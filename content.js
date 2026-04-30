console.log("Plot Armor semantic mode active");

const BLUR_CLASS = "plot-armor-blurred";
const OVERLAY_CLASS = "plot-armor-overlay";
const PROCESSED_ATTR = "data-plot-armor-processed";
const VISIBLE_ATTR = "data-plot-armor-visible";
const DEBUG = true;
const MIN_TEXT_LENGTH = 40;
const MAX_ANALYZE_CHARS = 900;
const DEBOUNCE_MS = 100;
const EVAL_CONCURRENCY_LIMIT = 5;
const FALLBACK_SELECTOR = "[id='mw-content-text'] .mw-parser-output > p, [id='mw-content-text'] .mw-parser-output td.summary, [id='mw-content-text'] .mw-parser-output td.description";
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
    return [
      "[id='mw-content-text'] .mw-parser-output > p",
      "[id='mw-content-text'] .mw-parser-output > ul > li",
      "[id='mw-content-text'] .mw-parser-output td.summary",
      "[id='mw-content-text'] .mw-parser-output td.description",
    ].join(", ");
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
      min-height: 2em;
      pointer-events: none;
    }

    .plot-armor-blur-wrapper {
      filter: blur(7px) saturate(0.9) contrast(0.9);
      opacity: 0.85;
      pointer-events: auto;
      user-select: none;
      cursor: pointer;
      transition: filter 0.2s ease, opacity 0.2s ease;
    }

    .${OVERLAY_CLASS} {
      position: absolute;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 18px;
      width: max-content;
      max-width: 460px;
      color: #ffffff;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      white-space: nowrap;
      background: rgba(14, 16, 22, 0.88);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 999px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
      z-index: 2147483647;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
    }

    .plot-armor-report-btn {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 10px;
      font-size: 11px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.75);
      background: rgba(14, 16, 22, 0.78);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.3);
      cursor: pointer;
      z-index: 2147483647;
      pointer-events: auto;
      user-select: none;
      vertical-align: middle;
      line-height: 1.8;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }

    .plot-armor-report-btn:hover {
      color: #ff6b6b;
      background: rgba(30, 16, 16, 0.92);
      border-color: rgba(220, 80, 80, 0.55);
    }

    .plot-armor-report-btn.reported {
      color: #6bff9e;
      border-color: rgba(50, 220, 100, 0.5);
      background: rgba(14, 30, 20, 0.88);
      pointer-events: none;
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
  // Read meta before clearing attributes.
  const show = container.dataset.paShow || "";
  const reason = container.dataset.paReason || "";
  const confidence = container.dataset.paConfidence || null;
  const source = container.dataset.paSource || "";

  container.classList.remove(BLUR_CLASS);
  container.removeAttribute("data-plot-armor-blurred");
  delete container.dataset.paShow;
  delete container.dataset.paReason;
  delete container.dataset.paConfidence;
  delete container.dataset.paSource;
  container.style.position = "";

  const overlay = container.querySelector(`:scope > .${OVERLAY_CLASS}`);
  if (overlay) overlay.remove();
  const existingReport = container.querySelector(".plot-armor-report-btn");
  if (existingReport) existingReport.remove();

  // Unwrap blurred content wrapper back into the container.
  const wrapper = container.querySelector(":scope > .plot-armor-blur-wrapper");
  if (wrapper) {
    while (wrapper.firstChild) container.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }

  // Show the report button AFTER reveal so the user can read the content first.
  const reportBtn = document.createElement("button");
  reportBtn.className = "plot-armor-report-btn";
  reportBtn.textContent = "⚑ not a spoiler?";
  reportBtn.title = "Report this as a false positive";
  reportBtn.style.setProperty("pointer-events", "auto", "important");

  let autoRemoveTimer = setTimeout(() => reportBtn.remove(), 10000);

  reportBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(autoRemoveTimer);
    reportBtn.textContent = "✓ logged";
    reportBtn.classList.add("reported");
    chrome.runtime.sendMessage({
      type: "REPORT_FALSE_POSITIVE",
      text: extractContainerText(container).slice(0, 500),
      show,
      reason,
      confidence: confidence !== "" ? Number(confidence) : null,
      source,
      url: location.href,
    }).catch(() => {});
    setTimeout(() => reportBtn.remove(), 1200);
  });

  // Inject inline at the end of the last text-bearing child so the button
  // flows naturally after the last word without overlapping anything.
  const lastTextChild = Array.from(container.childNodes)
    .reverse()
    .find((n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim()));
  if (lastTextChild && lastTextChild.nodeType === Node.ELEMENT_NODE) {
    lastTextChild.appendChild(reportBtn);
  } else {
    container.appendChild(reportBtn);
  }
}

