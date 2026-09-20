# The relay protocol

The seam between this extension and Ghost's daemon. Neither side imports the
other's source; this file and `protocol.js` are the contract, and
`PROTOCOL_VERSION` is the only thing that ties an extension release to a Ghost
release.

The daemon's mirror of these constants lives in its `relay-protocol.ts`, and its
conformance test reads the installed extension and compares them value by value.
Set `GHOST_CHROMIUM_EXTENSION_DIR` to point that test at a copy elsewhere.

## Transport

The extension dials out; the daemon listens. A service worker cannot accept a
socket, and dialing out is also what makes restarts survivable in either order.

```
ws://127.0.0.1:<port>/relay
subprotocols: ["ghost-relay.v1", "ghost-token.<token>"]
          or: ["ghost-relay.v1", "ghost-pair.<six digits>"]
```

`ghost-relay.v1` is frozen: it names the socket, and the version is negotiated
in the handshake. The credential rides in the subprotocol list because that is
the only header a browser `WebSocket` lets a caller set, and it keeps the token
out of anything that logs URLs.

## Handshake

| Frame | Direction | Meaning |
| --- | --- | --- |
| `welcome` | daemon → extension | `{ protocol, incarnation }`. A protocol the extension cannot speak is closed with 4000 and retried after a minute, not redialed. |
| `hello` | extension → daemon | `{ protocol, agent, browser }`, sent only after the extension has retired any claims left by a previous daemon process. |
| `ping` | extension → daemon | An `event` every 20s. Not liveness: it is what keeps Chrome from reaping the service worker between two tool calls. |

An unpaired browser offers a six-digit code instead of a token. The daemon holds
it until the owner allows it in the HUD or with `ghost browser allow`, then
answers with `paired` carrying the token. Close code 4001 is a denial (the
extension stops asking until the owner presses **Try again**); 4002 means the
code expired or was replaced, and a fresh one is minted.

## Requests

```
→ { t: "req", id, op, args, timeoutMs }
← { t: "res", id, ok: true, result }
← { t: "res", id, ok: false, error: { failure, message, details? } }
```

`op` is one of the closed set in `protocol.js`; anything else is
refused as `invalid_input`. `failure` is one of the eight names in that same
file — a name the daemon does not recognise is downgraded to
`navigation_failed`, so getting one wrong loses a detail rather than breaking a
tool. Each request carries its own deadline, which bounds the reply; there is no
cancel frame, and the extension does not pretend a late CDP command was aborted.

`args.session` is the browser workspace the request acts in: the daemon sends a
`randomUUID()` per ghost, and `close` retires that id permanently. Tabs are
isolated per workspace, and a workspace never sees another's tabs.

## What is not on the wire

The side panel's own agent uses the same ops through the same `ops.js`, in a
workspace whose id starts with `local:` (see `local-session.js`). It
never opens a socket, its workspace is stamped by the service worker rather than
chosen by the caller, and a request from either side naming the other side's tab
is refused by name. A daemon restart retires the claims of the daemon process
that made them and leaves the panel's workspace alone.

Two shapes are deliberately not wire shapes: the popup's all-workspaces tab list
(`allTabInfos`, which carries a `local` flag) and the local-op messages the side
panel sends the service worker. Both are in-process and extension-internal.
