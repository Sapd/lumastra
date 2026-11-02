// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import base from './playwright.config';
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer;
export default defineConfig({
    ...base,
    workers: 1,
    retries: 0,
    webServer: {
        ...server,
        command: 'node build/index.js',
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
