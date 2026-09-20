# Privacy policy

**Ghost** (the Chromium extension). Last updated 2026-09-20.

This extension has no servers. There is no account to create, nothing is synced,
and its publisher receives no data from it — no telemetry, no analytics, no
crash reports, no usage counts.

## What it stores, and where

Everything it stores lives in your own browser profile on your own computer,
in the extension's own storage:

| Stored | Where | Why |
| --- | --- | --- |
| The OpenRouter key its OAuth sign-in minted for this browser | `chrome.storage.local` | To call OpenRouter as you, if you connect side-panel chat. You never see or type it. |
| The model you picked | `chrome.storage.local` | So the next chat starts where you left off. |
| Your conversations and the agent's steps in each | `chrome.storage.local` | So the side panel's history still shows them when you reopen it. Screenshots are not stored. |
| The relay token and port | `chrome.storage.local` | To reconnect to a ghost on this machine, if you pair with one. |
| Which tabs the extension opened | `chrome.storage.session` (cleared when the browser exits) | So it can find them again after the extension restarts, and close them when you ask. |
| A pending pairing code, or a pending sign-in secret | `chrome.storage.session` | So a code or sign-in you started survives the extension restarting mid-way. |

Nothing is stored anywhere else. Clearing the extension's data, or removing the
extension, removes all of it. **Disconnect OpenRouter** in the side panel's menu
deletes the key; **Delete this conversation** removes it and closes the tabs it
opened.

## What leaves your browser

Two destinations, both of your choosing, and nothing else:

1. **`https://openrouter.ai`** — only if you connect side-panel chat. It
   receives your key, your messages, the page text, console lines, network
   entries, and screenshots the agent gathered from tabs it opened, and the list
   of actions available to it. That is what makes a reply possible. OpenRouter's
   handling of it is governed by their privacy policy, and by the model routing
   you choose there.
2. **`ws://127.0.0.1:<port>`** — only if you pair with a ghost. This is a
   loopback socket to a program running on the same computer. It never leaves
   the machine.

If you use neither, nothing leaves your browser at all.

## What it can see

The extension acts only in tabs it opened itself, through Chrome's debugger
protocol — which is why Chrome shows its own "is being debugged" banner across
any tab it is working in. It never attaches to a tab you opened, and it has no
content scripts and no permission over the pages you visit. Dismissing Chrome's
banner detaches it immediately.

It does act as you, in your signed-in session, in the tabs it opened: that is
the point of the product, and the reason for the pause switch in its menu,
which refuses everything instantly without disconnecting anything.

## Page JavaScript

One operation runs JavaScript inside a page. In side-panel chat, it asks you
first, every time, and shows you the exact code. There is no "always allow".

## Sensitive data

The extension does not collect, and cannot be configured to report, health,
financial, authentication or location data to its publisher. If you ask the
agent to work a page containing such data, that page's text goes to OpenRouter
like any other page you asked about. Do not point it at anything you would not
send there.

## Contact

Questions and reports: https://github.com/ferdousbhai/ghost-chromium-extension/issues
