# Ghost browser relay (Chromium extension)

The ghost drives **tabs it created in the browser you are already signed into**.
Every page operation names the tab it acts on. Each ghost has one browser
workspace shared by its conversations and may own several tabs; another ghost's
workspace remains separate. One extension serves them all over one socket without
their attachments or isolated worlds colliding.

This is the only browser a ghost has. There is no second profile to fall back to,
so until this extension pairs, browser calls fail and say so; if Chromium is not
running, the ghost starts it from the shell like anything else. That is the point:
the pages the ghost works on are your session — read
the thing behind the login, fill the form on the site that knows who you are,
check the dashboard you never log out of.

## How it fits together

```
ghost tool call
  → GhostBrowserSession        url policy, ref bookkeeping, read budget, idle timer
    → RelayBrowserBackend      packages/extensions/.../browser-relay-backend.ts
      → RelayHub               packages/daemon/src/relay.ts, ws://127.0.0.1:7717/relay
        → this extension       background.js dials OUT, ops.js drives the named tab
          → chrome.debugger    real CDP input into a ghost-owned tab
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
only after a compatible ghostd has answered the protocol handshake, `||` when
that authenticated connection is paused, and `off` otherwise.

The current relay protocol is 4. An older daemon or extension is refused
before either side accepts browser work; update the older Ghost package. The
extension probes again after a one-minute cool-down, or reload it from
`chrome://extensions` to retry immediately after updating either side.

The token lives at `$XDG_STATE_HOME/ghost/relay-token` (default
`~/.local/state/ghost/relay-token`), mode `0600`.
The pasted copy lives in Chromium's profile under `chrome.storage.local`;
Chromium owns that on-disk layout and the extension cannot assign it a separate
POSIX mode. Anyone who can read the browser profile should be treated as able to
recover the relay token. It authorizes only this loopback relay, not the daemon
HTTP API, and `--rotate` invalidates both copies immediately.

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
| One connection at a time | A second browser driving the same tabs behind this one's back. |
| Closed, validated op set | Arbitrary CDP frames and script hidden in another verb; `javascript` remains one explicit capability. |

And on the extension side:

- **No `tabs`, no `activeTab`, no `host_permissions`, no `chrome.scripting`, no
  content scripts.** The required `debugger` permission can enumerate target
  URL/title metadata even before attachment; the relay uses that capability only
  to describe and validate tab ids it created. Page content and actions require
  an attached debugger session, where Chrome draws its own un-suppressable "is
  being debugged" banner. Dismissing that banner detaches the debugger and locks
  the relay out of the tab until it navigates.
- **Only tabs created by the ghost.** It never adopts a tab you opened. The
  `tabs` operation can create, select, or close one of those tabs. Conversations
  of the same ghost share that workspace; terminal ghost teardown attempts every
  tab in it, leaving other ghosts' tabs and the browser itself open.
- **Pause** in the popup refuses every request instantly, without unpairing.
- The extension re-checks the URL scheme itself: it does not have to trust the
  daemon in order to be safe to install.

What this does *not* protect against:

- The ghost is genuinely acting as you, in your session, with your cookies. That
  is the feature. Pause in the popup, or close the tab, for anything you would
  not do yourself.
- **DNS rebinding.** Ghost resolves a hostname and checks the answers before it
  navigates, but the browser resolves it again independently. A short-TTL name
  that answers publicly to the daemon and `127.0.0.1` to Chromium will load.
- **Subresources.** Only the URL the ghost asks for is checked. A public page's
  own `fetch`, XHR, and iframes are never seen by Ghost, so a page can reach
  private-network addresses from inside your browser.
- **Redirects that already fired.** A redirect to a private address is caught
  when Ghost rechecks where it landed, so the ghost cannot read the response —
  but the request was already made, with your cookies.

The backend that could enforce these per-request — a browser Ghost launched and
proxied — was removed on purpose. Restoring them belongs here, in the extension,
which already has `chrome.debugger` and could pause requests with `Fetch.enable`;
that is a deliberate not-yet, not an oversight.

## Files

| File | What it is |
| --- | --- |
| `extension/manifest.json` | MV3. Permissions: `debugger`, `storage`, `alarms`. That is all. |
| `extension/icons/` | Chrome's required icon sizes, derived from the same Lucide ghost mascot and amber token as the shell. |
| `extension/background.js` | The outbound socket, reconnect loop, MV3 keepalive, frame dispatch. |
| `extension/ops.js` | The 20 protocol operations against ghost-owned tabs; the per-tab `chrome.debugger` attach state machine. |
| `extension/page-scripts.js` | The snippets that run inside the page (read, find, resolve, focus-and-clear). |
| `extension/protocol.js` | Frame shapes and the failure vocabulary; mirrors the TypeScript side. |
| `extension/popup.{html,js}` | Status, pairing, pause. |

No build step. It is plain ES modules; edit and hit reload in `chrome://extensions`.

Each relay request carries a deadline. The extension applies it around the whole
operation and drops a late result if the socket that requested it has gone away.
Chromium's `chrome.debugger.sendCommand()` Promise has no cancellation signal,
and the relay protocol has no cancel frame, so a deadline bounds the reply but
does not claim to abort a CDP command already accepted by Chromium. A terminal
Ghost-workspace close first publishes a durable retirement marker, then makes bounded
attempts against every known tab. Late tab creation observes that marker and
removes itself; uncertain removals remain owned and are retried by the keepalive
alarm even after ghostd has rotated to a fresh browser owner id. Tombstones are
discarded only once no late create handler can still produce a tab. Chrome
settings and ownership storage calls are bounded as well, so one silent API call
cannot pin the reconnect loop or extension popup indefinitely.

Each ghostd process also announces a fresh incarnation in the protocol-4
welcome. The extension retires claims left by an earlier crashed process before
it sends hello or accepts new work; an ordinary reconnect to the same process
keeps the ghost's workspace intact.

## Element refs

`find` mints `e1`, `e2`, … without writing attributes or expandos onto the
owner's DOM. Its isolated world keeps element → ref in a `WeakMap` and ref →
element in a `Map` of `WeakRef` records. Resolution is an O(1) lookup followed by
identity and tag checks: a collected, different, or tag-changed node cannot take
over a ref. A page can still semantically change the same surviving same-tag
element, as with any live DOM. Each `find` replaces the registry, and navigation
destroys the isolated world; only refs from the current results on the current
document resolve.

The relay keeps `find` bounded by walking at most 10,000 elements and returning
at most 100. Its CSS-selector path deliberately rejects `:scope`, the CSS nesting
selector `&`, CSS comments, and CSS escapes outside quoted strings: those forms
can change token identity or document scoping in ways a lazy per-element match
cannot reproduce without a full CSS parser. Quoted attribute values remain
opaque, so selectors such as `[data-label=":scope"]` and `[data-label="&"]`
still work. Use an ordinary selector or visible text for the rejected forms.

## Provenance

The icon assets are raster sizes of Lucide's ISC-licensed `ghost` glyph, already
used as the shell mascot, in the shell's fixed `ghostAmber` brand colour. The
required copyright and permission text is in the root
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md#lucide).

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
| "Browser ownership … is indeterminate" | A storage failure interrupted tab creation. Close the named ghost-created tab; the relay retries automatically. |
| "Chromium refused to attach its debugger" | DevTools is open on that tab, or another extension is debugging it. |
| Worked, then stopped after a while | You dismissed the debugger banner. It recovers when the tab navigates. |
