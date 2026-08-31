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
 *     bun packages/chromium-extension/contrib/smoke.mjs
 *
 * It launches its **own** Chromium against a throwaway `--user-data-dir`, never
 * the owner's profile, and forces captures into a throwaway screenshot directory
 * regardless of the caller's environment. It cleans all of them up. A window
 * appears for a few seconds.
 * Pass `--headless` to skip the window (note that `chrome.debugger` and real
 * input work fine in Chrome's headless mode, but the screenshot compositor is
 * happier headed).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const extensionDir = join(here, "..", "extension");
const headless = process.argv.includes("--headless");
const waitForCleanupSignal = process.argv.includes("--wait-for-cleanup-signal");
const callerScreenshotDir = process.env.OMARCHY_SCREENSHOT_DIR;
const CLEANUP_STEP_TIMEOUT_MS = 2_000;

const { RelayHub, attachRelay } = await import(join(repoRoot, "packages/daemon/dist/relay.js"));
const {
  browserSessionFor,
  closeAllBrowserSessions,
  closeBrowserSession,
  relayBackend,
} = await import(join(repoRoot, "packages/extensions/dist/index.js"));
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

process.on("SIGINT", () => requestSignalCleanup("SIGINT", 130));
process.on("SIGTERM", () => requestSignalCleanup("SIGTERM", 143));

try {
  const binary = await findChromium();
  throwIfSignalRequested();
  if (!binary) {
    process.stderr.write("No chromium on PATH. sudo pacman -S chromium\n");
    process.exit(2);
  }

  // 1. An in-process relay harness on an ephemeral loopback port.
  throwIfSignalRequested();
  hub = new RelayHub({ token: TOKEN, pingIntervalMs: 20_000 });
  server = createServer((_request, response) => response.writeHead(404).end());
  attachRelay(server, hub);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  throwIfSignalRequested();
  const port = server.address().port;
  record("relay listening", true, `ws://127.0.0.1:${port}/relay`);

  // 2. Pre-seed the extension's settings so no human has to click the popup:
  //    chrome.storage.local is a LevelDB the browser owns, so instead pass the
  //    pairing through the profile's Local Extension Settings via the extension's
  //    own first run — simplest reliable path is a preferences-free approach:
  //    write a tiny bootstrap file the extension reads. We do it the honest way
  //    instead: launch, then drive chrome.storage through the extension page.
  // Resource acquisition stays synchronous so a signal handler can never clean
  // an uncaptured path while a late filesystem operation is still creating it.
  profileDir = mkdtempSync(join(tmpdir(), "ghost-relay-smoke-profile-"));
  throwIfSignalRequested();
  ghostHome = mkdtempSync(join(tmpdir(), "ghost-relay-smoke-home-"));
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
    // Only so this script can type the pairing token into chrome.storage for
    // the owner; the shipped relay uses none of this.
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

  // 3. Pair the extension by writing its settings through the browser's own CDP:
  //    find the extension's service worker target and evaluate `chrome.storage`.
  const base = `http://127.0.0.1:${new URL(devtoolsUrl).port}`;
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

  // 6. Opening popup.html as an ordinary extension tab is not the browser-action
  //    popup: sender.tab is present, so production correctly withholds settings
  //    and live status. It can still prove the page and script render their
  //    unauthorized fallback without weakening that boundary.
  const popup = await checkPopup(base, extensionId);
  record("ordinary popup page renders without exposing relay settings", popup.ok, popup.detail);
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
 * popup; nothing in the shipped path uses it.
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
 * Open popup.html as an ordinary extension tab and read its unauthorized
 * fallback. This deliberately cannot exercise live action-popup state: the
 * background rejects any status/settings sender with `sender.tab` present.
 */
async function checkPopup(base, extensionId) {
  throwIfSignalRequested();
  if (!extensionId) return { ok: false, detail: "no extension id" };
  const url = `chrome-extension://${extensionId}/popup.html`;
  const deadline = Date.now() + 10_000;
  const created = await fetch(`${base}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
    signal: AbortSignal.timeout(remainingCdpBudget(deadline)),
  })
    .then((response) => response.json())
    .catch((error) => ({ error: error.message }));
  if (!created?.webSocketDebuggerUrl) {
    return { ok: false, detail: `could not open the popup: ${JSON.stringify(created)}` };
  }
  let socket;
  try {
    socket = await openCdpSocket(
      created.webSocketDebuggerUrl,
      "attach to the popup",
      remainingCdpBudget(deadline),
    );
    const diagnostics = { exceptions: [], observationErrors: [] };
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method !== "Runtime.exceptionThrown") return;
      const exception = message.params?.exceptionDetails;
      if (diagnostics.exceptions.length < 20) {
        diagnostics.exceptions.push(
          exception?.exception?.description ?? exception?.text ?? "popup exception",
        );
      }
    });
    await cdpRequest(
      socket,
      1,
      "Runtime.enable",
      {},
      "enable popup diagnostics",
      remainingCdpBudget(deadline),
    );
    const navigation = await cdpRequest(
      socket,
      2,
      "Page.navigate",
      { url },
      "navigate to the popup",
      remainingCdpBudget(deadline),
    );
    const navigationError = navigation?.result?.errorText;
    if (navigationError) throw new Error(`popup navigation failed: ${navigationError}`);

    let rendered = null;
    let lastObservation = null;
    for (let id = 3; Date.now() <= deadline; id += 1) {
      throwIfSignalRequested();
      try {
        const answer = await cdpRequest(socket, id, "Runtime.evaluate", {
          returnByValue: true,
          expression: `JSON.stringify({
            url: location.href,
            ready: document.readyState,
            status: document.getElementById("statusText")?.textContent ?? null,
            detail: document.getElementById("detail")?.textContent ?? null,
            token: document.getElementById("token")?.value.length ?? null,
            toggle: document.getElementById("toggle")?.textContent ?? null,
          })`,
        }, "read popup state", remainingCdpBudget(deadline));
        const raw = answer?.result?.result?.value;
        lastObservation = typeof raw === "string" ? JSON.parse(raw) : answer?.result;
        if (lastObservation?.url === url
            && lastObservation.ready === "complete"
            && lastObservation.status !== null
            && lastObservation.status !== "Checking…") {
          rendered = lastObservation;
          break;
        }
      } catch (error) {
        if (diagnostics.observationErrors.length < 20) {
          diagnostics.observationErrors.push(error?.message ?? String(error));
        }
      }
      const pause = Math.min(100, deadline - Date.now());
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    if (rendered === null) {
      return {
        ok: false,
        detail: `popup did not settle: ${JSON.stringify({ lastObservation, diagnostics })}`,
      };
    }
    const ok = diagnostics.exceptions.length === 0
      && rendered.status === "Not paired"
      && typeof rendered.detail === "string" && rendered.detail !== ""
      && rendered.token === 0
      && rendered.toggle === "Pause";
    return {
      ok,
      detail:
        `unauthorized fallback ${JSON.stringify(rendered.status)}, token ${rendered.token} chars; `
        + `diagnostics ${JSON.stringify(diagnostics)}`,
    };
  } finally {
    socket?.close();
    await fetch(`${base}/json/close/${created.id}`, {
      signal: AbortSignal.timeout(2_000),
    }).catch(() => {});
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
