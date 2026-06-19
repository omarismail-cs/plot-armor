console.log("Plot Armor semantic mode active");

const BLUR_CLASS = "plot-armor-blurred";
const OVERLAY_CLASS = "plot-armor-overlay";
const PROCESSED_ATTR = "data-plot-armor-processed";
const VISIBLE_ATTR = "data-plot-armor-visible";
const USER_REVEALED_ATTR = "data-plot-armor-user-revealed";
const DEBUG = true;
const MIN_TEXT_LENGTH = 40;
const MAX_ANALYZE_CHARS = 900;
const DEBOUNCE_MS = 100;
const EVAL_CONCURRENCY_LIMIT = 5;
const PREFETCH_MARGIN_PX = 1400;
const FALLBACK_SELECTOR = "[id='mw-content-text'] .mw-parser-output > p, [id='mw-content-text'] .mw-parser-output td.summary, [id='mw-content-text'] .mw-parser-output td.description";
const FALLBACK_EXCLUDE_SELECTOR =
  "nav, .toc, .toclevel-1, .toclevel-2, .toclevel-3, .infobox, .references, .metadata, header, footer, aside";
const REDDIT_COMMENT_SELECTOR =
  "shreddit-comment, [data-testid='comment'], [data-test-id='comment'], article[thingid^='t1_'], div[id^='comment-thing-']";

let missingExtensionRuntimeLogged = false;

/** MV3 content scripts normally have chrome.runtime; it can be missing after disable/reload races or in odd frames. */
function getExtensionRuntime() {
  try {
    if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) return chrome.runtime;
    if (typeof browser !== "undefined" && browser?.runtime?.sendMessage) return browser.runtime;
  } catch (_) {
    return null;
  }
  return null;
}

const MESSAGE_CHANNEL_CLOSED_RE =
  /message channel closed before a response was received/i;

