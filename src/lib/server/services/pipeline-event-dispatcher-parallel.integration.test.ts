// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Parallel sharded drain — the dispatcher runs `drainConcurrency` workers, each
 * pinned to one `hashtext(media_item_id)` shard. Two properties must hold:
 *
 *   1. Completeness — every drainable row is consumed exactly once even though
 *      the shards partition the outbox (no row is stranded outside all shards,
 *      none double-processed).
 *   2. Per-item ordering — all events for a single item are handled by ONE
 *      worker in `id` order, so `item.created` is always processed before a
 *      later `item.deleted` for the same item. If that inverted, a consumer
 *      would seed coverage for an already-deleted item.
 *
 * Runs against the real `lumastra_tests` Postgres (the shard predicate is SQL —
 * `hashtext()` — so it can only be exercised against a real backend).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    PipelineEventDispatcher,
    _clearPipelineEventHandlersForTesting,
} from './pipeline-event-dispatcher.service.js';
import type { StageStateService } from './stage-state.service.js';

// Deterministic v4-shaped uuids for the test items (version nibble 4, variant 8).
function itemId(n: number): string {
    const h = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
}

const ITEM_COUNT = 24;
const TEST_ITEMS = Array.from({ length: ITEM_COUNT }, (_, i) => itemId(i + 1));
const ORDER_ITEM = itemId(9999);
const ALL_TEST_ITEMS = [...TEST_ITEMS, ORDER_ITEM];

/** Records the ordered sequence of handler calls, tagged by kind + item. */
function makeRecordingStageState(log: Array<{ item: string; kind: string }>): StageStateService {
    return {
        async seedRowsForCreate(item: string): Promise<void> {
            log.push({ item, kind: 'seed' });
        },
        async deleteRowsForItem(item: string): Promise<void> {
            log.push({ item, kind: 'delete' });
        },
        async invalidateByEvent(item: string): Promise<void> {
            log.push({ item, kind: 'invalidate' });
        },
    } as unknown as StageStateService;
}

describe('PipelineEventDispatcher — parallel sharded drain', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        _clearPipelineEventHandlersForTesting();
        await sql`DELETE FROM event_outbox WHERE media_item_id = ANY(${ALL_TEST_ITEMS}::uuid[])`;
        // Park any other drainable row so only our fixtures are visible this tick
        // (the shared test outbox may hold rows from other suites / triggers).
        await sql`
            UPDATE event_outbox
               SET next_retry_at = now() + interval '1 hour'
             WHERE consumed_at IS NULL
               AND NOT dead_letter
               AND (next_retry_at IS NULL OR next_retry_at <= now())
               AND media_item_id <> ALL(${ALL_TEST_ITEMS}::uuid[])
        `;
    });

    it('drains a multi-item backlog to completion with concurrency > 1', async () => {
        // 4 events per item across 24 items = 96 rows spread over all shards.
        for (const item of TEST_ITEMS) {
            await sql`
                INSERT INTO event_outbox (event_name, media_item_id, payload)
                VALUES
                  ('item.created',     ${item}::uuid, ${sql.json({})}),
                  ('metadata.changed', ${item}::uuid, ${sql.json({})}),
                  ('file.probed',      ${item}::uuid, ${sql.json({})}),
                  ('metadata.changed', ${item}::uuid, ${sql.json({})})
            `;
        }

        const log: Array<{ item: string; kind: string }> = [];
        const dispatcher = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            drainConcurrency: 4,
            drainBudgetMs: 30_000, // generous — the backlog should empty well before this
            stageState: makeRecordingStageState(log),
        });

        const result = await dispatcher.tick();

        expect(result.deadLettered).toBe(0);
        expect(result.drained).toBe(ITEM_COUNT * 4);

        // Every fixture row consumed exactly once.
        const [{ pending }] = await sql<{ pending: number }[]>`
            SELECT count(*)::int AS pending
              FROM event_outbox
             WHERE media_item_id = ANY(${TEST_ITEMS}::uuid[]) AND consumed_at IS NULL
        `;
        expect(pending).toBe(0);
        expect(log.length).toBe(ITEM_COUNT * 4);
    });

    it('keeps per-item order (created before deleted) under parallel workers', async () => {
        // One item with a strict created→deleted sequence (created gets the lower
        // id). Surround it with a large multi-item backlog so all 4 shards are
        // busy and the two ordered rows are not trivially alone.
        for (const item of TEST_ITEMS) {
            await sql`
                INSERT INTO event_outbox (event_name, media_item_id, payload)
                VALUES ('metadata.changed', ${item}::uuid, ${sql.json({})}),
                       ('metadata.changed', ${item}::uuid, ${sql.json({})})
            `;
        }
        await sql`
            INSERT INTO event_outbox (event_name, media_item_id, payload)
            VALUES ('item.created', ${ORDER_ITEM}::uuid, ${sql.json({})})
        `;
        await sql`
            INSERT INTO event_outbox (event_name, media_item_id, payload)
            VALUES ('item.deleted', ${ORDER_ITEM}::uuid, ${sql.json({})})
        `;

        const log: Array<{ item: string; kind: string }> = [];
        const dispatcher = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            drainConcurrency: 4,
            drainBudgetMs: 30_000,
            stageState: makeRecordingStageState(log),
        });

        await dispatcher.tick();

        const orderItemLog = log.filter((e) => e.item === ORDER_ITEM).map((e) => e.kind);
        // seed (created) MUST precede delete (deleted) — the correctness-critical
        // invariant a naive parallel drain would break.
        expect(orderItemLog).toEqual(['seed', 'delete']);

        const [{ pending }] = await sql<{ pending: number }[]>`
            SELECT count(*)::int AS pending
              FROM event_outbox
             WHERE media_item_id = ANY(${ALL_TEST_ITEMS}::uuid[]) AND consumed_at IS NULL
        `;
        expect(pending).toBe(0);
    });
});
