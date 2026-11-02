// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix matches → "Remove from library" + Undo: the restore must bring back
 * exactly what the removal hid (the item and its seasons/episodes), and must
 * leave rows the scanner's rename path dismissed (dismissed_content_hash set)
 * alone.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { dismissMediaItemWithChildren } from './media-items.queries.js';
import { restoreDismissedMediaItemWithChildren } from './unmatched-files.queries.js';

describe('restoreDismissedMediaItemWithChildren (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM media_items WHERE title LIKE 'unmatched-restore-test-%'`;
    });

    async function insert(
        title: string,
        mediaType: string,
        parentId: string | null = null,
    ): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, parent_id)
            VALUES (${id}::uuid, ${title}, ${mediaType}, 'active', ${parentId})
        `;
        return id;
    }

    async function dismissedOf(ids: string[]): Promise<boolean[]> {
        const rows = await sql<{ id: string; is_dismissed: boolean }[]>`
            SELECT id, is_dismissed FROM media_items WHERE id = ANY(${ids}::uuid[])
        `;
        return ids.map((id) => rows.find((r) => r.id === id)?.is_dismissed ?? false);
    }

    it('undoes a removal of a series with its seasons and episodes', async () => {
        const series = await insert('unmatched-restore-test-series', 'tv');
        const season = await insert('unmatched-restore-test-season', 'season', series);
        const episode = await insert('unmatched-restore-test-episode', 'episode', season);

        expect(await dismissMediaItemWithChildren(sql, series)).toBe(3);
        expect(await dismissedOf([series, season, episode])).toEqual([true, true, true]);

        expect(await restoreDismissedMediaItemWithChildren(sql, series)).toBe(3);
        expect(await dismissedOf([series, season, episode])).toEqual([false, false, false]);
    });

    it('leaves a rename-path dismissal (content hash set) alone', async () => {
        const movie = await insert('unmatched-restore-test-renamed', 'movie');
        await sql`
            UPDATE media_items
               SET is_dismissed = true, dismissed_content_hash = 'abc123'
             WHERE id = ${movie}::uuid
        `;

        expect(await restoreDismissedMediaItemWithChildren(sql, movie)).toBe(0);
        expect(await dismissedOf([movie])).toEqual([true]);
    });

    it('never dismisses an item that has a provider match', async () => {
        const movie = await insert('unmatched-restore-test-matched', 'movie');
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${movie}::uuid, 'tmdb', ${String(1 + (Date.now() % 9_000_000))}, 'movie')
        `;
        expect(await dismissMediaItemWithChildren(sql, movie)).toBe(0);
        expect(await dismissedOf([movie])).toEqual([false]);
        await sql`DELETE FROM external_ids WHERE media_id = ${movie}::uuid`;
    });

    it('returns 0 for an item that is not removed', async () => {
        const movie = await insert('unmatched-restore-test-live', 'movie');
        expect(await restoreDismissedMediaItemWithChildren(sql, movie)).toBe(0);
    });
});
