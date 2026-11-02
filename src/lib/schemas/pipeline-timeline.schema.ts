// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pipeline timeline schemas (Slice 2 — Per-Item Traceability).
 *
 * SINGLE SOURCE OF TRUTH for the composed per-item pipeline timeline payload
 * and the two remediation response shapes. Types are derived via `z.infer`.
 *
 * Nullability rule (CLAUDE.md): prefer `.optional()`; use `.nullable()` only
 * where the database / composed service genuinely yields `null` (the row's
 * `last_error`, `completed_at`, `next_eligible_at`, the resolved `run`, the
 * `diagnosis`, and the owning `taskId` for an orphaned stage).
 */

import { z } from 'zod';
import { STAGE_STATUSES } from '$lib/types/pipeline.js';

// ── Stage status (mirrors the host enum, single-sourced from pipeline.ts) ──────

export const TimelineStageStatusSchema = z.enum(STAGE_STATUSES);

// ── Stage error detail (mirrors StageErrorDetail in pipeline.ts) ───────────────

export const StageErrorDetailSchema = z.object({
    remediation: z
        .enum(['identity', 'operational'])
        .optional()
        .describe('The operator repair needed for this failure; independent of retryability.'),
    message: z.string(),
    code: z.string().optional(),
    retryable: z.boolean().optional(),
    plugin_id: z.string().optional(),
    /**
     * The classifier's real verdict, the upstream HTTP status, and WHICH rule
     * decided. All three are written to `last_error` by the run-wrapper — and
     * were silently dropped here, because Zod strips unknown keys. So the data
     * existed and reading it still required psql.
     *
     * `decidedBy: 'default'` is the one worth surfacing: it means no rule
     * matched and the fallback chose. That is how a 429 burst was written off as
     * permanent and turned every headline health metric red, with nothing on the
     * row to say the verdict was a guess.
     *
     * Optional, mirroring `StageErrorDetail` in `types/pipeline.ts` — additive,
     * so no existing consumer changes.
     */
    kind: z.enum(['transient', 'permanent', 'fatal']).optional(),
    status: z.number().int().optional(),
    decidedBy: z
        .enum(['task-error-kind', 'retryable-flag', 'classifier', 'classifier-threw', 'default'])
        .optional(),
});

// ── Run reference (resolved last_run_id with live state) ───────────────────────

/**
 * Run states the timeline surfaces. The first six mirror the SDK
 * `RunStateSchema`; `expired` is a timeline-only synthetic state used when
 * `orchestrator.getRun` returns null (the run row was pruned) so the UI can
 * render "run record expired" instead of a dead link.
 */
export const TimelineRunStateSchema = z.enum([
    'pending',
    'active',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'expired',
]);

export const TimelineRunRefSchema = z.object({
    runId: z.string(),
    state: TimelineRunStateSchema,
    ownerInstanceId: z.string().nullable(),
    heartbeatAt: z.string().nullable(),
    startedAt: z.string().nullable(),
    /** state∈{active,cancelling} AND heartbeat within the reconciler stale threshold. */
    alive: z.boolean(),
});

// ── Stuck-reason diagnosis ─────────────────────────────────────────────────────

export const StuckReasonSchema = z.enum([
    'worker-dead',
    // An admin paused this step's owning task (`scheduler_state.paused`). Ranked
    // above `circuit-open` to match `readTaskState`'s worst-of precedence
    // (paused > open > half_open > active) — a deliberate human "off" outranks
    // the system's own auto-pause.
    'schedule-paused',
    'circuit-open',
    'identity-locked',
    'backpressure',
    'predicate-blocked',
    'scheduled-wait',
    'orphaned-stage',
    'running-healthy',
    'none',
]);

export const StageDiagnosisSchema = z.object({
    reason: StuckReasonSchema,
    /** Human one-liner, e.g. "Circuit breaker open for tmdb-metadata-sync; next probe 14:32". */
    summary: z.string(),
    /** Reason-specific structured detail. */
    detail: z.record(z.string(), z.unknown()),
    /** Whether a UI action (retry / re-evaluate) can clear this state. */
    remediable: z.boolean(),
});

// ── Operator state (the five buckets the per-item view renders) ────────────────