async function sendExtensionMessage(message, { retries = 1 } = {}) {
  const rt = getExtensionRuntime();
  if (!rt) {
    if (!missingExtensionRuntimeLogged) {
      missingExtensionRuntimeLogged = true;
      debugLog("Extension messaging unavailable (runtime missing); stopping observers for this tab.");
      shutdownObservers();
    }
    return null;
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await rt.sendMessage(message);
    } catch (error) {
      lastError = error;
      if (isContextInvalidated(error)) {
        shutdownObservers();
        return null;
      }
      const msg = String(error?.message || error);
      if (MESSAGE_CHANNEL_CLOSED_RE.test(msg) && attempt < retries) {
        debugLog("SEMANTIC_CHECK channel closed; retrying after service worker wake", { attempt });
        await new Promise((resolve) => setTimeout(resolve, 400 + attempt * 300));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

let processVisibleDebounce = null;
const observedContainers = new WeakSet();
const visibleContainers = new Set();
const queuedContainers = new WeakSet();

/** X virtualizes timeline cells; we must unobserve removed nodes or IO holds strong refs and scroll/load stalls. */
function cleanupObservedContainer(container) {
  if (!(container instanceof Element)) return;
  if (!observedContainers.has(container)) return;
  const blurSurface = getPlotArmorBlurSurface(container);
  if (blurSurface.classList.contains(BLUR_CLASS) || container.classList.contains(BLUR_CLASS)) {
    revealContainer(container, { skipReport: true });
  }
  intersectionObserver.unobserve(container);
  observedContainers.delete(container);
  visibleContainers.delete(container);
  queuedContainers.delete(container);
  for (let i = pendingEvaluationQueue.length - 1; i >= 0; i -= 1) {
    if (pendingEvaluationQueue[i] === container) pendingEvaluationQueue.splice(i, 1);
  }
  container.removeAttribute(PROCESSED_ATTR);
  container.removeAttribute(VISIBLE_ATTR);
  container.removeAttribute(USER_REVEALED_ATTR);
}

function cleanupRemovedSubtree(root) {
  if (!(root instanceof Element)) return;
  const sel = getCandidateSelector();
  const toClean = [];
  if (typeof root.matches === "function" && root.matches(sel)) toClean.push(root);
  root.querySelectorAll(sel).forEach((el) => toClean.push(el));
  toClean.forEach((el) => cleanupObservedContainer(el));
}
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

  const parent = document.head || document.documentElement;
  if (!parent) return;

  const style = document.createElement("style");
  style.id = "plot-armor-semantic-style";
  style.textContent = `
    .${BLUR_CLASS} {
      position: relative !important;
      min-height: 2em;
      pointer-events: none;
    }

    /* X/Twitter: full-bleed veil + backdrop-filter obscures media reliably. */
    .plot-armor-x-veil {
      position: absolute;
      inset: 0;
      z-index: 2147483645;
      pointer-events: none;
      border-radius: inherit;
      background: rgba(16, 12, 10, 0.58);
      backdrop-filter: blur(14px) saturate(0.75) sepia(0.12);
      -webkit-backdrop-filter: blur(14px) saturate(0.75) sepia(0.12);
    }

    .plot-armor-blur-wrapper {
      filter: blur(7px) saturate(0.82) sepia(0.08);
      opacity: 0.88;
      pointer-events: auto;
      user-select: none;
      cursor: pointer;
      transition: filter 0.2s ease, opacity 0.2s ease;
    }

    .plot-armor-intercept {
      position: absolute;
      inset: 0;
      z-index: 2147483646;
      cursor: pointer;
      background: transparent;
      pointer-events: auto;
    }

    .${OVERLAY_CLASS} {
      position: absolute;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 8px 14px 7px;
      width: max-content;
      max-width: 460px;
      overflow: hidden;
      color: #f3e7d6;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: -0.01em;
      line-height: 1.4;
      white-space: nowrap;
      text-transform: lowercase;
      background: rgba(16, 12, 10, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid #2c231d;
      border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
      z-index: 2147483647;
      cursor: pointer;
      user-select: none;
      transform: translate(-50%, -50%);
      transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .${OVERLAY_CLASS}::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(
        90deg,
        #ffc857 0%,
        #ff9e3d 25%,
        #ff7a4d 50%,
        #ff5e7e 75%,
        #d94f6c 100%
      );
      opacity: 0.85;
    }

    .${OVERLAY_CLASS}:hover {
      background: rgba(28, 23, 20, 0.96);
      border-color: rgba(255, 158, 61, 0.45);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 158, 61, 0.12);
    }

    .plot-armor-overlay-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: #ff9e3d;
      box-shadow: 0 0 8px rgba(255, 158, 61, 0.65);
      flex-shrink: 0;
    }

    .plot-armor-overlay-text {
      color: #f3e7d6;
    }

    .plot-armor-overlay-cta {
      color: #9a8775;
      transition: color 0.15s ease;
    }

    .${OVERLAY_CLASS}:hover .plot-armor-overlay-cta {
      color: #ff9e3d;
    }

    .plot-armor-report-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      padding: 3px 10px;
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 11px;
      font-weight: 500;
      letter-spacing: -0.01em;
      text-transform: lowercase;
      color: #9a8775;
      background: rgba(16, 12, 10, 0.9);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid #2c231d;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      z-index: 2147483647;
      pointer-events: auto;
      user-select: none;
      vertical-align: middle;
      line-height: 1.6;
      transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease, padding 0.15s ease, max-width 0.2s ease;
    }

    .plot-armor-report-btn svg {
      width: 12px;
      height: 12px;
      display: block;
      flex-shrink: 0;
      color: #ff9e3d;
    }

    .plot-armor-report-btn:hover {
      color: #f3e7d6;
      background: rgba(28, 23, 20, 0.95);
      border-color: rgba(255, 94, 126, 0.45);
    }

    .plot-armor-report-btn.reported {
      color: #ff9e3d;
      border-color: rgba(255, 158, 61, 0.4);
      background: rgba(28, 23, 20, 0.92);
      pointer-events: none;
    }

    .plot-armor-report-btn--host {
      position: absolute;
      top: 8px;
      right: 88px;
      margin-left: 0;
      padding: 4px;
      gap: 0;
      max-width: 24px;
      overflow: hidden;
      background: rgba(16, 12, 10, 0.72);
      border-color: #2c231d;
      border-radius: 8px;
    }

    .plot-armor-report-btn--host .plot-armor-report-btn-text {
      max-width: 0;
      opacity: 0;
      white-space: nowrap;
      overflow: hidden;
      transition: max-width 0.18s ease, opacity 0.12s ease, margin-left 0.18s ease;
      margin-left: 0;
    }

    .plot-armor-report-btn--host:hover,
    .plot-armor-report-btn--host:focus-visible {
      padding: 4px 10px 4px 6px;
      gap: 6px;
      max-width: 200px;
      border-color: rgba(255, 94, 126, 0.45);
    }

    .plot-armor-report-btn--host:hover .plot-armor-report-btn-text,
    .plot-armor-report-btn--host:focus-visible .plot-armor-report-btn-text {
      max-width: 160px;
      opacity: 1;
      margin-left: 4px;
    }
  `;
  parent.appendChild(style);
}

function ensureContainerPosition(container) {
  const computed = getComputedStyle(container);
  if (computed.position === "static") {
    container.style.position = "relative";
  }
}

function isXHost() {
  const host = location.hostname.toLowerCase();
  return host.includes("twitter.com") || host.includes("x.com");
}

function isRedditHost() {
  return location.hostname.toLowerCase().includes("reddit.com");
}

function isRedditCommentContainer(container) {
  if (!(container instanceof Element)) return false;
  return (
    container.matches(REDDIT_COMMENT_SELECTOR) ||
    String(container.getAttribute("thingid") || "").startsWith("t1_") ||
    String(container.id || "").startsWith("comment-thing-")
  );
}

/** Comment copy lives in slot="comment" (shreddit); blur/reveal should target that, not the whole card. */
function findRedditCommentBody(container) {
  if (!(container instanceof Element) || !isRedditHost() || !isRedditCommentContainer(container)) {
    return null;
  }

  const slotted = container.querySelector(':scope > [slot="comment"]');
  if (slotted instanceof Element) {
    const rtjson = slotted.querySelector('[id$="-comment-rtjson-content"], [id$="-post-rtjson-content"]');
    if (rtjson instanceof Element) {
      const text = (rtjson.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length >= 5) return rtjson;
    }
    const text = (slotted.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length >= 5) return slotted;
  }

  const directRtjson = container.querySelector(
    ':scope [id$="-comment-rtjson-content"], :scope [id$="-post-rtjson-content"]'
  );
  if (directRtjson instanceof Element) {
    const text = (directRtjson.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length >= 5) return directRtjson;
  }

  return null;
}

function getPlotArmorBlurSurface(container) {
  if (!(container instanceof Element)) return container;
  return findRedditCommentBody(container) || container;
}

function resolvePlotArmorContainer(el) {
  if (!(el instanceof Element)) return el;
  if (isRedditCommentContainer(el)) return el;
  const commentRoot = el.closest(REDDIT_COMMENT_SELECTOR);
  if (commentRoot instanceof Element && findRedditCommentBody(commentRoot) === el) {
    return commentRoot;
  }
  return el;
}

function appendInlineReportButton(target, reportBtn) {
  if (!(target instanceof Element)) {
    target.appendChild(reportBtn);
    return;
  }
  const lastParagraph = target.querySelector(":scope p:last-of-type");
  if (lastParagraph) {
    if (!/\s$/.test(lastParagraph.textContent || "")) {
      lastParagraph.appendChild(document.createTextNode(" "));
    }
    lastParagraph.appendChild(reportBtn);
    return;
  }
  target.appendChild(reportBtn);
}

/** Place host report chip just left of X's Grok control (avoids overlap with Grok + overflow). */
function schedulePositionXReportButton(container, reportBtn) {
  const gapPx = 10;
  const fallbackRightPx = 88;
  const run = () => {
    if (!reportBtn.isConnected || !container.isConnected) return;
    const grok = container.querySelector('button[aria-label="Grok actions"]');
    const cRect = container.getBoundingClientRect();
    if (!grok || !Number.isFinite(cRect.right)) {
      reportBtn.style.right = `${fallbackRightPx}px`;
      return;
    }
    const gRect = grok.getBoundingClientRect();
    if (!Number.isFinite(gRect.left) || gRect.width < 2) {
      reportBtn.style.right = `${fallbackRightPx}px`;
      return;
    }
    const inset = Math.round(cRect.right - gRect.left + gapPx);
    const minInset = 8;
    const maxInset = Math.max(minInset, Math.round(cRect.width) - 12);
    reportBtn.style.right = `${Math.min(maxInset, Math.max(minInset, inset))}px`;
  };
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
  });
}

