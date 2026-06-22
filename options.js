// Options page script for Plot Armor

const FALSE_POSITIVES_KEY = "false_positives";

const form = document.getElementById("optionsForm");
const openaiKeyInput = document.getElementById("openaiKey");
const tmdbTokenInput = document.getElementById("tmdbToken");
const ingestUrlInput = document.getElementById("ingestUrl");
const ingestKeyInput = document.getElementById("ingestKey");
const clearBtn = document.getElementById("clearBtn");
const statusDiv = document.getElementById("status");
const reportsCountEl = document.getElementById("reportsCount");
const reportsEmptyEl = document.getElementById("reportsEmpty");
const reportsListEl = document.getElementById("reportsList");
const exportReportsBtn = document.getElementById("exportReportsBtn");
const clearReportsBtn = document.getElementById("clearReportsBtn");
const clearReportsConfirmEl = document.getElementById("clearReportsConfirm");
const clearReportsConfirmCountEl = document.getElementById("clearReportsConfirmCount");
const clearReportsCancelBtn = document.getElementById("clearReportsCancelBtn");
const clearReportsOkBtn = document.getElementById("clearReportsOkBtn");

async function loadSavedKeys() {
  try {
    const result = await chrome.storage.local.get([
      "OPENAI_API_KEY",
      "TMDB_READ_ACCESS_TOKEN",
      "FALSE_POSITIVE_INGEST_URL",
      "FALSE_POSITIVE_INGEST_KEY",
    ]);

    if (result.OPENAI_API_KEY) {
      openaiKeyInput.value = result.OPENAI_API_KEY;
    }

    if (result.TMDB_READ_ACCESS_TOKEN) {
      tmdbTokenInput.value = result.TMDB_READ_ACCESS_TOKEN;
    }

    if (result.FALSE_POSITIVE_INGEST_URL) {
      ingestUrlInput.value = result.FALSE_POSITIVE_INGEST_URL;
    }

    if (result.FALSE_POSITIVE_INGEST_KEY) {
      ingestKeyInput.value = result.FALSE_POSITIVE_INGEST_KEY;
    }
  } catch (error) {
    console.error("Error loading saved keys:", error);
  }
}

