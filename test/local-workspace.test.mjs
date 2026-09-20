/**
 * The side panel's workspace against a ghost's, in the one file where the two
 * meet: `ops.js`. There is no second tab backend, so the only thing that can
 * separate them is the workspace id — and the only thing that makes a mistake
 * legible is a refusal that names the owner.
 *
 * The ghost-to-ghost refusal is pinned here too. The daemon treats relay failure
 * messages as a compatibility surface, so improving the cross-mode one must not
 * quietly reword the one a ghost already reads.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { RelayOpError } from "../extension/protocol.js";

const originalChrome = globalThis.chrome;
const INCARNATION_A = "11111111-1111-4111-8111-111111111111";
const INCARNATION_B = "22222222-2222-4222-8222-222222222222";
const GHOST = "3f2a1c4e-0000-4000-8000-000000000001";
const OTHER_GHOST = "3f2a1c4e-0000-4000-8000-000000000002";
const LOCAL = "local:9a1b2c3d-0000-4000-8000-000000000003";

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
});

function eventHook() {
  const listeners = [];
  return {
    addListener: (listener) => listeners.push(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); },
    removeListener: () => {},
  };
}

function chromeMock({ incarnation = null, removed = [] } = {}) {
  const tabs = new Map();
  let nextTabId = 17;
  const redacted = (tab) => tab && {
    id: tab.id, windowId: tab.windowId, status: tab.status, active: tab.active,
  };
  return {
    debugger: {
      attach: async () => {},
      detach: async () => {},
      getTargets: async () => [...tabs.values()].map((tab) => ({
        tabId: tab.id, type: "page", attached: false, url: tab.url, title: tab.title,
      })),
      onDetach: eventHook(),
      onEvent: eventHook(),
      sendCommand: async (_target, method) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
        if (method === "Runtime.evaluate") {
          return { result: { value: { url: "https://example.com/", title: "Example", text: "ok" } } };
        }
        return {};
      },
    },
    storage: {
      local: {
        get: async (defaults) => {
          if (Object.hasOwn(defaults, "ghostDaemonIncarnation")) {
            return {
              ...defaults,
              ghostDaemonIncarnation: incarnation === null
                ? null
                : { version: 1, revision: 2, incarnation },
            };
          }
          return { ...defaults };
        },
        remove: async () => {},
        set: async () => {},
      },
      session: {
        get: async (defaults) => ({ ...defaults }),
        set: async () => {},
      },
    },
    tabs: {
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
      remove: async (id) => {
        removed.push(id);
        tabs.delete(id);
      },
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

async function freshOps(label) {
  return import(`../extension/ops.js?${label}=${Date.now()}-${Math.random()}`);
}

test("a local turn pointed at a ghost's tab is refused, and told whose it is", async () => {
  globalThis.chrome = chromeMock();
  const { runOp } = await freshOps("local-vs-ghost");
  const opened = await runOp("open", { session: GHOST, url: "https://example.com/" }, 1_000);

  await assert.rejects(
    runOp("read", { session: LOCAL, tab: opened.id }, 1_000),
    (error) => {
      assert.ok(error instanceof RelayOpError);
      assert.equal(error.failure, "invalid_input");
      assert.match(error.message, /belongs to a ghost's browser workspace/);
      assert.match(error.message, /not this browser's local chat/);
      return true;
    },
  );
});

test("a ghost pointed at the side panel's tab is refused, and told whose it is", async () => {
  globalThis.chrome = chromeMock();
  const { runOp } = await freshOps("ghost-vs-local");
  const opened = await runOp("open", { session: LOCAL, url: "https://example.com/" }, 1_000);

  await assert.rejects(
    runOp("click", { session: GHOST, tab: opened.id, selector: "button" }, 1_000),
    (error) => {
      assert.ok(error instanceof RelayOpError);
      assert.equal(error.failure, "invalid_input");
      assert.match(error.message, /belongs to this browser's local chat/);
      assert.match(error.message, /not a ghost's browser workspace/);
      return true;
    },
  );
});

test("one ghost naming another ghost's tab still gets the daemon's own message", async () => {
  globalThis.chrome = chromeMock();
  const { runOp } = await freshOps("ghost-vs-ghost");
  const opened = await runOp("open", { session: GHOST, url: "https://example.com/" }, 1_000);

  await assert.rejects(
    runOp("read", { session: OTHER_GHOST, tab: opened.id }, 1_000),
    (error) => {
      assert.ok(error instanceof RelayOpError);
      assert.equal(error.failure, "no_page");
      assert.equal(error.message, "No page is loaded. Use action \"open\" with a URL first.");
      return true;
    },
  );
});

test("a ghostd restart retires the ghost's workspace and leaves the chat's alone", async () => {
  const removed = [];
  globalThis.chrome = chromeMock({ incarnation: INCARNATION_A, removed });
  const { reconcileDaemonIncarnation, runOp } = await freshOps("incarnation");
  const ghostTab = await runOp("open", { session: GHOST, url: "https://example.com/one" }, 1_000);
  const localTab = await runOp("open", { session: LOCAL, url: "https://example.com/two" }, 1_000);

  await reconcileDaemonIncarnation(INCARNATION_B);

  assert.deepEqual(removed, [Number(ghostTab.id)]);
  const still = await runOp("current", { session: LOCAL, tab: localTab.id }, 1_000);
  assert.equal(still.page.url, "https://example.com/two");
  await assert.rejects(
    runOp("current", { session: GHOST, tab: ghostTab.id }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
});