function markPlotArmorUserRevealed(container) {
  if (!(container instanceof Element)) return;
  container.setAttribute(USER_REVEALED_ATTR, "1");
}

function wasPlotArmorUserRevealed(container) {
  if (!(container instanceof Element)) return false;
  return container.getAttribute(USER_REVEALED_ATTR) === "1";
}

function attachAtomicReveal(node, container) {
  // Capture-phase + stopImmediatePropagation so first click reaches us before
  // the host site's own click interceptors (Reddit shreddit, X article navigation)
  // can swallow or re-render the event mid-flight (TC#15).
  const handler = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    // Before DOM peel / async SEMANTIC_CHECK resolves: blocks in-flight blur (Reddit snap-back).
    markPlotArmorUserRevealed(container);
    revealContainer(container);
  };
  node.addEventListener("click", handler, { capture: true });
}

function buildShieldIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z");
  svg.appendChild(path);
  return svg;
}

function domDepth(node) {
  let d = 0;
  let n = node;
  while (n) {
    d += 1;
    n = n.parentElement;
  }
  return d;
}

/**
 * Remove Plot Armor blur UI from `container`.
 * @param {{ skipReport?: boolean }} options — inner peels pass skipReport so only
 *   the outermost reveal adds "not a spoiler?" (avoids duplicate buttons / clicks).
 */
