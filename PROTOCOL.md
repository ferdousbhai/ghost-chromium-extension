# Relay protocol seam

This package is a separate product from the Ghost daemon. The two meet only
at the relay WebSocket protocol documented here; neither side imports the
other's source.

## The two mirrors

- Extension side: [`extension/protocol.js`](extension/protocol.js) —
  `PROTOCOL_VERSION`, `SUBPROTOCOL`, the token/pair subprotocol prefixes,
  `RELAY_PATH`, the closed `OPS` set, and the `FAILURES` vocabulary.
- Daemon side: `packages/daemon/src/relay-protocol.ts` plus
  `packages/extensions/src/extensions/browser-relay-backend.ts` in the Ghost
  checkout — the same constants in TypeScript.

The mirrors are plain duplication, not a dependency: an MV3 service worker
cannot reach into a package manager workspace, and this extension ships with
no build step. The duplication is held honest by
`packages/daemon/test/relay-extension.test.ts` in the Ghost checkout, which
imports `extension/protocol.js` straight into Node (it carries no `chrome`
API) and asserts every constant still agrees. That test reads the installed
copy at `$GHOST_CHROMIUM_EXTENSION_DIR`, defaulting to the sibling checkout
while the sources travel together.

## Compatibility rule

`PROTOCOL_VERSION` bumps when a frame shape changes incompatibly; the
`hello`/`welcome` exchange negotiates it and an older peer is refused before
either side accepts browser work. The handshake name (`SUBPROTOCOL`) stays
frozen across bumps: renaming it would unpair every installed browser.

Package versions (`package.json`, `extension/manifest.json`) move
independently of Ghost releases. Only `PROTOCOL_VERSION` ties the two
products together.
