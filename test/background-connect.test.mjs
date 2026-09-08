import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PAIR_SUBPROTOCOL_PREFIX, PROTOCOL_VERSION, SUBPROTOCOL } from "../extension/protocol.js";

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
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const INCARNATION_A = "11111111-1111-4111-8111-111111111111";
const INCARNATION_B = "22222222-2222-4222-8222-222222222222";
const BROWSER_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function incarnationPublication(incarnation, revision = 2) {
  return { version: 1, revision, incarnation };
}

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  globalThis.WebSocket = originalWebSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
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
  setBadgeColor = async () => {},
  setBadgeText = async ({ text }) => badges.push(text),
  persistFence = async () => {},
  persistLocal = async () => {},
  removeLocal = async () => {},
  restoreIncarnation = async () => ({ ghostDaemonIncarnation: null }),
  restorePoison = async () => ({ ghostOwnershipPoison: null }),
  persistSession = async () => {},
  restoreSession = async () => ({ ghostTabId: null }),
  tabApi = {},
}) {
  return {
    action: {
      setBadgeText,
      setBadgeBackgroundColor: setBadgeColor,
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
      local: {
        get: async (defaults) => {
          let restored;
          if (Object.hasOwn(defaults, "ghostOwnershipPoison")) {
            restored = await restorePoison(defaults);
          } else if (Object.hasOwn(defaults, "ghostDaemonIncarnation")) {
            restored = await restoreIncarnation(defaults);
          } else {
            restored = await loadSettings(defaults);
          }
          return { ...defaults, ...restored };
        },
        remove: removeLocal,
        set: (value) => Object.hasOwn(value, "ghostOwnershipFence")
          ? persistFence(value)
          : persistLocal(value),
      },
      onChanged: eventHook(),
      session: {
        get: restoreSession,
        remove: async () => {},
        set: persistSession,
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

test("an indeterminate ownership restore fails closed before dialing", async () => {
  const reconnects = [];
  const sockets = [];
  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
    restoreSession: async () => { throw new Error("session storage unavailable"); },
  });
  globalThis.setTimeout = (callback) => {
    reconnects.push(callback);
    return reconnects.length;
  };
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url) {
      sockets.push(url);
    }
  };

  await import(`../extension/background.js?restore-failure=${Date.now()}`);
  await settle();
  assert.deepEqual(sockets, []);
  assert.equal(reconnects.length, 1);

  let status;
  chrome.runtime.onMessage.emit(
    { type: "ghost-relay-status" },
    { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") },
    (value) => { status = value; },
  );
  await settle();
  assert.equal(status.connected, false);
  assert.match(status.lastError, /could not restore browser ownership.*storage unavailable/i);
});

test("a timed-out ownership read releases connect for the alarm retry", async () => {
  const firstRead = deferred();
  const reconnects = [];
  const sockets = [];
  let reads = 0;
  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
    restoreSession: () => {
      reads += 1;
      return reads === 1 ? firstRead.promise : Promise.resolve({ ghostTabs: null });
    },
  });
  globalThis.setTimeout = (callback) => {
    reconnects.push(callback);
    return reconnects.length;
  };
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(url);
    }
  };

  await import(`../extension/background.js?restore-timeout=${Date.now()}`);
  await new Promise((resolve) => originalSetTimeout(resolve, 1_100));
  await settle();
  assert.equal(reads, 1);
  assert.deepEqual(sockets, []);
  assert.equal(reconnects.length, 1);

  reconnects[0]();
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(sockets, ["ws://127.0.0.1:7717/relay"]);
  firstRead.resolve({ ghostTabs: null });
});

