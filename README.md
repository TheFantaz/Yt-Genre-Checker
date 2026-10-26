# Genre Gate

Genre Gate is a Manifest V3 Chrome extension that pauses each new YouTube video,
classifies its genre with an OpenRouter language model, and shows a small gate
over the player. Approved genres resume automatically; unapproved genres wait
for an explicit decision.

There is no build step, bundler, framework, or remotely hosted code. Load the
folder directly with **Load unpacked**.

## File tree

```
YT-Genre-Checker/
├── manifest.json          Manifest V3 definition
├── background.js          Service worker: key storage, settings, cache, API
├── content.js             YouTube gate, pause guard, Shadow DOM overlay
├── interceptor.js         Page-context bridge for ytInitialPlayerResponse
├── options.html           Full settings page
├── options.css            Settings page styles
├── options.js             Settings page logic (messages only)
├── popup.html             Toolbar popup
├── popup.css              Toolbar popup styles
├── popup.js               Toolbar popup logic
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

The overlay CSS lives inside `content.js` so it can be adopted into the Shadow
DOM synchronously, before the gate first appears. No `content.css` file is
needed.

## Install (Load unpacked)

1. Open `chrome://extensions` in Chrome (or another Chromium-based browser with
   Manifest V3 support).
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select this repository folder (the one containing `manifest.json`).
5. Open or refresh a YouTube tab. Genre Gate only acts on `youtube.com/watch`
   and `youtube.com/shorts` pages.

To pick up code changes, click the reload icon on the Genre Gate card in
`chrome://extensions`, then refresh any open YouTube tabs.

## Get an OpenRouter key

1. Create or sign in to an OpenRouter account.
2. Open <https://openrouter.ai/keys>.
3. Create a dedicated key. A spending limit is strongly recommended.
4. In Genre Gate, click the toolbar icon → **Open settings**, paste the key into
   **OpenRouter API key**, and click **Save key**.
5. Optionally click **Test key**. It performs a minimal authenticated request to
   OpenRouter, reports `Valid`, and shows the remaining credit balance when
   OpenRouter exposes it. Invalid keys, exhausted credits, and network failures
   are reported explicitly.

The default model is `openai/gpt-4o-mini`; the model ID is editable. Any
OpenRouter chat-completions model that supports JSON output can be used.

**Free-only setup:** set the model to `openrouter/free`, or click **Use free
router** in Settings. It is OpenRouter's free auto-router and supports JSON
output. Free models are subject to OpenRouter's free-tier rate limits and
provider availability, so occasional 429/5xx responses are normal. Do not use
content-safety or code-only models (for example,
`nvidia/nemotron-3.5-content-safety:free`) as genre classifiers; they do not
return genres. Classification requests disable model reasoning and use a
512-token cap so free models answer quickly.

## What happens on a new video

1. On `yt-navigate-finish`, or via a URL-poll fallback for `/watch?v=` and
   `/shorts/`, the content script detects a new video ID.
2. It immediately pauses the player, opens the Shadow DOM overlay in a loading
   state, and installs a `play`/`playing` guard so YouTube autoplay cannot
   restart the video behind the gate. Genre Gate **never changes `video.muted`,
   volume, or audio state**; if YouTube/you had audio muted before the gate, it
   stays that way, and the extension never mutes it.
3. It gathers title, channel name, channel ID/handle, video ID, and duration.
   Description text is read from the page-context bridge
   (`ytInitialPlayerResponse` / the player API), then the meta description, then
   the DOM, and is truncated to 1,500 characters.
4. The service worker reads fresh settings and checks, in order:
   - channel whitelist;
   - channel blacklist;
   - minimum video length (disabled at `0`; Shorts are ignored by this rule,
     and only a verified player-response duration is trusted);
   - the local classification cache;
   - API key availability.
