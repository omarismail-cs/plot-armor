console.log("Plot Armor is active on this page");

const TARGET_SELECTOR = "p, span:not(.plot-armor-spoiler), div";
const SPOILER_CLASS = "plot-armor-spoiler";
const ALL_KEYWORDS_KEY = "allSpoilerKeywords";
const SHOWS_KEY = "protectedShows";
const EXCLUDED_CONTAINER_SELECTOR = "script, style, noscript, textarea, template, title";
let keywordRegex = null;

function createSpoilerSpan(text) {
  const span = document.createElement("span");
  span.className = SPOILER_CLASS;
  span.textContent = text;
  span.style.filter = "blur(8px)";
  span.style.transition = "filter 0.25s ease";
  return span;
}

function blurSpoilerInTextNode(textNode) {
  if (!(textNode instanceof Text)) {
    return;
  }

  if (textNode.parentElement?.closest(`.${SPOILER_CLASS}`)) {
    return;
  }

  if (textNode.parentElement?.closest(EXCLUDED_CONTAINER_SELECTOR)) {
    return;
  }

  const text = textNode.textContent || "";
  if (!text || !keywordRegex) {
    return;
  }

  // Global regexes keep state via lastIndex; always reset per text node.
  keywordRegex.lastIndex = 0;
  if (!keywordRegex.test(text)) {
    return;
  }

  keywordRegex.lastIndex = 0;
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let match = keywordRegex.exec(text);

  while (match) {
    const matchedText = match[0];
    const matchIndex = match.index;

    if (matchIndex > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, matchIndex)));
    }

    fragment.appendChild(createSpoilerSpan(matchedText));
    cursor = matchIndex + matchedText.length;
    match = keywordRegex.exec(text);
  }

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }

  try {
    textNode.replaceWith(fragment);
  } catch (error) {
    // Some browser-managed nodes (e.g. speculation rules scripts) cannot be edited.
    console.debug("Plot Armor skipped non-replaceable text node:", error);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeyword(keyword) {
  return keyword
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ");
}

function buildKeywordPattern(keyword) {
  const tokens = normalizeKeyword(keyword).split(" ").filter(Boolean);
  if (!tokens.length) {
    return "";
  }

  // Match flexible spacing and allow possessive suffixes (Elektra -> Elektra's).
  const phrase = tokens.map(escapeRegex).join("[\\s\\u00A0]+");
  return `(?<![A-Za-z0-9])${phrase}(?:['’]s)?(?![A-Za-z0-9])`;
}

function updateKeywordRegex(keywords) {
  if (!Array.isArray(keywords) || !keywords.length) {
    keywordRegex = null;
    return;
  }

  const sanitized = keywords
    .map(normalizeKeyword)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map(buildKeywordPattern)
    .filter(Boolean);

  if (!sanitized.length) {
    keywordRegex = null;
    return;
  }

  keywordRegex = new RegExp(`(${sanitized.join("|")})`, "gi");
}

function blurIfSpoiler(element) {
  if (!(element instanceof Element) || !element.matches(TARGET_SELECTOR)) {
    return;
  }

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  textNodes.forEach(blurSpoilerInTextNode);
}

function scanElement(root) {
  if (!(root instanceof Element)) {
    return;
  }

  blurIfSpoiler(root);
  root.querySelectorAll(TARGET_SELECTOR).forEach(blurIfSpoiler);
}

const observer = new MutationObserver((mutations) => {
  observer.disconnect();

  mutations.forEach((mutation) => {
    if (mutation.type === "characterData") {
      const parent = mutation.target.parentElement;
      if (!parent) return;

      const target = parent.matches(TARGET_SELECTOR)
        ? parent
        : parent.closest(TARGET_SELECTOR);
      if (target) blurIfSpoiler(target);
      return;
    }

    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        scanElement(node);
      } else if (node.nodeType === Node.TEXT_NODE) {
        blurSpoilerInTextNode(node);
      }
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

function refreshKeywordsAndScan() {
  chrome.storage.local.get([ALL_KEYWORDS_KEY], (localResult) => {
    chrome.storage.sync.get([SHOWS_KEY], (syncResult) => {
      const localKeywords = Array.isArray(localResult[ALL_KEYWORDS_KEY])
        ? localResult[ALL_KEYWORDS_KEY]
        : [];
      const protectedShows = Array.isArray(syncResult[SHOWS_KEY]) ? syncResult[SHOWS_KEY] : [];

      const mergedKeywords = [...localKeywords, ...protectedShows];
      updateKeywordRegex(mergedKeywords);
      scanElement(document.body);
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  const localKeywordChanged = areaName === "local" && Boolean(changes[ALL_KEYWORDS_KEY]);
  const syncShowsChanged = areaName === "sync" && Boolean(changes[SHOWS_KEY]);
  if (!localKeywordChanged && !syncShowsChanged) {
    return;
  }

  refreshKeywordsAndScan();
});

refreshKeywordsAndScan();
