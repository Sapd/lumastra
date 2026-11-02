// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';
export default defineConfig({
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
