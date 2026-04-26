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
    item.textContent = show;
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

async function addShow() {
  const show = inputEl.value.trim();

  if (!show) return;

  const shows = await getShows();
  const exists = shows.some((item) => item.toLowerCase() === show.toLowerCase());

  if (exists) {
    inputEl.value = "";
    return;
  }

  const updatedShows = [...shows, show];
  await setShows(updatedShows);
  renderShows(updatedShows);
  inputEl.value = "";
}

addBtn.addEventListener("click", addShow);
inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    addShow();
  }
});

getShows().then(renderShows);
