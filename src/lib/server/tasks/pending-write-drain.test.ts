// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for pending-write-drain.ts.
 * Valkey and Postgres are fully mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type postgres from 'postgres';
import type { ValkeyLike } from './valkey-types.js';
import { PendingWriteDrain, isTransientPgError, type PendingWrite } from './pending-write-drain.js';
import { taskPendingWriteDroppedTotal } from './metrics.js';
import { invokeFencedValkey } from './lua/fenced.js';
import {
    TerminalAttemptJobMissingError,
    TerminalAttemptUnknownError,
    terminalQueueAttemptCurrent,
    type TerminalQueueAttempt,
} from './terminal-attempt.js';
import { AuthorityError } from '../../../task-runtime/authority/store.js';
const enqueueLogError = vi.hoisted(() => vi.fn());
/** True while the (mocked) authority transaction callback runs. */
const writeTransaction = vi.hoisted(() => ({ open: false }));

// These tests exercise list durability/retry behavior. Real transaction and
// authority enforcement are covered in existing-write.integration.test.ts.
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async (
        sql: postgres.Sql,
        _authority: unknown,
        mutate: (tx: postgres.Sql) => Promise<unknown>,
    ): Promise<unknown> => {
        writeTransaction.open = true;
        try {
            return await mutate(sql);
        } finally {
            writeTransaction.open = false;
        }
    },
}));

// Queue-attempt lookups are real BullMQ reads in terminal-attempt.integration.
vi.mock('./terminal-attempt.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./terminal-attempt.js')>();
    return { ...actual, terminalQueueAttemptCurrent: vi.fn() };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: enqueueLogError,
            debug: vi.fn(),
        }),
    },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

interface FakeClient {
    /** Backwards-compatible alias for the main pending-writes list. */
    list: string[];
    lists: Map<string, string[]>;
    customCommand: Mock<(command: string[]) => Promise<unknown>>;
    /** Per-key TTLs recorded by PEXPIRE/EXPIRE (ms). */
    ttls: Map<string, number>;
    /**
     * Override for the leader-gate SET. `'OK'` (default) wins the lock,
     * `null`/anything-else loses it, `'throw'` makes SET throw.
     */
    setBehavior: 'OK' | 'lost' | 'throw';
}

const MAIN_LIST_KEY = 'task:pending-writes';
const PROCESSING_KEY = 'task:pending-writes:processing';
const POISON_KEY = 'task:pending-writes:poison';

function makeClient(): FakeClient {
    const lists = new Map<string, string[]>();
    const ttls = new Map<string, number>();
    const getList = (key: string): string[] => {
        let l = lists.get(key);
        if (!l) {
            l = [];
            lists.set(key, l);
        }
        return l;
    };
    // Initialize main list eagerly so the `.list` alias is stable.
    const mainList = getList(MAIN_LIST_KEY);
    const client: FakeClient = {
        list: mainList,
        lists,
        ttls,
        setBehavior: 'OK',
        customCommand: vi.fn(async (cmd: string[]): Promise<unknown> => {
            const [op, key] = cmd;
            switch (op) {
                case 'LLEN':
                    return getList(key).length;
                case 'LPUSH': {
                    const l = getList(key);
                    l.unshift(cmd[2]);
                    return l.length;
                }
                case 'RPUSH': {
                    const l = getList(key);
                    l.push(cmd[2]);
                    return l.length;
                }
                case 'RPOP': {
                    const l = getList(key);
                    if (l.length === 0) return null;
                    return l.pop()!;
                }
                case 'LMOVE': {
                    // LMOVE source destination LEFT|RIGHT LEFT|RIGHT
                    const [, source, destination, fromSide, toSide] = cmd;
                    const src = getList(source);
                    if (src.length === 0) return null;
                    const value = fromSide === 'LEFT' ? src.shift()! : src.pop()!;
                    const dst = getList(destination);
                    if (toSide === 'LEFT') dst.unshift(value);
                    else dst.push(value);
                    return value;
                }
                case 'LREM': {
                    // LREM key count value — count=positive searches head→tail,
                    // removing up to `count` matching occurrences. Tests only
                    // ever use count=1.
                    const l = getList(key);
                    const count = parseInt(cmd[2], 10) || 1;
                    const value = cmd[3];
                    let removed = 0;
                    for (let i = 0; i < l.length && removed < count; i++) {
                        if (l[i] === value) {
                            l.splice(i, 1);
                            removed++;
                            i--;
                        }
                    }
                    return removed;
                }
                case 'LTRIM': {
                    // LTRIM key start stop — keep the inclusive [start, stop]
                    // range. Tests only use start=0, so trim from the right.
                    const l = getList(key);
                    const start = parseInt(cmd[2], 10);
                    const stop = parseInt(cmd[3], 10);
                    const trimmed = l.slice(start, stop + 1);
                    l.length = 0;
                    l.push(...trimmed);
                    return 'OK';
                }
                case 'PEXPIRE':
                case 'EXPIRE': {
                    ttls.set(key, parseInt(cmd[2], 10));
                    return 1;
                }
                case 'SET':
                    // Used by tickIfLeader's leader-gate SETNX. Default single
                    // replica always wins so the drain path runs
                    // deterministically; overridable via `setBehavior`.
                    if (client.setBehavior === 'throw') {
                        throw new Error('valkey unreachable');
                    }
                    return client.setBehavior === 'OK' ? 'OK' : null;
                default:
                    return null;
            }
        }),
    };
    return client;
}

