// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Config for the cross-client Watch Together e2e (browser <-> Apple TV simulator).
 *
 *   WT_WEB_URL=http://127.0.0.1:5191 WT_E2E_DIR=/tmp/wt-e2e ... \
 *     npx playwright test -c playwright.watch-together-tv.config.ts
 *
 * Deliberately separate from playwright.config.ts: the server is already running
 * (no webServer), there is no DB seeding (no globalSetup/Teardown), and the spec is
 * named *.e2e.ts so the normal `playwright test` run never collects it.
 */

import { defineConfig } from '@playwright/test';

const E2E_DIR = process.env.WT_E2E_DIR || './test-results/wt-e2e';

// One id for the whole run. Playwright restarts the worker after a failed test, which
// re-evaluates the spec module, so per-run state must live in env + files, not memory.
process.env.WT_RUN_ID ??= String(Date.now());

export default defineConfig({
    testDir: './tests',
    testMatch: 'watch-together-tv.e2e.ts',

    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 20 * 60_000,

    reporter: [['list'], ['html', { outputFolder: `${E2E_DIR}/playwright-report`, open: 'never' }]],
    outputDir: `${E2E_DIR}/pw-results`,

    use: {
        baseURL: process.env.WT_WEB_URL,
        video: 'on',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            // The synthetic movie must start without a user gesture (remote-driven play).
            args: ['--autoplay-policy=no-user-gesture-required'],
        },
    },
});
