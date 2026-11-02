// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Versioned Database Schema Migration
//
// The schema is delivered as a squashed base snapshot (base-schema.ts /
// base-schema-sql.ts) covering every migration through 16.467.0. On a fresh
// database the base schema is applied and BASE_SCHEMA_VERSION is recorded as the
// watermark; on an existing database the base schema is skipped and only
// migrations newer than the watermark run. The historical migration files were
// removed in the squash — see git history for their content.
//
// To add a new migration: create migrations/<version>_<name>.ts exporting a
// `Migration` object, import it here, and append it to MIGRATIONS. Its version
// must be greater than the highest version already applied on every deployed
// database (not just BASE_SCHEMA_VERSION) — the runner refuses to boot when a
// MIGRATIONS entry sits at or below the watermark without an applied row, and
// refuses on checksum drift when an already-applied migration file is edited.
//
// SIZING GUIDANCE for migrations that touch `media_item_stage_state`:
// Any migration that bulk-inserts >5 000 `pending` stage-state rows causes
// stage-sweep to translate those rows into BullMQ enqueues at its configured
// rate, ramping Valkey memory during drain (even with QUEUE_DEPTH_SKIP_THRESHOLD
// + MAX_ENQUEUES_PER_TICK throttling). Precedents: migration 16.7.0 (~150k row
// reseed) and 16.11.0 (~150k trickplay seed) both landed alongside Valkey bumped
// to 1 GiB. If a migration exceeds 5 000 rows, document the expected steady-state
// enqueue volume and consider a one-shot paced background task instead of a bulk
// INSERT that hands the pacing problem to stage-sweep.

import { MigrationSystem, type Migration } from './migration-system';
import { migration_16_468_0 } from './migrations/16.468.0_play_sessions_download_purpose.js';
import { migration_16_469_0 } from './migrations/16.469.0_trickplay_measured_height.js';
import { BASE_SCHEMA_MIGRATION } from './base-schema.js';
import { Logger } from '../utils/logger';
import { EMBEDDING_SOURCE } from '../utils/embedding-source.js';

const logger = Logger.for('Migration');

// Incremental migrations newer than the squashed base schema (BASE_SCHEMA_VERSION).
// The base schema (fresh DBs) + version watermark (existing DBs) cover everything
// through 16.467.0 (migrations 16.126.0..16.228.0 were squashed into the base on
// 2026-08-25, 16.229.0..16.300.0 on 2026-10-13, 16.301.0..16.302.0 on 2026-10-15,
// 16.303.0..16.467.0 on 2026-11-01, and their files deleted). An existing database
// below 16.467.0 refuses to boot — see migration-system.ts. Append new migrations here
// as they are added (each must have a version above the highest already-deployed
// migration — see header). The runner sorts by version, so array order is for
// readability only.
export const MIGRATIONS: Migration[] = [
    migration_16_468_0,
    migration_16_469_0,
    // Append new migrations above this line, one per line.
];

/**
 * Main migration function
 */
export async function migrateSchema(): Promise<void> {
    logger.info('Starting schema migration...');

    const migrationSystem = new MigrationSystem();

    try {
        // Run migrations with base schema support
        await migrationSystem.runMigrations(MIGRATIONS, {
            baseSchemaMigration: BASE_SCHEMA_MIGRATION,
        });

        // Get final status
        const status = await migrationSystem.getStatus();
        logger.info('Migration completed successfully', {
            databaseVersion: status.current_version,
        });

        // Check current state
        const sql = migrationSystem['sql'];

        try {
            // Query stats from the UUID-based tables
            type DbStatsRow = {
                total_items: number;
                has_imdb_id: number;
                has_actors: number;
                has_directors: number;
                library_embeddings: number;
                discovery_embeddings: number;
            };
            // has_actors/has_directors count media_people (synced from
            // provider_metadata by trg_provider_metadata_people), not the jsonb
            // blobs: `metadata->>'actors' IS NOT NULL` detoasted every
            // provider_metadata row, ~8 s of this startup log on prod
            // (2026-09-26); now ~250 ms, no new index. Items with an empty
            // `actors: []` count as "has" there but have no people rows (0.24%).
            const stats = await sql<DbStatsRow[]>`
                SELECT
                    (SELECT COUNT(*) FROM media_items WHERE status = 'active') as total_items,
                    (SELECT COUNT(*) FROM external_ids WHERE provider = 'imdb') as has_imdb_id,
                    (SELECT COUNT(DISTINCT media_id) FROM media_people WHERE role = 'actor') as has_actors,
                    (SELECT COUNT(DISTINCT media_id) FROM media_people WHERE role = 'director') as has_directors,
                    (SELECT COUNT(*) FROM media_embeddings WHERE source = ${EMBEDDING_SOURCE.LIBRARY}) as library_embeddings,
                    (SELECT COUNT(*) FROM media_embeddings WHERE source = ${EMBEDDING_SOURCE.DISCOVERY}) as discovery_embeddings
            `;

            const row = stats[0];
            logger.info('Current database stats', {
                totalItems: row.total_items,
                hasImdbId: row.has_imdb_id,
                hasActors: row.has_actors,
                hasDirectors: row.has_directors,
                libraryEmbeddings: row.library_embeddings,
                discoveryEmbeddings: row.discovery_embeddings,
            });

            if (row.total_items > 0) {
                const completeness = {
                    imdb_id: Math.round((row.has_imdb_id / row.total_items) * 100),
                    actors: Math.round((row.has_actors / row.total_items) * 100),
                    directors: Math.round((row.has_directors / row.total_items) * 100),
                    library_embeddings: Math.round(
                        (row.library_embeddings / row.total_items) * 100,
                    ),
                };

                logger.info('Metadata completeness', completeness);

                const missingFields = Object.entries(completeness)
                    .filter(([_, percent]) => percent < 50)
                    .map(([field, _]) => field);

                if (missingFields.length > 0) {
                    logger.info('Consider running sync to populate missing fields', {
                        missingFields,
                    });
                }
            }
        } catch (statsError) {
            logger.warn(
                'Could not fetch database stats',
                statsError instanceof Error ? statsError : undefined,
            );
        }
    } catch (error) {
        logger.error('Migration failed', error instanceof Error ? error : undefined);
        throw error;
    }
}

/**
 * Get migration status (useful for health checks)
 */
export async function getMigrationStatus() {
    const migrationSystem = new MigrationSystem();
    return await migrationSystem.getStatus();
}

// Command line execution. Gated on an explicit env flag (set only by the
// `migrate-schema` npm script) rather than `import.meta.url === file://${process.argv[1]}`:
// that comparison breaks under bundling — esbuild concatenates this module into
// `build/sandbox-entry.js` for worker-thread task isolation, and a
// `node:worker_threads` Worker's `process.argv[1]` is its own entry path, so the
// equality check was accidentally satisfied on every worker-isolated task boot
// (music-analysis, lumastra-intro-analyzer, trickplay-generation), firing an
// unwanted migration attempt before any task code ran and crashing the sandbox.
if (process.env.LUMASTRA_MIGRATE_CLI === '1') {
    migrateSchema()
        .then(() => {
            logger.info('Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            logger.error('Migration failed', error instanceof Error ? error : undefined);
            process.exit(1);
        });
}