function revealContainer(container, options = {}) {
  const skipReport = options.skipReport === true;
  const logicalContainer = resolvePlotArmorContainer(container);
  const blurSurface = getPlotArmorBlurSurface(logicalContainer);

  // Generic hosts can stack two+ blurred nodes inside one card.
  // For Reddit comments, keep reveal local to the clicked comment.
  if (logicalContainer instanceof Element && !isRedditCommentContainer(logicalContainer)) {
    let nested = Array.from(logicalContainer.querySelectorAll(`:scope .${BLUR_CLASS}`)).filter(
      (el) => el !== logicalContainer
    );
    while (nested.length) {
      nested.sort((a, b) => domDepth(b) - domDepth(a));
      const deepest = nested[0];
      revealContainer(deepest, { skipReport: true });
      nested = Array.from(logicalContainer.querySelectorAll(`:scope .${BLUR_CLASS}`)).filter(
        (el) => el !== logicalContainer
      );
    }
  }

  // Read meta before clearing attributes.
  const show = logicalContainer.dataset.paShow || "";
  const reason = logicalContainer.dataset.paReason || "";
  const confidence = logicalContainer.dataset.paConfidence || null;
  const source = logicalContainer.dataset.paSource || "";

  blurSurface.classList.remove(BLUR_CLASS);
  blurSurface.removeAttribute("data-plot-armor-blurred");
  logicalContainer.classList.remove(BLUR_CLASS);
  logicalContainer.removeAttribute("data-plot-armor-blurred");
  delete logicalContainer.dataset.paShow;
  delete logicalContainer.dataset.paReason;
  delete logicalContainer.dataset.paConfidence;
  delete logicalContainer.dataset.paSource;
  blurSurface.style.position = "";
  logicalContainer.style.position = "";

  const overlay = blurSurface.querySelector(`:scope > .${OVERLAY_CLASS}`);
  if (overlay) overlay.remove();
  const veil = blurSurface.querySelector(":scope > .plot-armor-x-veil");
  if (veil) veil.remove();
  const intercept = blurSurface.querySelector(":scope > .plot-armor-intercept");
  if (intercept) intercept.remove();
  logicalContainer.querySelectorAll(".plot-armor-report-btn").forEach((btn) => btn.remove());

  // Unwrap blurred content wrapper back into the blur surface.
  // No-op when the host-blur path was used (e.g. X) since there is no wrapper.
  const wrapper = blurSurface.querySelector(":scope > .plot-armor-blur-wrapper");
  if (wrapper) {
    while (wrapper.firstChild) blurSurface.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }

  if (skipReport) {
    return;
  }

  // Show the report button AFTER reveal so the user can read the content first.
  const onX = isXHost();
  const onRedditComment = isRedditHost() && isRedditCommentContainer(logicalContainer);
  const reportBtn = document.createElement("button");
  reportBtn.className = onX ? "plot-armor-report-btn plot-armor-report-btn--host" : "plot-armor-report-btn";
  reportBtn.title = "Report this as a false positive";
  reportBtn.setAttribute("aria-label", "Report not a spoiler");
  reportBtn.style.setProperty("pointer-events", "auto", "important");

  reportBtn.appendChild(buildShieldIcon());
  const reportText = document.createElement("span");
  reportText.className = "plot-armor-report-btn-text";
  reportText.textContent = "not a spoiler?";
  reportBtn.appendChild(reportText);

  let autoRemoveTimer = setTimeout(() => reportBtn.remove(), 10000);

  reportBtn.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      clearTimeout(autoRemoveTimer);
      reportText.textContent = "logged";
      reportBtn.classList.add("reported");
      void sendExtensionMessage({
        type: "REPORT_FALSE_POSITIVE",
        text: extractContainerText(logicalContainer).slice(0, 500),
        show,
        reason,
        confidence: confidence !== "" ? Number(confidence) : null,
        source,
        url: location.href,
      }).catch(() => {});
      setTimeout(() => reportBtn.remove(), 1200);
    },
    { capture: true }
  );

  if (onX) {
    // Anchor in the top-right corner of the article. Container already has
    // `position: relative` set by ensureContainerPosition while blurred, but
    // revealContainer cleared inline `position`, so reapply briefly.
    if (getComputedStyle(logicalContainer).position === "static") {
      logicalContainer.style.position = "relative";
    }
    logicalContainer.appendChild(reportBtn);
    schedulePositionXReportButton(logicalContainer, reportBtn);
  } else if (onRedditComment) {
    appendInlineReportButton(findRedditCommentBody(logicalContainer) || blurSurface, reportBtn);
  } else {
    // Inject inline at the end of the last text-bearing child so the button
    // flows naturally after the last word without overlapping anything.
    const lastTextChild = Array.from(logicalContainer.childNodes)
      .reverse()
      .find((n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim()));
    if (lastTextChild && lastTextChild.nodeType === Node.ELEMENT_NODE) {
      lastTextChild.appendChild(reportBtn);
    } else {
      logicalContainer.appendChild(reportBtn);
    }
  }
}

