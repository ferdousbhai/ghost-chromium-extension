/**
 * The verbs, against real tabs in the owner's real browser.
 *
 * Three rules run through this file.
 *
 * **The tab is the unit of isolation.** One extension serves every ghost and
 * every conversation through a single socket, so nothing here may be global: each
 * op names the tab it acts on and gets that tab's own attach state and isolated
 * world. Two conversations driving two tabs cannot reset each other's world or
 * invalidate each other's refs. `state.tabs` maps a claimed tab id to that state;
 * the ghost never touches a tab the owner opened. `close` shuts the caller's tab
 * and detaches from it, never the browser, which has the rest of the owner's day
 * in it.
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
const SETTLE_WATCH_MS = 900;
/** Chrome's own texture limits; a taller capture comes back blank or fails. */
const MAX_CAPTURE_PX = 16_384;
const RING_LIMIT = 200;

/**
 * `tabs`: claimed tab id -> that tab's CDP state. Nothing about a page lives
 * outside it. `sessions`: session id -> the tabs that session claimed, which is
 * what keeps one conversation from listing, driving, or closing another's tab
 * over the socket they share.
 */
const state = { tabs: new Map(), sessions: new Map() };

function freshTabState() {
  return {
    attached: false,
    /** Set when attach failed or the owner dismissed the debugger banner. */
    banned: false,
    attaching: null,
    /**
     * The `executionContextId` of the per-frame isolated world every page snippet
     * runs in. Kept across ops so the ref table (which lives on that world's
     * global) survives from `find` to the `click`/`type` that uses its refs. Reset
     * to null whenever the world is gone: a navigation or a detach.
     */
    worldContextId: null,
    domainsEnabled: false,
    attachGeneration: 0,
    /**
     * What this tab has said since its last `console`/`network` op. Per tab, not
     * shared: one chatty page must not evict another conversation's lines, and a
     * tab that goes away takes its buffers with it.
     */
    consoleRing: [],
    networkRing: [],
    netPending: new Map(),
  };
}

/** Forget a tab's isolated world, so the next evaluate builds a fresh one. */
function clearWorld(tabId) {
  const tab = state.tabs.get(tabId);
  if (tab) tab.worldContextId = null;
}

/** The tabs one session has claimed, tracked from its first `open`. */
function sessionTabs(session) {
  let owned = state.sessions.get(session);
  if (!owned) {
    owned = new Set();
    state.sessions.set(session, owned);
  }
  return owned;
}

/** Whether this session is the one that opened this tab. */
function owns(session, tabId) {
  return typeof session === "string" && state.sessions.get(session)?.has(tabId) === true;
}

const attachBarriers = new Map();

const SESSION_KEY = "ghostTabs";

function persist() {
  void chrome.storage.session
    .set({
      [SESSION_KEY]: {
        tabs: [...state.tabs.keys()],
        sessions: [...state.sessions].map(([session, owned]) => [session, [...owned]]),
      },
    })
    .catch(() => {});
}

export async function restoreTabsFromSession() {
  try {
    const stored = await chrome.storage.session.get({ [SESSION_KEY]: null });
    const saved = stored[SESSION_KEY];
    if (!saved || !Array.isArray(saved.tabs)) return;
    // Only adopt tabs that still exist. A worker restart plus a closed tab would
    // otherwise leave us driving a tab id Chrome has reused.
    const ids = saved.tabs.filter((id) => typeof id === "number");
    const live = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
    for (const [index, id] of ids.entries()) {
      if (live[index]) state.tabs.set(id, freshTabState());
    }
    // A backend that reconnects names the same session, so restoring who owned
    // what is what lets its next `close` still find the tabs it opened.
    for (const [session, owned] of Array.isArray(saved.sessions) ? saved.sessions : []) {
      if (typeof session !== "string" || !Array.isArray(owned)) continue;
      const kept = owned.filter((id) => state.tabs.has(id));
      if (kept.length > 0) state.sessions.set(session, new Set(kept));
    }
    persist();
  } catch {
    // Session storage is a convenience; a fresh `open` recovers either way.
  }
}

