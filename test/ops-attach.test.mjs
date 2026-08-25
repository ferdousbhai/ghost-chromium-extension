import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { RelayOpError } from "../extension/protocol.js";

const originalChrome = globalThis.chrome;

afterEach(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    },
  };
}

function chromeMock({ attach, detach = async () => {}, sendCommand = async () => ({}) }) {
  const tabs = new Map();
  let nextTabId = 17;
  return {
    debugger: {
      attach,
      detach,
      getTargets: async () => [],
      onDetach: eventHook(),
      onEvent: eventHook(),
      sendCommand,
    },
    storage: {
      session: {
        get: async () => ({ ghostTabs: null }),
        set: async () => {},
      },
    },
    tabs: {
      create: async ({ url = "about:blank" }) => {
        const tab = {
          id: nextTabId,
          windowId: 4,
          url,
          title: `Tab ${nextTabId}`,
          status: "complete",
        };
        nextTabId += 1;
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => tabs.get(id) ?? null,
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      remove: async (id) => {
        tabs.delete(id);
      },
      update: async (id, update) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("missing tab");
        Object.assign(tab, update);
        return tab;
      },
    },
    windows: { update: async () => {} },
  };
}

test("every concurrent attach waiter receives browser_unavailable", async () => {
  const attaching = deferred();
  let attachCalls = 0;
  globalThis.chrome = chromeMock({
    attach: () => {
      attachCalls += 1;
      return attaching.promise;
    },
  });
  const { runOp } = await import(`../extension/ops.js?attach-failure=${Date.now()}`);
  await runOp("open", { url: "https://example.com/" }, 1_000);

  const first = runOp("read", {}, 1_000);
  const waiter = runOp("read", {}, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attachCalls, 1);

  attaching.reject(new Error("DevTools owns the target"));
  const failures = await Promise.allSettled([first, waiter]);
  assert.equal(failures.length, 2);
  for (const result of failures) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof RelayOpError);
    assert.equal(result.reason.failure, "browser_unavailable");
    assert.match(result.reason.message, /DevTools owns the target/);
  }

  await assert.rejects(
    runOp("read", {}, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.equal(attachCalls, 1);
});

test("release invalidates an in-flight attach and the stale success detaches itself", async () => {
  const firstAttach = deferred();
  const attachTargets = [];
  const detachTargets = [];
  globalThis.chrome = chromeMock({
    attach: ({ tabId }) => {
      attachTargets.push(tabId);
      return attachTargets.length === 1 ? firstAttach.promise : Promise.resolve();
    },
    detach: async ({ tabId }) => {
      detachTargets.push(tabId);
    },
    sendCommand: async (_target, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { value: { url: "https://example.com/", title: "Example", text: "ok" } } };
      }
      return {};
    },
  });
  const { installOpsListeners, isAttached, releaseTab, runOp } = await import(
    `../extension/ops.js?release-attach=${Date.now()}`
  );
  installOpsListeners();
  await runOp("open", { url: "https://example.com/" }, 1_000);

  const read = runOp("read", {}, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachTargets, [17]);
  await releaseTab();
  const retry = runOp("read", {}, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachTargets, [17], "same-tab retry must wait for stale cleanup");

  firstAttach.resolve();
  await assert.rejects(
    read,
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /active ghost tab changed/.test(error.message),
  );
  assert.deepEqual(detachTargets, [17]);
  assert.equal(isAttached(), false);

  const retried = await retry;
  assert.equal(retried.text, "ok");
  assert.deepEqual(attachTargets, [17, 17]);
  assert.equal(isAttached(), true);

  chrome.debugger.onDetach.emit({ tabId: 17 }, "canceled_by_user");
  assert.equal(isAttached(), false);
  await assert.rejects(
    runOp("read", {}, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.deepEqual(attachTargets, [17, 17], "a genuine detach must not be suppressed");
});

test("switch invalidates an in-flight attach without resurrecting the old tab", async () => {
  const firstAttach = deferred();
  const attachTargets = [];
  const detachTargets = [];
  globalThis.chrome = chromeMock({
    attach: ({ tabId }) => {
      attachTargets.push(tabId);
      return attachTargets.length === 1 ? firstAttach.promise : Promise.resolve();
    },
    detach: async ({ tabId }) => {
      detachTargets.push(tabId);
    },
    sendCommand: async (_target, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { value: { url: "https://second.example/", title: "Second", text: "ok" } } };
      }
      return {};
    },
  });
  const { currentTabId, isAttached, runOp } = await import(
    `../extension/ops.js?switch-attach=${Date.now()}`
  );
  await runOp("open", { url: "https://first.example/" }, 1_000);
  await runOp("tabs", { op: "create", url: "https://second.example/" }, 1_000);
  await runOp("tabs", { op: "switch", id: "17" }, 1_000);

  const read = runOp("read", {}, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachTargets, [17]);
  await runOp("tabs", { op: "switch", id: "18" }, 1_000);

  firstAttach.resolve();
  await assert.rejects(
    read,
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.deepEqual(detachTargets, [17]);
  assert.equal(currentTabId(), 18);
  assert.equal(isAttached(), false);

  const retried = await runOp("read", {}, 1_000);
  assert.equal(retried.text, "ok");
  assert.deepEqual(attachTargets, [17, 18]);
  assert.equal(currentTabId(), 18);
  assert.equal(isAttached(), true);
});

test("find clamps relay-provided limits before evaluating page code", async () => {
  const expressions = [];
  let attachCalls = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {
      attachCalls += 1;
    },
    sendCommand: async (_target, method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        expressions.push(params.expression);
        return { result: { value: [] } };
      }
      return {};
    },
  });
  const { runOp } = await import(`../extension/ops.js?find-limit=${Date.now()}`);
  await runOp("open", { url: "https://example.com/" }, 1_000);

  for (const query of [
    ":scope",
    ":/**/scope",
    String.raw`:sc\6f pe`,
    "&",
    "& > body",
    ":is(&)",
  ]) {
    await assert.rejects(
      runOp("find", { query, limit: 5 }, 1_000),
      (error) => error instanceof RelayOpError
        && error.failure === "invalid_input"
        && /bounded selector scan/.test(error.message),
    );
  }
  assert.equal(attachCalls, 0, "unsupported selectors must be rejected before attach");
  assert.equal(expressions.length, 0, "unsupported selectors must not reach the page");

  await runOp("find", { query: "needle", limit: 10_000 }, 1_000);
  await runOp("find", { query: "needle", limit: -20 }, 1_000);

  assert.equal(attachCalls, 1);
  assert.match(expressions[0], /\)\(\{"query":"needle","limit":100\}\)$/);
  assert.match(expressions[1], /\)\(\{"query":"needle","limit":1\}\)$/);
});
