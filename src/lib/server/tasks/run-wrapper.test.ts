// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the run-wrapper that writes stage-coverage transitions
 * around `task.execute()`. Mocks postgres via a tagged-template stub —
 * no live DB required.
 *
 * Run with: npx vitest run src/lib/server/tasks/run-wrapper.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import { AuthorityError } from '../../../task-runtime/authority/store.js';

const fenceState = vi.hoisted(() => ({ active: 0 }));
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: vi.fn(
        async (
            sql: postgres.Sql,
            _authority: unknown,
            mutate: (sql: postgres.Sql) => Promise<unknown>,
        ): Promise<unknown> => {
            fenceState.active++;
            try {
                return await mutate(sql);
            } finally {
                fenceState.active--;
            }
        },
    ),
}));

vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));

import { wrapExecute, MEDIA_ITEM_DELETED_BEFORE_RUN } from './run-wrapper.js';
import { TaskError } from '@sapd/lumastra-plugin-sdk';

type PostgresSql = postgres.Sql;

type SqlCall = { query: string; values: unknown[] };

interface FakeSql {
    (parts: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    (identifier: string): string;
    calls: SqlCall[];
    json: (v: unknown) => unknown;
}

function makeSql(): FakeSql {
    const calls: SqlCall[] = [];
    const tag = (parts: TemplateStringsArray | string, ...values: unknown[]) => {
        if (typeof parts === 'string') return parts;
        calls.push({ query: parts.join('?'), values });
        return Promise.resolve([] as unknown[]);
    };
    return Object.assign(tag, { calls, json: (v: unknown) => v }) as FakeSql;
}

describe('wrapExecute', () => {
    it.each(['completed', 'declined', 'permanent'] as const)(
        'rejects a stale %s outcome instead of returning a plugin success',
        async (outcome) => {
            const sql = makeSql();
            const stale = new AuthorityError('stale_authority');
            const result =
                outcome === 'completed'
                    ? { success: true }
                    : { success: false, permanent: outcome === 'permanent' };
            await expect(
                wrapExecute({
                    sql: sql as unknown as PostgresSql,
                    stageId: 's1',
                    pluginId: 'test-task',
                    mediaItemId: 'm1',
                    runId: 'run1',
                    processingVersion: 1,
                    currentAttempt: 1,
                    inner: async () => {
                        vi.mocked(withExistingTaskWrite).mockRejectedValueOnce(stale);
                        return result;
                    },
                }),
            ).rejects.toBe(stale);
        },
    );

    it('keeps the original authority across plugin execution and holds no SQL transaction while the plugin runs', async () => {
        vi.mocked(withExistingTaskWrite).mockClear();
        const sql = makeSql();
        const authority = {
            partition: 'tasks',
            generation: '1',
            ownerId: '5233022b-dd9b-44d6-82fd-1f622bcbfda5',
        };
        const expectedAuthority = { ...authority };
        await wrapExecute({
            sql: sql as unknown as PostgresSql,
            authority,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'm1',
            runId: 'run1',
            processingVersion: 1,
            currentAttempt: 1,
            inner: async () => {
                expect(fenceState.active).toBe(0);
                authority.generation = '2';
                return { success: true };
            },
        });
        // Claim and completion use separate short transactions; completion and
        // resolution of prior failure events are in the same second callback.
        expect(withExistingTaskWrite).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(withExistingTaskWrite).mock.calls;
        expect(calls[0][1]).toEqual(expectedAuthority);
        expect(calls[1][1]).toBe(calls[0][1]);
        expect(Object.isFrozen(calls[0][1])).toBe(true);
        expect(fenceState.active).toBe(0);
    });

    it('marks running before execute and completed on success, returning result', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => ({ ok: true }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            inner,
            currentAttempt: 1,
            processingVersion: 1,
        });
        expect(result).toEqual({ ok: true });
        expect(sql.calls.some((c) => c.query.includes("'running'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(true);
        // assertion: running was set BEFORE completed
        const runningIdx = sql.calls.findIndex((c) => c.query.includes("'running'"));
        const completedIdx = sql.calls.findIndex((c) => c.query.includes("'completed'"));
        expect(runningIdx).toBeLessThan(completedIdx);
        expect(inner).toHaveBeenCalledOnce();
    });

    it("resolves the task's own unresolved failure rows for the item on success", async () => {
        // plugin_failure_events is append-only and, before this, the only
        // thing that ever stamped `resolved_at` was an operator clicking
        // Retry. So a transient ffmpeg timeout stayed on the attention board
        // forever even after the item was reprocessed successfully — prod
        // 2026-09-11 held 1,477 unresolved intro-analyzer rows across 580
        // items, 578 of them already `completed` on this very path.
        const sql = makeSql();
        await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 'multi-stage-task:visual',
            pluginId: 'multi-stage-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            inner: async () => ({ ok: true }),
            currentAttempt: 1,
            processingVersion: 1,
        });

        const resolve = sql.calls.find((c) => c.query.includes('resolved_at = now()'));
        expect(resolve).toBeDefined();
        // Keyed on the TASK id, not the stage id: a multi-stage task spells
        // its stage `<taskId>:<stage>`, which matches no plugin_id row.
        expect(resolve!.values).toContain('multi-stage-task');
        expect(resolve!.values).toContain('item-1');
        expect(resolve!.values).not.toContain('multi-stage-task:visual');
    });

    it('leaves analyzer completion and failure resolution to its input-fenced writes', async () => {
        // d046376876: the generic wrapper has no input proof. It must not
        // complete a replacement file or resolve another stage/input's failures.
        const sql = makeSql();
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 'lumastra-intro-analyzer:visual',
            pluginId: 'lumastra-intro-analyzer',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            inner: async () => ({ success: true }),
            currentAttempt: 1,
            processingVersion: 5,
        });

        expect(result).toEqual({ success: true });
        expect(sql.calls.some((c) => c.query.includes("'running'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes('UPDATE plugin_failure_events'))).toBe(false);
    });

    it('does NOT resolve failure rows when inner returned success:false', async () => {
        const sql = makeSql();
        await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            inner: async () => ({ success: false }),
            currentAttempt: 1,
            processingVersion: 1,
        });

        expect(sql.calls.some((c) => c.query.includes('resolved_at = now()'))).toBe(false);
    });

