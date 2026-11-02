// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestSeries } from '../../../../../tests/integration/fixtures/index.js';
import { getFileAssociationCounts } from './admin-file-associations.queries.js';
let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
});
afterAll(async () => {
    await closeTestDb();
});
it('counts associations globally even when a file is requested from one episode context', async () => {
    const { seriesId } = await createAndInsertTestSeries(sql, {
        seasonCount: 1,
        episodesPerSeason: 3,
    });
    const episodes = await sql<
        { id: string }[]
    >`SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id WHERE season.parent_id=${seriesId} AND ep.media_type='episode'`;
    const fileId = crypto.randomUUID();
    await sql`INSERT INTO media_files(id,file_path) VALUES(${fileId},'/fictional/shared-count.mkv')`;
    for (const ep of episodes)
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES(${fileId},${ep.id},true)`;
    const context = await sql<
        { file_id: string }[]
    >`SELECT file_id FROM media_file_items WHERE media_item_id=${episodes[0].id}`;
    expect(context).toHaveLength(1);
    const counts = await getFileAssociationCounts(sql, [...context.map((r) => r.file_id), fileId]);
    expect([...counts]).toEqual([[fileId, 3]]);
    expect((await getFileAssociationCounts(sql, [])).size).toBe(0);
});
