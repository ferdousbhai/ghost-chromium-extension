/**
 * The verbs, against real tabs in the owner's real browser.
 *
 * Three rules run through this file.
 *
 * **The tab is the unit of isolation.** One extension serves every ghost through
 * a single socket, so tab state cannot be global: each op
 * names the tab it acts on and gets that tab's own attach state and isolated
 * world. Two tabs cannot reset each other's world or invalidate each other's
 * refs. `state.tabs` maps a claimed tab id to that state;
 * the ghost never touches a tab the owner opened. `close` shuts every tab the
 * caller's ghost-wide owner opened and detaches from them, never the browser,
 * which has the rest of the owner's day in it.
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
const STORAGE_TIMEOUT_MS = 750;
const RESTORE_TIMEOUT_MS = 1_000;
const RESTORE_TOTAL_TIMEOUT_MS = 5_000;
const RESTORE_CONCURRENCY = 16;
const DETACH_TIMEOUT_MS = 750;
const RETIRED_SWEEP_TIMEOUT_MS = 1_000;
const RETIRE_TOTAL_TIMEOUT_MS = 1_000;
const RETIRE_CONCURRENCY = 16;
const RECENT_RETIRED_LIMIT = 1_024;
const MAX_STORED_TABS = 1_024;
const MAX_STORED_OWNERS = 1_024;
const MAX_STORED_RETIRED = 2_048;
const MAX_OWNER_ID_LENGTH = 128;
const MAX_TAB_ID = 2_147_483_647;
const RELEASED_WORKSPACE_MESSAGE =
  "This ghost browser workspace has been released. Retry the browser action so Ghost can open a fresh workspace.";
/** Chrome's own texture limits; a taller capture comes back blank or fails. */
const MAX_CAPTURE_PX = 16_384;
const RING_LIMIT = 200;

/**
 * `tabs`: claimed tab id -> that tab's CDP state. Nothing about a page lives
 * outside it. `sessions`: ghost-wide protocol owner id -> its claimed tabs,
 * which keeps one ghost from listing, driving, or closing another ghost's tab
 * over the socket they share.
 */
const state = { tabs: new Map(), sessions: new Map(), retired: new Set() };
const creatingSessions = new Map();
let creatingTotal = 0;
const recentRetired = new Set();
let ownershipGeneration = 0;
let sweepInFlight = null;
let aggregateRetirementDepth = 0;
let dropPublicationDirty = false;
let dropPublicationInFlight = null;
let incarnationTail = Promise.resolve();
let incarnationPublication = null;

function freshRepairLane() {
  return { requested: 0, completed: 0, inFlight: null };
}

const ownershipRepair = freshRepairLane();
const poisonRepair = freshRepairLane();
const incarnationRepair = freshRepairLane();

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
    pendingDetach: false,
    attachGeneration: 0,
    /**
     * What this tab has said since its last `console`/`network` op. Per tab, not
     * shared: one chatty page must not evict another tab's lines, and a
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

/** The tabs one ghost-wide protocol owner has claimed, tracked from its first `open`. */
function sessionTabs(session) {
  let owned = state.sessions.get(session);
  if (!owned) {
    owned = new Set();
    state.sessions.set(session, owned);
  }
  return owned;
}

/** Whether this ghost-wide protocol owner is the one that opened this tab. */
function owns(session, tabId) {
  return typeof session === "string" && state.sessions.get(session)?.has(tabId) === true;
}

function requireOwningSession(args) {
  const session = args?.session;
  if (typeof session !== "string" || session === "") {
    throw failed(
      FAILURES.invalidInput,
      "The relay request is missing its ghost browser workspace owner. Update Ghost and reload the extension.",
    );
  }
  if (session.length > MAX_OWNER_ID_LENGTH) {
    throw failed(
      FAILURES.invalidInput,
      `The ghost browser workspace owner may be at most ${MAX_OWNER_ID_LENGTH} characters. `
        + "Update Ghost and reload the extension.",
    );
  }
  return session;
}

function isRetired(session) {
  return state.retired.has(session) || recentRetired.has(session);
}

function rememberRecentRetirement(session) {
  recentRetired.delete(session);
  recentRetired.add(session);
  while (recentRetired.size > RECENT_RETIRED_LIMIT) {
    recentRetired.delete(recentRetired.values().next().value);
  }
}

function beginCreating(session) {
  creatingTotal += 1;
  creatingSessions.set(session, (creatingSessions.get(session) ?? 0) + 1);
}

function endCreating(session) {
  creatingTotal = Math.max(0, creatingTotal - 1);
  const remaining = (creatingSessions.get(session) ?? 1) - 1;
  if (remaining > 0) creatingSessions.set(session, remaining);
  else creatingSessions.delete(session);
  if (state.retired.has(session)) void sweepRetiredTabs().catch(() => {});
}

const attachBarriers = new Map();

const SESSION_KEY = "ghostTabs";
const SESSION_REVISION_KEY = "ghostTabsRevision";
const BROWSER_SESSION_KEY = "ghostBrowserSession";
const POISON_KEY = "ghostOwnershipPoison";
const POISON_BACKUP_KEY = "ghostOwnershipPoisonBackup";
const OWNERSHIP_FENCE_KEY = "ghostOwnershipFence";
const INCARNATION_KEY = "ghostDaemonIncarnation";
const INCARNATION_BACKUP_KEY = "ghostDaemonIncarnationBackup";
const SESSION_STATE_VERSION = 2;
const OWNERSHIP_FENCE_VERSION = 2;
const POISON_VERSION = 2;
const INCARNATION_VERSION = 1;
const INCARNATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let ownershipTail = Promise.resolve();
let ownershipPublicationRevision = 0;
let browserSessionId = null;
const ownershipPoison = new Map();
let poisonPublicationRevision = 0;
let poisonStorageTail = Promise.resolve();
let incarnationPublicationRevision = 0;
let incarnationStorageTail = Promise.resolve();

function serializeOwnership(work) {
  const task = ownershipTail.then(work, work);
  ownershipTail = task.then(() => undefined, () => undefined);
  return task;
}

function serializeIncarnation(work) {
  const task = incarnationTail.then(work, work);
  incarnationTail = task.then(() => undefined, () => undefined);
  return task;
}

function repairPending(lane) {
  return lane.completed !== lane.requested;
}

