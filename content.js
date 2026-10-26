/**
 * Genre Gate content script.
 *
 * Runs on youtube.com only. It never reads local/session storage and never
 * sees the OpenRouter key: settings, cache lookups, and API calls all live in
 * the service worker. This script owns the player pause/overlay lifecycle.
 */
(() => {
  "use strict";

  const OVERLAY_ID = "genre-gate-overlay-host";
  const TOAST_ID = "genre-gate-toast-host";
  const DESCRIPTION_LIMIT = 1500;
  const PLAYER_CONTAINER_ID = "movie_player";

  const state = {
    currentVideoId: null,
    route: null,
    sessionToken: 0,
    metadata: null,
    videoEl: null,
    overlay: null,
    overlayOpen: false,
    pendingRequestId: null,
    approvedTimer: null,
    watchAnywayTimer: null,
    watchAnywayInterval: null,
    guardHandler: null,
    guardInterval: null,
    escapeHandler: null,
    messagingError: ""
  };

  let lastNavKey = null;
  let bridgeInjected = false;
  let fullscreenHandlerAdded = false;
  let toastTimer = null;

  const OVERLAY_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: block;
      font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    [hidden] {
      display: none !important;
    }

    .backdrop {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(0, 0, 0, 0.6);
      opacity: 0;
      transition: opacity 160ms ease;
    }

    :host(.gg-visible) .backdrop {
      opacity: 1;
    }

    .card {
      width: min(520px, 100%);
      max-height: 82vh;
      overflow: auto;
      padding: 24px;
      font-family: "Avenir Next", Avenir, "Segoe UI", sans-serif;
      border: 1px solid #303030;
      border-radius: 10px;
      background: #212121;
      color: #f1f1f1;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      outline: none;
    }

    .status-icon {
      display: flex;
      align-items: center;
      min-height: 18px;
      margin-bottom: 10px;
      color: #aaaaaa;
      font-size: 18px;
      font-weight: 600;
      line-height: 1;
    }

    .status-icon.approved {
      color: #2ba640;
    }

    .status-icon.blocked,
    .status-icon.error {
      color: #ff4e45;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid #3f3f3f;
      border-top-color: #f1f1f1;
      border-radius: 50%;
      animation: gg-spin 800ms linear infinite;
    }

    @keyframes gg-spin {
      to {
        transform: rotate(360deg);
      }
    }

    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 500;
      line-height: 1.3;
    }

    .title-mark {
      color: #ff4e45;
      font-weight: 700;
    }

    .card.is-blocked {
      width: min(580px, 100%);
    }

    .card.is-blocked h1 {
      font-size: clamp(28px, 5vw, 34px);
      font-weight: 600;
      line-height: 1.22;
      letter-spacing: -0.02em;
    }

    .card.is-blocked .message {
      font-size: 17px;
      line-height: 1.6;
    }

    .card.is-blocked .message strong {
      font-size: 18px;
    }

    .card.is-blocked button {
      font-size: 14px;
    }

    .message {
      margin: 10px 0 0;
      color: #aaaaaa;
      font-size: 14px;
      line-height: 1.55;
    }

    .message strong {
      color: #ffffff;
      font-weight: 650;
    }

    .message .detail {
      display: block;
      margin-top: 6px;
      color: #aaaaaa;
      font-size: 13px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 20px;
    }

    button {
      appearance: none;
      min-height: 36px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 5px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    button:focus-visible {
      outline: 2px solid #3ea6ff;
      outline-offset: 2px;
    }

    button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .btn-primary {
      background: #cc0000;
      color: #ffffff;
    }

    .btn-primary:hover {
      background: #e60000;
    }

    .btn-secondary {
      border-color: #3f3f3f;
      background: transparent;
      color: #f1f1f1;
    }

    .btn-secondary:hover {
      border-color: #5a5a5a;
      background: #303030;
    }

    .hint {
      margin-top: 16px;
      color: #aaaaaa;
      font-size: 12px;
      line-height: 1.5;
    }

    .hint code {
      color: #f1f1f1;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    @media (max-width: 520px) {
      .card {
        padding: 20px;
      }

      .card.is-blocked h1 {
        font-size: 27px;
      }

      .card.is-blocked .message {
        font-size: 16px;
      }

      .actions {
        flex-direction: column;
      }

      .actions button {
        width: 100%;
      }
    }

    @media (prefers-color-scheme: light) {
      .backdrop {
        background: rgba(0, 0, 0, 0.5);
      }

      .card {
        border-color: #e5e5e5;
        background: #ffffff;
        color: #0f0f0f;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
      }

      .status-icon {
        color: #606060;
      }

      .status-icon.approved {
        color: #2ba640;
      }

      .status-icon.blocked,
      .status-icon.error {
        color: #cc0000;
      }

      .spinner {
        border-color: #e5e5e5;
        border-top-color: #606060;
      }

      .title-mark {
        color: #cc0000;
      }

      .message {
        color: #606060;
      }

      .message strong {
        color: #0f0f0f;
      }

      .message .detail {
        color: #606060;
      }

      .btn-primary {
        background: #cc0000;
        color: #ffffff;
      }

      .btn-primary:hover {
        background: #e60000;
      }

      .btn-secondary {
        border-color: #d0d0d0;
        color: #0f0f0f;
      }

      .btn-secondary:hover {
        border-color: #aaaaaa;
        background: #f2f2f2;
      }

      .hint {
        color: #606060;
      }

      .hint code {
        color: #0f0f0f;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .backdrop {
        transition: none;
      }

      .spinner {
        animation-duration: 1.6s;
      }
    }
  `;

  const TOAST_CSS = `
    :host {
      all: initial;
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: center;
      gap: 9px;
      max-width: min(390px, calc(100vw - 32px));
      padding: 11px 14px;
      border: 1px solid #303030;
      border-radius: 8px;
      background: #212121;
      color: #f1f1f1;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      font-family: Roboto, Arial, "Segoe UI", sans-serif;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 160ms ease, transform 160ms ease;
    }

    :host(.gg-visible) .toast {
      opacity: 1;
      transform: translateY(0);
    }

    .dot {
      width: 8px;
      height: 8px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: #ff0000;
      box-shadow: 0 0 0 3px rgba(255, 0, 0, 0.14);
    }

    .toast.allowed .dot {
      background: #3ea6ff;
      box-shadow: 0 0 0 3px rgba(62, 166, 255, 0.14);
    }

    .toast.neutral .dot {
      background: #aaaaaa;
    }

    @media (prefers-color-scheme: light) {
      .toast {
        border-color: #e5e5e5;
        background: #ffffff;
        color: #0f0f0f;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .toast {
        transition: none;
      }
    }
  `;

  /* ------------------------------------------------------------------------ */
  /* Messaging helpers                                                        */
  /* ------------------------------------------------------------------------ */

  function sendMessage(message, attempts = 3) {
    return new Promise((resolve) => {
      let attempt = 0;
      let settled = false;

      try {
        if (!chrome.runtime?.id) {
          state.messagingError = "Extension context invalidated.";
          resolve(null);
          return;
        }
      } catch {
        state.messagingError = "Extension context invalidated.";
        resolve(null);
        return;
      }

      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const trySend = () => {
        attempt += 1;
        let handled = false;

        try {
          chrome.runtime.sendMessage(message, (response) => {
            if (handled || settled) return;
            handled = true;
            const error = chrome.runtime.lastError;
            if (!error) {
              state.messagingError = "";
              finish(response || null);
              return;
            }

            state.messagingError = error.message || "Messaging failed.";
            if (
              /Extension context invalidated/i.test(state.messagingError) ||
              attempt >= attempts ||
              (message.action === "CLASSIFY_VIDEO" &&
                state.pendingRequestId !== message.requestId)
            ) {
              finish(null);
              return;
            }
            // A cold or restarting service worker can miss the first message.
            // Retry a couple of times before showing an error.
            setTimeout(trySend, 250 * attempt);
          });
        } catch (error) {
          if (handled || settled) return;
          handled = true;
          state.messagingError = error?.message || String(error);
          if (
            /Extension context invalidated/i.test(state.messagingError) ||
            attempt >= attempts ||
            (message.action === "CLASSIFY_VIDEO" &&
              state.pendingRequestId !== message.requestId)
          ) {
            finish(null);
            return;
          }
          setTimeout(trySend, 250 * attempt);
        }
      };

      trySend();
    });
  }

  function sendQuietly(message) {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      // The service worker can be unavailable during browser shutdown.
    }
  }

  function cancelPendingRequest() {
    const requestId = state.pendingRequestId;
    state.pendingRequestId = null;
    if (requestId) {
      sendQuietly({ action: "CANCEL_CLASSIFICATION", requestId });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Page-context bridge                                                      */
  /* ------------------------------------------------------------------------ */

  function injectPageBridge() {
    if (bridgeInjected) return;
    bridgeInjected = true;
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("interceptor.js");
      script.async = false;
      script.dataset.genreGate = "bridge";
      script.addEventListener("load", () => script.remove(), { once: true });
      script.addEventListener("error", () => script.remove(), { once: true });
      (document.head || document.documentElement).appendChild(script);
    } catch {
      // The DOM fallbacks below still provide title/channel/description.
    }
  }

  function requestVideoDetailsOnce(videoId, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const requestId = makeRequestId();

      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(value);
      }

      function onMessage(event) {
        // Validate the sender window and origin before reading page data.
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;

        const data = event.data;
        if (
          !data ||
          typeof data !== "object" ||
          data.source !== "genre-gate-page" ||
          data.type !== "video-details" ||
          data.requestId !== requestId
        ) {
          return;
        }

        const normalized = normalizePageDetails(data.payload, videoId);
        if (normalized) finish(normalized);
      }

      window.addEventListener("message", onMessage);
      timer = setTimeout(() => finish(null), timeoutMs);

      try {
        window.postMessage(
          {
            source: "genre-gate-content",
            type: "get-video-details",
            requestId,
            videoId
          },
          window.location.origin
        );
      } catch {
        finish(null);
      }
    });
  }

  async function requestVideoDetails(videoId) {
    // First attempt usually succeeds. The second covers the rare case where the
    // injected page script starts listening just after the first postMessage.
    for (const timeoutMs of [500, 900]) {
      const details = await requestVideoDetailsOnce(videoId, timeoutMs);
      if (details) return details;
      if (state.currentVideoId !== videoId) return null;
    }
    return null;
  }

  function normalizePageDetails(payload, expectedVideoId) {
    if (!payload || typeof payload !== "object") return null;

    const videoId = cleanText(payload.videoId, 64);
    if (!videoId || videoId !== expectedVideoId) return null;

    const duration = Number(payload.durationSeconds);
    return {
      videoId,
      title: cleanText(payload.title, 300),
      description: cleanText(payload.description, 5000),
      channel: cleanText(payload.channel, 200),
      channelId: cleanText(payload.channelId, 200),
      channelHandle: cleanText(payload.channelHandle, 200),
      category: cleanText(payload.category, 100),
      keywords: Array.isArray(payload.keywords)
        ? payload.keywords
            .map((keyword) => cleanText(keyword, 80))
            .filter(Boolean)
            .slice(0, 20)
        : [],
      durationSeconds:
        Number.isFinite(duration) && duration > 0 ? duration : null,
      isLive: payload.isLive === true
    };
  }

  function makeRequestId() {
    try {
      return crypto.randomUUID();
    } catch {
      return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  }

  function cleanText(value, maxLength) {
    return typeof value === "string"
      ? value.replace(/\u0000/g, "").trim().slice(0, maxLength)
      : "";
  }

  /* ------------------------------------------------------------------------ */
  /* YouTube navigation detection                                             */
  /* ------------------------------------------------------------------------ */

  function parseRoute() {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      return null;
    }
    if (url.hostname !== "www.youtube.com") return null;

    if (url.pathname === "/watch") {
      const videoId = url.searchParams.get("v") || "";
      if (/^[A-Za-z0-9_-]+$/.test(videoId)) {
        return { videoId, kind: "watch" };
      }
      return null;
    }

    // Shorts URLs are /shorts/<videoId>. Keep this separate from /watch so a
    // navigation from one surface to the other starts a fresh check.
    const shorts = url.pathname.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
    if (shorts) {
      return { videoId: shorts[1], kind: "shorts" };
    }
    return null;
  }

  function checkNavigation() {
    const route = parseRoute();
    if (!route) {
      lastNavKey = null;
      if (state.currentVideoId || state.overlay) {
        abandonSession();
      }
      return;
    }

    const navKey = `${route.kind}:${route.videoId}`;
    if (navKey === lastNavKey) return;
    lastNavKey = navKey;
    void startForVideo(route).catch(() => {});
  }

  function abandonSession() {
    clearToast();
    cancelPendingRequest();
    state.sessionToken += 1;
    state.currentVideoId = null;
    state.route = null;
    state.metadata = null;
    if (state.overlay) {
      closeOverlay({ resume: false, immediate: true });
    }
    state.videoEl = null;
  }

  function beginSession(route) {
    clearToast();
    cancelPendingRequest();
    if (state.overlay) {
      closeOverlay({ resume: false, immediate: true });
    }

    state.sessionToken += 1;
    state.currentVideoId = route.videoId;
    state.route = route;
    state.metadata = null;
    state.videoEl = null;
    return state.sessionToken;
  }

  function isCurrent(token) {
    return (
      state.sessionToken === token &&
      state.currentVideoId !== null &&
      state.overlayOpen
    );
  }

  async function startForVideo(route) {
    if (!route) return;

    const token = beginSession(route);
    openLoadingOverlay();
    startPlaybackGuard();
    pauseCurrentVideo();

    // Start the page bridge and player lookup immediately, in parallel with the
    // settings preflight. The preflight used to serialize ~0.5-1.5 seconds of
    // avoidable latency into every first check.
    const pagePromise = requestVideoDetails(route.videoId);
    const videoPromise = waitForVideo(token, 3200);

    const preflight = await sendMessage({ action: "GET_SETTINGS" });
    if (!isCurrent(token)) return;
    if (/Extension context invalidated/i.test(state.messagingError)) {
      renderError(
        "Genre Gate was updated or reloaded. Reload this YouTube tab to reconnect.",
        { reloadHint: true }
      );
      return;
    }
    if (
      preflight &&
      preflight.ok === true &&
      preflight.settings?.enabled === false
    ) {
      closeOverlay({ resume: true });
      showToast("Genre Gate is disabled — no check was performed.", "neutral");
      return;
    }

    try {
      const page = await pagePromise;
      if (!isCurrent(token)) return;

      // A verified player response already has the title, channel, and
      // duration, so do not wait for the <video> node before asking OpenRouter.
      // The play guard still pauses it as soon as it appears.
      const video = findMainVideo() || (page ? null : await videoPromise);
      if (!isCurrent(token)) return;
      if (video) pauseForGate(video);

      const metadata = await buildMetadata(route, page, video, token);
      if (!isCurrent(token)) return;

      state.metadata = metadata;
      await classifyCurrent(metadata, token);
    } catch {
      if (!state.currentVideoId || state.sessionToken !== token) return;
      if (state.overlayOpen) {
        renderError("Could not read this video's details. Try again.");
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Player pause and playback guard                                          */
  /* ------------------------------------------------------------------------ */

  function findMainVideo() {
    return (
      document.querySelector(
        `#${PLAYER_CONTAINER_ID} video.html5-main-video`
      ) ||
      document.querySelector("video.html5-main-video") ||
      document.querySelector(`#${PLAYER_CONTAINER_ID} video`) ||
      document.querySelector("video")
    );
  }

  function isAdShowing() {
    const player = document.getElementById(PLAYER_CONTAINER_ID);
    if (!player) return false;
    return Boolean(
      player.classList.contains("ad-showing") ||
        player.querySelector(
          ".ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-module"
        )
    );
  }

  function enforcePaused(video) {
    if (!video) return;
    try {
      video.pause();
    } catch {
      // The video element may be mid-teardown during navigation.
    }
  }

  function pauseForGate(video) {
    if (!video) return;
    state.videoEl = video;
    enforcePaused(video);
  }

  function pauseCurrentVideo() {
    const video = findMainVideo();
    if (video) pauseForGate(video);
  }

  function startPlaybackGuard() {
    if (!state.guardHandler) {
      state.guardHandler = (event) => {
        if (!state.overlayOpen) return;
        const video = event.target;
        if (!video || video.tagName !== "VIDEO") return;
        enforcePaused(video);
      };
      // YouTube autoplay can call play() again after our pause. Capture both
      // events and keep re-pausing while the gate is open.
      document.addEventListener("play", state.guardHandler, true);
      document.addEventListener("playing", state.guardHandler, true);
    }

    if (!state.guardInterval) {
      // Also handles players that swap elements or start without emitting an
      // event visible to us.
      state.guardInterval = setInterval(() => {
        if (!state.overlayOpen) return;
        const video = findMainVideo();
        if (video && !video.paused) {
          enforcePaused(video);
        }
      }, 400);
    }
  }

  function stopPlaybackGuard() {
    if (state.guardHandler) {
      document.removeEventListener("play", state.guardHandler, true);
      document.removeEventListener("playing", state.guardHandler, true);
      state.guardHandler = null;
    }
    if (state.guardInterval) {
      clearInterval(state.guardInterval);
      state.guardInterval = null;
    }
  }

  function resumePlaybackIfRequested(resume) {
    if (!resume) return;
    const video =
      state.videoEl && state.videoEl.isConnected
        ? state.videoEl
        : findMainVideo();
    if (!video) return;

    try {
      void video.play().catch(() => {});
    } catch {
      // Autoplay policy may reject; the user can start playback manually.
    }
  }

  async function waitForVideo(token, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isCurrent(token)) return null;
      const video = findMainVideo();
      if (video) return video;
      await delay(80);
    }
    return null;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ------------------------------------------------------------------------ */
  /* Metadata gathering                                                       */
  /* ------------------------------------------------------------------------ */

  async function buildMetadata(route, page, video, token) {
    const dom = readDomMetadata();
    const resolvedVideo = video || findMainVideo();
    const duration = await resolveDuration(page, resolvedVideo, token);

    const title =
      cleanText(page?.title, 300) || dom.title || "Untitled video";
    const channel =
      cleanText(page?.channel, 200) || dom.channel || "Unknown channel";
    const description = cleanText(
      page?.description ||
        dom.metaDescription ||
        dom.description ||
        "",
      DESCRIPTION_LIMIT
    );

    return {
      videoId: route.videoId,
      title,
      description,
      channel,
      channelId:
        cleanText(page?.channelId, 200) || dom.channelId || "",
      channelHandle:
        cleanText(page?.channelHandle, 200) || dom.channelHandle || "",
      category: cleanText(page?.category, 100) || dom.category || "",
      keywords:
        Array.isArray(page?.keywords) && page.keywords.length > 0
          ? page.keywords.slice(0, 20)
          : dom.keywords.slice(0, 20),
      durationSeconds: duration.durationSeconds,
      durationSource: duration.source || null,
      isShort: route.kind === "shorts",
      isLive: duration.isLive
    };
  }

  async function resolveDuration(page, video, token) {
    const pageDuration = Number(page?.durationSeconds);
    if (page?.isLive) {
      return { durationSeconds: null, isLive: true, source: "player" };
    }
    if (Number.isFinite(pageDuration) && pageDuration > 0) {
      return {
        durationSeconds: pageDuration,
        isLive: false,
        source: "player"
      };
    }

    let element = video || findMainVideo();
    if (!element) {
      return { durationSeconds: null, isLive: false, source: null };
    }

    // Never read the DOM video duration while an ad is playing: that duration
    // belongs to the ad, not to the main video.
    if (isAdShowing()) {
      return { durationSeconds: null, isLive: false, source: null };
    }

    let duration = Number(element.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      await waitForLoadedMetadata(element, 1200);
      if (!isCurrent(token)) {
        return { durationSeconds: null, isLive: false, source: null };
      }
      element = element.isConnected ? element : findMainVideo();
      if (!element) {
        return { durationSeconds: null, isLive: false, source: null };
      }
      duration = Number(element.duration);
    }

    if (isAdShowing()) {
      return { durationSeconds: null, isLive: false, source: null };
    }
    if (duration === Infinity) {
      return { durationSeconds: null, isLive: true, source: "video" };
    }
    if (Number.isFinite(duration) && duration > 0) {
      // Kept for display/fallback metadata only. The background will not use
      // an unverified video-element duration for auto-skip decisions.
      return { durationSeconds: duration, isLive: false, source: "video" };
    }
    return { durationSeconds: null, isLive: false, source: null };
  }

  function waitForLoadedMetadata(video, timeoutMs) {
    if (video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;

      function cleanup() {
        if (timer) clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onLoaded);
      }

      function onLoaded() {
        cleanup();
        resolve();
      }

      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onLoaded);
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
    });
  }

  function readDomMetadata() {
    const metaDescription =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      "";
    const category =
      document.querySelector('meta[itemprop="genre"]')?.content || "";
    const keywords = (document.querySelector('meta[name="keywords"]')?.content || "")
      .split(",")
      .map((keyword) => cleanText(keyword, 80))
      .filter(Boolean)
      .slice(0, 20);

    const descriptionSelectors = [
      "#description-inline-expander",
      "ytd-text-inline-expander#description-inline-expander",
      "#description.ytd-watch-metadata",
      "ytd-expander#description",
      "#description-text",
      "ytd-reel-player-overlay-renderer #description"
    ];
    let description = "";
    for (const selector of descriptionSelectors) {
      const value = cleanText(
        document.querySelector(selector)?.textContent,
        5000
      );
      if (value) {
        description = value;
        break;
      }
    }

    // Selectors here cover the watch page, old layouts, and Shorts. They are
    // deliberately ordered from most specific to most generic.
    const channelSelectors = [
      "#owner #channel-name a",
      "ytd-video-owner-renderer #channel-name a",
      "#channel-name a",
      "ytd-reel-player-header-renderer #channel-name a",
      "ytd-reel-player-header-renderer a[href^='/@']",
      "#owner a[href^='/@']"
    ];
    let channel = "";
    let channelId = "";
    let channelHandle = "";
    for (const selector of channelSelectors) {
      const anchor = document.querySelector(selector);
      if (!anchor) continue;
      channel = cleanText(anchor.textContent, 200);
      const href = anchor.getAttribute("href") || "";
      try {
        const url = new URL(href, window.location.origin);
        const handleMatch = url.pathname.match(/^\/@([^/]+)/);
        if (handleMatch) {
          channelHandle = `@${decodeURIComponent(handleMatch[1])}`;
        }
        const channelMatch = url.pathname.match(/^\/channel\/([^/]+)/);
        if (channelMatch) {
          channelId = decodeURIComponent(channelMatch[1]);
        }
        if (!channelId) {
          const customMatch = url.pathname.match(/^\/(?:c|user)\/([^/]+)/);
          if (customMatch) {
            channelHandle = `@${decodeURIComponent(customMatch[1])}`;
          }
        }
      } catch {
        // Ignore unusual owner hrefs.
      }
      if (channel) break;
    }

    let title = "";
    const titleSelectors = [
      "ytd-watch-metadata h1",
      "#title h1",
      "h1.title.ytd-video-primary-info-renderer",
      "ytd-reel-player-header-renderer h2"
    ];
    for (const selector of titleSelectors) {
      const value = cleanText(
        document.querySelector(selector)?.textContent,
        300
      );
      if (value) {
        title = value;
        break;
      }
    }
    if (!title) {
      title = cleanText(document.title.replace(/\s*-\s*YouTube\s*$/i, ""), 300);
    }

    return {
      title,
      channel,
      channelId: cleanText(channelId, 200),
      channelHandle: cleanText(channelHandle, 200),
      metaDescription,
      description,
      category: cleanText(category, 100),
      keywords
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Classification                                                           */
  /* ------------------------------------------------------------------------ */

  async function classifyCurrent(metadata, token) {
    if (!metadata || !isCurrent(token)) return;

    cancelPendingRequest();
    const requestId = makeRequestId();
    state.pendingRequestId = requestId;
    renderLoading();

    const response = await sendMessage({
      action: "CLASSIFY_VIDEO",
      requestId,
      metadata
    });

    // Stale responses must never be rendered for the current video. Compare
    // both the session and the specific request, because Retry creates a new
    // request in the same session.
    if (!isCurrent(token) || state.pendingRequestId !== requestId) {
      return;
    }
    state.pendingRequestId = null;

    if (!response) {
      const contextLost = /Extension context invalidated/i.test(
        state.messagingError
      );
      renderError(
        contextLost
          ? "Genre Gate was updated or reloaded. Reload this YouTube tab to reconnect."
          : "Could not reach the Genre Gate background after retrying. Try again or reload this page.",
        { reloadHint: contextLost }
      );
      return;
    }
    if (response.ok !== true) {
      renderError(response.message || "The genre check failed. Try again.");
      return;
    }

    switch (response.status) {
      case "disabled":
        closeOverlay({ resume: true });
        showToast("Genre Gate is disabled — no check was performed.", "neutral");
        break;
      case "whitelisted":
        closeOverlay({ resume: true });
        showToast(
          response.reason
            ? `Allowed — whitelisted channel (${response.reason}).`
            : "Allowed — channel is on your whitelist.",
          "allowed"
        );
        break;
      case "blacklisted":
        renderBlacklisted(response.channel, response.reason);
        break;
      case "too_short":
        closeOverlay({ resume: true });
        showToast("Allowed — video is under your minimum length.", "allowed");
        break;
      case "cancelled":
        break;
      case "no_key":
        renderKeyError("no_key");
        break;
      case "auth_error":
        renderKeyError("auth_error");
        break;
      case "error":
        renderError(
          response.message || "The genre check failed. Try again.",
          {
            settingsHint: response.settingsHint === true,
            model: response.model || ""
          }
        );
        break;
      case "cached":
      case "classified":
        if (response.approved === true) {
          renderApproved(response.genre);
        } else {
          renderUnapproved(response.genre);
        }
        break;
      default:
        renderError("The genre check returned an unexpected result.");
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Overlay                                                                  */
  /* ------------------------------------------------------------------------ */

  function createOverlay() {
    document.querySelectorAll(`#${OVERLAY_ID}`).forEach((node) => node.remove());

    const host = document.createElement("div");
    host.id = OVERLAY_ID;
    host.style.cssText =
      "all: initial !important; position: fixed !important; inset: 0 !important; " +
      "z-index: 2147483647 !important; display: block !important;";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${OVERLAY_CSS}</style>
      <div class="backdrop">
        <section class="card" role="dialog" aria-modal="true"
          aria-labelledby="gg-dialog-title" aria-describedby="gg-dialog-message"
          tabindex="-1">
          <div class="status-icon loading" aria-hidden="true"></div>
          <h1 id="gg-dialog-title">Checking this video…</h1>
          <p class="message" id="gg-dialog-message" role="status"
            aria-live="polite"></p>
          <div class="actions"></div>
          <div class="hint" hidden></div>
        </section>
      </div>
    `;

    const overlay = {
      host,
      shadow,
      card: shadow.querySelector(".card"),
      icon: shadow.querySelector(".status-icon"),
      title: shadow.querySelector("h1"),
      message: shadow.querySelector(".message"),
      actions: shadow.querySelector(".actions"),
      hint: shadow.querySelector(".hint")
    };

    state.overlay = overlay;
    state.overlayOpen = true;
    mountOverlayHost(host);

    overlay.shadow.addEventListener("keydown", onShadowKeyDown);
    overlay.shadow.addEventListener("keyup", (event) => {
      event.stopPropagation();
    });
    state.escapeHandler = (event) => {
      if (!state.overlayOpen) return;
      if (event.key === "Escape") {
        // Esc must not dismiss an unapproved gate (or any other state).
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("keydown", state.escapeHandler, true);

    requestAnimationFrame(() => {
      if (state.overlay === overlay) host.classList.add("gg-visible");
    });

    return overlay;
  }

  function mountOverlayHost(host) {
    // When YouTube is fullscreen, append inside the fullscreen element so the
    // overlay remains visible; otherwise use a viewport-level fixed host.
    const fullscreenElement = document.fullscreenElement;
    if (
      fullscreenElement &&
      fullscreenElement.id === PLAYER_CONTAINER_ID &&
      !fullscreenElement.contains(host)
    ) {
      fullscreenElement.appendChild(host);
      return;
    }
    document.documentElement.appendChild(host);
  }

  function ensureOverlay() {
    if (state.overlay && state.overlayOpen) return state.overlay;
    return createOverlay();
  }

  function openLoadingOverlay() {
    ensureOverlay();
    renderLoading();
  }

  function renderLoading() {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.remove("is-blocked");
    overlay.card.setAttribute("aria-busy", "true");
    setOverlayIcon("loading");
    overlay.title.textContent = "Checking this video…";
    overlay.message.textContent =
      "The video is paused while its genre is checked.";
    overlay.actions.replaceChildren();
    overlay.hint.hidden = true;
    overlay.hint.replaceChildren();
    focusOverlay(null);
  }

  function renderApproved(genre) {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.remove("is-blocked");
    overlay.card.setAttribute("aria-busy", "false");
    hideOverlayIcon();
    overlay.title.textContent = `✓ Approved: ${genre}`;
    overlay.message.textContent = "Resuming playback…";
    overlay.actions.replaceChildren();
    overlay.hint.hidden = true;
    overlay.hint.replaceChildren();
    focusOverlay(null);

    state.approvedTimer = setTimeout(() => {
      state.approvedTimer = null;
      if (state.overlayOpen) {
        closeOverlay({ resume: true });
        showToast(`Approved: ${genre} — this genre is allowed in Settings.`);
      }
    }, 1000);
  }

  function renderUnapproved(genre) {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.add("is-blocked");
    overlay.card.setAttribute("aria-busy", "false");
    setBlockedTitle(`Not Approved: ${genre}`);
    overlay.message.replaceChildren();
    overlay.message.append("This looks like ");
    const strong = document.createElement("strong");
    strong.textContent = genre;
    overlay.message.append(strong);
    overlay.message.append(
      ". While it can be a way to relax, it's likely a waste of time."
    );

    overlay.actions.replaceChildren();
    overlay.actions.append(createWatchAnywayButton());
    overlay.actions.append(
      createButton("Go back", "btn-primary", () => {
        goBack();
      })
    );

    overlay.hint.hidden = true;
    overlay.hint.replaceChildren();
    focusOverlay(".btn-primary");
  }

  function renderBlacklisted(channel, reason) {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.remove("is-blocked");
    overlay.card.setAttribute("aria-busy", "false");
    setBlockedTitle("Channel Blacklisted");

    overlay.message.replaceChildren();
    if (channel) {
      const strong = document.createElement("strong");
      strong.textContent = channel;
      overlay.message.append(strong, " is on your channel blacklist.");
    } else {
      overlay.message.append("This channel is on your channel blacklist.");
    }
    if (reason) {
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = `Reason / genre: ${reason}`;
      overlay.message.append(" ", detail);
    }

    overlay.actions.replaceChildren();
    overlay.actions.append(createWatchAnywayButton());
    overlay.actions.append(
      createButton("Go back", "btn-primary", () => {
        goBack();
      })
    );
    overlay.hint.hidden = true;
    overlay.hint.replaceChildren();
    focusOverlay(".btn-primary");
  }

  function renderKeyError(kind) {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.remove("is-blocked");
    overlay.card.setAttribute("aria-busy", "false");
    setOverlayIcon("error");
    overlay.actions.replaceChildren();
    overlay.hint.hidden = true;
    overlay.hint.replaceChildren();

    if (kind === "auth_error") {
      overlay.title.textContent = "API key invalid or missing";
      overlay.message.textContent =
        "OpenRouter rejected the saved key (HTTP 401/403). Update it in Settings, or watch this video anyway.";
    } else {
      overlay.title.textContent = "No API key set";
      overlay.message.textContent =
        "Add your OpenRouter API key in Settings to check video genres. The video stays paused until you decide.";
    }

    overlay.actions.append(
      createButton("Open settings", "btn-primary", () => {
        void sendMessage({ action: "OPEN_OPTIONS" });
      })
    );
    overlay.actions.append(
      createButton("Watch anyway", "btn-secondary", () => {
        closeOverlay({ resume: true });
      })
    );
    focusOverlay(".btn-primary");
  }

  function renderError(
    message,
    { settingsHint = false, model = "", reloadHint = false } = {}
  ) {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.remove("is-blocked");
    overlay.card.setAttribute("aria-busy", "false");
    setOverlayIcon("error");
    overlay.title.textContent = "Something went wrong";
    overlay.message.textContent =
      message || "The genre check failed. Try again.";
    overlay.actions.replaceChildren();

    if (reloadHint) {
      overlay.actions.append(
        createButton("Reload page", "btn-primary", () => {
          window.location.reload();
        })
      );
    } else {
      overlay.actions.append(
        createButton("Retry", "btn-primary", () => {
          if (state.metadata) {
            void classifyCurrent(state.metadata, state.sessionToken);
          } else {
            const route = state.route || parseRoute();
            if (route) void startForVideo(route).catch(() => {});
          }
        })
      );
    }

    if (settingsHint && !reloadHint) {
      const settingsButton = createButton(
        "Open settings",
        "btn-secondary",
        () => {
          void sendMessage({ action: "OPEN_OPTIONS" });
        }
      );
      settingsButton.dataset.action = "settings";
      overlay.actions.append(settingsButton);
    }
    overlay.actions.append(
      createButton("Watch anyway", "btn-secondary", () => {
        closeOverlay({ resume: true });
      })
    );
    overlay.hint.hidden = false;
    overlay.hint.replaceChildren();
    if (model) {
      const modelNote = document.createElement("span");
      modelNote.textContent = "Model: ";
      const modelCode = document.createElement("code");
      modelCode.textContent = model;
      overlay.hint.append(modelNote, modelCode);
    }
    focusOverlay(
      reloadHint
        ? ".btn-primary"
        : settingsHint
          ? '[data-action="settings"]'
          : ".btn-primary"
    );
  }

  function showToast(message, tone = "approved") {
    clearToast();
    const safeTone = ["approved", "allowed", "neutral"].includes(tone)
      ? tone
      : "approved";
    const host = document.createElement("div");
    host.id = TOAST_ID;
    host.style.cssText =
      "all: initial !important; position: fixed !important; top: 16px !important; " +
      "right: 16px !important; z-index: 2147483647 !important; " +
      "pointer-events: none !important; display: block !important;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${TOAST_CSS}</style>
      <div class="toast ${safeTone}" role="status" aria-live="polite">
        <span class="dot" aria-hidden="true"></span>
        <span class="text"></span>
      </div>
    `;
    shadow.querySelector(".text").textContent = message;

    const fullscreenElement = document.fullscreenElement;
    (fullscreenElement || document.documentElement).appendChild(host);
    requestAnimationFrame(() => host.classList.add("gg-visible"));

    toastTimer = setTimeout(() => {
      host.classList.remove("gg-visible");
      setTimeout(() => host.remove(), 180);
      toastTimer = null;
    }, 3200);
  }

  function clearToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    document.querySelectorAll(`#${TOAST_ID}`).forEach((node) => node.remove());
  }

  function hideOverlayIcon() {
    const overlay = state.overlay;
    if (!overlay) return;
    overlay.icon.hidden = true;
    overlay.icon.className = "status-icon";
    overlay.icon.replaceChildren();
  }

  function setBlockedTitle(text) {
    const overlay = ensureOverlay();
    hideOverlayIcon();
    overlay.title.replaceChildren();

    const openMark = document.createElement("span");
    openMark.className = "title-mark";
    openMark.textContent = "!";
    const closeMark = document.createElement("span");
    closeMark.className = "title-mark";
    closeMark.textContent = "!";

    overlay.title.append(openMark, ` ${text} `, closeMark);
  }

  function setOverlayIcon(kind) {
    const overlay = state.overlay;
    if (!overlay) return;
    overlay.icon.hidden = false;
    overlay.icon.className = `status-icon ${kind}`;
    overlay.icon.replaceChildren();

    if (kind === "loading") {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      overlay.icon.append(spinner);
      return;
    }
    if (kind === "approved") {
      overlay.icon.textContent = "✓";
      return;
    }
    overlay.icon.textContent = "!";
  }

  function createWatchAnywayButton() {
    let openingConfirmation = false;
    const button = createButton("Watch anyway", "btn-secondary", () => {
      if (openingConfirmation || state.watchAnywayTimer) return;
      openingConfirmation = true;
      const sessionToken = state.sessionToken;
      button.textContent = "Please wait…";

      // Fetch the daily count during the one-second transition so the second
      // dialog opens on time.
      const countPromise = sendMessage({
        action: "GET_WATCH_ANYWAY_COUNT"
      });

      state.watchAnywayTimer = setTimeout(async () => {
        state.watchAnywayTimer = null;
        if (
          state.sessionToken !== sessionToken ||
          !state.overlayOpen
        ) {
          return;
        }
        const response = await countPromise;
        if (
          state.sessionToken !== sessionToken ||
          !state.overlayOpen
        ) {
          return;
        }
        const count =
          response && response.ok === true && Number.isFinite(response.count)
            ? response.count
            : 0;
        renderWatchAnywayConfirmation(count);
      }, 1000);
    });
    return button;
  }

  function renderWatchAnywayConfirmation(count) {
    const overlay = ensureOverlay();
    clearApprovedTimer();
    clearWatchAnywayDelay();
    overlay.card.classList.add("is-blocked");
    overlay.card.setAttribute("aria-busy", "false");
    hideOverlayIcon();
    overlay.title.textContent = "Are you sure?";
    overlay.message.replaceChildren();

    const safeCount =
      Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
    const noun = safeCount === 1 ? "video" : "videos";
    overlay.message.append(
      `You have watched ${safeCount} prohibited ${noun} today.`
    );

    overlay.actions.replaceChildren();
    overlay.actions.append(createYesButton());
    overlay.actions.append(
      createButton("Go back", "btn-primary", () => {
        goBack();
      })
    );
    overlay.hint.hidden = true;
    overlay.hint.replaceChildren();
    focusOverlay(".btn-primary");
  }

  function createYesButton() {
    const button = createButton("Yes", "btn-secondary", () => {
      if (state.watchAnywayTimer) return;

      const sessionToken = state.sessionToken;
      let remaining = 2;
      button.textContent = `Yes in ${remaining}s…`;

      state.watchAnywayInterval = setInterval(() => {
        remaining -= 1;
        if (remaining > 0) {
          button.textContent = `Yes in ${remaining}s…`;
        }
      }, 1000);

      state.watchAnywayTimer = setTimeout(async () => {
        state.watchAnywayTimer = null;
        if (
          state.sessionToken !== sessionToken ||
          !state.overlayOpen
        ) {
          return;
        }
        await sendMessage({ action: "INCREMENT_WATCH_ANYWAY" });
        if (
          state.sessionToken !== sessionToken ||
          !state.overlayOpen
        ) {
          return;
        }
        closeOverlay({ resume: true });
      }, 2000);
    });
    return button;
  }

  function createButton(label, className, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function focusOverlay(preferredSelector) {
    requestAnimationFrame(() => {
      const overlay = state.overlay;
      if (!overlay || !state.overlayOpen) return;
      const preferred = preferredSelector
        ? overlay.shadow.querySelector(preferredSelector)
        : null;
      const firstButton = overlay.shadow.querySelector(
        "button:not([disabled])"
      );
      const target = preferred || firstButton || overlay.card;
      try {
        target.focus({ preventScroll: true });
      } catch {
        // The overlay may have closed before the animation frame.
      }
    });
  }

  function onShadowKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === "Tab") {
      const overlay = state.overlay;
      if (!overlay) return;
      const focusables = Array.from(
        overlay.shadow.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0);

      if (focusables.length === 0) {
        event.preventDefault();
        overlay.card.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = overlay.shadow.activeElement;
      if (event.shiftKey) {
        if (active === first || active === overlay.card || !active) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (
        active === last ||
        active === overlay.card ||
        !active ||
        !overlay.shadow.contains(active)
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
      event.stopPropagation();
      return;
    }

    // Prevent YouTube's document-level shortcuts from firing while focus is
    // inside the gate. The button's own default action still runs.
    event.stopPropagation();
  }

  function clearApprovedTimer() {
    if (state.approvedTimer) {
      clearTimeout(state.approvedTimer);
      state.approvedTimer = null;
    }
  }

  function clearWatchAnywayDelay() {
    if (state.watchAnywayTimer) {
      clearTimeout(state.watchAnywayTimer);
      state.watchAnywayTimer = null;
    }
    if (state.watchAnywayInterval) {
      clearInterval(state.watchAnywayInterval);
      state.watchAnywayInterval = null;
    }
  }

  function closeOverlay({ resume, immediate = false } = {}) {
    const overlay = state.overlay;
    if (!overlay) return;

    clearApprovedTimer();
    clearWatchAnywayDelay();
    state.overlay = null;
    state.overlayOpen = false;
    state.pendingRequestId = null;
    stopPlaybackGuard();

    if (state.escapeHandler) {
      document.removeEventListener("keydown", state.escapeHandler, true);
      state.escapeHandler = null;
    }

    overlay.host.classList.remove("gg-visible");
    overlay.host.style.setProperty("pointer-events", "none", "important");
    if (immediate) {
      overlay.host.remove();
    } else {
      setTimeout(() => overlay.host.remove(), 200);
    }

    resumePlaybackIfRequested(Boolean(resume));
  }

  function goBack() {
    cancelPendingRequest();
    closeOverlay({ resume: false });
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.assign("https://www.youtube.com/");
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Boot                                                                     */
  /* ------------------------------------------------------------------------ */

  injectPageBridge();

  // YouTube is a SPA. yt-navigate-finish is the canonical navigation event;
  // the URL poll and popstate listener are fallbacks for DOM/event changes.
  document.addEventListener("yt-navigate-finish", checkNavigation, true);
  window.addEventListener("yt-navigate-finish", checkNavigation, true);
  document.addEventListener("yt-page-data-updated", checkNavigation, true);
  window.addEventListener("popstate", checkNavigation, true);

  // yt-navigate-start fires before the URL has necessarily changed. Check now
  // and twice more shortly after, which catches the new URL in ~60ms without
  // waiting for yt-navigate-finish (which YouTube sometimes fires much later).
  window.addEventListener(
    "yt-navigate-start",
    () => {
      checkNavigation();
      setTimeout(checkNavigation, 60);
      setTimeout(checkNavigation, 200);
    },
    true
  );

  if (!fullscreenHandlerAdded) {
    fullscreenHandlerAdded = true;
    document.addEventListener("fullscreenchange", () => {
      if (state.overlay) mountOverlayHost(state.overlay.host);
    });
  }

  setInterval(checkNavigation, 400);
  checkNavigation();
})();
