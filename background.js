const KEYWORDS_BY_SHOW_KEY = "keywordsByShow";
const ALL_KEYWORDS_KEY = "allSpoilerKeywords";
let cachedApiKey = null;
const LOG_PREFIX = "[Plot Armor background]";
const MIN_EXPECTED_KEYWORDS = 8;

function getLocalStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result));
  });
}

function setLocalStorage(payload) {
  return new Promise((resolve) => {
    chrome.storage.local.set(payload, resolve);
  });
}

async function loadApiKeyFromEnv() {
  if (cachedApiKey) {
    console.info(`${LOG_PREFIX} Reusing cached OPENAI_API_KEY from .env`);
    return cachedApiKey;
  }

  const envUrl = chrome.runtime.getURL(".env");
  console.info(`${LOG_PREFIX} Loading .env from extension root`);
  const response = await fetch(envUrl);
  if (!response.ok) {
    console.error(`${LOG_PREFIX} Failed to load .env file`);
    throw new Error("Could not load .env file. Create one in the project root.");
  }

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
      console.info(`${LOG_PREFIX} OPENAI_API_KEY loaded from .env`);
      return cachedApiKey;
    }
  }

  console.error(`${LOG_PREFIX} OPENAI_API_KEY missing in .env`);
  throw new Error("OPENAI_API_KEY not found in .env");
}

function normalizeKeyword(rawKeyword) {
  return rawKeyword
    .trim()
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\s+/g, " ");
}

function parseKeywords(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return [];
  }

  const splitEntries = rawText
    .split(/,|\r?\n|;|\|/g)
    .map(normalizeKeyword)
    .filter(Boolean);

  const seen = new Set();
  const unique = [];

  splitEntries.forEach((entry) => {
    const normalized = entry.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    unique.push(entry);
  });

  return unique;
}

async function fetchKeywordsForShow(showName, attempt = 1) {
  const apiKey = await loadApiKeyFromEnv();
  const prompt = [
    `Give me a comma-separated list of 20 highly specific keywords, character names, and major plot events associated with the show ${showName}.`,
    "Output only the list (no intro text, no numbering, no bullets).",
  ].join(" ");
  console.info(`${LOG_PREFIX} Starting OpenAI keyword fetch for "${showName}"`, { attempt });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`${LOG_PREFIX} OpenAI request failed`, {
      showName,
      status: response.status,
      errorBody,
    });
    throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  const parsedKeywords = parseKeywords(raw);
  console.info(`${LOG_PREFIX} OpenAI keyword fetch succeeded for "${showName}"`, {
    attempt,
    parsedKeywords: parsedKeywords.length,
  });

  if (parsedKeywords.length >= MIN_EXPECTED_KEYWORDS) {
    return parsedKeywords;
  }

  if (attempt < 2) {
    console.warn(`${LOG_PREFIX} Parsed too few keywords, retrying`, {
      showName,
      attempt,
      parsedKeywords: parsedKeywords.length,
    });
    return fetchKeywordsForShow(showName, attempt + 1);
  }

  return parsedKeywords;
}

function mergeUniqueKeywords(keywordsByShow) {
  const seen = new Set();
  const merged = [];

  Object.values(keywordsByShow).forEach((showKeywords) => {
    showKeywords.forEach((keyword) => {
      const normalized = keyword.toLowerCase();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      merged.push(keyword);
    });
  });

  return merged;
}

async function handleShowAdded(showName) {
  console.info(`${LOG_PREFIX} Received show add event`, { showName });
  const existing = await getLocalStorage([KEYWORDS_BY_SHOW_KEY]);
  const keywordsByShow = existing[KEYWORDS_BY_SHOW_KEY] || {};
  let keywords = [];
  let usedFallback = false;

  try {
    keywords = await fetchKeywordsForShow(showName);
  } catch (error) {
    // Keep the feature working even when API/env/network fails.
    console.warn("Plot Armor keyword fetch failed, using fallback:", error.message);
    usedFallback = true;
  }

  if (!keywords.length) {
    keywords = [showName];
    usedFallback = true;
    console.warn(`${LOG_PREFIX} Using fallback keyword list`, { showName, keywords });
  } else if (keywords.length < MIN_EXPECTED_KEYWORDS) {
    // Keep at least show name included when output quality is low.
    keywords = [showName, ...keywords];
    console.warn(`${LOG_PREFIX} Keyword list is small; show name injected for safety`, {
      showName,
      keywordsCount: keywords.length,
    });
  }

  keywordsByShow[showName] = keywords;
  const allSpoilerKeywords = mergeUniqueKeywords(keywordsByShow);

  await setLocalStorage({
    [KEYWORDS_BY_SHOW_KEY]: keywordsByShow,
    [ALL_KEYWORDS_KEY]: allSpoilerKeywords,
  });
  console.info(`${LOG_PREFIX} Saved keywords to chrome.storage.local`, {
    showName,
    keywordsForShow: keywords.length,
    totalKeywords: allSpoilerKeywords.length,
    usedFallback,
  });

  return { showName, keywords, totalKeywords: allSpoilerKeywords.length, usedFallback };
}

async function handleShowRemoved(showName) {
  console.info(`${LOG_PREFIX} Received show remove event`, { showName });
  const existing = await getLocalStorage([KEYWORDS_BY_SHOW_KEY]);
  const keywordsByShow = existing[KEYWORDS_BY_SHOW_KEY] || {};

  if (keywordsByShow[showName]) {
    delete keywordsByShow[showName];
  }

  const allSpoilerKeywords = mergeUniqueKeywords(keywordsByShow);
  await setLocalStorage({
    [KEYWORDS_BY_SHOW_KEY]: keywordsByShow,
    [ALL_KEYWORDS_KEY]: allSpoilerKeywords,
  });

  console.info(`${LOG_PREFIX} Removed show keywords from chrome.storage.local`, {
    showName,
    totalKeywords: allSpoilerKeywords.length,
  });

  return { showName, totalKeywords: allSpoilerKeywords.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.showName) {
    return false;
  }
  console.info(`${LOG_PREFIX} Message received`, {
    type: message.type,
    showName: message.showName,
    sender: sender?.url || "unknown",
  });

  const handler =
    message.type === "SHOW_ADDED"
      ? handleShowAdded
      : message.type === "SHOW_REMOVED"
      ? handleShowRemoved
      : null;

  if (!handler) {
    return false;
  }

  handler(message.showName)
    .then((result) => {
      console.info(`${LOG_PREFIX} ${message.type} completed`, result);
      sendResponse({ ok: true, data: result });
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} ${message.type} failed`, error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});
