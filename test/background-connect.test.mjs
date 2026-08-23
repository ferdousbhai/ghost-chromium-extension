import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originalChrome = globalThis.chrome;
const originalWebSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
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
      for (const listener of listeners) listener(...args);
    },
  };
}

function chromeMock({ loadSettings, restoreSession = async () => ({ ghostTabId: null }) }) {
  return {
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    alarms: {
      create() {},
      onAlarm: eventHook(),
    },
    debugger: {
      onDetach: eventHook(),
      onEvent: eventHook(),
    },
    runtime: {
      getManifest: () => ({ version: "test" }),
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
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
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
