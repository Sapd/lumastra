// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PipelineTimelineService (Slice 2 — Per-Item Traceability).
 *
 * Composes the single per-item pipeline timeline payload the admin Pipeline tab
 * renders top-to-bottom: stage_state rows (chronological) + per-stage run ref
 * (resolved via `orchestrator.getRun`, deduped) + per-stage stuck-reason
 * diagnosis (the pure `diagnoseStuckStage`) + per-item `event_outbox` history +
 * the existing summary.
 *
 * All I/O lives here so the route holds zero SQL and the join logic stays
 * testable. Best-effort enrichment never fails the timeline: a Valkey probe
 * failure degrades the affected diagnosis field (`probe: 'unavailable'`) and a
 * `getRun` miss yields an `expired` run ref — one bad signal never 500s the tab
 * (mirrors `findRowsByItem`'s degraded-row precedent).
 */

import type postgres from 'postgres';
import {
    ANALYZER_VISUAL_VERSION,
    ANALYZER_ACOUSTIC_VERSION,
} from '$lib/server/tasks/builtin/native/intro-analyzer/settings.js';
import {
    getAnalyzerInputSnapshot,
    getAnalyzerPolicySkippedStages,
} from '$lib/server/database/queries/media-segment-input.queries.js';
import * as m from '$lib/paraglide/messages.js';
import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';
import type { TaskRegistry } from '$lib/server/tasks/registry.js';
import { registry as defaultRegistry } from '$lib/server/tasks/registry.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { buildIdentityProbeKey } from './pipeline-identity-probe.js';
import { RECONCILER_STALE_HEARTBEAT_MS } from '$lib/server/tasks/reconciler.js';
import {
    LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS,
    LUMASTRA_QUEUE_DEPTH_CAP_BULK,
    LUMASTRA_QUEUE_DEPTH_CAP_CPU,
    LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY,
    LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING,
    LUMASTRA_QUEUE_DEPTH_CAP_INGEST,
    LUMASTRA_QUEUE_DEPTH_CAP_IO,
    LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE,
} from '$lib/server/config.js';
import { findRowsByItem } from '$lib/server/database/queries/stage-state.queries.js';
import { GLOBAL_IDENTITY_SENTINEL_UUID } from './stage-state.service.js';
import { fingerprintError } from '$lib/server/tasks/observability/error-fingerprint.js';
import { findEventsByItem } from '$lib/server/database/queries/event-outbox.queries.js';
import type { StageStateRow } from '$lib/types/pipeline.js';
import { isCoveredStatus } from '$lib/types/pipeline.js';
import type {
    ItemEventRow,
    PipelineSummary,
    PipelineTimelineResponse,
    StageBlastRadius,
    StageQueueWait,
    TimelineRunRef,
    TimelineRunState,
    TimelineStage,
} from '$lib/schemas/pipeline-timeline.schema.js';
import {
    diagnoseStuckStage,
    estimateWaitMs,
    stageOperatorState,
    THROUGHPUT_WINDOW_MINUTES,
    type CircuitProbe,
    type DepthProbe,
    type DiagnosisStageInput,
    type PausedProbe,
} from './pipeline-diagnosis.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const log = Logger.for('PipelineTimelineService');

// Live config bindings — read per call so the admin view shows the saved caps.
const classCaps = (): Record<ResourceClass, number> => ({
    cpu: LUMASTRA_QUEUE_DEPTH_CAP_CPU,
    io: LUMASTRA_QUEUE_DEPTH_CAP_IO,
    embedding: LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING,
    maintenance: LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE,
    ingest: LUMASTRA_QUEUE_DEPTH_CAP_INGEST,
    bulk: LUMASTRA_QUEUE_DEPTH_CAP_BULK,
    analysis: LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS,
    discovery: LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY,
});

/**
 * Ceiling on the "items ahead of me" count, mirroring `countSweepBacklog`'s
 * `BACKLOG_COUNT_CEILING`. A count AT the ceiling is reported as a floor
 * (`atLeast: true`) — the UI must say "more than N", never a number it cannot
 * support.
 */
const QUEUE_POSITION_CEILING = 10_001;

/**
 * Rows scanned when measuring a failure's blast radius. Bounded for the same
 * reason `RAW_ROW_LIMIT` bounds the fleet failure-pattern scan: the grouping is
 * computed on READ (there is no persisted fingerprint), so the scan has to be
 * capped rather than trusted to stay small.
 */
const BLAST_RADIUS_SCAN_LIMIT = 2_000;

/** How many other affected items get named, so the count links somewhere. */
const BLAST_RADIUS_SAMPLE_LIMIT = 5;

/** Statuses the stage sweep claims — the population a pending row queues behind. */
const SWEEP_ELIGIBLE_STATUSES = [
    'pending',
    'failed_transient',
    'skipped_transient',
    'obsolete',
] as const;

/** Non-terminal statuses that get a diagnosis (terminal ones are settled). */
const DIAGNOSED_STATUSES = new Set<StageStateRow['status']>([
    'pending',
    'running',
    'failed_transient',
    'failed_permanent',
    'skipped_permanent',
    'skipped_transient',
    'obsolete',
]);

/** Minimal `getRun` surface so tests can inject a fake without the orchestrator. */
export interface RunReader {
    getRun(runId: string): Promise<{
        id: string;
        state: string;
        ownerInstanceId?: string;
        heartbeatAt?: string;
        startedAt?: string;
    } | null>;
}

export interface PipelineTimelineDeps {
    registry?: TaskRegistry;
    runReader?: RunReader;
    /** Injectable for tests; defaults to the shared Valkey client. */
    getValkey?: () => {
        customCommand(args: string[]): Promise<unknown>;
    } | null;
    /** Injectable wall-clock for deterministic diagnosis. */
    now?: () => Date;
}

/**
 * Whether "Do this one first" can honestly be offered for one stage row.
 *
 * The action starts a SCOPED express run (`priority: 1`) for just this item, so
 * it only works where both halves hold:
 *
 *  1. The task's `identityFor` varies with `mediaItemId`. A global-identity task
 *     (media-probe, music-popularity, …) collapses every per-item enqueue into
 *     one whole-backlog run — clicking would drain the backlog, not this item.
 *     Probed exactly the way `eagerEnqueueForStages` probes it.
 *  2. The task covers exactly THIS one stage. The runner only wraps `execute()`
 *     in the stage-transition bookkeeping when `coversStages.length === 1`
 *     (Phase 1a single-stage limit), so on a multi-stage task the express run
 *     would do the work and leave this row sitting at `pending` — which reads to
 *     the operator as the button having done nothing.
 *
 * Shared with the prioritize endpoint so the button and the handler agree on
 * exactly one definition of "can be prioritized".
 */
export function canPrioritizeStage(
    task:
        | { coversStages?: ReadonlyArray<{ id: string }>; identityFor: (i: never) => string }
        | undefined,
    stageId: string,
    mediaItemId: string,
): boolean {
    if (!task) return false;
    const covers = task.coversStages;
    if (!covers || covers.length !== 1 || covers[0].id !== stageId) return false;
    try {
        const scoped = task.identityFor({ mediaItemId } as never);
        const global = task.identityFor({ mediaItemId: GLOBAL_IDENTITY_SENTINEL_UUID } as never);
        return scoped !== global;
    } catch {
        // identityFor rejected the shape — assume not scopable rather than
        // offering an action that would throw on click.
        return false;
    }
}

export class PipelineTimelineService {
    private readonly registry: TaskRegistry;
    private readonly getValkey: () => {
        customCommand(args: string[]): Promise<unknown>;
    } | null;
    private readonly now: () => Date;
    private readonly runReader: RunReader | null;

    constructor(
        private readonly sql: postgres.Sql,
        deps: PipelineTimelineDeps = {},
    ) {
        this.registry = deps.registry ?? defaultRegistry;
        this.getValkey = deps.getValkey ?? (() => getCoordinationClient());
        this.now = deps.now ?? (() => new Date());
        this.runReader = deps.runReader ?? null;
    }

    /**
     * Build the composed timeline for one resolved internal media-item UUID.
     */
    async buildTimeline(mediaItemId: string): Promise<PipelineTimelineResponse> {
        const rows = await findRowsByItem(this.sql, mediaItemId);
        const analyzerStages = rows.filter((row) =>
            row.stage_id.startsWith('lumastra-intro-analyzer:'),
        );
        const analyzerScopes = new Map<string, 'current' | 'earlier' | 'unverified'>();
        let analyzerAwaitingInput = false;
        if (analyzerStages.length > 0) {
            const input = await getAnalyzerInputSnapshot(this.sql, mediaItemId);
            const policySkipped = await getAnalyzerPolicySkippedStages(this.sql, mediaItemId);
            analyzerAwaitingInput = !input;
            const evidence = await this.sql<
                {
                    stage_id: string;
                    input_identity: string | null;
                    run_id: string | null;
                    processing_version: number | null;
                    coverage_complete: boolean | null;
                    kind: string;
                }[]
            >`
                SELECT stage_id, input_identity, run_id, processing_version, coverage_complete, 'pass' AS kind
                  FROM media_segment_analysis_passes WHERE media_id = ${mediaItemId}::uuid
                UNION ALL
                SELECT COALESCE(analysis_stage_id,stage_id), input_identity, run_id, processing_version, NULL, 'failure' AS kind
                  FROM plugin_failure_events WHERE plugin_id = 'lumastra-intro-analyzer' AND item_id = ${mediaItemId}
            `;
            for (const row of analyzerStages) {
                if (
                    ![
                        'completed',
                        'failed_permanent',
                        'failed_transient',
                        'skipped_transient',
                        'skipped_permanent',
                    ].includes(row.status)
                )
                    continue;
                if (
                    policySkipped.has(row.stage_id) ||
                    row.skipped_reason === 'season-scan-not-yet-stable' ||
                    (row.status === 'skipped_permanent' &&
                        row.skipped_reason?.startsWith('operator-'))
                )
                    continue;
                const stageEvidence = evidence.filter(
                    (entry) =>
                        entry.stage_id === row.stage_id ||
                        (entry.kind === 'failure' && entry.stage_id === null),
                );
                const current = stageEvidence.some(
                    (entry) =>
                        entry.input_identity === input?.inputIdentity &&
                        (row.status === 'completed'
                            ? entry.kind === 'pass' &&
                              entry.coverage_complete === true &&
                              entry.processing_version ===
                                  (row.stage_id.endsWith(':acoustic')
                                      ? ANALYZER_ACOUSTIC_VERSION
                                      : ANALYZER_VISUAL_VERSION) &&
                              (entry.processing_version ?? 0) >= row.processing_version
                            : entry.kind === 'failure' &&
                              entry.processing_version ===
                                  (row.stage_id.endsWith(':acoustic')
                                      ? ANALYZER_ACOUSTIC_VERSION
                                      : ANALYZER_VISUAL_VERSION) &&
                              (!row.last_run_id || entry.run_id === row.last_run_id)),
                );
                analyzerScopes.set(
                    row.stage_id,
                    current
                        ? 'current'
                        : stageEvidence.some(
                                (entry) =>
                                    entry.input_identity !== null &&
                                    entry.processing_version !== null &&
                                    (entry.input_identity !== input?.inputIdentity ||
                                        entry.processing_version !==
                                            (row.stage_id.endsWith(':acoustic')
                                                ? ANALYZER_ACOUSTIC_VERSION
                                                : ANALYZER_VISUAL_VERSION)),
                            )
                          ? 'earlier'
                          : 'unverified',
                );
            }
        }

        // Acoustic rows are deliberately not covered by the framework's item
        // sweep: the analyzer writes them from its season-cohort drain. This
        // display-only fallback does not register or enqueue another stage.
        const cooperativeOwnerByStage = new Map([
            ['lumastra-intro-analyzer:acoustic', 'lumastra-intro-analyzer'],
        ]);
        const cooperativeStages = new Set<string>();
        // Resolve declared owners first; a missing cooperative task is still orphaned.
        const taskIdByStage = new Map<string, string | null>();
        const taskNameByStage = new Map<string, string | null>();
        for (const row of rows) {
            const declared = this.registry.findTaskByStage(row.stage_id);
            const cooperativeOwner = cooperativeOwnerByStage.get(row.stage_id);
            const task =
                declared ??
                (cooperativeOwner ? this.registry.getTask(cooperativeOwner) : undefined);
            if (!declared && task) cooperativeStages.add(row.stage_id);
            taskIdByStage.set(row.stage_id, task?.id ?? null);
            taskNameByStage.set(row.stage_id, task ? taskDisplayName(task.id, task.name) : null);
        }

        // Dedupe run lookups across stages sharing a last_run_id.
        const runRefs = await this.resolveRunRefs(rows);

        // Batched best-effort Valkey probes (identity keys + active-counts) keyed
        // by the small set of distinct owning task ids. NEVER SCAN — every key is
        // derived from a resolved task id.
        const distinctTaskIds = [
            ...new Set([...taskIdByStage.values()].filter((t): t is string => t !== null)),
        ];
        const { identityTtlMs, activeCount, probeUnavailable } = await this.probeValkey(
            distinctTaskIds,
            mediaItemId,
        );

        // Per-task circuit snapshots (read-only; never calls check()) and per-task
        // schedule-pause snapshots. Both are best-effort single queries keyed by
        // the same small task-id set, so they run together.
        const [circuitByTask, pausedByTask] = await Promise.all([
            this.readCircuits(distinctTaskIds),
            this.readPaused(distinctTaskIds),
        ]);

        const now = this.now();
        const stages: TimelineStage[] = rows.map((row) => {
            const taskId = taskIdByStage.get(row.stage_id) ?? null;
            const run = row.last_run_id ? (runRefs.get(row.last_run_id) ?? null) : null;

            const observedDiagnosis = DIAGNOSED_STATUSES.has(row.status)
                ? diagnoseStuckStage(this.toDiagnosisStage(row, taskId), run, {
                      now,
                      circuit: taskId ? (circuitByTask.get(taskId) ?? null) : null,
                      paused: taskId ? (pausedByTask.get(taskId) ?? null) : null,
                      identityTtlMs: taskId ? (identityTtlMs.get(taskId) ?? null) : null,
                      depth: this.depthProbe(taskId, activeCount),
                      probeUnavailable,
                  })
                : null;
            // A cooperative stage is not an independently queued item. Retain
            // verified live-run and task off/failure evidence, but do not invent
            // a missing worker, item eligibility or per-item queue position.
            const inputScope = analyzerScopes.get(row.stage_id);
            const staleEvidence = inputScope !== undefined && inputScope !== 'current';
            const diagnosis = staleEvidence
                ? {
                      reason: 'none' as const,
                      summary: analyzerAwaitingInput
                          ? m.media_source_awaiting_input()
                          : m.media_sync_analysis_unverified(),
                      detail: { inputScope },
                      remediable: false,
                  }
                : cooperativeStages.has(row.stage_id) &&
                    observedDiagnosis &&
                    !['running-healthy', 'schedule-paused', 'circuit-open'].includes(
                        observedDiagnosis.reason,
                    )
                  ? {
                        reason: 'none' as const,
                        summary: m.admin_pipeline_acoustic_coordinated(),
                        detail: { coordination: 'season-cohort', taskId },
                        remediable: false,
                    }
                  : observedDiagnosis;

            const operatorState = staleEvidence
                ? 'waiting'
                : stageOperatorState(row.status, diagnosis);
            // The pause is only NEWS on a row that is still expecting work: a
            // finished or not-applicable step is not waiting on the scheduler,
            // and saying "also turned off" there is noise the operator has to
            // decide to ignore.
            const paused =
                taskId && (operatorState === 'off' || operatorState === 'failed')
                    ? pausedByTask.get(taskId)
                    : undefined;

            return {
                stageId: row.stage_id,
                ...(inputScope ? { inputScope } : {}),
                ...(staleEvidence ? { evidenceStatus: row.status } : {}),
                taskId,
                taskName: taskNameByStage.get(row.stage_id) ?? null,
                status: staleEvidence ? 'pending' : row.status,
                processingVersion: row.processing_version,
                attempt: row.attempt,
                skippedReason: row.skipped_reason,
                lastError: row.last_error,
                startedAt: row.started_at ? row.started_at.toISOString() : null,
                completedAt: row.completed_at ? row.completed_at.toISOString() : null,
                nextEligibleAt: row.next_eligible_at ? row.next_eligible_at.toISOString() : null,
                timeInStageMs: computeTimeInStage(row, now),
                run,
                diagnosis,
                operatorState,
                prioritizable:
                    operatorState === 'waiting' &&
                    !staleEvidence &&
                    !(
                        analyzerAwaitingInput && row.stage_id.startsWith('lumastra-intro-analyzer:')
                    ) &&
                    taskId !== null &&
                    canPrioritizeStage(this.registry.getTask(taskId), row.stage_id, mediaItemId),
                // Attached on a paused task's row whatever bucket it landed in:
                // a FAILED row on a paused task is still headlined by its error,
                // but the operator needs to know the retry will never come.
                ...(paused
                    ? {
                          paused: {
                              taskId: taskId as string,
                              pausedBy: paused.pausedBy,
                              pausedAt: paused.pausedAt ? paused.pausedAt.toISOString() : null,
                          },
                      }
                    : {}),
                updatedAt: row.updated_at.toISOString(),
            };
        });

        sortChronologically(stages, rows);

        // Enrichment passes. Both are bounded, best-effort, and independent of
        // each other — a failure in either leaves the field absent rather than
        // failing the tab (same contract as the Valkey / getRun probes above).
        const [queueWaits, blastRadii] = await Promise.all([
            this.computeQueueWaits(stages, rows),
            this.computeBlastRadii(mediaItemId, stages),
        ]);
        for (const stage of stages) {
            const wait = queueWaits.get(stage.stageId);
            if (wait) stage.queueWait = wait;
            const blast = blastRadii.get(stage.stageId);
            if (blast) stage.blastRadius = blast;
        }

        const events = await this.loadEvents(mediaItemId);
        const summary = buildSummary(
            rows.map((row) => ({
                ...row,
                status:
                    stages.find((stage) => stage.stageId === row.stage_id)?.status ?? row.status,
            })),
        );

        return { mediaItemId, stages, events, summary };
    }

    // ── Run refs ────────────────────────────────────────────────────────────

    private async resolveRunRefs(rows: StageStateRow[]): Promise<Map<string, TimelineRunRef>> {
        const out = new Map<string, TimelineRunRef>();
        const runIds = [
            ...new Set(rows.map((r) => r.last_run_id).filter((id): id is string => id !== null)),
        ];
        if (runIds.length === 0) return out;

        const reader = await this.getRunReader();
        const now = this.now().getTime();
        for (const runId of runIds) {
            try {
                const run = reader ? await reader.getRun(runId) : null;
                if (!run) {
                    out.set(runId, {
                        runId,
                        state: 'expired',
                        ownerInstanceId: null,
                        heartbeatAt: null,
                        startedAt: null,
                        alive: false,
                    });
                    continue;
                }
                const state = run.state as TimelineRunState;
                const heartbeatAt = run.heartbeatAt ?? null;
                const liveState = state === 'active' || state === 'cancelling';
                const hbFresh =
                    heartbeatAt !== null &&
                    now - new Date(heartbeatAt).getTime() <= RECONCILER_STALE_HEARTBEAT_MS;
                out.set(runId, {
                    runId,
                    state,
                    ownerInstanceId: run.ownerInstanceId ?? null,
                    heartbeatAt,
                    startedAt: run.startedAt ?? null,
                    alive: liveState && hbFresh,
                });
            } catch (err) {
                // Degrade to an expired ref rather than failing the whole timeline.
                log.warn('resolveRunRefs: getRun failed; marking run expired', {
                    runId,
                    err: err instanceof Error ? err.message : String(err),
                });
                out.set(runId, {
                    runId,
                    state: 'expired',
                    ownerInstanceId: null,
                    heartbeatAt: null,
                    startedAt: null,
                    alive: false,
                });
            }
        }
        return out;
    }

    private async getRunReader(): Promise<RunReader | null> {
        if (this.runReader) return this.runReader;
        try {
            const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
            return orchestrator;
        } catch (err) {
            log.warn('getRunReader: orchestrator unavailable; run refs degrade to expired', {
                err: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }

    // ── Valkey probes (best-effort, batched MGET — never SCAN) ────────────────

    private async probeValkey(
        taskIds: string[],
        mediaItemId: string,
    ): Promise<{
        identityTtlMs: Map<string, number>;
        activeCount: Map<string, number>;
        probeUnavailable: boolean;
    }> {
        const identityTtlMs = new Map<string, number>();
        const activeCount = new Map<string, number>();
        if (taskIds.length === 0) {
            return { identityTtlMs, activeCount, probeUnavailable: false };
        }

        const client = this.getValkey();
        if (!client) {
            return { identityTtlMs, activeCount, probeUnavailable: true };
        }

        // Build the cross-time identity key the SAME way the orchestrator does
        // (see buildIdentityProbeKey). Only `exclusiveWith` tasks claim a SETNX
        // identity lock, and the key embeds computeIdentity(task, input) — NOT
        // the bare mediaItemId. Tasks with no such lock are skipped (probing a
        // fabricated key would false-negative the `identity-locked` diagnosis).
        const idTaskIds: string[] = [];
        const idKeys: string[] = [];
        for (const t of taskIds) {
            const key = buildIdentityProbeKey(this.registry.getTask(t), mediaItemId);
            if (key) {
                idTaskIds.push(t);
                idKeys.push(key);
            }
        }
        const activeCountKeys = taskIds.map((t) => `task:active-count:${t}`);

        // Single MGET for the active-count counters.
        try {
            const counts = (await client.customCommand(['MGET', ...activeCountKeys])) as Array<
                string | null
            > | null;
            if (Array.isArray(counts)) {
                counts.forEach((v, i) => {
                    const n = v == null ? 0 : Number(v);
                    activeCount.set(taskIds[i], Number.isFinite(n) ? n : 0);
                });
            }
        } catch (err) {
            log.warn('probeValkey: active-count MGET failed (best-effort)', {
                err: err instanceof Error ? err.message : String(err),
            });
            return { identityTtlMs, activeCount, probeUnavailable: true };
        }

        // Identity presence + TTL: one MGET to detect presence, then PTTL only
        // for the (typically few) present keys. PTTL has no MGET equivalent, so
        // we bound the per-key calls to keys we already know exist.
        if (idKeys.length > 0) {
            try {
                const present = (await client.customCommand(['MGET', ...idKeys])) as Array<
                    string | null
                > | null;
                if (Array.isArray(present)) {
                    for (let i = 0; i < present.length; i++) {
                        if (present[i] == null) continue;
                        const ttl = (await client.customCommand(['PTTL', idKeys[i]])) as
                            number | string | null;
                        const ttlMs = ttl == null ? -1 : Number(ttl);
                        // PTTL: -2 (no key), -1 (no expiry). Report a present lock
                        // even without an expiry (treat as a large positive TTL = 0).
                        identityTtlMs.set(idTaskIds[i], ttlMs > 0 ? ttlMs : 0);
                    }
                }
            } catch (err) {
                log.warn('probeValkey: identity MGET/PTTL failed (best-effort)', {
                    err: err instanceof Error ? err.message : String(err),
                });
                return { identityTtlMs, activeCount, probeUnavailable: true };
            }
        }

        return { identityTtlMs, activeCount, probeUnavailable: false };
    }

    private depthProbe(taskId: string | null, activeCount: Map<string, number>): DepthProbe | null {
        if (!taskId) return null;
        const task = this.registry.getTask(taskId);
        if (!task) return null;
        const cap = classCaps()[task.resourceClass];
        if (typeof cap !== 'number') return null;
        return { classDepth: activeCount.get(taskId) ?? 0, cap };
    }

    // ── Circuit snapshots (read-only) ─────────────────────────────────────────

    private async readCircuits(taskIds: string[]): Promise<Map<string, CircuitProbe>> {
        const out = new Map<string, CircuitProbe>();
        if (taskIds.length === 0) return out;
        try {
            const rows = await this.sql<
                {
                    task_id: string;
                    state: 'closed' | 'open' | 'half_open';
                    opened_reason: string | null;
                    next_probe_at: Date | null;
                }[]
            >`
                SELECT task_id, state, opened_reason, next_probe_at
                  FROM task_circuit_state
                 WHERE task_id = ANY(${taskIds})
            `;
            for (const r of rows) {
                out.set(r.task_id, {
                    state: r.state,
                    openedReason: r.opened_reason,
                    nextProbeAt: r.next_probe_at,
                });
            }
        } catch (err) {
            // Best-effort: absent circuit data simply means no circuit-open verdict.
            log.warn('readCircuits failed (best-effort)', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return out;
    }

    // ── Schedule pause snapshots (read-only) ─────────────────────────────────

    /**
     * Which of these tasks a PERSON has switched off (`scheduler_state.paused`).
     *
     * Deliberately distinct from {@link readCircuits}: the circuit is the system
     * pausing itself after repeated failures, this is an admin decision, and the
     * two want different copy and different remedies. Only paused rows are
     * returned — an absent entry means "not paused", which is also what a failed
     * probe degrades to (best-effort: never fail the tab over it).
     *
     * The web pool reads `scheduler_state` directly rather than going through
     * `scheduler-state.ts`, whose helpers are called with the TASK pool; web-tier
     * code must not reach for `getTaskDb()`.
     */
    private async readPaused(taskIds: string[]): Promise<Map<string, PausedProbe>> {
        const out = new Map<string, PausedProbe>();
        if (taskIds.length === 0) return out;
        try {
            const rows = await this.sql<
                {
                    task_id: string;
                    paused_by: string | null;
                    paused_at: Date | null;
                }[]
            >`
                SELECT task_id, paused_by, paused_at
                  FROM scheduler_state
                 WHERE task_id = ANY(${taskIds})
                   AND paused = true
            `;
            for (const r of rows) {
                out.set(r.task_id, { pausedBy: r.paused_by, pausedAt: r.paused_at });
            }
        } catch (err) {
            // Best-effort: absent pause data simply means no "Off" verdict.
            log.warn('readPaused failed (best-effort)', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return out;
    }

    // ── Waiting: queue position + ETA ────────────────────────────────────────

    /**
     * "812 items ahead · about 40 min" for the rows that are PLAINLY queued.
     *
     * Only rows whose diagnosis is `none` qualify. A row held by a breaker, a
     * lock, backpressure or a retry backoff has no meaningful position — it is
     * not waiting its turn, it is waiting on something else, and quoting a queue
     * position there would be a confidently wrong number.
     *
     * "Ahead of" is defined by the dispatcher's own ordering
     * (`findSweepCandidates`: `ORDER BY next_eligible_at ASC NULLS FIRST,
     * updated_at ASC`) over the same WHERE, so the count means what it says.
     * Two honest imprecisions, both encoded rather than papered over:
     *   - The sweep has NO tiebreaker after `updated_at`, so after a bulk seed
     *     the position is ±(size of the tie group). The copy says "about".
     *   - `eagerEnqueueForStages` can dispatch a freshly-seeded row without the
     *     sweep ever seeing it, which makes the count an UPPER bound for new rows.
     */
    private async computeQueueWaits(
        stages: TimelineStage[],
        rows: StageStateRow[],
    ): Promise<Map<string, StageQueueWait>> {
        const out = new Map<string, StageQueueWait>();

        const rowByStage = new Map(rows.map((r) => [r.stage_id, r]));
        const targets = stages.filter(
            (st) =>
                st.operatorState === 'waiting' &&
                st.diagnosis?.reason === 'none' &&
                // Only declared stages enter the per-item stage sweep.
                this.registry.findTaskByStage(st.stageId) !== undefined &&
                (SWEEP_ELIGIBLE_STATUSES as readonly string[]).includes(st.status) &&
                rowByStage.has(st.stageId),
        );
        if (targets.length === 0) return out;

        const stageIds = targets.map((st) => st.stageId);
        const nextEligible = targets.map((st) => {
            const at = rowByStage.get(st.stageId)?.next_eligible_at ?? null;
            return at ? at.toISOString() : null;
        });
        const updatedAt = targets.map((st) =>
            (rowByStage.get(st.stageId) as StageStateRow).updated_at.toISOString(),
        );

        try {
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only surface (GET /api/admin/media/[id]/pipeline/timeline, auth kind 'admin'). media_items is joined ONLY to reproduce the dispatcher's own dismissed/active gate so the position matches what the sweep would actually claim; it returns a COUNT, never any media metadata.
            const counts = await this.sql<
                { stage_id: string; ahead: number; completed_recent: number }[]
            >`
                WITH targets AS (
                    SELECT *
                      FROM unnest(
                          ${stageIds}::text[],
                          ${nextEligible}::timestamptz[],
                          ${updatedAt}::timestamptz[]
                      ) AS t(stage_id, ne, ua)
                )
                SELECT t.stage_id,
                       (
                           SELECT count(*)
                             FROM (
                                 SELECT 1
                                   FROM media_item_stage_state s
                                  WHERE s.stage_id = t.stage_id
                                    AND s.status = ANY(${[...SWEEP_ELIGIBLE_STATUSES]}::text[])
                                    AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
                                    AND (
                                            COALESCE(s.next_eligible_at, '-infinity'::timestamptz),
                                            s.updated_at
                                        ) < (
                                            COALESCE(t.ne, '-infinity'::timestamptz),
                                            t.ua
                                        )
                                    AND EXISTS (
                                        SELECT 1
                                          FROM media_items mi
                                         WHERE mi.id = s.media_item_id
                                           AND COALESCE(mi.is_dismissed, false) = false
                                           AND mi.status = 'active'
                                    )
                                  LIMIT ${QUEUE_POSITION_CEILING}
                             ) capped
                       )::int AS ahead,
                       (
                           SELECT count(*)
                             FROM media_item_stage_state c
                            WHERE c.stage_id = t.stage_id
                              AND c.status = 'completed'
                              AND c.completed_at > now()
                                  - make_interval(mins => ${THROUGHPUT_WINDOW_MINUTES})
                       )::int AS completed_recent
                  FROM targets t
            `;

            for (const row of counts) {
                const atLeast = row.ahead >= QUEUE_POSITION_CEILING;
                out.set(row.stage_id, {
                    itemsAhead: row.ahead,
                    atLeast,
                    etaMs: estimateWaitMs(row.ahead, row.completed_recent),
                });
            }
        } catch (err) {
            // Position is enrichment — a missing one drops the "N ahead" line,
            // it never costs the operator the rest of the row.
            log.warn('computeQueueWaits failed (best-effort)', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return out;
    }

    // ── Failed: blast radius ─────────────────────────────────────────────────

    /**
     * "14 other items hit the same error."
     *
     * Groups by `fingerprintError()` — the SAME read-time normalise+hash the
     * fleet Error Groups panel uses — so ids, paths, timestamps and counts inside
     * the message do not split one cause into fourteen. There is no persisted
     * fingerprint anywhere, so this is a bounded scan of the recent failed rows
     * for the same step, hashed in memory: exactly the trade `failure-patterns`
     * already makes, at per-item scope.
     *
     * Scoped to the same `stage_id` on purpose. The same message text raised by a
     * different step is a different operational problem, and a cross-step count
     * would send the operator to the wrong config.
     */
    private async computeBlastRadii(
        mediaItemId: string,
        stages: TimelineStage[],
    ): Promise<Map<string, StageBlastRadius>> {
        const out = new Map<string, StageBlastRadius>();

        const targets = stages.filter(
            (st) => st.operatorState === 'failed' && st.lastError?.message,
        );
        if (targets.length === 0) return out;

        const stageIds = targets.map((st) => st.stageId);
        try {
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only surface (GET /api/admin/media/[id]/pipeline/timeline, auth kind 'admin'). Titles of the OTHER affected items are the point of the feature: the count has to link somewhere an admin can click. No user context exists on this route to gate against.
            const rows = await this.sql<
                {
                    stage_id: string;
                    media_item_id: string;
                    message: string | null;
                    title: string;
                }[]
            >`
                SELECT s.stage_id,
                       s.media_item_id::text AS media_item_id,
                       s.last_error->>'message' AS message,
                       mi.title
                  FROM media_item_stage_state s
                  JOIN media_items mi ON mi.id = s.media_item_id
                 WHERE s.stage_id = ANY(${stageIds}::text[])
                   AND s.status IN ('failed_transient', 'failed_permanent')
                   AND s.last_error IS NOT NULL
                   AND s.media_item_id <> ${mediaItemId}::uuid
                 ORDER BY s.stage_id, s.updated_at DESC
                 LIMIT ${BLAST_RADIUS_SCAN_LIMIT}
            `;

            // A full page back means the scan was truncated, so every count it
            // produced is a floor rather than a total.
            const scanCapped = rows.length >= BLAST_RADIUS_SCAN_LIMIT;

            for (const stage of targets) {
                const mine = fingerprintError(stage.lastError?.message ?? '');
                const matches = rows.filter(
                    (r) =>
                        r.stage_id === stage.stageId &&
                        r.message != null &&
                        fingerprintError(r.message) === mine,
                );
                // A zero count is deliberately KEPT: "no other item hit this
                // error" is exactly as useful to an operator as "14 did" — it is
                // what rules the config out and points at this one file.
                out.set(stage.stageId, {
                    otherItems: matches.length,
                    atLeast: scanCapped,
                    samples: matches.slice(0, BLAST_RADIUS_SAMPLE_LIMIT).map((r) => ({
                        mediaItemId: r.media_item_id,
                        title: r.title,
                    })),
                });
            }
        } catch (err) {
            // Enrichment: without it the row still shows its own error.
            log.warn('computeBlastRadii failed (best-effort)', {
                err: err instanceof Error ? err.message : String(err),
            });
        }
        return out;
    }

    // ── Events ────────────────────────────────────────────────────────────────

    private async loadEvents(mediaItemId: string): Promise<ItemEventRow[]> {
        try {
            const rows = await findEventsByItem(this.sql, mediaItemId, 50);
            return rows.map((r) => ({
                id: r.id,
                eventName: r.event_name,
                payload: isRecordLike(r.payload) ? r.payload : {},
                attempts: r.attempts,
                createdAt: r.created_at.toISOString(),
                consumedAt: r.consumed_at ? r.consumed_at.toISOString() : null,
                nextRetryAt: r.next_retry_at ? r.next_retry_at.toISOString() : null,
                deadLetter: r.dead_letter,
                lastError: r.last_error,
            }));
        } catch (err) {
            // Event history is enrichment — never fail the timeline on it.
            log.warn('loadEvents failed (best-effort)', {
                mediaItemId,
                err: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    private toDiagnosisStage(row: StageStateRow, taskId: string | null): DiagnosisStageInput {
        return {
            stageId: row.stage_id,
            taskId,
            status: row.status,
            skippedReason: row.skipped_reason,
            nextEligibleAt: row.next_eligible_at,
        };
    }
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function isRecordLike(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Time-in-stage: for a running row, now − started_at; for a settled row,
 * completed − started. Null when neither timestamp is available.
 */
export function computeTimeInStage(row: StageStateRow, now: Date): number | null {
    if (!row.started_at) return null;
    const start = row.started_at.getTime();
    if (row.status === 'running') {
        return Math.max(0, now.getTime() - start);
    }
    if (row.completed_at) {
        return Math.max(0, row.completed_at.getTime() - start);
    }
    return null;
}

/**
 * Chronological narrative sort. `findRowsByItem` returns rows ordered by
 * stage_id (alphabetical); the timeline orders by a derived `firstObservedAt`
 * (min of started_at / completed_at), falling back to the original
 * stage_id order when both timestamps are null — so unstarted `pending`
 * stages slot after stages that already ran, in a stable order.
 */
function sortChronologically(stages: TimelineStage[], rows: StageStateRow[]): void {
    const observedByStage = new Map<string, number | null>();
    const indexByStage = new Map<string, number>();
    rows.forEach((r, i) => {
        const ts: number[] = [];
        if (r.started_at) ts.push(r.started_at.getTime());
        if (r.completed_at) ts.push(r.completed_at.getTime());
        observedByStage.set(r.stage_id, ts.length ? Math.min(...ts) : null);
        indexByStage.set(r.stage_id, i);
    });

    stages.sort((a, b) => {
        const av = observedByStage.get(a.stageId) ?? null;
        const bv = observedByStage.get(b.stageId) ?? null;
        if (av !== null && bv !== null) return av - bv;
        if (av !== null) return -1; // observed stages before unstarted ones
        if (bv !== null) return 1;
        // Both unstarted → preserve the stable stage_id order from the query.
        return (indexByStage.get(a.stageId) ?? 0) - (indexByStage.get(b.stageId) ?? 0);
    });
}

function buildSummary(rows: StageStateRow[]): PipelineSummary {
    return {
        total: rows.length,
        completed: rows.filter((r) => r.status === 'completed').length,
        in_progress: rows.filter((r) => r.status === 'running').length,
        failed: rows.filter(
            (r) => r.status === 'failed_transient' || r.status === 'failed_permanent',
        ).length,
        pending: rows.filter((r) => r.status === 'pending').length,
        obsolete: rows.filter((r) => r.status === 'obsolete').length,
        skipped: rows.filter(
            (r) => r.status === 'skipped_permanent' || r.status === 'skipped_transient',
        ).length,
    };
}

// Re-export so callers can reason about coverage without a second import.
export { isCoveredStatus };
export { buildIdentityProbeKey };
