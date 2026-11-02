// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * F41 regression — `recordEventFailure` failure must not trap the dispatcher
 * in a hot-retry loop.
 *
 * Scenario: a side effect poisons the per-row transaction (a bad SQL statement
 * aborts it) BEFORE the consume decision. `handleRow`'s own catch then runs
 * `recordEventFailure` inside that already-aborted transaction, so the UPDATE
 * fails and the whole `withTx` rolls back. Pre-fix, the outbox row was left
 * untouched — `attempts` still 0, `next_retry_at` still NULL — so the next tick
 * re-locked the same poison row immediately and spun 100% on it.
 *
 * Post-fix, `processOneRow` records the failure OUT OF BAND in a fresh
 * transaction, so the row gets `attempts = 1` and a future `next_retry_at`
 * (backoff), and a fresh drainable row is processed instead of re-locking the
 * poison one.
 *
 * Runs against the real `lumastra_tests` Postgres.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    PipelineEventDispatcher,
    _clearPipelineEventHandlersForTesting,
    type DispatcherOpts,
} from './pipeline-event-dispatcher.service.js';
import type { StageStateService } from './stage-state.service.js';

const POISON_ITEM = '00000000-0000-4000-c000-0000000000f1';

/**
 * Every dispatcher a test builds, stopped after that test. A tick that ends on
 * its wall-clock budget re-arms itself `notifyDebounceMs` later — with
 * `drainBudgetMs: 0` that is after EVERY row — and `closeTestDb()` is a no-op,
 * so an un-stopped dispatcher keeps ticking on the live pool into the next
 * test. The F41 poison dispatcher did exactly that: it locked and poisoned a
 * row or two of the F40 backlog mid-drain, so the F40 tick's `drained` came up
 * short (CI 2026-09-27: 248/249 of 250). All ticks are awaited in the tests,
 * so by afterEach only a pending re-arm timer is left, and `stop()` clears it.
 */
const dispatchers: PipelineEventDispatcher[] = [];
function makeDispatcher(opts: DispatcherOpts): PipelineEventDispatcher {
    const dispatcher = new PipelineEventDispatcher(opts);
    dispatchers.push(dispatcher);
    return dispatcher;
}
afterEach(() => {
    for (const dispatcher of dispatchers.splice(0)) dispatcher.stop();
});

/**
 * Minimal StageStateService stand-in. `invalidateByEvent` runs an intentionally
 * invalid statement on the per-row tx handle, aborting that transaction. Once
 * aborted, every subsequent statement on the same tx (including the
 * `recordEventFailure` UPDATE that `handleRow`'s catch issues) fails — which is
 * exactly the F41 trap we are reproducing.
 */
function makePoisonStageState(): StageStateService {
    return {
        async invalidateByEvent(
            _mediaId: string,
            _event: string,
            sql: postgres.Sql,
        ): Promise<void> {
            // Abort the transaction with a deliberate error.
            await sql`SELECT cast('not-a-number' as integer)`;
        },
        async seedRowsForCreate(_mediaId: string, sql: postgres.Sql): Promise<void> {
            await sql`SELECT cast('not-a-number' as integer)`;
        },
    } as unknown as StageStateService;
}

/**
 * No-op stage state: every event consumes cleanly with zero downstream work,
 * isolating the drain-loop throughput from handler cost (F40 re-confirmation).
 */
function makeNoopStageState(): StageStateService {
    return {
        async invalidateByEvent(): Promise<void> {},
        async seedRowsForCreate(): Promise<void> {},
    } as unknown as StageStateService;
}

