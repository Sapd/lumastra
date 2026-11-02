// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test Database Connection
 *
 * Provides database connection management for integration tests.
 * Uses a separate `lumastra_tests` database to avoid affecting production data.
 *
 * Priority for database URL:
 * 1. TEST_DATABASE_URL (explicit override)
 * 2. Derived from DATABASE_URL (same credentials, different database name)
 * 3. Default: postgres://localhost:5432/lumastra_tests
 */

import postgres, { type Sql } from 'postgres';
import 'dotenv/config';

// Test database name - always use this instead of production
const TEST_DATABASE_NAME = 'lumastra_tests';

/**
 * Fixed advisory-lock key used to serialize TRUNCATE-based test resets across
 * all forks/files against the shared test DB (see truncateTestTables and
 * helpers/cleanup.ts:truncateTables). Any single arbitrary 64-bit int works;
 * it only needs to be identical for every TRUNCATE caller.
 */
export const TRUNCATE_ADVISORY_LOCK_KEY = 728_415_390;

/**
 * Derive test database URL from production DATABASE_URL.
 * Replaces the database name with 'lumastra_tests' while keeping credentials.
 */
function deriveTestUrlFromProduction(productionUrl: string): string {
    try {
        const url = new URL(productionUrl);
        // Replace the pathname (database name) with test database
        url.pathname = `/${TEST_DATABASE_NAME}`;
        return url.toString();
    } catch {
        // If URL parsing fails, return default
        return `postgres://localhost:5432/${TEST_DATABASE_NAME}`;
    }
}

/**
 * Get the test database URL from environment or derive from DATABASE_URL.
 *
 * Priority:
 * 1. TEST_DATABASE_URL - explicit test database URL
 * 2. DATABASE_URL - derive from production URL (same host/credentials, different DB)
 * 3. Default fallback
 */
export function getTestDatabaseUrl(): string {
    // Explicit test database URL takes priority
    if (process.env.TEST_DATABASE_URL) {
        console.log('[test-db] Using TEST_DATABASE_URL from environment');
        return process.env.TEST_DATABASE_URL;
    }

    // Derive from production DATABASE_URL
    if (process.env.DATABASE_URL) {
        const testUrl = deriveTestUrlFromProduction(process.env.DATABASE_URL);
        console.log('[test-db] Derived test URL from DATABASE_URL');
        return testUrl;
    }

    // Default fallback (no credentials)
    console.log('[test-db] Using default fallback URL (no DATABASE_URL found)');
    return `postgres://localhost:5432/${TEST_DATABASE_NAME}`;
}

// Singleton connection instance.
//
// LIFECYCLE MODEL (read this before touching closeTestDb):
// The integration suite runs with `pool: 'forks'` + `fileParallelism: false`,
// so files run one-at-a-time but several files share a single worker (fork)
// process. This module is imported once per fork, making `testSql` a
// per-fork singleton meant to live for the ENTIRE run of that fork — it is
// opened lazily on first use and closed exactly once when the fork's process
// exits (registered below), NOT between files.
//
// Previously every test file (and the per-file setup `afterAll`) called
// closeTestDb(), draining + nulling this pool against the single shared
// `lumastra_tests` DB. Because Vitest does not guarantee that file N's
// teardown fully settles before file N+1's beforeAll/beforeEach runs its
// TRUNCATE/INSERT fixtures, the pool was being torn down mid-flight under the
// next file — surfacing as 'insert/update violates foreign key constraint' in
// fixture setup and 'deadlock detected' during cross-file TRUNCATE. The fix
// makes connection teardown the HARNESS's job (once per fork, at exit), so
// closeTestDb() is now a no-op during the run (see its doc comment).
let testSql: Sql | null = null;

// Ensure the per-fork pool is closed exactly once when the worker process
// exits, instead of between files. postgres.js sockets are unref'd, so this is
// belt-and-suspenders for a clean shutdown; the process would exit regardless.
let exitHandlerRegistered = false;
function registerProcessExitClose(): void {
    if (exitHandlerRegistered) return;
    exitHandlerRegistered = true;
    const close = () => {
        if (testSql) {
            // Null first to defeat any late getTestDb() re-init, then drain.
            const sql = testSql;
            testSql = null;
            void sql.end({ timeout: 5 }).catch(() => {});
        }
    };
    process.once('beforeExit', close);
    process.once('exit', close);
}

/**
 * Get the test database connection.
 * Uses singleton pattern to reuse connection across tests.
 *
 * Lazily (re-)initializes the pool, so even a stray hard close cannot leave a
 * file without a working connection — the next call transparently re-opens it.
 *
 * @returns Sql connection to test database
 * @throws Error if connection fails
 */
