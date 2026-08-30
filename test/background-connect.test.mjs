import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PROTOCOL_VERSION } from "../extension/protocol.js";

const originalChrome = globalThis.chrome;
const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function eventHook() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    },
  };
}

function chromeMock({
  badges = [],
  debuggerTargets = async () => [],
  loadSettings,
  restoreSession = async () => ({ ghostTabId: null }),
  tabApi = {},
}) {
  return {
    action: {
      setBadgeText: async ({ text }) => badges.push(text),
      setBadgeBackgroundColor: async () => {},
    },
    alarms: {
      create() {},
      onAlarm: eventHook(),
    },
    debugger: {
      getTargets: debuggerTargets,
      onDetach: eventHook(),
      onEvent: eventHook(),
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
      local: { get: loadSettings },
      onChanged: eventHook(),
      session: {
        get: restoreSession,
        remove: async () => {},
        set: async () => {},
      },
    },
    tabs: {
      get: async () => null,
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      ...tabApi,
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function responseFor(socket, id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = socket.sent.find((frame) => frame.t === "res" && frame.id === id);
    if (response) return response;
    await settle();
  }
  assert.fail(`relay response ${id} did not arrive`);
}

test("connect is single-flight while settings and session restoration await", async () => {
  const settings = deferred();
  const session = deferred();
  let settingsReads = 0;
  let sessionReads = 0;
  const sockets = [];

  globalThis.chrome = chromeMock({
    loadSettings: () => {
      settingsReads += 1;
      return settings.promise;
    },
    restoreSession: () => {
      sessionReads += 1;
      return session.promise;
    },
  });
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(url);
    }
  };

  await import(`../extension/background.js?single-flight=${Date.now()}`);
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  chrome.runtime.onStartup.emit();
  assert.equal(settingsReads, 1);

  settings.resolve({ port: 7717, token: "paired", enabled: true });
  await settle();
  assert.equal(sessionReads, 1);
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });

  session.resolve({ ghostTabId: null });
  await settle();
  assert.deepEqual(sockets, ["ws://127.0.0.1:7717/relay"]);
});

test("a failed dial releases the latch and reconnects once", async () => {
  let constructions = 0;
  const reconnects = [];

  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
  });
  globalThis.setTimeout = (callback) => {
    reconnects.push(callback);
    return reconnects.length;
  };
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      constructions += 1;
      if (constructions === 1) throw new Error("dial failed");
      this.readyState = FakeWebSocket.CONNECTING;
    }
  };

  await import(`../extension/background.js?retry=${Date.now()}`);
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  chrome.runtime.onStartup.emit();
  await settle();
  assert.equal(constructions, 1);
  assert.equal(reconnects.length, 1);

  reconnects[0]();
  await settle();
  assert.equal(constructions, 2);
});

test("a settings change invalidates an awaiting attempt before it can dial", async () => {
  const oldSettings = deferred();
  let settingsReads = 0;
  const sockets = [];

  globalThis.chrome = chromeMock({
    loadSettings: () => {
      settingsReads += 1;
      if (settingsReads === 1) return oldSettings.promise;
      return Promise.resolve({ port: 8828, token: "new-token", enabled: true });
    },
  });
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(url);
    }
  };

  await import(`../extension/background.js?settings=${Date.now()}`);
  chrome.storage.onChanged.emit({ token: { newValue: "new-token" } }, "local");
  oldSettings.resolve({ port: 7717, token: "old-token", enabled: true });
  await settle();
  await settle();

  assert.equal(settingsReads, 2);
  assert.deepEqual(sockets, ["ws://127.0.0.1:8828/relay"]);
});

test("only this extension's popup can read live relay status", async () => {
  let settingsReads = 0;
  globalThis.chrome = chromeMock({
    loadSettings: async () => {
      settingsReads += 1;
      return { port: 7717, token: "", enabled: true };
    },
  });

  await import(`../extension/background.js?sender=${Date.now()}`);
  await settle();
  const startupReads = settingsReads;
  const leaked = [];
  const popupUrl = chrome.runtime.getURL("popup.html");

  for (const sender of [
    { id: "another-extension", url: popupUrl },
    { id: chrome.runtime.id, url: "https://attacker.example/", tab: { id: 7 } },
    { id: chrome.runtime.id, url: chrome.runtime.getURL("future-page.html") },
  ]) {
    const returns = chrome.runtime.onMessage.emit(
      { type: "ghost-relay-status" },
      sender,
      (status) => leaked.push(status),
    );
    assert.deepEqual(returns, [undefined]);
  }
  await settle();
  assert.deepEqual(leaked, []);
  assert.equal(settingsReads, startupReads);

  let status;
  const returns = chrome.runtime.onMessage.emit(
    { type: "ghost-relay-status" },
    { id: chrome.runtime.id, url: popupUrl },
    (value) => {
      status = value;
    },
  );
  assert.deepEqual(returns, [true]);
  await settle();

  assert.equal(settingsReads, startupReads);
  assert.deepEqual(status, {
    connected: false,
    paired: false,
    enabled: true,
    port: 7717,
    lastError: "Not paired yet — run `ghostd relay-token` and paste the token below.",
    tabs: [],
  });
});

