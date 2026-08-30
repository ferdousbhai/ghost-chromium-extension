/**
 * The service worker: one outbound WebSocket to ghostd, and a dispatcher.
 *
 * **The extension dials out.** A service worker cannot listen on a socket, so
 * somebody has to be the server and it is the daemon. This is also what makes the
 * whole arrangement survive normal life: ghostd restarts and the extension
 * reconnects; the owner closes Chromium and the daemon simply reports the relay
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
 * `ghostd relay-token` prints; this worker keeps it in `chrome.storage.local`
 * and sends it in the one field a browser `WebSocket` lets you set: the
 * subprotocol list.
 */
import { PROTOCOL_VERSION, RELAY_PATH, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX, toErrorFrame } from "./protocol.js";
import {
  installOpsListeners,
  repairBrowserPersistence,
  reconcileDaemonIncarnation,
  releaseAllTabs,
  restoreTabsFromSession,
  runOp,
  startOp,
  sweepRetiredTabs,
} from "./ops.js";

const DEFAULT_PORT = 7717;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const PROTOCOL_RETRY_MS = 60_000;
const SETTINGS_TIMEOUT_MS = 1_000;
const SETTINGS_FENCE_KEY = "ghostRelaySettingsFence";
const SETTINGS_FENCE_BACKUP_KEY = "ghostRelaySettingsFenceBackup";
const SETTINGS_FENCE_VERSION = 1;
const KEEPALIVE_ALARM = "ghost-relay-keepalive";
const settingsStorage = chrome.storage.local;
const actionApi = chrome.action;

let ws = null;
/**
 * Covers the whole prepare-and-dial sequence, not just `new WebSocket()`. MV3
 * lifecycle events can call `connect()` together while storage and session
 * restoration are still awaiting; without this latch each caller reaches the
 * constructor before any of them assigns `ws`.
 */
let connectInFlight = null;
let connectEpoch = 0;
/**
 * Settings are read once per service-worker lifetime, then invalidated by the
 * storage change event. The generation makes an already-running read retry
 * rather than publishing values that changed while it was awaiting Chrome.
 */
let settingsGeneration = 0;
let settingsCache = null;
let settingsInFlight = null;
let settingsRevision = 0;
let settingsDesired = null;
let settingsRepairPending = false;
let settingsRepairInFlight = null;
let settingsMutationTail = Promise.resolve();
let settingsStorageTail = Promise.resolve();
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let reconnectTimerIncompatible = false;
let pingTimer = null;
/** The current socket only becomes connected after its compatible welcome. */
let welcomedSocket = null;
let lastError = "";
/**
 * Latched when the daemon's `welcome` reports a protocol version this extension
 * cannot speak. A mismatch does not heal by dialing again — the socket opens
 * fine every time and only the `welcome` reveals the problem — so retrying is a
 * permanent 1s reconnect storm. While latched, alarms are suppressed and one
 * slow retry checks whether the owner has updated the daemon or extension.
 */
let protocolIncompatible = false;
/** Per-protocol-session request-start ordering; durable tombstones live in ops. */
const sessionTails = new Map();

function normalizeSettings(stored = {}) {
  return {
    port: Number(stored.port) || DEFAULT_PORT,
    token: typeof stored.token === "string" ? stored.token.trim() : "",
    enabled: stored.enabled !== false,
    unavailable: null,
  };
}

function sameSettings(left, right) {
  return left.port === right.port
    && left.token === right.token
    && left.enabled === right.enabled;
}

function parseSettingsFence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "revision,settings,version"
      || value.version !== SETTINGS_FENCE_VERSION
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.settings !== "object" || value.settings === null
      || Array.isArray(value.settings)
      || Object.keys(value.settings).sort().join(",") !== "enabled,port,token"
      || !Number.isSafeInteger(value.settings.port)
      || value.settings.port < 1 || value.settings.port > 65_535
      || typeof value.settings.token !== "string"
      || typeof value.settings.enabled !== "boolean") return undefined;
  return value;
}

