# Privacy policy

Ghost browser relay has one job: let the owner's own local agent program
(`ghostd`, running on the same machine) drive tabs that agent created in this
browser. This policy covers what the extension touches to do that.

## What stays on this machine

- **Page activity, only in agent-owned tabs.** The extension reads, clicks,
  types, and screenshots only tabs the agent opened, and only when the agent
  issues that exact operation. Other tabs are never touched.
- **The relay token and settings.** The pairing token plus the port and
  on/off settings live in `chrome.storage.local` on this device.
- **The relay connection.** The extension opens a WebSocket to
  `127.0.0.1` (this machine) and nothing else.

## What never happens

- No browsing data, page content, tokens, or settings are sent to any remote
  server. The extension contains no analytics, no trackers, no ads, and no
  remote code — every file it runs ships inside the package.
- Nothing is sold, shared, or used for advertising.

## Permissions, and why each exists

- `debugger` — attach to agent-owned tabs and drive real input and captures
  through CDP. Chrome shows its own banner while attached.
- `storage` — keep the relay token and settings locally.
- `alarms` — schedule reconnects and expire unanswered pairing codes.

Questions: the issue tracker at
https://github.com/ferdousbhai/ghost-chromium-extension/issues.
