// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { findSeriesFolderOwnerId } from './series-folder-ownership.queries.js';

// The prefilter must return one owner without the heavy fence's 1001-row
// limit, and must include contradictions rather than filtering them away.
describe('series-folder ownership reclaim prefilter (real PG)', () => {
    let sql: postgres.Sql;
    let groupId: string;
    let seriesId: string;
    let seasonId: string;
    const folder = '/library/Show';
    const incoming = `${folder}/Season 01/Renamed S01E01.mp4`;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        groupId = crypto.randomUUID();
        seriesId = crypto.randomUUID();
        seasonId = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}, ${groupId})`;
        await sql`INSERT INTO media_items (id, title, media_type, library_group_id, year)
            VALUES (${seriesId}, 'Show', 'tv', ${groupId}, 2026)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${seasonId}, 'Season 1', 'season', ${seriesId})`;
        return async () => {
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_groups WHERE id = ${groupId}`;
        };
    });

    async function witness(filePath: string, parentId: string = seasonId): Promise<string> {
        const episodeId = crypto.randomUUID();
        const fileId = crypto.randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${episodeId}, 'Episode', 'episode', ${parentId})`;
        await sql`INSERT INTO media_files (id, file_path, library_group_id)
            VALUES (${fileId}, ${filePath}, ${groupId})`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}, ${episodeId})`;
        return fileId;
    }

    it('finds the unique owner beyond 1000 witnesses', async () => {
        // Batch fixture creation so the regression itself has no per-episode DB roundtrips.
        await sql`WITH episodes AS (
            INSERT INTO media_items (title, media_type, parent_id)
            SELECT 'Episode ' || n, 'episode', ${seasonId}::uuid FROM generate_series(1, 1002) n
            RETURNING id
        ), files AS (
            INSERT INTO media_files (id, file_path, library_group_id)
            SELECT id, ${folder + '/Season 01/'} || id::text || '.mp4', ${groupId}::uuid FROM episodes
            RETURNING id
        ) INSERT INTO media_file_items (file_id, media_item_id) SELECT id, id FROM files`;
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId, 2026)).toBe(seriesId);
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId, 2001)).toBeNull();
    });

    it('keeps mixed, invalid and missing witnesses unknown; excludes the incoming file and adjacent folders', async () => {
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBeNull();
        await witness(`${folder}/Season 01/S01E02.mp4`);
        const otherSeries = crypto.randomUUID();
        const otherSeason = crypto.randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, library_group_id)
            VALUES (${otherSeries}, 'Other', 'tv', ${groupId})`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id)
            VALUES (${otherSeason}, 'Season 1', 'season', ${otherSeries})`;
        const contradictoryFile = await witness(incoming, otherSeason);
        await witness('/library/Show Extra/S01E01.mp4', otherSeason);
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBe(seriesId);
        await sql`UPDATE media_files SET file_path = ${folder + '/Season 01/Other.mp4'} WHERE id = ${contradictoryFile}`;
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBeNull();
        await sql`UPDATE media_files SET is_missing = true WHERE id = ${contradictoryFile}`;
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBeNull();
        await sql`UPDATE media_items SET parent_id = ${seasonId} WHERE parent_id = ${otherSeason}`;
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBeNull();
        await sql`UPDATE media_files SET is_missing = false WHERE id = ${contradictoryFile}`;
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBe(seriesId);
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${seriesId}`;
        expect(await findSeriesFolderOwnerId(sql, folder, incoming, groupId)).toBeNull();
    });
});
