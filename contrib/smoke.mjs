#!/usr/bin/env bun
/**
 * Live smoke test: the real relay extension, a real Chromium, and real pages.
 *
 * It uses Ghost's production RelayHub and browser-session code behind an
 * in-process ephemeral HTTP server; it does not launch the full ghostd process.
 * Unit tests cover the protocol against a scripted transport and the hub against
 * a fake extension. Neither can tell you whether `chrome.debugger` actually
 * attaches, whether dispatched input lands, or whether screenshots contain
 * pixels. This does.
 *
 *     GHOST_REPO=~/src/ghost bun contrib/smoke.mjs    # ghost mode, needs a built ghost
 *     bun contrib/smoke.mjs --local                    # the ghostless product
 *
 * It launches its **own** Chromium against a throwaway `--user-data-dir`, never
 * the owner's profile, and forces captures into a throwaway screenshot directory
 * regardless of the caller's environment. It cleans all of them up. A window
 * appears for a few seconds.
 * Pass `--headless` to skip the window (note that `chrome.debugger` and real
 * input work fine in Chrome's headless mode, but the screenshot compositor is
 * happier headed).
 *
 * Pass `--local` for the ghostless product instead: no relay hub at all, the
 * side panel opened for real, and the panel's own message path driving tabs
 * through the worker. It proves what no unit test can — that a side-panel
 * document is accepted by the worker's sender check, and that the chat's tabs
 * survive Chrome reaping the worker — and, when `OPENROUTER_API_KEY` is set,
 * runs one real model turn on the free router and reads the usage line back.
 * The side panel is browser chrome, so `--local` needs a headed run.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, "..");
// The ghost-mode smoke drives a real ghost relay hub, so it needs a built
// checkout of github.com/ferdousbhai/ghost. `--local` needs none.
const ghostRepo = process.env.GHOST_REPO ?? null;
const headless = process.argv.includes("--headless");
const waitForCleanupSignal = process.argv.includes("--wait-for-cleanup-signal");
const callerScreenshotDir = process.env.OMARCHY_SCREENSHOT_DIR;
const CLEANUP_STEP_TIMEOUT_MS = 2_000;

const local = process.argv.includes("--local");
if (!local && ghostRepo === null) {
  process.stderr.write(
    "smoke: the ghost-mode smoke needs GHOST_REPO=<path to a built ghost checkout>; "
    + "pass --local for the ghostless product.\n",
  );
  process.exit(2);
}
const ghostModule = (path) => import(join(ghostRepo ?? "", path));
const { RelayHub, attachRelay } = local ? {} : await ghostModule("packages/daemon/dist/relay.js");
const {
  browserSessionFor,
  closeAllBrowserSessions = async () => {},
  closeBrowserSession,
  relayBackend,
} = local ? {} : await ghostModule("packages/extensions/dist/index.js");
const { createServer } = await import("node:http");

const TOKEN = "0123456789abcdef".repeat(4);
const steps = [];
const record = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  process.stdout.write(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}\n`);
};

let chromium;
let profileDir;
let ghostHome;
let otherGhostHome;
let screenshotDir;
let server;
let hub;
let fixtureServer;
let cleanupPromise;
let signalExitCode;
let resolveBodyDone;
let resolveSignalRequested;
let bodyFinished = false;
const bodyDone = new Promise((resolve) => { resolveBodyDone = resolve; });
const signalRequested = new Promise((resolve) => { resolveSignalRequested = resolve; });

/**
 * A page to type into, served from loopback.
 *
 * `type` is the one verb a public page cannot exercise honestly — a real search
 * box means a network round trip and someone else's markup changing under the
 * test. This one is three inputs and a form, and it proves the parts that are
 * genuinely hard: `Input.insertText` into a focused field, the native-setter
 * clear that a controlled input will believe, and Enter actually submitting.
 */
