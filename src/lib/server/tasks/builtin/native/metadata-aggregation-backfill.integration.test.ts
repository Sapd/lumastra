// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test: metadata-aggregation-backfill task.
 *
 * Goal: prove that running the backfill's core re-aggregation populates an
 * 'aggregated' provider_metadata row from an existing source provider row,
 * without any external API calls.
 *
 * Scenario: a media item has a 'tmdb' provider_metadata row with genre and
 * keyword data, but no 'aggregated' row. After running batchAggregateMetadata
 * (the function the task delegates to), the 'aggregated' row exists and carries
 * the genres/keywords from the 'tmdb' source row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../tests/integration/fixtures/index.js';
import { batchAggregateMetadata } from '$lib/server/database/queries/metadata-aggregation.queries.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { metadataAggregationBackfillTask } from './metadata-aggregation-backfill.js';

describe('metadata-aggregation-backfill — core re-aggregation logic', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('populates an aggregated row from an existing tmdb source row (genres)', async () => {
        // Seed a media item with a 'tmdb' provider_metadata row carrying genres
        // and genre_slugs, but no 'aggregated' row.
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        const tmdbMetadata = {
            overview: 'A great action film.',
            genres: ['Action', 'Science Fiction'],
            genre_slugs: ['action', 'science-fiction'],
            keywords: ['space', 'hero'],
            keyword_slugs: ['space', 'hero'],
            release_date: '2025-01-15',
        };

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'tmdb', ${sql.json(tmdbMetadata)}, NOW())
        `;

        // Confirm no aggregated row exists before the backfill.
        const before = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count
            FROM provider_metadata
            WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
        `;
        expect(before[0].count).toBe(0);

        // Run the same function the task uses: batchAggregateMetadata.
        const stats = await batchAggregateMetadata(sql, [item.id]);

        expect(stats.updated).toBe(1);
        expect(stats.errors).toBe(0);

        // The 'aggregated' row must now exist and carry the genres.
        const after = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
        `;

        expect(after).toHaveLength(1);
        const meta = after[0].metadata;

        expect(meta.genre_slugs).toEqual(expect.arrayContaining(['action', 'science-fiction']));
        expect(meta.keyword_slugs).toEqual(expect.arrayContaining(['space', 'hero']));
        expect(meta.overview).toBe('A great action film.');
        expect(meta.release_date).toBe('2025-01-15');
    });

    it('re-aggregation is idempotent — running twice does not duplicate or corrupt the row', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        const tmdbMetadata = {
            genres: ['Drama'],
            genre_slugs: ['drama'],
        };

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'tmdb', ${sql.json(tmdbMetadata)}, NOW())
        `;

        // Run twice.
        await batchAggregateMetadata(sql, [item.id]);
        const stats2 = await batchAggregateMetadata(sql, [item.id]);

        // Still exactly one aggregated row.
        const rows = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata
            FROM provider_metadata
            WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
        `;

        expect(rows).toHaveLength(1);
        expect(rows[0].metadata.genre_slugs).toEqual(['drama']);
        expect(stats2.errors).toBe(0);
    });

    it('skips a media item with no source provider rows', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        // No provider_metadata rows at all.
        const stats = await batchAggregateMetadata(sql, [item.id]);

        expect(stats.updated).toBe(0);
        expect(stats.skipped).toBe(1);
        expect(stats.errors).toBe(0);

        const after = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count
            FROM provider_metadata
            WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
        `;
        expect(after[0].count).toBe(0);
    });

    it('candidate query finds items with non-aggregated rows', async () => {
        // This mirrors the SELECT the task runs to build its id list.
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'tmdb', ${sql.json({ genres: ['Drama'], genre_slugs: ['drama'] })}, NOW())
        `;

        const candidates = await sql<{ media_id: string }[]>`
            SELECT DISTINCT media_id::text
            FROM provider_metadata
            WHERE provider <> 'aggregated'
        `;

        const found = candidates.find((r) => r.media_id === item.id);
        expect(found).toBeDefined();
    });

    it('candidate query excludes items that only have an aggregated row', async () => {
        // An item with ONLY an 'aggregated' row (no source rows) must not appear
        // in the candidate set — re-aggregating it would produce nothing anyway.
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'aggregated', ${sql.json({ genre_slugs: ['action'] })}, NOW())
        `;

        const candidates = await sql<{ media_id: string }[]>`
            SELECT DISTINCT media_id::text
            FROM provider_metadata
            WHERE provider <> 'aggregated'
        `;

        const found = candidates.find((r) => r.media_id === item.id);
        expect(found).toBeUndefined();
    });

    it('processes multiple items in one batch', async () => {
        const items = [
            createTestMediaItem({ media_type: 'movie' }),
            createTestMediaItem({ media_type: 'tv' }),
        ];
        for (const item of items) {
            await insertTestMediaItem(sql, item);
        }

        for (const item of items) {
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json({ genres: ['Comedy'], genre_slugs: ['comedy'] })},
                    NOW()
                )
            `;
        }

        const stats = await batchAggregateMetadata(
            sql,
            items.map((i) => i.id),
        );

        expect(stats.updated).toBe(2);
        expect(stats.errors).toBe(0);

        for (const item of items) {
            const rows = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata
                FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].metadata.genre_slugs).toEqual(['comedy']);
        }
    });

    it('a resumed run continues after its checkpoint (resumeAfterRestart)', async () => {
        expect(metadataAggregationBackfillTask.resumeAfterRestart).toBe(true);
        const items = [
            createTestMediaItem({ media_type: 'movie' }),
            createTestMediaItem({ media_type: 'movie' }),
            createTestMediaItem({ media_type: 'movie' }),
        ];
        for (const item of items) {
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', ${sql.json({ genres: ['Drama'], genre_slugs: ['drama'] })}, NOW())
            `;
        }
        const ordered = [...items.map((i) => i.id)].sort();
        const saves: Array<{ afterMediaId: string }> = [];
        const ctx = {
            sql,
            signal: new AbortController().signal,
            input: {},
            logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
            checkpoint: {
                // The interrupted run had finished the first item (uuid order).
                load: async () => ({
                    v: 1,
                    afterMediaId: ordered[0],
                    totals: { updated: 1, skipped: 0, errors: 0, candidateCount: 3 },
                }),
                save: async (v: unknown) => {
                    saves.push(v as { afterMediaId: string });
                },
            },
        } as unknown as TaskContext<Record<string, unknown>>;

        const result = (await metadataAggregationBackfillTask.execute(ctx)) as {
            success: boolean;
            result: { updated: number };
        };
        expect(result.success).toBe(true);
        expect(result.result.updated).toBe(3);
        const aggregated = await sql<{ media_id: string }[]>`
            SELECT media_id::text FROM provider_metadata WHERE provider = 'aggregated'
        `;
        // Only the two items after the checkpoint were re-aggregated.
        expect(aggregated.map((r) => r.media_id).sort()).toEqual(ordered.slice(1));
        expect(saves.at(-1)?.afterMediaId).toBe(ordered[2]);
    });
});
