// Runs inside the nested compositor's environment (see capture.sh). Seeds the
// extension with a conversation, opens the real side panel, moves the browser
// onto the headless output, and captures that output for each screenshot.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const ext = process.env.EXT; const out = process.env.OUT;
const profile = mkdtempSync(join(process.env.XDG_RUNTIME_DIR, "prof-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn("chromium", [`--user-data-dir=${profile}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`,
  "--ozone-platform=wayland", "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--use-mock-keychain",
  "--force-dark-mode", "--remote-debugging-port=0", "https://example.com/"], { stdio: ["ignore", "pipe", "pipe"] });
let base = "";
child.stderr.on("data", (c) => { const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(c)); if (m) base = `http://127.0.0.1:${new URL(m[1]).port}`; });
const cdp = (ws, method, params = {}) => new Promise((resolve, reject) => {
  const s = new WebSocket(ws);
  const timer = setTimeout(() => { s.close(); reject(new Error(`cdp timeout: ${method}`)); }, 8000);
  s.onopen = () => s.send(JSON.stringify({ id: 1, method, params }));
  s.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); s.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
  s.onerror = () => { clearTimeout(timer); reject(new Error("ws")); };
});
const findPanel = () => until(async () => (await targets()).find((t) => t.url.endsWith("/sidepanel.html")), 20000, "panel");
const targets = async () => (await fetch(`${base}/json/list`)).json();
const evalIn = async (t, expression, userGesture = false) => (await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture })).result?.value;
const until = async (fn, ms, what) => { const d = Date.now() + ms; let last = ""; for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { last = e?.message ?? String(e); } if (Date.now() > d) throw new Error(`timeout: ${what} (${last})`); await sleep(150); } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = async (name) => { log("capturing", name); for (let i = 0; i < 3; i += 1) { try { execFileSync("timeout", ["15", "grim", "-o", "HEADLESS-1", `${out}/${name}.png`]); break; } catch (e) { log("grim retry", i + 1); await sleep(1000); if (i === 2) throw e; } } console.log("wrote", name, execFileSync("magick", [`${out}/${name}.png`, "-format", "%wx%h", "info:"]).toString()); };
const hyprctl = (...args) => execFileSync("hyprctl", args).toString();
try {
  await until(() => base !== "", 30000, "devtools"); log("devtools up");
  // Put the browser window on the headless output; alone there, it fills it.
  const win = await until(() => JSON.parse(hyprctl("clients", "-j")).find((c) => c.class === "chromium"), 20000, "chromium window");
  hyprctl("dispatch", `hl.dsp.window.move({ monitor = "HEADLESS-1", window = "address:${win.address}" })`);
  await until(() => { const c = JSON.parse(hyprctl("clients", "-j")).find((c) => c.address === win.address); return c && c.size[0] === 1280 && c.size[1] === 800; }, 15000, "window at 1280x800 on HEADLESS-1");
  log("chromium on HEADLESS-1");
  // The compositor draws a software cursor into the headless output; park it
  // on the other output, and clear the "started without start-hyprland" notice.
  hyprctl("dispatch", `hl.dsp.cursor.move({ x = 6400, y = 100 })`);
  hyprctl("dismissnotify");
  const worker = await until(async () => (await targets()).find((t) => t.type === "service_worker"), 30000, "worker");
  const now = Date.now();
  const chats = { active: "a", chats: [
    { id: "a", title: "Find the IANA page", updatedAt: now, messages: [], record: [
      { kind: "user", text: "Open example.com, follow its link, and tell me where it goes." },
      { kind: "tool", text: '→ open url="https://example.com/"' }, { kind: "tool", text: "← open ok" },
      { kind: "tool", text: '→ find query="a"' }, { kind: "tool", text: "← find ok" },
      { kind: "tool", text: '→ click ref="e1"' }, { kind: "tool", text: "← click ok" },
      { kind: "assistant", text: "It goes to IANA's page on reserved example domains — example.com, .net and .org are set aside by RFC 2606 for documentation, so nothing typed there reaches a real site." },
      { kind: "usage", text: "qwen/qwen3-coder:free · 2,104 tokens · free" } ] },
    { id: "b", title: "Check the Arch news page", updatedAt: now - 3_600_000, messages: [], record: [{ kind: "user", text: "Check the Arch news page" }] } ] };
  await until(async () => await evalIn(worker, `(async()=>{ if(!globalThis.chrome?.storage) return false; await chrome.storage.local.set(${JSON.stringify({ openRouterKey: "sk-or-store-shot", enabled: true, port: 1, localChats: chats })}); return true; })()`), 30000, "seed");
  const gestureTab = await evalIn(worker, `chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html?gesture") }).then((t)=>t.id)`);
  const gesture = await until(async () => (await targets()).find((t) => t.url.endsWith("sidepanel.html?gesture")), 20000, "gesture page");
  await until(async () => await evalIn(gesture, `(async()=>{ const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); return true; })()`, true), 20000, "open panel");
  let panel = await until(async () => (await targets()).find((t) => t.url.endsWith("/sidepanel.html")), 20000, "panel");
  await evalIn(worker, `chrome.tabs.remove(${gestureTab}).then(()=>true)`);
  await until(async () => await evalIn(panel, `document.getElementById("log").children.length > 3`), 30000, "panel rendered");
  // The nested compositor's "started without start-hyprland" notice times out
  // after about forty seconds; nothing dismisses it sooner.
  await sleep(2000);
  // The panel's debugger endpoint can be replaced while idle; look it up again.
  panel = await until(async () => (await targets()).find((t) => t.url.endsWith("/sidepanel.html")), 20000, "panel again");
  await evalIn(panel, `(() => { const l = document.getElementById("log"); l.scrollTop = l.scrollHeight; return true; })()`); await sleep(400);
  await shot("1-conversation");
  panel = await findPanel(); log("opening menu"); await evalIn(panel, `document.getElementById("more").click(); true`); await sleep(500);
  await shot("3-menu");
  panel = await findPanel(); await evalIn(panel, `document.getElementById("menu").hidden = true; true`);
  // The consent card, staged with the panel's own markup and styles.
  await evalIn(panel, `(() => { const log = document.getElementById("log"); const node = document.createElement("div"); node.className = "confirm";
    node.innerHTML = '<div class="who">javascript — run this in the page?</div><pre>document.querySelector("h1").textContent</pre><div class="row"><button class="primary" type="button">Run it</button><button type="button">Don\\'t</button></div>';
    log.append(node); log.scrollTop = log.scrollHeight; return true; })()`); await sleep(500);
  await shot("2-consent");
} finally {
  child.kill("SIGKILL"); await sleep(300); rmSync(profile, { recursive: true, force: true });
}
