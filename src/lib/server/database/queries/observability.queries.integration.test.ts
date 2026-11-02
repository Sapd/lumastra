// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the task-system observability query module (Slice 0).
 *
 * Covers:
 *   - audit_log (source='subsystem') table + indexes exist after migration
 *     16.107.0 (IF NOT EXISTS guards make it idempotent on re-run).
 *   - audit_log subsystem rows: append → read by category/limit; newest-first
 *     ordering; prune drops only >30d rows; source='admin' rows are untouched.
 *   - boot_recovery_log: insert + latest read; 30d prune.
 *
 * Runs against the shared lumastra_tests database (migrations already applied by
 * the vitest global setup hook).
 *
 * Run locally:
 *   npm run test:integration src/lib/server/database/queries/observability.queries
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    insertAuditEvent,
    listAuditEvents,
    pruneAuditEvents,
    insertBootRecoveryLog,
    getLatestBootRecovery,
    pruneBootRecoveryLog,
} from './observability.queries.js';

describe('observability.queries (migration 16.107.0)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clear test-owned rows from audit_log (subsystem source) and
        // boot_recovery_log between tests for deterministic assertions.
        await sql`DELETE FROM audit_log WHERE source = 'subsystem' AND instance_id = 'web-1'`;
        await sql`TRUNCATE boot_recovery_log RESTART IDENTITY`;
    });

    // ── Migration shape + idempotency ───────────────────────────────────────

    it('audit_log table exists with the required indexes', async () => {
        const tables = await sql<{ table_name: string }[]>`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'audit_log'
        `;
        expect(tables.map((t) => t.table_name)).toEqual(['audit_log']);

        // Old tables must not exist after the consolidation migration.
        const oldTables = await sql<{ table_name: string }[]>`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('system_audit_log', 'admin_audit_log')
        `;
        expect(oldTables).toHaveLength(0);

        const indexes = await sql<{ indexname: string }[]>`
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname IN (
                'boot_recovery_log_finished_at_idx',
                'idx_audit_log_source_ts',
                'idx_audit_log_category_ts'
              )
        `;
        expect(indexes.length).toBe(3);
    });

    // ── audit_log (source='subsystem') ─────────────────────────────────────

    it('appends and reads subsystem audit events newest-first', async () => {
        await insertAuditEvent(sql, {
            instanceId: 'web-1',
            category: 'reconciler',
            action: 'orphans-reclaimed',
            severity: 'warn',
            summary: 'reclaimed 3 orphans',
            detail: { orphansReclaimed: 3 },
        });
        await insertAuditEvent(sql, {
            instanceId: 'web-1',
            category: 'leader',
            action: 'leader-acquired',
            severity: 'info',
            summary: 'leadership acquired for cpu',
        });

        const all = await listAuditEvents(sql, { limit: 50 });
        // Filter to our test instance only (other tests may have left rows).
        const mine = all.filter((e) => e.instanceId === 'web-1');
        expect(mine.length).toBe(2);
        // Newest-first: the leader event was inserted last.
        expect(mine[0].action).toBe('leader-acquired');
        expect(mine[1].action).toBe('orphans-reclaimed');
        expect(mine[1].detail).toEqual({ orphansReclaimed: 3 });
    });

    it('filters by category and clamps to limit', async () => {
        await insertAuditEvent(sql, {
            instanceId: 'web-1',
            category: 'reconciler',
            action: 'orphans-reclaimed',
            severity: 'warn',
            summary: 'a',
        });
        await insertAuditEvent(sql, {
            instanceId: 'web-1',
            category: 'backpressure',
            action: 'backpressure-shed',
            severity: 'warn',
            summary: 'b',
        });

        const onlyReconciler = await listAuditEvents(sql, {
            category: 'reconciler',
            limit: 50,
        });
        const mine = onlyReconciler.filter((e) => e.instanceId === 'web-1');
        expect(mine.length).toBe(1);
        expect(mine[0].category).toBe('reconciler');
    });

    it('prunes only subsystem audit rows older than 30 days, leaves admin rows alone', async () => {
        await insertAuditEvent(sql, {
            instanceId: 'web-1',
            category: 'reconciler',
            action: 'recent',
            severity: 'info',
            summary: 'recent',
        });
        // Backdate one subsystem row well past the 30-day window.
        await sql`
            INSERT INTO audit_log (ts, instance_id, source, category, action, severity, summary, detail)
            VALUES (NOW() - INTERVAL '40 days', 'web-1', 'subsystem', 'reconciler', 'old', 'info', 'old', '{}'::jsonb)
        `;
        // Insert an admin row — pruneAuditEvents must NOT touch it.
        await sql`
            INSERT INTO audit_log (ts, instance_id, source, actor, action, target, outcome, detail)
            VALUES (NOW() - INTERVAL '40 days', 'web-1', 'admin', 'admin-user', 'test.action', 'item', 'ok', '{}'::jsonb)
        `;

        const deleted = await pruneAuditEvents(sql);
        expect(deleted).toBe(1); // only the old subsystem row

        const remaining = await listAuditEvents(sql, { limit: 50 });
        const mine = remaining.filter((e) => e.instanceId === 'web-1');
        expect(mine.length).toBe(1);
        expect(mine[0].action).toBe('recent');

        // Admin row must still exist
        const adminRows = await sql<{ id: number }[]>`
            SELECT id FROM audit_log
            WHERE source = 'admin' AND instance_id = 'web-1' AND action = 'test.action'
        `;
        expect(adminRows.length).toBe(1);

        // Cleanup the admin row we inserted
        await sql`DELETE FROM audit_log WHERE source = 'admin' AND instance_id = 'web-1' AND action = 'test.action'`;
    });

    // ── boot_recovery_log ───────────────────────────────────────────────────

    it('inserts and reads the latest boot-recovery row', async () => {
        const started = new Date(Date.now() - 5_000);
        await insertBootRecoveryLog(sql, {
            instanceId: 'web-1',
            startedAt: started,
            inspected: 10,
            reclaimed: 2,
            wedgedStageRowsReclaimed: 1,
            runIds: ['run-a', 'run-b'],
        });

        const latest = await getLatestBootRecovery(sql);
        expect(latest).not.toBeNull();
        expect(latest?.instanceId).toBe('web-1');
        expect(latest?.inspected).toBe(10);
        expect(latest?.reclaimed).toBe(2);
        expect(latest?.wedgedStageRowsReclaimed).toBe(1);
        expect(latest?.runIds).toEqual(['run-a', 'run-b']);
    });

    it('getLatestBootRecovery returns the most recent by finished_at', async () => {
        await sql`
            INSERT INTO boot_recovery_log (instance_id, started_at, finished_at, reclaimed)
            VALUES ('web-1', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', 9)
        `;
        await insertBootRecoveryLog(sql, {
            instanceId: 'web-2',
            startedAt: new Date(),
            inspected: 0,
            reclaimed: 0,
            wedgedStageRowsReclaimed: 0,
            runIds: [],
        });

        const latest = await getLatestBootRecovery(sql);
        expect(latest?.instanceId).toBe('web-2');
    });

    it('prunes only boot-recovery rows older than 30 days', async () => {
        await insertBootRecoveryLog(sql, {
            instanceId: 'web-1',
            startedAt: new Date(),
            inspected: 0,
            reclaimed: 0,
            wedgedStageRowsReclaimed: 0,
            runIds: [],
        });
        await sql`
            INSERT INTO boot_recovery_log (instance_id, started_at, finished_at, reclaimed)
            VALUES ('web-old', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days', 0)
        `;

        const deleted = await pruneBootRecoveryLog(sql);
        expect(deleted).toBe(1);

        const latest = await getLatestBootRecovery(sql);
        expect(latest?.instanceId).toBe('web-1');
    });
});
