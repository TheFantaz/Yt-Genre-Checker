(() => {
  "use strict";

  const elements = {};
  let settings = null;
  let keyConfigured = false;
  let busy = false;

  document.addEventListener("DOMContentLoaded", () => {
    elements.toggle = document.getElementById("enabled-toggle");
    elements.enabledCopy = document.getElementById("enabled-copy");
    elements.keyDot = document.getElementById("key-dot");
    elements.keyCopy = document.getElementById("key-copy");
    elements.modelCopy = document.getElementById("model-copy");
    elements.status = document.getElementById("popup-status");
    elements.openOptions = document.getElementById("open-options");

    elements.toggle.addEventListener("change", () => {
      void updateEnabled();
    });
    elements.openOptions.addEventListener("click", () => {
      try {
        void chrome.runtime.openOptionsPage();
        window.close();
      } catch {
        showStatus("Could not open settings.", true);
      }
    });

    void loadState();
  });

  async function loadState() {
    elements.toggle.disabled = true;
    const response = await sendMessage({ action: "GET_OPTIONS_STATE" });
    if (!response || response.ok !== true || !response.settings) {
      elements.enabledCopy.textContent = "Could not load settings.";
      showStatus("Reload the extension and try again.", true);
      return;
    }

    settings = response.settings;
    keyConfigured = Boolean(response.key && response.key.hasKey);
    elements.toggle.checked = settings.enabled !== false;
    elements.toggle.disabled = false;
    elements.modelCopy.textContent = settings.model || "—";
    renderEnabled();
    renderKey();
  }

  async function updateEnabled() {
    if (busy || !settings) return;
    const enabled = elements.toggle.checked;
    busy = true;
    elements.toggle.disabled = true;
    hideStatus();

    const response = await sendMessage({
      action: "SET_ENABLED",
      enabled
    });

    busy = false;
    elements.toggle.disabled = false;

    if (response && response.ok === true && response.settings) {
      settings = response.settings;
      elements.toggle.checked = settings.enabled !== false;
      renderEnabled();
      showStatus(
        settings.enabled ? "Gate enabled." : "Gate disabled.",
        false
      );
    } else {
      elements.toggle.checked = !enabled;
      showStatus("Could not save the change.", true);
    }
  }

  function renderEnabled() {
    const enabled = settings.enabled !== false;
    elements.enabledCopy.textContent = enabled
      ? "On — new videos pause for a genre check."
      : "Off — videos play normally.";
  }

  function renderKey() {
    elements.keyCopy.textContent = keyConfigured
      ? "OpenRouter API key saved."
      : "No API key set. Open settings to add one.";
    elements.keyDot.className = keyConfigured ? "dot good" : "dot bad";
  }

  function showStatus(message, isError) {
    elements.status.textContent = message;
    elements.status.className = isError
      ? "popup-status error"
      : "popup-status";
    elements.status.hidden = false;
  }

  function hideStatus() {
    elements.status.hidden = true;
    elements.status.textContent = "";
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve(null);
          } else {
            resolve(response || null);
          }
        });
      } catch {
        resolve(null);
      }
    });
  }
})();
