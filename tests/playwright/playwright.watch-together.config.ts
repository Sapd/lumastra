// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Web-only Watch Together e2e: two browser contexts (two users) in one party.
 *
 *   DATABASE_URL=… CACHE_URL=… npx playwright test -c tests/playwright/playwright.watch-together.config.ts
 *   … --grep @pr          # the per-PR subset (scenarios 1–3)
 *
 * Separate from playwright.config.ts on purpose: its own server, its own seeding, no
 * retries. A party is a shared server-side object and two scenarios must never touch
 * one at the same time: parallel workers (WT_WORKERS) therefore each use their own
 * user pair, and every scenario creates its own party and seeded media rows.
 *
 * Server (WT_SERVER):
 *   build (default) — the production build, `node build` as deploy/docker/start.sh runs
 *                     it. Run `npm run build` first. This is what CI uses.
 *   dev             — `vite dev --config vite.wt-e2e.config.ts` (watch + HMR off), for
 *                     quick local iteration on the test. NOT for verdicts: under two
 *                     browsers' load Vite intermittently failed module fetches
 *                     ("Failed to fetch dynamically imported module …/nodes/0.js"),
 *                     which surfaces as a 500 page mid-scenario.
 * Specs are named *.e2e.ts so the normal run (`**\/*.spec.ts`) never collects them.
 *
 * DATABASE_URL must name a DEDICATED database (CI: the job's service container;
 * preprod runner: the slot's test DB). Never the shared lumastra_dev, never preprod/prod.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { outDir, webUrl, wtPort, wtWorkers } from '../watch-together/wt-env';

// One id for the whole run. Playwright restarts the worker after a failed test, which
// re-evaluates the spec module, so per-run state lives in env + files, not memory.
process.env.WT_RUN_ID ??= String(Date.now());

// Relative outDir() values are relative to the app root, as before this file moved to
// tests/playwright/. Playwright resolves outputDir and the report folder against this file,
// so the root is anchored explicitly.
const OUT = resolve(fileURLToPath(new URL('../..', import.meta.url)), outDir());
const SERVER = process.env.WT_SERVER === 'dev' ? 'dev' : 'build';
const SERVER_COMMAND =
    SERVER === 'dev'
        ? `npx vite dev --config vite.wt-e2e.config.ts --host 127.0.0.1 --port ${wtPort()} --strictPort`
        : `node build`;

export default defineConfig({
    testDir: '../watch-together',
    testMatch: '*.e2e.ts',
    globalSetup: '../watch-together/global-setup.ts',
    globalTeardown: '../watch-together/global-teardown.ts',

    // WT_WORKERS (default 1) scenarios at a time. Each worker signs in as its own pair
    // of users (wt-env.ts wtUsersFor), so no two running scenarios share a party, a
    // "current party" pointer or a stream budget. fullyParallel spreads the tests of a
    // file over the workers; with one worker the order is the file order, as before.
    fullyParallel: true,
    workers: wtWorkers(),
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 4 * 60_000,

    reporter: [
        ['list'],
        ['html', { outputFolder: `${OUT}/playwright-report`, open: 'never' }],
        ...(process.env.PLAYWRIGHT_JSON_REPORT
            ? [['json', { outputFile: process.env.PLAYWRIGHT_JSON_REPORT }] as const]
            : []),
    ],
    outputDir: `${OUT}/pw-results`,

    // `chromium`: every scenario. The cross-engine projects put a WebKit (Safari's
    // engine) or Firefox participant opposite a Chromium one — as host or as guest —
    // and run what is not Chromium-specific, in one user direction.
    //   npx playwright test -c tests/playwright/playwright.watch-together.config.ts --project chromium
    //   … --project 'webkit-*' --project 'firefox-*'
    projects: [
        // This scenario temporarily enables instance-wide library types. Run it
        // alone before any worker can observe those types in another scenario.
        { name: 'watch-navigation', testMatch: 'watch-navigation.e2e.ts' },
        {
            name: 'chromium',
            testIgnore: 'watch-navigation.e2e.ts',
            dependencies: ['watch-navigation'],
        },
        ...(
            [
                ['webkit-guest', 'chromium', 'webkit'],
                ['webkit-host', 'webkit', 'chromium'],
                ['firefox-guest', 'chromium', 'firefox'],
                ['firefox-host', 'firefox', 'chromium'],
                // Real Brave, only where it is installed (WT_BRAVE_PATH), not in CI.
                ...(process.env.WT_BRAVE_PATH
                    ? ([
                          ['brave-guest', 'chromium', 'brave'],
                          ['brave-host', 'brave', 'chromium'],
                      ] as const)
                    : []),
            ] as const
        ).map(([name, hostEngine, guestEngine]) => ({
            name,
            dependencies: ['watch-navigation'],
            grepInvert: /@chromium-only/,
            metadata: { hostEngine, guestEngine, singleDirection: true },
        })),
    ],

    use: {
        ...devices['Desktop Chrome'],
        baseURL: webUrl(),
        // Artifacts only for failures: the CI host has run out of disk before.
        trace: 'retain-on-failure',
        video: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            // Remote-driven play has no user gesture. The autoplay scenario launches
            // its own browser WITHOUT this flag.
            // --mute-audio: no sound from test runs (the fixtures are silent too).
            args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
        },
    },

    webServer: {
        // Server output goes to a file, not the console: scenarios read it (buffer-check
        // timeouts are recorded as observations) and the CI log stays readable.
        command:
            SERVER === 'build'
                ? `test -f build/index.js || { echo 'build/ missing: run npm run build first (or WT_SERVER=dev)' >&2; exit 1; }; mkdir -p '${OUT}' && exec ${SERVER_COMMAND} > '${OUT}/server.log' 2>&1`
                : `mkdir -p '${OUT}' && exec ${SERVER_COMMAND} > '${OUT}/server.log' 2>&1`,
        // The root, like playwright.config.ts: before globalSetup has created an admin
        // it answers 303 -> /setup (Playwright counts that as up), whereas the
        // /api/health* routes answer 503 "Account not provisioned" until then.
        url: webUrl(),
        // A reused server would share another run's DB + Valkey state.
        cwd: '../..',
        reuseExistingServer: !!process.env.WT_REUSE_SERVER,
        timeout: 180_000,
        env: {
            ...(Object.fromEntries(
                Object.entries(process.env).filter(([, v]) => v !== undefined),
            ) as Record<string, string>),
            // Forward-auth identity is honoured only from a trusted proxy peer, and with
            // no allowlist (and no LUMASTRA_TRUST_ANY_PROXY, which only the dev .env
            // sets) it fails CLOSED: the headers are dropped and dev mode falls back to
            // DEFAULT_USER — both "users" would silently be `admin`. The browsers reach
            // the server over loopback, so loopback is the proxy here.
            TRUSTED_PROXY_IPS: '127.0.0.1,::1,::ffff:127.0.0.1',
            // Forward auth is opt-in; the specs sign in through its headers.
            FORWARD_AUTH_ENABLED: 'true',
            // The catalog script-boundary scenario visits an enabled, empty Live TV
            // lineup as these non-admin users. Keep the real route gate in force.
            FEATURE_LIVETV: 'true',
            LIVETV_GROUPS: 'Users',
            // Web-only, like a production web replica (workers run in their own
            // container there). Otherwise the task system runs in this process and,
            // on the seeded items, stalled the event loop for seconds mid-scenario.
            WORKER_MODE: 'disabled',
            // adapter-node (build mode): listen where the browsers connect, and accept
            // that origin for SvelteKit's CSRF check on DELETE/POST.
            HOST: '127.0.0.1',
            PORT: String(wtPort()),
            ORIGIN: webUrl(),
        },
        // SIGTERM lets the server close its Postgres pool; an orphaned dev server once held
        // all 100 connections of a shared instance.
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
});
