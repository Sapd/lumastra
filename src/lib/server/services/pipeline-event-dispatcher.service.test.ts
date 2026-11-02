// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for PipelineEventDispatcher drain semantics:
 *   - drains the outbox to empty within budget,
 *   - stops at the wall-clock budget (drain-to-budget, not fixed batchSize)
 *     and re-arms,
 *   - is leader-gated and reentrancy-guarded,
 *   - wires LISTEN and drains on NOTIFY.
 *
 * The query layer + observability are mocked; StageStateService is injected
 * via the `stageState` test seam so no DB/registry is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Sql } from 'postgres';

const lockDrainableEvents = vi.fn();
const markEventConsumed = vi.fn(async (..._a: unknown[]) => {});
const recordEventFailure = vi.fn(async (..._a: unknown[]) => ({
    deadLettered: false,
    nextAttempts: 1,
}));
const findAutoRequeuableDeadLetters = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const requeueDeadLetterEventsAuto = vi.fn(async (..._a: unknown[]) => 0);

vi.mock('$lib/server/database/queries/event-outbox.queries.js', () => ({
    lockDrainableEvents: (...a: unknown[]) => lockDrainableEvents(...a),
    markEventConsumed: (...a: unknown[]) => markEventConsumed(...a),
    recordEventFailure: (...a: unknown[]) => recordEventFailure(...a),
    findAutoRequeuableDeadLetters: (...a: unknown[]) => findAutoRequeuableDeadLetters(...a),
    requeueDeadLetterEventsAuto: (...a: unknown[]) => requeueDeadLetterEventsAuto(...a),
}));
vi.mock('$lib/server/tasks/observability/heartbeat.js', () => ({
    writeHeartbeat: vi.fn(async () => {}),
    beatAlive: vi.fn(async () => {}),
}));
vi.mock('$lib/server/tasks/observability/audit-log.js', () => ({
    appendAuditEvent: vi.fn(async () => {}),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({ registry: {} }));

import { PipelineEventDispatcher } from './pipeline-event-dispatcher.service.js';

interface FakeRow {
    id: number;
    media_item_id: string;
    event_name: string;
    payload: Record<string, unknown>;
    attempts: number;
}

function makeRows(n: number): FakeRow[] {
    return Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        media_item_id: `m${i + 1}`,
        event_name: 'metadata.changed',
        payload: {},
        attempts: 0,
    }));
}

/** sql.begin(fn) runs fn with the same fake handle; lockDrainableEvents is mocked so the handle is opaque. */
function makeFakeSql(listenCb?: { current: (() => void) | null }) {
    const sql = {
        begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
        listen: vi.fn(async (_channel: string, cb: () => void) => {
            if (listenCb) listenCb.current = cb;
            return { unlisten: async () => {} };
        }),
    };
    return sql as unknown as Sql & { listen: ReturnType<typeof vi.fn> };
}

const invalidateByEvent = vi.fn(async () => {});
const stageStateStub = { invalidateByEvent } as never;

beforeEach(() => {
    vi.clearAllMocks();
    recordEventFailure.mockResolvedValue({
        deadLettered: false,
        nextAttempts: 1,
    });
    // Default: no dead-letters to auto-requeue, so existing drain tests are unaffected.
    findAutoRequeuableDeadLetters.mockResolvedValue([]);
    requeueDeadLetterEventsAuto.mockResolvedValue(0);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('PipelineEventDispatcher.tick — drain-to-budget', () => {
    it('passes the outbox identity so invalidation can coalesce events older than a run', async () => {
        const queue = makeRows(1);
        const row = queue[0];
        const sql = makeFakeSql();
        lockDrainableEvents.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        const dispatcher = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            stageState: stageStateStub,
        });
        await dispatcher.tick();
        expect(invalidateByEvent).toHaveBeenCalledWith(
            row.media_item_id,
            row.event_name,
            sql,
            expect.objectContaining({ push: expect.any(Function) }),
            row.id,
        );
    });

    it('drains the whole outbox in one tick when within budget', async () => {
        const queue = makeRows(250); // far more than the legacy batchSize=100
        lockDrainableEvents.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000, // effectively unlimited for the test
        });
        const res = await d.tick();
        expect(res.drained).toBe(250); // NOT capped at batchSize
        expect(queue.length).toBe(0);
    });

    it('stops at the wall-clock budget instead of draining everything', async () => {
        const queue = makeRows(50);
        lockDrainableEvents.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 0, // budget elapses immediately → exactly one row per tick
        });
        const res = await d.tick();
        expect(res.drained).toBe(1);
        expect(queue.length).toBe(49); // remainder left for the re-armed tick / interval
        d.stop(); // cancel the re-arm timer scheduled by the budget-bounded tick
    });

    it('re-arms after a budget-bounded tick to drain the remaining backlog', async () => {
        vi.useFakeTimers();
        const queue = makeRows(3);
        lockDrainableEvents.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 0, // one row per tick → forces a re-arm after each
            notifyDebounceMs: 250,
        });
        // Direct (never-started) tick: still re-arms so the backlog continues.
        const res = await d.tick();
        expect(res.drained).toBe(1);
        expect(queue.length).toBe(2);
        await vi.advanceTimersByTimeAsync(250); // re-armed tick drains row 2
        expect(queue.length).toBe(1);
        await vi.advanceTimersByTimeAsync(250); // re-armed tick drains row 3
        expect(queue.length).toBe(0);
        await vi.advanceTimersByTimeAsync(250); // empty drain → no further re-arm
        expect(queue.length).toBe(0);
        d.stop();
    });

    it('no-ops when not the leader', async () => {
        lockDrainableEvents.mockResolvedValue(makeRows(5));
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => false,
            stageState: stageStateStub,
        });
        const res = await d.tick();
        expect(res).toEqual({ drained: 0, deadLettered: 0 });
        expect(lockDrainableEvents).not.toHaveBeenCalled();
    });

    it('counts dead-lettered rows separately', async () => {
        const queue = makeRows(1);
        lockDrainableEvents.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        // handler path: invalidateByEvent throws → recordEventFailure → dead-letter
        const throwingStage = {
            invalidateByEvent: vi.fn(async () => {
                throw new Error('boom');
            }),
        } as never;
        recordEventFailure.mockResolvedValue({
            deadLettered: true,
            nextAttempts: 8,
        });
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: throwingStage,
            drainBudgetMs: 60_000,
        });
        const res = await d.tick();
        expect(res.deadLettered).toBe(1);
        expect(res.drained).toBe(0);
    });
});

