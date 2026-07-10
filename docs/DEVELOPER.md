# Plot Armor — developer notes

Architecture, debugging, and regression testing. For install and everyday use, see the [README](../README.md).

## Repository map

| File | Role |
|------|------|
| `manifest.json` | MV3 config, permissions, CSP |
| `popup.html` / `popup.js` | Protected titles, TMDB search, toggles |
| `options.html` / `options.js` | API key storage (`chrome.storage.local`) |
| `background.js` | Story context, spoiler engine, API calls, cache |
| `content.js` | Page scan, blur/reveal, observers |
| `tests/fixtures.json` | Fixed spoiler/non-spoiler cases |
| `tests/run-fixtures.js` | Console runner for fixtures |

**Stack:** Chrome MV3, vanilla JS, OpenAI Chat Completions, TMDB API, `chrome.storage` (sync + local), `MutationObserver` + `IntersectionObserver`.

## Spoiler detection (`background.js`)

Current detector: `DETECTOR_VERSION` in `background.js` (cache keys include this — bump it when rules change).

### Tier 1 — local / story graph

- Fast entity and story-graph matching.
- Scan uses **main text + optional preceding context** so pronoun-only lines can inherit names from the line before.

### Escalation to Tier 2 (LLM)

- If Tier 1 does not match, the pipeline **defaults to the LLM** when you have active shields, unless the snippet is very short or reads as **pure meta** (casting, reviews, release, production, music) with no spoiler-shaped cues.
- Favors **recall** over exhaustive regex lists.

### Deterministic gates

High-signal patterns can short-circuit to blur or hard-allow (e.g. relationship reveals, major spoiler cues with enough title context, speculative “leak” phrasing, narrow origin/injury reveal phrasing tied to a protected title). **Review/schedule meta** (`directed by`, `airs on Sunday`, `season finale review`, credits, air dates, etc.) hard-allows before the LLM when no plot-shaped overrides are present — including on Reddit/X, not only TMDB/Wikipedia show pages. **Sports commentary** (championship, finals, NBA/NFL teams, “your team”) hard-allows too; hyperbolic “kill each other” / “fighting” in that context is treated as trash-talk, not plot deaths. **Unreleased character reveals** (`first look at X in TITLE`, teaser/poster/trailer stills, leak/rumor phrasing, rumored matchups like `apparently we'll have X vs Y in TITLE`, footage analysis like `new footage from TITLE` / side-by-side comparisons / `X looks bigger in TITLE`) hard-block when the protected title matches — official promo and soft rumor phrasing are treated the same as leaks for “who shows up” / “what was shown” spoilers. Hard-block checks the **full post text**, not only the highest-risk snippet (short headlines were previously dropped). **Production/exhibition meta** (ScreenX, IMAX, “first film to be shot for…”) hard-allows; filming “shot” must not read as gun violence. **Box office speculation** (`realistic shot at $2 billion worldwide`, opening weekend / gross talk tied to a protected title) hard-allows too. **Unrelated personal posts** (coding side projects, journaling apps, etc.) hard-allow when no protected title is mentioned — even if loose tier1 tokens or casual phrasing (`as it turns out`, `dead simple`) match.

### Tier 2 — semantic judge

- OpenAI JSON classifier; **missing story graphs** use an empty fallback so new titles still get judged.
- Judge failures log a **normalized error payload** (not opaque `[object Object]`).
- With multiple active titles, the service may run **one LLM call per title** until a confident hit or the list is exhausted.

### Verdict cache

- `evalCache` in `chrome.storage.local`, keyed in part by detector version.
- After pulling rule changes, clear cache (below) or expect mixed old/new behavior until entries expire.

## On-page behavior (`content.js`)

- Blur + click-to-reveal.
- **X/Twitter:** full-card veil (backdrop) so media stays covered.
- **Quote tweets:** quoted-card text merged into the snippet sent for classification.
- **Prefetch:** larger intersection margin (~1400px) + eager queueing for near-viewport nodes.
- **Reddit:** reveal is **per comment** on threads; feed posts target `shreddit-post` (the wrapping `<article data-post-id>` shell is ignored so the card is not evaluated twice). **not a spoiler?** on feed posts is placed in the action row beside Share when possible.
- **Virtualized feeds (X):** removed nodes are cleaned up (unobserve + queue).
- **Edge cases:** `image/*` documents and missing `document.head` handled without throwing; if `chrome.runtime` disappears after extension reload, scanning stops quietly for that tab (refresh after reload).
- **X “not a spoiler?” chip:** positioned via Grok control (`aria-label="Grok actions"`, English UI); CSS fallback offset if missing.

### False-positive reports

“Not a spoiler?” appends to `chrome.storage.local` → **`false_positives`** (last **100** records: timestamp, url, show, snippet, reason, confidence, source).

## Popup / storage model

- **Sync:** `protectedShows`, `activeProtectedShows` (paused titles are skipped by the background check).
- **Local:** `showContexts`, `showThumbnails`, `evalCache`, `false_positives`.
- Adds require a TMDB suggestion row (id + media type); free-text titles are not accepted.

## Debug checklist

1. Open the extension **service worker** console from `chrome://extensions`.
2. Inspect state:

```js
chrome.storage.sync.get(["protectedShows", "activeProtectedShows"], console.log);
chrome.storage.local.get(["showContexts", "evalCache", "false_positives", "pa_metrics"], console.log);
```

3. Detection metrics (local intercept %, cache hit %, LLM usage):

```js
chrome.runtime.sendMessage({ type: "GET_METRICS" }).then((r) => console.log(r.data));
// Or open Extension options → detection metrics → copy stats
```

4. Clear semantic verdict cache (after `DETECTOR_VERSION` or rule changes):

```js
chrome.storage.local.set({ evalCache: {} });
```

5. Clear generated show contexts for a fresh rebuild:

```js
chrome.storage.local.set({ showContexts: {} });
```

## Fixture regression (63 cases)

Fixed inputs in `tests/fixtures.json`; runner in `tests/run-fixtures.js`.

1. `chrome://extensions` → Plot Armor → **Inspect views: service worker**.
2. Paste the full contents of `tests/run-fixtures.js` into the console.
3. Run:

```js
await runPlotArmorFixtures();
```

Options:

```js
await runPlotArmorFixtures({ limit: 10 });
await runPlotArmorFixtures({ ids: ["PA-001", "PA-045"] });
await runPlotArmorFixtures({ clearEvalCacheEachCase: true });
```

If `runPlotArmorFixtures is not defined`, the worker restarted — paste the script again (or save as a DevTools Snippet).

**Notes:**

- Hits the live semantic pipeline — consumes OpenAI quota.
- A full 62-case run with `clearEvalCacheEachCase: true` can take tens of seconds.
- Runner temporarily overrides sync show state per case and restores it in `finally`.

## Known limits (dev-facing)

- No non-TMDB / manual keyword blocking in the popup yet.
- Default LLM escalation increases cost and latency vs a stricter local-only gate.
- `resetAndReevaluate` on storage changes may **reveal all blurs** before re-scan — brief flash on some sites.
- X report chip placement depends on English Grok `aria-label`.
- Context quality depends on TMDB/Wikipedia/OpenAI behavior.

## Near-term priorities

- Cut LLM cost/latency where safe (batched judge, cheaper pre-filter) without losing recall-heavy behavior.
- Reddit comment-level precision.
- Soften blur flicker on protected-list updates.
- Stronger meta-vs-plot handling without regex whack-a-mole.
- Optional watch-progress awareness.
