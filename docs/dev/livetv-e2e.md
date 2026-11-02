<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Real Live TV E2E

`playwright.livetv.config.ts` runs the actual application, import tasks, PostgreSQL/Valkey,
standalone stream proxy and generated H.264/AAC provider. No network route, player or provider
API is mocked. The generated media and guide have no third-party recordings or show titles.
This is a contributor test harness, not a deployment guide.

## Run on the remote runner

From `warp10-dashboard/` in the current checkout:

```sh
lumastra-remote --slot livetv-e2e 'npm run test:e2e:livetv'
# Optional subsets (each still seeds and cleans up its own provider/source):
lumastra-remote --slot livetv-e2e 'npm run test:e2e:livetv -- --grep "VLC-style"'
lumastra-remote --slot livetv-e2e 'npm run test:e2e:livetv -- livetv-e2e.ui.spec.ts'
```

The runner must provision its slot's migrated test database and isolated Valkey database,
Node dependencies, Chromium plus its system libraries, and FFmpeg/ffprobe. Its pinned
`FFMPEG_PATH`/`FFPROBE_PATH` are honoured. If Chromium is missing, install it **on the runner**
with `npx playwright install chromium` (system library installation may need runner admin
access). Missing FFmpeg or ffprobe skips all tests with an explicit prerequisite message;
it does not substitute canned media. Missing codecs, DB/cache, broken imports or proxy
failures are errors, not skips.

The harness refuses a `DATABASE_URL` whose database name is not `lumastra_t_<slot>` or
`lumastra_tests`, before starting the app. Never point it at a shared development, preprod or
production database. The harness upserts three `livetv-e2e-*` identity rows, resets their
simple-mode settings, revokes their previous harness PATs and deletes previous sources named
`Live TV E2E synthetic…`. Each test mints fresh read/write PATs (admin also gets admin scope).
The actual admin source API creates and imports the source; source creation queues M3U import
and its EPG child task. The worker process must stay enabled. A missing enqueue result triggers an explicit
import API call; setup polls stations and guide for up to three minutes per phase.

Source teardown deletes its channels and guide through the admin API, revokes per-test tokens,
and stops the synthetic provider and its children. Test identities remain for bootstrap reuse.
Interrupted runs are reconciled next run. Active sessions are explicitly left where possible;
closed UI tabs can require the viewer timeout before the slot disappears. Tests run sequentially,
with one worker and no retries. Do not run two copies against the same slot/cache concurrently.

The ordinary `playwright.config.ts` excludes `tests/livetv/**`; the npm script selects the dedicated
config. Tests are tagged `@livetv` in their describe titles. Nothing is added to a default test run.

## Processes, ports and artifacts

| Process  | Startup and configuration                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App      | Default: Vite via `vite.wt-e2e.config.ts` (watch/HMR disabled), port 5198; forward auth explicitly on and restricted to loopback; no implicit dev admin |
| Proxy    | The Rust proxy (`npm run build:proxy`, then `build/lumastra-livetv-proxy --serve`). Port 5199, own webServer entry; `/status` is its health URL         |
| Worker   | `node scripts/dev-worker.mjs` (dedicated task worker, native watcher), health on port 5197 (`LIVETV_E2E_WORKER_PORT`)                                   |
| Provider | Global setup spawns `node scripts/livetv-testsource/server.mjs`, random port, waits for readiness JSON                                                  |

The proxy is a **separate process**, not started by `npm run dev`. Its listen port is `PORT`,
not `STREAM_PROXY_PORT`. `STREAM_PROXY_URL` is set on the app; the two processes must share
`STREAM_PROXY_SECRET`. The proxy needs its own `LIVETV_ALLOW_PRIVATE_URLS`, FFmpeg paths,
`LIVETV_VIEWER_TIMEOUT_SECONDS=12`, `LIVETV_GRACE_PERIOD_SECONDS=2`,
`LIVETV_ORPHAN_CHECK_INTERVAL_SECONDS=1`, `LIVETV_HEALTH_CHECK_INTERVAL_SECONDS=1` and
`LIVETV_DEGRADED_FAILOVER_SECONDS=5` (the failure specs; the proxy defaults are 3 s and 60 s,
the latter only matters for stalls without a classified reason); it does not read the app's persisted admin settings.
`HLS_TEMP_DIR` is a writable directory unique to this run's app port. GPU use and outbound
provider proxies are disabled for determinism. Both processes inherit the runner's DB/cache URLs.

Use `LIVETV_E2E_PORT` and `LIVETV_E2E_PROXY_PORT` together if another slot occupies the defaults.
No existing app/proxy server is reused. The provider always enforces one actual HTTP connection,
including ffprobe connections; an overlap that a permissive fake would hide gets HTTP 429.

`LIVETV_E2E_SERVER=build` selects `node build` instead of Vite. Build this checkout on the runner
first (`npm run build`); the suite never builds or regenerates source files. Use a build run for
release confidence: the default dev run proves the real pipeline but does not prove the production
bundle. No E2E hooks or source changes are required.

Artifacts default to `<OS tmp>/lumastra-livetv-e2e-<app-port>/`: fixture metadata, final provider connection log (`provider-status.json`), provider FFmpeg
diagnostics (`provider.log`), HTML report and failure traces/screenshots. App/proxy logs stream into Playwright output. To retrieve artifacts
from the runner, put them under the checkout and pull them in the **same invocation**, for example:

```sh
lumastra-remote --slot livetv-e2e --pull test-results/livetv-e2e \
  'LIVETV_E2E_OUT=test-results/livetv-e2e npm run test:e2e:livetv'
```

These results can contain viewer/stream credentials in traces. Treat them as private test artifacts.

