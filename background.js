/**
 * Genre Gate - Manifest V3 service worker.
 *
 * Everything that matters is read from chrome.storage on every request. The
 * worker can be terminated at any time, so there is no authoritative in-memory
 * settings/key/cache state here. The only in-memory map below tracks fetches
 * that are currently in flight so the content script can cancel work for a
 * video the user has already navigated away from.
 */

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const API_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const KEY_REMOVED_MESSAGE =
  "Key removed from this device. To fully invalidate it, revoke it in your OpenRouter dashboard (Keys).";

const DEFAULT_GENRES = Object.freeze([
  Object.freeze({ name: "Tech/Informational", approved: true }),
  Object.freeze({ name: "Educational/Tutorial", approved: true }),
  Object.freeze({ name: "Cooking Tutorial", approved: true }),
  Object.freeze({ name: "News/Current Events", approved: false }),
  Object.freeze({ name: "Gaming", approved: false }),
  Object.freeze({ name: "Comedy/Entertainment", approved: false }),
  Object.freeze({ name: "Music", approved: false }),
  Object.freeze({ name: "Vlog", approved: false }),
  Object.freeze({ name: "Other", approved: false })
]);

const SETTINGS_KEYS = [
  "genres",
  "channelWhitelist",
  "channelBlacklist",
  "minLengthMinutes",
  "model",
  "enabled",
  "rememberKey"
];

// The general auto-save path must not clobber the two settings that have their
// own dedicated atomic operations (and can race with a key move/toggle).
const AUTO_SAVE_KEYS = SETTINGS_KEYS.filter(
  (key) => key !== "enabled" && key !== "rememberKey"
);

const activeRequests = new Map();

/*
 * SECURITY: lock the extension-only storage areas before any request can be
 * served. Content scripts get TypeError/permission errors when they try to read
 * local or session storage. These calls intentionally live at the top level so
 * they run on every service-worker startup, not only for one event.
 */
try {
  chrome.storage.local.setAccessLevel(
    { accessLevel: "TRUSTED_CONTEXTS" },
    () => void chrome.runtime.lastError
  );
} catch {
  // Older Chromium builds without setAccessLevel still get the message API;
  // the extension never exposes the key through messages.
}
try {
  chrome.storage.session.setAccessLevel(
    { accessLevel: "TRUSTED_CONTEXTS" },
    () => void chrome.runtime.lastError
  );
} catch {
  // See the note above.
}

chrome.runtime.onInstalled.addListener(() => {
  void seedDefaults();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch(() => {
      sendResponse({
        ok: false,
        code: "internal",
        message: "Genre Gate hit an unexpected error."
      });
    });
  return true;
});

/* -------------------------------------------------------------------------- */
/* Defaults and validation                                                   */
/* -------------------------------------------------------------------------- */

function defaultSettings() {
  return {
    genres: DEFAULT_GENRES.map((genre) => ({ ...genre })),
    channelWhitelist: [],
    channelBlacklist: [],
    minLengthMinutes: 0,
    model: DEFAULT_MODEL,
    enabled: true,
    rememberKey: true
  };
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeGenres(value) {
  // An absent or empty genre list means "use the shipped defaults". A list that
  // contains only invalid entries is allowed to collapse to just "Other".
  const source =
    Array.isArray(value) && value.length > 0
      ? value
      : DEFAULT_GENRES.map((genre) => ({ ...genre }));
  const genres = [];
  const seen = new Set();
  let otherApproved = false;

  for (const item of source.slice(0, 100)) {
    const rawName = typeof item === "object" && item ? item.name : "";
    const name = cleanText(rawName, 80);
    if (!name) continue;

    if (name.toLowerCase() === "other") {
      otherApproved = item.approved === true;
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    genres.push({ name, approved: item.approved === true });
  }

  // "Other" is a permanent, case-insensitive fixture and always sorts last.
  genres.push({ name: "Other", approved: otherApproved });
  return genres;
}

function normalizeChannelList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const entries = [];

  for (const item of value.slice(0, 500)) {
    // Existing releases stored plain strings. Accept both shapes so upgrading
    // does not drop an existing whitelist.
    const channel =
      typeof item === "string"
        ? cleanText(item, 200)
        : cleanText(item?.channel, 200);
    if (!channel) continue;

    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const reason =
      typeof item === "object" && item
        ? cleanText(item.reason ?? item.genre, 200)
        : "";
    entries.push({ channel, reason });
  }

  return entries;
}

function normalizeSettings(raw = {}) {
  const settings = defaultSettings();
  return {
    genres: normalizeGenres(raw.genres),
    channelWhitelist: normalizeChannelList(raw.channelWhitelist),
    channelBlacklist: normalizeChannelList(raw.channelBlacklist),
    minLengthMinutes: clampNumber(
      raw.minLengthMinutes,
      0,
      100_000,
      settings.minLengthMinutes
    ),
    model: cleanText(raw.model, 200) || DEFAULT_MODEL,
    enabled: raw.enabled !== false,
    rememberKey: raw.rememberKey !== false
  };
}

function settingsForStorage(settings) {
  return {
    genres: settings.genres,
    channelWhitelist: settings.channelWhitelist,
    channelBlacklist: settings.channelBlacklist,
    minLengthMinutes: settings.minLengthMinutes,
    model: settings.model,
    enabled: settings.enabled,
    rememberKey: settings.rememberKey
  };
}

async function seedDefaults() {
  try {
    const stored = await chrome.storage.sync.get(SETTINGS_KEYS);
    const defaults = defaultSettings();
    const patch = {};
    for (const key of SETTINGS_KEYS) {
      if (stored[key] === undefined) {
        patch[key] = defaults[key];
      }
    }
    if (Object.keys(patch).length > 0) {
      await chrome.storage.sync.set(patch);
    }
  } catch {
    // Defaults are still applied in memory by normalizeSettings().
  }
}

/* -------------------------------------------------------------------------- */
/* Storage helpers                                                           */
/* -------------------------------------------------------------------------- */

async function readSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEYS);
  return normalizeSettings(stored);
}

