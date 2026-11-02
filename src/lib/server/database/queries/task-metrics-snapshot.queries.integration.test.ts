// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the trend-snapshot writer/reader (Slice 3 §4.4, §9).
 *
 * Real Postgres `lumastra_tests` — exercises migration 16.30.0's table via
 * insert + windowed/ordered list + 30d prune. (Migration idempotency on a
 * fresh DB is covered by the migration runner; here we assert query behaviour.)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertSnapshot,
    listSnapshots,
    getLatestSnapshot,
    pruneSnapshots,
} from './task-metrics-snapshot.queries.js';

describe('task_metrics_snapshot queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_metrics_snapshot`;
    });

    afterAll(async () => {
        await sql`DELETE FROM task_metrics_snapshot`;
        await closeTestDb();
    });

    it('inserts and reads back a snapshot with JSONB maps intact', async () => {
        await insertSnapshot(sql, {
            instanceId: 'it-instance',
            queueDepth: { cpu: 3, io: 0 },
            activeRuns: { cpu: 1 },
            durationP50Ms: 1200,
            durationP95Ms: 8000,
            runsCompleted: 10,
            runsFailed: 2,
            openCircuits: 1,
        });

        const latest = await getLatestSnapshot(sql);
        expect(latest).not.toBeNull();
        expect(latest?.queueDepth).toEqual({ cpu: 3, io: 0 });
        expect(latest?.activeRuns).toEqual({ cpu: 1 });
        expect(latest?.durationP95Ms).toBe(8000);
        expect(latest?.openCircuits).toBe(1);
    });

    it('lists oldest→newest within the window', async () => {
        await sql`
            INSERT INTO task_metrics_snapshot (instance_id, ts) VALUES
                ('it', NOW() - INTERVAL '3 hours'),
                ('it', NOW() - INTERVAL '1 hours'),
                ('it', NOW() - INTERVAL '2 hours')
        `;
        const points = await listSnapshots(sql, { sinceHours: 6, limit: 100 });
        expect(points).toHaveLength(3);
        // ascending ts
        const ts = points.map((p) => new Date(p.ts).getTime());
        expect(ts[0]).toBeLessThan(ts[1]);
        expect(ts[1]).toBeLessThan(ts[2]);
    });

    it('clamps to the window', async () => {
        await sql`
            INSERT INTO task_metrics_snapshot (instance_id, ts) VALUES
                ('it', NOW() - INTERVAL '1 hours'),
                ('it', NOW() - INTERVAL '48 hours')
        `;
        const points = await listSnapshots(sql, { sinceHours: 6, limit: 100 });
        expect(points).toHaveLength(1);
    });

    it('prunes rows older than 30 days', async () => {
        await sql`
            INSERT INTO task_metrics_snapshot (instance_id, ts) VALUES
                ('it', NOW() - INTERVAL '40 days'),
                ('it', NOW() - INTERVAL '1 days')
        `;
        const deleted = await pruneSnapshots(sql);
        expect(deleted).toBe(1);
        const remaining = await listSnapshots(sql, {
            sinceHours: 24 * 60,
            limit: 100,
        });
        expect(remaining).toHaveLength(1);
    });
});
