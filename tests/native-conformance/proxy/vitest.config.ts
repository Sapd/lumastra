// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { cleanVitestTmpDir } from '../../vitest/vitest.tmpdir-cleanup';

// mergeConfig concatenates include arrays: replace it explicitly so an isolated
// conformance run does not silently execute the entire TS reference suite again.
export default defineConfig({
    plugins: [cleanVitestTmpDir()],
    test: {
        include: ['tests/native-conformance/proxy/**/*.test.ts'],
        pool: 'forks',
        maxWorkers: 2,
        testTimeout: 25000,
        environment: 'node',
    },
});