function makeSql(shouldFail = false): postgres.Sql {
    const fn = vi.fn(async () => {
        if (shouldFail) throw new Error('pg connect refused');
        return [];
    }) as unknown as postgres.Sql;
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    (fn as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
    return fn;
}

/**
 * SQL stub that throws a TRANSIENT Postgres error (SQLSTATE 08006 —
 * connection_failure). `isTransientPgError` classifies this as transient, so
 * the drain re-enqueues WITHOUT bumping attempts.
 */
function makeTransientSql(): postgres.Sql {
    const fn = vi.fn(async () => {
        throw Object.assign(new Error('connection_failure'), { code: '08006' });
    }) as unknown as postgres.Sql;
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    (fn as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
    return fn;
}

/**
 * Build a drain backed by an explicit SQL stub (used for transient-vs-permanent
 * failure tests where `sqlFail` boolean isn't expressive enough).
 */
function makeDrainWithSql(client: FakeClient, sql: postgres.Sql) {
    const drain = new PendingWriteDrain(
        sql,
        async () =>
            client as unknown as {
                customCommand: (cmd: string[]) => Promise<unknown>;
            },
    );
    return { drain, client, sql };
}

function makeWrite(overrides: Partial<PendingWrite> = {}): PendingWrite {
    return {
        kind: 'update',
        runId: 'run_test',
        payload: { state: 'failed', completedAt: new Date().toISOString() },
        enqueuedAt: Date.now(),
        ...overrides,
    };
}

function makeDrain(clientOverride?: FakeClient, sqlFail = false) {
    const client = clientOverride ?? makeClient();
    const sql = makeSql(sqlFail);
    const drain = new PendingWriteDrain(
        sql,
        async () =>
            client as unknown as {
                customCommand: (cmd: string[]) => Promise<unknown>;
            },
    );
    return { drain, client, sql };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PendingWriteDrain', () => {
    describe('enqueue', () => {
        it.each(['circular', 'bigint'] as const)(
            'catches and logs a %s payload serialization failure',
            async (kind) => {
                enqueueLogError.mockClear();
                const { drain, client } = makeDrain();
                const payload: Record<string, unknown> = {};
                payload.result = kind === 'circular' ? payload : 1n;
                await expect(drain.enqueue(makeWrite({ payload }))).resolves.toBeUndefined();
                expect(client.customCommand).not.toHaveBeenCalled();
                expect(enqueueLogError).toHaveBeenCalledWith(
                    'PendingWriteDrain.enqueue failed',
                    expect.any(Error),
                    { runId: 'run_test' },
                );
            },
        );

        it.each(['circular', 'bigint'] as const)(
            'strict enqueue rejects %s serialization without claiming durability',
            async (kind) => {
                const { drain, client } = makeDrain();
                const payload: Record<string, unknown> = {};
                payload.value = kind === 'circular' ? payload : 1n;
                await expect(
                    drain.enqueue(makeWrite({ payload }), { strict: true }),
                ).rejects.toThrow('UNKNOWN');
                expect(client.customCommand).not.toHaveBeenCalled();
            },
        );

        it('strict enqueue waits for acknowledgement and exposes a lost acknowledgement', async () => {
            const client = makeClient();
            let finish!: () => void;
            const held = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const command = client.customCommand.getMockImplementation()!;
            client.customCommand.mockImplementation(async (args) => {
                const result = await command(args);
                if (args[0] === 'LPUSH') {
                    await held;
                    throw new Error('write applied but acknowledgement lost');
                }
                return result;
            });
            const { drain } = makeDrain(client);
            const enqueue = drain.enqueue(makeWrite(), { strict: true });
            const rejected = expect(enqueue).rejects.toThrow('UNKNOWN');
            await vi.waitFor(() => {
                expect(client.list).toHaveLength(1);
            });
            finish();
            await rejected;
            expect(client.list).toHaveLength(1);
        });

        it('captures the original token before waiting for the Valkey client', async () => {
            const client = makeClient();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const drain = new PendingWriteDrain(makeSql(), async () => {
                await gate;
                return {
                    customCommand: async (command: string[]): Promise<unknown> =>
                        client.customCommand(command),
                };
            });
            const authority = {
                partition: 'tasks',
                generation: '1',
                ownerId: '5233022b-dd9b-44d6-82fd-1f622bcbfda5',
            };
            const queued = drain.enqueue(makeWrite({ authority }));
            authority.generation = '2';
            release();
            await queued;
            expect((JSON.parse(client.list[0]) as PendingWrite).authority?.generation).toBe('1');
        });

        it('writes JSON entry to list head', async () => {
            const { drain, client } = makeDrain();
            const write = makeWrite({ runId: 'run_abc' });
            await drain.enqueue(write);
            expect(client.list).toHaveLength(1);
            const stored = JSON.parse(client.list[0]) as PendingWrite;
            expect(stored.runId).toBe('run_abc');
        });

        it('at capacity drops oldest (tail) before push', async () => {
            const { drain, client } = makeDrain();
            // Pre-fill list to cap.
            for (let i = 0; i < 10_000; i++) {
                client.list.push(
                    `{"runId":"old_${i}","kind":"update","payload":{},"enqueuedAt":0}`,
                );
            }
            expect(client.list).toHaveLength(10_000);

            const write = makeWrite({ runId: 'run_newest' });
            await drain.enqueue(write);

            // Should have popped one (oldest tail) and pushed new head → still 10_000.
            expect(client.list).toHaveLength(10_000);
            // Newest is at head.
            const head = JSON.parse(client.list[0]) as PendingWrite;
            expect(head.runId).toBe('run_newest');
        });

        it('enqueues multiple writes in order', async () => {
            const { drain, client } = makeDrain();
            await drain.enqueue(makeWrite({ runId: 'run_1' }));
            await drain.enqueue(makeWrite({ runId: 'run_2' }));
            await drain.enqueue(makeWrite({ runId: 'run_3' }));

            // LPUSH prepends — newest at index 0, oldest at tail.
            expect(client.list).toHaveLength(3);
            const head = JSON.parse(client.list[0]) as PendingWrite;
            expect(head.runId).toBe('run_3');
        });
    });

    describe('drain', () => {
        it('returns zero drained when list is empty', async () => {
            const { drain } = makeDrain();
            const result = await drain.drain();
            expect(result.drained).toBe(0);
            expect(result.remaining).toBe(0);
        });

        it('drains entries and writes to Postgres', async () => {
            const { drain, client, sql } = makeDrain();
            await drain.enqueue(makeWrite({ runId: 'run_a' }));
            await drain.enqueue(makeWrite({ runId: 'run_b' }));

            const result = await drain.drain();
            expect(result.drained).toBe(2);
            expect(result.remaining).toBe(0);
            expect(client.list).toHaveLength(0);
            // sql was called for each write.
            expect(sql).toHaveBeenCalledTimes(2);
        });

        it('replays cancel_requested_at when the payload carries cancelRequestedAt', async () => {
            // Regression: the orchestrator's DB-down cancel fallback enqueues
            // cancelRequestedAt; the replay must write it to cancel_requested_at
            // or the run stays invisible to the reconciler's cancel-grace sweep.
            const { drain, sql } = makeDrain();
            const ts = '2026-06-21T18:00:00.000Z';
            await drain.enqueue(
                makeWrite({
                    runId: 'run_cancel',
                    payload: { state: 'cancelling', cancelRequestedAt: ts },
                }),
            );

            await drain.drain();

            const calls = (sql as unknown as { mock: { calls: unknown[][] } }).mock.calls;
            const update = calls.find((c) =>
                Array.from(c[0] as TemplateStringsArray)
                    .join('')
                    .includes('cancel_requested_at'),
            );
            expect(update, 'replay UPDATE must set cancel_requested_at').toBeDefined();
            // The timestamp value is interpolated into the UPDATE.
            expect((update as unknown[]).slice(1)).toContain(ts);
        });

        it('re-enqueues failed write to head (LPUSH) with bumped attempts', async () => {
            const { drain, client } = makeDrain(undefined, true /* sqlFail */);
            await drain.enqueue(makeWrite({ runId: 'run_fail' }));

            const result = await drain.drain();
            expect(result.drained).toBe(0);
            // Re-appended → still 1 entry, attempts bumped to 1.
            expect(client.list).toHaveLength(1);
            const requeued = JSON.parse(client.list[0]) as PendingWrite;
            expect(requeued.attempts).toBe(1);
        });

        it('does not burn through all retries inside a single drain pass', async () => {
            // Regression: previously RPOP/RPUSH cycled the same tail in one
            // tick, exhausting all 10 attempts in <10ms. LPUSH + break keeps
            // the entry at head and aborts the pass after re-enqueue.
            const client = makeClient();
            const { drain } = makeDrain(client, true /* sqlFail */);

            // Seed two entries; both would fail to replay.
            client.list.push(JSON.stringify(makeWrite({ runId: 'run_a' })));
            client.list.push(JSON.stringify(makeWrite({ runId: 'run_b' })));

            const result = await drain.drain();
            // Exactly one entry was processed (failed and re-enqueued); the
            // other one stays untouched. attempts must be 1, not 10.
            expect(result.drained).toBe(0);
            expect(client.list).toHaveLength(2);
            const allAttempts = client.list
                .map((s) => (JSON.parse(s) as PendingWrite).attempts ?? 0)
                .sort();
            // First entry hit replay once; second entry never popped.
            expect(allAttempts).toEqual([0, 1]);

            // Verify only ONE claim (LMOVE off the main list) happened in this
            // pass — the crash-safe claim replaces the old destructive RPOP.
            const claimCount = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'LMOVE' && cmd[1] === MAIN_LIST_KEY,
            ).length;
            expect(claimCount).toBe(1);

            // And the claimed+failed entry was acked off the processing list
            // (re-enqueued to the main list, not left behind).
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
        });

        it('after re-enqueue the entry sits at head — next drain re-pops it from head', async () => {
            // Verifies that LPUSH puts the bumped entry on the same side
            // that subsequent RPOP reads from (FIFO via LPUSH/RPOP). It
            // does get re-tried on the next drain tick (no infinite delay)
            // but only after the older tail entries.
            const client = makeClient();
            const { drain } = makeDrain(client, true /* sqlFail */);

            // Only one entry — drain → LPUSH → drain again finds & re-pops it.
            client.list.push(JSON.stringify(makeWrite({ runId: 'run_solo' })));

            await drain.drain();
            expect(client.list).toHaveLength(1);
            const after1 = JSON.parse(client.list[0]) as PendingWrite;
            expect(after1.attempts).toBe(1);

            await drain.drain();
            expect(client.list).toHaveLength(1);
            const after2 = JSON.parse(client.list[0]) as PendingWrite;
            expect(after2.attempts).toBe(2);
        });

        it('moves write to poison list after max attempts', async () => {
            const client = makeClient();
            const { drain } = makeDrain(client, true /* sqlFail */);

            // Seed with a write that already has 9 attempts; the 10th
            // replay should trip the poison threshold.
            client.list.push(JSON.stringify(makeWrite({ runId: 'run_poison', attempts: 9 })));

            const result = await drain.drain();
            expect(result.drained).toBe(1); // poison counts as "removed from main list"
            // Main list is now empty (write moved to poison).
            expect(client.list).toHaveLength(0);

            // Poison list should contain exactly one entry.
            const poisonCmds = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'LPUSH' && cmd[1] === 'task:pending-writes:poison',
            );
            expect(poisonCmds).toHaveLength(1);
            const poisoned = JSON.parse(poisonCmds[0][0][2]) as PendingWrite;
            expect(poisoned.runId).toBe('run_poison');
            expect(poisoned.attempts).toBe(10);
        });

        it('handles insert kind', async () => {
            const { drain, sql } = makeDrain();
            await drain.enqueue(
                makeWrite({
                    kind: 'insert',
                    runId: 'run_insert',
                    payload: {
                        taskId: 'my-task',
                        label: 'My Task',
                        state: 'pending',
                        trigger: { kind: 'in-process' },
                        actor: { type: 'system' },
                        processingVersion: '1',
                    },
                }),
            );
            const result = await drain.drain();
            expect(result.drained).toBe(1);
            expect(sql).toHaveBeenCalledTimes(1);
        });

        it('drops malformed entry without re-enqueueing', async () => {
            const { drain, client } = makeDrain();
            // Push raw garbage that can't be parsed as PendingWrite.
            client.list.push('NOT_VALID_JSON{{{');

            const result = await drain.drain();
            expect(result.drained).toBe(1); // malformed counts as processed
            expect(client.list).toHaveLength(0);
        });
    });

    describe('start / stop', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('start schedules interval, stop clears it', async () => {
            const { drain } = makeDrain();
            const drainSpy = vi
                .spyOn(drain, 'drain')
                .mockResolvedValue({ drained: 0, remaining: 0 });

            drain.start(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(drainSpy).toHaveBeenCalledTimes(1);

            drain.stop();
            await vi.advanceTimersByTimeAsync(2_000);
            // No additional calls after stop.
            expect(drainSpy).toHaveBeenCalledTimes(1);
        });

        it('start is idempotent', () => {
            const { drain } = makeDrain();
            drain.start(5_000);
            drain.start(5_000); // second call no-ops
            drain.stop();
        });

        it('stop waits for the drain in flight and no new tick starts', async () => {
            const { drain } = makeDrain();
            let finish!: () => void;
            const running = new Promise<{ drained: number; remaining: number }>((resolve) => {
                finish = () => resolve({ drained: 0, remaining: 0 });
            });
            const drainSpy = vi.spyOn(drain, 'drain').mockReturnValue(running);

            drain.start(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(drainSpy).toHaveBeenCalledTimes(1);

            let settled: boolean | undefined;
            const stopping = drain.stop().then((value) => {
                settled = value;
            });
            await vi.advanceTimersByTimeAsync(3_000);
            expect(settled).toBeUndefined();

            finish();
            await stopping;
            expect(settled).toBe(true);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(drainSpy).toHaveBeenCalledTimes(1);
        });

        it('a slow drain does not let the next timer tick start an overlapping one', async () => {
            const { drain } = makeDrain();
            let finish!: () => void;
            const running = new Promise<{ drained: number; remaining: number }>((resolve) => {
                finish = () => resolve({ drained: 0, remaining: 0 });
            });
            const drainSpy = vi.spyOn(drain, 'drain').mockReturnValue(running);
            drain.start(1_000);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(drainSpy).toHaveBeenCalledTimes(1);
            finish();
            await drain.stop();
        });
    });

    // ── F4.1: capacity-drop routes oldest to poison, increments metric ──────────
    describe('F4.1 capacity-drop preserves dropped entry', () => {
        it('removes the OLDEST (tail) entry and routes it to the poison list', async () => {
            const { drain, client } = makeDrain();
            const incSpy = vi.spyOn(taskPendingWriteDroppedTotal, 'inc');

            // Pre-fill to cap. RPOP reads the tail, so index 0 of the array
            // (after our pushes) is the newest; the array's last element is the
            // oldest that LPUSH-then-RPOP semantics evict.
            for (let i = 0; i < 10_000; i++) {
                // Push at index 0 so the LAST pushed ends up at the tail = oldest.
                client.list.unshift(
                    JSON.stringify({
                        runId: `old_${i}`,
                        kind: 'update',
                        payload: {},
                        enqueuedAt: 0,
                    }),
                );
            }
            // Tail (oldest, evicted by RPOP) is old_0.
            const tailBefore = JSON.parse(client.list[client.list.length - 1]) as PendingWrite;
            expect(tailBefore.runId).toBe('old_0');

            await drain.enqueue(makeWrite({ runId: 'run_newest' }));

            // Length pinned at cap.
            expect(client.list).toHaveLength(10_000);
            // The dropped oldest (old_0) is no longer in the main list.
            const stillPresent = client.list.some(
                (s) => (JSON.parse(s) as PendingWrite).runId === 'old_0',
            );
            expect(stillPresent).toBe(false);
            // And it now lives on the poison list.
            const poison = client.lists.get(POISON_KEY) ?? [];
            expect(poison).toHaveLength(1);
            expect((JSON.parse(poison[0]) as PendingWrite).runId).toBe('old_0');

            // Dropped counter incremented with the dropped entry's kind.
            expect(incSpy).toHaveBeenCalledTimes(1);
            expect(incSpy).toHaveBeenCalledWith({ kind: 'update' });

            // Review R1: the enqueue capacity-drop poison push is BOUNDED, just
            // like the drain path — LTRIM + PEXPIRE issued so a sustained outage
            // at capacity can't grow the DLQ without bound.
            expect(
                client.customCommand.mock.calls.some(
                    ([cmd]) => cmd[0] === 'LTRIM' && cmd[1] === POISON_KEY,
                ),
            ).toBe(true);
            expect(
                client.customCommand.mock.calls.some(
                    ([cmd]) => cmd[0] === 'PEXPIRE' && cmd[1] === POISON_KEY,
                ),
            ).toBe(true);

            incSpy.mockRestore();
        });

        it('repeated over-cap enqueues keep the main list pinned at LIST_CAP', async () => {
            const { drain, client } = makeDrain();
            for (let i = 0; i < 10_000; i++) {
                client.list.unshift(
                    JSON.stringify({
                        runId: `seed_${i}`,
                        kind: 'update',
                        payload: {},
                        enqueuedAt: 0,
                    }),
                );
            }
            expect(client.list).toHaveLength(10_000);

            for (let i = 0; i < 5; i++) {
                await drain.enqueue(makeWrite({ runId: `over_${i}` }));
                expect(client.list).toHaveLength(10_000);
            }

            // Five drops → five entries on the poison list.
            const poison = client.lists.get(POISON_KEY) ?? [];
            expect(poison).toHaveLength(5);
        });

        it('falls back to the unknown kind label when the dropped entry is undecodable', async () => {
            const { drain, client } = makeDrain();
            const incSpy = vi.spyOn(taskPendingWriteDroppedTotal, 'inc');

            // Fill to cap-1 with valid entries, then put garbage at the tail so
            // it's the one RPOP evicts.
            client.list.push('NOT_VALID_JSON{{{'); // tail = oldest = evicted
            for (let i = 0; i < 9_999; i++) {
                client.list.unshift(
                    JSON.stringify({
                        runId: `v_${i}`,
                        kind: 'update',
                        payload: {},
                        enqueuedAt: 0,
                    }),
                );
            }
            expect(client.list).toHaveLength(10_000);

            await drain.enqueue(makeWrite({ runId: 'run_after_garbage' }));

            expect(incSpy).toHaveBeenCalledWith({ kind: 'unknown' });
            // Garbage still preserved on the poison list (raw string).
            const poison = client.lists.get(POISON_KEY) ?? [];
            expect(poison).toContain('NOT_VALID_JSON{{{');

            incSpy.mockRestore();
        });
    });

    // ── F4.2: transient vs non-transient replay failure handling ────────────────
    describe('F4.2 transient-aware replay failure', () => {
        it('TRANSIENT failure re-enqueues to head WITHOUT bumping attempts', async () => {
            const client = makeClient();
            const { drain } = makeDrainWithSql(client, makeTransientSql());

            client.list.push(JSON.stringify(makeWrite({ runId: 'run_head' })));
            client.list.push(JSON.stringify(makeWrite({ runId: 'run_tail', attempts: 3 })));

            const result = await drain.drain();
            expect(result.drained).toBe(0);
            // Both entries still present (only the tail/oldest was popped + re-pushed).
            expect(client.list).toHaveLength(2);

            // The re-enqueued entry (run_tail, oldest) sits at the head now and
            // its attempts counter is UNCHANGED (still 3).
            const head = JSON.parse(client.list[0]) as PendingWrite;
            expect(head.runId).toBe('run_tail');
            expect(head.attempts).toBe(3);

            // The untouched entry (run_head) keeps its original shape.
            const other = JSON.parse(client.list[1]) as PendingWrite;
            expect(other.runId).toBe('run_head');
            expect(other.attempts).toBeUndefined();

            // Only one claim (LMOVE) happened (backpressure break after first
            // failure), and the claimed entry was acked off the processing list.
            const claimCount = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'LMOVE' && cmd[1] === MAIN_LIST_KEY,
            ).length;
            expect(claimCount).toBe(1);
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
        });

        it('NON-transient failure bumps attempts and poisons at MAX', async () => {
            const client = makeClient();
            // makeSql(true) throws "pg connect refused" — classified NON-transient.
            const { drain } = makeDrainWithSql(client, makeSql(true));

            client.list.push(JSON.stringify(makeWrite({ runId: 'run_perm', attempts: 9 })));

            const result = await drain.drain();
            // 10th attempt trips the poison threshold.
            expect(result.drained).toBe(1);
            expect(client.list).toHaveLength(0);

            const poison = client.lists.get(POISON_KEY) ?? [];
            expect(poison).toHaveLength(1);
            const poisoned = JSON.parse(poison[0]) as PendingWrite;
            expect(poisoned.runId).toBe('run_perm');
            expect(poisoned.attempts).toBe(10);
        });

        it('NON-transient failure below MAX bumps attempts and re-enqueues', async () => {
            const client = makeClient();
            const { drain } = makeDrainWithSql(client, makeSql(true));

            client.list.push(JSON.stringify(makeWrite({ runId: 'run_perm2' })));

            const result = await drain.drain();
            expect(result.drained).toBe(0);
            expect(client.list).toHaveLength(1);
            const requeued = JSON.parse(client.list[0]) as PendingWrite;
            expect(requeued.attempts).toBe(1);
        });

        it('TRANSIENT failure is poisoned once transientAttempts hits the cap (no infinite head-wedge)', async () => {
            // Review R2: an entry that DETERMINISTICALLY raises a transient error
            // must not loop at the head forever. Seed it one short of the cap; the
            // next transient failure exhausts MAX_TRANSIENT_REPLAY_ATTEMPTS and
            // poisons it instead of re-enqueuing.
            const client = makeClient();
            const { drain } = makeDrainWithSql(client, makeTransientSql());

            // MAX_TRANSIENT_REPLAY_ATTEMPTS = 360; seed at 359 so one more trips it.
            client.list.push(
                JSON.stringify(makeWrite({ runId: 'run_stuck', transientAttempts: 359 })),
            );

            const result = await drain.drain();
            // Poisoned (counted as drained) — NOT re-enqueued to the head.
            expect(result.drained).toBe(1);
            expect(client.list).toHaveLength(0);
            const poison = client.lists.get(POISON_KEY) ?? [];
            expect(poison).toHaveLength(1);
            const poisoned = JSON.parse(poison[0]) as PendingWrite;
            expect(poisoned.runId).toBe('run_stuck');
            expect(poisoned.transientAttempts).toBe(360);
            // Poison push is bounded (LTRIM + PEXPIRE), same as the non-transient path.
            expect(
                client.customCommand.mock.calls.some(
                    ([cmd]) => cmd[0] === 'LTRIM' && cmd[1] === POISON_KEY,
                ),
            ).toBe(true);
        });

        it('TRANSIENT failure below the cap bumps transientAttempts (not attempts)', async () => {
            const client = makeClient();
            const { drain } = makeDrainWithSql(client, makeTransientSql());
            client.list.push(
                JSON.stringify(
                    makeWrite({
                        runId: 'run_t',
                        attempts: 2,
                        transientAttempts: 5,
                    }),
                ),
            );

            await drain.drain();
            expect(client.list).toHaveLength(1);
            const head = JSON.parse(client.list[0]) as PendingWrite;
            expect(head.transientAttempts).toBe(6); // bumped
            expect(head.attempts).toBe(2); // untouched
        });
    });

    // ── F4.3: poison list is bounded (LTRIM + TTL) ──────────────────────────────
    describe('F4.3 poison list bounding', () => {
        it('applies LTRIM cap and a PEXPIRE TTL after poisoning', async () => {
            const client = makeClient();
            const { drain } = makeDrainWithSql(client, makeSql(true));

            // Pre-fill the poison list well past the cap so LTRIM has work to do.
            const poison = client.lists.get(POISON_KEY) ?? [];
            client.lists.set(POISON_KEY, poison);
            for (let i = 0; i < 1_500; i++) {
                poison.push(JSON.stringify({ runId: `dead_${i}` }));
            }

            client.list.push(JSON.stringify(makeWrite({ runId: 'run_poison', attempts: 9 })));

            await drain.drain();

            // LTRIM bounded the DLQ to the cap (1000).
            const poisonAfter = client.lists.get(POISON_KEY) ?? [];
            expect(poisonAfter.length).toBe(1000);

            // An LTRIM 0 999 command was issued on the poison key.
            const ltrimCmds = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'LTRIM' && cmd[1] === POISON_KEY,
            );
            expect(ltrimCmds).toHaveLength(1);
            expect(ltrimCmds[0][0][2]).toBe('0');
            expect(ltrimCmds[0][0][3]).toBe('999');

            // A TTL was set on the poison key.
            const pexpireCmds = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'PEXPIRE' && cmd[1] === POISON_KEY,
            );
            expect(pexpireCmds).toHaveLength(1);
            expect(client.ttls.get(POISON_KEY)).toBeGreaterThan(0);
        });
    });

    // ── Crash-safe claim: durability fix ────────────────────────────────────────
    describe('crash-safe claim (LMOVE/LREM durability fix)', () => {
        it('drain claims via LMOVE onto the processing list, not a destructive RPOP', async () => {
            const { drain, client } = makeDrain();
            await drain.enqueue(makeWrite({ runId: 'run_a' }));

            await drain.drain();

            // The claim command used was LMOVE, and no RPOP was issued against
            // the main list during the drain pass.
            const lmoveCalls = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'LMOVE' && cmd[1] === MAIN_LIST_KEY,
            );
            expect(lmoveCalls).toHaveLength(1);
            const rpopOnMain = client.customCommand.mock.calls.filter(
                ([cmd]) => cmd[0] === 'RPOP' && cmd[1] === MAIN_LIST_KEY,
            );
            expect(rpopOnMain).toHaveLength(0);

            // Successfully replayed entry is acked off the processing list, not
            // left behind.
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
        });

        it('an entry stuck on the processing list (simulated crash between claim and ack) is recovered and redrained', async () => {
            // Simulate a crash: a previous process claimed this entry (moved it
            // onto PROCESSING_KEY) but died before replaying/acking it. It must
            // NOT be lost — the next drain tick's recovery sweep should move it
            // back onto the main list and redrain it.
            const client = makeClient();
            const { drain, sql } = makeDrain(client);

            const stuck = makeWrite({ runId: 'run_crashed' });
            client.lists.set(PROCESSING_KEY, [JSON.stringify(stuck)]);
            // Main list is otherwise empty — the ONLY record of this write is
            // the orphaned processing-list entry.
            expect(client.list).toHaveLength(0);

            const result = await drain.drain();

            // Recovered from PROCESSING_KEY, redrained, and replayed to Postgres.
            expect(result.drained).toBe(1);
            expect(sql).toHaveBeenCalledTimes(1);
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
            expect(client.list).toHaveLength(0);
        });

        it('multiple crash-orphaned entries on the processing list are all recovered', async () => {
            const client = makeClient();
            const { drain, sql } = makeDrain(client);

            client.lists.set(PROCESSING_KEY, [
                JSON.stringify(makeWrite({ runId: 'run_orphan_1' })),
                JSON.stringify(makeWrite({ runId: 'run_orphan_2' })),
                JSON.stringify(makeWrite({ runId: 'run_orphan_3' })),
            ]);

            const result = await drain.drain();

            expect(result.drained).toBe(3);
            expect(sql).toHaveBeenCalledTimes(3);
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
        });

        it('a crash-orphaned entry that fails replay is re-enqueued to the main list (not lost, not left on processing)', async () => {
            const client = makeClient();
            const { drain } = makeDrain(client, true /* sqlFail */);

            client.lists.set(PROCESSING_KEY, [
                JSON.stringify(makeWrite({ runId: 'run_orphan_fail' })),
            ]);

            const result = await drain.drain();

            // Recovered from PROCESSING_KEY onto the main list, claimed again,
            // failed replay, and re-enqueued to the main list head with
            // attempts bumped — never disappears.
            expect(result.drained).toBe(0);
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
            expect(client.list).toHaveLength(1);
            const requeued = JSON.parse(client.list[0]) as PendingWrite;
            expect(requeued.runId).toBe('run_orphan_fail');
            expect(requeued.attempts).toBe(1);
        });

        it('the transient-retry re-enqueue acks the ORIGINAL claimed entry, leaving no duplicate on the processing list', async () => {
            const client = makeClient();
            const { drain } = makeDrainWithSql(client, makeTransientSql());

            client.list.push(JSON.stringify(makeWrite({ runId: 'run_transient' })));

            await drain.drain();

            // Exactly one copy on the main list (the bumped re-enqueue), and
            // nothing left behind on the processing list — proves the ORIGINAL
            // raw string (not the bumped copy) was the one acked.
            expect(client.list).toHaveLength(1);
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
            const requeued = JSON.parse(client.list[0]) as PendingWrite;
            expect(requeued.runId).toBe('run_transient');
            expect(requeued.transientAttempts).toBe(1);
        });

        it('recovery sweep runs before the alert-depth calculation so a crash backlog is visible immediately', async () => {
            const client = makeClient();
            const { drain } = makeDrain(client);

            // Seed a backlog entirely on the processing list (as if the
            // draining process crashed mid-batch last tick).
            const orphans = Array.from({ length: 5 }, (_, i) =>
                JSON.stringify(makeWrite({ runId: `run_orphan_${i}` })),
            );
            client.lists.set(PROCESSING_KEY, orphans);

            const result = await drain.drain();

            // All 5 orphans were merged into the main list's accounting and
            // drained in this same pass (DRAIN_BATCH=50 comfortably covers 5).
            expect(result.drained).toBe(5);
            expect(result.remaining).toBe(0);
        });

        it('malformed entry recovered from the processing list is dropped and acked, not left behind', async () => {
            const client = makeClient();
            const { drain } = makeDrain(client);

            client.lists.set(PROCESSING_KEY, ['NOT_VALID_JSON{{{']);

            const result = await drain.drain();

            expect(result.drained).toBe(1);
            expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
            expect(client.list).toHaveLength(0);
        });
    });

    // ── F4.4: reentrancy guard ──────────────────────────────────────────────────
    describe('F4.4 drain reentrancy', () => {
        it('concurrent drain() calls — second returns the sentinel, one pass runs', async () => {
            const client = makeClient();
            // Seed a few entries so the first pass does real work.
            for (let i = 0; i < 3; i++) {
                client.list.push(JSON.stringify(makeWrite({ runId: `run_${i}` })));
            }
            const { drain } = makeDrainWithSql(client, makeSql(false));

            const [a, b] = await Promise.all([drain.drain(), drain.drain()]);

            // Exactly one of the two saw the sentinel { drained: 0, remaining: -1 }.
            const results = [a, b];
            const sentinels = results.filter((r) => r.remaining === -1 && r.drained === 0);
            expect(sentinels).toHaveLength(1);

            // The real pass drained all three.
            const real = results.find((r) => r.remaining !== -1)!;
            expect(real.drained).toBe(3);
        });
    });

    // ── F4.4: leader-gate failure fallthrough ───────────────────────────────────
    describe('F4.4 leader-gate', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it('SET throwing skips the drain tick', async () => {
            const client = makeClient();
            client.setBehavior = 'throw';
            const { drain } = makeDrainWithSql(client, makeSql(false));
            const drainSpy = vi
                .spyOn(drain, 'drain')
                .mockResolvedValue({ drained: 0, remaining: 0 });

            drain.start(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            // A failed ownership/election check cannot authorize list mutation.
            expect(drainSpy).not.toHaveBeenCalled();
            drain.stop();
        });

        it('SET returning non-OK (lock held) skips drain', async () => {
            const client = makeClient();
            client.setBehavior = 'lost';
            const { drain } = makeDrainWithSql(client, makeSql(false));
            const drainSpy = vi
                .spyOn(drain, 'drain')
                .mockResolvedValue({ drained: 0, remaining: 0 });

            drain.start(1_000);
            await vi.advanceTimersByTimeAsync(1_000);
            // Lock held by another replica → this tick does NOT drain.
            expect(drainSpy).not.toHaveBeenCalled();
            drain.stop();
        });
    });
});

