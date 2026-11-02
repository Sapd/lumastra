// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Resume-after-restart for manually started runs (`resumeAfterRestart: true`).
//
// A worker restart used to end every in-flight run for good. That is fine for
// scheduled work (the next cycle catches up) but loses a one-shot manual run
// such as a one-shot manual repair. This module decides whether an interrupted run
// is continued by a NEW linked run, and holds the two Valkey keys the feature
// needs. The decision itself is a pure function so every rule is unit-testable.
//
// Why a new run and not the same id: re-enqueueing the same run would fight
// invariants written for one-way terminal states — the reclaim already wrote
// the terminal hash and released the identity key, BullMQ keeps the failed job
// under the same jobId (a re-add with that id is a silent no-op), and the
// terminal CloudEvent has gone out. A new run goes through startRun like any
// other: identity dedup (exclusiveWith), backpressure, quota, then the
// runner's maxConcurrent + class-budget path with moveToDelayed. The chain is
// linked through `trigger.resume` ({ rootRunId, previousRunId, count, max }),
// NOT parent_run_id, which means pipeline membership (cascade cancel, "Part
// of" in the admin UI).
//
// LOOP PROTECTION — every rule below must hold before a run is resumed:
//   1. The task declares resumeAfterRestart and the run was started manually.
//   2. The worker shut down GRACEFULLY and the handler had actually stopped:
//      the runner writes `task:run:interrupted:<runId>` only after execute()
//      unwound on a shutdown abort (runner.ts). A crash, OOM kill or wedge
//      leaves no marker, so a run that may have crashed the worker is never
//      resumed. The marker also proves the old execution is no longer running,
//      so a resume can't duplicate it.
//   3. No cancel was requested (cancel_requested_at IS NULL, state 'active').
//   4. Fewer than RESUME_MAX resumes so far (the count travels in the trigger
//      of each resumed run, i.e. in Postgres with the run).
//   5. A resumed run that executed for less than RESUME_CRASH_LOOP_WINDOW_MS
//      before it was interrupted again is treated as a crash loop.
//   6. The reclaim UPDATE (state = 'active' → failed) is the single winner
//      across replicas, so two reclaimers can never both resume one run, and
//      a run whose heartbeat or Valkey hash is still live is never reclaimed.
//      In production the reclaim is the reconciler's background sweep (5 min
//      stale-heartbeat threshold); a redelivered job of an interrupted run is
//      refused by the runner (isInterruptedOrReclaimed), so the old run id
//      never executes next to its continuation.
// Each resume is also delayed (RESUME_BACKOFF_BASE_MS × count).

import type { Trigger } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import type { ValkeyLike } from './valkey-types.js';

const log = Logger.for('RunResume');

/** At most this many resumes per run chain; the next interruption fails it. */
export const RESUME_MAX = 3;

/**
 * A resumed run whose handler executed for less than this before it was
 * interrupted again is treated as a crash loop. Measured as execution time
 * (the runner records it in the interrupt marker), so queue wait and the
 * resume back-off don't count.
 */
export const RESUME_CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;

/** Resume n waits n × this before it may start (1, 2, 3 min). */
export const RESUME_BACKOFF_BASE_MS = 60 * 1000;

/**
 * Lifetime of the shutdown marker. The marker is read when the run is
 * reclaimed, a few minutes after the shutdown; a marker older than this is
 * not trusted (and a reclaim that late is no longer "after a restart").
 */
export const INTERRUPT_MARKER_TTL_MS = 6 * 60 * 60 * 1000;

/** Checkpoints outlive a long pause between restarts, not forever. */
export const CHECKPOINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Larger checkpoint values are refused (logged) rather than stored. */
export const CHECKPOINT_MAX_BYTES = 64 * 1024;

export type ResumeInfo = NonNullable<Trigger['resume']>;

/** `task:` prefix → the noeviction coordination Valkey instance. */
export function interruptMarkerKey(runId: string): string {
    return `task:run:interrupted:${runId}`;
}

export function checkpointKey(rootRunId: string): string {
    return `task:run:checkpoint:${rootRunId}`;
}

/** The resume metadata of a persisted trigger, or null for a run nobody resumed. */
export function readResumeInfo(trigger: unknown): ResumeInfo | null {
    if (typeof trigger !== 'object' || trigger === null) return null;
    const resume = (trigger as { resume?: unknown }).resume;
    if (typeof resume !== 'object' || resume === null) return null;
    const r = resume as Record<string, unknown>;
    if (
        typeof r.rootRunId !== 'string' ||
        typeof r.previousRunId !== 'string' ||
        typeof r.count !== 'number' ||
        !Number.isInteger(r.count) ||
        r.count < 1
    ) {
        return null;
    }
    return {
        rootRunId: r.rootRunId,
        previousRunId: r.previousRunId,
        count: r.count,
        max: typeof r.max === 'number' ? r.max : RESUME_MAX,
    };
}

/** True when a run of this task, started by this trigger, may be resumed at all. */
export function isResumableRun(task: { resumeAfterRestart?: boolean }, trigger: unknown): boolean {
    if (task.resumeAfterRestart !== true) return false;
    if (typeof trigger !== 'object' || trigger === null) return false;
    return (trigger as { kind?: unknown }).kind === 'manual';
}

export type ResumeOutcome =
    /** Not a candidate at all — today's reclaim behaviour, untouched. */
    'not-applicable' | 'resume' | 'cancelled' | 'crashed' | 'exhausted' | 'crash-loop';

