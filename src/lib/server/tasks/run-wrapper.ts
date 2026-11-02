// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Run-wrapper for pipeline-coverage stage state transitions.
 *
 * Wraps a task's `execute()` invocation so that:
 *   1. The corresponding row in `media_item_stage_state` flips to `'running'`
 *      before `inner()` runs.
 *   2. On success → `'completed'`.
 *   3. On retryable failure within the retry budget → `'failed_transient'`
 *      with a backoff window.
 *   4. On non-retryable failure or exhausted retries → `'failed_permanent'`.
 *
 * Invariants:
 *   - The original error thrown by `inner` always propagates unchanged.
 *   - If the failure-recording SQL itself throws, it is logged but does NOT
 *     swallow the original error (the original error still rethrows).
 *
 * BullMQ-level retry mechanics are unchanged — this wrapper just records
 * coverage transitions around whatever the existing runner already does.
 */

import type postgres from 'postgres';
import { AuthorityError, type AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withExistingTaskWrite } from '../../../task-runtime/authority/existing-write.js';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import type { StageRetryPolicy, StageErrorDetail } from '$lib/types/pipeline.js';
import {
    upsertRunningRow,
    markCompleted,
    markFailedTransient,
    markFailedPermanent,
    resetRunningToPending,
    lockRunningStageForDisposition,
    markRunSkippedPermanent,
} from '$lib/server/database/queries/stage-state.queries.js';
import { markFailureEventsResolved } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { ALERT_FLOOR } from '$lib/server/tasks/decline-loop.js';
import { Logger } from '$lib/server/utils/logger.js';
import { publishStageStateChange } from '$lib/server/cache/pipeline-pubsub.js';

const log = Logger.for('run-wrapper');

/**
 * Stable sentinel for the media-item deletion race. A media-item-scoped run can
 * be enqueued, then have its media_item deleted before it executes; the very
 * first thing the wrapper does — seed the `media_item_stage_state` row — then
 * FK-violates on `media_item_stage_state_media_item_id_fkey`. The work is moot
 * (its subject is gone, and its stage rows were cascade-deleted with it), so we
 * record a permanent skip with THIS exact message rather than letting an opaque
 * Postgres FK error count as an actionable task failure. The message is excluded
 * by `actionableTaskFailure()` in task-failure.fragments.ts — and it can NEVER
 * "recover" (the item won't come back), so it must be excluded by message, not
 * by the later-success rule. Keep the two in sync.
 */
export const MEDIA_ITEM_DELETED_BEFORE_RUN = 'media_item_deleted_before_run';

/** True iff `err` is the FK violation from seeding stage_state for a now-deleted media_item. */
function isMediaItemDeletedRace(err: unknown): boolean {
    const e = err as { code?: string; constraint_name?: string } | null;
    return (
        !!e &&
        e.code === '23503' &&
        e.constraint_name === 'media_item_stage_state_media_item_id_fkey'
    );
}

/** Internal native-task request; consumed only with success:false by the stage wrapper. */
export interface StageSkipDisposition {
    status: 'skipped_permanent';
    reason: string;
}