function browserPersistenceRepairPending() {
  return repairPending(ownershipRepair)
    || repairPending(poisonRepair)
    || repairPending(incarnationRepair);
}

function startRepair(lane, serialize, work) {
  if (!repairPending(lane)) return Promise.resolve();
  if (lane.inFlight !== null) return lane.inFlight;
  const revision = lane.requested;
  const attempt = serialize(async () => {
    await work();
    if (lane.requested === revision) lane.completed = revision;
  });
  lane.inFlight = attempt;
  const clear = () => {
    if (lane.inFlight === attempt) lane.inFlight = null;
  };
  void attempt.then(clear, clear);
  return attempt;
}

function requestRepair(lane, attempt) {
  lane.requested += 1;
  void attempt().catch(() => {});
}

function attemptIncarnationRepair() {
  return startRepair(incarnationRepair, serializeIncarnation, async () => {
    const publication = incarnationPublication;
    if (publication === null) return;
    await persistIncarnation(publication);
  });
}

function scheduleIncarnationRepair() {
  requestRepair(incarnationRepair, attemptIncarnationRepair);
}

function ownershipSnapshot() {
  return {
    version: SESSION_STATE_VERSION,
    tabs: [...state.tabs.keys()],
    sessions: [...state.sessions].map(([session, owned]) => [session, [...owned]]),
    retired: [...state.retired],
  };
}

function attemptOwnershipRepair() {
  return startRepair(ownershipRepair, serializeOwnership, persistOwnership);
}

function scheduleOwnershipRepair() {
  requestRepair(ownershipRepair, attemptOwnershipRepair);
}

function attemptPoisonRepair() {
  return startRepair(poisonRepair, serializeOwnership, persistCurrentPoison);
}

function schedulePoisonRepair() {
  requestRepair(poisonRepair, attemptPoisonRepair);
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectNewestPublication(primary, backup, parse) {
  const left = parse(primary);
  const right = parse(backup);
  if (left === undefined || right === undefined) return undefined;
  if (left === null) return right;
  if (right === null) return left;
  if (left.revision === right.revision) {
    // The second slot is the commit record. Equal-but-different values arise
    // when an unacknowledged first-slot write from a reaped worker lands after
    // a newer worker has committed both slots at the same next revision.
    return right;
  }
  return left.revision > right.revision ? left : right;
}

function queueLocalPublication(tail, primaryKey, backupKey, publication) {
  const write = async () => {
    await chrome.storage.local.set({ [primaryKey]: publication });
    await chrome.storage.local.set({ [backupKey]: publication });
  };
  const task = tail.then(write, write);
  return {
    task,
    tail: task.then(() => undefined, () => undefined),
  };
}

async function boundedStorageMutation(promise, what, repair) {
  let expired = false;
  void promise.then(
    () => {
      if (expired) repair();
    },
    () => {},
  );
  try {
    return await withApiTimeout(promise, STORAGE_TIMEOUT_MS, what);
  } catch (error) {
    expired = true;
    throw error;
  }
}

async function setOwnershipSnapshot(snapshot) {
  browserSessionId ??= crypto.randomUUID();
  const publication = {
    version: OWNERSHIP_FENCE_VERSION,
    browserSession: browserSessionId,
    revision: ownershipPublicationRevision + 1,
    snapshot,
  };
  ownershipPublicationRevision = publication.revision;
  await boundedStorageMutation(
    chrome.storage.local.set({ [OWNERSHIP_FENCE_KEY]: publication }),
    "fencing browser ownership",
    () => {
      if (publication.revision !== ownershipPublicationRevision
          || !sameSnapshot(snapshot, ownershipSnapshot())) scheduleOwnershipRepair();
    },
  );
  await boundedStorageMutation(
    chrome.storage.session.set({
      [SESSION_KEY]: snapshot,
      [SESSION_REVISION_KEY]: publication.revision,
      [BROWSER_SESSION_KEY]: browserSessionId,
    }),
    "saving browser ownership",
    () => {
      if (publication.revision !== ownershipPublicationRevision
          || !sameSnapshot(snapshot, ownershipSnapshot())) scheduleOwnershipRepair();
    },
  );
}

async function persistCurrentPoison() {
  browserSessionId ??= crypto.randomUUID();
  const publication = poisonSnapshot(poisonPublicationRevision + 2);
  poisonPublicationRevision = publication.revision;
  const queued = queueLocalPublication(
    poisonStorageTail,
    POISON_KEY,
    POISON_BACKUP_KEY,
    publication,
  );
  poisonStorageTail = queued.tail;
  await withApiTimeout(
    queued.task,
    STORAGE_TIMEOUT_MS,
    ownershipPoison.size === 0
      ? "clearing browser ownership recovery"
      : "saving browser ownership recovery",
  );
}

async function persistCurrentPoisonOrSchedule() {
  try {
    await persistCurrentPoison();
  } catch {
    schedulePoisonRepair();
  }
}

async function persistOwnership() {
  await setOwnershipSnapshot(ownershipSnapshot());
  if (ownershipPoison.size > 0) {
    ownershipPoison.clear();
    ownershipGeneration += 1;
    await persistCurrentPoisonOrSchedule();
  }
}

async function persistPoison(session, tabId) {
  if (ownershipPoison.get(tabId) !== session) ownershipGeneration += 1;
  ownershipPoison.set(tabId, session);
  try {
    await persistCurrentPoison();
  } catch (error) {
    schedulePoisonRepair();
    throw error;
  }
}

function poisonSnapshot(revision) {
  return {
    version: POISON_VERSION,
    browserSession: browserSessionId,
    revision,
    claims: [...ownershipPoison].map(([tab, session]) => [session, tab]),
  };
}

function parsePoisonPublication(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "browserSession,claims,revision,version"
      || value.version !== POISON_VERSION
      || typeof value.browserSession !== "string"
      || !INCARNATION_PATTERN.test(value.browserSession)
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Array.isArray(value.claims) || value.claims.length > MAX_STORED_TABS) {
    return undefined;
  }
  const parsed = new Map();
  for (const row of value.claims) {
    if (!Array.isArray(row) || row.length !== 2) return undefined;
    const [session, tab] = row;
    if (typeof session !== "string" || session === "" || session.length > MAX_OWNER_ID_LENGTH
        || !Number.isSafeInteger(tab) || tab < 0 || tab > MAX_TAB_ID || parsed.has(tab)) {
      return undefined;
    }
    parsed.set(tab, session);
  }
  return value;
}

