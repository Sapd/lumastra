# utils/

Client-side utility functions — data extraction, formatting, media helpers, UI utilities.

## Files

| File                         | What                                                                                  | When to read                             |
| ---------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------- |
| `data-extraction.ts`         | Type-safe data extraction (isRecord, toString, toNumberOr, parseInteger, extractBody) | Parsing API responses, extracting data   |
| `runtime-validation.ts`      | Runtime assertion helpers (assertDefined, requireValue, validateCallback)             | Adding runtime checks, validation        |
| `media-types.ts`             | Client-side media type comparison (isMovie, isSeries, isEpisode)                      | Comparing media types, type guards       |
| `media-display.ts`           | Media display formatting                                                              | Formatting media metadata for display    |
| `media-id-helpers.ts`        | Media ID parsing and construction                                                     | Parsing/constructing media IDs           |
| `date-formatting.ts`         | Date/time formatting helpers                                                          | Formatting dates, times                  |
| `time-formatting.ts`         | Duration/time formatting                                                              | Formatting durations, runtime            |
| `metric-formatters.ts`       | Statistics metric formatting                                                          | Formatting numbers, metrics              |
| `metric-styles.ts`           | Metric display styling                                                                | Styling metric displays                  |
| `image-utils.ts`             | Image URL/size utilities                                                              | Generating image URLs, sizing            |
| `external-ids.ts`            | External ID utilities                                                                 | Handling TMDB/IMDB IDs                   |
| `modal-data.ts`              | Modal data preparation                                                                | Preparing data for modals                |
| `modal-utils.ts`             | Modal utility functions                                                               | Implementing modal features              |
| `similar-prefetch.ts`        | Warms a detail modal's Similar row on hover intent                                    | Changing card/popup hover prefetch       |
| `browse-transformers.ts`     | Browse data transformers                                                              | Transforming browse data                 |
| `hero-builder.ts`            | Hero section builder                                                                  | Building hero sections                   |
| `hero-refresh-controller.ts` | Hero image rotation                                                                   | Implementing hero rotation               |
| `cache-utils.ts`             | Client-side cache helpers                                                             | Implementing client caching              |
| `request-utils.ts`           | Media request utilities                                                               | Handling media requests                  |
| `notification-logic.ts`      | Notification business logic                                                           | Implementing notification features       |
| `assistant-utils.ts`         | AI Assistant message utilities                                                        | Implementing AI assistant features       |
| `time-period.ts`             | Time period calculations                                                              | Calculating time periods, ranges         |
| `ui-state.ts`                | UI state management                                                                   | Managing UI state                        |
| `task-phases.ts`             | Admin task phase definitions                                                          | Implementing admin task UI               |
| `video-player-utils.ts`      | Video player helper functions                                                         | Implementing video player features       |
| `media-session.ts`           | MediaSession API integration                                                          | Implementing media session controls      |
| `background-playback.ts`     | Background audio playback                                                             | Implementing background audio            |
| `wake-lock.ts`               | Screen wake lock management                                                           | Preventing screen sleep during playback  |
| `favicon-controller.ts`      | Dynamic favicon management                                                            | Updating favicon dynamically             |
| `document-title.ts`          | Tab-title override that survives navigation (music player)                            | Painting over a page's `<title>`         |
| `now-playing-title.ts`       | Formats the music player's `▶ Song · Artist` tab title                                | Changing what the tab says while playing |
| `icon-map.ts`                | Icon name mapping                                                                     | Mapping icon names to components         |
| `click-outside.ts`           | Click outside directive                                                               | Implementing click-outside behavior      |
| `drag-scroll.ts`             | Drag-to-scroll behavior                                                               | Implementing drag scrolling              |
| `scroll-restoration.ts`      | Back/Forward scroll restore for the app-shell scroller (`.main-content`)              | Scroll lost/wrong after navigation       |
| `event-helpers.ts`           | DOM event helper functions                                                            | Handling DOM events                      |
| `popup.ts`                   | Popup positioning                                                                     | Positioning popups, tooltips             |
| `worker-timer.ts`            | Web worker timer                                                                      | Implementing background timers           |

## Subdirectories

| Directory | What                      | When to read                 |
| --------- | ------------------------- | ---------------------------- |
| `admin/`  | Admin page utilities      | Implementing admin features  |
| `search/` | Search-specific utilities | Implementing search features |

## Traps

- **Do not call `invalidate()` while a navigation is still finishing** (for example from the teardown
  of a component destroyed inside a `goto()`). SvelteKit takes over the router's navigation token,
  the in-flight navigation returns early without resetting the `navigating` store, the progress bar
  stays on screen for the rest of the session, and the invalidation is dropped. Use
  `invalidateWhenIdle` (`invalidate-when-idle.ts`), which waits until the navigation settles.
