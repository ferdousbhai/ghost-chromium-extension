/**
 * The service worker: one outbound WebSocket to ghostd, and a dispatcher.
 *
 * **The extension dials out.** A service worker cannot listen on a socket, so
 * somebody has to be the server and it is the daemon. This is also what makes the
 * whole arrangement survive normal life: ghostd restarts and the extension
 * reconnects; the creator closes Chromium and the daemon simply reports the relay
 * as disconnected. Nothing has to be started in a particular order.
 *
 * **Staying alive is the hard part of MV3.** A background service worker is killed
 * after ~30s idle. Three mechanisms, all necessary:
 *
 *   1. WebSocket traffic resets the idle timer (Chrome 116+), so a 20s app-level
 *      ping is not a heartbeat — it is life support.
 *   2. `chrome.alarms` at 30s wakes the worker back up after Chrome kills it
 *      anyway, and the top-level `connect()` on a fresh worker re-dials.
 *   3. `onInstalled` / `onStartup` cover the cold cases.
 *
 * Without (1) the ghost's second tool call would find a dead relay; without (2) it
 * would stay dead. Both are ported from oh-my-pi's `browser-relay` extension, which
 * is where these were learned the expensive way.
 *
 * **Pairing is a token, typed once.** The popup asks for the string
 * `ghostd relay-token` prints, keeps it in `chrome.storage.local`, and sends it in
 * the one field a browser `WebSocket` lets you set: the subprotocol list.
 */
import { PROTOCOL_VERSION, RELAY_PATH, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX, toErrorFrame } from "./protocol.js";
import { installOpsListeners, releaseTab, restoreTabFromSession, runOp } from "./ops.js";

const DEFAULT_PORT = 7717;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const KEEPALIVE_ALARM = "ghost-relay-keepalive";

let ws = null;
/**
 * Covers the whole prepare-and-dial sequence, not just `new WebSocket()`. MV3
 * lifecycle events can call `connect()` together while storage and session
 * restoration are still awaiting; without this latch each caller reaches the
 * constructor before any of them assigns `ws`.
 */
let connectInFlight = null;
/** Invalidates settings captured by an attempt that is already awaiting. */
let connectEpoch = 0;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer = null;
/** The last refusal from the daemon, so the popup can explain itself. */
let lastError = "";
/**
 * Latched when the daemon's `welcome` reports a protocol version this extension
 * cannot speak. A mismatch does not heal by dialing again — the socket opens
 * fine every time and only the `welcome` reveals the problem — so retrying is a
 * permanent 1s reconnect storm. While latched, every reconnect is suppressed;
 * it is cleared only when the settings change or the extension is re-installed
 * (either can mean a fixed daemon or a fixed extension).
 */
let protocolIncompatible = false;

async function loadSettings() {
  const stored = await chrome.storage.local
    .get({ port: DEFAULT_PORT, token: "", enabled: true })
    .catch(() => ({ port: DEFAULT_PORT, token: "", enabled: true }));
  return {
    port: Number(stored.port) || DEFAULT_PORT,
    token: typeof stored.token === "string" ? stored.token.trim() : "",
    enabled: stored.enabled !== false,
  };
}

/** The badge is the whole status UI at a glance; never let it break the relay. */
async function setBadge(status) {
  const look = {
    on: { text: "on", color: "#1a7f37" },
    paused: { text: "||", color: "#9a6700" },
    off: { text: "off", color: "#8b8b8b" },
  }[status];
  try {
    await chrome.action.setBadgeText({ text: look.text });
    await chrome.action.setBadgeBackgroundColor({ color: look.color });
  } catch {
    // Cosmetic.
  }
}

function send(frame) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function notice(event, data) {
  send({ t: "event", event, ...(data ? { data } : {}) });
}

async function refreshBadge() {
  const { enabled } = await loadSettings();
  const connected = ws !== null && ws.readyState === WebSocket.OPEN;
  await setBadge(connected ? (enabled ? "on" : "paused") : "off");
}

// ------------------------------------------------------------------ the socket

function scheduleReconnect() {
  if (protocolIncompatible) {
    // A version mismatch will not fix itself by dialing again. Sit tight until
    // the creator updates one side and the settings change (or reinstall) clears
    // the latch, rather than reconnecting every second forever.
    void setBadge("off");
    return;
  }
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  setTimeout(() => void connect(), delay);
}

