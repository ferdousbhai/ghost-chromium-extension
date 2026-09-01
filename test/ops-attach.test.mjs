import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { RelayOpError } from "../extension/protocol.js";

const originalChrome = globalThis.chrome;
const INCARNATION_A = "11111111-1111-4111-8111-111111111111";
const INCARNATION_B = "22222222-2222-4222-8222-222222222222";
const BROWSER_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function poisonPublication(claims, revision = 2, browserSession = BROWSER_SESSION) {
  return { version: 2, browserSession, revision, claims };
}

function incarnationPublication(incarnation, revision = 2) {
  return { version: 1, revision, incarnation };
}

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
    listenerCount() {
      return listeners.length;
    },
  };
}

function chromeMock({
  attach,
  detach = async () => {},
  getTargets,
  persistFence = async () => {},
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
        get: async (defaults) => ({ ...defaults, ...await restoreLocal(defaults) }),
        remove: removeLocal,
        set: (value) => Object.hasOwn(value, "ghostOwnershipFence")
          ? persistFence(value)
          : persistLocal(value),
      },
      session: {
        get: async (defaults) => ({ ...defaults, ...await restoreSession(defaults) }),
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

  // A navigation on one tab drops only that tab's world, so the other tab's
  // refs survive.
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

test("status is owner-scoped on the wire; only the popup view sees every tab", async () => {
  globalThis.chrome = chromeMock({ attach: async () => {} });
  const { runOp, allTabInfos } = await import(`../extension/ops.js?status-tabs=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("open", { session: "s2", url: "https://second.example/" }, 1_000);

  // A wire frame that names no session names no workspace: it sees nothing,
  // never the machine owner's all-tabs view.
  const anonymous = await runOp("status", {}, 1_000);
  assert.deepEqual(anonymous.tabs, []);

  // A ghost asking over the wire sees only the tabs its own session claimed.
  const one = await runOp("status", { session: "s2", tab: "18" }, 1_000);
  assert.equal(one.attached, false);
  assert.equal(one.banned, false);
  assert.deepEqual(one.tabs.map((tab) => [tab.title, tab.active]), [["Tab 18", true]]);

  // The popup's in-process view is the machine owner's: every ghost tab.
  const all = await allTabInfos();
  assert.deepEqual(all.map((tab) => tab.title), ["Tab 17", "Tab 18"]);
});

test("one ghost workspace cannot see or drive another ghost's tabs", async () => {
  const removed = [];
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabRemove: async (id) => removed.push(id),
  });
  const { runOp } = await import(`../extension/ops.js?ownership=${Date.now()}`);
  await runOp("open", { session: "s1", url: "https://first.example/" }, 1_000);
  await runOp("open", { session: "s2", url: "https://second.example/" }, 1_000);

  // One ghost must not learn another ghost's tab id from the list...
  const mine = await runOp("tabs", { session: "s1", op: "list", tab: "17" }, 1_000);
  assert.deepEqual(mine.tabs.map((tab) => tab.id), ["17"]);
  assert.equal(mine.active, "17");

  // ...nor act on it if it guesses one.
  for (const op of ["switch", "close"]) {
    await assert.rejects(
      runOp("tabs", { session: "s1", op, id: "18", tab: "17" }, 1_000),
      (error) => error instanceof RelayOpError
        && error.failure === "invalid_input"
        && /ghost browser workspace's tabs.*run tabs list/i.test(error.message),
    );
  }
  await assert.rejects(
    runOp("read", { session: "s1", tab: "18" }, 1_000),
    (error) => error instanceof RelayOpError && error.failure === "no_page",
  );
  assert.deepEqual(removed, []);
});

test("open closes the load-event gap with the tab's current status", async () => {
  let snapshotReads = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    tabCreate: async ({ url }, tabs) => {
      const loading = {
        id: 17,
        windowId: 4,
        url,
        title: "Fast page",
        status: "loading",
      };
      tabs.set(loading.id, loading);
      return loading;
    },
    tabGet: (id, stale) => {
      snapshotReads += 1;
      // This fires synchronously inside tabs.get. Reading before subscribing
      // would miss the edge, and the deliberately stale snapshot cannot help.
      if (snapshotReads === 1) {
        assert.ok(
          globalThis.chrome.tabs.onUpdated.listenerCount() > 0,
          "the complete listener must exist before tabs.get reads its snapshot",
        );
        globalThis.chrome.tabs.onUpdated.emit(id, { status: "complete" });
      }
      return stale;
    },
  });
  const { runOp } = await import(`../extension/ops.js?load-event-gap=${Date.now()}`);

  const opened = await runOp(
    "open",
    { session: "fast-page", url: "https://fast.example/" },
    1_000,
  );

  assert.equal(opened.id, "17");
  assert.deepEqual(opened.page, { url: "https://fast.example/", title: "Fast page" });
  assert.ok(snapshotReads >= 1);
});

test("protocol-4 tab creation refuses a missing workspace owner with recovery", async () => {
  globalThis.chrome = chromeMock({ attach: async () => {} });
  const { runOp } = await import(`../extension/ops.js?missing-owner=${Date.now()}`);

  for (const [op, args] of [
    ["open", { url: "https://example.com/" }],
    ["tabs", { op: "create", url: "https://example.com/" }],
  ]) {
    await assert.rejects(
      runOp(op, args, 1_000),
      (error) => error instanceof RelayOpError
        && error.failure === "invalid_input"
        && /missing its ghost browser workspace owner.*update Ghost.*reload/i.test(error.message),
    );
  }
  assert.deepEqual((await runOp("status", {}, 1_000)).tabs, []);
});

test("releasing a ghost workspace sweeps every tab it opened, not just the last one", async () => {
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

test("workspace release sweeps older tabs after the current tab is gone", async () => {
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

test("a burst of owner-closed tabs coalesces slow ownership publication", async () => {
  const firstBurstWrite = deferred();
  let burstWrites = null;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistSession: async () => {
      if (burstWrites === null) return;
      burstWrites += 1;
      if (burstWrites === 1) await firstBurstWrite.promise;
    },
  });
  const ops = await import(`../extension/ops.js?tab-close-coalescing=${Date.now()}`);
  ops.installOpsListeners();
  await ops.runOp("open", { session: "burst", url: "https://first.example/" }, 1_000);
  await ops.runOp("tabs", {
    session: "burst",
    op: "create",
    url: "https://second.example/",
  }, 1_000);
  await ops.runOp("tabs", {
    session: "burst",
    op: "create",
    url: "https://third.example/",
  }, 1_000);
  burstWrites = 0;

  globalThis.chrome.tabs.onRemoved.emit(17);
  await new Promise((resolve) => setImmediate(resolve));
  globalThis.chrome.tabs.onRemoved.emit(18);
  globalThis.chrome.tabs.onRemoved.emit(19);
  firstBurstWrite.resolve();
  for (let attempt = 0; attempt < 20 && burstWrites < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(burstWrites, 2, "one follow-up snapshot covers every close during the slow write");
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
  assert.deepEqual(stored.ghostTabs, {
    version: 2,
    tabs: [17],
    sessions: [["durable", [17]]],
    retired: [],
  });

  const restarted = await import(`../extension/ops.js?restore-owner=${Date.now()}`);
  await restarted.restoreTabsFromSession();
  const closed = await restarted.runOp("close", { session: "durable" }, 1_000);
  assert.equal(closed.closed, true);
  assert.deepEqual(removed, [17]);
});

test("a Chromium restart never adopts a reused tab id from the prior browser session", async () => {
  const oldSnapshot = {
    version: 2,
    tabs: [17],
    sessions: [["old-browser", [17]]],
    retired: [],
  };
  const storedLocal = {
    ghostOwnershipPoison: poisonPublication([["old-browser", 17]], 8),
    ghostOwnershipFence: {
      version: 2,
      browserSession: BROWSER_SESSION,
      revision: 9,
      snapshot: oldSnapshot,
    },
  };
  const storedSession = {
    ghostTabs: null,
    ghostTabsRevision: null,
    ghostBrowserSession: null,
  };
  let tabReads = 0;
  globalThis.chrome = chromeMock({
    persistFence: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => { Object.assign(storedSession, structuredClone(value)); },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabGet: async () => {
      tabReads += 1;
      return { id: 17, windowId: 8, status: "complete", active: true };
    },
  });
  const restarted = await import(`../extension/ops.js?browser-session-restart=${Date.now()}`);

  await restarted.restoreTabsFromSession();
  assert.equal(tabReads, 0, "the unrelated reused id is never queried or admitted");
  assert.notEqual(storedSession.ghostBrowserSession, BROWSER_SESSION);
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
  assert.deepEqual((await restarted.runOp("status", {}, 1_000)).tabs, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, []);
});

test("a partial fresh-browser poison reset is completed before ownership is published", async () => {
  const partialBrowser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const storedLocal = {
    ghostOwnershipPoison: poisonPublication([], 10, partialBrowser),
    ghostOwnershipPoisonBackup: poisonPublication([["old-browser", 17]], 8),
  };
  const storedSession = {
    ghostTabs: null,
    ghostTabsRevision: null,
    ghostBrowserSession: null,
  };
  let tabReads = 0;
  globalThis.chrome = chromeMock({
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => { Object.assign(storedSession, structuredClone(value)); },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabGet: async () => {
      tabReads += 1;
      return { id: 17, windowId: 8, status: "complete", active: true };
    },
  });
  const restarted = await import(`../extension/ops.js?partial-browser-reset=${Date.now()}`);

  await restarted.restoreTabsFromSession();
  assert.equal(tabReads, 0);
  assert.notEqual(storedSession.ghostBrowserSession, partialBrowser);
  assert.equal(
    storedLocal.ghostOwnershipPoison.browserSession,
    storedSession.ghostBrowserSession,
  );
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup, storedLocal.ghostOwnershipPoison);
});

test("fresh Chromium withholds its browser identity until both poison slots clear", async () => {
  const storedLocal = {
    ghostOwnershipPoison: poisonPublication([["old-browser", 17]], 8),
  };
  let sessionWrites = 0;
  globalThis.chrome = chromeMock({
    persistLocal: async (value) => {
      if (Object.hasOwn(value, "ghostOwnershipPoisonBackup")) {
        throw new Error("backup poison slot unavailable");
      }
      Object.assign(storedLocal, structuredClone(value));
    },
    persistSession: async () => { sessionWrites += 1; },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => ({
      ghostTabs: null,
      ghostTabsRevision: null,
      ghostBrowserSession: null,
    }),
  });
  const resetting = await import(`../extension/ops.js?browser-reset-barrier=${Date.now()}`);

  await assert.rejects(
    resetting.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /backup poison slot unavailable/i.test(error.message),
  );
  assert.equal(sessionWrites, 0);
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
});

test("a new daemon tombstones a pending old-daemon create before admitting work", async () => {
  const created = deferred();
  const removed = [];
  let storedSession = { ghostTabs: null };
  const storedLocal = {
    ghostOwnershipPoison: null,
    ghostDaemonIncarnation: incarnationPublication(INCARNATION_A),
  };
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => { storedSession = structuredClone(value); },
    restoreLocal: async (defaults) => Object.hasOwn(defaults, "ghostDaemonIncarnation")
      ? { ghostDaemonIncarnation: storedLocal.ghostDaemonIncarnation }
      : { ghostOwnershipPoison: storedLocal.ghostOwnershipPoison },
    tabCreate: async ({ url }, tabs) => {
      await created.promise;
      const tab = { id: 17, windowId: 4, status: "complete", url, title: "Late tab" };
      tabs.set(tab.id, tab);
      return tab;
    },
    tabRemove: async (id) => { removed.push(id); },
  });
  const ops = await import(`../extension/ops.js?incarnation-create-lease=${Date.now()}`);

  const opening = ops.runOp(
    "open",
    { session: "crashed-owner", url: "https://late.example/" },
    5_000,
  );
  await new Promise((resolve) => setImmediate(resolve));

  await ops.reconcileDaemonIncarnation(INCARNATION_B);
  assert.equal(storedLocal.ghostDaemonIncarnation.incarnation, INCARNATION_B);
  assert.equal(storedLocal.ghostDaemonIncarnationBackup.incarnation, INCARNATION_B);
  assert.deepEqual(storedSession.ghostTabs.retired, ["crashed-owner"]);

  created.resolve();
  await assert.rejects(
    opening,
    (error) => error instanceof RelayOpError
      && /workspace has been released.*retry.*fresh workspace/i.test(error.message),
  );
  for (let attempt = 0;
    attempt < 20 && storedSession.ghostTabs.retired.length > 0;
    attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(removed, [17]);
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
});

test("incarnation retry republishes an in-memory create tombstone before worker restart", async () => {
  const created = deferred();
  const removed = [];
  let writes = 0;
  let storedSession = { ghostTabs: null };
  const storedLocal = {
    ghostOwnershipPoison: null,
    ghostDaemonIncarnation: incarnationPublication(INCARNATION_A),
  };
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => {
      writes += 1;
      if (writes === 1) throw new Error("session storage unavailable");
      storedSession = structuredClone(value);
    },
    restoreLocal: async (defaults) => Object.hasOwn(defaults, "ghostDaemonIncarnation")
      ? {
        ghostDaemonIncarnation: storedLocal.ghostDaemonIncarnation,
        ghostDaemonIncarnationBackup: storedLocal.ghostDaemonIncarnationBackup,
      }
      : { ghostOwnershipPoison: storedLocal.ghostOwnershipPoison },
    restoreSession: async () => structuredClone(storedSession),
    tabCreate: async ({ url }, tabs) => {
      await created.promise;
      const tab = { id: 17, windowId: 4, status: "complete", url, title: "Late tab" };
      tabs.set(tab.id, tab);
      return tab;
    },
    tabRemove: async (id) => { removed.push(id); },
  });
  const first = await import(`../extension/ops.js?incarnation-republish=${Date.now()}`);
  const opening = first.runOp(
    "open",
    { session: "crashed-owner", url: "https://late.example/" },
    5_000,
  );
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    first.reconcileDaemonIncarnation(INCARNATION_B),
    (error) => error instanceof RelayOpError
      && /previous ghostd.*session storage unavailable.*retry automatically/i.test(error.message),
  );
  assert.equal(storedSession.ghostTabs, null);

  await first.reconcileDaemonIncarnation(INCARNATION_B);
  assert.equal(writes, 2, "the retry republishes an already-present in-memory tombstone");
  assert.deepEqual(storedSession.ghostTabs.retired, ["crashed-owner"]);
  assert.equal(storedLocal.ghostDaemonIncarnation.incarnation, INCARNATION_B);

  const restarted = await import(`../extension/ops.js?incarnation-republish-restart=${Date.now()}`);
  await restarted.restoreTabsFromSession();
  await assert.rejects(
    restarted.runOp("open", { session: "crashed-owner", url: "https://other.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /workspace has been released.*retry.*fresh workspace/i.test(error.message),
  );

  created.resolve();
  await assert.rejects(
    opening,
    (error) => error instanceof RelayOpError
      && /workspace has been released.*retry.*fresh workspace/i.test(error.message),
  );
  for (let attempt = 0; attempt < 20 && removed.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(removed, [17]);
});

test("a fresh worker ignores an older incarnation slot that settled late", async () => {
  const storedLocal = {
    ghostOwnershipPoison: null,
    ghostDaemonIncarnation: incarnationPublication(INCARNATION_A, 4),
    ghostDaemonIncarnationBackup: incarnationPublication(INCARNATION_B, 4),
  };
  let writes = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => {
      writes += 1;
      Object.assign(storedLocal, structuredClone(value));
    },
    restoreLocal: async (defaults) => Object.hasOwn(defaults, "ghostDaemonIncarnation")
      ? {
        ghostDaemonIncarnation: storedLocal.ghostDaemonIncarnation,
        ghostDaemonIncarnationBackup: storedLocal.ghostDaemonIncarnationBackup,
      }
      : { ghostOwnershipPoison: storedLocal.ghostOwnershipPoison },
  });
  const ops = await import(`../extension/ops.js?incarnation-write-order=${Date.now()}`);

  await ops.reconcileDaemonIncarnation(INCARNATION_B);
  assert.equal(writes, 0, "the higher acknowledged slot remains authoritative after restart");
  assert.equal(storedLocal.ghostDaemonIncarnation.incarnation, INCARNATION_A);
  assert.equal(storedLocal.ghostDaemonIncarnationBackup.incarnation, INCARNATION_B);
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
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
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
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, []);

  await assert.rejects(
    writer.runOp("open", { session: "timed-write", url: "https://late.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /workspace has been released.*retry.*fresh workspace/i.test(error.message),
  );
  const restarted = await import(`../extension/ops.js?write-timeout-restart=${Date.now()}`);
  await restarted.restoreTabsFromSession();
});

test("a failed late ownership repair stays fenced across a fresh worker module", async () => {
  const staleWrite = deferred();
  let storedSession = { ghostTabs: null, ghostTabsRevision: null };
  const storedLocal = {
    ghostOwnershipPoison: null,
    ghostOwnershipFence: null,
  };
  let writes = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistFence: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => {
      writes += 1;
      if (writes === 2) await staleWrite.promise;
      if (writes === 4) throw new Error("repair storage unavailable");
      storedSession = structuredClone(value);
    },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
  });
  const ops = await import(`../extension/ops.js?ownership-repair-retry=${Date.now()}`);
  await ops.runOp("open", { session: "stale-owner", url: "https://example.com/" }, 1_000);

  await assert.rejects(
    ops.runOp("close", { session: "stale-owner" }, 2_000),
    (error) => error instanceof RelayOpError && /workspace release needs retry/i.test(error.message),
  );
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: ["stale-owner"],
  });

  staleWrite.resolve();
  for (let attempt = 0; attempt < 30 && writes < 4; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(writes, 4, "the immediate newest-snapshot repair was attempted once");
  assert.deepEqual(storedSession.ghostTabs.tabs, [17], "the late stale write won temporarily");
  assert.ok(
    storedLocal.ghostOwnershipFence.revision > storedSession.ghostTabsRevision,
    "the durable fence remains newer than the stale session snapshot",
  );
  const activeBrowserSession = storedSession.ghostBrowserSession;
  await assert.rejects(
    ops.runOp("open", { session: "other-owner", url: "https://other.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /ownership recovery is not durable yet.*automatic repair/i.test(error.message),
  );

  const restarted = await import(`../extension/ops.js?ownership-fence-restart=${Date.now()}`);
  await restarted.restoreTabsFromSession();
  assert.equal(storedSession.ghostBrowserSession, activeBrowserSession);
  assert.equal(writes, 5, "a fresh worker republishes the newer durable fence");
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: ["stale-owner"],
  });
});

test("a fresh worker keeps newer poison when an older empty slot settled late", async () => {
  const storedSession = {
    ghostTabs: null,
    ghostTabsRevision: null,
    ghostBrowserSession: BROWSER_SESSION,
  };
  const storedLocal = {
    ghostOwnershipPoison: poisonPublication([], 4),
    ghostOwnershipPoisonBackup: poisonPublication([["uncertain", 17]], 4),
  };
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabGet: async () => { throw new Error("tab status indeterminate"); },
  });
  const restarted = await import(`../extension/ops.js?poison-late-empty=${Date.now()}`);

  await assert.rejects(
    restarted.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && /ownership of tab 17 is indeterminate.*tab status indeterminate/i.test(error.message),
  );
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, [["uncertain", 17]]);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, [["uncertain", 17]]);
  await assert.rejects(
    restarted.runOp("open", { session: "fresh", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError && /ownership of tab 17 is indeterminate/i.test(error.message),
  );
});

test("poison-only live ownership is reverified and promoted on a repeated restore", async () => {
  const storedSession = {
    ghostTabs: null,
    ghostTabsRevision: null,
    ghostBrowserSession: BROWSER_SESSION,
  };
  const storedLocal = {
    ghostOwnershipPoison: poisonPublication([["poison-owner", 17]]),
    ghostOwnershipFence: null,
  };
  let tabReads = 0;
  globalThis.chrome = chromeMock({
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => { Object.assign(storedSession, structuredClone(value)); },
    removeLocal: async () => { storedLocal.ghostOwnershipPoison = null; },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabGet: async () => {
      tabReads += 1;
      if (tabReads === 1) throw new Error("tab status temporarily unavailable");
      return { id: 17, windowId: 4, status: "complete", active: false };
    },
  });
  const ops = await import(`../extension/ops.js?poison-repeat=${Date.now()}`);

  await assert.rejects(
    ops.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && /ownership of tab 17 is indeterminate.*temporarily unavailable/i.test(error.message),
  );
  assert.equal(storedSession.ghostTabs, null);
  assert.equal(storedSession.ghostTabsRevision, null);
  assert.notEqual(storedLocal.ghostOwnershipPoison, null);

  await ops.restoreTabsFromSession();
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [17],
    sessions: [["poison-owner", [17]]],
    retired: [],
  });
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
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
  let storedSession = { ghostTabs: null, ghostBrowserSession: BROWSER_SESSION };
  let storedLocal = { ghostOwnershipPoison: null };
  let persistenceAttempts = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
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
  await first.restoreTabsFromSession();

  await assert.rejects(
    first.runOp("open", { session: "poisoned", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /across a worker restart/.test(error.message),
  );
  assert.equal(persistenceAttempts, 2, "the uncertain live tab gets a second durable claim attempt");
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, [["poisoned", 17]]);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, [["poisoned", 17]]);

  const restarted = await import(`../extension/ops.js?poison-reader=${Date.now()}`);
  await assert.rejects(
    restarted.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /could not confirm restored browser ownership.*session storage unavailable/i.test(
        error.message,
      ),
  );
  await assert.rejects(
    restarted.runOp("open", { session: "fresh", url: "https://other.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /ownership of tab 17 is indeterminate/i.test(error.message)
      && /retry the ghost browser workspace close/i.test(error.message),
  );

  failPersistence = false;
  failRemoval = false;
  const recovered = await first.runOp("close", { session: "poisoned" }, 1_000);
  assert.equal(recovered.closed, true);
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, []);

  let cleared = false;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => {
      if (Object.values(value).some((entry) => entry?.claims?.length === 0)) cleared = true;
    },
    restoreLocal: async () => ({
      ghostOwnershipPoison: poisonPublication([["already-gone", 99]]),
    }),
    restoreSession: async () => ({ ghostBrowserSession: BROWSER_SESSION }),
  });
  const absent = await import(`../extension/ops.js?poison-absent=${Date.now()}`);
  await absent.restoreTabsFromSession();
  assert.equal(cleared, true, "an authoritative no-such-tab result clears the restart poison");
});

test("an onRemoved storage rejection stays pending for automatic recovery", async () => {
  let failPersistence = true;
  const storedSession = { ghostTabs: null, ghostBrowserSession: BROWSER_SESSION };
  const storedLocal = { ghostOwnershipPoison: null };
  let persistenceAttempts = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistFence: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
    persistSession: async (value) => {
      persistenceAttempts += 1;
      if (failPersistence) throw new Error("session storage unavailable");
      Object.assign(storedSession, structuredClone(value));
    },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabRemove: async () => { throw new Error("Chromium refused the rollback"); },
  });
  const ops = await import(`../extension/ops.js?removed-repair=${Date.now()}`);
  ops.installOpsListeners();

  await assert.rejects(
    ops.runOp("open", { session: "uncertain", url: "https://example.com/" }, 1_000),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /across a worker restart/i.test(error.message),
  );
  assert.equal(persistenceAttempts, 2);
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, [["uncertain", 17]]);

  globalThis.chrome.tabs.onRemoved.emit(17);
  for (let attempt = 0; attempt < 20 && persistenceAttempts < 4; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    persistenceAttempts,
    4,
    "the rejected drop publication immediately attempts and retains one repair",
  );
  await assert.rejects(
    ops.runOp("open", { session: "other", url: "https://other.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /ownership recovery is not durable yet.*automatic repair/i.test(error.message),
  );

  failPersistence = false;
  await ops.repairBrowserPersistence();
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, []);
});

test("concurrent failed claims publish every uncertain tab to the poison ledger", async () => {
  let nextId = 17;
  const storedLocal = { ghostOwnershipPoison: null };
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
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
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, [["one", 17], ["two", 18]]);
  assert.deepEqual(
    storedLocal.ghostOwnershipPoisonBackup.claims,
    [["one", 17], ["two", 18]],
  );
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
      && /verify restored browser tabs.*tabs service unavailable/i.test(error.message),
  );
});

test("restore rejects equal ownership revisions with different snapshots", async () => {
  const sessionSnapshot = {
    version: 2,
    tabs: [],
    sessions: [],
    retired: ["session-owner"],
  };
  const fenceSnapshot = {
    version: 2,
    tabs: [],
    sessions: [],
    retired: ["fence-owner"],
  };
  globalThis.chrome = chromeMock({
    restoreLocal: async () => ({
      ghostOwnershipPoison: null,
      ghostOwnershipFence: {
        version: 2,
        browserSession: BROWSER_SESSION,
        revision: 7,
        snapshot: fenceSnapshot,
      },
    }),
    restoreSession: async () => ({
      ghostTabs: sessionSnapshot,
      ghostTabsRevision: 7,
      ghostBrowserSession: BROWSER_SESSION,
    }),
  });
  const restoring = await import(`../extension/ops.js?restore-fence-conflict=${Date.now()}`);

  await assert.rejects(
    restoring.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /ownership or its durability fence is invalid/i.test(error.message),
  );
});

test("ownership recovery accepts the exact tab cap with bounded lookup concurrency", async () => {
  const tabs = Array.from({ length: 1_024 }, (_, index) => index);
  const owner = "x".repeat(128);
  let active = 0;
  let maximumActive = 0;
  let reads = 0;
  globalThis.chrome = chromeMock({
    restoreLocal: async () => ({
      ghostOwnershipPoison: poisonPublication(tabs.map((tab) => [owner, tab])),
    }),
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs,
        sessions: [[owner, tabs]],
        retired: [],
      },
    }),
    tabGet: async (id) => {
      reads += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      throw new Error(`No tab with id: ${id}.`);
    },
  });
  const restoring = await import(`../extension/ops.js?restore-exact-cap=${Date.now()}`);

  await restoring.restoreTabsFromSession();
  assert.equal(reads, 1_024);
  assert.ok(maximumActive <= 16, `expected no more than 16 lookups, observed ${maximumActive}`);
});

test("ownership and poison ledgers share their tab and owner caps", async () => {
  const savedTabs = Array.from({ length: 512 }, (_, index) => index);
  const poisonTabs = Array.from({ length: 512 }, (_, index) => index + 512);
  let tabReads = 0;
  globalThis.chrome = chromeMock({
    restoreLocal: async () => ({
      ghostOwnershipPoison: poisonPublication(
        poisonTabs.map((tab) => [`poison-${tab}`, tab]),
      ),
    }),
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs: savedTabs,
        sessions: savedTabs.map((tab) => [`saved-${tab}`, [tab]]),
        retired: [],
      },
    }),
    tabGet: async (id) => {
      tabReads += 1;
      throw new Error(`No tab with id: ${id}.`);
    },
  });
  const exact = await import(`../extension/ops.js?restore-combined-exact-cap=${Date.now()}`);
  await exact.restoreTabsFromSession();
  assert.equal(tabReads, 1_024, "the exact combined cap remains admissible");

  tabReads = 0;
  const overPoisonTabs = Array.from({ length: 513 }, (_, index) => index + 512);
  globalThis.chrome = chromeMock({
    restoreLocal: async () => ({
      ghostOwnershipPoison: poisonPublication(
        overPoisonTabs.map((tab) => [`poison-${tab}`, tab]),
      ),
    }),
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs: savedTabs,
        sessions: savedTabs.map((tab) => [`saved-${tab}`, [tab]]),
        retired: [],
      },
    }),
    tabGet: async () => { tabReads += 1; },
  });
  const overTabs = await import(`../extension/ops.js?restore-combined-tab-over-cap=${Date.now()}`);
  await assert.rejects(
    overTabs.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /combined limits/i.test(error.message),
  );
  assert.equal(tabReads, 0, "a combined tab overflow is rejected before Chromium I/O");

  tabReads = 0;
  const exactTabs = Array.from({ length: 1_024 }, (_, index) => index);
  globalThis.chrome = chromeMock({
    restoreLocal: async () => ({
      ghostOwnershipPoison: poisonPublication([["extra-owner", 0]]),
    }),
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs: exactTabs,
        sessions: exactTabs.map((tab) => [`saved-${tab}`, [tab]]),
        retired: [],
      },
    }),
    tabGet: async () => { tabReads += 1; },
  });
  const overOwners = await import(
    `../extension/ops.js?restore-combined-owner-over-cap=${Date.now()}`
  );
  await assert.rejects(
    overOwners.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /combined limits/i.test(error.message),
  );
  assert.equal(tabReads, 0, "a combined owner overflow is rejected before Chromium I/O");
});

test("a quota-sized hung restore stops after one bounded lookup batch", async () => {
  const tabs = Array.from({ length: 1_024 }, (_, index) => index);
  const never = deferred();
  let reads = 0;
  globalThis.chrome = chromeMock({
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs,
        sessions: [["bounded-owner", tabs]],
        retired: [],
      },
    }),
    tabGet: async () => {
      reads += 1;
      return never.promise;
    },
  });
  const restoring = await import(`../extension/ops.js?restore-hung-cap=${Date.now()}`);
  const started = Date.now();

  await assert.rejects(
    restoring.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /did not finish restoring/i.test(error.message),
  );
  assert.ok(Date.now() - started < 2_500, "the quota-sized restore has one aggregate deadline");
  assert.equal(reads, 16, "hung lookups never fan out beyond the bounded worker batch");
  never.resolve(null);
});

test("ownership and poison recovery reject over-cap rows and owner strings before tab I/O", async () => {
  const overCapTabs = Array.from({ length: 1_025 }, (_, index) => index);
  let tabReads = 0;
  globalThis.chrome = chromeMock({
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs: overCapTabs,
        sessions: [["owner", overCapTabs]],
        retired: [],
      },
    }),
    tabGet: async () => { tabReads += 1; },
  });
  const overRows = await import(`../extension/ops.js?restore-over-cap=${Date.now()}`);
  await assert.rejects(
    overRows.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /ownership.*invalid/i.test(error.message),
  );
  assert.equal(tabReads, 0);

  globalThis.chrome = chromeMock({
    restoreLocal: async () => ({
      ghostOwnershipPoison: poisonPublication(
        Array.from({ length: 1_025 }, (_, index) => ["owner", index]),
      ),
    }),
    restoreSession: async () => ({ ghostBrowserSession: BROWSER_SESSION }),
    tabGet: async () => { tabReads += 1; },
  });
  const overPoison = await import(`../extension/ops.js?poison-over-cap=${Date.now()}`);
  await assert.rejects(
    overPoison.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /ownership recovery is invalid/i.test(error.message),
  );
  assert.equal(tabReads, 0);

  const longOwner = "x".repeat(129);
  globalThis.chrome = chromeMock({
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: {
        version: 2,
        tabs: [17],
        sessions: [[longOwner, [17]]],
        retired: [],
      },
    }),
    tabGet: async () => { tabReads += 1; },
  });
  const overString = await import(`../extension/ops.js?owner-over-cap=${Date.now()}`);
  await assert.rejects(
    overString.restoreTabsFromSession(),
    (error) => error instanceof RelayOpError && /ownership.*invalid/i.test(error.message),
  );
  assert.equal(tabReads, 0);
});

test("a timed-out restored tab lookup releases ownership for a later retry", async () => {
  const firstLookup = deferred();
  let lookups = 0;
  globalThis.chrome = chromeMock({
    attach: async () => {},
    restoreSession: async () => ({
      ghostBrowserSession: BROWSER_SESSION,
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
      && /did not finish restoring browser ownership tab 17/i.test(error.message),
  );
  await restoring.restoreTabsFromSession();
  assert.equal(lookups, 2);
  firstLookup.resolve({ id: 17, windowId: 4, status: "complete" });
});

test("a partial workspace release keeps the refused live tab for retry", async () => {
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
    (error) => error instanceof RelayOpError
      && error.failure === "browser_unavailable"
      && /workspace release needs retry.*retry close/i.test(error.message),
  );
  assert.deepEqual(removed, [18], "a failed first tab must not suppress later cleanup attempts");

  const retried = await runOp("close", { session: "s1" }, 1_000);
  assert.equal(retried.closed, true);
  assert.deepEqual(removed, [18, 17]);
});

test("quota-sized incarnation retirement coalesces ownership publication", async () => {
  const tabs = Array.from({ length: 1_024 }, (_, index) => index);
  const owner = "quota-owner";
  const storedSession = {
    ghostTabs: {
      version: 2,
      tabs,
      sessions: [[owner, tabs]],
      retired: [],
    },
    ghostTabsRevision: 2,
    ghostBrowserSession: BROWSER_SESSION,
  };
  const storedLocal = {
    ghostOwnershipPoison: null,
    ghostDaemonIncarnation: incarnationPublication(INCARNATION_A),
    ghostDaemonIncarnationBackup: incarnationPublication(INCARNATION_A),
  };
  let sessionWrites = 0;
  let fenceWrites = 0;
  let activeRemovals = 0;
  let maximumRemovals = 0;
  let removals = 0;
  const slowWrite = () => new Promise((resolve) => setTimeout(resolve, 10));
  globalThis.chrome = chromeMock({
    attach: async () => {},
    persistFence: async (value) => {
      fenceWrites += 1;
      await slowWrite();
      Object.assign(storedLocal, structuredClone(value));
    },
    persistLocal: async (value) => {
      await slowWrite();
      Object.assign(storedLocal, structuredClone(value));
    },
    persistSession: async (value) => {
      sessionWrites += 1;
      await slowWrite();
      Object.assign(storedSession, structuredClone(value));
    },
    restoreLocal: async () => structuredClone(storedLocal),
    restoreSession: async () => structuredClone(storedSession),
    tabGet: async (id) => ({ id, windowId: 4, status: "complete" }),
    tabRemove: async (id) => {
      activeRemovals += 1;
      maximumRemovals = Math.max(maximumRemovals, activeRemovals);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeRemovals -= 1;
      removals += 1;
      globalThis.chrome.tabs.onRemoved.emit(id);
    },
  });
  const ops = await import(`../extension/ops.js?incarnation-quota-retirement=${Date.now()}`);
  ops.installOpsListeners();
  await ops.restoreTabsFromSession();
  sessionWrites = 0;
  fenceWrites = 0;
  const started = Date.now();

  await ops.reconcileDaemonIncarnation(INCARNATION_B);

  assert.equal(removals, 1_024);
  assert.ok(maximumRemovals <= 16, `expected at most 16 removals, observed ${maximumRemovals}`);
  assert.equal(sessionWrites, 2, "retirement writes one tombstone and one aggregate result");
  assert.equal(fenceWrites, 2, "each ownership publication writes one matching fence");
  assert.ok(Date.now() - started < 2_500, "slow storage is constant, not multiplied per tab");
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
  assert.equal(storedLocal.ghostDaemonIncarnation.incarnation, INCARNATION_B);
  assert.equal(storedLocal.ghostDaemonIncarnationBackup.incarnation, INCARNATION_B);
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
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
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
    persistLocal: async (value) => { Object.assign(storedLocal, structuredClone(value)); },
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
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [17],
    sessions: [["newer", [17]]],
    retired: [],
  });
  assert.deepEqual(storedLocal.ghostOwnershipPoison.claims, []);
  assert.deepEqual(storedLocal.ghostOwnershipPoisonBackup.claims, []);

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
      ghostBrowserSession: BROWSER_SESSION,
      ghostTabs: { version: 2, tabs: [], sessions: [], retired },
    }),
  });
  const gc = await import(`../extension/ops.js?retired-gc=${Date.now()}`);
  await gc.restoreTabsFromSession();
  await gc.sweepRetiredTabs();
  assert.deepEqual(storedSession.ghostTabs, {
    version: 2,
    tabs: [],
    sessions: [],
    retired: [],
  });
  await assert.rejects(
    gc.runOp("open", { session: "retired-2047", url: "https://late.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /workspace has been released.*retry.*fresh workspace/i.test(error.message),
  );
  assert.equal(
    (await gc.runOp("open", { session: "retired-0", url: "https://reused.example/" }, 1_000)).id,
    "17",
    "only the bounded recent-retirement window remains after durable GC",
  );
  await gc.runOp("close", { session: "retired-0" }, 1_000);
});

test("claimless close bursts cannot overflow the retired-owner ledger across restart", async () => {
  const retired = Array.from({ length: 2_048 }, (_, index) => `retired-${index}`);
  const storedSession = {
    ghostBrowserSession: BROWSER_SESSION,
    ghostTabs: { version: 2, tabs: [], sessions: [], retired },
  };
  let writes = 0;
  let largestPublication = 0;
  globalThis.chrome = chromeMock({
    persistSession: async (value) => {
      writes += 1;
      largestPublication = Math.max(
        largestPublication,
        value.ghostTabs?.retired?.length ?? 0,
      );
      Object.assign(storedSession, structuredClone(value));
    },
    restoreSession: async () => structuredClone(storedSession),
  });
  const first = await import(`../extension/ops.js?claimless-close-cap=${Date.now()}`);
  await first.restoreTabsFromSession();
  const restoreWrites = writes;

  await Promise.all(
    Array.from({ length: 2_049 }, (_, index) =>
      first.runOp("close", { session: `claimless-${index}` }, 1_000)),
  );

  assert.equal(writes, restoreWrites, "claimless closes do not publish retirement tombstones");
  assert.equal(largestPublication, 2_048);
  assert.equal(storedSession.ghostTabs.retired.length, 2_048);
  await assert.rejects(
    first.runOp("open", { session: "claimless-2048", url: "https://late.example/" }, 1_000),
    (error) => error instanceof RelayOpError
      && /workspace has been released.*retry.*fresh workspace/i.test(error.message),
  );

  const restarted = await import(`../extension/ops.js?claimless-close-restart=${Date.now()}`);
  await restarted.restoreTabsFromSession();
  assert.equal(storedSession.ghostTabs.retired.length, 2_048);
  assert.equal(largestPublication, 2_048, "a fresh worker never receives an oversized ledger");
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
      && /workspace release needs retry.*retry close/i.test(error.message)
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
