# Plot Armor

Plot Armor is a Chrome extension that tries to protect you from spoilers while you scroll.

Most spoiler blockers only look for exact words. Plot Armor also checks context, so it can still catch spoilers even when the show name is not written directly.

## What it does right now

- You add shows you want protected.
- The extension builds a spoiler context for each show using OpenAI.
- It scans content on pages like Reddit/Wikipedia (and other article-like pages).
- It runs a hybrid check:
  - fast local rules
  - then semantic AI check when needed
- If something looks like a spoiler, it blurs the container.
- You can click to reveal.

## Tech stack

- Chrome Extension (Manifest V3)
- JavaScript
- OpenAI Chat Completions API
- Chrome Storage API (`sync` + `local`)
- `MutationObserver` + `IntersectionObserver`

## Project files

- `manifest.json` - extension config
- `popup.html` / `popup.js` - add/remove protected shows
- `background.js` - spoiler engine + OpenAI calls + cache
- `content.js` - page scanning + blur UI
- `.env` - OpenAI API key

## Setup

1. Clone this repo.
2. Create/update `.env` in project root:

```env
OPENAI_API_KEY=your_key_here
```

3. Open Chrome and go to `chrome://extensions`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and choose this folder.

## How to use

1. Click the Plot Armor extension icon.
2. Add a show (example: `Daredevil`).
3. Open pages with possible spoilers.
4. Spoiler blocks should blur with a **click to reveal** control.

## Quick test flow

1. Add a show in the popup.
2. Open service worker console from `chrome://extensions`.
3. Check stored context:

```js
chrome.storage.local.get(["showContexts"], console.log);
chrome.storage.sync.get(["protectedShows"], console.log);
```

4. Clear verdict cache before fresh testing:

```js
chrome.storage.local.set({ evalCache: {} });
```

## Current known limits

- It is still being tuned. Some spoilers can be missed.
- Some non-spoiler lines can still get blurred.
- Different Reddit/Wiki layouts can behave a little differently.
- AI output quality can vary, so context cleanup rules matter.

## Roadmap (next)

- Better comment-level handling across Reddit layouts
- Stronger precision on relationship/twist spoilers
- Cleaner testing harness for snippet accuracy checks
- User progress awareness (block only beyond where user is)

## Safety note

This project sends text to OpenAI for analysis. Do not use your real API key in screenshots or commits.

