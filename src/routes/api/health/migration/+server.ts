// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Health check endpoint for database migration status
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { buildProviderFilterUnsafe } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { z } from 'zod';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { requireAdmin } from '$lib/server/middleware/auth';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';

const logger = Logger.for('HealthMigrationAPI');
const toCount = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

type SchemaColumnRow = {
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
};

type IndexRow = {
    indexname: string;
};

type MediaItemsStatsRow = {
    total_items: number | string;
    has_tmdb_id: number | string;
    has_imdb_id: number | string;
    has_jellyfin_id: number | string;
    has_metadata: number | string;
    has_embeddings: number | string;
    media_items_count: number | string;
};

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        try {
            // Use dynamic imports to avoid build issues
            const { getDb } = await import('$lib/server/database/connection.js');
            const { getMigrationStatus } = await import('$lib/server/database/migrate-schema.js');

            const sql = getDb();
            if (!sql) {
                return ApiResponses.error('Database connection unavailable');
            }

            // Get versioned migration status
            const migrationStatus = await getMigrationStatus();

            // Check if UUID-based schema tables exist
            const schemaCheck = await sql<SchemaColumnRow[]>`
      SELECT
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_name = 'media_items'
        AND table_schema = 'public'
        AND column_name IN ('id', 'title', 'media_type', 'year', 'status', 'is_local_only')
      ORDER BY column_name
    `;

            const expectedFields = ['id', 'title', 'media_type', 'year', 'status', 'is_local_only'];

            const presentFields = schemaCheck.map((row) => row.column_name);
            const missingFields = expectedFields.filter((field) => !presentFields.includes(field));

            // Check indexes for UUID-based tables
            const indexCheck = await sql<IndexRow[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename IN ('media_items', 'external_ids', 'provider_metadata', 'library_availability')
        AND indexname IN ('idx_media_items_type', 'idx_media_items_year', 'idx_external_ids_media', 'idx_library_availability_media')
    `;

            const expectedIndexes = [
                'idx_media_items_type',
                'idx_media_items_year',
                'idx_external_ids_media',
                'idx_library_availability_media',
            ];
            const presentIndexes = indexCheck.map((row) => row.indexname);
            const missingIndexes = expectedIndexes.filter((idx) => !presentIndexes.includes(idx));

            // Get data completeness stats from UUID-based tables
            const stats = await sql<MediaItemsStatsRow[]>`
      SELECT
        (SELECT COUNT(*) FROM media_items) as media_items_count,
        COUNT(*) as total_items,
        COUNT(primary_ext.id) as has_tmdb_id,
        COUNT(imdb_ext.id) as has_imdb_id,
        COUNT(*) FILTER (WHERE EXISTS(SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)) as has_jellyfin_id,
        COUNT(pm.id) as has_metadata,
        COUNT(me.id) as has_embeddings
      FROM media_items mi
      LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
      LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id AND imdb_ext.provider = 'imdb'
      LEFT JOIN provider_metadata pm ON pm.media_id = mi.id AND ${sql.unsafe(buildProviderFilterUnsafe())}
      LEFT JOIN media_embeddings me ON me.media_id = mi.id
    `;

            const totalItems = toCount(stats[0]?.media_items_count);
            const completeness =
                totalItems > 0
                    ? {
                          tmdb_id: Math.round((toCount(stats[0]?.has_tmdb_id) / totalItems) * 100),
                          imdb_id: Math.round((toCount(stats[0]?.has_imdb_id) / totalItems) * 100),
                          jellyfin_id: Math.round(
                              (toCount(stats[0]?.has_jellyfin_id) / totalItems) * 100,
                          ),
                          metadata: Math.round(
                              (toCount(stats[0]?.has_metadata) / totalItems) * 100,
                          ),
                          embeddings: Math.round(
                              (toCount(stats[0]?.has_embeddings) / totalItems) * 100,
                          ),
                      }
                    : {};

            const migrationComplete = missingFields.length === 0 && missingIndexes.length === 0;
            const needsDataSync = Object.values(completeness).some(
                (percent) => typeof percent === 'number' && percent < 10,
            );

            const MigrationHealthSchema = z
                .object({
                    database_version: z.string(),
                    applied_migrations: z.number(),
                    last_migration: z.string().nullable(),
                    migration_status: z.string(),
                    schema_fields: z.object({
                        expected: z.number(),
                        present: z.number(),
                        missing: z.array(z.string()),
                    }),
                    indexes: z.object({
                        expected: z.number(),
                        present: z.number(),
                        missing: z.array(z.string()),
                    }),
                    data_completeness: z.unknown(),
                    recommendations: z.object({
                        needs_migration: z.boolean(),
                        needs_data_sync: z.boolean(),
                        sync_command: z.string().nullable(),
                    }),
                    database_stats: z.unknown(),
                    timestamp: z.string(),
                })
                .passthrough();

            return typedJson(MigrationHealthSchema, {
                // Versioned migration info
                database_version: migrationStatus.current_version,
                applied_migrations: migrationStatus.applied_migrations,
                last_migration: migrationStatus.last_migration?.version ?? null,

                // Legacy schema check
                migration_status: migrationComplete ? 'complete' : 'incomplete',
                schema_fields: {
                    expected: expectedFields.length,
                    present: presentFields.length,
                    missing: missingFields,
                },
                indexes: {
                    expected: expectedIndexes.length,
                    present: presentIndexes.length,
                    missing: missingIndexes,
                },
                data_completeness: completeness,
                recommendations: {
                    needs_migration: !migrationComplete,
                    needs_data_sync: needsDataSync,
                    sync_command: needsDataSync ? 'POST /api/ai/sync-metadata' : null,
                },
                database_stats: stats[0],
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Migration health check failed', error as Error);

            // Try to get basic migration status even if detailed checks fail
            let basicStatus = null;
            try {
                const { getMigrationStatus } =
                    await import('$lib/server/database/migrate-schema.js');
                basicStatus = await getMigrationStatus();
            } catch (statusError) {
                logger.warn('Could not get migration status', statusError as Error);
            }

            const errorDetails = {
                database_version: basicStatus?.current_version || 'unknown',
                applied_migrations: basicStatus?.applied_migrations || 0,
                migration_status: 'error',
                recommendations: {
                    needs_migration: true,
                    action: 'Check database connection and run migration manually',
                },
                timestamp: new Date().toISOString(),
            };

            return ApiResponses.error(
                'Migration health check failed',
                JSON.stringify(errorDetails),
                500,
            );
        }
    }),
);
