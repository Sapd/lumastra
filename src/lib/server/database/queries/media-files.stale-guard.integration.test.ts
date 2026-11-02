// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { deleteStaleMediaFile } from './media-files.queries.js';

const TEST_FILE_PATH = '/test/stale-guard/movie.mkv';

describe('deleteStaleMediaFile — notNewerThan timestamp guard', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        await sql`DELETE FROM media_files WHERE file_path = ${TEST_FILE_PATH}`;
    });

    async function seedRow(updatedAt: Date): Promise<void> {
        await sql`
            INSERT INTO media_files (file_path, updated_at)
            VALUES (${TEST_FILE_PATH}, ${updatedAt})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = EXCLUDED.updated_at
        `;
    }

    async function rowExists(): Promise<boolean> {
        const rows = await sql<{ exists: boolean }[]>`
            SELECT EXISTS (
                SELECT 1 FROM media_files WHERE file_path = ${TEST_FILE_PATH}
            ) AS exists
        `;
        return rows[0].exists;
    }

    it('spares a row whose updated_at is AFTER the walk-start timestamp', async () => {
        const [{ now: rowTime }] = await sql<[{ now: Date }]>`SELECT NOW() AS now`;
        await seedRow(rowTime);

        // notNewerThan is 10 seconds before the row was written
        const walkStart = new Date(rowTime.getTime() - 10_000);

        const result = await deleteStaleMediaFile(sql, TEST_FILE_PATH, walkStart);

        expect(result.deleted).toBe(false);
        expect(await rowExists()).toBe(true);
    });

    it('deletes a row whose updated_at is AT OR BEFORE the walk-start timestamp', async () => {
        const [{ now: rowTime }] = await sql<[{ now: Date }]>`SELECT NOW() AS now`;
        await seedRow(rowTime);

        // notNewerThan is 10 seconds after the row was written
        const walkStart = new Date(rowTime.getTime() + 10_000);

        const result = await deleteStaleMediaFile(sql, TEST_FILE_PATH, walkStart);

        expect(result.deleted).toBe(true);
        expect(await rowExists()).toBe(false);
    });

    it('deletes the row when no notNewerThan param is given (existing behavior)', async () => {
        const [{ now: rowTime }] = await sql<[{ now: Date }]>`SELECT NOW() AS now`;
        await seedRow(rowTime);

        const result = await deleteStaleMediaFile(sql, TEST_FILE_PATH);

        expect(result.deleted).toBe(true);
        expect(await rowExists()).toBe(false);
    });
});