test("a timed-out settings read releases connect and the popup for an alarm retry", async () => {
  const firstRead = deferred();
  const reconnects = [];
  const sockets = [];
  let reads = 0;
  globalThis.chrome = chromeMock({
    loadSettings: () => {
      reads += 1;
      return reads === 1
        ? firstRead.promise
        : Promise.resolve({ port: 8828, token: "recovered", enabled: true });
    },
  });
  globalThis.setTimeout = (callback, delay) => {
    reconnects.push({ callback, delay });
    return reconnects.length;
  };
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url) {
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(url);
    }
  };

  await import(`../extension/background.js?settings-timeout=${Date.now()}`);
  let status;
  chrome.runtime.onMessage.emit(
    { type: "ghost-relay-status" },
    { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") },
    (value) => { status = value; },
  );
  await new Promise((resolve) => originalSetTimeout(resolve, 1_100));
  await settle();

  assert.equal(reads, 1);
  assert.deepEqual(sockets, []);
  const reconnect = reconnects.find(({ delay }) => delay === 1_000);
  assert.ok(reconnect, "the failed preparation schedules the normal reconnect");
  assert.equal(status.paired, false, "the popup gets bounded fallback state instead of hanging");

  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  await settle();
  assert.equal(reads, 2);
  assert.deepEqual(sockets, ["ws://127.0.0.1:8828/relay"]);
  firstRead.resolve({ port: 7717, token: "stale", enabled: true });
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

test("hung cosmetic badge I/O cannot pin unpaired alarm or settings recovery", async () => {
  const never = deferred();
  const sockets = [];
  let settings = { port: 7717, token: "", enabled: true };
  globalThis.chrome = chromeMock({
    loadSettings: async () => settings,
    setBadgeColor: () => never.promise,
    setBadgeText: () => never.promise,
  });
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url, protocols) {
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(protocols[1].startsWith(PAIR_SUBPROTOCOL_PREFIX) ? `pair ${url}` : url);
    }

    close() {}
  };

  await import(`../extension/background.js?badge-hang=${Date.now()}`);
  await settle();
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  await settle();
  // Unpaired, the worker dials for pairing without waiting on the badge.
  assert.deepEqual(sockets, ["pair ws://127.0.0.1:7717/relay"]);

  settings = { ...settings, token: "paired" };
  chrome.storage.onChanged.emit({ token: { oldValue: "", newValue: "paired" } }, "local");
  for (let attempt = 0; attempt < 20 && sockets.length === 1; attempt += 1) await settle();
  assert.deepEqual(sockets, ["pair ws://127.0.0.1:7717/relay", "ws://127.0.0.1:7717/relay"]);
  never.resolve();
  await settle();
});

test("reconnect attempts share one cancelable timer and recover through an alarm", async () => {
  const timers = new Map();
  const sockets = [];
  let nextTimer = 1;
  let failDial = true;
  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
  });
  globalThis.setTimeout = (callback, delay) => {
    const id = nextTimer;
    nextTimer += 1;
    timers.set(id, {
      delay,
      run: () => {
        timers.delete(id);
        callback();
      },
    });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor() {
      if (failDial) throw new Error("dial failed");
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
    }

    close() {
      this.readyState = 3;
      this.onclose?.({ code: 1000, reason: "" });
    }
  };

  await import(`../extension/background.js?timer-coalesce=${Date.now()}`);
  await settle();
  assert.equal(timers.size, 1);
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [1_000]);

  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  chrome.runtime.onStartup.emit();
  await settle();
  assert.equal(timers.size, 1, "overlapping failures coalesce behind one retry timer");

  failDial = false;
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(timers.size, 0, "an alarm recovery cancels the obsolete retry");

  sockets[0].onclose({ code: 1006, reason: "" });
  assert.equal(timers.size, 1);
  chrome.storage.onChanged.emit({ token: { oldValue: "paired", newValue: "new" } }, "local");
  await settle();
  assert.equal(sockets.length, 2);
  assert.equal(timers.size, 0, "a settings redial cancels the disconnected socket's retry");
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

  // Unpaired, the worker dials for pairing; a test must never let that reach
  // a real daemon port.
  const dials = [];
  globalThis.WebSocket = class {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url, protocols) {
      this.readyState = 0;
      dials.push({ url, protocols });
    }

    close() {}
  };

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
  assert.match(status.pairingCode, /^[0-9]{6}$/);
  assert.equal(dials.length, 1);
  assert.equal(dials[0].protocols[1], `${PAIR_SUBPROTOCOL_PREFIX}${status.pairingCode}`);
  assert.deepEqual(status, {
    connected: false,
    paired: false,
    pairingCode: status.pairingCode,
    pairingDenied: false,
    token: "",
    enabled: true,
    port: 7717,
    lastError: "",
    tabs: [],
  });
});

