/**
 * The service worker's side of the local chat.
 *
 * Three things are the worker's to guarantee and nobody else's: that the chat's
 * workspace id is stamped here rather than chosen by the caller, that the one
 * pause switch stops the local agent as well as the ghost, and that only the
 * extension's own chrome-owned surfaces can ask for either — a document in a
 * tab, including one of our own pages opened as a tab, must not drive tabs on
 * the owner's behalf.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { LOCAL_SESSION_PREFIX } from "../extension/local-session.js";

const originalChrome = globalThis.chrome;
const originalWebSocket = globalThis.WebSocket;

class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  constructor() { this.readyState = 0; }
  close() {}
}

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
});

function eventHook() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => listeners.map((listener) => listener(...args)),
    removeListener: () => {},
  };
}

function chromeMock({
  enabled = true,
  removed = [],
  localSeed = new Map(),
  sessionSeed = new Map(),
} = {}) {
  const store = new Map(localSeed);
  const sessionStore = new Map(sessionSeed);
  const tabs = new Map();
  let nextTabId = 31;
  const redacted = (tab) => tab && {
    id: tab.id, windowId: tab.windowId, status: tab.status, active: tab.active,
  };
  return {
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create() {}, onAlarm: eventHook() },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      getTargets: async () => [...tabs.values()].map((tab) => ({
        tabId: tab.id, type: "page", attached: false, url: tab.url, title: tab.title,
      })),
      onDetach: eventHook(),
      onEvent: eventHook(),
      sendCommand: async () => ({}),
    },
    runtime: {
      id: "ghost-relay-test",
      getManifest: () => ({ version: "test" }),
      getURL: (path = "") => `chrome-extension://ghost-relay-test/${path}`,
      onInstalled: eventHook(),
      onMessage: eventHook(),
      onStartup: eventHook(),
    },
    storage: {
      local: {
        get: async (defaults) => {
          const out = { ...defaults };
          for (const field of Object.keys(defaults)) {
            if (store.has(field)) out[field] = store.get(field);
          }
          if (Object.hasOwn(defaults, "enabled")) out.enabled = enabled;
          return out;
        },
        remove: async (field) => { store.delete(field); },
        set: async (value) => {
          for (const [field, entry] of Object.entries(value)) store.set(field, entry);
        },
      },
      onChanged: eventHook(),
      session: {
        get: async (defaults) => {
          const out = { ...defaults };
          for (const field of Object.keys(defaults)) {
            if (sessionStore.has(field)) out[field] = sessionStore.get(field);
          }
          return out;
        },
        remove: async (field) => { sessionStore.delete(field); },
        set: async (value) => {
          for (const [field, entry] of Object.entries(value)) sessionStore.set(field, entry);
        },
      },
    },
    localStore: store,
    sessionStore,
    tabs: {
      seed: (id, url) => {
        tabs.set(id, { id, windowId: 4, url, title: `Tab ${id}`, status: "complete" });
      },
      create: async ({ url = "about:blank" }) => {
        const tab = {
          id: nextTabId, windowId: 4, url, title: `Tab ${nextTabId}`, status: "complete",
        };
        nextTabId += 1;
        tabs.set(tab.id, tab);
        return redacted(tab);
      },
      get: async (id) => {
        const tab = redacted(tabs.get(id));
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      },
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      remove: async (id) => { removed.push(id); tabs.delete(id); },
      update: async (id, update) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("missing tab");
        Object.assign(tab, update);
        return redacted(tab);
      },
    },
    windows: { update: async () => {} },
  };
}

const panelSender = () => ({
  id: "ghost-relay-test",
  url: "chrome-extension://ghost-relay-test/sidepanel.html",
});

function askWorker(message, sender = panelSender()) {
  return new Promise((resolve) => {
    const handled = chrome.runtime.onMessage.emit(message, sender, resolve);
    if (!handled.some((value) => value === true)) resolve(undefined);
  });
}

async function loadWorker(label) {
  globalThis.WebSocket = InertWebSocket;
  await import(`../extension/background.js?${label}=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setImmediate(resolve));
}

const CONVERSATION = "4d3c2b1a-0000-4000-8000-000000000001";
const OTHER_CONVERSATION = "4d3c2b1a-0000-4000-8000-000000000002";
const localOp = (op, args = {}, conversation = CONVERSATION) =>
  askWorker({ type: "ghost-relay-local-op", conversation, op, args });

test("the worker stamps the chat's workspace; the panel never names one", async () => {
  globalThis.chrome = chromeMock();
  await loadWorker("local-session");

  // A caller naming somebody else's workspace is simply overridden: the tab it
  // opens under one made-up id is listed under another made-up id, because
  // both were replaced by the worker's own.
  const opened = await localOp("open", { url: "https://example.com/", session: "a-ghost-id" });
  assert.equal(opened.ok, true);
  const listed = await localOp("tabs", { op: "list", session: "somebody-else" });
  assert.deepEqual(listed.result.tabs.map((tab) => tab.url), ["https://example.com/"]);
});

test("each conversation has its own workspace, and deleting one closes only its tabs", async () => {
  const removed = [];
  const mock = chromeMock({ removed });
  globalThis.chrome = mock;
  await loadWorker("local-conversations");

  const first = await localOp("open", { url: "https://example.com/one" });
  const second = await localOp("open", { url: "https://example.com/two" }, OTHER_CONVERSATION);
  assert.deepEqual((await localOp("tabs", { op: "list" })).result.tabs.map((tab) => tab.url), ["https://example.com/one"]);
  assert.deepEqual((await localOp("tabs", { op: "list" }, OTHER_CONVERSATION)).result.tabs.map((tab) => tab.url), ["https://example.com/two"]);
  const sessions = mock.localStore.get("ghostLocalSessions");
  assert.ok(sessions[CONVERSATION].startsWith(LOCAL_SESSION_PREFIX));
  assert.notEqual(sessions[CONVERSATION], sessions[OTHER_CONVERSATION]);

  const closed = await askWorker({ type: "ghost-relay-local-close", conversation: CONVERSATION });
  assert.equal(closed.ok, true);
  assert.deepEqual(removed, [Number(first.result.id)]);
  assert.deepEqual((await localOp("tabs", { op: "list" }, OTHER_CONVERSATION)).result.tabs.map((tab) => tab.id), [second.result.id]);
  assert.equal(mock.localStore.get("ghostLocalSessions")[CONVERSATION], undefined);

  // A conversation id that is not one of the panel's is refused before any op.
  const bogus = await localOp("open", { url: "https://example.com/" }, "not-a-conversation");
  assert.equal(bogus.ok, false);
  assert.match(bogus.error, /named no conversation/);
});

test("a fresh worker finds the chat's tabs again before it answers a local op", async () => {
  // The tab is claimed by an earlier worker and lives on in session storage; the
  // new worker never pairs (no token), so restoration cannot hide behind the
  // dial. This is the reap-after-thirty-seconds case for a ghostless install.
  const removed = [];
  const mock = chromeMock({ removed });
  globalThis.chrome = mock;
  await loadWorker("local-restore-a");
  const opened = await localOp("open", { url: "https://example.com/kept" });
  const stored = mock.sessionStore;

  const reborn = chromeMock({ removed, sessionSeed: stored, localSeed: mock.localStore });
  globalThis.chrome = reborn;
  reborn.tabs.seed(Number(opened.result.id), "https://example.com/kept");
  await loadWorker("local-restore-b");

  const current = await localOp("current", { tab: opened.result.id });
  assert.equal(current.ok, true, current.error);
  assert.equal(current.result.page.url, "https://example.com/kept");
});

test("pause refuses the local agent too, and says where to undo it", async () => {
  globalThis.chrome = chromeMock({ enabled: false });
  await loadWorker("local-paused");

  const refused = await askWorker({
    type: "ghost-relay-local-op",
    op: "open",
    args: { url: "https://example.com/" },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /paused/i);
  assert.match(refused.error, /menu/);

  // Status still answers, exactly as it does for the ghost over the socket.
  const status = await localOp("status");
  assert.equal(status.ok, true);
});

test("a page cannot reach the local agent, even one of our own pages in a tab", async () => {
  globalThis.chrome = chromeMock();
  await loadWorker("local-sender");

  const fromTab = await askWorker(
    { type: "ghost-relay-local-op", op: "open", args: { url: "https://example.com/" } },
    { ...panelSender(), tab: { id: 4 } },
  );
  assert.equal(fromTab, undefined);

  const fromWeb = await askWorker(
    { type: "ghost-relay-local-op", op: "open", args: { url: "https://example.com/" } },
    { id: "ghost-relay-test", url: "https://example.com/" },
  );
  assert.equal(fromWeb, undefined);

  // Nor the pairing and settings controls, which are the panel's alone too.
  const pairing = await askWorker(
    { type: "ghost-relay-pair" },
    { ...panelSender(), tab: { id: 4 } },
  );
  assert.equal(pairing, undefined);
});
