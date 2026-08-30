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
  persistLocal = async () => {},
  persistSession = async () => {},
  removeLocal = async () => {},
  restoreLocal = async () => ({ ghostOwnershipPoison: null }),
  restoreSession = async () => ({ ghostTabs: null }),
  sendCommand = async () => ({}),
  tabCreate,
  tabGet,
  tabRemove = () => {},
  tabUpdate,
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
      local: {
        get: restoreLocal,
        remove: removeLocal,
        set: persistLocal,
      },
      session: {
        get: restoreSession,
        set: persistSession,
      },
    },
    tabs: {
      create: async ({ url = "about:blank" }) => {
        if (tabCreate) return tabCreate({ url }, tabs);
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
      get: async (id) => {
        const tab = redacted(tabs.get(id));
        if (tabGet) return tabGet(id, tab);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      },
      onRemoved: eventHook(),
      onUpdated: eventHook(),
      remove: async (id) => {
        await tabRemove(id);
        tabs.delete(id);
      },
      update: async (id, update) => {
        if (tabUpdate) return tabUpdate(id, update, tabs);
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

test("a timed-out stale detach blocks a newer attachment until its outcome is known", async () => {
  const firstAttach = deferred();
  const staleDetach = deferred();
  let attachCalls = 0;
  let detachCalls = 0;
  globalThis.chrome = chromeMock({
    attach: () => {
      attachCalls += 1;
      return attachCalls === 1 ? firstAttach.promise : Promise.resolve();
    },
    detach: () => {
      detachCalls += 1;
      return staleDetach.promise;
    },
    sendCommand: async (_target, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { value: { url: "https://example.com/", title: "E", text: "ok" } } };
      }
      return {};
    },
  });
  const { releaseAllTabs, runOp } = await import(
    `../extension/ops.js?stale-detach-timeout=${Date.now()}`
  );
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  const staleRead = runOp("read", { session: "s1", tab: "17" }, 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  await releaseAllTabs();
  firstAttach.resolve();
  await assert.rejects(
    staleRead,
    (error) => error instanceof RelayOpError && /released while Chromium was attaching/.test(error.message),
  );
  assert.equal(detachCalls, 1);

  await assert.rejects(
    runOp("read", { session: "s1", tab: "17" }, 1_000),
    (error) => error instanceof RelayOpError && /cleaning up an older debugger attachment/.test(error.message),
  );
  assert.equal(attachCalls, 1, "an indeterminate stale detach must quarantine the tab");

  staleDetach.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runOp("read", { session: "s1", tab: "17" }, 1_000)).text, "ok");
  assert.equal(attachCalls, 2);
});

test("release attempts every attached tab and retains an indeterminate detach for retry", async () => {
  const firstDetach = deferred();
  const detached = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    detach: ({ tabId }) => {
      detached.push(tabId);
      return tabId === 17 && detached.filter((id) => id === 17).length === 1
        ? firstDetach.promise
        : Promise.resolve();
    },
    sendCommand: async (_target, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { value: { url: "https://example.com/", title: "E", text: "ok" } } };
      }
      return {};
    },
  });
  const { isAttached, releaseAllTabs, runOp } = await import(
    `../extension/ops.js?release-detach-timeout=${Date.now()}`
  );
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("tabs", { session: "s1", op: "create", url: "https://second.example/" }, 1_000);
  await runOp("read", { session: "s1", tab: "17" }, 1_000);
  await runOp("read", { session: "s1", tab: "18" }, 1_000);

  await releaseAllTabs();
  assert.deepEqual(detached, [17, 18]);
  assert.equal(isAttached(17), true, "a timed-out detach remains visible for retry");
  assert.equal(isAttached(18), false, "later tabs are still released");

  firstDetach.reject(new Error("late detach failure"));
  await new Promise((resolve) => setImmediate(resolve));
  await releaseAllTabs();
  assert.deepEqual(detached, [17, 18, 17]);
  assert.equal(isAttached(17), false);
});

