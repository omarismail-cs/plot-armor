console.log("Plot Armor semantic mode active");

const BLUR_CLASS = "plot-armor-blurred";
const OVERLAY_CLASS = "plot-armor-overlay";
const PROCESSED_ATTR = "data-plot-armor-processed";
const VISIBLE_ATTR = "data-plot-armor-visible";
const DEBUG = true;
const MIN_TEXT_LENGTH = 40;
const MAX_ANALYZE_CHARS = 900;
const DEBOUNCE_MS = 250;
const EVAL_CONCURRENCY_LIMIT = 2;
const FALLBACK_SELECTOR = "[id='mw-content-text'] .mw-parser-output > p";
const FALLBACK_EXCLUDE_SELECTOR =
  "nav, .toc, .toclevel-1, .toclevel-2, .toclevel-3, .infobox, .references, .metadata, header, footer, aside";
const REDDIT_COMMENT_SELECTOR =
  "shreddit-comment, [data-testid='comment'], [data-test-id='comment'], article[thingid^='t1_'], div[id^='comment-thing-']";

let processVisibleDebounce = null;
const observedContainers = new WeakSet();
const visibleContainers = new Set();
const queuedContainers = new WeakSet();
const pendingEvaluationQueue = [];
let activeEvaluations = 0;

function getCandidateSelector() {
  const host = location.hostname.toLowerCase();
  if (host.includes("reddit.com")) {
    return [
      "shreddit-post",
      "shreddit-comment",
      'article[data-testid="post-container"]',
      '[data-testid="comment"]',
      '[data-test-id="comment"]',
      'div[data-click-id="body"]',
      'article[thingid^="t1_"]',
      'div[id^="comment-thing-"]',
      "article",
    ].join(", ");
  }
  if (host.includes("twitter.com") || host.includes("x.com")) {
    return 'article[data-testid="tweet"], [data-testid="cellInnerDiv"] article';
  }
  if (host.includes("wikipedia.org")) {
    return "[id='mw-content-text'] .mw-parser-output > p, [id='mw-content-text'] .mw-parser-output > ul > li";
  }
  return "article, [role='article'], main p";
}

