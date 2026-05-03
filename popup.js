const STORAGE_KEY = "protectedShows";
const ACTIVE_SHOWS_KEY = "activeProtectedShows";
const SHOW_THUMBNAILS_KEY = "showThumbnails";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w92";

const inputEl = document.getElementById("showInput");
const addBtn = document.getElementById("addBtn");
const listEl = document.getElementById("showList");
const emptyEl = document.getElementById("emptyState");
const metricsTextEl = document.getElementById("metricsText");
const suggestionsEl = document.getElementById("suggestions");
const pauseAllBtn = document.getElementById("pauseAllBtn");
const enableAllBtn = document.getElementById("enableAllBtn");
const headerShieldStatusEl = document.getElementById("headerShieldStatus");
const headerShieldLabelEl = document.getElementById("headerShieldLabel");

let searchDebounce = null;
let latestSearchToken = 0;
let selectedSuggestion = null;
let showThumbnails = {};
let activeShowMap = {};
/** Shows currently waiting on background keyword / graph sync */
const pendingKeywordSync = new Set();

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

function fillPosterEl(container, url) {
  container.innerHTML = "";
  if (!url) {
    const fb = document.createElement("span");
    fb.className = "poster-fallback";
    fb.textContent = "—";
    container.appendChild(fb);
    return;
  }
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    container.innerHTML = "";
    const fb = document.createElement("span");
    fb.className = "poster-fallback";
    fb.textContent = "—";
    container.appendChild(fb);
  });
  container.appendChild(img);
}

function saveThumbnails() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SHOW_THUMBNAILS_KEY]: showThumbnails }, resolve);
  });
}

function isShowActive(showName) {
  return activeShowMap[showName] !== false;
}

function updateHeaderShieldState(shows, activeCount) {
  if (!headerShieldStatusEl || !headerShieldLabelEl) return;
  const blocking = shows.length > 0 && activeCount > 0;
  headerShieldStatusEl.classList.toggle("is-standby", !blocking);
  headerShieldLabelEl.textContent = blocking ? "System Active" : "Standby";
  headerShieldStatusEl.setAttribute("aria-label", blocking ? "Shields blocking spoilers" : "No shields active");
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
  updateHeaderShieldState(shows, activeCount);

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
    li.className = "show-row";
    li.dataset.show = show;
    if (!isShowActive(show) && !pendingKeywordSync.has(show)) li.classList.add("show-paused");

    const poster = document.createElement("div");
    poster.className = "poster";
    fillPosterEl(poster, posterUrlFromPath(showThumbnails[show]));

    const info = document.createElement("div");
    info.className = "show-info";

    const titleEl = document.createElement("span");
    titleEl.className = "show-title";
    titleEl.textContent = show;

    const refEl = document.createElement("span");
    refEl.className = "show-ref";
    refEl.textContent = refIdForShow(show);

    const statusLine = document.createElement("span");
    statusLine.className = "show-sync-status";
    statusLine.setAttribute("aria-live", "polite");

    info.appendChild(titleEl);
    info.appendChild(statusLine);
    info.appendChild(refEl);

    const controls = document.createElement("div");
    controls.className = "show-controls";

    const swLabel = document.createElement("label");
    swLabel.className = "pa-switch";
    const swInput = document.createElement("input");
    swInput.type = "checkbox";
    swInput.className = "pa-switch-input";
    swInput.dataset.show = show;
    swInput.checked = isShowActive(show);
    swInput.setAttribute("aria-label", `Protection for ${show}`);
    const swUi = document.createElement("span");
    swUi.className = "pa-switch-ui";
    swLabel.appendChild(swInput);
    swLabel.appendChild(swUi);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
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
      poster.appendChild(overlay);
    }

    controls.appendChild(swLabel);
    controls.appendChild(removeBtn);

    li.appendChild(poster);
    li.appendChild(info);
    li.appendChild(controls);
    listEl.appendChild(li);
  });
}

function setShowStatus(showName, status) {
  const item = listEl.querySelector(`li[data-show="${CSS.escape(showName)}"]`);
  if (!item) return;
  item.classList.remove("is-error");
  if (status === "error") item.classList.add("is-error");
}

function getShows() {
  return loadSyncState();
}

function setShows(shows) {
  return saveSyncState(shows);
}

function requestKeywordRefresh(show, isRefresh = false, tmdbSelection = null) {
  console.info("[Plot Armor popup] Sending show to background", { show, isRefresh, tmdbSelection });
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
        console.info("[Plot Armor popup] Background processing succeeded", response.data);
        resolve(response.data);
      }
    );
  });
}

function requestShowRemoval(show) {
  console.info("[Plot Armor popup] Removing show", { show });
  chrome.runtime.sendMessage({ type: "SHOW_REMOVED", showName: show }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Plot Armor background remove message error:", chrome.runtime.lastError.message);
      return;
    }
    if (!response?.ok) {
      console.error("Plot Armor failed to remove show keywords:", response?.error || "Unknown error");
      return;
    }
    console.info("[Plot Armor popup] Show removal processed", response.data);
  });
}

async function addShow() {
  const typed = inputEl.value.trim();
  const show = selectedSuggestion?.title || typed;
  const tmdbSel = selectedSuggestion;

  if (!show) return;

  inputEl.value = "";
  selectedSuggestion = null;
  hideSuggestions();

  const shows = await getShows();
  const exists = shows.some((item) => item.toLowerCase() === show.toLowerCase());

  if (!exists) {
    const updatedShows = [...shows, show];
    activeShowMap[show] = true;
    if (tmdbSel?.posterPath) {
      showThumbnails[show] = tmdbSel.posterPath;
      await saveThumbnails();
    }
    await setShows(updatedShows);
  }

  const currentShows = await getShows();
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
    renderShows(await getShows());
  }
  if (syncFailed) setShowStatus(show, "error");
}

addBtn.addEventListener("click", addShow);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addShow();
});

inputEl.addEventListener("input", () => {
  selectedSuggestion = null;
  const query = inputEl.value.trim();
  if (query.length < 2) {
    hideSuggestions();
    return;
  }
  searchTmdbSuggestions(query);
});

listEl.addEventListener("change", async (event) => {
  const input = event.target.closest(".pa-switch-input");
  if (!input) return;
  const showToToggle = input.dataset.show;
  if (!showToToggle) return;
  const shows = await getShows();
  activeShowMap[showToToggle] = input.checked;
  await setShows(shows);
  renderShows(shows);
});

listEl.addEventListener("click", async (event) => {
  const removeBtn = event.target.closest(".remove-btn");
  if (!removeBtn) return;

  const showToRemove = removeBtn.dataset.show;
  if (!showToRemove) return;

  const shows = await getShows();
  const updatedShows = shows.filter((showName) => showName !== showToRemove);
  delete activeShowMap[showToRemove];

  if (showThumbnails[showToRemove]) {
    delete showThumbnails[showToRemove];
    await saveThumbnails();
  }

  await setShows(updatedShows);
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
  const shows = await getShows();
  shows.forEach((show) => {
    activeShowMap[show] = false;
  });
  await setShows(shows);
  renderShows(shows);
});

enableAllBtn?.addEventListener("click", async () => {
  const shows = await getShows();
  shows.forEach((show) => {
    activeShowMap[show] = true;
  });
  await setShows(shows);
  renderShows(shows);
});

Promise.all([loadSyncState(), loadThumbnails()]).then(([shows]) => renderShows(shows));
