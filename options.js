/**
 * Genre Gate options page.
 *
 * All key operations and all settings reads/writes go through the service
 * worker. This page never reads extension storage directly and never receives
 * the full API key after it has been saved.
 */
(() => {
  "use strict";

  const DEFAULT_MODEL = "openai/gpt-4o-mini";
  const SAVE_DEBOUNCE_MS = 350;

  const elements = {};
  let settings = null;
  let keyState = {
    hasKey: false,
    masked: "",
    rememberKey: true
  };
  let keyEditorOpen = false;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let statusTimer = null;
  let testResetTimer = null;

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    if (!elements.apiKeyInput) return;
    bindEvents();
    void loadState();
  });

  function cacheElements() {
    const ids = [
      "status",
      "enabled-toggle",
      "enabled-label",
      "key-state",
      "key-saved",
      "masked-key",
      "change-key",
      "remove-key",
      "key-editor",
      "api-key-input",
      "save-key",
      "cancel-change",
      "key-editor-help",
      "test-key",
      "test-status",
      "remember-key",
      "key-notice",
      "model-input",
      "use-free-model",
      "min-length",
      "genre-list",
      "new-genre",
      "add-genre",
      "whitelist-list",
      "new-whitelist-channel",
      "new-whitelist-reason",
      "add-whitelist-channel",
      "blacklist-list",
      "new-blacklist-channel",
      "new-blacklist-reason",
      "add-blacklist-channel",
      "clear-cache",
      "cache-status"
    ];
    for (const id of ids) {
      elements[toCamelCase(id)] = document.getElementById(id);
    }
  }

  function toCamelCase(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  }

  function bindEvents() {
    elements.enabledToggle.addEventListener("change", () => {
      void updateEnabled();
    });

    elements.modelInput.addEventListener("input", () => {
      const value = elements.modelInput.value.trim();
      if (!value) return;
      settings.model = value;
      markSettingsChanged();
    });
    elements.modelInput.addEventListener("blur", () => {
      const value = elements.modelInput.value.trim();
      elements.modelInput.value = value || DEFAULT_MODEL;
      settings.model = value || DEFAULT_MODEL;
      markSettingsChanged();
    });

    elements.minLength.addEventListener("input", () => {
      const raw = elements.minLength.value;
      const value = Number(raw);
      if (raw !== "" && Number.isFinite(value) && value >= 0) {
        settings.minLengthMinutes = value;
        markSettingsChanged();
      } else if (raw === "") {
        settings.minLengthMinutes = 0;
        markSettingsChanged();
      }
    });
    elements.minLength.addEventListener("blur", () => {
      const value = Number(elements.minLength.value);
      if (!Number.isFinite(value) || value < 0) {
        elements.minLength.value = "0";
        settings.minLengthMinutes = 0;
      } else {
        elements.minLength.value = String(value);
        settings.minLengthMinutes = value;
      }
      markSettingsChanged();
    });

    elements.useFreeModel.addEventListener("click", () => {
      if (!settings) return;
      settings.model = "openrouter/free";
      elements.modelInput.value = "openrouter/free";
      markSettingsChanged();
      void flushPendingSave();
      setStatus(
        "Free router selected. It supports JSON output and needs no credits.",
        "success"
      );
    });

    elements.addGenre.addEventListener("click", addGenre);
    elements.newGenre.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addGenre();
      }
    });

    elements.addWhitelistChannel.addEventListener("click", () => {
      addChannel("channelWhitelist", "newWhitelistChannel", "newWhitelistReason");
    });
    elements.addBlacklistChannel.addEventListener("click", () => {
      addChannel("channelBlacklist", "newBlacklistChannel", "newBlacklistReason");
    });
    bindChannelEnter(
      elements.newWhitelistChannel,
      elements.newWhitelistReason,
      () => addChannel("channelWhitelist", "newWhitelistChannel", "newWhitelistReason")
    );
    bindChannelEnter(
      elements.newBlacklistChannel,
      elements.newBlacklistReason,
      () => addChannel("channelBlacklist", "newBlacklistChannel", "newBlacklistReason")
    );

    elements.clearCache.addEventListener("click", () => {
      void clearCache();
    });

    elements.changeKey.addEventListener("click", () => {
      if (!settings) return;
      keyEditorOpen = true;
      hideKeyNotice();
      elements.apiKeyInput.value = "";
      renderKey();
      elements.apiKeyInput.focus();
    });

    elements.cancelChange.addEventListener("click", () => {
      if (!settings) return;
      keyEditorOpen = false;
      elements.apiKeyInput.value = "";
      renderKey();
    });

    elements.saveKey.addEventListener("click", () => {
      void saveKey();
    });
    elements.apiKeyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void saveKey();
      }
    });

    elements.removeKey.addEventListener("click", () => {
      void removeKey();
    });

    elements.testKey.addEventListener("click", () => {
      void testKey();
    });

    elements.rememberKey.addEventListener("change", () => {
      void updateRememberPreference();
    });
  }

  async function loadState() {
    setBusy(true);
    const response = await sendMessage({ action: "GET_OPTIONS_STATE" });
    setBusy(false);
    if (!response || response.ok !== true || !response.settings) {
      setStatus("Could not load settings. Reload the page.", "error");
      elements.keyState.textContent = "Error";
      elements.keyState.className = "badge warn";
      return;
    }

    settings = response.settings;
    keyState = response.key || {
      hasKey: false,
      masked: "",
      rememberKey: settings.rememberKey
    };
    renderSettings();
    renderKey();
  }

  function renderSettings() {
    elements.enabledToggle.checked = settings.enabled !== false;
    elements.enabledLabel.textContent = settings.enabled
      ? "Enabled"
      : "Disabled";
    elements.modelInput.value = settings.model || DEFAULT_MODEL;
    elements.minLength.value = String(settings.minLengthMinutes ?? 0);
    settings.channelWhitelist = Array.isArray(settings.channelWhitelist)
      ? settings.channelWhitelist
      : [];
    settings.channelBlacklist = Array.isArray(settings.channelBlacklist)
      ? settings.channelBlacklist
      : [];
    renderGenres();
    renderChannels();
  }

  function renderKey() {
    if (!settings) return;
    const remember = settings.rememberKey !== false;
    const showSaved = keyState.hasKey && !keyEditorOpen;

    elements.rememberKey.checked = remember;
    elements.keySaved.hidden = !showSaved;
    elements.keyEditor.hidden = showSaved;
    elements.maskedKey.textContent = keyState.masked || "••••••••";
    elements.cancelChange.hidden = !(keyEditorOpen && keyState.hasKey);
    elements.testKey.disabled = !keyState.hasKey;

    elements.keyState.textContent = keyState.hasKey ? "Saved" : "Not set";
    elements.keyState.className = keyState.hasKey
      ? "badge good"
      : "badge warn";

    elements.keyEditorHelp.textContent = remember
      ? "Stored in chrome.storage.local on this device. The full key is never shown again after saving."
      : "Kept in chrome.storage.session (memory only) and lost when the browser closes.";

    elements.enabledLabel.textContent = settings.enabled
      ? "Enabled"
      : "Disabled";
  }

  function renderGenres() {
    elements.genreList.replaceChildren();

    settings.genres.forEach((genre, index) => {
      const isOther = genre.name.toLowerCase() === "other";
      const row = document.createElement("div");
      row.className = "genre-row";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = genre.name;
      nameInput.maxLength = 80;
      nameInput.disabled = isOther;
      nameInput.setAttribute(
        "aria-label",
        isOther ? "Other genre (fixed name)" : `Genre name: ${genre.name}`
      );
      let lastValidName = genre.name;

      nameInput.addEventListener("input", () => {
        if (isOther) return;
        const value = nameInput.value.trim();
        if (!value) {
          nameInput.classList.add("invalid");
          return;
        }
        const duplicate = settings.genres.some(
          (item, itemIndex) =>
            itemIndex !== index &&
            item.name.trim().toLowerCase() === value.toLowerCase()
        );
        if (value.toLowerCase() === "other" || duplicate) {
          nameInput.classList.add("invalid");
          return;
        }
        nameInput.classList.remove("invalid");
        genre.name = value;
        lastValidName = value;
        markSettingsChanged();
      });

      nameInput.addEventListener("blur", () => {
        if (isOther) return;
        const value = nameInput.value.trim();
        const duplicate = settings.genres.some(
          (item, itemIndex) =>
            itemIndex !== index &&
            item.name.trim().toLowerCase() === value.toLowerCase()
        );
        if (
          !value ||
          value.toLowerCase() === "other" ||
          duplicate
        ) {
          nameInput.value = lastValidName;
          genre.name = lastValidName;
          nameInput.classList.remove("invalid");
          setStatus(
            'Genre names must be unique, non-empty, and cannot be "Other".',
            "error"
          );
        } else {
          nameInput.value = value;
          genre.name = value;
          lastValidName = value;
        }
      });

      const approvedLabel = document.createElement("label");
      approvedLabel.className = "approved-toggle";
      const approved = document.createElement("input");
      approved.type = "checkbox";
      approved.checked = genre.approved === true;
      approved.addEventListener("change", () => {
        genre.approved = approved.checked;
        markSettingsChanged();
      });
      const approvedText = document.createElement("span");
      approvedText.textContent = "Approved";
      approvedLabel.append(approved, approvedText);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-button";
      remove.textContent = "×";
      remove.title = isOther ? '"Other" cannot be deleted' : `Remove ${genre.name}`;
      remove.setAttribute(
        "aria-label",
        isOther ? '"Other" cannot be deleted' : `Remove ${genre.name}`
      );
      remove.disabled = isOther;
      remove.addEventListener("click", () => {
        if (isOther) return;
        settings.genres.splice(index, 1);
        renderGenres();
        markSettingsChanged();
      });

      row.append(nameInput, approvedLabel, remove);
      elements.genreList.append(row);
    });
  }

  function renderChannels() {
    renderChannelList(
      "channelWhitelist",
      elements.whitelistList,
      "No whitelisted channels."
    );
    renderChannelList(
      "channelBlacklist",
      elements.blacklistList,
      "No blacklisted channels."
    );
  }

  function renderChannelList(listKey, container, emptyText) {
    container.replaceChildren();
    const entries = settings[listKey];

    if (!Array.isArray(entries) || entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "channel-empty";
      empty.textContent = emptyText;
      container.append(empty);
      return;
    }

    entries.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "channel-row";

      const main = document.createElement("div");
      main.className = "channel-main";

      const name = document.createElement("span");
      name.className = "channel-name";
      name.textContent = entry.channel;

      main.append(name);
      if (entry.reason) {
        const reason = document.createElement("span");
        reason.className = "channel-reason";
        reason.textContent = entry.reason;
        main.append(reason);
      }

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-secondary";
      remove.textContent = "Remove";
      remove.setAttribute(
        "aria-label",
        `Remove ${entry.channel} from ${listKey === "channelWhitelist" ? "whitelist" : "blacklist"}`
      );
      remove.addEventListener("click", () => {
        entries.splice(index, 1);
        renderChannels();
        markSettingsChanged();
        void flushPendingSave();
      });

      row.append(main, remove);
      container.append(row);
    });
  }

  function bindChannelEnter(channelInput, reasonInput, action) {
    const listener = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        action();
      }
    };
    channelInput.addEventListener("keydown", listener);
    reasonInput.addEventListener("keydown", listener);
  }

  function addGenre() {
    if (!settings) return;
    const name = elements.newGenre.value.trim();
    if (!name) return;
    if (name.toLowerCase() === "other") {
      setStatus('"Other" is already built in.', "error");
      return;
    }
    if (
      settings.genres.some(
        (genre) => genre.name.toLowerCase() === name.toLowerCase()
      )
    ) {
      setStatus("That genre already exists.", "error");
      return;
    }

    // Keep the permanent "Other" entry last so the most specific choices read
    // first in both the options page and the classifier prompt.
    const otherIndex = settings.genres.findIndex(
      (genre) => genre.name.toLowerCase() === "other"
    );
    const insertAt = otherIndex === -1 ? settings.genres.length : otherIndex;
    settings.genres.splice(insertAt, 0, { name, approved: false });
    elements.newGenre.value = "";
    renderGenres();
    markSettingsChanged();
    elements.newGenre.focus();
  }

  function addChannel(listKey, channelElementKey, reasonElementKey) {
    if (!settings) return;
    const channelInput = elements[channelElementKey];
    const reasonInput = elements[reasonElementKey];
    const channel = channelInput.value.trim();
    if (!channel) return;

    const list = settings[listKey];
    const otherKey =
      listKey === "channelWhitelist" ? "channelBlacklist" : "channelWhitelist";
    const otherList = settings[otherKey];
    const duplicate = list.some(
      (entry) => entry.channel.toLowerCase() === channel.toLowerCase()
    );
    const inOther = otherList.some(
      (entry) => entry.channel.toLowerCase() === channel.toLowerCase()
    );

    if (duplicate) {
      setStatus(
        listKey === "channelWhitelist"
          ? "That channel is already whitelisted."
          : "That channel is already blacklisted.",
        "error"
      );
      return;
    }
    if (inOther) {
      setStatus(
        "That channel is already on the other list. Remove it there first.",
        "error"
      );
      return;
    }

    list.push({
      channel,
      reason: reasonInput.value.trim()
    });
    channelInput.value = "";
    reasonInput.value = "";
    renderChannels();
    markSettingsChanged();
    void flushPendingSave();
    channelInput.focus();
  }

  function markSettingsChanged() {
    if (!settings) return;
    clearTimeout(saveTimer);
    setStatus("Saving…", "");
    saveTimer = setTimeout(() => {
      saveTimer = null;
      queueSave();
    }, SAVE_DEBOUNCE_MS);
  }

  function queueSave() {
    if (!settings) return saveChain;
    const snapshot = JSON.parse(JSON.stringify(settings));
    saveChain = saveChain
      .then(async () => {
        const response = await sendMessage({
          action: "SAVE_SETTINGS",
          settings: snapshot
        });
        if (response && response.ok === true) {
          setStatus("Settings saved.", "success");
        } else {
          setStatus("Could not save settings.", "error");
        }
      })
      .catch(() => {
        setStatus("Could not save settings.", "error");
      });
    return saveChain;
  }

  function flushPendingSave() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      queueSave();
    }
    return saveChain;
  }

  async function updateEnabled() {
    if (!settings) return;
    const enabled = elements.enabledToggle.checked;
    elements.enabledToggle.disabled = true;
    await flushPendingSave();
    settings.enabled = enabled;
    const response = await sendMessage({
      action: "SET_ENABLED",
      enabled
    });
    elements.enabledToggle.disabled = false;

    if (response && response.ok === true) {
      settings.enabled = response.settings.enabled !== false;
      elements.enabledToggle.checked = settings.enabled;
      elements.enabledLabel.textContent = settings.enabled
        ? "Enabled"
        : "Disabled";
      setStatus(
        settings.enabled ? "Genre Gate enabled." : "Genre Gate disabled.",
        "success"
      );
    } else {
      settings.enabled = !enabled;
      elements.enabledToggle.checked = settings.enabled;
      elements.enabledLabel.textContent = settings.enabled
        ? "Enabled"
        : "Disabled";
      setStatus("Could not change the enabled state.", "error");
    }
  }

  async function saveKey() {
    if (!settings) return;
    const apiKey = elements.apiKeyInput.value;
    const remember = elements.rememberKey.checked;
    elements.saveKey.disabled = true;
    elements.cancelChange.disabled = true;
    hideKeyNotice();
    await flushPendingSave();

    settings.rememberKey = remember;
    const response = await sendMessage({
      action: "SAVE_API_KEY",
      apiKey,
      remember
    });

    elements.saveKey.disabled = false;
    elements.cancelChange.disabled = false;

    if (!response || response.ok !== true) {
      showKeyNotice(
        response?.message || "Could not save the API key.",
        true
      );
      setStatus("API key was not saved.", "error");
      return;
    }

    elements.apiKeyInput.value = "";
    keyEditorOpen = false;

    if (response.removed) {
      await refreshKeyStatus();
      showKeyNotice(
        response.message ||
          "Key removed from this device. To fully invalidate it, revoke it in your OpenRouter dashboard (Keys)."
      );
      setStatus("API key removed.", "success");
      return;
    }

    if (response.key) {
      keyState = response.key;
    } else {
      await refreshKeyStatus();
    }
    renderKey();
    showKeyNotice(
      remember
        ? "Key saved on this device."
        : "Key saved for this browser session only (memory only)."
    );
    setStatus("API key saved.", "success");
  }

  async function removeKey() {
    if (!settings || !keyState.hasKey) return;
    const confirmed = window.confirm(
      "Remove the OpenRouter API key from this device?"
    );
    if (!confirmed) return;

    elements.removeKey.disabled = true;
    hideKeyNotice();
    const response = await sendMessage({ action: "REMOVE_API_KEY" });
    elements.removeKey.disabled = false;

    if (!response || response.ok !== true) {
      showKeyNotice(
        response?.message || "Could not remove the API key.",
        true
      );
      setStatus("API key was not removed.", "error");
      return;
    }

    keyEditorOpen = false;
    elements.apiKeyInput.value = "";
    await refreshKeyStatus();
    showKeyNotice(
      response.message ||
        "Key removed from this device. To fully invalidate it, revoke it in your OpenRouter dashboard (Keys)."
    );
    setStatus("API key removed.", "success");
  }

  async function updateRememberPreference() {
    if (!settings) return;
    const remember = elements.rememberKey.checked;
    elements.rememberKey.disabled = true;
    await flushPendingSave();

    const response = await sendMessage({
      action: "SET_REMEMBER_KEY",
      remember
    });
    elements.rememberKey.disabled = false;

    if (response && response.ok === true) {
      settings.rememberKey = remember;
      if (response.key) keyState = response.key;
      renderKey();
      setStatus(
        remember
          ? "Key will be remembered on this device."
          : "Key will be kept in memory only for this browser session.",
        "success"
      );
      return;
    }

    elements.rememberKey.checked = !remember;
    setStatus("Could not change the key storage mode.", "error");
  }

  async function refreshKeyStatus() {
    const response = await sendMessage({ action: "GET_KEY_STATUS" });
    if (response && response.ok === true && response.key) {
      keyState = response.key;
      settings.rememberKey = response.key.rememberKey !== false;
    } else {
      keyState = {
        hasKey: false,
        masked: "",
        rememberKey: settings.rememberKey !== false
      };
    }
    renderKey();
  }

  async function testKey() {
    if (!settings) return;
    if (keyEditorOpen && elements.apiKeyInput.value.trim()) {
      setTestStatus("Save the key before testing it.", "bad");
      return;
    }
    if (!keyState.hasKey) {
      setTestStatus("No API key saved.", "bad");
      return;
    }

    elements.testKey.disabled = true;
    setTestStatus("Testing…", "");
    const response = await sendMessage({ action: "TEST_API_KEY" });
    elements.testKey.disabled = false;

    if (response && response.ok === true) {
      setTestStatus(response.message || "Valid", "good");
    } else {
      setTestStatus(response?.message || "Key test failed.", "bad");
    }
  }

  async function clearCache() {
    if (!settings) return;
    elements.clearCache.disabled = true;
    elements.cacheStatus.textContent = "Clearing…";
    elements.cacheStatus.className = "inline-status";

    const response = await sendMessage({ action: "CLEAR_CACHE" });
    elements.clearCache.disabled = false;

    if (response && response.ok === true) {
      elements.cacheStatus.textContent =
        response.message || "Classification cache cleared.";
      elements.cacheStatus.className = "inline-status good";
      setStatus("Classification cache cleared.", "success");
    } else {
      elements.cacheStatus.textContent = "Could not clear the cache.";
      elements.cacheStatus.className = "inline-status bad";
      setStatus("Could not clear the cache.", "error");
    }
  }

  function setStatus(message, kind) {
    clearTimeout(statusTimer);
    elements.status.textContent = message;
    elements.status.className = "status-toast";
    if (kind === "success") elements.status.classList.add("success");
    if (kind === "error") elements.status.classList.add("error");
    elements.status.hidden = !message;

    if (message) {
      statusTimer = setTimeout(
        () => {
          elements.status.hidden = true;
        },
        kind === "error" ? 6000 : 3200
      );
    }
  }

  function showKeyNotice(message, isError = false) {
    elements.keyNotice.textContent = message;
    elements.keyNotice.className = isError ? "notice error" : "notice";
    elements.keyNotice.hidden = false;
  }

  function hideKeyNotice() {
    elements.keyNotice.hidden = true;
    elements.keyNotice.textContent = "";
  }

  function setTestStatus(message, kind) {
    clearTimeout(testResetTimer);
    elements.testStatus.textContent = message;
    elements.testStatus.className = "inline-status";
    if (kind === "good") elements.testStatus.classList.add("good");
    if (kind === "bad") elements.testStatus.classList.add("bad");

    if (kind === "good") {
      testResetTimer = setTimeout(() => {
        elements.testStatus.textContent = "";
        elements.testStatus.className = "inline-status";
      }, 5000);
    }
  }

  function setBusy(busy) {
    document.body.toggleAttribute("aria-busy", busy);
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