async function clearPoison(tabId) {
  if (ownershipPoison.delete(tabId)) ownershipGeneration += 1;
  await persistCurrentPoisonOrSchedule();
}

function noSuchTab(error, tabId) {
  return error instanceof Error && error.message === `No tab with id: ${tabId}.`;
}

async function liveTabOrNull(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`Chromium returned no status for tab ${tabId}.`);
    return tab;
  } catch (error) {
    if (noSuchTab(error, tabId)) return null;
    throw error;
  }
}

async function verifyLiveTabs(tabIds, deadline, description) {
  const ids = [...tabIds];
  const results = new Map();
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw failed(
          FAILURES.timeout,
          `The browser did not finish ${description} within the total recovery deadline.`,
        );
      }
      results.set(id, await withApiTimeout(
        liveTabOrNull(id),
        Math.min(RESTORE_TIMEOUT_MS, remaining),
        `${description} tab ${id}`,
      ));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(RESTORE_CONCURRENCY, ids.length) }, () => worker()),
  );
  return results;
}

function validStoredOwnership(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
  if (Object.keys(saved).sort().join(",") !== "retired,sessions,tabs,version") return false;
  if (saved.version !== SESSION_STATE_VERSION || !Array.isArray(saved.tabs)
      || !Array.isArray(saved.sessions) || !Array.isArray(saved.retired)) return false;
  if (saved.tabs.length > MAX_STORED_TABS
      || saved.sessions.length > MAX_STORED_OWNERS
      || saved.retired.length > MAX_STORED_RETIRED) return false;
  const tabs = new Set();
  for (const id of saved.tabs) {
    if (!Number.isSafeInteger(id) || id < 0 || id > MAX_TAB_ID || tabs.has(id)) return false;
    tabs.add(id);
  }
  const sessions = new Set();
  const assigned = new Set();
  for (const row of saved.sessions) {
    if (!Array.isArray(row) || row.length !== 2) return false;
    const [session, owned] = row;
    if (typeof session !== "string" || session === ""
        || session.length > MAX_OWNER_ID_LENGTH || sessions.has(session)
        || !Array.isArray(owned) || owned.length === 0
        || owned.length > MAX_STORED_TABS) return false;
    sessions.add(session);
    for (const id of owned) {
      if (!tabs.has(id) || assigned.has(id)) return false;
      assigned.add(id);
    }
  }
  const retired = new Set();
  for (const session of saved.retired) {
    if (typeof session !== "string" || session === ""
        || session.length > MAX_OWNER_ID_LENGTH || retired.has(session)) return false;
    retired.add(session);
  }
  return assigned.size === tabs.size;
}

function parseOwnershipPublication(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "browserSession,revision,snapshot,version"
      || value.version !== OWNERSHIP_FENCE_VERSION
      || typeof value.browserSession !== "string"
      || !INCARNATION_PATTERN.test(value.browserSession)
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !validStoredOwnership(value.snapshot)) return undefined;
  return value;
}

function selectStoredOwnership(stored, fenced, currentBrowserSession) {
  const snapshot = stored[SESSION_KEY];
  const rawRevision = stored[SESSION_REVISION_KEY];
  let sessionPublication = null;
  if (snapshot !== null && snapshot !== undefined) {
    if (!validStoredOwnership(snapshot)
        || (rawRevision !== null && rawRevision !== undefined
          && (!Number.isSafeInteger(rawRevision) || rawRevision < 1))) return undefined;
    sessionPublication = {
      version: OWNERSHIP_FENCE_VERSION,
      revision: rawRevision ?? 0,
      snapshot,
    };
  } else if (rawRevision !== null && rawRevision !== undefined) {
    return undefined;
  }

  const fencePublication = parseOwnershipPublication(fenced[OWNERSHIP_FENCE_KEY]);
  if (fencePublication === undefined) return undefined;
  const currentFence = fencePublication?.browserSession === currentBrowserSession
    ? fencePublication
    : null;
  if (sessionPublication === null) return currentFence;
  if (currentFence === null) return sessionPublication;
  if (sessionPublication.revision === currentFence.revision
      && !sameSnapshot(sessionPublication.snapshot, currentFence.snapshot)) return undefined;
  return sessionPublication.revision > currentFence.revision
    ? sessionPublication
    : currentFence;
}

