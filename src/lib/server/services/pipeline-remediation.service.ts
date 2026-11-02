// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PipelineRemediationService (Slice 2 — Per-Item Traceability).
 *
 * Item-scoped, confirmed (UI-gated) remediation for a single media item's
 * pipeline. Owns the two write actions so the route holds no SQL and obeys the
 * "service-managers-for-writes" lint rule:
 *
 *   - resetFailed()  → flip `failed_permanent` rows back to `pending`
 *                      (wraps the existing `resetFailedPermanent` query).
 *   - reevaluate()   → re-run each target stage's eligibility predicate and
 *                      eager-enqueue the now-eligible ones via the EXISTING
 *                      `StageStateService.eagerEnqueueForStages` primitive
 *                      (no hand-rolled TaskContext, no raw `queue.add`).
 *
 * Both actions are naturally idempotent: reset only touches `failed_permanent`;
 * reevaluate dedupes through the idempotency key `eagerEnqueueForStages`
 * already computes (global vs per-item). A double-click is safe.
 */

import type postgres from 'postgres';
import type { TaskRegistry } from '$lib/server/tasks/registry.js';
import { registry as defaultRegistry } from '$lib/server/tasks/registry.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    resetFailedPermanent,
    resetFailedPermanentForStage,
    releaseWedgedRunningForStage,
    skipItemStage,
    unskipItemStage,
} from '$lib/server/database/queries/stage-state.queries.js';
import { requeueAllDeadLetterEvents } from '$lib/server/database/queries/event-outbox.queries.js';
import {
    acceptReidentifyForStage,
    acceptReidentifyItem,
} from '$lib/server/database/queries/ingest-map.queries.js';
import { resetFailedSonicEmbeddingAttempts } from '$lib/server/database/queries/sonic-embeddings-admin.queries.js';
import { StageStateService } from '$lib/server/services/stage-state.service.js';
import type { MediaItemSnapshot } from '$lib/types/pipeline.js';
import type {
    PipelineReevaluateResponse,
    PipelineResetResponse,
} from '$lib/schemas/pipeline-timeline.schema.js';

const log = Logger.for('PipelineRemediationService');

export interface PipelineRemediationDeps {
    registry?: TaskRegistry;
    /** Injectable for tests; defaults to a fresh StageStateService on this sql. */
    stageStateService?: Pick<
        StageStateService,
        'eagerEnqueueForStages' | 'loadItemSnapshot' | 'applicableStages'
    >;
}

/**
 * Namespace an operator-supplied skip reason.
 *
 * `skipped_permanent` is written by two very different actors: an operator
 * deciding "I know, ignore this one", and the disposition runner deciding a
 * stage does not apply (`'ineligible'`, rule ids, …). Only the first is
 * reversible — un-skipping a system disposition sets the row `pending`,
 * stage-sweep re-evaluates eligibility and re-skips it, and the operator
 * watches their own action silently undo itself.
 *
 * Keeping the `operator-` prefix on the stored reason is what lets
 * `unskipItemStage` tell them apart, so free text is appended to the machine
 * prefix rather than replacing it. Pre-existing rows already carry the bare
 * prefixes, so they match too.
 */
function operatorReason(fixed: `operator-${string}`, free?: string): string {
    const note = free?.trim();
    return note ? `${fixed}: ${note}` : fixed;
}

export class PipelineRemediationService {
    private readonly registry: TaskRegistry;
    private readonly stageState: Pick<
        StageStateService,
        'eagerEnqueueForStages' | 'loadItemSnapshot' | 'applicableStages'
    >;

    constructor(
        private readonly sql: postgres.Sql,
        deps: PipelineRemediationDeps = {},
    ) {
        this.registry = deps.registry ?? defaultRegistry;
        this.stageState = deps.stageStateService ?? new StageStateService(this.sql, this.registry);
    }

    /**
     * Reset failed rows and automatic poison exclusions → `pending` for one item (and optionally one
     * stage). Returns the number of rows reset.
     */
    async resetFailed(mediaItemId: string, stageId?: string): Promise<PipelineResetResponse> {
        const reset = await resetFailedPermanent(this.sql, {
            mediaItemId,
            stageId,
        });
        log.info('resetFailed', {
            mediaItemId,
            stageId: stageId ?? '*',
            reset,
        });
        return { reset };
    }

