// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// hard-kill.ts — deferred hard-kill for SIGKILL'd / unresponsive workers.
//
// Plan §9.2: soft cancel fires first; after 60s if state is still
// 'cancelling', we escalate:
//   1. BullMQ moveToFailed via job.token (graceful — honours BullMQ's lock model).
//   2. Direct Valkey Lua bypass (atomic ZREM + DEL) when the worker is
//      unresponsive and has no token to hand back.
//   3. Write state='cancelled' with error='hard-killed' to Postgres + Valkey.
//
// The caller (TaskOrchestrator.cancelRun) schedules a timer and stores its
// ID. When the run completes naturally before the deadline, cancelScheduled()
// clears the timer so the hard-kill never fires.

import type { Queue } from 'bullmq';
import type postgres from 'postgres';
import { StateMachine } from './state-machine.js';
import { AuthorityError, type AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import {
    withTaskQueueWrite,
    QueueOperationUncertainError,
} from '../../../task-runtime/authority/queue-write.js';
import {
    assertTaskJobOrigin,
    taskJobOrigin,
    unmanagedTaskJobId,
} from '../../../task-runtime/authority/queue-origin.js';
import { captureValkeyAuthority, invokeFencedValkey } from './lua/fenced.js';
import { QUEUE_PREFIX } from './queue-naming.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';
import { identityKey } from './identity.js';
import { LUMASTRA_RUN_STATE_TTL_TERMINAL_MS } from '$lib/server/config.js';
import { luaLoader } from './lua/loader.js';

const log = Logger.for('HardKill');

export const HARD_KILL_QUEUE_PENDING_CODE = 'HARD_KILL_QUEUE_PENDING';

export type HardKillMethod = 'bullmq' | 'redis-pipeline' | 'already-terminal';

export interface HardKillResult {
    killed: boolean;
    method: HardKillMethod;
}

// ── HardKill ──────────────────────────────────────────────────────────────────

export class HardKill {
    private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly authority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly getSql: () => postgres.Sql | null,
        // Resolve the queue a task's jobs live on. Per-task queue when
        // FEATURE_PER_TASK_QUEUES is on, per-class otherwise — the caller owns
        // that decision. The Redis key prefix for the Lua bypass is derived
        // from the resolved queue's own `opts.prefix`, so both keyspaces work.
        private readonly getQueueForTask: (taskId: string) => Queue | undefined,
        private readonly getClient: () => ValkeyLike,
        private readonly stateMachine: StateMachine,
        private readonly getJobIdForRun: (runId: string) => Promise<string | null>,
        // Optional terminal-event emitter (the orchestrator's
        // emitTerminalCloudEvent). The hard-kill writes the terminal `cancelled`
        // state directly to Postgres + Valkey, bypassing the runner's normal
        // terminal path entirely — so without this, a hard-killed run NEVER emits
        // the CloudEvent + webhook that every other terminal transition does, and
        // silently diverges from dashboards/webhooks (TASK-C2, mirrors the
        // boot-recovery/reconciler fix in #01 Phase 0). Omitted in tests → no
        // emit, identical to prior behaviour.
        private readonly emitTerminal?: (
            taskId: string,
            runId: string,
            to: 'completed' | 'failed' | 'cancelled',
            extra?: Record<string, string | number>,
            authority?: AuthorityToken,
        ) => Promise<void>,
        authority?: AuthorityToken,
    ) {
        this.authority = captureValkeyAuthority(authority);
    }

    // -- schedule / cancel -------------------------------------------------------

    /**
     * Schedule a hard kill after deadlineMs. Returns the timer ID so the caller
     * can cancel it if the run completes naturally first.
     */
    schedule(
        runId: string,
        deadlineMs: number = 60_000,
        authority: AuthorityToken | undefined = this.authority,
    ): ReturnType<typeof setTimeout> {
        const original = captureValkeyAuthority(authority);
        const existing = this.pendingTimers.get(runId);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.pendingTimers.delete(runId);
            void this.execute(runId, original).catch((err: unknown) => {
                log.error('HardKill.execute threw', err as Error, { runId });
            });
        }, deadlineMs);
        if (typeof timer.unref === 'function') timer.unref();
        this.pendingTimers.set(runId, timer);
        log.info('Hard kill scheduled', { runId, deadlineMs });
        return timer;
    }

    /**
     * Cancel a pending hard-kill timer (e.g. run completed naturally).
     */
    cancelScheduled(runId: string): void {
        const timer = this.pendingTimers.get(runId);
        if (timer) {
            clearTimeout(timer);
            this.pendingTimers.delete(runId);
            log.debug('Hard kill timer cancelled — run completed naturally', {
                runId,
            });
        }
    }

    // -- execute -----------------------------------------------------------------

    /**
     * Execute the hard-kill sequence immediately.
     *
     * 1. Check current state — skip if already terminal.
     * 2. Managed runs persist a retryable cancelling intent, then finalize only
     *    after acknowledged queue cleanup. Legacy unmanaged runs keep terminal
     *    SQL first so QueueEvents cannot overwrite cancellation.
     * 3. Try BullMQ graceful path (moveToFailed via token).
     * 4. Fall through to Lua bypass ZREM + DEL.
     * 5. Mirror terminal state to Valkey.
     */
    async execute(
        runId: string,
        authority: AuthorityToken | undefined = this.authority,
    ): Promise<HardKillResult> {
        const original = captureValkeyAuthority(authority);
        log.info('Hard kill executing', { runId });

        const sql = this.getSql();
        if (!sql) {
            log.warn('HardKill: no sql handle', { runId });
            return { killed: false, method: 'already-terminal' };
        }

        // 1. Read current state. We only need state + task_id; the BullMQ
        //    jobId is derived from job.data.runId via getJobIdForRun (which
        //    scans the active queue) so the row doesn't need to store it.
        //
        //    A SELECT failure here is a real signal (DB down, query error) —
        //    log it explicitly instead of silently swallowing.
        const rows = await sql<{ state: string; task_id: string }[]>`
            SELECT state, task_id
            FROM task_history
            WHERE id = ${runId}
            LIMIT 1
        `.catch((e: unknown) => {
            log.error('HardKill: task_history lookup failed', e as Error, {
                runId,
                err: errMessage(e),
            });
            return [] as { state: string; task_id: string }[];
        });

        if (rows.length === 0) {
            log.warn('HardKill: run not found', { runId });
            return { killed: false, method: 'already-terminal' };
        }

        const { state, task_id: taskId } = rows[0];
        if (state === 'completed' || state === 'failed' || state === 'cancelled') {
            log.info('HardKill: run already terminal', { runId, state });
            return { killed: false, method: 'already-terminal' };
        }

        // Managed cancellation must remain retryable until queue cleanup is
        // acknowledged. The intent also suppresses QueueEvents' failed mirror
        // while the queue RPC's outcome is unresolved.
        if (original) return this.executeManaged(runId, taskId, original);

        // 2. Legacy unmanaged ordering: write terminal state before BullMQ. This
        //    ensures that when QueueEvents 'failed' fires after moveToFailed,
        //    the orchestrator's handler sees 'cancelled' in Postgres and skips
        //    writing 'failed' over it (guarded by AND state NOT IN ('cancelled')).
        //    `wonWrite` is true only when THIS call did the winning UPDATE; it
        //    gates the terminal CloudEvent/webhook emit below so we don't
        //    double-emit when another path already finalized the row.
        const wonWrite = await this.finalizePostgres(runId, original);
        if (wonWrite === null) return { killed: false, method: 'already-terminal' };

        // 3. Resolve BullMQ job + the queue it lives on (per-task or per-class).
        const queue = this.getQueueForTask(taskId);
        const jobId = await this.getJobIdForRun(runId);

        if (queue && jobId) {
            const killed = await this.tryBullMqPath(runId, queue, jobId, original);
            if (killed) {
                // The runner's terminal path is the only OTHER place that DELs the
                // exclusiveWith identity key; the hard-kill bypasses the runner
                // entirely, so we must release it here too or the key lingers for
                // its whole crash-safety TTL (default 24h) and blocks legitimate
                // sequential re-runs of the same identity (F17).
                await this.releaseExclusivityKey(runId, taskId, jobId, original);
                await this.finalizeValkey(runId, original);
                await this.emitTerminalCancelled(taskId, runId, wonWrite, original);
                return { killed: true, method: 'bullmq' };
            }

            // 4. Lua bypass. Pass the queue's actual key prefix + bare name —
            //    the Lua concatenates them so the final keys land at
            //    `<prefix>:<queueName>:…`, byte-identical to what BullMQ writes
            //    (`bull:task:<cls>:…` flag-off, `bull:task:t:<taskId>:…` flag-on).
            await this.redisLuaBypass(runId, queuePrefix(queue), queue.name, jobId, original);
            await this.releaseExclusivityKey(runId, taskId, jobId, original);
        }

        // 5. Mirror terminal state to Valkey regardless of which path succeeded.
        await this.finalizeValkey(runId, original);
        await this.emitTerminalCancelled(taskId, runId, wonWrite, original);
        return { killed: true, method: 'redis-pipeline' };
    }

    private async executeManaged(
        runId: string,
        taskId: string,
        authority: AuthorityToken,
    ): Promise<HardKillResult> {
        const sql = this.getSql();
        if (!sql) throw new AuthorityError('not_drained');
        const marked = await invokeFencedValkey(
            `
            local terminal = redis.call('HGET', KEYS[2], 'state')
            if terminal == 'cancelled' and
                redis.call('HGET', KEYS[2], 'hardKillAuthorityGeneration') == ARGV[1] and
                redis.call('HGET', KEYS[2], 'hardKillAuthorityOwnerId') == ARGV[2] then return 2 end
            if terminal == 'completed' or terminal == 'failed' or terminal == 'cancelled' then return 0 end
            local state = redis.call('HGET', KEYS[1], 'state')
            if not state then return redis.error_reply('TASK_RUN_STATE_MISSING') end
            if state ~= 'pending' and state ~= 'active' and state ~= 'cancelling' then return 0 end
            redis.call('HSET', KEYS[1], 'hardKillQueuePending', '1')
            return 1
        `,
            [`task:run:active:${runId}`, `task:run:terminal:${runId}`],
            [authority.generation, authority.ownerId],
            this.getClient(),
            authority,
        );
        if (Number(marked) === 0) return { killed: false, method: 'already-terminal' };
        const intent = await withExistingTaskWrite(
            sql,
            authority,
            async (tx) => tx<{ id: string }[]>`
            UPDATE task_history
            SET state = 'cancelling',
                cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
                completed_at = NULL,
                error = ${sql.json({
                    message: 'Hard kill awaiting acknowledged queue cleanup',
                    kind: 'fatal',
                    code: HARD_KILL_QUEUE_PENDING_CODE,
                })}
            WHERE id = ${runId} AND state NOT IN ('completed', 'failed', 'cancelled')
            RETURNING id
        `,
        );
        if (intent.length === 0) return { killed: false, method: 'already-terminal' };
        if (Number(marked) === 2) {
            // Our prior acknowledged cleanup and atomic mirror already landed;
            // retry only the SQL finalization that failed or lost its reply.
            const wonWrite = await this.finalizePostgres(runId, authority);
            if (wonWrite === null)
                throw new Error('Managed hard-kill finalization remains pending');
            await this.emitTerminalCancelled(taskId, runId, wonWrite, authority);
            return { killed: true, method: 'bullmq' };
        }

        const queue = this.getQueueForTask(taskId);
        const jobId = await this.getJobIdForRun(runId);
        if (!queue || !jobId) throw new AuthorityError('not_drained');
        if (!(await this.tryBullMqPath(runId, queue, jobId, authority)))
            throw new AuthorityError('not_drained');

        // Clean up before final history SQL: a lost final SQL reply must not
        // leave a terminal row hiding an unreleased identity. Any cleanup
        // failure keeps the durable cancelling intent available to retry.
        await this.releaseExclusivityKey(runId, taskId, jobId, authority, true);
        await this.settleManagedValkey(runId, authority);
        const wonWrite = await this.finalizePostgres(runId, authority);
        if (wonWrite === null) throw new Error('Managed hard-kill finalization remains pending');
        await this.emitTerminalCancelled(taskId, runId, wonWrite, authority);
        return { killed: true, method: 'bullmq' };
    }

    private async settleManagedValkey(runId: string, authority: AuthorityToken): Promise<void> {
        await invokeFencedValkey(
            `
            local terminal = redis.call('HGET', KEYS[2], 'state')
            if terminal == 'cancelled' and
                redis.call('HGET', KEYS[2], 'hardKillAuthorityGeneration') == ARGV[3] and
                redis.call('HGET', KEYS[2], 'hardKillAuthorityOwnerId') == ARGV[4] then return 1 end
            if terminal then return redis.error_reply('TASK_HARD_KILL_TERMINAL_CONFLICT') end
            local state = redis.call('HGET', KEYS[1], 'state')
            if state ~= 'pending' and state ~= 'active' and state ~= 'cancelling' then
                return redis.error_reply('TASK_HARD_KILL_STATE_MISSING')
            end
            if redis.call('HGET', KEYS[1], 'hardKillQueuePending') ~= '1' then
                return redis.error_reply('TASK_HARD_KILL_INTENT_MISSING')
            end
            local fields = redis.call('HGETALL', KEYS[1])
            local clock = redis.call('TIME')
            local nowMs = tostring(tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000))
            redis.call('HSET', KEYS[2], unpack(fields))
            redis.call('HSET', KEYS[2], 'state', 'cancelled', 'updatedAt', nowMs,
                'cancelledAt', ARGV[1], 'errorMessage', 'hard-killed', 'hardKillQueuePending', '0',
                'hardKillAuthorityGeneration', ARGV[3], 'hardKillAuthorityOwnerId', ARGV[4])
            redis.call('PEXPIRE', KEYS[2], ARGV[2])
            redis.call('DEL', KEYS[1])
            return 1
        `,
            [`task:run:active:${runId}`, `task:run:terminal:${runId}`],
            [
                new Date().toISOString(),
                LUMASTRA_RUN_STATE_TTL_TERMINAL_MS,
                authority.generation,
                authority.ownerId,
            ],
            this.getClient(),
            authority,
        );
    }

    /**
     * Emit the terminal `cancelled` CloudEvent + webhook for a hard-killed run.
     *
     * Only fires when `wonWrite` is true (this call performed the winning
     * Postgres UPDATE) so a hard-kill never double-emits with a concurrent
     * terminal writer. Best-effort: a failed emit is logged, not thrown — the
     * run is already terminal in Postgres + Valkey regardless.
     */
    private async emitTerminalCancelled(
        taskId: string,
        runId: string,
        wonWrite: boolean,
        authority?: AuthorityToken,
    ): Promise<void> {
        if (!wonWrite || !this.emitTerminal) return;
        try {
            await this.emitTerminal(
                taskId,
                runId,
                'cancelled',
                {
                    errorMessage: 'hard-killed',
                },
                authority,
            );
        } catch (err) {
            log.warn('HardKill: terminal CloudEvent emit failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    // -- BullMQ graceful path ------------------------------------------------

    private async tryBullMqPath(
        runId: string,
        queue: Queue,
        jobId: string,
        authority?: AuthorityToken,
    ): Promise<boolean> {
        try {
            const job = await queue.getJob(jobId);
            if (!job) return false;
            assertTaskJobOrigin(authority, job.data?.taskAuthority, job.id ?? jobId);

            const jobState = await job.getState();
            // A lost ACK may leave the durable intent pending although the
            // supported queue operation succeeded. Read the actual job's
            // matching failure before finishing that same cancellation.
            if (authority && jobState === 'failed' && job.failedReason === 'hard-cancel')
                return true;
            if (jobState !== 'active') return false;

            const token = (job as unknown as { token?: string }).token;
            if (!token) return false;

            await withTaskQueueWrite(
                this.getSql(),
                authority,
                { kind: 'hard-kill', queue: `${queuePrefix(queue)}:${queue.name}`, jobId },
                async () => {
                    await job.moveToFailed(new Error('hard-cancel'), token);
                },
                { allowDraining: true },
            );
            log.info('HardKill: BullMQ moveToFailed succeeded', {
                runId,
                jobId,
            });
            return true;
        } catch (err) {
            if (err instanceof AuthorityError || err instanceof QueueOperationUncertainError)
                throw err;
            log.warn('HardKill: BullMQ path failed, falling through to Lua bypass', {
                runId,
                jobId,
                err: errMessage(err),
            });
            return false;
        }
    }

    // -- Lua bypass (atomic ZREM + DEL) --------------------------------------

    private async redisLuaBypass(
        runId: string,
        prefix: string,
        queueName: string,
        jobId: string,
        authority?: AuthorityToken,
    ): Promise<void> {
        // Atomic Lua: ZREM the job from all queue ordered sets, then DEL the
        // job key and its lock. This handles the case where BullMQ's lock is
        // held by a dead worker that can never return the token.
        //
        // Every mutated key is explicit, so the ownership prefix fences the
        // complete queue mutation in the same atomic script.
        assertTaskJobOrigin(authority, taskJobOrigin(jobId), jobId);
        const lua = `
local jobId = ARGV[1]
-- BullMQ 5.x key TYPES (verified vs bullmq@5.71.1): :active and :waiting are
-- LISTs (RPOPLPUSH/LPUSH/LREM); :prioritized, :delayed and :waiting-children
-- are ZSETs. Using ZREM on the LIST keys raises WRONGTYPE, and redis.call
-- propagates that and ABORTS the whole script at the first offending line — so
-- the job hash + lock were never DEL'd and the dead job survived. Use the
-- correct command per type, and redis.pcall so a single type-mismatch (e.g. a
-- future BullMQ layout change) degrades to best-effort instead of aborting the
-- entire bypass.
redis.pcall('LREM', KEYS[1],           0, jobId)
redis.pcall('LREM', KEYS[2],          0, jobId)
redis.pcall('ZREM', KEYS[3],      jobId)
redis.pcall('ZREM', KEYS[4], jobId)
redis.pcall('ZREM', KEYS[5],          jobId)
redis.pcall('DEL',  KEYS[6])
redis.pcall('DEL',  KEYS[7])
-- Waiting-children dependency tracking keys are only meaningful while the job
-- exists; removing them with the job prevents Valkey key bloat under
-- high-volume hard-kills of waiting-children parents.
redis.pcall('DEL',  KEYS[8])
redis.pcall('DEL',  KEYS[9])
return 1
`;
        try {
            const client = this.getClient();
            const base = `${prefix}:${queueName}`;
            await invokeFencedValkey(
                lua,
                [
                    `${base}:active`,
                    `${base}:waiting`,
                    `${base}:prioritized`,
                    `${base}:waiting-children`,
                    `${base}:delayed`,
                    `${base}:${jobId}`,
                    `${base}:${jobId}:lock`,
                    `${base}:${jobId}:dependencies`,
                    `${base}:${jobId}:processed`,
                ],
                [jobId],
                client,
                authority,
            );
            log.info('HardKill: Lua bypass completed', {
                runId,
                prefix,
                queueName,
                jobId,
            });
        } catch (err) {
            if (errMessage(err).includes('TASK_AUTHORITY_')) throw err;
            log.warn('HardKill: Lua bypass failed', {
                runId,
                prefix,
                queueName,
                jobId,
                err: errMessage(err),
            });
        }
    }

    // -- Release exclusiveWith identity key ----------------------------------

    /**
     * Release the `exclusiveWith` mutex key the orchestrator SETNX-claimed at
     * enqueue. The key is `identityKey(taskId, jobId)` — byte-identical to what
     * the orchestrator computed and stashed in job data, so the runner's normal
     * terminal path and this hard-kill path target the same key.
     *
     * Uses the same compare-and-delete `release-identity` Lua as the runner: it
     * DELs the key ONLY when it still holds THIS run's runId. That makes the
     * call a harmless no-op for the (vast) majority of tasks that don't declare
     * `exclusiveWith` (no key exists → GET nil ≠ runId), and also prevents
     * stealing a successor's lock if our key's TTL expired mid-run and another
     * run re-claimed the same identity. Best-effort: a failed DEL just falls
     * back to TTL expiry.
     */
    private async releaseExclusivityKey(
        runId: string,
        taskId: string,
        jobId: string,
        authority?: AuthorityToken,
        strict: boolean = false,
    ): Promise<void> {
        const unmanagedId = unmanagedTaskJobId(jobId);
        const suffix = unmanagedId.lastIndexOf('#');
        const baseIdentity = suffix > 0 ? unmanagedId.slice(0, suffix) : unmanagedId;
        const key = identityKey(taskId, baseIdentity);
        try {
            await luaLoader.invoke('release-identity', [key], [runId], this.getClient(), authority);
        } catch (err) {
            if (strict) throw err;
            log.warn('HardKill: releaseExclusivityKey failed — falling back to TTL expiry', {
                runId,
                key,
                err: errMessage(err),
            });
        }
    }

    // -- Finalize Postgres + Valkey ------------------------------------------

    /**
     * Write the terminal `cancelled` state to Postgres.
     *
     * Returns `true` only when THIS call performed the winning UPDATE (the row
     * was non-terminal and is now `cancelled`). Returns `false` when the UPDATE
     * matched 0 rows — the row was already terminal (a concurrent replica /
     * QueueEvents 'failed' handler / pending-write drain replay got there first)
     * — or when the write failed. The caller uses this to gate the terminal
     * CloudEvent/webhook emit so a hard-kill never double-emits or emits for a
     * run someone else already finalized (mirrors boot-recovery's RETURNING-id
     * no-op guard).
     */
    private async finalizePostgres(
        runId: string,
        authority?: AuthorityToken,
    ): Promise<boolean | null> {
        const sql = this.getSql();
        if (!sql) return false;
        try {
            const rows = await withExistingTaskWrite(
                sql,
                authority,
                async (tx) => tx<{ id: string }[]>`
                UPDATE task_history
                SET state = 'cancelled',
                    completed_at = NOW(),
                    error = ${sql.json({ message: 'hard-killed', kind: 'fatal' } as unknown as postgres.JSONValue)}
                WHERE id = ${runId}
                  AND state NOT IN ('completed', 'failed', 'cancelled')
                RETURNING id
            `,
            );
            return rows.length > 0;
        } catch (err) {
            if (err instanceof AuthorityError) throw err;
            log.warn('HardKill: Postgres finalize failed', {
                runId,
                err: errMessage(err),
            });
            return null;
        }
    }

    private async finalizeValkey(runId: string, authority?: AuthorityToken): Promise<void> {
        try {
            const stateMachine = authority
                ? new StateMachine(() => this.getClient(), authority)
                : this.stateMachine;
            await stateMachine.transitionRun({
                runId,
                from: 'cancelling',
                to: 'cancelled',
                extra: { cancelledAt: new Date().toISOString(), errorMessage: 'hard-killed' },
            });
        } catch (err) {
            log.warn('HardKill: state machine finalize failed', { runId, err: errMessage(err) });
        }
        log.info('HardKill: run finalized as cancelled', { runId });
    }
}

/**
 * The Redis key prefix a queue's keys actually use. BullMQ stores it on
 * `queue.opts.prefix`; we always set it (`bull:task` per-class, `bull:task:t`
 * per-task), but fall back to QUEUE_PREFIX defensively so the Lua bypass never
 * targets BullMQ's default `bull:` namespace by accident.
 */
function queuePrefix(queue: Queue): string {
    const prefix = (queue.opts as { prefix?: string } | undefined)?.prefix;
    return typeof prefix === 'string' && prefix.length > 0 ? prefix : QUEUE_PREFIX;
}
