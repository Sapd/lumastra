// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-item stuck-reason diagnosis (Slice 2 — Per-Item Traceability).
 *
 * `diagnoseStuckStage` is a PURE, priority-ordered function: given a single
 * stage row, its resolved run reference, and a pre-probed context bag, it
 * returns exactly one `StuckReason` (the first that matches, in priority
 * order) plus a human summary and structured detail.
 *
 * Purity is deliberate (mirrors the lane-data noise filter / `health-invariants`
 * precedent): the UI never re-derives "why stuck" from raw fields, and the
 * branch order + per-branch preconditions are unit-testable with no DB / Valkey.
 *
 * The caller (`PipelineTimelineService`) does all I/O up front — circuit reads,
 * batched Valkey identity + active-count probes — and hands the results in via
 * `ctx`. Probe unavailability is signalled with `probeUnavailable: true`, which
 * makes the Valkey-dependent branches (`identity-locked`, `backpressure`) fall
 * through to the next non-Valkey signal rather than asserting a false verdict.
 */

import type { StageStatus } from '$lib/types/pipeline.js';
import type {
    StageDiagnosis,
    StageOperatorState,
    TimelineRunRef,
} from '$lib/schemas/pipeline-timeline.schema.js';

/** Minimal stage shape the diagnosis reads — a subset of the timeline stage. */
export interface DiagnosisStageInput {
    stageId: string;
    taskId: string | null;
    status: StageStatus;
    skippedReason: string | null;
    nextEligibleAt: Date | null;
}

/** Per-task circuit snapshot (read from `task_circuit_state`, never `check()`). */
export interface CircuitProbe {
    state: 'closed' | 'open' | 'half_open';
    openedReason: string | null;
    nextProbeAt: Date | null;
}

/**
 * Per-task schedule snapshot (read from `scheduler_state`, the row a person
 * writes by pausing the task). Distinct from {@link CircuitProbe}: the circuit
 * is the system pausing ITSELF after repeated failures, this is a human having
 * switched the task off.
 */
export interface PausedProbe {
    pausedBy: string | null;
    pausedAt: Date | null;
}

/** Per-task class-depth snapshot (active-count vs the class cap). */
export interface DepthProbe {
    classDepth: number;
    cap: number;
}

/**
 * Context handed to the pure diagnosis. All I/O happens before this — the
 * function itself touches no singletons.
 */
export interface DiagnosisContext {
    /** Wall-clock "now" (injected for deterministic tests). */
    now: Date;
    /** Owning-task circuit snapshot, or null if not probed / no task. */
    circuit: CircuitProbe | null;
    /**
     * Owning-task schedule-pause snapshot, or null when the task is not paused
     * (or the probe failed / there is no task). Non-null ⇒ an admin turned this
     * step off.
     */
    paused: PausedProbe | null;
    /**
     * Identity-lock TTL in ms for the owning per-item identity key, or null
     * when the key is absent. Present ⇒ a run has claimed this identity.
     */
    identityTtlMs: number | null;
    /** Owning-task class depth vs cap, or null if not probed / no task. */
    depth: DepthProbe | null;
    /** True when the batched Valkey probes could not be read this request. */
    probeUnavailable: boolean;
}

const PREDICATE_BLOCKED_REASONS = new Set([
    // Unified eligibility skip reason (migration 16.50.0 renamed the two legacy
    // strings below to this; seed/dispose now write only this one). Legacy strings
    // kept so a pre-migration row still classifies correctly.
    'ineligible',
    'predicate-false',
    'predicate-false-on-invalidation',
    // C3 fix-round-3 (2026-09-25 security review): the `metadata-locked`
    // terminalDisposition rule (metadata-sync.ts, mdblist-sync.ts) writes this
    // exact `skipped_reason`. Without it here, a locked item's row fell
    // through to `scheduled-wait`/`none` — reading as an ordinary queue wait
    // with a 6h ETA that re-arms every time the disposition re-stamps it,
    // instead of "this item is not eligible right now".
    'metadata-locked',
]);

/**
 * The statuses the stage sweep actually claims (`findSweepCandidates`' WHERE).
 * A row outside this set is not waiting on the scheduler at all.
 */
const SWEEP_ELIGIBLE_STATUSES = new Set<StageStatus>([
    'pending',
    'failed_transient',
    'skipped_transient',
    'obsolete',
]);