    /**
     * Stage-wide: reset failed rows and automatic poison exclusions → `pending` so the
     * sweeper retries the whole dead-letter group. Stage-sweep self-throttles
     * (per-stage + global per-tick caps), so this can't re-flood. Returns rows reset.
     */
    async resetFailedForStage(stageId: string): Promise<number> {
        let reset = await resetFailedPermanentForStage(this.sql, stageId);
        // The sonic backfill is a batch task: its failures and give-up counter live in
        // media_audio_embedding_state, which the stage reset above never touches.
        if (stageId === 'sonic-embedding-backfill') {
            reset += await resetFailedSonicEmbeddingAttempts(this.sql);
        }
        log.info('resetFailedForStage', { stageId, reset });
        return reset;
    }

    /**
     * Stage-wide "accept as expected": flip a stage's PERMANENT (non-retryable)
     * dead-letters → `skipped_permanent`. The closure path for data problems a
     * retry can never fix (TMDB 404s etc.) — the alert resolves truthfully instead
     * of looping on "Retry all". Retry-exhausted transient rows are left alone.
     * `reason` is operator-supplied free text recorded as `skipped_reason`;
     * defaults to the original fixed reason when omitted (existing callers that
     * only post `{stageId}` keep their current behavior). Returns rows accepted.
     */
    async acceptReidentifyForStage(stageId: string, reason?: string): Promise<number> {
        const skippedReason = operatorReason('operator-accepted-not-on-provider', reason);
        const accepted = await acceptReidentifyForStage(this.sql, stageId, skippedReason);
        log.info('acceptReidentifyForStage', { stageId, skippedReason, accepted });
        return accepted;
    }

    /**
     * Per-item "accept as expected": accept ONE non-retryable dead-letter →
     * `skipped_permanent`. Backs the per-item verb on the re-identification queue.
     * `reason` is operator-supplied free text recorded as `skipped_reason`;
     * defaults to the original fixed reason when omitted. Returns rows accepted
     * (0 or 1 — 0 if it changed state between render and click).
     */
    async acceptReidentifyItem(
        mediaItemId: string,
        stageId: string,
        reason?: string,
    ): Promise<number> {
        const skippedReason = operatorReason('operator-accepted-not-on-provider', reason);
        const accepted = await acceptReidentifyItem(this.sql, mediaItemId, stageId, skippedReason);
        log.info('acceptReidentifyItem', { mediaItemId, stageId, skippedReason, accepted });
        return accepted;
    }

    /**
     * Stage-wide: release wedged `running` rows for a stage whose owning run is no
     * longer active (the same guard the reconciler uses every 30s — never races a
     * live worker). Recovered rows become `failed_transient` for stage-sweep to retry.
     * Returns rows released.
     */
    async releaseStuckForStage(stageId: string): Promise<number> {
        const released = await releaseWedgedRunningForStage(this.sql, stageId);
        log.info('releaseStuckForStage', { stageId, released });
        return released;
    }

    /**
     * Operator "Give up" on ONE stuck (item, stage): force it to
     * `skipped_permanent` so the stage-sweep stops retrying it. The manual
     * inverse of "Retry" for a wedged stage (e.g. a probe that keeps timing
     * out). Reversible via the normal file-content invalidation path, and via
     * {@link unignoreItem}. `reason` is operator-supplied free text recorded as
     * `skipped_reason`; defaults to the original fixed reason when omitted.
     * Returns `{ skipped }` (0 or 1).
     */
    async giveUpItem(
        mediaItemId: string,
        stageId: string,
        reason?: string,
    ): Promise<{ skipped: number }> {
        const skippedReason = operatorReason('operator-gave-up', reason);
        const skipped = await skipItemStage(this.sql, {
            mediaItemId,
            stageId,
            skippedReason,
        });
        log.info('giveUpItem', { mediaItemId, stageId, skippedReason, skipped });
        return { skipped };
    }

