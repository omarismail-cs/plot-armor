const SHOW_CONTEXTS_KEY = "showContexts";
const EVAL_CACHE_KEY = "evalCache";
const LOG_PREFIX = "[Plot Armor background]";
const SPOILER_CONFIDENCE_THRESHOLD = 0.58;
const MIN_CONFIDENCE_FLOOR = 0.4;
const DETECTOR_VERSION = "v4";
const SIGNAL_PATTERNS = {
  majorSpoilerCues:
    /\b(dies|death|killed|murdered|betray(?:ed|al)|ending|finale|resurrection|returns?|was behind|turns out|secret identity|twist|fate|killed off|identity is revealed)\b/i,
  relationshipReveal:
    /\b(is|was|turns out to be|revealed to be)\b.{0,40}\b(mother|father|brother|sister|son|daughter|parent|half-brother|half-sister|wife|husband)\b/i,
  twistIdentity:
    /\b(real identity|true identity|is actually|was actually|double life|secretly)\b/i,
  nonSpoilerContext:
    /\b(cast|casting|production|development|filming|designer|costume|ratings|rotten tomatoes|metacritic|review|critical consensus|release|soundtrack|music|announced|joined the cast|portray|portrayed|reception)\b/i,
  castingAnnouncement:
    /\b(announced that|was cast as|joined the cast|return(?:s|ed) for|guest appearance|fbi agent|season one returners|in june|in july|in september|in november)\b/i,
};
const HIGH_RISK_SECTION_REGEX = /\b(premise|plot|synopsis|story|characters?)\b/i;
const LOW_RISK_SECTION_REGEX = /\b(casting|production|reception|reviews?|music|soundtrack)\b/i;
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

function looksGenericKeyword(value) {
  const generic = new Set([
    "chaos",
    "dark secret",
    "secret",
    "manipulation",
    "betrayal",
    "conflict",
    "twist",
    "ending",
    "finale",
    "mystery",
    "revenge",
    "power",
    "truth",
  ]);
  const lower = String(value || "").trim().toLowerCase();
  return generic.has(lower);
}

function sanitizeDeathNames(names, showName) {
  const blocked = new Set([
    String(showName || "").trim().toLowerCase(),
    "main character",
    "protagonist",
    "hero",
    "villain",
    "narrator",
  ]);
  return normalizeList(names)
    .filter((name) => {
      const lower = name.toLowerCase();
      if (blocked.has(lower)) return false;
      if (lower.length < 3) return false;
      if (!/[a-z]/i.test(lower)) return false;
      return true;
    })
    .slice(0, 12);
}

function sanitizeStatusChanges(changes) {
  return normalizeList(changes)
    .filter((change) => {
      if (change.length < 10) return false;
      // Require at least one relation/action verb to stay meaningful.
      return /\b(is|was|revealed|betrays|becomes|returns|joins|leaves|killed|dies)\b/i.test(change);
    })
    .slice(0, 12);
}

function sanitizeTwists(twists) {
  return normalizeList(twists)
    .filter((twist) => twist.length >= 10)
    .slice(0, 10);
}

function sanitizeHighRiskKeywords(keywords, showName) {
  const normalizedShow = String(showName || "").trim().toLowerCase();
  return normalizeList(keywords)
    .filter((keyword) => {
      const lower = keyword.toLowerCase();
      if (!lower) return false;
      if (lower === normalizedShow) return true;
      if (looksGenericKeyword(lower)) return false;
      if (lower.length < 4) return false;
      return true;
    })
    .slice(0, 16);
}

function createFallbackContext(showName) {
  return {
    major_death_names: [],
    pivotal_twists: [`Major events from ${showName}.`],
    status_changes: [],
    high_risk_keywords: [showName],
  };
}

