# tests/

Playwright E2E and API tests, plus integration test infrastructure for Lumastra.

Before you write a spec or an integration test, read `docs/dev/testing-traps.md`: it lists the ways tests
pass or fail for the wrong reason (hydration waits, CSRF on body-less requests, mock pitfalls, env
differences between a local `.env` and CI).

## Files

| File                                      | What                                                            | When to read                                          |
| ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `admin-users.api.spec.ts`                 | Admin user management API tests                                 | Testing admin user endpoints                          |
| `api-tokens.api.spec.ts`                  | API token CRUD and authentication tests                         | Testing token generation, validation, revocation      |
| `authorization-security.api.spec.ts`      | Authorization and security boundary tests                       | Testing user isolation, permission enforcement        |
| `for-you-provider-agnostic.api.spec.ts`   | For-You endpoints with provider-agnostic IDs                    | Testing recommendations with TMDB/composite keys      |
| `global-setup.ts`                         | Playwright global setup — seeds test DB and Valkey              | Configuring test environment, adding test media items |
| `global-teardown.ts`                      | Playwright global teardown                                      | Cleaning up after Playwright tests                    |
| `hls-transcoding.api.spec.ts`             | HLS transcoding API tests                                       | Testing video transcoding endpoints                   |
| `provider-agnostic.api.spec.ts`           | Provider-agnostic media identification tests                    | Testing TMDB composite key (provider_id, media_type)  |
| `lumastra-playback-modes.api.spec.ts`     | Lumastra local playback mode API tests (direct/remux/transcode) | Testing local FFmpeg playback paths                   |
| `lumastra-playback.ui.spec.ts`            | Lumastra playback UI tests                                      | Testing lumastra player UI flows                      |
| `play-session-progress.api.spec.ts`       | Play-session progress + combined-file completion API tests      | Testing PUT /api/play-sessions/{id}                   |
| `streaming-sessions-security.api.spec.ts` | Streaming session security tests                                | Testing session isolation and authorization           |
| `streaming-sessions.api.spec.ts`          | Streaming session lifecycle tests                               | Testing session creation, updates, completion         |

## Subdirectories

| Directory      | What                                                        | When to read                         |
| -------------- | ----------------------------------------------------------- | ------------------------------------ |
| `fixtures/`    | Static test assets (test-video.mp4)                         | Referencing fixture files in tests   |
| `integration/` | Vitest integration tests against a real PostgreSQL database | Writing or running integration tests |

## Real Live TV E2E

`tests/livetv/` belongs only to `tests/playwright/playwright.livetv.config.ts` / `npm run test:e2e:livetv`.
The default Playwright config must keep excluding it. Read `docs/dev/livetv-e2e.md` before
changing it: it starts a real strict one-slot provider and standalone stream proxy, uses real
M3U/XMLTV import tasks and v1 PATs, and decodes app-served segments. No player hooks or route
mocks are needed. Keep workers enabled or the admin import API only queues work that never runs.
Use a fresh PAT per API test: the credential fingerprints form viewer keys, so reusing one leaks
120-second eviction guards between scenarios. Browser identities need separate contexts/cookie jars.