function selectSettingsFence(primary, backup) {
  const left = parseSettingsFence(primary);
  const right = parseSettingsFence(backup);
  if (left === undefined || right === undefined) return undefined;
  if (left === null) return right;
  if (right === null) return left;
  if (left.revision === right.revision) {
    // The backup slot is written second and is therefore the commit record if
    // a dead worker's unacknowledged first-slot write arrives late.
    return right;
  }
  return left.revision > right.revision ? left : right;
}

function queueSettingsFence(publication) {
  const write = async () => {
    await settingsStorage.set({ [SETTINGS_FENCE_KEY]: publication });
    await settingsStorage.set({ [SETTINGS_FENCE_BACKUP_KEY]: publication });
  };
  const task = settingsStorageTail.then(write, write);
  settingsStorageTail = task.then(() => undefined, () => undefined);
  return task;
}

function scheduleSettingsRepair() {
  settingsRepairPending = true;
  if (settingsRepairInFlight !== null || settingsDesired === null) return;
  const revision = settingsRevision;
  const desired = settingsDesired;
  const publication = {
    version: SETTINGS_FENCE_VERSION,
    revision,
    settings: desired,
  };
  settingsRepairPending = false;
  const attempt = (async () => {
    const fenceWrite = queueSettingsFence(publication);
    await withPreparationTimeout(
      fenceWrite,
      SETTINGS_TIMEOUT_MS,
      "Chromium did not repair the relay settings fence in time.",
    );
    const rawWrite = settingsStorage.set(desired);
    observeSettingsWrite(rawWrite, revision);
    await withPreparationTimeout(
      rawWrite,
      SETTINGS_TIMEOUT_MS,
      "Chromium did not repair the relay settings in time.",
    );
  })()
    .catch(() => {
      settingsRepairPending = true;
    })
    .finally(() => {
      if (settingsRepairInFlight === attempt) settingsRepairInFlight = null;
      if (revision !== settingsRevision) {
        settingsRepairPending = true;
        queueMicrotask(scheduleSettingsRepair);
      }
    });
  settingsRepairInFlight = attempt;
}

function observeSettingsWrite(raw, revision) {
  void raw.then(
    () => {
      if (revision !== settingsRevision) scheduleSettingsRepair();
    },
    () => {},
  );
}

function withPreparationTimeout(promise, timeoutMs, message) {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const onTimeout = () => reject(new Error(message));
    signal.addEventListener("abort", onTimeout, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onTimeout);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onTimeout);
        reject(error);
      },
    );
  });
}

function loadSettings() {
  if (settingsCache !== null) return Promise.resolve(settingsCache);
  if (settingsInFlight !== null) return settingsInFlight;

  const generation = settingsGeneration;
  const attempt = withPreparationTimeout(
    settingsStorage.get({
      port: DEFAULT_PORT,
      token: "",
      enabled: true,
      [SETTINGS_FENCE_KEY]: null,
      [SETTINGS_FENCE_BACKUP_KEY]: null,
    }),
    SETTINGS_TIMEOUT_MS,
    "Chromium did not return the relay settings in time.",
  )
    .then((stored) => {
        const fence = selectSettingsFence(
          stored[SETTINGS_FENCE_KEY],
          stored[SETTINGS_FENCE_BACKUP_KEY],
        );
        if (fence === undefined) {
          throw new Error("Stored relay settings recovery is invalid; reload the extension.");
        }
        const raw = normalizeSettings(stored);
        const settings = fence?.settings ?? raw;
        if (fence !== null) {
          settingsRevision = Math.max(settingsRevision, fence.revision);
          settingsDesired = settings;
          if (!sameSettings(raw, settings)) scheduleSettingsRepair();
        } else {
          settingsDesired ??= settings;
        }
        return { settings: { ...settings, unavailable: null }, cacheable: true };
      })
    .catch((error) => ({
        settings: {
          ...normalizeSettings(),
          unavailable: error?.message ?? String(error),
        },
        cacheable: false,
      }))
    .then(({ settings, cacheable }) => {
      if (generation !== settingsGeneration) return loadSettings();
      // A transient Chrome storage failure must not pin unpaired defaults for
      // the rest of this worker's lifetime; retry on the next caller instead.
      if (cacheable) settingsCache = settings;
      return settings;
    });
  settingsInFlight = attempt;
  const clearAttempt = () => {
    if (settingsInFlight === attempt) settingsInFlight = null;
  };
  void attempt.then(clearAttempt, clearAttempt);
  return attempt;
}

