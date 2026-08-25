/**
 * The verbs, against real tabs in the owner's real browser.
 *
 * Three rules run through this file.
 *
 * **The ghost owns a set of tabs, and drives one at a time.** The one-tab
 * invariant is relaxed: `state.tabs` is the set of tab ids the ghost created, and
 * `state.activeTabId` is the one every page op acts on. Switching tabs just moves
 * `activeTabId`; the ghost never touches a tab the owner opened. `close` shuts
 * *all* of the ghost's tabs and detaches; the `tabs` op's `close` shuts one. Neither
 * closes the browser, which has the rest of the owner's day in it.
 *
 * **`chrome.debugger` is the only way in.** There is no `chrome.scripting`, no
 * content script, and no `host_permissions` in the manifest. The debugger grant
 * can enumerate target URL/title metadata, which we use only for ghost-owned tab
 * ids. Reading page content or acting on it requires an attached debugger session,
 * and Chrome puts its own un-suppressable "is being debugged" banner across the
 * top of that tab.
 *
 * **Input is real input.** Clicks, scrolls, drags, and keys go through
 * `Input.dispatch*` at hit-tested points, not `element.click()` and not
 * `element.value = x`. The one script-running op, `javascript`, runs in the page's
 * *main* world through `Runtime.evaluate` — that is the capability; the page and
 * the value it returns are untrusted data, and the tool description says so. Every
 * *other* page snippet (find/click/type/resolve, and the upload node lookup) runs
 * in a hardened isolated world the page cannot reach.
 *
 * The attach state machine (`attached` / `banned` / `attaching`, ban on any attach
 * failure, ban cleared by navigation) is ported from the MIT-licensed
 * `browser-relay` bridge in https://github.com/can1357/oh-my-pi.
 */
import { failed, FAILURES } from "./protocol.js";
import {
  callScript,
  DEFAULT_FIND_RESULTS,
  FIND_ELEMENTS_SCRIPT,
  FOCUS_AND_CLEAR_SCRIPT,
  MAX_FIND_RESULTS,
  READ_PAGE_SCRIPT,
  RESOLVE_NODE_SCRIPT,
  RESOLVE_SCRIPT,
  unsupportedFindSyntax,
} from "./page-scripts.js";

const CDP_VERSION = "1.3";
/** URLs `chrome.debugger` cannot attach to. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search|about):/i;
/** How long to watch for a click to turn into a navigation before calling it settled. */
const SETTLE_WATCH_MS = 900;
/** Chrome's own texture limits; a taller capture comes back blank or fails. */
const MAX_CAPTURE_PX = 16_384;
/** How many console / network entries a ring keeps before dropping the oldest. */
const RING_LIMIT = 200;

const state = {
  /** The chrome tab ids the ghost owns. Relaxed from the old one-tab invariant. */
  tabs: new Set(),
  /** The owned tab every page op acts on, or null when the ghost owns none. */
  activeTabId: null,
  attached: false,
  /** Set when attach failed or the owner dismissed the debugger banner. */
  banned: false,
  attaching: null,
  /**
   * The `executionContextId` of the per-frame isolated world every page snippet
   * runs in. Kept across ops so the ref table (which lives on that world's
   * global) survives from `find` to the `click`/`type` that uses its refs. Reset
   * to null whenever the world is gone: a navigation, a detach, a new active tab.
   */
  worldContextId: null,
  /** Whether Runtime/Network/DOM have been enabled on the current attachment. */
  domainsEnabled: false,
  /** Invalidates attach work captured before a release, reset, or tab switch. */
  attachGeneration: 0,
};

/** Console and network rings, tagged with the tab they came from, drained per op. */
const consoleRing = [];
const networkRing = [];
/** requestId → the ring entry, so a response can fill the request it answered. */
const netPending = new Map();
/** Captured-tab attach/cleanup work that a newer same-tab generation must await. */
const attachBarriers = new Map();

/** Where the ghost's tab ids survive a service-worker restart. */
const SESSION_KEY = "ghostTabs";

function persist() {
  void chrome.storage.session
    .set({ [SESSION_KEY]: { tabs: [...state.tabs], active: state.activeTabId } })
    .catch(() => {});
}

export async function restoreTabFromSession() {
  try {
    const stored = await chrome.storage.session.get({ [SESSION_KEY]: null });
    const saved = stored[SESSION_KEY];
    if (!saved || !Array.isArray(saved.tabs)) return;
    // Only adopt tabs that still exist. A worker restart plus a closed tab would
    // otherwise leave us driving a tab id Chrome has reused.
    for (const id of saved.tabs) {
      if (typeof id !== "number") continue;
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab) state.tabs.add(id);
    }
    if (state.tabs.has(saved.active)) state.activeTabId = saved.active;
    else state.activeTabId = state.tabs.values().next().value ?? null;
    persist();
  } catch {
    // Session storage is a convenience; a fresh `open` recovers either way.
  }
}

/** Reset the attach machinery for a new active tab; the old attachment is left be. */
function resetAttachment() {
  state.attachGeneration += 1;
  state.attached = false;
  state.banned = false;
  state.attaching = null;
  state.worldContextId = null;
  state.domainsEnabled = false;
}