export function getTestDb(): Sql {
    if (!testSql) {
        registerProcessExitClose();
        const url = getTestDatabaseUrl();
        console.log(`[test-db] Connecting to test database: ${url.replace(/:[^:]*@/, ':****@')}`);

        // Match the production connection's type mapping so BIGINT columns
        // (position_ms, runtime_ms, session_elapsed_ms) come back as JS
        // numbers instead of BigInt. Without this, computeStateFromEvents's
        // `typeof ev.position_ms === 'number'` check fails and
        // resume_position_ms is always computed as 0.
        const bigintAsNumber = {
            to: 20,
            from: [20],
            parse: (x: string) => Number(x),
            serialize: (x: number) => x.toString(),
        };

        testSql = postgres(url, {
            max: 10,
            idle_timeout: 30,
            connect_timeout: 10,
            // Disable notices in tests to reduce noise
            onnotice: () => {},
            types: { bigint: bigintAsNumber },
        }) as unknown as Sql;
    }
    return testSql;
}

/**
 * Per-file teardown hook — INTENTIONALLY A NO-OP.
 *
 * Historically each test file called this in its own afterAll, and so did the
 * per-file setup file. With the shared `lumastra_tests` DB + `pool:'forks'`,
 * that tore the shared pool down between files and raced the next file's
 * fixture TRUNCATE/INSERT, producing flaky FK-violation + deadlock failures.
 *
 * The pool's lifecycle is now owned by the harness: it is opened lazily by
 * getTestDb() and closed exactly once per fork on process exit (see
 * registerProcessExitClose). Test files cleaning up their *data* should
 * TRUNCATE/reset (truncateTestTables / helpers/cleanup), never close the
 * connection. This export is kept so the ~250 existing `afterAll(closeTestDb)`
 * call sites compile and become harmless no-ops without touching every file.
 *
 * Use forceCloseTestDb() if you ever need to truly drop the connection.
 */
export async function closeTestDb(): Promise<void> {
    // no-op: connection lifecycle is owned by the harness (see doc comment).
}

/**
 * Truly close the test database pool. Reserved for harness-level teardown only
 * (e.g. an explicit globalTeardown); not for per-file afterAll hooks. Safe to
 * call repeatedly; getTestDb() will lazily re-open afterwards if used again.
 */
export async function forceCloseTestDb(): Promise<void> {
    if (testSql) {
        console.log('[test-db] Closing test database connection (harness teardown)');
        const sql = testSql;
        testSql = null;
        await sql.end();
    }
}

/**
 * Truncate specified tables for test isolation.
 * Uses TRUNCATE with CASCADE and RESTART IDENTITY for complete cleanup.
 *
 * @param sql - Database connection
 * @param tables - Array of table names to truncate
 *
 * @example
 * await truncateTestTables(sql, ['user_ratings_v2', 'media_items', 'external_ids']);
 */
export async function truncateTestTables(sql: Sql, tables: string[]): Promise<void> {
    if (tables.length === 0) return;

    // Truncate tables with CASCADE to handle foreign key relationships
    // RESTART IDENTITY resets auto-increment sequences.
    //
    // Serialize ALL test TRUNCATEs against this DB behind a single
    // transaction-scoped advisory lock (TRUNCATE_ADVISORY_LOCK_KEY). Different
    // callers truncate different (but CASCADE-overlapping) table sets in
    // different orders; if two resets ever overlap — e.g. a lingering teardown
    // racing the next file's beforeEach — Postgres reports 'deadlock detected'.
    // pg_advisory_xact_lock makes them queue deterministically and auto-releases
    // on commit/rollback so the lock can never leak.
    const tableList = tables.join(', ');
    await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${TRUNCATE_ADVISORY_LOCK_KEY})`;
        await tx.unsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    });
}

/**
 * Delete test data from tables with optional WHERE clause.
 * Useful for targeted cleanup when TRUNCATE is too aggressive.
 *
 * @param sql - Database connection
 * @param table - Table name
 * @param whereClause - Optional WHERE clause (without 'WHERE' keyword)
 */
export async function deleteTestData(
    sql: Sql,
    table: string,
    whereClause?: string,
): Promise<number> {
    if (whereClause) {
        const result = await sql.unsafe(`DELETE FROM ${table} WHERE ${whereClause}`);
        return result.count;
    }
    const result = await sql.unsafe(`DELETE FROM ${table}`);
    return result.count;
}

/**
 * Check if a table exists in the database.
 * Useful for conditional setup in tests.
 */
export async function tableExists(sql: Sql, tableName: string): Promise<boolean> {
    const result = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name = ${tableName}
        ) as exists
    `;
    return result[0]?.exists ?? false;
}

/**
 * Wait for database to be ready (useful for CI/CD environments).
 * Retries connection with exponential backoff.
 */
export async function waitForDatabase(
    maxRetries: number = 10,
    initialDelayMs: number = 100,
): Promise<void> {
    const sql = getTestDb();
    let delay = initialDelayMs;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sql`SELECT 1`;
            console.log(`[test-db] Database ready (attempt ${attempt}/${maxRetries})`);
            return;
        } catch (error) {
            if (attempt === maxRetries) {
                throw new Error(
                    `Database not ready after ${maxRetries} attempts: ${(error as Error).message}`,
                    { cause: error },
                );
            }
            console.log(`[test-db] Waiting for database (attempt ${attempt}/${maxRetries})...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 5000); // Max 5s delay
        }
    }
}

/**
 * Generate a unique test identifier.
 * Useful for creating isolated test data that won't conflict.
 */
export function generateTestId(prefix: string = 'test'): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${random}`;
}
