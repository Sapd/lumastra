// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from '../../../vitest.tmpdir-cleanup';

export default defineConfig({
    plugins: [cleanVitestTmpDir()],
    test: {
        include: ['tests/native-conformance/watcher/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30_000,
        maxWorkers: 1,
    },
});
