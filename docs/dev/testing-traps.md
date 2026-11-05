<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Testing traps

Ways a test can pass for the wrong reason, fail for the wrong reason, or pass locally and fail in
CI. Read it before writing a `vi.mock`, an integration test that seeds data, or a Playwright spec.

## Vitest

- **Run vitest from the app folder (the one with `package.json`), not from a parent folder.** From a
  parent it resolves a different project root: the `$lib` alias is lost (your own imports fail) and it can
  glob stale worktrees below the root, whose errors have nothing to do with your change.
- **Brace the body of `beforeEach`.** `beforeEach(() => fn.mockReset())` returns the mock, and vitest
  runs a function returned from `beforeEach` as the teardown. If the test made `fn` reject, the
  teardown call rejects and fails a test whose assertions all passed. Write
  `beforeEach(() => { fn.mockReset(); })`.
- **A rejecting `vi.fn()` cannot prove "no unhandled rejection".** A rejection that starts inside a
  mock implementation does not surface as a real `unhandledRejection` event, so such a test passes
  with and without the fix. Assert on the guard instead (a catch path ran, a handler is attached),
  and make the test fail against the unguarded code before you trust it.
- **Keep every export in a `vi.mock` factory in step with the real module.** A factory replaces
  the module wholly. When a handler later imports a new export, vitest throws on first access
  _inside the handler_, where `mount()` or a def's own `try/catch` turns it into a 500 or 503. The
  test then reports a status mismatch and never names the export. If a mocked logger swallows the
  error, make it print temporarily. When you add an import to a def, grep the tests that mock that
  module.
- **Give a hand-built request a real body stream.** `mount()` reads bodies through
  `readBoundedBodyChunks()`, which uses `request.body.getReader()` and returns an empty body when
  there is no stream. A fake with only `text()`/`json()` hands the handler `{}`. Attach a
  `ReadableStream` only when the request has a body; `body: null` makes body-less tests hang.
- **Overlapping dynamic imports bypass a factory mock.** Two concurrent `import('x')` calls from
  one importer (`Promise.all([import('x'), import('x')])`) make the second one load the real module.
  Spies then under-count and the real module can fail after teardown. Use an automock
  (`vi.mock(path)` without a factory) and install implementations in `beforeEach`, or avoid the
  concurrent dynamic imports. A spy that records zero calls on a path you know runs is the tell.
- **Never write an absolute path in `vi.mock`.** It cannot match on another machine, so the mock
  silently does nothing, the real module loads, and the suite is green locally and red in CI with an
  unrelated error (for example a missing `DATABASE_URL`). Use a relative specifier.
- **A benchmark only counts if it runs.** In vitest 5, `bench` is a test-context fixture and
  `bench(...)` only registers; without `.run()` the file still reports "passed". Check that the
  output has a per-benchmark stats table, and note that env-guarded files report "skipped" when their
  URLs are unset.
- **Every vitest config needs the shared plugins.** Each config under the project root must list
  `cleanVitestTmpDir()` (`tests/vitest/vitest.tmpdir-cleanup.ts`); vitest leaves a large module dump in the OS
  temp dir per run and fills the disk without it. A config that loads `sveltekit()` must also list
  `paraglideLocaleModulesForTests()` (`tests/vitest/vitest.paraglide-locale-modules.ts`); without it the message
  barrel loads one module per message and route tests time out when run alone. If route tests start
  timing out, check the plugin's compile step did not fail (it warns and falls back to the slow tree).

## Opt-in test suites

Set `LUMASTRA_SCALE_TEST=1` for large scale cases (page boundaries and repair/regression guards
stay in the default run), `LUMASTRA_BENCH_TEST=1` for benchmarks/baselines, and
`LUMASTRA_FFMPEG_SMOKE=1` for real FFmpeg unit smokes. CI enables the benchmark and smoke gates;
local and lander runs skip them unless enabled. Baseline capture/strictness still use
`BENCH_CAPTURE`/`BENCH_GATE` in addition to `LUMASTRA_BENCH_TEST`.

## Environment differences