function showStatus(message, isError = false) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${isError ? "error" : "success"} show`;

  setTimeout(() => {
    statusDiv.classList.remove("show");
  }, 3000);
}

function loadFalsePositives() {
  return new Promise((resolve) => {
    chrome.storage.local.get([FALSE_POSITIVES_KEY], (result) => {
      const list = Array.isArray(result[FALSE_POSITIVES_KEY]) ? result[FALSE_POSITIVES_KEY] : [];
      resolve(list);
    });
  });
}

function saveFalsePositives(list) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [FALSE_POSITIVES_KEY]: list }, resolve);
  });
}

function formatReportTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hostLabelFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function hideClearReportsConfirm() {
  clearReportsConfirmEl?.classList.add("hidden");
}

function showClearReportsConfirm(count) {
  if (clearReportsConfirmCountEl) clearReportsConfirmCountEl.textContent = String(count);
  clearReportsConfirmEl?.classList.remove("hidden");
}

function renderReports(reports) {
  const items = [...reports].reverse();
  const count = items.length;

  if (reportsCountEl) {
    reportsCountEl.textContent = count === 1 ? "1 report" : `${count} reports`;
  }

  if (exportReportsBtn) exportReportsBtn.disabled = count === 0;
  if (clearReportsBtn) clearReportsBtn.disabled = count === 0;

  if (!reportsListEl || !reportsEmptyEl) return;

  reportsListEl.innerHTML = "";

  if (!count) {
    reportsEmptyEl.classList.remove("hidden");
    hideClearReportsConfirm();
    return;
  }

  reportsEmptyEl.classList.add("hidden");

  items.forEach((report) => {
    const li = document.createElement("li");
    li.className = "report-card";

    const header = document.createElement("div");
    header.className = "report-card-header";

    const showEl = document.createElement("h3");
    showEl.className = "report-show";
    showEl.textContent = report.show || "Unknown show";
    showEl.title = report.show || "";

    const timeEl = document.createElement("span");
    timeEl.className = "report-time";
    timeEl.textContent = formatReportTime(report.timestamp);

    header.append(showEl, timeEl);

    const meta = document.createElement("div");
    meta.className = "report-meta";

    if (report.reason) {
      const tag = document.createElement("span");
      tag.className = "report-tag report-tag--reason";
      tag.textContent = report.reason;
      tag.title = report.reason;
      meta.appendChild(tag);
    }
    if (report.source) {
      const tag = document.createElement("span");
      tag.className = "report-tag";
      tag.textContent = report.source;
      meta.appendChild(tag);
    }
    if (typeof report.confidence === "number") {
      const tag = document.createElement("span");
      tag.className = "report-tag";
      tag.textContent = `${(report.confidence * 100).toFixed(0)}% conf`;
      meta.appendChild(tag);
    }
    if (report.detectorVersion) {
      const tag = document.createElement("span");
      tag.className = "report-tag";
      tag.textContent = report.detectorVersion;
      meta.appendChild(tag);
    }
    const host = hostLabelFromUrl(report.url);
    if (host) {
      const tag = document.createElement("span");
      tag.className = "report-tag";
      tag.textContent = host;
      meta.appendChild(tag);
    }

    const snippet = document.createElement("p");
    snippet.className = "report-snippet";
    snippet.textContent = report.text || "(no snippet)";

    li.appendChild(header);
    if (meta.childNodes.length) li.appendChild(meta);
    li.appendChild(snippet);

    if (report.url) {
      const link = document.createElement("a");
      link.className = "report-link";
      link.href = report.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = report.url;
      link.title = report.url;
      li.appendChild(link);
    }

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "report-copy-btn";
    copyBtn.textContent = "copy json";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        copyBtn.textContent = "copied";
        setTimeout(() => {
          copyBtn.textContent = "copy json";
        }, 1200);
      } catch (_) {
        copyBtn.textContent = "copy failed";
        setTimeout(() => {
          copyBtn.textContent = "copy json";
        }, 1200);
      }
    });
    li.appendChild(copyBtn);
    reportsListEl.appendChild(li);
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const openaiKey = openaiKeyInput.value.trim();
  const tmdbToken = tmdbTokenInput.value.trim();
  const ingestUrl = ingestUrlInput.value.trim();
  const ingestKey = ingestKeyInput.value.trim();

  if (!openaiKey && !tmdbToken && !ingestUrl && !ingestKey) {
    showStatus("Please enter at least one setting", true);
    return;
  }

  try {
    const dataToSave = {};

    if (openaiKey) {
      dataToSave.OPENAI_API_KEY = openaiKey;
    }

    if (tmdbToken) {
      dataToSave.TMDB_READ_ACCESS_TOKEN = tmdbToken;
    }

    if (ingestUrl) {
      dataToSave.FALSE_POSITIVE_INGEST_URL = ingestUrl;
    }

    if (ingestKey) {
      dataToSave.FALSE_POSITIVE_INGEST_KEY = ingestKey;
    }

    await chrome.storage.local.set(dataToSave);
    showStatus("✓ Settings saved successfully!");
  } catch (error) {
    console.error("Error saving keys:", error);
    showStatus("Failed to save settings. Please try again.", true);
  }
});

clearBtn.addEventListener("click", async () => {
  if (!confirm("Clear all saved API keys and Supabase ingest settings?")) {
    return;
  }

  try {
    await chrome.storage.local.remove([
      "OPENAI_API_KEY",
      "TMDB_READ_ACCESS_TOKEN",
      "FALSE_POSITIVE_INGEST_URL",
      "FALSE_POSITIVE_INGEST_KEY",
    ]);
    openaiKeyInput.value = "";
    tmdbTokenInput.value = "";
    ingestUrlInput.value = "";
    ingestKeyInput.value = "";
    showStatus("✓ Settings cleared");
  } catch (error) {
    console.error("Error clearing keys:", error);
    showStatus("Failed to clear keys. Please try again.", true);
  }
});

exportReportsBtn?.addEventListener("click", async () => {
  const reports = await loadFalsePositives();
  if (!reports.length) return;
  const blob = new Blob([JSON.stringify(reports, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `plot-armor-false-positives-${stamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

clearReportsBtn?.addEventListener("click", async () => {
  const reports = await loadFalsePositives();
  if (!reports.length) return;
  showClearReportsConfirm(reports.length);
});

clearReportsCancelBtn?.addEventListener("click", hideClearReportsConfirm);

clearReportsOkBtn?.addEventListener("click", async () => {
  await saveFalsePositives([]);
  hideClearReportsConfirm();
  renderReports([]);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[FALSE_POSITIVES_KEY]) return;
  const next = Array.isArray(changes[FALSE_POSITIVES_KEY].newValue)
    ? changes[FALSE_POSITIVES_KEY].newValue
    : [];
  renderReports(next);
});

loadSavedKeys();
loadFalsePositives().then(renderReports);