async function writeSettings(settings) {
  await chrome.storage.sync.set(settingsForStorage(settings));
}

function keyArea(rememberKey) {
  return rememberKey ? chrome.storage.local : chrome.storage.session;
}

async function readApiKey(rememberKey) {
  try {
    const stored = await keyArea(rememberKey).get("apiKey");
    return typeof stored.apiKey === "string" ? stored.apiKey.trim() : "";
  } catch {
    return "";
  }
}

function maskApiKey(key) {
  if (typeof key !== "string" || key.length === 0) return "";
  const lastFour = key.slice(-4);
  return key.startsWith("sk-or-")
    ? `sk-or-••••${lastFour}`
    : `••••••••${lastFour}`;
}

function randomString(length) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[bytes[index] % alphabet.length];
  }
  return result;
}

/**
 * Best-effort key deletion.
 *
 * We overwrite the value with random text of the same length and then remove
 * the entry. This is a mitigation, not a guarantee: Chrome's LevelDB backing
 * storage may retain old bytes until compaction. Revoking the key at OpenRouter
 * is the only guaranteed way to invalidate it.
 */
async function securelyRemoveKeyFromArea(area) {
  let oldValue = "";
  try {
    const stored = await area.get("apiKey");
    oldValue = typeof stored.apiKey === "string" ? stored.apiKey : "";
  } catch {
    // Continue to the remove attempt even if reading failed.
  }

  if (oldValue.length > 0) {
    try {
      await area.set({ apiKey: randomString(oldValue.length) });
    } catch {
      // The final remove below is still attempted.
    }
  }

  try {
    await area.remove("apiKey");
  } catch {
    // Nothing else can be done locally; revocation at OpenRouter is the fix.
  }
}

async function removeKeyEverywhere() {
  await Promise.all([
    securelyRemoveKeyFromArea(chrome.storage.local),
    securelyRemoveKeyFromArea(chrome.storage.session)
  ]);
}

async function keyStatus(settings) {
  const key = await readApiKey(settings.rememberKey);
  return {
    hasKey: key.length > 0,
    masked: key ? maskApiKey(key) : "",
    rememberKey: settings.rememberKey
  };
}

async function readCache() {
  try {
    const stored = await chrome.storage.local.get("classificationCache");
    const cache = stored.classificationCache;
    if (cache && typeof cache === "object" && !Array.isArray(cache)) {
      return cache;
    }
  } catch {
    // A missing/unreadable cache behaves like an empty cache.
  }
  return {};
}

function validCacheEntry(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.genre === "string" &&
      entry.genre.length > 0 &&
      typeof entry.timestamp === "number" &&
      Number.isFinite(entry.timestamp)
  );
}

async function storeClassification(videoId, genre) {
  const cache = await readCache();
  cache[videoId] = { genre, timestamp: Date.now() };
  await chrome.storage.local.set({ classificationCache: cache });
}

function localDateKey() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

async function readWatchAnywayStats() {
  const date = localDateKey();
  try {
    const stored = await chrome.storage.local.get("watchAnywayStats");
    const stats = stored.watchAnywayStats;
    if (
      stats &&
      stats.date === date &&
      Number.isFinite(stats.count) &&
      stats.count >= 0
    ) {
      return { date, count: Math.floor(stats.count) };
    }
  } catch {
    // A missing/unreadable counter behaves like zero for today.
  }
  return { date, count: 0 };
}

async function incrementWatchAnywayCount() {
  const stats = await readWatchAnywayStats();
  const next = { date: stats.date, count: stats.count + 1 };
  await chrome.storage.local.set({ watchAnywayStats: next });
  return next;
}