- **A local `.env` can hide failures CI sees.** `client-ip.ts` reads `TRUSTED_PROXY_IPS` and
  `LUMASTRA_TRUST_ANY_PROXY` at module load and fails closed. A developer `.env` that trusts any
  proxy lets forward-auth tests pass locally while CI drops the identity headers. Set the trust
  variables inside the test file with `vi.hoisted`, and reproduce CI with
  `DOTENV_CONFIG_PATH=/dev/null` plus only the database and cache URLs.
- **Feature flags are getters, so spy on the getter.** `config.ts` copies `process.env` at module
  load; changing `process.env` in a test has no effect. Use
  `vi.spyOn(config, 'FEATURE_X', 'get').mockReturnValue(true)` and `vi.restoreAllMocks()` afterwards.
  A flag that defaults off can make a test false-green: the user-webhook outbox marks every claimed
  per-user row dead while `FEATURE_USER_NOTIFICATION_WEBHOOKS` is off, so delivery never runs and two
  different retirement paths look the same. Assert on `last_error`, not on `dead`.
- **Memoised health probes defeat re-probe tests.** `component-health.ts` caches a reading for
  `COMPONENT_HEALTH_TTL_MS`. A test that probes, seeds rows and probes again compares the cached
  reading with itself and every delta is 0. Wait past the TTL before every probe, including the
  baseline.
- **Valkey connects lazily.** Code on a request path can connect it after the first test in a file,
  so a precondition such as "Valkey is down, so only this route writes the row" holds once and then
  becomes vacuous. Mock `isValkeyReady` for the whole file instead of asserting it once, and prove
  the test by reverting the fix.

## Integration tests (real PostgreSQL)

- **Keep the per-file setup free of server imports.** Whatever `setupFiles`
  (`tests/integration/setup/vitest.setup.ts`) imports is loaded into every test file's module graph
  before that file's hoisted `vi.mock` calls register. An already-loaded module keeps its real
  bindings, so a mock of it, or of anything it imports, silently does nothing for code reached
  through it, while a direct import in the test file still sees the mock. Until 2026-10-14 the setup
  imported the migration runner, which preloaded about 120 server modules (logger, config,
  `connection.ts`, `media-lifecycle.service`, ...). Migrations now run once in `globalSetup`
  (`global-setup.ts`), which has its own module graph. `mock-reach.integration.test.ts` fails if the
  setup starts preloading server code again. When a mock looks ineffective, assert that the code
  under test actually calls it (`vi.isMockFunction`, call counts).
- **Mocked `sql` cannot see a wrong query.** A unit test that feeds the answer through a mocked
  `sql` proves what the caller does with the result, not what the SQL matches. Constraint
  violations, `DEFAULT` handling, `NULL` semantics and predicates that can only be false against real
  rows need an integration test. See `src/lib/server/database/CLAUDE.md`.
- **A concurrency test on one shared pool proves nothing.** `postgres.js` serialises calls on a
  shared instance, so 12 "parallel" reserves behave like 12 sequential ones. Use one dedicated
  connection (`postgres(url, { max: 1 })`) per worker.
- **Seed containers through the helper.** Series, seasons, artists and albums never own file rows.
  Use `placeInLibraryGroup` (`tests/integration/fixtures/library-access.fixtures.ts`) to put them in
  a library group; attaching a file straight to a container makes a vacuous filter look correct.
- **Pass an explicit `tmdbId` when one test seeds more than one series.**
  `createAndInsertTestSeries` draws its TMDB id from a small sample list, so two series in one test
  sometimes collide on the `external_ids` unique key, which looks like an unrelated flake.
- **Task tests must use the same Valkey client as the task system.** Use `requireClient` from
  `src/lib/server/tasks/valkey-types.ts`. Injecting the cache client splits run state across two
  Valkey instances when the task keyspace uses a separate one.

## Playwright

- **Wait for hydration before you click.** Server-rendered markup (headings, nav, landmarks)
  is visible before the client attaches handlers, so a click lands on a dead element and the failure
  reads like a product bug. Call `expectHydrated(page)` from `tests/helpers/hydration.ts` after
  `goto`, and poll values that a `$effect` writes instead of reading them once.
