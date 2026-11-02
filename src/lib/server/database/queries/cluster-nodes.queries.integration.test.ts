// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Cluster Nodes Query Module
 *
 * Tests insertNodeEvent, getRecentEvents, getNodeTimeline,
 * getInstancesExpectedOnline, and pruneOldEvents.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import {
    insertNodeEvent,
    getRecentEvents,
    getNodeTimeline,
    getInstancesExpectedOnline,
    pruneOldEvents,
    recordInstanceStart,
    countRestartsSince,
} from './cluster-nodes.queries.js';

describe('Cluster Nodes Queries', () => {
    let sql: postgres.Sql;
    const testInstanceId = 'test-instance-001';

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM cluster_node_events WHERE instance_id LIKE 'test-%'`;
    });

    describe('insertNodeEvent', () => {
        it('inserts an online event', async () => {
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'online',
                role: 'worker',
                version: '1.0.0',
                hostname: 'test-host',
            });

            const rows = await sql`
                SELECT * FROM cluster_node_events WHERE instance_id = ${testInstanceId}
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].event_type).toBe('online');
            expect(rows[0].role).toBe('worker');
        });

        it('inserts an offline event with optional fields null', async () => {
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'offline',
            });

            const rows = await sql`
                SELECT * FROM cluster_node_events WHERE instance_id = ${testInstanceId}
            `;
            expect(rows.length).toBe(1);
            expect(rows[0].role).toBeNull();
            expect(rows[0].version).toBeNull();
        });

        it('inserts a batch of events atomically as a single multi-row INSERT (F6)', async () => {
            await insertNodeEvent(sql, [
                {
                    instanceId: 'test-batch-a',
                    eventType: 'online',
                    role: 'worker',
                    version: '1.0.0',
                    hostname: 'host-a',
                },
                { instanceId: 'test-batch-b', eventType: 'offline' },
                {
                    instanceId: 'test-batch-c',
                    eventType: 'online',
                    role: 'leader',
                },
            ]);

            const rows = await sql`
                SELECT instance_id, event_type, role
                FROM cluster_node_events
                WHERE instance_id LIKE 'test-batch-%'
                ORDER BY instance_id
            `;
            expect(rows.length).toBe(3);
            expect(rows[0].instance_id).toBe('test-batch-a');
            expect(rows[0].event_type).toBe('online');
            expect(rows[1].event_type).toBe('offline');
            expect(rows[1].role).toBeNull();
            expect(rows[2].role).toBe('leader');
        });

        it('is a no-op for an empty batch', async () => {
            await insertNodeEvent(sql, []);
            const rows = await sql`
                SELECT * FROM cluster_node_events WHERE instance_id LIKE 'test-%'
            `;
            expect(rows.length).toBe(0);
        });
    });

    describe('insertNodeEvent idempotency', () => {
        it("skips an event equal to the instance's latest one (graceful stop + leader both record offline)", async () => {
            await insertNodeEvent(sql, { instanceId: testInstanceId, eventType: 'online' });
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'offline',
                version: '1.0.0',
            });
            await insertNodeEvent(sql, { instanceId: testInstanceId, eventType: 'offline' });

            const rows = await sql`
                SELECT event_type, version FROM cluster_node_events
                WHERE instance_id = ${testInstanceId} ORDER BY created_at
            `;
            expect(rows.map((r) => r.event_type)).toEqual(['online', 'offline']);
            expect(rows[1].version).toBe('1.0.0');
        });
    });

    describe('recordInstanceStart', () => {
        async function timeline(): Promise<string[]> {
            const rows = await sql`
                SELECT event_type, reason FROM cluster_node_events
                WHERE instance_id = ${testInstanceId} ORDER BY created_at
            `;
            return rows.map((r) => `${r.event_type}:${r.reason ?? '-'}`);
        }

        it('records a first start as a single online event', async () => {
            const kind = await recordInstanceStart(sql, {
                instanceId: testInstanceId,
                role: 'web',
                version: '2.0.0',
            });
            expect(kind).toBe('start');
            expect(await timeline()).toEqual(['online:start']);
            const counts = await countRestartsSince(sql, { instanceIds: [testInstanceId] });
            expect(counts.has(testInstanceId)).toBe(false);
        });

        it('records a clean restart after a graceful stop', async () => {
            await recordInstanceStart(sql, { instanceId: testInstanceId, version: '1.0.0' });
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'offline',
                version: '1.0.0',
                reason: 'stop',
            });
            expect(await recordInstanceStart(sql, { instanceId: testInstanceId })).toBe('restart');
            const counts = await countRestartsSince(sql, { instanceIds: [testInstanceId] });
            expect(counts.get(testInstanceId)).toEqual({ restarts: 1, unclean: 0 });
        });

        it('treats a legacy graceful stop (version, no reason) as clean', async () => {
            await insertNodeEvent(sql, { instanceId: testInstanceId, eventType: 'online' });
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'offline',
                version: '1.0.0',
            });
            expect(await recordInstanceStart(sql, { instanceId: testInstanceId })).toBe('restart');
        });

        it('counts a restart after the leader saw the key vanish as unclean', async () => {
            await recordInstanceStart(sql, { instanceId: testInstanceId });
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'offline',
                reason: 'missing',
            });
            expect(await recordInstanceStart(sql, { instanceId: testInstanceId })).toBe(
                'restart_unclean',
            );
        });

        it('backfills the unseen exit when the latest event is still online (fast OOM restart)', async () => {
            await recordInstanceStart(sql, { instanceId: testInstanceId });
            expect(await recordInstanceStart(sql, { instanceId: testInstanceId })).toBe(
                'restart_unclean',
            );
            expect(await timeline()).toEqual([
                'online:start',
                'offline:unseen',
                'online:restart_unclean',
            ]);
            expect(await getInstancesExpectedOnline(sql)).toContain(testInstanceId);
            const counts = await countRestartsSince(sql, { instanceIds: [testInstanceId] });
            expect(counts.get(testInstanceId)).toEqual({ restarts: 1, unclean: 1 });
        });

        it("makes the leader's later online for the same key a no-op", async () => {
            await recordInstanceStart(sql, { instanceId: testInstanceId });
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'online',
                reason: 'returned',
            });
            expect(await timeline()).toEqual(['online:start']);
        });
    });

    describe('countRestartsSince', () => {
        it('ignores a heartbeat gap (leader missing/returned) — the process never restarted', async () => {
            await recordInstanceStart(sql, { instanceId: 'test-r-gap' });
            await insertNodeEvent(sql, {
                instanceId: 'test-r-gap',
                eventType: 'offline',
                reason: 'missing',
            });
            await insertNodeEvent(sql, {
                instanceId: 'test-r-gap',
                eventType: 'online',
                reason: 'returned',
            });
            const counts = await countRestartsSince(sql, { instanceIds: ['test-r-gap'] });
            expect(counts.has('test-r-gap')).toBe(false);
        });

        it('counts only restarts of the requested instances inside the window', async () => {
            for (const id of ['test-r-a', 'test-r-b']) {
                await recordInstanceStart(sql, { instanceId: id });
                await recordInstanceStart(sql, { instanceId: id });
            }
            await sql`
                UPDATE cluster_node_events SET created_at = created_at - INTERVAL '2 days'
                WHERE instance_id = 'test-r-b'
            `;

            const counts = await countRestartsSince(sql, {
                instanceIds: ['test-r-a', 'test-r-b', 'test-r-c'],
            });
            expect(counts.get('test-r-a')).toEqual({ restarts: 1, unclean: 1 });
            expect(counts.has('test-r-b')).toBe(false);
            expect(counts.has('test-r-c')).toBe(false);
            expect((await countRestartsSince(sql, { instanceIds: [] })).size).toBe(0);
        });
    });

    describe('getRecentEvents', () => {
        it('returns recently inserted events', async () => {
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'online',
            });

            const rows = await getRecentEvents(sql, { limit: 10, hours: 24 });
            const testRows = rows.filter((r) => r.instanceId.startsWith('test-'));
            expect(testRows.length).toBeGreaterThanOrEqual(1);
        });

        it('respects the hours filter', async () => {
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'online',
            });

            const rows = await getRecentEvents(sql, {
                limit: 10,
                hours: 0,
            });
            const testRows = rows.filter((r) => r.instanceId.startsWith('test-'));
            expect(testRows).toHaveLength(0);
        });
    });

    describe('getNodeTimeline', () => {
        it('returns events for a specific instance', async () => {
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'online',
            });
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'offline',
            });

            const rows = await getNodeTimeline(sql, {
                instanceId: testInstanceId,
                limit: 10,
            });
            expect(rows.length).toBe(2);
            expect(rows[0].eventType).toBe('offline'); // DESC order
        });
    });

    describe('getInstancesExpectedOnline', () => {
        it('returns instance_ids whose latest event is online', async () => {
            const idOnline = 'test-online-001';
            const idOffline = 'test-offline-001';

            await insertNodeEvent(sql, {
                instanceId: idOnline,
                eventType: 'online',
            });
            await insertNodeEvent(sql, {
                instanceId: idOffline,
                eventType: 'online',
            });
            await insertNodeEvent(sql, {
                instanceId: idOffline,
                eventType: 'offline',
            });

            const onlineInstances = await getInstancesExpectedOnline(sql);
            expect(onlineInstances).toContain(idOnline);
            expect(onlineInstances).not.toContain(idOffline);
        });
    });

    describe('pruneOldEvents', () => {
        it('deletes events older than specified days', async () => {
            await insertNodeEvent(sql, {
                instanceId: testInstanceId,
                eventType: 'online',
            });

            const deleted = await pruneOldEvents(sql, { days: 0 });
            expect(deleted).toBeGreaterThanOrEqual(0);
        });
    });
});