export function restoreTabsFromSession() {
  const admittedGeneration = ownershipGeneration;
  return serializeOwnership(async () => {
    const restoreDeadline = Date.now() + RESTORE_TOTAL_TIMEOUT_MS;
    if (ownershipGeneration !== admittedGeneration
        || state.tabs.size > 0 || state.sessions.size > 0 || state.retired.size > 0) {
      await persistOwnership();
      return;
    }
    let stored;
    let local;
    try {
      [stored, local] = await Promise.all([
        withApiTimeout(
          chrome.storage.session.get({
            [SESSION_KEY]: null,
            [SESSION_REVISION_KEY]: null,
            [BROWSER_SESSION_KEY]: null,
          }),
          RESTORE_TIMEOUT_MS,
          "restoring browser ownership",
        ),
        withApiTimeout(
          chrome.storage.local.get({
            [POISON_KEY]: null,
            [POISON_BACKUP_KEY]: null,
            [OWNERSHIP_FENCE_KEY]: null,
          }),
          RESTORE_TIMEOUT_MS,
          "restoring browser ownership recovery",
        ),
      ]);
    } catch (error) {
      throw failed(
        FAILURES.browserUnavailable,
        `Could not restore browser ownership: ${error?.message ?? error}.`,
      );
    }
    const rawBrowserSession = stored[BROWSER_SESSION_KEY];
    const freshBrowserSession = rawBrowserSession === null || rawBrowserSession === undefined;
    if (!freshBrowserSession
        && (typeof rawBrowserSession !== "string" || !INCARNATION_PATTERN.test(rawBrowserSession))) {
      throw failed(
        FAILURES.browserUnavailable,
        "Stored browser-session identity is invalid; reload the Ghost extension.",
      );
    }
    if (freshBrowserSession
        && (stored[SESSION_KEY] !== null && stored[SESSION_KEY] !== undefined
          || stored[SESSION_REVISION_KEY] !== null
            && stored[SESSION_REVISION_KEY] !== undefined)) {
      throw failed(
        FAILURES.browserUnavailable,
        "Stored browser ownership has no browser-session identity; reload the Ghost extension.",
      );
    }
    browserSessionId = freshBrowserSession ? crypto.randomUUID() : rawBrowserSession;
    const publication = selectStoredOwnership(stored, local, browserSessionId);
    if (publication === undefined) {
      throw failed(
        FAILURES.browserUnavailable,
        "Stored browser ownership or its durability fence is invalid; reload the Ghost extension.",
      );
    }
    ownershipPublicationRevision = Math.max(
      ownershipPublicationRevision,
      publication?.revision ?? 0,
    );
    const saved = publication?.snapshot ?? null;
    const savedPoison = selectNewestPublication(
      local[POISON_KEY],
      local[POISON_BACKUP_KEY],
      parsePoisonPublication,
    );
    if (savedPoison === undefined) {
      throw failed(
        FAILURES.browserUnavailable,
        "Stored browser ownership recovery is invalid; reload the Ghost extension.",
      );
    }
    poisonPublicationRevision = Math.max(
      poisonPublicationRevision,
      savedPoison?.revision ?? 0,
    );
    const additionalClaims = new Map();
    if (savedPoison !== null) {
      const poisonClaims = new Map(
        savedPoison.claims.map(([session, tab]) => [tab, session]),
      );
      if (savedPoison.browserSession !== browserSessionId) {
        ownershipPoison.clear();
        // The empty poison tombstone must reach both durable slots before the
        // new browser-session id can make reusable numeric tab ids admissible.
        try {
          await persistCurrentPoison();
        } catch (error) {
          schedulePoisonRepair();
          throw failed(
            FAILURES.browserUnavailable,
            `Could not clear ownership from the prior browser session: `
              + `${error?.message ?? error}. The relay will retry automatically.`,
          );
        }
      } else {
        const recoveryTabs = new Set(saved?.tabs ?? []);
        const recoveryOwners = new Set(
          (saved?.sessions ?? []).map(([session]) => session),
        );
        for (const [tab, session] of poisonClaims) {
          recoveryTabs.add(tab);
          recoveryOwners.add(session);
        }
        if (recoveryTabs.size > MAX_STORED_TABS
            || recoveryOwners.size > MAX_STORED_OWNERS) {
          throw failed(
            FAILURES.browserUnavailable,
            "Stored browser ownership and recovery exceed their combined limits; reload the Ghost extension.",
          );
        }
        const uncertain = new Map();
        for (const [tab, session] of poisonClaims) {
          const durable = saved?.sessions.some(
            ([owner, tabs]) => owner === session && tabs.includes(tab),
          ) === true;
          if (durable) continue;
          if (saved?.tabs.includes(tab)) {
            throw failed(
              FAILURES.browserUnavailable,
              `Stored browser ownership recovery conflicts over tab ${tab}; reload the Ghost extension.`,
            );
          }
          uncertain.set(tab, session);
        }
        let verified;
        try {
          verified = await verifyLiveTabs(
            uncertain.keys(),
            restoreDeadline,
            "restoring uncertain browser ownership",
          );
        } catch (error) {
          ownershipPoison.clear();
          for (const [tab, session] of poisonClaims) ownershipPoison.set(tab, session);
          await persistCurrentPoisonOrSchedule();
          const tab = poisonClaims.keys().next().value;
          throw failed(
            FAILURES.browserUnavailable,
            `Browser ownership of tab ${tab} is indeterminate after a worker restart, `
              + `and at least one tab status could not be verified: `
              + `${error?.message ?? error}.`,
          );
        }
        for (const [tab, session] of uncertain) {
          if (verified.get(tab) !== null) additionalClaims.set(tab, session);
        }
        ownershipPoison.clear();
        for (const [tab, session] of poisonClaims) ownershipPoison.set(tab, session);
      }
    }
    if (freshBrowserSession) {
      await persistOwnership();
      return;
    }
    const applyGeneration = ownershipGeneration;
    if (saved === null) {
      if (additionalClaims.size === 0) {
        if (ownershipPoison.size > 0) await persistOwnership();
        return;
      }
    }
    const restoredTabs = new Map();
    let verifiedTabs;
    try {
      verifiedTabs = await verifyLiveTabs(
        saved?.tabs ?? [],
        restoreDeadline,
        "restoring browser ownership",
      );
    } catch (error) {
      throw failed(
        FAILURES.browserUnavailable,
        `Could not verify restored browser tabs: ${error?.message ?? error}.`,
      );
    }
    for (const [id, tab] of verifiedTabs) {
      if (tab !== null) restoredTabs.set(id, freshTabState());
    }
    for (const id of additionalClaims.keys()) restoredTabs.set(id, freshTabState());
    const restoredSessions = new Map();
    for (const [session, owned] of saved?.sessions ?? []) {
      const live = owned.filter((id) => restoredTabs.has(id));
      if (live.length > 0) restoredSessions.set(session, new Set(live));
    }
    for (const [tab, session] of additionalClaims) {
      let owned = restoredSessions.get(session);
      if (!owned) {
        owned = new Set();
        restoredSessions.set(session, owned);
      }
      owned.add(tab);
    }
    const restoredRetired = new Set(saved?.retired ?? []);

    if (ownershipGeneration !== applyGeneration) {
      await persistOwnership();
      return;
    }

    const previousTabs = new Map(state.tabs);
    const previousSessions = new Map(state.sessions);
    const previousRetired = new Set(state.retired);
    state.tabs.clear();
    state.sessions.clear();
    state.retired.clear();
    for (const [id, tab] of restoredTabs) state.tabs.set(id, tab);
    for (const [session, owned] of restoredSessions) state.sessions.set(session, owned);
    for (const session of restoredRetired) state.retired.add(session);
    try {
      await persistOwnership();
      ownershipGeneration += 1;
    } catch (error) {
      state.tabs.clear();
      state.sessions.clear();
      state.retired.clear();
      for (const [id, tab] of previousTabs) state.tabs.set(id, tab);
      for (const [session, owned] of previousSessions) state.sessions.set(session, owned);
      for (const session of previousRetired) state.retired.add(session);
      throw failed(
        FAILURES.browserUnavailable,
        `Could not confirm restored browser ownership: ${error?.message ?? error}.`,
      );
    }
  });
}

function parseIncarnationPublication(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "incarnation,revision,version"
      || value.version !== INCARNATION_VERSION
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.incarnation !== "string"
      || !INCARNATION_PATTERN.test(value.incarnation)) return undefined;
  return value;
}

