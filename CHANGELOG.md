# Changelog

All notable changes to Lumastra are listed here, newest first. Each release has the
sections New, Changed, Fixed, Security and Known issues where they apply. Changes that
haven't been released yet collect under "Unreleased".

A release with entries under Security also gets a line `Security: yes` in its GitHub
release notes (and links its GitHub Security Advisory). Lumastra's update check reads that
line and shows the update to admins as a red notice until they install it.

Each release starts with a line that says whether the Live TV proxy, which runs on its own
pinned image, needs an update: "Live TV proxy: update needed (reason)" or "Live TV proxy: no
update needed". If you skip releases, update the proxy when any of them says so. Admin → System
health → Cluster also warns when the running proxy is behind.

The iPhone, iPad and Apple TV apps have their own version numbers. Their notes are on
[lumastra.org/about/changelog/](https://lumastra.org/about/changelog/).

## 0.1.4 - 2026-11-13

Live TV proxy: update needed (its Rust dependencies were updated).

### Security

- The Docker images use Node.js 24.22.3, Node's November security release. npm and Rust
  dependencies are updated within their version ranges.

### Fixed

- Browse: the search box in the A-Z and Recently-added views also finds titles in the viewer's
  language and original titles (from 3 characters on), as global search already did.
- Search: an exact or prefix match on a title in the viewer's language now ranks first, instead of
  other titles that only look similar. Exact matches ignore case.
- Jellyfin apps: the Quick Connect QR code that Moonfin shows opens the approve dialog with the
  code filled in, instead of the home page.
- Jellyfin apps: `/j`, `/j/System/Info` and `/j/System/Info/Public` report the same server
  address (`PUBLIC_BASE_URL`, else the request address plus the base path). Before, an install on
  a sub-path lost its base path, and behind a proxy the server could report an internal address.
- Setup wizard: the library step offers every library type, including home videos, training,
  educational and personal.

### Changed

- When the Jellyfin-compatible API is on, the default home screen shows a "Set up a Jellyfin app"
  button that opens Settings → Connections. Admins can remove it in the home screen editor; "Load
  defaults" there includes it. The setup wizard says that apps connect through Settings →
  Connections.

## 0.1.3 - 2026-11-05

Live TV proxy: no update needed.

### Fixed

- Helm chart: with more than one router pod (two by default), video often didn't start and
  media requests failed with `403 ip_mismatch`, because the app saw each router pod's address
  as the client. The router now proves itself to the web pods with a value derived from
  `LUMASTRA_MASTER_KEY`, and the app takes the client address from the router only on those
  requests. It gives no login trust. Nothing to configure if the key is in the Secret, as in
  the quick start. Restart the router pods after rotating the key.
- Setup wizard: "Skip for now" on the basics step goes on to the library step instead of
  leaving the wizard.
- After a Valkey restart, the recovery message counts the connections that failed instead of
  every reconnect attempt (a worker reported hundreds of errors for a sub-second restart).
- `npm run doctor` no longer names an embedding provider when no embedding key is set.

### Changed

- Helm chart: `helm install` warns when any pod in the cluster could set its client address
  through the router (the router trusts `X-Forwarded-For` from the whole private range and no
  NetworkPolicy limits who reaches it). The security self-check reports the same.

## 0.1.2 - 2026-11-04

Live TV proxy: no update needed.

### Fixed

- A full `docker compose restart` (PostgreSQL, Valkey and the app stopping together) no longer
  keeps the worker stopping for about 60 s with "Task runtime shutdown failed". The worker and
  web now stop in a few seconds with no errors. Shutdown gives up waiting only on a server that
  is really unreachable (checked with its own TCP connection, per server), never on a slow one;
  in that case it leaves its locks and lease to expire instead of releasing them. A worker with
  running jobs still interrupts them and stops in order.
- The web container's shutdown steps each have a time limit, and the database and Valkey pools
  always keep enough time to close, so a hung step can't make Docker kill the container.
- A Valkey restart no longer floods the log with hundreds of warnings: connection errors are
  logged once per outage (with a reminder every 5 minutes if it lasts), the recovery message
  reports the real outage length, and other errors are still logged every time.
- The example compose file gives the web service a stop grace period, and the sonic service's
  media line is commented out like the others.

## 0.1.1 - 2026-11-04

Live TV proxy: no update needed.

A patch release with fixes from the first day of public CI, the first CodeQL scan and a fresh
install test of 0.1.0.

### Security

- Device sign-in codes (the code you type on a TV) and the passwords Lumastra generates for
  Jellyfin-compatible clients now draw every character with an unbiased random number. Before,
  some characters came up slightly more often than others, which made the codes a little
  easier to guess. Codes stay short-lived and rate-limited.
- Search boxes that match text with SQL `ILIKE` (Live TV channels and guide, the
  Jellyfin-compatible browse) now also escape the backslash, so a search can no longer
  disable the escaping of the next character.
- The Watch Together fallback client ID comes from `crypto.randomUUID()` instead of
  `Math.random()`.

### Fixed

- Closing the task queue listeners no longer waits forever while Valkey is restarting. A full
  `docker compose restart` could still keep the worker stopping for about 60 s; that is fixed
  in 0.1.2.
- Failed best-effort transcode-job writes while the app shuts down are warnings, not errors.
- Cancelling a music transcode right as ffmpeg started could record the stream as finished and
  put an empty file into the audio cache. A cancelled encode now always ends as an error.
- Titles and descriptions from XMLTV guides, AniDB, Kavita and the assistant's links are no
  longer HTML-decoded twice (`&amp;lt;` now stays `&lt;`).
- A backslash before `|` in a diagnostics, playback-incident, transcode-failure or
  failure-timeline report no longer breaks the report's Markdown table.

## 0.1.0 - 2026-11-03

Live TV proxy: update needed (protocol 0 → 1) if you ran the 2026-10-15 release candidate;
new installs start with the current proxy.

The first public release. Lumastra is a self-hosted media server for movies, series,
music, audiobooks and Live TV. It's an early release: it runs real libraries every day,
but expect rough edges. Read the
[known limitations](https://lumastra.org/reference/known-limitations/) before you deploy.

### What's in it

**Movies and series**

- Recommendations: For You shelves, mood picks and similar titles, including titles
  beyond your library.
- Semantic search by what a film is about (with your own AI provider key).
- A release calendar for what's in your library.
- Episode matching for multi-episode files and DVD or absolute ordering.
- Library types for home videos, training and educational content.

**Music, all built in**

- Audio analysis: tempo, key, energy and mood (x86-64), and an optional sidecar for
  "sounds like" similarity.
- A smart queue that keeps playing tracks that fit, gapless playback and DJ crossfades.
- Automatic mixes, Song Paths between two songs, a Music Map of your library, and search
  by sound or by what lyrics mean.
- OpenSubsonic support for your favourite music apps.

**Playback**

- Direct play, remux or transcode, decided per device.
- Hardware transcoding on Intel, NVIDIA and AMD (Intel is tested the most).
- Styled ASS/SSA and PGS/VobSub subtitles without burn-in.
- Seeking thumbnails, chapters, and skip intro or credits.

**Audiobooks, books and Live TV**

- Audiobooks from your Audiobookshelf server in the Lumastra apps, with progress synced
  both ways.
- Search your Kavita books and open them in Kavita.
- Live TV from M3U, Xtream or HDHomeRun sources, with a programme guide, automatic channel
  grouping, backup feeds and numbering.

**Together**

- Watch Together between browsers and the Apple TV app.
- Ratings, reviews and shared watch activity, with privacy controls per user.
- Trakt and MyAnimeList sync per user, and two-way watch sync with an existing Jellyfin
  server.

**Apps and sign-in**

- Native iPhone, iPad and Apple TV apps (version 1.0.1, in public TestFlight) and an
  installable web app.
- Jellyfin-compatible apps such as Streamyfin connect directly, without a Jellyfin server.
  Two streams at a time are included; more come with the supporter tier.
- Single sign-on through OIDC or forward authentication on every device, including the
  TV, plus built-in accounts.

**For developers and admins**

- A documented, versioned API (`/api/v1`) with an OpenAPI spec and scoped tokens.
- Plugins for sources, metadata, subtitles, lyrics, tasks, watch sync and sign-in.
- An admin task system, health monitoring and diagnostics sent from the apps.
- Docker Compose, or Kubernetes with a Helm chart (beta).

### Requirements

- Docker Compose (or Kubernetes), 8 GB RAM recommended, 20 GB disk plus your media.
- PostgreSQL 17 or newer with pgvector, and Valkey. The example compose file starts both.
- An x86-64-v2 CPU or 64-bit ARM. On ARM, music BPM and mood analysis, the sound
  sidecar and Intel Quick Sync are not available.
- HTTPS through a reverse proxy for the iPhone, iPad and Apple TV apps.

### Licensing

The core is open source under the AGPL-3.0. The AI chat assistant and more than two
streams through the Jellyfin bridge are source-available supporter features, free during
early access (until 2027-01-31). See
[editions and licensing](https://lumastra.org/guides/licensing/).

### Known issues

- No recording (DVR) for Live TV yet.
- The iPhone and iPad app can't join Watch Together sessions yet.
- Browsing very large libraries isn't optimised yet.
- Hardware transcoding is tested less on NVIDIA and least on AMD.

The full list is in [known limitations](https://lumastra.org/reference/known-limitations/).

### Changes since the 2026-10-15 release candidate

Testers who ran the release candidate from 2026-10-15 get these changes with 0.1.0.

#### Security

- Restrict preview playback grants to their own HLS playlists, segments, init files,
  keepalive and cleanup on both API surfaces. Preview grants, including previously
  issued ones, can no longer authorize full-item files, streams, downloads, remux,
  subtitles or trickplay. Normal playback grants are unchanged.

#### Changed

- File duration comparisons now request review without claiming corruption. Administrators can record a reason and inspection evidence for exact physical-file findings, inspect review history, and revoke a decision. Changed source or technical evidence reopens the finding; raw measurements and historical failures remain recorded.

- Active Streams includes Live TV viewers, channel logos, bandwidth and expandable output/continuity diagnostics.
- Episode language badge visibility is saved per user. Episode thumbnails and titles stay aligned, and playback preserves the saved mute and volume choices.
- Remove reviewed multipart video composition before release. Existing part files and episode links remain available as ordinary files; split episodes should be joined on disk.
- The admin home widget now shows monthly active users and gives a single GPU metric the full available width.
- Unavailable library entries now have a 30-day retention window by default. Installations
  without a stored or environment override adopt the new default. Existing unavailable
  entries receive a one-time grace reset before cleanup can remove them.
- Cleanup of never-owned catalog entries continues through bounded batches within a time
  budget instead of stopping after the first batch.
- Provider attribution and licensing information now includes Discogs, Last.fm and MusicBrainz.

- Short-item watch progress now requires the smaller of 60 seconds or 25% of runtime
  across live heartbeats, stops and offline uploads. Episodes sharing a file use their own
  window duration; long content and unknown runtimes keep the 60-second requirement.
- Breaking audiobook byte cutover: follow issued `/api/v1/audiobooks/{mediaId}/files/{trackIndex}`
  and `/remux/{trackIndex}` URLs with an owned Lumastra `PlaySessionId`; removed singular file/remux
  routes (GET and HEAD answer `410 route_retired`), raw ABS addressing and the `session`/`trackIndex`/`t` selectors without aliases. Byte
  failures use problem+json; remux success is binary AAC and HEAD never starts an encoder.
  The resume offset query is `startPositionSeconds`; HLS now answers HEAD; audiobook grants now
  require the owned `PlaySessionId`, so previously issued audiobook grants stop resolving (start a
  new session); `streamAudiobookFile` and `streamAudiobookFileAac` moved to the new paths. An
  upstream AudiobookShelf 401/403 is reported as 502 `bad_gateway`, never as a Lumastra auth error.
- Audiobook start chapters now share `TimelineChapter` (`index`, `name`, `startMs`, `endMs`, optional
  `image`). Requires the coordinated Apple release: migrate unfinished/background download requests
  before resuming, preserving completed files, partial bytes, validators and encoding. See API.md.
- **Breaking (P7 preview and Live contracts):** VOD previews use only
  `POST /playback/previews`, preserving admission, artifact caching, trailers and
  cleanup. Remove the legacy `/playback/{itemId}/preview-session` and generic-start
  `purpose`. Preview keepalive is POST `…/{id}/keepalive`. Reporting descriptors
  distinguish progress PUT from bodyless keepalive POST; Live cadence/href move
  from delivery to reporting. Live retains station/feed starts and publishes
  requested/applied quality plus `ladder_disabled`; ended Live grants cannot renew.
  Rename `delivery.previews` to `delivery.trickplay`. `POST /playback/previews` now
  rejects unknown body fields (for example the old `transcodeMode`) with 400.
  `DELETE /playback/previews/{id}` stays idempotent: 204 for unknown or foreign ids
  too (it discloses nothing), while keepalive answers 404. Requires the coordinated
  Apple client release; no aliases.
- Music counts a play on its first positive reported heard time, including completion/replay, rather than session allocation. Prefetches, downloads and cancelled unheard starts count zero; retries share a durable claim. Music starts reject `audio.download`; use Bearer `stream?download=1`. Discarded web preloads release their sessions, and cap-one transitions wait for the outgoing completion. URL-only receivers need controller reporting for listening statistics.
- Breaking API: play-session PUT/beacon reports use music `listenedTotalMs` and audiobook `listenedDeltaMs`; `sessionElapsedMs` stays cumulative. The old `listenedMs` is deprecated but still accepted on those reports for shipped clients (music maps it to `listenedTotalMs`, audiobooks to `listenedDeltaMs`, video ignores it); the separate music replay protocol keeps its terminal `listenedMs`. Audiobook explicit deltas also advance the elapsed baseline, preventing mixed-report double counting.

- **Breaking:** library filters use `libraryGroupId`; webhook subscription arrays use
  `libraryGroupIds`; media-type allow-lists on continue-watching, feed and
  recommendations use `types`. Exact series search uses `types=series&match=exact`.
  Retired spellings have no aliases. Scalar type selectors, genre cardinality,
  conjunctive tag/keyword filters and episode-ordering group IDs are unchanged.

- **Web actions and playback lifecycle (breaking API change):** reactions now use PUT
  with `{emoji}` (204); access membership uses bodyless PUT and DELETE at
  `/access/groups/{id}/members/{userId}`. `DELETE /play-sessions/{id}` replaces
  POST `…/cancel` and revokes delivery without inventing playback progress. Preview
  renewal is POST `…/keepalive`; Live keepalive and DELETE are unchanged.
  Explicit recommendation, upcoming and internal taste/mood/editorial refreshes
  use POST `…/refresh`, returning their existing synchronous responses; GET no longer
  accepts `refresh`. Web incidents now use diagnostics events/resolve; the incident
  alias is removed. Dismissal resources and telemetry retain their distinct contracts.
  Web Live sessions renew delivery grants and dispose renewal with the session;
  playback follows issued timeline and keepalive hrefs. Existing operation IDs are
  preserved; `refreshRecommendations` and `refreshUpcoming` are new. No aliases.
  Refresh actions share a 30/minute user budget across surfaces and accept native JSON
  booleans/id arrays. Adding an unknown user to an access group returns 404.

- **Breaking (P6 playback negotiation):** use `clientInfo`, `maxVideoBitrateBps`, `audio.bitrateKbps`, preference/Live `maxBitrateBps`, Live requested/applied/rung `…Bps`, music `bitrateKbps`/`maxBitrateKbps`, and byte-route `startPositionSeconds`. Select subtitles by stable `subtitleId` (`"none"` disables); omitted tracks apply server preferences and start reports `applied`. Remove `forceTranscode` in favor of upgrade-only `requestedMethod`. Music capabilities and byte delivery share one decision and return actual codec/container/bitrate/method/reasons. Refusals expose stable codes and object details; foreign sessions return 404. Invalid file selectors and media-inapplicable controls are rejected. Fix subtitle codec alias burn-in and native multi-audio recommendation/availability disagreement. `/j` and Subsonic retain their own protocols. Requires the coordinated Apple client release.

- **Collections and sonic mixes (breaking API change):** Paginated collections use `items`
  and `page`, with `page.nextCursor` sent back as `cursor`. Sync snapshot `after`/`nextAfter`
  and response `page.cursor` are removed; sync changes keep their checkpoint on empty terminal
  pages. Mood tracks are now `items`. Comments reject `cursor` plus polling `since` and remove
  `before`; run `since` remains a time filter. `/music/sonic-mixes` replaces `/music/clusters`,
  `/index` replaces `compact`, mix tracks support offset/hasMore paging, and shuffle uses
  `bitrateKbps`. Existing sonic-mix operation IDs are preserved; `listSonicMixIndex` is new.
  No aliases. Requires matching native clients; bounded samples retain `truncated`.

- **Self resources and partial updates (breaking API change):** `GET /me` replaces
  `GET /user/profile`, `/me/stats` replaces `/stats/me`, and every published `/user/*`
  resource moves to `/me/*` with its suffix unchanged. The web's shared `/api/*` mounts
  move together. Playback preferences, watch state, task switches and playlist metadata
  now use PATCH with optional fields; omitted fields are preserved. Operation IDs stay
  unchanged. Old paths and PUT methods are removed without aliases. Webhook replacement
  remains POST and rotates its signing secret; password reset remains POST and revokes
  credentials. Administrative `/users/{id}` resources are unchanged. Ship with matching
  native clients.
- **Breaking: removed** `GET` and `POST /playback/{id}/info` on both `/api` and
  `/api/v1`. Use `POST /media/{id}/playability` to probe and `POST /play-sessions`
  for the playback start envelope. Jellyfin `/j/.../PlaybackInfo` is unchanged.

- **App privacy preferences:** stable `GET /api/v1/me/privacy` (`getMyPrivacy`) and
  `PATCH /api/v1/me/privacy` (`updateMyPrivacy`) let device tokens and PATs read/update
  their own privacy preferences using the authenticated-user policy. PATCH preserves omitted
  fields and rejects empty updates with 422. Audiobook sharing remains ineffective
  while playback is hidden; the web’s internal privacy route continues to work.

- **Playback API parity:** probes and starts accept `capabilities.hlsCopyReload` (default false) for native muxed copy HLS; video starts return `delivery.hlsAudioMode`, and subtitle ids match between probe and delivery.

- **Live TV proxy update checks:** the Live TV proxy reports a protocol number and a build id.
  Admin → System health → Cluster shows a notice when the proxy's code changed since its image
  ("Update the Live TV proxy image to …"), and the attention board raises a critical item when the
  proxy and the server no longer work together. A proxy image from before this release shows the
  notice once; update it to this release so later checks can tell. Each release's notes now say
  whether the proxy needs an update (`node scripts/livetv-proxy-changes.mjs <previous> <new>`).

- **HLS stream URLs are opaque in the API reference (breaking for generated clients):** the 11 Live TV
  stream operations (`streamLiveTvMaster`, `streamLiveTvSegment`, `streamLiveTvAdaptive*`,
  `streamLiveTvCapped*`, `streamLiveTvCompat*`) are replaced by one, `streamLiveTv`
  (`GET /livetv/channels/{id}/stream/{path}`), and `streamHlsManifestForAvPlayer` is no longer
  documented. Clients must use the URLs the playback-session start and the playlists give them and never
  build one. The stream URLs themselves and the server pipelines are unchanged.
- **API cleanup after the fresh-eyes test (breaking API change):** every `/api/v1` error is
  problem+json, including authentication failures (`invalid_token`, `invalid_grant`, and 403
  `ip_mismatch` when a playback URL is opened from another network address; start with
  `castTarget: true` for that) and unknown paths; only the OAuth device and token endpoints keep the
  RFC error shape. Playback start: `capabilities` is optional (documented default),
  `delivery.subtitles[]` is one list of ready `/api/v1` subtitle URLs, `delivery.timeline` is just
  `{href}`, `delivery.recommended` names the preselected tracks, the `grant` object is the same as
  the renew response, a transcoded audiobook is one HLS track and `hlsUrl` is gone. A grant ends with
  its playback session (`reason: session_ended`). Progress reports and their answers are camelCase
  (`positionMs`, `eventSeq`, `sessionElapsedMs`, `resumeAnchorAt`, `progressSaved`, `bitrateBps`,
  `bufferHealthMs`). Live TV start returns the shared envelope (`playbackSessionId`, `delivery.url`,
  and the keepalive cadence and href in `reporting.intervalMs` / `reporting.href`) and its paths use
  `{playbackSessionId}`.
  `GET /me` and `GET /server` share one `permissions` object (`canWatchLiveTv`,
  `canSeeAllPlayback`, …). Media detail and lists carry `durationMs` (probed file length) instead of
  `runtimeMinutes`/`details.runtime`; rich metadata lives once under `details`. `GET`/`POST /playback/{id}/info` have been removed. A track without lyrics answers 200
  `{lyrics: null}`. Music sections carry image descriptors. Titles starting with an article now sort
  by the word after it everywhere (migration 16.409.0 fills the missing sort keys).

- **API reference reorganised; every operationId renamed (breaking for generated clients):** the
  OpenAPI spec groups its tags into sections in the order a client needs them (Getting started,
  Library, Playback, Music, Audiobooks, Live TV, Your data, Social, Devices, Integrations,
  Administration; `x-tagGroups`), every operation sits in exactly one tag, and every operationId is
  a hand-picked verbNoun name (`getMediaItem`, `startPlaybackSession`, `listLiveTvStations`) that no
  longer changes with the path. Paths and payloads are unchanged. Every operation now carries an
  explicit stability label; the API guide's new "Stability and deprecation" section says what
  `stable`, `beta`, `experimental`, `protocol` and `deprecated` promise, and deprecated operations
  will answer with `Deprecation`, `Sunset` and `Link` headers. Operations with translated titles
  list the `Accept-Language` header. `POST/PATCH /api/v1/playback/incidents` left the public spec
  (use `/api/v1/diagnostics/events`). The `alpha` tier is gone (`experimental` covers it). Tier
  changes: now `stable` — playlist CRUD and entries, Live TV playback sessions, stations, guide,
  favourites and availability, the audiobook catalog, self-service device list/rename/revoke/push
  token/heartbeat, `GET /media`, `GET /browse/genres`, music album/artist/track lists and details;
  now `beta` — probe status, media viewers,
  keywords, the admin `/pats` routes, notification artwork and push content (was `experimental`);
  now `protocol` — the offline rendition file. Deprecated operations' `Deprecation`, `Sunset` and
  `Link` headers are readable cross-origin.
- **Music discovery API (breaking API change):** one stateless call answers "what plays next":
  `POST /music/recommendations` with the playing track, the session history and an optional mood,
  genre, artist or album seed returns `{next, alternatives, source}`; it replaces `GET /music/queue` and
  `/music/queue/bootstrap` (a mood seed alone is the cold start). Similarity is one route per entity,
  `GET /music/{tracks,albums,artists}/{id}/similar` (tracks take `basis=auto|metadata|sonic`); the
  `…/sonic-similar` routes are gone. Sonic mixes list at `GET /music/clusters` and their tracks at
  `GET /music/clusters/{id}/tracks` (no more `?cluster=`). Taste stations moved to
  `/user/music/taste-stations` and are addressed by a stored-safe `id` instead of a list position: an
  old id keeps playing the station it named, or answers 410 once that clustering expired, never a
  different station. Pinned genres, recently played, top tracks and top artists moved to `/user/music/…`.
  Bounded lists say `page.truncated`. `/server` reports `music.sonicSimilarity` and `music.sonicMixes`.
- **Integration tokens use the `integrations:read` grant (breaking API change):** service tokens
  take the grants `read`, `write`, `admin` or `integrations:read`. `integrations:read` is the
  credential for `GET /api/v1/integrations/watch-history`, `/upcoming` and `/homepage`: it must be
  the token's only grant, only an administrator can mint it, it works on those three endpoints and
  nowhere else (GET/HEAD only) and only while its owner is an administrator. An `admin` token bound to
  integration paths no longer opens watch-history or upcoming; the update converts each such existing
  token whose paths name only those three endpoints to `integrations:read` (a token bound to the
  whole `/api/v1/integrations` family, or sandboxed with `forceNonAdmin`, is left as it was). A
  service token's owner is now checked by user id, so renaming the owner keeps the token working and
  a new account under the old name gains nothing. `allowedIps` entries must be exact IPv4 or IPv6
  addresses (at most 32); CIDR ranges are rejected. IPv6 entries match in any spelling
  (`2001:DB8:0:0::1` matches `2001:db8::1`).
- **Live TV tells you why a channel will not play (breaking API change):** a failed
  `POST /livetv/playback-sessions` now answers a typed problem with one `code` (`channel_offline`,
  `provider_auth_failed`, `provider_connection_limit`, `provider_unreachable`, `geo_blocked`,
  `no_video`, `encoder_failed`, `all_feeds_failed`, `upstream_stalled`, plus `stream_limit` and
  `dependency_unavailable`), `retryable`, `retryAfterMs` and a `Retry-After` header. The old flat
  `Stream unavailable: <code>` 502 is gone. When the channel fails while playing, the next keepalive
  answers `410` with `reason: failed` and the same code, `GET /livetv/playback-sessions/{id}` shows
  `endReason: failed` with `failure`, and the HLS routes answer a typed `410`. Administrators also see
  which feed failed how (`feedsTried`). The recipe "Handle Live TV errors" in the API guide has the
  full table.
- **Live TV channel health:** Channel Management and Backup Groups show each feed as ok, failing or
  offline with the last failure reason and time (`health` in the admin channel and backup-group APIs),
  and `POST /livetv/admin/channels/{id}/health/reset` clears it. The new setting "Hide offline
  channels after failures" (`LIVETV_HIDE_OFFLINE_AFTER_FAILURES`, off by default) hides a channel from
  viewers' lineup, guide and search once every feed of it failed that many times in a row; it reappears
  after 6 hours and administrators always see all channels.
- **Breaking API change (smaller reworks):** public social actors are one `PublicAuthor`
  (`userId`, `displayName`, `images.primary` image descriptor) instead of login usernames. Personal access tokens move to
  `/user/pats` (ids are integers, revoke is `DELETE /{id}` with 204); service tokens take
  `actAsUserId` and report `owner`/`actAs`; devices are keyed by `deviceSessionId` with one
  `{items, page}` list for you and for admins (`/users/{userId}/devices/...`). Request dismissal is
  `POST /requests/{id}/dismissal` and requests carry a `dismissalKey`. Playlists: the detail is
  metadata only, entries are `{id, mediaId, position}`, adding takes `{mediaIds}` and reports each
  input, reordering sends the whole order with `expectedRevision`, the playback context takes
  `entryId`/`position`/`mediaId` and returns current/previous/next, and `/playlists/{id}/suggestions`
  is the only suggestions route. Viewers are paged `{items, page, me}`. `/series-notifications`
  becomes `/user/series-follows`. Limit-only lists report `truncated` instead of an unusable `hasMore`.
  The offline playback body is a typed record list. Update clients together with the server.

- **Titles without files follow the "show unavailable" settings everywhere:** "Similar",
  "Because you watched", list pages and an actor's "in my library" filter no longer show
  titles you don't have unless _Show unavailable titles_ is on, and search never returns a
  single missing episode as a result. Lumastra also stops storing such titles when nothing
  needs them: series you don't own get no season or episode rows, the release calendar adds
  no movie rows, and automatic suggestions add none while the discovery catalog is off.
- **Cleanup of titles that were never in your library:** a new daily task, _Remove Never-Owned
  Catalog Entries_, deletes movies and series that never had a file, that nothing references
  (ratings, watchlists, playlists, watch history, comments, mutes, lists, Live TV and more)
  and that discovery hasn't listed for 30 days (titles discovery still lists are kept, also after a single-title refresh). It only reports what it would delete until
  you switch on _Delete Never-Owned Catalog Entries_ in Admin → Settings → Tasks; check the
  task's last run first.
- **Recently added updates at once:** a title that gets its first file shows in "Recently
  added" right away in every web process, instead of up to five minutes later.
- **No more duplicate discovery titles:** two discovery syncs adding the same title at once
  could leave a copy without a TMDB id that never refreshed. The existing copies are removed
  by the new cleanup.

- **"New episodes available" shows only new releases:** the home banner lists newly aired
  episodes (last 30 days) of series you follow — two or more episodes watched, episode
  notifications switched on, or on your watchlist and started. A fulfilled request, a season
  pack or a newly added old series no longer shows its back catalogue there ("+11 more" of a
  2017 season); those stay in "Recently added" and "Your requests are ready". The card says
  "1 episode watched" instead of "1 episodes watched". `GET /api/v1/for-you/new-episodes`
  (internal) returns one card per series with `newEpisodes {count, watchedEpisodeCount,
followReason}`; its `refresh`/`debug` parameters are gone.
- **Upgrading to the dedicated worker and two Valkeys:** installs that still run one container
  that does web and background jobs, or a single Valkey, must change their compose file once.
  Add a second Valkey service for the disposable cache (`CACHE_URL`) and keep your existing
  Valkey as the task store (`TASK_CACHE_URL`). Keep its volume: queued jobs survive, but only if
  you switch the append-only file on in the RUNNING Valkey first. A Valkey that only saved
  snapshots (`dump.rdb`) and is restarted with `--appendonly yes` starts empty and ignores the
  snapshot. In this order: (1) on the existing Valkey, `valkey-cli CONFIG SET appendonly yes`
  and `CONFIG SET maxmemory-policy noeviction` (set `REDISCLI_AUTH` to the password instead of
  using `-a`); (2) wait until `INFO persistence` shows `aof_rewrite_in_progress:0` and
  `aof_last_bgrewrite_status:ok`; (3) only then add `--appendonly yes --maxmemory-policy
noeviction` to the container command and restart it. Remove `WORKER_MODE` and
  `DEDICATED_WORKER` from the web container and add one worker service with the command
  `./start-worker.sh`. Startup now refuses to run when the task Valkey is empty while Postgres
  still shows in-flight task state, and when it is not `noeviction` (override with
  `LUMASTRA_ALLOW_EVICTING_TASK_VALKEY=true`, not recommended); it warns when AOF is off. The
  web container logs an error and admins see a banner when no worker heartbeat is seen. The
  errors for a missing or equal `TASK_CACHE_URL` and for leftover worker variables say what to
  change and link the guide:
  https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys.
  The Docker example and the Helm chart already deploy both Valkeys and the worker. The example
  worker has `stop_grace_period: 90s` and the Live TV proxy gets `TASK_CACHE_URL`; the Kubernetes
  worker has `terminationGracePeriodSeconds: 120`, and the task Valkey no longer has a
  `--maxmemory` cap. In `deploy/k8s`, the cache Valkey is now `lumastra-valkey-cache` (it was
  `lumastra-valkey`): update `CACHE_URL` and delete the old StatefulSet and Service. The Helm
  chart accepts `valkey.auth.taskPasswordKey` and Compose `TASK_CACHE_PASSWORD` for a separate
  task Valkey password (letters, digits and `-._~` only; the URLs are not percent-encoded).
- **Task Valkey is the required one, the cache is optional:** `TASK_CACHE_URL` without a `/<db>`
  path now selects database 0 (it was 1), where single-Valkey installs kept their queues; the
  worker refuses to start when the queues (`bull:*`) sit in another database of the same Valkey
  and names the URL to use. An empty task Valkey while Postgres shows in-flight runs or task
  ownership stops the worker too (`LUMASTRA_ALLOW_EMPTY_TASK_VALKEY=true` accepts losing those
  runs once), and two URLs that reach the same server through different names are refused by
  `run_id`. The worker, executors and web container no longer fail or go unready when only the
  cache (`CACHE_URL`) is down or unset; it reconnects in the background, and
  `/api/health/ready` reports it (and worker presence) as detail only. All pub/sub (task cancel,
  config changes, auth-cache invalidation, Watch Together) runs on the task Valkey; a cancel
  whose message is lost is still picked up from Postgres on the next run heartbeat. Rate limits,
  token revocation markers, plugin sign-in transactions, Jellyfin direct-play tokens, device
  commands, Watch Together parties, per-session bandwidth and the preview kill switch moved from
  the evictable cache to the task Valkey, so memory pressure can no longer reset or revoke them.
  The Live TV proxy writes its heartbeat (Admin → Cluster) and failure reports there as well.
- **API contract fixes:** the public spec now agrees with the handlers. Playlist item routes use
  `{itemId}` (the URL is unchanged), `DELETE /access/groups/{id}/members` takes a `{userId}` body,
  and the OAuth device/token schemas include `device_id`, form-encoded bodies and the real error
  codes. `HEAD /oauth/device` is documented. `GET /user/profile` and `POST /users` return the user
  `id`. Operator endpoints (provider writes, library scan and paths, media rescan/sync/streams,
  playback capabilities/quality, radio station admin, `POST /lists`) are internal only. Stability
  labels: notifications inbox, OAuth, renditions, `watch-marker` and `browse/libraries` are
  stable; music artists/albums and listener radio are beta.
- **Breaking API change (catalog and discovery):** every list, rail, search hit, credit and
  upcoming row is one `MediaPreview` (`id` handle + `catalogId`, external-only `ids`, `images`
  descriptors, `progress`). New `GET /api/v1/media` (paged, sortable library listing) replaces
  `/browse/az` and `/browse/genre/{name}`; new `POST /api/v1/media/batch`; `GET /media/{id}`
  returns details, `credits.cast`/`crew` as people with `tmdb:N` handles; person routes take one
  handle; virtual seasons have `vseason:` handles; paged episode walk and
  `/series/{id}/seasons/{n}/episodes/{e}`; upcoming rows carry typed episode coordinates;
  bounded lists return `{items, truncated}`.
- **Breaking API change:** Live TV viewers address **stations** instead of the feed currently
  shown. `/livetv/channels` becomes `/livetv/stations` (list, detail, `feeds`, `programs`,
  `current-program`); favourites, simple mode (now `PATCH`, with `stationIds`, `startStationId`,
  `clearStartStation`), the guide (`stationIds`), programme search and the remote-control
  `livetv.tune` command use the station id, which stays the same when a feed is hidden or replaced.
  Starting a stream is an explicit `POST /livetv/playback-sessions` that returns a session id;
  keepalive and leave go by that id (`DELETE .../{sessionId}` or `POST .../leave`), and a `410`
  carries a typed `reason` (`evicted`, `superseded`, `expired`, `left`). Watch history is
  recorded once per accepted start, not on every manifest fetch. The HLS paths
  `/livetv/channels/{feedId}/stream/**` are unchanged.
- **Breaking API change:** Live TV guide reads follow one contract. Stations and station detail
  carry `nowNext {current, next}` instead of `currentProgram` / `nextProgram`; programmes are
  `airings` keyed by `stationId`; `GET /livetv/guide` returns an ordered `stations` list with
  `limit` + `cursor` paging and windows up to 24 h; station programs take explicit `from` / `to`
  (no `view` / `day`). A station uses one schedule (its shown feed, falling back to the next visible
  feed with guide data) so list, guide and detail agree.
- **Breaking API change:** `GET /livetv/programs/search` returns one item per airing (a
  `LiveTvAiring` keyed by `stationId`, plus `temporalStatus` and a `station` summary) with
  `limit` / `offset` paging, instead of results grouped by title with a `channels` list. It
  searches the same schedule the guide shows for a station, so a show appears once per station;
  group by title in the client to merge stations.
- **Breaking API change:** `GET /api/v1/server` replaces `/api/v1/config`, `/api/config`,
  `/api/v1/server/capabilities` and `/api/server/capabilities`. It provides public discovery
  and adds typed camelCase capabilities and caller permissions after sign-in.
- **Breaking API change:** every item response now carries one image set, `images`, with a ready
  descriptor per role (`poster`, `backdrop`, `logo`, `thumb`, `banner`, `primary`): `href`,
  size `variants`, `revision`, `source` and a blurhash `placeholder`. The server picks the
  fallback (an episode without a still shows the series backdrop, a track shows its album
  cover), so clients no longer build image URLs or walk parents. Replaces `images.still`,
  `imageId`, `posterUrl`, `logoUrl`, `ownerAvatarUrl`, `coverUrl` and the per-resource image
  shapes of movies, series, seasons, episodes, people, users, libraries, Live TV stations,
  audiobooks and playlists (music follows with its own DTO change). `?inherit=none` returns only
  an item's own images. Image URLs carry `v=<revision>`; only those are cached as `immutable`,
  and gated images (libraries, people, collages, radio) are cached privately.

> **Upgrading an install that signs in through forward auth (Authentik, Authelia,
> oauth2-proxy)? Add `FORWARD_AUTH_ENABLED=true` to your environment BEFORE you
> upgrade.** Forward auth is now off unless you turn it on; without the line nobody can
> sign in through the proxy (an install whose only sign-in method is forward auth refuses
> to start, with an error naming the setting). Helm: `auth.forwardAuth.enabled: true`
> renders it (chart 0.1.0-beta.4). Built-in login and OIDC installs need no change.
> `FORWARD_AUTH_ENABLED` can only be set in the environment: Admin → Settings shows it
> read-only, and a value saved in `settings.json` is ignored, with a warning in the
> startup log. If you turned forward auth on in Admin → Settings on a preview build, set
> the environment variable as well.

#### New

- Search Home’s What's On Now row by channel name, current programme or the single next programme.

- Image candidates retain their provider and source references across caching and metadata
  updates, with protected manual choices and provider-based selection.
- Music can prepare the next track without taking a playback slot until it starts playing.
- Album cover lookup now includes Deezer and normalized title searches, retries albums
  without covers, and can fall back to the album artist's picture.

- Admin album merges now preview track moves, duplicate candidates, album data and the resulting
  artist before confirmation, including albums that both contain files. All track IDs and files
  are preserved; metadata locks require an explicit override. The health check “Possible split
  albums” links matching folder/tag/artist pairs directly to their merge preview.

- **System load per host:** Admin → System health → Cluster now shows CPU, memory and GPU use
  for every host, including GPU engine use (video and render) and encoder sessions, measured on the
  host that does the encoding. The Sessions page keeps only playback figures and links there.

- **Pick up where another device left off:** a paused web player tab that you come back to
  follows what you watched elsewhere since: it jumps to the newer position, or to the next
  episode you moved on to on another device, while staying paused, and offers Undo. It only
  follows a continuous run of watching (resuming where you stopped, or starting the next
  episode after finishing one), not an episode you picked explicitly, not during a Watch
  Together party, and not once you acted in that tab after the other device moved on.
- **Download stall timeout:** a new setting, _Rendition Stall Timeout_ (Admin → Settings →
  Playback, Downloads & Bandwidth, `DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS`, default 600 s,
  minimum 30), sets how long a download encode may make no progress before it is stopped and retried.

- Probe before you play: `POST /api/v1/media/{id}/playability` returns a title's file versions with how each
  would play for your `capabilities` (play method, reasons, HDR, duration, size, audio and subtitle tracks),
  plus the resume position, watched flag and the audio and subtitle tracks the server recommends. It makes
  no session, grant or watch history and decides exactly as `POST /play-sessions` does with the same
  capabilities. The probe and start call replace the removed `GET`/`POST /playback/{id}/info` endpoints.

- Library sync for apps that keep a local copy of the library (offline apps, add-ons): `GET /api/v1/sync/changes`
  returns what was added, changed or removed since a cursor, with a `delete` for every removal, so a client
  no longer re-reads every list. Per-user state (watch state, listening counts, explicit ratings, watchlist,
  playlists) comes inline and only to its owner; movies, series, seasons, episodes, music and audiobooks are
  hydrated with the batch call. Changes are kept for 30 days; an older cursor, or a change in what you may
  see, answers `410` and the client reloads from `GET /sync/library` and `GET /sync/user-state`. Items that
  you cannot see never appear, and a file that is renamed or moved keeps its id, so it causes no churn.
- Live TV, Configure Lineup: pick any number of countries to keep (for example Germany,
  Austria, UK and US) instead of one region. The list shows every country the provider tags
  ("US:", "|BG|", "[DE]", or a section header such as "DE • Local"), plus Arabic, Ex-Yugoslav,
  Kurdish, religious and adult groups, with channel counts. Your browser languages pre-select
  the countries, and adult and religious channels are never pre-selected. You can also hide
  24/7 channels that loop one show, and hide single categories. The choices are saved: a
  re-import applies them again, and a refresh hides new channels they exclude. Upgrading
  adds a column to the Live TV sources table (migration 16.304.0).
- Live TV: channels are sorted into genres (Live Events, Sports, News, Movies, Series, Kids,
  Documentary, Music, Entertainment, General, Regional, Radio, Shopping, 24/7, Religious,
  Adult) read from the provider's sections in many languages, instead of one category per
  provider group. A 12,000-channel provider went from 179 categories to 35. On /livetv, a
  row of category chips shows one genre in the grid or the guide (`?genre=sports`); the
  last choice is remembered.
- Live TV: a family of numbered channels ("Live Event 1…10") opens a dialog with a guide of
  just those channels, instead of expanding in the page.
- Live TV: a playlist without channel ids (a bare `type=` link) gets a hint on the Sources
  tab to use the `m3u_plus` link or the Xtream login, which carry ids, groups and logos.
- Live TV, Channel Management handles lineups of 12,000+ channels: rows render in a window,
  category headers stay in view, a category rail jumps between categories, and disabled
  channels are hidden unless you turn on "Show hidden". Moving a feed also moves the hidden
  feeds of the same station along with it.
- Live TV, Backup Groups tab: search, filters (category, country, on air, problems) and sorting for
  large providers; "Make primary" picks the feed viewers see first; and a station can be taken
  off air or put back on air, one at a time or for every group the filter shows.
- Live TV: stable channel numbers. Every station gets a number that stays the same when you
  reorder channels or categories, refresh the playlist or re-import it, so a viewer who
  knows "News is 12" finds it there tomorrow on the iPhone channel pad, the TV apps and
  Jellyfin clients. All feeds of a station share one number; new channels get the next free
  number. In Channel Management, click a number to set your own (it is pinned), give a
  category a start number ("Numbers start at 100"), or "Renumber in current order". A
  hidden channel gives its number up unless you set it yourself or turn on "Keep numbers
  of hidden channels" (Admin → Settings → Live TV). Upgrading adds a table for the numbers
  and a column to the categories (migration 16.308.0); the first lineup read numbers the
  channels in their current order.

- The player tells you when the server's video encoder can't keep up ("The server's video
  encoder is busy (another app may be using it). Playback may pause to buffer."), for
  example when a game stream, OBS or NVIDIA instant replay shares the GPU encoder, or when
  the CPU is too slow for a software transcode. Admin → Users → Active sessions shows the
  same as "Encoder busy" / "CPU too slow". While the notice is up the player waits instead
  of reconnecting.
- When NVENC cannot open an encoder session (all sessions in use, driver too old, library
  missing), the transcode continues in software at the same size instead of failing, and the
  player says so.
- Update check: once a day Lumastra reads the list of releases from api.github.com and
  tells admins when a newer version is out (bell, admin home, and Admin → System →
  Instance, which also shows the running and the latest version). A release that fixes a
  security problem shows as a red notice that cannot be dismissed and stays until the
  install runs the fixed version (`:edge` and other development builds get the quiet notice); a normal update is a quiet notice you can dismiss per
  version. An admin who has checked that a security fix does not apply can mark it as
  reviewed on the Instance page (audited); it then shows as a normal update, and a later
  security release is red again. When the check has not reached GitHub for three days,
  admins get a quiet notice saying so. No token or information about the server is sent. Turn it off under Admin →
  Settings → General → Diagnostics ("Check for Lumastra updates").
- Episode reconciliation: every episode that the automatic reconciliation binds to a TMDB
  episode (and, for series numbered across seasons, moves into another season) is now
  recorded, and Admin → Library → Quarantine lists the recent ones with an Undo button.
  Undo puts the episode back where it was, restores its title and removes the TMDB id the
  reconciliation gave it; the next metadata sync recreates the episode it had been merged
  with, and the same match is not applied again.
- Anime episodes numbered across seasons: a file named `Show - S09E21 - 188 - Title` (Sonarr's
  anime format) or `S01E0422` now carries its absolute episode number, stored by the scanner.
  Reconciliation looks up the TMDB episode at that absolute position, and applies the match on
  its own only when the episode title in the file name agrees with that episode's TMDB name or
  alt names (TMDB orders some shows differently from Sonarr). A title that disagrees is left
  alone; a file without a usable title (`TBA`, `Episode 12`, the series name, language tags
  such as `GER-JAP`) is only proposed, in Admin → Library → Quarantine, unless two independent
  readings of the number (position in the catalog, and a season numbered across seasons) name
  the same episode. Nothing is moved when the position is unclear or already has a file. The
  absolute number must be a real season's (not a special's) and not smaller than the number
  inside the season. At most 50 episodes per series are moved per sync; the rest follow on the
  next sync. The setting "Auto-apply episode matches based on the file name"
  (`RECONCILE_AUTO_APPLY_FILENAME_MATCHES`, Admin → Settings → Metadata, advanced, on by default)
  turns the automatic apply off: such matches are then only proposed. Undo also restores the
  episode's still image and re-derives an empty title from the file name; watch state merged
  from the placeholder stays on the episode.

- First-run setup suggests your media folders. It looks under `/data`, `/media`, `/mnt` and
  similar mounts, also one level into a folder that holds several libraries (`/data/media`
  with `movies/`, `series/`, `music/`). Folders named like a library come with their type
  set and ticked, in English, German, French, Spanish, Portuguese, Italian, Dutch, Polish
  and Czech (`Filme`, `Séries`, `Películas`, `Seriály` and so on). Ticked folders are
  added when you continue. Folders for kids or documentaries are listed without a type;
  audiobook folders are not suggested, because audiobooks come from Audiobookshelf.
- First-run setup can connect Audiobookshelf on the library step: enter the server URL and
  an API key, and its book libraries are listed and added with the rest.
- Lumastra can run without contacting lumastra.org: turn off **Contact lumastra.org for the
  licence** in the setup wizard or in Admin → Settings → General → Licensing, or set
  `LICENSE_SERVER_CONTACT_ENABLED=false`. The install then makes no licence, renewal,
  check-in or push relay calls and runs on the free tier (Jellyfin apps limited to 2
  streams at a time, no AI assistant, no iPhone or Apple TV push through the standard
  relay, no branding removal). A new install makes its first call only after you have
  answered that question, so turning it off in the wizard means nothing was sent.
- When the first scan finished without a TMDB key (or with one TMDB rejected), the last
  setup screen takes the key and scans the libraries again.

#### Changed

- **Duplicate routes removed (API, breaking):** ratings live on one resource, `/media/{id}/rating`
  (`GET`, `PUT`, and now `DELETE` to clear). `DELETE /watch-state/{id}/rating` and the `rating` field of
  `PUT /watch-state/{id}` are gone; `GET /watch-state/{id}` still reports the rating. The cross-user
  `GET /pats`, `POST /pats` and `DELETE /pats/{id}` are gone from `/api/v1`; manage another user's tokens
  with `/users/{id}/pats` (the admin UI keeps its own route).

- **Live TV failure answers are plain problem+json (API, breaking):** a failed
  `POST /livetv/playback-sessions`, a keepalive `410` with `reason: failed` and the HLS `410` carry the
  usual `code`, `error`, `status` and `retryAfter` (seconds, also the `Retry-After` header) plus a
  `failure` object `{ retryable, feedsTried? }`. The top-level `retryable`, `retryAfterMs` and
  `feedsTried` members are gone. The `failure` block of `GET /livetv/playback-sessions/{id}` is unchanged.

- **Last snake_case names in the API are camelCase (API, breaking):** `GET/POST /media/{id}/renditions`
  and `GET /renditions/{renditionId}` answer `fileId`, `durationMs`, `sourceHeight`, `audioIndex`,
  `rungs[].videoBitrate`, `audioBitrate`, `estimatedSizeBytes`, `renditionId`, `progressPct`,
  `sizeBytes`, and `rungId` / `errorCode` on a rendition. The query parameters `online_only` and
  `watch_together` (`GET /devices`, `GET /users/{id}/devices`) are now `onlineOnly` and
  `watchTogether`, and `item_type` (`GET /playlists/{id}/items`) is `itemType`. The old names are
  ignored.

- **DELETE operations take no request body (API):** seven declared one copied from their
  `PUT`/`PATCH`/`POST` (`/webhooks/{id}`, `/access/groups/{id}`, `/playlists/{id}`,
  `/tasks/{taskId}/triggers`, `/devices/{id}`, `/user/notification-webhook`,
  `/user/music/tracks/{id}/feedback`) no longer do. `DELETE /media|people|playlists/{id}/reactions`
  names the emoji as `?emoji=` and `DELETE /for-you/dismiss` takes `targetId`, `targetType` and
  `flagType` as query parameters. `DELETE /watchlist` keeps its body.

- **Create operations no longer declare list or paging parameters (API):** `POST /requests`,
  `/playlists`, `/playlists/{id}/members`, `/media|people|playlists/{id}/comments`, `/user/pats`,
  `/media/{id}/renditions` and `/watch-together/{code}/events` took the `GET` query parameters in the
  spec and validated them. They no longer do; the `GET` keeps them.

- **`available` query alias removed (API):** `GET /recommendations` and `GET /trending` take
  `availableOnly=true` only; `available=` is ignored.

- **One playback start for every media kind.** `POST /play-sessions` now starts video, music
  and audiobooks and returns `{ playbackSessionId, mediaId, kind, delivery, grant, reporting }`
  with ready-to-use URLs. The play-session response no longer contains the unused
  `stream_token` JWT. Typed `capabilities` describe clients on playability probes and starts;
  `GET/POST /playback/{id}/info` has been removed.
- **Media URLs carry a scoped `?grant=`, never your account key.** A grant is bound to one item and
  one playback session, expires, and works only on media delivery URLs. `api_key` and
  `stream_token` query parameters are no longer accepted on `/api` and `/api/v1` media routes.
  The old `/playback/stream-tokens*`, `/music/stream-token` and `POST /audiobooks/session`
  endpoints are gone; manage grants with `/playback/grants/{id}` (`GET`, `DELETE`, `POST …/renew`).
  Players that cannot send headers (VLC, Kodi, cast receivers) only need the `delivery.url`.
  Update scripts that built media URLs with an API key. The web player and the Apple apps ship
  with this change.

- Playback read projections now share `progress { positionMs, durationMs, fraction, finished, updatedAt }` on continue-watching, feed watching items, audiobook search, watchlist movies/episodes, and series watch markers. Watchlist series counts use `episodeProgress { watched, total }`. Heartbeat acknowledgements rename `resume_anchor` to `resume_anchor_epoch_ms`.
- **Breaking Watch Together API changes.** Participants and hosts are identified by user UUID
  (`userId`), exposed through PublicAuthor (`userId`, nullable `displayName`, `images.primary`).
  Parties use `host`, participants flatten PublicAuthor, and person frames use `author`
  (`newHost` for host changes, `host` for party endings). Login usernames are never display-name fallbacks.
  The collection is `/watch-together/parties`; reads, create, join and connected return `party`.
  A party is created `unlisted` unless the request sends `visibility: "listed"`; `isPublic`
  is replaced by `visibility` everywhere (create, the `visibility` command, the
  `visibility_changed` frame, the party list). The command body at `POST /watch-together/{code}/events`
  is published as a 17-variant union on `type`, and every SSE frame has a named schema.
  `connected` carries `lastEventId`; a reconnect with an old or future `Last-Event-ID` gets a
  `resync` frame and re-reads the party. The duplicate current-party route is removed
  (use `GET /watch-together`). The Valkey keys are versioned to `watch:v2:*`, so running parties
  end on this upgrade and must be started again. No database migration.
- **Sharing is now off by default, including for existing installs that never chose.** New
  users start with streams hidden and listening and audiobook activity sharing off. Migration
  16.350.0 applies the same private state to existing users who never saved a privacy preference
  (`privacy_prefs_updated_at` is empty); users who saved any privacy setting keep their values.
  Operators keep the audience setting (`SOCIAL_DEFAULT_AUDIENCE`); users opt in under
  Settings -> Privacy. `GET /media/{id}/listening-sharing` now returns a sharing policy with
  `audience` and `blockedBy` reasons, and `effectiveShared` is true only when someone can
  actually see the activity.
- The global event stream documents every frame with a named schema, and webhooks have a
  catalogue: `GET /webhooks/events` lists the events that are delivered, subscriptions are
  validated against it (unknown event types now return 422), and the docs state the signature,
  retry schedule and at-least-once delivery rules.
- Audiobook API: authors, narrators and series are resources with stable ids (`/audiobooks/authors`,
  `/audiobooks/narrators`, `/audiobooks/series`, each with detail and a books list). `GET /audiobooks`
  replaces `/audiobooks/browse` and returns the shared preview item with the standard `page` block.
  Audiobook detail uses `{id, name}` people and series objects, milliseconds for every time, image
  descriptors and ISBN/ASIN in `ids`; `seriesName`, `seriesBooks`, `durationSeconds` and
  `resumePositionMs` are gone. The web app gains author, narrator and series pages.
- Music API durations now use integer `durationMs` / `totalDurationMs`; radio now-playing
  uses `durationMs` / `elapsedMs`. Saved web music queues are reset on upgrade.
- Music track, album and artist artwork now uses shared image descriptors under
  `images.primary`, with variants, revision and source. Track cover fallback points
  to the owning album; artist photos are never used as album or track covers.
- Music text search, lyrics search and similar-track results now report
  `page.truncated` instead of advertising `hasMore` without a continuation request.
- **Breaking Tasks/Runs API changes** (both `/api/v1` and `/api`): task, run and
  task-failure lists now return `{ items, page }`. Read continuation from `page.cursor`
  and failure counts from `page.total`; task lists remain unpaged. Task/run detail
  responses stay flat and now have typed models. Task path parameters and generated
  operation IDs use `taskId`, with `itemId` for failed items; concrete URLs stay the same.
  `GET/PUT /tasks/{taskId}/schedule` is removed: configure cadence through `/triggers`
  and pause/resume separately through `/state`. Trigger writes do not resume paused
  tasks. Grouped runs move from `/runs?groupBy=task` to the internal `/runs/groups`
  projection, also returning `{ items, page }`. Retained public Tasks/Runs operations
  are beta; `/scheduler` is internal/beta with its URL and authorization preserved.
  Queue controls, execution behavior and SSE protocols are unchanged.

- **Playback timeline API (breaking, before 0.1).** `GET /playback/{id}/chapters` is now
  `GET /playback/{id}/timeline`: chapters, skip segments and trickplay variants for the selected
  file, all in milliseconds, with the resolved `fileId` echoed and ready chapter-image hrefs. The
  trickplay manifest is JSON with sheet hrefs (the `X-Trickplay-*` headers are gone), skip segments
  are stored per file (migration 16.360.0), subtitle tracks list only the selected file's sidecars and
  carry ready hrefs, and rendered-subtitle rects carry a ready `href`. Admin chapter and segment
  responses use `startMs`/`endMs`.
- The example `docker-compose.yml` has a commented media line on the `lumastra` service, and
  the README quick start says to set it; without a media mount the setup wizard finds no
  folders.
- Setup wizard: the install check notices a GPU passed in by Docker Desktop on Windows
  (`gpus: all`), and the hardware step's switch takes effect right away, without a restart.
- Existing album titles are cleaned of scene tags once on upgrade ("Sucker WEB" → "Sucker",
  "Gimme More (Promo CDS)" → "Gimme More"); albums that become identical are merged, with their
  tracks and user data.
- API responses no longer include Jellyfin item ids: `externalIds.jellyfin` / `ids.jellyfin`,
  `jellyfin_id`, `jellyfinId` and `jellyfinSeriesId` are gone from catalogue, search,
  recommendations, watching, playlist, watchlist and request responses. Use the internal id
  (`id` / `ids.internal`) everywhere. Season ids are the internal season ids. An older client
  that still sends a Jellyfin item id it got earlier (as a media id, `?jellyfinId=`, or a
  `jellyfin` key in `externalIds`) is mapped to the right item through the ids Jellyfin sync
  stores; a Jellyfin id never creates an item and never appears in a response. Search results for
  Kavita books carry the Kavita id in `ids.kavita` and AudiobookShelf books in
  `ids.audiobookshelf`.
- Music and integration settings now show credits and links for the metadata providers
  behind their information.
- Licensing: an install with a valid key now checks in with lumastra.org about once a
  week (not only near the key's expiry), sending its install ID, its Lumastra version and
  the status code. A failed check-in changes nothing; the key stays until it expires.
  lumastra.org keeps pseudonymised counts (a keyed hash of the install ID, no IP address). Turn
  the check-in off under Admin → Settings → General → Diagnostics ("Weekly licence check-in"),
  or on the setup wizard's settings step; licence renewal is not affected. See
  [What Lumastra sends where](https://lumastra.org/reference/data-flows/).
- Tasks: a run you start by hand (Admin → Tasks, the API or a service token) of a task
  that supports it (Media Segment Repair, Reconciliation Backfill, Metadata Aggregation
  Backfill, Bulk Metadata Sync) continues in a new run after a
  restart or deploy instead of failing, from where it stopped. Admin → Runs labels it
  "Resumed after restart (n/3)". It is resumed at most 3 times, only after a clean
  shutdown (never after a crash), never once you cancelled it, and not again when it
  ran less than 15 minutes since its last resume. Scheduled runs are unchanged.
- Admin sidebar: the current section lists its pages under its row, and the other
  sections open theirs with a chevron (remembered per admin). The tab row above the
  page is gone while the full sidebar shows. Settings opens its pages as a grouped
  panel beside the row, and on the collapsed rail every section does, on hover or
  keyboard focus. A page with an open problem gets its own status dot. The mega-menu
  style and the phone drawer are unchanged.
- Episode reconciliation: a match that rests only on episode numbers lining up (an episode
  without an identity and an unplayed episode of the TMDB catalog in another season, in a
  series whose releases are numbered across seasons) is no longer applied on its own. It
  appears as a proposal under Admin → Library → Quarantine, and dismissing the proposal keeps it from coming
  back. The new setting "Auto-apply episode matches based on numbers alone"
  (`RECONCILE_AUTO_APPLY_NUMBER_MATCHES`, Admin → Settings → Metadata, advanced) is off by default;
  turn it on to keep the earlier behaviour. An install that never chose a value gets the new default.
  Binding an episode, merging its placeholder and moving it now happen together or not at all.

- First-run setup recommends single sign-on (OIDC, or forward auth when your proxy already
  sends an identity) instead of built-in login, which stays one click away. The step after
  creating the admin says the page is optional and only shows services that are down, and
  the setup texts are plainer.
- Settings now take effect without a restart: a Jellyfin server connected after the first
  start (also on the worker of a split install), a changed `GPU_ACCELERATION` or device
  path (the hardware encoder is probed again), and MDBList or Last.fm keys, whose tasks
  start right away instead of up to 12 hours later.
- The unused OMDb key is no longer shown in the settings, and OMDb is no longer credited
  as a metadata source.
- Subtitle renderers updated: PGS subtitles no longer freeze in Safari or stay blank until a
  seek when the graphics backend starts late, and very large or malformed subtitle files
  are capped (32 MiB) instead of using unbounded memory.

#### Security

- The sign-in form and the setup wizard's account, single sign-on and library forms (and the
  change-password dialog) always send their data in the request body. Before, a form sent
  before the page had finished loading put the username and password in the address, and
  so into the browser history and proxy logs.
- Quick Connect approvals and Watch Together client identities are bound to the signed-in
  participant. Authentication and rate limits now consistently use the trusted peer and
  canonical account identity.
- Private activity stays hidden on annotations and reviews, and playlist suggestions
  require accepted membership. Subsonic album information respects library access.
- Stream-proxy redirects and playlists check upstream destinations, local artwork reads
  remain inside their library, and catalogue identifiers cannot alter upstream paths.
- Search highlights and diagnostic logs no longer expose unsafe markup or malformed
  connection credentials. Kubernetes application pods no longer mount cluster credentials.
- Hover and trailer previews ignored the age limit of age-restricted accounts: such a user
  could start a preview of a title rated above their limit. Previews now check library
  access and age rating like playback does.
- A device token from the OAuth device flow (the Apple TV and iPhone apps, third-party
  clients) could create a personal access token with more rights than it had itself: an
  admin's device token could create an admin token, and a read-only device token a
  read-write one. A new token now gets only scopes the credential that creates it holds.
- `GET /api/v1/watch-together/parties?includePrivate=true` listed private watch parties
  to an admin's device token (Apple TV and iPhone apps, third-party clients) and to an
  admin's personal access token without the admin scope: it checked whether the account
  was an admin, not whether the token carries admin rights. The same check let such a
  token skip the content-access check on music collages, downloads and artwork while the
  database was unreachable, and made `GET /api/v1/user/profile` report `isAdmin: true`.
  API endpoints now decide admin rights on the token, like the admin API does, and a lint
  rule keeps it that way. The other places that read the account's flag were not
  reachable with a token.
- Forward auth is opt-in. The identity headers (`USERHEADER`, `GROUPHEADER`,
  `NAMEHEADER`) are read only with `FORWARD_AUTH_ENABLED=true` and only from peers in
  `TRUSTED_PROXY_IPS`. Before, any peer in `TRUSTED_PROXY_IPS` was believed whatever
  sign-in method you chose, so an install that set `TRUSTED_PROXY_IPS` only for real
  client IPs, behind a proxy that does not strip these headers, let anyone send
  `X-Forwarded-User: <admin>` and be signed in as that admin. With forward auth off, such
  headers are ignored and logged at most once every 10 minutes (without their values);
  `npm run doctor`, the admin health banner and the security self-check warn about
  them. Client-IP handling through `TRUSTED_PROXY_IPS` is unchanged. The setup wizard
  says when your proxy sends identity headers while forward auth is off.
- `FORWARD_AUTH_ENABLED` is environment-only, like `TRUSTED_PROXY_IPS`. An admin
  account can no longer turn header sign-in on from Admin → Settings.
- `npm run doctor`, the admin config check, the security self-check and the setup
  wizard warn when `TRUSTED_PROXY_IPS` contains an IPv4 range wider than `/24` (or an
  IPv6 range, which matches nothing). Every device in such a range can choose its
  client IP and, with forward auth on, sign in as any user. On Kubernetes the finding is
  informational, since the chart's NetworkPolicy limits who reaches the app.
- A signed-in user who is not an admin could read the data behind admin pages (settings,
  cost, instance, client diagnostics, the audit log, other users' listening data) by
  requesting the page's `__data.json` directly. Every request under `/admin` now needs an
  admin, whatever form it takes.
- With forward auth on, `/api/v1` requests sent as `/api/%76%31/…` (percent-encoded) or
  with a language prefix (`/de/api/v1/…`) were signed in from the identity headers,
  which `/api/v1` otherwise ignores because reverse proxies usually skip sign-in there.
  Behind a proxy that does not strip those headers on its `/api/v1` route, anyone could
  call the API as any user. Requests are now classified by the route they reach.
- Pages now apply the same access rules as the API: a home-video, personal, training or
  educational series (and its episode list in the player) is hidden from users without
  access to its library or above their age rating, and series pages no longer show
  server file paths. A playlist invite opens the playlist only once accepted, and
  private playlists answer like missing ones. The Watch Together join page hides parties
  for items you cannot watch and counts misses against the join limit. The music home
  page's radio row applies age ratings.
- Visitors who are not signed in (the sign-in, setup and error pages) no longer receive
  the admin-configured navigation links, installed plugin widgets or library types.
  Navigation links limited to groups are only sent to members of those groups.
- A file in a library could run script in another user's browser: an MKV attachment
  tagged `text/html`, or an SVG poster or cover the server could not convert, opened as a
  page on Lumastra's own address. Any response that is not a page now carries a sandbox
  Content-Security-Policy unless its type is one browsers never run (images other than
  SVG, audio, video, JSON, playlists, subtitles, plain text).
- A signed-in user could make Lumastra call other Jellyfin or Audiobookshelf endpoints
  with the server's API key, and read the answer, through a crafted image id
  (`/api/image/jellyfin:…`, `/api/image/audiobook/…`). Ids are now sent as a single
  path segment in every request to an integration, and Jellyfin ids are validated.
- A symbolic link placed in a library could make Lumastra read files outside it, such as
  the encryption key, through lyrics, trickplay images or ignore files, and files written
  next to media followed such links. Sidecar files must now resolve inside a library;
  media links to another mount (debrid, rclone) still work but never into the config,
  system or app directories; writes replace a link instead of following it.
- Crafted content could keep the server busy for seconds to hours: a pattern in a
  `.lumastraignore` file, a subtitle or NFO file, long audio tags, an M3U or XMLTV feed,
  AniDB data, or a long search term. These parsers now run in linear time and their input
  is capped (subtitle and NFO files at 10 MiB, Live TV playlists at 64 MiB and guides at
  100 MiB, search terms at 200 characters).
- `POST /j/Users/AuthenticateWithQuickConnect` read request bodies up to 50 MB without
  sign-in or a rate limit. Request bodies read outside the API framework (Jellyfin-app
  endpoints, OAuth, setup) are now capped, and QuickConnect sign-in is rate-limited.
- FFmpeg and ffprobe now accept only media formats when they open a library file for
  subtitles, thumbnails, trickplay, downloads or music transcodes, as playback already
  did. A `%` in a file name no longer redirects thumbnail output. Live TV allows RTP/UDP
  only for RTSP sources. Progressive transcodes for Jellyfin apps respect
  `FFMPEG_MAX_JOBS_PER_USER`.
- AI assistant: in a shared chat room (the shoutbox bot) other people's messages could
  steer the asker's personal tools, and the answer was posted to the room. Shared rooms
  now get catalogue tools only and no personal context. Links in replies can no longer
  carry extra attributes, tool calls per message are capped, prompt-cache tokens count
  toward the daily budget, and plugins calling the assistant share the chat's rate limit.
  Library titles in home-page row headings are escaped.
- The Docker image runs Node.js 24 LTS (Node 25 stopped receiving security updates on
  2026-06-01) and picks up Ubuntu security updates every week. The example compose file
  drops all Linux capabilities and blocks privilege escalation.
- Device tokens that hold only the read-only `media:read` scope can no longer change anything: their
  writes to `/api/v1` answer 403 `scope_insufficient`. The shipped apps request the full `media` scope
  and are not affected. A service token whose stored scopes are all unknown is rejected, and a non-admin
  with token-admin rights can no longer list or revoke an administrator's personal access tokens.
- Creating and deleting personal access tokens, linking and unlinking accounts, the notification webhook,
  data reset, "sign out everywhere" and device-control grants now need a signed-in browser session. API
  tokens get 403 `session_required` for them, so an app token can no longer create long-lived tokens or
  grant device control that would outlive the app's connection.

#### Fixed

- Show the full placeholder in Home’s Live TV search field.
- Keep Home responsive with large Live TV lineups by revealing channel cards in small batches.
- Preserve fullscreen when web playback advances to another episode, and correct distorted seek previews on partial trickplay sprite sheets.
- Show a season as available when all its aired episodes are present.

- Live TV status responses preserve FFmpeg decisions and terminal failure details.
- Playback bitrate reporting preserves MKV metadata and excludes manifest peak allowances.
- Collaboration reviews show saved feedback immediately and skip expensive fingerprint work for unreviewed artists.
- TMDB transport errors retain safe network cause codes for diagnosing connection failures.
- Live TV keeps media intact when paced readers apply backpressure, and restores upstream timeout handling after a pause.
- Playback keeps the episode position when switching windowed files, and the web player aligns its feed control correctly.
- Admin collaboration reviews handle dismissed and resolved credits safely; audio tail checks account for timestamp rounding.
- Preserve selected artwork, manual choices and enrichment attribution when upgrading
  legacy image records. Detect same-path cover replacements, keep image cache versions
  consistent with served bytes, and prevent stale repair or cleanup work from removing
  a newer image. Local cached artwork now reads its source to verify content identity.

- Sync quarantine can recheck decisions that are already applied, closing only exact,
  unchanged identity/title matches. Remaining changes use reviewed batches with explicit
  dependency and provider-binding checks, retained results and continuation controls.
- Missing-file retention rechecks files before cleanup and preserves artist records that
  still own usable music.
- The homepage's live active-stream refresh uses the same data and display rules as its
  initial load.

- Bound analysis FFmpeg decoder and filter threads to two by default. Limit the intro
  analyzer to one run across the cluster and one visual decode at a time (including 4K),
  and back off timed-out intro/credits analysis for 30 minutes.
  Existing 320px/5fps black-frame sampling is preserved. Unset analysis thread settings now
  use two; explicit zero still enables FFmpeg auto-threading. Episode preparation now
  defaults to two concurrent items instead of four.
- Expose cgroup anonymous/file/cache/shared/slab/dirty memory counters in cluster metrics
  and memory breakdown logs, use the same working set for host-pressure diagnostics, and
  retain a one-minute child-process RSS peak in the cluster view.
- Stop transcodes when playback sessions end, time out, or are replaced, including jobs on other
  pods. Progress polling no longer keeps ended jobs alive, and the idle sweep removes jobs whose
  playback sessions have ended or disappeared.
- Web playback waits and retries when a playability probe is rate limited, respecting `Retry-After` instead of immediately showing ‘Playback isn't available’. The read-only probe budget is now 240 requests/minute/user (previously 60), shared across titles and versions. Playback start and grant renewal limits are unchanged.

- **Pod restarts no longer log playback errors:** when a server pod shuts down, the HLS and music
  transcodes it stops are no longer treated as crashes (no restart, no error log), and requests
  interrupted by the shutdown get `503` with `Retry-After` so players retry on the other pod.
- **Audiobooks page with single sign-on:** the audiobooks page no longer shows "Couldn't load
  audiobooks" when you sign in through a single sign-on proxy.
- **GPU usage on Intel Arc hosts:** GPU use is read from the actual GPU instead of the virtual
  display adapter, so Intel Arc usage shows up at all.

- **Downloads that hang:** a stuck download encode is stopped by a stall watchdog and retried. Two
  encoders can no longer write the same partial file, a late encoder can no longer change a download
  that is already ready, interrupted attempts are removed by the database cleanup task, and the
  download cache is trimmed even when another cleanup step fails.
- **Hardware encoder stalls:** when the GPU encoder stops responding, the transcode retries once on
  the CPU instead of failing.
- **Seeking during a transcode restart:** a timeout from an older transcode no longer ends playback
  when a newer transcode is already serving the video.
- **Watch Together names:** a member without a display name shows as "Someone" in party
  notifications instead of an empty name.
- **Merging duplicate series during cleanup:** the cleanup task no longer hides a season that has
  files, skips a merge when the clashing episode has watch progress or other user data, and merges
  a series without a year only when exactly one title matches.
- **Cleanup no longer deletes live work:** the music transcode cache keeps files that are still
  being written (unfinished files go after one hour; `MUSIC_TRANSCODE_PARTIAL_TIMEOUT_S` no longer
  controls this), and the startup transcode sweep and the upload cleanup leave live or restorable
  work alone. Upload cleanup only touches folders Lumastra created.
- **Web player audio and subtitles:** the web player now plans playback for the audio track you
  picked, keeps a 10-bit HEVC file on a path your browser can actually decode, burns in picture
  subtitles after a fallback to a re-encoded stream, and no longer reloads the scrub preview and
  chapter markers every few minutes. A file without audio ignores a stale audio choice.

- iPhone, iPad and Apple TV apps: subtitles show again after resuming from Continue
  Watching or after a long seek. The stream that starts mid-title carried timestamps that
  began near zero, so every subtitle was due minutes later than its line.
- Artist posters and other provider images no longer turn into placeholders while the
  provider's image server refuses requests for a while (Deezer does this in bursts). The
  last copy keeps being shown until a refetch works. An image the provider removed (404 or 410) still disappears.
- Helm: `persistence.appCache` keeps `/app/.cache` (artwork, extracted subtitles, library
  backdrops) on a volume shared by the web and worker pods. Without it, every restart empties
  the cache. The default `auto` (chart 0.1.0-beta.9) turns it on in mode `allInOne`; in mode
  `split` set `enabled: true` when you have ReadWriteMany storage or one node. Docker Compose
  already keeps it.
- Subtitles in the iPhone and iPad apps no longer stay blank for a stretch of a video
  that was opened while its subtitles were still being extracted.
- Some videos with very short keyframe intervals failed to play ("410") in the
  segment-exact playback mode, and a server restart during playback could switch a title
  back to the older segmenting.
- Live TV: HEVC channels (for example UHD channels) play in Safari, in the iPhone, iPad and
  Apple TV apps, and in browsers without HEVC support. Safari and the apps get the same video
  in fMP4 segments, which Apple's players need for HEVC. Firefox, and Chrome without hardware
  HEVC, get an H.264 version (HDR converted to SDR), which takes one encoder slot. Viewers
  whose browser plays HEVC still get the original stream.
- Live TV: a channel group whose main feed was hidden by Configure Lineup disappeared from
  /livetv. It now shows through its first visible feed, and Configure Lineup keeps the
  main feed.
- Live TV, Channel Management: channels matched to the guide by name show as matched
  instead of "Unmatched".
- Live TV: the guide match prefers the guide entry of the channel's own country ("DMAX" in a
  German section gets the German DMAX), and a channel whose tvg-id is a guide id always gets
  that guide, even when several stations' feeds share the id.
- Live TV: the feeds of one station are grouped however the provider spells the name
  ("Nick Jr." and "Nick Jr", "Sky Sport-F1" and "Sky Sport F1"), while names that only differ
  by a "+" stay apart.
- Live TV: saving the channel order of a large lineup failed with "Failed to save channel
  order" (the request was larger than the server allowed).
- Live TV: genre chips and channel logos only load images through Lumastra, never straight
  from the provider's servers.
- Music: an album whose cover is a GIF, TIFF or AVIF image gets the cover converted to PNG
  instead of failing artwork enrichment for good.
- Music: with artwork stored next to the media files, albums whose files are gone no longer
  fail artwork enrichment five times and end up as errors in the task list. They are set
  aside and enriched once a file is back.
- Videos in Safari on an iPhone or iPad start quickly again. Before, iOS could request the
  first segment over and over for up to a minute, or fail. Safari on these devices now gets
  the audio as a separate stream, and subtitles are added once the video has loaded.
- Closing the player no longer records a playback error ("MediaError 4") and no longer
  checks the session on the way out.
- HLS segments of a playback session are no longer cached by the browser for an hour.
- The web player no longer saves "muted" as your setting when it had to start muted because
  the browser blocked autoplay with sound. On an iPhone or iPad it always starts with sound; a
  blocked autoplay shows the play button instead.
- Live TV: a playlist with more than about 6,500 channels imports again. The import failed
  with "MAX_PARAMETERS_EXCEEDED" and the source still showed as refreshed with 0 channels; a
  failed channel import now shows as failed on the source.
- Live TV with large providers: the TV guide import no longer stalls the worker (it was
  restarted by its health check on a 12,000-channel source), starts only after the channel
  import has finished, and shows its progress on the source. Deleting or re-importing a large
  source no longer takes minutes, and the viewer channel list loads in milliseconds instead of
  seconds. The Sources tab no longer gets stuck on "Loading sources" when the last import
  reported the same warning twice.
- Live TV with large providers: the provider's section headers ("✦●✦ DE • Local RAW ✦●✦")
  are no longer imported as channels, "HDraw", "Cable", "HD+", "(Transcoded)" and "(Mobil)"
  feeds are grouped with the other qualities of a channel (a transcoded or mobile feed is
  never the one shown while a normal feed exists), every quality of a channel gets its guide
  and logo when one of them has it, a refresh no longer stalls the worker on a 12,000-channel source,
  and /livetv renders large lineups in steps instead of all at once. Re-import a source to
  apply this to its existing channels.
- Faster queries for music artist browsing, mood rows, artist-credit cleanup and duplicate series
  cleanup, and the MyAnimeList watch sync no longer runs one database query per list entry.
  Upgrading adds 51 indexes (migration 16.303.0); writes to the affected tables wait for a few
  seconds while the first upgraded instance starts.
- Episode files named the British way ("Show_Series_2_-_03._Title.mp4", as iPlayer
  downloads are) land in their own season and episode. They were all filed under episode 2
  of season 1. An OVA numbered in the file name ("Show.OVA.01.mkv") is now read as that
  episode instead of being refused.
- New episodes, the anime shelf and movie search now work without Jellyfin: they no longer
  depend on Jellyfin item ids, so a library without Jellyfin shows new episodes of the
  series you watch and finds playable movies by name.
- Without Jellyfin sync, the admin status page no longer calls Jellyfin, and an unknown
  32-character image id is no longer looked up as a Jellyfin item. The admin "Test connection"
  button still tests a Jellyfin server before sync is turned on.
- Audio and subtitle tracks share one scrolling list. The menu grows with the available
  player and viewport height, and keeps search and subtitle appearance controls accessible.
- Mobile episode and season pickers no longer clip their options or trap scrolling.
- Music playback cards show crossfades correctly, and cancelling playback in a Jellyfin
  app stops further progressive transcode chunks.
- Stream diagnostics no longer flag healthy bridge streams as stalled. Clearing confirmed
  transcode failures preserves the exact cutoff time and selected scope.
- Private API documentation uses the correct fallback and caching rules. Subsonic
  requests with unsupported method names are handled safely.
- Licence clocks now start at the current time, and existing clocks stuck near 1970 are
  repaired so grace periods and key expiry work correctly.
- When every transcode slot (`LUMASTRA_MAX_CONCURRENT_TRANSCODES`) was busy, pressing play
  stopped someone else's video mid-episode, and that viewer's player restarting could stop
  the next one in turn. The server now only stops a stream nobody has played or loaded for
  2 minutes (`LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS`, Admin → Settings → Playback,
  advanced; 0 brings back the old behaviour). If every stream is still being watched, the
  new one is refused with 503 and `Retry-After` and the player tries again; the same
  retryable refusal applies when system load triggers load shedding. Restarting
  your own stream of the same title replaces your old one, and a preview never holds a
  slot against someone pressing play.
- With more than one web instance, a signed-out or revoked device could keep working for up
  to a minute on an instance that had started while Valkey was unreachable, or whose Valkey
  connection had dropped: that instance missed the sign-out message and trusted its cached
  answer. Such an instance now keeps retrying its Valkey subscription, checks each device
  against the database (at most every 5 seconds) until it is subscribed again, and shows the
  state as `authCacheBus` under Admin → System → Health. After such a gap it also drops its
  cached admin, account, age-limit and token permissions, which the missed messages may have
  changed.
- Linking a MyAnimeList account through `/oauth/links/mal/callback` always ended with an
  error, because that callback never saw who was signed in. It now uses your browser
  sign-in (built-in account, OIDC or forward auth). The Helm chart (0.1.0-beta.7) sends
  `/oauth/links/` through the identity provider even though the rest of `/oauth/`
  bypasses it (`router.forwardAuth.oauthLinksPassthrough`); with your own proxy, keep
  `/oauth/links/` behind forward auth.
- Tasks: the stale-run sweep no longer fails a run whose worker is still alive but late
  writing its heartbeat to the database. The check for the worker's live run state never
  matched, so such runs were marked failed and released their slot. A worker that really
  died now has its runs reclaimed when that live state expires (about 15 minutes) instead
  of after 5; a clean shutdown still releases them at once.
- Picture-based subtitles (PGS, VobSub) and styled ASS subtitles no longer drift by a few
  seconds after you resume or seek in a video that plays without re-encoding its picture
  (for example in Firefox). The server now cuts such videos on their own keyframes and
  lists exact segment times, so the player's timeline matches the file. Turn it off with
  `HLS_COPY_GOP_SEGMENTS=false` if this playback misbehaves.
- Signing in with a built-in account over plain HTTP from another device on the local
  network (`http://<server-ip>:3000`) works. The session cookie was always marked
  `Secure`, so the browser dropped it and the sign-in did nothing. Cookies stay `Secure`
  on HTTPS, and with `ORIGIN` set to an `https` address they are `Secure` on every
  request. OIDC sign-in over plain HTTP needs `ORIGIN` set to that `http://` address.
- Behind Caddy or Traefik, an upload refused as too large (or any request answered before
  its body was read) no longer makes the next request on that connection fail with a 502.
  The uploader gets a clean 413 instead of a connection reset.
- The library dialogs no longer offer an Audiobooks library from a local folder, which
  imported nothing. Audiobooks come from Audiobookshelf; the API now refuses a local
  audiobook library with an error that says so.
- Transcoded videos no longer repeat or stall in their last moment. When a file's audio
  ran a few milliseconds past its last video frame, the playlist ended with a tiny extra
  segment that the server answered with a copy of the one before. A segment past the end
  now answers 404.
- Episode reconciliation no longer moves the second half of a merged two-part episode into
  an unaired later season. A pair that cannot be completed (the target position is taken,
  the episode was locked meanwhile) is skipped without leaving a half-applied change behind.
- Adding a TMDB key after a scan without one now identifies the existing movies, series and
  episodes in place. Before, series stayed unidentified and movies were added a second time
  next to the hidden file-name items.
- A film kept in two libraries (for example `movies/` and `kids/`) is no longer listed twice
  after it is matched, and the scan no longer logs a database error for it.
- File names with a year in parentheses from 1880 on (`(1896)`) get a clean title and the
  year. Episode titles taken from file names drop a trailing source tag (`- DVD`), and
  `[tmdbid-…]` or `{tvdb-…}` tags in series folder names no longer show up in titles.
- Opening Lumastra in a second browser tab no longer stops the music playing in the first tab (it used
  to stop it after the next seek). A new tab no longer adds autoplay tracks to the queue while autoplay
  is off.
- Library scans skip unchanged multi-episode files (such as `S01E03-E04`) whose episodes all have their
  own files, so a scan with no changes is much faster. A hard link or symlink to a file the library
  already has is no longer added a second time by the watcher. Migration 16.408.0 indexes the lookups
  behind these checks.
- A multi-episode file and the single file of one of its episodes, scanned at the same time, could both
  stay linked to that episode. The link is now decided under a lock per episode, and a dedicated file
  takes the episode back from a range file that held it.
- A file that holds two episodes (such as `S01E03-E04`) started the second episode at the first one's
  start. Migration 16.410.0 recomputes the affected files.
- Episode lengths agree across the API: the next-episode answer reports the same length as the episode
  itself (it was rounded to whole seconds in some places).
- Skip-intro was never detected for a new show or season that arrived in one scan, because a season whose
  files were still settling was marked as analysed. Such seasons are fingerprinted once they settle, and
  films now get intro and credits markers automatically.
- Episode thumbnails failed on read-only libraries, every episode on every cycle. Generated frames are
  now stored in the app's metadata folder when the library folder cannot be written.
- Faster imports: a new video file is read by ffprobe once instead of up to five times, and its media
  probe is no longer queued twice. Migration 16.407.0 stores the file's stamp with its chapters, so
  unchanged chapters are reused.
- Ratings you give movies, series, albums and books now reach sync clients (offline apps and add-ons).
  Before, ratings in the middle of the scale were never sent. Migration 16.411.0 makes the existing
  ratings sync as well.
- A music session that the server closed after a crash counts its real listening time again. Audiobook
  listening time sent to Audiobookshelf is no longer inflated for apps that do not report how long they
  listened.
