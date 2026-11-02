#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Migration Status and History Tool

import { MigrationSystem } from '../src/lib/server/database/migration-system.js';
import { Database } from '../src/lib/server/database/connection.js';

type EmbeddingStatsRow = {
    total_items: number | string;
    has_imdb_id: number | string;
    has_actors: number | string;
    has_directors: number | string;
    has_producers: number | string;
    has_writers: number | string;
    has_runtime: number | string;
    has_budget: number | string;
    has_revenue: number | string;
};

type SchemaColumnRow = {
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO' | string;
};

async function showMigrationStatus(): Promise<void> {
    console.log('🗄️  LUMASTRA — DATABASE MIGRATION STATUS');
    console.log('='.repeat(60));

    try {
        const migrationSystem = new MigrationSystem();
        const db = new Database();
        const sql = db.getSql();

        // Get migration status
        const status = await migrationSystem.getStatus();

        console.log('📊 CURRENT STATUS:');
        console.log(`   Database Version: ${status.current_version}`);
        console.log(`   Applied Migrations: ${status.applied_migrations}`);

        if (status.last_migration) {
            console.log(
                `   Last Migration: ${status.last_migration.name} (${status.last_migration.version})`,
            );
            console.log(`   Applied At: ${status.last_migration.applied_at}`);
        }

        // Show migration history
        console.log('\n📋 MIGRATION HISTORY:');
        console.log('-'.repeat(60));

        const migrations = await migrationSystem.getAppliedMigrations();

        if (migrations.length === 0) {
            console.log('   No migrations applied yet');
        } else {
            migrations.forEach((migration, index) => {
                const status = '✅';
                console.log(`   ${index + 1}. ${status} ${migration.version} - ${migration.name}`);
                console.log(`      Applied: ${migration.applied_at}`);
                if (migration.description) {
                    console.log(`      Description: ${migration.description}`);
                }
                if (migration.checksum) {
                    console.log(`      Checksum: ${migration.checksum}`);
                }
                console.log();
            });
        }

        // Show database stats
        console.log('📈 DATABASE STATISTICS:');
        console.log('-'.repeat(60));

        try {
            const stats = await sql<EmbeddingStatsRow[]>`
        SELECT 
          COUNT(*) as total_items,
          COUNT(imdb_id) as has_imdb_id,
          COUNT(actors) as has_actors,
          COUNT(directors) as has_directors,
          COUNT(producers) as has_producers,
          COUNT(writers) as has_writers,
          COUNT(runtime_minutes) as has_runtime,
          COUNT(budget) as has_budget,
          COUNT(revenue) as has_revenue
        FROM media_embeddings
      `;

            const data = stats[0];
            const totalItems = Number(data?.total_items ?? 0);
            const hasImdbId = Number(data?.has_imdb_id ?? 0);
            const hasActors = Number(data?.has_actors ?? 0);
            const hasDirectors = Number(data?.has_directors ?? 0);
            const hasProducers = Number(data?.has_producers ?? 0);
            const hasWriters = Number(data?.has_writers ?? 0);
            const hasRuntime = Number(data?.has_runtime ?? 0);
            const hasBudget = Number(data?.has_budget ?? 0);
            const hasRevenue = Number(data?.has_revenue ?? 0);

            if (totalItems > 0) {
                console.log(`   Total Media Items: ${totalItems}`);
                console.log('   Metadata Completeness:');
                console.log(
                    `     IMDB IDs: ${Math.round((hasImdbId / totalItems) * 100)}% (${hasImdbId}/${totalItems})`,
                );
                console.log(
                    `     Actors: ${Math.round((hasActors / totalItems) * 100)}% (${hasActors}/${totalItems})`,
                );
                console.log(
                    `     Directors: ${Math.round((hasDirectors / totalItems) * 100)}% (${hasDirectors}/${totalItems})`,
                );
                console.log(
                    `     Producers: ${Math.round((hasProducers / totalItems) * 100)}% (${hasProducers}/${totalItems})`,
                );
                console.log(
                    `     Writers: ${Math.round((hasWriters / totalItems) * 100)}% (${hasWriters}/${totalItems})`,
                );
                console.log(
                    `     Runtime: ${Math.round((hasRuntime / totalItems) * 100)}% (${hasRuntime}/${totalItems})`,
                );
                console.log(
                    `     Budget/Revenue: ${Math.round((hasBudget / totalItems) * 100)}%/${Math.round((hasRevenue / totalItems) * 100)}%`,
                );
            } else {
                console.log('   No media items in database yet');
            }
        } catch (statsError) {
            console.warn('   Could not retrieve database stats:', statsError);
        }

        // Show schema verification
        console.log('\n🔍 SCHEMA VERIFICATION:');
        console.log('-'.repeat(60));

        try {
            const schemaCheck = await sql<SchemaColumnRow[]>`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_name = 'media_embeddings' 
          AND table_schema = 'public'
          AND column_name IN ('imdb_id', 'actors', 'directors', 'producers', 'writers', 'runtime_minutes', 'budget', 'revenue', 'rt_rating', 'jellyseerr_id')
        ORDER BY column_name
      `;

            const expectedFields = [
                'imdb_id',
                'actors',
                'directors',
                'producers',
                'writers',
                'runtime_minutes',
                'budget',
                'revenue',
                'rt_rating',
                'jellyseerr_id',
            ];
            const presentFields = schemaCheck.map((row) => row.column_name);

            console.log(`   Expected Fields: ${expectedFields.length}`);
            console.log(`   Present Fields: ${presentFields.length}`);

            const missingFields = expectedFields.filter((field) => !presentFields.includes(field));
            if (missingFields.length > 0) {
                console.log(`   ❌ Missing Fields: ${missingFields.join(', ')}`);
            } else {
                console.log('   ✅ All expected fields present');
            }
        } catch (schemaError) {
            console.warn('   Could not verify schema:', schemaError);
        }

        // Recommendations
        console.log('\n💡 RECOMMENDATIONS:');
        console.log('-'.repeat(60));

        if (status.current_version === '0.0.0') {
            console.log('   ⚠️  Run migration: npm run migrate-schema');
        } else if (status.current_version < '1.0.0') {
            console.log('   ⚠️  Update to latest version: npm run migrate-schema');
        } else {
            console.log('   ✅ Database is up to date');
        }

        console.log('   🔄 Sync missing metadata: npm run sync-metadata -- --imdb-id --cast');
        console.log('   🌐 Check health status: GET /api/health/migration');

        console.log('\n' + '='.repeat(60));
    } catch (error) {
        console.error('❌ Failed to get migration status:', error);
        process.exit(1);
    }
}

// Command line execution
if (import.meta.url === `file://${process.argv[1]}`) {
    showMigrationStatus()
        .then(() => {
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Status check failed:', error);
            process.exit(1);
        });
}
