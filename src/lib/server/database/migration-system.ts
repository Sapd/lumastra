// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Versioned Database Migration System
// Tracks migration history and ensures idempotent updates

import type postgres from 'postgres';
import { Database } from './connection.js';
import { Logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// postgres.js type shim (applies program-wide — module augmentations are
// collected across every file in the program, so this file need not be
// imported for the fix to take effect).
//
// postgres.js declares `TransactionSql` as `Omit<Sql, ...>`. `Omit` is a mapped
// type, and mapped types DROP CALL SIGNATURES and INDEX/heritage — so through
// the published types a transaction handle is (a) not callable as a tagged
// template (`tx`…`` reports TS2349 "no call signatures") and (b) not assignable
// to `Sql` (missing CLOSE/END/PostgresError/… → TS2740). Both are spurious: at
// runtime a transaction handle IS the same callable, fully Sql-shaped function
// object. Re-open the interface so it once again `extends Sql`, restoring the
// call signatures and Sql-assignability. Declaration merging unions the heritage
// clauses; the three members below are restated verbatim from the library's own
// `Sql` definition purely to reconcile a polymorphic-`this` mismatch between the
// merged `Omit<Sql, …>` and `Sql` bases (otherwise TS2320). No behavior change.
declare module 'postgres' {
    interface TransactionSql<
        // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the `= {}` default MUST match postgres.js's own `TransactionSql<TTypes extends Record<string, unknown> = {}>` verbatim; interface declaration merging requires identical type parameters (else TS2428). See docs/dev/eslint-exceptions.md.
        TTypes extends Record<string, unknown> = {},
    > extends postgres.Sql<TTypes> {
        types: this['typed'];
        typed: (<T>(value: T, oid: number) => postgres.Parameter<T>) & {
            [name in keyof TTypes]: (value: TTypes[name]) => postgres.Parameter<TTypes[name]>;
        };
        END: this['CLOSE'];
    }
}

const logger = Logger.for('Migration');

export interface MigrationRecord {
    version: string;
    name: string;
    applied_at: Date;
    checksum?: string;
    description?: string;
}

export interface Migration {
    version: string;
    name: string;
    description: string;
    // Typed as TransactionSql (NOT Sql) to document intent: the runner already
    // wraps every migration in `sql.begin(...)`, so `up`/`down` receive a
    // transaction handle — never the root pool. Migrations MUST NOT call
    // `sql.begin()` inside up(): nesting a transaction throws at runtime and
    // crash-loops prod boot (it has, once). NOTE: this is now a runtime-only
    // hazard. The postgres.js type shim at the top of this file restores
    // TransactionSql to its true, fully Sql-shaped form (a tx handle really is a
    // callable Sql at runtime), so `.begin` is again visible and no longer
    // blocked at compile time — treat "no nested begin" as a hard convention.
    up: (sql: postgres.TransactionSql) => Promise<void>;
    down?: (sql: postgres.TransactionSql) => Promise<void>;
    /**
     * Optional resumable data work, executed before up() without a surrounding
     * transaction. Must be idempotent and open its own bounded transactions.
     * The normal migration lock remains held; success is recorded only after
     * this callback and up() complete. A failure retries the callback on boot.
     */
    nonTransactionalUp?: (sql: postgres.Sql) => Promise<void>;
    checksum: string; // Hash of the migration content for verification
}

export class MigrationSystem {
    // Advisory-lock coordinates that serialize concurrent migrators (e.g. the
    // web and worker containers booting against a fresh DB). Without this they
    // race in initializeMigrationTable and the loser crashes on a duplicate
    // schema_migrations pg_type entry. ns/key are arbitrary but stable.
    private static readonly MIGRATION_LOCK_NS = 4242;
    private static readonly MIGRATION_LOCK_KEY = 1;

    // Lazily resolved so constructing the system never requires a live pool at
    // import/construction time (tests inject a mock by assigning `sql`). In
    // production the pool is resolved on first use via the `Database` wrapper.
    private _sql: postgres.Sql | null;

    constructor(providedSql?: postgres.Sql | null) {
        this._sql = providedSql ?? null;
    }

    private get sql(): postgres.Sql {
        if (!this._sql) {
            this._sql = new Database().getSql();
        }
        return this._sql;
    }

    private set sql(value: postgres.Sql) {
        this._sql = value;
    }

    /**
     * Initialize migration tracking table
     */
    async initializeMigrationTable(): Promise<void> {
        await this.sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        version VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        checksum VARCHAR(64),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_time_ms INTEGER,
        success BOOLEAN NOT NULL DEFAULT true
      )
    `;

        await this.sql`
      CREATE INDEX IF NOT EXISTS idx_schema_migrations_version
      ON schema_migrations (version)
    `;

        await this.sql`
      CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
      ON schema_migrations (applied_at DESC)
    `;
    }

    /**
     * Get all applied migrations
     */
    async getAppliedMigrations(): Promise<MigrationRecord[]> {
        return await this.sql`
      SELECT version, name, description, checksum, applied_at
      FROM schema_migrations
      WHERE success = true
      ORDER BY version ASC
    `;
    }

    /**
     * Check if a migration has been applied
     */
    async isMigrationApplied(version: string): Promise<boolean> {
        const result = await this.sql`
      SELECT 1 FROM schema_migrations
      WHERE version = ${version} AND success = true
    `;
        return result.length > 0;
    }

    /**
     * Look up the stored row for an already-applied migration. Returns the
     * version + checksum so callers can detect post-deployment drift (an edited
     * migration file whose checksum no longer matches what was recorded when it
     * first ran). Returns null when the migration has not been applied.
     */
    async getAppliedMigrationChecksum(
        version: string,
    ): Promise<{ version: string; checksum: string | null } | null> {
        const result = await this.sql<{ version: string; checksum: string | null }[]>`
      SELECT version, checksum FROM schema_migrations
      WHERE version = ${version} AND success = true
    `;
        return result[0] ?? null;
    }

    /**
     * Apply a migration
     */
    async applyMigration(migration: Migration): Promise<void> {
        const startTime = Date.now();

        logger.info(` Applying ${migration.version}: ${migration.name}`);

        // Check if already applied. When it is, compare the stored checksum
        // against the current migration object's checksum: a mismatch means an
        // already-applied migration file was edited after deployment, which
        // silently desyncs code from the live schema. Fail loudly on drift
        // rather than skipping — the operator must reconcile by hand. This runs
        // OUTSIDE the apply try/catch below so a drift error is never recorded
        // as a (false) failed migration row.
        const applied = await this.getAppliedMigrationChecksum(migration.version);
        if (applied) {
            this.assertChecksumMatches(applied, migration);
            logger.info(` ⏭️  ${migration.version} already applied, skipping`);
            return;
        }

        try {
            // Large resumable data repairs commit their own small transactions;
            // they must not retain schema/row locks until the whole repair ends.
            await migration.nonTransactionalUp?.(this.sql);
            // Apply the migration and record success atomically. `begin()` hands
            // the callback a TransactionSql, which is exactly what migration.up
            // expects now — no cast needed (and `.begin` is intentionally absent
            // so a nested-transaction migration can't compile).
            let executionTime = 0;
            await this.sql.begin(async (tx) => {
                await migration.up(tx);

                executionTime = Date.now() - startTime;

                await tx`
          INSERT INTO schema_migrations
          (version, name, description, checksum, execution_time_ms, success)
          VALUES (
            ${migration.version},
            ${migration.name},
            ${migration.description},
            ${migration.checksum},
            ${executionTime},
            true
          )
          ON CONFLICT (version) DO UPDATE SET
            success = true,
            execution_time_ms = ${executionTime},
            applied_at = NOW()
        `;
            });

            logger.info(` ✅ ${migration.version} applied successfully (${executionTime}ms)`);
        } catch (error) {
            const executionTime = Date.now() - startTime;

            // Record failed migration (use ON CONFLICT to handle re-runs)
            try {
                await this.sql`
          INSERT INTO schema_migrations
          (version, name, description, checksum, execution_time_ms, success)
          VALUES (
            ${migration.version},
            ${migration.name},
            ${migration.description},
            ${migration.checksum},
            ${executionTime},
            false
          )
          ON CONFLICT (version) DO UPDATE SET
            success = false,
            execution_time_ms = ${executionTime},
            applied_at = NOW()
        `;
            } catch (recordError) {
                logger.error(
                    'Failed to record migration failure',
                    recordError instanceof Error ? recordError : undefined,
                );
            }

            logger.error('Migration failed', error instanceof Error ? error : undefined, {
                version: migration.version,
                executionTimeMs: executionTime,
            });
            throw error;
        }
    }

    /**
     * Sentinel checksum carried by legacy 'legacy_superseded' rows that older
     * installs wrote when the base schema superseded a migration (the runner no
     * longer writes these, but existing databases still contain them). These
     * rows carry no real content hash, so drift detection must skip them.
     */
    private static readonly SUPERSEDED_CHECKSUM = 'superseded';

    /**
     * Compare the checksum recorded when a migration first ran against the
     * checksum of the in-code migration object. Throws on drift so boot fails
     * loudly instead of running with code that no longer matches the live
     * schema. Skips rows with no stored checksum or the `superseded` sentinel,
     * which are intentional non-content markers.
     */
    private assertChecksumMatches(
        applied: { version: string; checksum: string | null },
        migration: Migration,
    ): void {
        const stored = applied.checksum;
        if (
            stored === null ||
            stored === undefined ||
            stored === MigrationSystem.SUPERSEDED_CHECKSUM
        ) {
            return;
        }

        if (stored !== migration.checksum) {
            const message =
                `Migration checksum drift detected for ${migration.version} ` +
                `(${migration.name}): stored checksum "${stored}" does not match ` +
                `current checksum "${migration.checksum}". An already-applied ` +
                `migration file was edited after it ran. Refusing to boot — ` +
                `revert the migration file or create a new versioned migration.`;
            logger.warn(message, {
                version: migration.version,
                storedChecksum: stored,
                currentChecksum: migration.checksum,
            });
            throw new Error(message);
        }
    }

    /**
     * Get current database schema version
     */
    async getCurrentVersion(): Promise<string> {
        try {
            const result = await this.sql<{ version: string }[]>`
        SELECT version FROM schema_migrations
        WHERE success = true
      `;

            if (result.length === 0) return '0.0.0';

            // Sort by semantic version and return the highest
            const versions = result.map((r) => r.version);
            versions.sort((a: string, b: string) => this.compareVersions(b, a)); // Descending
            return versions[0];
        } catch {
            // If table doesn't exist, we're at version 0
            return '0.0.0';
        }
    }

    /**
     * Compare two semantic versions
     */
    private compareVersions(v1: string, v2: string): number {
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
     * Check if this is a fresh database (no application tables exist)
     */
    async isFreshDatabase(): Promise<boolean> {
        try {
            // Check if the media table exists (either old name or new name)
            const result = await this.sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name IN ('media_catalog', 'media_embeddings', 'media_items')
        )
      `;
            return !result[0]?.exists;
        } catch {
            // If we can't query, assume fresh
            return true;
        }
    }

    /**
     * Run all pending migrations with support for base schema on fresh installs.
     *
     * Wrapped in a database advisory lock so concurrent migrators are
     * serialized: the web and worker containers boot simultaneously and both
     * run startup migration, and without the lock the loser crashes in
     * initializeMigrationTable on a duplicate schema_migrations pg_type entry.
     * The reserved connection keeps the lock bound to one session for the whole
     * acquire→run→release cycle. The loser blocks until the winner finishes,
     * then sees a non-fresh DB and no pending migrations. If the lock cannot be
     * acquired within lockTimeoutMs (default 120s) the runner throws instead of
     * proceeding unlocked — see the comment at the throw site.
     */
    async runMigrations(
        migrations: Migration[],
        options?: {
            baseSchemaMigration?: Migration;
            lockTimeoutMs?: number;
        },
    ): Promise<void> {
        const reserved = await this.sql.reserve();
        // postgres.js ReservedSql is callable as a tagged template but its type
        // isn't directly assignable to postgres.Sql; cast for use below.
        const rSql = reserved as unknown as postgres.Sql;
        let locked = false;
        try {
            const lockTimeoutMs = options?.lockTimeoutMs ?? 120_000;
            const deadline = Date.now() + lockTimeoutMs;
            for (;;) {
                const [row] = await rSql<{ ok: boolean }[]>`
                    SELECT pg_try_advisory_lock(${MigrationSystem.MIGRATION_LOCK_NS}, ${MigrationSystem.MIGRATION_LOCK_KEY}) AS ok
                `;
                locked = row?.ok === true;
                if (locked || Date.now() >= deadline) break;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!locked) {
                // Fail rather than proceed unlocked: the usual reason the lock is
                // still held past the timeout is another migrator mid-way through
                // a slow migration (e.g. a large index build) — exactly the case
                // where running the same DDL concurrently is unsafe. Throwing
                // fails the boot; start.sh exits non-zero and the container
                // restart retries acquisition with a fresh timeout, so a slow
                // winner is waited out across restarts instead of raced.
                throw new Error(
                    `Migration advisory lock not acquired within ${lockTimeoutMs}ms — ` +
                        `another migrator is likely still running (or a session leaked the lock: ` +
                        `check pg_locks for advisory lock ${MigrationSystem.MIGRATION_LOCK_NS}/${MigrationSystem.MIGRATION_LOCK_KEY}). ` +
                        `Refusing to run migrations concurrently; will retry on next boot.`,
                );
            }
            await this.runMigrationsInner(migrations, options);
        } finally {
            if (locked) {
                try {
                    await rSql`SELECT pg_advisory_unlock(${MigrationSystem.MIGRATION_LOCK_NS}, ${MigrationSystem.MIGRATION_LOCK_KEY})`;
                } catch (err) {
                    logger.warn('Failed to release migration advisory lock', {}, err as Error);
                }
            }
            try {
                reserved.release();
            } catch {
                // postgres.js may throw if already released — harmless
            }
        }
    }

    private async runMigrationsInner(
        migrations: Migration[],
        options?: {
            baseSchemaMigration?: Migration;
        },
    ): Promise<void> {
        logger.info(' Initializing migration system...');
        await this.initializeMigrationTable();

        let currentVersion = await this.getCurrentVersion();
        logger.info(` Current database version: ${currentVersion}`);

        // Check if this is a fresh database and we have a base schema
        const isFresh = await this.isFreshDatabase();

        if (isFresh && options?.baseSchemaMigration) {
            logger.info(' 🆕 Fresh database detected - using base schema for faster setup');

            // Apply base schema
            await this.applyMigration(options.baseSchemaMigration);

            // Re-read the watermark after the base schema records BASE_SCHEMA_VERSION.
            // Every historical migration version <= that watermark is then skipped by
            // the version comparison in the loop below — there is no enumerated legacy
            // list; the watermark is the single source of "already applied".
            currentVersion = await this.getCurrentVersion();
            logger.info(` ✅ Base schema applied, database version: ${currentVersion}`);
            // Continue below to apply any incremental migrations newer than the base schema
        } else if (
            options?.baseSchemaMigration &&
            this.compareVersions(currentVersion, options.baseSchemaMigration.version) < 0
        ) {
            // An existing database below the squashed base: the migrations that would
            // bring it up to the base were folded into it and deleted, so nothing here
            // can apply them. Skipping on would leave this schema silently behind
            // fresh installs; refuse instead.
            throw new Error(
                `Database schema version ${currentVersion} is below the squashed base ` +
                    `schema ${options.baseSchemaMigration.version}. The migrations up to ` +
                    `${options.baseSchemaMigration.version} were folded into the base schema ` +
                    `and are no longer shipped. Upgrade through a release whose base schema ` +
                    `is at or below ${currentVersion} first, then to this one.`,
            );
        }

        // Sort migrations by semantic version
        const sortedMigrations = [...migrations].sort((a, b) =>
            this.compareVersions(a.version, b.version),
        );

        // Stored checksums for every successfully-applied migration, fetched
        // once so the skip branch below can (a) detect drift — an already-applied
        // migration file edited after it ran — and (b) detect an out-of-order
        // migration: one whose version is at or below the watermark but that
        // never actually ran on this database (e.g. two work streams merged
        // migrations out of numeric order). Both previously passed silently:
        // the version check skipped the migration before applyMigration's
        // drift check could ever see it.
        const appliedRows = await this.getAppliedMigrations();
        const appliedByVersion = new Map(appliedRows.map((r) => [r.version, r.checksum ?? null]));

        let appliedCount = 0;

        for (const migration of sortedMigrations) {
            // At or below the watermark: verify instead of blindly skipping.
            if (this.compareVersions(migration.version, currentVersion) <= 0) {
                if (appliedByVersion.has(migration.version)) {
                    this.assertChecksumMatches(
                        {
                            version: migration.version,
                            checksum: appliedByVersion.get(migration.version) ?? null,
                        },
                        migration,
                    );
                    continue;
                }
                // Note: the base schema watermark only covers migrations whose
                // files were deleted in the squash — anything still in the
                // MIGRATIONS array is expected to have its own applied row.
                throw new Error(
                    `Migration ${migration.version} (${migration.name}) has a version at or ` +
                        `below the current database version ${currentVersion} but was never ` +
                        `applied here — it would be silently skipped forever, diverging this ` +
                        `schema from fresh installs. This usually means it was added out of ` +
                        `numeric order (or a previous attempt failed while a later migration ` +
                        `succeeded). Renumber it above ${currentVersion}, or apply it by hand ` +
                        `and record it in schema_migrations.`,
                );
            }

            await this.applyMigration(migration);
            appliedCount++;
        }

        if (appliedCount === 0) {
            logger.info(' ✅ Database is up to date');
        } else {
            const newVersion = await this.getCurrentVersion();
            logger.info(` ✅ Applied ${appliedCount} migrations, database version: ${newVersion}`);
        }
    }

    /**
     * Generate migration status report
     */
    async getStatus(): Promise<{
        current_version: string;
        applied_migrations: number;
        last_migration: MigrationRecord | null;
        pending_migrations?: Migration[];
    }> {
        const currentVersion = await this.getCurrentVersion();
        const appliedMigrations = await this.getAppliedMigrations();

        return {
            current_version: currentVersion,
            applied_migrations: appliedMigrations.length,
            last_migration: appliedMigrations.at(-1) ?? null,
        };
    }
}

/**
 * Generate checksum for migration content
 */
export function generateMigrationChecksum(content: string): string {
    // Simple hash function for migration verification
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.codePointAt(i) ?? 0;
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
}

// Export for backward compatibility
export { migrateSchema } from './migrate-schema.js';
