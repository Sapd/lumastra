# services/

Business logic services — transactions, multi-table writes, external coordination.

## Files

| File                                           | What                                                    | When to read                               |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `activity-feed.service.ts`                     | Activity feed logic                                     | Building activity features                 |
| `activity-feed.service.test.ts`                | Activity feed tests                                     | Testing activity logic                     |
| `availability.service.ts`                      | Media availability checking                             | Implementing availability checks           |
| `bandwidth-tracker.service.ts`                 | Bandwidth usage tracking                                | Monitoring bandwidth                       |
| `cast-crew.service.ts`                         | Cast and crew data service                              | Managing cast and crew data                |
| `catalog.service.ts`                           | Media catalog CRUD (composite key enforcement)          | Creating or updating catalog items         |
| `cluster-heartbeat.service.ts`                 | Replica heartbeat registration and transition detection | Monitoring cluster node state              |
| `connection-status.service.ts`                 | Server connection health monitoring                     | Checking server connectivity               |
| `data-normalization.service.ts`                | Data normalization for API responses                    | Normalizing API data                       |
| `data-normalization.service.test.ts`           | Data normalization tests                                | Testing normalization logic                |
| `database.service.ts`                          | Database service layer                                  | Using database service abstraction         |
| `dismiss.service.ts`                           | Recommendation dismissal logic                          | Implementing dismiss functionality         |
| `embedding-operations.service.ts`              | Embedding CRUD operations                               | Managing AI embeddings                     |
| `episode-ordering.service.ts`                  | Episode ordering logic                                  | Implementing episode ordering              |
| `episode-ordering.service.test.ts`             | Episode ordering unit tests                             | Testing ordering logic                     |
| `episode-ordering.service.integration.test.ts` | Episode ordering integration tests                      | Testing ordering with database             |
| `ffmpeg-transcode.service.ts`                  | FFmpeg transcoding orchestration                        | Implementing transcoding                   |
| `ffmpeg-transcode.service.test.ts`             | FFmpeg transcode tests                                  | Testing transcoding logic                  |
| `for-you.service.ts`                           | For-You page data aggregation                           | Building For-You page                      |
| `genre.service.ts`                             | Genre management                                        | Managing genres                            |
| `genre.service.test.ts`                        | Genre tests                                             | Testing genre logic                        |
| `jellyfin-user-id-resolver.ts`                 | Resolves Jellyfin user IDs from Valkey cache            | Implementing Jellyfin user ID lookups      |
| `jellyfin-user-id-resolver.test.ts`            | Jellyfin user ID resolver tests                         | Testing Jellyfin user ID resolution        |
| `mdblist-api.ts`                               | MDBList external API client                             | Integrating MDBList                        |
| `media-aggregation.service.ts`                 | Media data aggregation                                  | Aggregating media data                     |
| `media-id-resolver.ts`                         | Media ID resolution between providers                   | Resolving cross-provider IDs               |
| `media-id-resolver.integration.test.ts`        | Media ID resolver integration tests                     | Testing ID resolution with real DB         |
| `media-id-resolver.types.ts`                   | Media ID resolver types                                 | Using resolver types                       |
| `media-segments.service.ts`                    | Intro/outro segment data fetching and storage           | Implementing skip-intro/outro features     |
| `media-segments.service.test.ts`               | Media segments service tests                            | Testing segment logic                      |
| `media-transformer.service.ts`                 | Transforms raw DB rows to API response shapes           | Converting DB media rows to API responses  |
| `metadata-matching.service.ts`                 | Fuzzy metadata matching between providers               | Implementing metadata reconciliation       |
| `metadata-matching.service.test.ts`            | Metadata matching tests                                 | Testing matching logic                     |
| `mood-vector-seeds.ts`                         | Mood vector seed data                                   | Using mood-based recommendations           |
| `mood-vector.service.ts`                       | Mood-based recommendation vectors                       | Implementing mood features                 |
| `new-episodes.service.ts`                      | "New episodes available" banner + watching-strip items  | Detecting new episodes                     |
| `new-release-rule.ts`                          | The pure new-release rule (follow, window, bulk import) | Changing what counts as a new episode      |
| `personal-stats.service.ts`                    | Personal viewing statistics                             | Building stats features                    |
| `play-session-device.service.ts`               | Play session device management                          | Managing device-linked play sessions       |
| `play-session-events.service.ts`               | Play session event processing                           | Handling playback events (start/stop/seek) |
| `play-sessions.service.ts`                     | Play session CRUD and lifecycle management              | Managing active play sessions              |
| `playback-telemetry.service.ts`                | Playback telemetry collection                           | Collecting playback metrics                |
| `preview-session.service.ts`                   | Preview session management                              | Managing preview sessions                  |
| `provider-resolution.service.ts`               | Provider ID resolution                                  | Resolving provider IDs                     |
| `sessions-cache.service.ts`                    | Active sessions caching                                 | Caching session data                       |
| `sessions-cache.service.test.ts`               | Sessions cache tests                                    | Testing session caching logic              |
| `stream-token.service.ts`                      | Stream token generation and validation                  | Implementing stream URL authentication     |
| `suggestion-engine.service.ts`                 | AI suggestion generation and management                 | Building AI recommendations                |
| `suggestion-engine.service.test.ts`            | Suggestion engine tests                                 | Testing suggestion generation              |
| `subtitle-cache.service.ts`                    | Subtitle file caching                                   | Caching subtitles                          |
| `../providers/implementations/tmdb/client.ts`  | TMDB REST API client                                    | Fetching TMDB movie/TV metadata            |
| `transcode-job-persistence.service.ts`         | Transcoding job persistence                             | Persisting transcode jobs                  |
| `transcoding-cache-tracker.ts`                 | Transcoding cache tracking                              | Tracking transcode cache                   |
| `user-profile.service.ts`                      | User profile management                                 | Managing user profiles                     |
| `user-ratings.service.ts`                      | User rating operations                                  | Managing ratings                           |
| `watch-history.service.ts`                     | Bridge from play_sessions to watch_history              | Recording completed sessions               |
| `watch-manager.service.ts`                     | Unified watch state API (merged WatchState)             | Managing watch state                       |
| `watch-together.service.ts`                    | Watch party session management                          | Building watch party features              |
| `watched-cache.service.ts`                     | Watched status caching                                  | Caching watch status                       |
| `watchlist-manager.service.ts`                 | Watchlist add/remove with cache invalidation            | Managing user watchlist                    |
| `play-session-lifecycle.service.ts`            | Unified session fan-out (heartbeat/stop)                | Session state changes                      |
| `media-deletion.service.ts`                    | Cascade media deletion (hard/soft/merge)                | Deleting media items                       |
| `media-lifecycle.service.ts`                   | Post-mutation hooks (cache, embeddings)                 | After media create/update/delete           |
| `rating-manager.service.ts`                    | Rating with AI pipeline + cache invalidation            | Recording user ratings                     |
| `playlist-item-manager.service.ts`             | Playlist mutations with transactions                    | Adding/removing playlist items             |

## Subdirectories

| Directory         | What                                                   | When to read                      |
| ----------------- | ------------------------------------------------------ | --------------------------------- |
| `cache/`          | Cache service utilities                                | Building cache features           |
| `image-proxy/`    | Centralized image proxy service (5 files + providers/) | Implementing image handling       |
| `request-status/` | Jellyseerr request status state machine (14 files)     | Managing request status           |
| `transcoding/`    | Video transcoding pipeline (26 files + profiles/)      | Implementing transcoding features |