function serializeSettingsMutation(work) {
  const task = settingsMutationTail.then(work, work);
  settingsMutationTail = task.then(() => undefined, () => undefined);
  return task;
}

function updateRelaySettings(patch) {
  return serializeSettingsMutation(async () => {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("The relay settings update must be an object.");
    }
    const keys = Object.keys(patch);
    if (keys.length === 0 || keys.some((key) => !["port", "token", "enabled"].includes(key))) {
      throw new Error("The relay settings update contains an unsupported field.");
    }
    if (Object.hasOwn(patch, "port")
        && (!Number.isSafeInteger(patch.port) || patch.port < 1 || patch.port > 65_535)) {
      throw new Error("The relay port must be an integer from 1 through 65535.");
    }
    if (Object.hasOwn(patch, "token") && typeof patch.token !== "string") {
      throw new Error("The relay token must be a string.");
    }
    if (Object.hasOwn(patch, "enabled") && typeof patch.enabled !== "boolean") {
      throw new Error("The relay enabled setting must be a boolean.");
    }

    const current = await loadSettings();
    if (current.unavailable !== null) throw new Error(current.unavailable);
    const next = {
      port: patch.port ?? current.port,
      token: patch.token?.trim() ?? current.token,
      enabled: patch.enabled ?? current.enabled,
    };
    const publication = {
      version: SETTINGS_FENCE_VERSION,
      revision: settingsRevision + 2,
      settings: next,
    };
    settingsRevision = publication.revision;
    settingsDesired = next;
    settingsCache = { ...next, unavailable: null };
    const fenceWrite = queueSettingsFence(publication);
    try {
      await withPreparationTimeout(
        fenceWrite,
        SETTINGS_TIMEOUT_MS,
        "Chromium did not fence the relay settings in time.",
      );
    } catch (error) {
      scheduleSettingsRepair();
      throw error;
    }
    const raw = settingsStorage.set(next);
    observeSettingsWrite(raw, publication.revision);
    try {
      await withPreparationTimeout(
        raw,
        SETTINGS_TIMEOUT_MS,
        "Chromium did not save the relay settings in time.",
      );
    } catch (error) {
      scheduleSettingsRepair();
      throw error;
    }
    return next;
  });
}

function invalidateSettings() {
  settingsGeneration += 1;
  settingsCache = null;
  settingsInFlight = null;
}

function setBadge(status) {
  const look = {
    on: { text: "on", color: "#1a7f37" },
    paused: { text: "||", color: "#9a6700" },
    off: { text: "off", color: "#8b8b8b" },
  }[status];
  // Cosmetic calls never own connection progress: Chrome may leave either
  // Promise pending while the action UI is rebuilding.
  void Promise.resolve()
    .then(() => actionApi.setBadgeText({ text: look.text }))
    .catch(() => {});
  void Promise.resolve()
    .then(() => actionApi.setBadgeBackgroundColor({ color: look.color }))
    .catch(() => {});
}