    /**
     * Un-ignore ONE (item, stage): the reverse of {@link giveUpItem} /
     * {@link acceptReidentifyItem}. Restores a `skipped_permanent` row to
     * `pending` so it re-enters normal stage-sweep processing. Before this verb
     * existed, the only way back from `skipped_permanent` was
     * `invalidateByEvent` firing on a content or identity change — an operator
     * who ignored the wrong item had no escape hatch from the UI. Idempotent:
     * a repeat call on an already-restored row is a no-op. Returns
     * `{ restored }` (0 or 1 — 0 if the row already changed state).
     */
    async unignoreItem(mediaItemId: string, stageId: string): Promise<{ restored: number }> {
        const restored = await unskipItemStage(this.sql, { mediaItemId, stageId });
        log.info('unignoreItem', { mediaItemId, stageId, restored });
        return { restored };
    }

    /**
     * Operator override: requeue EVERY dead-lettered pipeline event in the
     * `event_outbox`. Clears `dead_letter`, resets attempts/backoff, and resets
     * the transient-error auto-requeue budget so each parked event gets a fresh
     * full run. The dispatcher re-drains them on its next tick; ones that still
     * fail simply re-dead-letter. Idempotent — a second click requeues whatever
     * dead-lettered again in the interim (0 if none). Returns rows requeued.
     */
    async requeueDeadLetterEvents(): Promise<number> {
        const requeued = await requeueAllDeadLetterEvents(this.sql);
        log.info('requeueDeadLetterEvents', { requeued });
        return requeued;
    }

    /**
     * Force re-evaluate eligibility for one item (and optionally one stage).
     *
     * Re-runs each candidate stage's immutable `eligibility.appliesTo` predicate against the item's
     * current snapshot. Stages that are now eligible AND enqueueable are eager-enqueued via the existing
     * primitive; the rest are counted as skipped. Native stages (which gate via `eligibility.sql`, not a
     * TS predicate) have no `appliesTo` and are treated as eligible here — a manual admin override; if the
     * item is truly ineligible the sweep's dispose pass re-suppresses it. Returns `{ enqueued, skipped }`.
     */
    async reevaluate(mediaItemId: string, stageId?: string): Promise<PipelineReevaluateResponse> {
        const snap = await this.stageState.loadItemSnapshot(mediaItemId);
        if (!snap) {
            log.warn('reevaluate: media item snapshot not found', {
                mediaItemId,
            });
            return { enqueued: 0, skipped: 0 };
        }

        // Candidate stages: those whose appliesTo covers the item's media_type,
        // optionally narrowed to the one requested stage.
        const candidates = this.stageState
            .applicableStages(snap)
            .filter((s) => (stageId ? s.id === stageId : true));

        const eligibleStageIds: string[] = [];
        let skipped = 0;

        for (const stage of candidates) {
            const eligible = this.isEligible(stage.eligibility?.appliesTo, snap);
            const decl = this.registry
                .getTask(stage.taskId)
                ?.coversStages?.find((c) => c.id === stage.id);
            const enqueueable = decl?.enqueueable === true;
            if (eligible && enqueueable) {
                eligibleStageIds.push(stage.id);
            } else {
                skipped += 1;
            }
        }

        if (eligibleStageIds.length > 0) {
            // The existing primitive resolves the owning task, computes the
            // correct idempotency key (global vs per-item), and calls
            // orchestrator.startRun — building the TaskContext correctly. No
            // hand-rolled stub.
            await this.stageState.eagerEnqueueForStages(mediaItemId, eligibleStageIds);
        }

        const result = { enqueued: eligibleStageIds.length, skipped };
        log.info('reevaluate', {
            mediaItemId,
            stageId: stageId ?? '*',
            ...result,
        });
        return result;
    }

    private isEligible(
        predicate: ((item: MediaItemSnapshot) => boolean) | undefined,
        snap: MediaItemSnapshot,
    ): boolean {
        if (!predicate) return true;
        try {
            return predicate(snap);
        } catch (err) {
            // A throwing plugin predicate is treated as ineligible (mirrors
            // invalidateByEvent's per-stage trap) so one bad predicate never
            // aborts the whole remediation.
            log.warn('reevaluate: eligibility predicate threw; treating as ineligible', {
                err: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }
}
