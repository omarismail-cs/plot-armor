// Options page script for Plot Armor
// Handles saving and loading API keys from chrome.storage.local

const form = document.getElementById("optionsForm");
const openaiKeyInput = document.getElementById("openaiKey");
const tmdbTokenInput = document.getElementById("tmdbToken");
const supabaseUrlInput = document.getElementById("supabaseUrl");
const supabaseAnonKeyInput = document.getElementById("supabaseAnonKey");
const clearBtn = document.getElementById("clearBtn");
const statusDiv = document.getElementById("status");

const STORAGE_KEYS = [
  "OPENAI_API_KEY",
  "TMDB_READ_ACCESS_TOKEN",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
];

async function loadSavedKeys() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS);

    if (result.OPENAI_API_KEY) {
      openaiKeyInput.value = result.OPENAI_API_KEY;
    }

    if (result.TMDB_READ_ACCESS_TOKEN) {
      tmdbTokenInput.value = result.TMDB_READ_ACCESS_TOKEN;
    }

    if (result.SUPABASE_URL) {
      supabaseUrlInput.value = result.SUPABASE_URL;
    }

    if (result.SUPABASE_ANON_KEY) {
      supabaseAnonKeyInput.value = result.SUPABASE_ANON_KEY;
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

function normalizeSupabaseUrl(raw) {
  return String(raw || "")
    .trim()
    .replace(/\/$/, "");
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const openaiKey = openaiKeyInput.value.trim();
  const tmdbToken = tmdbTokenInput.value.trim();
  const supabaseUrl = normalizeSupabaseUrl(supabaseUrlInput.value);
  const supabaseAnonKey = supabaseAnonKeyInput.value.trim();

  if (!openaiKey && !tmdbToken && !supabaseUrl && !supabaseAnonKey) {
    showStatus("Please enter at least one setting", true);
    return;
  }

  if ((supabaseUrl && !supabaseAnonKey) || (!supabaseUrl && supabaseAnonKey)) {
    showStatus("Supabase URL and anon key must both be set (or leave both empty)", true);
    return;
  }

  if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) {
    showStatus("Supabase URL should look like https://your-project.supabase.co", true);
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

    if (supabaseUrl && supabaseAnonKey) {
      dataToSave.SUPABASE_URL = supabaseUrl;
      dataToSave.SUPABASE_ANON_KEY = supabaseAnonKey;
    } else {
      await chrome.storage.local.remove(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
    }

    await chrome.storage.local.set(dataToSave);
    showStatus("✓ Settings saved successfully!");
  } catch (error) {
    console.error("Error saving keys:", error);
    showStatus("Failed to save settings. Please try again.", true);
  }
});

clearBtn.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to clear all saved settings?")) {
    return;
  }

  try {
    await chrome.storage.local.remove(STORAGE_KEYS);
    openaiKeyInput.value = "";
    tmdbTokenInput.value = "";
    supabaseUrlInput.value = "";
    supabaseAnonKeyInput.value = "";
    showStatus("✓ Settings cleared");
  } catch (error) {
    console.error("Error clearing keys:", error);
    showStatus("Failed to clear settings. Please try again.", true);
  }
});

loadSavedKeys();