- **A body-less `POST` or `DELETE` without an `Origin` header gets a CSRF 403.** Tests then see 403
  instead of the 401 or 405 they assert, and cleanup calls wrapped in `.catch(() => {})` silently
  never land. Send `Origin: new URL(baseURL).origin` (see `cancelPlaySession` in
  `tests/helpers/play-sessions.ts`) or use a request with an `Authorization` header.
- **`/api/v1` ignores forward-auth.** A spec against it needs a real bearer token.
- **Mirror the CI environment when you run specs elsewhere.** Copy the variables from the E2E
  workflow (test user and groups, and the CORS origin); without the CORS origin the
  CORS specs fail for the wrong reason.
- **Blank identity headers are not "anonymous" on `/api/*`.** The internal surface resolves them to
  the default user, who is an admin. Assert unauthenticated behaviour on `/api/v1/*`.

### Running the nightly probe

Run from the app folder with dependencies and Chromium installed, PostgreSQL and
Valkey running, and `DATABASE_URL`, `TEST_DATABASE_URL` and `CACHE_URL` pointing
at disposable test services. Use the same database URL for both database
variables. Install FFmpeg on `PATH` or set `FFMPEG_PATH` to its executable for
the generated playback fixtures. Initialize a fresh test database before each probe:

```bash
npm ci --legacy-peer-deps
npx playwright install chromium
npm run db:test:migrate
CI=1 TEST_USER=TestUser TEST_GROUPS="Users|Librarians|admin" \
CORS_ALLOWED_ORIGINS=https://e2e-cors-client.example \
npx playwright test --project=ui --workers=1 --retries=0
```

Use `--project=api` for the API probe. The main config sets the feature gates used
by browser mocks and gives music transcoding a writable temporary cache. CI's
service database is named `lumastra_t_e2e` so fixture safety guards accept it;
keep those guards fail-closed against arbitrary databases.
The shared browser fixture records failed client-module requests. On shared CI
hosts, container network-interface churn can make Chromium abort scripts with
`net::ERR_NETWORK_CHANGED`, leaving SvelteKit's `Internal Error` page. The fixture
reloads only when that exact transport failure is observed and either the error
page is visible or client hydration never started, at most twice per page. Each recovery is annotated in the JSON report;
HTTP failures, other network errors and ordinary assertion failures do not retry.
Clean-console assertions use `withoutNetworkChangeErrors` to exclude only
module errors recorded during a recovered transport abort; their full messages
remain in the diagnostic attachment. Unrecovered errors, HTTP failures and
ordinary runtime exceptions still fail those assertions.
The non-blocking UI probe alone opts into `PLAYWRIGHT_ENVIRONMENT_QUARANTINE=1`.
If network-change aborts exhaust both reloads and hydration remains stalled, the
hydration helper skips that case with an `environment-quarantine` annotation and
an explicit reason. Mixed HTTP failures, other connection failures and ordinary
runtime exceptions cannot qualify. Blocking ratchets do not enable this flag.
Music probes also await the lazy backend's `init()` before exercising playback;
backend-import recovery shares the same two-reload budget. The app's custom
`.error-container.server-error` screen counts as failed startup even when the
prior layout already mounted. Retry-UI fixtures label intentional fetch outages
with `X-E2E-Expected-Status`; this marker cannot exempt document/module HTTP
errors from the guard. Stop a fixture page before deleting its records, so an
in-flight invalidation cannot turn teardown into a false 404/500.

- **Assert cleanup responses when a test changes shared account policy.** A
  swallowed CSRF 403 on the stream-policy DELETE left a one-stream limit behind.
  The first player-controls test then took the slot; subsequent controls,
  track-menu, subtitle and handoff tests timed out at source readiness. Use the
  same-origin fixture and assert the policy reset returns 204.
- **A saved preference and an eager store mutation test different paths.** Admin
  settings restore their preference after mount. Forcing the store to `true`
  before `hydrate(..., {recover: false})` deliberately changes the client tree;
  that is a negative control which must reject, not a production hydration case.