function sendTo(socket, frame) {
  if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function send(frame) {
  if (welcomedSocket !== null && welcomedSocket === ws) sendTo(welcomedSocket, frame);
}

function notice(event, data) {
  send({ t: "event", event, ...(data ? { data } : {}) });
}

async function refreshBadge() {
  const { enabled, unavailable } = await loadSettings();
  const connected = unavailable === null
    && ws !== null && welcomedSocket === ws && ws.readyState === WebSocket.OPEN;
  await setBadge(connected ? (enabled ? "on" : "paused") : "off");
}


function cancelReconnect() {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectTimerIncompatible = false;
}

function scheduleReconnect() {
  const incompatible = protocolIncompatible;
  if (reconnectTimer !== null) {
    if (!incompatible || reconnectTimerIncompatible) return;
    cancelReconnect();
  }
  const delay = incompatible ? PROTOCOL_RETRY_MS : reconnectDelay;
  if (incompatible) void setBadge("off");
  else reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimerIncompatible = incompatible;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectTimerIncompatible = false;
    // Keep alarm-driven attempts latched during the cool-down, then give exactly
    // this scheduled probe permission to negotiate the newly updated peer.
    if (incompatible) protocolIncompatible = false;
    void connect();
  }, delay);
}

async function connectOnce(epoch) {
  if (protocolIncompatible) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const settings = await loadSettings();
  if (epoch !== connectEpoch) return;
  if (settings.unavailable !== null) {
    throw new Error(`Could not read relay settings: ${settings.unavailable}`);
  }
  if (!settings.token) {
    lastError = "Not paired yet — run `ghostd relay-token` and paste the token below.";
    await setBadge("off");
    return;
  }

  await repairBrowserPersistence();
  await restoreTabsFromSession();
  await sweepRetiredTabs().catch(() => undefined);
  await repairBrowserPersistence();
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
  welcomedSocket = null;

  socket.onopen = () => {
    if (ws !== socket) {
      socket.close(1000, "superseded");
      return;
    }
    // A socket is not admitted yet. Protocol 4 waits for the daemon's
    // incarnation-bearing welcome and retires claims from an earlier daemon
    // process before sending hello.
    void setBadge("off");
  };

  socket.onmessage = (event) => {
    if (typeof event.data === "string") void handleFrame(socket, event.data);
  };

  socket.onerror = () => {
    // Funnel every failure through one path; onclose does the reconnect.
    socket.close();
  };

  socket.onclose = (event) => {
    // A newer socket already took over: this close belongs to a dead one.
    if (ws !== socket) return;
    ws = null;
    if (welcomedSocket === socket) welcomedSocket = null;
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
    // Let go of the debugger so the owner's tab is not left with a banner over
    // a relay that is no longer there.
    void releaseAllTabs();
    scheduleReconnect();
  };
}