const FIXTURE_HTML = `<!doctype html><meta charset=utf-8><title>Relay fixture</title>
<body>
<h1>Relay fixture</h1>
<form action="/submitted" method="get">
  <input name="q" id="q" value="prefilled text" placeholder="Search">
  <button type="submit">Go</button>
</form>
<p id="note">A page with a field in it.</p>
</body>`;

async function findChromium() {
  const { access } = await import("node:fs/promises");
  const names = ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"];
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        await access(candidate);
        return candidate;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        throwIfSignalRequested();
      } catch (error) {
        reject(error);
        return;
      }
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function throwIfSignalRequested() {
  if (signalExitCode !== undefined) {
    throw new Error(`smoke interrupted with exit status ${signalExitCode}`);
  }
}

function markBodyFinished() {
  if (bodyFinished) return;
  bodyFinished = true;
  resolveBodyDone();
}

function boundedCleanup(work, timeoutMs, what) {
  let timer;
  return Promise.race([
    Promise.resolve().then(work).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), timeoutMs);
    }),
  ]);
}

function closeServer(captured) {
  if (!captured) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      captured.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  });
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

function settlesWithin(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then(() => true).finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
}

async function stopChromium() {
  const child = chromium;
  if (!child || childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 500)) return;
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, 1_000)) {
    throw new Error(`captured Chromium child ${child.pid} did not exit`);
  }
}

