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
 * **Pairing is a token, delivered once.** The daemon hands it over the socket
 * when the owner allows this browser's code (or the owner pastes it under
 * Advanced in the side panel); this worker keeps it in `chrome.storage.local`
 * and sends it in the one field a browser `WebSocket` lets you set: the
 * subprotocol list.
 */
import {
  FAILURES,
  PAIR_SUBPROTOCOL_PREFIX,
  PROTOCOL_VERSION,
  RELAY_PATH,
  SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  toErrorFrame,
} from "./protocol.js";
import { isLocalSession, newLocalSession } from "./local-session.js";
import { KEY_STORE } from "./openrouter.js";
import {
  allTabInfos,
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
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let reconnectTimerIncompatible = false;
let pingTimer = null;
/** The current socket only becomes connected after its compatible welcome. */
let welcomedSocket = null;
let lastError = "";
// Pairing: the six-digit code this unpaired browser is showing, the socket it is
// waiting on, and whether the owner said no (which stops redialing until the
// panel asks again).
let pairingCode = null;
let pairingSocket = null;
let pairingDenied = false;
// The code survives a worker restart (chrome.storage.session), so the number
// on the HUD stays the number in the panel even if Chromium reaps the worker.
const PAIRING_CODE_KEY = "ghostPairingCode";
const PAIRING_DENIED_MESSAGE = "Ghost denied this browser. Try again to ask once more.";
const PAIRING_WAITING_MESSAGE = "Open Ghost (Super+Ctrl+G) and choose Allow for this code.";
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

function describeError(error) {
  return error?.message ?? String(error);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A one-at-a-time queue: the next task starts only once the previous one has
 * settled. Two storage writes that overtake each other leave the older value on
 * disk, so everything that must not regress runs through one of these tails,
 * and a failed task never stalls the ones behind it.
 */
function makeQueue() {
  let tail = Promise.resolve();
  return function enqueue(work) {
    const task = tail.then(work, work);
    tail = task.then(() => undefined, () => undefined);
    return task;
  };
}

const queueSettingsWrite = makeQueue();
const queueSettingsMutation = makeQueue();
const queueLocalSessionsWrite = makeQueue();

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

/**
 * Three answers, and the caller depends on the difference: the fence itself,
 * `null` for "nothing stored yet" (the normal first run), and `undefined` for
 * "stored something this worker refuses to trust".
 */
function parseSettingsFence(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).sort().join(",") !== "revision,settings,version") return undefined;
  if (value.version !== SETTINGS_FENCE_VERSION) return undefined;
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) return undefined;
  const { settings } = value;
  if (!isPlainObject(settings)) return undefined;
  if (Object.keys(settings).sort().join(",") !== "enabled,port,token") return undefined;
  if (!Number.isSafeInteger(settings.port) || settings.port < 1 || settings.port > 65_535) {
    return undefined;
  }
  if (typeof settings.token !== "string" || typeof settings.enabled !== "boolean") return undefined;
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
  return queueSettingsWrite(async () => {
    await settingsStorage.set({ [SETTINGS_FENCE_KEY]: publication });
    await settingsStorage.set({ [SETTINGS_FENCE_BACKUP_KEY]: publication });
  });
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

/** The durable fence wins over the raw keys, and repairs them when they differ. */
async function readSettings() {
  const stored = await withPreparationTimeout(
    settingsStorage.get({
      port: DEFAULT_PORT,
      token: "",
      enabled: true,
      [SETTINGS_FENCE_KEY]: null,
      [SETTINGS_FENCE_BACKUP_KEY]: null,
    }),
    SETTINGS_TIMEOUT_MS,
    "Chromium did not return the relay settings in time.",
  );
  const fence = selectSettingsFence(
    stored[SETTINGS_FENCE_KEY],
    stored[SETTINGS_FENCE_BACKUP_KEY],
  );
  if (fence === undefined) {
    throw new Error("Stored relay settings recovery is invalid; reload the extension.");
  }
  const raw = normalizeSettings(stored);
  const settings = fence?.settings ?? raw;
  if (fence === null) {
    settingsDesired ??= settings;
  } else {
    settingsRevision = Math.max(settingsRevision, fence.revision);
    settingsDesired = settings;
    if (!sameSettings(raw, settings)) scheduleSettingsRepair();
  }
  return { ...settings, unavailable: null };
}

