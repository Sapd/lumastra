// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Single liveness authority for orphan run recovery.
//
// Consolidation #1: replaces the three-signal (BullMQ job state, Valkey hash,
// cluster-node presence) classification in BootRecovery with one rule:
//
//   A run whose `heartbeat_at` is stale past the caller-supplied threshold is DEAD.
//
// The ONLY fail-closed guard is: if `getClient()` throws, skip the entire cycle
// (Valkey store unreachable — cannot safely classify).
//
// The Valkey hash check (Signal 2) is retained as the sole per-row liveness
// guard: a CPU-burst worker with a stale per-run heartbeat but a still-present
// `task:run:active:<id>` hash is protected. Signals 1 (BullMQ job state) and 3
// (cluster-node presence) are deleted.
//
// Fresh-run grace window: enforced structurally by the SQL candidate queries
// (`started_at < NOW() - threshold`), NOT by classifier logic. A run that has
// not yet emitted its first heartbeat but whose started_at is within the grace
// window never appears in the candidate set and is never passed to this class.

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { publishMessage } from '$lib/server/cache/valkey.js';
import { reclaimWedgedRunningStageRows } from '$lib/server/database/queries/stage-state.queries.js';
import { registry as defaultRegistry, type TaskRegistry } from './registry.js';
import { computeIdentity, identityKey } from './identity.js';
import { luaLoader } from './lua/loader.js';
import { captureValkeyAuthority, invokeFencedValkey } from './lua/fenced.js';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import { taskJobId } from '../../../task-runtime/authority/queue-origin.js';
import { taskRunsTotal } from './metrics.js';
import { RESOURCE_CLASSES, type TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { BUDGET_TTL_SECONDS } from './budget-semaphore.js';
import {
    FEATURE_PER_TASK_QUEUES,
    config,
    LUMASTRA_RUN_STATE_TTL_TERMINAL_MS,
} from '$lib/server/config.js';
import { type ValkeyLike } from './valkey-types.js';
import type { PendingWriteDrain } from './pending-write-drain.js';
import { isTransientPgError } from '$lib/server/utils/transient-pg.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { insertBootRecoveryLog } from '$lib/server/database/queries/observability.queries.js';
import { appendAuditEvent } from './observability/audit-log.js';
import type { StateMachine } from './state-machine.js';
import {
    checkpointKey,
    decideResume,
    interruptMarkerKey,
    readResumeInfo,
    resumeErrorMessage,
    resumeStartFailedMessage,
    RESUME_MAX,
    type ResumeDecision,
    type ResumeInfo,
} from './run-resume.js';
import {
    BOOT_STALE_HEARTBEAT_MS,
    RECONCILER_STALE_HEARTBEAT_MS,
    RECONCILER_STALE_PENDING_MS,
} from './recovery-thresholds.js';

const log = Logger.for('RunLivenessAuthority');

// Atomic terminal-hash seed for an orphan reclaim whose `task:run:active:<id>`
// hash is ALREADY GONE (isOrphan() only classifies a run as orphaned once
// HEXISTS on that hash returns 0 — see isOrphan()). transition-run.lua's
// HEXISTS guard would therefore unconditionally reject a stateMachine
// .transitionRun() call from here with 'run not found': there is no active
// hash left to transition FROM. This EVAL writes `task:run:terminal:<id>`
// directly, mirroring the field shape transition-run.lua leaves behind
// (state/updatedAt/errorMessage) and pairing HSET with PEXPIRE in one atomic
// round trip so a leaked TTL-less key can never exist under the noeviction
// task Valkey instance. Not registered as a named script in lua/
// SCRIPT_VERSIONS.ts + loader.ts (the repo's usual pattern) because doing so
// without also updating loader.ts's SCRIPT_SOURCES map would make
// `luaLoader.load()` throw at orchestrator boot for every script, not just
// this one; the pattern instead follows the existing inline-EVAL precedent
// already used by sweepStaleActiveCounters/reconcileBudgetCounters below.
const WRITE_ORPHAN_TERMINAL_LUA = `
    local t = redis.call('TIME')
    local nowMs = tostring(tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
    redis.call('HSET', KEYS[1], 'state', ARGV[1], 'updatedAt', nowMs, 'errorMessage', ARGV[2])
    redis.call('PEXPIRE', KEYS[1], ARGV[3])
    return 1
`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecoveryReport {
    inspected: number;
    reclaimed: number;
    runIds: string[];
}

type CandidateRow = {
    id: string;
    task_id: string;
    state: 'active' | 'cancelling' | 'pending';
    owner_instance_id: string | null;
    input: Record<string, unknown> | null;
    heartbeat_at: Date | null;
    // Read for the resume-after-restart decision (run-resume.ts). Optional so
    // hand-built test rows without them keep today's reclaim behaviour.
    trigger?: unknown;
    started_at?: Date | null;
    cancel_requested_at?: Date | null;
    scope?: Record<string, unknown> | null;
};

/**
 * Starts the run that continues an interrupted one (orchestrator.startRun
 * with `trigger.resume`). Returns the new run id, or `deduped` when a live run
 * of the same identity already exists. Throws when the run cannot be started.
 */
export type ResumeStarter = (req: {
    taskId: string;
    input: unknown;
    trigger: { kind: 'manual'; by?: string; sourceRoute?: string };
    resume: ResumeInfo;
    /** The interrupted run's scope, carried over unchanged. */
    scope: ResumeScope;
    /** Recovery operation origin; the starter must not substitute a newer owner. */
    authority?: AuthorityToken;
}) => Promise<{ runId: string; deduped?: boolean; existingRunId?: string }>;

export interface ResumeScope {
    libraryGroupId?: string;
    userId?: string;
    subject?: { type: 'mediaItem'; id: string };
}

function resumeScopeOf(scope: Record<string, unknown> | null | undefined): ResumeScope {
    const out: ResumeScope = {};
    if (!scope) return out;
    if (typeof scope.libraryGroupId === 'string') out.libraryGroupId = scope.libraryGroupId;
    if (typeof scope.userId === 'string') out.userId = scope.userId;
    if (scope.subjectType === 'mediaItem' && typeof scope.subjectId === 'string') {
        out.subject = { type: 'mediaItem', id: scope.subjectId };
    }
    return out;
}

type TerminalEmitter = (
    taskId: string,
    runId: string,
    to: 'completed' | 'failed' | 'cancelled',
    extra?: Record<string, string | number>,
    authority?: AuthorityToken,
) => Promise<void>;

/**
 * Minimal structural view of a BullMQ queue used ONLY for the pending-orphan
 * job-existence check. Kept structural (not the full bullmq `Queue`) so the
 * authority stays unit-testable without a real queue and so the dependency is
 * obviously narrow — a single `getJob` lookup, never the old multi-list scan.
 */
export interface QueueJobLookup {
    getJob(jobId: string): Promise<{ getState(): Promise<string> } | null | undefined>;
}
export type QueueResolver = (taskId: string) => QueueJobLookup | undefined;

// ── SQL helpers — standalone, parameterised by threshold ──────────────────────

/**
 * Boot-time candidate query: active/cancelling with stale heartbeat OR pending
 * older than the threshold. Used by `runBoot()`.
 */
export async function queryBootCandidates(
    sql: postgres.Sql,
    thresholdMs: number = BOOT_STALE_HEARTBEAT_MS,
): Promise<CandidateRow[]> {
    const staleSecs = thresholdMs / 1000;
    return sql<CandidateRow[]>`
        SELECT id, task_id, state, owner_instance_id, input, heartbeat_at,
               trigger, started_at, cancel_requested_at, scope
        FROM task_history
        WHERE (
            state IN ('active', 'cancelling')
            AND started_at < NOW() - make_interval(secs => ${staleSecs})
            AND (
                heartbeat_at IS NULL
                OR heartbeat_at < NOW() - make_interval(secs => ${staleSecs})
            )
        )
        OR (
            state = 'pending'
            AND started_at < NOW() - make_interval(secs => ${staleSecs})
        )
        -- Active/cancelling FIRST (the urgent zombie reclaims), then pending;
        -- bounded so a fresh-install cold-start backlog can't make boot recovery
        -- a multi-minute per-row getJob scan over tens of thousands of pending
        -- rows. The reconciler continuous sweep drains the pending tail over
        -- subsequent ticks; the active zombies are always reclaimed here first.
        ORDER BY (state <> 'pending') DESC, started_at ASC
        LIMIT 2000
    `;
}

/**
 * Reconciler continuous-sweep candidate query: returns stale run IDs using
 * separate active/pending thresholds. Used by `queryStaleCandidateIds()` in
 * Reconciler and exposed for test access.
 */
export async function queryStaleCandidateIds(
    sql: postgres.Sql,
    activeThresholdMs: number = RECONCILER_STALE_HEARTBEAT_MS,
    pendingThresholdMs: number = RECONCILER_STALE_PENDING_MS,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM task_history
        WHERE (
            state IN ('active', 'cancelling')
            AND (
                heartbeat_at IS NULL
                OR heartbeat_at < NOW() - make_interval(secs => ${activeThresholdMs / 1000})
            )
        )
        OR (
            state = 'pending'
            AND started_at < NOW() - make_interval(secs => ${pendingThresholdMs / 1000})
        )
        -- Active/cancelling FIRST, then pending — each oldest-first. The few
        -- stale ACTIVE zombies hold concurrency + wedge their stage rows in
        -- 'running', so they are the urgent reclaims; a large older PENDING
        -- backlog (e.g. 15k+ on a fresh-install cold start) must not crowd them
        -- out of the LIMIT and starve their reclaim. (state <> 'pending') = TRUE
        -- for active/cancelling sorts before pending under DESC.
        ORDER BY (state <> 'pending') DESC, started_at ASC
        LIMIT 1000
    `;
    return rows.map((r) => r.id);
}

/**
 * Cancel-grace candidate query: runs stuck in `cancelling` whose cancel was
 * requested longer ago than `graceMs`, REGARDLESS of heartbeat freshness.
 *
 * This deliberately does NOT filter on `heartbeat_at` — unlike the stale-run
 * queries above. A worker that wedged AFTER a cancel (e.g. it lost its BullMQ
 * job lock during a CPU stall) keeps its independent heartbeat setInterval
 * beating, so a heartbeat filter would skip it forever. The whole point of this
 * sweep is to finalize exactly those still-beating-but-not-terminating runs.
 *
 * `cancel_requested_at IS NOT NULL` excludes legacy rows cancelled before the
 * column existed — those remain covered by the stale-heartbeat reclaim once
 * their worker actually dies. The caller force-finalizes each via the hard-kill
 * path (terminal write + BullMQ job removal), which bypasses both the heartbeat
 * filter and the Valkey-hash liveness guard in `isOrphan`.
 */
export async function queryCancelGraceCandidateIds(
    sql: postgres.Sql,
    graceMs: number,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM task_history
        WHERE state = 'cancelling'
          AND cancel_requested_at IS NOT NULL
          AND cancel_requested_at < NOW() - make_interval(secs => ${graceMs / 1000})
        ORDER BY cancel_requested_at ASC
        LIMIT 200
    `;
    return rows.map((r) => r.id);
}

// ── RunLivenessAuthority ───────────────────────────────────────────────────────

/**
 * Single authority for classifying and reclaiming stale runs.
 *
 * Replaces the three-signal (BullMQ job state + Valkey hash + cluster-node
 * presence) classifier with one rule: per-run heartbeat staleness = death.
 *
 * The Valkey hash check is retained as the sole per-row liveness guard (Signal 2),
 * protecting CPU-burst workers whose heartbeat lagged but whose hash is still alive.
 *
 * Fail-closed guard: if `getClient()` throws, skip the entire cycle.
 */
export class RunLivenessAuthority {
    private readonly registry: TaskRegistry;
    private readonly perTaskQueues: boolean;
    private readonly writeAuthority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly stateMachine: Pick<StateMachine, 'transitionRun'>,
        private readonly getClient: () => Promise<ValkeyLike>,
        // Narrow BullMQ lookup, used ONLY for the pending-orphan job-existence
        // guard (see isPendingRunQueued). Optional: when absent (e.g. per-class
        // legacy mode or a test), the pending path falls back to hash-only.
        private readonly getQueue?: QueueResolver,
        registry?: TaskRegistry,
        perTaskQueues?: boolean,
        private readonly emitTerminal?: TerminalEmitter,
        private readonly pendingWriteDrain?: Pick<PendingWriteDrain, 'enqueue'>,
        // Resume-after-restart (run-resume.ts). Optional: without it nothing
        // is ever resumed and reclaim behaves exactly as before.
        private readonly resumeRun?: ResumeStarter,
        authority?: AuthorityToken,
    ) {
        this.writeAuthority = captureValkeyAuthority(authority);
        this.registry = registry ?? defaultRegistry;
        this.perTaskQueues = perTaskQueues ?? FEATURE_PER_TASK_QUEUES;
    }

    /**
     * Boot-time full pass (2-min threshold).
     * Sweeps counters, stage rows, and logs a recovery record.
     */
    async runBoot(): Promise<RecoveryReport> {
        const startedAt = new Date();
        const candidates = await queryBootCandidates(this.sql);
        const report = await this.classifyAndReclaim(candidates, 'boot');
        await this.sweepStaleCounters();

        let wedgedStageRowsReclaimed = 0;
        try {
            wedgedStageRowsReclaimed = await withExistingTaskWrite(
                this.sql,
                this.writeAuthority,
                async (tx) => reclaimWedgedRunningStageRows(tx as postgres.Sql),
            );
            if (wedgedStageRowsReclaimed > 0) {
                log.info('Boot recovery: reclaimed wedged-running stage_state rows', {
                    count: wedgedStageRowsReclaimed,
                });
            }
        } catch (err) {
            log.warn('Boot recovery: wedged stage-state sweep failed', {
                err: err instanceof Error ? err.message : String(err),
            });
        }

        await this.persistBootRecovery(startedAt, report, wedgedStageRowsReclaimed);
        return report;
    }

    /**
     * Continuous-sweep pass (caller supplies candidate run IDs from its own query).
     * Replaces BootRecovery.runForCandidates().
     */
    async reclaimStaleRuns(runIds: string[], callerLabel: string): Promise<RecoveryReport> {
        if (runIds.length === 0) return { inspected: 0, reclaimed: 0, runIds: [] };

        const rows = await this.sql<CandidateRow[]>`
            SELECT id, task_id, state, owner_instance_id, input, heartbeat_at,
                   trigger, started_at, cancel_requested_at, scope
            FROM task_history
            WHERE id = ANY(${this.sql.array(runIds)})
              AND state NOT IN ('completed', 'failed', 'cancelled')
        `;
        return this.classifyAndReclaim(rows, callerLabel);
    }

    /**
     * Counter reconciliation — called every reconciler tick AND at boot.
     */
    async sweepStaleCounters(): Promise<void> {
        await this.sweepStaleActiveCounters();
        await this.reconcileBudgetCounters();
    }

    // ── Core classification ────────────────────────────────────────────────────

    private async classifyAndReclaim(
        candidates: CandidateRow[],
        callerLabel: string,
    ): Promise<RecoveryReport> {
        // Per-cycle reachability probe: if getClient() throws, the Valkey store
        // is unreachable — skip the entire cycle to avoid mass-reclaiming live
        // runs during a partition. Log with candidate count so operators can
        // distinguish a skipped cycle from "no orphans found".
        let client: ValkeyLike;
        try {
            client = await this.getClient();
        } catch (err) {
            log.warn('RunLivenessAuthority: skipping cycle — Valkey client unavailable', {
                callerLabel,
                candidates: candidates.length,
                err: err instanceof Error ? err.message : String(err),
            });
            return { inspected: 0, reclaimed: 0, runIds: [] };
        }

        const runIds: string[] = [];

        for (const row of candidates) {
            const orphan = await this.isOrphan(row, client);
            if (!orphan) continue;

            const task = this.registry.getTask(row.task_id) as
                TaskDefinition<unknown, unknown> | undefined;
            const resumeDecision = await this.decideResumeFor(row, task, client);
            const errorCode =
                row.state === 'pending'
                    ? 'pending_orphan_at_recovery'
                    : row.state === 'cancelling'
                      ? 'cancelling_orphan_at_recovery'
                      : 'orphaned_at_recovery';
            // A run that ends here for a resume reason gets that reason as its
            // message; a run about to be resumed keeps errorCode until the
            // resumed run exists (finishResume rewrites it).
            const recordedMessage =
                resumeDecision.outcome === 'exhausted' ||
                resumeDecision.outcome === 'crash-loop' ||
                resumeDecision.outcome === 'crashed'
                    ? resumeErrorMessage(resumeDecision.outcome)
                    : errorCode;
            // A resume candidate never goes through the write drain: a replay
            // landing later would end the row 'failed' with nothing started.
            // On a transient error it simply stays 'active' (marker intact)
            // and the next sweep retries the reclaim.
            const reclaimed = await this.markFailed(row.id, row.state, recordedMessage, {
                allowDrain: resumeDecision.outcome !== 'resume',
            });
            if (reclaimed) {
                runIds.push(row.id);
                await this.removeOrphanedBullJob(row);

                const terminal = row.state === 'cancelling' ? 'cancelled' : 'failed';
                const rc = task?.resourceClass ?? 'unknown';
                taskRunsTotal.inc({
                    task_id: row.task_id,
                    status: terminal,
                    resource_class: rc,
                });

                if (task?.exclusiveWith && row.input !== null && row.input !== undefined) {
                    await this.releaseIdentityKey(task, row.id, row.input);
                }

                // AFTER the identity release: the resumed run claims the same
                // exclusiveWith identity, which our own stale claim would dedup.
                let finalMessage = recordedMessage;
                if (resumeDecision.outcome !== 'not-applicable') {
                    finalMessage = await this.finishResume(
                        row,
                        resumeDecision,
                        reclaimed === 'updated',
                        recordedMessage,
                    );
                }

                if (this.emitTerminal) {
                    try {
                        await this.emitTerminal(
                            row.task_id,
                            row.id,
                            terminal,
                            {
                                errorMessage: finalMessage,
                            },
                            this.writeAuthority,
                        );
                    } catch (err) {
                        log.warn('RunLivenessAuthority: terminal CloudEvent emit failed', {
                            runId: row.id,
                            err: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }
        }

        if (runIds.length > 0) {
            await this.emitMeta(runIds.length, runIds);
        }

        log.info('RunLivenessAuthority: classification complete', {
            callerLabel,
            inspected: candidates.length,
            reclaimed: runIds.length,
        });

        return {
            inspected: candidates.length,
            reclaimed: runIds.length,
            runIds,
        };
    }

    /**
     * Single-rule orphan classifier.
     *
     * A run is an orphan if:
     * 1. Its Valkey hash is absent (HEXISTS returns 0) — the sole per-row
     *    liveness guard, protecting CPU-burst workers whose heartbeat lagged.
     * 2. Heartbeat age drives the pending/active/cancelling decision — the
     *    SQL candidate query already enforces the grace window via started_at
     *    and heartbeat_at filters, so any row here is past the threshold.
     *
     * The client reachability check happens once per cycle (classifyAndReclaim),
     * not per row. If we reach this method the store is reachable.
     */
    private async isOrphan(row: CandidateRow, client: ValkeyLike): Promise<boolean> {
        // Signal 2: Valkey hash presence. A CPU-burst worker that let heartbeat
        // lag still has its `task:run:active:<id>` hash present — leave it alone.
        // `alive` or throw → not an orphan (throw is unreachable here since the
        // per-cycle probe already confirmed reachability, but guard anyway).
        try {
            const result = await client.customCommand([
                'HEXISTS',
                `task:run:active:${row.id}`,
                'state',
            ]);
            // valkey-glide answers HEXISTS with a BOOLEAN (`true`/`false`),
            // not the RESP integer. The old `=== 1 || === '1'` test never
            // matched `true`, so this guard never fired and a live run whose
            // Postgres heartbeat merely lagged was reclaimed anyway (found
            // 2026-10-06 by resume-after-restart.integration.test.ts). Fail
            // closed: only an explicit "absent" reply counts as gone.
            const absent = result === false || result === 0 || result === '0';
            if (!absent) return false;
        } catch {
            // Per-row probe failed despite store being reachable at cycle start.
            // Fail closed — do not reclaim.
            return false;
        }

        // Hash absent. For ACTIVE/cancelling runs this is decisive: the candidate
        // query already proved the heartbeat is stale and a live worker keeps its
        // hash refreshed every beat, so an absent hash means the worker is gone →
        // orphan. (This is the heartbeat-age rule; no BullMQ check — Signal 1 here
        // was the zombie bug consolidation #1 removed.)
        //
        // For PENDING runs the hash is NOT a liveness signal. A pending run never
        // heartbeats, so its hash (seeded at startRun with a ~15min TTL) expires
        // even while the run sits legitimately enqueued behind a deep backlog.
        // The hash alone therefore cannot tell a queued-and-waiting run from a
        // never-enqueued orphan — only BullMQ can. Consolidation #1 deleted that
        // check for ALL states; for pending it was load-bearing (it originally
        // fixed "pending_orphan_at_recovery every 15-30min on a live job"). Restore
        // it narrowly here: a still-queued job is not an orphan.
        if (row.state === 'pending' && (await this.isPendingRunQueued(row))) {
            return false;
        }

        return true;
    }

    /**
     * PENDING-only: is the run's BullMQ job still in a non-terminal state
     * (waiting / waiting-children / active / delayed / prioritized)?
     *
     * O(1): reconstruct the deterministic jobId `${identity}#${runId}` and ask
     * the queue directly (single HGETALL), never the unbounded multi-list scan
     * that once overloaded Valkey. Returns true (do NOT reclaim) for a live job;
     * false for an absent or terminal (completed/failed/unknown) job, or when no
     * queue/identity is resolvable (fall back to the hash-only reclaim decision,
     * matching the pre-consolidation 'absent' behaviour). Conservative on a
     * getState() blip → true, so a transient Valkey error can't drop a live run.
     */
    private async isPendingRunQueued(row: CandidateRow): Promise<boolean> {
        const queue = this.getQueue?.(row.task_id);
        if (!queue) return false;
        const task = this.registry.getTask(row.task_id) as
            TaskDefinition<unknown, unknown> | undefined;
        if (!task || row.input === null || row.input === undefined) return false;

        try {
            const baseJobId = computeIdentity(task, row.input);
            const job = await queue.getJob(
                taskJobId(`${baseJobId}#${row.id}`, this.writeAuthority),
            );
            if (!job) return false;
            try {
                const state = await job.getState();
                if (state === 'completed' || state === 'failed' || state === 'unknown') {
                    return false;
                }
                return true;
            } catch {
                // getState() blip — treat hash existence as a weak alive signal
                // and skip the reclaim; the next sweep re-checks.
                return true;
            }
        } catch {
            // computeIdentity threw on malformed identityFor output — can't
            // reconstruct the jobId, so fall through to reclaim (matches the old
            // 'absent' path leading to reclaim once the hash has also expired).
            return false;
        }
    }

    // ── Resume after restart (run-resume.ts) ──────────────────────────────────

    /**
     * Evaluate the resume rules for a run about to be reclaimed. Reads the
     * shutdown marker; a read error counts as "no marker" (never resume on
     * doubt).
     */
    private async decideResumeFor(
        row: CandidateRow,
        task: TaskDefinition<unknown, unknown> | undefined,
        client: ValkeyLike,
    ): Promise<ResumeDecision> {
        const base = {
            task,
            state: row.state,
            trigger: row.trigger,
            cancelRequestedAt: row.cancel_requested_at ?? null,
            startedAt: row.started_at ?? null,
            now: new Date(),
        };
        const preliminary = decideResume({ ...base, gracefulShutdown: true });
        if (preliminary.outcome === 'not-applicable' || preliminary.outcome === 'cancelled') {
            return preliminary;
        }
        let gracefulShutdown = false;
        let executedMs: number | null = null;
        try {
            const marker = await client.customCommand(['GET', interruptMarkerKey(row.id)]);
            gracefulShutdown = typeof marker === 'string' && marker.length > 0;
            if (gracefulShutdown) {
                try {
                    const parsed = JSON.parse(marker as string) as { executedMs?: unknown };
                    if (typeof parsed.executedMs === 'number') executedMs = parsed.executedMs;
                } catch {
                    // Unparseable marker: fall back to started_at for the window.
                }
            }
        } catch (err) {
            log.warn('RunLivenessAuthority: interrupt-marker read failed; not resuming', {
                runId: row.id,
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return decideResume({ ...base, gracefulShutdown, executedMs });
    }

    /**
     * Complete the resume decision for a run this call just reclaimed: start
     * the continuing run (outcome 'resume') or end the chain. Returns the
     * message that ends up on the interrupted run.
     *
     * Only the reclaim that actually moved the row ('updated') may resume: a
     * drained write means Postgres is flaky and the row may still read
     * active, so nothing new is started on top of it.
     */
    private async finishResume(
        row: CandidateRow,
        decision: ResumeDecision,
        rowUpdated: boolean,
        recordedMessage: string,
    ): Promise<string> {
        const info = readResumeInfo(row.trigger);
        const rootRunId = info?.rootRunId ?? row.id;
        const endChain = async (): Promise<void> => {
            try {
                await invokeFencedValkey(
                    "return redis.call('DEL', KEYS[1])",
                    [checkpointKey(rootRunId)],
                    [],
                    await this.getClient(),
                    this.writeAuthority,
                );
            } catch {
                // best-effort — the checkpoint expires on its own
            }
        };
        // Unreachable today (a resume candidate's reclaim never drains — see
        // classifyAndReclaim); kept so a future drained path keeps the marker
        // and checkpoint instead of ending the chain.
        if (decision.outcome === 'resume' && !rowUpdated) return recordedMessage;
        await this.clearInterruptMarker(row.id);

        if (decision.outcome !== 'resume') {
            log.info('RunLivenessAuthority: interrupted run not resumed', {
                runId: row.id,
                taskId: row.task_id,
                outcome: decision.outcome,
                resumesSoFar: decision.previousCount,
            });
            await endChain();
            return recordedMessage;
        }
        // A cancel requested before the reclaim moves the row to 'cancelling'
        // in the same statement that sets cancel_requested_at, so the
        // `WHERE state = 'active'` reclaim UPDATE loses to it and never gets
        // here; a cancel after the reclaim targets a terminal row and is
        // refused. Cancel therefore always wins over resume.
        if (!this.resumeRun) {
            const message = resumeStartFailedMessage('no resume handler');
            await this.rewriteReclaimMessage(row.id, message);
            await endChain();
            return message;
        }

        const trigger = (row.trigger ?? {}) as { by?: unknown; sourceRoute?: unknown };
        const resume: ResumeInfo = {
            rootRunId,
            previousRunId: row.id,
            count: decision.previousCount + 1,
            max: RESUME_MAX,
        };
        let message: string;
        try {
            const request = {
                taskId: row.task_id,
                input: row.input ?? {},
                trigger: {
                    kind: 'manual' as const,
                    by: typeof trigger.by === 'string' ? trigger.by : undefined,
                    sourceRoute:
                        typeof trigger.sourceRoute === 'string' ? trigger.sourceRoute : undefined,
                },
                resume,
                scope: resumeScopeOf(row.scope),
                authority: this.writeAuthority,
            };
            let started = await this.resumeRun(request);
            // Deduped against the interrupted run's OWN identity claim: the
            // release above failed (it only warns). Release once more and
            // retry once — the claim belongs to a run that is now terminal.
            const task = this.registry.getTask(row.task_id) as
                TaskDefinition<unknown, unknown> | undefined;
            if (
                started.deduped &&
                started.existingRunId === row.id &&
                task?.exclusiveWith &&
                row.input
            ) {
                await this.releaseIdentityKey(task, row.id, row.input);
                started = await this.resumeRun(request);
            }
            if (started.deduped) {
                // A live run with the same identity already exists (another
                // replica, or the operator started one). Never a second copy.
                message = resumeStartFailedMessage(
                    `run ${started.existingRunId ?? started.runId} is already running`,
                );
                await endChain();
            } else {
                message = resumeErrorMessage('resume', {
                    resumedAs: started.runId,
                    count: resume.count,
                });
                log.info('RunLivenessAuthority: resumed interrupted run', {
                    runId: row.id,
                    resumedAs: started.runId,
                    taskId: row.task_id,
                    count: resume.count,
                });
            }
        } catch (err) {
            message = resumeStartFailedMessage(err instanceof Error ? err.message : String(err));
            log.warn('RunLivenessAuthority: resume start failed', {
                runId: row.id,
                taskId: row.task_id,
                err: err instanceof Error ? err.message : String(err),
            });
            await endChain();
        }
        await this.rewriteReclaimMessage(row.id, message);
        return message;
    }

    private async rewriteReclaimMessage(runId: string, message: string): Promise<void> {
        try {
            await withExistingTaskWrite(this.sql, this.writeAuthority, async (tx) => {
                await tx`
                UPDATE task_history
                SET error = ${this.sql.json({ message } as unknown as Record<string, never>)}
                WHERE id = ${runId}
                  AND state IN ('failed', 'cancelled')
            `;
            });
        } catch (err) {
            log.warn('RunLivenessAuthority: reclaim message rewrite failed', {
                runId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async clearInterruptMarker(runId: string): Promise<void> {
        try {
            const client = await this.getClient();
            await invokeFencedValkey(
                "return redis.call('DEL', KEYS[1])",
                [interruptMarkerKey(runId)],
                [],
                client,
                this.writeAuthority,
            );
        } catch {
            // best-effort — the marker carries a TTL
        }
    }

    // ── Support methods (identical logic to BootRecovery) ─────────────────────

    private async releaseIdentityKey(
        task: TaskDefinition<unknown, unknown>,
        runId: string,
        input: unknown,
    ): Promise<void> {
        try {
            const exclusivityKey = identityKey(task.id, computeIdentity(task, input));
            const client = await this.getClient();
            await luaLoader.invoke(
                'release-identity',
                [exclusivityKey],
                [runId],
                client,
                this.writeAuthority,
            );
        } catch (err) {
            log.warn('RunLivenessAuthority: identity-key release failed', {
                runId,
                taskId: task.id,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * 'updated' = this call's UPDATE moved the row (the single winner across
     * replicas); 'drained' = the write was queued for replay after a transient
     * Postgres error (the row may still read non-terminal); false = not
     * reclaimed (another writer got there first, or the write failed).
     */
    private async markFailed(
        runId: string,
        fromState: CandidateRow['state'],
        errorCode: string,
        opts: { allowDrain?: boolean } = {},
    ): Promise<'updated' | 'drained' | false> {
        const terminalState = fromState === 'cancelling' ? 'cancelled' : 'failed';
        try {
            const updated = await withExistingTaskWrite(
                this.sql,
                this.writeAuthority,
                async (tx) => tx<{ id: string }[]>`
                UPDATE task_history
                SET state        = ${terminalState},
                    completed_at = NOW(),
                    error        = ${this.sql.json({ message: errorCode } as unknown as Record<string, never>)}
                WHERE id = ${runId}
                  AND state = ${fromState}
                RETURNING id
            `,
            );
            if (updated.length === 0) {
                log.info('RunLivenessAuthority: orphan already transitioned — skipping', {
                    runId,
                    fromState,
                });
                return false;
            }

            // NOTE: this used to gate a `stateMachine.transitionRun({from:'active',
            // to:'failed'})` call for fromState==='active'. That was a dead guard:
            // isOrphan() only returns true once the active hash's `state` field is
            // ABSENT (HEXISTS===0), and transition-run.lua's own HEXISTS guard then
            // rejects with 'run not found' for every orphan reaching this method —
            // silently swallowed by the empty catch. No orphan path ever populated
            // the terminal hash, so a later BullMQ redelivery of the stalled job
            // could reseed the run 'pending' via reseed-for-retry.lua (whose
            // cancelled-run guard reads ONLY the terminal hash) and re-execute
            // already-finalized work. Write the terminal hash directly instead —
            // for every reclaimed orphan (fromState active, cancelling, or
            // pending), not just the formerly-gated 'active' case.
            try {
                const client = await this.getClient();
                await invokeFencedValkey(
                    WRITE_ORPHAN_TERMINAL_LUA,
                    [`task:run:terminal:${runId}`],
                    [terminalState, errorCode, LUMASTRA_RUN_STATE_TTL_TERMINAL_MS],
                    client,
                    this.writeAuthority,
                );
            } catch (err) {
                // Non-fatal for the reclaim itself (Postgres is already the
                // source of truth), but log loudly: a failure here is exactly
                // the leaked-terminal-hash condition this fix closes.
                log.warn('RunLivenessAuthority: terminal-hash write failed', {
                    runId,
                    terminalState,
                    err: err instanceof Error ? err.message : String(err),
                });
            }

            try {
                const client = await this.getClient();
                await invokeFencedValkey(
                    "return redis.call('DEL', KEYS[1])",
                    [`task:run:active:${runId}`],
                    [],
                    client,
                    this.writeAuthority,
                );
            } catch {
                // Non-fatal.
            }

            log.info('RunLivenessAuthority: reclaimed orphan', { runId, errorCode });
            return 'updated';
        } catch (err) {
            log.warn('RunLivenessAuthority: markFailed failed', {
                runId,
                err: err instanceof Error ? err.message : String(err),
            });
            if (opts.allowDrain !== false && this.pendingWriteDrain && isTransientPgError(err)) {
                try {
                    await this.pendingWriteDrain.enqueue({
                        kind: 'update',
                        runId,
                        authority: this.writeAuthority,
                        payload: {
                            state: terminalState,
                            error: { message: errorCode },
                            completedAt: new Date().toISOString(),
                        },
                        enqueuedAt: Date.now(),
                    });
                    log.info('RunLivenessAuthority: terminal write enqueued to drain', {
                        runId,
                        terminalState,
                        errorCode,
                    });
                    return 'drained';
                } catch (enqueueErr) {
                    log.warn('RunLivenessAuthority: drain enqueue failed', {
                        runId,
                        err: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
                    });
                }
            }
            return false;
        }
    }

    /**
     * Intentional no-op. RunLivenessAuthority owns no queue getter — Signal 1
     * (the BullMQ job-state probe) was deleted in consolidation #1, and there is
     * NO separate BullMQ removal path anywhere (the orchestrator's recoverOnBoot
     * passes a now-dead `_getQueue` arg to the shim). A reclaimed run's stuck
     * BullMQ job is left to BullMQ's own stalled-check, which moves it off the
     * active set once the worker's lock expires (~lockDuration + stalledInterval).
     * By the time a run is reclaimed here — its run hash expired ~15 min
     * (RUN_STATE_TTL_ACTIVE_MS) after the last heartbeat — that has long since
     * happened. Any BullMQ retry then calls claim-run.lua, finds the run hash
     * already DEL'd by markFailed, and fails fast as 'run not found', so there is
     * no double-execution. Kept as a seam for a future eager-removal path.
     */
    private async removeOrphanedBullJob(_row: CandidateRow): Promise<void> {
        // See doc comment — deliberately does nothing.
    }

    private async emitMeta(count: number, runIds: string[]): Promise<void> {
        try {
            await publishMessage(
                'task:events:meta',
                JSON.stringify({ type: 'recovery-reclaimed', count, runIds }),
            );
        } catch {
            // Non-fatal.
        }
    }

    private async persistBootRecovery(
        startedAt: Date,
        report: RecoveryReport,
        wedgedStageRowsReclaimed: number,
    ): Promise<void> {
        try {
            const taskSql = getTaskDb();
            if (taskSql) {
                await insertBootRecoveryLog(taskSql, {
                    instanceId: config.INSTANCE_ID,
                    startedAt,
                    inspected: report.inspected,
                    reclaimed: report.reclaimed,
                    wedgedStageRowsReclaimed,
                    runIds: report.runIds,
                });
            }
        } catch (err) {
            log.warn('RunLivenessAuthority: boot_recovery_log write failed (best-effort)', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
        await appendAuditEvent({
            category: 'boot-recovery',
            action: 'boot-recovery-complete',
            severity: report.reclaimed > 0 ? 'warn' : 'info',
            summary:
                `Boot recovery on ${config.INSTANCE_ID} inspected ${report.inspected}, ` +
                `reclaimed ${report.reclaimed} orphan(s)` +
                (wedgedStageRowsReclaimed > 0
                    ? ` and ${wedgedStageRowsReclaimed} wedged stage row(s)`
                    : '') +
                '.',
            detail: {
                inspected: report.inspected,
                reclaimed: report.reclaimed,
                wedgedStageRowsReclaimed,
                runIds: report.runIds,
            },
        });
    }

    async sweepStaleActiveCounters(): Promise<void> {
        let client: ValkeyLike;
        try {
            client = await this.getClient();
        } catch (err) {
            log.warn('sweepStaleActiveCounters: getClient failed', {
                err: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        const counterTaskIds = this.registry
            .getAllTasks()
            .filter(
                (t) => typeof t.quotas?.maxConcurrent === 'number' && t.quotas.maxConcurrent > 0,
            )
            .map((t) => t.id);
        if (counterTaskIds.length === 0) return;

        let liveByTask: Map<string, number>;
        try {
            const rows = await this.sql<{ task_id: string; n: number }[]>`
                SELECT task_id, COUNT(*)::int AS n
                FROM task_history
                WHERE state IN ('active', 'cancelling')
                GROUP BY task_id
            `;
            liveByTask = new Map(rows.map((r) => [r.task_id, r.n]));
        } catch (err) {
            log.warn('sweepStaleActiveCounters: active-count query failed', {
                err: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        const RECONCILE_LUA = `
            local cur = tonumber(redis.call('GET', KEYS[1]))
            if cur == nil then return 0 end
            local target = tonumber(ARGV[1])
            if cur < 0 then
                if target > 0 then
                    redis.call('SET', KEYS[1], tostring(target))
                else
                    redis.call('DEL', KEYS[1])
                end
                return cur
            end
            if cur <= target then return 0 end
            if target <= 0 then
                redis.call('DEL', KEYS[1])
            else
                redis.call('DECRBY', KEYS[1], cur - target)
            end
            return cur - target
        `;

        const prefix = 'task:active-count:';
        let reconciled = 0;
        let slotsCleared = 0;
        for (const taskId of counterTaskIds) {
            const key = `${prefix}${taskId}`;
            const target = liveByTask.get(taskId) ?? 0;
            try {
                const cleared = Number(
                    await invokeFencedValkey(
                        RECONCILE_LUA,
                        [key],
                        [target],
                        client,
                        this.writeAuthority,
                    ),
                );
                if (Number.isFinite(cleared) && cleared > 0) {
                    reconciled++;
                    slotsCleared += cleared;
                    log.info('sweepStaleActiveCounters: reconciled leaked counter', {
                        taskId,
                        target,
                        cleared,
                    });
                }
            } catch (err) {
                log.warn('sweepStaleActiveCounters: reconcile EVAL failed', {
                    key,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
        if (reconciled > 0) {
            log.info('sweepStaleActiveCounters: cleared stale maxConcurrent slots', {
                counters: reconciled,
                slotsCleared,
                total: counterTaskIds.length,
            });
        }
    }

    private async reconcileBudgetCounters(): Promise<void> {
        if (!this.perTaskQueues) return;
        let client: ValkeyLike;
        try {
            client = await this.getClient();
        } catch (err) {
            log.warn('reconcileBudgetCounters: getClient failed', {
                err: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        let activeByClass: Map<string, number>;
        try {
            const rows = await this.sql<{ task_id: string; n: number }[]>`
                SELECT task_id, COUNT(*)::int AS n
                FROM task_history
                WHERE state IN ('active', 'cancelling')
                GROUP BY task_id
            `;
            activeByClass = new Map<string, number>();
            for (const { task_id, n } of rows) {
                const task = this.registry.getTask(task_id);
                const cls = task?.resourceClass;
                if (!cls) continue;
                activeByClass.set(cls, (activeByClass.get(cls) ?? 0) + n);
            }
        } catch (err) {
            log.warn('reconcileBudgetCounters: active-count query failed', {
                err: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        const RECONCILE_LUA = `
            local target = tonumber(ARGV[1])
            local ttl = tonumber(ARGV[2])
            local raw = redis.call('GET', KEYS[1])
            if raw == false then
                if target > 0 then
                    redis.call('SET', KEYS[1], tostring(target))
                    redis.call('EXPIRE', KEYS[1], ttl)
                    return -target
                end
                return 0
            end
            local cur = tonumber(raw)
            if cur == nil then return 0 end
            if cur < 0 then
                if target > 0 then
                    redis.call('SET', KEYS[1], tostring(target))
                else
                    redis.call('DEL', KEYS[1])
                end
                return cur
            end
            if cur <= target then return 0 end
            if target <= 0 then
                redis.call('DEL', KEYS[1])
            else
                redis.call('DECRBY', KEYS[1], cur - target)
            end
            return cur - target
        `;

        let reconciled = 0;
        let tokensCleared = 0;
        let rebuilt = 0;
        for (const cls of RESOURCE_CLASSES) {
            const key = `task:resource-budget:${cls}`;
            const target = activeByClass.get(cls) ?? 0;
            try {
                const result = Number(
                    await invokeFencedValkey(
                        RECONCILE_LUA,
                        [key],
                        [target, BUDGET_TTL_SECONDS],
                        client,
                        this.writeAuthority,
                    ),
                );
                if (Number.isFinite(result) && result > 0) {
                    reconciled++;
                    tokensCleared += result;
                    log.info('reconcileBudgetCounters: reconciled leaked class budget', {
                        cls,
                        target,
                        cleared: result,
                    });
                } else if (Number.isFinite(result) && result < 0 && target > 0) {
                    rebuilt++;
                    log.info('reconcileBudgetCounters: rebuilt expired class budget from DB', {
                        cls,
                        target,
                        ttlSeconds: BUDGET_TTL_SECONDS,
                    });
                }
            } catch (err) {
                log.warn('reconcileBudgetCounters: reconcile EVAL failed', {
                    cls,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
        if (reconciled > 0 || rebuilt > 0) {
            log.info('reconcileBudgetCounters: cleared stale class budget tokens', {
                classesReconciled: reconciled,
                tokensCleared,
                classesRebuilt: rebuilt,
                totalClasses: RESOURCE_CLASSES.length,
            });
        }
    }
}