5. If none of those decide the video, the service worker calls OpenRouter with
   `response_format: { type: "json_object" }`, temperature `0`, a small token
   limit, reasoning disabled, and a 15-second `AbortController` timeout.
   Reasoning is unnecessary for a one-word genre and made free reasoning models
   far slower.
6. Approved genres show `✓ Approved: {genre}` for about one second, then the
   gate closes and playback resumes. A non-blocking toast confirms the decision.
   Unapproved genres show **Watch anyway** and **Go back**, with inline
   exclamation marks in the heading. **Watch anyway** waits one second, then
   opens a second confirmation dialog showing the number of prohibited videos
   confirmed today. **Yes** waits two seconds before resuming; **Go back** is
   immediate. The video remains paused through both dialogs. Whitelisted,
   minimum-length, and disabled skips also show a brief non-blocking reason
   toast instead of vanishing silently.

### What is sent to OpenRouter

The model receives only:

- video title (up to 300 characters);
- channel name (up to 200 characters);
- YouTube category, when available;
- up to 20 video keywords/tags;
- description (up to 1,500 characters);
- the user's genre list and classification instructions.

It does **not** receive the API key, the page URL, thumbnails, audio, transcript,
comments, or the user's approval choices. Requests use temperature `0`, JSON
output mode, reasoning disabled, and a 512-token cap.

The uploader-selected YouTube category is always included, whatever it is
(including unknown), and keywords are included when available. The prompt treats
them as supporting hints only. Title and description take precedence; channel
identity is context only. There is no hard override forcing a genre from the
category. If the evidence is genuinely unclear, the model is told to choose
Other rather than guess.

YouTube's category is uploader-selected, not an automatically generated fine
genre. It comes from YouTube Studio and is exposed through the player response
and the page's `itemprop="genre"` meta tag. It has only a small set of broad
options (for example Gaming, Education, Science & Technology, Howto & Style,
Entertainment, and Music), with no confidence score, no multi-label support, and
no direct mapping to this extension's custom genre list. It is useful as a hint,
but not reliable enough to replace the model.

