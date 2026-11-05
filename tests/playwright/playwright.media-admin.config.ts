// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';
// Playwright resolves relative paths against THIS file (tests/playwright/), not the app
// root, so the paths that base inherits are re-pointed below.
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
export default defineConfig({
    ...base,
    testDir: '../../tests',
    globalSetup: '../../tests/global-setup.ts',
    globalTeardown: '../../tests/global-teardown.ts',
    reporter: [
        ['list'],
        ['html', { open: 'never', outputFolder: '../../playwright-report' }],
        ...(process.env.PLAYWRIGHT_JSON_REPORT
            ? [['json', { outputFile: process.env.PLAYWRIGHT_JSON_REPORT }] as const]
            : []),
    ],
    workers: 1,
    retries: 0,
    webServer: {
        ...server,
        command: 'node build/index.js',
        cwd: '../..',
        reuseExistingServer: false,
        env: {
            ...server?.env,
            NODE_ENV: 'production',
            HOST: '127.0.0.1',
            PORT: process.env.PLAYWRIGHT_PORT ?? '15373',
        },
        url:
            process.env.PLAYWRIGHT_BASE_URL ??
            `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '15373'}`,
    },
    use: {
        ...base.use,
        baseURL:
            process.env.PLAYWRIGHT_BASE_URL ??
            `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '15373'}`,
    },
});
