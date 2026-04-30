const SHOW_CONTEXTS_KEY = "showContexts";
const EVAL_CACHE_KEY = "evalCache";
const LOG_PREFIX = "[Plot Armor background]";
const SPOILER_CONFIDENCE_THRESHOLD = 0.58;
const MIN_CONFIDENCE_FLOOR = 0.4;
const DETECTOR_VERSION = "v8";
const SIGNAL_PATTERNS = {
  majorSpoilerCues:
    /\b(dies|death|killed|murdered|betray(?:ed|al)|ending|finale|resurrection|returns?|was behind|turns out|secret identity|twist|fate|killed off|identity is revealed)\b/i,
  relationshipReveal:
    /\b(is|was|turns out to be|revealed to be)\b.{0,40}\b(mother|father|brother|sister|son|daughter|parent|half-brother|half-sister|wife|husband)\b/i,
  twistIdentity:
    /\b(real identity|true identity|is actually|was actually|double life|secretly)\b/i,
  nonSpoilerContext:
    /\b(cast|casting|production|development|filming|designer|costume|ratings|rotten tomatoes|metacritic|review|critical consensus|release|soundtrack|music|announced|joined the cast|portray|portrayed|reception|netflix|disney|hulu|amazon|apple tv|streaming|license|licens(?:ing|ed)|rights|renewed|showrunner|executive producer|distribution|distributor|broadcast|premiere|parental controls|home media|blu.ray|dvd|box set|season order|episode count|budget|filming location|spin.?off|crossover|cameo)\b/i,
  castingAnnouncement:
    /\b(announced that|was cast as|joined the cast|renewed for|return(?:s|ed) for|guest appearance|showrunner|executive producer|prior commitments|writers? for|fbi agent|season one returners|in june|in july|in september|in november)\b/i,
  // Speculative/leak language — cancels casting/production hard-allows and forces LLM evaluation.
  // "spotted on set", "reportedly returning as X", "seemingly appear" reveal character presences
  // in unaired content and should NOT be treated as safe casting announcements.
  speculativeLeak:
    /\b(seemingly|reportedly|rumored|rumour|spotted on set|leaked|unconfirmed|allegedly|sources say|according to sources|return(?:s|ing)? as|appearing as)\b/i,
};
const DEATH_CUE_REGEX = /\b(dies|die|death|killed|murdered|slain|executed|fatal|killed off)\b/i;
const HIGH_RISK_SECTION_REGEX = /\b(premise|plot|synopsis|story|characters?)\b/i;
const LOW_RISK_SECTION_REGEX = /\b(casting|production|reception|reviews?|music|soundtrack|broadcast|distribution|development|accolades?|home media|filming|notes|release|renewal|ratings)\b/i;
const NARRATIVE_HISTORIAN_SYSTEM_PROMPT = `You are the Plot Armor Narrative Historian. Your job is to extract 100% accurate, canon-only spoilers for the show/movie provided.
STRICT FACTUAL RULES:
Death Accuracy: Only list characters in major_death_names if they actually die in the canon. For example, in Daredevil, Wilson Fisk does NOT die; he is imprisoned. Do NOT list characters who are merely defeated or arrested.
Identity Accuracy: Distinguish between a 'secret identity' being known by friends vs. being 'revealed to the public.' Only list it as a twist if it's a confirmed plot event.
No Hallucinations: If you are not 100% certain of a death or twist based on the official show ending, omit it.
STRICT FORMATTING RULES:
You must return a JSON object with these keys: major_death_names, pivotal_twists, status_changes, high_risk_keywords.
EVERY ITEM IN THE ARRAYS MUST BE A SINGLE STRING. Do not use nested objects.
pivotal_twists should be one sentence each: [The Setup] followed by [The Truth].
MISSION: Provide a forensic, spoiler-heavy breakdown of: [Insert Show Name Here]. Ensure no main characters are falsely listed as dead.`;
const TIER1_TOKEN_BLOCKLIST = new Set([
  "the",
  "and",
  "show",
  "series",
  "season",
  "episode",
  "finale",
  "kitchen",
  "city",
  "story",
  "character",
  "characters",
  "revealed",
]);
let cachedApiKey = null;
let cachedTmdbReadToken = null;

function normalizeList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const output = [];

  values.forEach((value) => {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(normalized);
  });

  return output;
}

function createFallbackContext(showName) {
  return {
    key_characters: [],
    character_deaths: [],
    relationships: [],
    event_facts: [],
    outcomes: [],
    safe_topics: ["casting", "reviews", "production", "soundtrack", "release date"],
  };
}

function parseStoryGraph(rawContext, showName) {
  if (!rawContext || typeof rawContext !== "object") return createFallbackContext(showName);

  const sanitizeStrings = (arr, maxLen, minChars = 8) =>
    normalizeList(arr)
      .filter((s) => String(s).trim().length >= minChars)
      .slice(0, maxLen);

  const sanitizeNames = (arr, maxLen) =>
    normalizeList(arr)
      .filter((s) => String(s).trim().length >= 2)
      .slice(0, maxLen);

  return {
    key_characters: sanitizeNames(rawContext.key_characters, 40),
    character_deaths: sanitizeStrings(rawContext.character_deaths, 20),
    relationships: sanitizeStrings(rawContext.relationships, 10),
    event_facts: sanitizeStrings(rawContext.event_facts, 20),
    outcomes: sanitizeStrings(rawContext.outcomes, 12),
    safe_topics: sanitizeStrings(rawContext.safe_topics, 8, 3),
  };
}

