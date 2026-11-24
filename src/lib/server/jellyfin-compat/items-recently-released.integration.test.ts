// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wholphin's "recently released" home row: `GET /Items?ParentId=<library>&Recursive=true
 * &SortBy=PremiereDate,SeriesSortName,AiredEpisodeOrder&SortOrder=Descending,Ascending,Descending
 * &MaxPremiereDate=<now>&IsUnaired=false` with NO IncludeItemTypes. Jellyfin walks every
 * descendant, so the episodes themselves come back (newest premiere first), unaired ones do not.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { browseMediaItems } from '$lib/server/database/queries/jellyfin-browse.queries.js';
import { parseItemsQuery } from './items-handler.js';

let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [
        'provider_metadata',
        'media_file_items',
        'media_files',
        'library_groups',
        'media_items',
    ]);
});

const day = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function item(
    title: string,
    type: string,
    parentId: string | null,
    premiere: string | null,
    group: string | null,
): Promise<string> {
    const leaf = type === 'movie' || type === 'episode';
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, has_files, premiere_date, runtime_seconds)
        VALUES (${title}, ${type}, 'active', ${parentId}, ${leaf}, ${premiere}, 1500)
        RETURNING id`;
    if (leaf) {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${`/rr/${row.id}.mkv`}, ${group}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${f.id}, ${row.id}, true)`;
    }
    return row.id;
}

describe("Wholphin's recently-released request", () => {
    it('lists released episodes newest first and leaves unaired ones out', async () => {
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('Wholphin TV') RETURNING id`;
        const series = await item('The Body', 'tv', null, day(-4000), group.id);
        const season = await item('Season 2', 'season', series, null, group.id);
        const e1 = await item('F1', 'episode', season, day(-3), group.id);
        const e2 = await item('F2', 'episode', season, day(-1), group.id);
        await item('F3 unaired', 'episode', season, day(5), group.id);

        const q = parseItemsQuery(
            new URL(
                `http://x/Items?userId=u&ParentId=${group.id}&Limit=20&Recursive=true` +
                    '&SortBy=PremiereDate&SortBy=SeriesSortName&SortBy=AiredEpisodeOrder' +
                    '&SortOrder=Descending&SortOrder=Ascending&SortOrder=Descending' +
                    `&MaxPremiereDate=${new Date().toISOString().slice(0, 19)}&IsUnaired=false`,
            ),
        );
        const { rows } = await browseMediaItems(sql, {
            mediaTypes: q.mediaTypes,
            parentId: q.parentId,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: false,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: true,
            userId: undefined,
            idList: [],
            sortBy: q.sortBy,
            sortOrder: q.sortOrder,
            limit: q.limit,
            startIndex: 0,
            access: unrestrictedAccess(),
            recursive: q.recursive,
            maxPremiereDate: q.maxPremiereDate,
            isUnaired: q.isUnaired,
        });
        const ids = rows.map((r) => String(r.id));
        expect(ids.indexOf(e2)).toBeLessThan(ids.indexOf(e1));
        expect(ids).toContain(e1);
        expect(rows.map((r) => String(r.title))).not.toContain('F3 unaired');
    });

    it("Wholphin's library 'recently added' tab (IncludeItemTypes=Episode, DateCreated desc) orders by when files landed", async () => {
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('Series') RETURNING id`;
        const series = await item('The Body', 'tv', null, null, group.id);
        const season = await item('Season 1', 'season', series, null, group.id);
        // Same created_at for all (one metadata fetch), different library_added_at.
        const order = [3, 1, 2];
        const ids: string[] = [];
        for (const [i, m] of order.entries()) {
            const id = await item(`E${i + 1}`, 'episode', season, day(-9), group.id);
            await sql`UPDATE media_items SET created_at = '2026-11-23T10:34:32Z',
                      library_added_at = ${`2026-11-23T10:${30 + m}:00Z`} WHERE id = ${id}`;
            ids.push(id);
        }
        const q = parseItemsQuery(
            new URL(
                `http://x/Items?ParentId=${group.id}&Recursive=true&IncludeItemTypes=Episode` +
                    '&SortBy=DateCreated&SortOrder=Descending&EnableTotalRecordCount=false',
            ),
        );
        const { rows } = await browseMediaItems(sql, {
            mediaTypes: q.mediaTypes,
            parentId: q.parentId,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: false,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: true,
            userId: undefined,
            idList: [],
            sortBy: q.sortBy,
            sortOrder: q.sortOrder,
            limit: 20,
            startIndex: 0,
            access: unrestrictedAccess(),
            recursive: true,
        });
        // library_added_at minutes 33, 31, 32 -> newest first: E1, E3, E2
        expect(rows.map((r) => String(r.id))).toEqual([ids[0], ids[2], ids[1]]);
    });
});
