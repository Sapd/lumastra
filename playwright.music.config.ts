// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Web music player e2e with REAL audio: generated fixture tracks (ffmpeg tones with
 * tags), real <audio> elements and the real Web Audio crossfade engine — nothing in
 * the player is stubbed. Scenarios: cross-tab mirroring, crossfade hand-off, dead
 * incoming stream, Range reconnect on a transcoded stream, hidden-tab crossfade, fast
 * search, mood radio, cluster shuffle.
 *
 *   VITE_E2E_HOOKS=true npm run build
 *   DATABASE_URL=… CACHE_URL=… npx playwright test -c playwright.music.config.ts
 *   … --grep @pr          # the per-PR subset (mirroring + crossfade)
 *
 * Same shape as playwright.watch-together.config.ts (read its header): its own server
 * (`node build`, verdicts never on `vite dev`), its own seeding, one worker, no retries.
 * The build needs VITE_E2E_HOOKS=true: it compiles in `window.__musicPlayerStore`, the
 * read-only window the scenarios use to observe the player (dev builds always have it).
 * User actions still go through the real UI (buttons, seek bar, keyboard).
 *
 * DATABASE_URL must name a DEDICATED database (CI: the job's service container;
 * preprod runner: the slot's test DB). Never the shared lumastra_dev, never preprod/prod.
 */

import { resolve } from 'path';
import { defineConfig, devices } from '@playwright/test';
import { MUSIC_USER, musicPort, outDir, serverUrl, webUrl } from './tests/music-e2e/music-env';

const OUT = outDir();
const SERVER = process.env.MUSIC_E2E_SERVER === 'dev' ? 'dev' : 'build';
const SERVER_COMMAND =
    SERVER === 'dev'
        ? `npx vite dev --config vite.wt-e2e.config.ts --host 127.0.0.1 --port ${musicPort()} --strictPort`
        : `node build`;

export default defineConfig({
    testDir: './tests/music-e2e',
    testMatch: '*.e2e.ts',
    globalSetup: './tests/music-e2e/global-setup.ts',

    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 3 * 60_000,
    expect: { timeout: 10_000 },

    reporter: [
        ['list'],
        ['html', { outputFolder: `${OUT}/playwright-report`, open: 'never' }],
        ...(process.env.PLAYWRIGHT_JSON_REPORT
            ? [['json', { outputFile: process.env.PLAYWRIGHT_JSON_REPORT }] as const]
            : []),
    ],
    outputDir: `${OUT}/pw-results`,

    projects: [{ name: 'chromium' }],

    use: {
        ...devices['Desktop Chrome'],
        baseURL: webUrl(),
        // Forward-auth identity on every request of every page (see global-setup).
        extraHTTPHeaders: { 'X-Forwarded-User': MUSIC_USER, 'X-Forwarded-Groups': 'Users' },
        trace: 'retain-on-failure',
        video: 'off',
        screenshot: 'only-on-failure',
        launchOptions: {
            // Playback starts from evaluate()/remote commands, not always a click.
            // --mute-audio: the decks still decode and advance; nothing is heard.
            args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
        },
    },

    webServer: {
        command:
            SERVER === 'build'
                ? `test -f build/index.js || { echo 'build/ missing: run VITE_E2E_HOOKS=true npm run build first (or MUSIC_E2E_SERVER=dev)' >&2; exit 1; }; mkdir -p '${OUT}' && exec ${SERVER_COMMAND} > '${OUT}/server.log' 2>&1`
                : `mkdir -p '${OUT}' && exec ${SERVER_COMMAND} > '${OUT}/server.log' 2>&1`,
        url: serverUrl(),
        reuseExistingServer: !!process.env.MUSIC_E2E_REUSE_SERVER,
        timeout: 180_000,
        env: {
            ...(Object.fromEntries(
                Object.entries(process.env).filter(([, v]) => v !== undefined),
            ) as Record<string, string>),
            // Forward-auth headers count only from a trusted proxy peer; the browser
            // reaches the server over loopback (see playwright.watch-together.config.ts).
            TRUSTED_PROXY_IPS: '127.0.0.1,::1,::ffff:127.0.0.1',
            // Forward auth is opt-in; the specs sign in through its headers.
            FORWARD_AUTH_ENABLED: 'true',
            WORKER_MODE: 'disabled',
            // Mood radio's sonic arm, cluster shuffle (v1, bearer-only: a PAT).
            FEATURE_MUSIC_SONIC: 'true',
            FEATURE_MUSIC_SONIC_QUEUE: 'true',
            FEATURE_MUSIC_CLUSTERS: 'true',
            FEATURE_USER_PATS: 'true',
            // The default (/config/cache/…) is not writable outside the image.
            MUSIC_TRANSCODE_CACHE_DIR: resolve(OUT, 'transcode-cache'),
            JWT_SECRET:
                process.env.JWT_SECRET || 'music-e2e-jwt-secret-not-for-production-0123456789',
            HOST: '127.0.0.1',
            PORT: String(musicPort()),
            ORIGIN: webUrl(),
        },
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
});
