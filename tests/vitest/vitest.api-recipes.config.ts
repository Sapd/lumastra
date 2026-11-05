// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
// This file lives in tests/vitest/. Its include/setup/globalSetup paths are relative to the
// app root, so the root is set explicitly.
const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
    root: APP_ROOT,
    plugins: [cleanVitestTmpDir()],
    test: {
        include: ['tests/api-recipes/*.test.ts'],
        environment: 'node',
        setupFiles: [],
        globalSetup: ['tests/api-recipes/global-setup.ts'],
        fileParallelism: false,
        maxWorkers: 1,
        sequence: { concurrent: false },
        testTimeout: 120000,
        hookTimeout: 60000,
    },
});
