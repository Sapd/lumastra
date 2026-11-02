// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-file setup for the integration suites (wired via `setupFiles`, so it runs
 * once PER TEST FILE in each fork).
 *
 * Keep this file free of server imports. Whatever it imports is loaded into every
 * test file's module graph before that file's hoisted `vi.mock` calls register,
 * and an already-loaded module keeps its real bindings — a mock of anything in
 * that graph silently stops applying. Migrations therefore run once in
 * `global-setup.ts` (vitest `globalSetup`, a separate module graph). See
 * docs/dev/testing-traps.md.
 *
 * There is intentionally NO afterAll teardown here. The DB pool is a per-fork
 * singleton owned by the harness: it is opened lazily by getTestDb() and closed
 * exactly once when the fork's process exits (see test-database.ts). Closing it
 * per file raced the next file's fixture setup against the shared
 * `lumastra_tests` DB and produced the flaky FK-violation/deadlock failures.
 * Per-file isolation comes from TRUNCATE/reset of DATA (see helpers/cleanup),
 * never from tearing down the CONNECTION.
 */

import 'dotenv/config';
import { beforeAll } from 'vitest';
import { waitForDatabase } from './test-database.js';

// Mirror TEST_DATABASE_URL onto DATABASE_URL so production-code paths that
// read `process.env.DATABASE_URL` at module load talk to lumastra_tests, not the
// live DB. The primary routing happens in the vitest config via `test.env`
// (applied before any module loads); this remains as a defensive mirror for
// runs that pass an explicit TEST_DATABASE_URL.
if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Warm this fork's test pool before the file's first test. postgres.js loads the
// array type OIDs on its first connection; a file whose first query is a
// `sql.array(...)` on a cold pool sends it untyped and fails with "malformed
// array literal". The old per-file migration check hid this by querying first.
// test-database.ts imports only postgres, so this does not preload server code.
beforeAll(async () => {
    await waitForDatabase();
});
