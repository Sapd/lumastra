import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for E2E tests.
 *
 * These tests require a running dev server and real database.
 * Use: npm run test:e2e
 *
 * Test structure:
 * - tests/*.spec.ts - E2E tests (API and UI)
 *
 * For API-only tests, no browser is needed (uses request context).
 * For UI tests, install browsers with: npx playwright install chromium
 */

/**
 * Dev-server port. Overridable because the port used to be hardcoded in two
 * places (the webServer command and its url), and that made ANY two concurrent
 * e2e runs on one machine mutually exclusive:
 *
 *     Error: http://127.0.0.1:5173 is already used, make sure that nothing is
 *     running on the port/url or set reuseExistingServer:true
 *
 * Observed when a second e2e job was added to the same workflow — the two
 * self-hosted runners share a host, so the second job's webServer collided with
 * the first job's. The service containers already used ephemeral host ports for
 * exactly this reason; the webServer was the one thing still pinned.
 *
 * This is NOT only a CI concern: a `npm run test:e2e` started while a dev server
 * is already up hits the same wall, and so would a PR run overlapping a main
 * run (different refs, so the workflow's concurrency group does not serialise
 * them).
 *
 * `reuseExistingServer` is deliberately NOT the answer for CI: sharing one
 * server between two runs would share its database and cache state too, which
 * is precisely what separate jobs are trying to avoid.
 */
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 5173);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
    // Global setup/teardown for database test data
    globalSetup: './tests/global-setup.ts',
    globalTeardown: './tests/global-teardown.ts',

    // Test directory
    testDir: './tests',

    // Test file pattern
    testMatch: '**/*.spec.ts',

    // The route sweep has its own config (tests/playwright/playwright.route-sweep.config.ts) and
    // targets a running remote instance. Its identity module throws at import
    // without SWEEP_IDENTITY_MODE, so collecting it here fails the whole run.
    // Real Live TV owns its source/proxy lifecycle and one-slot state too.
    testIgnore: ['**/route-sweep/**', '**/livetv/**'],

    // Run tests in parallel
    fullyParallel: true,

    // Fail the build on CI if test.only is left in code
    forbidOnly: !!process.env.CI,

    // Retry failed tests (useful for flaky network tests)
    retries: process.env.CI ? 2 : 0,

    // Limit parallel workers
    workers: process.env.CI ? 1 : undefined,

    // Reporter
    //
    // The JSON report is opt-in via PLAYWRIGHT_JSON_REPORT, and only CI sets
    // it — a local run should not drop a report file into the working tree.
    //
    // It exists because the HTML report cannot be READ from anywhere except a
    // browser with access to the artifact: it is ~16 MB, and on the first CI
    // run (2026-09-07) the job log's readable tail was entirely the Postgres
    // container's stderr, so the outcome of 49 specs was unknowable from the
    // outside. scripts/check-playwright-json.mjs turns this file into the
    // green/failing lists, in the step summary. Keep the HTML report too —
    // it is still the right thing for a human debugging one failure.
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ...(process.env.PLAYWRIGHT_JSON_REPORT
            ? [['json', { outputFile: process.env.PLAYWRIGHT_JSON_REPORT }] as const]
            : []),
    ],

    // Shared settings for all projects
    use: {
        // Base URL for API requests. See PORT/BASE_URL above.
        baseURL: BASE_URL,

        // Collect trace on failure
        trace: 'on-first-retry',

        // NOTE: forward-auth identity headers are deliberately NOT set here.
        //
        // Setting them globally made every request — including writes — arrive
        // with ambient admin rights. Because only /api/v1/* validates bearer
        // tokens, a spec attaching a read-scope PAT to a mutation on /api/*,
        // /j/* or /subsonic/* was authorised by these headers instead, and the
        // token's scope was never consulted: the write returned 200 and
        // mutated the shared test account.
        //
        // Identity is now opt-in per spec:
        //     import { adminTest as test, expect } from './fixtures/auth';
        // A spec importing `test` from '@playwright/test' is unauthenticated,
        // so this class of accident fails closed instead of silently passing.
        // See tests/fixtures/auth.ts.
    },

    // Test projects
    projects: [
        {
            name: 'api',
            testMatch: '**/*.api.spec.ts',
            // API tests don't need a browser
            // Use single worker to prevent test isolation issues with shared database state
            fullyParallel: false,
            use: {},
        },
        {
            name: 'ui',
            testMatch: '**/*.ui.spec.ts',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    // Web server configuration
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120000, // 2 minutes to start
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
            ...(Object.fromEntries(
                Object.entries(process.env).filter(([, v]) => v !== undefined),
            ) as Record<string, string>),
            // The default /config cache is a Docker mount, unavailable to the
            // unprivileged CI runner. Isolate generated audio by dev-server port.
            MUSIC_TRANSCODE_CACHE_DIR: join(tmpdir(), `lumastra-e2e-${PORT}`, 'music-transcode'),
            // Forward-auth identity headers are honoured only from a trusted proxy
            // peer. With no allowlist (and no LUMASTRA_TRUST_ANY_PROXY, which only
            // the dev .env sets) the server fails CLOSED: the headers are dropped
            // and dev mode falls back to DEFAULT_USER. Until this was set, every
            // CI spec ran as `admin` — TestUserNonAdmin included, so the
            // permission specs passed vacuously. Playwright reaches the server
            // over loopback, so loopback is the proxy here. global-setup.ts
            // fails fast if the server still does not see TEST_USER.
            TRUSTED_PROXY_IPS: '127.0.0.1,::1,::ffff:127.0.0.1',
            // Forward auth is opt-in; the specs sign in through its headers.
            FORWARD_AUTH_ENABLED: 'true',
            // `vite dev` turns a request with NO identity header into
            // DEFAULT_USER ('admin') with ADMIN_GROUPS. That made every spec
            // that omits or blanks the headers ("unauthenticated", "bearer
            // only") run as admin. Opt out so such requests are rejected as in
            // a production build. global-setup.ts fails fast if a header-less
            // request still authenticates.
            LUMASTRA_DEV_NO_DEFAULT_USER: 'true',
            // Shared test identities issue bursts across hundreds of specs. The
            // rate-limit override only applies to development builds; auth gates
            // and the production budgets are unchanged.
            LUMASTRA_E2E_RATE_LIMIT_MULTIPLIER: '100',
            // Prod runs with user PATs on, and /api/v1 is Bearer-only, so with
            // the flag off (its default) POST /api/user/tokens 404'd and every
            // PAT-minting spec skipped: api-tokens, streaming-sessions(-security)
            // and the Bearer half of authorization-security. features.userPats
            // also needs JWT_SECRET; this is a test-only value. Set here rather
            // than in e2e.yml so all four CI jobs and local runs agree.
            FEATURE_USER_PATS: process.env.FEATURE_USER_PATS || 'true',
            JWT_SECRET: process.env.JWT_SECRET || 'e2e-only-jwt-secret-0123456789abcdefghijklmnop',
            // The home Calendar widget and the request cards render only when
            // features.calendar (a Sonarr/Radarr URL) and features.requests
            // (FEATURE_REQUEST_MODAL + a Seerr URL and key) are on. calendar-grouping
            // and request-progress stub the upstream responses in the browser; the
            // URLs point at a closed loopback port so nothing real is ever contacted.
            SONARRURL: process.env.SONARRURL || 'http://127.0.0.1:9',
            SEERRURL: process.env.SEERRURL || 'http://127.0.0.1:9',
            SEERRAPIKEY: process.env.SEERRAPIKEY || 'e2e-test-key',
            FEATURE_REQUEST_MODAL: process.env.FEATURE_REQUEST_MODAL || 'true',
            // Alchemy's browser spec stubs recommendations, but still needs the
            // same feature gates as a configured instance.
            FEATURE_MUSIC_CLUSTERING: 'true',
            FEATURE_MUSIC_ALCHEMY: 'true',
        },
    },
});