function normalizeShowContext(rawContext, showName) {
  if (!rawContext || typeof rawContext !== "object") return createFallbackContext(showName);

  const majorDeathNames = sanitizeDeathNames(rawContext.major_death_names, showName);
  const pivotalTwists = sanitizeTwists(rawContext.pivotal_twists);
  const statusChanges = sanitizeStatusChanges(rawContext.status_changes);
  const highRiskKeywords = sanitizeHighRiskKeywords(rawContext.high_risk_keywords, showName);
  return {
    major_death_names: majorDeathNames,
    pivotal_twists: pivotalTwists.length ? pivotalTwists : [`Major events from ${showName}.`],
    status_changes: statusChanges,
    high_risk_keywords: highRiskKeywords.length ? highRiskKeywords : [showName],
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

async function learnShowContext(showName) {
  const systemPrompt = `You are the Plot Armor Spoiler Assassin. Your job is to find the most 'radioactive' spoilers for the show provided.
STRICT INSTRUCTIONS:
Ignore the Premise: Do NOT include basic setup info (e.g., 'Matt is a lawyer'). Assume the user already knows how the show starts.
Target the Twists: Focus ONLY on major character deaths, secret identities revealed, massive betrayals, and series-finale shocks.
Be Specific: I need the names of people who die and the exact nature of the twists.
Factual Accuracy: Only include things that actually happen in the canon.
Categories to fill:
major_death_names: Names of characters who die later in the series.
pivotal_twists: The biggest shocks of the show.
status_changes: Significant shifts in power or relationships.
high_risk_keywords: 1-2 word phrases that are 'dead giveaways' for spoilers.
Return as a flat JSON object with single-string array items. Analyze: ${showName}`;
  const raw = await callOpenAI(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Forensically analyze the show/movie: ${showName}` },
    ],
    0,
    { response_format: { type: "json_object" } }
  );
  const jsonCandidate = stripToJsonObject(raw);
  const parsed = JSON.parse(jsonCandidate);
  return normalizeShowContext(parsed, showName);
}

async function handleShowAdded(showName) {
  console.info(`${LOG_PREFIX} SHOW_ADDED received`, { showName });
  const local = await chrome.storage.local.get([SHOW_CONTEXTS_KEY]);
  const showContexts = local[SHOW_CONTEXTS_KEY] || {};
  let context;
  let usedFallback = false;

  try {
    context = await learnShowContext(showName);
  } catch (error) {
    console.error(`${LOG_PREFIX} Context fetch failed, using fallback`, { showName, error });
    context = createFallbackContext(showName);
    usedFallback = true;
  }

  showContexts[showName] = context;
  await chrome.storage.local.set({ [SHOW_CONTEXTS_KEY]: showContexts });
  console.info(`${LOG_PREFIX} SHOW_ADDED stored context`, {
    showName,
    deathNames: context.major_death_names.length,
    twists: context.pivotal_twists.length,
    statusChanges: context.status_changes.length,
    highRiskKeywords: context.high_risk_keywords.length,
    usedFallback,
  });
  return { showName, context, usedFallback };
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

function extractContextTerms(showContext) {
  if (!showContext || typeof showContext !== "object") return [];
  const deathNames = normalizeList(showContext.major_death_names);
  const statusChanges = normalizeList(showContext.status_changes);
  const highRiskKeywords = normalizeList(showContext.high_risk_keywords);
  const terms = [...deathNames, ...highRiskKeywords];

  statusChanges.forEach((change) => {
    change
      .split(/[^A-Za-z0-9'’]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 5)
      .forEach((token) => terms.push(token));
  });

  return normalizeList(terms);
}

function tier1AnalyzeShow(textToAnalyze, showContext) {
  const text = String(textToAnalyze || "").toLowerCase();
  const normalizedText = text
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const entities = extractContextTerms(showContext);
  const terms = [];

  entities.forEach((entity) => {
    const full = String(entity || "").toLowerCase().trim();
    if (!full) return;
    terms.push(full);

    // Also match meaningful parts of multi-word entities (e.g. "Matt Murdock" -> "murdock").
    full
      .split(/\s+/)
      .map((token) => token.replace(/[^\w']/g, "").replace(/(?:'s|’s)$/i, ""))
      .filter((token) => token.length >= 5 && !TIER1_TOKEN_BLOCKLIST.has(token))
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

async function runSemanticJudge(showName, showContext, textToAnalyze) {
  const contextBlock = JSON.stringify(
    {
      major_death_names: showContext.major_death_names || [],
      pivotal_twists: showContext.pivotal_twists || [],
      status_changes: showContext.status_changes || [],
      high_risk_keywords: showContext.high_risk_keywords || [],
    },
    null,
    2
  );
  const prompt = [
    "You are a strict spoiler classifier for a spoiler blocker.",
    "If text reveals plot outcomes, character fates, identity reveals, major twists, finales, betrayals, deaths, or arc resolutions, classify as spoiler.",
    "When uncertain between spoiler vs not-spoiler, prefer spoiler for user safety.",
    `Show: ${showName}`,
    `Target spoiler context JSON:\n${contextBlock}`,
    `Text to analyze: ${textToAnalyze}`,
    'Return ONLY valid raw JSON with keys: "isSpoiler" (boolean), "confidence" (number 0..1), "reason" (short non-spoilery explanation).',
  ].join("\n");

  const raw = await callOpenAI([{ role: "user", content: prompt }], 0);
  const jsonCandidate = stripToJsonObject(raw);

  try {
    const parsed = JSON.parse(jsonCandidate);
    const confidence = Number(parsed?.confidence);
    return {
      isSpoiler: Boolean(parsed?.isSpoiler),
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      reason: String(parsed?.reason || "").trim(),
    };
  } catch (_) {
    // Fallback parser for non-JSON model outputs.
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
}) {
  const strongestTier1MatchCount = matchedShows.reduce((maxCount, showName) => {
    const count = tier1ByShow[showName]?.matchedCount || 0;
    return Math.max(maxCount, count);
  }, 0);
  const isLikelyShowPage = matchedShows.some((showName) => looksLikeShowPage(pageUrl, showName));
  const hasMajorCue = SIGNAL_PATTERNS.majorSpoilerCues.test(text);
  const hasRelationshipReveal = SIGNAL_PATTERNS.relationshipReveal.test(text);
  const hasTwistIdentity = SIGNAL_PATTERNS.twistIdentity.test(text);
  const looksLikeNonSpoilerContext = SIGNAL_PATTERNS.nonSpoilerContext.test(text);
  const looksLikeCastingAnnouncement = SIGNAL_PATTERNS.castingAnnouncement.test(text);
  const sectionRisk = getSectionRiskAdjustment(sectionHint);
  let riskScore = sectionRisk + Math.min(0.35, strongestTier1MatchCount * 0.08);

  if (hasMajorCue) riskScore += 0.25;
  if (hasTwistIdentity) riskScore += 0.2;
  if (hasRelationshipReveal) riskScore += 0.35;
  if (looksLikeNonSpoilerContext) riskScore -= 0.2;
  if (looksLikeCastingAnnouncement) riskScore -= 0.2;

  if (hasRelationshipReveal && strongestTier1MatchCount >= 1) {
    return {
      hardBlock: { matched: true, reason: "deterministic-relationship-reveal" },
      hardAllow: { matched: false, reason: "" },
      riskScore: Math.max(riskScore, 0.85),
    };
  }

  if ((hasMajorCue || hasTwistIdentity) && strongestTier1MatchCount >= 2) {
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
    !hasMajorCue
  ) {
    return {
      hardBlock: { matched: false, reason: "" },
      hardAllow: { matched: true, reason: "deterministic-nonspoiler-context" },
      riskScore: Math.min(riskScore, -0.6),
    };
  }

  if (looksLikeCastingAnnouncement && !hasRelationshipReveal && !hasMajorCue) {
    return {
      hardBlock: { matched: false, reason: "" },
      hardAllow: { matched: true, reason: "deterministic-casting-context" },
      riskScore: Math.min(riskScore, -0.6),
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

async function handleSemanticCheck(textToAnalyze, pageUrl = "", sectionHint = "", containerTag = "") {
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
    const analysis = tier1AnalyzeShow(text, showContexts[showName]);
    tier1ByShow[showName] = analysis;
    return analysis.isMatch;
  });
  console.info(`${LOG_PREFIX} SEMANTIC_CHECK tier1 result`, {
    textLength: text.length,
    protectedShows: protectedShows.length,
    matchedShows,
  });

  // Tier 1: local fast pre-filter
  if (!matchedShows.length) {
    return { isSpoiler: false, reason: "tier1-no-match" };
  }

  // Evaluate the highest-risk snippet inside long blocks for better relevance.
  const evaluationText = pickBestEvaluationText(text, matchedShows, showContexts);

  const signals = computeDeterministicSignals({
    text: evaluationText,
    pageUrl,
    sectionHint,
    matchedShows,
    tier1ByShow,
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
      const verdict = await runSemanticJudge(showName, showContext, text);
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

  const run = async () => {
    if (type === "SHOW_ADDED" && showName) return handleShowAdded(showName);
    if (type === "SHOW_REMOVED" && showName) return handleShowRemoved(showName);
    if (type === "SEMANTIC_CHECK") {
      return handleSemanticCheck(textToAnalyze, sender?.url || "", sectionHint, containerTag);
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
