# Chrome Web Store listing kit

One product, one sentence: **an agent works your tabs**. Everything below tells
that story. A reviewer who comes away thinking there are two products here —
a chat app and a remote-control bridge — has been told it badly; the ghost is
one of the two things that can drive the agent, not a second product.

Build the upload with `contrib/package.sh`. It zips the runtime files at the
repository root — manifest, scripts, pages, icons — and nothing else, with no
build step, so the bytes reviewed are the bytes that run.

## Name

Ghost

## Short description (132 characters max)

> An agent across your tabs, on any OpenRouter model — free ones included. It
> reads the page, then clicks, types, and fills forms.

## Detailed description

> **A helping hand across your tabs — on the model you choose.**
>
> Ghost reads the page you're signed in to, then clicks, types, fills forms,
> and follows links while you decide what happens next. No more copying,
> pasting, and switching tabs: ask it in the side panel and watch it work.
>
> **Any model, your account.** Ghost runs on your own OpenRouter account, so
> the picker lists every model OpenRouter offers that can call tools — Claude,
> GPT, Gemini, Qwen, Llama, DeepSeek and the rest — and you pay OpenRouter's
> rates, nothing more. **Start free:** the default is OpenRouter's free
> router, which picks a capable free model for each request. Every turn shows
> which model answered and what it cost.
>
> **Reach the web that has no API.** Internal tools, admin consoles, portals
> behind your login — if you can open it in a tab, Ghost can work in it.
>
> **You stay in control.** Ghost works only in tabs it opened itself; it
> never touches the tabs you opened, and Chrome shows its own "is being
> debugged" banner in any tab it is working in — dismiss the banner and it is
> locked out until that tab navigates. The one operation that runs JavaScript
> inside a page asks you first, every time, and shows you the code. One
> switch pauses everything, instantly. Conversations are separate, each with
> its own tabs.
>
> **Also a relay for Ghost on your machine.** If you run Ghost
> (github.com/ferdousbhai/ghost) on the same computer, its ghosts can drive
> the same tabs: pair once by matching a six-digit code, over a loopback
> socket that never leaves your machine.
>
> No account with us. No servers of ours. No telemetry. Open source. Sign in
> to OpenRouter once; the credential it issues and your conversations stay in
> this browser's local storage.

## Category

Workflow & Planning

## Permission justifications

Copy these into the store's "Why do you need this permission?" fields verbatim.

| Permission | Justification |
| --- | --- |
| `debugger` | The extension reads pages and dispatches real mouse and keyboard input through the Chrome DevTools Protocol. It attaches only to tabs it opened itself, and Chrome displays its own banner in every tab it attaches to. It is the only way to act in a page without a content script or a host permission over every site the user visits. |
| `storage` | Stores, in the user's own profile: the OpenRouter key they connected, the model they picked, the side-panel conversation, the relay token for a paired local Ghost daemon, and (in session storage) which tabs the extension opened so it can find and close them after the extension restarts. |
| `alarms` | A Manifest V3 service worker is terminated after about thirty seconds idle. A periodic alarm wakes it to re-establish the loopback connection to a local Ghost daemon and to finish cleaning up tabs it opened. |
| `sidePanel` | The chat surface is a side panel, so the conversation stays visible beside the page the agent is working in. |
| `identity` | Sign-in to the user's own OpenRouter account with OAuth PKCE (`launchWebAuthFlow`), the only way to connect; used for nothing else. OpenRouter's headless OAuth mode (paste the code it shows) remains as a fallback. |
| Remote code | None. The extension is plain ES modules loaded from the package. It fetches no script, evaluates no downloaded code, and has no `web_accessible_resources`. The one operation that runs JavaScript in a page runs code the user has read and approved in that moment. |
| Host permissions | None requested. The extension has no host permissions and no content scripts. It reaches `openrouter.ai` under ordinary CORS from its own extension pages, and a local Ghost daemon over a loopback WebSocket. |

## Data disclosure

- **Does this item collect user data?** Yes — because the user's messages and
  the page content they ask about are sent to OpenRouter, the AI provider they
  connected.
- **Data types:** *Website content* (page text, console output, network entry
  summaries and screenshots from tabs the extension opened), *Personal
  communications* (the user's own chat messages), *Authentication information*
  (the user's OpenRouter API key, stored locally and sent only to OpenRouter).
- **Not collected:** health, financial, location, personally identifiable
  information, web history, or user activity analytics.
- **Certifications:** data is not sold to third parties; data is not used or
  transferred for purposes unrelated to the item's single purpose; data is not
  used or transferred to determine creditworthiness or for lending.

## Single purpose statement

> The extension gives the user an agent that operates tabs it opens in their
> browser. The side panel and the optional local Ghost daemon are two ways to
> instruct that same agent; both use the same fixed set of page operations.

## Reviewer notes

> To try the default path: install, click the toolbar icon (the side panel
> opens), click **Connect OpenRouter** and authorize (OAuth; there is no API
> key to paste). The default model
> (`openrouter/free`) costs nothing and needs no balance. Then ask it something
> like "open example.com and tell me what the page says". It will open a new tab
> — Chrome's debugger banner appears there — read it, and answer.
>
> To see the permission gate: ask it to "run some JavaScript on this page". The
> panel shows the exact code with **Run it** / **Don't**, and nothing runs until
> you choose.
>
> To see the pause: open the ⋮ menu and press **Pause Ghost** mid-turn. The
> current turn stops and every further action is refused until you resume.
>
> The pairing code and the "ghostd" screens are the optional local-daemon path.
> Without that program installed the extension simply reports "Not connected";
> nothing in the chat path depends on it.

## Checklist before upload

- [ ] `node --test test/*.test.mjs` is green.
- [ ] `bun contrib/smoke.mjs --local` is green with `OPENROUTER_API_KEY` set,
      and the paid/unfunded checks in the README were done by hand.
- [ ] `contrib/package.sh` lists exactly the runtime files (no tests, docs, or scripts).
- [ ] `manifest.json` version bumped.
- [ ] Privacy policy URL in the listing:
      `https://github.com/ferdousbhai/ghost-chromium-extension/blob/main/PRIVACY.md`
- [ ] Screenshots: the side panel mid-turn, the script confirmation, the menu
      with Pause, all at 1280×800.