function blurContainer(container, meta = {}) {
  if (container.classList.contains(BLUR_CLASS)) return;
  ensureContainerPosition(container);

  // Wrap ALL child nodes (including bare text nodes) in a single div so
  // the blur filter covers everything, not just element children.
  // On Reddit, nested comment containers must stay outside the wrapper so
  // each reply is evaluated and revealed independently.
  const blurWrapper = document.createElement("div");
  blurWrapper.className = "plot-armor-blur-wrapper";

  const isReddit = location.hostname.toLowerCase().includes("reddit.com");
  const childSnapshot = Array.from(container.childNodes);
  const skippedChildren = [];

  childSnapshot.forEach((node) => {
    const isNestedComment =
      isReddit &&
      node.nodeType === Node.ELEMENT_NODE &&
      node.matches &&
      node.matches(REDDIT_COMMENT_SELECTOR);
    if (isNestedComment) {
      skippedChildren.push(node);
    } else {
      blurWrapper.appendChild(node);
    }
  });

  blurWrapper.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealContainer(container);
  });

  container.appendChild(blurWrapper);
  // Re-attach nested comments after the wrapper so they remain independent.
  skippedChildren.forEach((node) => container.appendChild(node));

  container.classList.add(BLUR_CLASS);
  container.setAttribute("data-plot-armor-blurred", "1");

  const overlay = document.createElement("div");
  overlay.className = OVERLAY_CLASS;
  overlay.textContent = "🛡️ Hidden by Plot Armor — click to reveal";
  overlay.style.setProperty("z-index", "2147483647", "important");
  overlay.style.setProperty("pointer-events", "auto", "important");
  // Store meta on the element so revealContainer can attach the report button after reveal.
  container.dataset.paShow = meta.matchedShow || "";
  container.dataset.paReason = meta.reason || "";
  container.dataset.paConfidence = meta.confidence ?? "";
  container.dataset.paSource = meta.source || "";

  overlay.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    revealContainer(container);
  });
  container.appendChild(overlay);

  // Use Range.getClientRects() to find the actual visual bounding box of the
  // text content. Unlike getBoundingClientRect() on a block element, this
  // accounts for CSS floats that make the container wider than the text area.
  requestAnimationFrame(() => {
    const cRect = container.getBoundingClientRect();
    let cx, cy;

    try {
      const range = document.createRange();
      range.selectNodeContents(blurWrapper);
      const lineRects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 2 && r.height > 2
      );
      if (lineRects.length > 0) {
        const minLeft = Math.min(...lineRects.map((r) => r.left));
        const maxRight = Math.max(...lineRects.map((r) => r.right));
        const minTop = Math.min(...lineRects.map((r) => r.top));
        const maxBottom = Math.max(...lineRects.map((r) => r.bottom));
        cx = (minLeft + maxRight) / 2 - cRect.left;
        cy = (minTop + maxBottom) / 2 - cRect.top;
      }
    } catch (_) {}

    if (cx == null || cy == null) {
      const wRect = blurWrapper.getBoundingClientRect();
      cx = wRect.left - cRect.left + wRect.width / 2;
      cy = wRect.top - cRect.top + wRect.height / 2;
    }

    overlay.style.top = `${cy}px`;
    overlay.style.left = `${cx}px`;
  });

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