function blurContainer(container, meta = {}) {
  const blurSurface = getPlotArmorBlurSurface(container);
  if (blurSurface.classList.contains(BLUR_CLASS) || container.classList.contains(BLUR_CLASS)) return;
  if (wasPlotArmorUserRevealed(container)) {
    debugLog("skip blur: user already revealed this block", {});
    return;
  }
  ensureContainerPosition(blurSurface);

  const useDirectBlur = isXHost();
  const redditCommentBodyOnly = blurSurface !== container;
  let blurWrapper = null;

  if (useDirectBlur) {
    // X tweets are flex containers; wrapping their children collapses the
    // flex line. A full-area veil (backdrop + tint) hides media reliably;
    // filter on <article> often misses <video> / compositor quirks.
    const veil = document.createElement("div");
    veil.className = "plot-armor-x-veil";
    container.appendChild(veil);

    const intercept = document.createElement("div");
    intercept.className = "plot-armor-intercept";
    attachAtomicReveal(intercept, container);
    container.appendChild(intercept);
  } else if (redditCommentBodyOnly) {
    // Reddit shreddit-comment: blur only slot="comment" copy, not meta/actions/replies.
    blurWrapper = document.createElement("div");
    blurWrapper.className = "plot-armor-blur-wrapper";
    Array.from(blurSurface.childNodes).forEach((node) => blurWrapper.appendChild(node));
    attachAtomicReveal(blurWrapper, container);
    blurSurface.appendChild(blurWrapper);
  } else {
    // Wrap ALL child nodes (including bare text nodes) in a single div so
    // the blur filter covers everything, not just element children.
    // On Reddit posts, nested comment containers must stay outside the wrapper so
    // each reply is evaluated and revealed independently.
    blurWrapper = document.createElement("div");
    blurWrapper.className = "plot-armor-blur-wrapper";

    const isReddit = isRedditHost();
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

    attachAtomicReveal(blurWrapper, container);

    container.appendChild(blurWrapper);
    // Re-attach nested comments after the wrapper so they remain independent.
    skippedChildren.forEach((node) => container.appendChild(node));
  }

  blurSurface.classList.add(BLUR_CLASS);
  blurSurface.setAttribute("data-plot-armor-blurred", "1");

  const overlay = document.createElement("div");
  overlay.className = OVERLAY_CLASS;

  const dot = document.createElement("span");
  dot.className = "plot-armor-overlay-dot";

  const textEl = document.createElement("span");
  textEl.className = "plot-armor-overlay-text";
  textEl.textContent = "hidden by plot armor";

  const ctaEl = document.createElement("span");
  ctaEl.className = "plot-armor-overlay-cta";
  ctaEl.textContent = "click to reveal";

  overlay.append(dot, textEl, ctaEl);
  overlay.style.setProperty("z-index", "2147483647", "important");
  overlay.style.setProperty("pointer-events", "auto", "important");
  // Store meta on the element so revealContainer can attach the report button after reveal.
  container.dataset.paShow = meta.matchedShow || "";
  container.dataset.paReason = meta.reason || "";
  container.dataset.paConfidence = meta.confidence ?? "";
  container.dataset.paSource = meta.source || "";

  attachAtomicReveal(overlay, container);
  blurSurface.appendChild(overlay);

  // Center within the blur surface (comment body on Reddit, full card elsewhere).
  overlay.style.top = "50%";
  overlay.style.left = "50%";

  debugLog("Blur applied", {
    tag: container.tagName,
    className: container.className,
    textLength: extractContainerText(container).length,
  });
  void sendExtensionMessage({
    type: "BLUR_APPLIED",
    textLength: extractContainerText(container).length,
    tagName: container.tagName,
    className: container.className,
    href: location.href,
  }).catch(() => {});
}

