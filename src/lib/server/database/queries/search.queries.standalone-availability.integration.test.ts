// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `searchMedia` derives `is_available` from `media_items.has_files` alone.
 * A row with files and no Jellyfin id in `external_ids` is available; a row
 * without files is not.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import {
    searchMedia,
    searchMediaFulltext,
    searchMediaTrigram,
} from './search.queries.js';

async function insertMovie(
    sql: postgres.Sql,
    title: string,
    tmdbId: number,
    hasFiles: boolean,
): Promise<string> {
    const item = createTestMediaItem({
        title,
        media_type: 'movie',
        year: 2024,
        status: 'active',
        has_files: hasFiles,
    });
    await insertTestMediaItem(sql, item);
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${item.id}::uuid, 'tmdb', ${String(tmdbId)}, 'movie', true)
    `;
    return item.id;
}

describe('searchMedia is_available without Jellyfin ids (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
    });

    it('is true for a has_files row and false for a row without files', async () => {
        const withFiles = await insertMovie(sql, 'Quillmark Withfiles', 7790001, true);
        const withoutFiles = await insertMovie(sql, 'Quillmark Nofiles', 7790002, false);

        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM external_ids WHERE provider = 'jellyfin'
        `;
        expect(count).toBe('0');

        const results = await searchMedia(sql, 'Quillmark', unrestrictedAccess(), {
            availableOnly: false,
        });

        const byId = new Map(results.map((row) => [row.internal_id, row]));
        expect(byId.get(withFiles)?.is_available).toBe(true);
        expect(byId.get(withoutFiles)?.is_available).toBe(false);
    });
});

describe('episodes always require a file in catalog search (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
    });

    async function insertEpisode(title: string, hasFiles: boolean): Promise<string> {
        const item = createTestMediaItem({
            title,
            media_type: 'episode',
            year: 2024,
            status: 'active',
            has_files: hasFiles,
        });
        await insertTestMediaItem(sql, item);
        return item.id;
    }

    it('availableOnly:false keeps file-less movies but never a file-less episode', async () => {
        const ghostMovie = await insertMovie(sql, 'Zephyrine Ghost Movie', 7790011, false);
        const ownedEpisode = await insertEpisode('Zephyrine Owned Episode', true);
        const ghostEpisode = await insertEpisode('Zephyrine Ghost Episode', false);

        const rows = await searchMediaFulltext(sql, 'Zephyrine', unrestrictedAccess(), {
            mediaTypes: ['movie', 'episode'],
            availableOnly: false,
        });

        const ids = new Set(rows.map((row) => row.internal_id));
        expect(ids.has(ghostMovie)).toBe(true);
        expect(ids.has(ownedEpisode)).toBe(true);
        expect(ids.has(ghostEpisode)).toBe(false);
    });

    it('searchMedia: availableOnly:false keeps file-less movies but never a file-less episode', async () => {
        const ghostMovie = await insertMovie(sql, 'Zephyrine Ghost Movie', 7790021, false);
        const ownedEpisode = await insertEpisode('Zephyrine Owned Episode', true);
        const ghostEpisode = await insertEpisode('Zephyrine Ghost Episode', false);

        const rows = await searchMedia(sql, 'Zephyrine', unrestrictedAccess(), {
            mediaTypes: ['movie', 'episode'],
            availableOnly: false,
        });

        const ids = new Set(rows.map((row) => row.internal_id));
        expect(ids.has(ghostMovie)).toBe(true);
        expect(ids.has(ownedEpisode)).toBe(true);
        expect(ids.has(ghostEpisode)).toBe(false);
    });

    it('searchMediaTrigram: availableOnly:false keeps file-less movies but never a file-less episode', async () => {
        const ghostMovie = await insertMovie(sql, 'Zephyrine Ghost Movie', 7790031, false);
        const ownedEpisode = await insertEpisode('Zephyrine Owned Episode', true);
        const ghostEpisode = await insertEpisode('Zephyrine Ghost Episode', false);

        const rows = await searchMediaTrigram(sql, 'Zephyrine', unrestrictedAccess(), {
            mediaTypes: ['movie', 'episode'],
            availableOnly: false,
        });

        const ids = new Set(rows.map((row) => row.internal_id));
        expect(ids.has(ghostMovie)).toBe(true);
        expect(ids.has(ownedEpisode)).toBe(true);
        expect(ids.has(ghostEpisode)).toBe(false);
    });
});