function connect() {
  if (protocolIncompatible) return Promise.resolve();
  if (connectInFlight !== null) return connectInFlight;
  cancelReconnect();

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

async function answerRequest(socket, frame) {
  const settings = await loadSettings();
  if (settings.unavailable !== null && frame.op !== "status") {
    sendTo(socket, {
      t: "res",
      id: frame.id,
      ok: false,
      error: {
        failure: "browser_unavailable",
        message:
          `Chromium could not verify the relay settings: ${settings.unavailable} `
          + "Retry after the extension finishes restoring them.",
      },
    });
    return false;
  }
  const { enabled } = settings;
  if (!enabled && frame.op !== "status") {
    sendTo(socket, {
      t: "res",
      id: frame.id,
      ok: false,
      error: {
        failure: "browser_unavailable",
        message:
          "The Ghost relay is paused. The owner can resume it from the "
          + "extension's popup in Chromium.",
      },
    });
    return false;
  }

  let operation;
  try {
    operation = startOp(frame.op, frame.args ?? {}, frame.timeoutMs ?? 30_000);
  } catch (error) {
    sendTo(socket, toErrorFrame(frame.id, error));
    return false;
  }
  try {
    const result = await operation.response;
    sendTo(socket, { t: "res", id: frame.id, ok: true, result });
  } catch (error) {
    sendTo(socket, toErrorFrame(frame.id, error));
  }
}

function queueRequest(socket, frame) {
  const session = typeof frame.args?.session === "string" && frame.args.session !== ""
    ? frame.args.session
    : null;
  if (session === null) return answerRequest(socket, frame);
  const previous = sessionTails.get(session) ?? Promise.resolve();
  const run = () => answerRequest(socket, frame);
  const task = previous.then(run, run);
  sessionTails.set(session, task);
  const clear = () => {
    if (sessionTails.get(session) === task) sessionTails.delete(session);
  };
  void task.then(clear, clear);
  return task;
}

async function handleFrame(socket, raw) {
  if (ws !== socket) return;
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
      socket.close(4000, lastError);
      return;
    }
    try {
      await repairBrowserPersistence();
      await reconcileDaemonIncarnation(frame.incarnation);
      await repairBrowserPersistence();
    } catch (error) {
      if (ws !== socket) return;
      lastError = error?.message ?? String(error);
      socket.close(4000, lastError.slice(0, 120));
      return;
    }
    if (ws !== socket) return;
    sendTo(socket, {
      t: "hello",
      protocol: PROTOCOL_VERSION,
      agent: `ghost-relay/${chrome.runtime.getManifest().version}`,
      browser: /Chrom(e|ium)\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? "Chromium",
    });
    // A compatible daemon has greeted us: only now is the connection truly good,
    // so only now is the backoff safe to reset.
    protocolIncompatible = false;
    reconnectDelay = RECONNECT_MIN_MS;
    cancelReconnect();
    welcomedSocket = socket;
    lastError = "";
    clearInterval(pingTimer ?? undefined);
    // Not liveness — this is what keeps the service worker from being reaped
    // between two of the ghost's tool calls.
    pingTimer = setInterval(() => notice("ping", null), PING_INTERVAL_MS);
    void refreshBadge();
    return;
  }
  if (frame?.t !== "req" || typeof frame.id !== "number") return;
  if (welcomedSocket !== socket) return;
  return queueRequest(socket, frame);
}


installOpsListeners(notice);

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (settingsRepairPending) scheduleSettingsRepair();
    void repairBrowserPersistence().catch(() => {});
    void sweepRetiredTabs().catch(() => {});
    void connect();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.port || changes.token || changes.enabled) invalidateSettings();
  if (changes.port || changes.token) {
    // Re-dial with the new settings rather than waiting for the next alarm. New
    // settings can mean a fixed daemon, so clear the protocol latch and give it
    // a fresh chance.
    connectEpoch += 1;
    protocolIncompatible = false;
    cancelReconnect();
    const oldSocket = ws;
    ws = null;
    if (welcomedSocket === oldSocket) welcomedSocket = null;
    oldSocket?.close(1000, "settings changed");
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    void releaseAllTabs();
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

// Restrict live relay state to this extension's installed popup.
function isPopupSender(sender) {
  return sender?.id === chrome.runtime.id
    && sender?.url === chrome.runtime.getURL("popup.html")
    && sender.tab === undefined;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isPopupSender(sender)) return undefined;
  if (message?.type === "ghost-relay-settings-update") {
    void updateRelaySettings(message.settings).then(
      (settings) => respond({ ok: true, settings }),
      (error) => respond({
        ok: false,
        error: error?.message ?? String(error),
      }),
    );
    return true;
  }
  if (message?.type !== "ghost-relay-status") return undefined;
  void (async () => {
    const settings = await loadSettings();
    let tabs = [];
    try {
      const status = await runOp("status", {}, 2_000);
      if (Array.isArray(status.tabs)) tabs = status.tabs;
    } catch {
      // No tab yet is the normal case.
    }
    respond({
      connected: ws !== null && welcomedSocket === ws && ws.readyState === WebSocket.OPEN,
      paired: settings.token !== "",
      token: settings.token,
      enabled: settings.enabled,
      port: settings.port,
      lastError,
      tabs,
    });
  })();
  return true;
});

void connect();