/* -------------------------------------------------------------------------- */
/* Message handlers                                                          */
/* -------------------------------------------------------------------------- */

async function handleMessage(message, sender) {
  if (sender && sender.id && sender.id !== chrome.runtime.id) {
    return { ok: false, code: "forbidden", message: "Unknown sender." };
  }
  if (!message || typeof message !== "object") {
    return { ok: false, code: "bad_request", message: "Invalid request." };
  }

  switch (message.action) {
    case "CLASSIFY_VIDEO":
      return classifyVideoRequest(message);
    case "CANCEL_CLASSIFICATION":
      return cancelClassificationRequest(message);
    case "GET_SETTINGS":
      return { ok: true, settings: await readSettings() };
    case "GET_OPTIONS_STATE":
      return getOptionsState();
    case "GET_KEY_STATUS":
      return getKeyStatusResponse();
    case "SAVE_SETTINGS":
      return saveSettingsRequest(message);
    case "SET_ENABLED":
      return setEnabledRequest(message);
    case "SAVE_API_KEY":
      return saveApiKeyRequest(message);
    case "REMOVE_API_KEY":
      return removeApiKeyRequest();
    case "SET_REMEMBER_KEY":
      return setRememberKeyRequest(message);
    case "TEST_API_KEY":
      return testApiKeyRequest();
    case "CLEAR_CACHE":
      // Deliberately ONLY the cache. This must never be combined with key
      // removal, the watch-anyway count, or any other storage cleanup.
      await chrome.storage.local.remove("classificationCache");
      return { ok: true, message: "Classification cache cleared." };
    case "GET_WATCH_ANYWAY_COUNT":
      return {
        ok: true,
        count: (await readWatchAnywayStats()).count
      };
    case "INCREMENT_WATCH_ANYWAY":
      return {
        ok: true,
        count: (await incrementWatchAnywayCount()).count
      };
    case "ALLOW_GENRE":
      return allowGenreRequest(message);
    case "OPEN_OPTIONS":
      return openOptionsRequest();
    default:
      return { ok: false, code: "unknown_action", message: "Unknown action." };
  }
}

async function getOptionsState() {
  const settings = await readSettings();
  return {
    ok: true,
    settings,
    key: await keyStatus(settings)
  };
}

async function getKeyStatusResponse() {
  const settings = await readSettings();
  return { ok: true, key: await keyStatus(settings) };
}

async function saveSettingsRequest(message) {
  const current = await readSettings();
  const incoming =
    message.settings && typeof message.settings === "object"
      ? message.settings
      : {};
  const merged = { ...current };
  for (const key of AUTO_SAVE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      merged[key] = incoming[key];
    }
  }
  const settings = normalizeSettings(merged);
  await writeSettings(settings);
  return { ok: true, settings };
}

async function setEnabledRequest(message) {
  const enabled = message.enabled !== false;
  await chrome.storage.sync.set({ enabled });
  const settings = await readSettings();
  return { ok: true, settings };
}

async function saveApiKeyRequest(message) {
  const key = cleanText(message.apiKey, 512);
  const current = await readSettings();
  const remember =
    typeof message.remember === "boolean"
      ? message.remember
      : current.rememberKey;

  if (!key) {
    await chrome.storage.sync.set({ rememberKey: remember });
    await removeKeyEverywhere();
    return { ok: true, removed: true, message: KEY_REMOVED_MESSAGE };
  }

  const target = keyArea(remember);
  const other = remember ? chrome.storage.session : chrome.storage.local;

  // Write the new copy first, then persist the mode and destroy the copy in the
  // old location. If the extension is interrupted in between, the active
  // location still works and a later Remove cleans both.
  await target.set({ apiKey: key });
  await chrome.storage.sync.set({ rememberKey: remember });
  await securelyRemoveKeyFromArea(other);

  return {
    ok: true,
    saved: true,
    key: {
      hasKey: true,
      masked: maskApiKey(key),
      rememberKey: remember
    }
  };
}

async function removeApiKeyRequest() {
  await removeKeyEverywhere();
  return { ok: true, removed: true, message: KEY_REMOVED_MESSAGE };
}

async function setRememberKeyRequest(message) {
  const remember = message.remember === true;
  const current = await readSettings();
  const source = keyArea(current.rememberKey);
  const destination = keyArea(remember);
  let key = "";

  // Persist the choice only after moving the key (when one exists). This keeps
  // a request racing with the toggle able to find the key in one of the areas.
  if (source !== destination) {
    key = await readApiKey(current.rememberKey);
    if (key) {
      await destination.set({ apiKey: key });
    }
  }

  await chrome.storage.sync.set({ rememberKey: remember });

  if (source !== destination) {
    await securelyRemoveKeyFromArea(source);
  }

  const settings = await readSettings();
  return { ok: true, key: await keyStatus(settings) };
}

