// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for class leadership handoff (plan §16.1 #10).
 *
 * Exactly two TaskOrchestrators share real Valkey/Postgres. The `io` leader's
 * class-only crash simulation stops renewal and acquisition, leaving its lease
 * orphaned until the normal TTL (default 15s, renewed every 5s) expires. Other
 * classes, coordinator duties and enqueue APIs in that instance remain alive;
 * this in-process helper does not simulate a full process SIGKILL.
 *
 * Asserts the actual lease owner changes to the standby within the existing
 * deadline, the crashed class stays nonleader, persisted runs survive and the
 * new leader can start a new run. Requires TEST_DATABASE_URL + CACHE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import postgres from 'postgres';
import { Worker } from 'bullmq';
import { getQueueConnectionOptions } from './connection.js';
import { perTaskQueueName, PER_TASK_QUEUE_PREFIX } from './queue-naming.js';
import type { TransitionRequest, TransitionFlushResult } from './transition-batcher.js';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator, orchestrator } from './orchestrator.js';
import { requireClient } from './valkey-types.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS } from '$lib/server/config.js';

// Config snapshots the environment at import; shorten only this file's leases.
vi.hoisted(() => {
    process.env.LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS = '3000';
    process.env.LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS = '1000';
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const TASK_ID = 'integration-replica-handoff';
const RUN_ID_PREFIX = 'run_repl_';

describe.runIf(RUN)('Replica handoff (plan §16.1 #10)', () => {
    let sql: postgres.Sql;
    const ownedRunIds = new Set<string>();

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 6 });
        await connectValkey();
        try {
            await sql`SELECT 1 FROM task_history LIMIT 0`;
        } catch (e) {
            throw new Error(
                `task_history table missing — run db:test:migrate first. ${(e as Error).message}`,
                { cause: e },
            );
        }
    }, 30_000);

    afterAll(async () => {
        for (const runId of ownedRunIds) await sql`DELETE FROM task_history WHERE id = ${runId}`;
        await disconnectValkey();
        await sql.end();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE task_id = ${TASK_ID}`;
        // Clear any stale leader lock so the test always starts from a known
        // state — even if a prior run aborted before stop().
        const client = requireClient();
        await client.customCommand(['DEL', 'lock:orch:io']);
    });

    afterEach(async () => {
        // Belt-and-suspenders: this test deliberately leaves a lock entry
        // stranded mid-test by stopping the renew loop without releasing.
        // The dead replica's later orch.stop() can't reclaim that lock (CAS
        // guard sees a different holder), so we drop it here to prevent the
        // lease TTL window leaking into adjacent test files in the same vitest
        // run.
        const client = requireClient();
        await client.customCommand(['DEL', 'lock:orch:io']);
        vi.restoreAllMocks();
    });

    it('standby replica acquires leadership after leader crash and runs survive', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            defineTask({
                id: TASK_ID,
                name: 'Replica Handoff Task',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({ id: z.string() }),
                identityFor: (input) => input.id,
                async execute() {
                    return { success: true };
                },
            }),
        );

        const getClient = requireClient;
        const client = getClient();
        const readOwner = async (): Promise<string | null> => {
            const value = await client.customCommand(['GET', 'lock:orch:io']);
            return value === null ? null : String(value);
        };

        // An immediate dispatcher drain can eager-enqueue through StageStateService,
        // whose default depth/start callbacks lazy-start the module singleton.
        // Bind those facade calls to our real instances so background work keeps
        // running without introducing a third election participant.
        let delegate: TaskOrchestrator | undefined;
        let resolveStarted!: (orch: TaskOrchestrator) => void;
        const started = new Promise<TaskOrchestrator>((resolve) => {
            resolveStarted = resolve;
        });
        vi.spyOn(orchestrator, 'getQueueDepths').mockImplementation(async () =>
            (delegate ?? (await started)).getQueueDepths(),
        );
        vi.spyOn(orchestrator, 'startRun').mockImplementation(async (...args) =>
            (delegate ?? (await started)).startRun(...args),
        );
        const starts = vi.spyOn(TaskOrchestrator, 'start');

        const orchA = await TaskOrchestrator.start(['io'], {
            registry: reg,
            stateMachine,
            getSql: () => sql,
            getClient,
            instanceId: 'replica-a',
            perTaskQueues: true,
        });
        delegate = orchA;
        resolveStarted(orchA);
        let orchB: TaskOrchestrator;
        try {
            orchB = await TaskOrchestrator.start(['io'], {
                registry: reg,
                stateMachine,
                getSql: () => sql,
                getClient,
                instanceId: 'replica-b',
                perTaskQueues: true,
            });
        } catch (err) {
            // orchA already started — clean it up before re-throwing, otherwise
            // its renew timer + Valkey lock leak into the next test.
            await orchA.stop().catch(() => {});
            throw err;
        }
        const stopErrors: Error[] = [];
        let terminalWorker: Worker | undefined;

        try {
            // ── Assertion 1: exactly one replica holds leadership ─────────
            const aLeader = orchA.isLeaderForAnyClass();
            const bLeader = orchB.isLeaderForAnyClass();
            expect(aLeader || bLeader).toBe(true);
            expect(aLeader && bLeader).toBe(false);

            const leader = aLeader ? orchA : orchB;
            const standby = leader === orchA ? orchB : orchA;
            const leaderLabel = leader === orchA ? 'a' : 'b';
            const standbyLabel = standby === orchA ? 'a' : 'b';
            const originalOwner = await readOwner();
            expect(originalOwner).toMatch(new RegExp(`^replica-${leaderLabel}:`));
            expect(starts).toHaveBeenCalledTimes(2);

            // ── Pre-handoff run: assertion 3 baseline ─────────────────────
            const preRun = await leader.startRun(TASK_ID, {
                id: 'before-kill',
            });
            ownedRunIds.add(preRun.runId);
            expect(preRun.runId.startsWith('run_')).toBe(true);
            const preRows = await sql<{ state: string }[]>`
                SELECT state FROM task_history WHERE id = ${preRun.runId}
            `;
            expect(preRows[0]?.state).toBe('pending');

            // ── Crash only the leader's io class, preserving the orphan ───
            const crashed = leader.simulateCrashForTesting('io');
            expect(crashed).toBe(true);
            expect(await readOwner(), 'crash helper released the orphaned lease').toBe(
                originalOwner,
            );
            // Dead leader must no longer report itself as leader (the local
            // flag was cleared by simulateCrashForTesting).
            expect(leader.isLeaderForAnyClass()).toBe(false);

            // ── Assertion 2: surviving replica acquires within deadline ───
            // Worst case: TTL (15s default) + up to 2 reacquire-jitter cycles
            // (5-7s each) if the first attempt loses a race. Cap so the
            // deadline can never exceed the 60s test timeout (`Math.min`):
            // a misconfigured-high TTL would otherwise produce a generic
            // vitest timeout error instead of our readable assertion.
            const TEST_BUDGET_MS = 60_000;
            const HEADROOM_MS = 20_000;
            const effectiveTtlMs = Math.min(
                LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS,
                TEST_BUDGET_MS - HEADROOM_MS - 5_000,
            );
            const deadline = Date.now() + effectiveTtlMs + HEADROOM_MS;
            let acquiredAt = 0;
            while (Date.now() < deadline) {
                expect(leader.isLeaderForAnyClass(), 'crashed class resurrected').toBe(false);
                const owner = await readOwner();
                expect(
                    owner === null ||
                        owner === originalOwner ||
                        owner.startsWith(`replica-${standbyLabel}:`),
                    `unexpected third lease owner: ${owner}`,
                ).toBe(true);
                if (standby.isLeaderForAnyClass()) {
                    acquiredAt = Date.now();
                    break;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            expect(
                acquiredAt,
                `standby replica (${standbyLabel}) did not acquire leadership after leader (${leaderLabel}) crash`,
            ).toBeGreaterThan(0);
            expect(standby.isLeaderForAnyClass()).toBe(true);
            const successorOwner = await readOwner();
            expect(successorOwner).toMatch(new RegExp(`^replica-${standbyLabel}:`));
            expect(successorOwner).not.toBe(originalOwner);
            expect(leader.isLeaderForAnyClass()).toBe(false);
            delegate = standby;

            // ── Assertion 3: pre-handoff run state survived ────────────────
            const surviveRows = await sql<{ state: string; task_id: string }[]>`
                SELECT state, task_id FROM task_history WHERE id = ${preRun.runId}
            `;
            expect(surviveRows[0]).toBeTruthy();
            expect(surviveRows[0]?.state).toBe('pending');
            expect(surviveRows[0]?.task_id).toBe(TASK_ID);

            // ── Assertion 4: new leader can startRun (continuity) ──────────
            const postRun = await standby.startRun(TASK_ID, {
                id: 'after-handoff',
            });
            ownedRunIds.add(postRun.runId);
            expect(postRun.runId.startsWith('run_')).toBe(true);
            const postRows = await sql<{ state: string }[]>`
                SELECT state FROM task_history WHERE id = ${postRun.runId}
            `;
            expect(postRows[0]?.state).toBe('pending');
            expect(await readOwner()).toBe(successorOwner);
            expect(leader.isLeaderForAnyClass()).toBe(false);
            expect(starts).toHaveBeenCalledTimes(2);

            // Complete actual BullMQ jobs only after the pending-run survival
            // assertions. With A's task subscriptions disconnected, B must observe
            // the real terminal events and persist both completed rows.
            type TerminalSink = {
                flushTransitions(batch: TransitionRequest[]): Promise<TransitionFlushResult>;
            };
            const crashedFlush = vi.spyOn(leader as unknown as TerminalSink, 'flushTransitions');
            const successorFlush = vi.spyOn(standby as unknown as TerminalSink, 'flushTransitions');
            const connection = getQueueConnectionOptions();
            expect(connection).not.toBeNull();
            terminalWorker = new Worker(
                perTaskQueueName(TASK_ID),
                async () => ({ success: true }),
                {
                    connection: connection!,
                    prefix: PER_TASK_QUEUE_PREFIX,
                },
            );
            await vi.waitFor(
                async () => {
                    const terminalRows = await sql<{ id: string; state: string }[]>`
                    SELECT id, state FROM task_history WHERE id IN (${preRun.runId}, ${postRun.runId})
                `;
                    expect(terminalRows).toHaveLength(2);
                    expect(terminalRows.every((row) => row.state === 'completed')).toBe(true);
                },
                { timeout: 10_000, interval: 100 },
            );
            expect(
                successorFlush.mock.calls.flatMap(([batch]) =>
                    batch.map((request) => request.runId),
                ),
            ).toEqual(expect.arrayContaining([preRun.runId, postRun.runId]));
            expect(crashedFlush).not.toHaveBeenCalled();
            expect(starts).toHaveBeenCalledTimes(2);

            // ── Sanity: the two run IDs differ ─────────────────────────────
            expect(preRun.runId).not.toBe(postRun.runId);
            // Prefix probe just ensures the project's run-id format hasn't
            // silently changed underneath this test.
            expect(preRun.runId.startsWith(RUN_ID_PREFIX) || preRun.runId.startsWith('run_')).toBe(
                true,
            );
        } finally {
            try {
                await terminalWorker?.close();
            } catch (err) {
                stopErrors.push(err as Error);
            }
            // Always stop both replicas — release() is CAS-guarded so the
            // dead one's stop() can't accidentally clobber the new leader's
            // lock. Collect any stop errors into stopErrors (declared above)
            // and let them surface AFTER the finally block — throwing from
            // finally would mask any assertion error from the try block.
            try {
                await orchA.stop();
            } catch (err) {
                stopErrors.push(err as Error);
            }
            try {
                await orchB.stop();
            } catch (err) {
                stopErrors.push(err as Error);
            }
        }
        if (stopErrors.length > 0) {
            throw new Error(
                `orchestrator teardown failed: ${stopErrors.map((e) => e.message).join('; ')}`,
            );
        }
    }, 60_000);
});
