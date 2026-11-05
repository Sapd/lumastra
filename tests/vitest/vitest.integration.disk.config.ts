// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
import { paraglideLocaleModulesForTests } from './vitest.paraglide-locale-modules';
import { sveltekit } from '@sveltejs/kit/vite';

/**
 * Vitest configuration for disk-only integration tests (no database required).
 * Use: npm run test:integration:disk
 *
 * These tests only need the filesystem — no PostgreSQL, no Valkey.
 * E.g. music-transcode disk LRU cache integration tests.
 */
// This file lives in tests/vitest/. Its include/setup/globalSetup paths are relative to the
// app root, so the root is set explicitly.
const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
    root: APP_ROOT,
    define: { __API_CONTRACT_STRICT__: true },
    plugins: [sveltekit(), cleanVitestTmpDir(), paraglideLocaleModulesForTests()],
    test: {
        include: ['src/lib/server/services/music-transcode/*.integration.test.ts'],
        exclude: ['node_modules/**'],
        environment: 'node',
        globals: true,
        testTimeout: 30000,
        hookTimeout: 30000,
        pool: 'forks',
        fileParallelism: false,
    },
});
