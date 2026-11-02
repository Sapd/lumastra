// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getReconciliationGroups } from '$lib/server/database/queries/episode-reconciliation.queries.js';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';

const URL = getTestDatabaseUrl();

describe('episode-reconciliation queries (integration)', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = postgres(URL, { max: 2 });
    });
    afterAll(async () => {
        await sql.end();
    });

    it('groups episode rows by their backing file with ordered chapter names', async () => {
        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('ReconTest', 'tv') RETURNING id`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('S1', 'season', ${seriesId}, 1) RETURNING id`;
        const [{ id: ep3 }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Wrong A', 'episode', ${seasonId}, 1, 3) RETURNING id`;
        const [{ id: ep4 }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Wrong B', 'episode', ${seasonId}, 1, 4) RETURNING id`;
        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/recon.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${ep3}, ${fileId}, true), (${ep4}, ${fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileId}, 0, 'Real One', 0, 'file'), (${fileId}, 1, 'Real Two', 1000, 'file')`;
        try {
            const groups = await getReconciliationGroups(sql, seriesId);
            expect(groups).toHaveLength(1);
            expect(groups[0].chapterNames).toEqual(['Real One', 'Real Two']);
            expect(groups[0].episodes.map((e) => e.episodeNumber)).toEqual([3, 4]);
        } finally {
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });
});