describe('isTransientPgError', () => {
    it('classifies 08xxx connection codes as transient', () => {
        expect(isTransientPgError({ code: '08000' })).toBe(true);
        expect(isTransientPgError({ code: '08003' })).toBe(true);
        expect(isTransientPgError({ code: '08006' })).toBe(true);
        expect(isTransientPgError({ code: '08P01' })).toBe(true);
    });

    it('classifies deadlock and serialization failure as transient', () => {
        expect(isTransientPgError({ code: '40001' })).toBe(true);
        expect(isTransientPgError({ code: '40P01' })).toBe(true);
    });

    it('classifies resource exhaustion as transient', () => {
        expect(isTransientPgError({ code: '53300' })).toBe(true); // too_many_connections
        expect(isTransientPgError({ code: '53200' })).toBe(true); // out_of_memory
    });

    it('TASK-M-poison: classifies 55xxx object-not-in-prerequisite-state as transient', () => {
        expect(isTransientPgError({ code: '55000' })).toBe(true); // object_not_in_prerequisite_state
        expect(isTransientPgError({ code: '55006' })).toBe(true); // object_in_use
        expect(isTransientPgError({ code: '55P02' })).toBe(true); // cant_change_runtime_param
        expect(isTransientPgError({ code: '55P03' })).toBe(true); // lock_not_available
    });

    it('TASK-M-poison: classifies F0xxx configuration-file errors as transient', () => {
        expect(isTransientPgError({ code: 'F0000' })).toBe(true); // config_file_error
        expect(isTransientPgError({ code: 'F0001' })).toBe(true); // lock_file_exists
    });

    it('classifies constraint violations as NOT transient (must re-throw)', () => {
        expect(isTransientPgError({ code: '23505' })).toBe(false); // unique_violation
        expect(isTransientPgError({ code: '23503' })).toBe(false); // foreign_key_violation
        expect(isTransientPgError({ code: '23502' })).toBe(false); // not_null_violation
    });

    it('classifies syntax and data errors as NOT transient', () => {
        expect(isTransientPgError({ code: '42601' })).toBe(false); // syntax_error
        expect(isTransientPgError({ code: '22P02' })).toBe(false); // invalid_text_representation
    });

    it('falls back to message heuristic for uncoded network errors', () => {
        expect(isTransientPgError({ message: 'Connection lost' })).toBe(true);
        expect(isTransientPgError({ message: 'connection closed' })).toBe(true);
        expect(
            isTransientPgError({
                message: 'connection terminated unexpectedly',
            }),
        ).toBe(true);
        expect(isTransientPgError({ message: 'ECONNREFUSED 127.0.0.1:5432' })).toBe(true);
        expect(isTransientPgError({ message: 'write ECONNRESET' })).toBe(true);
        // Non-network messages stay permanent.
        expect(
            isTransientPgError({
                message: 'duplicate key value violates unique constraint',
            }),
        ).toBe(false);
    });

    it('Important-6 (F1): classifies EPIPE/ENOTCONN/EHOSTUNREACH socket errors as transient', () => {
        // postgres.js raises these at the socket layer without a SQLSTATE
        // during replica failover, node draining, and network partition.
        // Without these heuristics the orchestrator's INSERT drain treats
        // them as fatal and refuses to retry — defeating the entire purpose
        // of the pending-write drain.
        expect(isTransientPgError({ message: 'write EPIPE' })).toBe(true);
        expect(isTransientPgError({ message: 'write ENOTCONN' })).toBe(true);
        expect(
            isTransientPgError({
                message: 'connect EHOSTUNREACH 10.0.0.5:5432',
            }),
        ).toBe(true);
        // Case-insensitive — postgres.js casing varies between Node versions.
        expect(isTransientPgError({ message: 'EPIPE' })).toBe(true);
        expect(isTransientPgError({ message: 'epipe error' })).toBe(true);
    });

    it('returns false for non-error inputs', () => {
        expect(isTransientPgError(null)).toBe(false);
        expect(isTransientPgError(undefined)).toBe(false);
        expect(isTransientPgError('string error')).toBe(false);
        expect(isTransientPgError({})).toBe(false);
    });
});