function stripToJsonObject(rawText) {
  const cleaned = String(rawText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

function hashText(inputText) {
  let hash = 5381;
  const input = String(inputText || "");
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeShowPage(pageUrl, showName) {
  const normalizedUrl = normalizeForMatch(pageUrl);
  const normalizedShow = normalizeForMatch(showName);
  if (!normalizedUrl || !normalizedShow) return false;
  return normalizedShow
    .split(" ")
    .filter((token) => token.length >= 4)
    .every((token) => normalizedUrl.includes(token));
}

async function loadApiKeyFromEnv() {
  if (cachedApiKey) return cachedApiKey;

  const envUrl = chrome.runtime.getURL(".env");
  const response = await fetch(envUrl);
  if (!response.ok) throw new Error("Could not load .env file.");

  const envText = await response.text();
  const lines = envText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "OPENAI_API_KEY" && value) {
      cachedApiKey = value;
      return cachedApiKey;
    }
  }

  throw new Error("OPENAI_API_KEY not found in .env");
}

async function callOpenAI(messages, temperature = 0.2, extraBody = {}) {
  const apiKey = await loadApiKeyFromEnv();
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature,
      ...extraBody,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function loadTmdbReadTokenFromEnv() {
  if (cachedTmdbReadToken) return cachedTmdbReadToken;

  const envUrl = chrome.runtime.getURL(".env");
  const response = await fetch(envUrl);
  if (!response.ok) throw new Error("Could not load .env file.");

  const envText = await response.text();
  const lines = envText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key === "TMDB_READ_ACCESS_TOKEN" && value) {
      cachedTmdbReadToken = value;
      return cachedTmdbReadToken;
    }
  }

  throw new Error("TMDB_READ_ACCESS_TOKEN not found in .env");
}

async function searchTmdbTitles(query) {
  const searchQuery = String(query || "").trim();
  if (searchQuery.length < 2) return [];

  const token = await loadTmdbReadTokenFromEnv();
  const url = `https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(
    searchQuery
  )}&include_adult=false&language=en-US&page=1`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`TMDB search failed ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  return (data?.results || [])
    .filter((item) => item && (item.media_type === "tv" || item.media_type === "movie"))
    .slice(0, 8)
    .map((item) => ({
      id: item.id,
      mediaType: item.media_type,
      title: item.title || item.name || "",
      year: String(item.release_date || item.first_air_date || "").slice(0, 4),
    }));
}

async function fetchTmdbJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) return null;
  return response.json();
}

async function fetchTmdbMediaContext(mediaType, id) {
  if (!id || !["tv", "movie"].includes(mediaType)) return null;
  const token = await loadTmdbReadTokenFromEnv();

  const details = await fetchTmdbJson(
    `https://api.themoviedb.org/3/${mediaType}/${id}?language=en-US`,
    token
  );
  if (!details) return null;

  // TV: aggregate_credits covers all seasons. Movie: standard credits.
  const creditsUrl =
    mediaType === "tv"
      ? `https://api.themoviedb.org/3/tv/${id}/aggregate_credits?language=en-US`
      : `https://api.themoviedb.org/3/movie/${id}/credits?language=en-US`;
  const credits = await fetchTmdbJson(creditsUrl, token);
  const keywordPayload = await fetchTmdbJson(
    mediaType === "tv"
      ? `https://api.themoviedb.org/3/tv/${id}/keywords`
      : `https://api.themoviedb.org/3/movie/${id}/keywords`,
    token
  );

  // aggregate_credits stores character name under roles[0].character; standard credits use .character directly.
  const rawCast = Array.isArray(credits?.cast) ? credits.cast : [];

  let cast;
  if (mediaType === "tv" && rawCast.some((e) => e?.total_episode_count != null)) {
    // For TV aggregate_credits: keep actors who appear in >15% of total episodes,
    // falling back to billing order if episode counts aren't available.
    // This captures core cast from later seasons that aren't billed top-40 overall.
    const totalEpisodes = details?.number_of_episodes || 1;
    const threshold = Math.max(1, Math.floor(totalEpisodes * 0.15));
    const frequent = rawCast.filter((e) => (e?.total_episode_count ?? 0) >= threshold);
    // If the threshold is too aggressive (e.g. a 2-season show), fall back to top billing.
    const pool = frequent.length >= 5 ? frequent : rawCast.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    // Sort by episode count descending so highest-presence actors rank first.
    cast = pool
      .sort((a, b) => (b.total_episode_count ?? 0) - (a.total_episode_count ?? 0))
      .slice(0, 50);
  } else {
    // Movies or shows without episode count data: use billing order.
    cast = rawCast.sort((a, b) => (a.order ?? 999) - (b.order ?? 999)).slice(0, 40);
  }

  const actorNames = normalizeList(cast.map((entry) => entry?.name));
  const characterNames = normalizeList(
    cast.map((entry) => entry?.roles?.[0]?.character || entry?.character)
  );
  const keywords = normalizeList(
    (Array.isArray(keywordPayload?.results)
      ? keywordPayload.results
      : Array.isArray(keywordPayload?.keywords)
        ? keywordPayload.keywords
        : []
    ).map((item) => item?.name)
  );

  let episodeTitles = [];
  let episodeSummaries = [];
  let mainSeasonNumbers = [];
  if (mediaType === "tv" && Array.isArray(details?.seasons)) {
    const seasonNumbers = details.seasons
      .map((season) => season?.season_number)
      .filter((num) => Number.isInteger(num) && num >= 0)
      .slice(0, 8);

    // Numbered seasons only (exclude season 0 specials) for per-season LLM calls.
    mainSeasonNumbers = seasonNumbers.filter((n) => n >= 1);

    const seasonPayloads = await Promise.all(
      seasonNumbers.map((seasonNumber) =>
        fetchTmdbJson(
          `https://api.themoviedb.org/3/tv/${id}/season/${seasonNumber}?language=en-US`,
          token
        )
      )
    );

    const allEpisodes = seasonPayloads.flatMap((season) =>
      Array.isArray(season?.episodes) ? season.episodes : []
    );

    episodeTitles = normalizeList(allEpisodes.map((ep) => ep?.name)).slice(0, 40);

    // Build compact per-season episode summaries: "S1E3 Title: overview"
    // Keep overviews short (120 chars) to stay within prompt budget.
    episodeSummaries = seasonPayloads.flatMap((season, idx) => {
      const sNum = seasonNumbers[idx];
      if (!sNum || sNum === 0) return [];
      return (Array.isArray(season?.episodes) ? season.episodes : [])
        .filter((ep) => ep?.name && ep?.overview)
        .map((ep) => {
          const overview = String(ep.overview).slice(0, 120).replace(/\n/g, " ");
          return `S${sNum}E${ep.episode_number} ${ep.name}: ${overview}`;
        });
    });
  }

  return {
    id: details.id,
    mediaType,
    title: details.title || details.name || "",
    originalTitle: details.original_title || details.original_name || "",
    overview: details.overview || "",
    actorNames,
    characterNames,
    keywords,
    episodeTitles,
    episodeSummaries,
    mainSeasonNumbers,
  };
}

