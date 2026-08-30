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

function chromeMock({
  attach,
  detach = async () => {},
  getTargets,
  sendCommand = async () => ({}),
  tabRemove = () => {},
}) {
  const tabs = new Map();
  let nextTabId = 17;
  const redacted = (tab) => tab && ({
    id: tab.id,
    windowId: tab.windowId,
    status: tab.status,
    active: tab.active,
  });
  return {
    debugger: {
      attach,
      detach,
      getTargets: getTargets ?? (async () => [...tabs.values()].map((tab) => ({
        tabId: tab.id,
        type: "page",
        attached: false,
        url: tab.url,
        title: tab.title,
      }))),
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
        return redacted(tab);
      },
      get: async (id) => redacted(tabs.get(id)) ?? null,
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      remove: async (id) => {
        tabRemove(id);
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
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  const first = runOp("read", { session: "s1", tab: "17" }, 1_000);
  const waiter = runOp("read", { session: "s1", tab: "17" }, 1_000);
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
    runOp("read", { session: "s1", tab: "17" }, 1_000),
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
  const { installOpsListeners, isAttached, releaseAllTabs, runOp } = await import(
    `../extension/ops.js?release-attach=${Date.now()}`
  );
  installOpsListeners();
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  const read = runOp("read", { session: "s1", tab: "17" }, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachTargets, [17]);
  await releaseAllTabs();
  const retry = runOp("read", { session: "s1", tab: "17" }, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(attachTargets, [17], "same-tab retry must wait for stale cleanup");

  firstAttach.resolve();
  await assert.rejects(
    read,
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /Tab 17 was released while Chromium was attaching/.test(error.message),
  );
  assert.deepEqual(detachTargets, [17]);
  assert.equal(isAttached(17), false);

  const retried = await retry;
  assert.equal(retried.text, "ok");
  assert.deepEqual(attachTargets, [17, 17]);
  assert.equal(isAttached(17), true);

  chrome.debugger.onDetach.emit({ tabId: 17 }, "canceled_by_user");
  assert.equal(isAttached(17), false);
  await assert.rejects(
    runOp("read", { session: "s1", tab: "17" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.deepEqual(attachTargets, [17, 17], "a genuine detach must not be suppressed");

  chrome.tabs.onUpdated.emit(17, { status: "loading" });
  const afterNavigation = await runOp("read", { session: "s1", tab: "17" }, 1_000);
  assert.equal(afterNavigation.text, "ok");
  assert.deepEqual(
    attachTargets,
    [17, 17, 17],
    "permission-free loading status must clear the post-detach ban",
  );
});

test("two tabs keep their own attachment and isolated world", async () => {
  const attachTargets = [];
  const worlds = [];
  let nextContextId = 9;
  globalThis.chrome = chromeMock({
    attach: async ({ tabId }) => {
      attachTargets.push(tabId);
    },
    sendCommand: async ({ tabId }, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        nextContextId += 1;
        worlds.push({ tabId, contextId: nextContextId });
        return { executionContextId: nextContextId };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: { url: "https://example/", title: "T", text: `tab ${tabId}` } } };
      }
      return {};
    },
  });
  const { installOpsListeners, isAttached, runOp } = await import(
    `../extension/ops.js?two-tabs=${Date.now()}`
  );
  installOpsListeners();
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("tabs", { session: "s1", op: "create", url: "https://second.example/" }, 1_000);

  assert.equal((await runOp("read", { session: "s1", tab: "17" }, 1_000)).text, "tab 17");
  assert.equal((await runOp("read", { session: "s1", tab: "18" }, 1_000)).text, "tab 18");
  assert.deepEqual(attachTargets, [17, 18]);
  assert.equal(isAttached(17), true);
  assert.equal(isAttached(18), true);
  assert.deepEqual(worlds, [{ tabId: 17, contextId: 10 }, { tabId: 18, contextId: 11 }]);

  // A navigation on one tab drops only that tab's world, so the other
  // conversation's refs survive.
  chrome.debugger.onEvent.emit({ tabId: 17 }, "Page.frameNavigated", { frame: { id: "main" } });
  await runOp("read", { session: "s1", tab: "18" }, 1_000);
  assert.equal(worlds.length, 2, "tab 18 must reuse its own world");
  await runOp("read", { session: "s1", tab: "17" }, 1_000);
  assert.deepEqual(worlds.at(-1), { tabId: 17, contextId: 12 });

  // Nor does one tab's detach ban the other.
  chrome.debugger.onDetach.emit({ tabId: 17 }, "canceled_by_user");
  assert.equal(isAttached(17), false);
  assert.equal(isAttached(18), true);
  assert.equal((await runOp("read", { session: "s1", tab: "18" }, 1_000)).text, "tab 18");
});

test("status names every claimed tab so the popup can show them", async () => {
  globalThis.chrome = chromeMock({ attach: async () => {} });
  const { runOp } = await import(`../extension/ops.js?status-tabs=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("tabs", { session: "s1", op: "create", url: "https://second.example/" }, 1_000);

  // The popup asks without a tab of its own: it is the owner's view of the whole
  // browser, not one conversation's.
  const all = await runOp("status", {}, 1_000);
  assert.deepEqual(all.tabs.map((tab) => tab.title), ["Tab 17", "Tab 18"]);
  assert.deepEqual(all.tabs.map((tab) => tab.active), [false, false]);

  const one = await runOp("status", { session: "s1", tab: "18" }, 1_000);
  assert.equal(one.attached, false);
  assert.equal(one.banned, false);
  assert.deepEqual(one.tabs.map((tab) => tab.active), [false, true]);
});

test("a session sees, drives, and closes only the tabs it opened", async () => {
  const removed = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: async (id) => removed.push(id),
  });
  const { runOp } = await import(`../extension/ops.js?ownership=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("open", { session: "s2", url: "https://second.example/" }, 1_000);

  // One conversation must not learn the other's tab id from the list...
  const mine = await runOp("tabs", { session: "s1", op: "list", tab: "17" }, 1_000);
  assert.deepEqual(mine.tabs.map((tab) => tab.id), ["17"]);
  assert.equal(mine.active, "17");

  // ...nor act on it if it guesses one.
  for (const op of ["switch", "close"]) {
    await assert.rejects(
      runOp("tabs", { session: "s1", op, id: "18", tab: "17" }, 1_000),
      (error) => error instanceof RelayOpError && error.failure === "invalid_input",
    );
  }
  await assert.rejects(
    runOp("read", { session: "s1", tab: "18" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "no_page",
  );
  assert.deepEqual(removed, []);
});

test("closing a session sweeps every tab it opened, not just the last one", async () => {
  const removed = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: async (id) => removed.push(id),
  });
  const { runOp } = await import(`../extension/ops.js?sweep=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  // `tabs create` re-points the caller; the tab it moved off must not be orphaned.
  await runOp("tabs", { session: "s1", op: "create", url: "https://second.example/" }, 1_000);
  await runOp("open", { session: "s2", url: "https://third.example/" }, 1_000);

  const closed = await runOp("close", { session: "s1", tab: "18" }, 1_000);
  assert.equal(closed.closed, true);
  assert.deepEqual(removed, [17, 18], "both of s1's tabs, and only s1's");

  // s2 is untouched and still works.
  const other = await runOp("tabs", { session: "s2", op: "list", tab: "19" }, 1_000);
  assert.deepEqual(other.tabs.map((tab) => tab.id), ["19"]);
});

test("session close sweeps older tabs after the current tab is gone", async () => {
  const removed = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: async (id) => removed.push(id),
  });
  const { runOp } = await import(`../extension/ops.js?current-gone=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("tabs", {
    session: "s1",
    op: "create",
    url: "https://second.example/",
  }, 1_000);

  await runOp("tabs", { session: "s1", op: "close", tab: "18" }, 1_000);
  const closed = await runOp("close", { session: "s1" }, 1_000);

  assert.equal(closed.closed, true);
  assert.deepEqual(removed, [18, 17]);
});

test("a partial session close keeps the refused live tab for retry", async () => {
  const removed = [];
  let refuseSecond = true;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: (id) => {
      if (id === 18 && refuseSecond) {
        refuseSecond = false;
        throw new Error("Chromium refused the close");
      }
      removed.push(id);
    },
  });
  const { runOp } = await import(`../extension/ops.js?close-retry=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("tabs", {
    session: "s1",
    op: "create",
    url: "https://second.example/",
  }, 1_000);

  await assert.rejects(
    runOp("close", { session: "s1" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.deepEqual(removed, [17]);

  const retried = await runOp("close", { session: "s1" }, 1_000);
  assert.equal(retried.closed, true);
  assert.deepEqual(removed, [17, 18]);
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
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  for (const query of [
    ":scope",
    ":/**/scope",
    String.raw`:sc\6f pe`,
    "&",
    "& > body",
    ":is(&)",
  ]) {
    await assert.rejects(
      runOp("find", { session: "s1", tab: "17", query, limit: 5 }, 1_000),
      (error) => error instanceof RelayOpError
        && error.failure === "invalid_input"
        && /bounded selector scan/.test(error.message),
    );
  }
  assert.equal(attachCalls, 0, "unsupported selectors must be rejected before attach");
  assert.equal(expressions.length, 0, "unsupported selectors must not reach the page");

  await runOp("find", { session: "s1", tab: "17", query: "needle", limit: 10_000 }, 1_000);
  await runOp("find", { session: "s1", tab: "17", query: "needle", limit: -20 }, 1_000);

  assert.equal(attachCalls, 1);
  assert.match(expressions[0], /\)\(\{"query":"needle","limit":100\}\)$/);
  assert.match(expressions[1], /\)\(\{"query":"needle","limit":1\}\)$/);
});

test("owned tab metadata comes from debugger targets without the tabs permission", async () => {
  globalThis.chrome = chromeMock({ attach: async () => {} });
  const { runOp } = await import(`../extension/ops.js?target-metadata=${Date.now()}`);

  const opened = await runOp("open", { session: "s1", url: "https://example.com/path" }, 1_000);
  assert.deepEqual(opened.page, {
    url: "https://example.com/path",
    title: "Tab 17",
  });

  const listed = await runOp("tabs", { session: "s1", op: "list", tab: "17" }, 1_000);
  assert.deepEqual(listed.tabs, [{
    id: "17",
    url: "https://example.com/path",
    title: "Tab 17",
    active: true,
  }]);
});

test("the relay operation deadline bounds CDP work without claiming to cancel it", async () => {
  const attaching = deferred();
  globalThis.chrome = chromeMock({ attach: () => attaching.promise });
  const { runOp } = await import(`../extension/ops.js?operation-deadline=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  const started = Date.now();
  await assert.rejects(
    runOp("read", { session: "s1", tab: "17" }, 1_000),
    (error) => error instanceof RelayOpError
      && error.failure === "timeout"
      && /running read/.test(error.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 2_000, `deadline fired after ${elapsed}ms`);

  // The Chrome API has no AbortSignal. A late transport result is still observed
  // and cleaned up by the attach generation rather than producing an unhandled
  // rejection or a second relay result.
  attaching.reject(new Error("late CDP failure"));
  await new Promise((resolve) => setImmediate(resolve));
});
