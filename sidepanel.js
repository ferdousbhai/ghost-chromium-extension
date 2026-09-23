/**
 * The side panel: conversations with Ghost, and the only place the owner's
 * OpenRouter credential is ever read. The service worker asks whether the key
 * exists, to light the toolbar badge; its value is read here and nowhere else.
 *
 * The turn loop runs *here*, not in the service worker, because a panel document
 * lives as long as the owner keeps it open while an MV3 worker is reaped after
 * thirty idle seconds. That choice has one visible consequence, and it is the
 * honest one: closing the panel ends the turn, the same as pressing Stop. What
 * already happened is persisted, so reopening shows the conversation.
 *
 * Each conversation has its own tab workspace. The panel mints the conversation
 * id; the worker mints the workspace behind it and stamps it on every op, so
 * the panel never names a workspace and never touches `chrome.debugger`.
 *
 * Chrome draws the panel's title bar itself, so this document starts at the
 * toolbar: history, new conversation, and a menu.
 */
import { runTurn, SYSTEM_PROMPT, TurnStopped } from "./agent.js";
import {
  beginAuth,
  codeFromCallback,
  DEFAULT_MODEL,
  exchangeCode,
  KEY_STORE,
  listModels,
  modelEntry,
  streamChat,
} from "./openrouter.js";
import { toolDefinitions } from "./tools.js";

const MODEL_STORE = "openRouterModel";
const CHATS_STORE = "localChats";
/** The PKCE verifier outlives this document while the owner fetches a code. */
const VERIFIER_STORE = "openRouterVerifier";
/** Enough to keep a working history, small enough to always fit storage. */
const MAX_CHATS = 30;
const MAX_ENTRIES_PER_CHAT = 400;
const MAX_STORE_BYTES = 3_000_000;
const OP_TIMEOUT_MS = 60_000;

const ui = Object.fromEntries([
  "toolbar", "history", "newChat", "menu", "pauseToggle", "ghostMachine", "deleteChat",
  "disconnect", "paused", "notice", "connect", "oauth", "showCode", "codePath", "openAuth",
  "manual", "manualSave", "connectError", "ghostView", "ghostBack", "dot", "statusText",
  "detail", "ghostTabs", "pair", "pairCode", "retry", "token", "port", "save", "saved",
  "empty", "log", "historyList", "composerBar", "input", "model", "modelName", "modelMenu",
  "modelSearch", "modelList", "modelNone", "send", "stop",
].map((id) => [id, document.getElementById(id)]));

const tools = toolDefinitions();

let key = null;
let model = DEFAULT_MODEL;
const FREE_ROUTER = modelEntry(DEFAULT_MODEL, "", true);
/**
 * The catalog as the picker draws it, in listModels' order: one row per entry,
 * built once per catalog; typing only hides some.
 */
let pickerRows = [];
let activeRow = null;
/** Newest first. Each: { id, title, updatedAt, messages, record }. */
let chats = [];
let activeId = null;
/** "chat", "history", or "ghost" (the pairing screen for a ghost on this machine). */
let view = "chat";
/** The turn in flight, if any: { chat, controller }. */
let turn = null;
let paused = false;
let pendingConfirm = null;

// ---------------------------------------------------------------- persistence

function storable(entries) {
  return entries.map((entry) => (Array.isArray(entry?.content)
    // Screenshots are the one payload that would blow the storage quota, and a
    // stored one is of no use to anybody: the page has moved on.
    ? { ...entry, content: "[screenshot]" }
    : entry));
}

/**
 * Drop whole turns from the front until the history fits. A cut anywhere else
 * leaves a `tool` message without the `assistant` call it answers, which the
 * API refuses, and the system prompt at index 0 is not a turn and stays.
 */
export function trimTurns(entries, isTurnStart, fits) {
  const head = entries[0]?.role === "system" ? [entries[0]] : [];
  let body = entries.slice(head.length);
  while (!fits([...head, ...body]) && body.length > 0) {
    const next = body.findIndex((entry, index) => index > 0 && isTurnStart(entry));
    body = next === -1 ? [] : body.slice(next);
  }
  return [...head, ...body];
}

const startsTurn = (message) => message.role === "user" && typeof message.content === "string";
const startsRecord = (entry) => entry.kind === "user";