async function openOptionsRequest() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    return { ok: false, code: "options_error", message: "Could not open settings." };
  }
  return { ok: true };
}

async function allowGenreRequest(message) {
  const requested = cleanText(message.genre, 80);
  if (!requested) {
    return { ok: false, code: "bad_genre", message: "No genre supplied." };
  }

  const settings = await readSettings();
  const index = settings.genres.findIndex(
    (genre) => genre.name.toLowerCase() === requested.toLowerCase()
  );
  if (index === -1) {
    return { ok: false, code: "unknown_genre", message: "Unknown genre." };
  }

  settings.genres[index] = {
    ...settings.genres[index],
    approved: true
  };
  await writeSettings(settings);
  return { ok: true, genres: settings.genres };
}

async function cancelClassificationRequest(message) {
  const requestId = cleanText(message.requestId, 100);
  const active = activeRequests.get(requestId);
  if (active) {
    active.controller.abort();
    activeRequests.delete(requestId);
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Classification                                                            */
/* -------------------------------------------------------------------------- */

function sanitizeVideoId(value) {
  const id = cleanText(value, 64);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : "";
}

function sanitizeMetadata(input) {
  const metadata = input && typeof input === "object" ? input : {};
  const duration = Number(metadata.durationSeconds);
  return {
    videoId: sanitizeVideoId(metadata.videoId),
    title: cleanText(metadata.title, 300),
    description: cleanText(metadata.description, 1500),
    channel: cleanText(metadata.channel, 200),
    channelId: cleanText(metadata.channelId, 200),
    channelHandle: cleanText(metadata.channelHandle, 200),
    category: cleanText(metadata.category, 100),
    keywords: Array.isArray(metadata.keywords)
      ? metadata.keywords
          .map((keyword) => cleanText(keyword, 80))
          .filter(Boolean)
          .slice(0, 20)
      : [],
    durationSeconds:
      Number.isFinite(duration) && duration >= 0 ? duration : null,
    durationSource:
      metadata.durationSource === "player"
        ? "player"
        : metadata.durationSource === "video"
          ? "video"
          : null,
    isShort: metadata.isShort === true,
    isLive: metadata.isLive === true
  };
}

function findChannelEntry(entries, metadata) {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const candidates = new Set();
  for (const value of [
    metadata.channel,
    metadata.channelId,
    metadata.channelHandle
  ]) {
    const clean = cleanText(value, 200).toLowerCase();
    if (!clean) continue;
    candidates.add(clean);
    if (clean.startsWith("@")) candidates.add(clean.slice(1));
  }
  if (candidates.size === 0) return null;

  return (
    entries.find((entry) => {
      const clean = cleanText(entry?.channel, 200).toLowerCase();
      if (!clean) return false;
      if (candidates.has(clean)) return true;
      if (clean.startsWith("@") && candidates.has(clean.slice(1))) return true;
      return false;
    }) || null
  );
}

function isShorterThanMinimum(settings, metadata) {
  const minimumSeconds = Number(settings.minLengthMinutes) * 60;
  if (!Number.isFinite(minimumSeconds) || minimumSeconds <= 0) return false;
  // Shorts are ignored by the minimum-length rule entirely.
  if (metadata.isShort) return false;
  if (metadata.isLive) return false;
  if (metadata.durationSeconds === null) return false;
  // Only the verified player response is trusted for auto-skip. Video-element
  // durations can belong to an ad, an old player, or a transition, and caused
  // false "under minimum" passes.
  if (metadata.durationSource !== "player") return false;
  return metadata.durationSeconds < minimumSeconds;
}

function canonicalGenre(rawGenre, genres) {
  const wanted = cleanText(rawGenre, 100).toLowerCase();
  if (!wanted) return "Other";
  const match = genres.find(
    (genre) => genre.name.toLowerCase() === wanted
  );
  return match ? match.name : "Other";
}

function genreIsApproved(genre, genres) {
  const match = genres.find(
    (item) => item.name.toLowerCase() === String(genre).toLowerCase()
  );
  return Boolean(match && match.approved === true);
}

async function classifyVideoRequest(message) {
  const metadata = sanitizeMetadata(message.metadata);
  if (!metadata.videoId) {
    return {
      ok: false,
      code: "bad_video",
      message: "The video ID was missing or invalid."
    };
  }

  // Always read fresh settings and the key location: options/key changes apply
  // to the very next video and nothing is cached in worker memory.
  const settings = await readSettings();
  const apiKey = await readApiKey(settings.rememberKey);
  if (!settings.enabled) {
    return { ok: true, status: "disabled" };
  }

  // Channel decisions and the minimum-length rule run before cache and before
  // any network call. The blacklist wins if legacy data has a channel on both
  // lists.
  const blacklistEntry = findChannelEntry(settings.channelBlacklist, metadata);
  if (blacklistEntry) {
    return {
      ok: true,
      status: "blacklisted",
      channel: blacklistEntry.channel,
      reason: blacklistEntry.reason
    };
  }
  const whitelistEntry = findChannelEntry(settings.channelWhitelist, metadata);
  if (whitelistEntry) {
    return {
      ok: true,
      status: "whitelisted",
      channel: whitelistEntry.channel,
      reason: whitelistEntry.reason
    };
  }
  if (isShorterThanMinimum(settings, metadata)) {
    return { ok: true, status: "too_short" };
  }

  const cache = await readCache();
  if (
    Object.prototype.hasOwnProperty.call(cache, metadata.videoId) &&
    validCacheEntry(cache[metadata.videoId])
  ) {
    const genre = canonicalGenre(cache[metadata.videoId].genre, settings.genres);
    return {
      ok: true,
      status: "cached",
      genre,
      approved: genreIsApproved(genre, settings.genres),
      timestamp: cache[metadata.videoId].timestamp
    };
  }

  if (!apiKey) {
    return { ok: true, status: "no_key" };
  }

  const requestId = cleanText(message.requestId, 100) || crypto.randomUUID();
  const result = await callOpenRouter(
    apiKey,
    settings,
    metadata,
    requestId
  );

  if (result.status === "auth_error") {
    return {
      ok: true,
      status: "auth_error",
      httpStatus: result.httpStatus
    };
  }

  if (result.status === "cancelled") {
    return { ok: true, status: "cancelled" };
  }

  if (result.status !== "ok") {
    return {
      ok: true,
      status: "error",
      code: result.code,
      message: result.message,
      settingsHint: result.settingsHint === true,
      httpStatus: result.httpStatus,
      model: result.model || settings.model
    };
  }

  const genre = canonicalGenre(result.genre, settings.genres);
  await storeClassification(metadata.videoId, genre);

  return {
    ok: true,
    status: "classified",
    genre,
    approved: genreIsApproved(genre, settings.genres)
  };
}

function buildSystemPrompt(genres) {
  const byName = new Map(
    genres.map((genre) => [genre.name.toLowerCase(), genre.name])
  );
  const guidance = [];

  if (byName.has("gaming")) {
    guidance.push(
      `- "${byName.get("gaming")}": the primary subject is video-game content. ` +
        "This includes gameplay, playthroughs, game-specific reviews or " +
        "previews, esports, game news and patches, game lore, speedruns, " +
        "game-specific development/modding, and tutorials about a particular " +
        "game. General software, app, hardware, or PC-building tutorials are " +
        "not Gaming unless the game itself is the subject."
    );
  }
  if (byName.has("tech/informational")) {
    guidance.push(
      `- "${byName.get("tech/informational")}": technology, software, apps, ` +
        "consumer electronics, computers, gaming hardware, PC building, " +
        "science, engineering, or technology news."
    );
  }
  if (byName.has("educational/tutorial")) {
    guidance.push(
      `- "${byName.get("educational/tutorial")}": instructional or how-to ` +
        "content whose primary subject is not a specific video game."
    );
  }

  return [
    "You are a video genre classifier. Choose exactly one genre from the allowed list.",
    "Use the evidence in this order:",
    "1. Title and description: what the video is actually about.",
    "2. Uploader-selected YouTube category and keywords: supporting hints, not proof.",
    "3. Channel identity: context only; never choose a genre from the channel alone.",
    "Choose the most specific genre that matches the primary subject.",
    "Do not favor an approved genre, and do not avoid a genre because it may cause a block.",
    'If the evidence is genuinely unclear or no allowed genre fits, choose "Other"',
    "rather than guessing.",
    ...(guidance.length > 0 ? ["", "Genre guidance:", ...guidance] : []),
    "",
    "Allowed genres:",
    ...genres.map((genre) => `- ${genre.name}`),
    "",
    "Respond with JSON only, in exactly this shape:",
    '{"genre":"<one of the allowed genres>"}',
    "No markdown, no explanation, no extra keys."
  ].join("\n");
}

function buildUserPrompt(metadata) {
  return [
    `Title: ${metadata.title || "(unknown)"}`,
    `Channel: ${metadata.channel || "(unknown)"}`,
    `Uploader-selected YouTube category: ${
      metadata.category || "(unknown)"
    }`,
    `Uploader-provided keywords: ${
      metadata.keywords.length > 0
        ? metadata.keywords.join(", ")
        : "(none)"
    }`,
    "Description:",
    metadata.description || "(no description available)"
  ].join("\n");
}

function stringifyContentPart(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  // Some providers wrap the text one level deeper, e.g.
  // { type: "text", text: { value: "..." } }.
  if (part.text && typeof part.text.value === "string") {
    return part.text.value;
  }
  return "";
}

function extractResponseText(payload) {
  const message = payload?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(stringifyContentPart).join("");
  }
  // Some reasoning models return nothing in content and only text in
  // `reasoning`. Reading it as a fallback is better than failing outright.
  if (typeof message?.reasoning === "string") return message.reasoning;
  return "";
}

/**
 * Walks every text snapshot a reply can hide in. We prefer content, then the
 * reasoning output, then the provider's raw text and delta fields (seen on
 * some non-streaming responses).
 */
function responseTextCandidates(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const candidates = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim()) candidates.push(value);
  };

  if (Array.isArray(message?.content)) {
    add(message.content.map(stringifyContentPart).join(""));
  } else {
    add(message?.content);
  }
  add(message?.reasoning);
  add(message?.refusal);
  add(choice?.delta?.content);
  add(choice?.text);
  add(payload?.output_text);
  return candidates;
}