async function resolveTmdbContext(showName, tmdbSelection = null) {
  if (tmdbSelection?.id && tmdbSelection?.mediaType) {
    const selectedContext = await fetchTmdbMediaContext(tmdbSelection.mediaType, tmdbSelection.id);
    if (selectedContext) return selectedContext;
  }

  const matches = await searchTmdbTitles(showName);
  const first = matches[0];
  if (!first?.id || !first?.mediaType) return null;
  return fetchTmdbMediaContext(first.mediaType, first.id);
}


function cleanWikitext(raw) {
  return raw
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1") // [[Link|label]] → label
    .replace(/\{\{[^}]*\}\}/g, "")                     // {{templates}} → remove
    .replace(/\[\[File:[^\]]*\]\]/gi, "")               // [[File:...]] → remove
    .replace(/'''([^']*?)'''/g, "$1")                   // '''bold''' → text
    .replace(/''([^']*?)''/g, "$1")                     // ''italic'' → text
    .replace(/={2,6}\s*(.+?)\s*={2,6}/g, "")           // ==headers== → remove
    .replace(/<[^>]+>/g, "")                            // HTML tags
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Strip streaming/studio prefixes that never appear in Wikipedia titles.
// e.g. "Marvel's Daredevil" → "Daredevil", "Netflix's Narcos" → "Narcos"
function wikiShortName(showName) {
  return showName
    .replace(/['']/g, "'")
    .replace(/^(?:Marvel(?:'s)?|DC(?:'s)?|Netflix(?:'s)?|Amazon(?:'s)?|Hulu(?:'s)?|Apple(?:'s)?|Disney(?:\+|'s)?)\s+/i, "")
    .trim();
}

async function fetchWikipediaEpisodes(showName, seasonNumber = null) {
  const base = showName.replace(/['']/g, "'").trim();
  const short = wikiShortName(showName); // e.g. "Daredevil" from "Marvel's Daredevil"
  const names = short !== base ? [base, short] : [base];

  // Build candidate titles from both the full name and the short name.
  const candidates = seasonNumber
    ? names.flatMap((n) => [
        `${n} season ${seasonNumber}`,
        `${n} (TV series) season ${seasonNumber}`,
        `${n} (season ${seasonNumber})`,
      ])
    : names.flatMap((n) => [n, `${n} (TV series)`, `${n} (film)`, `${n} (miniseries)`]);

  for (const title of candidates) {
    const result = await fetchEpisodesFromTitle(title);
    if (result) return result;
  }

  // Fallback: opensearch using both names to find the real canonical title.
  if (seasonNumber) {
    for (const searchName of names) {
      try {
        const searchResp = await fetch(
          `https://en.wikipedia.org/w/api.php?action=opensearch` +
            `&search=${encodeURIComponent(`${searchName} season ${seasonNumber}`)}` +
            `&limit=6&format=json&origin=*`
        );
        if (!searchResp.ok) continue;
        const searchData = await searchResp.json();
        const titles = Array.isArray(searchData[1]) ? searchData[1] : [];
        // Accept any result that mentions "season" and at least one word from the short name.
        const shortWords = short.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
        const match = titles.find(
          (t) =>
            t.toLowerCase().includes("season") &&
            shortWords.some((w) => t.toLowerCase().includes(w))
        );
        if (match) {
          const result = await fetchEpisodesFromTitle(match);
          if (result) return result;
        }
      } catch (_) {}
    }
  }

  return null;
}

async function fetchEpisodesFromTitle(title) {
  const base = `https://en.wikipedia.org/w/api.php?format=json&origin=*&page=${encodeURIComponent(title)}`;
  try {
    // Step 1: get section list to find the Episodes / Plot section index.
    const sectionsResp = await fetch(`${base}&action=parse&prop=sections`);
    if (!sectionsResp.ok) return null;
    const sectionsData = await sectionsResp.json();
    if (sectionsData.error) return null;

    const sections = sectionsData.parse?.sections || [];
    const target = sections.find((s) => /^(Episodes?|Plot|Synopsis|Season overview)/i.test(s.line));
    if (!target) return null;

    // Step 2: fetch just that section as wikitext.
    const sectionResp = await fetch(`${base}&action=parse&prop=wikitext&section=${target.index}`);
    if (!sectionResp.ok) return null;
    const sectionData = await sectionResp.json();
    const wikitext = sectionData.parse?.wikitext?.["*"] || "";
    const cleaned = cleanWikitext(wikitext);
    if (cleaned.length < 100) return null;

    // Cap at 8 000 chars to stay within prompt budget.
    return cleaned.slice(0, 8000);
  } catch (_) {
    return null;
  }
}

// Interleave arrays from multiple seasons so no single season dominates the cap.
function roundRobin(arrays, limit) {
  const result = [];
  const seen = new Set();
  const maxLen = Math.max(...arrays.map((a) => a.length), 0);
  for (let i = 0; i < maxLen && result.length < limit; i++) {
    for (const arr of arrays) {
      if (i < arr.length && result.length < limit) {
        const val = String(arr[i]).trim();
        const key = val.toLowerCase();
        if (val && !seen.has(key)) {
          seen.add(key);
          result.push(val);
        }
      }
    }
  }
  return result;
}

function mergeSeasonContexts(contexts) {
  const seenChars = new Set();
  const merged = { key_characters: [], character_deaths: [], relationships: [], event_facts: [], outcomes: [], safe_topics: [] };

  // key_characters: deduplicate across seasons preserving order.
  for (const ctx of contexts) {
    for (const name of ctx.key_characters || []) {
      const key = String(name).toLowerCase().trim();
      if (key && !seenChars.has(key)) {
        seenChars.add(key);
        merged.key_characters.push(name);
      }
    }
  }
  merged.key_characters = merged.key_characters.slice(0, 50);

  // List fields: round-robin so each season contributes equally before hitting the cap.
  merged.character_deaths = roundRobin(contexts.map((c) => normalizeList(c.character_deaths || [])), 30);
  merged.event_facts  = roundRobin(contexts.map((c) => normalizeList(c.event_facts  || [])), 30);
  merged.outcomes     = roundRobin(contexts.map((c) => normalizeList(c.outcomes     || [])), 18);
  merged.relationships= roundRobin(contexts.map((c) => normalizeList(c.relationships|| [])), 12);
  merged.safe_topics  = roundRobin(contexts.map((c) => normalizeList(c.safe_topics  || [])),  8);
  return merged;
}

async function learnShowContext(showName, tmdbContext = null, seasonNumber = null, wikiEpisodes = null) {
  // Filter episode summaries to just this season when doing a per-season call.
  const relevantSummaries = seasonNumber && tmdbContext?.episodeSummaries?.length
    ? tmdbContext.episodeSummaries.filter((s) => s.startsWith(`S${seasonNumber}E`))
    : tmdbContext?.episodeSummaries;

  // Intentionally exclude character_names/actor_names — the LLM mirrors them back,
  // biasing key_characters toward whoever TMDB bills highest (Season 1 cast).
  const tmdbBlock = tmdbContext
    ? JSON.stringify(
        {
          canonical_title: tmdbContext.title,
          media_type: tmdbContext.mediaType,
          overview: tmdbContext.overview,
          episode_summaries: relevantSummaries?.length
            ? relevantSummaries
            : tmdbContext.episodeTitles,
          tmdb_keywords: tmdbContext.keywords,
        },
        null,
        2
      )
    : "No TMDB context available.";

  const systemPrompt = `You are a story analyst for Plot Armor, an AI spoiler blocker.
Your job is to build a structured story graph for the title provided so the system can accurately detect spoilers.

RULES:
- All entries must be 100% canon accurate. Do NOT hallucinate events.
- key_characters = every named character who appears in THIS season — main cast, recurring, and supporting.
  Use your own training knowledge. Include villain characters and one-season characters.
  Do NOT include generic roles like "Officer #1" or "Elderly Man".
- character_deaths = EVERY character who dies this season, one entry per death. This is the highest priority field.
  Format: "[Character name] is killed by [killer] [method/context]."
  Include ALL deaths — main cast, recurring, and supporting characters. Do not skip anyone.
  If Wikipedia episode summaries are provided, scan every episode for deaths and list them all.
  Example: "Father Paul Lantom is shot and killed by Dex Poindexter inside the church."
  Example: "Ray Nadeem is executed by Dex Poindexter on Wilson Fisk's orders."
  Example: "Benjamin Urich is murdered by Wilson Fisk in his office."
  Example: "Nobu Yoshioka is burned alive after Daredevil causes an explosion."
- event_facts = other major plot events: betrayals, identity reveals, twists, and key turning points.
  Do NOT repeat deaths already listed in character_deaths.
  Example: "Elektra Natchios is revealed to be the Black Sky, the weapon of the Hand."
  Example: "Wilson Fisk manipulates the FBI by using Agent Nadeem as a pawn."
- outcomes = final confirmed states for major characters and storylines at the END of this season.
  Example: "Wilson Fisk is imprisoned but continues to control criminal networks from prison."
- relationships = key character dynamics relevant to understanding spoilers.
  Example: "Foggy Nelson is Matt's best friend and law partner who discovers his secret identity."
- safe_topics = discussion topics that are explicitly NOT plot spoilers for this title.
  Example: "fight choreography", "casting announcements", "Netflix renewal", "comic book comparisons".
- Be specific with character names. Vague entries like "a major character dies" are useless.
- If Wikipedia episode summaries are provided below, treat them as the PRIMARY source of plot events.
  Extract character names, deaths, twists, and outcomes directly from that text first.
  Use TMDB metadata and your own training knowledge as supplementary sources only.

Return a JSON object with exactly these keys:
  key_characters (array of character name strings, max 40)
  character_deaths (array of strings, max 20)
  relationships (array of strings, max 10)
  event_facts (array of strings, max 20)
  outcomes (array of strings, max 12)
  safe_topics (array of strings, max 8)`;

  const raw = await callOpenAI(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content:
          `Build the story graph for: ${showName}${seasonNumber ? ` Season ${seasonNumber}` : ""}` +
          `\n\nTMDB Metadata:\n${tmdbBlock}` +
          (wikiEpisodes ? `\n\nWikipedia Episode Summaries (PRIMARY SOURCE):\n${wikiEpisodes}` : ""),
      },
    ],
    0,
    { response_format: { type: "json_object" } }
  );

  const parsed = JSON.parse(stripToJsonObject(raw));
  return parseStoryGraph(parsed, showName);
}

async function handleShowAdded(showName, _tmdbSelection = null) {
  console.info(`${LOG_PREFIX} SHOW_ADDED received`, { showName });
  const local = await chrome.storage.local.get([SHOW_CONTEXTS_KEY]);
  const showContexts = local[SHOW_CONTEXTS_KEY] || {};
  let context;
  let usedFallback = false;
  let tmdbContext = null;

  try {
    tmdbContext = await resolveTmdbContext(showName, _tmdbSelection);
  } catch (error) {
    console.warn(`${LOG_PREFIX} TMDB context fetch failed`, { showName, error });
  }

  try {
    const seasons = tmdbContext?.mainSeasonNumbers || [];
    if (seasons.length >= 2) {
      // Multi-season TV: one focused LLM call per season, then merge.
      // Cap at 5 seasons to limit API cost (covers the vast majority of shows).
      const cappedSeasons = seasons.slice(0, 5);
      console.info(`${LOG_PREFIX} Per-season story graph`, { showName, seasons: cappedSeasons });

      // Fetch Wikipedia episode summaries for each season in parallel with each other.
      const wikiResults = await Promise.all(
        cappedSeasons.map((n) => fetchWikipediaEpisodes(showName, n).catch(() => null))
      );
      console.info(`${LOG_PREFIX} Wikipedia episodes fetched`, {
        showName,
        found: wikiResults.filter(Boolean).length,
        total: cappedSeasons.length,
      });

      const seasonContexts = await Promise.all(
        cappedSeasons.map((n, i) =>
          learnShowContext(showName, tmdbContext, n, wikiResults[i] || null).catch((err) => {
            console.warn(`${LOG_PREFIX} Season ${n} context failed`, { err });
            return createFallbackContext(showName);
          })
        )
      );
      context = mergeSeasonContexts(seasonContexts);
    } else {
      // Single-season show or movie.
      const wikiEpisodes = await fetchWikipediaEpisodes(showName).catch(() => null);
      console.info(`${LOG_PREFIX} Wikipedia episodes fetched`, {
        showName,
        found: Boolean(wikiEpisodes),
      });
      context = await learnShowContext(showName, tmdbContext, null, wikiEpisodes);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Context fetch failed, using fallback`, { showName, error });
    context = createFallbackContext(showName);
    usedFallback = true;
  }

  showContexts[showName] = context;
  // Store TMDB character/actor names directly so Tier 1 can match on them
  // regardless of what the story graph includes.
  if (tmdbContext) {
    showContexts[showName].tmdb_character_names = tmdbContext.characterNames || [];
    showContexts[showName].tmdb_actor_names = tmdbContext.actorNames || [];
  }
  await chrome.storage.local.set({ [SHOW_CONTEXTS_KEY]: showContexts });
  console.info(`${LOG_PREFIX} SHOW_ADDED stored story graph`, {
    showName,
    key_characters: context.key_characters.length,
    character_deaths: context.character_deaths.length,
    relationships: context.relationships.length,
    event_facts: context.event_facts.length,
    outcomes: context.outcomes.length,
    safe_topics: context.safe_topics.length,
    tmdbGrounded: Boolean(tmdbContext),
    usedFallback,
  });
  return { showName, context, tmdbGrounded: Boolean(tmdbContext), usedFallback };
}

async function handleShowRemoved(showName) {
  console.info(`${LOG_PREFIX} SHOW_REMOVED received`, { showName });
  const local = await chrome.storage.local.get([SHOW_CONTEXTS_KEY]);
  const showContexts = local[SHOW_CONTEXTS_KEY] || {};
  delete showContexts[showName];
  await chrome.storage.local.set({ [SHOW_CONTEXTS_KEY]: showContexts });
  console.info(`${LOG_PREFIX} SHOW_REMOVED stored context update`, {
    showName,
    remainingShows: Object.keys(showContexts).length,
  });
  return { showName };
}

function extractContextTerms(showContext, showName = "") {
  if (!showContext || typeof showContext !== "object") return [];

  // LLM-generated key_characters covers all seasons; TMDB cast is a billing-order fallback.
  const llmCharacters = normalizeList(showContext.key_characters);
  const tmdbCharacters = normalizeList(showContext.tmdb_character_names);
  const tmdbActors = normalizeList(showContext.tmdb_actor_names);
  const terms = [...llmCharacters, ...tmdbCharacters, ...tmdbActors];

  const normalizedShowName = String(showName || "").trim();
  if (normalizedShowName) terms.push(normalizedShowName);

  // Tokenize story graph lines so individual names inside sentences trip Tier 1.
  // character_deaths is highest priority — tokenize it first.
  const storyLines = [
    ...normalizeList(showContext.character_deaths),
    ...normalizeList(showContext.event_facts),
    ...normalizeList(showContext.outcomes),
    ...normalizeList(showContext.relationships),
  ];
  storyLines.forEach((line) => {
    line
      .split(/[^A-Za-z0-9'']+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !TIER1_TOKEN_BLOCKLIST.has(token.toLowerCase()))
      .forEach((token) => terms.push(token));
  });

  const normalized = normalizeList(terms);
  return normalized.length ? normalized : normalizedShowName ? [normalizedShowName] : [];
}

function tier1AnalyzeShow(textToAnalyze, showContext, showName = "") {
  const text = String(textToAnalyze || "").toLowerCase();
  const normalizedText = text
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const entities = extractContextTerms(showContext, showName);
  const terms = [];

  entities.forEach((entity) => {
    const full = String(entity || "").toLowerCase().trim();
    if (!full) return;
    terms.push(full);

    // Also match meaningful parts of multi-word entities (e.g. "Matt Murdock" -> "murdock").
    full
      .split(/\s+/)
      .map((token) => token.replace(/[^\w']/g, "").replace(/(?:'s|’s)$/i, ""))
      .filter((token) => token.length >= 4 && !TIER1_TOKEN_BLOCKLIST.has(token))
      .forEach((token) => terms.push(token));
  });

  const uniqueTerms = [...new Set(terms)];
  const matchedTerms = uniqueTerms.filter((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(^|\\W)${escaped}(?:['’]s)?(?=$|\\W)`, "i");
    return regex.test(normalizedText);
  });

  if (matchedTerms.length) {
    console.info(`${LOG_PREFIX} Tier1 matched terms`, {
      sample: matchedTerms.slice(0, 5),
      total: matchedTerms.length,
    });
  }

  return {
    isMatch: matchedTerms.length > 0,
    matchedTerms,
    matchedCount: matchedTerms.length,
  };
}

async function runSemanticJudge(showName, showContext, textToAnalyze, precedingContext = "") {
  const storyGraphBlock = JSON.stringify(
    {
      character_deaths: showContext.character_deaths || [],
      relationships: showContext.relationships || [],
      event_facts: showContext.event_facts || [],
      outcomes: showContext.outcomes || [],
      safe_topics: showContext.safe_topics || [],
    },
    null,
    2
  );

  const systemPrompt = [
    `You are a strict spoiler classifier for the media title: "${showName}".`,
    "",
    "Your job: using your own knowledge of this title, determine if the user-provided text",
    "reveals ANY plot points, character deaths, narrative events, twists, or endings.",
    "",
    "Rules:",
    "- Use your own training knowledge of this title as the primary source of truth.",
    "- The story graph below is supplementary context — use it if helpful, but do NOT limit",
    "  yourself to only flagging events that appear in it.",
    "- DO NOT flag: acting reviews, casting news, release dates, production info, or genre commentary.",
    "- DO flag: character deaths, betrayals, twists, identity reveals, relationship outcomes, endings.",
    "- DO flag: reveals that a specific character appears in an unaired or future season/episode,",
    "  even if framed as casting news, set reports, or speculation (e.g. 'spotted on set as X', 'seemingly returning as Y').",
    "  Knowing a character appears in a season the user hasn't watched yet IS a spoiler.",
    "- A plot event is a spoiler regardless of which season it occurs in.",
    "",
    `Supplementary story graph:\n${storyGraphBlock}`,
    "",
    'Respond with a JSON object with keys: "isSpoiler" (boolean), "confidence" (number 0..1), "reason" (one sentence).',
  ].join("\n");

  const raw = await callOpenAI(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: precedingContext
          ? `[Preceding sentence(s) — for pronoun/reference resolution only, do NOT classify these as spoilers]:\n"${precedingContext}"\n\n[Text to classify]:\n"${textToAnalyze}"`
          : textToAnalyze,
      },
    ],
    0,
    { response_format: { type: "json_object" } }
  );

  const jsonCandidate = stripToJsonObject(raw);
  console.info(`${LOG_PREFIX} runSemanticJudge raw`, { showName, raw });
  try {
    const parsed = JSON.parse(jsonCandidate);
    const confidence = Number(parsed?.confidence);
    return {
      isSpoiler: Boolean(parsed?.isSpoiler),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason: String(parsed?.reason || "").trim(),
    };
  } catch (_) {
    const normalized = String(raw || "").trim().toLowerCase();
    const isSpoiler = normalized.startsWith("true");
    return {
      isSpoiler,
      confidence: isSpoiler ? 0.8 : 0.2,
      reason: "fallback-parse",
    };
  }
}

function getSectionRiskAdjustment(sectionHint = "") {
  const section = String(sectionHint || "").trim();
  if (!section) return 0;
  if (HIGH_RISK_SECTION_REGEX.test(section)) return 0.15;
  if (LOW_RISK_SECTION_REGEX.test(section)) return -0.18;
  return 0;
}

function computeDeterministicSignals({
  text,
  pageUrl,
  sectionHint,
  matchedShows,
  tier1ByShow,
  showContexts,
}) {
  const strongestTier1MatchCount = matchedShows.reduce((maxCount, showName) => {
    const count = tier1ByShow[showName]?.matchedCount || 0;
    return Math.max(maxCount, count);
  }, 0);
  const isLikelyShowPage = matchedShows.some((showName) => looksLikeShowPage(pageUrl, showName));
  const hasMajorCue = SIGNAL_PATTERNS.majorSpoilerCues.test(text);
  const hasRelationshipReveal = SIGNAL_PATTERNS.relationshipReveal.test(text);
  const hasTwistIdentity = SIGNAL_PATTERNS.twistIdentity.test(text);
  const hasDeathCue = DEATH_CUE_REGEX.test(text);
  const looksLikeNonSpoilerContext = SIGNAL_PATTERNS.nonSpoilerContext.test(text);
  const looksLikeCastingAnnouncement = SIGNAL_PATTERNS.castingAnnouncement.test(text);
  // Speculative/leak language overrides casting and production hard-allows —
  // "spotted on set, seemingly returning as X" reveals character presences and must go to LLM.
  const isSpeculativeLeak = SIGNAL_PATTERNS.speculativeLeak.test(text);
  const sectionRisk = getSectionRiskAdjustment(sectionHint);
  const deathNameHitCount = matchedShows.reduce((total, showName) => {
    const deathNames = normalizeList(showContexts?.[showName]?.major_death_names);
    const normalizedText = normalizeForMatch(text);
    const hits = deathNames.filter((name) => normalizedText.includes(normalizeForMatch(name))).length;
    return total + hits;
  }, 0);

  // Generic tier1 matches should contribute modestly by default.
  let riskScore = sectionRisk + Math.min(0.22, strongestTier1MatchCount * 0.05);

  if (hasMajorCue) riskScore += 0.25;
  if (hasTwistIdentity) riskScore += 0.2;
  if (hasRelationshipReveal) riskScore += 0.35;
  // Death names are high-signal only when explicit death/fate language appears.
  if (hasDeathCue && deathNameHitCount > 0) {
    riskScore += Math.min(0.3, deathNameHitCount * 0.1);
  } else if (deathNameHitCount > 0) {
    riskScore -= Math.min(0.15, deathNameHitCount * 0.05);
  }
  if (looksLikeNonSpoilerContext) riskScore -= 0.2;
  if (looksLikeCastingAnnouncement) riskScore -= 0.2;

  if (hasRelationshipReveal && strongestTier1MatchCount >= 1) {
    return {
      hardBlock: { matched: true, reason: "deterministic-relationship-reveal" },
      hardAllow: { matched: false, reason: "" },
      riskScore: Math.max(riskScore, 0.85),
    };
  }

  if (
    (hasMajorCue || hasTwistIdentity) &&
    strongestTier1MatchCount >= 2 &&
    !looksLikeCastingAnnouncement &&
    !looksLikeNonSpoilerContext
  ) {
    return {
      hardBlock: { matched: true, reason: "deterministic-major-cue" },
      hardAllow: { matched: false, reason: "" },
      riskScore: Math.max(riskScore, 0.75),
    };
  }

  if (
    isLikelyShowPage &&
    looksLikeNonSpoilerContext &&
    !hasRelationshipReveal &&
    !hasTwistIdentity &&
    !isSpeculativeLeak
  ) {
    return {
      hardBlock: { matched: false, reason: "" },
      hardAllow: { matched: true, reason: "deterministic-nonspoiler-context" },
      riskScore: Math.min(riskScore, -0.6),
    };
  }

  // Casting/production context: must not be speculative/leak language.
  // "spotted on set, seemingly returning as X" goes to LLM, not hard-allowed.
  if (looksLikeCastingAnnouncement && !hasRelationshipReveal && !hasTwistIdentity && !isSpeculativeLeak) {
    return {
      hardBlock: { matched: false, reason: "" },
      hardAllow: { matched: true, reason: "deterministic-casting-context" },
      riskScore: Math.min(riskScore, -0.6),
    };
  }

  // Section-level hard-allow: if the nearest heading is clearly non-plot
  // (Production, Broadcast, Reception, etc.) skip the LLM entirely.
  // A relationship reveal, identity twist, or speculative leak can still override this.
  if (
    sectionHint &&
    LOW_RISK_SECTION_REGEX.test(sectionHint) &&
    !hasRelationshipReveal &&
    !hasTwistIdentity &&
    !isSpeculativeLeak
  ) {
    return {
      hardBlock: { matched: false, reason: "" },
      hardAllow: { matched: true, reason: "deterministic-low-risk-section" },
      riskScore: Math.min(riskScore, -0.7),
    };
  }

  return {
    hardBlock: { matched: false, reason: "" },
    hardAllow: { matched: false, reason: "" },
    riskScore: Math.max(-1, Math.min(1, riskScore)),
  };
}

function getDynamicThreshold(riskScore) {
  const dynamic = SPOILER_CONFIDENCE_THRESHOLD - riskScore * 0.2;
  return Math.max(MIN_CONFIDENCE_FLOOR, Math.min(0.9, dynamic));
}

function splitIntoSnippets(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 60);
}