    it('converts the media_item deletion race (FK on stage_state) into a permanent skip sentinel, without running inner', async () => {
        // First sql call is upsertRunningRow — make it FK-violate as it would
        // when the media_item was deleted between enqueue and execute.
        const fkErr = Object.assign(
            new Error(
                'insert or update on table "media_item_stage_state" violates foreign key constraint "media_item_stage_state_media_item_id_fkey"',
            ),
            {
                code: '23503',
                constraint_name: 'media_item_stage_state_media_item_id_fkey',
            },
        );
        const sql = ((parts: TemplateStringsArray) => {
            if (parts.join('?').includes('media_item_stage_state')) return Promise.reject(fkErr);
            return Promise.resolve([] as unknown[]);
        }) as unknown as PostgresSql;
        const inner = vi.fn(async () => ({ ok: true }));

        const err = await wrapExecute({
            sql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'deleted-item',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            currentAttempt: 1,
            inner,
        }).then(
            () => null,
            (e) => e as unknown,
        );

        expect(err).toBeInstanceOf(TaskError);
        expect((err as TaskError).message).toBe(MEDIA_ITEM_DELETED_BEFORE_RUN);
        expect((err as TaskError).kind).toBe('permanent');
        // The work is moot — inner must never run for a deleted subject.
        expect(inner).not.toHaveBeenCalled();
    });

    it('propagates an unrelated FK violation from the running upsert unchanged (not the deletion sentinel)', async () => {
        const otherFk = Object.assign(new Error('some other fk'), {
            code: '23503',
            constraint_name: 'some_other_fkey',
        });
        const sql = ((parts: TemplateStringsArray) => {
            if (parts.join('?').includes('media_item_stage_state')) return Promise.reject(otherFk);
            return Promise.resolve([] as unknown[]);
        }) as unknown as PostgresSql;

        const err = await wrapExecute({
            sql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            currentAttempt: 1,
            inner: vi.fn(async () => ({ ok: true })),
        }).then(
            () => null,
            (e) => e as unknown,
        );

        expect(err).toBe(otherFk);
    });