test("the popup reports a nonempty list of tabs owned by the relay", async () => {
  const sockets = [];
  let live = false;
  const tab = {
    id: 73,
    windowId: 4,
    status: "complete",
    url: "https://popup.example/",
    title: "Popup tab",
  };
  globalThis.chrome = chromeMock({
    debuggerTargets: async () => live
      ? [{ tabId: tab.id, type: "page", attached: false, url: tab.url, title: tab.title }]
      : [],
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
    tabApi: {
      create: async () => {
        live = true;
        return tab;
      },
      get: async () => live ? tab : null,
      remove: async () => { live = false; },
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

  await import(`../extension/background.js?popup-tabs=${Date.now()}`);
  await settle();
  const socket = sockets[0];
  socket.readyState = WebSocket.OPEN;
  socket.onopen();
  socket.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_A,
    }),
  });
  await settle();
  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 31,
      op: "open",
      args: { session: "popup-list", url: tab.url },
      timeoutMs: 1_000,
    }),
  });
  assert.equal((await responseFor(socket, 31)).ok, true);

  let status;
  chrome.runtime.onMessage.emit(
    { type: "ghost-relay-status" },
    { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") },
    (value) => { status = value; },
  );
  for (let attempt = 0; attempt < 20 && status === undefined; attempt += 1) await settle();
  assert.deepEqual(status.tabs, [{
    id: "73",
    active: false,
    url: tab.url,
    title: tab.title,
  }]);

  socket.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 32,
      op: "close",
      args: { session: "popup-list" },
      timeoutMs: 1_000,
    }),
  });
  assert.equal((await responseFor(socket, 32)).ok, true);
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
  let settingsError = null;
  let stored = { port: 7717, token: "paired", enabled: true };
  globalThis.chrome = chromeMock({
    badges,
    loadSettings: async () => {
      settingsReads += 1;
      if (settingsError !== null) throw settingsError;
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
  assert.deepEqual(socket.sent, []);
  assert.equal(badges.at(-1), "off");

  // Requests are not accepted merely because TCP/WebSocket setup completed.
  socket.onmessage({ data: JSON.stringify({ t: "req", id: 1, op: "status", args: {} }) });
  await settle();
  assert.deepEqual(socket.sent, []);

  socket.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_A,
    }),
  });
  await settle();
  assert.equal(badges.at(-1), "on");
  assert.equal(socket.sent.at(-1).t, "hello");

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

  settingsError = new Error("settings storage is restarting");
  chrome.storage.onChanged.emit({ enabled: { oldValue: false, newValue: true } }, "local");
  await settle();
  socket.onmessage({ data: JSON.stringify({ t: "req", id: 4, op: "read", args: {} }) });
  await settle();
  assert.equal(socket.sent.at(-1).id, 4);
  assert.equal(socket.sent.at(-1).ok, false);
  assert.equal(socket.sent.at(-1).error.failure, "browser_unavailable");
  assert.match(socket.sent.at(-1).error.message, /could not verify.*settings storage is restarting/i);

  socket.onmessage({ data: JSON.stringify({ t: "req", id: 5, op: "status", args: {} }) });
  await settle();
  assert.equal(socket.sent.at(-1).id, 5);
  assert.equal(socket.sent.at(-1).ok, true, "status remains available for recovery visibility");
});

test("a new daemon incarnation retires crash-orphaned claims before hello", async () => {
  const removal = deferred();
  const sockets = [];
  const timeouts = [];
  let live = false;
  let storedSession = { ghostTabs: null };
  const storedLocal = {
    ghostOwnershipPoison: null,
    ghostDaemonIncarnation: null,
  };
  const tab = {
    id: 91,
    windowId: 4,
    status: "complete",
    url: "https://crash.example/",
    title: "Crash claim",
  };
  globalThis.chrome = chromeMock({
    debuggerTargets: async () => live
      ? [{ tabId: tab.id, type: "page", attached: false, url: tab.url, title: tab.title }]
      : [],
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    removeLocal: async (key) => { storedLocal[key] = null; },
    restoreIncarnation: async () => ({
      ghostDaemonIncarnation: storedLocal.ghostDaemonIncarnation,
    }),
    restorePoison: async () => ({ ghostOwnershipPoison: storedLocal.ghostOwnershipPoison }),
    persistSession: async (value) => { storedSession = structuredClone(value); },
    restoreSession: async () => structuredClone(storedSession),
    tabApi: {
      create: async () => {
        live = true;
        return tab;
      },
      get: async () => live ? tab : null,
      remove: async () => {
        await removal.promise;
        live = false;
      },
    },
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = (callback, delay) => {
    timeouts.push({ callback, delay });
    return timeouts.length;
  };
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

  await import(`../extension/background.js?daemon-incarnation=${Date.now()}`);
  await settle();
  const first = sockets[0];
  first.readyState = WebSocket.OPEN;
  first.onopen();
  first.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_A,
    }),
  });
  await settle();
  assert.equal(first.sent.at(-1).t, "hello");
  first.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 61,
      op: "open",
      args: { session: "lost-daemon", url: tab.url },
      timeoutMs: 1_000,
    }),
  });
  assert.equal((await responseFor(first, 61)).ok, true);
  assert.equal(storedLocal.ghostDaemonIncarnation.incarnation, INCARNATION_A);
  assert.deepEqual(storedSession.ghostTabs.sessions, [["lost-daemon", [91]]]);

  first.readyState = 3;
  const timersBeforeCrash = timeouts.length;
  first.onclose({ code: 1006, reason: "" });
  await settle();
  const reconnect = timeouts.slice(timersBeforeCrash).find(({ delay }) => delay === 1_000);
  assert.ok(reconnect);
  reconnect.callback();
  await settle();

  const replacement = sockets[1];
  replacement.readyState = WebSocket.OPEN;
  replacement.onopen();
  replacement.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_B,
    }),
  });
  await settle();
  assert.deepEqual(replacement.sent, [], "the new daemon is not admitted before old claims retire");

  removal.resolve();
  for (let attempt = 0; attempt < 30 && replacement.sent.length === 0; attempt += 1) await settle();
  assert.equal(replacement.sent.at(-1).t, "hello");
  assert.equal(storedLocal.ghostDaemonIncarnation.incarnation, INCARNATION_B);
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
  assert.equal(live, false);
});

