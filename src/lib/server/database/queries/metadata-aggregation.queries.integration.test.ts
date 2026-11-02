// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Metadata Aggregation Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    aggregateMetadataForMedia,
    batchAggregateMetadata,
    getItemsNeedingAggregation,
    getAggregationStats,
    getDetailedAggregationStats,
    resetFieldAuthorityCache,
} from './metadata-aggregation.queries.js';

describe('Metadata Aggregation Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        resetFieldAuthorityCache();
    });

    async function insertProviderMetadata(
        mediaId: string,
        provider: string,
        metadata: postgres.JSONValue,
    ): Promise<void> {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            VALUES (${mediaId}::uuid, ${provider}, ${sql.json(metadata)}, NOW(), NOW())
        `;
    }

    // ========================================================================
    // aggregateMetadataForMedia
    // ========================================================================

    describe('aggregateMetadataForMedia', () => {
        it('is a no-op when no provider metadata exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await aggregateMetadataForMedia(sql, item.id);

            const rows = await sql`
                SELECT 1 FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(0);
        });

        it('aggregates fields and inserts an aggregated row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', {
                overview: 'TMDB overview',
                imdb_rating: 8.0,
                genres: ['Action'],
            });
            await insertProviderMetadata(item.id, 'mdblist', {
                rt_audience_score: 85,
                mdblist_score: 75,
            });

            await aggregateMetadataForMedia(sql, item.id);

            const rows = await sql`
                SELECT metadata FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(1);
            const meta = rows[0].metadata as Record<string, unknown>;
            expect(meta.overview).toBe('TMDB overview');
            expect(meta.imdb_rating).toBe(8.0);
            expect(meta.rt_audience_score).toBe(85);
            expect(meta.mdblist_score).toBe(75);
        });

        it('carries structured cast from the tmdb row onto the aggregated row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', {
                overview: 'x',
                actors: ['Keiran Vale'],
                cast: [{ name: 'Keiran Vale', character: 'Neo', person_id: '6384' }],
            });

            await aggregateMetadataForMedia(sql, item.id);

            const rows = await sql`
                SELECT metadata FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(1);
            const meta = rows[0].metadata as Record<string, unknown>;
            // The detail API reads the aggregated row — cast MUST survive
            // aggregation as structured objects, not just the flat names.
            expect(meta.cast).toEqual([
                { name: 'Keiran Vale', character: 'Neo', person_id: '6384' },
            ]);
        });

        // C3 (2026-09-24 security review): the 'aggregated' row rebuild
        // previously had NO lock guard at all. mdblist-sync (background, no
        // force) and metadata-sync-single/CatalogService.storeProviderMetadata
        // (admin, force-capable) are the two call shapes exercised here.
        it('does NOT rebuild the aggregated row for a metadata_locked item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'Locked overview' });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${item.id}`;

            await aggregateMetadataForMedia(sql, item.id);

            const rows = await sql`
                SELECT 1 FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(0);
        });

        it('control: DOES rebuild the aggregated row for an unlocked item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'Unlocked overview' });

            await aggregateMetadataForMedia(sql, item.id);

            const rows = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].metadata.overview).toBe('Unlocked overview');
        });

        it('control: force:true DOES rebuild the aggregated row for a metadata_locked item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'Forced overview' });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${item.id}`;

            await aggregateMetadataForMedia(sql, item.id, { force: true });

            const rows = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].metadata.overview).toBe('Forced overview');
        });

        it('re-aggregating a locked row after a prior unlocked aggregation leaves it untouched', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'Original overview' });
            await aggregateMetadataForMedia(sql, item.id);
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${item.id}`;

            // Source row changes (e.g. a background enrichment pass would try
            // to fold this in), but the item is now locked.
            await sql`
                UPDATE provider_metadata SET metadata = ${sql.json({ overview: 'Changed overview' })}
                WHERE media_id = ${item.id}::uuid AND provider = 'tmdb'
            `;
            await aggregateMetadataForMedia(sql, item.id);

            const rows = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows[0].metadata.overview).toBe('Original overview');
        });
    });

    // ========================================================================
    // aggregateMetadataForMedia — tmdb_keyword_ids preservation (KEY REGRESSION)
    // ========================================================================

    describe('aggregateMetadataForMedia – tmdb_keyword_ids preserve clause', () => {
        /**
         * Regression guard for the ON CONFLICT preserve clause.
         *
         * Scenario: syncMissingMetadata writes tmdb_keyword_ids directly onto
         * the aggregated row (no source provider row). A subsequent aggregation
         * run triggered by, e.g., mdblist-sync must NOT wipe the keyword ids —
         * the `|| CASE WHEN ... COALESCE(...)` block in the upsert keeps them.
         */
        it('preserves tmdb_keyword_ids that exist on the aggregated row but not in any source provider', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Seed a tmdb source row WITHOUT tmdb_keyword_ids (simulating an
            // item enriched before keyword sync ran).
            await insertProviderMetadata(item.id, 'tmdb', {
                overview: 'Keyword Preserve Movie',
                popularity: 7.5,
            });

            // First aggregation: produces an aggregated row without keyword ids.
            await aggregateMetadataForMedia(sql, item.id);

            // Simulate syncMissingMetadata writing keyword ids directly onto the
            // aggregated row — this is the state the preserve clause protects.
            await sql`
                UPDATE provider_metadata
                   SET metadata = metadata || '{"tmdb_keyword_ids": [9882, 1234], "keyword_slugs": ["based-on-novel", "heist"]}'::jsonb
                 WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;

            // Verify the keyword ids are on the aggregated row before the next aggregation.
            const [before] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata
                 WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(before.metadata.tmdb_keyword_ids).toEqual([9882, 1234]);

            // Second aggregation (e.g. triggered by mdblist-sync updating an mdblist row).
            // Must NOT clobber the keyword ids.
            await insertProviderMetadata(item.id, 'mdblist', { rt_audience_score: 88 });
            await aggregateMetadataForMedia(sql, item.id);

            const [after] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata
                 WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(after.metadata.tmdb_keyword_ids).toEqual([9882, 1234]);
            expect(after.metadata.keyword_slugs).toEqual(['based-on-novel', 'heist']);
            // Source-provider fields still aggregate correctly.
            expect(after.metadata.rt_audience_score).toBe(88);
        });

        it('does NOT preserve tmdb_keyword_ids when the source tmdb row now carries them (FIELD_PRIORITY wins)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // tmdb source row now has keyword ids — these should be picked up by
            // the normal aggregation path (FIELD_PRIORITY: tmdb_keyword_ids: ['tmdb']).
            await insertProviderMetadata(item.id, 'tmdb', {
                overview: 'Keyword From Source',
                tmdb_keyword_ids: [5555, 6666],
                keyword_slugs: ['space-opera', 'robot'],
            });

            await aggregateMetadataForMedia(sql, item.id);

            const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata
                 WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(row.metadata.tmdb_keyword_ids).toEqual([5555, 6666]);
            expect(row.metadata.keyword_slugs).toEqual(['space-opera', 'robot']);
        });

        it('jsonb_typeof guard: a non-object existing aggregated metadata does not error the upsert', async () => {
            // Seed a deliberately malformed aggregated row whose metadata is a
            // JSON array (not an object) — jsonb_typeof returns 'array', so the
            // preserve CASE falls through to the ELSE '{}' branch and the upsert
            // completes normally.
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${item.id}::uuid, 'aggregated', '[]'::jsonb, NOW(), NOW())
            `;

            // Source row that triggers the aggregation.
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'Fix malformed' });

            // Must not throw.
            await expect(aggregateMetadataForMedia(sql, item.id)).resolves.toBeUndefined();

            const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata
                 WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            // After the upsert the row contains the real merged metadata (object).
            expect(typeof row.metadata).toBe('object');
            expect(Array.isArray(row.metadata)).toBe(false);
            expect(row.metadata.overview).toBe('Fix malformed');
        });
    });

    // ========================================================================
    // batchAggregateMetadata
    // ========================================================================

    describe('batchAggregateMetadata', () => {
        it('returns zero stats for empty input', async () => {
            const stats = await batchAggregateMetadata(sql, []);
            expect(stats.updated).toBe(0);
            expect(stats.skipped).toBe(0);
            expect(stats.errors).toBe(0);
        });

        it('processes multiple items', async () => {
            const item1 = createTestMediaItem({ media_type: 'movie' });
            const item2 = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item1);
            await insertTestMediaItem(sql, item2);
            await insertProviderMetadata(item1.id, 'tmdb', {
                overview: 'Movie',
            });
            await insertProviderMetadata(item2.id, 'tmdb', {
                overview: 'TV',
            });

            const stats = await batchAggregateMetadata(sql, [item1.id, item2.id], 10);
            expect(stats.updated).toBe(2);
            expect(stats.skipped).toBe(0);
        });

        // H14: the set-based batch upsert must write the SAME aggregated content
        // the per-item path would, for every row in the batch.
        it('writes correct aggregated content for each item in the batch', async () => {
            const item1 = createTestMediaItem({ media_type: 'movie' });
            const item2 = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item1);
            await insertTestMediaItem(sql, item2);
            await insertProviderMetadata(item1.id, 'tmdb', { overview: 'First' });
            await insertProviderMetadata(item2.id, 'tmdb', { overview: 'Second' });

            await batchAggregateMetadata(sql, [item1.id, item2.id], 10);

            const rows = await sql<{ media_id: string; metadata: { overview?: string } }[]>`
                SELECT media_id::text, metadata FROM provider_metadata
                WHERE provider = 'aggregated' AND media_id = ANY(${[item1.id, item2.id]}::uuid[])
            `;
            const byId = new Map(rows.map((r) => [r.media_id, r.metadata]));
            expect(byId.get(item1.id)?.overview).toBe('First');
            expect(byId.get(item2.id)?.overview).toBe('Second');
        });

        // H14: the ON CONFLICT preserve clause must carry forward keyword/genre
        // slugs (written straight onto the aggregated row by enrichment, never by
        // aggregation) so a re-aggregation doesn't wipe DB-backed browse. This is
        // the risky half of the set-based rewrite.
        it('preserves keyword_slugs / genre_slugs on re-aggregation (batch path)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            // Pre-existing aggregated row carrying enrichment-only keys + stale overview.
            await insertProviderMetadata(item.id, 'aggregated', {
                overview: 'stale',
                keyword_slugs: ['based-on-novel-or-book'],
                genre_slugs: ['action'],
                tmdb_keyword_ids: [818],
            });
            // Fresh source row that does NOT carry those enrichment keys.
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'fresh' });

            await batchAggregateMetadata(sql, [item.id], 10);

            const [agg] = await sql<
                {
                    metadata: {
                        overview?: string;
                        keyword_slugs?: string[];
                        genre_slugs?: string[];
                        tmdb_keyword_ids?: number[];
                    };
                }[]
            >`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            // Overview refreshed from the source…
            expect(agg.metadata.overview).toBe('fresh');
            // …but enrichment-only keys preserved (not wiped by re-aggregation).
            expect(agg.metadata.keyword_slugs).toEqual(['based-on-novel-or-book']);
            expect(agg.metadata.genre_slugs).toEqual(['action']);
            expect(agg.metadata.tmdb_keyword_ids).toEqual([818]);
        });

        // C3 (2026-09-24 security review): every caller of batchAggregateMetadata
        // is a background/bulk task (tmdb sweep, cast backfill, missing-metadata
        // sync, aggregation backfill) — none pass an admin-force override — so a
        // metadata_locked item's 'aggregated' row must not be rebuilt.
        it('skips a metadata_locked item — its aggregated row is not rebuilt', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${item.id}::uuid`;
            await insertProviderMetadata(item.id, 'aggregated', { overview: 'frozen by admin' });
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'fresh from sweep' });

            const stats = await batchAggregateMetadata(sql, [item.id], 10);

            expect(stats.updated).toBe(0);
            const [agg] = await sql<{ metadata: { overview?: string } }[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(agg.metadata.overview).toBe('frozen by admin');
        });

        it('control: an unlocked item in the same batch IS rebuilt', async () => {
            const locked = createTestMediaItem({ media_type: 'movie' });
            const unlocked = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, locked);
            await insertTestMediaItem(sql, unlocked);
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${locked.id}::uuid`;
            await insertProviderMetadata(locked.id, 'aggregated', { overview: 'frozen' });
            await insertProviderMetadata(locked.id, 'tmdb', { overview: 'should not land' });
            await insertProviderMetadata(unlocked.id, 'tmdb', { overview: 'should land' });

            const stats = await batchAggregateMetadata(sql, [locked.id, unlocked.id], 10);

            expect(stats.updated).toBe(1);
            const rows = await sql<{ media_id: string; metadata: { overview?: string } }[]>`
                SELECT media_id::text, metadata FROM provider_metadata
                WHERE provider = 'aggregated' AND media_id = ANY(${[locked.id, unlocked.id]}::uuid[])
            `;
            const byId = new Map(rows.map((r) => [r.media_id, r.metadata]));
            expect(byId.get(locked.id)?.overview).toBe('frozen');
            expect(byId.get(unlocked.id)?.overview).toBe('should land');
        });
    });

    // ========================================================================
    // getItemsNeedingAggregation
    // ========================================================================

    describe('getItemsNeedingAggregation', () => {
        it('returns items missing aggregated row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'x' });

            const ids = await getItemsNeedingAggregation(sql, 100);
            expect(ids).toContain(item.id);
        });

        it('does not return items that already have fresh aggregated row', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'x' });
            await aggregateMetadataForMedia(sql, item.id);

            const ids = await getItemsNeedingAggregation(sql, 100);
            expect(ids).not.toContain(item.id);
        });
    });

    // ========================================================================
    // getAggregationStats
    // ========================================================================

    describe('getAggregationStats', () => {
        it('returns zero counts when no metadata', async () => {
            const stats = await getAggregationStats(sql);
            expect(stats.total_with_metadata).toBe(0);
        });

        it('counts items with and without aggregated rows', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'x' });

            const stats = await getAggregationStats(sql);
            expect(stats.total_with_metadata).toBe(1);
            expect(stats.with_aggregated).toBe(0);
            expect(stats.without_aggregated).toBe(1);
        });
    });

    // ========================================================================
    // getDetailedAggregationStats
    // ========================================================================

    describe('getDetailedAggregationStats', () => {
        it('returns detailed stats including per-provider counts', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await insertProviderMetadata(item.id, 'tmdb', { overview: 'x' });

            const stats = await getDetailedAggregationStats(sql);
            expect(stats.provider_counts.tmdb).toBeGreaterThanOrEqual(1);
        });
    });
});