// List-behavior fixtures bypass only the ownership envelope. Real rejection is
// exercised against PostgreSQL and Valkey in recovery-fencing.integration.
vi.mock('./lua/fenced.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lua/fenced.js')>();
    return {
        ...actual,
        invokeFencedValkey: vi.fn(
            async (
                source: string,
                keys: string[],
                args: (string | number)[],
                client: ValkeyLike,
            ): Promise<unknown> => {
                const argv = args.map(String);
                if (source.includes('-- task-pending-enqueue-v1')) {
                    let dropped: unknown = null;
                    if (Number(await client.customCommand(['LLEN', keys[0]])) >= Number(argv[1])) {
                        dropped = await client.customCommand([
                            'LMOVE',
                            keys[0],
                            keys[1],
                            'RIGHT',
                            'LEFT',
                        ]);
                        if (dropped !== null) {
                            await client.customCommand([
                                'LTRIM',
                                keys[1],
                                '0',
                                String(Number(argv[2]) - 1),
                            ]);
                            await client.customCommand(['PEXPIRE', keys[1], argv[3]]);
                        }
                    }
                    await client.customCommand(['LPUSH', keys[0], argv[0]]);
                    return dropped;
                }
                if (source.includes('-- task-pending-transfer-v1')) {
                    await client.customCommand(['LPUSH', keys[1], argv[1]]);
                    if (argv[2] === '1') {
                        await client.customCommand([
                            'LTRIM',
                            keys[1],
                            '0',
                            String(Number(argv[3]) - 1),
                        ]);
                        await client.customCommand(['PEXPIRE', keys[1], argv[4]]);
                    }
                    return client.customCommand(['LREM', keys[0], '1', argv[0]]);
                }
                return client.customCommand(
                    source.includes("redis.call('LMOVE'")
                        ? ['LMOVE', ...keys, ...argv]
                        : [argv[0], keys[0], ...argv.slice(1)],
                );
            },
        ),
    };
});

