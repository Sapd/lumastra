// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test Database Migration Runner
 *
 * Runs database migrations against the test database.
 * Imports the canonical MIGRATIONS array from migrate-schema.ts (single source of truth)
 * so new migrations are automatically available to tests.
 */

import type { Sql, TransactionSql } from 'postgres';
import { getTestDb } from './test-database.js';

// Import from production sources — single source of truth
import { BASE_SCHEMA_MIGRATION } from '../../../src/lib/server/database/base-schema.js';
import { MIGRATIONS } from '../../../src/lib/server/database/migrate-schema.js';
import type { Migration } from '../../../src/lib/server/database/migration-system.js';

/**
 * Initialize migration tracking table.
 */
async function initializeMigrationTable(sql: Sql): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            version VARCHAR(50) NOT NULL UNIQUE,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            checksum VARCHAR(64),
            applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
            execution_time_ms INTEGER,
            success BOOLEAN NOT NULL DEFAULT true
        )
    `;

    await sql`
        CREATE INDEX IF NOT EXISTS idx_schema_migrations_version
        ON schema_migrations (version)
    `;
}

/**
 * Check if a migration has been applied.
 */
async function isMigrationApplied(sql: Sql, version: string): Promise<boolean> {
    const result = await sql`
        SELECT 1 FROM schema_migrations
        WHERE version = ${version} AND success = true
    `;
    return result.length > 0;
}

/**
 * Sentinel checksum carried by legacy 'legacy_superseded' rows that older
 * installs wrote when the base schema superseded a migration. Mirrors
 * MigrationSystem.SUPERSEDED_CHECKSUM in migration-system.ts — these rows
 * carry no real content hash, so drift detection must skip them.
 */
const SUPERSEDED_CHECKSUM = 'superseded';

/**
 * Fetch the checksum recorded for every successfully-applied migration,
 * keyed by version.
 */
async function getAppliedChecksums(sql: Sql): Promise<Map<string, string | null>> {
    const rows = await sql<{ version: string; checksum: string | null }[]>`
        SELECT version, checksum FROM schema_migrations WHERE success = true
    `;
    return new Map(rows.map((row) => [row.version, row.checksum]));
}

/**
 * Compare the checksum recorded when a migration first ran against the
 * checksum of the in-code migration object. Throws on drift so the test
 * migrator fails loudly instead of silently running against a schema that
 * no longer matches the migration files. Mirrors
 * MigrationSystem.assertChecksumMatches (migration-system.ts) — the app
 * boot path this runner otherwise bypasses entirely. Skips rows with no
 * stored checksum or the `superseded` sentinel, which are intentional
 * non-content markers.
 */
function assertChecksumMatches(stored: string | null | undefined, migration: Migration): void {
    if (stored === null || stored === undefined || stored === SUPERSEDED_CHECKSUM) {
        return;
    }

    if (stored !== migration.checksum) {
        const message =
            `Migration checksum drift detected for ${migration.version} ` +
            `(${migration.name}): stored checksum "${stored}" does not match ` +
            `current checksum "${migration.checksum}". An already-applied ` +
            `migration file was edited after it ran. Refusing to boot — ` +
            `revert the migration file or create a new versioned migration.`;
        console.error(`[test-migrations] ❌ ${message}`);
        throw new Error(message);
    }
}

/**
 * Check if this is a fresh database (no application tables exist).
 */
async function isFreshDatabase(sql: Sql): Promise<boolean> {
    const result = await sql`
        SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_name IN ('media_catalog', 'media_embeddings', 'media_items')
        ) as exists
    `;
    return !result[0]?.exists;
}

/**
 * Apply a single migration.
 */
async function applyMigration(sql: Sql, migration: Migration): Promise<void> {
    const startTime = Date.now();
    console.log(`[test-migrations] Applying ${migration.version}: ${migration.name}`);

    try {
        if (await isMigrationApplied(sql, migration.version)) {
            console.log(`[test-migrations] ${migration.version} already applied, skipping`);
            return;
        }

        // Migrations declare a `TransactionSql` handle (documentation of intent —
        // production wraps each in `sql.begin`). The test runner applies them on
        // the pool directly, which is valid at runtime since a tx handle is a
        // fully Sql-shaped callable; narrow the pool to the declared handle type.
        await migration.nonTransactionalUp?.(sql);
        await migration.up(sql as TransactionSql);
        const executionTime = Date.now() - startTime;

        await sql`
            INSERT INTO schema_migrations
            (version, name, description, checksum, execution_time_ms, success)
            VALUES (
                ${migration.version},
                ${migration.name},
                ${migration.description},
                ${migration.checksum ?? null},
                ${executionTime},
                true
            )
            ON CONFLICT (version) DO UPDATE SET
                success = true,
                execution_time_ms = ${executionTime},
                applied_at = NOW()
        `;

        console.log(`[test-migrations] ✅ ${migration.version} applied (${executionTime}ms)`);
    } catch (error) {
        const executionTime = Date.now() - startTime;
        console.error(
            `[test-migrations] ❌ ${migration.version} failed (${executionTime}ms):`,
            error,
        );
        throw error;
    }
}

/**
 * Compare semantic versions.
 */
function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

/**
 * Get current database schema version.
 */
async function getCurrentVersion(sql: Sql): Promise<string> {
    try {
        const result = await sql<{ version: string }[]>`
            SELECT version FROM schema_migrations
            WHERE success = true
        `;
        if (result.length === 0) return '0.0.0';
        // Use proper semver comparison instead of string ORDER BY
        const versions = result.map((r) => r.version);
        versions.sort(compareVersions);
        return versions[versions.length - 1] || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * Run all pending migrations against the test database.
 *
 * @param sql - Optional database connection (uses test DB if not provided)
 */
export async function runTestMigrations(sql?: Sql): Promise<void> {
    const db = sql || getTestDb();
    console.log('[test-migrations] Starting test database migrations...');

    await initializeMigrationTable(db);

    const isFresh = await isFreshDatabase(db);
    let currentVersion = await getCurrentVersion(db);
    console.log(`[test-migrations] Current version: ${currentVersion}, Fresh DB: ${isFresh}`);

    if (isFresh) {
        console.log('[test-migrations] Fresh database detected - applying base schema');
        await applyMigration(db, BASE_SCHEMA_MIGRATION);
        // Re-read the watermark AFTER the base schema records BASE_SCHEMA_VERSION.
        // This mirrors the production runner (migration-system.ts): every migration
        // version <= the watermark is then skipped by the loop's version comparison.
        // There is no enumerated legacy list — the watermark is the sole source of
        // "already applied".
        currentVersion = await getCurrentVersion(db);
    } else if (compareVersions(currentVersion, BASE_SCHEMA_MIGRATION.version) < 0) {
        // Mirrors the production runner: the migrations below the squashed base
        // were folded into it and deleted, so this database can never catch up.
        throw new Error(
            `[test-migrations] Test database is at ${currentVersion}, below the squashed base ` +
                `schema ${BASE_SCHEMA_MIGRATION.version}. Drop and recreate it.`,
        );
    }

    // Sort and apply pending migrations
    const sortedMigrations = [...MIGRATIONS].sort((a, b) => compareVersions(a.version, b.version));
    const appliedChecksums = await getAppliedChecksums(db);

    let appliedCount = 0;
    for (const migration of sortedMigrations) {
        if (compareVersions(migration.version, currentVersion) <= 0) {
            assertChecksumMatches(appliedChecksums.get(migration.version), migration);
            continue;
        }
        await applyMigration(db, migration);
        appliedCount++;
    }

    const finalVersion = await getCurrentVersion(db);
    if (appliedCount === 0) {
        console.log('[test-migrations] ✅ Database is up to date');
    } else {
        console.log(
            `[test-migrations] ✅ Applied ${appliedCount} migrations, version: ${finalVersion}`,
        );
    }

    // Disable the DB-side event-outbox trigger for the test environment.
    //
    // Without this row, pipeline_event_outbox_enabled() returns NULL.
    // In PL/pgSQL `IF NOT NULL` evaluates as `IF NULL` (not truthy), so the
    // guard in emit_pipeline_event() does NOT take the RETURN branch — the
    // trigger fires on EVERY media_items INSERT and silently pollutes
    // event_outbox across all test files.
    //
    // Setting the flag to 'off' makes the function return literal false, so
    // `IF NOT false` → `IF true` → RETURN — trigger is inert.
    //
    // DO UPDATE (not DO NOTHING) resets the flag even if a previous test run
    // crashed while it was 'on' (left by media-lifecycle-after-created-repro's
    // beforeAll). Tests that legitimately exercise the trigger already read
    // priorFlag in beforeAll, flip to 'on', and restore via afterAll — they
    // are unaffected by this seed.
    await db`
        INSERT INTO feature_flags (key, value)
        VALUES ('event_outbox_enabled', 'off')
        ON CONFLICT (key) DO UPDATE SET value = 'off', updated_at = now()
    `;
    console.log('[test-migrations] ✅ Seeded event_outbox_enabled=off (trigger inert for tests)');
}

/**
 * Reset test database to a clean state.
 * Drops all tables and re-runs migrations.
 */
export async function resetTestDatabase(sql?: Sql): Promise<void> {
    const db = sql || getTestDb();
    console.log('[test-migrations] Resetting test database...');

    // Drop all tables in public schema
    await db`
        DO $$ DECLARE
            r RECORD;
        BEGIN
            -- Disable triggers
            EXECUTE 'SET session_replication_role = replica';

            -- Drop all tables
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
                EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
            END LOOP;

            -- Drop all sequences
            FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
                EXECUTE 'DROP SEQUENCE IF EXISTS public.' || quote_ident(r.sequence_name) || ' CASCADE';
            END LOOP;

            -- Drop all functions — but SKIP functions owned by an extension
            -- (e.g. pg_trgm's set_limit(real)); Postgres refuses to drop those
            -- directly ("cannot drop function ... because extension ... requires it").
            FOR r IN (
                SELECT p.proname, oidvectortypes(p.proargtypes) AS args
                FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace
                  AND NOT EXISTS (
                      SELECT 1 FROM pg_depend d
                      WHERE d.objid = p.oid AND d.deptype = 'e'
                  )
            ) LOOP
                EXECUTE 'DROP FUNCTION IF EXISTS public.' || quote_ident(r.proname) || '(' || r.args || ') CASCADE';
            END LOOP;

            -- Drop all enum types — likewise skip extension-owned types.
            FOR r IN (
                SELECT t.typname
                FROM pg_type t
                WHERE t.typnamespace = 'public'::regnamespace
                  AND t.typtype = 'e'
                  AND NOT EXISTS (
                      SELECT 1 FROM pg_depend d
                      WHERE d.objid = t.oid AND d.deptype = 'e'
                  )
            ) LOOP
                EXECUTE 'DROP TYPE IF EXISTS public.' || quote_ident(r.typname) || ' CASCADE';
            END LOOP;

            -- Re-enable triggers
            EXECUTE 'SET session_replication_role = DEFAULT';
        END $$;
    `;

    console.log('[test-migrations] Database reset complete, running migrations...');
    await runTestMigrations(db);
}

// CLI execution support
if (import.meta.url === `file://${process.argv[1]}`) {
    const command = process.argv[2];

    if (command === 'reset') {
        resetTestDatabase()
            .then(() => {
                console.log('[test-migrations] Reset complete');
                process.exit(0);
            })
            .catch((error) => {
                console.error('[test-migrations] Reset failed:', error);
                process.exit(1);
            });
    } else {
        runTestMigrations()
            .then(() => {
                console.log('[test-migrations] Migrations complete');
                process.exit(0);
            })
            .catch((error) => {
                console.error('[test-migrations] Migrations failed:', error);
                process.exit(1);
            });
    }
}