    it('marks failed_transient when inner throws retryable error within retry budget', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('boom'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 3 },
                currentAttempt: 1,
            }),
        ).rejects.toThrow('boom');
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
    });

    it('marks failed_permanent when retries are exhausted', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('boom'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 3 },
                currentAttempt: 3,
            }),
        ).rejects.toThrow('boom');
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
    });

    it('marks failed_permanent when error explicitly retryable=false', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('hard fail'), { retryable: false });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 10 },
                currentAttempt: 1,
            }),
        ).rejects.toThrow('hard fail');
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
    });

    it('throws the original error (not a wrapped one)', async () => {
        const sql = makeSql();
        const original = Object.assign(new Error('exact message'), {
            code: 'E_TEST',
        });
        const inner = vi.fn(async () => {
            throw original;
        });
        let caught: unknown;
        try {
            await wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                currentAttempt: 1,
            });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBe(original);
    });

    it('still throws even if the markFailed_* SQL throws (does not swallow)', async () => {
        // Edge case: if recording the failure also fails, the original error
        // must still propagate. Otherwise we silently lose errors.
        const tag = (parts: TemplateStringsArray, ..._values: unknown[]) => {
            const q = parts.join('?');
            if (q.includes("'running'")) return Promise.resolve([] as unknown[]);
            return Promise.reject(new Error('DB write failed'));
        };
        const sql = Object.assign(tag, { json: (v: unknown) => v });
        const inner = vi.fn(async () => {
            throw new Error('original');
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                currentAttempt: 1,
            }),
        ).rejects.toThrow(/original|DB write failed/);
        // Either one is acceptable, but it must throw — must not silently succeed.
    });

    it('returns the inner result even when markCompleted throws (P1-2)', async () => {
        // P1-2: a DB blip while writing `'completed'` must NOT cause BullMQ to
        // retry an already-successful expensive task. The coverage row staying
        // at 'running' is strictly less harmful than a duplicate execution.
        const tag = (parts: TemplateStringsArray, ..._values: unknown[]) => {
            const q = parts.join('?');
            // Upsert (running) → succeed. Mark completed → throw.
            if (q.includes("'completed'")) {
                return Promise.reject(new Error('completion write failed'));
            }
            return Promise.resolve([] as unknown[]);
        };
        const sql = Object.assign(tag, { json: (v: unknown) => v });
        const inner = vi.fn(async () => ({ ok: true, payload: 42 }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(result).toEqual({ ok: true, payload: 42 });
        expect(inner).toHaveBeenCalledOnce();
    });

    it('does NOT mark completed when inner resolves with { success: false } (anti-false-coverage guard)', async () => {
        // Regression for the "The League" class of bug: series-sync /
        // image-sync / trickplay-generation return `{ success: false, ... }`
        // WITHOUT throwing (e.g. aborted mid-flight, zero episodes synced)
        // specifically so the coverage row is NOT marked completed. Before
        // the fix, wrapExecute unconditionally wrote 'completed' for any
        // non-throwing return, silently defeating that guard.
        const sql = makeSql();
        const inner = vi.fn(async () => ({
            success: false,
            itemsProcessed: 0,
            stopReason: 'aborted',
        }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(result).toEqual({ success: false, itemsProcessed: 0, stopReason: 'aborted' });
        expect(sql.calls.some((c) => c.query.includes("'running'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(false);
        // No synthetic failed_transient/failed_permanent disposition — those
        // carry retry/exhaustion semantics the task never opted into.
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
    });

    it('regression lock: success:false resets the stage row to pending, not leaving it running (prevents the provider-artwork stage-sweep wedge)', async () => {
        // The provider-artwork-backfill wedge: a routine GLOBAL block (hourly
        // rate cap, disk headroom) was signalled via `success:false`, which
        // used to leave the row `'running'` until `reclaimWedgedRunningStageRows`
        // reclassified it `failed_transient` after 10 minutes — churning
        // forever on a healthy drain. `success:false` must never again be
        // left as a stale `'running'` row; it must reset to `'pending'` so
        // the item is immediately re-sweepable.
        const sql = makeSql();
        const inner = vi.fn(async () => ({
            success: false,
            itemsProcessed: 0,
            stopReason: 'budget',
        }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(result).toEqual({ success: false, itemsProcessed: 0, stopReason: 'budget' });
        const pendingCall = sql.calls.find((c) => c.query.includes("'pending'"));
        expect(pendingCall).toBeDefined();
        // Scoped by runId, same ownership guard as the terminal writers.
        expect(pendingCall?.values).toContain('11111111-1111-1111-1111-111111111111');
        // attempt is untouched — a declined run is not a failed attempt.
        expect(pendingCall?.query).not.toMatch(/attempt\s*=\s*attempt\s*\+\s*1/);
    });

    it('success:false + permanent:true marks failed_permanent instead of resetting to pending', async () => {
        // 2026-08-20: trickplay-generation hit files ffmpeg simply cannot
        // decode (broken EBML header). Under the plain success:false
        // disposition those reset to `pending` and re-drained on every sweep
        // tick forever, pinning both worker slots and holding the stage at
        // 98%. A task that KNOWS retrying is futile opts out via
        // `permanent: true`, and the row must terminate.
        const sql = makeSql();
        const inner = vi.fn(async () => ({
            success: false,
            permanent: true,
            itemsProcessed: 0,
            error: 'Invalid as first byte of an EBML number',
        }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });

        expect(result).toMatchObject({ success: false, permanent: true });
        const permanentCall = sql.calls.find((c) => c.query.includes("'failed_permanent'"));
        expect(permanentCall).toBeDefined();
        // Same runId ownership guard as every other terminal writer.
        expect(permanentCall?.values).toContain('11111111-1111-1111-1111-111111111111');
        // The reason is stored, not just the fact of failure.
        expect(JSON.stringify(permanentCall?.values)).toContain('EBML');
        // Critically: it must NOT also go back to pending.
        expect(sql.calls.some((c) => c.query.includes("'pending'"))).toBe(false);
    });

    it('permanent:true is ignored without success:false (a successful run still completes)', async () => {
        // Guards against the flag leaking into the success path.
        const sql = makeSql();
        const inner = vi.fn(async () => ({ success: true, permanent: true }));
        await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
    });

    it('success:false does not touch the attempt counter and does not mark completed/failed', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => ({ success: false, itemsProcessed: 0 }));
        await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(sql.calls.some((c) => /attempt\s*=\s*attempt\s*\+\s*1/.test(c.query))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
    });

    it('success:false reset to pending is scoped by runId (a run that lost the ownership race does not resurrect the row)', async () => {
        // Mirrors markCompleted/markFailed*'s "keep, don't clobber the winner"
        // guard: the UPDATE's WHERE clause carries `last_run_id = runId`, so a
        // concurrent run that lost `upsertRunningRow` cannot un-claim the
        // winner's row merely by also returning success:false.
        const sql = makeSql();
        const inner = vi.fn(async () => ({ success: false, itemsProcessed: 0 }));
        await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '22222222-2222-2222-2222-222222222222',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        const pendingCall = sql.calls.find((c) => c.query.includes("'pending'"));
        expect(pendingCall).toBeDefined();
        expect(pendingCall?.values).toContain('22222222-2222-2222-2222-222222222222');
    });

    it('success:false still returns the inner result even if the pending-reset write fails (does not swallow the result)', async () => {
        const tag = (parts: TemplateStringsArray, ..._values: unknown[]) => {
            const q = parts.join('?');
            if (q.includes("'pending'")) return Promise.reject(new Error('reset write failed'));
            return Promise.resolve([] as unknown[]);
        };
        const sql = Object.assign(tag, { json: (v: unknown) => v });
        const inner = vi.fn(async () => ({
            success: false,
            itemsProcessed: 0,
            stopReason: 'budget',
        }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(result).toEqual({ success: false, itemsProcessed: 0, stopReason: 'budget' });
    });

    it('still marks completed when inner resolves with { success: true }', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => ({ success: true, itemsProcessed: 5 }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(result).toEqual({ success: true, itemsProcessed: 5 });
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(true);
    });

    it('still marks completed when inner resolves with a result that has no `success` field', async () => {
        // Tasks without a success/failure discriminated result (the majority)
        // must keep the pre-existing "any non-throwing return is a success"
        // behavior — only an EXPLICIT `success: false` should suppress
        // markCompleted.
        const sql = makeSql();
        const inner = vi.fn(async () => ({ ok: true }));
        const result = await wrapExecute({
            sql: sql as unknown as PostgresSql,
            stageId: 's1',
            pluginId: 'test-task',
            mediaItemId: 'item-1',
            runId: '11111111-1111-1111-1111-111111111111',
            processingVersion: 1,
            inner,
            currentAttempt: 1,
        });
        expect(result).toEqual({ ok: true });
        expect(sql.calls.some((c) => c.query.includes("'completed'"))).toBe(true);
    });

    it('does not write a failure row when inner throws an AbortError (P1-3)', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('aborted by signal'), {
                name: 'AbortError',
            });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                currentAttempt: 1,
            }),
        ).rejects.toThrow('aborted');
        // No failed_transient / failed_permanent write — cancellation is the
        // runner's outer concern; the row stays 'running'.
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
        // Upsert (running) still ran.
        expect(sql.calls.some((c) => c.query.includes("'running'"))).toBe(true);
    });

    it('does not write a failure row when inner throws a CANCELLED code (P1-3)', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('job was cancelled by user'), {
                code: 'CANCELLED',
            });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                currentAttempt: 1,
            }),
        ).rejects.toThrow(/cancel/i);
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
    });

    it('clamps maxAttempts to >= 1 (P1-5)', async () => {
        // A caller misconfiguring maxAttempts: 0 must not cause every transient
        // failure to be classified as permanent on the first attempt.
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('transient'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 0 }, // bogus
                currentAttempt: 1,
            }),
        ).rejects.toThrow('transient');
        // With clamp: maxAttempts becomes 1 → currentAttempt (1) >= 1 → exhausted
        // → failed_permanent. Without clamp: 1 >= 0 also exhausted → same. The
        // crucial property is the wrapper still runs `inner` exactly once and
        // writes a terminal row at all (rather than throwing before inner).
        expect(inner).toHaveBeenCalledOnce();
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
    });

    it('clamps maxAttempts to >= 1 and respects the budget on later attempts', async () => {
        // Stronger guard: ensure maxAttempts=0 doesn't somehow let an attempt
        // through as transient. With clamp -> 1, attempt 1 must be exhausted.
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('boom'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 0 },
                currentAttempt: 1,
            }),
        ).rejects.toThrow();
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
    });

    it('marks failed_permanent when a TaskError with kind="permanent" is thrown', async () => {
        // Regression: previously the wrapper only checked `.retryable === false`,
        // so a TaskError({kind:'permanent'}) (which has no .retryable field) was
        // treated as transient and the row cycled failed_transient → pending
        // forever on every stage-sweep. Now it honours .kind directly.
        const sql = makeSql();
        const inner = vi.fn(async () => {
            const err = new Error('hard fail');
            err.name = 'TaskError';
            (err as Error & { kind?: string }).kind = 'permanent';
            throw err;
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 10 },
                currentAttempt: 1,
            }),
        ).rejects.toThrow('hard fail');
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
    });

    it('marks failed_permanent when classify() returns "permanent" (e.g. TMDB 404)', async () => {
        // Regression: a TmdbApiError thrown without `.retryable: false` would
        // get cycled as transient forever. With the runner-supplied classifier
        // (which mirrors classifyError(err, task)), the wrapper writes
        // failed_permanent on the very first attempt.
        const sql = makeSql();
        const inner = vi.fn(async () => {
            const err = new Error('TMDB API request failed: 404 Not Found');
            err.name = 'TmdbApiError';
            throw err;
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 10 },
                currentAttempt: 1,
                classify: () => 'permanent',
            }),
        ).rejects.toThrow(/404/);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
    });

    it('still uses retry budget when classify() returns "transient"', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw new Error('rate-limited');
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 3 },
                currentAttempt: 1,
                classify: () => 'transient',
            }),
        ).rejects.toThrow('rate-limited');
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(false);
    });

    it('treats classify() throwing as permanent (no retry storm on broken predicate)', async () => {
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw new Error('boom');
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: { maxAttempts: 10 },
                currentAttempt: 1,
                classify: () => {
                    throw new Error('predicate exploded');
                },
            }),
        ).rejects.toThrow('boom');
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
    });

    it('uses exponential backoff by default and respects maxDelayMs cap', async () => {
        // Sanity check on the backoff math — at attempt 1 with initialDelayMs=1000,
        // backoff should be 1000ms; at attempt 5 it should hit the cap.
        const sql = makeSql();
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('retry'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: {
                    maxAttempts: 10,
                    initialDelayMs: 1000,
                    maxDelayMs: 4000,
                },
                currentAttempt: 5,
            }),
        ).rejects.toThrow();
        // backoff at attempt 5 = 1000 * 2^4 = 16000, capped to 4000
        const transientCall = sql.calls.find((c) => c.query.includes("'failed_transient'"));
        expect(transientCall).toBeDefined();
        // The numeric backoffMs is the 4th interpolation value (mediaItemId, stageId, error, backoffMs in our SQL).
        // Look for 4000 in the values array.
        expect(transientCall?.values).toContain(4000);
    });

    /**
     * Build a FakeSql whose upsertRunningRow (the INSERT into
     * media_item_stage_state) RETURNs the given durable `attempt` value, the
     * way the real query does. All other calls resolve to [].
     */
    function makeSqlWithRowAttempt(attempt: number): FakeSql {
        const calls: SqlCall[] = [];
        const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
            const query = parts.join('?');
            calls.push({ query, values });
            if (query.includes('INSERT INTO media_item_stage_state')) {
                return Promise.resolve([{ attempt }] as unknown[]);
            }
            return Promise.resolve([] as unknown[]);
        };
        return Object.assign(tag, { calls, json: (v: unknown) => v }) as FakeSql;
    }

    // Regression: the sweep-retry path. Stage-sweep enqueues each retry as a
    // FRESH BullMQ job, so `currentAttempt` is ALWAYS 1 — the durable per-row
    // `attempt` column is the only counter that grows. The wrapper must use it
    // for backoff and exhaustion, or a permanently-broken item retries on a
    // flat initialDelayMs forever and never dead-letters (prod incident:
    // provider-artwork `write-path-failed` ghosts at attempt 14 retrying every
    // 60s, tripping the task circuit breaker on every half-open probe).
    it('grows backoff from the durable row attempt even when currentAttempt is 1 (sweep retry)', async () => {
        // Row has 9 prior failures → this is effective attempt 10.
        const sql = makeSqlWithRowAttempt(9);
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('write-path-failed'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 'provider-artwork-poster',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                // provider-artwork's real policy shape
                retryPolicy: {
                    maxAttempts: 30,
                    backoff: 'exponential',
                    initialDelayMs: 60_000,
                    maxDelayMs: 21_600_000,
                },
                currentAttempt: 1, // fresh sweep-enqueued job
            }),
        ).rejects.toThrow('write-path-failed');
        const transientCall = sql.calls.find((c) => c.query.includes("'failed_transient'"));
        expect(transientCall).toBeDefined();
        // effective attempt 10 → 60000 * 2^9 = 30,720,000 → capped at 21,600,000.
        // Pre-fix this was a flat 60,000 on every retry.
        expect(transientCall?.values).toContain(21_600_000);
        expect(transientCall?.values).not.toContain(60_000);
    });

    it('notifies the runner when stage retries exhaust so remaining BullMQ attempts cannot stack', async () => {
        const sql = makeSqlWithRowAttempt(2);
        const onRetryExhausted = vi.fn();
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 'provider-artwork-poster',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner: async () => {
                    throw new Error('temporary dependency error');
                },
                retryPolicy: { maxAttempts: 3 },
                currentAttempt: 1,
                onRetryExhausted,
            }),
        ).rejects.toThrow('temporary dependency error');
        expect(onRetryExhausted).toHaveBeenCalledOnce();
    });

    it('dead-letters to failed_permanent once the durable row attempt exhausts maxAttempts (sweep retry)', async () => {
        // Row has 29 prior failures, maxAttempts 30 → this failure is attempt 30 → exhausted.
        const sql = makeSqlWithRowAttempt(29);
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('write-path-failed'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 'provider-artwork-poster',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: {
                    maxAttempts: 30,
                    backoff: 'exponential',
                    initialDelayMs: 60_000,
                    maxDelayMs: 21_600_000,
                },
                currentAttempt: 1, // fresh sweep-enqueued job — pre-fix this could NEVER exhaust
            }),
        ).rejects.toThrow('write-path-failed');
        expect(sql.calls.some((c) => c.query.includes("'failed_permanent'"))).toBe(true);
        expect(sql.calls.some((c) => c.query.includes("'failed_transient'"))).toBe(false);
    });

    it('keeps BullMQ-native in-job retry accounting when it is ahead of the row attempt', async () => {
        // Fresh row (attempt 0) but BullMQ says this is in-job attempt 3 —
        // the max() must keep the larger counter.
        const sql = makeSqlWithRowAttempt(0);
        const inner = vi.fn(async () => {
            throw Object.assign(new Error('boom'), { retryable: true });
        });
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 's1',
                pluginId: 'test-task',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                inner,
                retryPolicy: {
                    maxAttempts: 10,
                    backoff: 'exponential',
                    initialDelayMs: 1000,
                    maxDelayMs: 3_600_000,
                },
                currentAttempt: 3,
            }),
        ).rejects.toThrow('boom');
        const transientCall = sql.calls.find((c) => c.query.includes("'failed_transient'"));
        // attempt 3 → 1000 * 2^2 = 4000
        expect(transientCall?.values).toContain(4000);
    });
});