function fmtTime(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Priority order (first match wins):
 *   1. running-healthy   — running AND its run is alive (NOT stuck; checked
 *                          first so a live active run is never mislabelled).
 *   2. orphaned-stage    — no task owns the stage id.
 *   3. worker-dead       — running but the owning run's heartbeat is stale.
 *   4. schedule-paused   — an admin turned the owning task off.
 *   5. circuit-open      — owning task's breaker is open.
 *   6. identity-locked   — identity key held but no live run owns this stage.
 *   7. backpressure      — owning task's class depth ≥ cap.
 *   8. predicate-blocked — skipped_reason is a predicate-false marker.
 *   9. scheduled-wait    — next_eligible_at is in the future.
 *  10. none              — nothing blocking; normal queue wait.
 *
 * Cross-precedence notes from the spec §7:
 *   - worker-dead before scheduled-wait (a dead running worker outranks a
 *     future next_eligible_at).
 *   - circuit-open before backpressure.
 *   - schedule-paused before circuit-open, mirroring `readTaskState`'s worst-of
 *     ordering (paused > open > half_open > active): a deliberate human "off"
 *     is the more actionable of the two, and the one an operator can undo from
 *     this row.
 */
export function diagnoseStuckStage(
    stage: DiagnosisStageInput,
    runRef: TimelineRunRef | null,
    ctx: DiagnosisContext,
): StageDiagnosis {
    const { now } = ctx;
    const runAlive = runRef?.alive === true;

    // 1. running-healthy — a live active run is actively processing.
    if (stage.status === 'running' && runAlive) {
        return {
            reason: 'running-healthy',
            summary: `Actively processing (run ${runRef?.runId ?? 'unknown'} alive).`,
            detail: runRef ? { runId: runRef.runId } : {},
            remediable: false,
        };
    }

    // 2. orphaned-stage — no task owns this stage id; nothing will ever pick it.
    if (stage.taskId === null) {
        return {
            reason: 'orphaned-stage',
            summary: `No registered task owns stage "${stage.stageId}"; it will never be picked up.`,
            detail: { stageId: stage.stageId },
            remediable: false,
        };
    }

    // 3. worker-dead — running but its run is not alive (stale heartbeat).
    if (stage.status === 'running' && !runAlive) {
        return {
            reason: 'worker-dead',
            summary:
                `Run ${runRef?.runId ?? '(none)'} is no longer alive (stale heartbeat); ` +
                `the reconciler will reclaim this stage.`,
            detail: {
                runId: runRef?.runId ?? null,
                runState: runRef?.state ?? null,
                heartbeatAt: runRef?.heartbeatAt ?? null,
            },
            // The reconciler self-heals wedged-running rows; an admin retry
            // does not apply to a row still marked running.
            remediable: false,
        };
    }

    // 4. schedule-paused — a person switched the owning task off. Only the
    //    sweep-eligible statuses can be blocked by this: the stage sweep is what
    //    would pick the row up, and it is the thing the pause stops. A settled
    //    row (skipped_permanent / failed_permanent) is not waiting on the
    //    scheduler, so a pause says nothing about it.
    if (ctx.paused && SWEEP_ELIGIBLE_STATUSES.has(stage.status)) {
        return {
            reason: 'schedule-paused',
            summary:
                `This step's task is paused, so nothing will pick this item up ` +
                `until it is switched back on.`,
            detail: {
                taskId: stage.taskId,
                pausedBy: ctx.paused.pausedBy,
                pausedAt: ctx.paused.pausedAt ? ctx.paused.pausedAt.toISOString() : null,
            },
            // Resuming is a single PUT on the owning task's state — exactly the
            // affordance this row can offer, unlike the breaker's fleet action.
            remediable: true,
        };
    }

    // 4. circuit-open — the owning task's breaker is open.
    if (ctx.circuit && ctx.circuit.state === 'open') {
        const probe = ctx.circuit.nextProbeAt;
        const summary =
            `Circuit breaker open for ${stage.taskId}` +
            (ctx.circuit.openedReason ? ` (${ctx.circuit.openedReason})` : '') +
            (probe ? `; next probe ${fmtTime(probe)}.` : '.');
        return {
            reason: 'circuit-open',
            summary,
            detail: {
                taskId: stage.taskId,
                openedReason: ctx.circuit.openedReason,
                nextProbeAt: probe ? probe.toISOString() : null,
            },
            // Cleared by force-enabling the circuit (a fleet action, not this
            // per-item view) or by the breaker's own probe — not by per-item retry.
            remediable: false,
        };
    }

    // 5. identity-locked — identity key present but no live run owns this stage.
    //    A healthy active run holding its own identity key reads as
    //    running-healthy above, so reaching here means the lock is orphaned.
    if (!ctx.probeUnavailable && ctx.identityTtlMs !== null && !runAlive) {
        return {
            reason: 'identity-locked',
            summary:
                `An identity lock for ${stage.taskId} is held but no live run owns this stage; ` +
                `it clears when the lock's 24h TTL expires or the holding run completes.`,
            detail: { taskId: stage.taskId, ttlMs: ctx.identityTtlMs },
            // Re-evaluate will recompute the idempotency key; the held lock means
            // an enqueue currently dedupes, but the operator may still want to try.
            remediable: true,
        };
    }

    // 6. backpressure — the owning task's class depth has hit the cap.
    if (!ctx.probeUnavailable && ctx.depth && ctx.depth.classDepth >= ctx.depth.cap) {
        return {
            reason: 'backpressure',
            summary:
                `Resource-class queue is saturated (${ctx.depth.classDepth}/${ctx.depth.cap}); ` +
                `this item waits until depth drops.`,
            detail: { classDepth: ctx.depth.classDepth, cap: ctx.depth.cap },
            remediable: false,
        };
    }

    // 7. predicate-blocked — eligibility predicate returned false.
    if (stage.skippedReason && PREDICATE_BLOCKED_REASONS.has(stage.skippedReason)) {
        return {
            reason: 'predicate-blocked',
            summary:
                `Skipped: the stage's eligibility predicate is currently false ` +
                `(${stage.skippedReason}). Re-evaluate if the item now qualifies.`,
            detail: { skippedReason: stage.skippedReason },
            // Force re-evaluate re-runs the predicate and enqueues if now eligible.
            remediable: true,
        };
    }

    // 8. scheduled-wait — backoff / schedule window not yet elapsed.
    if (stage.nextEligibleAt && stage.nextEligibleAt.getTime() > now.getTime()) {
        return {
            reason: 'scheduled-wait',
            summary: `Waiting for retry backoff; eligible after ${fmtTime(stage.nextEligibleAt)}.`,
            detail: { eligibleAfter: stage.nextEligibleAt.toISOString() },
            remediable: false,
        };
    }

    // 9. none — pending & eligible & nothing blocking: normal queue wait.
    const detail: Record<string, unknown> = {};
    if (ctx.probeUnavailable) detail.probe = 'unavailable';
    return {
        reason: 'none',
        summary: 'Eligible and waiting in the normal queue; nothing is blocking it.',
        detail,
        remediable: false,
    };
}

/**
 * Fold a stage row's raw status + diagnosis into ONE of the five buckets the
 * per-item view renders. Pure, and the single place the mapping lives — the
 * timeline component cannot import this module (it is server-only), so the
 * result travels in the payload as `TimelineStage.operatorState`.
 *
 * Why five and not two: an operator reading a row as "broken" when it is
 * actually waiting, not applicable, or switched off is the single largest
 * source of false "it's broken" reports. `running` folds into `waiting` — it is
 * the same "nothing for you to do yet" bucket, and `taskStatusLabel()` still
 * distinguishes it as "In progress" on the row itself.
 *
 * A FAILED row stays `failed` even when the owning task is paused: the error is
 * the headline, and the pause is rendered as an extra note on the same row
 * rather than replacing the cause with "Off".
 */
export function stageOperatorState(
    status: StageStatus,
    diagnosis: StageDiagnosis | null,
): StageOperatorState {
    if (status === 'completed') return 'done';
    if (status === 'failed_transient' || status === 'failed_permanent') return 'failed';
    if (diagnosis?.reason === 'schedule-paused') return 'off';
    if (status === 'skipped_permanent' || status === 'obsolete') return 'skipped';
    // A `skipped_transient` row whose predicate is currently false reads as
    // "does not apply"; one skipped for any other reason is still queued work.
    if (status === 'skipped_transient') {
        return diagnosis?.reason === 'predicate-blocked' ? 'skipped' : 'waiting';
    }
    if (diagnosis?.reason === 'predicate-blocked') return 'skipped';
    return 'waiting';
}

/**
 * The stage sweep's own per-stage enqueue cap per 60s tick — mirrored from
 * `PER_STAGE_LIMIT` in `builtin/native/stage-sweep.ts` (not exported; keep in
 * sync). It is a HARD floor on any ETA: however fast the workers drain, a stage
 * cannot be handed more than this many items a minute, so an ETA computed from
 * observed throughput alone can promise a time the dispatcher cannot deliver.
 */
const SWEEP_MAX_ITEMS_PER_MINUTE = 100;

/**
 * Window used to measure a step's recent throughput. Exported so the SQL that
 * COUNTS completions and the arithmetic that DIVIDES by the window cannot drift
 * apart — a mismatch there silently scales every ETA.
 */
export const THROUGHPUT_WINDOW_MINUTES = 5;

/**
 * Estimated wall-clock wait for `itemsAhead`, from the step's own recent
 * throughput. Exported for the unit tests — the clamping is the interesting part.
 *
 * Returns null (render NO time at all, never "now") when throughput cannot be
 * observed. Both existing ETA sites in this codebase bail the same way rather
 * than dividing by zero: `computeTaskAggregates` skips when `itemsPerHour` is
 * missing, and the processing hero gates on `completed5m > 0`.
 *
 * The rate is clamped to the sweep's own per-stage enqueue ceiling. Workers can
 * momentarily drain faster than the dispatcher refills — a burst that measures
 * at 400/min still cannot be SERVED faster than 100/min, and an ETA that expires
 * without the item moving is worse than no ETA.
 */
export function estimateWaitMs(itemsAhead: number, completedInWindow: number): number | null {
    if (itemsAhead <= 0) return 0;
    const observedPerMinute = completedInWindow / THROUGHPUT_WINDOW_MINUTES;
    if (!Number.isFinite(observedPerMinute) || observedPerMinute <= 0) return null;
    const servedPerMinute = Math.min(observedPerMinute, SWEEP_MAX_ITEMS_PER_MINUTE);
    return Math.ceil(itemsAhead / servedPerMinute) * 60_000;
}
