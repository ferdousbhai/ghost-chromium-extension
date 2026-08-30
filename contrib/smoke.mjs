#!/usr/bin/env bun
/**
 * Live smoke test: a real ghostd, a real Chromium, a real page.
 *
 * The unit tests cover the protocol against a scripted transport and the hub
 * against a fake extension. Neither of them can tell you whether `chrome.debugger`
 * actually attaches, whether a dispatched mouse event lands on the link the model
 * asked for, or whether `Page.captureScreenshot` returns pixels. This does.
 *
 *     bun packages/chromium-extension/contrib/smoke.mjs
 *
 * It launches its **own** Chromium against a throwaway `--user-data-dir`, never
 * the owner's profile, and cleans both up. A window appears for a few seconds.
 * Pass `--headless` to skip the window (note that `chrome.debugger` and real
 * input work fine in Chrome's headless mode, but the screenshot compositor is
 * happier headed).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const extensionDir = join(here, "..", "extension");
const headless = process.argv.includes("--headless");

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
let server;
let hub;
let fixtureServer;

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
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

try {
  const binary = await findChromium();
  if (!binary) {
    process.stderr.write("No chromium on PATH. sudo pacman -S chromium\n");
    process.exit(2);
  }

  // 1. A daemon-shaped relay on an ephemeral loopback port.
  hub = new RelayHub({ token: TOKEN, pingIntervalMs: 20_000 });
  server = createServer((_request, response) => response.writeHead(404).end());
  attachRelay(server, hub);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  record("relay listening", true, `ws://127.0.0.1:${port}/relay`);

  // 2. Pre-seed the extension's settings so no human has to click the popup:
  //    chrome.storage.local is a LevelDB the browser owns, so instead pass the
  //    pairing through the profile's Local Extension Settings via the extension's
  //    own first run — simplest reliable path is a preferences-free approach:
  //    write a tiny bootstrap file the extension reads. We do it the honest way
  //    instead: launch, then drive chrome.storage through the extension page.
  profileDir = await mkdtemp(join(tmpdir(), "ghost-relay-smoke-profile-"));
  ghostHome = await mkdtemp(join(tmpdir(), "ghost-relay-smoke-home-"));

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
  record("extension paired", paired.ok, paired.detail);
  if (!paired.ok) throw new Error(paired.detail);
  const extensionId = paired.extensionId;

  await waitFor(() => hub.connected, 20_000, "the extension to dial in");
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
  record("screenshot", isPng && bytes > 1000, `${bytes} bytes of PNG at ${shot.path}`);

  const back = await session.back();
  record("back", back.moved && back.url.includes("example.com"), `${back.url}`);

  // 5. Typing, against a local fixture so the assertion is about the relay and
  //    not about someone else's search page.
  fixtureServer = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url?.startsWith("/submitted")
        ? `<!doctype html><title>Submitted</title><body><h1>Submitted</h1><p>${request.url}</p>`
        : FIXTURE_HTML,
    );
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
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

  otherGhostHome = await mkdtemp(join(tmpdir(), "ghost-relay-smoke-other-home-"));
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

  await closeBrowserSession(otherGhostHome);
  const afterOtherClosed = await session.tabs({ op: "list" });
  record(
    "closing another ghost leaves this workspace",
    afterOtherClosed.tabs.length === 2,
    `still owns ${afterOtherClosed.tabs.map((tab) => tab.id).join(", ")}`,
  );

  await closeBrowserSession(ghostHome);
  record("close the ghost-wide workspace", true, "the browser itself stayed open");

  // 6. The popup is the only way an owner ever pairs, so a syntax error in it
  //    is a ship-blocker that no unit test would catch. Only its rendering is
  //    assertable here — see checkPopup.
  const popup = await checkPopup(base, extensionId);
  record("popup renders and reports the connection", popup.ok, popup.detail);
} catch (error) {
  record("smoke run", false, error?.message ?? String(error));
} finally {
  await closeAllBrowserSessions().catch(() => {});
  await hub?.close().catch(() => {});
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await new Promise((resolve) => (fixtureServer ? fixtureServer.close(resolve) : resolve()));
  chromium?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  chromium?.kill("SIGKILL");
  for (const dir of [profileDir, ghostHome, otherGhostHome]) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const failed = steps.filter((step) => !step.ok);
process.stdout.write(`\n${steps.length - failed.length}/${steps.length} steps passed\n`);
process.exit(failed.length === 0 ? 0 : 1);

/**
 * Type the token into the extension for the owner, over the browser's own
 * debugging port. This is the smoke test standing in for four clicks in the
 * popup; nothing in the shipped path uses it.
 */
