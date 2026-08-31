import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originalChrome = globalThis.chrome;
const originalDocument = globalThis.document;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.className = "";
    this.textContent = "";
    this.children = [];
    this.listeners = new Map();
  }

  set innerHTML(_value) {
    this.children = [];
  }

  addEventListener(event, listener) {
    this.listeners.set(event, listener);
  }

  append(...children) {
    this.children.push(...children);
  }

  emit(event) {
    this.listeners.get(event)?.();
  }
}

function popupDocument() {
  const ids = [
    "dot", "statusText", "detail", "tab", "token", "port", "save", "saved", "toggle",
    "enabledLabel",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
  elements.tab.hidden = true;
  elements.saved.hidden = true;
  return {
    activeElement: null,
    elements,
    getElementById: (id) => elements[id],
    createElement: () => new FakeElement(),
    createTextNode: (text) => ({ textContent: text }),
  };
}

function textOf(element) {
  return `${element.textContent ?? ""}${(element.children ?? []).map((child) => textOf(child)).join("")}`;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("interval refresh is bounded and single-flight when the worker hangs", async () => {
  const firstStatus = deferred();
  const intervals = [];
  let requests = 0;
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    runtime: {
      sendMessage: () => {
        requests += 1;
        return requests === 1
          ? firstStatus.promise
          : Promise.resolve({
            connected: false,
            paired: true,
            token: "paired",
            port: 7717,
            enabled: true,
            tabs: [],
          });
      },
    },
  };
  globalThis.setInterval = (callback) => {
    intervals.push(callback);
    return intervals.length;
  };
  globalThis.clearInterval = () => {};

  await import(`../extension/popup.js?refresh-timeout=${Date.now()}`);
  intervals[0]();
  intervals[0]();
  intervals[0]();
  await settle();
  assert.equal(requests, 1, "timer ticks coalesce behind the in-flight refresh");

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await settle();
  assert.match(document.elements.detail.textContent, /did not answer status in time/i);

  intervals[0]();
  await settle();
  assert.equal(requests, 2, "the next tick retries after the bounded failure");
  firstStatus.resolve({ connected: false, paired: false, token: "", tabs: [] });
});

test("an extension tab without popup authority renders a bounded fallback", async () => {
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    runtime: {
      // Chrome resolves sendMessage with undefined when no listener accepts it.
      sendMessage: async () => undefined,
    },
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};

  await import(`../extension/popup.js?unauthorized-tab=${Date.now()}`);
  await settle();

  assert.equal(document.elements.statusText.textContent, "Not paired");
  assert.match(document.elements.detail.textContent, /did not return status to this page/i);
  assert.equal(document.elements.token.value, "");
  assert.equal(document.elements.toggle.textContent, "Pause");
});

test("save and toggle are bounded and never overlap", async () => {
  const firstUpdate = deferred();
  const updates = [];
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => {
        if (message.type === "ghost-relay-status") {
          return {
            connected: false,
            paired: true,
            token: "paired",
            port: 7717,
            enabled: true,
            tabs: [],
          };
        }
        updates.push(message.settings);
        if (updates.length === 1) return firstUpdate.promise;
        return {
          ok: true,
          settings: { port: 8828, token: "new-token", enabled: false },
        };
      },
    },
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};

  await import(`../extension/popup.js?mutation-timeout=${Date.now()}`);
  await settle();
  document.elements.token.value = "new-token";
  document.elements.port.value = "8828";
  document.elements.save.emit("click");
  document.elements.save.emit("click");
  document.elements.toggle.emit("click");
  await settle();
  assert.deepEqual(updates, [{ token: "new-token", port: 8828 }]);
  assert.equal(document.elements.save.disabled, true);
  assert.equal(document.elements.toggle.disabled, true);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await settle();
  assert.equal(document.elements.save.disabled, false);
  assert.equal(document.elements.toggle.disabled, false);
  assert.match(document.elements.detail.textContent, /did not save the settings in time/i);

  firstUpdate.resolve({ ok: false, error: "stale update finished late" });
  document.elements.toggle.emit("click");
  for (let attempt = 0; attempt < 20 && updates.length < 2; attempt += 1) await settle();
  assert.deepEqual(updates[1], { enabled: false });
});

test("settings mutations are delegated to the durable worker boundary", async () => {
  const messages = [];
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => { throw new Error("the popup must not read settings storage"); },
        set: async () => { throw new Error("the popup must not write settings storage"); },
      },
    },
    runtime: {
      sendMessage: async (message) => {
        messages.push(structuredClone(message));
        if (message.type === "ghost-relay-status") {
          return {
            connected: false,
            paired: true,
            token: "paired",
            port: 7717,
            enabled: true,
            tabs: [],
          };
        }
        return {
          ok: true,
          settings: { port: 8222, token: "newest-token", enabled: true },
        };
      },
    },
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};

  await import(`../extension/popup.js?late-save=${Date.now()}`);
  await settle();
  document.elements.token.value = "newest-token";
  document.elements.port.value = "8222";
  document.elements.save.emit("click");
  for (let attempt = 0; attempt < 20 && messages.length < 2; attempt += 1) await settle();
  assert.deepEqual(messages[1], {
    type: "ghost-relay-settings-update",
    settings: { token: "newest-token", port: 8222 },
  });
});

test("a ghost tab without title or URL falls back to its tab id, including zero", async () => {
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ port: 7717, token: "paired", enabled: true }),
        set: async () => {},
      },
    },
    runtime: {
      sendMessage: async () => ({
        connected: true,
        paired: true,
        enabled: true,
        lastError: "",
        tabs: [{ id: 0, title: "", url: "", active: false }],
      }),
    },
  };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};

  await import(`../extension/popup.js?tab-fallback=${Date.now()}`);
  for (let attempt = 0; attempt < 20 && document.elements.tab.hidden; attempt += 1) await settle();
  assert.equal(document.elements.tab.hidden, false);
  assert.match(textOf(document.elements.tab), /Ghost's tab: Tab 0/);
});
