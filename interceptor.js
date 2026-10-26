/**
 * Genre Gate page-context bridge.
 *
 * This file runs in YouTube's MAIN world (injected by content.js through a
 * chrome-extension:// script tag declared in web_accessible_resources). It is
 * the only place that can read YouTube's page JavaScript variables, most
 * importantly ytInitialPlayerResponse.videoDetails.shortDescription, which is
 * where the lazy-loaded description usually lives.
 *
 * It receives a window.postMessage request from the isolated content script,
 * reads the current player response, and posts a plain data object back. It
 * never receives or handles the OpenRouter API key.
 */
(() => {
  "use strict";

  if (window.__genreGatePageBridgeInstalled) return;
  window.__genreGatePageBridgeInstalled = true;

  const PAGE_SOURCE = "genre-gate-page";
  const CONTENT_SOURCE = "genre-gate-content";
  const ORIGIN = window.location.origin;

  function cleanString(value, maxLength) {
    return typeof value === "string"
      ? value.replace(/\u0000/g, "").trim().slice(0, maxLength)
      : "";
  }

  function microformatText(value) {
    if (typeof value === "string") return value;
    if (value && typeof value.simpleText === "string") return value.simpleText;
    return "";
  }

  /**
   * YouTube replaces the player's data on SPA navigation in different ways
   * depending on the build. The player API is the most current source;
   * ytInitialPlayerResponse is the reliable fallback on first page load.
   * #movie_player is YouTube's stable player container ID.
   */
  function getCurrentPlayerResponse() {
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        const response = player.getPlayerResponse();
        if (response && typeof response === "object") return response;
      }
    } catch {
      // Fall through to the initial response.
    }

    try {
      if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;
    } catch {
      // The page may have replaced the global with a getter that throws.
    }
    return null;
  }

  function handleFromOwnerUrl(value) {
    const raw = cleanString(value, 500);
    if (!raw) return "";
    try {
      const url = new URL(raw, window.location.origin);
      const match = url.pathname.match(/^\/@([^/]+)/);
      if (match) return `@${decodeURIComponent(match[1])}`;
    } catch {
      // Ignore malformed owner URLs.
    }
    return "";
  }

  function readVideoDetails() {
    const response = getCurrentPlayerResponse();
    if (!response || typeof response !== "object") return null;

    const details =
      response.videoDetails && typeof response.videoDetails === "object"
        ? response.videoDetails
        : null;
    if (!details) return null;

    const micro =
      response.microformat &&
      typeof response.microformat.playerMicroformatRenderer === "object"
        ? response.microformat.playerMicroformatRenderer
        : {};

    const rawLength = Number(details.lengthSeconds ?? micro.lengthSeconds);
    const lengthSeconds =
      Number.isFinite(rawLength) && rawLength > 0 ? rawLength : null;
    const isLive =
      details.isLiveContent === true ||
      details.isLive === true ||
      micro.liveBroadcastDetails?.isLiveNow === true;

    // Never substitute the URL's video ID for a missing player-response ID.
    // During an ad or transition this could pair an ad duration with the main
    // video ID, which previously caused false "under minimum length" passes.
    const videoId = cleanString(details.videoId, 64);
    if (!videoId) return null;

    const category =
      cleanString(micro.category, 100) ||
      cleanString(details.category, 100);
    const keywords = Array.isArray(details.keywords)
      ? details.keywords
          .map((keyword) => cleanString(keyword, 80))
          .filter(Boolean)
          .slice(0, 20)
      : [];

    return {
      videoId,
      title:
        cleanString(details.title, 300) ||
        cleanString(microformatText(micro.title), 300),
      description:
        cleanString(details.shortDescription, 5000) ||
        cleanString(microformatText(micro.description), 5000),
      channel:
        cleanString(details.author, 200) ||
        cleanString(micro.ownerChannelName, 200),
      channelId: cleanString(details.channelId, 200),
      channelHandle: handleFromOwnerUrl(micro.ownerProfileUrl),
      category,
      keywords,
      durationSeconds: isLive ? null : lengthSeconds,
      isLive
    };
  }

  window.addEventListener("message", (event) => {
    // Validate both the source window and origin before trusting any data.
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      data.source !== CONTENT_SOURCE ||
      data.type !== "get-video-details" ||
      typeof data.requestId !== "string"
    ) {
      return;
    }

    const requestId = cleanString(data.requestId, 100);
    if (!requestId) return;

    let details;
    try {
      details = readVideoDetails();
    } catch {
      details = null;
    }
    if (!details) return;

    // If the player response is still showing the previous video, do not send
    // it: the content script will retry or fall back to DOM metadata.
    const expectedVideoId = cleanString(data.videoId, 64);
    if (
      expectedVideoId &&
      details.videoId &&
      details.videoId !== expectedVideoId
    ) {
      return;
    }

    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: "video-details",
        requestId,
        payload: details
      },
      window.location.origin
    );
  });

  // Let the isolated world know the bridge is listening (used only as a fast
  // path hint; request retries work even if this message is missed).
  window.postMessage({ source: PAGE_SOURCE, type: "ready" }, ORIGIN);
})();
