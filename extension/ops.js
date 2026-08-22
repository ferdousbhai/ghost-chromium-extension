/**
 * The eight verbs, against real tabs in the creator's real browser.
 *
 * Three rules run through this file.
 *
 * **One tab, and it is ours.** The ghost gets exactly one tab, created on the
 * first `open` and remembered in `chrome.storage.session` so a service-worker
 * restart does not orphan it. It never touches a tab the creator opened. `close`
 * closes that tab and detaches the debugger; it does *not* close the browser,
 * which has the rest of the creator's day in it.
 *
 * **`chrome.debugger` is the only way in.** There is no `chrome.scripting`, no
 * content script, and no `host_permissions` in the manifest — which means this
 * extension has *no standing access to any page at all*. It can only read or act
 * on a page while a `chrome.debugger` session is attached, and Chrome puts its own
 * un-suppressable "is being debugged" banner across the top of any tab in that
 * state. The creator's evidence that the ghost is looking is a browser-drawn
 * banner rather than our promise. (The brief suggested `scripting` + host
 * permissions; this is a deliberate departure, taking oh-my-pi's permission set.)
 *
 * **Input is real input.** Clicks are `Input.dispatchMouseEvent` at a
 * hit-tested point and typing is `Input.insertText` into a focused field, not
 * `element.click()` and not `element.value = x`. Synthetic DOM events have
 * `isTrusted: false`, which a meaningful number of real sites check, and — more
 * to the point — a ghost that can only drive a page the way a person could is a
 * ghost whose behaviour a person can predict.
 *
 * The attach state machine (`attached` / `banned` / `attaching`, ban on any attach
 * failure, ban cleared by navigation) is ported from the MIT-licensed
 * `browser-relay` bridge in https://github.com/can1357/oh-my-pi.
 */
import { failed, FAILURES } from "./protocol.js";
import {
  callScript,
  FIND_ELEMENTS_SCRIPT,
  FOCUS_AND_CLEAR_SCRIPT,
  READ_PAGE_SCRIPT,
  RESOLVE_SCRIPT,
} from "./page-scripts.js";

const CDP_VERSION = "1.3";
/** URLs `chrome.debugger` cannot attach to. */
const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search|about):/i;
/** How long to watch for a click to turn into a navigation before calling it settled. */
const SETTLE_WATCH_MS = 900;
/** Chrome's own texture limits; a taller capture comes back blank or fails. */
const MAX_CAPTURE_PX = 16_384;

const state = {
  tabId: null,
  attached: false,
  /** Set when attach failed or the creator dismissed the debugger banner. */
  banned: false,
  attaching: null,
};

/** Where the ghost's tab id survives a service-worker restart. */
const SESSION_KEY = "ghostTabId";

export async function restoreTabFromSession() {
  try {
    const stored = await chrome.storage.session.get({ [SESSION_KEY]: null });
    const tabId = stored[SESSION_KEY];
    if (typeof tabId !== "number") return;
    // Only adopt it if it is still there. A worker restart plus a closed tab
    // would otherwise leave us driving a tab id Chrome has reused.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) state.tabId = tabId;
    else await chrome.storage.session.remove(SESSION_KEY);
  } catch {
    // Session storage is a convenience; a fresh `open` recovers either way.
  }
}

function rememberTab(tabId) {
  state.tabId = tabId;
  state.attached = false;
  state.banned = false;
  void chrome.storage.session.set({ [SESSION_KEY]: tabId }).catch(() => {});
}

function forgetTab() {
  state.tabId = null;
  state.attached = false;
  state.banned = false;
  state.attaching = null;
  void chrome.storage.session.remove(SESSION_KEY).catch(() => {});
}

export function currentTabId() {
  return state.tabId;
}

export function isAttached() {
  return state.attached;
}

// ------------------------------------------------------------------ listeners

/**
 * Wire the tab and debugger events. Called once from the service worker; every
 * handler is defensive because these fire for every tab in the browser, not ours.
 */
export function installOpsListeners(onNotice) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId !== state.tabId) return;
    forgetTab();
    onNotice?.("tab_closed", {});
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.tabId) return;
    // A navigation is the one thing that can un-wedge a banned tab: the creator
    // dismissed the debugger banner, the page moved on, and attaching is worth
    // trying again. oh-my-pi's rule, and it is the difference between "the relay
    // stopped working forever" and "the relay recovered by itself".
    if (changeInfo.url && state.banned) state.banned = false;
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId !== state.tabId) return;
    state.attached = false;
    state.attaching = null;
    // Any detach is a ban until the tab navigates. Re-attaching immediately would
    // fight the creator for the banner they just dismissed.
    state.banned = true;
    onNotice?.("detached", { reason });
  });

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== state.tabId) return;
    if (method !== "Page.javascriptDialogOpening") return;
    // With `Page.enable` on, Chrome hands dialogs to the debugger instead of the
    // creator, and an unanswered one wedges the renderer forever. Dismiss —
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
  if (state.tabId === null) {
    throw failed(FAILURES.noPage, "No page is loaded. Use action \"open\" with a URL first.");
  }
  return state.tabId;
}