/** Add a tab, make it active, and start fresh on the attach machinery. */
function rememberTab(tabId) {
  state.tabs.add(tabId);
  state.activeTabId = tabId;
  resetAttachment();
  persist();
}

/** Point the ghost at an already-owned tab. */
function setActive(tabId) {
  state.activeTabId = tabId;
  resetAttachment();
  persist();
}

/** Drop one tab from the owned set, choosing a new active if it was the active one. */
function dropTab(tabId) {
  const wasActive = tabId === state.activeTabId;
  state.tabs.delete(tabId);
  if (wasActive) {
    state.activeTabId = state.tabs.values().next().value ?? null;
    resetAttachment();
  }
  persist();
}

/** Forget every tab — used by the full-teardown `close` and lost-tab recovery. */
function forgetTab() {
  state.tabs.clear();
  state.activeTabId = null;
  resetAttachment();
  persist();
}

export function currentTabId() {
  return state.activeTabId;
}

export function isAttached() {
  return state.attached;
}

// ------------------------------------------------------------------- ring buffers

function pushRing(ring, entry) {
  ring.push(entry);
  if (ring.length > RING_LIMIT) {
    const dropped = ring.shift();
    if (dropped && dropped.__reqId !== undefined) netPending.delete(dropped.__reqId);
  }
}

function bufferConsole(tabId, params, isException) {
  let level = "log";
  let text = "";
  let url;
  let line;
  if (isException) {
    level = "error";
    const details = params?.exceptionDetails ?? {};
    text = details.exception?.description ?? details.text ?? "Uncaught exception";
    url = details.url || undefined;
    line = typeof details.lineNumber === "number" ? details.lineNumber : undefined;
  } else {
    level = typeof params?.type === "string" ? params.type : "log";
    text = (Array.isArray(params?.args) ? params.args : [])
      .map((arg) => {
        if (arg == null) return "";
        if (arg.value !== undefined) return String(arg.value);
        if (typeof arg.description === "string") return arg.description;
        if (typeof arg.unserializableValue === "string") return arg.unserializableValue;
        return arg.type ?? "";
      })
      .join(" ");
    const frame = params?.stackTrace?.callFrames?.[0];
    if (frame) {
      url = frame.url || undefined;
      line = typeof frame.lineNumber === "number" ? frame.lineNumber : undefined;
    }
  }
  pushRing(consoleRing, {
    tabId,
    level,
    text,
    ...(url ? { url } : {}),
    ...(line === undefined ? {} : { line }),
  });
}

function bufferRequest(tabId, params) {
  const entry = {
    tabId,
    __reqId: params?.requestId,
    method: params?.request?.method ?? "GET",
    url: params?.request?.url ?? "",
    ...(params?.type ? { type: params.type } : {}),
  };
  pushRing(networkRing, entry);
  if (params?.requestId !== undefined) netPending.set(params.requestId, entry);
}

function fillResponse(params) {
  const entry = netPending.get(params?.requestId);
  if (!entry) return;
  const response = params?.response ?? {};
  if (typeof response.status === "number") entry.status = response.status;
  if (!entry.type && params?.type) entry.type = params.type;
  if (typeof response.encodedDataLength === "number" && response.encodedDataLength > 0) {
    entry.bodyBytes = response.encodedDataLength;
  }
}

function fillFinished(params) {
  const entry = netPending.get(params?.requestId);
  if (entry && typeof params?.encodedDataLength === "number" && params.encodedDataLength > 0) {
    entry.bodyBytes = params.encodedDataLength;
  }
  netPending.delete(params?.requestId);
}

/** Drain a ring of the active tab's entries, stripping the internal bookkeeping. */
function drainRing(ring) {
  const active = state.activeTabId;
  const out = [];
  const keep = [];
  for (const entry of ring) {
    if (entry.tabId === active) {
      const { tabId, __reqId, ...rest } = entry;
      out.push(rest);
    } else {
      keep.push(entry);
    }
  }
  ring.length = 0;
  for (const entry of keep) ring.push(entry);
  return out;
}

// ------------------------------------------------------------------ listeners

/**
 * Wire the tab and debugger events. Called once from the service worker; every
 * handler is defensive because these fire for every tab in the browser, not ours.
 */
