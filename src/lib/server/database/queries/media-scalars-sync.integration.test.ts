// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the media_scalars projection + trg_provider_metadata_scalars
 * trigger (migration 16.124.0). Focuses on the guarded casts: a malformed numeric
 * or date must become NULL (never abort the trigger, which would break ingestion).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

async function writeMeta(
    sql: postgres.Sql,
    mediaId: string,
    provider: string,
    meta: unknown,
): Promise<void> {
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
        VALUES (${mediaId}::uuid, ${provider}, ${sql.json(meta as Record<string, never>)}::jsonb, NOW(), NOW())
        ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()
    `;
}
async function row(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Record<string, unknown> | undefined> {
    const rows = await sql<Record<string, unknown>[]>`
        SELECT mdblist_score, imdb_rating, runtime_minutes, release_date::text AS release_date,
               has_anime_genres, overview
        FROM media_scalars WHERE media_id = ${mediaId}::uuid AND source = 'tmdb'`;
    return rows[0];
}

describe('media_scalars sync trigger', () => {
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

    it('projects well-formed scalars with native types', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeMeta(sql, item.id, 'tmdb', {
            mdblist_score: '82',
            imdb_rating: '7.5',
            runtime_minutes: '88',
            release_date: '1994-09-23',
            overview: 'x',
            anime_genres: [{ id: 1 }],
        });
        const r = await row(sql, item.id);
        expect(Number(r?.mdblist_score)).toBe(82);
        expect(Number(r?.imdb_rating)).toBe(7.5);
        expect(Number(r?.runtime_minutes)).toBe(88);
        expect(String(r?.release_date)).toContain('1994-09-23');
        expect(r?.has_anime_genres).toBe(true);
    });

    it('coerces malformed numerics/dates to NULL without erroring the write', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        // Malformed values on fields with NO pre-existing cast/index constraint on
        // provider_metadata (imdb_rating/popularity are guarded by compute_media_quality_score;
        // mdblist_score by idx_pm_mdblist_score — so those never reach my trigger malformed).
        // media_scalars' own guards must NULL these, not crash the trigger.
        await writeMeta(sql, item.id, 'tmdb', {
            runtime_minutes: '90 min',
            release_date: 'soon',
            rt_rating: '9x',
        });
        const r = await row(sql, item.id);
        expect(r).toBeDefined(); // the write succeeded
        expect(r?.runtime_minutes).toBeNull();
        expect(r?.release_date).toBeNull();
        expect(r?.has_anime_genres).toBe(false);
    });

    it('NULLs a calendar-invalid date that matches the format regex (no crash)', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        // '1994-99-99' matches ^YYYY-MM-DD but is not a real date → ::date would throw.
        await writeMeta(sql, item.id, 'tmdb', { release_date: '1994-99-99' });
        const r = await row(sql, item.id);
        expect(r).toBeDefined();
        expect(r?.release_date).toBeNull();
    });

    it('clears the row on media_item delete (FK cascade)', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeMeta(sql, item.id, 'tmdb', { mdblist_score: '50' });
        await sql`DELETE FROM media_items WHERE id = ${item.id}::uuid`;
        expect(await row(sql, item.id)).toBeUndefined();
    });
});
