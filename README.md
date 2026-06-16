# Plot Armor

Chrome extension that blurs likely spoilers while you browse. It combines local story-graph matching with an OpenAI semantic check so spoilers can still be caught when a show title is not spelled out.

## Tech stack

- Chrome Extension (Manifest V3)
- JavaScript
- OpenAI Chat Completions API
- TMDB API
- Chrome Storage API (`sync` + `local`)
- `MutationObserver` + `IntersectionObserver`

## Demo

<div align="center">
  <img src="./docs/plot-armor-add-show.gif" width="450" alt="Adding a show" />
  <br />
  <sub>Search TMDB, pick a suggestion, then Add.</sub>
</div>

<div align="center">
  <img src="./docs/plot-armor-blocking-demo.gif" width="380" alt="Blocking in action" />
  <br />
  <sub>Matched content is blurred; click to reveal.</sub>
</div>

## Setup

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, select this folder.
3. Configure API keys — right-click the extension → **Options** (or use **Extension options** on `chrome://extensions`):

<div align="center">
  <img src="./docs/api-key-page.png" width="400" alt="Plot Armor API key configuration page" />
</div>

- [OpenAI API key](https://platform.openai.com/api-keys) — semantic spoiler detection
- [TMDB Read Access Token](https://www.themoviedb.org/settings/api) — search and metadata

Legacy: you can still use a local `.env` with `OPENAI_API_KEY` and `TMDB_READ_ACCESS_TOKEN` (not committed).

## Usage

1. Open the popup, search TMDB, **select a row** (Add stays disabled until you do), click **Add**.
2. Toggle shields per title, or use **pause all** / **enable all**.
3. Browse as usual — Reddit, Wikipedia, X, etc. Blurred blocks can be revealed per click.

## Docs

- [Developer guide](docs/DEVELOPER.md) — architecture, detection pipeline, debugging, fixture tests

## Known limits

- Adds must come from TMDB suggestions (no free-text or manual keyword lists yet).
- Default LLM escalation favors recall over cost — more API use than a local-only gate.
- Detection and context quality still vary by site layout and model behavior.
- Protected-list updates can briefly re-scan and flash existing blurs on some pages.

## Safety

Page text snippets are sent to OpenAI for analysis. Do not commit API keys or share screenshots that expose credentials.
