/**
 * The relay wire protocol, extension side.
 *
 * This is the mirror of `packages/daemon/src/relay-protocol.ts` and
 * `packages/extensions/src/extensions/browser-relay-backend.ts`. It is duplicated
 * rather than imported because an MV3 service worker cannot reach into a pnpm
 * workspace and this extension deliberately has no build step — you load the
 * directory and it runs. The duplication is held honest by a test
 * (`packages/daemon/test/relay-extension.test.ts`) that reads this file and
 * asserts the constants still agree with the TypeScript ones.
 */

/** Bumped when a frame shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

export const SUBPROTOCOL = "ghost-relay.v1";
export const TOKEN_SUBPROTOCOL_PREFIX = "ghost-token.";
export const RELAY_PATH = "/relay";

/**
 * Every operation this extension will perform. A closed set: there is no "run
 * this script" op, so a daemon that got compromised still cannot execute
 * arbitrary code in the pages you are signed into.
 */
export const OPS = [
  "status",
  "current",
  "open",
  "read",
  "find",
  "click",
  "type",
  "screenshot",
  "back",
  "close",
];

/**
 * The failure vocabulary. Identical to `BrowserFailure` in the extensions
 * package; a failure name the daemon does not recognize is downgraded to
 * `navigation_failed` on arrival, so getting one wrong is a lost detail rather
 * than a broken tool.
 */
export const FAILURES = {
  browserUnavailable: "browser_unavailable",
  blockedUrl: "blocked_url",
  navigationFailed: "navigation_failed",
  timeout: "timeout",
  noPage: "no_page",
  unknownRef: "unknown_ref",
  elementNotFound: "element_not_found",
  invalidInput: "invalid_input",
  forbiddenScope: "forbidden_scope",
};

/** A failure that should travel back to the ghost as a structured refusal. */
export class RelayOpError extends Error {
  constructor(failure, message, details) {
    super(message);
    this.name = "RelayOpError";
    this.failure = failure;
    this.details = details;
  }
}

export const failed = (failure, message, details) =>
  new RelayOpError(failure, message, details);

/** Anything that is not a `RelayOpError` is a bug here, not a page problem. */
export function toErrorFrame(id, error) {
  if (error instanceof RelayOpError) {
    return {
      t: "res",
      id,
      ok: false,
      error: {
        failure: error.failure,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    t: "res",
    id,
    ok: false,
    error: {
      failure: FAILURES.navigationFailed,
      message: `The Ghost relay extension failed: ${error?.message ?? String(error)}`,
    },
  };
}