function findGenreInText(text, allowedGenres, exactOnly) {
  // Models occasionally wrap JSON in markdown despite response_format.
  const cleaned = String(text || "")
    .replace(/```(?:json)?/gi, " ")
    .replace(/```/g, " ")
    .trim();
  if (!cleaned) return null;

  const byName = new Map(
    allowedGenres.map((genre) => [genre.name.toLowerCase(), genre.name])
  );

  const fromObject = (value) => {
    if (!value || typeof value !== "object") return null;
    for (const key of ["genre", "genre_name", "category", "label", "type"]) {
      if (typeof value[key] === "string") return value[key];
    }
    return null;
  };

  // 1. Any complete JSON object in the text.
  const objects = cleaned.match(/\{[^{}]*\}/g) || [];
  for (const objectText of objects) {
    try {
      const label = fromObject(JSON.parse(objectText));
      if (label) return label;
    } catch {
      // Try the next object.
    }
  }

  // 2. A quoted genre key without a parseable object.
  const keyed = cleaned.match(
    /"?(?:genre|genre_name|category|label)"?\s*[:=]\s*["']([^"'\n]{1,80})["']/i
  );
  if (keyed) return keyed[1];

  // 3. A bare genre name. Match longest first so "Comedy/Entertainment"
  // wins over any shorter genre contained inside it.
  const bare = [...byName.keys()].sort(
    (a, b) => b.length - a.length
  );
  for (const genre of bare) {
    if (containsGenre(cleaned, genre)) return byName.get(genre);
  }

  // 4. Model-level fallback: a non-JSON reply that is only "Other", or that
  // refuses/answers with a short label we don't recognise.
  if (exactOnly === false) {
    if (/\bother\b/i.test(cleaned)) return "Other";
  }

  return null;
}

