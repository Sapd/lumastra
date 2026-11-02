// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { listComments, type CommentsCursor } from './interactions.queries.js';

let sql: postgres.Sql;
const userId = generateTestUserId();
const targetId = crypto.randomUUID();
beforeAll(async () => {
    sql = getTestDb();
    await ensureTestUser(sql, userId);
});
afterAll(async () => {
    await sql`DELETE FROM interactions WHERE target_id = ${targetId}`;
    await closeTestDb();
});

describe('comment keyset continuation', () => {
    it('bootstraps an exact timestamp cursor and walks tied timestamps without duplicates', async () => {
        for (let i = 0; i < 5; i++) {
            await sql`INSERT INTO interactions (target_type, target_id, user_id, body, created_at)
                VALUES ('media', ${targetId}, ${userId}::uuid, ${`comment ${i}`},
                    '2026-10-21 10:00:00.123456+00'::timestamptz)`;
        }
        const ids: string[] = [];
        let cursor: CommentsCursor | undefined;
        for (;;) {
            const rows = await listComments(sql, {
                targetType: 'media',
                targetId,
                limit: 2,
                cursor,
            });
            ids.push(...rows.map((row) => row.id));
            if (rows.length < 2) break;
            const last = rows[rows.length - 1];
            expect(last.created_at_cursor).toContain('.123456');
            cursor = { createdAt: last.created_at_cursor!, id: last.id };
        }
        expect(ids).toHaveLength(5);
        expect(new Set(ids).size).toBe(5);
        expect(ids).toEqual([...ids].sort((a, b) => Number(b) - Number(a)));
    });
});