export function installOpsListeners(onNotice) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!state.tabs.has(tabId)) return;
    dropTab(tabId);
    onNotice?.("tab_closed", { tabId });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.activeTabId) return;
    // A navigation is the one thing that can un-wedge a banned tab: the owner
    // dismissed the debugger banner, the page moved on, and attaching is worth
    // trying again.
    // `changeInfo.url` is redacted without the named `tabs` permission. Loading
    // status is permission-free and is the navigation edge this state needs.
    if (changeInfo.status === "loading" && state.banned) state.banned = false;
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== state.activeTabId) return;
    resetAttachment();
    // Any detach is a ban until the tab navigates. Re-attaching immediately would
    // fight the owner for the banner they just dismissed.
    state.banned = true;
    onNotice?.("detached", { reason });
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!state.tabs.has(source.tabId)) return;
    // Console and network events are buffered for any owned tab, so a later
    // `console`/`network` op on the active tab has something to drain.
    if (method === "Runtime.consoleAPICalled") {
      bufferConsole(source.tabId, params, false);
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      bufferConsole(source.tabId, params, true);
      return;
    }
    if (method === "Network.requestWillBeSent") {
      bufferRequest(source.tabId, params);
      return;
    }
    if (method === "Network.responseReceived") {
      fillResponse(params);
      return;
    }
    if (method === "Network.loadingFinished") {
      fillFinished(params);
      return;
    }
    if (source.tabId !== state.activeTabId) return;
    if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
      // A main-frame navigation tears down our isolated world and every ref in
      // it. Drop the cached context id so the next evaluate builds a fresh one
      // (and a fresh, empty ref table) rather than talking to a dead context.
      state.worldContextId = null;
      return;
    }
    if (method !== "Page.javascriptDialogOpening") return;
    // With `Page.enable` on, Chrome hands dialogs to the debugger instead of the
    // owner, and an unanswered one wedges the renderer forever. Dismiss —
    // except `beforeunload`, where dismissing is what *blocks* the navigation.
    void chrome.debugger
      .sendCommand({ tabId: source.tabId }, "Page.handleJavaScriptDialog", {
        accept: params?.type === "beforeunload",
      })
      .catch(() => {});
  });
}

// ------------------------------------------------------------------- plumbing

function withTimeout(promise, timeoutMs, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(failed(FAILURES.timeout, `The browser did not finish ${what} in time.`)),
        timeoutMs,
      );
    }),
  ]);
}

function requireTab() {
  if (state.activeTabId === null) {
    throw failed(FAILURES.noPage, "No page is loaded. Use action \"open\" with a URL first.");
  }
  return state.activeTabId;
}

/**
 * `tabs.get()` itself needs no permission, but Chrome redacts URL/title unless an
 * extension also has `tabs`, a matching host grant, or a temporary activeTab
 * grant. The debugger permission we already need exposes that metadata through
 * `getTargets()`, without the separate standing `tabs` grant. Restrict the lookup
 * to a tab id already present in the ghost-owned set.
 */
async function tabSnapshot(tabId, targets = null) {
  if (!state.tabs.has(tabId)) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  const targetList = targets ?? await chrome.debugger.getTargets().catch(() => []);
  const target = targetList.find((entry) => entry.tabId === tabId);
  return {
    ...tab,
    url: target?.url ?? tab.url ?? "",
    title: target?.title ?? tab.title ?? "",
  };
}

/**
 * A debugger session can outlive the service-worker instance that opened it,
 * because Chrome tracks the attachment per-extension. After the worker is reaped
 * and respawned, `getTargets()` can still report our tab as `attached` while our
 * in-memory `state.attached` has been reset to false — and re-attaching over that
 * throws and bans the tab. Prove the surviving session is *ours* with one command
 * and adopt it; if another extension or DevTools holds it, fall through to a
 * normal attach (which fails loudly, as it should).
 */