function getPrecedingContext(container) {
  let sibling = container.previousElementSibling;
  while (sibling) {
    // Stop at headings or non-text structural elements — they don't give pronoun context.
    if (/^(H[1-6]|TABLE|FIGURE|FIGCAPTION|NAV|ASIDE|UL|OL)$/.test(sibling.tagName)) break;
    if (sibling.closest(FALLBACK_EXCLUDE_SELECTOR)) break;

    const text = (sibling.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length >= 20) {
      // Take the last 2 sentences, capped at 250 chars — enough for pronoun resolution.
      const sentences = text.split(/(?<=[.!?])\s+/);
      return sentences.slice(-2).join(" ").slice(-250).trim();
    }
    sibling = sibling.previousElementSibling;
  }
  return "";
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
  const precedingContext = getPrecedingContext(container);
  debugLog("Evaluating container", { textLength: textToAnalyze.length, tag: container.tagName, hasPrecedingContext: Boolean(precedingContext) });

  try {
    const response = await chrome.runtime.sendMessage({
      type: "SEMANTIC_CHECK",
      textToAnalyze: analysisText,
      precedingContext,
      sectionHint,
      containerTag: container.tagName,
    });
    debugLog("Semantic check response", response?.data || response);

    if (response?.ok && response.data?.isSpoiler) {
      blurContainer(container, {
        matchedShow: response.data?.matchedShow || "",
        reason: response.data?.reason || "",
        confidence: response.data?.confidence ?? null,
        source: response.data?.source || "",
      });
      debugLog("Container blurred", { reason: response.data?.reason });
    }
  } catch (error) {
    if (isContextInvalidated(error)) {
      shutdownObservers();
    } else {
      console.error("Plot Armor semantic request failed", error);
    }
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

function enqueueEvaluation(container, priority = false) {
  if (!(container instanceof Element)) return;
  if (container.getAttribute(PROCESSED_ATTR) === "1") return;
  if (queuedContainers.has(container)) {
    // Already queued — if now high priority, move to front.
    if (priority) {
      const idx = pendingEvaluationQueue.indexOf(container);
      if (idx > 0) {
        pendingEvaluationQueue.splice(idx, 1);
        pendingEvaluationQueue.unshift(container);
      }
    }
    return;
  }
  queuedContainers.add(container);
  if (priority) {
    pendingEvaluationQueue.unshift(container);
  } else {
    pendingEvaluationQueue.push(container);
  }
  pumpEvaluationQueue();
}

function processVisibleContainers() {
  visibleContainers.forEach((container) => {
    if (container.getAttribute(VISIBLE_ATTR) === "1") {
      enqueueEvaluation(container, true);
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
        // Enqueue immediately with priority so content the user can actually
        // see is processed before off-screen paragraphs already in the queue.
        enqueueEvaluation(container, true);
      } else {
        container.setAttribute(VISIBLE_ATTR, "0");
        visibleContainers.delete(container);
      }
    });
  },
  { root: null, rootMargin: "400px 0px", threshold: 0.05 }
);

function observeContainer(container) {
  if (!(container instanceof Element)) return;
  if (shouldSkipContainer(container)) return;
  if (observedContainers.has(container)) return;
  observedContainers.add(container);
  // IntersectionObserver fires immediately for elements already in viewport,
  // so no separate enqueue needed here — visible ones get priority-queued there.
  intersectionObserver.observe(container);
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

function isContextInvalidated(error) {
  return (
    error instanceof Error &&
    (error.message.includes("Extension context invalidated") ||
      error.message.includes("Could not establish connection"))
  );
}

let observersStopped = false;
function shutdownObservers() {
  if (observersStopped) return;
  observersStopped = true;
  mutationObserver.disconnect();
  intersectionObserver.disconnect();
  pendingEvaluationQueue.length = 0;
  debugLog("Extension context lost — observers shut down. Reload the page to re-activate Plot Armor.");
}

const mutationObserver = new MutationObserver((mutations) => {
  if (observersStopped) return;
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
  if (observersStopped) return;
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
