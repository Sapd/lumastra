// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the watch_state_pull_log query module.
 *
 * Verifies `resetPullCursor` against real PostgreSQL: it NULLs the
 * `last_played_cursor` for exactly one (user, provider) pair and leaves
 * every other row's cursor untouched — so a manual per-user Import
 * re-pulls that provider's full history without disturbing other
 * providers or other users.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { resetPullCursor } from './watch-sync-pull-log.queries.js';

describe('watch_state_pull_log queries — resetPullCursor', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['watch_state_pull_log']);
    });

    async function insertLog(userId: string, provider: string, cursor: string): Promise<void> {
        await sql`
            INSERT INTO watch_state_pull_log
                (user_id, provider, last_pulled_at, resolved_count, skipped_count, error_count, last_played_cursor)
            VALUES (${userId}::uuid, ${provider}, NOW(), 5, 1, 0, ${cursor}::timestamptz)
        `;
    }

    async function readCursor(userId: string, provider: string): Promise<Date | null> {
        const rows = await sql<Array<{ last_played_cursor: Date | null }>>`
            SELECT last_played_cursor
            FROM watch_state_pull_log
            WHERE user_id = ${userId}::uuid AND provider = ${provider}
        `;
        return rows[0]?.last_played_cursor ?? null;
    }

    it('NULLs only the target (user, provider) cursor; other rows untouched', async () => {
        const userA = generateTestUserId();
        const userB = generateTestUserId();
        await ensureTestUser(sql, userA);
        await ensureTestUser(sql, userB);

        const cursor = '2026-01-15T10:00:00.000Z';
        await insertLog(userA, 'mal', cursor);
        await insertLog(userA, 'trakt', cursor);
        await insertLog(userB, 'mal', cursor);

        await resetPullCursor(sql, userA, 'mal');

        // Target cleared.
        expect(await readCursor(userA, 'mal')).toBeNull();
        // Same user, different provider — unchanged.
        expect(await readCursor(userA, 'trakt')).not.toBeNull();
        // Different user, same provider — unchanged.
        expect(await readCursor(userB, 'mal')).not.toBeNull();
    });

    it('is a no-op when no log row exists for the (user, provider) pair', async () => {
        const userA = generateTestUserId();
        await ensureTestUser(sql, userA);

        // No row inserted for (userA, 'mal') — should not throw, no rows affected.
        await expect(resetPullCursor(sql, userA, 'mal')).resolves.toBeUndefined();

        const rows = await sql<Array<{ n: string }>>`
            SELECT count(*)::text AS n FROM watch_state_pull_log WHERE user_id = ${userA}::uuid
        `;
        expect(Number(rows[0]?.n ?? '0')).toBe(0);
    });
});