async function adoptExistingAttachment(tabId) {
  let targets;
  try {
    targets = await chrome.debugger.getTargets();
  } catch {
    return false;
  }
  const target = targets.find((entry) => entry.tabId === tabId);
  if (target?.attached !== true) return false;
  try {
    // `sendCommand` succeeds only if this extension is the attached client, and
    // re-enabling Page is idempotent, so it doubles as re-arming dialog handling.
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Enable the CDP domains the extra capabilities need, once per attachment. Each is
 * best-effort: a page that refuses one domain should not sink an attach. `Page` is
 * dialog interception and stop-loading; `Runtime` feeds the console ring and the
 * isolated-world evaluate; `Network` feeds the network ring; `DOM` backs
 * `DOM.setFileInputFiles` for uploads.
 */
async function enableDomains(tabId) {
  if (state.domainsEnabled) return;
  state.domainsEnabled = true;
  await chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "Network.enable", {}).catch(() => {});
  await chrome.debugger.sendCommand({ tabId }, "DOM.enable", {}).catch(() => {});
}

function invalidatedAttach(tabId) {
  return failed(
    FAILURES.browserUnavailable,
    `The active ghost tab changed while Chromium was attaching to tab ${tabId}. Try the action again.`,
  );
}

function isCurrentAttach(attempt) {
  return state.attaching === attempt
    && state.attachGeneration === attempt.generation
    && state.activeTabId === attempt.tabId;
}

/** A stale successful attach owns removing exactly the captured tab's debugger. */
async function detachStale(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function ensureAttached() {
  const tabId = requireTab();
  if (state.attached) {
    await enableDomains(tabId);
    return tabId;
  }
  if (state.banned) {
    throw failed(
      FAILURES.browserUnavailable,
      "Chromium will not let the relay inspect this tab — the owner dismissed "
      + "the \"is being debugged\" banner, or DevTools is open on it. It will work "
      + "again after the tab navigates somewhere.",
    );
  }
  const tab = await tabSnapshot(tabId);
  if (!tab) {
    dropTab(tabId);
    throw failed(FAILURES.noPage, "The ghost's tab is gone. Open a page again.");
  }
  if (tab.url && INELIGIBLE_URL.test(tab.url)) {
    throw failed(
      FAILURES.blockedUrl,
      `Chromium does not allow automation of ${tab.url.split(":")[0]}: pages.`,
    );
  }
  if (!state.attaching) {
    const barrier = attachBarriers.get(tabId);
    if (barrier) {
      // A reset can make the current state forget an attempt before Chrome has
      // settled it. Never attach the same tab again until that attempt has either
      // failed or succeeded and detached itself, or its cleanup could detach this
      // newer generation by tab id.
      await barrier.catch(() => {});
      if (state.activeTabId !== tabId) throw invalidatedAttach(tabId);
      return ensureAttached();
    }
    const attempt = {
      tabId,
      generation: state.attachGeneration,
      promise: null,
    };
    attempt.promise = (async () => {
      // A `chrome.debugger` session is attached per-extension, not per-worker, so
      // it can outlive the service-worker instance that opened it. After a worker
      // restart `state.attached` is false but Chrome still lists us as attached;
      // a plain `attach()` would then throw "Another debugger is already attached"
      // and ban the tab forever. Adopt the surviving session instead.
      if (await adoptExistingAttachment(tabId)) {
        // The surviving session belongs to this extension, so stale cleanup owns
        // detaching it just as it would a session opened below.
      } else {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
      }
      if (!isCurrentAttach(attempt)) {
        await detachStale(tabId);
        throw invalidatedAttach(tabId);
      }
      state.attached = true;
      state.domainsEnabled = false;
      await enableDomains(tabId);
      if (!isCurrentAttach(attempt)) {
        await detachStale(tabId);
        throw invalidatedAttach(tabId);
      }
    })().catch((error) => {
      if (!isCurrentAttach(attempt)) {
        if (error?.failure === FAILURES.browserUnavailable) throw error;
        throw invalidatedAttach(tabId);
      }
      state.attached = false;
      state.worldContextId = null;
      state.domainsEnabled = false;
      // Any attach failure bans the tab rather than looping: the causes (DevTools,
      // another extension's debugger, a policy-blocked page) do not fix themselves
      // between two retries, and each retry costs the owner a banner flash. The
      // normalization lives on the shared promise so its owner and every concurrent
      // waiter receive the same typed failure.
      state.banned = true;
      if (error?.failure === FAILURES.browserUnavailable) throw error;
      throw failed(
        FAILURES.browserUnavailable,
        `Chromium refused to attach its debugger to the ghost's tab: ${error?.message ?? error}. `
        + "Close DevTools on that tab, or any other extension driving it, and try again.",
      );
    });
    attempt.promise = attempt.promise.finally(() => {
      if (attachBarriers.get(tabId) === attempt.promise) attachBarriers.delete(tabId);
    });
    attachBarriers.set(tabId, attempt.promise);
    state.attaching = attempt;
  }
  const attempt = state.attaching;
  try {
    await attempt.promise;
    if (!isCurrentAttach(attempt)) throw invalidatedAttach(attempt.tabId);
  } finally {
    if (state.attaching === attempt) state.attaching = null;
  }
  return tabId;
}

function cdp(method, params) {
  return chrome.debugger.sendCommand({ tabId: requireTab() }, method, params ?? {});
}

/**
 * Get — creating once, then reusing — the isolated world our snippets run in.
 * `Page.createIsolatedWorld` hands back an `executionContextId` for a realm that
 * shares the tab's DOM but has its own globals and its own native copies of the
 * DOM APIs, so a hostile page cannot override `querySelectorAll`/`elementFromPoint`
 * to spoof the hit-test, and the ref table on its global is out of the page's
 * reach. The same context is reused across ops so refs survive `find` → `click`.
 */
async function ensureIsolatedWorld() {
  if (state.worldContextId !== null) return state.worldContextId;
  const tree = await cdp("Page.getFrameTree");
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== "string") {
    throw failed(FAILURES.navigationFailed, "The page has no main frame to inspect.");
  }
  const world = await cdp("Page.createIsolatedWorld", { frameId, worldName: "ghost-relay" });
  const contextId = world?.executionContextId;
  if (typeof contextId !== "number") {
    throw failed(FAILURES.navigationFailed, "Chromium would not open an isolated world to inspect the page.");
  }
  state.worldContextId = contextId;
  return contextId;
}

/** Does this rejection mean the isolated world is gone (navigation between ops)? */
function isStaleWorld(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("context")
    && (message.includes("cannot find") || message.includes("not found")
      || message.includes("destroyed") || message.includes("no longer"));
}

async function evaluate(script, arg, timeoutMs, what, allowRebuild = true) {
  const contextId = await ensureIsolatedWorld();
  let response;
  try {
    response = await withTimeout(
      cdp("Runtime.evaluate", {
        expression: callScript(script, arg),
        returnByValue: true,
        awaitPromise: true,
        // Pin the evaluation to our isolated world — never the page's main world.
        contextId,
      }),
      timeoutMs,
      what,
    );
  } catch (error) {
    // A navigation can destroy the world between the `find` and this op; the
    // frameNavigated hook usually clears it first, but if we raced it, rebuild
    // the world once and retry so the ghost meets a fresh page, not an error.
    if (isStaleWorld(error)) {
      if (state.worldContextId === contextId) state.worldContextId = null;
      if (allowRebuild) return evaluate(script, arg, timeoutMs, what, false);
    }
    throw error;
  }
  if (response?.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? "the page threw";
    throw failed(FAILURES.navigationFailed, `${what} failed in the page: ${text}`);
  }
  return response?.result?.value;
}

async function summary() {
  const tabId = requireTab();
  const tab = await tabSnapshot(tabId);
  if (!tab) {
    dropTab(tabId);
    throw failed(FAILURES.noPage, "The ghost's tab was closed.");
  }
  return { url: tab.url ?? "", title: tab.title ?? "" };
}

/** Resolve once the tab reports `complete`, or once the budget runs out. */
function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve(loaded);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish(true);
    };
    const onRemoved = (id) => {
      if (id === tabId) finish(false);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * After a click or a submit, give the page a moment to turn it into a navigation.
 * No navigation inside the watch window means it was an in-page interaction, which
 * is the common case and must not cost the ghost the whole action timeout.
 */
async function settle(tabId, timeoutMs) {
  const started = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(value);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "loading") finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => finish(false), Math.min(SETTLE_WATCH_MS, timeoutMs));
  });
  if (started) await waitForLoad(tabId, timeoutMs);
}

