// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { buildSearchFilter } from './search-filter.builder.js';

describe('buildSearchFilter ancestor expansion', () => {
    let sql: postgres.Sql;
    const ids: string[] = [];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        if (ids.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
            ids.length = 0;
        }
    });

    async function item(
        title: string,
        mediaType: string,
        parentId: string | null,
    ): Promise<string> {
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, parent_id)
            VALUES (${title}, ${mediaType}, 'active', ${parentId})
            RETURNING id
        `;
        ids.unshift(id);
        return id;
    }

    async function search(query: string, mediaTypes: string[]): Promise<string[]> {
        const filter = buildSearchFilter(sql, query, {
            searchParent: true,
            searchGrandparent: true,
            mediaTypes,
        });
        const rows = await sql<{ id: string }[]>`
            ${filter.cte}
            SELECT mi.id FROM media_items mi WHERE mi.id = ANY(${ids}::uuid[]) ${filter.where}
        `;
        return rows.map((r) => r.id);
    }

    it('finds an episode through its series when seasons are outside the type scope', async () => {
        const series = await item('Zorblaxian Chronicles', 'tv', null);
        const season = await item('Season 1', 'season', series);
        const episode = await item('Pilot', 'episode', season);

        // The series is the hit; the season is the grandparent chain's middle
        // row and is not a searched type, which must not stop the episode
        // from matching.
        expect((await search('Zorblaxian', ['tv', 'episode'])).sort()).toEqual(
            [series, episode].sort(),
        );
        expect((await search('Zorblaxian', ['tv', 'season', 'episode'])).sort()).toEqual(
            [series, season, episode].sort(),
        );
    });
});