Live streams (`duration === Infinity` or YouTube's live flag) are never treated
as short. During an ad, metadata comes from the main player response and the
content script avoids reading the ad's `video.duration`. Navigating to another
video cancels the prior request, discards stale responses by video ID and
request ID, and starts a fresh gate.

## Settings

All settings are non-secret and live in `chrome.storage.sync`:

- **Enabled** — master switch, also in the toolbar popup.
- **Model ID** — default `openai/gpt-4o-mini`.
- **Genres & approvals** — add, remove, rename, and approve genres. `Other`
  always exists, cannot be deleted or renamed, and defaults to unapproved.
  Default genres: Tech/Informational (approved), Educational/Tutorial
  (approved), Cooking Tutorial (approved), News/Current Events, Gaming,
  Comedy/Entertainment, Music, Vlog, Other (all unapproved).
- **Channel whitelist** — names or handles such as `@veritasium`, each with an
  optional reason/genre. Videos from these channels are allowed immediately
  without an API call.
- **Channel blacklist** — names or handles, each with an optional reason/genre.
  Videos from these channels are blocked immediately without an API call; the
  gate stays open with **Watch anyway** and **Go back**, and shows the reason.
  Matching is case-insensitive against the channel name, handle, and channel
  ID. A channel cannot be added to both lists; if legacy data has it on both,
  the blacklist wins.
- **Minimum video length** — minutes; `0` disables. Shorter videos auto-allow
  with no API call. `/shorts/` videos are ignored by this minimum-length rule
  and are classified normally. Only a player response matching the current
  video ID counts; ad, transition, and unverified video-element durations are
  never used to auto-allow a video. If no verified duration is available, the
  video is classified instead.
- **Remember key on this device** — default on.

There is no fail-open mode. If the check fails, the gate stays open with
**Retry**, **Open settings** when relevant, and **Watch anyway**; it never
resumes the video on its own.

Settings are written when changed (debounced), with a visible “Settings saved”
confirmation. The service worker re-reads settings on every classification, so
changes apply to the next video without reloading the extension. The API key is
handled separately and explicitly.

## API key storage and removal

### Storage layout

- `chrome.storage.sync`
  - `genres`, `channelWhitelist`, `channelBlacklist`, `minLengthMinutes`,
    `model`, `enabled`, `rememberKey`
  - **Never** the API key.
- `chrome.storage.local`
  - `apiKey` only when **Remember key on this device** is on
  - `classificationCache` (video ID → `{ genre, timestamp }`)
  - `watchAnywayStats` (`{ date, count }`, reset by local calendar day; only
    incremented after final **Yes** confirmation)
- `chrome.storage.session`
  - `apiKey` only when **Remember key on this device** is off
  - Memory-only; cleared when the browser closes

At the top level of `background.js`, on every service-worker startup, both
`chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` and
`chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` are
called. Content scripts therefore cannot read the key or the cache. The content
script obtains everything through `chrome.runtime.sendMessage`; the full key is
never sent to it, to the page, or logged.

The options page also communicates only through the service worker. After a key
is saved, the options page can receive only a masked form such as
`sk-or-••••1a2b` with the last four characters visible.

### Remember key modes

- **On:** the key is stored in `chrome.storage.local`.
- **Off:** the key is stored only in `chrome.storage.session` and never written
  to disk. It must be re-entered after restarting the browser.

Changing the checkbox moves the key to the new area, then securely removes the
copy in the old area.

### Removal procedure

Clicking **Remove**, saving an empty key field, or toggling **Remember key** off
all use the same deletion procedure:

1. Overwrite the stored value with a cryptographically random string of the same
   length (`crypto.getRandomValues`).
2. Remove `apiKey` from that area.
3. For explicit Remove/empty-save, perform the procedure on **both**
   `chrome.storage.local` and `chrome.storage.session`.

After removal the UI confirms:

> Key removed from this device. To fully invalidate it, revoke it in your
> OpenRouter dashboard (Keys).

**Caveat:** overwrite-then-delete is a best-effort mitigation, not a guarantee.
Chrome's LevelDB storage may retain old bytes until compaction. Revoking the key
at OpenRouter is the only guaranteed way to invalidate it.

**Clear cache** is separate and only deletes `classificationCache`. It never
touches the key, settings, or the daily watch-anyway count. **Remove** only
removes the key; it never clears the cache or the count.

## Error states

- **Blacklisted channel:** gate shows **Channel blacklisted**, the configured
  reason/genre, **Watch anyway**, and **Go back**. No API call is made.
- **No key:** gate shows **No API key set** with **Open settings** (and a
  Watch anyway escape hatch).
- **401 / 403:** gate shows **API key invalid or missing** with **Open
  settings** and **Watch anyway**. Nothing is cached.
- **402 / 404 / 400 / 422:** the gate shows OpenRouter’s specific message and
  adds **Open settings** alongside **Retry** / **Watch anyway**. This usually
  means the account has no credits, the model ID changed, or the selected model
  does not support JSON output. For 402, add credits at
  <https://openrouter.ai/credits> or choose a model the balance covers.
- **429 / 502 / 503 / timeout:** the gate explains the transient failure,
  honoring a `Retry-After` value in the message when OpenRouter sends one.
- **Errors returned inside an HTTP 200 body:** OpenRouter can report a provider
  error with status 200. The worker now checks for a top-level `error` object and
  `finish_reason: "error"` instead of treating that response as an unreadable
  genre.
- **Timeout, network, malformed response:** always keeps the gate open with
  **Retry**, **Open settings** when the model/config may be the cause, and
  **Watch anyway**. There is no silent fail-open. Errors never include the key;
  the key is also redacted from provider messages.

## Permissions and privacy

- Permissions: `storage` only.
- Host permissions: `https://www.youtube.com/*` and `https://openrouter.ai/*`.
- The page-context bridge is declared under `web_accessible_resources` and only
  exposes video metadata read from YouTube's player response.
- The extension sends the video title, channel, and up to 1,500 characters of
  description to the configured OpenRouter model. It does not send the key to
  YouTube.

## Known limitations

- YouTube is a moving target. Its DOM selectors and SPA events can change; the
  relevant selectors and `yt-navigate-finish` handling are commented in
  `content.js` and `interceptor.js` for easy repair.
- Only `/watch` and `/shorts/` pages are gated. The YouTube homepage, embeds,
  and other domains are intentionally out of scope.
- Ad handling relies on YouTube's `ad-showing` class and player response. If
  YouTube changes ad internals, the extension may wait for metadata longer but
  will not intentionally classify ad copy.
- Classification quality depends on the chosen model and on the title,
  description, and channel metadata available at check time. Free models share
  provider capacity and can be rate-limited or temporarily unavailable;
  `openrouter/free` is the supported free-router option.
- Some models are not genre classifiers at all (content-safety, code-only,
  embedding, or moderation models). The error state names the configured model
  and the reply excerpt so an unsuitable model can be identified quickly.
- The cache has no expiration and no UI list; **Clear cache** removes all
  entries. Cache entries store only genre and timestamp, so approval changes are
  applied when a cached genre is read.
- Minimum-length auto-skip requires a verified YouTube player duration. If
  YouTube does not expose it, the extension classifies the video rather than
  risking a false auto-allow.
- The overlay may briefly appear while the extension is disabled, because the
  enabled setting is confirmed asynchronously; it closes as soon as the service
  worker answers.
- Removing a key from extension storage cannot erase copies from disk backups,
  Chrome's LevelDB history, or OpenRouter itself. Revoke the key at OpenRouter
  when in doubt.
- Channel matching is exact (case-insensitive); substrings are not used.
- No automated browser tests are included. The extension is plain MV3 and can
  be verified manually via `chrome://extensions` and DevTools.

## Troubleshooting

- **No gate appears:** confirm Genre Gate is enabled, the page is a `/watch` or
  `/shorts/` URL, and reload the YouTube tab after reloading the extension.
- **“Could not reach the Genre Gate background”:** the extension page was
  probably reloaded without refreshing YouTube. Reload the extension at
  `chrome://extensions`, then refresh the YouTube tab. The content script now
  retries a cold service worker and shows **Reload page** when its extension
  context is stale.
- **A whitelisted/blacklisted channel is not recognized:** use the channel
  name, handle, or channel ID. `TCNick3` and `@TCNick3` are equivalent. After
  changing the extension, refresh YouTube so the content script is current.
- **“No API key set”:** open settings and save a key. In memory-only mode, enter
  it again after each browser restart.
- **“API key invalid or missing”:** check the key in OpenRouter, click **Test
  key**, and revoke/replace it if necessary.
- **HTTP 402 / “credits are exhausted”:** OpenRouter’s paid models require
  credits. Add credits at <https://openrouter.ai/credits> or set the model to
  `openrouter/free`. **Test key** displays the remaining balance when available.
- **“content-safety classifier, not a genre classifier”:** switch to
  `openrouter/free` or another JSON-capable chat model. Content-safety models
  return safety labels such as `User Safety: safe`.
- **HTTP 404 / “could not find the model”:** the model ID was retired or typed
  incorrectly. Update **OpenRouter model ID** in Settings.
- **HTTP 400 / non-JSON output:** the selected model may not support
  `response_format: { type: "json_object" }`. Switch to a model that supports
  JSON output, such as `openrouter/free` or the default `openai/gpt-4o-mini`.
- **Free model rate limits:** free models can return 429 or provider
  unavailable errors. Wait and click **Retry**, or try another free model.
- **Rate limits / provider unavailable:** wait for the retry hint, then click
  **Retry**, or choose another model.
- **Settings do not seem to apply:** they are re-read per video; navigate to a
  new video or reload the extension if you just changed source files.