/** X/Twitter: pull "From …" / repost context lines that often sit outside the main tweet copy (TC#2). */
function extractXAttributionText(article) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (t.length < 6 || t.length > 200 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  article.querySelectorAll('[data-testid="socialContext"]').forEach((n) => push(n.textContent));

  const video = article.querySelector('[data-testid="videoComponent"]');
  if (video) {
    video.querySelectorAll('span[dir="auto"], div[dir="auto"]').forEach((el) => {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/^from\s+/i.test(t)) push(t);
    });
    const parent = video.parentElement;
    if (parent && parent !== article) {
      parent.querySelectorAll('span[dir="auto"], div[dir="auto"]').forEach((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/^from\s+/i.test(t)) push(t);
      });
    }
  }

  return out.join(" ");
}

/** X/Twitter: quoted-tweet cards often render separately from the main tweet copy. */
function extractXQuotedTweetText(article) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const t = String(raw || "").replace(/\s+/g, " ").trim();
    if (t.length < 10 || t.length > 700 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  article.querySelectorAll('[data-testid="card.wrapper"] [data-testid="tweetText"]').forEach((n) => push(n.textContent));
  article.querySelectorAll('[data-testid="card.wrapper"] blockquote, [data-testid="card.wrapper"] [role="blockquote"]').forEach((n) =>
    push(n.textContent)
  );
  article.querySelectorAll('[data-testid="card.wrapper"] [lang], [data-testid="card.wrapper"] [dir="auto"]').forEach((n) =>
    push(n.textContent)
  );

  return out.join(" ");
}