test("close retries an indeterminate debugger detach instead of marking it released", async () => {
  const firstDetach = deferred();
  let detachAttempts = 0;
  let removeAttempts = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    detach: () => {
      detachAttempts += 1;
      return detachAttempts === 1 ? firstDetach.promise : Promise.resolve();
    },
    sendCommand: async (_target, method) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { value: { url: "https://example.com/", title: "E", text: "ok" } } };
      }
      return {};
    },
    tabRemove: async () => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw new Error("Chromium refused the close");
    },
  });
  const { isAttached, runOp } = await import(`../extension/ops.js?close-detach-timeout=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);
  await runOp("read", { session: "s1", tab: "17" }, 1_000);

  await assert.rejects(
    runOp("close", { session: "s1" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.equal(isAttached(17), true);

  firstDetach.reject(new Error("late detach failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await runOp("close", { session: "s1" }, 1_000)).closed, true);
  assert.equal(detachAttempts, 2);
  assert.equal(isAttached(17), false);
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

test("protocol-4 tab creation refuses a missing owner session", async () => {
  globalThis.chrome = chromeMock({ attach: async () => {} });
  const { runOp } = await import(`../extension/ops.js?missing-owner=${Date.now()}`);

  for (const [op, args] of [
    ["open", { url: "https://example.com/" }],
    ["tabs", { op: "create", url: "https://example.com/" }],
  ]) {
    await assert.rejects(
      runOp(op, args, 1_000),
      (error) => error instanceof RelayOpError && error.failure === "invalid_input",
    );
  }
  assert.deepEqual((await runOp("status", {}, 1_000)).tabs, []);
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

test("a worker restart restores a durably published session claim", async () => {
  let stored = { ghostTabs: null };
  const removed = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: async (value) => { stored = structuredClone(value); },
    restoreSession: async () => structuredClone(stored),
    tabRemove: async (id) => { removed.push(id); },
  });
  const first = await import(`../extension/ops.js?persist-owner=${Date.now()}`);
  await first.runOp("open", { session: "durable", url: "https://example.com/" }, 1_000);
  assert.deepEqual(stored, {
    ghostTabs: {
      version: 2,
      tabs: [17],
      sessions: [["durable", [17]]],
      retired: [],
    },
  });

  const restarted = await import(`../extension/ops.js?restore-owner=${Date.now()}`);
  await restarted.restoreTabsFromSession();
  const closed = await restarted.runOp("close", { session: "durable" }, 1_000);
  assert.equal(closed.closed, true);
  assert.deepEqual(removed, [17]);
});

test("a claim is not acknowledged until storage accepts it", async () => {
  const stored = deferred();
  let acknowledged = false;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: () => stored.promise,
  });
  const { runOp } = await import(`../extension/ops.js?claim-barrier=${Date.now()}`);
  const opening = runOp("open", { session: "s1", url: "https://example.com/" }, 5_000)
    .then((result) => {
      acknowledged = true;
      return result;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);

  stored.resolve();
  await opening;
  assert.equal(acknowledged, true);
});

test("a timed-out ownership write cannot block close and repairs a late stale write", async () => {
  const firstWrite = deferred();
  let storedSession = { ghostTabs: null };
  let storedLocal = { ghostOwnershipPoison: null };
  let writes = 0;
  let removals = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { storedLocal = structuredClone(value); },
    persistSession: async (value) => {
      writes += 1;
      if (writes === 1) await firstWrite.promise;
      storedSession = structuredClone(value);
    },
    removeLocal: async () => { storedLocal = { ghostOwnershipPoison: null }; },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabRemove: async () => {
      removals += 1;
      if (removals === 1) throw new Error("Chromium refused the rollback");
    },
  });
  const writer = await import(`../extension/ops.js?write-timeout=${Date.now()}`);

  await assert.rejects(
    writer.runOp("open", { session: "timed-write", url: "https://example.com/" }, 2_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.ok(writes >= 2, "a timed-out first claim must not retain the ownership lane");
  assert.equal((await writer.runOp("close", { session: "timed-write" }, 2_000)).closed, true);

  firstWrite.resolve();
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(storedSession, {
    ghostTabs: { version: 2, tabs: [], sessions: [], retired: [] },
  });
  assert.deepEqual(storedLocal, { ghostOwnershipPoison: null });

  await assert.rejects(
    writer.runOp("open", { session: "timed-write", url: "https://late.example/" }, 1_000),
    (error) => error instanceof RelayOpError && /session is closed/.test(error.message),
  );
  const restarted = await import(`../extension/ops.js?write-timeout-restart=${Date.now()}`);
  await restarted.restoreTabsFromSession();
});

test("a timed-out poison publication releases close and repairs its late result", async () => {
  const poisonWrite = deferred();
  let storedSession = { ghostTabs: null };
  let storedLocal = { ghostOwnershipPoison: null };
  let sessionWrites = 0;
  let localWrites = 0;
  let removals = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => {
      localWrites += 1;
      if (localWrites === 1) await poisonWrite.promise;
      storedLocal = structuredClone(value);
    },
    persistSession: async (value) => {
      sessionWrites += 1;
      if (sessionWrites === 1) throw new Error("session storage unavailable");
      storedSession = structuredClone(value);
    },
    removeLocal: async () => { storedLocal = { ghostOwnershipPoison: null }; },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabRemove: async () => {
      removals += 1;
      if (removals === 1) throw new Error("Chromium refused the rollback");
    },
  });
  const writer = await import(`../extension/ops.js?poison-timeout=${Date.now()}`);

  await assert.rejects(
    writer.runOp("open", { session: "timed-poison", url: "https://example.com/" }, 2_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.equal((await writer.runOp("close", { session: "timed-poison" }, 2_000)).closed, true);

  poisonWrite.resolve();
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(storedLocal, { ghostOwnershipPoison: null });
  assert.deepEqual(storedSession, {
    ghostTabs: { version: 2, tabs: [], sessions: [], retired: [] },
  });
});

test("a rejected claim publication closes the unowned new tab", async () => {
  const removed = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: async () => { throw new Error("session storage unavailable"); },
    tabRemove: async (id) => { removed.push(id); },
  });
  const { runOp } = await import(`../extension/ops.js?claim-rollback=${Date.now()}`);

  await assert.rejects(
    runOp("open", { session: "s1", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /rolled back/.test(error.message),
  );
  assert.deepEqual(removed, [17]);
});

test("double claim persistence failure stays poisoned across a worker restart", async () => {
  let failPersistence = true;
  let failRemoval = true;
  let storedSession = { ghostTabs: null };
  let storedLocal = { ghostOwnershipPoison: null };
  let persistenceAttempts = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { storedLocal = structuredClone(value); },
    persistSession: async (value) => {
      persistenceAttempts += 1;
      if (failPersistence) throw new Error("session storage unavailable");
      storedSession = structuredClone(value);
    },
    removeLocal: async () => { storedLocal = { ghostOwnershipPoison: null }; },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabRemove: async () => {
      if (failRemoval) throw new Error("Chromium refused the rollback");
    },
  });
  const first = await import(`../extension/ops.js?poison-writer=${Date.now()}`);

  await assert.rejects(
    first.runOp("open", { session: "poisoned", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /across a worker restart/.test(error.message),
  );
  assert.equal(persistenceAttempts, 2, "the uncertain live tab gets a second durable claim attempt");
  assert.deepEqual(storedLocal, {
    ghostOwnershipPoison: { version: 1, claims: [["poisoned", 17]] },
  });

  const restarted = await import(`../extension/ops.js?poison-reader=${Date.now()}`);
  await assert.rejects(
    restarted.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /indeterminate after a worker restart/.test(error.message),
  );
  await assert.rejects(
    restarted.runOp("open", { session: "fresh", url: "https://other.example/" }, 1_000),
    (error) => error instanceof RelayOpError && /ownership of tab 17 is indeterminate/i.test(error.message),
  );

  failPersistence = false;
  failRemoval = false;
  const recovered = await first.runOp("close", { session: "poisoned" }, 1_000);
  assert.equal(recovered.closed, true);
  assert.deepEqual(storedLocal, { ghostOwnershipPoison: null });

  let cleared = false;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    removeLocal: async () => { cleared = true; },
    restoreLocal: async () => ({
      ghostOwnershipPoison: { version: 1, claims: [["already-gone", 99]] },
    }),
  });
  const absent = await import(`../extension/ops.js?poison-absent=${Date.now()}`);
  await absent.restoreTabsFromSession();
  assert.equal(cleared, true, "an authoritative no-such-tab result clears the restart poison");
});

test("concurrent failed claims publish every uncertain tab to the poison ledger", async () => {
  let nextId = 17;
  let storedLocal = { ghostOwnershipPoison: null };
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { storedLocal = structuredClone(value); },
    persistSession: async () => { throw new Error("session storage unavailable"); },
    tabCreate: ({ url }, tabs) => {
      const tab = { id: nextId, windowId: 4, status: "complete", url, title: `Tab ${nextId}` };
      nextId += 1;
      tabs.set(tab.id, tab);
      return tab;
    },
    tabRemove: async () => { throw new Error("Chromium refused the rollback"); },
  });
  const concurrent = await import(`../extension/ops.js?poison-concurrent=${Date.now()}`);

  const failures = await Promise.allSettled([
    concurrent.runOp("open", { session: "one", url: "https://one.example/" }, 1_000),
    concurrent.runOp("open", { session: "two", url: "https://two.example/" }, 1_000),
  ]);

  assert.deepEqual(failures.map(({ status }) => status), ["rejected", "rejected"]);
  assert.deepEqual(storedLocal, {
    ghostOwnershipPoison: { version: 1, claims: [["one", 17], ["two", 18]] },
  });
});

test("restore fails closed when storage or tab existence is indeterminate", async () => {
  globalThis.chrome = chromeMock({
    attach: async () => {},
    restoreSession: async () => { throw new Error("session storage unavailable"); },
  });
  const storageFailure = await import(`../extension/ops.js?restore-storage-failure=${Date.now()}`);
  await assert.rejects(
    storageFailure.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /restore browser ownership/.test(error.message),
  );

  let stored = { ghostTabs: null };
  let failLookup = false;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: async (value) => { stored = structuredClone(value); },
    restoreSession: async () => structuredClone(stored),
    tabGet: async (_id, tab) => {
      if (failLookup) throw new Error("tabs service unavailable");
      return tab;
    },
  });
  const writer = await import(`../extension/ops.js?restore-tab-writer=${Date.now()}`);
  await writer.runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);
  failLookup = true;
  const tabFailure = await import(`../extension/ops.js?restore-tab-failure=${Date.now()}`);
  await assert.rejects(
    tabFailure.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /verify restored tab 17/.test(error.message),
  );
});

test("a timed-out restored tab lookup releases ownership for a later retry", async () => {
  const firstLookup = deferred();
  let lookups = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    restoreSession: async () => ({
      ghostTabs: {
        version: 2,
        tabs: [17],
        sessions: [["restored", [17]]],
        retired: [],
      },
    }),
    tabGet: async () => {
      lookups += 1;
      if (lookups === 1) return firstLookup.promise;
      return { id: 17, windowId: 4, status: "complete" };
    },
  });
  const restoring = await import(`../extension/ops.js?restore-tab-timeout=${Date.now()}`);

  await assert.rejects(
    restoring.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /did not finish restoring tab 17/.test(error.message),
  );
  await restoring.restoreTabsFromSession();
  assert.equal(lookups, 2);
  firstLookup.resolve({ id: 17, windowId: 4, status: "complete" });
});

test("a partial session close keeps the refused live tab for retry", async () => {
  const removed = [];
  let refuseSecond = true;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: (id) => {
      if (id === 17 && refuseSecond) {
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
  assert.deepEqual(removed, [18], "a failed first tab must not suppress later cleanup attempts");

  const retried = await runOp("close", { session: "s1" }, 1_000);
  assert.equal(retried.closed, true);
  assert.deepEqual(removed, [18, 17]);
});

test("retirement advances past never-settling create, update, and remove calls", async () => {
  const creating = deferred();
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabCreate: () => creating.promise,
  });
  const createOps = await import(`../extension/ops.js?never-create=${Date.now()}`);
  await assert.rejects(
    createOps.runOp("open", { session: "never-create", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "timeout",
  );
  assert.deepEqual(
    await createOps.runOp("close", { session: "never-create" }, 1_000),
    { closed: false },
  );

  const updating = deferred();
  const removedAfterUpdate = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: async (id) => { removedAfterUpdate.push(id); },
    tabUpdate: () => updating.promise,
  });
  const updateOps = await import(`../extension/ops.js?never-update=${Date.now()}`);
  await updateOps.runOp("open", { session: "never-update", url: "https://first.example/" }, 1_000);
  await assert.rejects(
    updateOps.runOp("open", {
      session: "never-update",
      tab: "17",
      url: "https://second.example/",
    }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "timeout",
  );
  assert.equal((await updateOps.runOp("close", { session: "never-update" }, 1_000)).closed, true);
  assert.deepEqual(removedAfterUpdate, [17]);

  const removing = deferred();
  let removeAttempts = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: async () => {
      removeAttempts += 1;
      if (removeAttempts === 1) await removing.promise;
    },
  });
  const removeOps = await import(`../extension/ops.js?never-remove=${Date.now()}`);
  await removeOps.runOp("open", { session: "never-remove", url: "https://example.com/" }, 1_000);
  await assert.rejects(
    removeOps.runOp("close", { session: "never-remove" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "browser_unavailable",
  );
  assert.equal((await removeOps.runOp("close", { session: "never-remove" }, 1_000)).closed, true);
  assert.equal(removeAttempts, 2);
  removing.resolve();
});

test("a failed late-create removal is swept after the daemon has rotated sessions", async () => {
  const created = deferred();
  let storedSession = { ghostTabs: null };
  let removeAttempts = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: async (value) => { storedSession = structuredClone(value); },
    restoreSession: async () => structuredClone(storedSession),
    tabCreate: async ({ url }, tabs) => {
      await created.promise;
      const tab = { id: 17, windowId: 4, status: "complete", url, title: "Late" };
      tabs.set(tab.id, tab);
      return tab;
    },
    tabRemove: async () => {
      removeAttempts += 1;
      if (removeAttempts === 1) throw new Error("Chromium refused the autonomous close");
    },
  });
  const late = await import(`../extension/ops.js?late-sweeper=${Date.now()}`);
  const opening = late.startOp(
    "open",
    { session: "rotated-away", url: "https://example.com/" },
    1_000,
  );
  await assert.rejects(
    opening.response,
    (error) => error instanceof RelayOpError && error.failure === "timeout",
  );

  assert.deepEqual(await late.runOp("close", { session: "rotated-away" }, 1_000), {
    closed: false,
  });
  assert.deepEqual(storedSession.ghostTabs.retired, ["rotated-away"]);

  created.resolve();
  for (let attempt = 0; attempt < 40
    && (removeAttempts < 2 || storedSession.ghostTabs.retired.length > 0); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(removeAttempts, 2);
  assert.deepEqual(storedSession, {
    ghostTabs: { version: 2, tabs: [], sessions: [], retired: [] },
  });
});

test("restore merge-gates an older snapshot behind a newer uncertain live claim", async () => {
  let allowPersistence = false;
  let allowRemoval = false;
  let storedSession = {
    ghostTabs: {
      version: 2,
      tabs: [99],
      sessions: [["older", [99]]],
      retired: [],
    },
  };
  let storedLocal = { ghostOwnershipPoison: null };
  let restoreReads = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { storedLocal = structuredClone(value); },
    persistSession: async (value) => {
      if (!allowPersistence) throw new Error("session storage unavailable");
      storedSession = structuredClone(value);
    },
    removeLocal: async () => { storedLocal = { ghostOwnershipPoison: null }; },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => {
      restoreReads += 1;
      return structuredClone(storedSession);
    },
    tabRemove: async () => {
      if (!allowRemoval) throw new Error("Chromium refused the rollback");
    },
  });
  const merging = await import(`../extension/ops.js?restore-merge=${Date.now()}`);
  await assert.rejects(
    merging.runOp("open", { session: "newer", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError && /across a worker restart/.test(error.message),
  );
  assert.notEqual(storedLocal.ghostOwnershipPoison, null);

  allowPersistence = true;
  await merging.restoreTabsFromSession();
  assert.equal(restoreReads, 0, "live generation must win before the old snapshot is read");
  assert.deepEqual(storedSession, {
    ghostTabs: { version: 2, tabs: [17], sessions: [["newer", [17]]], retired: [] },
  });
  assert.deepEqual(storedLocal, { ghostOwnershipPoison: null });

  allowRemoval = true;
  assert.equal((await merging.runOp("close", { session: "newer" }, 1_000)).closed, true);
});

test("retired UUID persistence is garbage-collected after all create leases settle", async () => {
  const retired = Array.from({ length: 2_048 }, (_, index) => `retired-${index}`);
  let storedSession = { ghostTabs: null };
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: async (value) => { storedSession = structuredClone(value); },
    restoreSession: async () => ({
      ghostTabs: { version: 2, tabs: [], sessions: [], retired },
    }),
  });
  const gc = await import(`../extension/ops.js?retired-gc=${Date.now()}`);
  await gc.restoreTabsFromSession();
  await gc.sweepRetiredTabs();
  assert.deepEqual(storedSession, {
    ghostTabs: { version: 2, tabs: [], sessions: [], retired: [] },
  });
  await assert.rejects(
    gc.runOp("open", { session: "retired-2047", url: "https://late.example/" }, 1_000),
    (error) => error instanceof RelayOpError && /session is closed/.test(error.message),
  );
  assert.equal(
    (await gc.runOp("open", { session: "retired-0", url: "https://reused.example/" }, 1_000)).id,
    "17",
    "only the bounded recent-retirement window remains after durable GC",
  );
  await gc.runOp("close", { session: "retired-0" }, 1_000);
});

test("an indeterminate remove failure retains the tab for close retry", async () => {
  const removed = [];
  let removeAttempts = 0;
  let verificationFailure = false;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabGet: async (_id, tab) => {
      if (verificationFailure) {
        verificationFailure = false;
        throw new Error("tabs service unavailable");
      }
      return tab;
    },
    tabRemove: async (id) => {
      removeAttempts += 1;
      if (removeAttempts === 1) {
        verificationFailure = true;
        throw new Error("Chromium refused the close");
      }
      removed.push(id);
    },
  });
  const { runOp } = await import(`../extension/ops.js?indeterminate-close=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  await assert.rejects(
    runOp("close", { session: "s1" }, 1_000),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /needs retry/.test(error.message)
      && /could not be verified/.test(error.details.tabs[0].message),
  );
  const retried = await runOp("close", { session: "s1" }, 1_000);
  assert.equal(retried.closed, true);
  assert.equal(removeAttempts, 2);
  assert.deepEqual(removed, [17]);
});

test("the exact no-such-tab result authoritatively completes a failed close", async () => {
  let removeAttempts = 0;
  let missing = false;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabGet: async (id, tab) => {
      if (missing) throw new Error(`No tab with id: ${id}.`);
      return tab;
    },
    tabRemove: async () => {
      removeAttempts += 1;
      missing = true;
      throw new Error("remove response was lost");
    },
  });
  const { runOp } = await import(`../extension/ops.js?authoritative-close=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://example.com/" }, 1_000);

  const closed = await runOp("close", { session: "s1" }, 1_000);
  assert.equal(closed.closed, false);
  assert.equal(removeAttempts, 1);
  const again = await runOp("close", { session: "s1" }, 1_000);
  assert.equal(again.closed, false);
  assert.equal(removeAttempts, 1);
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
