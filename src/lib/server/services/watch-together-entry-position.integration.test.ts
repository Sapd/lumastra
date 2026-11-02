// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { getDb } from '$lib/server/database/connection.js';
import { resolveWatchTogetherEntryPosition } from './watch-together-entry-position';

vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: vi.fn(),
}));

describe('party entry lookup against real file links', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
        vi.mocked(getDb).mockReturnValue(sql);
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('selects the requested episode default window without borrowing it for an alternate file', async () => {
        const [series] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,media_type,status) VALUES ('Entry test','tv','active') RETURNING id`;
        const [season] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,media_type,status,parent_id,season_number) VALUES ('Season 1','season','active',${series.id},1) RETURNING id`;
        const [one, two] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,media_type,status,parent_id,season_number,episode_number)
            VALUES ('Part one','episode','active',${season.id},1,1),('Part two','episode','active',${season.id},1,2) RETURNING id`;
        const [file, alternate] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path,duration_seconds)
            VALUES ('/entry-test/combined.mkv',120),('/entry-test/alternate.mkv',60) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default,sort_order,start_offset_ms,end_offset_ms,offset_source)
            VALUES (${file.id},${one.id},true,0,0,60000,'manual'),(${file.id},${two.id},true,1,60000,120000,'manual'),
                   (${alternate.id},${two.id},false,1,NULL,NULL,NULL)`;
        expect(await resolveWatchTogetherEntryPosition(two.id, 'episode')).toBe(60);
        expect(await resolveWatchTogetherEntryPosition(two.id, 'episode', file.id)).toBe(60);
        expect(await resolveWatchTogetherEntryPosition(two.id, 'episode', alternate.id)).toBe(0);
        expect(await resolveWatchTogetherEntryPosition(one.id, 'episode')).toBe(0);
        expect(await resolveWatchTogetherEntryPosition(two.id, 'episode', undefined, 0)).toBe(0);
    });
});
