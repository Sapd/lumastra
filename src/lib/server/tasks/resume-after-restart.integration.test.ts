// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resume-after-restart (run-resume.ts) at the seam: a real TaskOrchestrator +
 * TaskRunner against Postgres + Valkey. A "restart" is `runner.stop()` (the
 * graceful SIGTERM path) followed by one sweep of the orchestrator's own
 * reconciler (the production reclaim path) with the run's timestamps
 * backdated past the 5-minute stale threshold, then a fresh TaskRunner — the
 * same sequence a deploy produces. Time the handler "executed" is set on the
 * interrupt marker, which is what the crash-loop window measures.
 *
 * Requires TEST_DATABASE_URL + CACHE_URL — skipped when either is missing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { z } from 'zod';
import { ulid } from 'ulid';
import { defineTask, type TaskContext, type TaskResult } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { TaskRunner } from './runner.js';
import { RunLivenessAuthority } from './run-liveness-authority.js';
import {
    checkpointKey,
    interruptMarkerKey,
    RESUME_CRASH_LOOP_WINDOW_MS,
    RESUME_MAX,
} from './run-resume.js';
import { Queue } from 'bullmq';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { getQueueConnectionOptions } from './connection.js';
import { PER_TASK_QUEUE_PREFIX, perTaskQueueName } from './queue-naming.js';
import { requireClient } from './valkey-types.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const TASK_ID = 'integration-resume-after-restart';
const PLAIN_TASK_ID = 'integration-resume-not-opted-in';

// The coordination client, like production: the `stateMachine` singleton
// writes run state there, so the runner/orchestrator under test and the
// liveness check must all look at the same Valkey instance (the cache client
// is a different one when TASK_CACHE_URL is split, as on CI).
const getClient = () => requireClient();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Behaviour switch for the test task: block until aborted, or finish. */
const behaviour = { block: true, throwOnAbort: false };
/** Run ids whose execute() started, with the checkpoint each one loaded. */
const started = new Map<string, unknown>();

function buildRegistry(): TaskRegistry {
    const registry = new TaskRegistry();
    const execute = async (ctx: TaskContext<{ id: string }>): Promise<TaskResult<unknown>> => {
        const saved = (await ctx.checkpoint?.load<{ step: number }>()) ?? null;
        started.set(ctx.runId, saved);
        await ctx.checkpoint?.save({ step: (saved?.step ?? 0) + 1 });
        if (behaviour.block) {
            while (!ctx.signal.aborted) await sleep(25);
            if (behaviour.throwOnAbort) throw new Error('AbortError: the operation was aborted');
            return { success: false, stopReason: 'aborted' };
        }
        return { success: true, itemsProcessed: 1 };
    };
    registry.registerTask(
        defineTask({
            id: TASK_ID,
            name: 'Resume After Restart',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            manualOnly: true,
            resumeAfterRestart: true,
            resourceClass: 'io',
            inputSchema: z.object({ id: z.string() }),
            identityFor: (input) => input.id,
            exclusiveWith: { scope: 'global', ttl: '1h' },
            execute,
        }),
    );
    registry.registerTask(
        defineTask({
            id: PLAIN_TASK_ID,
            name: 'Not Opted In',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            manualOnly: true,
            resourceClass: 'io',
            inputSchema: z.object({ id: z.string() }),
            identityFor: (input) => input.id,
            execute,
        }),
    );
    return registry;
}