async function ensureAttached() {
  const tabId = requireTab();
  if (state.attached) return tabId;
  if (state.banned) {
    throw failed(
      FAILURES.browserUnavailable,
      "Chromium will not let the relay inspect this tab — the creator dismissed "
      + "the \"is being debugged\" banner, or DevTools is open on it. It will work "
      + "again after the tab navigates somewhere.",
    );
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    forgetTab();
    throw failed(FAILURES.noPage, "The ghost's tab is gone. Open a page again.");
  }
  if (tab.url && INELIGIBLE_URL.test(tab.url)) {
    throw failed(
      FAILURES.blockedUrl,
      `Chromium does not allow automation of ${tab.url.split(":")[0]}: pages.`,
    );
  }
  if (state.attaching) {
    await state.attaching;
    return tabId;
  }
  state.attaching = (async () => {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    state.attached = true;
    // Page domain: dialog interception (above) and `Page.stopLoading` recovery.
    await chrome.debugger.sendCommand({ tabId }, "Page.enable", {}).catch(() => {});
  })();
  try {
    await state.attaching;
  } catch (error) {
    state.attached = false;
    // Any attach failure bans the tab rather than looping: the causes (DevTools,
    // another extension's debugger, a policy-blocked page) do not fix themselves
    // between two retries, and each retry costs the creator a banner flash.
    state.banned = true;
    throw failed(
      FAILURES.browserUnavailable,
      `Chromium refused to attach its debugger to the ghost's tab: ${error?.message ?? error}. `
      + "Close DevTools on that tab, or any other extension driving it, and try again.",
    );
  } finally {
    state.attaching = null;
  }
  return tabId;
}

function cdp(method, params) {
  return chrome.debugger.sendCommand({ tabId: requireTab() }, method, params ?? {});
}

async function evaluate(script, arg, timeoutMs, what) {
  const response = await withTimeout(
    cdp("Runtime.evaluate", {
      expression: callScript(script, arg),
      returnByValue: true,
      awaitPromise: true,
    }),
    timeoutMs,
    what,
  );
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
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    forgetTab();
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

async function resolveTarget(args, timeoutMs, { clickable }) {
  const found = await evaluate(
    clickable ? RESOLVE_SCRIPT : FOCUS_AND_CLEAR_SCRIPT,
    { ref: args.ref ?? null, selector: args.selector ?? null, clickable },
    timeoutMs,
    "locating the element",
  );
  if (!found || found.found !== true) {
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

// --------------------------------------------------------------------- the ops

const ops = {
  async status() {
    const tabId = state.tabId;
    const tab = tabId === null ? null : await chrome.tabs.get(tabId).catch(() => null);
    return {
      tab: tab ? { id: tab.id, url: tab.url ?? "", title: tab.title ?? "" } : null,
      attached: state.attached,
      banned: state.banned,
    };
  },

  async current() {
    if (state.tabId === null) return { page: null };
    const tab = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!tab) {
      forgetTab();
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
    if (state.tabId !== null) {
      // Reuse the ghost's tab without raising it: only the first `open` and a
      // screenshot are allowed to take the creator's focus.
      tab = await chrome.tabs.update(state.tabId, { url }).catch(() => null);
      if (!tab) forgetTab();
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
      // A brand-new tab is a brand-new page: whatever the debugger was attached
      // to is gone.
      state.attached = false;
      state.banned = false;
    }

    if (tab.status !== "complete") {
      const loaded = await waitForLoad(tab.id, timeoutMs);
      if (!loaded) await stopLoading();
    }
    return { page: await summary() };
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
    await ensureAttached();
    const query = typeof args.query === "string" ? args.query : "";
    const limit = Number.isInteger(args.limit) ? args.limit : 20;
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
    // tab is the one place the relay is allowed to take the creator's focus, and
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
    const tabId = requireTab();
    const before = await summary();
    let moved = true;
    try {
      await chrome.tabs.goBack(tabId);
    } catch {
      // Chrome rejects when there is nothing behind this page. That is an answer,
      // not a failure — the seam has a `moved: false` for exactly this.
      moved = false;
    }
    if (moved) {
      await settle(tabId, timeoutMs);
      const after = await summary();
      return { page: after, moved: after.url !== before.url };
    }
    return { page: before, moved: false };
  },

  async close() {
    const tabId = state.tabId;
    if (tabId === null) return { closed: false };
    if (state.attached) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    const removed = await chrome.tabs
      .remove(tabId)
      .then(() => true)
      .catch(() => false);
    forgetTab();
    return { closed: removed };
  },
};

/** Detach and drop the tab without closing it — used when the socket goes away. */
export async function releaseTab() {
  const tabId = state.tabId;
  if (tabId !== null && state.attached) {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  state.attached = false;
  state.attaching = null;
}

/** Run one op. Throws `RelayOpError` for anything the ghost should be told about. */
export async function runOp(op, args, timeoutMs) {
  const handler = ops[op];
  if (!handler) {
    throw failed(FAILURES.invalidInput, `The relay extension does not implement "${op}".`);
  }
  return handler(args ?? {}, Math.max(1_000, timeoutMs || 30_000));
}