test("a transient storage read failure is not cached as an unpaired configuration", async () => {
  let settingsReads = 0;
  globalThis.chrome = chromeMock({
    loadSettings: async () => {
      settingsReads += 1;
      if (settingsReads === 1) throw new Error("storage worker restarting");
      return { port: 8828, token: "recovered", enabled: true };
    },
  });

  await import(`../extension/background.js?storage-retry=${Date.now()}`);
  await settle();
  assert.equal(settingsReads, 1);

  const statuses = [];
  const popupUrl = chrome.runtime.getURL("popup.html");
  chrome.runtime.onMessage.emit(
    { type: "ghost-relay-status" },
    { id: chrome.runtime.id, url: popupUrl },
    (status) => statuses.push(status),
  );
  await settle();
  chrome.runtime.onMessage.emit(
    { type: "ghost-relay-status" },
    { id: chrome.runtime.id, url: popupUrl },
    (status) => statuses.push(status),
  );
  await settle();

  assert.equal(settingsReads, 2);
  assert.deepEqual(statuses.map(({ paired, port }) => ({ paired, port })), [
    { paired: true, port: 8828 },
    { paired: true, port: 8828 },
  ]);
});

test("settings are cached and an open socket stays off until a compatible welcome", async () => {
  const badges = [];
  const sockets = [];
  let settingsReads = 0;
  let stored = { port: 7717, token: "paired", enabled: true };
  globalThis.chrome = chromeMock({
    badges,
    loadSettings: async () => {
      settingsReads += 1;
      return stored;
    },
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    close() {
      this.readyState = 3;
    }
  };

  await import(`../extension/background.js?welcome=${Date.now()}`);
  await settle();
  assert.equal(settingsReads, 1);
  const socket = sockets[0];
  socket.readyState = WebSocket.OPEN;
  socket.onopen();
  await settle();
  assert.deepEqual(socket.sent.map((frame) => frame.t), ["hello"]);
  assert.equal(badges.at(-1), "off");

  // Requests are not accepted merely because TCP/WebSocket setup completed.
  socket.onmessage({ data: JSON.stringify({ t: "req", id: 1, op: "status", args: {} }) });
  await settle();
  assert.deepEqual(socket.sent.map((frame) => frame.t), ["hello"]);

  socket.onmessage({
    data: JSON.stringify({ t: "welcome", protocol: PROTOCOL_VERSION, daemon: "ghostd" }),
  });
  await settle();
  assert.equal(badges.at(-1), "on");

  socket.onmessage({ data: JSON.stringify({ t: "req", id: 2, op: "status", args: {} }) });
  await settle();
  assert.equal(socket.sent.at(-1).t, "res");
  assert.equal(socket.sent.at(-1).id, 2);
  assert.equal(settingsReads, 1, "requests reuse the cached settings snapshot");

  stored = { ...stored, enabled: false };
  chrome.storage.onChanged.emit({ enabled: { oldValue: true, newValue: false } }, "local");
  await settle();
  assert.equal(settingsReads, 2, "a storage change invalidates the cached snapshot");
  assert.equal(badges.at(-1), "||");

  socket.onmessage({ data: JSON.stringify({ t: "req", id: 3, op: "read", args: {} }) });
  await settle();
  assert.equal(socket.sent.at(-1).id, 3);
  assert.equal(socket.sent.at(-1).ok, false);
  assert.equal(socket.sent.at(-1).error.failure, "browser_unavailable");
  assert.equal(settingsReads, 2);
});

test("an old protocol-2 daemon is refused with update guidance", async () => {
  const sockets = [];
  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closes = [];
      sockets.push(this);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    close(code, reason) {
      this.readyState = 3;
      this.closes.push({ code, reason });
    }
  };

  await import(`../extension/background.js?old-protocol=${Date.now()}`);
  await settle();
  const socket = sockets[0];
  socket.readyState = WebSocket.OPEN;
  socket.onopen();
  assert.equal(socket.sent.at(-1).protocol, 3);

  socket.onmessage({
    data: JSON.stringify({ t: "welcome", protocol: 2, daemon: "old-ghostd" }),
  });
  await settle();
  assert.equal(socket.closes[0].code, 4000);
  assert.match(socket.closes[0].reason, /speaks relay protocol 2.*speaks 3/i);
  assert.match(socket.closes[0].reason, /update whichever is older/i);

  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  await settle();
  assert.equal(sockets.length, 1, "a version mismatch must not reconnect-loop");
});