function resetAttachment(tab) {
  tab.attachGeneration += 1;
  tab.attached = false;
  tab.banned = false;
  tab.attaching = null;
  tab.worldContextId = null;
  tab.domainsEnabled = false;
}

/** Claim a freshly opened tab for the calling session, discarding a reused id's state. */
function claimTab(session, tabId) {
  state.tabs.set(tabId, freshTabState());
  if (typeof session === "string" && session !== "") sessionTabs(session).add(tabId);
  persist();
}

function dropTab(tabId) {
  // The tab owns its console/network buffers, so they go with it.
  state.tabs.delete(tabId);
  for (const [session, owned] of state.sessions) {
    if (owned.delete(tabId) && owned.size === 0) state.sessions.delete(session);
  }
  persist();
}

/** Close one claimed tab without forgetting a live tab Chromium refused to close. */
async function retireTab(tabId) {
  if (isAttached(tabId)) {
    await detachStale(tabId);
    const tab = state.tabs.get(tabId);
    if (tab) resetAttachment(tab);
  }
  try {
    await chrome.tabs.remove(tabId);
    dropTab(tabId);
    return true;
  } catch {
    const stillOpen = await chrome.tabs.get(tabId).catch(() => null);
    if (!stillOpen) {
      dropTab(tabId);
      return false;
    }
    throw failed(
      FAILURES.browserUnavailable,
      "Chromium did not close one of the ghost's tabs. Retry the close.",
    );
  }
}

/** Whether the relay currently holds a debugger session on one claimed tab. */
export function isAttached(tabId) {
  return state.tabs.get(tabId)?.attached === true;
}


function pushRing(tab, ring, entry) {
  ring.push(entry);
  if (ring.length > RING_LIMIT) {
    const dropped = ring.shift();
    if (dropped && dropped.__reqId !== undefined) tab.netPending.delete(dropped.__reqId);
  }
}

function bufferConsole(tab, params, isException) {
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
  pushRing(tab, tab.consoleRing, {
    level,
    text,
    ...(url ? { url } : {}),
    ...(line === undefined ? {} : { line }),
  });
}

function bufferRequest(tab, params) {
  const entry = {
    __reqId: params?.requestId,
    method: params?.request?.method ?? "GET",
    url: params?.request?.url ?? "",
    ...(params?.type ? { type: params.type } : {}),
  };
  pushRing(tab, tab.networkRing, entry);
  if (params?.requestId !== undefined) tab.netPending.set(params.requestId, entry);
}

function fillResponse(tab, params) {
  const entry = tab.netPending.get(params?.requestId);
  if (!entry) return;
  const response = params?.response ?? {};
  if (typeof response.status === "number") entry.status = response.status;
  if (!entry.type && params?.type) entry.type = params.type;
  if (typeof response.encodedDataLength === "number" && response.encodedDataLength > 0) {
    entry.bodyBytes = response.encodedDataLength;
  }
}

function fillFinished(tab, params) {
  const entry = tab.netPending.get(params?.requestId);
  if (entry && typeof params?.encodedDataLength === "number" && params.encodedDataLength > 0) {
    entry.bodyBytes = params.encodedDataLength;
  }
  tab.netPending.delete(params?.requestId);
}

/**
 * Hand over what this tab has buffered and start its next window empty. The ring
 * is the tab's own, so there is nothing to filter: swap it out.
 */
function drainConsole(tab) {
  const entries = tab.consoleRing;
  tab.consoleRing = [];
  return entries;
}

