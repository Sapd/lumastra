// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the extended audit feed (Slice 3 §5, §9).
 *
 * Real Postgres `lumastra_tests`. Exercises listAuditFeed's severity +
 * multi-category + keyset (before) filters + nextCursor, and sumAuditDetailField
 * (the systemic-panel window roll-up).
 *
 * Since migration 16.107.0, these rows live in `audit_log` (source='subsystem').
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { insertAuditEvent, listAuditFeed, sumAuditDetailField } from './observability.queries.js';

describe('audit feed (extended filters)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM audit_log WHERE source = 'subsystem' AND instance_id = 'it-feed'`;
    });

    afterAll(async () => {
        await sql`DELETE FROM audit_log WHERE source = 'subsystem' AND instance_id = 'it-feed'`;
        await closeTestDb();
    });

    async function seed(
        category: string,
        severity: 'info' | 'warn' | 'error',
        detail?: Record<string, unknown>,
    ) {
        await insertAuditEvent(sql, {
            instanceId: 'it-feed',
            category,
            action: 'test',
            severity,
            summary: `${category}/${severity}`,
            detail,
        });
    }

    it('filters by severity', async () => {
        await seed('reconciler', 'info');
        await seed('reconciler', 'error');
        const { events } = await listAuditFeed(sql, {
            severity: 'error',
            limit: 50,
        });
        const mine = events.filter((e) => e.instanceId === 'it-feed');
        expect(mine.every((e) => e.severity === 'error')).toBe(true);
        expect(mine).toHaveLength(1);
    });

    it('filters by multiple categories', async () => {
        await seed('reconciler', 'info');
        await seed('backpressure', 'warn');
        await seed('leader', 'info');
        const { events } = await listAuditFeed(sql, {
            categories: ['reconciler', 'backpressure'],
            limit: 50,
        });
        const mine = events.filter((e) => e.instanceId === 'it-feed');
        expect(new Set(mine.map((e) => e.category))).toEqual(
            new Set(['reconciler', 'backpressure']),
        );
    });

    it('pages via the keyset cursor (before) newest-first', async () => {
        for (let i = 0; i < 5; i++) await seed('reconciler', 'info');

        const page1 = await listAuditFeed(sql, {
            categories: ['reconciler'],
            limit: 2,
        });
        const p1mine = page1.events.filter((e) => e.instanceId === 'it-feed');
        expect(p1mine).toHaveLength(2);
        expect(page1.nextCursor).not.toBeNull();
        // newest-first → descending ids
        expect(p1mine[0].id).toBeGreaterThan(p1mine[1].id);

        const page2 = await listAuditFeed(sql, {
            categories: ['reconciler'],
            limit: 2,
            before: page1.nextCursor ?? undefined,
        });
        const p2mine = page2.events.filter((e) => e.instanceId === 'it-feed');
        // page2 rows are strictly older than the cursor
        expect(p2mine.every((e) => e.id < (page1.nextCursor ?? 0))).toBe(true);
    });

    it('nextCursor is null on a non-full final page', async () => {
        await seed('reconciler', 'info');
        const { events, nextCursor } = await listAuditFeed(sql, {
            categories: ['reconciler'],
            limit: 50,
        });
        expect(events.filter((e) => e.instanceId === 'it-feed')).toHaveLength(1);
        expect(nextCursor).toBeNull();
    });

    it('sums a numeric detail field over the window', async () => {
        await seed('backpressure', 'warn', { total: 12 });
        await seed('backpressure', 'warn', { total: 8 });
        await seed('backpressure', 'warn', { counters: [] }); // no `total` → 0
        const sum = await sumAuditDetailField(sql, {
            category: 'backpressure',
            action: 'test',
            field: 'total',
            sinceHours: 24,
        });
        expect(sum).toBe(20);
    });
});
