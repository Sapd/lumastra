// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `deleteAllUnpinnedNotifications` against real Postgres: the drawer's
 * "Clear all" must delete only the caller's rows, and must spare an
 * announcement whose pin is still in force — but not one whose pin lapsed or
 * was never set, matching what the single DELETE accepts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { deleteAllUnpinnedNotifications } from './user-notifications.queries.js';

const TABLES = ['user_notifications', 'admin_broadcasts'] as const;

describe('deleteAllUnpinnedNotifications (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TABLES);
    });

    afterAll(async () => {
        await truncateTables(sql, TABLES);
        await closeTestDb();
    });

    async function broadcast(pin: 'active' | 'lapsed' | 'none'): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO admin_broadcasts (title, audience, pinned_at, pin_expires_at, created_by)
            VALUES (
                'Maintenance', 'all',
                ${pin === 'none' ? null : sql`now() - interval '1 day'`},
                ${pin === 'lapsed' ? sql`now() - interval '1 hour'` : null},
                'admin'
            )
            RETURNING id
        `;
        return row.id;
    }

    async function notify(userId: string, broadcastId: string | null = null): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO user_notifications (user_id, kind, payload, broadcast_id)
            VALUES (${userId}::uuid, 'request.available', ${sql.json({ mediaId: 'm' })}, ${broadcastId})
            RETURNING id
        `;
        return row.id;
    }

    it('deletes the caller’s unpinned rows, keeps active pins and other users’ rows', async () => {
        const me = generateTestUserId();
        const other = generateTestUserId();
        await ensureTestUser(sql, me);
        await ensureTestUser(sql, other);

        const plain = await notify(me);
        const read = await notify(me);
        await sql`UPDATE user_notifications SET read_at = now() WHERE id = ${read}::uuid`;
        const pinned = await notify(me, await broadcast('active'));
        const lapsed = await notify(me, await broadcast('lapsed'));
        const unpinned = await notify(me, await broadcast('none'));
        const theirs = await notify(other);

        const deleted = await deleteAllUnpinnedNotifications(sql, me);

        expect(deleted.map((r) => r.id).sort()).toEqual([plain, read, lapsed, unpinned].sort());
        expect(deleted[0].kind).toBe('request.available');
        const left = await sql<{ id: string }[]>`SELECT id FROM user_notifications ORDER BY id`;
        expect(left.map((r) => r.id).sort()).toEqual([pinned, theirs].sort());
    });
});
