// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
    appPort,
    baseURL,
    proxyPort,
    workerPort,
    outDir,
    viewerTimeoutSeconds,
    graceSeconds,
    identityHeaders,
    haveLiveTvFfmpeg,
    dedicatedDatabaseUrl,
} from './tests/livetv/env';

const binariesAvailable = haveLiveTvFfmpeg();
// Refuse shared databases before Playwright starts either server.
if (binariesAvailable) dedicatedDatabaseUrl();
const sharedEnv = {
    ...Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    ),
    ...(binariesAvailable ? { DATABASE_URL: dedicatedDatabaseUrl() } : {}),
    STREAM_PROXY_SECRET: 'livetv-e2e-only-proxy-secret',
    LIVETV_ALLOW_PRIVATE_URLS: 'true',
    LIVETV_VIEWER_TIMEOUT_SECONDS: String(viewerTimeoutSeconds),
    LIVETV_GRACE_PERIOD_SECONDS: String(graceSeconds),
    LIVETV_ORPHAN_CHECK_INTERVAL_SECONDS: '1',
    // Failure specs: unclassified stalls fail over after 5 s (default 60 s), checked every second.
    LIVETV_HEALTH_CHECK_INTERVAL_SECONDS: '1',
    LIVETV_DEGRADED_FAILOVER_SECONDS: '5',
    FFMPEG_GRACE_PERIOD_SECONDS: '2',
    FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
    FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
    LIVETV_PROXY_GPU: 'none',
    LIVETV_UPSTREAM_PROXY_URL: '',
    HLS_TEMP_DIR: resolve(outDir, 'hls'),
};

export default defineConfig({
    testDir: './tests/livetv',
    testMatch: 'livetv-e2e.*.spec.ts',
    globalSetup: './tests/livetv/global-setup.ts',
    workers: 1,
    fullyParallel: false,
    retries: 0,
    forbidOnly: !!process.env.CI,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    reporter: [['list'], ['html', { outputFolder: resolve(outDir, 'report'), open: 'never' }]],
    outputDir: resolve(outDir, 'results'),
    use: {
        ...devices['Desktop Chrome'],
        baseURL,
        locale: 'en-US',
        extraHTTPHeaders: identityHeaders('alice'),
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
    },
    // No processes or DB access when the prerequisite is absent: specs report a
    // clear skip instead of timing out waiting for a proxy that cannot ingest.
    webServer: binariesAvailable
        ? [
              {
                  // The Rust build is a cold `cargo build --release` the first time on a slot.
                  command: 'npm run build:proxy && exec build/lumastra-livetv-proxy --serve',
                  url: `http://127.0.0.1:${proxyPort}/status`,
                  env: { ...sharedEnv, PORT: String(proxyPort) },
                  reuseExistingServer: false,
                  timeout: 900_000,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
              },
              // Import tasks run in a dedicated worker; the web process never runs tasks.
              {
                  command: 'node scripts/dev-worker.mjs',
                  url: `http://127.0.0.1:${workerPort}/api/health`,
                  env: {
                      ...sharedEnv,
                      PORT: String(workerPort),
                      HOST: '127.0.0.1',
                      STREAM_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
                      FEATURE_LIVETV: 'true',
                      LIVETV_SOURCE: 'standalone',
                  },
                  reuseExistingServer: false,
                  timeout: 600_000,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
              },
              {
                  command:
                      process.env.LIVETV_E2E_SERVER === 'build'
                          ? 'node build'
                          : `npx vite dev --host 127.0.0.1 --port ${appPort} --strictPort`,
                  url: baseURL,
                  env: {
                      ...sharedEnv,
                      PORT: String(appPort),
                      HOST: '127.0.0.1',
                      ORIGIN: baseURL,
                      STREAM_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
                      FEATURE_LIVETV: 'true',
                      LIVETV_SOURCE: 'standalone',
                      LIVETV_GROUPS: 'Users',
                      LIVETV_HIGH_PRIORITY_GROUPS: 'LIVETV_HIGH_PRIORITY',
                      LIVETV_VIEWER_FEED_CHOICE: 'true',
                      LIVETV_DEFAULT_QUALITY: 'original',
                      FORWARD_AUTH_ENABLED: 'true',
                      ADMIN_GROUPS: 'admin',
                      USERHEADER: 'X-Forwarded-User',
                      GROUPHEADER: 'X-Forwarded-Groups',
                      TRUSTED_PROXY_IPS: '127.0.0.1,::1,::ffff:127.0.0.1',
                      LUMASTRA_DEV_NO_DEFAULT_USER: 'true',
                      FEATURE_USER_PATS: 'true',
                      JWT_SECRET: 'livetv-e2e-only-jwt-secret-0123456789abcdefghijklmnop',
                      WORKER_MODE: 'disabled',
                  },
                  reuseExistingServer: false,
                  timeout: 180_000,
                  stdout: 'pipe',
                  stderr: 'pipe',
                  gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
              },
          ]
        : [],
});