describe('PipelineEventDispatcher F41 — recordEventFailure tx-failure backoff', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        _clearPipelineEventHandlersForTesting();
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${POISON_ITEM}::uuid`;
        // The dispatcher drains EVERY drainable row, not just ours, and the
        // shared `lumastra_tests` outbox can hold rows left by other suites or
        // emitted by DB triggers. Park any currently-drainable row far in the
        // future so our single poison row is the only one this tick can lock —
        // keeping the assertions deterministic. We never touch consumed_at, so
        // this is non-destructive to those rows' eventual processing.
        await sql`
            UPDATE event_outbox
               SET next_retry_at = now() + interval '1 hour'
             WHERE consumed_at IS NULL
               AND NOT dead_letter
               AND (next_retry_at IS NULL OR next_retry_at <= now())
               AND media_item_id <> ${POISON_ITEM}::uuid
        `;
    });

    it('records backoff out-of-band when the per-row tx (and its recordEventFailure) fails', async () => {
        // A single poison event whose handling will abort the per-row tx.
        await sql`
            INSERT INTO event_outbox (event_name, media_item_id, payload)
            VALUES ('metadata.changed', ${POISON_ITEM}::uuid, ${sql.json({ event: 'metadata.changed' })})
        `;

        const dispatcher = makeDispatcher({
            sql,
            isLeader: () => true,
            drainBudgetMs: 0, // one row per tick is enough
            stageState: makePoisonStageState(),
        });

        const result = await dispatcher.tick();

        // The poison row was counted as a retry (not silently dropped, not a
        // throw that aborts the whole pass).
        expect(result.deadLettered).toBe(0);

        // The row is now backed off: attempts incremented and next_retry_at set
        // in the future — NOT left at attempts=0 / next_retry_at=NULL (the
        // pre-fix hot-retry trap).
        const [row] = await sql<
            {
                attempts: number;
                next_retry_at: Date | null;
                consumed_at: Date | null;
            }[]
        >`
            SELECT attempts, next_retry_at, consumed_at
              FROM event_outbox
             WHERE media_item_id = ${POISON_ITEM}::uuid
        `;
        expect(row.consumed_at).toBeNull();
        expect(row.attempts).toBe(1);
        expect(row.next_retry_at).not.toBeNull();
        expect((row.next_retry_at as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('does not re-lock the same poison row on the immediately following tick', async () => {
        await sql`
            INSERT INTO event_outbox (event_name, media_item_id, payload)
            VALUES ('metadata.changed', ${POISON_ITEM}::uuid, ${sql.json({ event: 'metadata.changed' })})
        `;

        const dispatcher = makeDispatcher({
            sql,
            isLeader: () => true,
            drainBudgetMs: 1_000,
            stageState: makePoisonStageState(),
        });

        // First tick backs the row off into the future. A second tick run right
        // away must find it NOT drainable (next_retry_at > now), so it drains
        // nothing rather than hot-looping on the same row.
        await dispatcher.tick();
        const second = await dispatcher.tick();
        expect(second.drained).toBe(0);
        expect(second.deadLettered).toBe(0);

        const [row] = await sql<{ attempts: number }[]>`
            SELECT attempts FROM event_outbox WHERE media_item_id = ${POISON_ITEM}::uuid
        `;
        // Still attempts=1 — the second tick did NOT re-process it.
        expect(row.attempts).toBe(1);
    });
});

/**
 * F40 re-confirmation — `2c8607c38` replaced the old `batchSize`-per-interval
 * cap (which throttled throughput to ~`DEFAULT_BATCH_SIZE` rows per 30 s tick,
 * ~3.3 rows/s) with a continuous drain-to-budget loop. This locks in that a
 * single `tick()` drains an entire backlog larger than the legacy batch cap in
 * one pass, so it cannot silently regress back to a per-tick row ceiling.
 */
describe('PipelineEventDispatcher F40 — continuous drain-to-budget throughput', () => {
    let sql: postgres.Sql;
    // Larger than the legacy DEFAULT_BATCH_SIZE (100) so a per-tick batch cap
    // would leave rows behind; the budget loop drains them all.
    const BACKLOG_ITEM = '00000000-0000-4000-c000-0000000000f7';
    const BACKLOG = 250;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        _clearPipelineEventHandlersForTesting();
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${BACKLOG_ITEM}::uuid`;
        // Park ALL pending non-BACKLOG rows — including those with a future
        // next_retry_at — so a short backoff set by the F41 poison-row tests
        // (2 s for attempts=0→1) cannot expire mid-tick and sneak in as an
        // extra row while the 250-row drain is in progress.
        await sql`
            UPDATE event_outbox
               SET next_retry_at = now() + interval '1 hour'
             WHERE consumed_at IS NULL
               AND NOT dead_letter
               AND media_item_id <> ${BACKLOG_ITEM}::uuid
        `;
    });

    it('drains a backlog larger than the legacy batch cap in a single tick', async () => {
        const values = Array.from(
            { length: BACKLOG },
            () => sql`('metadata.changed', ${BACKLOG_ITEM}::uuid, ${sql.json({})})`,
        );
        await sql`
            INSERT INTO event_outbox (event_name, media_item_id, payload)
            VALUES ${values.reduce((acc, v, i) => (i === 0 ? v : sql`${acc}, ${v}`))}
        `;

        const dispatcher = makeDispatcher({
            sql,
            isLeader: () => true,
            drainBudgetMs: 30_000, // generous — the backlog should empty well before this
            stageState: makeNoopStageState(),
        });

        const result = await dispatcher.tick();

        // All BACKLOG rows consumed in ONE tick — proving no per-tick batch cap.
        expect(result.drained).toBe(BACKLOG);
        expect(result.deadLettered).toBe(0);

        const [{ remaining }] = await sql<{ remaining: number }[]>`
            SELECT COUNT(*)::int AS remaining
              FROM event_outbox
             WHERE media_item_id = ${BACKLOG_ITEM}::uuid
               AND consumed_at IS NULL
        `;
        expect(remaining).toBe(0);
    });
});
