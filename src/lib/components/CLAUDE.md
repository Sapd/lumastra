# components/

Reusable UI components organized by feature domain.

## Files

| File                                           | What                                                                                      | When to read                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `MediaCarousel.svelte`                         | Horizontal media carousel                                                                 | Implementing media carousels, scrollable lists |
| `AIRatingButton.svelte`                        | AI-powered rating button (kept — used by ModalActions, MovieSidebar, DetailedRatingPanel) | Implementing AI rating features                |
| `ActivityChart.svelte`                         | Activity chart visualization                                                              | Displaying activity statistics                 |
| `CustomActivityChart.svelte`                   | Customizable activity chart                                                               | Implementing custom activity charts            |
| `PopularMediaStats.svelte`                     | Popular media statistics display                                                          | Displaying popularity metrics                  |
| `NewEpisodeBanner.svelte`                      | New episode notification banner                                                           | Implementing new episode alerts                |
| `ai-assistant/AiAssistant.svelte` | AI Assistant component wrapper                                                            | Implementing AI assistant features             |
| `RequestModal.svelte`                          | Media request modal                                                                       | Implementing media request features            |
| `RequestNotificationWidget.svelte`             | Request notification widget                                                               | Displaying request notifications               |
| `SeasonSelectorModal.svelte`                   | Season selection modal                                                                    | Implementing season selection                  |
| `SimilarMoviesModal.svelte`                    | Similar movies modal                                                                      | Displaying similar content                     |
| `WatchParties.svelte`                          | Watch party overview component                                                            | Displaying watch parties                       |
| `TableOfContents.svelte`                       | Table of contents component                                                               | Implementing TOC navigation                    |

## Subdirectories

| Directory        | What                                                                       | When to read                                 |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| `ui/`            | Generic UI components                                                      | Implementing reusable UI elements            |
| `media/`         | Media display components                                                   | Displaying media items, cards                |
| `sections/`      | Section layout components (SectionRenderer, StandardSection)               | Implementing page sections, server-driven UI |
| `modal/`         | Modal dialog components                                                    | Implementing modal dialogs                   |
| `player/`        | Video player components (controls, trickplay)                              | Implementing video player features           |
| `playlist/`      | Playlist components                                                        | Implementing playlist features               |
| `search/`        | Search components                                                          | Implementing search features                 |
| `browse/`        | Browse/category components                                                 | Implementing browse pages                    |
| `foryou/`        | For-You section components                                                 | Implementing personalized recommendations    |
| `stats/`         | Statistics components                                                      | Implementing statistics displays             |
| `calendar/`      | Calendar components                                                        | Implementing calendar features               |
| `activity-feed/` | Activity feed components                                                   | Implementing activity feeds                  |
| `ai/`            | AI feature components                                                      | Implementing AI features                     |
| `admin/`         | Admin panel components (embeddings, navigation, playback, settings, stats) | Implementing admin features                  |
| `plugins/`       | Plugin UI components (holidays)                                            | Implementing plugin features                 |

## Svelte 5 traps

- **An `$effect` that resets state and then calls a loader can loop.** In
  `$effect(() => { rows = []; void load(); })`, if `load()` reads `rows` (or any other `$state`)
  before its first `await`, the effect tracks and writes it and ends in `effect_update_depth_exceeded`;
  a "load more" control that reads its own page size snaps back to page one for the same reason. Read
  the trigger props into locals first (`const id = taskId`), then run the resets and the `load()` call
  inside `untrack(() => ...)`. A component test shows it as a timeout with the Svelte error in the log.