export interface WrapExecuteOptions<TResult> {
    sql: postgres.Sql;
    /** Authority captured for this invocation; never refreshed after inner executes. */
    authority?: AuthorityToken;
    /** Cancellation must be rechecked after a blocked terminal-write lock. */
    signal?: AbortSignal;
    stageId: string;
    /**
     * The TASK's id, which is what `plugin_failure_events.plugin_id` holds.
     * Distinct from `stageId`: a multi-stage task's stage is spelled
     * `<taskId>:<stage>` (`lumastra-intro-analyzer:visual`), so the stage id
     * cannot be used to look those rows up.
     */
    pluginId: string;
    mediaItemId: string;
    runId: string;
    /**
     * Task's declared `processingVersion`. Used by `upsertRunningRow` to
     * stamp a freshly-seeded row when no `media_item_stage_state` row exists
     * for `(mediaItemId, stageId)` yet (pre-migration items, inference-missed
     * items, items not yet processed by `afterCreated`).
     */
    processingVersion: number;
    inner: () => Promise<TResult>;
    /** From TaskDefinition.coversStages[].retryPolicy — defaults applied here. */
    retryPolicy?: StageRetryPolicy;
    /** Stop any remaining queue retries when the durable stage budget is spent. */
    onRetryExhausted?: () => void;
    /**
     * 1-indexed current attempt. Typically BullMQ's `job.attemptsMade + 1`.
     *
     * NOTE: this counter is PER BULLMQ JOB. Stage-sweep retries enqueue a
     * FRESH job (fresh run) per cycle, so `attemptsMade` is 0 and this is 1 on
     * every sweep-driven retry. The wrapper therefore combines it with the
     * stage row's durable `attempt` column (returned by `upsertRunningRow`)
     * before computing backoff/exhaustion — otherwise a perpetually-failing
     * item retries on a FLAT `initialDelayMs` forever and NEVER dead-letters
     * (observed in prod: provider-artwork `write-path-failed` items at
     * attempt 14 still retrying every 60s, feeding the task's circuit
     * breaker an endless stream of consecutive failures).
     */
    currentAttempt: number;
    /**
     * Optional error classifier (typically `(err) => classifyError(err, task)`
     * from the runner). Returns `'permanent'` or `'fatal'` for errors that
     * should NOT be retried. Without this, errors like TMDB 404 — thrown
     * without a `.retryable: false` flag — get classified as transient and
     * cycle forever (the stage-state row keeps flipping failed_transient →
     * pending on every stage-sweep). With it, the wrapper mirrors the
     * runner's task_history `kind` classification so a permanent error
     * lands in `failed_permanent` on the very first attempt.
     */
    classify?: (err: Error) => 'transient' | 'permanent' | 'fatal';
}

/**
 * Runtime defaults applied when a `StageRetryPolicy` leaves a field unset.
 * These mirror the contract documented on `StageRetryPolicy` in
 * `src/lib/types/pipeline.ts`.
 */
const DEFAULTS: Required<StageRetryPolicy> = {
    maxAttempts: 10,
    backoff: 'exponential',
    initialDelayMs: 30_000,
    maxDelayMs: 3_600_000,
    skipTransientAfterMs: 30_000,
};

function computeBackoff(policy: Required<StageRetryPolicy>, attempt: number): number {
    if (policy.backoff === 'fixed') {
        return Math.min(policy.initialDelayMs, policy.maxDelayMs);
    }
    // Exponential: initialDelayMs * 2^(attempt-1), capped at maxDelayMs.
    // `attempt` is 1-indexed, so attempt 1 → 2^0 = initialDelayMs.
    const exp = Math.max(0, attempt - 1);
    const delay = policy.initialDelayMs * Math.pow(2, exp);
    return Math.min(delay, policy.maxDelayMs);
}

/**
 * Best-effort human reason for a `permanent: true` result, so the stored
 * `last_error` says WHY the item was written off rather than just that it was.
 */
function permanentFailureMessage(result: unknown): string {
    const err = (result as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim() !== '') return err;
    return 'Task reported a permanent failure';
}

/**
 * Best-effort upstream HTTP status off an arbitrary thrown value.
 *
 * Deliberately structural rather than instanceof-based: these errors arrive from
 * plugin code, vendor SDKs and hand-rolled fetch wrappers, and the field is spelled
 * at least three ways in this codebase alone. Reading none of them — which is what
 * happened before — makes a 404, a 429 and a 500 indistinguishable on the stored
 * row forever.
 */
function httpStatusOf(err: unknown): number | undefined {
    if (err === null || typeof err !== 'object') return undefined;
    const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
    for (const v of [e.status, e.statusCode, e.response?.status]) {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599) return v;
    }
    return undefined;
}

