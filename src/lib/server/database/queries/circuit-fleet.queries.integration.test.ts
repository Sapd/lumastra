// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the circuit-fleet reader (Slice 3 §4.2, §9).
 *
 * Real Postgres `lumastra_tests`. Seeds task_circuit_state across
 * closed/open/half_open + a live vs expired force-enable, asserts the entry
 * mapping + force-enable TTL logic + open-first ordering.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { listCircuitFleet } from './circuit-fleet.queries.js';

const TTL_MS = 60 * 60 * 1000; // 1h force-enable window

describe('listCircuitFleet', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_circuit_state`;
        await sql`DELETE FROM task_history WHERE task_id LIKE 'task-%'`;
    });

    afterAll(async () => {
        await sql`DELETE FROM task_circuit_state`;
        await sql`DELETE FROM task_history WHERE task_id LIKE 'task-%'`;
        await closeTestDb();
    });

    it('maps state, ordering (open first), and counts consecutive failures', async () => {
        await sql`
            INSERT INTO task_circuit_state (task_id, state, consecutive_failures, opened_at, opened_reason)
            VALUES
                ('task-closed', 'closed', 0, NULL, NULL),
                ('task-open', 'open', 4, NOW(), 'consecutive_failures'),
                ('task-half', 'half_open', 2, NOW() - INTERVAL '1 minute', 'failure_rate')
        `;

        const fleet = await listCircuitFleet(sql, { forceEnableTtlMs: TTL_MS });
        expect(fleet).toHaveLength(3);
        // Open first, then half_open, then closed.
        expect(fleet[0].state).toBe('open');
        expect(fleet[1].state).toBe('half_open');
        expect(fleet[2].state).toBe('closed');

        const open = fleet.find((e) => e.taskId === 'task-open');
        expect(open?.consecutiveFailures).toBe(4);
        expect(open?.openedReason).toBe('consecutive_failures');
        expect(open?.openedAt).not.toBeNull();
    });

    it('treats a live force-enable as forceEnabled=true', async () => {
        await sql`
            INSERT INTO task_circuit_state (task_id, state, consecutive_failures, manual_override, override_at)
            VALUES ('task-live', 'open', 4, 'force_enabled', NOW())
        `;
        const fleet = await listCircuitFleet(sql, { forceEnableTtlMs: TTL_MS });
        expect(fleet.find((e) => e.taskId === 'task-live')?.forceEnabled).toBe(true);
    });

    it('treats an expired force-enable as forceEnabled=false', async () => {
        await sql`
            INSERT INTO task_circuit_state (task_id, state, consecutive_failures, manual_override, override_at)
            VALUES ('task-expired', 'open', 4, 'force_enabled', NOW() - INTERVAL '2 hours')
        `;
        const fleet = await listCircuitFleet(sql, { forceEnableTtlMs: TTL_MS });
        expect(fleet.find((e) => e.taskId === 'task-expired')?.forceEnabled).toBe(false);
    });

    it("lastErrorMessage carries the most recent failed run's error, not the generic opened_reason", async () => {
        await sql`
            INSERT INTO task_circuit_state (task_id, state, consecutive_failures, opened_at, opened_reason)
            VALUES ('task-rate-limited', 'open', 5, NOW(), 'probe_failure')
        `;
        await sql`
            INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version,
                started_at, completed_at, error)
            VALUES ('task-hist-older', 'task-rate-limited', 'task-rate-limited', 'failed',
                ${sql.json({})}, ${sql.json({ kind: 'scheduled' })}, ${sql.json({ type: 'system' })}, '1',
                NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours',
                ${sql.json({ message: 'stale error, should not win' })})
        `;
        await sql`
            INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version,
                started_at, completed_at, error)
            VALUES ('task-hist-newer', 'task-rate-limited', 'task-rate-limited', 'failed',
                ${sql.json({})}, ${sql.json({ kind: 'scheduled' })}, ${sql.json({ type: 'system' })}, '1',
                NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute',
                ${sql.json({ message: 'mdblist-sync: rate limit reached (mdblist.com free-tier quota)' })})
        `;

        const fleet = await listCircuitFleet(sql, { forceEnableTtlMs: TTL_MS });
        const entry = fleet.find((e) => e.taskId === 'task-rate-limited');
        expect(entry?.lastErrorMessage).toBe(
            'mdblist-sync: rate limit reached (mdblist.com free-tier quota)',
        );
        expect(entry?.openedReason).toBe('probe_failure');
    });

    it('lastErrorMessage is null when the task has no failed task_history rows', async () => {
        await sql`
            INSERT INTO task_circuit_state (task_id, state, consecutive_failures, opened_at, opened_reason)
            VALUES ('task-no-history', 'open', 5, NOW(), 'consecutive_failures')
        `;
        const fleet = await listCircuitFleet(sql, { forceEnableTtlMs: TTL_MS });
        expect(fleet.find((e) => e.taskId === 'task-no-history')?.lastErrorMessage).toBeNull();
    });
});