function pickBestEvaluationText(text, matchedShows, showContexts) {
  const snippets = splitIntoSnippets(text);
  if (!snippets.length) return text;

  let bestSnippet = text;
  let bestScore = -Infinity;

  snippets.forEach((snippet) => {
    const normalized = snippet.toLowerCase();
    const hasMajorCue = SIGNAL_PATTERNS.majorSpoilerCues.test(normalized);
    const hasRelationshipReveal = SIGNAL_PATTERNS.relationshipReveal.test(normalized);
    const hasTwistIdentity = SIGNAL_PATTERNS.twistIdentity.test(normalized);
    const looksNonSpoiler =
      SIGNAL_PATTERNS.nonSpoilerContext.test(normalized) ||
      SIGNAL_PATTERNS.castingAnnouncement.test(normalized);

    let maxMatchCount = 0;
    matchedShows.forEach((showName) => {
      const analysis = tier1AnalyzeShow(snippet, showContexts[showName]);
      maxMatchCount = Math.max(maxMatchCount, analysis.matchedCount || 0);
    });

    let score = maxMatchCount * 0.2;
    if (hasMajorCue) score += 0.5;
    if (hasTwistIdentity) score += 0.45;
    if (hasRelationshipReveal) score += 0.6;
    if (looksNonSpoiler) score -= 0.4;

    if (score > bestScore) {
      bestScore = score;
      bestSnippet = snippet;
    }
  });

  return bestSnippet;
}