async function persistIncarnation(publication) {
  const durable = {
    version: INCARNATION_VERSION,
    revision: publication.revision,
    incarnation: publication.incarnation,
  };
  const queued = queueLocalPublication(
    incarnationStorageTail,
    INCARNATION_KEY,
    INCARNATION_BACKUP_KEY,
    durable,
  );
  incarnationStorageTail = queued.tail;
  try {
    await withApiTimeout(
      queued.task,
      STORAGE_TIMEOUT_MS,
      "saving the daemon incarnation",
    );
  } catch (error) {
    scheduleIncarnationRepair();
    throw failed(
      FAILURES.browserUnavailable,
      `Could not save the daemon incarnation: ${error?.message ?? error}.`,
    );
  }
}

async function reconcileIncarnation(incarnation) {
  const changed = await serializeOwnership(async () => {
    let stored;
    try {
      stored = await withApiTimeout(
        chrome.storage.local.get({
          [INCARNATION_KEY]: null,
          [INCARNATION_BACKUP_KEY]: null,
        }),
        RESTORE_TIMEOUT_MS,
        "restoring the daemon incarnation",
      );
    } catch (error) {
      throw failed(
        FAILURES.browserUnavailable,
        `Could not restore the daemon incarnation: ${error?.message ?? error}.`,
      );
    }
    const restored = selectNewestPublication(
      stored[INCARNATION_KEY],
      stored[INCARNATION_BACKUP_KEY],
      parseIncarnationPublication,
    );
    if (restored === undefined) {
      throw failed(
        FAILURES.browserUnavailable,
        "Stored daemon incarnation is invalid; reload the Ghost extension.",
      );
    }
    incarnationPublicationRevision = Math.max(
      incarnationPublicationRevision,
      restored?.revision ?? 0,
    );
    const previous = restored?.incarnation ?? null;
    if (previous === incarnation) return false;

    const priorOwners = new Set([...state.sessions.keys(), ...creatingSessions.keys()]);
    for (const session of priorOwners) {
      if (state.retired.has(session)) continue;
      state.retired.add(session);
      ownershipGeneration += 1;
    }
    // A prior failed attempt may have added the tombstone only in memory. Every
    // retry with live claims or create leases republishes the complete snapshot
    // before the new daemon incarnation can be admitted.
    if (priorOwners.size > 0) {
      try {
        await persistOwnership();
      } catch (error) {
        throw failed(
          FAILURES.browserUnavailable,
          `Could not durably retire browser work from the previous ghostd: `
            + `${error?.message ?? error}. The relay will retry automatically.`,
        );
      }
    }
    return true;
  });
  if (!changed) return;

  await sweepRetiredTabs();
  if (state.sessions.size > 0) {
    throw failed(
      FAILURES.browserUnavailable,
      `The previous ghostd process left ${state.sessions.size} browser ownership `
        + "claim(s) that Chromium has not retired yet. The relay will retry automatically.",
    );
  }
  const publication = {
    incarnation,
    generation: (incarnationPublication?.generation ?? 0) + 1,
    revision: incarnationPublicationRevision + 2,
  };
  incarnationPublicationRevision = publication.revision;
  incarnationPublication = publication;
  await persistIncarnation(publication);
}

/** Retire every claim and create lease whose owning daemon can no longer close it. */
export async function reconcileDaemonIncarnation(incarnation) {
  if (typeof incarnation !== "string" || !INCARNATION_PATTERN.test(incarnation)) {
    throw failed(
      FAILURES.browserUnavailable,
      "ghostd did not provide a valid browser ownership incarnation. Update Ghost and reload the extension.",
    );
  }

  return serializeIncarnation(() => reconcileIncarnation(incarnation));
}

function resetAttachment(tab) {
  tab.attachGeneration += 1;
  tab.attached = false;
  tab.banned = false;
  tab.attaching = null;
  tab.worldContextId = null;
  tab.domainsEnabled = false;
}

function rememberTab(session, tabId) {
  state.tabs.set(tabId, freshTabState());
  if (typeof session === "string" && session !== "") sessionTabs(session).add(tabId);
  ownershipGeneration += 1;
}

function forgetTab(tabId) {
  // The tab owns its console/network buffers, so they go with it.
  const changed = state.tabs.delete(tabId);
  for (const [session, owned] of state.sessions) {
    if (owned.delete(tabId) && owned.size === 0) state.sessions.delete(session);
  }
  if (changed) ownershipGeneration += 1;
  return changed;
}

/** Claim a new tab durably before its successful create response leaves this worker. */
async function claimTab(session, tabId, timeoutMs) {
  let storageError = null;
  let retired = false;
  await serializeOwnership(async () => {
    rememberTab(session, tabId);
    retired = isRetired(session);
    try {
      await persistOwnership();
    } catch (error) {
      storageError = error;
    }
  });

  if (storageError === null) {
    if (!retired) return;
    try {
      await retireTab(tabId, timeoutMs);
    } catch (error) {
      void sweepRetiredTabs().catch(() => {});
      throw error;
    }
    throw failed(
      FAILURES.browserUnavailable,
      RELEASED_WORKSPACE_MESSAGE,
    );
  }

  const [poisonResult, removal] = await Promise.all([
    serializeOwnership(() => persistPoison(session, tabId)).then(
      () => ({ error: null }),
      (error) => ({ error }),
    ),
    removeTab(tabId, timeoutMs),
  ]);
  const poisonError = poisonResult.error;
  if (removal.authoritative) {
    forgetTab(tabId);
    await serializeOwnership(() => clearPoison(tabId));
    throw failed(
      FAILURES.browserUnavailable,
      `Could not persist ownership of tab ${tabId}: ${storageError?.message ?? storageError}. `
        + "The new tab was rolled back; retry open.",
    );
  }

  try {
    await serializeOwnership(() => persistOwnership());
  } catch {
    throw failed(
      FAILURES.browserUnavailable,
      `Could not persist ownership of tab ${tabId}: ${storageError?.message ?? storageError}. `
        + "The tab remains fail-closed for close recovery"
        + (poisonError === null
          ? ", including across a worker restart."
          : `, but its recovery marker also failed: ${poisonError?.message ?? poisonError}.`),
    );
  }
  throw failed(
    FAILURES.browserUnavailable,
    `Could not persist ownership of tab ${tabId}: ${storageError?.message ?? storageError}. `
      + "The tab is durably owned; retry close.",
  );
}