/**
 * The bucket an operator reads a row as. Derived server-side from `status` +
 * `diagnosis` so client and server never disagree (`pipeline-diagnosis.ts` is
 * server-only and the timeline component cannot import it).
 *
 * Deliberately FIVE, not two: roughly half of "it's broken" reports are a row
 * that is actually `waiting`, `skipped` or `off`. The labels themselves still
 * come from `taskStatusLabel()` — this is the grouping, not a new vocabulary.
 *
 *   done    — finished; the row shows WHEN, so staleness is visible
 *   failed  — a real failure; shows why + a primary action
 *   waiting — queued or backing off; shows position + ETA
 *   skipped — does not apply to this item; shows WHY it does not apply
 *   off     — an admin paused the owning task; offer to turn it back on
 */
export const StageOperatorStateSchema = z.enum(['done', 'failed', 'waiting', 'skipped', 'off']);

// ── Waiting: queue position + ETA ──────────────────────────────────────────────

/**
 * Where a pending row sits in its own queue. Only ever attached to a row whose
 * operator state is `waiting` AND whose diagnosis is a plain queue wait — a row
 * blocked by a breaker, a lock or backpressure has no meaningful position.
 */
export const StageQueueWaitSchema = z.object({
    /** Pending rows for the SAME step that the sweep claims before this one. */
    itemsAhead: z.number().int().nonnegative(),
    /**
     * True when the count hit the scan cap: `itemsAhead` is then a FLOOR, and
     * the UI must say "more than N", never a precise number it cannot support.
     */
    atLeast: z.boolean(),
    /**
     * Estimated wait in ms, or null when recent throughput for this step could
     * not be measured. Null renders as no ETA at all — never as "now".
     */
    etaMs: z.number().int().nonnegative().nullable(),
});

// ── Failed: blast radius (how many other items share this failure) ─────────────

/**
 * How widely a failure is spread. Grouped by `fingerprintError()` — the same
 * read-time normalise+hash the fleet Error Groups panel uses — so two items
 * whose messages differ only in ids/paths/timestamps count as one cause.
 *
 * This is the line that turns "my file is cursed" into "my config is wrong".
 */
export const StageBlastRadiusSchema = z.object({
    /** OTHER media items whose same step failed with the same error class. */
    otherItems: z.number().int().nonnegative(),
    /** True when the bounded scan hit its cap — `otherItems` is a floor. */
    atLeast: z.boolean(),
    /** A few of them, so the count links somewhere instead of being a dead number. */
    samples: z.array(
        z.object({
            mediaItemId: z.string(),
            title: z.string(),
        }),
    ),
});

// ── Off: the owning task's schedule is paused by a person ──────────────────────

/**
 * Present only when `scheduler_state.paused` is true for the owning task. The
 * `DISABLE_*` env killswitches are a genuinely different, non-queryable
 * mechanism (each task reads its own key inside `execute()`), so they are NOT
 * represented here — the UI mentions them in prose instead of guessing.
 */
export const StagePausedInfoSchema = z.object({
    /** Task id the resume action targets — NEVER rendered as operator copy. */
    taskId: z.string(),
    pausedBy: z.string().nullable(),
    pausedAt: z.string().nullable(),
});

// ── Timeline stage row ─────────────────────────────────────────────────────────

export const TimelineStageSchema = z.object({
    inputScope: z
        .enum(['current', 'earlier', 'unverified'])
        .optional()
        .describe('Scope of retained analyzer evidence relative to the selected current input.'),
    stageId: z.string(),
    /** registry.findTaskByStage → task.id; null when no task owns the stage. */
    taskId: z.string().nullable(),
    /**
     * The owning task's CATALOG name (registry `name`), so a step can say which
     * task it belongs to.
     *
     * A step and its task are named from different vocabularies on purpose —
     * `media-probe` is "Media File Probe" in the catalog and "Quick scan" /
     * "Deep scan" here, because those are two real stages of it. Both names are
     * right; what was missing is the link between them, which left an operator
     * reading "Quick scan failed" with nothing to search the catalog for.
     */
    taskName: z.string().nullable(),
    status: TimelineStageStatusSchema,
    evidenceStatus: TimelineStageStatusSchema.optional().describe(
        'Retained historical status when current input has no matching evidence.',
    ),
    processingVersion: z.number(),
    attempt: z.number(),
    skippedReason: z.string().nullable(),
    lastError: StageErrorDetailSchema.nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
    nextEligibleAt: z.string().nullable(),
    /** Computed: now − started_at for running, else completed − started. */
    timeInStageMs: z.number().nullable(),
    run: TimelineRunRefSchema.nullable(),
    diagnosis: StageDiagnosisSchema.nullable(),
    /** Which of the five operator buckets this row belongs to. Always present. */
    operatorState: StageOperatorStateSchema,
    /** Queue position + ETA — only on a plainly-queued `waiting` row. */
    queueWait: StageQueueWaitSchema.optional(),
    /**
     * True when "Do this one first" can honestly be offered for this row: the
     * owning task takes a `mediaItemId`, its identity varies per item, and it
     * covers exactly this one stage (so the express run actually settles THIS
     * row). Absent/false ⇒ the button is not rendered — never rendered inert.
     */
    prioritizable: z.boolean().optional(),
    /** Same-cause spread — only on a `failed` row that has a `lastError`. */
    blastRadius: StageBlastRadiusSchema.optional(),
    /** Who turned this step off and when — only on an `off` row. */
    paused: StagePausedInfoSchema.optional(),
    updatedAt: z.string(),
});