async function handleSemanticCheck(textToAnalyze, pageUrl = "", sectionHint = "", containerTag = "", precedingContext = "") {
  const originalText = String(textToAnalyze || "").trim();
  const text = originalText;
  if (!text) {
    console.info(`${LOG_PREFIX} SEMANTIC_CHECK skipped empty text`);
    return { isSpoiler: false, reason: "empty-text" };
  }

  const [local, sync] = await Promise.all([
    chrome.storage.local.get([SHOW_CONTEXTS_KEY, EVAL_CACHE_KEY]),
    chrome.storage.sync.get(["protectedShows"]),
  ]);

  const showContexts = local[SHOW_CONTEXTS_KEY] || {};
  const evalCache = local[EVAL_CACHE_KEY] || {};
  const protectedShows = Array.isArray(sync.protectedShows) ? sync.protectedShows : [];
  const tier1ByShow = {};
  const matchedShows = protectedShows.filter((showName) => {
    const analysis = tier1AnalyzeShow(text, showContexts[showName], showName);
    tier1ByShow[showName] = analysis;
    return analysis.isMatch;
  });
  console.info(`${LOG_PREFIX} SEMANTIC_CHECK tier1 result`, {
    textLength: text.length,
    protectedShows: protectedShows.length,
    matchedShows,
  });

  // Tier 1: local fast pre-filter
  // Exception: if the content self-labels as spoilers (e.g. "spoiler warning",
  // "#spoilers", or a username containing "spoilers"), escalate to LLM anyway
  // using all protected show contexts — the content is explicitly flagged as spoilery.
  const selfLabelsSpoiler = /\bspoilers?\b/i.test(text);
  if (!matchedShows.length) {
    if (!selfLabelsSpoiler || !protectedShows.length) {
      return { isSpoiler: false, reason: "tier1-no-match" };
    }
    // Self-labelled spoiler with no entity match — escalate using first protected show.
    // The LLM will decide if it actually spoils anything the user cares about.
    console.info(`${LOG_PREFIX} SEMANTIC_CHECK self-labelled spoiler, escalating to LLM`);
    matchedShows.push(protectedShows[0]);
  }

  // Evaluate the highest-risk snippet inside long blocks for better relevance.
  const evaluationText = pickBestEvaluationText(text, matchedShows, showContexts);

  const signals = computeDeterministicSignals({
    text: evaluationText,
    pageUrl,
    sectionHint,
    matchedShows,
    tier1ByShow,
    showContexts,
  });
  const dynamicThreshold = getDynamicThreshold(signals.riskScore);

  if (signals.hardAllow.matched) {
    return {
      isSpoiler: false,
      confidence: 0.05,
      reason: signals.hardAllow.reason,
      source: "tier1-hard-allow",
      score: signals.riskScore,
      sectionHint,
      containerTag,
    };
  }

  if (signals.hardBlock.matched) {
    return {
      isSpoiler: true,
      confidence: 0.95,
      reason: signals.hardBlock.reason,
      matchedShow: matchedShows[0],
      source: "tier1-hard-block",
      score: signals.riskScore,
      sectionHint,
      containerTag,
    };
  }

  const cacheKey = hashText(
    `${DETECTOR_VERSION}::${evaluationText}::${normalizeForMatch(pageUrl)}::${normalizeForMatch(
      sectionHint
    )}::${containerTag}::${matchedShows.sort().join("|")}`
  );
  if (evalCache[cacheKey] && typeof evalCache[cacheKey] === "object") {
    console.info(`${LOG_PREFIX} SEMANTIC_CHECK cache-hit`, {
      cacheKey,
      verdict: evalCache[cacheKey],
    });
    return { ...evalCache[cacheKey], source: "cache-hit" };
  }

  // Tier 2: semantic LLM judgement
  let finalVerdict = {
    isSpoiler: false,
    confidence: 0,
    reason: "semantic-no-match",
  };

  for (const showName of matchedShows) {
    const showContext = showContexts[showName];
    if (!showContext) continue;
    try {
      const verdict = await runSemanticJudge(showName, showContext, text, precedingContext);
      const shouldBlur = verdict.isSpoiler && verdict.confidence >= dynamicThreshold;
      console.info(`${LOG_PREFIX} SEMANTIC_CHECK tier2 result`, {
        showName,
        verdict,
        shouldBlur,
        dynamicThreshold,
        riskScore: signals.riskScore,
      });

      if (shouldBlur) {
        finalVerdict = {
          isSpoiler: true,
          confidence: verdict.confidence,
          reason: verdict.reason || "semantic-high-confidence",
          matchedShow: showName,
          score: signals.riskScore,
          sectionHint,
          containerTag,
          analyzedTextLength: evaluationText.length,
        };
        break;
      } else if (verdict.isSpoiler) {
        finalVerdict = {
          isSpoiler: false,
          confidence: verdict.confidence,
          reason: verdict.reason || "semantic-below-threshold",
          matchedShow: showName,
          score: signals.riskScore,
          sectionHint,
          containerTag,
          analyzedTextLength: evaluationText.length,
        };
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} semantic judge failed`, { showName, error });
    }
  }

  evalCache[cacheKey] = finalVerdict;
  await chrome.storage.local.set({ [EVAL_CACHE_KEY]: evalCache });
  console.info(`${LOG_PREFIX} SEMANTIC_CHECK completed`, {
    cacheKey,
    verdict: finalVerdict,
    threshold: dynamicThreshold,
    baseThreshold: SPOILER_CONFIDENCE_THRESHOLD,
    riskScore: signals.riskScore,
    sectionHint,
    analyzedTextLength: evaluationText.length,
  });
  return { ...finalVerdict, source: "semantic-fused", score: signals.riskScore };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  const showName = message?.showName;
  const textToAnalyze = message?.textToAnalyze;
  const sectionHint = message?.sectionHint;
  const containerTag = message?.containerTag;
  const precedingContext = message?.precedingContext;

  const run = async () => {
    if (type === "SHOW_ADDED" && showName) return handleShowAdded(showName, message?.tmdbSelection);
    if (type === "SHOW_REMOVED" && showName) return handleShowRemoved(showName);
    if (type === "TMDB_SEARCH") return { results: await searchTmdbTitles(message?.query) };
    if (type === "SEMANTIC_CHECK") {
      return handleSemanticCheck(textToAnalyze, sender?.url || "", sectionHint, containerTag, precedingContext);
    }
    if (type === "BLUR_APPLIED") {
      console.info(`${LOG_PREFIX} BLUR_APPLIED`, {
        href: message?.href,
        tagName: message?.tagName,
        textLength: message?.textLength,
        className: message?.className,
      });
      return { ok: true };
    }
    if (type === "REPORT_FALSE_POSITIVE") {
      const local = await chrome.storage.local.get(["false_positives"]);
      const list = Array.isArray(local.false_positives) ? local.false_positives : [];
      list.push({
        timestamp: new Date().toISOString(),
        url: message?.url || "",
        show: message?.show || "",
        text: message?.text || "",
        reason: message?.reason || "",
        confidence: message?.confidence ?? null,
        source: message?.source || "",
      });
      // Keep last 100 reports to avoid bloating storage.
      await chrome.storage.local.set({ false_positives: list.slice(-100) });
      console.info(`${LOG_PREFIX} REPORT_FALSE_POSITIVE saved`, {
        show: message?.show,
        reason: message?.reason,
        total: list.length,
      });
      return { ok: true };
    }
    throw new Error("Unsupported message type");
  };
  console.info(`${LOG_PREFIX} message received`, {
    type,
    showName,
    hasText: Boolean(textToAnalyze),
    sender: sender?.url || "unknown",
  });

  run()
    .then((result) => {
      console.info(`${LOG_PREFIX} message handled`, { type, ok: true, result });
      sendResponse({ ok: true, data: result });
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} ${type || "unknown"} failed`, error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});
