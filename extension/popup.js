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

  // One tab per conversation, so there may be several open at once.
  const tabs = Array.isArray(status.tabs) ? status.tabs : [];
  if (tabs.length > 0) {
    tabBox.hidden = false;
    tabBox.innerHTML = "";
    const label = document.createElement("strong");
    label.textContent = tabs.length === 1 ? "Ghost's tab: " : `Ghost's tabs (${tabs.length}): `;
    const named = tabs.map((tab) => tab.title || tab.url || "").join(", ");
    tabBox.append(label, document.createTextNode(named));
  } else {
    tabBox.hidden = true;
  }

  enabledLabel.textContent = enabled
    ? "The ghost may drive this browser"
    : "The ghost is locked out of this browser";
  toggleButton.textContent = enabled ? "Pause" : "Resume";
}

async function refresh() {
  const settings = await chrome.storage.local.get({ port: 7717, token: "", enabled: true });
  if (document.activeElement !== tokenInput) tokenInput.value = settings.token ?? "";
  if (document.activeElement !== portInput) portInput.value = settings.port ?? 7717;

  let status;
  try {
    status = await chrome.runtime.sendMessage({ type: "ghost-relay-status" });
  } catch {
    // The worker is asleep; sending the message wakes it, so the next tick
    // answers. Show what storage knows in the meantime.
    status = null;
  }
  render(status ?? {
    connected: false,
    paired: (settings.token ?? "") !== "",
    enabled: settings.enabled !== false,
    lastError: "",
    tabs: [],
  });
}

saveButton.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  const port = Number(portInput.value) || 7717;
  await chrome.storage.local.set({ token, port });
  savedFlag.hidden = false;
  setTimeout(() => {
    savedFlag.hidden = true;
  }, 1_500);
  // Give the worker a moment to re-dial before asking how it went.
  setTimeout(() => void refresh(), 600);
});

toggleButton.addEventListener("click", async () => {
  const { enabled } = await chrome.storage.local.get({ enabled: true });
  await chrome.storage.local.set({ enabled: enabled === false });
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 2_000);