function containsGenre(text, genre) {
  if (/[^a-z0-9]/i.test(genre)) {
    // Multi-word or punctuated genres need an exact case-insensitive match.
    return text.toLowerCase().includes(genre.toLowerCase());
  }
  // Single words need a word boundary so "Gaming" does not match "Gamedex".
  return new RegExp(`(^|[^a-z0-9])${genre}([^a-z0-9]|$)`, "i").test(text);
}

function parseGenreResponse(text, allowedGenres) {
  const direct = findGenreInText(text, allowedGenres, false);
  return direct ? canonicalGenre(direct, allowedGenres) : null;
}

function genreFromPayload(payload, allowedGenres) {
  const candidates = responseTextCandidates(payload);
  for (const text of candidates) {
    const genre = parseGenreResponse(text, allowedGenres);
    if (genre) return genre;
  }

  // The reply may be a JSON object directly as content.
  try {
    const rawContent = payload?.choices?.[0]?.message?.content;
    if (typeof rawContent === "string") {
      const parsed = JSON.parse(rawContent.trim());
      if (parsed && typeof parsed === "object") {
        for (const key of ["genre", "genre_name", "category"]) {
          if (typeof parsed[key] === "string") {
            return canonicalGenre(parsed[key], allowedGenres);
          }
        }
      }
    }
  } catch {
    // Not direct JSON.
  }

  return null;
}

function describeUnexpectedText(payload, apiKey) {
  const raw = responseTextCandidates(payload)[0] || "";
  const safe = redactSecret(raw, apiKey);
  if (!safe) return "The model returned an empty reply.";
  const excerpt = safe.length > 100 ? `${safe.slice(0, 100)}…` : safe;
  return `The model replied: "${excerpt}"`;
}

function redactSecret(text, secret) {
  let safe = cleanText(text, 500);
  if (!safe) return "";
  if (secret) {
    safe = safe.split(secret).join("[redacted]");
    safe = safe.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  }
  return safe;
}

function extractOpenRouterError(payload, apiKey) {
  const error = payload?.error ?? payload?.choices?.[0]?.error;
  if (!error) return null;

  const message = redactSecret(
    typeof error === "string" ? error : error.message,
    apiKey
  );
  const type = cleanText(
    error?.metadata?.error_type || error?.error_type || error?.type,
    100
  );
  const numericCode = Number(error?.code);
  return {
    message,
    type,
    code: Number.isFinite(numericCode) ? numericCode : null
  };
}