async function pairViaCdp(base, relayPort) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const targets = await fetch(`${base}/json/list`).then((r) => r.json()).catch(() => []);
    const worker = targets.find(
      (target) => target.type === "service_worker" && target.url.includes("background.js"),
    );
    if (worker) {
      // Node 22's own WebSocket client; no dependency needed for a smoke script.
      const socket = new WebSocket(worker.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("could not attach to the service worker"));
      });
      const answer = await new Promise((resolve, reject) => {
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id === 1) resolve(message);
        };
        setTimeout(() => reject(new Error("no answer from the service worker")), 15_000);
        socket.send(JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            returnByValue: true,
            expression:
              `chrome.storage.local.set({ token: ${JSON.stringify(TOKEN)}, `
              + `port: ${relayPort}, enabled: true }).then(() => "stored")`,
          },
        }));
      });
      socket.close();
      const value = answer?.result?.result?.value;
      return value === "stored"
        ? {
          ok: true,
          detail: `token written to chrome.storage.local, port ${relayPort}`,
          extensionId: new URL(worker.url).host,
        }
        : { ok: false, detail: JSON.stringify(answer?.result ?? answer) };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, detail: "the extension's service worker never appeared in /json/list" };
}

/**
 * Open the popup in a normal tab and read back what it rendered. A popup that
 * throws on load looks exactly like a popup that is merely empty, which is how a
 * broken pairing UI ships.
 */
async function checkPopup(base, extensionId) {
  if (!extensionId) return { ok: false, detail: "no extension id" };
  const url = `chrome-extension://${extensionId}/popup.html`;
  const created = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
    .then((response) => response.json())
    .catch((error) => ({ error: error.message }));
  if (!created?.webSocketDebuggerUrl) {
    return { ok: false, detail: `could not open the popup: ${JSON.stringify(created)}` };
  }
  const socket = new WebSocket(created.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("could not attach to the popup"));
    });
    // Give popup.js its first refresh() round trip to the service worker.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const answer = await new Promise((resolve, reject) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
      setTimeout(() => reject(new Error("the popup never answered")), 10_000);
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          returnByValue: true,
          expression: `JSON.stringify({
            status: document.getElementById("statusText").textContent,
            detail: document.getElementById("detail").textContent,
            token: document.getElementById("token").value.length,
            toggle: document.getElementById("toggle").textContent,
          })`,
        },
      }));
    });
    const raw = answer?.result?.result?.value;
    if (typeof raw !== "string") {
      return { ok: false, detail: `popup evaluate failed: ${JSON.stringify(answer?.result)}` };
    }
    const rendered = JSON.parse(raw);
    // Connection state is deliberately unobservable from here: `isPopupSender`
    // releases live relay status only to the real extension popup, and this
    // opens popup.html as a tab, so `sender.tab` is set and the request is
    // refused. What this step is for is the thing no unit test covers — that
    // the page parses, runs, and renders its controls.
    const ok = typeof rendered.status === "string" && rendered.status !== ""
      && rendered.token === 64
      && rendered.toggle === "Pause";
    return { ok, detail: `rendered, token ${rendered.token} chars, toggle ${JSON.stringify(rendered.toggle)}` };
  } finally {
    socket.close();
    await fetch(`${base}/json/close/${created.id}`).catch(() => {});
  }
}
