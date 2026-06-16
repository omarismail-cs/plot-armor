// Options page script for Plot Armor
// Handles saving and loading API keys from chrome.storage.local

const form = document.getElementById("optionsForm");
const openaiKeyInput = document.getElementById("openaiKey");
const tmdbTokenInput = document.getElementById("tmdbToken");
const clearBtn = document.getElementById("clearBtn");
const statusDiv = document.getElementById("status");

async function loadSavedKeys() {
  try {
    const result = await chrome.storage.local.get(["OPENAI_API_KEY", "TMDB_READ_ACCESS_TOKEN"]);

    if (result.OPENAI_API_KEY) {
      openaiKeyInput.value = result.OPENAI_API_KEY;
    }

    if (result.TMDB_READ_ACCESS_TOKEN) {
      tmdbTokenInput.value = result.TMDB_READ_ACCESS_TOKEN;
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

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const openaiKey = openaiKeyInput.value.trim();
  const tmdbToken = tmdbTokenInput.value.trim();

  if (!openaiKey && !tmdbToken) {
    showStatus("Please enter at least one API key", true);
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

    await chrome.storage.local.set(dataToSave);
    showStatus("✓ Settings saved successfully!");
  } catch (error) {
    console.error("Error saving keys:", error);
    showStatus("Failed to save settings. Please try again.", true);
  }
});

clearBtn.addEventListener("click", async () => {
  if (!confirm("Are you sure you want to clear all saved API keys?")) {
    return;
  }

  try {
    await chrome.storage.local.remove(["OPENAI_API_KEY", "TMDB_READ_ACCESS_TOKEN"]);
    openaiKeyInput.value = "";
    tmdbTokenInput.value = "";
    showStatus("✓ API keys cleared");
  } catch (error) {
    console.error("Error clearing keys:", error);
    showStatus("Failed to clear keys. Please try again.", true);
  }
});

loadSavedKeys();