async function readOpenRouterBody(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function retryAfterText(response) {
  const raw = response.headers.get("Retry-After");
  if (!raw) return "";
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return `${Math.ceil(seconds)}s`;
  }
  return cleanText(raw, 60);
}

function openRouterStatusMessage(status, details, retryAfter, model) {
  const provider = details?.message
    ? ` OpenRouter said: "${details.message}"`
    : "";

  if (status === 401 || status === 403) {
    return {
      message: `API key invalid or missing (HTTP ${status}).${provider}`,
      settingsHint: true
    };
  }

  if (status === 402) {
    return {
      message:
        "OpenRouter credits are exhausted (HTTP 402). Add credits at " +
        "openrouter.ai/credits or switch to the free router " +
        `"openrouter/free" in Settings, then retry.${provider}`,
      settingsHint: true
    };
  }

  if (status === 404) {
    return {
      message:
        `OpenRouter could not find the model "${model}" (HTTP 404). ` +
        `Check the model ID in Settings.${provider}`,
      settingsHint: true
    };
  }

  if (status === 400 || status === 422) {
    return {
      message:
        `OpenRouter rejected the request (HTTP ${status}). Check the model ` +
        `ID and that the model supports JSON output.${provider}`,
      settingsHint: true
    };
  }

  if (status === 429) {
    const wait = retryAfter ? ` Wait ${retryAfter} and retry.` : "";
    return {
      message: `OpenRouter is rate limiting requests (HTTP 429).${wait}${provider}`,
      settingsHint: false
    };
  }

  if (status === 408 || status === 504) {
    return {
      message:
        `OpenRouter timed out while generating a response (HTTP ${status}). ` +
        `Retry, or choose a faster model.${provider}`,
      settingsHint: true
    };
  }

  if (status === 502 || status === 503) {
    return {
      message:
        `OpenRouter's model provider is temporarily unavailable (HTTP ${status}). ` +
        `Retry shortly or choose another model.${provider}`,
      settingsHint: true
    };
  }

  return {
    message: `OpenRouter returned HTTP ${status}.${provider}`,
    settingsHint: false
  };
}

