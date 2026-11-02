# server/

Server-side application code — database, services, AI, caching, auth, and external integrations.

## Files

| File                             | What                                                                      | When to read                                                 |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `audiobookshelf.ts`              | Audiobookshelf API client                                                 | Integrating audiobook features                               |
| `auth.ts`                        | Authentication utilities                                                  | Implementing auth logic                                      |
| `auth.test.ts`                   | Auth utility tests                                                        | Verifying auth behavior                                      |
| `config.ts`                      | Server configuration (environment variables, feature flags)               | Adding config options or reading settings                    |
| `dev-user.ts`                    | Development mode user bypass                                              | Debugging auth in dev mode                                   |
| `jellyfin.ts`                    | Jellyfin server connection setup                                          | Configuring Jellyfin integration                             |
| `jellyseerr.ts`                  | Jellyseerr (media requests) API client                                    | Implementing request features                                |
| `utils/playlist-utils.ts`        | Playlist visibility/role gates (`getUserRole`, `getPlaylistContext`)      | ANY playlist read/write route — use before query             |
| `runtime-optimizations.ts`       | Runtime performance optimizations                                         | Optimizing server performance                                |
| `utils/search-access-context.ts` | `buildSearchAccessContext` + `scopedCacheKey`; bundles library/age/livetv | Any search/aggregation route — pass to helpers, key caches   |
| `utils/resolve-and-gate.ts`      | `resolveAndGate(externalIds, mediaType, user)` for mutation routes        | Rating/watchlist/music writes — resolves IDs + checks access |
| `utils/pagination.ts`            | `parsePagination(url, opts)` — clamped limit/offset                       | Any paginated API route — never hand-roll `Number.parseInt`  |
| `sonarr.ts`                      | Sonarr (TV management) API client                                         | Implementing TV management features                          |
| `transformers.ts`                | Data transformers for API responses                                       | Converting data for API responses                            |
| `transformers.test.ts`           | Transformer tests                                                         | Verifying transformation logic                               |
| `types.ts`                       | Shared server-side type definitions                                       | Using server-side types                                      |

## Subdirectories

| Directory     | What                                                     | When to read                             |
| ------------- | -------------------------------------------------------- | ---------------------------------------- |
| `ai/`         | AI embeddings, recommendations, metadata sync (34 files) | Implementing AI features                 |
| `cache/`      | Unified caching layer with Valkey and LRU (8 files)      | Implementing caching logic               |
| `caches/`     | Legacy cache implementations                             | Working with legacy cache code           |
| `config/`     | Additional server config modules                         | Reading extended configuration           |
| `database/`   | Database connection, migrations, query modules           | Working with database                    |
| `handlers/`   | HLS streaming request handlers (3 files)                 | Implementing HLS streaming               |
| `jellyfin/`   | Jellyfin API client services (12 files)                  | Integrating Jellyfin features            |
| `middleware/` | Request middleware (auth, validation, rate limiting)     | Adding request processing logic          |
| `oauth/`      | OAuth 2.0, PAT, service tokens, JWT (15 files)           | Implementing OAuth features              |
| `plugins/`    | Unified plugin system (runtime, scheduler, registry)     | Building plugin features                 |
| `providers/`  | Thin shim: core types + TMDB client (old system deleted) | Importing `MediaType`, `ExternalIdWrite` |
| `routes/`     | Server route utilities                                   | Building API routes                      |
| `services/`   | Business logic services (50 files)                       | Implementing business logic              |
| `utils/`      | Server utility functions (55 files)                      | Using server utilities                   |

## API def request body size (`EndpointDef.request.maxBodyBytes`)

`mount()` (`api/mount.ts`) caps every def's declared `request.body` at 256 KB by
default (`readRequestBody()`), rejecting an over-cap `Content-Length` with `413
payload_too_large` before touching the body stream, and aborting a streamed read
mid-buffer if a missing/lying `Content-Length` lets an oversized body through
anyway. Set an explicit `request.maxBodyBytes` on a def whose legitimate bodies
exceed 256 KB (measure the real worst case — see `playlists/[id]/items/bulk.ts`
and `watched/series-set-progress.ts` for examples) — do not raise it
defensively "just in case".

A def with **no** `request.body` schema (multipart `formData()` uploads —
`admin/upload/[libraryPathId]/ancillary.ts`, `admin/media/[id]/images/index.ts`,
`users/[id]/images/[role].ts` — and a handful of defs that validate their body
in-handler, e.g. `library/ingest.ts`) never goes through `readRequestBody()` at
all and keeps adapter-node's much larger `BODY_SIZE_LIMIT` ceiling; a def that
validates in-handler needs its OWN size guard if it is reachable without a prior
size bound (see `library/ingest.ts`'s `MAX_INGEST_BODY_BYTES`).

## Config defaults

- **Changing a setting's default changes installs that never chose a value.** `saveConfig`
  (`config/config.service.ts`) removes a key from `settings.json` when the value equals the schema
  default, so an admin who picked the old default in the UI stored nothing, and the new default
  applies to them too. Only an environment variable or a value that differed from the old default
  survives. Say so in the commit message and the operator docs for every default flip.