describe.runIf(RUN)('resume after restart (integration)', () => {
    let sql: postgres.Sql;
    let registry: TaskRegistry;
    let orch: TaskOrchestrator;
    const runners: TaskRunner[] = [];

    async function startRunner(): Promise<TaskRunner> {
        const runner = await TaskRunner.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
            instanceId: `resume-it-${runners.length}`,
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
        });
        runners.push(runner);
        return runner;
    }

    async function row(runId: string) {
        const rows = await sql<
            {
                id: string;
                state: string;
                trigger: Record<string, unknown>;
                error: { message?: string } | null;
                started_at: Date;
            }[]
        >`SELECT id, state, trigger, error, started_at FROM task_history WHERE id = ${runId}`;
        return rows[0];
    }

    async function waitFor<T>(
        fn: () => Promise<T | null | undefined | false>,
        label: string,
        timeoutMs = 15_000,
    ): Promise<T> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const v = await fn();
            if (v) return v as T;
            await sleep(100);
        }
        throw new Error(`timed out waiting for ${label}`);
    }

    const waitStarted = (runId: string) =>
        waitFor(async () => started.has(runId), `execute() of ${runId}`);

    const waitState = (runId: string, states: string[]) =>
        waitFor(
            async () => {
                const r = await row(runId);
                return r && states.includes(r.state) ? r : null;
            },
            `${runId} in ${states.join('/')}`,
        );

    /** Push the run past the boot-recovery stale threshold (2 min). */
    async function backdate(runId: string, minutes: number): Promise<void> {
        await sql`
            UPDATE task_history
            SET started_at = NOW() - make_interval(mins => ${minutes}),
                heartbeat_at = NOW() - make_interval(mins => ${minutes})
            WHERE id = ${runId}
        `;
    }

    /** Runs the server started to continue `runId`. */
    async function resumedFrom(runId: string): Promise<string[]> {
        const rows = await sql<{ id: string }[]>`
            SELECT id FROM task_history
            WHERE trigger->'resume'->>'previousRunId' = ${runId}
        `;
        return rows.map((r) => r.id);
    }

    /** One sweep of the orchestrator's reconciler — the production reclaim. */
    async function sweep(): Promise<void> {
        const reconciler = (orch as unknown as { reconciler: { sweepOnce(): Promise<unknown> } })
            .reconciler;
        await reconciler.sweepOnce();
    }

    /**
     * Graceful shutdown of the runner holding the run, then the reclaim. The
     * handler is recorded as having executed `executedMinutes` before the
     * stop; the run is pushed past the reconciler's stale threshold.
     */
    async function restart(runId: string, executedMinutes = 20): Promise<void> {
        const runner = runners.pop();
        await runner?.stop();
        const key = interruptMarkerKey(runId);
        const marker = (await getClient().customCommand(['GET', key])) as string | null;
        if (marker) {
            const value = { ...JSON.parse(marker), executedMs: executedMinutes * 60_000 };
            await getClient().customCommand(['SET', key, JSON.stringify(value), 'PX', '600000']);
        }
        await backdate(runId, 20);
        await sweep();
    }

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 6 });
        await connectValkey();
        await sql`SELECT 1 FROM task_history LIMIT 0`;
    }, 30_000);

    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        behaviour.block = true;
        behaviour.throwOnAbort = false;
        started.clear();
        await sql`DELETE FROM task_history WHERE task_id IN (${TASK_ID}, ${PLAIN_TASK_ID})`;
        registry = buildRegistry();
        orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient,
            instanceId: 'resume-it-orch',
            resumeBackoffMs: 0,
        });
    }, 30_000);

    afterEach(async () => {
        while (runners.length > 0) await runners.pop()?.stop();
        await orch.stop();
        await getClient().customCommand(['DEL', 'task:resource-budget:io']);
    }, 30_000);

    it('a restart mid-run resumes once, from the checkpoint, and completes', async () => {
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `r-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis', sourceRoute: 'test' } },
        );
        await waitStarted(runId);

        await restart(runId);

        // The interrupted run is closed with a "resumed as" message, and the
        // continuing run carries the chain in its trigger.
        const interrupted = await row(runId);
        expect(interrupted.state).toBe('failed');
        const resumedIds = await resumedFrom(runId);
        expect(resumedIds).toHaveLength(1);
        const [resumedId] = resumedIds;
        expect(interrupted.error?.message).toContain(`resumed as ${resumedId} (1/${RESUME_MAX})`);
        expect(interrupted.error?.message).toMatch(/^orphaned_at_recovery/);
        const resumed = await row(resumedId);
        expect(resumed.trigger).toMatchObject({
            kind: 'manual',
            by: 'denis',
            resume: { rootRunId: runId, previousRunId: runId, count: 1, max: RESUME_MAX },
        });
        // The marker is consumed.
        expect(await getClient().customCommand(['GET', interruptMarkerKey(runId)])).toBeNull();

        behaviour.block = false;
        await startRunner();
        await waitState(resumedId, ['completed']);
        // It continued from what the interrupted run saved.
        expect(started.get(resumedId)).toEqual({ step: 1 });
        // Exactly one resume, and the chain's checkpoint is gone.
        expect(await resumedFrom(resumedId)).toEqual([]);
        // The runner publishes the terminal row before clearing the checkpoint.
        // Observing `completed` above does not mean that final Valkey write ran.
        await waitFor(
            async () => (await getClient().customCommand(['GET', checkpointKey(runId)])) === null,
            `checkpoint cleanup for ${runId}`,
        );
        expect(await getClient().customCommand(['GET', checkpointKey(runId)])).toBeNull();
    }, 60_000);

    it(`${RESUME_MAX} restarts end the chain with a final failure`, async () => {
        await startRunner();
        let { runId } = await orch.startRun(
            TASK_ID,
            { id: `x-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        const chain = [runId];
        for (let i = 1; i <= RESUME_MAX; i++) {
            await waitStarted(runId);
            await restart(runId);
            const nexts = await resumedFrom(runId);
            expect(nexts, `resume ${i}`).toHaveLength(1);
            const [next] = nexts;
            expect((await row(next)).trigger).toMatchObject({
                resume: { count: i, rootRunId: chain[0], previousRunId: runId },
            });
            chain.push(next);
            runId = next;
            await startRunner();
        }
        await waitStarted(runId);
        // The checkpoint followed the chain's root: each run continued from
        // the step the one before it saved.
        chain.slice(1).forEach((id, i) => expect(started.get(id)).toEqual({ step: i + 1 }));
        await restart(runId);

        const last = await row(runId);
        expect(last.state).toBe('failed');
        expect(last.error?.message).toBe(
            `Stopped after ${RESUME_MAX} restarts: resume limit reached`,
        );
        expect(await resumedFrom(runId)).toEqual([]);
        expect(chain).toHaveLength(RESUME_MAX + 1);
        expect(await getClient().customCommand(['GET', checkpointKey(chain[0])])).toBeNull();
    }, 120_000);

    it('a handler that THROWS on the shutdown abort is resumed too', async () => {
        behaviour.throwOnAbort = true;
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `t-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(runId);
        await runners.pop()?.stop();
        // Let the leader's QueueEvents 'failed' for the job flush through the
        // transition batcher: it must not terminalize the run either.
        await sleep(2_000);
        // Left active for the reclaim (not written cancelled/failed by the runner).
        expect((await row(runId)).state).toBe('active');
        expect(await getClient().customCommand(['GET', interruptMarkerKey(runId)])).not.toBeNull();
        await backdate(runId, 20);
        await sweep();
        expect(await resumedFrom(runId)).toHaveLength(1);
    }, 60_000);

    it('a redelivered job of an interrupted run never re-executes the old run id', async () => {
        await startRunner();
        const input = { id: `j-${ulid().toLowerCase()}` };
        const { runId } = await orch.startRun(TASK_ID, input, {
            trigger: { kind: 'manual', by: 'denis' },
        });
        await waitStarted(runId);
        await runners.pop()?.stop();
        started.delete(runId);

        // What BullMQ's stalled check does after a SIGKILL that landed between
        // the marker write and the job's moveToFailed: the job comes back.
        const queue = new Queue(perTaskQueueName(TASK_ID), {
            connection: getQueueConnectionOptions()!,
            prefix: PER_TASK_QUEUE_PREFIX,
        });
        try {
            behaviour.block = false;
            await startRunner();
            await queue.add(
                TASK_ID,
                { runId, input, resume: { rootRunId: runId } },
                { jobId: `redelivered#${runId}` },
            );
            await sleep(3_000);
            expect(started.has(runId)).toBe(false);
            expect((await row(runId)).state).toBe('active');

            // And after the reclaim resumed it, still no second execution.
            await backdate(runId, 20);
            await sweep();
            expect(await resumedFrom(runId)).toHaveLength(1);
            await queue.add(
                TASK_ID,
                { runId, input, resume: { rootRunId: runId } },
                { jobId: `redelivered-2#${runId}` },
            );
            await sleep(3_000);
            expect(started.has(runId)).toBe(false);
            // The refused redelivery's QueueEvent must not overwrite the
            // reclaimed row: "resumed as" stays (and the guard keeps matching).
            const after = await row(runId);
            expect(after.state).toBe('failed');
            expect(after.error?.message).toMatch(/^orphaned_at_recovery: .*resumed as /);
        } finally {
            await queue.close();
        }
    }, 60_000);

    it('a resumed run interrupted again inside the window is not resumed (crash loop)', async () => {
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `c-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(runId);
        await restart(runId);
        const [resumedId] = await resumedFrom(runId);
        await startRunner();
        await waitStarted(resumedId);

        // Interrupted again after executing for 3 minutes: well inside the
        // crash-loop window.
        expect(3 * 60_000).toBeLessThan(RESUME_CRASH_LOOP_WINDOW_MS);
        await restart(resumedId, 3);

        const r = await row(resumedId);
        expect(r.state).toBe('failed');
        expect(r.error?.message).toMatch(/^Not resumed: interrupted again within/);
        expect(await resumedFrom(resumedId)).toEqual([]);
    }, 60_000);

    it('a run cancelled while the worker was down is not resumed', async () => {
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `k-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(runId);
        await runners.pop()?.stop();
        // Interrupt marker present, row still active — then the operator cancels.
        expect(await getClient().customCommand(['GET', interruptMarkerKey(runId)])).not.toBeNull();
        await orch.cancelRun(runId, { reason: 'operator' });
        await backdate(runId, 20);
        await sweep();

        expect((await row(runId)).state).toBe('cancelled');
        expect(await resumedFrom(runId)).toEqual([]);
    }, 60_000);

    it('a run whose worker died without a graceful shutdown is not resumed', async () => {
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `d-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(runId);
        // A crash: the runner never reached the shutdown path, so no marker.
        await runners.pop()?.stop();
        await getClient().customCommand(['DEL', interruptMarkerKey(runId)]);
        await backdate(runId, 20);
        await sweep();

        const r = await row(runId);
        expect(r.state).toBe('failed');
        expect(r.error?.message).toMatch(/^Not resumed: the worker stopped unexpectedly/);
        expect(await resumedFrom(runId)).toEqual([]);
    }, 60_000);

    it('never duplicates a run that is live on another replica', async () => {
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `l-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(runId);
        // Let the worker beat at least once so its run hash is refreshed.
        await sleep(1_500);
        // Postgres says the heartbeat is stale and a marker exists, but the
        // worker is alive (its run hash is present): not an orphan.
        await getClient().customCommand(['SET', interruptMarkerKey(runId), '{}', 'PX', '60000']);
        await backdate(runId, 20);
        await sweep();
        expect((await row(runId)).state).toBe('active');
        expect(await resumedFrom(runId)).toEqual([]);

        // Two replicas reclaim the same interrupted run at once: exactly one
        // continuing run comes out of it.
        await runners.pop()?.stop();
        await backdate(runId, 20);
        const authority = () =>
            new RunLivenessAuthority(
                sql,
                stateMachine,
                async () => getClient(),
                undefined,
                registry,
                true,
                undefined,
                undefined,
                (req) => orch.resumeInterruptedRun(req),
            );
        await Promise.all([
            authority().reclaimStaleRuns([runId], 'replica-a'),
            authority().reclaimStaleRuns([runId], 'replica-b'),
        ]);
        expect(await resumedFrom(runId)).toHaveLength(1);
    }, 60_000);

    it('a budget-blocked resume waits (delayed) instead of failing', async () => {
        await startRunner();
        const { runId } = await orch.startRun(
            TASK_ID,
            { id: `b-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(runId);
        await restart(runId);
        const [resumedId] = await resumedFrom(runId);

        // Exhaust the io class budget before a worker can pick the job up.
        await getClient().customCommand(['SET', 'task:resource-budget:io', '1000', 'EX', '300']);
        behaviour.block = false;
        await startRunner();
        await sleep(4_000);
        const waiting = await row(resumedId);
        expect(waiting.state).toBe('pending');
        expect(started.has(resumedId)).toBe(false);

        await getClient().customCommand(['DEL', 'task:resource-budget:io']);
        await waitState(resumedId, ['completed']);
    }, 60_000);

    it('scheduled runs and tasks without the opt-in keep today’s behaviour', async () => {
        await startRunner();
        const scheduled = await orch.startRun(
            TASK_ID,
            { id: `s-${ulid().toLowerCase()}` },
            { trigger: { kind: 'scheduled' } },
        );
        const plain = await orch.startRun(
            PLAIN_TASK_ID,
            { id: `p-${ulid().toLowerCase()}` },
            { trigger: { kind: 'manual', by: 'denis' } },
        );
        await waitStarted(scheduled.runId);
        await waitStarted(plain.runId);
        await runners.pop()?.stop();

        for (const id of [scheduled.runId, plain.runId]) {
            // The shutdown abort ends them as before (no interrupt marker, no
            // row left active for a resume).
            const r = await waitState(id, ['completed', 'failed', 'cancelled']);
            expect(r.state).not.toBe('active');
            expect(await getClient().customCommand(['GET', interruptMarkerKey(id)])).toBeNull();
            await sweep();
            expect(await resumedFrom(id)).toEqual([]);
        }
    }, 60_000);
});