async function stopLoading() {
  // An abandoned navigation stalls every later op on the tab; drop it as soon as
  // we give up waiting rather than letting it poison the next three tool calls.
  if (!state.attached) return;
  await cdp("Page.stopLoading").catch(() => {});
}

/**
 * Shared body of `back`/`forward`: run the history move, and report whether it
 * changed the page. Chrome rejects when there is nowhere to go, which is a
 * `moved: false` answer rather than a failure.
 */
async function historyNav(tabId, timeoutMs, navigate) {
  const before = await summary();
  try {
    await navigate(tabId);
  } catch {
    return { page: before, moved: false };
  }
  await settle(tabId, timeoutMs);
  const after = await summary();
  return { page: after, moved: after.url !== before.url };
}

async function resolveTarget(args, timeoutMs, { clickable }) {
  const found = await evaluate(
    clickable ? RESOLVE_SCRIPT : FOCUS_AND_CLEAR_SCRIPT,
    { ref: args.ref ?? null, selector: args.selector ?? null, clickable },
    timeoutMs,
    "locating the element",
  );
  if (found?.found !== true) {
    const reason = found?.reason ?? "no-match";
    if (reason === "stale-ref") {
      throw failed(
        FAILURES.unknownRef,
        `${args.ref} is not on this page any more. Run find again — the page has changed.`,
        { ref: args.ref },
      );
    }
    if (reason === "bad-selector") {
      throw failed(FAILURES.invalidInput, `${args.selector} is not a valid CSS selector.`);
    }
    throw failed(
      FAILURES.elementNotFound,
      `Nothing matched ${args.ref ?? args.selector}. Run find again — the page may have changed.`,
    );
  }
  return found;
}

/** The CDP modifier bitmask from names: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function modifierMask(modifiers) {
  if (!Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const raw of modifiers) {
    switch (String(raw).toLowerCase()) {
      case "alt": mask |= 1; break;
      case "control": case "ctrl": mask |= 2; break;
      case "meta": case "command": case "cmd": mask |= 4; break;
      case "shift": mask |= 8; break;
    }
  }
  return mask;
}

/** Windows virtual key codes for the non-printable keys worth naming. */
const VIRTUAL_KEYS = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32,
};

// --------------------------------------------------------------------- the ops

