// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { cleanVitestTmpDir } from './vitest.tmpdir-cleanup';

// This file lives in tests/vitest/. Its include/setup/globalSetup paths are relative to the
// app root, so the root is set explicitly.
const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Scoped config for Valkey-only integration tests — the Lua admission
 * primitives in `cache/valkey.ts` (`sAddBounded`, `zAddBoundedExpiring`) need a
 * REAL Valkey/Redis server to prove the script itself is correct (the mocked
 * unit suite only proves the JS wrapper calls `EVAL` with the right args; it
 * never runs the script). They do NOT need Postgres.
 *
 * `vitest.integration.config.ts` (the app's main integration config) requires
 * a database via its `setupFiles` (`tests/integration/setup/vitest.setup.ts`
 * runs migrations and hard-fails without one) — unnecessary weight and risk
 * for a Valkey-only concern. This config skips that setup entirely.
 *
 * Point `CACHE_URL` at a throwaway Valkey you start yourself (never a shared
 * instance — these tests FLUSHDB-adjacent keys are safe to collide with
 * nothing else). Tests skip cleanly (not fail) when CACHE_URL is unset or the
 * server is unreachable, matching the rest of the integration suite's posture
 * toward an optional/absent backend.
 *
 * This file is intentionally its own, single-purpose target rather than a
 * `src/**` glob: `valkey-zadd-bounded.integration.test.ts` is named with the
 * app-wide `*.integration.test.ts` convention (so it ALSO ships as part of
 * the normal `npm run test:integration` run, alongside the Postgres-backed
 * suite, whenever a real environment provides both) — this config exists so
 * it can additionally be run on its own, without paying the Postgres setup
 * cost, when only Valkey is available.
 *
 * Run: CACHE_URL=redis://localhost:<port>/0 npx vitest run --config tests/vitest/vitest.config.valkey-integration.ts
 */
export default defineConfig({
    root: APP_ROOT,
    plugins: [cleanVitestTmpDir()],
    test: {
        include: ['src/lib/server/cache/valkey-zadd-bounded.integration.test.ts'],
        exclude: ['node_modules/**'],
        environment: 'node',
        globals: true,
        testTimeout: 20_000,
        hookTimeout: 20_000,
        pool: 'forks',
        fileParallelism: false,
    },
});
