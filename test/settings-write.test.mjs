import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originalChrome = globalThis.chrome;
// Never Node's real WebSocket: an unpaired worker dials for pairing on import,
// and a test must not reach a live daemon port. Tests that care install their
// own fake; this inert one is the floor.
class InertWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;

  constructor() {
    this.readyState = 0;
  }

  close() {}
}
const originalWebSocket = InertWebSocket;
globalThis.WebSocket = InertWebSocket;

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  globalThis.WebSocket = originalWebSocket;
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

function extensionChrome({ loadSettings, persistLocal }) {
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
      getTargets: async () => [],
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
      local: {
        get: loadSettings,
        remove: async () => {},
        set: persistLocal,
      },
      onChanged: eventHook(),
      session: {
        get: async () => ({}),
        remove: async () => {},
        set: async () => {},
      },
    },
    tabs: {
      get: async () => { throw new Error("No tab with id"); },
      onRemoved: eventHook(),
      onUpdated: eventHook(),
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("the worker repairs a timed-out panel write after that panel context is gone", async () => {
  const firstRawWrite = deferred();
  const stored = {
    port: 7717,
    token: "",
    enabled: true,
    ghostRelaySettingsFence: null,
  };
  let rawWrites = 0;
  globalThis.chrome = extensionChrome({
    loadSettings: async () => structuredClone(stored),
    persistLocal: async (value) => {
      if (Object.hasOwn(value, "ghostRelaySettingsFence")) {
        Object.assign(stored, structuredClone(value));
        return;
      }
      if (Object.hasOwn(value, "port")) {
        rawWrites += 1;
        if (rawWrites === 1) await firstRawWrite.promise;
      }
      Object.assign(stored, structuredClone(value));
    },
  });
  await import(`../extension/background.js?settings-fence=${Date.now()}`);
  await settle();
  const popup = {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL("sidepanel.html"),
  };

  let firstResponse;
  chrome.runtime.onMessage.emit(
    {
      type: "ghost-relay-settings-update",
      settings: { port: 8111, token: "first" },
    },
    popup,
    (value) => { firstResponse = value; },
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await settle();
  assert.equal(firstResponse.ok, false);

  let secondResponse;
  chrome.runtime.onMessage.emit(
    {
      type: "ghost-relay-settings-update",
      settings: { port: 8222, token: "newest" },
    },
    popup,
    (value) => { secondResponse = value; },
  );
  for (let attempt = 0; attempt < 20 && secondResponse === undefined; attempt += 1) await settle();
  assert.equal(secondResponse.ok, true);
  assert.deepEqual(
    { port: stored.port, token: stored.token, enabled: stored.enabled },
    { port: 8222, token: "newest", enabled: true },
  );

  // The initiating popup is gone. Its old Chrome write can still settle, but
  // the worker's durable generation fence owns the repair.
  firstRawWrite.resolve();
  for (let attempt = 0; attempt < 20 && rawWrites < 4; attempt += 1) await settle();
  await settle();
  await settle();
  assert.equal(rawWrites, 4);
  assert.deepEqual(
    { port: stored.port, token: stored.token, enabled: stored.enabled },
    { port: 8222, token: "newest", enabled: true },
  );
  assert.equal(stored.ghostRelaySettingsFence.revision, 4);
  assert.equal(stored.ghostRelaySettingsFenceBackup.revision, 4);
});

test("a late settings-fence write cannot regress a newer worker choice", async () => {
  const firstFenceWrite = deferred();
  const stored = {
    port: 7717,
    token: "",
    enabled: true,
    ghostRelaySettingsFence: null,
  };
  let fenceWrites = 0;
  globalThis.chrome = extensionChrome({
    loadSettings: async () => structuredClone(stored),
    persistLocal: async (value) => {
      if (Object.hasOwn(value, "ghostRelaySettingsFence")) {
        fenceWrites += 1;
        if (fenceWrites === 1) await firstFenceWrite.promise;
      }
      Object.assign(stored, structuredClone(value));
    },
  });
  await import(`../extension/background.js?settings-fence-race=${Date.now()}`);
  await settle();
  const popup = {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL("sidepanel.html"),
  };

  let firstResponse;
  chrome.runtime.onMessage.emit(
    {
      type: "ghost-relay-settings-update",
      settings: { port: 8111, token: "first" },
    },
    popup,
    (value) => { firstResponse = value; },
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  for (let attempt = 0; attempt < 20 && firstResponse === undefined; attempt += 1) await settle();
  assert.equal(firstResponse.ok, false);

  let secondResponse;
  chrome.runtime.onMessage.emit(
    {
      type: "ghost-relay-settings-update",
      settings: { port: 8222, token: "newest" },
    },
    popup,
    (value) => { secondResponse = value; },
  );
  for (let attempt = 0; attempt < 20 && secondResponse === undefined; attempt += 1) await settle();
  assert.equal(
    secondResponse,
    undefined,
    "a newer choice is not acknowledged while an older fence write is still indeterminate",
  );

  firstFenceWrite.resolve();
  for (let attempt = 0; attempt < 40 && secondResponse === undefined; attempt += 1) await settle();
  assert.equal(secondResponse.ok, true);
  await settle();
  assert.ok(fenceWrites >= 3);
  assert.deepEqual(stored.ghostRelaySettingsFence, {
    version: 1,
    revision: 4,
    settings: { port: 8222, token: "newest", enabled: true },
  });
  assert.deepEqual(stored.ghostRelaySettingsFenceBackup, stored.ghostRelaySettingsFence);
  assert.deepEqual(
    { port: stored.port, token: stored.token, enabled: stored.enabled },
    { port: 8222, token: "newest", enabled: true },
  );
});

test("a fresh worker repairs raw settings from the durable fence", async () => {
  const stored = {
    port: 8111,
    token: "stale",
    enabled: true,
    ghostRelaySettingsFence: {
      version: 1,
      revision: 4,
      settings: { port: 8111, token: "stale", enabled: true },
    },
    ghostRelaySettingsFenceBackup: {
      version: 1,
      revision: 4,
      settings: { port: 8222, token: "", enabled: false },
    },
  };
  globalThis.chrome = extensionChrome({
    loadSettings: async () => structuredClone(stored),
    persistLocal: async (value) => { Object.assign(stored, structuredClone(value)); },
  });

  await import(`../extension/background.js?settings-fence-restart=${Date.now()}`);
  for (let attempt = 0; attempt < 20 && stored.port !== 8222; attempt += 1) await settle();
  assert.deepEqual(
    { port: stored.port, token: stored.token, enabled: stored.enabled },
    { port: 8222, token: "", enabled: false },
  );
  assert.equal(stored.ghostRelaySettingsFence.revision, 4);
  assert.equal(stored.ghostRelaySettingsFenceBackup.revision, 4);
});