async function removeScratchDirectory(dir, prefix) {
  if (!dir) return;
  const absolute = resolve(dir);
  const expectedPrefix = resolve(tmpdir(), prefix);
  if (!absolute.startsWith(expectedPrefix) || absolute === expectedPrefix) {
    throw new Error(`refusing to remove non-smoke directory ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true });
}

async function runCleanup() {
  const errors = [];
  let interruptedActiveResources = false;
  const attempt = async (what, work, timeoutMs = CLEANUP_STEP_TIMEOUT_MS) => {
    try {
      await boundedCleanup(work, timeoutMs, what);
    } catch (error) {
      errors.push(new Error(`${what}: ${error?.message ?? error}`));
    }
  };

  if (signalExitCode !== undefined && !bodyFinished) {
    // Give signal-aware work one turn to enter the shared finally. If an active
    // browser operation is stuck, retire its captured transport and child; the
    // child exit owns those ephemeral tabs, so a later graceful session close
    // would only report the transport failure this interruption just caused.
    if (!await settlesWithin(bodyDone, 100)) {
      interruptedActiveResources = true;
      await Promise.all([
        attempt("interrupting the relay hub", () => hub?.close()),
        attempt("interrupting captured Chromium", stopChromium),
      ]);
      await attempt("waiting for the smoke body to stop", () => bodyDone, 5_000);
    }
  }

  if (!interruptedActiveResources) {
    await attempt("closing browser sessions", () => closeAllBrowserSessions());
  }
  await attempt("closing the relay hub", () => hub?.close());
  await Promise.all([
    attempt("closing the relay server", () => closeServer(server)),
    attempt("closing the fixture server", () => closeServer(fixtureServer)),
  ]);
  await attempt("stopping captured Chromium", stopChromium);

  if (callerScreenshotDir === undefined) delete process.env.OMARCHY_SCREENSHOT_DIR;
  else process.env.OMARCHY_SCREENSHOT_DIR = callerScreenshotDir;

  await Promise.all([
    attempt(
      "removing the Chromium profile",
      () => removeScratchDirectory(profileDir, "ghost-relay-smoke-profile-"),
    ),
    attempt(
      "removing the ghost home",
      () => removeScratchDirectory(ghostHome, "ghost-relay-smoke-home-"),
    ),
    attempt(
      "removing the other ghost home",
      () => removeScratchDirectory(otherGhostHome, "ghost-relay-smoke-other-home-"),
    ),
    attempt(
      "removing screenshots",
      () => removeScratchDirectory(screenshotDir, "ghost-relay-smoke-screenshots-"),
    ),
  ]);

  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `smoke cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
}

function cleanupSmoke() {
  cleanupPromise ??= runCleanup();
  return cleanupPromise;
}

function requestSignalCleanup(signal, exitCode) {
  if (signalExitCode !== undefined) return;
  signalExitCode = exitCode;
  resolveSignalRequested();
  void cleanupSmoke().then(
    () => process.exit(exitCode),
    (error) => {
      try {
        writeSync(2, `${signal} cleanup failed: ${error?.message ?? error}\n`);
      } catch { /* there is no safer diagnostic channel during signal exit */ }
      process.exit(exitCode);
    },
  );
}

/**
 * A throwaway Chromium with the unpacked extension and a debugging port. The
 * port exists only so this script can reach `chrome.storage` and the panel
 * document; the shipped extension uses none of it.
 */
async function launchChromium(binary) {
  // Resource acquisition stays synchronous so a signal handler can never clean
  // an uncaptured path while a late filesystem operation is still creating it.
  profileDir = mkdtempSync(join(tmpdir(), "ghost-relay-smoke-profile-"));
  throwIfSignalRequested();
  screenshotDir = resolve(mkdtempSync(join(tmpdir(), "ghost-relay-smoke-screenshots-")));
  throwIfSignalRequested();
  process.env.OMARCHY_SCREENSHOT_DIR = screenshotDir;

  throwIfSignalRequested();
  chromium = spawn(binary, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-background-timer-throttling",
    "--remote-debugging-port=0",
    ...(headless ? ["--headless=new"] : []),
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  throwIfSignalRequested();

  let devtoolsUrl = "";
  chromium.stderr.on("data", (chunk) => {
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString());
    if (match) devtoolsUrl = match[1];
  });
  await waitFor(() => devtoolsUrl !== "", 20_000, "chromium to start");
  record("chromium launched", true, `throwaway profile ${profileDir}`);
  return { base: `http://127.0.0.1:${new URL(devtoolsUrl).port}`, devtoolsUrl };
}

/** The ghost-driven product: a relay hub in-process, the extension paired to it. */
async function ghostSmoke(binary) {
  // 1. An in-process relay harness on an ephemeral loopback port.
  throwIfSignalRequested();
  hub = new RelayHub({ token: TOKEN, pingIntervalMs: 20_000 });
  server = createServer((_request, response) => response.writeHead(404).end());
  attachRelay(server, hub);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  throwIfSignalRequested();
  const port = server.address().port;
  record("relay listening", true, `ws://127.0.0.1:${port}/relay`);

  // 2. Pre-seed the extension's settings so no human has to click the panel:
  //    chrome.storage.local is a LevelDB the browser owns, so instead pass the
  //    pairing through the profile's Local Extension Settings via the extension's
  //    own first run — simplest reliable path is a preferences-free approach:
  //    write a tiny bootstrap file the extension reads. We do it the honest way
  //    instead: launch, then drive chrome.storage through the extension page.
  // Resource acquisition stays synchronous so a signal handler can never clean
  // an uncaptured path while a late filesystem operation is still creating it.
  ghostHome = mkdtempSync(join(tmpdir(), "ghost-relay-smoke-home-"));
  throwIfSignalRequested();

  const { base } = await launchChromium(binary);

  // 3. Pair the extension by writing its settings through the browser's own CDP:
  //    find the extension's service worker target and evaluate `chrome.storage`.
  const paired = await pairViaCdp(base, port);
  throwIfSignalRequested();
  record("extension paired", paired.ok, paired.detail);
  if (!paired.ok) throw new Error(paired.detail);
  const extensionId = paired.extensionId;

  await waitFor(() => hub.connected, 20_000, "the extension to dial in");
  throwIfSignalRequested();
  record("extension connected", true, hub.peer ?? "");

  // 4. Drive one full round through the real session layer, so URL policy, ref
  //    bookkeeping, and the read budget are all in the path.
  const sessionOptions = {
    backend: relayBackend({ transport: hub }),
    idleTimeoutMs: 0,
    actionTimeoutMs: 30_000,
    // The typing step below serves its own fixture on loopback rather than
    // asserting against someone else's search page, and the URL policy refuses
    // local addresses unless the session was configured to allow them.
    allowLocal: true,
  };
  throwIfSignalRequested();
  const session = browserSessionFor(ghostHome, sessionOptions);

  const opened = await session.open("https://example.com");
  record("open", opened.url.includes("example.com"), `${opened.url} — ${opened.title}`);

  const read = await session.read({ maxChars: 400 });
  record(
    "read",
    read.text.toLowerCase().includes("documentation examples"),
    `${read.totalLength} chars, title ${JSON.stringify(read.title)}`,
  );

  // `find` answers with the page it searched alongside the matches, so the model
  // is told where the refs came from; the matches are one field of that.
  const { matches } = await session.find("Learn more", { limit: 5 });
  record(
    "find",
    matches.length > 0 && matches[0].ref === "e1",
    matches.map((m) => `${m.ref}<${m.tag}> ${JSON.stringify(m.text.slice(0, 30))}`).join(", "),
  );

  const clicked = await session.click({ ref: "e1" });
  record("click a link", clicked.url !== opened.url, `now at ${clicked.url}`);

  const shot = await session.screenshot();
  const bytes = (await readFile(shot.path)).length;
  const isPng = (await readFile(shot.path)).subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  record(
    "screenshot",
    isPng && bytes > 1000,
    `${bytes} bytes of temporary PNG at ${shot.path}`,
  );

  const back = await session.back();
  record("back", back.moved && back.url.includes("example.com"), `${back.url}`);

  // 5. Typing, against a local fixture so the assertion is about the relay and
  //    not about someone else's search page.
  throwIfSignalRequested();
  fixtureServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url?.startsWith("/submitted")
        ? `<!doctype html><title>Submitted</title><body><h1>Submitted</h1><p>${request.url}</p>`
        : FIXTURE_HTML,
    );
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  throwIfSignalRequested();
  const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;

  await session.open(fixtureUrl, { allowLocal: true });
  const { matches: fields } = await session.find("input#q", { limit: 3 });
  record("find a field by selector", fields.length === 1 && fields[0].value === "prefilled text",
    fields.map((m) => `${m.ref}<${m.tag}> value=${JSON.stringify(m.value ?? "")}`).join(", "));

  const typed = await session.type({ ref: "e1", text: "letterpress", submit: false });
  const { matches: afterType } = await session.find("input#q", { limit: 1 });
  record(
    "type replaces the field's value",
    typed.submitted === false && afterType[0]?.value === "letterpress",
    `value is now ${JSON.stringify(afterType[0]?.value ?? "")}`,
  );

  const submitted = await session.type({ ref: "e1", text: "typewriter", submit: true });
  record(
    "submit with Enter",
    submitted.submitted && submitted.url.includes("q=typewriter"),
    submitted.url,
  );

  // 5b. Exercise the production ownership model: one resolved ghost home is one
  //     shared workspace across conversations, with multiple tabs; another home
  //     gets a separate protocol owner over the same extension socket.
  throwIfSignalRequested();
  const sameGhost = browserSessionFor(join(ghostHome, "."), {
    ...sessionOptions,
    backend: relayBackend({ transport: hub }),
  });
  record(
    "same-home conversations reuse one browser workspace",
    sameGhost === session,
    `resolved registry key ${ghostHome}`,
  );

  const firstTab = (await session.tabs({ op: "list" })).active;
  const created = await sameGhost.tabs({ op: "create", url: `${fixtureUrl}?second-tab=1` });
  const shared = await session.tabs({ op: "list" });
  record(
    "one ghost-wide workspace owns multiple tabs",
    shared.tabs.length === 2 && created.active !== firstTab && shared.active === created.active,
    `tabs ${shared.tabs.map((tab) => tab.id).join(", ")}; active ${shared.active}`,
  );

  otherGhostHome = mkdtempSync(join(tmpdir(), "ghost-relay-smoke-other-home-"));
  throwIfSignalRequested();
  const otherGhost = browserSessionFor(otherGhostHome, {
    ...sessionOptions,
    backend: relayBackend({ transport: hub }),
  });
  await otherGhost.open(`${fixtureUrl}?other-ghost=1`);
  const mine = await session.tabs({ op: "list" });
  const theirs = await otherGhost.tabs({ op: "list" });
  record(
    "separate ghost homes keep separate browser workspaces",
    mine.tabs.length === 2 && theirs.tabs.length === 1
      && mine.tabs.every((tab) => !theirs.tabs.some((otherTab) => otherTab.id === tab.id)),
    `first ghost: ${mine.tabs.map((tab) => tab.id).join(", ")}; other: ${theirs.active}`,
  );

  if (waitForCleanupSignal) {
    process.stdout.write(`cleanup checkpoint ${JSON.stringify({
      smokePid: process.pid,
      chromiumPid: chromium.pid,
      profileDir,
      ghostHome,
      otherGhostHome,
      screenshotDir,
    })}\n`);
    await signalRequested;
    throwIfSignalRequested();
  }

  await closeBrowserSession(otherGhostHome);
  const afterOtherClosed = await session.tabs({ op: "list" });
  record(
    "closing another ghost leaves this workspace",
    afterOtherClosed.tabs.length === 2,
    `still owns ${afterOtherClosed.tabs.map((tab) => tab.id).join(", ")}`,
  );

  await closeBrowserSession(ghostHome);
  record("close the ghost-wide workspace", true, "the browser itself stayed open");

  // 6. Opening the panel document as an ordinary extension tab is not the side
  //    panel: sender.tab is present, so production correctly withholds settings
  //    and live status. It can still prove the page and script render their
  //    unauthorized fallback without weakening that boundary.
  const asTab = await checkTabDocument(base, extensionId);
  record("the panel document opened as a tab is refused relay state", asTab.ok, asTab.detail);
}
/**
 * The ghostless product. No relay hub exists; the extension's port is pointed
 * at a loopback listener that speaks no relay, so its pairing dial goes nowhere
 * — never to a live ghostd on 7717, whose HUD would otherwise show this
 * throwaway browser's code to the owner.
 */
async function localSmoke(binary) {
  throwIfSignalRequested();
  server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const deadPort = server.address().port;
  const key = process.env.OPENROUTER_API_KEY ?? "";

  const { base, devtoolsUrl } = await launchChromium(binary);
  // The worker target is listed before its `chrome` globals exist; keep asking
  // until the write lands, as the pairing seed does.
  const seeded = await untilValue(
    () => workerTarget(base, 5_000).then((worker) => evaluateIn(worker, `(async () => {
      if (typeof globalThis.chrome?.storage?.local?.set !== "function") return "not-ready";
      await chrome.storage.local.set({
        port: ${deadPort},
        enabled: true,
        ...(${JSON.stringify(key)} === "" ? {} : { openRouterKey: ${JSON.stringify(key)} }),
      });
      return "stored";
    })()`, "seed the extension's settings")),
    (value) => value === "stored",
    20_000,
    "the extension's settings to be seeded",
  );
  record("extension pointed at a dead port, no token", seeded === "stored", `port ${deadPort}`);

  // The toolbar click, without a toolbar. `sidePanel.open()` wants a user
  // gesture, and CDP can only grant one to a page frame, not to the worker — so
  // an extension page opened as a tab does the clicking. That page is the panel
  // document itself under a query string (so it is not mistaken for the real
  // panel below), which the worker rightly ignores; it is borrowed for its origin.
  await untilValue(
    () => workerTarget(base, 5_000).then((worker) => evaluateIn(worker, `(async () => {
      if (typeof globalThis.chrome?.tabs?.create !== "function") return "not-ready";
      await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html?gesture") });
      return "opened";
    })()`, "open an extension page")),
    (value) => value === "opened",
    20_000,
    "an extension page to open",
  );
  const page = await pageTarget(base, "/sidepanel.html?gesture", 20_000);
  const windowId = await untilValue(
    () => evaluateIn(page, `(async () => {
      const window_ = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: window_.id });
      return window_.id;
    })()`, "open the side panel", { userGesture: true }),
    (value) => Number.isInteger(value),
    20_000,
    "the side panel to open",
  );
  record("side panel opened", Number.isInteger(windowId), `window ${windowId}`);

  const panel = await pageTarget(base, "/sidepanel.html", 20_000);
  throwIfSignalRequested();
  record("side panel document found", true, panel.url);

  const conversation = crypto.randomUUID();
  const op = (name, args) => evaluateIn(panel, `chrome.runtime.sendMessage(${JSON.stringify({
    type: "ghost-relay-local-op", conversation, op: name, args, timeoutMs: 30_000,
  })})`, `local ${name}`, { timeoutMs: 35_000 });

  // 1. A side-panel document is an accepted sender: this answers at all only if
  //    the worker saw no `sender.tab`.
  const opened = await op("open", { url: "https://example.com/" });
  record("panel may drive tabs (sender.tab is absent)", opened?.ok === true, opened?.error ?? opened?.result?.page?.url);
  if (opened?.ok !== true) throw new Error(opened?.error ?? "open failed");
  const tab = opened.result.id;

  const read = await op("read", { tab });
  record("read", read?.ok === true && /Example Domain/.test(read.result.text), read?.error ?? `${read?.result?.text?.length ?? 0} chars`);
  const found = await op("find", { tab, query: "a" });
  const ref = found?.result?.matches?.[0]?.ref;
  record("find", typeof ref === "string", found?.error ?? `${found?.result?.matches?.length ?? 0} matches`);
  const clicked = await op("click", { tab, ref });
  record("click", clicked?.ok === true, clicked?.error ?? clicked?.result?.page?.url);
  const shot = await op("screenshot", { tab });
  record("screenshot", shot?.ok === true && shot.result.png?.length > 1_000, shot?.error ?? `${shot?.result?.png?.length ?? 0} base64 chars`);

  // 2. Chrome reaps the worker; the next op must find the same tab. This is the
  //    ghostless install's thirty-seconds-idle case, forced instead of waited
  //    for. The proof that a reap happened is a *different* worker target id
  //    answering afterwards; a close that quietly did nothing would leave the
  //    old id in place and this step says so.
  const before = await workerTarget(base, 5_000);
  const browser = await openCdpSocket(devtoolsUrl, "attach to the browser", 5_000);
  let closed;
  try {
    closed = await cdpRequest(browser, 1, "Target.closeTarget", { targetId: before.id }, "stop the worker", 5_000);
  } finally {
    browser.close();
  }
  await untilValue(
    () => fetch(`${base}/json/list`).then((r) => r.json()),
    (targets) => !targets.some((target) => target.id === before.id),
    10_000,
    "the old worker target to disappear",
  );
  const current = await op("current", { tab });
  const after = await workerTarget(base, 5_000);
  record(
    "tabs survive a worker reap without a ghost",
    closed?.result?.success === true && after.id !== before.id
      && current?.ok === true && current.result.page?.url?.startsWith("https://"),
    current?.error ?? `${current?.result?.page?.url} (worker ${before.id.slice(0, 8)} → ${after.id.slice(0, 8)})`,
  );

  // 3. One real turn, when there is a key to run it on.
  if (key === "") {
    record("model turn on the free router", true, "skipped: OPENROUTER_API_KEY is not set");
    return;
  }
  await evaluateIn(panel, "location.reload()", "reload the panel with the key");
  const fresh = await pageTarget(base, "/sidepanel.html", 20_000);
  await evaluateIn(fresh, `(async () => {
    for (let i = 0; i < 100 && document.getElementById("composerBar").hidden; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    document.getElementById("input").value = "Open https://example.com/ and tell me its heading in five words or fewer.";
    document.getElementById("send").click();
    return "sent";
  })()`, "send a message", { timeoutMs: 15_000 });
  const outcome = await evaluateIn(fresh, `(async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const usage = [...document.querySelectorAll("#log .usage")].at(-1)?.textContent ?? "";
      const error = [...document.querySelectorAll("#log .error")].map((n) => n.textContent).join(" | ");
      if (usage !== "" || error !== "") return { usage, error };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { usage: "", error: "timed out waiting for the turn" };
  })()`, "wait for the turn", { timeoutMs: 125_000 });
  record("model turn on the free router", outcome.error === "" && outcome.usage !== "", outcome.error || outcome.usage);
  record("usage line reports a cost", /free|\$/.test(outcome.usage), outcome.usage);
}

/** Re-run `attempt` until `accept` likes its value; a throw is a retry too. */
async function untilValue(attempt, accept, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    throwIfSignalRequested();
    try {
      const value = await attempt();
      if (accept(value)) return value;
      last = `got ${JSON.stringify(value)}`;
    } catch (error) {
      last = error?.message ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}: ${last}`);
}

async function workerTarget(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    throwIfSignalRequested();
    const targets = await fetch(`${base}/json/list`, {
      signal: AbortSignal.timeout(remainingCdpBudget(deadline)),
    }).then((r) => r.json()).catch(() => []);
    const worker = targets.find(
      (target) => target.type === "service_worker" && target.url.includes("background.js"),
    );
    if (worker) return worker;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the extension's service worker did not appear");
}

async function pageTarget(base, suffix, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    throwIfSignalRequested();
    const targets = await fetch(`${base}/json/list`, {
      signal: AbortSignal.timeout(remainingCdpBudget(deadline)),
    }).then((r) => r.json()).catch(() => []);
    const page = targets.find((target) => target.url.endsWith(suffix));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the ${suffix} document did not appear`);
}