async function createClaimedTab(session, options, timeoutMs) {
  if (state.tabs.size + creatingTotal >= MAX_STORED_TABS) {
    throw failed(
      FAILURES.browserUnavailable,
      `This browser relay already owns ${MAX_STORED_TABS} tabs. Close a ghost browser `
        + "workspace before opening another tab.",
    );
  }
  const creatingOwners = [...creatingSessions.keys()]
    .filter((owner) => !state.sessions.has(owner)).length;
  if (!state.sessions.has(session) && !creatingSessions.has(session)
      && state.sessions.size + creatingOwners >= MAX_STORED_OWNERS) {
    throw failed(
      FAILURES.browserUnavailable,
      `This browser relay already owns ${MAX_STORED_OWNERS} ghost workspaces. Close one `
        + "before opening another.",
    );
  }
  beginCreating(session);
  try {
    let tab;
    try {
      tab = await chrome.tabs.create(options);
    } catch (error) {
      throw failed(
        FAILURES.navigationFailed,
        `Chromium would not open a tab: ${error?.message ?? error}`,
      );
    }
    await claimTab(session, tab.id, timeoutMs);
    return tab;
  } finally {
    endCreating(session);
  }
}

function flushDroppedTabs() {
  if (dropPublicationInFlight !== null) return dropPublicationInFlight;
  const attempt = (async () => {
    while (dropPublicationDirty && aggregateRetirementDepth === 0) {
      dropPublicationDirty = false;
      try {
        await serializeOwnership(() => persistOwnership());
      } catch {
        // The repair snapshot includes every drop that arrived during this
        // attempt. Keep it pending for preparation/alarm retry without making
        // this best-effort event handler hot-loop storage.
        scheduleOwnershipRepair();
        break;
      }
    }
  })();
  dropPublicationInFlight = attempt;
  const clear = () => {
    if (dropPublicationInFlight !== attempt) return;
    dropPublicationInFlight = null;
    if (dropPublicationDirty && aggregateRetirementDepth === 0) void flushDroppedTabs();
  };
  void attempt.then(clear, clear);
  return attempt;
}

function dropTab(tabId) {
  if (!forgetTab(tabId)) return Promise.resolve();
  if (aggregateRetirementDepth > 0) return Promise.resolve();
  // A stale durable row is safe: restore rechecks the tab's existence. The live
  // in-memory owner is removed synchronously, while storage cleanup is ordered
  // behind any claim publication already in progress. If several Chrome events
  // arrive while that write is slow, one follow-up snapshot covers all of them.
  dropPublicationDirty = true;
  return flushDroppedTabs();
}

function cleanupBudget(timeoutMs) {
  return Math.max(100, Math.floor(timeoutMs * 0.8));
}

function remainingCleanupBudget(timeoutMs, deadline) {
  return Math.max(0, Math.min(cleanupBudget(timeoutMs), deadline - Date.now()));
}

async function tryDetach(
  tabId,
  timeoutMs = DETACH_TIMEOUT_MS,
  deadline = Date.now() + cleanupBudget(timeoutMs),
) {
  const tab = state.tabs.get(tabId);
  if (!tab) return true;
  if (tab.pendingDetach) return false;
  const budget = Math.min(
    DETACH_TIMEOUT_MS,
    remainingCleanupBudget(timeoutMs, deadline),
  );
  if (budget <= 0) return false;
  let expired = false;
  let outcome = null;
  const raw = Promise.resolve().then(() => chrome.debugger.detach({ tabId }));
  tab.pendingDetach = true;
  void raw.then(
    () => {
      outcome = "detached";
      tab.pendingDetach = false;
      if (expired && state.tabs.get(tabId) === tab) resetAttachment(tab);
    },
    () => {
      outcome = "failed";
      tab.pendingDetach = false;
    },
  );
  try {
    await withApiTimeout(
      raw,
      budget,
      `detaching tab ${tabId}`,
    );
    return true;
  } catch {
    expired = true;
    if (outcome === "detached" && state.tabs.get(tabId) === tab) resetAttachment(tab);
    return false;
  }
}

/** Try to prove one tab absent without trusting an indeterminate Chrome error. */
async function removeTab(
  tabId,
  timeoutMs,
  deadline = Date.now() + cleanupBudget(timeoutMs),
) {
  let budget = remainingCleanupBudget(timeoutMs, deadline);
  if (budget <= 0) {
    return {
      authoritative: false,
      getError: failed(
        FAILURES.timeout,
        `The browser retirement deadline expired before tab ${tabId} could be checked.`,
      ),
    };
  }
  let removeError;
  try {
    await withTimeout(
      Promise.resolve().then(() => chrome.tabs.remove(tabId)),
      budget,
      `closing tab ${tabId}`,
    );
    return { authoritative: true, removed: true };
  } catch (error) {
    removeError = error;
    if (noSuchTab(error, tabId)) return { authoritative: true, removed: false };
  }
  budget = remainingCleanupBudget(timeoutMs, deadline);
  if (budget <= 0) {
    return {
      authoritative: false,
      removeError,
      getError: failed(
        FAILURES.timeout,
        `The browser retirement deadline expired before tab ${tabId} could be checked.`,
      ),
    };
  }
  try {
    const live = await withTimeout(liveTabOrNull(tabId), budget, `checking tab ${tabId}`);
    if (live === null) return { authoritative: true, removed: false };
  } catch (getError) {
    return { authoritative: false, removeError, getError };
  }
  return { authoritative: false, removeError };
}

/** Close one claimed tab without forgetting a live tab Chromium refused to close. */
async function retireTab(
  tabId,
  timeoutMs,
  deadline = Date.now() + cleanupBudget(timeoutMs),
) {
  if (isAttached(tabId)) {
    const detached = await tryDetach(tabId, timeoutMs, deadline);
    const tab = state.tabs.get(tabId);
    if (detached && tab) resetAttachment(tab);
  }
  const removal = await removeTab(tabId, timeoutMs, deadline);
  if (removal.authoritative) {
    await dropTab(tabId);
    return removal.removed;
  }
  if (removal.getError) {
    throw failed(
      FAILURES.browserUnavailable,
      `Chromium did not close tab ${tabId}, and its status could not be verified: `
        + `${removal.getError?.message ?? removal.getError}. Retry the close.`,
    );
  }
  throw failed(
    FAILURES.browserUnavailable,
    `Chromium did not close ghost tab ${tabId}. Retry the close.`,
  );
}

