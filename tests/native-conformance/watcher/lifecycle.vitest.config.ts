// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from '../../../vitest.tmpdir-cleanup';

export default defineConfig({
    plugins: [cleanVitestTmpDir()],
    test: {
        include: ['tests/native-conformance/watcher/lifecycle.qualify.ts'],
        environment: 'node',
        maxWorkers: 1,
        fileParallelism: false,
        testTimeout: 300_000,
    },
});
