// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Plugin Failure Events Query Module
 *
 * Tests failure recording, timeline retrieval, and aggregate stats.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { buildTaskFailuresList } from '../../api/defs/tasks/[taskId]/failures.js';

import {
    recordFailure,
    getFailureTimeline,
    getFailureAggregates,
    countUnresolvedFailuresByPlugin,
    markFailureEventsResolved,
} from './plugin-failure-events.queries.js';

describe('Plugin Failure Events Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id LIKE 'test_plugin_%'`;
    });

    // ========================================================================
    // recordFailure
    // ========================================================================

    describe('recordFailure', () => {
        it('inserts a failure event without throwing', async () => {
            await expect(
                recordFailure(sql, 'test_plugin_a', 'item-1', 'connection refused', 'job-1'),
            ).resolves.toBeUndefined();

            const rows = await sql<{ count: number }[]>`
                SELECT COUNT(*)::int AS count FROM plugin_failure_events
                WHERE plugin_id = 'test_plugin_a' AND item_id = 'item-1'
            `;
            expect(rows[0].count).toBe(1);
        });

        it('caps reason at 500 characters', async () => {
            const longReason = 'x'.repeat(600);
            await recordFailure(sql, 'test_plugin_a', 'item-2', longReason, null);

            const row = await sql<{ reason: string }[]>`
                SELECT reason FROM plugin_failure_events
                WHERE plugin_id = 'test_plugin_a' AND item_id = 'item-2'
            `;
            expect(row[0].reason.length).toBe(500);
        });
    });

    // ========================================================================
    // getFailureTimeline
    // ========================================================================

    describe('getFailureTimeline', () => {
        it('returns events ordered newest first', async () => {
            await recordFailure(sql, 'test_plugin_b', 'item-3', 'err1', null);
            await new Promise((r) => setTimeout(r, 20));
            await recordFailure(sql, 'test_plugin_b', 'item-3', 'err2', null);

            const timeline = await getFailureTimeline(sql, 'test_plugin_b', 'item-3', 10);
            expect(timeline.length).toBe(2);
            expect(timeline[0].reason).toBe('err2');
        });

        it('returns empty array when no events', async () => {
            const timeline = await getFailureTimeline(sql, 'test_plugin_b', 'no-item', 10);
            expect(timeline).toEqual([]);
        });
    });

    // ========================================================================
    // getFailureAggregates
    // ========================================================================

    describe('getFailureAggregates', () => {
        it('returns counts and date range per item', async () => {
            await recordFailure(sql, 'test_plugin_c', 'item-4', 'fail', null);
            await recordFailure(sql, 'test_plugin_c', 'item-4', 'fail again', null);

            const map = await getFailureAggregates(sql, 'test_plugin_c', ['item-4']);
            const agg = map.get('item-4');
            expect(agg).toBeDefined();
            expect(agg!.failure_count).toBe(2);
            expect(agg!.first_seen).toBeInstanceOf(Date);
            expect(agg!.last_seen).toBeInstanceOf(Date);
        });

        it('returns empty map for empty itemKeys', async () => {
            const map = await getFailureAggregates(sql, 'test_plugin_c', []);
            expect(map.size).toBe(0);
        });
    });
    // ========================================================================
    // countUnresolvedFailuresByPlugin
    // ========================================================================

    describe('countUnresolvedFailuresByPlugin', () => {
        it('counts DISTINCT items, not appended rows', async () => {
            // The append-only table records one row per attempt. A periodic
            // task that re-attempts the same broken item forever writes an
            // unbounded number of rows for a bounded number of items — prod
            // 2026-09-11: 1,179 rows, 4 items. The alert this feeds says
            // "could not process {count} items", so it has to count items.
            await recordFailure(sql, 'test_plugin_count', 'item-a', 'boom', null);
            await recordFailure(sql, 'test_plugin_count', 'item-a', 'boom', null);
            await recordFailure(sql, 'test_plugin_count', 'item-a', 'boom', null);
            await recordFailure(sql, 'test_plugin_count', 'item-b', 'boom', null);

            const rows = await countUnresolvedFailuresByPlugin(sql);
            const mine = rows.find((r) => r.pluginId === 'test_plugin_count');
            expect(mine?.count).toBe(2);
        });

        it('drops a plugin entirely once every item is resolved', async () => {
            await recordFailure(sql, 'test_plugin_count', 'item-a', 'boom', null);
            await recordFailure(sql, 'test_plugin_count', 'item-a', 'boom', null);

            expect(await markFailureEventsResolved(sql, 'test_plugin_count', 'item-a')).toBe(2);

            const rows = await countUnresolvedFailuresByPlugin(sql);
            expect(rows.find((r) => r.pluginId === 'test_plugin_count')).toBeUndefined();
        });
    });

    // ========================================================================
    // Stale subjects are not counted (attention board + Failures tab agree)
    // ========================================================================

    describe('stale failure subjects are not counted as unresolved', () => {
        const PLUGIN = 'test_plugin_liveness';
        const seededItemIds: string[] = [];

        afterEach(async () => {
            await sql`DELETE FROM plugin_failure_events WHERE plugin_id = ${PLUGIN}`;
            await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ANY(${seededItemIds}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${seededItemIds}::uuid[])`;
            seededItemIds.length = 0;
        });

        async function seedItem(title: string, mediaType: string, hasFiles: boolean): Promise<string> {
            const id = randomUUID();
            seededItemIds.push(id);
            await sql`
                INSERT INTO media_items (id, title, media_type, has_files)
                VALUES (${id}::uuid, ${title}, ${mediaType}, ${hasFiles})
            `;
            return id;
        }

        async function seedFailure(itemId: string): Promise<void> {
            await sql`
                INSERT INTO plugin_failure_events (plugin_id, item_id, reason, occurred_at)
                VALUES (${PLUGIN}, ${itemId}, 'could not process', now() - interval '1 hour')
            `;
        }

        /**
         * Four uuid subjects in each stale/live state, plus one non-uuid key:
         *  1. the file uuid was deleted (matches no media_items / media_files row)
         *  2. the item has has_files = false (fileless album, can't be processed)
         *  3. the item completed its stage after the failure
         *  4. the item is live (has_files, nothing completed) -- still counts
         *  5. a non-uuid key (another plugin's id scheme) -- still counts
         * Returns the live item id.
         */
        async function seedScenario(): Promise<string> {
            await seedFailure(randomUUID()); // 1: deleted subject

            const filelessId = await seedItem('Fileless album', 'album', false);
            await seedFailure(filelessId); // 2

            const doneId = await seedItem('Completed track', 'track', true);
            await seedFailure(doneId); // 3
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, processing_version, status, completed_at)
                VALUES (${doneId}::uuid, ${PLUGIN}, 1, 'completed', now())
            `;

            const liveId = await seedItem('Live track', 'track', true);
            await seedFailure(liveId); // 4: still live

            await seedFailure('legacy-key-7'); // 5: non-uuid key
            return liveId;
        }

        it('counts only subjects that still need attention', async () => {
            await seedScenario();

            const rows = await countUnresolvedFailuresByPlugin(sql);
            expect(rows.find((r) => r.pluginId === PLUGIN)?.count).toBe(2);
        });

        it('the Failures list shows the same items the count reports', async () => {
            const liveId = await seedScenario();

            const result = await buildTaskFailuresList(
                sql,
                PLUGIN,
                { limit: 50, cursorId: null },
                unrestrictedAccess(),
            );
            expect(result.total).toBe(2);
            expect(result.failures.map((f) => f.itemId).sort()).toEqual(
                [liveId, 'legacy-key-7'].sort(),
            );
        });
    });
});