describe('PipelineEventDispatcher — LISTEN wiring', () => {
    it('subscribes to event_outbox_new on start and drains on NOTIFY', async () => {
        vi.useFakeTimers();
        const listenCb: { current: (() => void) | null } = { current: null };
        const sql = makeFakeSql(listenCb);
        const queue = makeRows(3);
        lockDrainableEvents.mockImplementation(async () => (queue.length ? [queue.shift()] : []));
        const d = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000,
            notifyDebounceMs: 250,
        });
        d.start();
        // start() registers the listener (async) and fires an initial tick.
        await vi.runOnlyPendingTimersAsync();
        expect(sql.listen).toHaveBeenCalledWith('event_outbox_new', expect.any(Function));
        d.stop();
    });
});

describe('PipelineEventDispatcher — transient dead-letter auto-requeue', () => {
    const TRANSIENT = 'write CONNECT_TIMEOUT ai-postgres:5432';
    const PERMANENT = 'duplicate key value violates unique constraint';

    it('requeues only the transient dead-letters, not the permanent ones', async () => {
        lockDrainableEvents.mockResolvedValue([]); // nothing to drain; isolate the requeue pass
        findAutoRequeuableDeadLetters.mockResolvedValue([
            { id: '1', last_error: TRANSIENT, auto_requeue_count: 0 },
            { id: '2', last_error: PERMANENT, auto_requeue_count: 0 },
            { id: '3', last_error: TRANSIENT, auto_requeue_count: 2 },
            { id: '4', last_error: null, auto_requeue_count: 0 },
        ]);
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000,
        });
        await d.tick();
        expect(requeueDeadLetterEventsAuto).toHaveBeenCalledTimes(1);
        // Only the transient-error rows (ids 1 and 3); permanent (2) and null (4) excluded.
        expect(requeueDeadLetterEventsAuto).toHaveBeenCalledWith(expect.anything(), ['1', '3']);
    });

    it('does not requeue when no candidate has a transient error', async () => {
        lockDrainableEvents.mockResolvedValue([]);
        findAutoRequeuableDeadLetters.mockResolvedValue([
            { id: '9', last_error: PERMANENT, auto_requeue_count: 0 },
        ]);
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000,
        });
        await d.tick();
        expect(requeueDeadLetterEventsAuto).not.toHaveBeenCalled();
    });

    it('throttles: a second tick within the interval does not re-scan', async () => {
        lockDrainableEvents.mockResolvedValue([]);
        findAutoRequeuableDeadLetters.mockResolvedValue([]);
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000,
            autoRequeueIntervalMs: 5 * 60_000,
        });
        await d.tick();
        await d.tick();
        expect(findAutoRequeuableDeadLetters).toHaveBeenCalledTimes(1);
    });

    it('is disabled when maxAutoRequeue is 0', async () => {
        lockDrainableEvents.mockResolvedValue([]);
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000,
            maxAutoRequeue: 0,
        });
        await d.tick();
        expect(findAutoRequeuableDeadLetters).not.toHaveBeenCalled();
    });

    it('passes maxAutoRequeue through to the candidate query as the budget bound', async () => {
        lockDrainableEvents.mockResolvedValue([]);
        findAutoRequeuableDeadLetters.mockResolvedValue([]);
        const d = new PipelineEventDispatcher({
            sql: makeFakeSql(),
            isLeader: () => true,
            stageState: stageStateStub,
            drainBudgetMs: 60_000,
            maxAutoRequeue: 3,
        });
        await d.tick();
        expect(findAutoRequeuableDeadLetters).toHaveBeenCalledWith(expect.anything(), 3);
    });
});

describe('PipelineEventDispatcher — LISTEN wiring (cont.)', () => {
    it('unlistens the subscription when stop() races the LISTEN resolving', async () => {
        // listen() resolves on demand so we can call stop() while it is pending.
        const unlisten = vi.fn(async () => {});
        let resolveListen: (sub: { unlisten: () => Promise<void> }) => void = () => {};
        const listenPromise = new Promise<{ unlisten: () => Promise<void> }>((res) => {
            resolveListen = res;
        });
        const sql = {
            begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql),
            listen: vi.fn(() => listenPromise),
        } as unknown as Sql & { listen: ReturnType<typeof vi.fn> };
        lockDrainableEvents.mockResolvedValue([]);
        const d = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            stageState: stageStateStub,
        });
        d.start();
        d.stop(); // stop() before the LISTEN promise resolves
        resolveListen({ unlisten });
        await listenPromise;
        await Promise.resolve(); // let the .then chain settle
        expect(unlisten).toHaveBeenCalledTimes(1); // no leaked subscription
    });
});
