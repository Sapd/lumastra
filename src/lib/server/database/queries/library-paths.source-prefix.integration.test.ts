// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createLibraryPath,
    getLibraryPathById,
    updateLibraryPath,
} from './library-paths.queries.js';

describe('library_paths.source_prefix', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        await sql`DELETE FROM library_paths WHERE path = '/data/test-movies'`;
    });

    it('round-trips source_prefix', async () => {
        const [{ id: groupId }] = await sql<[{ id: string }]>`
            INSERT INTO library_groups (name) VALUES ('test-source-prefix-group') RETURNING id
        `;
        const created = await createLibraryPath(sql, {
            path: '/data/test-movies',
            media_type: 'movie',
            library_group_id: groupId,
        });
        await updateLibraryPath(sql, created.id, { source_prefix: 's3://b/movies/' });
        const row = await getLibraryPathById(sql, created.id);
        expect(row?.source_prefix).toBe('s3://b/movies/');
    });
});
