// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for CatalogService.batchUpsertExternalIds (SQL-M5).
 *
 * Validates the batched UNNEST DELETE + INSERT rewrite against a real
 * Postgres: stale-mapping cleanup, is_primary inheritance from a deleted
 * row, ON CONFLICT upsert semantics, Jellyfin ID normalization, and
 * intra-batch duplicate collapse (last-write-wins).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import { CatalogService } from './catalog.service.js';

type ExtRow = {
    media_id: string;
    provider: string;
    external_id: string;
    media_type: string;
    is_primary: boolean;
    source: string | null;
    confidence: number;
};

describe('CatalogService.batchUpsertExternalIds (integration)', () => {
    let sql: postgres.Sql;
    let service: CatalogService;

    beforeAll(() => {
        sql = getTestDb();
        service = new CatalogService(sql, { skipLifecycleHooks: true });
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function rowsFor(mediaId: string, provider: string): Promise<ExtRow[]> {
        return await sql<ExtRow[]>`
            SELECT media_id::text, provider, external_id, media_type,
                   is_primary, source, confidence
            FROM external_ids
            WHERE media_id = ${mediaId}::uuid AND provider = ${provider}
            ORDER BY external_id
        `;
    }

    it('inserts multiple items in a single batch', async () => {
        const a = createTestMediaItem({ media_type: 'movie' });
        const b = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, a);
        await insertTestMediaItem(sql, b);

        await service.batchUpsertExternalIds([
            {
                mediaId: a.id,
                externalId: { provider: 'tmdb', id: '550', mediaType: 'movie' },
                isPrimary: true,
            },
            {
                mediaId: b.id,
                externalId: { provider: 'tmdb', id: '1438', mediaType: 'tv' },
            },
        ]);

        const aRows = await rowsFor(a.id, 'tmdb');
        const bRows = await rowsFor(b.id, 'tmdb');
        expect(aRows).toHaveLength(1);
        expect(aRows[0].external_id).toBe('550');
        expect(aRows[0].is_primary).toBe(true);
        expect(bRows).toHaveLength(1);
        expect(bRows[0].external_id).toBe('1438');
        expect(bRows[0].is_primary).toBe(false);
    });

    it('removes a stale mapping and inherits its primary flag', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        // Seed an existing primary jellyfin mapping with an OLD id.
        //
        // `created_at` is set in the past on purpose. A rescan replaces a mapping
        // that has been sitting there since an earlier sync; a rival written
        // milliseconds ago is a different situation entirely — two live writers
        // disagreeing — and is now deliberately NOT replaced, because doing so
        // swapped the row back and forth forever (see catalog-identity-swap
        // .integration.test.ts). Seeding at now() would have been testing the loop.
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source, confidence, created_at)
            VALUES (${item.id}::uuid, 'jellyfin', 'oldjellyfinid000000000000000000a', 'movie', true, 'api', 1.0, now() - interval '1 day')
        `;

        // Re-scan produces a NEW jellyfin id for the same (media, provider, type).
        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'jellyfin',
                    id: 'newjellyfinid000000000000000000b',
                    mediaType: 'movie',
                },
            },
        ]);

        const rows = await rowsFor(item.id, 'jellyfin');
        expect(rows).toHaveLength(1);
        // New id present, old stale id deleted.
        expect(rows[0].external_id).toBe('newjellyfinid000000000000000000b');
        // Primary inherited from the deleted row even though caller passed no isPrimary.
        expect(rows[0].is_primary).toBe(true);
    });

    it('upserts (ON CONFLICT) keeping the greatest confidence', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source, confidence)
            VALUES (${item.id}::uuid, 'tmdb', '550', 'movie', false, 'seed', 0.9)
        `;

        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'tmdb',
                    id: '550',
                    mediaType: 'movie',
                    confidence: 0.5,
                },
            },
        ]);

        const rows = await rowsFor(item.id, 'tmdb');
        expect(rows).toHaveLength(1);
        // GREATEST(existing 0.9, incoming 0.5) === 0.9
        expect(rows[0].confidence).toBe(0.9);
    });

    it('collapses intra-batch duplicates (last-write-wins)', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'tmdb',
                    id: '550',
                    mediaType: 'movie',
                    confidence: 0.3,
                    source: 'first',
                },
            },
            {
                mediaId: item.id,
                externalId: {
                    provider: 'tmdb',
                    id: '550',
                    mediaType: 'movie',
                    confidence: 0.8,
                    source: 'second',
                },
            },
        ]);

        const rows = await rowsFor(item.id, 'tmdb');
        expect(rows).toHaveLength(1);
        expect(rows[0].confidence).toBe(0.8);
        expect(rows[0].source).toBe('second');
    });

    it('blocks automated batch identities on kept items while manual batch matching restores them', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by)
                  VALUES (${item.id}::uuid, 'kept', 'integration-test')`;

        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'tmdb',
                    id: '123456',
                    mediaType: 'movie',
                    source: 'scanner',
                },
            },
        ]);
        expect(await rowsFor(item.id, 'tmdb')).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM personal_media_dispositions WHERE media_id = ${item.id}::uuid`,
        ).toHaveLength(1);

        await service.batchUpsertExternalIds([
            {
                mediaId: item.id,
                externalId: {
                    provider: 'tmdb',
                    id: '123457',
                    mediaType: 'movie',
                    source: 'manual',
                },
            },
        ]);
        expect((await rowsFor(item.id, 'tmdb')).map((row) => row.external_id)).toEqual(['123457']);
        expect(
            await sql`SELECT 1 FROM personal_media_dispositions WHERE media_id = ${item.id}::uuid`,
        ).toHaveLength(0);
    });

    it('blocks descendants of kept roots and retains Keep when a manual id is already owned elsewhere', async () => {
        const root = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, root);
        const seasonId = crypto.randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                  VALUES (${seasonId}::uuid, 'Season 1', 'season', ${root.id}::uuid, 1, 'active')`;
        await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by)
                  VALUES (${root.id}::uuid, 'kept', 'integration-test')`;

        await service.batchUpsertExternalIds([
            {
                mediaId: seasonId,
                externalId: { provider: 'tmdb', id: '321654', mediaType: 'tv', source: 'scanner' },
            },
        ]);
        expect(await rowsFor(seasonId, 'tmdb')).toHaveLength(0);

        const kept = createTestMediaItem({ media_type: 'movie' });
        const owner = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, kept);
        await insertTestMediaItem(sql, owner);
        await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by)
                  VALUES (${kept.id}::uuid, 'kept', 'integration-test')`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, source)
                  VALUES (${owner.id}::uuid, 'tvdb', 'manual-owned-id', 'movie', 'manual')`;
        await service.batchUpsertExternalIds([
            {
                mediaId: kept.id,
                externalId: {
                    provider: 'tvdb',
                    id: 'manual-owned-id',
                    mediaType: 'movie',
                    source: 'manual',
                },
            },
        ]);

        expect(await rowsFor(owner.id, 'tvdb')).toHaveLength(1);
        expect(await rowsFor(kept.id, 'tvdb')).toHaveLength(0);
        expect(
            await sql`SELECT 1 FROM personal_media_dispositions WHERE media_id = ${kept.id}::uuid AND disposition = 'kept'`,
        ).toHaveLength(1);
    });
});