export interface ResumeDecisionInput {
    task: { resumeAfterRestart?: boolean } | undefined;
    state: 'active' | 'cancelling' | 'pending';
    trigger: unknown;
    cancelRequestedAt: Date | null;
    startedAt: Date | null;
    /** The shutdown marker the runner wrote after the handler unwound. */
    gracefulShutdown: boolean;
    /**
     * How long the interrupted run's handler actually executed (from the
     * marker). Null when unknown — then `now - startedAt` is used.
     */
    executedMs?: number | null;
    now: Date;
}

export interface ResumeDecision {
    outcome: ResumeOutcome;
    /** Resumes already made in this chain (0 for the original run). */
    previousCount: number;
}

export function decideResume(input: ResumeDecisionInput): ResumeDecision {
    const info = readResumeInfo(input.trigger);
    // A run that carries a resume block we cannot read is treated as having
    // used every resume: a corrupt count must never reset the cap to 0.
    const hasResumeBlock =
        typeof input.trigger === 'object' &&
        input.trigger !== null &&
        (input.trigger as { resume?: unknown }).resume !== undefined &&
        (input.trigger as { resume?: unknown }).resume !== null;
    const previousCount = info?.count ?? (hasResumeBlock ? RESUME_MAX : 0);
    const na: ResumeDecision = { outcome: 'not-applicable', previousCount };
    if (!input.task || !isResumableRun(input.task, input.trigger)) return na;
    // A pending run never started its work; a cancelling one is being stopped
    // on purpose. Only an interrupted ACTIVE run is a resume candidate.
    if (input.state === 'pending') return na;
    if (input.state === 'cancelling' || input.cancelRequestedAt !== null) {
        return { outcome: 'cancelled', previousCount };
    }
    if (!input.gracefulShutdown) return { outcome: 'crashed', previousCount };
    if (previousCount >= RESUME_MAX) return { outcome: 'exhausted', previousCount };
    if (info) {
        const lived =
            typeof input.executedMs === 'number' && Number.isFinite(input.executedMs)
                ? input.executedMs
                : input.startedAt
                  ? input.now.getTime() - input.startedAt.getTime()
                  : 0;
        if (lived < RESUME_CRASH_LOOP_WINDOW_MS) {
            return { outcome: 'crash-loop', previousCount };
        }
    }
    return { outcome: 'resume', previousCount };
}

/**
 * The error message recorded on the interrupted run. Messages of runs that go
 * on (resumed) keep the `orphaned_at_recovery` prefix so failure counts keep
 * treating them as infrastructure churn (`task-failure.fragments.ts` matches
 * `%orphan%_at_recovery%`); a run that ends here gets a plain sentence that
 * does count, because the operator's work did not finish.
 * `run-error-display.ts` parses these — keep the wording in sync.
 */
export function resumeErrorMessage(
    outcome: Exclude<ResumeOutcome, 'not-applicable' | 'cancelled'>,
    details: { resumedAs?: string; count?: number; reason?: string } = {},
): string {
    switch (outcome) {
        case 'resume':
            return `orphaned_at_recovery: interrupted by a restart, resumed as ${details.resumedAs ?? '?'} (${details.count ?? '?'}/${RESUME_MAX})`;
        case 'exhausted':
            return `Stopped after ${RESUME_MAX} restarts: resume limit reached`;
        case 'crash-loop':
            return `Not resumed: interrupted again within ${RESUME_CRASH_LOOP_WINDOW_MS / 60000} min of its last resume (crash loop)`;
        case 'crashed':
            return 'Not resumed: the worker stopped unexpectedly while this run was active';
    }
}

export function resumeStartFailedMessage(reason: string): string {
    return `Not resumed: the resumed run could not be started (${reason})`;
}

/** Valkey-backed `ctx.checkpoint` for one resume chain. */
export function buildRunCheckpoint(
    getClient: () => ValkeyLike,
    rootRunId: string,
    logger: { warn(msg: string, meta?: object): void },
): {
    load<T = unknown>(): Promise<T | null>;
    save(value: unknown): Promise<void>;
} {
    const key = checkpointKey(rootRunId);
    return {
        async load<T>(): Promise<T | null> {
            try {
                const raw = await getClient().customCommand(['GET', key]);
                if (typeof raw !== 'string' || raw.length === 0) return null;
                return JSON.parse(raw) as T;
            } catch (err) {
                logger.warn('checkpoint load failed; starting from the beginning', {
                    rootRunId,
                    err: err instanceof Error ? err.message : String(err),
                });
                return null;
            }
        },
        async save(value: unknown): Promise<void> {
            try {
                const raw = JSON.stringify(value ?? null);
                if (Buffer.byteLength(raw, 'utf8') > CHECKPOINT_MAX_BYTES) {
                    logger.warn('checkpoint too large; not saved', {
                        rootRunId,
                        bytes: Buffer.byteLength(raw, 'utf8'),
                        max: CHECKPOINT_MAX_BYTES,
                    });
                    return;
                }
                await getClient().customCommand(['SET', key, raw, 'PX', String(CHECKPOINT_TTL_MS)]);
            } catch (err) {
                logger.warn('checkpoint save failed', {
                    rootRunId,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        },
    };
}

/** Best-effort DEL of a chain's checkpoint once nothing will read it again. */
export async function clearCheckpoint(client: ValkeyLike, rootRunId: string): Promise<void> {
    try {
        await client.customCommand(['DEL', checkpointKey(rootRunId)]);
    } catch (err) {
        log.warn('checkpoint clear failed (expires on its own)', {
            rootRunId,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Data a resumed run's job carries so the runner knows it may be resumed. */
export interface ResumableJobData {
    rootRunId: string;
}