## Assertions

| Scenario              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Station grouping      | Five feeds import as exactly four stations. Kids Four HD/SD share one station ID; its `feedId` is the default feed from `/stations/{id}/feeds`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Session lifecycle     | v1 bearer POST gives 201, returned master and media playlists plus two segments traverse the app, ffprobe counts decoded audio/video frames and FFmpeg decodes them; heartbeat 204, active state, idempotent DELETE 204, provider slot released                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| One-slot priority     | Alice holds A; Bob gets 503 `reason: stream_limit` on B; admin takes B; Alice's explicit rejoin is guarded with 410 before heartbeat consumes the eviction notification. Repeated heartbeat stays terminal but omits the consumed details; explicit rejoin works once the guard is consumed and slot free                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Preview isolation     | An alternate-feed preview is refused under the real one-slot limit without disrupting playback; an accepted same-feed preview shares ingest, has a separate session, can be left independently, and favourites remain unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Segment-only liveness | After first master resolution, only media playlists and segments are fetched for more than 24 seconds. Fresh sequence URLs and decoded frames prove progress. State stays active; after reads stop the provider slot disappears within timeout + grace + 5 seconds scheduling allowance. A stale heartbeat then reports expired, and state ends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Feed choice           | Explicit SD feed ID returns that feed and opens `/stream/kids-four-sd.ts`, verified from the provider's active IDs and connection log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Settings / guide      | Favourites, simple-mode order and start station round-trip station IDs; every station has invented XMLTV airings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Chromium              | Four real grid cards, hydrated click to `/watch/<stationId>`, advancing video without MediaError/error alert; Bob's second context sees stream limit; admin's UI takes over and Alice retains the evicted overlay without auto-rejoin for more than two heartbeat intervals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Failure modes         | `livetv-e2e.failures.spec.ts` (`npm run test:e2e:livetv`, using the Rust proxy) drives the provider through `POST /__control` (`status:<n>`, `stall`, `end`, `ok`; see the source README) and asserts the typed contract, never a URL, host or port in any body: 401 gives 502 `provider_auth_failed` (`retryable: false`; `feedsTried` only for the admin, with the feed ID and `upstreamStatus` 401); a stopped (`end`) or 404 one-feed source gives `channel_offline` at start; `end` and `stall` after playback make keepalive answer 410 `reason: failed` with `code: upstream_stalled` (bounded polls: 45 s for `end`, 90 s for `stall`, which needs the proxy's fixed 30 s stale-segment detection plus the 5 s degraded window), session state carries `failure.code` and the media playlist answers 410 with the same code; OUR `maxStreams` 2 against the provider's one connection gives 503 `provider_connection_limit` (`retryable`, `retryAfterMs` 30000); both Kids Four feeds at 404 give `all_feeds_failed` with both feed IDs for the admin only; admin channel health shows `failing`/`offline` with `lastReason` and the health reset endpoint clears it; Chromium `/watch/<stationId>` shows the offline failure card with "Try another channel", no spinner. Every test resets the source to `ok` and restores `maxStreams` 1 in `afterEach`; the fixture then waits for zero provider slots |

## Reuse the source on a development or preproduction instance

Run [the standalone provider](../../scripts/livetv-testsource/README.md) on a host reachable from
all relevant containers, with `HOST=0.0.0.0`, a fixed port and `PUBLIC_BASE_URL` set to that reachable
host. In the instance's admin Live TV UI, add the printed M3U/XMLTV URLs, set maximum streams to 1,
allow private URLs on both app/worker and proxy if needed, then run import and EPG refresh. A provider
URL of `127.0.0.1` inside a container points at that container, not the fixture host.

Preproduction containers need an administrator to add/delete the source and apply restart-only
configuration. Ensure ordinary test users have Live TV access and low priority; admins are always
high priority (`auth.ts`), as are members of `LIVETV_HIGH_PRIORITY_GROUPS` or users with the explicit
high-priority capability. Observe `/__status` while testing the same takeover flow manually.
Remove the source afterward and stop the fixture server. The automated suite intentionally has no
"remote target" switch: it seeds a dedicated DB and starts its own processes. Use the standalone
source for manual instance testing, never repoint the destructive seeding suite at that instance.

## Limits and first-run checks

- Five feeds versus four stations resolves the requested count ambiguity by making **Kids Four**
  the grouped station; there is no fifth Harbour station. HD/SD are labels for importer/feed-choice
  testing, both generated at 640×360. Automatic failure-triggered backup switching is not tested;
  explicit grouped-feed choice is.
- The public guide now returns `stations[].airings` (the current implementation), rather than the
  earlier design's `programs` map. Tests assert this real contract.
- No public Live TV watch-history API exists. Preview history exclusion is not asserted; unchanged
  favourites alone does not prove it. Session GET is read-only and can retain an active Valkey record
  after the proxy viewer is reaped; provider status is the expiry authority, followed by a stale
  keepalive to observe the terminal state.
- This is Chromium/H.264/AAC on a single app/proxy instance. It does not cover Apple native HLS,
  HEVC/HDR, adaptive ladders, DRM, WAN failures, multiple replicas or real provider authentication.
- Verify on the first runner execution: worker task registration/dispatch, bootstrap/PAT permissions,
  Chromium codecs, and FFmpeg probe-to-ingest handoff under a strict one-connection provider. Failures
  here are useful pipeline evidence; do not loosen the provider limit or replace real media with mocks.
- The implementation was written without running SSH, Playwright, lint or typechecks on the Mac.
  A metadata-only provider smoke was also blocked by the sandbox's loopback bind restriction
  (`listen EPERM`). Run this suite and the repository's relevant remote checks before treating it as validated.