- **Playback starts probe real bytes.** Combined-file fixtures need accessible
  media with duration matching their episode windows, not synthetic nonexistent
  paths. Global setup generates small 20-minute files and fails if generation fails.

## Real Live TV E2E

- **A permissive synthetic provider hides connection-limit bugs.** Keep the real fixture at one
  connection, including ffprobe connections. Matching only the app source's `maxStreams` does not
  exercise probe/ingest handoff or upstream slot release. See [the runbook](livetv-e2e.md).
- **A master reload can rejoin.** For a segment-only liveness verdict, resolve the master once,
  then poll only the media playlist and segments. Repeated master fetches can make a broken
  segment heartbeat look healthy. Assert fresh segment URLs and decoded frames, not HTTP 200 alone.
- **Inspect the eviction guard before consuming it.** A join is blocked until keepalive consumes
  the channel-specific kicked flag; GET state does not consume it. Repeated keepalive can remain
  410 from the ended session record while its consume-once `details` have gone away.
- **Proxy expiry and Valkey record retention differ.** Session GET reads the retained record;
  provider `/__status` proves the ingest actually stopped. Only after that observation should a
  stale heartbeat be used to assert `session_expired`. Do not heartbeat during the expiry window.
- **An alternate-feed preview needs another provider slot.** Under the one-slot fixture it must
  refuse without superseding real playback. An accepted same-feed preview shares the ingest slot;
  its own leave must leave the real session active. Favourites do not prove history exclusion.

## Debugging playback on iOS Safari

- **Find the mechanism in the device's own log before you change code.** Safari's Web Inspector
  (Develop menu, with the device connected) shows the page side. Turn on Settings → Console →
  Media Logging (Verbose) for WebKit's media events. AVFoundation's errors and its network
  requests are only in the device's system log: `sudo log collect --device-udid <udid> --last 5m`
  on the Mac, then `log show --archive <file> --style compact` (use `/usr/bin/log` in zsh, where
  `log` is a builtin).
- **Change one variable at a time, on the real device, at least twice per state.** For an
  intermittent fault a single try in the full player proves nothing. A lucky start looks like a
  fix, and a fix of the iOS first-segment loop went wrong three times that way. Paste a small
  snippet into the Web Inspector console that builds a bare `<video>` on the same origin, runs
  case A and case B with exactly one difference, and prints the result:

    ```js
    (async () => {
        const run = (tag, setup) =>
            new Promise((done) => {
                const v = document.createElement('video');
                v.muted = true;
                v.playsInline = true;
                document.body.appendChild(v);
                setup(v); // the ONE difference between the cases, e.g. add a <track> before or after load
                v.src =
                    '/api/playback/<itemId>/hls?...&PlaySessionId=probe-' + tag + '-' + Date.now();
                v.play().catch(() => {});
                setTimeout(() => {
                    done(
                        `${tag}: err=${v.error?.code ?? 'none'} rs=${v.readyState} t=${v.currentTime.toFixed(1)}`,
                    );
                    v.remove();
                }, 10000);
            });
        console.log(await run('A', () => {}));
        console.log(
            await run('B', (v) => {
                /* change one thing */
            }),
        );
    })();
    ```

    Run it twice. `err=4 rs=0` is a load AVFoundation refused; `err=none rs=4` with a growing `t`
    is playback.

- **Don't use the Mac as a stand-in.** macOS AVFoundation plays streams that iOS rejects (a master
  playlist next to `<track>` elements, for one), and a stream served from a local test server
  behaves differently from the same stream on the real origin.

### E2E rate budgets and UUID fixtures

Playwright's `webServer.env` sets `LUMASTRA_E2E_RATE_LIMIT_MULTIPLIER=100` for the
shared test identities. Only `vite dev` honours this opt-in budget
multiplier; production builds ignore it. Authentication and permission checks still
run. Tests of rate-limit enforcement use the normal budgets in unit tests.

Seed RFC UUIDs (including valid version/variant bits), even though PostgreSQL also
accepts UUID-shaped hex strings with zero version/variant bits. Such rows can be
inserted successfully and then fail `z.uuid()` in start bodies and media previews.
The seed contract test checks these values without launching a browser.