export async function wrapExecute<TResult>(opts: WrapExecuteOptions<TResult>): Promise<TResult> {
    const authority =
        opts.authority === undefined ? undefined : Object.freeze({ ...opts.authority });
    const write = <T>(
        mutate: (sql: postgres.Sql | postgres.TransactionSql) => Promise<T>,
    ): Promise<T> => withExistingTaskWrite(opts.sql, authority, mutate);
    const merged = { ...DEFAULTS, ...(opts.retryPolicy ?? {}) };
    // P1-5: clamp `maxAttempts` to ≥1. A caller passing `0` (or any non-positive
    // value) would otherwise classify the very first attempt as exhausted and
    // write `failed_permanent` on a transient error — turning every retryable
    // failure into an unrecoverable one. Clamping preserves the at-least-one-
    // try contract regardless of how the policy was authored.
    const policy: Required<StageRetryPolicy> = {
        ...merged,
        maxAttempts: Math.max(1, merged.maxAttempts),
    };

    // P1-1: use the upsert. `markRunning` silently no-ops when no row exists
    // for `(mediaItemId, stageId)` — and in production that happens for
    // pre-migration items, items missed by inference, and items not yet
    // through `afterCreated`. The upsert also implements P1-4 (concurrent
    // delivery): if a different runId already owns a 'running' row, that
    // ownership is preserved.
    //
    // `priorAttempts` is the stage row's durable failed-attempt counter
    // (`media_item_stage_state.attempt`), captured at claim time. It is the
    // ONLY attempt counter that survives across sweep-enqueued retries —
    // BullMQ's `attemptsMade` (feeding `opts.currentAttempt`) resets to 0 on
    // each fresh job the sweeper enqueues.
    let priorAttempts: number;
    try {
        const claimed = await write((sql) =>
            upsertRunningRow(sql, {
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                processingVersion: opts.processingVersion,
                runId: opts.runId,
            }),
        );
        priorAttempts = claimed.attempt;
    } catch (err) {
        if (isMediaItemDeletedRace(err)) {
            // Deletion race: the media_item was removed between enqueue and
            // execute. Nothing to do — skip permanently (won't recover) with a
            // recognized, non-actionable sentinel instead of an opaque FK error.
            log.info('media_item deleted before stage run — recording permanent skip', {
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                runId: opts.runId,
            });
            throw new TaskError({
                message: MEDIA_ITEM_DELETED_BEFORE_RUN,
                kind: 'permanent',
                cause: err,
            });
        }
        throw err;
    }
    await publishStageStateChange({
        kind: 'transition',
        mediaItemId: opts.mediaItemId,
        stageId: opts.stageId,
        newStatus: 'running',
        processingVersion: opts.processingVersion,
        runId: opts.runId,
        timestamp: new Date().toISOString(),
    });

    let result: TResult;
    try {
        result = await opts.inner();
    } catch (err) {
        const e = err as Error & {
            remediation?: 'identity' | 'operational';
            retryable?: boolean;
            code?: string;
            name?: string;
            kind?: 'transient' | 'permanent' | 'fatal';
        };

        // P1-3: cancellation detection. When BullMQ aborts the job mid-execute
        // the AbortError propagates through `inner` into this catch. Writing
        // `failed_transient`/`failed_permanent` here would diverge from the
        // runner's outer cancel handler (which writes the run as `cancelled`).
        // We re-throw without writing a stage-state row — the row stays at
        // `'running'` until the boot reaper or the next dispatch picks it up.
        const isCancellation =
            e.name === 'AbortError' ||
            e.name === 'CancelError' ||
            e.code === 'CANCELLED' ||
            (typeof e.message === 'string' && /cancel/i.test(e.message));
        if (isCancellation) {
            throw err;
        }

        // Decide retryability with the same precedence the runner uses for
        // task_history.error.kind. Without this, plain Errors thrown by a
        // dependency (e.g. TmdbApiError 404) flow through `.retryable !== false`
        // → `true` and the stage row keeps cycling failed_transient → pending →
        // failed_transient forever.
        //
        // The VERDICT and WHO REACHED IT are both recorded on the row, not just
        // the boolean they collapse to. `retryable` alone cannot distinguish
        // permanent from fatal and says nothing about how the decision was made,
        // so a misclassification is invisible after the fact: a 429 burst during
        // a first scan once turned every headline health metric red because 429
        // fell through `classifyError`'s chain to the DEFAULT and was written off
        // as permanent — and nothing on the row said "no rule matched this".
        let retryable: boolean;
        let kind: StageErrorDetail['kind'];
        let decidedBy: StageErrorDetail['decidedBy'];
        const isPermanentKind =
            e.name === 'TaskError' && (e.kind === 'permanent' || e.kind === 'fatal');
        if (isPermanentKind) {
            retryable = false;
            kind = e.kind === 'fatal' ? 'fatal' : 'permanent';
            decidedBy = 'task-error-kind';
        } else if (e.retryable === false) {
            retryable = false;
            kind = 'permanent';
            decidedBy = 'retryable-flag';
        } else if (opts.classify) {
            try {
                const verdict = opts.classify(e);
                retryable = verdict === 'transient';
                kind = verdict;
                decidedBy = 'classifier';
            } catch {
                // Predicate threw — match classifyError's behaviour and treat
                // as permanent rather than re-cycling on a misbehaving rule.
                retryable = false;
                kind = 'permanent';
                decidedBy = 'classifier-threw';
            }
        } else {
            retryable = true;
            kind = 'transient';
            decidedBy = 'default';
        }
        const status = httpStatusOf(e);
        // Effective attempt = max(per-job attempt, durable per-row attempt + 1).
        // The durable column counts PRIOR failed attempts, so "this" failure is
        // attempt `priorAttempts + 1`. Taking the max keeps BullMQ-native
        // in-job retries (where `attemptsMade` genuinely grows) working while
        // fixing the sweep-retry path (where it is always 1). Without this, a
        // permanently-broken item never exhausts `maxAttempts` (never
        // dead-letters to failed_permanent) and its backoff never grows past
        // `initialDelayMs` — in a lane whose remaining backlog is mostly such
        // items, the resulting 100%-failure candidate stream trips the task's
        // circuit breaker on every half-open probe, wedging the lane forever.
        const effectiveAttempt = Math.max(opts.currentAttempt, priorAttempts + 1);
        const exhausted = effectiveAttempt >= policy.maxAttempts;
        if (retryable && exhausted) opts.onRetryExhausted?.();

        try {
            // P1-6: pass `runId` so the terminal-state UPDATE no-ops if a
            // concurrent run already owns the row. Without the guard, a run
            // that LOST the `upsertRunningRow` race would still overwrite
            // the WINNER's status when its `inner()` eventually fails —
            // diverging the audit trail from the recorded owner.
            if (retryable && !exhausted) {
                await write((sql) =>
                    markFailedTransient(sql, {
                        mediaItemId: opts.mediaItemId,
                        stageId: opts.stageId,
                        runId: opts.runId,
                        error: {
                            message: e.message,
                            remediation: e.remediation,
                            code: e.code,
                            retryable: true,
                            kind,
                            decidedBy,
                            ...(status === undefined ? {} : { status }),
                        },
                        backoffMs: computeBackoff(policy, effectiveAttempt),
                    }),
                );
                await publishStageStateChange({
                    kind: 'transition',
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    oldStatus: 'running',
                    newStatus: 'failed_transient',
                    processingVersion: opts.processingVersion,
                    runId: opts.runId,
                    timestamp: new Date().toISOString(),
                });
            } else {
                await write((sql) =>
                    markFailedPermanent(sql, {
                        mediaItemId: opts.mediaItemId,
                        stageId: opts.stageId,
                        runId: opts.runId,
                        error: {
                            message: e.message,
                            remediation: e.remediation,
                            code: e.code,
                            retryable,
                            kind,
                            decidedBy,
                            ...(status === undefined ? {} : { status }),
                        },
                    }),
                );
                await publishStageStateChange({
                    kind: 'transition',
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    oldStatus: 'running',
                    newStatus: 'failed_permanent',
                    processingVersion: opts.processingVersion,
                    runId: opts.runId,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch (dbErr) {
            // Don't swallow the original error if writing the failure also fails.
            // We log loudly so a DB write outage is visible, then rethrow the
            // ORIGINAL error from the inner execution.
            log.error('Failed to record stage failure state', dbErr as Error, {
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                originalError: e.message,
            });
        }
        throw err;
    }

    // Success path: inner returned successfully. Only claim `'completed'`
    // coverage when the result doesn't explicitly say otherwise.
    //
    // BUG FIX: this block used to run unconditionally for ANY non-throwing
    // return, which silently defeated the anti-false-coverage guards several
    // per-item tasks build on purpose (series-sync / image-sync /
    // trickplay-generation in media-item-tasks.ts — see the "The League"
    // incident comment on series-sync's execute()). Those tasks return
    // `{ success: false, ... }` WITHOUT throwing — e.g. when the run was
    // aborted mid-flight, or TMDB returned zero episodes — specifically so
    // the coverage row does NOT get marked completed. Honour that: gate the
    // auto-`markCompleted` on `result.success !== false`.
    //
    // Disposition choice on success:false: skip markCompleted (no task-authored
    // completion) AND actively reset the row from `'running'` back to
    // `'pending'` instead of leaving it exactly where `upsertRunningRow` put
    // it. `resetRunningToPending` is scoped by `runId` (same "keep, don't
    // clobber the winner" guard as markCompleted/markFailed*), so it never
    // touches `attempt` — declining to run this cycle is not a failed
    // attempt.
    //
    // A `'running'` row left un-reset survives until
    // `reclaimWedgedRunningStageRows` reclassifies it as `failed_transient`
    // after a 10-minute age gate. For a task whose `success:false` signals a
    // ROUTINE global block (an hourly rate cap, a disk-headroom guard) rather
    // than a rare aborted-run edge case, that reclassification fires on every
    // single run and produces a steady stream of false `failed_transient`
    // rows with no real failure behind them. Resetting to `'pending'`
    // immediately makes the row sweepable again on the very next drain tick
    // and never enters that path.
    const isExplicitFailure =
        typeof result === 'object' &&
        result !== null &&
        (result as { success?: unknown }).success === false;

    // Native tasks can request a prerequisite skip without writing stage SQL
    // themselves. The wrapper retains the original authority and row owner,
    // rechecks cancellation after row-lock waits, and publishes only committed
    // transitions. Never upsert here: a reset/deletion/new owner makes this
    // continuation stale, even when it still holds task execution authority.
    const disposition = (result as { stageDisposition?: unknown } | null)?.stageDisposition;
    if (
        isExplicitFailure &&
        disposition !== null &&
        typeof disposition === 'object' &&
        'status' in disposition &&
        disposition.status === 'skipped_permanent' &&
        'reason' in disposition &&
        typeof disposition.reason === 'string' &&
        disposition.reason.trim()
    ) {
        const reason = disposition.reason;
        const written = await write(async (tx) => {
            const input = {
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                runId: opts.runId,
            };
            const eligible = await lockRunningStageForDisposition(tx, input);
            opts.signal?.throwIfAborted();
            if (!eligible) return 0;
            const count = await markRunSkippedPermanent(tx, { ...input, reason });
            opts.signal?.throwIfAborted();
            return count;
        });
        if (written > 0) {
            await publishStageStateChange({
                kind: 'transition',
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                oldStatus: 'running',
                newStatus: 'skipped_permanent',
                processingVersion: opts.processingVersion,
                runId: opts.runId,
                timestamp: new Date().toISOString(),
            }).catch((err: unknown) => {
                log.warn('Prerequisite skip committed, but its event did not publish', {
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
            return result;
        }
    }

    // Opt-in escape hatch from the reset-to-pending disposition above: a task
    // that KNOWS re-running cannot change the answer (an unreadable media
    // container, not a rate cap) returns `permanent: true` alongside
    // `success: false`. Without it such an item re-drains on every sweep tick
    // forever — trickplay-generation spent 2026-08-19/20 doing exactly that,
    // holding both worker slots and zeroing the stage's visible throughput.
    const isPermanentFailure =
        isExplicitFailure && (result as { permanent?: unknown }).permanent === true;

    if (isPermanentFailure) {
        // The DB write and the event publish get their OWN try blocks. Sharing
        // one meant a failed publish — an observer concern — logged "row remains
        // running" even though the row had in fact been marked, sending whoever
        // read that log after the wrong thing entirely.
        let markedPermanent = false;
        try {
            await write((sql) =>
                markFailedPermanent(sql, {
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    runId: opts.runId,
                    error: {
                        message: permanentFailureMessage(result),
                        retryable: false,
                        remediation: (result as { remediation?: 'identity' | 'operational' })
                            .remediation,
                    },
                }),
            );
            markedPermanent = true;
        } catch (dbErr) {
            // Deliberately NOT falling back to resetRunningToPending: that is
            // the retry loop this branch exists to keep the item out of. The row
            // stays `running` until the wedged-row reclaimer reaches it, which
            // reclassifies it as failed_transient — so a genuinely unreadable
            // file does get one more pass. That is the lesser evil, and it is
            // rare (this only fires when the DB write itself failed), but it is
            // the residual hole in the permanent-failure path.
            if (dbErr instanceof AuthorityError) throw dbErr;
            log.error(
                'Failed to mark stage failed_permanent after permanent success:false; row remains running and the reclaimer will treat it as transient.',
                dbErr as Error,
                {
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    runId: opts.runId,
                },
            );
        }

        if (markedPermanent) {
            try {
                await publishStageStateChange({
                    kind: 'transition',
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    oldStatus: 'running',
                    newStatus: 'failed_permanent',
                    processingVersion: opts.processingVersion,
                    runId: opts.runId,
                    timestamp: new Date().toISOString(),
                });
            } catch (evtErr) {
                log.warn('Stage marked failed_permanent, but its event did not publish', {
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    runId: opts.runId,
                    error: evtErr instanceof Error ? evtErr.message : String(evtErr),
                });
            }
        }
        log.warn('inner() reported a PERMANENT failure — stage row marked failed_permanent', {
            mediaItemId: opts.mediaItemId,
            stageId: opts.stageId,
            runId: opts.runId,
        });
        return result;
    }

    if (isExplicitFailure) {
        try {
            const declined = await write((sql) =>
                resetRunningToPending(sql, {
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    runId: opts.runId,
                }),
            );
            // Equality, not `>=`: the guards on the UPDATE make the increment
            // single-writer, so the row passes through each value exactly once
            // and this fires once per streak with no process-level dedupe set.
            // Past this point the row is backed off and may not be picked again
            // on a busy stage — the attention derive, which keys on streak AGE
            // rather than count, is what actually reports it.
            if (declined.declines === ALERT_FLOOR) {
                log.warn(
                    'Stage row has declined without progressing and is now backing off — see the decline-loop attention alert if it persists',
                    {
                        mediaItemId: opts.mediaItemId,
                        stageId: opts.stageId,
                        runId: opts.runId,
                        declines: declined.declines,
                    },
                );
            }
            if (declined.count > 0) {
                await publishStageStateChange({
                    kind: 'transition',
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    oldStatus: 'running',
                    newStatus: 'pending',
                    processingVersion: opts.processingVersion,
                    runId: opts.runId,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch (dbErr) {
            if (dbErr instanceof AuthorityError) throw dbErr;
            log.error(
                'Failed to reset stage row to pending after success:false; row remains running.',
                dbErr as Error,
                {
                    mediaItemId: opts.mediaItemId,
                    stageId: opts.stageId,
                    runId: opts.runId,
                },
            );
        }
        const skipped = (result as { stopReason?: unknown }).stopReason === 'skipped';
        const details = (result as { result?: { reason?: unknown } }).result;
        const reason = typeof details?.reason === 'string' ? details.reason : undefined;
        const metadata = {
            mediaItemId: opts.mediaItemId,
            stageId: opts.stageId,
            runId: opts.runId,
            ...(reason ? { reason } : {}),
        };
        if (skipped) {
            log.debug('Stage skipped — no completed coverage claimed', metadata);
        } else {
            log.warn('inner() returned success:false — no completed coverage claimed', metadata);
        }
        return result;
    }

    if (opts.pluginId === 'lumastra-intro-analyzer') {
        // The analyzer commits coverage and lineage together under its source lock.
        // A generic terminal write here could complete a replacement after that fence.
        return result;
    }

    // P1-2: if `markCompleted` itself throws (DB outage, network blip), we
    // log loudly but RETURN THE INNER'S RESULT anyway. Re-throwing would
    // signal a false BullMQ failure and trigger a retry of an expensive task
    // that already succeeded. A stale coverage row stuck at `'running'` is
    // strictly less harmful — the boot reaper / next dispatch will reconcile.
    try {
        await write(async (sql) => {
            await markCompleted(sql, {
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                // P1-6: scope completion to the run that actually claimed the row.
                // If a concurrent run won `upsertRunningRow`, this update is a
                // no-op rather than a status clobber.
                runId: opts.runId,
            });
            // The item worked, so whatever this task said about it before is
            // history. `plugin_failure_events` is append-only and, until this
            // call existed, the ONLY thing that ever stamped `resolved_at` was an
            // operator clicking Retry on one item — so a transient ffmpeg timeout
            // in June was still asking for attention in September. Prod
            // 2026-09-11: `lumastra-intro-analyzer` held 1,477 unresolved rows
            // across 580 items, 578 of which were already `completed` right here.
            //
            // Inside the same try as `markCompleted` on purpose: this is audit
            // hygiene, and P1-2's reasoning applies unchanged — an expensive task
            // that genuinely succeeded must never be re-run because a bookkeeping
            // write failed.
            await markFailureEventsResolved(sql, opts.pluginId, opts.mediaItemId);
        });
        await publishStageStateChange({
            kind: 'transition',
            mediaItemId: opts.mediaItemId,
            stageId: opts.stageId,
            oldStatus: 'running',
            newStatus: 'completed',
            processingVersion: opts.processingVersion,
            runId: opts.runId,
            timestamp: new Date().toISOString(),
        });
    } catch (dbErr) {
        if (dbErr instanceof AuthorityError) throw dbErr;
        log.error(
            'Failed to mark stage completed; row remains running. Returning result anyway.',
            dbErr as Error,
            {
                mediaItemId: opts.mediaItemId,
                stageId: opts.stageId,
                runId: opts.runId,
            },
        );
    }
    return result;
}
