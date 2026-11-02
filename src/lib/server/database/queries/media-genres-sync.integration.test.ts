// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the media_genres projection + trg_provider_metadata_genres
 * trigger (migration 16.122.0). Proves the table is populated by ANY write to
 * provider_metadata — not a per-writer app hook — for both genre encodings, and
 * that it stays consistent across re-enrich and delete.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

async function writeProviderGenres(
    sql: postgres.Sql,
    mediaId: string,
    provider: string,
    genres: Array<number | { id: number; name: string }> | null,
): Promise<void> {
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
        VALUES (${mediaId}::uuid, ${provider}, ${sql.json({ genres })}::jsonb, NOW(), NOW())
        ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()
    `;
}

async function genreRows(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Array<{ source: string; genre_id: number; genre_name: string | null }>> {
    return sql<Array<{ source: string; genre_id: number; genre_name: string | null }>>`
        SELECT source, genre_id, genre_name FROM media_genres WHERE media_id = ${mediaId}::uuid
        ORDER BY source, genre_id
    `;
}

describe('media_genres sync trigger', () => {
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

    it('projects OBJECT-encoded genres with id + name on insert', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeProviderGenres(sql, item.id, 'tmdb', [
            { id: 28, name: 'Action' },
            { id: 12, name: 'Adventure' },
        ]);
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([
            { source: 'tmdb', genre_id: 12, genre_name: 'Adventure' },
            { source: 'tmdb', genre_id: 28, genre_name: 'Action' },
        ]);
    });

    it('projects SCALAR-encoded (bare number) genres with id + NULL name', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        // The shape tmdb-metadata-sync writes: genres as an array of ids.
        await writeProviderGenres(sql, item.id, 'tmdb', [16, 18]);
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([
            { source: 'tmdb', genre_id: 16, genre_name: null },
            { source: 'tmdb', genre_id: 18, genre_name: null },
        ]);
    });

    it('dedups a repeated id within one array (e.g. scalar [16,18,18])', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        // Real preprod data shape that broke the naive ON CONFLICT backfill.
        await writeProviderGenres(sql, item.id, 'aggregated', [16, 18, 18]);
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([
            { source: 'aggregated', genre_id: 16, genre_name: null },
            { source: 'aggregated', genre_id: 18, genre_name: null },
        ]);
    });

    it('prefers the named element when an id appears as both object and number', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeProviderGenres(sql, item.id, 'tmdb', [18, { id: 18, name: 'Drama' }]);
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([{ source: 'tmdb', genre_id: 18, genre_name: 'Drama' }]);
    });

    it('replaces a provider slice in place on re-enrich (UPDATE OF metadata)', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeProviderGenres(sql, item.id, 'tmdb', [{ id: 28, name: 'Action' }]);
        await writeProviderGenres(sql, item.id, 'tmdb', [{ id: 18, name: 'Drama' }]);
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([{ source: 'tmdb', genre_id: 18, genre_name: 'Drama' }]);
    });

    it('keeps per-source rows for multiple providers', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeProviderGenres(sql, item.id, 'tmdb', [{ id: 28, name: 'Action' }]);
        await writeProviderGenres(sql, item.id, 'aggregated', [{ id: 18, name: 'Drama' }]);
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([
            { source: 'aggregated', genre_id: 18, genre_name: 'Drama' },
            { source: 'tmdb', genre_id: 28, genre_name: 'Action' },
        ]);
    });

    it('clears rows when the media_item is deleted (FK cascade)', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeProviderGenres(sql, item.id, 'tmdb', [{ id: 28, name: 'Action' }]);
        await sql`DELETE FROM media_items WHERE id = ${item.id}::uuid`;
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([]);
    });

    it('clears a provider slice when its provider_metadata row is deleted', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeProviderGenres(sql, item.id, 'tmdb', [{ id: 28, name: 'Action' }]);
        await writeProviderGenres(sql, item.id, 'aggregated', [{ id: 18, name: 'Drama' }]);
        await sql`DELETE FROM provider_metadata WHERE media_id = ${item.id}::uuid AND provider = 'tmdb'`;
        const rows = await genreRows(sql, item.id);
        expect(rows).toEqual([{ source: 'aggregated', genre_id: 18, genre_name: 'Drama' }]);
    });
});