test("an old protocol-3 daemon is refused with update guidance", async () => {
  const sockets = [];
  const reconnects = [];
  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "paired", enabled: true }),
  });
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = (callback, delay) => {
    reconnects.push({ callback, delay });
    return reconnects.length;
  };
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
  assert.deepEqual(socket.sent, []);

  socket.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION - 1,
      daemon: "old-ghostd",
    }),
  });
  await settle();
  assert.equal(socket.closes[0].code, 4000);
  assert.match(socket.closes[0].reason, /speaks relay protocol 3.*speaks 4/i);
  assert.match(socket.closes[0].reason, /update whichever is older/i);

  socket.onclose({ code: 4000, reason: socket.closes[0].reason });
  await settle();
  assert.equal(reconnects.length, 1);
  assert.equal(reconnects[0].delay, 60_000);

  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  await settle();
  assert.equal(sockets.length, 1, "alarms must not turn a version mismatch into a reconnect loop");

  reconnects[0].callback();
  await settle();
  assert.equal(sockets.length, 2, "the slow probe lets an updated peer recover without settings edits");
  const recovered = sockets[1];
  recovered.readyState = WebSocket.OPEN;
  recovered.onopen();
  recovered.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "updated-ghostd",
      incarnation: INCARNATION_A,
    }),
  });
  await settle();
  assert.equal(recovered.sent.at(-1).protocol, PROTOCOL_VERSION);
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
    restoreIncarnation: async () => ({
      ghostDaemonIncarnation: incarnationPublication(INCARNATION_A),
    }),
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs: [17],
        sessions: [["socket-session", [17]]],
        retired: [],
      },
    }),
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
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_A,
    }),
  });
  await settle();

  first.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 41,
      op: "status",
      args: { session: "socket-session", tab: "17" },
      timeoutMs: 1_000,
    }),
  });
  await settle();
  stored = { ...stored, token: "second-token" };
  chrome.storage.onChanged.emit({ token: { oldValue: "first-token", newValue: "second-token" } }, "local");
  await settle();
  const second = sockets[1];
  second.readyState = WebSocket.OPEN;
  second.onopen();
  second.onmessage({
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_A,
    }),
  });

  statusRead.resolve(tab);
  await settle();
  assert.equal(first.sent.some((frame) => frame.id === 41), false);
  assert.equal(second.sent.some((frame) => frame.id === 41), false);

  // Leave the shared ops module without a remembered tab for later test files.
  second.onmessage({
    data: JSON.stringify({
      t: "req",
      id: 42,
      op: "close",
      args: { session: "socket-session" },
    }),
  });
  await settle();
  assert.equal(second.sent.at(-1).id, 42);
});

