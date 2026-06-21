const STORAGE_KEY = "protectedShows";
const ACTIVE_SHOWS_KEY = "activeProtectedShows";
const SHOW_THUMBNAILS_KEY = "showThumbnails";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w92";
const DEBUG = false;

const inputEl = document.getElementById("showInput");
const addBtn = document.getElementById("addBtn");
const listEl = document.getElementById("showList");
const emptyEl = document.getElementById("emptyState");
const metricsTextEl = document.getElementById("metricsText");
const suggestionsEl = document.getElementById("suggestions");
const pauseAllBtn = document.getElementById("pauseAllBtn");
const enableAllBtn = document.getElementById("enableAllBtn");

let searchDebounce = null;
let latestSearchToken = 0;
let selectedSuggestion = null;
let showThumbnails = {};
let activeShowMap = {};
/** Shows currently waiting on background keyword / graph sync */
const pendingKeywordSync = new Set();

function debugLog(message, payload) {
  if (!DEBUG) return;
  if (payload !== undefined) console.info(message, payload);
  else console.info(message);
}

function refIdForShow(show) {
  let h = 0;
  const text = String(show || "");
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  const hex = (Math.abs(h) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  return `REF-0x${hex}`;
}

function posterUrlFromPath(path) {
  const normalized = String(path || "").trim();
  if (!normalized) return "";
  return `${TMDB_IMAGE_BASE}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

function hasValidTmdbSelection(sel) {
  return Boolean(
    sel &&
      sel.id != null &&
      sel.mediaType &&
      typeof sel.title === "string" &&
      sel.title.trim().length > 0
  );
}

function syncAddButtonState() {
  const canAdd = hasValidTmdbSelection(selectedSuggestion);
  addBtn.disabled = !canAdd;
  addBtn.setAttribute("aria-disabled", canAdd ? "false" : "true");
}

function fillPosterImg(img, url, showName = "") {
  const alt = showName ? `${showName} poster` : "";
  img.classList.remove("poster--empty");
  if (!url) {
    img.removeAttribute("src");
    img.alt = alt;
    img.classList.add("poster--empty");
    return;
  }
  img.src = url;
  img.alt = alt;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => {
    img.removeAttribute("src");
    img.alt = alt;
    img.classList.add("poster--empty");
  };
}

function saveThumbnails() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SHOW_THUMBNAILS_KEY]: showThumbnails }, resolve);
  });
}

function isShowActive(showName) {
  return activeShowMap[showName] !== false;
}

function saveSyncState(shows) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(
      {
        [STORAGE_KEY]: shows,
        [ACTIVE_SHOWS_KEY]: activeShowMap,
      },
      resolve
    );
  });
}

function loadSyncState() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY, ACTIVE_SHOWS_KEY], (result) => {
      const shows = result[STORAGE_KEY] || [];
      activeShowMap = result[ACTIVE_SHOWS_KEY] || {};
      resolve(shows);
    });
  });
}

function loadThumbnails() {
  return new Promise((resolve) => {
    chrome.storage.local.get([SHOW_THUMBNAILS_KEY], (result) => {
      showThumbnails = result[SHOW_THUMBNAILS_KEY] || {};
      resolve(showThumbnails);
    });
  });
}

let clapperPatternSeq = 0;

function clapperboardToggleUi() {
  const uid = ++clapperPatternSeq;
  const stripeId = `pa-stripes-${uid}`;
  const armId = `clapper-arm-${uid}`;
  const wrap = document.createElement("span");
  wrap.className = "pa-clapper-ui";
  wrap.innerHTML = `
    <svg width="28" height="28" viewBox="2 3 18 21" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
      <defs>
        <pattern
          id="${stripeId}"
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
          patternTransform="rotate(-45 4 12.5)"
        >
          <rect width="3" height="6" fill="currentColor" />
        </pattern>
      </defs>
      <g class="pa-clapper-body">
        <rect
          class="pa-clapper-body-fill"
          x="4"
          y="12.5"
          width="15"
          height="11.5"
          rx="0.8"
          fill="currentColor"
          stroke="none"
        />
        <rect x="4" y="12.5" width="15" height="11.5" rx="0.8" />
        <rect x="4" y="12.5" width="15" height="3" fill="url(#${stripeId})" stroke="none" />
      </g>
      <g id="${armId}" class="clapper-arm pa-clapper-arm">
        <rect x="4" y="8.5" width="15" height="4" rx="0.5" fill="currentColor" fill-opacity="0.12" stroke="none" />
        <rect x="4" y="8.5" width="15" height="4" rx="0.5" fill="url(#${stripeId})" stroke="none" />
        <rect x="4" y="8.5" width="15" height="4" rx="0.5" fill="none" />
      </g>
      <circle cx="4" cy="12.5" r="0.85" fill="currentColor" stroke="none" />
    </svg>`;
  return wrap;
}

function removeIconSvg() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p1 = document.createElementNS(ns, "path");
  p1.setAttribute("d", "M18 6 6 18");
  const p2 = document.createElementNS(ns, "path");
  p2.setAttribute("d", "m6 6 12 12");
  svg.appendChild(p1);
  svg.appendChild(p2);
  return svg;
}

function renderShows(shows) {
  listEl.innerHTML = "";

  const activeCount = shows.filter((s) => isShowActive(s)).length;
  if (metricsTextEl) {
    metricsTextEl.textContent = `${activeCount}/${shows.length} Shields Active`;
  }

  if (!shows.length) {
    emptyEl.classList.remove("hidden");
    if (pauseAllBtn) pauseAllBtn.disabled = true;
    if (enableAllBtn) enableAllBtn.disabled = true;
    return;
  }

  emptyEl.classList.add("hidden");
  if (pauseAllBtn) pauseAllBtn.disabled = false;
  if (enableAllBtn) enableAllBtn.disabled = false;

  shows.forEach((show) => {
    const li = document.createElement("li");
    li.className = "media-row";
    li.dataset.show = show;
    if (!isShowActive(show) && !pendingKeywordSync.has(show)) li.classList.add("show-paused");

    const posterWrap = document.createElement("div");
    posterWrap.className = "poster-wrap";

    const posterImg = document.createElement("img");
    posterImg.className = "poster";
    fillPosterImg(posterImg, posterUrlFromPath(showThumbnails[show]), show);
    posterWrap.appendChild(posterImg);

    const meta = document.createElement("div");
    meta.className = "meta-content";

    const titleEl = document.createElement("h3");
    titleEl.className = "title";
    titleEl.textContent = show;

    const statusLine = document.createElement("span");
    statusLine.className = "show-sync-status";
    statusLine.setAttribute("aria-live", "polite");

    const refEl = document.createElement("span");
    refEl.className = "ref-code";
    refEl.textContent = refIdForShow(show);

    meta.appendChild(titleEl);
    meta.appendChild(statusLine);
    meta.appendChild(refEl);

    const actions = document.createElement("div");
    actions.className = "actions";

    const toggleBtn = document.createElement("label");
    toggleBtn.className = "toggle-btn pa-clapper";
    const swInput = document.createElement("input");
    swInput.type = "checkbox";
    swInput.className = "pa-clapper-input";
    swInput.dataset.show = show;
    swInput.checked = isShowActive(show);
    swInput.setAttribute(
      "aria-label",
      isShowActive(show) ? `Shield active for ${show} — click to pause` : `Shield paused for ${show} — click to enable`
    );
    const swUi = clapperboardToggleUi();
    toggleBtn.appendChild(swInput);
    toggleBtn.appendChild(swUi);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "delete-btn";
    removeBtn.dataset.show = show;
    removeBtn.setAttribute("aria-label", `Remove ${show}`);
    removeBtn.appendChild(removeIconSvg());

    if (pendingKeywordSync.has(show)) {
      li.classList.add("is-loading");
      li.setAttribute("aria-busy", "true");
      swInput.disabled = true;
      removeBtn.disabled = true;
      statusLine.textContent = "Syncing shield data…";
      const overlay = document.createElement("div");
      overlay.className = "poster-loading-overlay";
      overlay.setAttribute("aria-hidden", "true");
      const spin = document.createElement("div");
      spin.className = "poster-loading-spinner";
      overlay.appendChild(spin);
      posterWrap.appendChild(overlay);
    }

    actions.appendChild(toggleBtn);
    actions.appendChild(removeBtn);

    li.appendChild(posterWrap);
    li.appendChild(meta);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
}

function setShowStatus(showName, status) {
  const item = listEl.querySelector(`li[data-show="${CSS.escape(showName)}"]`);
  if (!item) return;
  item.classList.remove("is-error");
  if (status === "error") item.classList.add("is-error");
}

function requestKeywordRefresh(show, isRefresh = false, tmdbSelection = null) {
  debugLog("[Plot Armor popup] Sending show to background", { show, isRefresh, tmdbSelection });
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "SHOW_ADDED", showName: show, tmdbSelection: tmdbSelection || undefined },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Unknown error"));
          return;
        }
        debugLog("[Plot Armor popup] Background processing succeeded", response.data);
        resolve(response.data);
      }
    );
  });
}

function requestShowRemoval(show) {
  debugLog("[Plot Armor popup] Removing show", { show });
  chrome.runtime.sendMessage({ type: "SHOW_REMOVED", showName: show }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Plot Armor background remove message error:", chrome.runtime.lastError.message);
      return;
    }
    if (!response?.ok) {
      console.error("Plot Armor failed to remove show keywords:", response?.error || "Unknown error");
      return;
    }
    debugLog("[Plot Armor popup] Show removal processed", response.data);
  });
}

async function addShow() {
  if (!hasValidTmdbSelection(selectedSuggestion)) return;

  const show = selectedSuggestion.title.trim();
  const tmdbSel = selectedSuggestion;

  inputEl.value = "";
  selectedSuggestion = null;
  syncAddButtonState();
  hideSuggestions();

  const shows = await loadSyncState();
  const exists = shows.some((item) => item.toLowerCase() === show.toLowerCase());

  if (!exists) {
    const updatedShows = [...shows, show];
    activeShowMap[show] = true;
    if (tmdbSel?.posterPath) {
      showThumbnails[show] = tmdbSel.posterPath;
      await saveThumbnails();
    }
    await saveSyncState(updatedShows);
  }

  const currentShows = await loadSyncState();
  pendingKeywordSync.add(show);
  renderShows(currentShows);

  let syncFailed = false;
  try {
    await requestKeywordRefresh(show, exists, tmdbSel);
  } catch (err) {
    syncFailed = true;
    console.error("[Plot Armor popup] Story graph failed", err);
  } finally {
    pendingKeywordSync.delete(show);
    renderShows(await loadSyncState());
  }
  if (syncFailed) setShowStatus(show, "error");
}

addBtn.addEventListener("click", addShow);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addShow();
});

inputEl.addEventListener("input", () => {
  selectedSuggestion = null;
  syncAddButtonState();
  const query = inputEl.value.trim();
  if (query.length < 2) {
    hideSuggestions();
    return;
  }
  searchTmdbSuggestions(query);
});

listEl.addEventListener("change", async (event) => {
  const input = event.target.closest(".pa-clapper-input");
  if (!input) return;
  const showToToggle = input.dataset.show;
  if (!showToToggle) return;
  const shows = await loadSyncState();
  activeShowMap[showToToggle] = input.checked;
  await saveSyncState(shows);
  renderShows(shows);
});

listEl.addEventListener("click", async (event) => {
  const removeBtn = event.target.closest(".delete-btn");
  if (!removeBtn) return;

  const showToRemove = removeBtn.dataset.show;
  if (!showToRemove) return;

  const shows = await loadSyncState();
  const updatedShows = shows.filter((showName) => showName !== showToRemove);
  delete activeShowMap[showToRemove];

  if (showThumbnails[showToRemove]) {
    delete showThumbnails[showToRemove];
    await saveThumbnails();
  }

  await saveSyncState(updatedShows);
  renderShows(updatedShows);
  requestShowRemoval(showToRemove);
});

function hideSuggestions() {
  suggestionsEl.classList.add("hidden");
  suggestionsEl.innerHTML = "";
}

function selectSuggestion(suggestion) {
  selectedSuggestion = suggestion;
  inputEl.value = suggestion.title;
  hideSuggestions();
  syncAddButtonState();
}

function renderSuggestions(results) {
  suggestionsEl.innerHTML = "";
  if (!results.length) {
    hideSuggestions();
    return;
  }

  results.forEach((result) => {
    const item = document.createElement("li");
    item.className = "suggestion-item";
    item.dataset.id = String(result.id);
    item.dataset.title = result.title;
    item.dataset.year = result.year || "";
    item.dataset.mediaType = result.mediaType;
    item.dataset.posterPath = result.posterPath || "";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "suggestion-thumb-wrap";
    const url = posterUrlFromPath(result.posterPath);
    if (!url) {
      const fb = document.createElement("div");
      fb.className = "suggestion-thumb-fallback";
      fb.textContent = "—";
      thumbWrap.appendChild(fb);
    } else {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        thumbWrap.innerHTML = "";
        const fb = document.createElement("div");
        fb.className = "suggestion-thumb-fallback";
        fb.textContent = "—";
        thumbWrap.appendChild(fb);
      });
      thumbWrap.appendChild(img);
    }

    const title = document.createElement("div");
    title.className = "suggestion-title";
    title.textContent = result.title;

    const meta = document.createElement("div");
    meta.className = "suggestion-meta";
    const mediaLabel = result.mediaType === "tv" ? "TV" : "MOV";
    meta.textContent = `${mediaLabel}${result.year ? ` · ${result.year}` : ""}`;

    const textWrap = document.createElement("div");
    textWrap.className = "suggestion-text";
    textWrap.appendChild(title);
    textWrap.appendChild(meta);

    item.appendChild(thumbWrap);
    item.appendChild(textWrap);
    suggestionsEl.appendChild(item);
  });

  suggestionsEl.classList.remove("hidden");
}

function searchTmdbSuggestions(query) {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const token = ++latestSearchToken;
    chrome.runtime.sendMessage({ type: "TMDB_SEARCH", query }, (response) => {
      if (token !== latestSearchToken) return;
      if (chrome.runtime.lastError || !response?.ok) {
        hideSuggestions();
        return;
      }
      renderSuggestions(response.data?.results || []);
    });
  }, 220);
}

suggestionsEl.addEventListener("click", (event) => {
  const item = event.target.closest(".suggestion-item");
  if (!item) return;
  selectSuggestion({
    id: Number(item.dataset.id),
    title: item.dataset.title,
    year: item.dataset.year || "",
    mediaType: item.dataset.mediaType,
    posterPath: item.dataset.posterPath || "",
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".input-wrap-v0")) hideSuggestions();
});

pauseAllBtn?.addEventListener("click", async () => {
  const shows = await loadSyncState();
  shows.forEach((show) => {
    activeShowMap[show] = false;
  });
  await saveSyncState(shows);
  renderShows(shows);
});

enableAllBtn?.addEventListener("click", async () => {
  const shows = await loadSyncState();
  shows.forEach((show) => {
    activeShowMap[show] = true;
  });
  await saveSyncState(shows);
  renderShows(shows);
});

Promise.all([loadSyncState(), loadThumbnails()]).then(([shows]) => {
  renderShows(shows);
  syncAddButtonState();
});
