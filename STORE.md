# Chrome Web Store listing kit

The single purpose, in the store's words: a relay that lets the owner's
local Ghost agent drive tabs it created in the browser the owner is signed
into. One extension, one loopback connection, no remote servers.

## Listing fields

- **Name:** Ghost browser relay
- **Short description (127 chars):** Let your local Ghost agent work tabs in
  the browser you're signed into — read, click, type, and screenshot,
  supervised by you.
- **Category:** Productivity
- **Homepage:** https://github.com/ferdousbhai/ghost-chromium-extension
- **Privacy policy:**
  https://github.com/ferdousbhai/ghost-chromium-extension/blob/main/PRIVACY.md

## Full description

The ghost drives **tabs it created in the browser you are already signed
into**. Read the page behind your login, fill the form on the site that
knows you, check the dashboard you never log out of — the agent works where
you work, under your eyes.

- Every operation names its tab. Each agent gets one workspace; other agents'
  workspaces stay separate.
- Chrome shows its own debugger banner while a tab is driven, and the popup
  names the agent's tabs. Pause any time: every request is refused until you
  resume.
- Pairing is by eye: the extension shows a six-digit code, you Allow that
  exact code, and only then does it receive its token. Nothing to copy, no
  account, no cloud.
- No analytics, no trackers, no remote code. The full privacy policy is one
  page: PRIVACY.md in the linked repository.

## Permission justifications (paste into the submission)

- `debugger`: the product. Attaches only to tabs the agent opened, to send
  real input and take captures through CDP; Chrome brands attached tabs with
  its own banner. There are no host permissions and no content scripts.
- `storage`: holds the relay token and the port/on-off settings locally.
- `alarms`: schedules reconnects and expires unanswered pairing codes.

## Assets

- [x] 128px icon — `extension/icons/ghost-128.png` (16/32/48 ship too)
- [ ] Screenshots, 1280×800 or 640×400 — at least one: the popup paired
  (`on` badge), the popup showing a pairing code, a driven tab with the
  Chrome debugger banner visible
- [ ] Small promo tile, 440×280 — ghost mark plus the name, nothing else

## Reviewer notes (paste into the submission)

No account or local agent is needed to exercise the extension: install it and
the popup works immediately — pairing-code state, settings including the
port, and pause/resume. To see it drive tabs, run the open-source hub
(`ghostd` in `ferdousbhai/ghost`), pair the six-digit code, and issue a
browser operation; the driven tab carries Chrome's own debugger banner.

## Release steps

1. Bump `package.json` and `extension/manifest.json` to the same version
   (`test/manifest.test.mjs` refuses a mismatch).
2. `node --test test/*.test.mjs`
3. `contrib/package.sh` — uploads `/tmp/ghost-chromium-extension-<version>.zip`.
4. Upload the zip as a new version, keep the rollout staged, watch the
   review, then complete the rollout.
