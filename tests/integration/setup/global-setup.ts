// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Vitest globalSetup for the integration suites: waits for the test database and
 * applies migrations ONCE per run, in vitest's main process.
 *
 * This used to live in the per-file `setupFiles` entry (vitest.setup.ts). Its
 * static imports (run-migrations → migrate-schema → every migration → services,
 * connection.ts, config.ts, logger, ...) loaded ~120 server modules into each test
 * file's module graph BEFORE that file's hoisted `vi.mock` calls registered. An
 * already-loaded module keeps its real bindings, so `vi.mock('$lib/server/...')` of
 * anything in that graph silently did not apply to code reached through it (the
 * media-upsert lifecycle-hook stubs had 0 calls while the real hooks ran).
 * globalSetup runs in a separate module graph, so test files start empty and
 * their mocks reach everything they import.
 */

import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
    // `test.env` is applied inside the test workers only. config.ts and
    // connection.ts snapshot DATABASE_URL / LUMASTRA_MASTER_KEY at module load, so
    // mirror it into this process before the migration graph is imported.
    Object.assign(process.env, project.config.env);

    const { waitForDatabase, forceCloseTestDb } = await import('./test-database.js');
    const { runTestMigrations } = await import('./run-migrations.js');

    console.log('\n[integration-global-setup] Waiting for database and applying migrations...');
    await waitForDatabase();
    await runTestMigrations();
    console.log('[integration-global-setup] Migrations up to date\n');

    return async () => {
        // The migration graph opens handles at import (media-files.queries
        // subscribes to Valkey); close them or vitest's process cannot exit.
        const { closeAllSubscriptions, disconnectValkey } =
            await import('../../../src/lib/server/cache/valkey.js');
        const { closeDb } = await import('../../../src/lib/server/database/connection.js');
        await Promise.allSettled([forceCloseTestDb(), closeDb(), closeAllSubscriptions()]);
        await disconnectValkey();
    };
}
