// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, devices } from '@playwright/test';
import { sweepBrowserOrigin } from './tests/route-sweep/browser-origin';

/**
 * Playwright configuration for the pre-release route sweep.
 *
 * The sweep always targets an already-running remote instance. A local
 * `webServer` is deliberately absent: the dev server exits on its first
 * request, and starting one here would make a remote sweep look at the wrong
 * process.
 */
const BASE_URL = process.env.SWEEP_BASE_URL;
if (!BASE_URL) {
    throw new Error(
        'SWEEP_BASE_URL is required for the route sweep (for example, http://127.0.0.1:9999).',
    );
}
// Through a tunnel the browser runs under the target's own host name (see
// browser-origin.ts); API projects keep SWEEP_BASE_URL.
const BROWSER = sweepBrowserOrigin(BASE_URL, process.env.SWEEP_CSRF_ORIGIN);

export default defineConfig({
    // Keep the sweep isolated from the existing e2e suite and its database hooks.
    testDir: './tests/route-sweep',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,

    /*
     * The target is REMOTE, usually behind an SSH tunnel or Tailscale, and it is
     * a single application instance rather than a worker-per-core farm.
     * Unlimited parallelism does not speed this up, it starves it: at default
     * workers, Tier B's twelve admin pages failed to render their forms inside
     * 15s and the tier reported "no save form rendered" for pages that serve one
     * in under five seconds when asked on their own. Dropping to two workers
     * cut those rows from ten to four.
     *
     * The default test timeout is likewise sized for a local dev server. An
     * admin settings page over a tunnel legitimately needs longer than 30s once
     * several are loading at once.
     *
     * Override with SWEEP_WORKERS when the target can take more (a local stack,
     * or the fresh-install box on the same LAN).
     */
    workers: Number(process.env.SWEEP_WORKERS ?? (process.env.CI ? 1 : 2)),
    timeout: Number(process.env.SWEEP_TEST_TIMEOUT_MS ?? 90_000),

    // JSON is opt-in because it is the machine-readable artifact consumed by
    // the sweep reporting scripts; local runs should not write into the tree.
    reporter: [
        ['list'],
        // Its OWN folder: sharing 'playwright-report' with the main e2e suite would
        // make a sweep run overwrite that suite's last report. Ignored via .gitignore.
        ['html', { open: 'never', outputFolder: 'playwright-route-sweep-report' }],
        ...(process.env.PLAYWRIGHT_JSON_REPORT
            ? [['json', { outputFile: process.env.PLAYWRIGHT_JSON_REPORT }] as const]
            : []),
    ],

    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
    },

    projects: [
        {
            name: 'api',
            testMatch: '**/*.api.spec.ts',
            // API tests use Playwright's request context and do not need a browser.
            fullyParallel: false,
            use: {},
        },
        {
            name: 'ui',
            testMatch: '**/*.ui.spec.ts',
            use: {
                ...devices['Desktop Chrome'],
                baseURL: BROWSER.baseURL,
                launchOptions: { args: BROWSER.launchArgs },
            },
        },
    ],
});