function loadSettings() {
  if (settingsCache !== null) return Promise.resolve(settingsCache);
  if (settingsInFlight !== null) return settingsInFlight;

  const generation = settingsGeneration;
  const attempt = (async () => {
    let settings;
    let cacheable = true;
    try {
      settings = await readSettings();
    } catch (error) {
      settings = { ...normalizeSettings(), unavailable: describeError(error) };
      // A transient Chrome storage failure must not pin unpaired defaults for
      // the rest of this worker's lifetime; retry on the next caller instead.
      cacheable = false;
    }
    if (generation !== settingsGeneration) return loadSettings();
    if (cacheable) settingsCache = settings;
    return settings;
  })();
  settingsInFlight = attempt;
  const clearAttempt = () => {
    if (settingsInFlight === attempt) settingsInFlight = null;
  };
  void attempt.then(clearAttempt, clearAttempt);
  return attempt;
}

function updateRelaySettings(patch) {
  return queueSettingsMutation(async () => {
    if (!isPlainObject(patch)) {
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

/** Panel readiness, once read: `true`, `false`, or `null` for "ask again". */
let chatReadyCache = null;
/** Only the newest refresh may paint: two in flight can settle out of order. */
let badgeGeneration = 0;

/**
 * Whether this browser holds an OpenRouter key, which is the side panel's whole
 * readiness condition. One bit, for the badge: the worker never keeps the key
 * itself, and the panel is still the only document that reads its value or
 * sends it anywhere.
 */
async function loadChatReady() {
  if (chatReadyCache !== null) return chatReadyCache;
  try {
    const stored = await withPreparationTimeout(
      settingsStorage.get({ [KEY_STORE]: null }),
      SETTINGS_TIMEOUT_MS,
      "Chromium did not return the panel's credential state in time.",
    );
    chatReadyCache = typeof stored?.[KEY_STORE] === "string" && stored[KEY_STORE] !== "";
    return chatReadyCache;
  } catch {
    // Cosmetic like the rest of the badge: an unreadable store reads as no chat
    // for this refresh, and the next one asks again.
    return false;
  }
}

const BADGE_LOOKS = {
  on: { text: "on", color: "#1a7f37" },
  paused: { text: "||", color: "#9a6700" },
  off: { text: "off", color: "#8b8b8b" },
};

/**
 * Cosmetic calls never own connection progress: Chrome may leave any of these
 * Promises pending while the action UI is rebuilding.
 */
function paint(call) {
  void Promise.resolve().then(call).catch(() => {});
}

function setBadge(status, title) {
  const look = BADGE_LOOKS[status];
  paint(() => actionApi.setBadgeText({ text: look.text }));
  paint(() => actionApi.setBadgeBackgroundColor({ color: look.color }));
  // The badge has room for two characters; the tooltip is where the sentence
  // goes. `setTitle` is absent in the test harness, hence the optional call.
  paint(() => actionApi.setTitle?.({ title }));
}

/**
 * What the badge means, in one place.
 *
 * It is a readiness light for the extension, not a connection lamp for ghostd.
 * A browser holding an OpenRouter key chats and drives its own tabs from the
 * side panel with no daemon anywhere, and reading `off` forever told that owner
 * their working extension was dead. `off` now means this browser cannot act:
 * nothing set up yet, or a ghost link the owner did set up that is down — which
 * is worth showing, and is the one case where a working panel still reads grey.
 */
function badgeFor({ connected, enabled, paired, chatReady, incompatible }) {
  if (!connected && !paired && !chatReady) {
    return { status: "off", title: "Ghost — not set up yet" };
  }
  if (!enabled) return { status: "paused", title: "Ghost — paused" };
  const chat = chatReady ? "chat ready · " : "";
  if (connected) return { status: "on", title: `Ghost — ${chat}ghost attached` };
  if (paired || incompatible) {
    const trouble = incompatible
      ? "ghostd speaks a different relay protocol"
      : "ghostd not answering";
    return { status: "off", title: `Ghost — ${chat}${trouble}` };
  }
  return { status: "on", title: "Ghost — chat ready · no ghost paired" };
}

/** Ours, open, and past a compatible welcome — the only state worth calling up. */
function isConnected() {
  return ws !== null && welcomedSocket === ws && ws.readyState === WebSocket.OPEN;
}

/** A socket already open or on its way: a second dial would orphan it. */
function hasLiveSocket() {
  return ws !== null
    && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function stopPing() {
  if (pingTimer === null) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function sendTo(socket, frame) {
  if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function notice(event, data) {
  if (!isConnected()) return;
  sendTo(welcomedSocket, { t: "event", event, ...(data ? { data } : {}) });
}

async function refreshBadge() {
  const generation = (badgeGeneration += 1);
  const [{ enabled, token, unavailable }, chatReady] = await Promise.all([
    loadSettings(),
    loadChatReady(),
  ]);
  // A close and a storage change can race; the one that started last is the
  // one that knows the current state.
  if (generation !== badgeGeneration) return;
  const { status, title } = badgeFor({
    connected: unavailable === null && isConnected(),
    enabled,
    paired: token !== "",
    chatReady,
    incompatible: protocolIncompatible,
  });
  setBadge(status, title);
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
  if (incompatible) void refreshBadge();
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

/**
 * Restore tab ownership from the last worker, once per worker lifetime. Both
 * the dial path and the side panel's ops wait on the same attempt, so a local
 * op that lands while a fresh worker is still reading storage sees its tabs
 * rather than an empty map; a failed attempt clears the latch so the next
 * caller retries.
 */
let ownershipRestore = null;

function ensureOwnershipRestored() {
  if (ownershipRestore !== null) return ownershipRestore;
  const attempt = (async () => {
    await repairBrowserPersistence();
    await restoreTabsFromSession();
  })();
  ownershipRestore = attempt;
  attempt.catch(() => {
    if (ownershipRestore === attempt) ownershipRestore = null;
  });
  return attempt;
}

/**
 * Open one socket to the daemon and wire it up, whichever credential it carries:
 * a token for a paired browser, a six-digit code for one asking to pair. Returns
 * the socket, or `null` when the constructor itself refused the dial.
 *
 * A browser WebSocket cannot set headers, so the credential rides in the one
 * field it can set. The daemon accepts it there, or in a query string for
 * non-browser clients; the subprotocol keeps it out of anything that logs URLs.
 */
function dial(port, credential, { onReady, onClosed }) {
  const url = `ws://127.0.0.1:${port}${RELAY_PATH}`;
  let socket;
  try {
    socket = new WebSocket(url, [SUBPROTOCOL, credential]);
  } catch (error) {
    lastError = `Could not open ${url}: ${describeError(error)}`;
    scheduleReconnect();
    return null;
  }
  ws = socket;
  welcomedSocket = null;

  socket.onopen = () => {
    if (ws !== socket) {
      socket.close(1000, "superseded");
      return;
    }
    onReady();
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
    onClosed(socket, event);
  };
  return socket;
}

async function connectOnce(epoch) {
  if (protocolIncompatible) return;
  if (hasLiveSocket()) return;
  const settings = await loadSettings();
  if (epoch !== connectEpoch) return;
  if (settings.unavailable !== null) {
    throw new Error(`Could not read relay settings: ${settings.unavailable}`);
  }
  // Ownership comes back before anything else, paired or not: the side panel's
  // tabs are this worker's to find again whether or not a ghost ever pairs.
  await ensureOwnershipRestored();
  if (epoch !== connectEpoch) return;
  if (!settings.token) {
    if (pairingDenied) {
      lastError = PAIRING_DENIED_MESSAGE;
      void refreshBadge();
      return;
    }
    await dialForPairing(settings.port);
    return;
  }

  await sweepRetiredTabs().catch(() => undefined);
  await repairBrowserPersistence();
  if (epoch !== connectEpoch) return;

  dial(settings.port, TOKEN_SUBPROTOCOL_PREFIX + settings.token, {
    onReady() {
      // A socket is not admitted yet. Protocol 4 waits for the daemon's
      // incarnation-bearing welcome and retires claims from an earlier daemon
      // process before sending hello.
      void refreshBadge();
    },
    onClosed(socket, event) {
      if (welcomedSocket === socket) welcomedSocket = null;
      stopPing();
      if (event?.code === 4000 || (event?.reason && event.code !== 1000 && event.code !== 1001)) {
        lastError = event.reason || `The daemon closed the relay (code ${event.code}).`;
      } else if (event?.code === 1006) {
        lastError = "ghostd is not answering on that port. Is it running?";
      }
      void refreshBadge();
      // Let go of the debugger so the owner's tab is not left with a banner over
      // a relay that is no longer there.
      void releaseAllTabs();
      scheduleReconnect();
    },
  });
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
    lastError = `Could not prepare the relay connection: ${describeError(error)}`;
    // No badge refresh here: a preparation that failed has not changed what the
    // badge says, and re-reading storage that just failed is how a broken read
    // turns into a read storm. The keepalive alarm re-lights it.
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

function refuse(socket, id, message) {
  sendTo(socket, {
    t: "res",
    id,
    ok: false,
    error: { failure: FAILURES.browserUnavailable, message },
  });
}

async function answerRequest(socket, frame) {
  const settings = await loadSettings();
  // `status` is exempt from both refusals below: answering it is how a ghost
  // finds out that the relay is unreadable or paused.
  if (frame.op !== "status") {
    if (settings.unavailable !== null) {
      refuse(
        socket,
        frame.id,
        `Chromium could not verify the relay settings: ${settings.unavailable} `
        + "Retry after the extension finishes restoring them.",
      );
      return;
    }
    if (!settings.enabled) {
      refuse(
        socket,
        frame.id,
        "The Ghost relay is paused. The owner can resume it from the "
        + "Ghost side panel's menu in Chromium.",
      );
      return;
    }
  }

  let operation;
  try {
    operation = startOp(frame.op, frame.args ?? {}, frame.timeoutMs ?? 30_000);
  } catch (error) {
    sendTo(socket, toErrorFrame(frame.id, error));
    return;
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

function newPairingCode() {
  const word = new Uint32Array(1);
  crypto.getRandomValues(word);
  return String(word[0] % 1_000_000).padStart(6, "0");
}

/**
 * Ask the daemon to pair. The socket carries a code instead of a token; the
 * only frame it will ever receive is `paired`, and the only close that means
 * "no" is the daemon's denied code. The code stays put across redials so what
 * the panel shows and what the HUD shows are the same number.
 */
async function dialForPairing(port) {
  if (pairingCode === null) pairingCode = await restorePairingCode();
  if (pairingCode === null) {
    pairingCode = newPairingCode();
    void chrome.storage.session.set({ [PAIRING_CODE_KEY]: pairingCode }).catch(() => {});
  }
  if (hasLiveSocket()) return;
  const socket = dial(port, PAIR_SUBPROTOCOL_PREFIX + pairingCode, {
    onReady() {
      lastError = PAIRING_WAITING_MESSAGE;
      void refreshBadge();
    },
    onClosed(_socket, event) {
      pairingSocket = null;
      onPairingClosed(event);
    },
  });
  if (socket !== null) pairingSocket = socket;
}

async function restorePairingCode() {
  try {
    const stored = await chrome.storage.session.get({ [PAIRING_CODE_KEY]: null });
    const code = stored?.[PAIRING_CODE_KEY];
    return typeof code === "string" && /^[0-9]{6}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

function forgetPairingCode() {
  pairingCode = null;
  void chrome.storage.session.remove(PAIRING_CODE_KEY).catch(() => {});
}

function onPairingClosed(event) {
  void refreshBadge();
  if (event?.code === 4001) {
    pairingDenied = true;
    forgetPairingCode();
    lastError = PAIRING_DENIED_MESSAGE;
    return;
  }
  if (event?.code === 4002) {
    // Expired or replaced: the number on screen is stale, so pick a new one.
    forgetPairingCode();
  } else if (event?.code === 1006) {
    lastError = "ghostd is not answering on that port. Is it running?";
  }
  scheduleReconnect();
}

async function acceptPairing(socket, token) {
  if (typeof token !== "string" || token.trim() === "") return;
  forgetPairingCode();
  pairingDenied = false;
  try {
    await updateRelaySettings({ token });
  } catch (error) {
    lastError =
      `Ghost allowed this browser but the token could not be saved: ${describeError(error)}`;
    return;
  }
  // The settings change re-dials as a paired client; this socket is done.
  if (ws === socket) ws = null;
  pairingSocket = null;
  try {
    socket.close(1000, "paired");
  } catch {}
  reconnectDelay = RECONNECT_MIN_MS;
  void connect();
}

/** The panel's "Try again" after a denial: forget the no and dial afresh. */
function retryPairing() {
  pairingDenied = false;
  forgetPairingCode();
  reconnectDelay = RECONNECT_MIN_MS;
  return connect();
}

async function handleFrame(socket, raw) {
  if (ws !== socket) return;
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return;
  }
  if (pairingSocket === socket) {
    if (frame?.t === "paired") await acceptPairing(socket, frame.token);
    // `pairing` frames are the daemon keeping this worker alive; nothing to do.
    return;
  }
  if (frame?.t === "welcome") return answerWelcome(socket, frame);
  if (frame?.t !== "req" || typeof frame.id !== "number") return;
  if (welcomedSocket !== socket) return;
  return queueRequest(socket, frame);
}

/**
 * The daemon's `welcome`, which is what admits this socket: the version has to
 * match, and any claims left by an earlier daemon process are retired before
 * `hello` goes back.
 */
async function answerWelcome(socket, frame) {
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
    lastError = describeError(error);
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
  stopPing();
  // Not liveness — this is what keeps the service worker from being reaped
  // between two of the ghost's tool calls.
  pingTimer = setInterval(() => notice("ping", null), PING_INTERVAL_MS);
  void refreshBadge();
}

installOpsListeners(notice);

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (settingsRepairPending) scheduleSettingsRepair();
    void repairBrowserPersistence().catch(() => {});
    void sweepRetiredTabs().catch(() => {});
    void refreshBadge();
    void connect();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[KEY_STORE]) {
    // Connecting or disconnecting OpenRouter is the panel going ready or not.
    chatReadyCache = null;
    void refreshBadge();
  }
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
    stopPing();
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

// Restrict live relay state to this extension's one chrome-owned surface, the
// side panel. A `sender.tab` means the document is a page in a tab — including
// the panel's own document opened as a tab — and a page must not pair, pause,
// or drive tabs on the owner's behalf.
function isPanelSender(sender) {
  return sender?.id === chrome.runtime.id
    && sender?.url === chrome.runtime.getURL("sidepanel.html")
    && sender.tab === undefined;
}

/**
 * The side panel's workspaces: one per conversation.
 *
 * The panel names a conversation (an id it minted for its own history list);
 * the worker mints the workspace behind it. That split is the same reason the
 * socket's owner id comes off the wire and not out of a tool argument: a caller
 * that could name its own workspace could name somebody else's. A conversation
 * id can only ever resolve to a `local:` workspace, so the panel cannot reach a
 * ghost's tabs however it labels its conversations. The map survives a worker
 * restart in `chrome.storage.local`, so each conversation's tabs come back with
 * it; deleting a conversation retires its workspace, as ghostd does after a
 * protocol close.
 */
const LOCAL_SESSIONS_KEY = "ghostLocalSessions";
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let localSessions = null;
let localSessionsInFlight = null;

function loadLocalSessions() {
  if (localSessions !== null) return Promise.resolve(localSessions);
  if (localSessionsInFlight !== null) return localSessionsInFlight;
  const attempt = (async () => {
    let stored = null;
    try {
      stored = (await settingsStorage.get({ [LOCAL_SESSIONS_KEY]: null }))?.[LOCAL_SESSIONS_KEY];
    } catch {
      // A storage failure means fresh workspaces, not a failed chat.
    }
    const map = new Map();
    if (isPlainObject(stored)) {
      for (const [conversation, session] of Object.entries(stored)) {
        if (CONVERSATION_ID.test(conversation) && isLocalSession(session)) map.set(conversation, session);
      }
    }
    localSessions = map;
    return map;
  })();
  localSessionsInFlight = attempt;
  const clear = () => {
    if (localSessionsInFlight === attempt) localSessionsInFlight = null;
  };
  void attempt.then(clear, clear);
  return attempt;
}

function persistLocalSessions(map) {
  return queueLocalSessionsWrite(
    () => settingsStorage.set({ [LOCAL_SESSIONS_KEY]: Object.fromEntries(map) }).catch(() => {}),
  );
}

function requireConversation(conversation) {
  if (typeof conversation !== "string" || !CONVERSATION_ID.test(conversation)) {
    throw new Error("The side panel named no conversation. Reopen the panel.");
  }
  return conversation;
}

async function localSessionFor(conversation) {
  const map = await loadLocalSessions();
  let session = map.get(requireConversation(conversation));
  if (session === undefined) {
    session = newLocalSession();
    map.set(conversation, session);
    await persistLocalSessions(map);
  }
  return session;
}

/** Retire a conversation's workspace — closing its tabs — and forget it. */
async function closeLocalConversation(conversation) {
  const map = await loadLocalSessions();
  const session = map.get(requireConversation(conversation));
  if (session === undefined) return;
  await ensureOwnershipRestored();
  await runOp("close", { session }, 30_000);
  map.delete(conversation);
  await persistLocalSessions(map);
}

/**
 * Run one op for the side panel. The same `startOp` the socket reaches, with
 * the same pause: pausing the relay stops the local agent too, which is the
 * only reading of one switch labelled "pause" that is not a lie. This refusal
 * is the pause check — the panel does not probe first, it just gets told.
 */
async function runLocalOp(conversation, op, args, timeoutMs) {
  const settings = await loadSettings();
  if (settings.unavailable !== null) {
    throw new Error(`Chromium could not verify the relay settings: ${settings.unavailable}`);
  }
  if (!settings.enabled && op !== "status") {
    throw new Error("Ghost is paused. Resume it from the menu to let this chat act again.");
  }
  await ensureOwnershipRestored();
  const session = await localSessionFor(conversation);
  return runOp(op, { ...args, session }, timeoutMs);
}

/** Answer the panel when `work` settles; a rejection becomes its error string. */
function answerPanel(respond, work, toReply = () => ({ ok: true })) {
  void work.then(
    (value) => respond(toReply(value)),
    (error) => respond({ ok: false, error: describeError(error) }),
  );
}

async function reportStatus(respond) {
  const settings = await loadSettings();
  let tabs = [];
  try {
    // The panel is the machine owner's surface, so it lists every ghost's
    // tabs — through the in-process view, never the owner-scoped wire op.
    tabs = await allTabInfos();
  } catch {
    // No tab yet is the normal case.
  }
  respond({
    connected: isConnected(),
    paired: settings.token !== "",
    pairingCode: settings.token === "" ? pairingCode : null,
    pairingDenied: settings.token === "" && pairingDenied,
    token: settings.token,
    enabled: settings.enabled,
    port: settings.port,
    lastError,
    tabs,
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!isPanelSender(sender)) return undefined;
  switch (message?.type) {
    case "ghost-relay-local-op":
      answerPanel(
        respond,
        runLocalOp(
          message.conversation,
          message.op,
          message.args ?? {},
          Number.isSafeInteger(message.timeoutMs) ? message.timeoutMs : 30_000,
        ),
        (result) => ({ ok: true, result }),
      );
      return true;
    case "ghost-relay-local-close":
      answerPanel(respond, closeLocalConversation(message.conversation));
      return true;
    case "ghost-relay-settings-update":
      answerPanel(
        respond,
        updateRelaySettings(message.settings),
        (settings) => ({ ok: true, settings }),
      );
      return true;
    case "ghost-relay-pair":
      void retryPairing().then(() => respond({ ok: true }), () => respond({ ok: false }));
      return true;
    case "ghost-relay-status":
      void reportStatus(respond).catch(() => {
        // respond itself can throw once the panel's channel is gone; the panel's
        // own deadline already covers a missing reply.
        try {
          respond(null);
        } catch {}
      });
      return true;
    default:
      return undefined;
  }
});

// The toolbar icon opens the side panel; there is no popup. Absent in the test
// harness, hence the guard.
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })?.catch?.(() => {});

// A fresh worker says what this browser is before any socket resolves: a panel
// with a key is ready whether or not a ghost ever answers.
void refreshBadge();
void connect();
