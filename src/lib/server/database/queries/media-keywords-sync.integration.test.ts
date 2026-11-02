// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the media_keywords projection + trg_provider_metadata_keywords
 * trigger (migration 16.125.0): both keyword_types, lowercasing/trim, in-array dedup,
 * per-source rows, and delete cascade.
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
        VALUES (${mediaId}::uuid, ${provider}, ${sql.json(meta as postgres.JSONValue)}::jsonb, NOW(), NOW())
        ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = NOW()
    `;
}
async function kws(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Array<{ keyword_type: string; keyword: string; source: string }>> {
    return sql`SELECT source, keyword_type, keyword FROM media_keywords WHERE media_id = ${mediaId}::uuid ORDER BY keyword_type, keyword`;
}

describe('media_keywords sync trigger', () => {
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

    it('projects both keyword_types, lowercased + trimmed, deduped', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeMeta(sql, item.id, 'tmdb', {
            mdblist_keywords: ['Time Travel', ' time travel ', 'Dystopia'],
            keywords: ['Heist', 'heist'],
        });
        expect(await kws(sql, item.id)).toEqual([
            { source: 'tmdb', keyword_type: 'mdblist', keyword: 'dystopia' },
            { source: 'tmdb', keyword_type: 'mdblist', keyword: 'time travel' },
            { source: 'tmdb', keyword_type: 'plain', keyword: 'heist' },
        ]);
    });

    it('replaces the slice on re-enrich and drops empty entries', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeMeta(sql, item.id, 'tmdb', { keywords: ['Alpha'] });
        await writeMeta(sql, item.id, 'tmdb', { keywords: ['Beta', '', '   '] });
        expect(await kws(sql, item.id)).toEqual([
            { source: 'tmdb', keyword_type: 'plain', keyword: 'beta' },
        ]);
    });

    it('keeps per-source rows and cascades on media delete', async () => {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);
        await writeMeta(sql, item.id, 'tmdb', { keywords: ['x'] });
        await writeMeta(sql, item.id, 'mdblist', { mdblist_keywords: ['y'] });
        expect((await kws(sql, item.id)).length).toBe(2);
        await sql`DELETE FROM media_items WHERE id = ${item.id}::uuid`;
        expect((await kws(sql, item.id)).length).toBe(0);
    });
});