function extractContainerText(container) {
  const host = location.hostname.toLowerCase();
  if (!host.includes("reddit.com")) {
    let text = (container.innerText || "").replace(/\s+/g, " ").trim();
    if (isXHost()) {
      const extra = extractXAttributionText(container);
      if (extra) text = `${text} ${extra}`.replace(/\s+/g, " ").trim();
      const quote = extractXQuotedTweetText(container);
      if (quote) text = `${text} ${quote}`.replace(/\s+/g, " ").trim();
    }
    return text;
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
    // X hydrates tweet copy after mount; a first paint under MIN_TEXT_LENGTH used to mark
    // processed and skip blur forever. Retry a few times before giving up (TC#X-hydrate).
    if (isXHost()) {
      const attempts = Number(container.dataset.paTextHydrationAttempts || "0");
      const tooShort = !textToAnalyze || textToAnalyze.length < minLengthForContainer;
      const allowRetry =
        !textToAnalyze ||
        (textToAnalyze.length >= 5 && textToAnalyze.length < MIN_TEXT_LENGTH);
      if (attempts < 3 && tooShort && allowRetry) {
        container.dataset.paTextHydrationAttempts = String(attempts + 1);
        const delay = textToAnalyze ? 320 + attempts * 500 : 180 + attempts * 280;
        setTimeout(() => {
          if (observersStopped || !container.isConnected) return;
          if (container.getAttribute(PROCESSED_ATTR) === "1") return;
          void evaluateContainer(container);
        }, delay);
        return;
      }
    }
    container.setAttribute(PROCESSED_ATTR, "1");
    return;
  }
  delete container.dataset.paTextHydrationAttempts;

  const analysisText = textToAnalyze.slice(0, MAX_ANALYZE_CHARS);
  const sectionHint = isXHost() ? "" : getSectionHint(container);
  const precedingContext = getPrecedingContext(container);
  debugLog("Evaluating container", { textLength: textToAnalyze.length, tag: container.tagName, hasPrecedingContext: Boolean(precedingContext) });

  try {
    const response = await sendExtensionMessage({
      type: "SEMANTIC_CHECK",
      textToAnalyze: analysisText,
      precedingContext,
      sectionHint,
      containerTag: container.tagName,
    });
    if (response == null) {
      debugLog("SEMANTIC_CHECK skipped: extension runtime unavailable", {});
    } else {
      debugLog("Semantic check response", response?.data || response);
    }

    if (response?.ok && response.data?.isSpoiler) {
      if (wasPlotArmorUserRevealed(container)) {
        debugLog("skip blur after reveal: in-flight check resolved late", {});
      } else {
        blurContainer(container, {
          matchedShow: response.data?.matchedShow || "",
          reason: response.data?.reason || "",
          confidence: response.data?.confidence ?? null,
          source: response.data?.source || "",
        });
        debugLog("Container blurred", { reason: response.data?.reason });
      }
    }
  } catch (error) {
    if (isContextInvalidated(error)) {
      shutdownObservers();
    } else if (MESSAGE_CHANNEL_CLOSED_RE.test(String(error?.message || error))) {
      debugLog("SEMANTIC_CHECK failed: background did not respond in time (service worker may have slept)", {});
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
  { root: null, rootMargin: `${PREFETCH_MARGIN_PX}px 0px`, threshold: 0.01 }
);

function observeContainer(container) {
  if (!(container instanceof Element)) return;
  if (shouldSkipContainer(container)) return;
  if (observedContainers.has(container)) return;
  observedContainers.add(container);
  intersectionObserver.observe(container);
  // Eagerly queue near-viewport nodes so blur decisions can land before users
  // visually scan the line/card.
  const rect = container.getBoundingClientRect();
  const viewHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  if (viewHeight > 0) {
    const nearViewport = rect.bottom >= -PREFETCH_MARGIN_PX && rect.top <= viewHeight + PREFETCH_MARGIN_PX;
    if (nearViewport) enqueueEvaluation(container, true);
  }
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
    // Avoid double-blur / double-reveal: shreddit wraps a card in <shreddit-post>
    // (or legacy article[data-testid=post-container]) and also exposes inner
    // <article> / div[data-click-id=body] that match the same candidate list.
    // We only want the outer post root observed; inner shells share the same text.
    const shredditPost = container.closest("shreddit-post");
    if (shredditPost && container !== shredditPost && !isRedditCommentContainer(container)) {
      if (
        container.matches("article") ||
        container.matches('article[data-testid="post-container"]') ||
        container.matches('div[data-click-id="body"]')
      ) {
        return true;
      }
    }
    const legacyPost = container.closest('article[data-testid="post-container"]');
    if (legacyPost && container !== legacyPost && !isRedditCommentContainer(container)) {
      if (container.matches("article") || container.matches('div[data-click-id="body"]')) {
        return true;
      }
    }

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
    mutation.removedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        cleanupRemovedSubtree(node);
      }
    });
    mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        discoverContainers(node);
      }
    });
  });
});