/** Evaluate in a target and hand back the value, over a socket opened for the call. */
async function evaluateIn(target, expression, what, { userGesture = false, timeoutMs = 10_000 } = {}) {
  const socket = await openCdpSocket(target.webSocketDebuggerUrl, `attach to ${what}`, 5_000);
  try {
    const answer = await cdpRequest(socket, 1, "Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture,
    }, what, timeoutMs);
    if (answer?.result?.exceptionDetails) {
      const detail = answer.result.exceptionDetails.exception?.description
        ?? answer.result.exceptionDetails.text;
      throw new Error(`${what}: ${detail}`);
    }
    return answer?.result?.result?.value;
  } finally {
    socket.close();
  }
}

process.on("SIGINT", () => requestSignalCleanup("SIGINT", 130));
process.on("SIGTERM", () => requestSignalCleanup("SIGTERM", 143));

try {
  const binary = await findChromium();
  throwIfSignalRequested();
  if (!binary) {
    process.stderr.write("No chromium on PATH. sudo pacman -S chromium\n");
    process.exit(2);
  }

  if (local) await localSmoke(binary);
  else await ghostSmoke(binary);
} catch (error) {
  record("smoke run", false, error?.message ?? String(error));
} finally {
  markBodyFinished();
  try {
    await cleanupSmoke();
  } catch (error) {
    record("cleanup", false, error?.message ?? String(error));
  }
}