// ── Per-item event_outbox history row ──────────────────────────────────────────

export const ItemEventRowSchema = z.object({
    id: z.string(),
    eventName: z.string(),
    payload: z.record(z.string(), z.unknown()),
    attempts: z.number(),
    createdAt: z.string(),
    consumedAt: z.string().nullable(),
    nextRetryAt: z.string().nullable(),
    deadLetter: z.boolean(),
    lastError: z.string().nullable(),
});

// ── Pipeline summary (unchanged from the existing GET /pipeline) ────────────────

export const PipelineSummarySchema = z.object({
    total: z.number().int(),
    completed: z.number(),
    in_progress: z.number(),
    failed: z.number(),
    pending: z.number(),
    skipped: z.number(),
    obsolete: z.number(),
});

// ── Composed timeline response ─────────────────────────────────────────────────

export const PipelineTimelineResponseSchema = z.object({
    mediaItemId: z.string(),
    stages: z.array(TimelineStageSchema),
    events: z.array(ItemEventRowSchema),
    summary: PipelineSummarySchema,
});

// ── Remediation responses ──────────────────────────────────────────────────────

export const PipelineResetResponseSchema = z.object({
    reset: z.number(),
});

export const PipelineReevaluateResponseSchema = z.object({
    enqueued: z.number(),
    skipped: z.number(),
});

export const PipelineGiveUpResponseSchema = z.object({
    skipped: z.number(),
});

/**
 * "Do this one first" result. `started: false` is a real outcome, not an error:
 * the owning task may have become un-scopable between render and click.
 */
export const PipelinePrioritizeResponseSchema = z.object({
    started: z.boolean(),
    /** Present when a run was started or an existing one was joined. */
    runId: z.string().optional(),
    /** True when this collapsed into a run that was already queued for this item. */
    deduped: z.boolean().optional(),
    /** Machine-readable reason a run was NOT started. */
    reason: z.enum(['no-owning-task', 'not-item-scoped', 'multi-stage-task']).optional(),
});

// ── Inferred types ─────────────────────────────────────────────────────────────

export type TimelineStageStatus = z.infer<typeof TimelineStageStatusSchema>;
export type TimelineRunState = z.infer<typeof TimelineRunStateSchema>;
export type TimelineRunRef = z.infer<typeof TimelineRunRefSchema>;
export type StuckReason = z.infer<typeof StuckReasonSchema>;
export type StageDiagnosis = z.infer<typeof StageDiagnosisSchema>;
export type StageOperatorState = z.infer<typeof StageOperatorStateSchema>;
export type StageQueueWait = z.infer<typeof StageQueueWaitSchema>;
export type StageBlastRadius = z.infer<typeof StageBlastRadiusSchema>;
export type StagePausedInfo = z.infer<typeof StagePausedInfoSchema>;
export type TimelineStage = z.infer<typeof TimelineStageSchema>;
export type ItemEventRow = z.infer<typeof ItemEventRowSchema>;
export type PipelineSummary = z.infer<typeof PipelineSummarySchema>;
export type PipelineTimelineResponse = z.infer<typeof PipelineTimelineResponseSchema>;
export type PipelineResetResponse = z.infer<typeof PipelineResetResponseSchema>;
export type PipelineReevaluateResponse = z.infer<typeof PipelineReevaluateResponseSchema>;
export type PipelineGiveUpResponse = z.infer<typeof PipelineGiveUpResponseSchema>;
export type PipelinePrioritizeResponse = z.infer<typeof PipelinePrioritizeResponseSchema>;
