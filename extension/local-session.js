/**
 * Which side owns a browser workspace.
 *
 * The extension serves two callers over one set of tab verbs: a ghost in ghostd,
 * reached over the relay socket, and the side panel's own agent, running on the
 * owner's OpenRouter account. Both name their workspace with the same `session`
 * field that `ops.js` already isolates on, so neither needs a second tab backend
 * — but a workspace id has to say which side minted it, for two reasons:
 *
 *   1. A refusal can then name the owner. Pointing local chat at a ghost's tab
 *      (or the reverse) is a mistake worth explaining, where one ghost naming
 *      another ghost's tab is just an unknown tab id.
 *   2. A ghostd restart retires the claims of the ghostd process that made
 *      them. The local chat's tabs are not ghostd's to retire.
 *
 * Ghost workspace ids are `randomUUID()` from the daemon, so the prefix below
 * cannot collide with one.
 */

/** The marker that makes a workspace id the side panel's rather than a ghost's. */
export const LOCAL_SESSION_PREFIX = "local:";

export function isLocalSession(session) {
  return typeof session === "string" && session.startsWith(LOCAL_SESSION_PREFIX);
}

/**
 * A fresh local workspace. Minted like the daemon mints one: a `close` retires
 * an id permanently, so starting a new chat means starting a new id.
 */
export function newLocalSession() {
  return LOCAL_SESSION_PREFIX + crypto.randomUUID();
}

/** What to call a workspace's owner in a message the other side will read. */
export function sideName(session) {
  return isLocalSession(session)
    ? "this browser's local chat"
    : "a ghost's browser workspace";
}
