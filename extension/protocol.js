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
export const PROTOCOL_VERSION = 4;

// The handshake name, deliberately frozen while PROTOCOL_VERSION moves: it
// identifies the socket, and the `hello`/`welcome` exchange negotiates the
// version. Renaming it would unpair every installed browser.
export const SUBPROTOCOL = "ghost-relay.v1";
export const TOKEN_SUBPROTOCOL_PREFIX = "ghost-token.";
export const RELAY_PATH = "/relay";

/**
 * Every operation this extension will perform — a closed set, kept in lockstep
 * with the daemon's `RELAY_OPS` and its `RelayBrowserBackend` methods (a test in
 * `packages/daemon/test/relay-extension.test.ts` asserts this array and the ops.js
 * handlers still agree).
 *
 * There is exactly one script-running op, `javascript`, and it is deliberate:
 * the owner's ghost, on the owner's machine, may run page script
 * through CDP `Runtime.evaluate`. It is the only op that carries a code string;
 * every other verb is a fixed action the extension implements itself, so a
 * compromised daemon socket still cannot smuggle script through, say, `find`.
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
  "forward",
  "scroll",
  "drag",
  "key",
  "javascript",
  "console",
  "network",
  "upload",
  "resize",
  "tabs",
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
