/**
 * The popup: connection status, the pairing token, and the one control that
 * matters — a switch that stops the ghost driving this browser, immediately,
 * without unpairing anything or hunting for the daemon.
 *
 * It holds no state of its own. Settings live in `chrome.storage.local` (the
 * service worker watches it and re-dials on change) and live status is asked for
 * over `chrome.runtime.sendMessage`, because a popup and a service worker are
 * different documents with different lifetimes and sharing a variable between
 * them is how you get a status light that lies.
 */
const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const detail = document.getElementById("detail");
const tabBox = document.getElementById("tab");
const tokenInput = document.getElementById("token");
const portInput = document.getElementById("port");
const saveButton = document.getElementById("save");
const savedFlag = document.getElementById("saved");
const toggleButton = document.getElementById("toggle");
const enabledLabel = document.getElementById("enabledLabel");
const POPUP_API_TIMEOUT_MS = 1_000;
const DEFAULT_SETTINGS = { port: 7717, token: "", enabled: true };

let settingsSnapshot = { ...DEFAULT_SETTINGS };
let refreshInFlight = null;
let mutationInFlight = null;
let savedTimer = null;
let settingsMutationRevision = 0;
let settingsRepairInFlight = null;
const settingsRepairKeys = new Set();
const latestSettings = new Map(
  Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, { revision: 0, value }]),
);

