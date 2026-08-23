# Ghost browser relay (Chromium extension)

"My browser" mode: the ghost drives **one tab of the browser you are already
signed into**, instead of a separate profile of its own.

The other mode — "Ghost's browser", a dedicated Playwright Chromium profile under
the ghost home — stays the default and is the right choice for anything
autonomous. This one exists for the jobs where the point *is* your session: read
the thing behind the login, fill the form on the site that knows who you are,
check the dashboard you never log out of.

## How it fits together

```
ghost tool call
  → GhostBrowserSession        url policy, ref bookkeeping, read budget, idle timer
    → RelayBrowserBackend      packages/extensions/.../browser-relay-backend.ts
      → RelayHub               packages/daemon/src/relay.ts, ws://127.0.0.1:7717/relay
        → this extension       background.js dials OUT, ops.js drives the tab
          → chrome.debugger    real CDP input into a real tab
```

The extension **dials out**. A service worker cannot listen on a socket, so
ghostd is the server. Nothing has to start in a particular order: ghostd restarts
and the extension reconnects, Chromium closes and the relay simply reports as
disconnected.

## Install

```sh
packages/chromium-extension/contrib/install.sh        # copy to ~/.local/share/ghost/
packages/chromium-extension/contrib/install.sh --link # symlink, for hacking on it
```

Then, in the browser you actually use: `chrome://extensions` → Developer mode →
**Load unpacked** → the printed directory.

There is deliberately no attempt to install into your running browser
automatically. `--load-extension` only applies to a process started with it, and
Chrome ≥ 137 ignores it for the default profile without a policy allowlist —
which means any script claiming to do it either restarts your browser or edits
your profile behind your back. Four clicks, once, is the honest version.

On Omarchy the relevant browser is the `chromium` package (`sudo pacman -S
chromium`); the extension also works in Chrome and Brave. It needs Chrome ≥ 125
for flat `chrome.debugger` sessions.

## Pair

```sh
ghostd relay-token          # prints the token, minting one on first run
ghostd relay-token --rotate # mint a new one; the old one stops working
```

Click the extension, paste the token, **Save & connect**. It is kept in
`chrome.storage.local`, so this is a once-per-browser step. The badge reads `on`
when it is paired and ghostd is up, `||` when you have paused it, `off` otherwise.

The token lives at `$XDG_STATE_HOME/ghost/relay-token` (default
`~/.local/state/ghost/relay-token`), mode `0600`.

## The security model

The daemon's other routes have their own bearer token, read from a `0600` file
by clients that can read files (CONTRACTS.md). The relay cannot borrow that
secret, because the peer is a *browser*: pairing means pasting a token into an
extension popup, which puts it somewhere you do not fully control, and a leak
there must not also hand out the API. Any page you visit can open
`ws://127.0.0.1:7717/relay`. So the relay gets a second token of its own:

| Gate | Stops |
| --- | --- |
| Bound to `127.0.0.1` | Anything off this machine. |
| `Origin` must be `chrome-extension://…` or absent | A web page opening the socket from a tab you are visiting. |
| 32-byte token, compared in constant time | Everything else, including another extension. |
| One connection at a time | A second browser interleaving clicks on the same tab. |
| Closed op set — no `eval` frame | A compromised daemon running arbitrary script in your signed-in pages. |
| Visitor scope refused at the backend *factory* | A visitor conversation ever reaching this at all. |

And on the extension side:

- **No `host_permissions`, no `chrome.scripting`, no content scripts.** The
  extension has *no standing access to any page*. It can only read or act on a
  page while `chrome.debugger` is attached — and Chrome draws its own
  un-suppressable "is being debugged" banner across any tab in that state. Your
  evidence that the ghost is looking is a browser-drawn banner, not our promise.
  Dismissing that banner detaches the debugger and locks the relay out of the tab
  until it navigates.
- **One tab, created by the ghost.** It never touches a tab you opened. `close`
  closes that tab; the browser stays open.
- **Pause** in the popup refuses every request instantly, without unpairing.
- The extension re-checks the URL scheme itself: it does not have to trust the
  daemon in order to be safe to install.

What this does *not* protect against: the ghost is genuinely acting as you, in
your session, with your cookies. That is the feature. Use "Ghost's browser" mode
for anything you would not do yourself.

## Files

| File | What it is |
| --- | --- |
| `extension/manifest.json` | MV3. Permissions: `debugger`, `tabs`, `storage`, `alarms`. That is all. |
| `extension/background.js` | The outbound socket, reconnect loop, MV3 keepalive, frame dispatch. |
| `extension/ops.js` | The eight verbs against real tabs; the `chrome.debugger` attach state machine. |
| `extension/page-scripts.js` | The snippets that run inside the page (read, find, resolve, focus-and-clear). |
| `extension/protocol.js` | Frame shapes and the failure vocabulary; mirrors the TypeScript side. |
| `extension/popup.{html,js}` | Status, pairing, pause. |

No build step. It is plain ES modules; edit and hit reload in `chrome://extensions`.

## Element refs

`find` mints `e1`, `e2`, … the same way both backends do — but where the
Playwright backend stamps a `data-ghost-ref` attribute, this one sets a JavaScript
expando (`element.__ghostRef`). These are your real pages, mid-session: an
attribute can match a CSS selector, trip a `MutationObserver`, or desync a
framework's vdom. An expando is invisible to all of that and gone when the
document is replaced. Resolution is a linear scan for the expando, open shadow
roots included. (The technique is Playwright's `_ariaRef`, via oh-my-pi.)

Refs are invalidated by the session layer on navigation, exactly as in the other
backend, so `e3` never means two different things.

## Provenance

The relay shape — MV3 extension dialing out over WebSocket, the reconnect and
service-worker-keepalive loop, the `attached`/`banned`/`attaching` attach state
machine with ban-on-failure and clear-on-navigation, the viewport-clipped
`elementFromPoint` actionability probe — is ported from the MIT-licensed
`browser-relay` package in [oh-my-pi](https://github.com/can1357/oh-my-pi). No
code is vendored: their server half is Bun-only and their protocol is raw CDP
rather than the semantic verbs used here.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Badge stays `off` | ghostd is not running, or the port is wrong. The popup says which. |
| "That pairing token is not this daemon's" | Token rotated, or `$XDG_STATE_HOME` differs between the shell and the daemon. Re-run `ghostd relay-token`. |
| "A browser is already connected" | Another Chromium profile has the extension paired. Only one at a time. |
| "Chromium refused to attach its debugger" | DevTools is open on that tab, or another extension is debugging it. |
| Worked, then stopped after a while | You dismissed the debugger banner. It recovers when the tab navigates. |