function resetAndReevaluate() {
  document.querySelectorAll(`[${USER_REVEALED_ATTR}]`).forEach((el) => {
    el.removeAttribute(USER_REVEALED_ATTR);
  });
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
    el.removeAttribute(PROCESSED_ATTR);
  });
  document.querySelectorAll(`.${BLUR_CLASS}`).forEach((el) => {
    revealContainer(resolvePlotArmorContainer(el), { skipReport: true });
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

// SPA URL change rescan (TC#3). X / Reddit navigate without a full reload
// (clicking a tweet, hitting back, switching Search tabs). Patch history methods
// + listen popstate, then rediscover containers and process visible ones.
function setupSpaNavigationListener() {
  let lastHref = location.href;
  const onUrlChange = () => {
    if (observersStopped) return;
    if (location.href === lastHref) return;
    lastHref = location.href;
    debugLog("SPA navigation detected, rediscovering", { href: lastHref });
    // New view -> let the host paint its tree, then rediscover.
    setTimeout(() => {
      if (observersStopped) return;
      discoverContainers(document);
      debounceProcessVisible();
    }, 50);
  };

  const wrap = (method) => {
    const orig = history[method];
    if (typeof orig !== "function" || orig.__plotArmorWrapped) return;
    const wrapped = function (...args) {
      const result = orig.apply(this, args);
      try { onUrlChange(); } catch (_) {}
      return result;
    };
    wrapped.__plotArmorWrapped = true;
    history[method] = wrapped;
  };
  wrap("pushState");
  wrap("replaceState");
  window.addEventListener("popstate", onUrlChange);
  window.addEventListener("hashchange", onUrlChange);
}

// X often virtualizes the search column; scroll can mount new `article` nodes without
// a mutation that bubbles the way we expect. Debounced rescan keeps the queue warm (TC#4).
function setupXScrollRediscover() {
  if (!isXHost()) return;
  let scrollTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (observersStopped) return;
        discoverContainers(document);
        debounceProcessVisible();
      }, 350);
    },
    { passive: true, capture: true }
  );
}

let plotArmorBooted = false;

function bootPlotArmor() {
  if (plotArmorBooted) return;
  if (typeof document === "undefined" || !document.documentElement) return;
  const ct = document.contentType || "";
  if (/^image\//i.test(ct)) return;

  injectStyles();

  const run = () => {
    if (plotArmorBooted) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    plotArmorBooted = true;
    discoverContainers(document);
    mutationObserver.observe(root, { childList: true, subtree: true });
    setupSpaNavigationListener();
    setupXScrollRediscover();
    debugLog("Semantic scanner initialized");
  };

  if (document.body) run();
  else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}

bootPlotArmor();