/** As {@link drainConsole}, minus the request id that is ours to correlate with. */
function drainNetwork(tab) {
  const entries = tab.networkRing.map(({ __reqId, ...rest }) => rest);
  tab.networkRing = [];
  return entries;
}


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
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    // A navigation is the one thing that can un-wedge a banned tab: the owner
    // dismissed the debugger banner, the page moved on, and attaching is worth
    // trying again.
    // `changeInfo.url` is redacted without the named `tabs` permission. Loading
    // status is permission-free and is the navigation edge this state needs.
    if (changeInfo.status === "loading" && tab.banned) tab.banned = false;
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    const tab = state.tabs.get(source.tabId);
    if (!tab) return;
    resetAttachment(tab);
    // Any detach is a ban until the tab navigates. Re-attaching immediately would
    // fight the owner for the banner they just dismissed.
    tab.banned = true;
    onNotice?.("detached", { reason, tabId: source.tabId });
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    // Console and network events land in the tab's own buffers, so a later
    // `console`/`network` op on it has something to drain. Events fire for every
    // tab in the browser, so an unclaimed one is simply not ours.
    const tab = state.tabs.get(source.tabId);
    if (!tab) return;
    if (method === "Runtime.consoleAPICalled") {
      bufferConsole(tab, params, false);
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      bufferConsole(tab, params, true);
      return;
    }
    if (method === "Network.requestWillBeSent") {
      bufferRequest(tab, params);
      return;
    }
    if (method === "Network.responseReceived") {
      fillResponse(tab, params);
      return;
    }
    if (method === "Network.loadingFinished") {
      fillFinished(tab, params);
      return;
    }
    if (method === "Page.frameNavigated" && !params?.frame?.parentId) {
      // A main-frame navigation tears down that tab's isolated world and every
      // ref in it. Drop the cached context id so the next evaluate builds a fresh
      // one (and a fresh, empty ref table) rather than talking to a dead context.
      clearWorld(source.tabId);
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

/**
 * The claimed tab this op names, as `args.tab`, or null when it names none we
 * hold. Every page op carries it: the extension holds no "current" tab, because
 * the socket is shared by every conversation.
 */
function claimedTab(args) {
  const raw = args?.tab;
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const tabId = Number(raw);
  if (!Number.isInteger(tabId) || !state.tabs.has(tabId)) return null;
  return owns(args?.session, tabId) ? tabId : null;
}

/** {@link claimedTab}, for the ops that cannot proceed without a page. */
function requireTab(args) {
  const tabId = claimedTab(args);
  if (tabId === null) {
    throw failed(FAILURES.noPage, "No page is loaded. Use action \"open\" with a URL first.");
  }
  return tabId;
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
 * The asking session's tabs, with the metadata `tabSnapshot` can see. `active`
 * marks the one it drives, which is that session's answer alone. One
 * `getTargets()` call serves the whole list.
 */
/** The `{ tabs, active }` shape every `tabs` op answers with. */
async function tabsAnswer(session, active) {
  return {
    tabs: await tabInfos(session, active),
    active: active === null ? null : String(active),
  };
}

async function tabInfos(session, active) {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  // A session sees the tabs it opened. The popup asks with no session and sees
  // them all, because that view is the owner's, not a conversation's.
  const ids = session === null ? [...state.tabs.keys()] : [...sessionTabs(session)];
  const snapshots = await Promise.all(ids.map((id) => tabSnapshot(id, targets)));
  const out = [];
  for (const [index, id] of ids.entries()) {
    const snapshot = snapshots[index];
    if (!snapshot) {
      dropTab(id);
      continue;
    }
    out.push({
      id: String(id),
      url: snapshot.url ?? "",
      title: snapshot.title ?? "",
      active: id === active,
    });
  }
  return out;
}

/**
 * A debugger session can outlive the service-worker instance that opened it,
 * because Chrome tracks the attachment per-extension. After the worker is reaped
 * and respawned, `getTargets()` can still report our tab as `attached` while our
 * in-memory attach flag has been reset to false — and re-attaching over that
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
  const tab = state.tabs.get(tabId);
  if (tab.domainsEnabled) return;
  tab.domainsEnabled = true;
  await chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => {});
  await Promise.all(["Runtime", "Network", "DOM"].map((domain) =>
    chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {}).catch(() => {})));
}

function invalidatedAttach(tabId) {
  return failed(
    FAILURES.browserUnavailable,
    `Tab ${tabId} was released while Chromium was attaching to it. Try the action again.`,
  );
}

function isCurrentAttach(attempt) {
  const tab = state.tabs.get(attempt.tabId);
  return tab !== undefined
    && tab.attaching === attempt
    && tab.attachGeneration === attempt.generation;
}

async function detachStale(tabId) {
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function ensureAttached(args) {
  const tabId = requireTab(args);
  const tab = state.tabs.get(tabId);
  if (tab.attached) {
    await enableDomains(tabId);
    return tabId;
  }
  if (tab.banned) {
    throw failed(
      FAILURES.browserUnavailable,
      "Chromium will not let the relay inspect this tab — the owner dismissed "
      + "the \"is being debugged\" banner, or DevTools is open on it. It will work "
      + "again after the tab navigates somewhere.",
    );
  }
  const snapshot = await tabSnapshot(tabId);
  if (!snapshot) {
    dropTab(tabId);
    throw failed(FAILURES.noPage, "The ghost's tab is gone. Open a page again.");
  }
  if (snapshot.url && INELIGIBLE_URL.test(snapshot.url)) {
    throw failed(
      FAILURES.blockedUrl,
      `Chromium does not allow automation of ${snapshot.url.split(":")[0]}: pages.`,
    );
  }
  if (!tab.attaching) {
    const barrier = attachBarriers.get(tabId);
    if (barrier) {
      // A reset can make the current state forget an attempt before Chrome has
      // settled it. Never attach the same tab again until that attempt has either
      // failed or succeeded and detached itself, or its cleanup could detach this
      // newer generation by tab id.
      await barrier.catch(() => {});
      if (!state.tabs.has(tabId)) throw invalidatedAttach(tabId);
      return ensureAttached(args);
    }
    const attempt = {
      tabId,
      generation: tab.attachGeneration,
      promise: null,
    };
    attempt.promise = (async () => {
      // A `chrome.debugger` session is attached per-extension, not per-worker, so
      // it can outlive the service-worker instance that opened it. After a worker
      // restart this tab's attach flag is false but Chrome still lists us as attached;
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
      tab.attached = true;
      tab.domainsEnabled = false;
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
      tab.attached = false;
      tab.worldContextId = null;
      tab.domainsEnabled = false;
      // Any attach failure bans the tab rather than looping: the causes (DevTools,
      // another extension's debugger, a policy-blocked page) do not fix themselves
      // between two retries, and each retry costs the owner a banner flash. The
      // normalization lives on the shared promise so its owner and every concurrent
      // waiter receive the same typed failure.
      tab.banned = true;
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
    tab.attaching = attempt;
  }
  const attempt = tab.attaching;
  try {
    await attempt.promise;
    if (!isCurrentAttach(attempt)) throw invalidatedAttach(attempt.tabId);
  } finally {
    if (tab.attaching === attempt) tab.attaching = null;
  }
  return tabId;
}

function cdp(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params ?? {});
}

/**
 * Get — creating once, then reusing — the isolated world our snippets run in.
 * `Page.createIsolatedWorld` hands back an `executionContextId` for a realm that
 * shares the tab's DOM but has its own globals and its own native copies of the
 * DOM APIs, so a hostile page cannot override `querySelectorAll`/`elementFromPoint`
 * to spoof the hit-test, and the ref table on its global is out of the page's
 * reach. The same context is reused across ops so refs survive `find` → `click`.
 */
async function ensureIsolatedWorld(tabId) {
  const tab = state.tabs.get(tabId);
  if (tab.worldContextId !== null) return tab.worldContextId;
  const tree = await cdp(tabId, "Page.getFrameTree");
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== "string") {
    throw failed(FAILURES.navigationFailed, "The page has no main frame to inspect.");
  }
  const world = await cdp(tabId, "Page.createIsolatedWorld", { frameId, worldName: "ghost-relay" });
  const contextId = world?.executionContextId;
  if (typeof contextId !== "number") {
    throw failed(FAILURES.navigationFailed, "Chromium would not open an isolated world to inspect the page.");
  }
  tab.worldContextId = contextId;
  return contextId;
}

function isStaleWorld(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  return message.includes("context")
    && (message.includes("cannot find") || message.includes("not found")
      || message.includes("destroyed") || message.includes("no longer"));
}

async function evaluate(tabId, script, arg, timeoutMs, what, allowRebuild = true) {
  const contextId = await ensureIsolatedWorld(tabId);
  let response;
  try {
    response = await withTimeout(
      cdp(tabId, "Runtime.evaluate", {
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
      if (state.tabs.get(tabId)?.worldContextId === contextId) clearWorld(tabId);
      if (allowRebuild) return evaluate(tabId, script, arg, timeoutMs, what, false);
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

async function summary(tabId) {
  const tab = await tabSnapshot(tabId);
  if (!tab) {
    dropTab(tabId);
    throw failed(FAILURES.noPage, "The ghost's tab was closed.");
  }
  return { url: tab.url ?? "", title: tab.title ?? "" };
}

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

async function stopLoading(tabId) {
  // An abandoned navigation stalls every later op on the tab; drop it as soon as
  // we give up waiting rather than letting it poison the next three tool calls.
  if (!isAttached(tabId)) return;
  await cdp(tabId, "Page.stopLoading").catch(() => {});
}

/**
 * Shared body of `back`/`forward`: run the history move, and report whether it
 * changed the page. Chrome rejects when there is nowhere to go, which is a
 * `moved: false` answer rather than a failure.
 */
async function historyNav(tabId, timeoutMs, navigate) {
  const before = await summary(tabId);
  try {
    await navigate(tabId);
  } catch {
    return { page: before, moved: false };
  }
  await settle(tabId, timeoutMs);
  const after = await summary(tabId);
  return { page: after, moved: after.url !== before.url };
}

async function resolveTarget(tabId, args, timeoutMs, { clickable }) {
  const found = await evaluate(
    tabId,
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

const VIRTUAL_KEYS = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32,
};


const ops = {
  async status(args) {
    const tabId = claimedTab(args);
    const entry = tabId === null ? undefined : state.tabs.get(tabId);
    // Every claimed tab, not just the caller's: this is what the popup shows the
    // owner, and several conversations may be holding tabs at once.
    return {
      attached: entry?.attached === true,
      banned: entry?.banned === true,
      // No session: this is the popup, and the owner's view is every ghost tab.
      tabs: await tabInfos(null, tabId),
    };
  },

  async current(args) {
    const tabId = claimedTab(args);
    if (tabId === null) return { page: null };
    const tab = await tabSnapshot(tabId);
    if (!tab) {
      dropTab(tabId);
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

    let tabId = claimedTab(args);
    let tab = null;
    if (tabId !== null) {
      // Reuse the caller's own tab without raising it: only the first `open` and
      // a screenshot are allowed to take the owner's focus.
      tab = await chrome.tabs.update(tabId, { url }).catch(() => null);
      if (!tab) dropTab(tabId);
      // Navigating tears down whatever isolated world we had on the old document.
      else clearWorld(tabId);
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
      tabId = tab.id;
      claimTab(args.session, tabId);
    }

    if (tab.status !== "complete") {
      const loaded = await waitForLoad(tabId, timeoutMs);
      if (!loaded) await stopLoading(tabId);
    }
    return { page: await summary(tabId), id: String(tabId) };
  },

  async read(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    const result = await evaluate(tabId, READ_PAGE_SCRIPT, undefined, timeoutMs, "reading the page");
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
    const tabId = await ensureAttached(args);
    const requestedLimit = Number.isInteger(args.limit) ? args.limit : DEFAULT_FIND_RESULTS;
    const limit = Math.min(MAX_FIND_RESULTS, Math.max(1, requestedLimit));
    const matches = await evaluate(
      tabId,
      FIND_ELEMENTS_SCRIPT,
      { query, limit },
      timeoutMs,
      "searching the page",
    );
    return { page: await summary(tabId), matches: Array.isArray(matches) ? matches : [] };
  },

  async click(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    const target = await resolveTarget(tabId, args, timeoutMs, { clickable: true });
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
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
    await settle(tabId, timeoutMs);
    return { page: await summary(tabId) };
  },

  async type(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    const target = await resolveTarget(tabId, args, timeoutMs, { clickable: false });
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
    if (text !== "") await cdp(tabId, "Input.insertText", { text });
    if (args.submit === true) {
      const key = {
        key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      };
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", ...key, text: "\r", unmodifiedText: "\r" });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
      await settle(tabId, timeoutMs);
    }
    return { page: await summary(tabId) };
  },

  async screenshot(args, timeoutMs) {
    const tabId = await ensureAttached(args);
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
      const metrics = await cdp(tabId, "Page.getLayoutMetrics").catch(() => null);
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
      cdp(tabId, "Page.captureScreenshot", params),
      timeoutMs,
      "taking a screenshot",
    );
    if (!shot?.data) throw failed(FAILURES.timeout, "Chromium returned an empty screenshot.");
    return { page: await summary(tabId), png: shot.data };
  },

  async back(args, timeoutMs) {
    return historyNav(requireTab(args), timeoutMs, (id) => chrome.tabs.goBack(id));
  },

  async forward(args, timeoutMs) {
    return historyNav(requireTab(args), timeoutMs, (id) => chrome.tabs.goForward(id));
  },

  async scroll(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    let x = typeof args.x === "number" ? args.x : undefined;
    let y = typeof args.y === "number" ? args.y : undefined;
    if (x === undefined || y === undefined) {
      // Anchor the wheel at the viewport centre when the caller did not aim it.
      const vp = await evaluate(
        tabId,
        "() => ({ w: window.innerWidth, h: window.innerHeight })",
        undefined,
        timeoutMs,
        "measuring the viewport",
      );
      x = Math.floor((vp?.w ?? 800) / 2);
      y = Math.floor((vp?.h ?? 600) / 2);
    }
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x, y,
      deltaX: Number(args.deltaX) || 0,
      deltaY: Number(args.deltaY) || 0,
    });
    return { page: await summary(tabId) };
  },

  async drag(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    const fromX = Number(args.fromX) || 0;
    const fromY = Number(args.fromY) || 0;
    const toX = Number(args.toX) || 0;
    const toY = Number(args.toY) || 0;
    const steps = Math.max(1, Number.isInteger(args.steps) ? args.steps : 5);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY, buttons: 0 });
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: fromX, y: fromY, button: "left", buttons: 1, clickCount: 1,
    });
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(fromX + ((toX - fromX) * i) / steps);
      const y = Math.round(fromY + ((toY - fromY) * i) / steps);
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    }
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1,
    });
    await settle(tabId, timeoutMs);
    return { page: await summary(tabId) };
  },

  async key(args, timeoutMs) {
    const tabId = await ensureAttached(args);
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
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    // A char event actually types the character — but only when no non-shift
    // modifier is held (Ctrl+A selects, it does not insert an "a").
    const text = typeof args.text === "string" ? args.text : (keyName.length === 1 ? keyName : undefined);
    const printable = text !== undefined && (modifiers === 0 || modifiers === 8);
    if (printable) {
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", ...base, text, unmodifiedText: text });
    }
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    if (keyName === "Enter") await settle(tabId, timeoutMs);
    return { page: await summary(tabId) };
  },

  async javascript(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    const code = typeof args.code === "string" ? args.code : "";
    if (code.trim() === "") throw failed(FAILURES.invalidInput, "javascript needs code to run.");
    // The one script-running op. No `contextId`, so this evaluates in the page's
    // MAIN world — the capability the owner asked for. Both the code and the
    // value it returns are untrusted; the fencing lives in the tool description.
    const response = await withTimeout(
      cdp(tabId, "Runtime.evaluate", {
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

  async console(args, _timeoutMs) {
    // Attach so the Runtime domain is enabled and events flow; then hand over
    // whatever this tab has buffered since, and empty its slice of the ring.
    const tabId = await ensureAttached(args);
    return { entries: drainConsole(state.tabs.get(tabId)) };
  },

  async network(args, _timeoutMs) {
    const tabId = await ensureAttached(args);
    return { entries: drainNetwork(state.tabs.get(tabId)) };
  },

  async upload(args, timeoutMs) {
    const tabId = await ensureAttached(args);
    const paths = Array.isArray(args.paths)
      ? args.paths.filter((path) => typeof path === "string" && path !== "")
      : [];
    if (paths.length === 0) throw failed(FAILURES.invalidInput, "upload needs at least one path.");
    const contextId = await ensureIsolatedWorld(tabId);
    // Resolve the file input to a live node, keeping the handle (returnByValue:
    // false) so we get an objectId the browser process can act on.
    const response = await withTimeout(
      cdp(tabId, "Runtime.evaluate", {
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
    await cdp(tabId, "DOM.setFileInputFiles", { objectId, files: paths });
    return { page: await summary(tabId) };
  },

  async resize(args) {
    const tabId = requireTab(args);
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
    return { page: await summary(tabId), applied };
  },

  async tabs(args, timeoutMs) {
    const op = typeof args.op === "string" ? args.op : "list";
    // `active` is the caller's own tab, not a browser-wide one: the tab list is
    // shared, but which tab a conversation drives is that conversation's alone.
    const caller = claimedTab(args);

    if (op === "list") {
      return tabsAnswer(args.session, caller);
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
      claimTab(args.session, tab.id);
      if (tab.status !== "complete" && url !== "" && url !== "about:blank") {
        const loaded = await waitForLoad(tab.id, timeoutMs);
        if (!loaded) await stopLoading(tab.id);
      }
      return {
        ...(await tabsAnswer(args.session, tab.id)),
        id: String(tab.id),
        page: await summary(tab.id),
      };
    }

    const id = args.id === undefined ? caller : claimedTab({ tab: args.id, session: args.session });
    if (id === null) {
      throw failed(FAILURES.invalidInput, `${args.id ?? "(no id)"} is not one of this session's tabs.`);
    }

    if (op === "switch") {
      // Switching re-points this caller only; the tab keeps whatever attachment
      // and isolated world it already had, so another conversation's refs survive.
      await chrome.tabs.update(id, { active: true }).catch(() => {});
      return { ...(await tabsAnswer(args.session, id)), page: await summary(id) };
    }

    if (op === "close") {
      await retireTab(id);
      const active = id === caller ? null : caller;
      return {
        ...(await tabsAnswer(args.session, active)),
        ...(active === null ? {} : { page: await summary(active) }),
      };
    }

    throw failed(FAILURES.invalidInput, `Unknown tabs op "${op}".`);
  },

  async close(args) {
    // Session teardown closes every tab this session opened, not just the one it
    // was last driving: `tabs create` re-points the caller, and without this the
    // tabs it moved off would be left in the owner's browser with nothing owning
    // them. Other conversations keep their own tabs, and the browser keeps the
    // rest of the owner's day in it.
    const owned = [...(state.sessions.get(args?.session) ?? [])];
    let closed = false;
    for (const tabId of owned) {
      const removed = await retireTab(tabId);
      closed = closed || removed;
    }
    return { closed };
  },

};

/**
 * Drop every debugger session without closing a tab. The socket going away means
 * every conversation behind it is gone, but the tabs are the owner's to keep;
 * a reconnecting backend still names the same tab and re-attaches on its next op.
 */
export async function releaseAllTabs() {
  for (const [tabId, tab] of state.tabs) {
    if (tab.attached) await detachStale(tabId);
    resetAttachment(tab);
  }
}

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
