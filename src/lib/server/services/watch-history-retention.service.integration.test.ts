// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for WatchHistoryRetentionService.pruneWatchHistory.
 *
 * Verifies the retention window (rows older than the cutoff are deleted, newer
 * rows are kept), the drain-exit accounting, and abort-signal handling.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { pruneWatchHistory } from './watch-history-retention.service.js';

describe('WatchHistoryRetentionService.pruneWatchHistory', () => {
    let sql: postgres.Sql;
    let userId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['watch_history', 'users']);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
    });

    async function insertRow(daysAgo: number): Promise<void> {
        const start = new Date(Date.now() - daysAgo * 86_400_000);
        await sql`
            INSERT INTO watch_history (user_id, media_type, source_service, title, session_start_time)
            VALUES (${userId}::uuid, 'movie', 'test', 'T', ${start})
        `;
    }

    async function countRows(): Promise<number> {
        const r = await sql<{ c: string }[]>`SELECT COUNT(*)::text AS c FROM watch_history`;
        return parseInt(r[0]?.c ?? '0', 10);
    }

    it('deletes rows older than the retention window and keeps newer ones', async () => {
        await insertRow(500); // older than 400d cutoff → deleted
        await insertRow(410); // older → deleted
        await insertRow(300); // within window → kept
        await insertRow(10); // within window → kept

        const result = await pruneWatchHistory(sql, 400);

        expect(result.deleted).toBe(2);
        expect(result.aborted).toBe(false);
        expect(result.batches).toBeGreaterThanOrEqual(1);
        expect(await countRows()).toBe(2);
    });

    it('is a no-op when nothing is older than the cutoff', async () => {
        await insertRow(10);
        await insertRow(100);

        const result = await pruneWatchHistory(sql, 400);

        expect(result.deleted).toBe(0);
        expect(await countRows()).toBe(2);
    });

    it('does nothing and reports aborted when the signal is already aborted', async () => {
        await insertRow(500);
        const controller = new AbortController();
        controller.abort();

        const result = await pruneWatchHistory(sql, 400, controller.signal);

        expect(result.aborted).toBe(true);
        expect(result.deleted).toBe(0);
        expect(await countRows()).toBe(1); // old row survives — prune never ran
    });
});