function withDeadline(promise, message) {
  const signal = AbortSignal.timeout(POPUP_API_TIMEOUT_MS);
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

function normalizeSettings(value = {}) {
  return {
    port: Number(value.port) || DEFAULT_SETTINGS.port,
    token: typeof value.token === "string" ? value.token : "",
    enabled: value.enabled !== false,
  };
}

function queueSettingsRepair(keys) {
  for (const key of keys) settingsRepairKeys.add(key);
  void startSettingsRepair();
}

function persistSettingsPatch(patch, revisions) {
  const raw = chrome.storage.local.set(patch);
  void raw.then(
    () => {
      const stale = Object.keys(patch).filter(
        (key) => latestSettings.get(key)?.revision !== revisions.get(key),
      );
      if (stale.length > 0) queueSettingsRepair(stale);
    },
    () => {},
  );
  return withDeadline(raw, "Chromium did not save the relay settings in time.");
}

function startSettingsRepair() {
  if (settingsRepairInFlight !== null || settingsRepairKeys.size === 0) {
    return settingsRepairInFlight ?? Promise.resolve();
  }
  const keys = [...settingsRepairKeys];
  settingsRepairKeys.clear();
  const patch = {};
  const revisions = new Map();
  for (const key of keys) {
    const latest = latestSettings.get(key);
    if (!latest) continue;
    patch[key] = latest.value;
    revisions.set(key, latest.revision);
  }
  const attempt = persistSettingsPatch(patch, revisions)
    .catch(() => {
      for (const key of keys) settingsRepairKeys.add(key);
    })
    .finally(() => {
      if (settingsRepairInFlight === attempt) settingsRepairInFlight = null;
    });
  settingsRepairInFlight = attempt;
  return attempt;
}

function saveSettingsPatch(patch) {
  settingsMutationRevision += 1;
  const revisions = new Map();
  for (const [key, value] of Object.entries(patch)) {
    latestSettings.set(key, { revision: settingsMutationRevision, value });
    revisions.set(key, settingsMutationRevision);
  }
  return persistSettingsPatch(patch, revisions);
}

function render(status) {
  const connected = status.connected === true;
  const enabled = status.enabled !== false;

  dot.className = `dot ${connected ? (enabled ? "on" : "paused") : ""}`;
  statusText.textContent = connected
    ? (enabled ? "Connected to ghostd" : "Connected, paused")
    : (status.paired ? "Not connected" : "Not paired");

  detail.textContent = connected
    ? (enabled
      ? "A ghost can open a tab here and read, click, and type in it."
      : "Paused: every request from the ghost is refused until you resume.")
    : (status.lastError || (status.paired
      ? "Retrying. Is ghostd running?"
      : "Run `ghostd relay-token` in a terminal and paste the token below."));

  // One browser workspace per ghost, which may hold several tabs at once.
  const tabs = Array.isArray(status.tabs) ? status.tabs : [];
  if (tabs.length > 0) {
    tabBox.hidden = false;
    tabBox.innerHTML = "";
    const label = document.createElement("strong");
    label.textContent = tabs.length === 1 ? "Ghost's tab: " : `Ghost's tabs (${tabs.length}): `;
    const named = tabs
      .map((tab) => tab.title || tab.url
        || (tab.id !== undefined && tab.id !== null && tab.id !== ""
          ? `Tab ${tab.id}`
          : "Untitled tab"))
      .join(", ");
    tabBox.append(label, document.createTextNode(named));
  } else {
    tabBox.hidden = true;
  }

  enabledLabel.textContent = enabled
    ? "The ghost may drive this browser"
    : "The ghost is locked out of this browser";
  toggleButton.textContent = enabled ? "Pause" : "Resume";
}

function fallbackStatus(lastError = "") {
  return {
    connected: false,
    paired: settingsSnapshot.token !== "",
    enabled: settingsSnapshot.enabled,
    lastError,
    tabs: [],
  };
}

async function refreshNow() {
  let settings;
  try {
    settings = normalizeSettings(await withDeadline(
      chrome.storage.local.get(DEFAULT_SETTINGS),
      "Chromium did not return the relay settings in time.",
    ));
    settingsSnapshot = settings;
  } catch (error) {
    render(fallbackStatus(`Could not read relay settings: ${error?.message ?? error}`));
    return;
  }
  if (document.activeElement !== tokenInput) tokenInput.value = settings.token;
  if (document.activeElement !== portInput) portInput.value = settings.port;

  let status;
  try {
    status = await withDeadline(
      chrome.runtime.sendMessage({ type: "ghost-relay-status" }),
      "The relay worker did not answer status in time.",
    );
  } catch {
    // The worker is asleep; sending the message wakes it, so the next tick
    // answers. Show what storage knows in the meantime.
    status = null;
  }
  render(status ?? fallbackStatus());
}

function refreshSingleFlight() {
  if (refreshInFlight !== null) return refreshInFlight;
  const attempt = refreshNow().finally(() => {
    if (refreshInFlight === attempt) refreshInFlight = null;
  });
  refreshInFlight = attempt;
  return attempt;
}

function refresh() {
  if (settingsRepairKeys.size > 0) void startSettingsRepair();
  return mutationInFlight ?? refreshSingleFlight();
}

function showMutationError(error) {
  render(fallbackStatus(`Could not update relay settings: ${error?.message ?? error}`));
}

function mutateSettings(work) {
  if (mutationInFlight !== null) return mutationInFlight;
  saveButton.disabled = true;
  toggleButton.disabled = true;
  const attempt = (async () => {
    if (refreshInFlight !== null) await refreshInFlight;
    await work();
    await refreshSingleFlight();
  })().catch(showMutationError).finally(() => {
    if (mutationInFlight === attempt) mutationInFlight = null;
    saveButton.disabled = false;
    toggleButton.disabled = false;
  });
  mutationInFlight = attempt;
  return attempt;
}

function showSaved() {
  savedFlag.hidden = false;
  if (savedTimer !== null) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    savedFlag.hidden = true;
    savedTimer = null;
  }, 1_500);
}

saveButton.addEventListener("click", () => void mutateSettings(async () => {
  const next = {
    token: tokenInput.value.trim(),
    port: Number(portInput.value) || DEFAULT_SETTINGS.port,
  };
  await saveSettingsPatch(next);
  settingsSnapshot = { ...settingsSnapshot, ...next };
  showSaved();
}));

toggleButton.addEventListener("click", () => void mutateSettings(async () => {
  const stored = await withDeadline(
    chrome.storage.local.get({ enabled: true }),
    "Chromium did not return the relay setting in time.",
  );
  const enabled = stored.enabled === false;
  await saveSettingsPatch({ enabled });
  settingsSnapshot = { ...settingsSnapshot, enabled };
}));

void refresh();
setInterval(() => void refresh(), 2_000);