describe('pending list transfer fences', () => {
    it('capacity quarantine and incoming push use one fenced script without a destructive pop', async () => {
        const { drain, client } = makeDrain();
        client.list.push(
            ...Array.from({ length: 10_000 }, (_, i) =>
                JSON.stringify(makeWrite({ runId: `capacity_${i}` })),
            ),
        );
        vi.mocked(invokeFencedValkey).mockClear();
        await drain.enqueue(makeWrite({ runId: 'incoming' }));
        const calls = vi.mocked(invokeFencedValkey).mock.calls;
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toContain('-- task-pending-enqueue-v1');
        expect(calls[0][1]).toEqual([MAIN_LIST_KEY, POISON_KEY]);
        expect(client.customCommand.mock.calls.some(([cmd]) => cmd[0] === 'RPOP')).toBe(false);
        expect(client.lists.get(POISON_KEY)).toHaveLength(1);
        expect(client.list).toHaveLength(10_000);
    });
    it('does not acknowledge a processing claim when poison publication fails', async () => {
        const client = makeClient();
        const { drain } = makeDrainWithSql(client, makeSql(true));
        const raw = JSON.stringify(makeWrite({ runId: 'retained-poison', attempts: 9 }));
        client.list.push(raw);
        const original = client.customCommand.getMockImplementation()!;
        client.customCommand.mockImplementation(async (cmd) => {
            if (cmd[0] === 'LPUSH' && cmd[1] === POISON_KEY)
                throw new Error('publication unavailable');
            return original(cmd);
        });
        await expect(drain.drain()).rejects.toThrow('publication unavailable');
        expect(client.lists.get(PROCESSING_KEY)).toContain(raw);
        expect(client.customCommand.mock.calls.some(([cmd]) => cmd[0] === 'LREM')).toBe(false);
    });
});

