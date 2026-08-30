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

test("interval refresh is bounded and single-flight when storage hangs", async () => {
  const firstRead = deferred();
  const intervals = [];
  let reads = 0;
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    storage: {
      local: {
        get: () => {
          reads += 1;
          return reads === 1
            ? firstRead.promise
            : Promise.resolve({ port: 7717, token: "paired", enabled: true });
        },
        set: async () => {},
      },
    },
    runtime: { sendMessage: async () => ({ connected: false, paired: true, tabs: [] }) },
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
  assert.equal(reads, 1, "timer ticks coalesce behind the in-flight refresh");

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await settle();
  assert.match(document.elements.detail.textContent, /did not return the relay settings in time/i);

  intervals[0]();
  await settle();
  assert.equal(reads, 2, "the next tick retries after the bounded failure");
  firstRead.resolve({ port: 9999, token: "stale", enabled: true });
});

test("save and toggle are bounded and never overlap", async () => {
  const firstWrite = deferred();
  const writes = [];
  let settingReads = 0;
  const document = popupDocument();
  globalThis.document = document;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (defaults) => {
          if (Object.hasOwn(defaults, "port")) {
            settingReads += 1;
            return { port: 7717, token: "paired", enabled: true };
          }
          return { enabled: true };
        },
        set: (value) => {
          writes.push(value);
          return writes.length === 1 ? firstWrite.promise : Promise.resolve();
        },
      },
    },
    runtime: { sendMessage: async () => ({ connected: false, paired: true, tabs: [] }) },
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
  assert.deepEqual(writes, [{ token: "new-token", port: 8828 }]);
  assert.equal(document.elements.save.disabled, true);
  assert.equal(document.elements.toggle.disabled, true);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await settle();
  assert.equal(document.elements.save.disabled, false);
  assert.equal(document.elements.toggle.disabled, false);
  assert.match(document.elements.detail.textContent, /did not save the relay settings in time/i);

  firstWrite.resolve();
  document.elements.toggle.emit("click");
  for (let attempt = 0; attempt < 20 && writes.length < 2; attempt += 1) await settle();
  assert.deepEqual(writes[1], { enabled: false });
  assert.ok(settingReads >= 1);
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
