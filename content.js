const BLUR_CLASS = "plot-armor-blurred";
const OVERLAY_CLASS = "plot-armor-overlay";
const PROCESSED_ATTR = "data-plot-armor-processed";
const VISIBLE_ATTR = "data-plot-armor-visible";
const USER_REVEALED_ATTR = "data-plot-armor-user-revealed";
const DEBUG = false;
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

/** App / tool surfaces — not “scroll other people’s posts”. */
const PLOT_ARMOR_EXCLUDED_HOST_SUFFIXES = [
  "chatgpt.com",
  "chat.openai.com",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "perplexity.ai",
  "notion.so",
  "slack.com",
  "discord.com",
  "figma.com",
  "linear.app",
  "trello.com",
  "atlassian.net",
];

const PLOT_ARMOR_EXCLUDED_HOST_PREFIXES = [
  "mail.",
  "docs.",
  "drive.",
  "calendar.",
  "meet.",
  "admin.",
  "app.",
];

const PLOT_ARMOR_EXCLUDED_PATH_RE =
  /^\/(chat|c|compose|inbox|mail|login|signin|signup|account|settings|admin|dashboard)(\/|$)/i;

function hostMatchesSuffix(hostname, suffix) {
  const host = String(hostname || "").toLowerCase();
  const base = String(suffix || "").toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

function isPlotArmorExcludedHost() {
  const host = location.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (PLOT_ARMOR_EXCLUDED_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))) return true;
  return PLOT_ARMOR_EXCLUDED_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix));
}

function isPlotArmorExcludedPath() {
  return PLOT_ARMOR_EXCLUDED_PATH_RE.test(location.pathname || "");
}

/** First-class feed targets (custom selectors). */
function isPlotArmorSupportedHost() {
  const host = location.hostname.toLowerCase();
  return (
    host.includes("reddit.com") ||
    host.includes("twitter.com") ||
    host.includes("x.com") ||
    host.includes("wikipedia.org")
  );
}

/** Chat / compose UIs: big contenteditable or textarea in view — not spoiler feeds. */
function isPrimaryChatOrComposerUi() {
  if (!(document.body instanceof Element)) return false;
  const composerSel = [
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-placeholder]',
    '[contenteditable="plaintext-only"]',
    "textarea[placeholder]",
    '[aria-label*="message" i][contenteditable="true"]',
    "form textarea",
  ].join(", ");
  const viewHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  for (const el of document.querySelectorAll(composerSel)) {
    if (!(el instanceof Element)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 24) continue;
    if (rect.bottom > 0 && rect.top < viewHeight) return true;
  }
  return false;
}

/** Article / post-shaped read-only pages (news, blogs) — safe generic target. */
function isLikelyReadOnlyContentPage() {
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute("content") || "";
  if (/^article$/i.test(ogType)) return true;

  for (const el of document.querySelectorAll("article, [role='article']")) {
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (text.length >= MIN_TEXT_LENGTH) return true;
  }
  return false;
}

/**
 * Run only where users read third-party posts/articles — not in app/chat UIs.
 * Known feeds always on; other sites only if article-shaped and no composer detected.
 */
function shouldActivatePlotArmor() {
  if (isPlotArmorExcludedHost()) return false;
  if (isPlotArmorExcludedPath()) return false;
  if (isPlotArmorSupportedHost()) return true;
  if (isPrimaryChatOrComposerUi()) return false;
  return isLikelyReadOnlyContentPage();
}

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
/** Survives Reddit re-hydrating shreddit nodes after a reveal click (thing id / permalink). */
const redditUserRevealedKeys = new Set();
const plotArmorRevealNodes = new WeakMap();
const evaluationGeneration = new WeakMap();
const pendingRedditReportSessions = new WeakMap();
let redditEarlyRevealInstalled = false;