it('quarantines a managed deferred terminal instead of acknowledging hard-kill intent as applied', async () => {
    const client = makeClient();
    const fn = Object.assign(
        vi.fn(async () => [{ id: 'run_intent' }]),
        { json: (value: unknown) => value, array: (value: unknown) => value },
    );
    const { drain } = makeDrainWithSql(client, fn as unknown as postgres.Sql);
    const write = makeWrite({
        runId: 'run_intent',
        authority: {
            partition: 'tasks',
            generation: '1',
            ownerId: '10000000-0000-4000-8000-000000000001',
        },
        payload: { state: 'failed', error: { message: 'old terminal' } },
    });
    client.list.push(JSON.stringify(write));
    await drain.drain();
    const poison = client.lists.get(POISON_KEY) ?? [];
    expect(poison).toHaveLength(1);
    expect(JSON.parse(poison[0])).toMatchObject({
        ...write,
        rejectionReason: 'authority:conflict',
    });
    expect(fn).toHaveBeenCalledTimes(1);
});

describe('queue-attempt and authority replay bounds', () => {
    const attempt: TerminalQueueAttempt = {
        id: 'job-1',
        queueName: 'task-x',
        prefix: 'bull:task',
        attemptsStarted: 1,
        attemptsMade: 0,
    };
    const managed = {
        partition: 'tasks',
        generation: '1',
        ownerId: '10000000-0000-4000-8000-000000000001',
    };
    function sqlCalls(sql: postgres.Sql): string[] {
        return (sql as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
            Array.from(call[0] as TemplateStringsArray).join(''),
        );
    }
    afterEach(() => {
        vi.mocked(terminalQueueAttemptCurrent).mockReset();
    });

    it('counts attempt-UNKNOWN replays instead of re-queuing the raw entry forever', async () => {
        vi.mocked(terminalQueueAttemptCurrent).mockRejectedValue(
            new TerminalAttemptUnknownError('UNKNOWN: terminal attempt lookup timed out'),
        );
        const { drain, client } = makeDrain();
        client.list.push(
            JSON.stringify(makeWrite({ runId: 'run_unknown', queueAttempt: attempt })),
        );
        await drain.drain();
        expect(client.list).toHaveLength(1);
        expect(JSON.parse(client.list[0])).toMatchObject({
            runId: 'run_unknown',
            unknownAttempts: 1,
            jobMissingObservations: 0,
        });
        expect(client.lists.get(PROCESSING_KEY) ?? []).toHaveLength(0);
    });

    it('dead-letters an entry whose queue attempt stays UNKNOWN at the bound', async () => {
        vi.mocked(terminalQueueAttemptCurrent).mockRejectedValue(
            new TerminalAttemptUnknownError('UNKNOWN: terminal attempt provenance mismatch'),
        );
        const { drain, client, sql } = makeDrain();
        client.list.push(
            JSON.stringify(
                makeWrite({ runId: 'run_exhausted', queueAttempt: attempt, unknownAttempts: 59 }),
            ),
        );
        const result = await drain.drain();
        expect(result).toEqual({ drained: 1, remaining: 0 });
        const poison = client.lists.get(POISON_KEY) ?? [];
        expect(poison).toHaveLength(1);
        expect(JSON.parse(poison[0])).toMatchObject({
            runId: 'run_exhausted',
            unknownAttempts: 60,
            rejectionReason: 'attempt-unknown-exhausted',
        });
        expect(sql).not.toHaveBeenCalled();
    });

    it('applies the terminal write once the reaped job has been observed missing three times', async () => {
        vi.mocked(terminalQueueAttemptCurrent).mockRejectedValue(
            new TerminalAttemptJobMissingError(),
        );
        const { drain, client, sql } = makeDrain();
        client.list.push(
            JSON.stringify(
                makeWrite({
                    runId: 'run_reaped',
                    queueAttempt: attempt,
                    ownerInstanceId: 'instance-a',
                    unknownAttempts: 59,
                    payload: { state: 'failed', result: { itemsProcessed: 2 } },
                }),
            ),
        );
        for (const observed of [1, 2]) {
            await drain.drain();
            expect(client.list).toHaveLength(1);
            // Job-missing observations do not count toward the UNKNOWN bound.
            expect(JSON.parse(client.list[0])).toMatchObject({
                jobMissingObservations: observed,
                unknownAttempts: 59,
            });
            expect(sqlCalls(sql).some((text) => text.includes('UPDATE task_history'))).toBe(false);
        }
        // Third observation: PostgreSQL decides. The mocked row never confirms the
        // result, and the reaped job can no longer contest it, so it is accepted.
        expect(await drain.drain()).toEqual({ drained: 1, remaining: 0 });
        const update = sqlCalls(sql).find((text) => text.includes('UPDATE task_history'));
        // Guarded on the original attempt's ownership, never a successor's row.
        expect(update).toContain('owner_instance_id =');
        expect(update).toContain("state IN ('active', 'cancelling')");
        expect(client.lists.get(POISON_KEY) ?? []).toHaveLength(0);
    });

    it('does not apply a reaped-job write that lacks its original owner instance', async () => {
        vi.mocked(terminalQueueAttemptCurrent).mockRejectedValue(
            new TerminalAttemptJobMissingError(),
        );
        const { drain, client, sql } = makeDrain();
        client.list.push(
            JSON.stringify(
                makeWrite({
                    runId: 'run_ownerless',
                    queueAttempt: attempt,
                    jobMissingObservations: 2,
                }),
            ),
        );
        await drain.drain();
        expect(sqlCalls(sql).some((text) => text.includes('UPDATE task_history'))).toBe(false);
        expect(JSON.parse(client.list[0])).toMatchObject({ unknownAttempts: 1 });
    });

    it('moves a retained UNKNOWN entry behind the list and keeps draining the others', async () => {
        vi.mocked(terminalQueueAttemptCurrent).mockRejectedValue(
            new TerminalAttemptUnknownError('UNKNOWN: terminal attempt lookup timed out'),
        );
        const { drain, client } = makeDrain();
        // RPOP side (end of the array) is claimed first.
        client.list.push(
            JSON.stringify(makeWrite({ runId: 'run_after' })),
            JSON.stringify(makeWrite({ runId: 'run_blocked', queueAttempt: attempt })),
        );
        expect(await drain.drain()).toEqual({ drained: 1, remaining: 1 });
        expect(JSON.parse(client.list[0])).toMatchObject({
            runId: 'run_blocked',
            unknownAttempts: 1,
        });
    });

    it('stops claiming entries once the drain is stopped', async () => {
        const { drain, client, sql } = makeDrain();
        client.list.push(JSON.stringify(makeWrite({ runId: 'run_stopped' })));
        await drain.stop();
        expect(await drain.drain()).toEqual({ drained: 0, remaining: 1 });
        expect(sql).not.toHaveBeenCalled();
    });

    it('looks the queue attempt up before the PostgreSQL write transaction opens', async () => {
        const insideTransaction: boolean[] = [];
        vi.mocked(terminalQueueAttemptCurrent).mockImplementation(async () => {
            insideTransaction.push(writeTransaction.open);
            return true;
        });
        const { drain, client, sql } = makeDrain();
        client.list.push(
            JSON.stringify(makeWrite({ runId: 'run_outside', queueAttempt: attempt })),
        );
        expect(await drain.drain()).toEqual({ drained: 1, remaining: 0 });
        expect(insideTransaction).toEqual([false]);
        expect(sqlCalls(sql).some((text) => text.includes('UPDATE task_history'))).toBe(true);
    });

    it('quarantines an unmanaged entry on stale_authority (a tokenless write cannot succeed once managed)', async () => {
        const client = makeClient();
        const fn = Object.assign(
            vi.fn(async () => {
                throw new AuthorityError('stale_authority');
            }),
            { json: (value: unknown) => value, array: (value: unknown) => value },
        );
        const { drain } = makeDrainWithSql(client, fn as unknown as postgres.Sql);
        client.list.push(JSON.stringify(makeWrite({ runId: 'run_unmanaged' })));
        expect(await drain.drain()).toEqual({ drained: 1, remaining: 0 });
        const poison = client.lists.get(POISON_KEY) ?? [];
        expect(poison).toHaveLength(1);
        expect(JSON.parse(poison[0])).toMatchObject({
            runId: 'run_unmanaged',
            rejectionReason: 'authority:stale_authority',
        });
        // Undecidable-owner lookups are for managed tokens only; no PostgreSQL probe.
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unchanged', '1', false],
        ['replaced', '2', true],
    ] as const)(
        'managed stale_authority with %s owner generation: poisoned=%s',
        async (_label, generation, poisoned) => {
            const client = makeClient();
            const fn = Object.assign(
                vi.fn(async (strings: TemplateStringsArray) => {
                    if (strings.join('').includes('task_runtime_authorities'))
                        return [
                            {
                                partition: 'tasks',
                                generation,
                                owner_id: managed.ownerId,
                                owner_kind: 'typescript',
                                phase: 'active',
                                lease_until: new Date(0),
                                live: false,
                            },
                        ];
                    throw new AuthorityError('stale_authority');
                }),
                { json: (value: unknown) => value, array: (value: unknown) => value },
            );
            const { drain } = makeDrainWithSql(client, fn as unknown as postgres.Sql);
            client.list.push(JSON.stringify(makeWrite({ runId: 'run_lease', authority: managed })));
            await drain.drain();
            const poison = client.lists.get(POISON_KEY) ?? [];
            if (poisoned) {
                expect(poison).toHaveLength(1);
                expect(JSON.parse(poison[0])).toMatchObject({
                    rejectionReason: 'authority:stale_authority',
                });
            } else {
                expect(poison).toHaveLength(0);
                expect(JSON.parse(client.list[0])).toMatchObject({ transientAttempts: 1 });
            }
        },
    );
});
