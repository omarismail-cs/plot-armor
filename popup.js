const STORAGE_KEY = "protectedShows";
const inputEl = document.getElementById("showInput");
const addBtn = document.getElementById("addBtn");
const listEl = document.getElementById("showList");
const emptyEl = document.getElementById("emptyState");

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

function requestKeywordRefresh(show, isRefresh = false) {
  console.info("[Plot Armor popup] Sending show to background", { show, isRefresh });
  chrome.runtime.sendMessage({ type: "SHOW_ADDED", showName: show }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Plot Armor background message error:", chrome.runtime.lastError.message);
      return;
    }

    if (!response?.ok) {
      console.error("Plot Armor failed to fetch keywords:", response?.error || "Unknown error");
      return;
    }

    console.info("[Plot Armor popup] Background processing succeeded", response.data);
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
  const show = inputEl.value.trim();

  if (!show) return;

  const shows = await getShows();
  const exists = shows.some((item) => item.toLowerCase() === show.toLowerCase());

  if (exists) {
    requestKeywordRefresh(show, true);
    inputEl.value = "";
    return;
  }

  const updatedShows = [...shows, show];
  await setShows(updatedShows);
  console.info("[Plot Armor popup] Added show to sync storage", { show });

  requestKeywordRefresh(show);

  renderShows(updatedShows);
  inputEl.value = "";
}

addBtn.addEventListener("click", addShow);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addShow();
  }
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

getShows().then(renderShows);