it.each(['identity', 'operational'] as const)(
    'stores plugin remediation %s independently of stage name',
    async (remediation) => {
        const sql = makeSql();
        await expect(
            wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 'custom-plugin-stage',
                pluginId: 'custom-plugin',
                mediaItemId: 'item-1',
                runId: '11111111-1111-1111-1111-111111111111',
                processingVersion: 1,
                currentAttempt: 1,
                inner: async () => {
                    throw new TaskError({
                        message: 'custom failure',
                        kind: 'permanent',
                        remediation,
                    });
                },
            }),
        ).rejects.toThrow('custom failure');
        const write = sql.calls.find((c) => c.query.includes("status = 'failed_permanent'"));
        expect(write?.values).toContainEqual(
            expect.objectContaining({ remediation, retryable: false }),
        );
    },
);

it.each(['translations-disabled', 'no-primary-external-id'])(
    'logs the deliberate translation skip %s without a failure warning',
    async (reason) => {
        const log = Logger.for('run-wrapper');
        const warn = vi.spyOn(log, 'warn');
        const debug = vi.spyOn(log, 'debug');
        const sql = makeSql();
        try {
            const result = await wrapExecute({
                sql: sql as unknown as PostgresSql,
                stageId: 'metadata-translations-sync',
                pluginId: 'metadata-translations-sync',
                mediaItemId: 'm1',
                runId: 'run1',
                processingVersion: 1,
                currentAttempt: 1,
                inner: async () => ({
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'skipped',
                    result: { reason },
                }),
            });
            expect(result.success).toBe(false);
            expect(warn).not.toHaveBeenCalled();
            expect(debug).toHaveBeenCalledWith(
                'Stage skipped — no completed coverage claimed',
                expect.objectContaining({ reason }),
            );
            expect(sql.calls.some((call) => call.query.includes("SET status = 'completed'"))).toBe(
                false,
            );
        } finally {
            warn.mockRestore();
            debug.mockRestore();
        }
    },
);