async function connectOnce(epoch) {
  if (protocolIncompatible) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const settings = await loadSettings();
  if (epoch !== connectEpoch) return;
  if (!settings.token) {
    lastError = "Not paired yet — run `ghostd relay-token` and paste the token below.";
    await setBadge("off");
    return;
  }

  await restoreTabFromSession();
  if (epoch !== connectEpoch) return;

  // A browser WebSocket cannot set headers, so the token rides in the one field
  // it can set. The daemon accepts it there, or in a query string for non-browser
  // clients; the subprotocol keeps it out of anything that logs URLs.
  const url = `ws://127.0.0.1:${settings.port}${RELAY_PATH}`;
  let socket;
  try {
    socket = new WebSocket(url, [SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX + settings.token]);
  } catch (error) {
    lastError = `Could not open ${url}: ${error?.message ?? error}`;
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    // The backoff is NOT reset here: a socket opens even against a daemon whose
    // protocol we cannot speak, and resetting now is exactly what turns that into
    // a 1s storm. It is reset only once `welcome` is accepted (see handleFrame).
    lastError = "";
    send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      agent: `ghost-relay/${chrome.runtime.getManifest().version}`,
      browser: /Chrom(e|ium)\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? "Chromium",
    });
    clearInterval(pingTimer ?? undefined);
    // Not liveness — this is what keeps the service worker from being reaped
    // between two of the ghost's tool calls.
    pingTimer = setInterval(() => notice("ping", null), PING_INTERVAL_MS);
    void refreshBadge();
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") void handleFrame(event.data);
  };

  socket.onerror = () => {
    // Funnel every failure through one path; onclose does the reconnect.
    socket.close();
  };

  socket.onclose = (event) => {
    // A newer socket already took over: this close belongs to a dead one.
    if (ws !== socket) return;
    ws = null;
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (event?.code === 4000 || (event?.reason && event.code !== 1000 && event.code !== 1001)) {
      lastError = event.reason || `The daemon closed the relay (code ${event.code}).`;
    } else if (event?.code === 1006) {
      lastError = "ghostd is not answering on that port. Is it running?";
    }
    void setBadge("off");
    // Let go of the debugger so the creator's tab is not left with a banner over
    // a relay that is no longer there.
    void releaseTab();
    scheduleReconnect();
  };
}

function connect() {
  if (protocolIncompatible) return Promise.resolve();
  if (connectInFlight !== null) return connectInFlight;

  const epoch = connectEpoch;
  const attempt = connectOnce(epoch).catch((error) => {
    // `loadSettings()` and session restoration are expected to contain their
    // own recoverable failures. Keep this boundary anyway: a future async setup
    // step must not leave the single-flight latch permanently rejected.
    if (epoch !== connectEpoch) return;
    lastError = `Could not prepare the relay connection: ${error?.message ?? error}`;
    void setBadge("off");
    scheduleReconnect();
  });
  connectInFlight = attempt;
  void attempt.finally(() => {
    if (connectInFlight !== attempt) return;
    connectInFlight = null;
    // Pairing may have changed while this attempt was awaiting. Its epoch
    // checks prevent a stale dial; this follow-up uses the latest settings.
    if (epoch !== connectEpoch) void connect();
  });
  return attempt;
}

async function handleFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (frame?.t === "welcome") {
    if (frame.protocol !== PROTOCOL_VERSION) {
      protocolIncompatible = true;
      lastError =
        `ghostd speaks relay protocol ${frame.protocol}; this extension speaks `
        + `${PROTOCOL_VERSION}. Update whichever is older.`;
      ws?.close(4000, lastError);
      return;
    }
    // A compatible daemon has greeted us: only now is the connection truly good,
    // so only now is the backoff safe to reset.
    protocolIncompatible = false;
    reconnectDelay = RECONNECT_MIN_MS;
    return;
  }
  if (frame?.t !== "req" || typeof frame.id !== "number") return;

  const { enabled } = await loadSettings();
  if (!enabled && frame.op !== "status") {
    send({
      t: "res",
      id: frame.id,
      ok: false,
      error: {
        failure: "browser_unavailable",
        message:
          "The Ghost relay is paused. The creator can resume it from the "
          + "extension's popup in Chromium.",
      },
    });
    return;
  }

  try {
    const result = await runOp(frame.op, frame.args ?? {}, frame.timeoutMs ?? 30_000);
    send({ t: "res", id: frame.id, ok: true, result });
  } catch (error) {
    send(toErrorFrame(frame.id, error));
  }
}

// -------------------------------------------------------------------- lifecycle

installOpsListeners(notice);

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void connect();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.port || changes.token) {
    // Re-dial with the new settings rather than waiting for the next alarm. New
    // settings can mean a fixed daemon, so clear the protocol latch and give it
    // a fresh chance.
    connectEpoch += 1;
    protocolIncompatible = false;
    ws?.close(1000, "settings changed");
    ws = null;
    reconnectDelay = RECONNECT_MIN_MS;
    void connect();
    return;
  }
  if (changes.enabled) {
    void refreshBadge();
    notice("enabled_changed", { enabled: changes.enabled.newValue !== false });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // A fresh install or update may speak a new protocol version; clear any latch
  // from a prior version so it can greet the daemon again.
  protocolIncompatible = false;
  void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());

/** The popup asks for state rather than reaching into the worker's variables. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== "ghost-relay-status") return undefined;
  void (async () => {
    const settings = await loadSettings();
    let tab = null;
    try {
      const status = await runOp("status", {}, 2_000);
      tab = status.tab;
    } catch {
      // No tab yet is the normal case.
    }
    respond({
      connected: ws !== null && ws.readyState === WebSocket.OPEN,
      paired: settings.token !== "",
      enabled: settings.enabled,
      port: settings.port,
      lastError,
      tab,
    });
  })();
  return true;
});

void connect();