/** X virtualizes timeline cells; we must unobserve removed nodes or IO holds strong refs and scroll/load stalls. */
function cleanupObservedContainer(container) {
  if (!(container instanceof Element)) return;
  if (!observedContainers.has(container)) return;
  const revealed = wasPlotArmorUserRevealed(container);
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
  container.removeAttribute(VISIBLE_ATTR);
  if (revealed) {
    container.setAttribute(PROCESSED_ATTR, "1");
    container.setAttribute(USER_REVEALED_ATTR, "1");
  } else {
    container.removeAttribute(PROCESSED_ATTR);
    container.removeAttribute(USER_REVEALED_ATTR);
  }
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
  // Generic news/blog: article cards only — never `main p` (breaks app UIs).
  return "article, [role='article']";
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
      transform-origin: center center;
      animation: plot-armor-report-enter 0.32s cubic-bezier(0.34, 1.4, 0.64, 1) both;
      transition:
        color 0.22s ease,
        background 0.22s ease,
        border-color 0.22s ease,
        box-shadow 0.22s ease,
        transform 0.26s cubic-bezier(0.34, 1.4, 0.64, 1),
        opacity 0.28s ease,
        padding 0.24s ease,
        max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1),
        gap 0.24s ease;
    }

    @keyframes plot-armor-report-enter {
      from {
        opacity: 0;
        transform: translateY(5px) scale(0.92);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @keyframes plot-armor-report-host-enter {
      from {
        opacity: 0;
        transform: scale(0.88);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .plot-armor-report-btn svg {
      width: 12px;
      height: 12px;
      display: block;
      flex-shrink: 0;
      color: #ff9e3d;
      transition: transform 0.26s cubic-bezier(0.34, 1.4, 0.64, 1), color 0.22s ease;
    }

    .plot-armor-report-btn-text {
      display: inline-block;
      transition: opacity 0.2s ease, transform 0.22s ease, max-width 0.28s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .plot-armor-report-btn:hover {
      color: #f3e7d6;
      background: rgba(28, 23, 20, 0.95);
      border-color: rgba(255, 94, 126, 0.45);
    }

    .plot-armor-report-btn.reporting {
      transform: scale(0.97);
      border-color: rgba(255, 158, 61, 0.35);
      pointer-events: none;
    }

    .plot-armor-report-btn.reporting .plot-armor-report-btn-text {
      opacity: 0.55;
    }

    .plot-armor-report-btn.reporting svg {
      transform: scale(0.92);
      opacity: 0.7;
    }

    .plot-armor-report-btn.reported {
      color: #ff9e3d;
      border-color: rgba(255, 158, 61, 0.5);
      background: rgba(28, 23, 20, 0.96);
      box-shadow: 0 0 0 1px rgba(255, 158, 61, 0.12), 0 4px 14px rgba(0, 0, 0, 0.38);
      transform: scale(1);
      pointer-events: none;
    }

    .plot-armor-report-btn.reported svg {
      transform: scale(1.08);
      color: #ffb35c;
    }

    .plot-armor-report-btn.reported .plot-armor-report-btn-text {
      opacity: 1;
      transform: translateY(0);
    }

    .plot-armor-report-btn.reported-error {
      color: #ff5e7e;
      border-color: rgba(255, 94, 126, 0.5);
      box-shadow: 0 0 0 1px rgba(255, 94, 126, 0.1), 0 4px 14px rgba(0, 0, 0, 0.38);
    }

    .plot-armor-report-btn.reported-error svg {
      color: #ff5e7e;
      transform: scale(1);
    }

    .plot-armor-report-btn.report-fade-out {
      opacity: 0;
      transform: scale(0.94) translateY(3px);
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
      animation: plot-armor-report-host-enter 0.28s cubic-bezier(0.34, 1.4, 0.64, 1) both;
    }

    .plot-armor-report-btn--host .plot-armor-report-btn-text {
      max-width: 0;
      opacity: 0;
      white-space: nowrap;
      overflow: hidden;
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

    .plot-armor-report-btn--host.reporting,
    .plot-armor-report-btn--host.reported,
    .plot-armor-report-btn--host.reported-error {
      padding: 4px 10px 4px 6px;
      gap: 6px;
      max-width: 200px;
    }

    .plot-armor-report-btn--host.reporting .plot-armor-report-btn-text,
    .plot-armor-report-btn--host.reported .plot-armor-report-btn-text,
    .plot-armor-report-btn--host.reported-error .plot-armor-report-btn-text {
      max-width: 160px;
      opacity: 1;
      margin-left: 4px;
    }

    .plot-armor-report-btn--reddit {
      margin: 0 0 0 4px;
      padding: 0 10px;
      height: 32px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 999px;
      vertical-align: middle;
      align-self: center;
      flex-shrink: 0;
      box-shadow: none;
      background: var(--color-button-secondary-bg, transparent);
      border: var(--border-width-sm, 1px) solid var(--color-neutral-border-weak, rgba(255, 255, 255, 0.14));
      color: var(--color-neutral-content-weak, #8b949e);
      transform: translateX(-2px);
    }

    .plot-armor-report-btn--reddit:hover,
    .plot-armor-report-btn--reddit:focus-visible {
      color: var(--color-neutral-content-strong, #e6edf3);
      background: var(--color-button-secondary-hover, rgba(255, 255, 255, 0.06));
      border-color: var(--color-neutral-border-strong, rgba(255, 255, 255, 0.22));
    }

    .plot-armor-report-btn--reddit.reported,
    .plot-armor-report-btn--reddit.reported-error {
      background: rgba(28, 23, 20, 0.92);
      border-color: rgba(255, 158, 61, 0.45);
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
  if (isRedditHost()) {
    const post = el.closest("shreddit-post");
    if (post instanceof Element) return post;
    if (el.matches("article")) {
      const nestedPost = el.querySelector(":scope > shreddit-post, shreddit-post");
      if (nestedPost instanceof Element) return nestedPost;
    }
  }
  return el;
}

function findRedditFeedWrapper(post) {
  if (!(post instanceof Element) || !post.matches("shreddit-post")) return null;
  const parentArticle = post.parentElement?.closest?.("article[data-post-id], article");
  if (!(parentArticle instanceof Element)) return null;
  if (parentArticle.querySelector("shreddit-post") !== post) return null;
  return parentArticle;
}

function stripPlotArmorBlurShell(container) {
  if (!(container instanceof Element)) return;
  const blurSurface = getPlotArmorBlurSurface(container);
  blurSurface.classList.remove(BLUR_CLASS);
  blurSurface.removeAttribute("data-plot-armor-blurred");
  container.classList.remove(BLUR_CLASS);
  container.removeAttribute("data-plot-armor-blurred");

  const overlay = blurSurface.querySelector(`:scope > .${OVERLAY_CLASS}`);
  if (overlay) overlay.remove();
  blurSurface.querySelector(":scope > .plot-armor-x-veil")?.remove();
  blurSurface.querySelector(":scope > .plot-armor-intercept")?.remove();

  const wrapper = blurSurface.querySelector(":scope > .plot-armor-blur-wrapper");
  if (wrapper) {
    while (wrapper.firstChild) blurSurface.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }
}

function syncRedditFeedWrapperState(post) {
  if (!(post instanceof Element) || !post.matches("shreddit-post")) return;
  const wrapper = findRedditFeedWrapper(post);
  if (!(wrapper instanceof Element)) return;
  wrapper.setAttribute(USER_REVEALED_ATTR, "1");
  wrapper.setAttribute(PROCESSED_ATTR, "1");
  cancelPendingEvaluation(wrapper);
  rememberRedditUserReveal(wrapper);
  stripPlotArmorBlurShell(wrapper);
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

const PLOT_ARMOR_SHADOW_STYLE_ID = "plot-armor-shadow-style";

const PLOT_ARMOR_REPORT_SHADOW_CSS = `
  .plot-armor-report-btn {
    display: inline-flex !important;
    align-items: center !important;
    gap: 6px;
    margin: 0 0 0 4px !important;
    padding: 0 10px !important;
    height: var(--size-button-sm-h, 32px) !important;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 12px !important;
    font-weight: 600 !important;
    letter-spacing: -0.01em;
    text-transform: lowercase;
    color: var(--color-neutral-content-weak, #8b949e) !important;
    background: var(--color-button-secondary-bg, transparent) !important;
    border: var(--border-width-sm, 1px) solid var(--color-neutral-border-weak, rgba(255, 255, 255, 0.14)) !important;
    border-radius: 999px !important;
    box-shadow: none !important;
    cursor: pointer !important;
    pointer-events: auto !important;
    user-select: none;
    vertical-align: middle;
    line-height: 1.2 !important;
    flex-shrink: 0 !important;
    position: relative !important;
    z-index: 2 !important;
    visibility: visible !important;
    opacity: 1 !important;
    transform: translateX(-2px);
    animation: plot-armor-report-enter 0.32s cubic-bezier(0.34, 1.4, 0.64, 1) both;
  }
  .plot-armor-report-btn svg {
    width: 12px;
    height: 12px;
    display: block;
    flex-shrink: 0;
    color: #ff9e3d;
  }
  .plot-armor-report-btn:hover,
  .plot-armor-report-btn:focus-visible {
    color: var(--color-neutral-content-strong, #e6edf3) !important;
    background: var(--color-button-secondary-hover, rgba(255, 255, 255, 0.06)) !important;
    border-color: var(--color-neutral-border-strong, rgba(255, 255, 255, 0.22)) !important;
  }
  @keyframes plot-armor-report-enter {
    from { opacity: 0; transform: translateX(-2px) translateY(4px) scale(0.94); }
    to { opacity: 1; transform: translateX(-2px) translateY(0) scale(1); }
  }
`;

function ensurePlotArmorStylesInRoot(root) {
  if (!(root instanceof ShadowRoot) || root.getElementById(PLOT_ARMOR_SHADOW_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PLOT_ARMOR_SHADOW_STYLE_ID;
  style.textContent = PLOT_ARMOR_REPORT_SHADOW_CSS;
  root.appendChild(style);
}

function getRedditPlacementRoots(container) {
  const roots = [];
  const seen = new Set();
  const add = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    roots.push(node);
  };

  const post = container.matches?.("shreddit-post") ? container : container.closest("shreddit-post");
  const comment = isRedditCommentContainer(container) ? container : null;

  add(container);
  if (post) {
    add(post);
    if (post.shadowRoot) add(post.shadowRoot);
  }
  if (comment) add(comment);

  return roots;
}

function queryRedditDeep(container, selector) {
  for (const root of getRedditPlacementRoots(container)) {
    if (typeof root.querySelector !== "function") continue;
    const direct = root.querySelector(selector);
    if (direct instanceof Element) return direct;
    for (const host of root.querySelectorAll("*")) {
      if (!host.shadowRoot) continue;
      const nested = host.shadowRoot.querySelector(selector);
      if (nested instanceof Element) return nested;
    }
  }
  return null;
}

function findRedditActionBar(container) {
  if (!(container instanceof Element) || !isRedditHost()) return null;

  const bar = queryRedditDeep(container, "rpl-action-bar");
  if (bar instanceof Element) return bar;

  const commentSlot =
    container.querySelector(':scope div[slot="actionRow"]') ||
    container.closest("shreddit-comment")?.querySelector('div[slot="actionRow"]');
  if (commentSlot instanceof Element) return commentSlot;

  return null;
}

function findRedditShareHost(actionBar) {
  if (!(actionBar instanceof Element)) return null;

  let share = actionBar.querySelector("shreddit-post-share-button");
  if (share instanceof Element) return share;

  for (const row of actionBar.querySelectorAll("shreddit-comment-action-row")) {
    share = row.querySelector("shreddit-post-share-button");
    if (share instanceof Element) return share;
    if (row.shadowRoot) {
      share = row.shadowRoot.querySelector("shreddit-post-share-button");
      if (share instanceof Element) return share;
    }
  }

  return null;
}

function stylizeRedditReportButton(reportBtn) {
  reportBtn.classList.add("plot-armor-report-btn--reddit");
  reportBtn.style.setProperty("display", "inline-flex", "important");
  reportBtn.style.setProperty("align-items", "center", "important");
  reportBtn.style.setProperty("flex-shrink", "0", "important");
  reportBtn.style.setProperty("visibility", "visible", "important");
  reportBtn.style.setProperty("opacity", "1", "important");
}

function placeRedditReportButton(container, reportBtn) {
  if (reportBtn.isConnected) return true;

  const actionBar = findRedditActionBar(container);
  if (!(actionBar instanceof Element)) return false;

  actionBar.querySelectorAll(".plot-armor-report-btn").forEach((btn) => btn.remove());

  const root = actionBar.getRootNode();
  if (root instanceof ShadowRoot) ensurePlotArmorStylesInRoot(root);

  stylizeRedditReportButton(reportBtn);

  const shareHost = findRedditShareHost(actionBar);
  if (shareHost instanceof Element) {
    shareHost.insertAdjacentElement("afterend", reportBtn);
  } else {
    const msAuto = actionBar.querySelector(".ms-auto");
    if (msAuto instanceof Element) {
      msAuto.insertAdjacentElement("beforebegin", reportBtn);
    } else {
      actionBar.appendChild(reportBtn);
    }
  }

  return reportBtn.isConnected;
}

function scheduleRedditReportButtonPlacement(container, reportBtn, fallback) {
  const prior = pendingRedditReportSessions.get(container);
  if (prior) prior.cancel();

  let attempts = 0;
  let settled = false;
  let observer = null;
  let intervalId = null;
  let timeoutId = null;

  const session = {
    cancel() {
      if (settled) return;
      settled = true;
      if (observer) observer.disconnect();
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      if (pendingRedditReportSessions.get(container) === session) {
        pendingRedditReportSessions.delete(container);
      }
    },
  };
  pendingRedditReportSessions.set(container, session);

  const finish = (useFallback) => {
    if (settled) return;
    settled = true;
    if (observer) observer.disconnect();
    if (intervalId) clearInterval(intervalId);
    if (timeoutId) clearTimeout(timeoutId);
    pendingRedditReportSessions.delete(container);
    if (useFallback && !reportBtn.isConnected) fallback();
  };

  const tryPlace = () => {
    if (settled || !container.isConnected) return;
    if (placeRedditReportButton(container, reportBtn)) {
      finish(false);
      return;
    }
    attempts += 1;
    if (attempts >= 30) finish(true);
  };

  const watchTarget = container.closest("shreddit-post") || container;
  if (watchTarget instanceof Element) {
    observer = new MutationObserver(tryPlace);
    observer.observe(watchTarget, { childList: true, subtree: true });
    if (watchTarget.shadowRoot) {
      observer.observe(watchTarget.shadowRoot, { childList: true, subtree: true });
    }
  }

  intervalId = setInterval(tryPlace, 200);
  timeoutId = setTimeout(() => finish(true), 5000);

  requestAnimationFrame(tryPlace);
}

function appendRedditReportButtonFallback(container, reportBtn, onRedditComment, blurSurface) {
  if (onRedditComment) {
    appendInlineReportButton(findRedditCommentBody(container) || blurSurface, reportBtn);
    return;
  }
  const lastTextChild = Array.from(container.childNodes)
    .reverse()
    .find((n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim()));
  if (lastTextChild && lastTextChild.nodeType === Node.ELEMENT_NODE) {
    lastTextChild.appendChild(reportBtn);
  } else {
    container.appendChild(reportBtn);
  }
}

/** Place host report chip just left of X's Grok control (avoids overlap with Grok + overflow). */
function dismissReportButton(reportBtn, holdMs = 1000) {
  setTimeout(() => {
    if (!reportBtn.isConnected) return;
    reportBtn.classList.add("report-fade-out");
    setTimeout(() => reportBtn.remove(), 300);
  }, holdMs);
}

function finishReportButtonFeedback(reportBtn, reportText, label, isError = false) {
  reportBtn.classList.remove("reporting");
  reportBtn.classList.add("reported");
  if (isError) reportBtn.classList.add("reported-error");
  reportText.textContent = label;
  dismissReportButton(reportBtn, isError ? 1600 : 1100);
}

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

function parseRedditThingIdFromTracking(el) {
  if (!(el instanceof Element)) return null;
  const raw = el.getAttribute("data-faceplate-tracking-context");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const id = parsed?.post?.id || parsed?.comment?.id;
    if (typeof id === "string" && /^t[13]_/.test(id)) return id;
  } catch (_) {
    return null;
  }
  return null;
}

function getRedditRevealKey(container) {
  if (!isRedditHost() || !(container instanceof Element)) return null;
  const logical = resolvePlotArmorContainer(container);
  const post =
    logical.matches("shreddit-post") ? logical : logical.closest("shreddit-post");
  const wrapper = post instanceof Element ? findRedditFeedWrapper(post) : null;

  const postId =
    post?.getAttribute("post-id") ||
    post?.getAttribute("data-post-id") ||
    wrapper?.getAttribute("data-post-id") ||
    wrapper?.getAttribute("post-id") ||
    logical.getAttribute("post-id") ||
    logical.getAttribute("data-post-id") ||
    logical.getAttribute("itemid");
  if (postId && /^t[13]_/.test(postId)) return postId;

  const thingid = logical.getAttribute("thingid");
  if (thingid && /^t[13]_/.test(thingid)) return thingid;

  const ancestorThingid = logical.closest("[thingid]")?.getAttribute("thingid");
  if (ancestorThingid && /^t[13]_/.test(ancestorThingid)) return ancestorThingid;

  const id = logical.id || logical.getAttribute("id") || "";
  if (/^t[13]_/.test(id)) return id;

  const permalinkAttr = post?.getAttribute("permalink") || logical.getAttribute("permalink");
  if (permalinkAttr && permalinkAttr.includes("/comments/")) {
    const path = permalinkAttr.startsWith("http") ? new URL(permalinkAttr, location.origin).pathname : permalinkAttr;
    return path.split("?")[0];
  }

  const trackingRoot = post || logical;
  const trackingId =
    parseRedditThingIdFromTracking(trackingRoot) ||
    parseRedditThingIdFromTracking(trackingRoot.querySelector("shreddit-post-share-button"));
  if (trackingId) return trackingId;

  if (logical.matches("shreddit-post, shreddit-comment")) {
    const permalink = logical.querySelector('a[href*="/comments/"]')?.getAttribute("href");
    if (permalink) {
      const path = permalink.startsWith("http") ? new URL(permalink, location.origin).pathname : permalink;
      return path.split("?")[0];
    }
  }

  const text = extractContainerText(logical).slice(0, 140);
  if (text.length >= 48) return `text:${text}`;

  return null;
}

function rememberRedditUserReveal(container) {
  const key = getRedditRevealKey(container);
  if (key) redditUserRevealedKeys.add(key);
}

function invalidateContainerEvaluations(container) {
  if (!(container instanceof Element)) return;
  evaluationGeneration.set(container, (evaluationGeneration.get(container) || 0) + 1);
  const wrapper = container.matches("shreddit-post") ? findRedditFeedWrapper(container) : null;
  if (wrapper instanceof Element) {
    evaluationGeneration.set(wrapper, (evaluationGeneration.get(wrapper) || 0) + 1);
  }
}

function isStaleEvaluation(container, generation) {
  if (!(container instanceof Element)) return true;
  return (evaluationGeneration.get(container) || 0) !== generation;
}

function removePlotArmorReportButtonsInScope(container) {
  const logical = resolvePlotArmorContainer(container);
  const key = getRedditRevealKey(logical);

  const purgeRoot = (root) => {
    if (!root || typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll(".plot-armor-report-btn").forEach((btn) => btn.remove());
  };

  purgeRoot(logical);
  const post = logical.closest("shreddit-post");
  purgeRoot(post);
  purgeRoot(post?.shadowRoot);
  purgeRoot(logical.shadowRoot);

  if (key) {
    document.querySelectorAll(".plot-armor-report-btn").forEach((btn) => {
      if (btn.dataset.paRevealKey === key) btn.remove();
    });
  }
}

function cancelPendingEvaluation(container) {
  if (!(container instanceof Element)) return;
  queuedContainers.delete(container);
  for (let i = pendingEvaluationQueue.length - 1; i >= 0; i -= 1) {
    if (pendingEvaluationQueue[i] === container) pendingEvaluationQueue.splice(i, 1);
  }
}

function commitPlotArmorUserReveal(container) {
  const logical = resolvePlotArmorContainer(container);
  if (!(logical instanceof Element)) return;
  invalidateContainerEvaluations(logical);
  logical.setAttribute(USER_REVEALED_ATTR, "1");
  logical.setAttribute(PROCESSED_ATTR, "1");
  cancelPendingEvaluation(logical);
  rememberRedditUserReveal(logical);
  syncRedditFeedWrapperState(logical);
}

function wasPlotArmorUserRevealed(container) {
  if (!(container instanceof Element)) return false;
  const logical = resolvePlotArmorContainer(container);
  if (logical.getAttribute(USER_REVEALED_ATTR) === "1") return true;
  const wrapper = logical.matches("shreddit-post") ? findRedditFeedWrapper(logical) : null;
  if (wrapper?.getAttribute(USER_REVEALED_ATTR) === "1") return true;
  const redditKey = getRedditRevealKey(logical);
  return Boolean(redditKey && redditUserRevealedKeys.has(redditKey));
}

function installRedditEarlyRevealGuard() {
  if (!isRedditHost() || redditEarlyRevealInstalled) return;
  redditEarlyRevealInstalled = true;
  // Document capture runs before shreddit ancestor handlers that can re-hydrate the card.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const hit = event.target.closest(`.${OVERLAY_CLASS}, .plot-armor-blur-wrapper, .plot-armor-intercept`);
      if (!hit) return;
      const container = plotArmorRevealNodes.get(hit);
      if (!container) return;
      commitPlotArmorUserReveal(container);
    },
    { capture: true }
  );
}

function attachAtomicReveal(node, container) {
  plotArmorRevealNodes.set(node, container);
  // Capture-phase + stopImmediatePropagation so first click reaches us before
  // the host site's own click interceptors (Reddit shreddit, X article navigation)
  // can swallow or re-render the event mid-flight (TC#15).
  const handler = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    // Before DOM peel / async SEMANTIC_CHECK resolves: blocks in-flight blur (Reddit snap-back).
    commitPlotArmorUserReveal(container);
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
  removePlotArmorReportButtonsInScope(logicalContainer);

  // Unwrap blurred content wrapper back into the blur surface.
  // No-op when the host-blur path was used (e.g. X) since there is no wrapper.
  const wrapper = blurSurface.querySelector(":scope > .plot-armor-blur-wrapper");
  if (wrapper) {
    while (wrapper.firstChild) blurSurface.insertBefore(wrapper.firstChild, wrapper);
    wrapper.remove();
  }

  syncRedditFeedWrapperState(logicalContainer);

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
  const revealKey = getRedditRevealKey(logicalContainer);
  if (revealKey) reportBtn.dataset.paRevealKey = revealKey;

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
      reportBtn.classList.add("reporting");
      reportText.textContent = "sending…";
      void sendExtensionMessage({
        type: "REPORT_FALSE_POSITIVE",
        text: extractContainerText(logicalContainer).slice(0, 500),
        show,
        reason,
        confidence: confidence !== "" ? Number(confidence) : null,
        source,
        url: location.href,
      })
        .then((response) => {
          if (!response?.ok) {
            finishReportButtonFeedback(reportBtn, reportText, "couldn't send", true);
            return;
          }
          const data = response.data || {};
          if (data.ingested) finishReportButtonFeedback(reportBtn, reportText, "thanks!");
          else if (data.savedLocal) finishReportButtonFeedback(reportBtn, reportText, "logged");
          else finishReportButtonFeedback(reportBtn, reportText, "couldn't send", true);
        })
        .catch(() => {
          finishReportButtonFeedback(reportBtn, reportText, "couldn't send", true);
        });
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
  } else if (isRedditHost()) {
    // Prefer the post/comment action row beside Share; fall back to inline copy.
    scheduleRedditReportButtonPlacement(logicalContainer, reportBtn, () => {
      appendRedditReportButtonFallback(logicalContainer, reportBtn, onRedditComment, blurSurface);
    });
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
  const logical = resolvePlotArmorContainer(container);
  const blurSurface = getPlotArmorBlurSurface(logical);
  if (blurSurface.classList.contains(BLUR_CLASS) || logical.classList.contains(BLUR_CLASS)) return;
  if (wasPlotArmorUserRevealed(logical)) {
    debugLog("skip blur: user already revealed this block", {});
    return;
  }
  ensureContainerPosition(blurSurface);

  const useDirectBlur = isXHost();
  const redditCommentBodyOnly = blurSurface !== logical;
  let blurWrapper = null;

  if (useDirectBlur) {
    // X tweets are flex containers; wrapping their children collapses the
    // flex line. A full-area veil (backdrop + tint) hides media reliably;
    // filter on <article> often misses <video> / compositor quirks.
    const veil = document.createElement("div");
    veil.className = "plot-armor-x-veil";
    logical.appendChild(veil);

    const intercept = document.createElement("div");
    intercept.className = "plot-armor-intercept";
    attachAtomicReveal(intercept, logical);
    logical.appendChild(intercept);
  } else if (redditCommentBodyOnly) {
    // Reddit shreddit-comment: blur only slot="comment" copy, not meta/actions/replies.
    blurWrapper = document.createElement("div");
    blurWrapper.className = "plot-armor-blur-wrapper";
    Array.from(blurSurface.childNodes).forEach((node) => blurWrapper.appendChild(node));
    attachAtomicReveal(blurWrapper, logical);
    blurSurface.appendChild(blurWrapper);
  } else {
    // Wrap ALL child nodes (including bare text nodes) in a single div so
    // the blur filter covers everything, not just element children.
    // On Reddit posts, nested comment containers must stay outside the wrapper so
    // each reply is evaluated and revealed independently.
    blurWrapper = document.createElement("div");
    blurWrapper.className = "plot-armor-blur-wrapper";

    const isReddit = isRedditHost();
    const childSnapshot = Array.from(logical.childNodes);
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

    attachAtomicReveal(blurWrapper, logical);

    logical.appendChild(blurWrapper);
    // Re-attach nested comments after the wrapper so they remain independent.
    skippedChildren.forEach((node) => logical.appendChild(node));
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
  logical.dataset.paShow = meta.matchedShow || "";
  logical.dataset.paReason = meta.reason || "";
  logical.dataset.paConfidence = meta.confidence ?? "";
  logical.dataset.paSource = meta.source || "";

  attachAtomicReveal(overlay, logical);
  blurSurface.appendChild(overlay);

  // Center within the blur surface (comment body on Reddit, full card elsewhere).
  overlay.style.top = "50%";
  overlay.style.left = "50%";

  debugLog("Blur applied", {
    tag: logical.tagName,
    className: logical.className,
    textLength: extractContainerText(logical).length,
  });
  void sendExtensionMessage({
    type: "BLUR_APPLIED",
    textLength: extractContainerText(logical).length,
    tagName: logical.tagName,
    className: logical.className,
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
  const logical = resolvePlotArmorContainer(container);
  if (logical.getAttribute(PROCESSED_ATTR) === "1") return;
  if (wasPlotArmorUserRevealed(logical)) {
    logical.setAttribute(PROCESSED_ATTR, "1");
    return;
  }

  const evalGeneration = evaluationGeneration.get(logical) || 0;

  const textToAnalyze = extractContainerText(logical);
  const isRedditComment =
    location.hostname.toLowerCase().includes("reddit.com") &&
    (logical.matches("shreddit-comment, [data-testid='comment'], [data-test-id='comment']") ||
      String(logical.getAttribute("thingid") || "").startsWith("t1_") ||
      String(logical.id || "").startsWith("comment-thing-"));
  const minLengthForContainer = isRedditComment ? 20 : MIN_TEXT_LENGTH;

  if (!textToAnalyze || textToAnalyze.length < minLengthForContainer) {
    // X hydrates tweet copy after mount; a first paint under MIN_TEXT_LENGTH used to mark
    // processed and skip blur forever. Retry a few times before giving up (TC#X-hydrate).
    if (isXHost()) {
      const attempts = Number(logical.dataset.paTextHydrationAttempts || "0");
      const tooShort = !textToAnalyze || textToAnalyze.length < minLengthForContainer;
      const allowRetry =
        !textToAnalyze ||
        (textToAnalyze.length >= 5 && textToAnalyze.length < MIN_TEXT_LENGTH);
      if (attempts < 3 && tooShort && allowRetry) {
        logical.dataset.paTextHydrationAttempts = String(attempts + 1);
        const delay = textToAnalyze ? 320 + attempts * 500 : 180 + attempts * 280;
        setTimeout(() => {
          if (observersStopped || !logical.isConnected) return;
          if (logical.getAttribute(PROCESSED_ATTR) === "1") return;
          if (wasPlotArmorUserRevealed(logical)) return;
          void evaluateContainer(logical);
        }, delay);
        return;
      }
    }
    logical.setAttribute(PROCESSED_ATTR, "1");
    return;
  }
  delete logical.dataset.paTextHydrationAttempts;

  const analysisText = textToAnalyze.slice(0, MAX_ANALYZE_CHARS);
  const sectionHint = isXHost() ? "" : getSectionHint(logical);
  const precedingContext = getPrecedingContext(logical);
  debugLog("Evaluating container", { textLength: textToAnalyze.length, tag: logical.tagName, hasPrecedingContext: Boolean(precedingContext) });

  try {
    const response = await sendExtensionMessage({
      type: "SEMANTIC_CHECK",
      textToAnalyze: analysisText,
      precedingContext,
      sectionHint,
      containerTag: logical.tagName,
    });
    if (response == null) {
      debugLog("SEMANTIC_CHECK skipped: extension runtime unavailable", {});
    } else {
      debugLog("Semantic check response", response?.data || response);
    }

    if (isStaleEvaluation(logical, evalGeneration)) {
      debugLog("skip blur: stale evaluation after reveal", {});
    } else if (response?.ok && response.data?.isSpoiler) {
      if (wasPlotArmorUserRevealed(logical)) {
        debugLog("skip blur after reveal: in-flight check resolved late", {});
      } else {
        blurContainer(logical, {
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
    if (!isStaleEvaluation(logical, evalGeneration)) {
      logical.setAttribute(PROCESSED_ATTR, "1");
    }
  }
}

function pumpEvaluationQueue() {
  while (activeEvaluations < EVAL_CONCURRENCY_LIMIT && pendingEvaluationQueue.length) {
    const next = pendingEvaluationQueue.shift();
    if (!next || !next.isConnected) continue;
    const logical = resolvePlotArmorContainer(next);
    if (logical.getAttribute(PROCESSED_ATTR) === "1") continue;
    if (wasPlotArmorUserRevealed(logical)) continue;

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
  const logical = resolvePlotArmorContainer(container);
  if (logical.getAttribute(PROCESSED_ATTR) === "1") return;
  if (wasPlotArmorUserRevealed(logical)) return;
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
  if (shouldSkipContainer(container)) {
    cleanupObservedContainer(container);
    return;
  }
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
    // Feed layout: <article data-post-id> wraps <shreddit-post>. Only observe the post.
    if (container.matches("article") && container.querySelector("shreddit-post")) {
      return true;
    }
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
  if (!shouldActivatePlotArmor()) return;
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
  redditUserRevealedKeys.clear();
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
  if (!shouldActivatePlotArmor()) return;
  if (typeof document === "undefined" || !document.documentElement) return;
  const ct = document.contentType || "";
  if (/^image\//i.test(ct)) return;

  injectStyles();

  const run = () => {
    if (plotArmorBooted) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    plotArmorBooted = true;
    installRedditEarlyRevealGuard();
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