test("close tombstones on the response deadline and cleans up a late tab creation", async () => {
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
    data: JSON.stringify({
      t: "welcome",
      protocol: PROTOCOL_VERSION,
      daemon: "ghostd",
      incarnation: INCARNATION_A,
    }),
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
  assert.equal((await responseFor(socket, 52)).ok, true);
  assert.deepEqual(removed, []);

  created.resolve();
  for (let attempt = 0; attempt < 20 && removed.length === 0; attempt += 1) await settle();
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

test("an unpaired worker dials with a code and stores the token the daemon hands back", async () => {
  const sockets = [];
  const fenced = [];
  let settings = { port: 7717, token: "", enabled: true };
  globalThis.chrome = chromeMock({
    loadSettings: async () => settings,
    persistLocal: async (value) => {
      const publication = value.ghostRelaySettingsFence;
      if (!publication) return;
      fenced.push(publication);
      settings = { ...settings, ...publication.settings };
    },
  });
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.closed = null;
      sockets.push(this);
    }

    close(code, reason) {
      this.closed = { code, reason };
      this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
    }
  };
  const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
  const statusNow = async () => {
    let status;
    chrome.runtime.onMessage.emit({ type: "ghost-relay-status" }, popup, (value) => { status = value; });
    await settle();
    return status;
  };

  await import(`../extension/background.js?pairing=${Date.now()}`);
  await settle();
  assert.equal(sockets.length, 1);
  const [pairing] = sockets;
  assert.equal(pairing.protocols[0], SUBPROTOCOL);
  const code = pairing.protocols[1].slice(PAIR_SUBPROTOCOL_PREFIX.length);
  assert.match(code, /^[0-9]{6}$/);
  pairing.readyState = 1;
  pairing.onopen();
  let status = await statusNow();
  assert.equal(status.paired, false);
  assert.equal(status.pairingCode, code, "the popup shows the same code the daemon holds");
  assert.equal(status.pairingDenied, false);

  // A daemon that expires the request gets a fresh code on the redial.
  pairing.close(4002, "nobody answered the pairing request");
  await settle();
  status = await statusNow();
  assert.equal(status.pairingCode, null);

  // The owner's Allow arrives as a paired frame; the token is fenced into
  // settings and the paired redial follows.
  const before = sockets.length;
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  for (let attempt = 0; attempt < 20 && sockets.length === before; attempt += 1) await settle();
  const second = sockets[sockets.length - 1];
  assert.match(second.protocols[1], /^ghost-pair\.[0-9]{6}$/);
  assert.notEqual(second.protocols[1], pairing.protocols[1]);
  second.readyState = 1;
  second.onopen();
  second.onmessage({ data: JSON.stringify({ t: "paired", token: "f".repeat(64) }) });
  for (let attempt = 0; attempt < 40 && fenced.length === 0; attempt += 1) await settle();
  assert.equal(fenced[0].settings.token, "f".repeat(64));
  assert.deepEqual(second.closed, { code: 1000, reason: "paired" });
  chrome.storage.onChanged.emit({ token: { oldValue: "", newValue: "f".repeat(64) } }, "local");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await settle();
    if (sockets.some((socket) => socket.protocols[1].startsWith("ghost-token."))) break;
  }
  const paired = sockets[sockets.length - 1];
  assert.equal(paired.protocols[1], `ghost-token.${"f".repeat(64)}`);
  status = await statusNow();
  assert.equal(status.paired, true);
  assert.equal(status.pairingCode, null);
});

test("a denied pairing stops redialing until the popup asks again", async () => {
  const sockets = [];
  const timers = [];
  globalThis.setTimeout = (callback, delay) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  globalThis.clearTimeout = () => {};
  globalThis.chrome = chromeMock({
    loadSettings: async () => ({ port: 7717, token: "", enabled: true }),
  });
  globalThis.WebSocket = class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;

    constructor(_url, protocols) {
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      sockets.push(this);
    }

    close(code, reason) {
      this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
    }
  };
  const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };

  await import(`../extension/background.js?pairing-denied=${Date.now()}`);
  await settle();
  assert.equal(sockets.length, 1);
  sockets[0].readyState = 1;
  sockets[0].onopen();
  sockets[0].close(4001, "pairing denied");
  await settle();
  const reconnects = timers.filter((timer) => timer.delay >= 1_000).length;
  chrome.alarms.onAlarm.emit({ name: "ghost-relay-keepalive" });
  await settle();
  assert.equal(sockets.length, 1, "no redial after a denial");
  assert.equal(timers.filter((timer) => timer.delay >= 1_000).length, reconnects, "no reconnect timer either");

  let status;
  chrome.runtime.onMessage.emit({ type: "ghost-relay-status" }, popup, (value) => { status = value; });
  await settle();
  assert.equal(status.pairingDenied, true);
  assert.match(status.lastError, /denied/i);

  let retried;
  chrome.runtime.onMessage.emit({ type: "ghost-relay-pair" }, popup, (value) => { retried = value; });
  for (let attempt = 0; attempt < 20 && sockets.length === 1; attempt += 1) await settle();
  assert.equal(retried?.ok, true);
  assert.equal(sockets.length, 2, "Try again dials afresh");
  assert.notEqual(sockets[1].protocols[1], sockets[0].protocols[1], "with a new code");
});