if (signalExitCode !== undefined) process.exit(signalExitCode);
const failed = steps.filter((step) => !step.ok);
process.stdout.write(`\n${steps.length - failed.length}/${steps.length} steps passed\n`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Type the token into the extension for the owner, over the browser's own
 * debugging port. This is the smoke test standing in for four clicks in the
 * panel; nothing in the shipped path uses it.
 */
async function pairViaCdp(base, relayPort) {
  let lastDetail = "the extension's service worker has not appeared";
  const deadline = Date.now() + 20_000;
  while (Date.now() <= deadline) {
    throwIfSignalRequested();
    const targets = await fetch(`${base}/json/list`, {
      signal: AbortSignal.timeout(remainingCdpBudget(deadline)),
    }).then((r) => r.json()).catch(() => []);
    const worker = targets.find(
      (target) => target.type === "service_worker" && target.url.includes("background.js"),
    );
    if (worker) {
      let socket;
      try {
        // Node 22's own WebSocket client; no dependency needed for a smoke script.
        socket = await openCdpSocket(
          worker.webSocketDebuggerUrl,
          "attach to the service worker",
          remainingCdpBudget(deadline),
        );
        const answer = await cdpRequest(socket, 1, "Runtime.evaluate", {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
            if (typeof globalThis.chrome?.storage?.local?.set !== "function") {
              return "storage-unavailable";
            }
            await chrome.storage.local.set({ token: ${JSON.stringify(TOKEN)}, port: ${relayPort}, enabled: true });
            return "stored";
          })()`,
        }, "pair the extension", remainingCdpBudget(deadline));
        const value = answer?.result?.result?.value;
        if (value === "stored") {
          return {
            ok: true,
            detail: `token written to chrome.storage.local, port ${relayPort}`,
            extensionId: new URL(worker.url).host,
          };
        }
        lastDetail = JSON.stringify(answer?.result ?? answer);
      } catch (error) {
        lastDetail = error?.message ?? String(error);
      } finally {
        socket?.close();
      }
    }
    const pause = Math.min(100, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  return { ok: false, detail: `extension pairing did not become ready: ${lastDetail}` };
}

/**
 * Open the panel's document as an ordinary extension tab and ask it for live
 * relay state. It must get nothing: the worker answers only the real side
 * panel, where `sender.tab` is absent, which is what keeps a page from pairing
 * or pausing on the owner's behalf.
 */
async function checkTabDocument(base, extensionId) {
  throwIfSignalRequested();
  if (!extensionId) return { ok: false, detail: "no extension id" };
  const url = `chrome-extension://${extensionId}/sidepanel.html?as-a-tab`;
  const created = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json()).catch((error) => ({ error: error.message }));
  if (!created?.webSocketDebuggerUrl) {
    return { ok: false, detail: `could not open the tab: ${JSON.stringify(created)}` };
  }
  try {
    const answer = await untilValue(
      () => evaluateIn(created, `chrome.runtime.sendMessage({ type: "ghost-relay-status" })
        .then((value) => ({ answered: value !== undefined && value !== null }), () => ({ answered: false, refused: true }))`,
        "ask for relay status from a tab"),
      (value) => value && typeof value.answered === "boolean",
      10_000,
      "the tab document to answer",
    );
    return {
      ok: answer.answered === false,
      detail: answer.answered ? "a tab document was handed relay status" : "refused, as a tab must be",
    };
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) };
  }
}

function remainingCdpBudget(deadline) {
  return Math.max(1, Math.min(2_000, deadline - Date.now()));
}

function openCdpSocket(url, what, timeoutMs = 2_000) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (settle, value) => {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onerror = null;
      settle(value);
    };
    socket.onopen = () => finish(resolve, socket);
    socket.onerror = () => {
      socket.close();
      finish(reject, new Error(`could not ${what}`));
    };
    timer = setTimeout(() => {
      socket.close();
      finish(reject, new Error(`${what} timed out`));
    }, timeoutMs);
  });
}

function cdpRequest(socket, id, method, params, what, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      settle(value);
    };
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      if (message.error) {
        finish(reject, new Error(`${what}: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        finish(resolve, message);
      }
    };
    const timer = setTimeout(() => finish(reject, new Error(`${what} timed out`)), timeoutMs);
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}