async function retireTabs(tabIds, timeoutMs) {
  const ids = [...tabIds];
  const outcomes = new Array(ids.length);
  if (ids.length === 0) return outcomes;
  const deadline = Date.now() + Math.min(timeoutMs, RETIRE_TOTAL_TIMEOUT_MS);
  let next = 0;
  aggregateRetirementDepth += 1;
  try {
    async function worker() {
      while (next < ids.length) {
        const index = next;
        next += 1;
        const tabId = ids[index];
        if (Date.now() >= deadline) {
          outcomes[index] = {
            status: "rejected",
            reason: failed(
              FAILURES.timeout,
              `The shared browser retirement deadline expired before tab ${tabId} could be closed.`,
            ),
          };
          continue;
        }
        try {
          outcomes[index] = {
            status: "fulfilled",
            value: await retireTab(tabId, timeoutMs, deadline),
          };
        } catch (reason) {
          outcomes[index] = { status: "rejected", reason };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(RETIRE_CONCURRENCY, ids.length) }, () => worker()),
    );
  } finally {
    aggregateRetirementDepth -= 1;
  }
  return outcomes;
}

export function sweepRetiredTabs() {
  if (sweepInFlight !== null) return sweepInFlight;
  const attempt = (async () => {
    const retired = [...state.retired];
    const owned = [];
    for (const session of retired) {
      owned.push(...(state.sessions.get(session) ?? []));
    }
    await retireTabs(owned, RETIRED_SWEEP_TIMEOUT_MS);
    await serializeOwnership(async () => {
      let changed = false;
      for (const session of [...state.retired]) {
        if ((creatingSessions.get(session) ?? 0) > 0) continue;
        if ((state.sessions.get(session)?.size ?? 0) > 0) continue;
        state.retired.delete(session);
        rememberRecentRetirement(session);
        ownershipGeneration += 1;
        changed = true;
      }
      if (changed || owned.length > 0) await persistOwnership();
    });
  })().finally(() => {
    if (sweepInFlight === attempt) sweepInFlight = null;
  });
  sweepInFlight = attempt;
  return attempt;
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
    void dropTab(tabId);
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

function withApiTimeout(promise, timeoutMs, what) {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const onTimeout = () => reject(
      failed(FAILURES.timeout, `The browser did not finish ${what} in time.`),
    );
    signal.addEventListener("abort", onTimeout, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onTimeout);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onTimeout);
        reject(error);
      },
    );
  });
}

/**
 * The claimed tab this op names, as `args.tab`, or null when it names none we
 * hold. Every page op carries it: the extension holds no global "current" tab,
 * because the socket is shared by every ghost.
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
  let tab;
  try {
    tab = await liveTabOrNull(tabId);
  } catch (error) {
    throw failed(
      FAILURES.browserUnavailable,
      `Could not verify tab ${tabId}: ${error?.message ?? error}. Retry the browser action.`,
    );
  }
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
 * The asking ghost-wide owner's tabs, with the metadata `tabSnapshot` can see.
 * `active` marks the one it drives, which is that owner's answer alone. One
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
  // A protocol owner sees the tabs its ghost opened. The popup asks with no
  // owner id and sees them all, because that view belongs to the machine owner.
  const ids = session === null
    ? [...state.tabs.keys()]
    : [...(state.sessions.get(session) ?? [])];
  const snapshots = await Promise.all(ids.map((id) => tabSnapshot(id, targets)));
  const out = [];
  for (const [index, id] of ids.entries()) {
    const snapshot = snapshots[index];
    if (!snapshot) {
      await dropTab(id);
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
  await tryDetach(tabId);
}

async function ensureAttached(args) {
  const tabId = requireTab(args);
  const tab = state.tabs.get(tabId);
  if (tab.pendingDetach) {
    throw failed(
      FAILURES.browserUnavailable,
      `Tab ${tabId} is still cleaning up an older debugger attachment. Try again shortly.`,
    );
  }
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
    await dropTab(tabId);
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
    await dropTab(tabId);
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
    // machine owner, and several ghosts may be holding tabs at once.
    return {
      attached: entry?.attached === true,
      banned: entry?.banned === true,
      // No protocol owner: this is the popup, whose view is every ghost tab.
      tabs: await tabInfos(null, tabId),
    };
  },

  async current(args) {
    const tabId = claimedTab(args);
    if (tabId === null) return { page: null };
    const tab = await tabSnapshot(tabId);
    if (!tab) {
      await dropTab(tabId);
      return { page: null };
    }
    const url = tab.url ?? "";
    if (url === "" || url === "about:blank") return { page: null };
    return { page: { url, title: tab.title ?? "" } };
  },

  async open(args, timeoutMs) {
    const session = requireOwningSession(args);
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
      try {
        tab = await chrome.tabs.update(tabId, { url });
      } catch (error) {
        if (!noSuchTab(error, tabId)) {
          throw failed(
            FAILURES.navigationFailed,
            `Chromium would not navigate tab ${tabId}: ${error?.message ?? error}`,
          );
        }
        await dropTab(tabId);
      }
      if (!tab && state.tabs.has(tabId)) {
        throw failed(
          FAILURES.browserUnavailable,
          `Chromium returned no status while navigating tab ${tabId}. Retry open.`,
        );
      }
      // Navigating tears down whatever isolated world we had on the old document.
      if (tab) clearWorld(tabId);
    }
    if (!tab) {
      tab = await createClaimedTab(session, { url, active: true }, timeoutMs);
      tabId = tab.id;
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
    // `active` is this ghost workspace's tab, not a browser-wide one.
    const caller = claimedTab(args);

    if (op === "list") {
      return tabsAnswer(args.session, caller);
    }

    if (op === "create") {
      const session = requireOwningSession(args);
      const url = typeof args.url === "string" ? args.url.trim() : "";
      // The session layer vets a create URL like an open; recheck the scheme here
      // too, unless it is the blank page a tab may legitimately start on.
      if (url !== "" && url !== "about:blank" && !/^https?:\/\//i.test(url)) {
        throw failed(FAILURES.blockedUrl, "The relay only opens http and https URLs.");
      }
      const tab = await createClaimedTab(
        session,
        { ...(url === "" ? {} : { url }), active: true },
        timeoutMs,
      );
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
      throw failed(
        FAILURES.invalidInput,
        `${args.id ?? "(no id)"} is not one of this ghost browser workspace's tabs. `
          + "Run tabs list to get a current tab id.",
      );
    }

    if (op === "switch") {
      // Switching re-points this ghost workspace only; the tab keeps whatever
      // attachment and isolated world it already had, so another ghost's refs survive.
      await chrome.tabs.update(id, { active: true }).catch(() => {});
      return { ...(await tabsAnswer(args.session, id)), page: await summary(id) };
    }

    if (op === "close") {
      await retireTab(id, timeoutMs);
      const active = id === caller ? null : caller;
      return {
        ...(await tabsAnswer(args.session, active)),
        ...(active === null ? {} : { page: await summary(active) }),
      };
    }

    throw failed(FAILURES.invalidInput, `Unknown tabs op "${op}".`);
  },

  async close(args, timeoutMs) {
    // Ghost-workspace teardown closes every tab this protocol owner opened, not
    // just the one it was last driving: `tabs create` re-points the caller, and
    // without this the tabs it moved off would be left in the owner's browser
    // with nothing owning them. Other ghosts keep their tabs, and the browser
    // keeps the rest of the owner's day in it.
    const session = requireOwningSession(args);
    let retirementError = null;
    let needsRetirement = false;
    await serializeOwnership(async () => {
      needsRetirement = state.retired.has(session)
        || (state.sessions.get(session)?.size ?? 0) > 0
        || (creatingSessions.get(session) ?? 0) > 0;
      if (!needsRetirement) {
        rememberRecentRetirement(session);
        return;
      }
      if (!state.retired.has(session)) {
        if (state.retired.size >= MAX_STORED_RETIRED) {
          void sweepRetiredTabs().catch(() => {});
          throw failed(
            FAILURES.browserUnavailable,
            `The relay is still retiring ${MAX_STORED_RETIRED} older ghost browser workspaces. `
              + "Retry close after its automatic cleanup.",
          );
        }
        state.retired.add(session);
        ownershipGeneration += 1;
      }
      try {
        await persistOwnership();
      } catch (error) {
        retirementError = error;
      }
    });
    if (!needsRetirement) return { closed: false };

    const owned = [...(state.sessions.get(session) ?? [])];
    const outcomes = await retireTabs(owned, timeoutMs);
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected"
        ? [{ tab: owned[index], message: outcome.reason?.message ?? String(outcome.reason) }]
        : []);
    if (retirementError !== null || failures.length > 0) {
      try {
        await serializeOwnership(() => persistOwnership());
      } catch (error) {
        retirementError ??= error;
      }
      throw failed(
        FAILURES.browserUnavailable,
        `Ghost browser workspace release needs retry: ${failures.length} of ${owned.length} tabs `
          + `remain uncertain${retirementError === null
            ? "."
            : "; its retirement marker was not saved."} Retry close.`,
        {
          tabs: failures,
          ...(retirementError === null
            ? {}
            : { retirement: retirementError?.message ?? String(retirementError) }),
        },
      );
    }
    try {
      await sweepRetiredTabs();
    } catch (error) {
      throw failed(
        FAILURES.browserUnavailable,
        `Ghost browser workspace release needs retry: its completed retirement could not be `
          + `saved: ${error?.message ?? error}. Retry close.`,
      );
    }
    return { closed: outcomes.some((outcome) => outcome.status === "fulfilled" && outcome.value) };
  },

};

/**
 * Drop every debugger session without closing a tab. The socket going away means
 * every ghost workspace behind it is offline, but the tabs are the owner's to
 * keep; a reconnecting backend still names the same tab and re-attaches next op.
 */