async function callOpenRouter(apiKey, settings, metadata, requestId) {
  const existing = activeRequests.get(requestId);
  if (existing) existing.controller.abort();

  const controller = new AbortController();
  activeRequests.set(requestId, {
    controller,
    videoId: metadata.videoId
  });
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Genre Gate"
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(settings.genres)
          },
          {
            role: "user",
            content: buildUserPrompt(metadata)
          }
        ],
        temperature: 0,
        // Free routers can select a reasoning model. Reasoning tokens count
        // against max_tokens, so leave enough room for thinking plus the tiny
        // JSON answer.
        max_tokens: 512,
        response_format: { type: "json_object" },
        // Genre classification needs no chain-of-thought. Unbounded reasoning
        // was adding 7+ seconds and sometimes consumed the whole token budget.
        reasoning: { enabled: false }
      })
    });

    if (response.status === 401 || response.status === 403) {
      return {
        status: "auth_error",
        httpStatus: response.status
      };
    }

    const payload = await readOpenRouterBody(response);
    const details = extractOpenRouterError(payload, apiKey);
    const retryAfter = retryAfterText(response);

    if (!response.ok) {
      const info = openRouterStatusMessage(
        response.status,
        details,
        retryAfter,
        settings.model
      );
      return {
        status: "error",
        code: details?.type || `http_${response.status}`,
        message: info.message,
        settingsHint: info.settingsHint,
        httpStatus: response.status
      };
    }

    if (!payload) {
      return {
        status: "error",
        code: "malformed",
        message:
          "OpenRouter returned an unreadable response. Retry, or choose a different model.",
        settingsHint: true,
        httpStatus: response.status
      };
    }

    if (details) {
      // OpenRouter can return a provider error with HTTP 200. Previously this
      // looked like "unexpected response" because the body was discarded.
      const errorStatus = details.code || 502;
      const info = openRouterStatusMessage(
        errorStatus,
        details,
        retryAfter,
        settings.model
      );
      return {
        status: "error",
        code: details.type || `provider_${errorStatus}`,
        message: info.message,
        settingsHint: info.settingsHint,
        httpStatus: response.status
      };
    }

    const choice = payload?.choices?.[0];
    if (!choice) {
      return {
        status: "error",
        code: "no_choice",
        message:
          "OpenRouter returned no completion. Retry, or choose a different model.",
        settingsHint: true,
        httpStatus: response.status
      };
    }

    const genre = genreFromPayload(payload, settings.genres);
    if (!genre) {
      const tokenLimit = choice.finish_reason === "length";
      const message = choice?.message;
      const reasoningTokens =
        payload?.usage?.completion_tokens_details?.reasoning_tokens;
      const reasoningHeavy =
        tokenLimit && Number(reasoningTokens) > 0 && !String(message?.content || "").trim();

      const replyText = responseTextCandidates(payload)[0] || "";
      const unsuitableModel =
        /content-safety/i.test(settings.model) ||
        /^\s*user safety\s*:/i.test(replyText);
      const recommended = `Use "openrouter/free" in Settings for a free, JSON-capable auto-router.`;
      return {
        status: "error",
        code: tokenLimit ? "token_limit" : "unrecognized_reply",
        model: settings.model,
        message: reasoningHeavy
          ? `"${settings.model}" used its entire token budget on reasoning and returned no genre. ` +
            `Choose a non-reasoning model, or use "openrouter/free".`
          : unsuitableModel
            ? `"${settings.model}" is a content-safety classifier, not a genre classifier. ${recommended}`
            : `Could not find a genre in the model's reply. ${describeUnexpectedText(payload, apiKey)} ` +
              `The chosen model may return prose instead of JSON. ${recommended}`,
        settingsHint: true,
        httpStatus: response.status,
        debug: {
          model: settings.model,
          finishReason: choice?.finish_reason ?? null,
          reasoningTokens: Number.isFinite(Number(reasoningTokens))
            ? Number(reasoningTokens)
            : null,
          contentChars: String(message?.content || "").length,
          reasoningChars: String(message?.reasoning || "").length,
          excerpt: redactSecret(responseTextCandidates(payload)[0] || "", apiKey).slice(0, 120)
        }
      };
    }

    return { status: "ok", genre };
  } catch (error) {
    if (timedOut) {
      return {
        status: "error",
        code: "timeout",
        message: "OpenRouter did not respond in time. Try again."
      };
    }
    if (
      controller.signal.aborted ||
      (error && typeof error === "object" && error.name === "AbortError")
    ) {
      return { status: "cancelled" };
    }
    return {
      status: "error",
      code: "network",
      message: "Could not reach OpenRouter. Check your connection and try again."
    };
  } finally {
    clearTimeout(timeoutId);
    // Do not delete a newer request that reused the same id.
    if (activeRequests.get(requestId)?.controller === controller) {
      activeRequests.delete(requestId);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Key testing                                                               */
/* -------------------------------------------------------------------------- */

async function testApiKeyRequest() {
  const settings = await readSettings();
  const apiKey = await readApiKey(settings.rememberKey);
  if (!apiKey) {
    return {
      ok: false,
      code: "no_key",
      message: "No API key is saved."
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_TIMEOUT_MS);

  try {
    const response = await fetch(OPENROUTER_KEY_URL, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Title": "Genre Gate"
      }
    });

    const payload = await readOpenRouterBody(response);
    const details = extractOpenRouterError(payload, apiKey);
    const retryAfter = retryAfterText(response);

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: "auth_error",
        message: openRouterStatusMessage(
          response.status,
          details,
          retryAfter,
          settings.model
        ).message
      };
    }

    if (!response.ok) {
      const info = openRouterStatusMessage(
        response.status,
        details,
        retryAfter,
        settings.model
      );
      return {
        ok: false,
        code: details?.type || `http_${response.status}`,
        message: info.message
      };
    }

    if (details) {
      const info = openRouterStatusMessage(
        details.code || 502,
        details,
        retryAfter,
        settings.model
      );
      return {
        ok: false,
        code: details.type || "provider_error",
        message: info.message
      };
    }

    const data = payload?.data;
    const creditValue = (value) => {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (
        typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      ) {
        return Number(value);
      }
      return null;
    };
    const keyRemaining = creditValue(data?.limit_remaining);
    const budgetRemaining = creditValue(data?.effective_budget?.remaining_usd);
    const remaining = keyRemaining ?? budgetRemaining;

    if (remaining !== null && remaining <= 0) {
      return {
        ok: false,
        code: "no_credits",
        message:
          "The key is valid, but OpenRouter has no credits remaining for this " +
          "request. Add credits at openrouter.ai/credits or use the free router " +
          '"openrouter/free" in Settings.' 
      };
    }

    let suffix = "";
    if (remaining !== null) {
      suffix = ` · $${Math.max(0, remaining).toFixed(2)} credit remaining`;
    } else if (data?.is_free_tier === true) {
      suffix = " · free tier";
    }
    return { ok: true, message: `Valid${suffix}` };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        code: "timeout",
        message: "OpenRouter did not respond in time."
      };
    }
    if (
      controller.signal.aborted ||
      (error && typeof error === "object" && error.name === "AbortError")
    ) {
      return {
        ok: false,
        code: "aborted",
        message: "Key test was cancelled."
      };
    }
    return {
      ok: false,
      code: "network",
      message: "Network error while contacting OpenRouter."
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
