/**
 * The popup: connection status, the pairing token, and the one control that
 * matters — a switch that stops the ghost driving this browser, immediately,
 * without unpairing anything or hunting for the daemon.
 *
 * It holds no state of its own. The service worker owns settings durability and
 * live status; the popup reaches both over `chrome.runtime.sendMessage`, because
 * this short-lived document cannot arbitrate writes that may outlive it.
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
  let status;
  try {
    status = await withDeadline(
      chrome.runtime.sendMessage({ type: "ghost-relay-status" }),
      "The relay worker did not answer status in time.",
    );
    if (typeof status !== "object" || status === null) {
      throw new Error("The relay worker did not return status to this page.");
    }
  } catch (error) {
    // A sleeping worker may answer the next tick; an unauthorized extension
    // page never will. Keep the last complete settings snapshot either way.
    render(fallbackStatus(error?.message ?? String(error)));
    return;
  }
  settingsSnapshot = {
    port: Number(status.port) || DEFAULT_SETTINGS.port,
    token: typeof status.token === "string" ? status.token : "",
    enabled: status.enabled !== false,
  };
  if (document.activeElement !== tokenInput) tokenInput.value = settingsSnapshot.token;
  if (document.activeElement !== portInput) portInput.value = settingsSnapshot.port;
  render(status);
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
  return mutationInFlight ?? refreshSingleFlight();
}

async function updateSettings(settings) {
  const response = await withDeadline(
    chrome.runtime.sendMessage({ type: "ghost-relay-settings-update", settings }),
    "The relay worker did not save the settings in time.",
  );
  if (response?.ok !== true) {
    throw new Error(response?.error || "The relay worker refused the settings update.");
  }
  settingsSnapshot = response.settings;
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
  await updateSettings(next);
  showSaved();
}));

toggleButton.addEventListener("click", () => void mutateSettings(async () => {
  await updateSettings({ enabled: !settingsSnapshot.enabled });
}));

void refresh();
setInterval(() => void refresh(), 2_000);