test("a late operation result cannot cross into a replacement socket", async () => {
  const statusRead = deferred();
  const sockets = [];
  let tabReads = 0;
  let stored = { port: 7717, token: "first-token", enabled: true };
  const tab = { id: 17, windowId: 4, status: "complete" };
  globalThis.chrome = chromeMock({
    debuggerTargets: async () => [{
      tabId: 17,
      type: "page",
      attached: false,
      url: "https://example.com/",
      title: "Example",
    }],
    loadSettings: async () => stored,
    restoreSession: async () => ({ ghostTabs: { tabs: [17] } }),
    tabApi: {
      get: async () => {
        tabReads += 1;
        return tabReads === 2 ? statusRead.promise : tab;
      },
      remove: async () => {},
    },
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    close() {
      this.readyState = 3;
    }
  };

  await import(`../extension/background.js?socket-generation=${Date.now()}`);
  await settle();
  const first = sockets[0];
  first.readyState = WebSocket.OPEN;
  first.onopen();
  first.onmessage({
    data: JSON.stringify({ t: "welcome", protocol: PROTOCOL_VERSION, daemon: "ghostd" }),
  });
  await settle();

  first.onmessage({
    data: JSON.stringify({ t: "req", id: 41, op: "status", args: { tab: "17" }, timeoutMs: 1_000 }),
  });
  await settle();
  stored = { ...stored, token: "second-token" };
  chrome.storage.onChanged.emit({ token: { oldValue: "first-token", newValue: "second-token" } }, "local");
  await settle();
  const second = sockets[1];
  second.readyState = WebSocket.OPEN;
  second.onopen();
  second.onmessage({
    data: JSON.stringify({ t: "welcome", protocol: PROTOCOL_VERSION, daemon: "ghostd" }),
  });

  statusRead.resolve(tab);
  await settle();
  assert.equal(first.sent.some((frame) => frame.id === 41), false);
  assert.equal(second.sent.some((frame) => frame.id === 41), false);

  // Leave the shared ops module without a remembered tab for later test files.
  second.onmessage({ data: JSON.stringify({ t: "req", id: 42, op: "close", args: {} }) });
  await settle();
  assert.equal(second.sent.at(-1).id, 42);
});

test("close waits for tab creation after its response deadline and tombstones the session", async () => {
  const created = deferred();
  const sockets = [];
  const removed = [];
  let createCalls = 0;
  let live = false;
  const tab = {
    id: 17,
    windowId: 4,
    status: "complete",
    url: "https://example.com/",
    title: "Example",
  };
  globalThis.chrome = chromeMock({
    debuggerTargets: async () => live
      ? [{ tabId: 17, type: "page", attached: false, url: tab.url, title: tab.title }]
      : [],
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
    tabApi: {
      create: async () => {
        createCalls += 1;
        await created.promise;
        live = true;
        return tab;
      },
      get: async () => live ? tab : null,
      remove: async (tabId) => {
        removed.push(tabId);
        live = false;
      },
    },
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    close() {
      this.readyState = 3;
    }
  };

  await import(`../extension/background.js?session-order=${Date.now()}`);
  await settle();
  const socket = sockets[0];
  socket.readyState = WebSocket.OPEN;
  socket.onopen();
  socket.onmessage({
    data: JSON.stringify({ t: "welcome", protocol: PROTOCOL_VERSION, daemon: "ghostd" }),
  });
  await settle();

  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 51,
      op: "open",
      args: { session: "retiring", url: tab.url },
      timeoutMs: 1_000,
    }),
  });
  await settle();
  assert.equal(createCalls, 1);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const timedOut = await responseFor(socket, 51);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.failure, "timeout");

  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 52,
      op: "close",
      args: { session: "retiring" },
      timeoutMs: 1_000,
    }),
  });
  await settle();
  assert.equal(socket.sent.some((frame) => frame.id === 52), false);
  assert.deepEqual(removed, []);

  created.resolve();
  assert.equal((await responseFor(socket, 52)).ok, true);
  assert.deepEqual(removed, [17]);

  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 53,
      op: "open",
      args: { session: "retiring", url: tab.url },
      timeoutMs: 1_000,
    }),
  });
  const stale = await responseFor(socket, 53);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.failure, "browser_unavailable");
  assert.equal(createCalls, 1);

  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 54,
      op: "open",
      args: { session: "fresh", url: tab.url },
      timeoutMs: 1_000,
    }),
  });
  assert.equal((await responseFor(socket, 54)).ok, true);
  assert.equal(createCalls, 2);
  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 55,
      op: "close",
      args: { session: "fresh" },
      timeoutMs: 1_000,
    }),
  });
  assert.equal((await responseFor(socket, 55)).ok, true);
});
