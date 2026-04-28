const STORAGE_KEY = "protectedShows";
const inputEl = document.getElementById("showInput");
const addBtn = document.getElementById("addBtn");
const listEl = document.getElementById("showList");
const emptyEl = document.getElementById("emptyState");
const suggestionsEl = document.getElementById("suggestions");
let searchDebounce = null;
let latestSearchToken = 0;
let selectedSuggestion = null;

function renderShows(shows) {
  listEl.innerHTML = "";

  if (!shows.length) {
    emptyEl.style.display = "block";
    return;
  }

  emptyEl.style.display = "none";

  shows.forEach((show) => {
    const item = document.createElement("li");
    const showName = document.createElement("span");
    showName.className = "show-name";
    showName.textContent = show;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.type = "button";
    removeBtn.textContent = "Remove";
    removeBtn.dataset.show = show;

    item.appendChild(showName);
    item.appendChild(removeBtn);
    listEl.appendChild(item);
  });
}

function getShows() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] || []);
    });
  });
}

function setShows(shows) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_KEY]: shows }, resolve);
  });
}

function requestKeywordRefresh(show, isRefresh = false, tmdbSelection = null) {
  console.info("[Plot Armor popup] Sending show to background", { show, isRefresh, tmdbSelection });
  chrome.runtime.sendMessage(
    { type: "SHOW_ADDED", showName: show, tmdbSelection: tmdbSelection || undefined },
    (response) => {
    if (chrome.runtime.lastError) {
      console.error("Plot Armor background message error:", chrome.runtime.lastError.message);
      return;
    }

    if (!response?.ok) {
      console.error("Plot Armor failed to fetch keywords:", response?.error || "Unknown error");
      return;
    }

    console.info("[Plot Armor popup] Background processing succeeded", response.data);
    }
  );
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

  if (!show) return;

  const shows = await getShows();
  const exists = shows.some((item) => item.toLowerCase() === show.toLowerCase());

  if (exists) {
    requestKeywordRefresh(show, true, selectedSuggestion);
    inputEl.value = "";
    selectedSuggestion = null;
    hideSuggestions();
    return;
  }

  const updatedShows = [...shows, show];
  await setShows(updatedShows);
  console.info("[Plot Armor popup] Added show to sync storage", { show });

  requestKeywordRefresh(show, false, selectedSuggestion);

  renderShows(updatedShows);
  inputEl.value = "";
  selectedSuggestion = null;
  hideSuggestions();
}

addBtn.addEventListener("click", addShow);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addShow();
  }
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

listEl.addEventListener("click", async (event) => {
  const removeBtn = event.target.closest(".remove-btn");
  if (!removeBtn) return;

  const showToRemove = removeBtn.dataset.show;
  if (!showToRemove) return;

  const shows = await getShows();
  const updatedShows = shows.filter((show) => show !== showToRemove);
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

    const title = document.createElement("div");
    title.className = "suggestion-title";
    title.textContent = result.title;

    const meta = document.createElement("div");
    meta.className = "suggestion-meta";
    const mediaLabel = result.mediaType === "tv" ? "TV" : "Movie";
    meta.textContent = `${mediaLabel}${result.year ? ` • ${result.year}` : ""}`;

    item.appendChild(title);
    item.appendChild(meta);
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
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".input-wrap")) hideSuggestions();
});

getShows().then(renderShows);