export async function releaseAllTabs() {
  const attached = [];
  for (const [tabId, tab] of state.tabs) {
    if (tab.attached) attached.push(tabId);
    else resetAttachment(tab);
  }
  await Promise.all(attached.map(async (tabId) => {
    if (!await tryDetach(tabId)) return;
    const tab = state.tabs.get(tabId);
    if (tab) resetAttachment(tab);
  }));
}

/** Retry every durability repair that a timed-out Chrome storage write left pending. */
export async function repairBrowserPersistence() {
  let repairFailed = false;
  for (const attempt of [
    attemptOwnershipRepair,
    attemptPoisonRepair,
    attemptIncarnationRepair,
  ]) {
    try {
      await attempt();
    } catch {
      repairFailed = true;
    }
  }
  if (repairFailed || browserPersistenceRepairPending()) {
    throw failed(
      FAILURES.browserUnavailable,
      "Browser ownership recovery is not durable yet. Browser work remains paused while the relay retries automatically.",
    );
  }
}

export function startOp(op, args, timeoutMs) {
  const handler = ops[op];
  if (!handler) {
    throw failed(FAILURES.invalidInput, `The relay extension does not implement "${op}".`);
  }
  const session = typeof args?.session === "string" && args.session !== ""
    ? args.session
    : null;
  if (session !== null && isRetired(session) && op !== "close") {
    throw failed(
      FAILURES.browserUnavailable,
      RELEASED_WORKSPACE_MESSAGE,
    );
  }
  if (browserPersistenceRepairPending() && op !== "close" && op !== "status") {
    throw failed(
      FAILURES.browserUnavailable,
      "Browser ownership recovery is not durable yet. Retry after the relay finishes its automatic repair.",
    );
  }
  if (ownershipPoison.size > 0 && op !== "close" && op !== "status") {
    const tab = ownershipPoison.keys().next().value;
    throw failed(
      FAILURES.browserUnavailable,
      `Browser ownership of tab ${tab} is indeterminate. Retry the ghost browser workspace `
        + "close before any other browser action.",
    );
  }
  const budget = Math.max(1_000, timeoutMs || 30_000);
  // The relay protocol has a request deadline but no cancellation frame, and
  // chrome.debugger.sendCommand has no AbortSignal. Bound the response lifecycle
  // here so even ops made of several CDP calls answer on time. The late Chrome
  // promise remains observed by Promise.race; it is not falsely presented as a
  // transport cancellation.
  const completion = handler(args ?? {}, budget);
  return {
    response: withTimeout(completion, budget, `running ${op}`),
  };
}

export async function runOp(op, args, timeoutMs) {
  return startOp(op, args, timeoutMs).response;
}