function storableChat(chat) {
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    messages: trimTurns(storable(chat.messages), startsTurn,
      (kept) => kept.length <= MAX_ENTRIES_PER_CHAT),
    record: trimTurns(chat.record, startsRecord, (kept) => kept.length <= MAX_ENTRIES_PER_CHAT),
  };
}

async function persist() {
  const payload = { active: activeId, chats: chats.map(storableChat) };
  // Over the byte cap, the oldest conversations go first; their workspaces are
  // released by `dropChat`, not here, so a size-only trim never closes a tab.
  while (JSON.stringify(payload).length > MAX_STORE_BYTES && payload.chats.length > 1) {
    payload.chats.pop();
  }
  await chrome.storage.local.set({ [CHATS_STORE]: payload }).catch(() => {});
}

/** A stored setting is only a setting when it is a non-empty string. */
function storedText(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function validChat(value) {
  return typeof value?.id === "string" && Array.isArray(value.messages) && Array.isArray(value.record);
}

async function restore() {
  const stored = await chrome.storage.local
    .get({ [KEY_STORE]: null, [MODEL_STORE]: null, [CHATS_STORE]: null, enabled: true })
    .catch(() => ({ enabled: true }));
  key = storedText(stored?.[KEY_STORE], null);
  model = storedText(stored?.[MODEL_STORE], DEFAULT_MODEL);
  const saved = stored?.[CHATS_STORE];
  chats = Array.isArray(saved?.chats) ? saved.chats.filter(validChat) : [];
  activeId = chats.some((chat) => chat.id === saved?.active) ? saved.active : (chats[0]?.id ?? null);
  // The pause switch is the popup's `enabled`; `storage.onChanged` below keeps
  // it current, and the worker refuses a paused op regardless of what this
  // document believes.
  paused = stored?.enabled === false;
}

// ------------------------------------------------------------- conversations

function activeChat() {
  return chats.find((chat) => chat.id === activeId) ?? null;
}

function newChat() {
  const current = activeChat();
  // An empty conversation is already new; do not stack them.
  if (current !== null && current.record.length === 0) {
    view = "chat";
    render();
    return current;
  }
  const chat = { id: crypto.randomUUID(), title: "", updatedAt: Date.now(), messages: [], record: [] };
  chats.unshift(chat);
  activeId = chat.id;
  view = "chat";
  while (chats.length > MAX_CHATS) void dropChat(chats.at(-1).id);
  render();
  void persist();
  return chat;
}

/** Forget a conversation and retire its workspace, closing the tabs it opened. */
async function dropChat(id) {
  if (turn?.chat.id === id) stop();
  chats = chats.filter((chat) => chat.id !== id);
  if (activeId === id) activeId = chats[0]?.id ?? null;
  render();
  await persist();
  const closed = await chrome.runtime
    .sendMessage({ type: "ghost-relay-local-close", conversation: id })
    .catch((error) => ({ ok: false, error: error?.message ?? String(error) }));
  if (closed?.ok !== true) {
    notice(`The conversation is gone, but its tabs may not be: ${closed?.error ?? "the relay worker did not answer"}`);
  }
}

function touch(chat) {
  chat.updatedAt = Date.now();
  chats.sort((left, right) => right.updatedAt - left.updatedAt);
}

// -------------------------------------------------------------------- the UI

/** The banner above the log: the one place anything non-fatal is said. */
function notice(text) {
  ui.notice.textContent = text;
  ui.notice.hidden = false;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEntry(entry) {
  switch (entry.kind) {
    case "user":
    case "assistant": {
      const turnNode = el("div", `turn ${entry.kind}`);
      turnNode.append(el("div", "body", entry.text));
      return turnNode;
    }
    case "tool":
      return el("div", `tool${entry.failed ? " bad" : ""}`, entry.text);
    case "usage":
      return el("div", "usage", entry.text);
    default:
      return el("div", "error", entry.text);
  }
}

/**
 * Consecutive tool calls share one `.tools` block, so the log's gap falls
 * between blocks and the calls' rules join into one down the side.
 */
function renderLog(record) {
  const nodes = [];
  for (const entry of record) {
    const node = renderEntry(entry);
    if (entry.kind !== "tool") {
      nodes.push(node);
      continue;
    }
    if (nodes.at(-1)?.className !== "tools") nodes.push(el("div", "tools"));
    nodes.at(-1).append(node);
  }
  return nodes;
}

function whenLabel(at) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function renderHistory() {
  ui.historyList.replaceChildren(el("h2", null, "Conversations"));
  for (const chat of chats) {
    const row = el("button", chat.id === activeId ? "active" : "");
    row.type = "button";
    row.append(el("span", "title", chat.title || "New conversation"), el("span", "when", whenLabel(chat.updatedAt)));
    row.addEventListener("click", () => {
      activeId = chat.id;
      view = "chat";
      render();
      void persist();
    });
    ui.historyList.append(row);
  }
}

function render() {
  const connected = key !== null;
  const chat = activeChat();
  const busy = turn !== null && turn.chat.id === chat?.id;
  const showLog = connected && view === "chat" && chat !== null && (chat.record.length > 0 || pendingConfirm !== null);

  ui.toolbar.hidden = !connected;
  ui.connect.hidden = connected;
  ui.composerBar.hidden = !connected || view !== "chat";
  ui.historyList.hidden = !(connected && view === "history");
  ui.ghostView.hidden = !(connected && view === "ghost");
  ui.log.hidden = !showLog;
  ui.empty.hidden = !(connected && view === "chat" && !showLog);
  ui.paused.hidden = !paused;
  ui.pauseToggle.textContent = paused ? "Resume Ghost" : "Pause Ghost";
  ui.model.disabled = turn !== null;
  if (turn !== null) ui.modelMenu.hidePopover();
  ui.send.hidden = busy;
  ui.stop.hidden = !busy;
  // The wire has no cancel: a page op already handed to Chromium finishes. Stop
  // ends the turn at the next step and says so rather than looking ignored.
  const stopping = busy && turn.controller.signal.aborted;
  ui.stop.disabled = stopping;
  ui.stop.textContent = stopping ? "Stopping…" : "Stop";
  ui.deleteChat.disabled = chat === null;

  if (view === "history") renderHistory();
  if (showLog) {
    ui.log.replaceChildren(...renderLog(chat.record));
    if (pendingConfirm !== null && pendingConfirm.chat.id === chat.id) ui.log.append(pendingConfirm.node);
    ui.log.scrollTop = ui.log.scrollHeight;
  }
}

function say(chat, entry) {
  chat.record.push(entry);
  render();
}

/** Grow the last assistant entry as tokens arrive, without a full re-render. */
function streamInto(chat, text) {
  const last = chat.record.at(-1);
  if (last?.kind !== "assistant") {
    say(chat, { kind: "assistant", text });
    return;
  }
  last.text += text;
  if (chat.id !== activeId || view !== "chat") return;
  const node = ui.log.lastElementChild?.querySelector(".body");
  if (node) {
    node.textContent = last.text;
    ui.log.scrollTop = ui.log.scrollHeight;
  } else {
    render();
  }
}

function summarize(name, args) {
  const detail = name === "javascript"
    ? (args.code ?? "")
    : Object.entries(args)
      .filter(([field]) => field !== "tab")
      .map(([field, value]) => `${field}=${JSON.stringify(value)}`)
      .join(" ");
  return `${name} ${detail}`.trim().slice(0, 400);
}

// ------------------------------------------------------ a ghost on this machine

/**
 * The pairing screen. The worker owns the settings and the live status; this
 * view only asks, every two seconds while it is open, and renders the answer.
 * The six-digit code shown here is the one the HUD shows for Allow.
 */
const GHOST_POLL_MS = 2_000;
let ghostPoll = null;
let ghostSettings = { port: 7717, token: "", enabled: true };

function renderGhost(status) {
  const connected = status?.connected === true;
  const enabled = status?.enabled !== false;
  const paired = status?.paired === true;

  let light = "";
  if (connected) light = enabled ? "on" : "paused";
  ui.dot.className = `dot ${light}`;

  if (!connected) ui.statusText.textContent = paired ? "Not connected" : "Not paired";
  else ui.statusText.textContent = enabled ? "Connected to ghostd" : "Connected, paused";

  if (status === null) {
    ui.detail.textContent = "The relay worker did not answer.";
  } else if (!connected) {
    ui.detail.textContent = status.lastError
      || (paired ? "Retrying. Is ghostd running?" : "Waiting for ghostd. Is it running?");
  } else {
    ui.detail.textContent = enabled
      ? "A ghost can open a tab here and read, click, and type in it."
      : "Paused: every request from the ghost is refused until you resume.";
  }

  const pairing = status !== null && !connected && !paired;
  ui.pair.hidden = !pairing;
  if (pairing) {
    const code = typeof status.pairingCode === "string" ? status.pairingCode : "";
    ui.pairCode.textContent = status.pairingDenied
      ? "Denied"
      : (code === "" ? "…" : `${code.slice(0, 3)} ${code.slice(3)}`);
    ui.retry.hidden = status.pairingDenied !== true;
  }
  const tabs = Array.isArray(status?.tabs) ? status.tabs.filter((tab) => tab.local !== true) : [];
  ui.ghostTabs.hidden = tabs.length === 0;
  if (tabs.length === 0) {
    ui.ghostTabs.textContent = "";
  } else {
    const heading = tabs.length === 1 ? "tab" : `tabs (${tabs.length})`;
    const names = tabs.map((tab) => tab.title || tab.url || `Tab ${tab.id}`).join(", ");
    ui.ghostTabs.textContent = `Ghost's ${heading}: ${names}`;
  }
}

async function refreshGhost() {
  const status = await chrome.runtime.sendMessage({ type: "ghost-relay-status" }).catch(() => null);
  if (status && typeof status === "object") {
    ghostSettings = {
      port: Number(status.port) || 7717,
      token: typeof status.token === "string" ? status.token : "",
      enabled: status.enabled !== false,
    };
    if (document.activeElement !== ui.token) ui.token.value = ghostSettings.token;
    if (document.activeElement !== ui.port) ui.port.value = ghostSettings.port;
  }
  renderGhost(status && typeof status === "object" ? status : null);
}

function openGhostView() {
  view = "ghost";
  render();
  void refreshGhost();
  if (ghostPoll === null) ghostPoll = setInterval(() => void refreshGhost(), GHOST_POLL_MS);
}

function leaveGhostView() {
  if (ghostPoll !== null) clearInterval(ghostPoll);
  ghostPoll = null;
  view = "chat";
  render();
}

async function updateRelaySettings(settings) {
  const response = await chrome.runtime.sendMessage({ type: "ghost-relay-settings-update", settings });
  if (response?.ok !== true) throw new Error(response?.error || "The relay worker refused the settings update.");
  return response.settings;
}

async function retryPairing() {
  await chrome.runtime.sendMessage({ type: "ghost-relay-pair" }).catch(() => {});
  await refreshGhost();
}

async function saveGhostSettings() {
  try {
    await updateRelaySettings({
      token: ui.token.value.trim(),
      port: Number(ui.port.value) || ghostSettings.port,
    });
    ui.saved.hidden = false;
    setTimeout(() => { ui.saved.hidden = true; }, 1_500);
  } catch (error) {
    ui.detail.textContent = `Could not update relay settings: ${error?.message ?? error}`;
  }
  await refreshGhost();
}

async function togglePause() {
  try {
    await updateRelaySettings({ enabled: paused });
  } catch (error) {
    notice(error?.message ?? String(error));
  }
}

// ------------------------------------------------------------- the worker hop

async function runTool(chat, name, args) {
  const response = await chrome.runtime.sendMessage({
    type: "ghost-relay-local-op",
    conversation: chat.id,
    op: name,
    args,
    timeoutMs: OP_TIMEOUT_MS,
  });
  if (response === null || response === undefined) {
    throw new Error("The relay worker did not answer. Reopen this panel.");
  }
  if (response.ok !== true) throw new Error(response.error);
  return response.result;
}

// --------------------------------------------------------- the script consent

/**
 * The one operation that runs page JavaScript asks, every time. It is not a
 * remembered preference: the code is different each time, and the whole point
 * of showing it is that the owner reads *this* code.
 */
function confirmScript(chat, { name, args }) {
  return new Promise((resolve) => {
    const node = el("div", "confirm");
    node.append(el("div", "who", `${name} — run this in the page?`));
    node.append(el("pre", null, String(args.code ?? "")));
    const row = el("div", "row");
    const allow = el("button", "primary", "Run it");
    const deny = el("button", null, "Don't");
    row.append(allow, deny);
    node.append(row);
    const answer = (value) => {
      pendingConfirm = null;
      node.remove();
      resolve(value);
    };
    allow.addEventListener("click", () => answer(true));
    deny.addEventListener("click", () => answer(false));
    pendingConfirm = { chat, node, answer };
    render();
    allow.focus();
  });
}

// ------------------------------------------------------------------ the turn

function costLabel(cost) {
  if (typeof cost !== "number") return "cost unreported";
  if (cost === 0) return "free";
  return `$${cost.toFixed(6)}`;
}

function usageLine(answered, usage) {
  const tokens = usage?.total_tokens ?? null;
  const parts = [answered];
  if (tokens !== null) parts.push(`${tokens} tokens`);
  parts.push(costLabel(usage?.cost));
  return parts.join(" · ");
}

async function send() {
  const text = ui.input.value.trim();
  if (text === "" || turn !== null || key === null) return;
  const chat = activeChat() ?? newChat();
  ui.input.value = "";
  ui.input.style.height = "auto";
  ui.notice.hidden = true;

  if (chat.messages.length === 0) chat.messages.push({ role: "system", content: SYSTEM_PROMPT });
  chat.messages.push({ role: "user", content: text });
  if (chat.title === "") chat.title = text.slice(0, 60);
  touch(chat);
  say(chat, { kind: "user", text });

  const controller = new AbortController();
  turn = { chat, controller };
  render();
  try {
    const outcome = await runTurn({
      messages: chat.messages,
      model,
      tools,
      chat: (request) => streamChat({ key, ...request }),
      runTool: (name, args) => runTool(chat, name, args),
      confirm: (call) => confirmScript(chat, call),
      signal: controller.signal,
      // A step's text arrives token by token, so `assistant` itself needs no
      // entry — `delta` already wrote one, and a tool-only step says nothing.
      onEvent: (event) => {
        if (event.type === "delta") streamInto(chat, event.text);
        else if (event.type === "tool") {
          say(chat, { kind: "tool", text: `→ ${summarize(event.name, event.args)}` });
        } else if (event.type === "tool_result") {
          const failed = typeof event.result?.error === "string";
          say(chat, {
            kind: "tool",
            failed,
            text: failed ? `← ${event.result.error}` : `← ${event.name} ok`,
          });
        }
      },
    });
    say(chat, { kind: "usage", text: usageLine(outcome.model, outcome.usage) });
  } catch (error) {
    if (error instanceof TurnStopped || error?.name === "AbortError") {
      say(chat, { kind: "usage", text: error instanceof TurnStopped ? error.message : "Stopped." });
    } else {
      say(chat, { kind: "error", text: error?.message ?? String(error) });
    }
  } finally {
    if (pendingConfirm?.chat.id === chat.id) pendingConfirm.answer(false);
    turn = null;
    touch(chat);
    render();
    await persist();
  }
}

function stop() {
  turn?.controller.abort();
  pendingConfirm?.answer(false);
  render();
}

// ---------------------------------------------------------------- connecting

async function saveKey(value) {
  key = value;
  await chrome.storage.local.set({ [KEY_STORE]: value });
  ui.connectError.hidden = true;
  ui.notice.hidden = true;
  if (activeChat() === null) newChat();
  render();
  // The catalog fills the picker when it arrives; the panel does not wait for it.
  void loadModels();
}

function connectFailed(error) {
  ui.connectError.textContent = error?.message ?? String(error);
  ui.connectError.hidden = false;
  // The code path is the fallback; an error that points at it must reveal it.
  ui.codePath.hidden = false;
}

/**
 * OAuth, one click: PKCE through `chrome.identity`, which intercepts the
 * redirect to this extension's own `chromiumapp.org` URL. OpenRouter ends the
 * flow by minting a key for this browser; that key is what is stored, and the
 * owner never sees or handles it.
 */
async function oauthConnect() {
  ui.oauth.disabled = true;
  try {
    const redirect = chrome.identity.getRedirectURL();
    const { url, verifier } = await beginAuth({ callbackUrl: redirect });
    const answered = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    const code = codeFromCallback(answered ?? "");
    if (code === null) {
      throw new Error("OpenRouter did not send a code back. Connect with a code instead.");
    }
    await saveKey(await exchangeCode({ code, verifier }));
    ui.oauth.disabled = false;
  } catch (error) {
    // One-click failed once in this document; the code path is the path now.
    // The button comes back with the next panel open.
    connectFailed(error);
  }
}

/**
 * The same OAuth without the redirect: OpenRouter's headless mode shows the
 * code on its own page for the owner to paste. It works whatever a callback
 * URL is allowed to be.
 */
async function openManualAuth() {
  try {
    const { url, verifier } = await beginAuth();
    await chrome.storage.session.set({ [VERIFIER_STORE]: verifier });
    await chrome.tabs.create({ url });
  } catch (error) {
    connectFailed(error);
  }
}

async function useCode() {
  const code = ui.manual.value.trim();
  if (code === "") return;
  ui.manualSave.disabled = true;
  try {
    const stored = await chrome.storage.session.get({ [VERIFIER_STORE]: null }).catch(() => ({}));
    const verifier = stored?.[VERIFIER_STORE] ?? null;
    if (verifier === null) {
      throw new Error("Open the authorization page first, so the code can be matched to this browser.");
    }
    await saveKey(await exchangeCode({ code, verifier }));
    ui.manual.value = "";
    await chrome.storage.session.remove(VERIFIER_STORE).catch(() => {});
  } catch (error) {
    connectFailed(error);
  } finally {
    ui.manualSave.disabled = false;
  }
}

/** The way out. The key is this browser's copy, so forgetting it is the whole undo. */
async function disconnect() {
  stop();
  key = null;
  await chrome.storage.local.remove(KEY_STORE).catch(() => {});
  render();
}

async function loadModels() {
  let models = [FREE_ROUTER];
  try {
    const listed = await listModels({ signal: AbortSignal.timeout(10_000) });
    if (listed.length > 0) models = listed;
  } catch {
    notice("Could not load the model list; the free router is still available.");
  }
  if (!models.some((entry) => entry.id === model)) {
    // Keep showing the id the next turn will actually send, rather than a
    // catalog entry the picker only appears to have chosen.
    models = [{ ...modelEntry(model, model, false), stale: true }, ...models];
  }
  setCatalog(models);
}

function renderModelButton() {
  const entry = pickerRows.find(({ row }) => row.value === model)?.entry;
  ui.modelName.textContent = entry?.name ?? model;
  ui.model.title = `Model: ${model}`;
}

/** Entries are { id, name, vendor, free, stale? }. */
function setCatalog(models) {
  const nodes = [];
  let heading = null;
  pickerRows = models.map((entry) => {
    const group = entry.stale ? "No longer listed" : entry.free ? "Free" : "Paid";
    if (heading?.textContent !== group) {
      heading = el("div", "group", group);
      nodes.push(heading);
    }
    const row = el("button", entry.id === model ? "option selected" : "option");
    row.type = "button";
    row.value = entry.id;
    row.title = entry.id;
    row.append(el("span", "name", entry.name), el("span", "vendor", entry.vendor));
    nodes.push(row);
    return { entry, row, heading, haystack: `${entry.name} ${entry.id}`.toLowerCase() };
  });
  ui.modelList.replaceChildren(...nodes);
  renderModelButton();
}

function filterPicker() {
  const query = ui.modelSearch.value.trim().toLowerCase();
  const headings = new Set();
  for (const { row, heading, haystack } of pickerRows) {
    row.hidden = !haystack.includes(query);
    if (!row.hidden) headings.add(heading);
  }
  for (const { heading } of pickerRows) heading.hidden = !headings.has(heading);
  ui.modelNone.hidden = headings.size > 0;
}

const visibleRows = () => pickerRows.map(({ row }) => row).filter((row) => !row.hidden);

function markRow(row) {
  activeRow?.classList.remove("active");
  activeRow = row;
  row?.classList.add("active");
  row?.scrollIntoView({ block: "nearest" });
}

function chooseModel(id) {
  model = id;
  void chrome.storage.local.set({ [MODEL_STORE]: model }).catch(() => {});
  for (const { row } of pickerRows) row.classList.toggle("selected", row.value === model);
  ui.modelMenu.hidePopover();
  renderModelButton();
  ui.input.focus();
}

// ------------------------------------------------------------------- wiring

ui.send.addEventListener("click", () => void send());
ui.stop.addEventListener("click", stop);
ui.newChat.addEventListener("click", () => {
  if (view === "ghost") leaveGhostView();
  newChat();
});
ui.history.addEventListener("click", () => {
  if (view === "ghost") leaveGhostView();
  view = view === "history" ? "chat" : "history";
  render();
});
ui.deleteChat.addEventListener("click", () => {
  const chat = activeChat();
  if (chat !== null) void dropChat(chat.id);
});
ui.disconnect.addEventListener("click", () => void disconnect());
ui.pauseToggle.addEventListener("click", () => void togglePause());
ui.ghostMachine.addEventListener("click", openGhostView);
// Every item in the menu is an action; taking one closes the menu.
ui.menu.addEventListener("click", (event) => {
  if (event.target.closest("button")) ui.menu.hidePopover();
});
ui.ghostBack.addEventListener("click", leaveGhostView);
ui.retry.addEventListener("click", () => void retryPairing());
ui.save.addEventListener("click", () => void saveGhostSettings());
ui.oauth.addEventListener("click", () => void oauthConnect());
ui.showCode.addEventListener("click", () => {
  ui.codePath.hidden = !ui.codePath.hidden;
});
ui.openAuth.addEventListener("click", () => void openManualAuth());
ui.manualSave.addEventListener("click", () => void useCode());
ui.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});
ui.input.addEventListener("input", () => {
  ui.input.style.height = "auto";
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 160)}px`;
});
// Both popovers are native (`popover` + `popovertarget`): the browser opens
// them, closes one when the other opens, and dismisses on Escape or a click
// elsewhere. The picker only fills itself as it opens.
ui.modelMenu.addEventListener("beforetoggle", (event) => {
  if (event.newState !== "open") return;
  ui.modelSearch.value = "";
  filterPicker();
});
ui.modelMenu.addEventListener("toggle", (event) => {
  if (event.newState !== "open") return;
  markRow(pickerRows.find(({ row }) => row.value === model)?.row ?? null);
  ui.modelSearch.focus();
});
ui.modelList.addEventListener("click", (event) => {
  const row = event.target.closest(".option");
  if (row) chooseModel(row.value);
});
ui.modelList.addEventListener("mousemove", (event) => {
  const row = event.target.closest(".option");
  if (row && row !== activeRow) markRow(row);
});
ui.modelSearch.addEventListener("input", () => {
  filterPicker();
  markRow(visibleRows()[0] ?? null);
});
ui.modelSearch.addEventListener("keydown", (event) => {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  const rows = visibleRows();
  if (step !== undefined && rows.length > 0) {
    event.preventDefault();
    markRow(rows[(rows.indexOf(activeRow) + step + rows.length) % rows.length]);
  } else if (event.key === "Enter" && activeRow !== null && !activeRow.hidden) {
    event.preventDefault();
    chooseModel(activeRow.value);
  }
});
// Escape closes an open popover first; only with none open does it stop a turn.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && turn !== null && !document.querySelector(":popover-open")) stop();
});

// Pause is one switch for both sides: the popup flips it, and a turn in flight
// here stops at its next step rather than finishing behind the owner's back.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.enabled) return;
  paused = changes.enabled.newValue === false;
  if (paused && turn !== null) {
    say(turn.chat, { kind: "usage", text: "Paused. Resume Ghost from the menu to continue." });
    stop();
  }
  render();
});

// The whole conversation is in this document; a reload without a save would
// lose it, and Chrome may reload a panel whenever it likes.
window.addEventListener("pagehide", () => void persist());

void (async () => {
  await restore();
  setCatalog([FREE_ROUTER]);
  if (key !== null && activeChat() === null) newChat();
  // Paint before any network: a slow or unreachable OpenRouter must not leave
  // the panel blank. The picker shows the free router until the catalog lands.
  render();
  if (key !== null) void loadModels();
})();