const ops = {
  async status() {
    const tabId = state.activeTabId;
    const tab = tabId === null ? null : await tabSnapshot(tabId);
    return {
      tab: tab ? { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" } : null,
      attached: state.attached,
      banned: state.banned,
      tabs: [...state.tabs],
    };
  },

  async current() {
    if (state.activeTabId === null) return { page: null };
    const tab = await tabSnapshot(state.activeTabId);
    if (!tab) {
      dropTab(state.activeTabId);
      return { page: null };
    }
    const url = tab.url ?? "";
    if (url === "" || url === "about:blank") return { page: null };
    return { page: { url, title: tab.title ?? "" } };
  },

  async open(args, timeoutMs) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (url === "") throw failed(FAILURES.invalidInput, "open needs a url.");
    // The session layer already vetted this URL; refusing again here is the point
    // of a separate trust boundary. The extension does not have to believe the
    // daemon to be safe to install.
    if (!/^https?:\/\//i.test(url)) {
      throw failed(FAILURES.blockedUrl, "The relay only opens http and https URLs.");
    }

    let tab = null;
    if (state.activeTabId !== null) {
      // Reuse the ghost's active tab without raising it: only the first `open` and
      // a screenshot are allowed to take the owner's focus.
      tab = await chrome.tabs.update(state.activeTabId, { url }).catch(() => null);
      if (!tab) dropTab(state.activeTabId);
      // Navigating tears down whatever isolated world we had on the old document.
      else state.worldContextId = null;
    }
    if (!tab) {
      try {
        tab = await chrome.tabs.create({ url, active: true });
      } catch (error) {
        throw failed(
          FAILURES.navigationFailed,
          `Chromium would not open a tab: ${error?.message ?? error}`,
        );
      }
      rememberTab(tab.id);
    }

    if (tab.status !== "complete") {
      const loaded = await waitForLoad(tab.id, timeoutMs);
      if (!loaded) await stopLoading();
    }
    return { page: await summary(), id: String(state.activeTabId) };
  },

  async read(_args, timeoutMs) {
    await ensureAttached();
    const result = await evaluate(READ_PAGE_SCRIPT, undefined, timeoutMs, "reading the page");
    if (!result) throw failed(FAILURES.noPage, "The page had nothing to read.");
    return {
      page: { url: result.url ?? "", title: result.title ?? "" },
      text: typeof result.text === "string" ? result.text : "",
    };
  },

  async find(args, timeoutMs) {
    const query = typeof args.query === "string" ? args.query : "";
    const unsupported = unsupportedFindSyntax(query);
    if (unsupported !== null) {
      throw failed(
        FAILURES.invalidInput,
        `The relay find query uses ${unsupported}, which its bounded selector scan cannot safely interpret. `
        + "Use an ordinary selector or visible text without that syntax.",
      );
    }
    await ensureAttached();
    const requestedLimit = Number.isInteger(args.limit) ? args.limit : DEFAULT_FIND_RESULTS;
    const limit = Math.min(MAX_FIND_RESULTS, Math.max(1, requestedLimit));
    const matches = await evaluate(
      FIND_ELEMENTS_SCRIPT,
      { query, limit },
      timeoutMs,
      "searching the page",
    );
    return { page: await summary(), matches: Array.isArray(matches) ? matches : [] };
  },

  async click(args, timeoutMs) {
    const tabId = await ensureAttached();
    const target = await resolveTarget(args, timeoutMs, { clickable: true });
    if (target.actionable !== true) {
      throw failed(
        FAILURES.elementNotFound,
        `<${target.tag}> is on the page but cannot be clicked (${target.reason}). `
        + "Scroll it into view, dismiss whatever is covering it, or find a different element.",
        { reason: target.reason },
      );
    }
    const { x, y } = target;
    // Move first: menus and tooltips that open on hover need the pointer to have
    // arrived before the press, exactly as it would for a person.
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await cdp("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
    await settle(tabId, timeoutMs);
    return { page: await summary() };
  },

  async type(args, timeoutMs) {
    const tabId = await ensureAttached();
    const target = await resolveTarget(args, timeoutMs, { clickable: false });
    if (target.editable !== true) {
      throw failed(
        FAILURES.elementNotFound,
        target.reason === "select"
          ? `<${target.tag}> is a dropdown, not a text field. Click it and click an option.`
          : `<${target.tag}> is not a field you can type into (${target.reason}).`,
        { reason: target.reason },
      );
    }
    const text = typeof args.text === "string" ? args.text : "";
    if (text !== "") await cdp("Input.insertText", { text });
    if (args.submit === true) {
      const key = {
        key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      };
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
      await cdp("Input.dispatchKeyEvent", { type: "char", ...key, text: "\r", unmodifiedText: "\r" });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      await settle(tabId, timeoutMs);
    }
    return { page: await summary() };
  },

  async screenshot(args, timeoutMs) {
    const tabId = await ensureAttached();
    // `Page.captureScreenshot` reads the compositor surface, which follows the
    // *active* target: capturing a backgrounded tab either stalls waiting for a
    // frame that never comes or hands back a sibling tab's pixels. Raising the
    // tab is the one place the relay is allowed to take the owner's focus, and
    // it is the one place where doing so is also what they asked for.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }

    const params = { format: "png", captureBeyondViewport: args.fullPage === true };
    if (args.fullPage === true) {
      const metrics = await cdp("Page.getLayoutMetrics").catch(() => null);
      const size = metrics?.cssContentSize ?? metrics?.contentSize;
      if (size) {
        params.clip = {
          x: 0,
          y: 0,
          width: Math.min(Math.ceil(size.width), MAX_CAPTURE_PX),
          height: Math.min(Math.ceil(size.height), MAX_CAPTURE_PX),
          scale: 1,
        };
      }
    }
    const shot = await withTimeout(
      cdp("Page.captureScreenshot", params),
      timeoutMs,
      "taking a screenshot",
    );
    if (!shot?.data) throw failed(FAILURES.timeout, "Chromium returned an empty screenshot.");
    return { page: await summary(), png: shot.data };
  },

  async back(_args, timeoutMs) {
    return historyNav(requireTab(), timeoutMs, (id) => chrome.tabs.goBack(id));
  },

  async forward(_args, timeoutMs) {
    return historyNav(requireTab(), timeoutMs, (id) => chrome.tabs.goForward(id));
  },

  async scroll(args, timeoutMs) {
    await ensureAttached();
    let x = typeof args.x === "number" ? args.x : undefined;
    let y = typeof args.y === "number" ? args.y : undefined;
    if (x === undefined || y === undefined) {
      // Anchor the wheel at the viewport centre when the caller did not aim it.
      const vp = await evaluate(
        "() => ({ w: window.innerWidth, h: window.innerHeight })",
        undefined,
        timeoutMs,
        "measuring the viewport",
      );
      x = Math.floor((vp?.w ?? 800) / 2);
      y = Math.floor((vp?.h ?? 600) / 2);
    }
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x, y,
      deltaX: Number(args.deltaX) || 0,
      deltaY: Number(args.deltaY) || 0,
    });
    return { page: await summary() };
  },

  async drag(args, timeoutMs) {
    const tabId = await ensureAttached();
    const fromX = Number(args.fromX) || 0;
    const fromY = Number(args.fromY) || 0;
    const toX = Number(args.toX) || 0;
    const toY = Number(args.toY) || 0;
    const steps = Math.max(1, Number.isInteger(args.steps) ? args.steps : 5);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY, buttons: 0 });
    await cdp("Input.dispatchMouseEvent", {
      type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1,
    });
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(fromX + ((toX - fromX) * i) / steps);
      const y = Math.round(fromY + ((toY - fromY) * i) / steps);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    await cdp("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1,
    });
    await settle(tabId, timeoutMs);
    return { page: await summary() };
  },

  async key(args, timeoutMs) {
    const tabId = await ensureAttached();
    const keyName = typeof args.key === "string" ? args.key : "";
    if (keyName === "") throw failed(FAILURES.invalidInput, "key needs a key name.");
    const modifiers = modifierMask(args.modifiers);
    const vk = VIRTUAL_KEYS[keyName];
    const base = {
      key: keyName,
      ...(typeof args.code === "string" && args.code ? { code: args.code } : {}),
      ...(vk === undefined ? {} : { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }),
      modifiers,
    };
    await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    // A char event actually types the character — but only when no non-shift
    // modifier is held (Ctrl+A selects, it does not insert an "a").
    const text = typeof args.text === "string" ? args.text : (keyName.length === 1 ? keyName : undefined);
    const printable = text !== undefined && (modifiers === 0 || modifiers === 8);
    if (printable) {
      await cdp("Input.dispatchKeyEvent", { type: "char", ...base, text, unmodifiedText: text });
    }
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    if (keyName === "Enter") await settle(tabId, timeoutMs);
    return { page: await summary() };
  },

  async javascript(args, timeoutMs) {
    await ensureAttached();
    const code = typeof args.code === "string" ? args.code : "";
    if (code.trim() === "") throw failed(FAILURES.invalidInput, "javascript needs code to run.");
    // The one script-running op. No `contextId`, so this evaluates in the page's
    // MAIN world — the capability the owner asked for. Both the code and the
    // value it returns are untrusted; the fencing lives in the tool description.
    const response = await withTimeout(
      cdp("Runtime.evaluate", {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
      timeoutMs,
      "running javascript",
    );
    if (response?.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? "the page threw";
      throw failed(FAILURES.navigationFailed, `javascript failed in the page: ${text}`);
    }
    const value = response?.result?.value ?? null;
    return { value, type: typeof value };
  },

  async console(_args, _timeoutMs) {
    // Attach so the Runtime domain is enabled and events flow; then hand over
    // whatever the active tab has buffered since, and empty its slice of the ring.
    await ensureAttached();
    return { entries: drainRing(consoleRing) };
  },

  async network(_args, _timeoutMs) {
    await ensureAttached();
    return { entries: drainRing(networkRing) };
  },

  async upload(args, timeoutMs) {
    await ensureAttached();
    const paths = Array.isArray(args.paths)
      ? args.paths.filter((p) => typeof p === "string" && p !== "")
      : [];
    if (paths.length === 0) throw failed(FAILURES.invalidInput, "upload needs at least one path.");
    const contextId = await ensureIsolatedWorld();
    // Resolve the file input to a live node, keeping the handle (returnByValue:
    // false) so we get an objectId the browser process can act on.
    const response = await withTimeout(
      cdp("Runtime.evaluate", {
        expression: callScript(RESOLVE_NODE_SCRIPT, {
          ref: args.ref ?? null,
          selector: args.selector ?? null,
        }),
        returnByValue: false,
        contextId,
      }),
      timeoutMs,
      "locating the file input",
    );
    const objectId = response?.result?.objectId;
    if (!objectId || response.result.subtype === "null") {
      if (args.ref) {
        throw failed(
          FAILURES.unknownRef,
          `${args.ref} is not on this page any more. Run find again — the page has changed.`,
          { ref: args.ref },
        );
      }
      throw failed(
        FAILURES.elementNotFound,
        `Nothing matched ${args.selector ?? "(no target)"}. Run find again — the page may have changed.`,
      );
    }
    // The browser process reads the paths from disk; the extension never touches
    // the files itself.
    await cdp("DOM.setFileInputFiles", { objectId, files: paths });
    return { page: await summary() };
  },

  async resize(args) {
    const tabId = requireTab();
    const width = Math.round(Number(args.width));
    const height = Math.round(Number(args.height));
    if (!(width > 0) || !(height > 0)) {
      throw failed(FAILURES.invalidInput, "resize needs a positive width and height.");
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const applied = tab
      ? await chrome.windows
          .update(tab.windowId, { width, height })
          .then(() => true)
          .catch(() => false)
      : false;
    return { page: await summary(), applied };
  },

  async tabs(args, timeoutMs) {
    const op = typeof args.op === "string" ? args.op : "list";

    const infos = async () => {
      const out = [];
      const targets = await chrome.debugger.getTargets().catch(() => []);
      for (const id of [...state.tabs]) {
        const tab = await tabSnapshot(id, targets);
        if (!tab) {
          dropTab(id);
          continue;
        }
        out.push({
          id: String(id),
          url: tab.url ?? "",
          title: tab.title ?? "",
          active: id === state.activeTabId,
        });
      }
      return out;
    };
    const activeStr = () => (state.activeTabId === null ? null : String(state.activeTabId));

    if (op === "list") {
      const tabs = await infos();
      return { tabs, active: activeStr() };
    }

    if (op === "create") {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      // The session layer vets a create URL like an open; recheck the scheme here
      // too, unless it is the blank page a tab may legitimately start on.
      if (url !== "" && url !== "about:blank" && !/^https?:\/\//i.test(url)) {
        throw failed(FAILURES.blockedUrl, "The relay only opens http and https URLs.");
      }
      let tab;
      try {
        tab = await chrome.tabs.create({
          ...(url === "" ? {} : { url }),
          active: true,
        });
      } catch (error) {
        throw failed(
          FAILURES.navigationFailed,
          `Chromium would not open a tab: ${error?.message ?? error}`,
        );
      }
      rememberTab(tab.id);
      if (tab.status !== "complete" && url !== "" && url !== "about:blank") {
        const loaded = await waitForLoad(tab.id, timeoutMs);
        if (!loaded) await stopLoading();
      }
      const tabs = await infos();
      return { tabs, active: activeStr(), id: String(tab.id), page: await summary() };
    }

    const id = args.id === undefined ? state.activeTabId : Number(args.id);
    if (!state.tabs.has(id)) {
      throw failed(FAILURES.invalidInput, `${args.id ?? "(no id)"} is not one of the ghost's tabs.`);
    }

    if (op === "switch") {
      setActive(id);
      await chrome.tabs.update(id, { active: true }).catch(() => {});
      const tabs = await infos();
      return { tabs, active: activeStr(), page: await summary() };
    }

    if (op === "close") {
      if (state.attached && id === state.activeTabId) {
        await chrome.debugger.detach({ tabId: id }).catch(() => {});
      }
      await chrome.tabs.remove(id).catch(() => {});
      dropTab(id);
      const tabs = await infos();
      return {
        tabs,
        active: activeStr(),
        ...(state.activeTabId === null ? {} : { page: await summary() }),
      };
    }

    throw failed(FAILURES.invalidInput, `Unknown tabs op "${op}".`);
  },

  async close() {
    // Full teardown: detach and close *every* tab the ghost owns. The tool's
    // `close` action, the idle timeout, and shutdown all route here; per-tab
    // closing is the `tabs` op's job.
    const owned = [...state.tabs];
    let closedAny = false;
    if (state.attached && state.activeTabId !== null) {
      await chrome.debugger.detach({ tabId: state.activeTabId }).catch(() => {});
    }
    for (const id of owned) {
      const removed = await chrome.tabs.remove(id).then(() => true).catch(() => false);
      closedAny = closedAny || removed;
    }
    forgetTab();
    consoleRing.length = 0;
    networkRing.length = 0;
    netPending.clear();
    return { closed: closedAny, tabs: [], active: null };
  },
};

/** Detach and drop the active tab without closing it — used when the socket goes away. */
export async function releaseTab() {
  const tabId = state.activeTabId;
  if (tabId !== null && state.attached) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  resetAttachment();
}

/** Run one op. Throws `RelayOpError` for anything the ghost should be told about. */
export async function runOp(op, args, timeoutMs) {
  const handler = ops[op];
  if (!handler) {
    throw failed(FAILURES.invalidInput, `The relay extension does not implement "${op}".`);
  }
  const budget = Math.max(1_000, timeoutMs || 30_000);
  // The relay protocol has a request deadline but no cancellation frame, and
  // chrome.debugger.sendCommand has no AbortSignal. Bound the response lifecycle
  // here so even ops made of several CDP calls answer on time. The late Chrome
  // promise remains observed by Promise.race; it is not falsely presented as a
  // transport cancellation.
  return withTimeout(
    handler(args ?? {}, budget),
    budget,
    `running ${op}`,
  );
}
