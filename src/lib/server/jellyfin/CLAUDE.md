# jellyfin/

Jellyfin media server API client for authentication, media queries, series, and playback.

## Files

| File                        | What                                                      | When to read                             |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| `auth.service.ts`           | Jellyfin authentication service (login, token management) | Authenticating users with Jellyfin       |
| `base-client.ts`            | Base HTTP client for Jellyfin API requests                | Understanding Jellyfin API communication |
| `index.ts`                  | Jellyfin module exports                                   | Importing Jellyfin services              |
| `media.service.ts`          | Media item queries (movies, episodes, details)            | Fetching media metadata from Jellyfin    |
| `playback.service.ts`       | Playback session management (start, progress, stop)       | Managing playback state with Jellyfin    |
| `series.service.ts`         | Series, season, and episode queries                       | Fetching TV series data from Jellyfin    |
| `user.service.ts`           | Jellyfin user management (profiles, settings)             | Managing Jellyfin user accounts          |
| `watch-progress.service.ts` | Watch progress reporting (resume points, completion)      | Tracking or updating watch progress      |

## Subdirectories

| Directory | What                          | When to read                           |
| --------- | ----------------------------- | -------------------------------------- |
| `types/`  | Jellyfin API type definitions | Understanding Jellyfin data structures |
| `utils/`  | Jellyfin-specific utilities   | Using Jellyfin helper functions        |

## Runtime gate

Calls to a Jellyfin server that bypass the axios client (direct `fetch`, image downloads, metadata
fallbacks) must check `canCallJellyfin()` from `runtime-gate.ts` first. It is true only when Jellyfin
sync is enabled, the connection is established and the circuit breaker allows requests. Use
`JELLYFIN_DIRECT_FETCH_TIMEOUT_MS` for the timeout and report transport failures with
`recordJellyfinTransportFailure(err)` so the shared breaker sees them. Without the gate, a configured
URL and key alone make every uncached request wait for a timeout when the server is gone.