function injectStyles() {
  if (document.getElementById("plot-armor-semantic-style")) return;

  const style = document.createElement("style");
  style.id = "plot-armor-semantic-style";
  style.textContent = `
    .${BLUR_CLASS} {
      position: relative !important;
      border-radius: 12px;
    }

    .${BLUR_CLASS} > :not(.${OVERLAY_CLASS}) {
      filter: blur(8px) saturate(0.92) contrast(0.92);
      transition: filter 0.2s ease, opacity 0.2s ease;
      opacity: 0.9;
      pointer-events: none;
    }

    .${OVERLAY_CLASS} {
      position: static;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 10px 16px;
      width: fit-content;
      max-width: min(95%, 560px);
      margin: 10px auto 0 auto;
      color: #ffffff;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.3;
      background: rgba(16, 18, 25, 0.72);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      z-index: 2147483647;
      cursor: pointer;
      user-select: none;
      white-space: normal;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);
}

function ensureContainerPosition(container) {
  const computed = getComputedStyle(container);
  if (computed.position === "static") {
    container.style.position = "relative";
  }
}

function revealContainer(container) {
  container.classList.remove(BLUR_CLASS);
  container.removeAttribute("data-plot-armor-blurred");
  const overlay = container.querySelector(`:scope > .${OVERLAY_CLASS}`);
  if (overlay) overlay.remove();
}

function blurContainer(container) {
  if (container.classList.contains(BLUR_CLASS)) return;
  ensureContainerPosition(container);

  container.classList.add(BLUR_CLASS);
  container.setAttribute("data-plot-armor-blurred", "1");
  const overlay = document.createElement("div");
  overlay.className = OVERLAY_CLASS;
  overlay.textContent = "🛡️ Hidden by Plot Armor. Click to reveal.";
  overlay.style.setProperty("z-index", "2147483647", "important");
  overlay.style.setProperty("pointer-events", "auto", "important");
  overlay.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealContainer(container);
  });
  container.appendChild(overlay);
  debugLog("Blur applied", {
    tag: container.tagName,
    className: container.className,
    textLength: extractContainerText(container).length,
  });
  chrome.runtime
    .sendMessage({
      type: "BLUR_APPLIED",
      textLength: extractContainerText(container).length,
      tagName: container.tagName,
      className: container.className,
      href: location.href,
    })
    .catch(() => {});
}

function extractContainerText(container) {
  const host = location.hostname.toLowerCase();
  if (!host.includes("reddit.com")) {
    return (container.innerText || "").replace(/\s+/g, " ").trim();
  }

  const clone = container.cloneNode(true);
  const nestedComments = clone.querySelectorAll(REDDIT_COMMENT_SELECTOR);
  nestedComments.forEach((node) => {
    if (node === clone) return;
    node.remove();
  });

  return (clone.innerText || "").replace(/\s+/g, " ").trim();
}

function debugLog(message, payload) {
  if (!DEBUG) return;
  console.info(`[Plot Armor content] ${message}`, payload || "");
}

function normalizeHeadingText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function getSectionHint(container) {
  if (!(container instanceof Element)) return "";

  // Prefer the closest previous heading in document flow.
  let node = container;
  while (node && node !== document.body) {
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (/^H[1-6]$/.test(sibling.tagName)) {
        return normalizeHeadingText(sibling.textContent);
      }
      const nestedHeading = sibling.querySelector?.("h1, h2, h3, h4, h5, h6");
      if (nestedHeading) {
        return normalizeHeadingText(nestedHeading.textContent);
      }
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }

  const closestHeading = container.closest("section, article, main, [id='mw-content-text']")?.querySelector(
    "h1, h2, h3, h4, h5, h6"
  );
  if (closestHeading) {
    return normalizeHeadingText(closestHeading.textContent);
  }

  return "";
}

async function evaluateContainer(container) {
  if (!(container instanceof Element)) return;
  if (container.getAttribute(PROCESSED_ATTR) === "1") return;

  const textToAnalyze = extractContainerText(container);
  const isRedditComment =
    location.hostname.toLowerCase().includes("reddit.com") &&
    (container.matches("shreddit-comment, [data-testid='comment'], [data-test-id='comment']") ||
      String(container.getAttribute("thingid") || "").startsWith("t1_") ||
      String(container.id || "").startsWith("comment-thing-"));
  const minLengthForContainer = isRedditComment ? 20 : MIN_TEXT_LENGTH;

  if (!textToAnalyze || textToAnalyze.length < minLengthForContainer) {
    container.setAttribute(PROCESSED_ATTR, "1");
    return;
  }
  const analysisText = textToAnalyze.slice(0, MAX_ANALYZE_CHARS);
  const sectionHint = getSectionHint(container);
  debugLog("Evaluating container", { textLength: textToAnalyze.length, tag: container.tagName });

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SEMANTIC_CHECK",
      textToAnalyze: analysisText,
      sectionHint,
      containerTag: container.tagName,
    });
    debugLog("Semantic check response", response?.data || response);

    if (response?.ok && response.data?.isSpoiler) {
      blurContainer(container);
      debugLog("Container blurred", { reason: response.data?.reason });
    }
  } catch (error) {
    console.error("Plot Armor semantic request failed", error);
  } finally {
    container.setAttribute(PROCESSED_ATTR, "1");
  }
}

function pumpEvaluationQueue() {
  while (activeEvaluations < EVAL_CONCURRENCY_LIMIT && pendingEvaluationQueue.length) {
    const next = pendingEvaluationQueue.shift();
    if (!next || !next.isConnected || next.getAttribute(PROCESSED_ATTR) === "1") continue;

    activeEvaluations += 1;
    queuedContainers.delete(next);
    void evaluateContainer(next).finally(() => {
      activeEvaluations -= 1;
      pumpEvaluationQueue();
    });
  }
}

function enqueueEvaluation(container) {
  if (!(container instanceof Element)) return;
  if (container.getAttribute(PROCESSED_ATTR) === "1") return;
  if (queuedContainers.has(container)) return;
  queuedContainers.add(container);
  pendingEvaluationQueue.push(container);
  pumpEvaluationQueue();
}

function processVisibleContainers() {
  visibleContainers.forEach((container) => {
    if (container.getAttribute(VISIBLE_ATTR) === "1") {
      enqueueEvaluation(container);
    }
  });
}

function debounceProcessVisible() {
  if (processVisibleDebounce) clearTimeout(processVisibleDebounce);
  processVisibleDebounce = setTimeout(processVisibleContainers, DEBOUNCE_MS);
}

const intersectionObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const container = entry.target;
      if (entry.isIntersecting) {
        container.setAttribute(VISIBLE_ATTR, "1");
        visibleContainers.add(container);
      } else {
        container.setAttribute(VISIBLE_ATTR, "0");
        visibleContainers.delete(container);
      }
    });
    debounceProcessVisible();
  },
  { root: null, rootMargin: "200px 0px", threshold: 0.05 }
);

function observeContainer(container) {
  if (!(container instanceof Element)) return;
  if (shouldSkipContainer(container)) return;
  if (observedContainers.has(container)) return;
  observedContainers.add(container);
  intersectionObserver.observe(container);
  // Immediate first pass so initial viewport content is not missed.
  enqueueEvaluation(container);
}

function shouldSkipContainer(container) {
  if (!(container instanceof Element)) return true;
  if (container.closest(FALLBACK_EXCLUDE_SELECTOR)) return true;

  const className = (container.className || "").toString().toLowerCase();
  const id = (container.id || "").toLowerCase();
  if (
    className.includes("toclevel") ||
    className.includes("toc") ||
    className.includes("navbox") ||
    className.includes("infobox") ||
    className.includes("reference") ||
    id.includes("toc")
  ) {
    return true;
  }

  if (location.hostname.toLowerCase().includes("reddit.com")) {
    const ownText = extractContainerText(container);
    if (!ownText || ownText.length < 5) return true;
  }

  return false;
}

function discoverContainers(root = document) {
  if (!(root instanceof Element || root instanceof Document)) return;
  const candidateSelector = getCandidateSelector();

  if (root instanceof Element && root.matches(candidateSelector)) {
    observeContainer(root);
  }
  root.querySelectorAll(candidateSelector).forEach(observeContainer);

  // Fallback path for pages that don't expose social-specific wrappers.
  if (root === document && location.hostname.toLowerCase().includes("wikipedia.org")) {
    const fallbackNodes = Array.from(document.querySelectorAll(FALLBACK_SELECTOR)).filter(
      (node) => !node.closest(FALLBACK_EXCLUDE_SELECTOR)
    );
    fallbackNodes.forEach(observeContainer);
    debugLog("Discovered containers", {
      observed: observedContainers ? "tracked" : "n/a",
      fallbackCount: fallbackNodes.length,
    });
  }
}

const mutationObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        discoverContainers(node);
      }
    });
  });
});

function resetAndReevaluate() {
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
    el.removeAttribute(PROCESSED_ATTR);
  });
  document.querySelectorAll(`.${BLUR_CLASS}`).forEach((container) => {
    revealContainer(container);
  });
  pendingEvaluationQueue.length = 0;
  debounceProcessVisible();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  const localContextChanged = areaName === "local" && Boolean(changes.showContexts);
  const syncShowsChanged = areaName === "sync" && Boolean(changes.protectedShows);
  if (!localContextChanged && !syncShowsChanged) return;
  debugLog("Storage changed, resetting reevaluation", { areaName });
  resetAndReevaluate();
});

injectStyles();
discoverContainers(document);
mutationObserver.observe(document.body, { childList: true, subtree: true });
debugLog("Semantic scanner initialized");
