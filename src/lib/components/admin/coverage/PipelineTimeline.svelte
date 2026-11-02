<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Per-item pipeline timeline.

  The organising idea: an operator never asks "what is the state of stage
  media-probe-a". They ask "why has this episode got no poster, and what do I
  do?" So every row leads with WHICH OF FIVE THINGS is true — Done, Failed,
  Waiting, Skipped, Off — and each of the five says a different, actionable
  sentence:

    Done     when it finished, so staleness is visible at a glance
    Failed   the cause, plus how many OTHER items hit the same error
    Waiting  position in the queue and an ETA, plus "Do this one first"
    Skipped  why it does not apply to this item
    Off      an admin switched the step off — offer to switch it back on

  Four of those five were previously one undifferentiated "not done" state,
  which is why so much waiting/skipped/off gets reported as breakage.

  The bucket itself is computed SERVER-side (`TimelineStage.operatorState`,
  from `stageOperatorState`): the diagnosis module is server-only, so deriving
  it here would mean a second, drifting copy of the rule.
-->

<script lang="ts">
    import { Icon, QuestionMarkCircle } from 'svelte-hero-icons';
    import { onMount } from 'svelte';
    import ActionModal from '$lib/components/admin/ActionModal.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import RunRefChip from './RunRefChip.svelte';
    import StageDiagnosisBadge from './StageDiagnosisBadge.svelte';
    import { stageOperatorStateStyle, type StageStateStyle } from './stage-diagnosis-display.js';
    import StageErrorBlock from './StageErrorBlock.svelte';
    import type { TimelineStage } from '$lib/schemas/pipeline-timeline.schema.js';
    import { taskStatusLabel } from '$lib/utils/operator-labels';
    import { pipelineStepName } from '$lib/config/pipeline-step-names.js';
    import { sharesVocabulary } from '$lib/config/vocabulary.js';
    import { pipelineStepDescription } from '$lib/config/pipeline-step-descriptions.js';
    import { formatRelativeTime, formatDurationLong } from '$lib/utils/time-formatting';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        mediaItemId: string;
        stages: TimelineStage[];
        /** Re-fetch the timeline after a remediation action completes. */
        onremediated?: () => void;
        /**
         * Show the raw `stage_id` / `task_id` next to the friendly step name
         * (admin IA redesign, spec §3.3: "raw ids only in dev mode").
         * Threaded down from `$page.data.devToolsEnabled`.
         */
        devMode?: boolean;
    }

    const { mediaItemId, stages, onremediated, devMode = false }: Props = $props();

    // A live server snapshot is evidence only while fresh. This presentation
    // budget does not classify workers as dead or alter backend lock handling.
    const LIVE_SNAPSHOT_FRESHNESS_MS = 30_000;
    let now = $state(Date.now());
    onMount(() => {
        const timer = setInterval(() => {
            now = Date.now();
        }, 1_000);
        return () => clearInterval(timer);
    });

    type PendingAction = {
        kind: 'retry' | 'reevaluate' | 'give-up' | 'resume' | 'unignore';
        stageId: string | null;
        /** Friendly step name (or an all-stages phrase) — never a raw id. */
        label: string;
        /** Owning task id for `resume`; only ever used to build the URL. */
        taskId?: string;
    } | null;

    let pending = $state<PendingAction>(null);
    let actionError = $state<string | null>(null);

    /** Per-stage inline result of "Do this one first" (never a modal — it is not destructive). */
    let prioritizeState = $state<Record<string, { busy: boolean; message: string | null }>>({});
    /** Stage ids whose blast-radius sample list is expanded. */
    let blastOpen = $state<Record<string, boolean>>({});

    const hasFailed = $derived(stages.some((s) => s.status === 'failed_permanent'));
    const hasReevaluable = $derived(
        stages.some((s) => s.diagnosis?.reason === 'predicate-blocked' || s.diagnosis?.remediable),
    );

    /**
     * Name the owning task when the step's name would not lead an operator to
     * it — the old "Quick scan failed, but there is no Quick scan in the
     * catalog" problem.
     *
     * Only when the two names share NO word. Builtin steps are named after
     * their task since the vocabulary pass (spec 2026-09-27 §1.5 — "Read Media
     * File Details (quick)" under "Read Media File Details"), so this now
     * fires for plugin steps whose humanized id shares nothing with the task.
     */
    function owningTaskHint(stage: TimelineStage): string | null {
        const task = stage.taskName;
        if (!task) return null;
        // `sharesVocabulary` is imported, not re-derived: a private copy here
        // could not fail when the rule changes, and the rule is the whole
        // decision — poster/posters and art/artwork must read as the same word
        // or this fires on perfectly good copy.
        return sharesVocabulary(pipelineStepName(stage.stageId), task) ? null : task;
    }

    /** What this step does, for the `?` next to its name. Undefined → no `?`. */
    function stepDescription(stage: TimelineStage): string | undefined {
        return pipelineStepDescription(stage.stageId, stage.taskId);
    }

    // ── The five states ──────────────────────────────────────────────────────

    // Colour + left rule per bucket: `stageOperatorStateStyle` in
    // `stage-diagnosis-display.ts`. It was a record keyed on the operator-state
    // enum here, checked by nothing — tsgo skips `.svelte` and
    // svelte-check-native does not flag a broken key in a component-local record
    // — and the `?? waiting` fallback below would have rendered a new bucket as
    // a calm blue "waiting" row. That is the same failure the sibling
    // stuck-reason record actually shipped; see that module's doc.

    function stateStyle(stage: TimelineStage): StageStateStyle {
        return stageOperatorStateStyle(stage.operatorState);
    }

    /**
     * The pill text. "Off" is the one bucket with no status code behind it — an
     * admin pause is an overlay on a row that is otherwise `pending`. Every
     * other bucket keeps `taskStatusLabel()`'s existing vocabulary rather than
     * inventing a parallel one ("Not applicable", "Failed — will retry", …).
     */
    function stateLabel(stage: TimelineStage): string {
        return stage.operatorState === 'off'
            ? m.admin_pipeline_row_state_off()
            : taskStatusLabel(stage.status);
    }

    // ── Done ─────────────────────────────────────────────────────────────────

    /** Done rows lead with WHEN, so a two-year-old "success" is visibly stale. */
    function doneLine(stage: TimelineStage): string {
        const at = stage.completedAt ?? stage.updatedAt;
        if (!at) return m.admin_pipeline_row_done_no_time();
        return m.admin_pipeline_row_done_when({ age: formatRelativeTime(at) });
    }

    // ── Waiting ──────────────────────────────────────────────────────────────

    /**
     * Round an estimate to something it can actually support. Anything past a
     * day is reported as "more than a day": the underlying rate is a five-minute
     * sample, and quoting "73 hours" from it would be false precision.
     */
    function formatEta(ms: number): string {
        if (ms >= 24 * 3_600_000) return m.admin_pipeline_row_waiting_eta_over_a_day();
        if (ms >= 3_600_000) {
            const hours = Math.round(ms / 3_600_000);
            return formatDurationLong(hours * 3600);
        }
        return formatDurationLong(Math.max(1, Math.ceil(ms / 60_000)) * 60);
    }

    /** "812 items ahead" — or the honest floor when the count hit its ceiling. */
    function aheadLabel(stage: TimelineStage): string | null {
        const q = stage.queueWait;
        if (!q) return null;
        if (q.atLeast) return m.admin_pipeline_row_waiting_ahead_atleast({ count: q.itemsAhead });
        if (q.itemsAhead === 0) return m.admin_pipeline_row_waiting_next();
        if (q.itemsAhead === 1) return m.admin_pipeline_row_waiting_ahead_one();
        return m.admin_pipeline_row_waiting_ahead({ count: q.itemsAhead });
    }

    function etaLabel(stage: TimelineStage): string | null {
        const q = stage.queueWait;
        if (!q || q.itemsAhead === 0) return null;
        if (q.etaMs === null) return m.admin_pipeline_row_waiting_eta_unknown();
        return m.admin_pipeline_row_waiting_eta({ duration: formatEta(q.etaMs) });
    }

    // ── Skipped ──────────────────────────────────────────────────────────────

    /**
     * Plain language for the `skipped_reason` markers the task system writes.
     * These are internal kebab-case strings ("no-match-upstream") that used to
     * be rendered verbatim; the map covers the recurring families and anything
     * unmapped is humanised rather than shown as a code.
     */
    function skippedLine(stage: TimelineStage): string {
        if (stage.status === 'obsolete') return m.admin_pipeline_row_skipped_obsolete();

        const reason = stage.skippedReason;
        if (!reason) return m.admin_pipeline_row_skipped_generic();

        // An operator's own "ignore" is not a system disposition and must not
        // read like one — "Doesn't apply to this item" is actively misleading
        // when the reason it doesn't apply is that you said so. The stored form
        // is `operator-<verb>` with optional `: free text` (operatorReason() in
        // pipeline-remediation.service.ts).
        if (reason.startsWith('operator-')) {
            const note = reason.slice(reason.indexOf(':') + 1).trim();
            return reason.includes(':') && note
                ? m.admin_pipeline_row_skipped_by_operator_note({ note })
                : m.admin_pipeline_row_skipped_by_operator();
        }

        if (reason.startsWith('predicate-false') || reason === 'ineligible') {
            return m.admin_pipeline_row_skipped_generic();
        }
        if (reason === 'unsupported-media-type' || reason === 'not-a-movie-item') {
            return m.admin_pipeline_row_skipped_media_type();
        }
        if (
            reason === 'no-provider' ||
            reason === 'no-match-upstream' ||
            reason === 'no-data-upstream'
        ) {
            return m.admin_pipeline_row_skipped_no_provider_data();
        }
        if (reason === 'no-image-bytes') return m.admin_pipeline_row_skipped_no_image();
        if (reason === 'no-parent-artist') return m.admin_pipeline_row_skipped_no_parent_artist();
        // music-analysis: no Essentia binary, or one that crashes on this host.
        if (reason === 'essentia-unavailable') {
            return m.admin_pipeline_row_skipped_audio_analysis_unavailable();
        }
        if (reason.includes('fribb') || reason.includes('mal-anilist')) {
            return m.admin_pipeline_row_skipped_no_anime_match();
        }
        return m.admin_pipeline_row_skipped_reason({ reason: humanizeReason(reason) });
    }

    /** `no-match-upstream` → `No match upstream`. Last resort, never a raw code. */
    function humanizeReason(code: string): string {
        const base = code.replace(/[:_-]+/g, ' ').trim();
        if (!base) return code;
        return base.charAt(0).toUpperCase() + base.slice(1);
    }

    // ── Off ──────────────────────────────────────────────────────────────────

    function offByLine(stage: TimelineStage): string | null {
        const p = stage.paused;
        if (!p) return null;
        if (p.pausedBy && p.pausedAt) {
            return m.admin_pipeline_row_off_by({
                who: p.pausedBy,
                age: formatRelativeTime(p.pausedAt),
            });
        }
        if (p.pausedAt)
            return m.admin_pipeline_row_off_when({ age: formatRelativeTime(p.pausedAt) });
        return null;
    }

    // ── Failed ───────────────────────────────────────────────────────────────

    function blastLine(stage: TimelineStage): string | null {
        const b = stage.blastRadius;
        if (!b) return null;
        if (b.atLeast) return m.admin_pipeline_row_blast_atleast({ count: b.otherItems });
        if (b.otherItems === 0) return m.admin_pipeline_row_blast_none();
        if (b.otherItems === 1) return m.admin_pipeline_row_blast_one();
        return m.admin_pipeline_row_blast_others({ count: b.otherItems });
    }

    // ── Timestamps footer ────────────────────────────────────────────────────

    function formatDuration(ms: number): string {
        if (!Number.isFinite(ms) || ms < 0) return '—';
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const mins = Math.floor(s / 60);
        const rs = s % 60;
        if (mins < 60) return `${mins}m ${rs}s`;
        const h = Math.floor(mins / 60);
        return `${h}h ${mins % 60}m`;
    }

    function timestamp(value: string | null): number | null {
        if (!value) return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }

    function currentAttemptIsLive(stage: TimelineStage): boolean {
        const started = timestamp(stage.startedAt);
        const runStarted = timestamp(stage.run?.startedAt ?? null);
        const heartbeat = timestamp(stage.run?.heartbeatAt ?? null);
        return (
            stage.status === 'running' &&
            stage.completedAt === null &&
            stage.run?.alive === true &&
            (stage.run.state === 'active' || stage.run.state === 'cancelling') &&
            started !== null &&
            runStarted !== null &&
            started >= runStarted &&
            started <= now &&
            heartbeat !== null &&
            heartbeat <= now &&
            now - heartbeat < LIVE_SNAPSHOT_FRESHNESS_MS
        );
    }

    function timeInStageLabel(stage: TimelineStage): string | null {
        if (stage.status === 'running') {
            if (
                !currentAttemptIsLive(stage) ||
                stage.timeInStageMs === null ||
                !Number.isFinite(stage.timeInStageMs) ||
                stage.timeInStageMs < 0
            )
                return m.pipeline_timing_live_unverified();
            return m.pipeline_timing_running({ duration: formatDuration(stage.timeInStageMs) });
        }
        if (stage.status !== 'completed') return null;
        const started = timestamp(stage.startedAt);
        const completed = timestamp(stage.completedAt);
        const runStarted = timestamp(stage.run?.startedAt ?? null);
        if (
            stage.run?.state === 'expired' ||
            started === null ||
            completed === null ||
            completed < started ||
            completed > Date.now() ||
            (runStarted !== null && started < runStarted)
        )
            return m.pipeline_timing_completion_unverified();
        // The row's timestamps describe this completed attempt. A retained
        // timeInStageMs from another state must never supply its duration.
        return m.pipeline_timing_completed({ duration: formatDuration(completed - started) });
    }

    function historicalRun(stage: TimelineStage): boolean {
        return (
            !!stage.run && ['expired', 'completed', 'failed', 'cancelled'].includes(stage.run.state)
        );
    }

    function retryCountdownLabel(stage: TimelineStage): string | null {
        if (!stage.nextEligibleAt) return null;
        const delta = new Date(stage.nextEligibleAt).getTime() - Date.now();
        if (delta <= 0) return 'ready to retry';
        return `retry in ${formatDuration(delta)}`;
    }

    // ── Which actions a row offers ───────────────────────────────────────────

    // Whether a stage can be RETRIED (failed_permanent → pending).
    function canRetry(stage: TimelineStage): boolean {
        if (stage.inputScope && stage.inputScope !== 'current') return false;
        return stage.status === 'failed_permanent';
    }

    // Whether a stage can be RE-EVALUATED (predicate-blocked / remediable skip).
    // A `schedule-paused` row is remediable by RESUMING, not by re-evaluating —
    // re-evaluating it would enqueue into a queue nothing is draining.
    function canReevaluate(stage: TimelineStage): boolean {
        if (stage.inputScope && stage.inputScope !== 'current') return false;
        if (stage.diagnosis?.reason === 'schedule-paused') return false;
        return (
            stage.diagnosis?.reason === 'predicate-blocked' ||
            (stage.diagnosis?.remediable === true && stage.status !== 'failed_permanent')
        );
    }

    // Whether an operator can GIVE UP on a stage (→ skipped_permanent): only a
    // stage that is actually failing — stuck retrying (failed_transient) or
    // already given-up (failed_permanent). The inverse of Retry.
    function canGiveUp(stage: TimelineStage): boolean {
        if (stage.inputScope && stage.inputScope !== 'current') return false;
        return stage.status === 'failed_transient' || stage.status === 'failed_permanent';
    }

    /**
     * Whether an operator's own ignore can be LIFTED (skipped_permanent →
     * pending).
     *
     * Mirrors `unskipItemStage`'s SQL gate exactly, including the
     * `operator-` prefix. The disposition runner also writes
     * `skipped_permanent` for stages that genuinely do not apply, and those are
     * NOT reversible: un-skipping one sets it pending, stage-sweep re-evaluates
     * and re-skips it, and the operator watches their own action silently undo
     * itself. Offering the button there would return `restored: 0` every time.
     */
    function canUnignore(stage: TimelineStage): boolean {
        if (stage.inputScope && stage.inputScope !== 'current') return false;
        return (
            stage.status === 'skipped_permanent' &&
            stage.skippedReason?.startsWith('operator-') === true
        );
    }

    /**
     * "Do this one first" is offered only where the server said it can honestly
     * be done (`prioritizable`): the owning task must scope by item AND cover
     * exactly this stage, or the express run would drain the whole backlog or
     * leave this row untouched. A button that cannot deliver is worse than none.
     */
    function canPrioritize(stage: TimelineStage): boolean {
        return stage.operatorState === 'waiting' && stage.prioritizable === true;
    }

    function openAction(
        kind: 'retry' | 'reevaluate' | 'give-up' | 'resume' | 'unignore',
        stageId: string | null,
        label: string,
        taskId?: string,
    ): void {
        actionError = null;
        pending = { kind, stageId, label, taskId };
    }

    async function confirmAction(): Promise<void> {
        if (!pending) return;
        const { kind, stageId, taskId } = pending;
        try {
            if (kind === 'resume') {
                if (!taskId) throw new Error('missing task');
                // Same call the task dashboard's "Resume" makes — one shared
                // contract for turning a task's schedule back on.
                const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/state`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ schedule: 'active' }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } else {
                const url =
                    kind === 'retry'
                        ? `/api/admin/media/${mediaItemId}/pipeline`
                        : kind === 'give-up'
                          ? `/api/admin/media/${mediaItemId}/pipeline/give-up`
                          : kind === 'unignore'
                            ? `/api/admin/media/${mediaItemId}/pipeline/unignore`
                            : `/api/admin/media/${mediaItemId}/pipeline/reevaluate`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(stageId ? { stageId } : {}),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                // `restored: 0` is a 200, not an error: the row stopped being
                // an operator skip between render and click (an invalidation
                // brought it back on its own). Reporting a bare success would
                // claim credit for something that did not happen here, and the
                // refresh below would show a row that never moved.
                if (kind === 'unignore') {
                    const body = (await res.json()) as { restored?: number };
                    if (!body.restored) {
                        actionError = m.admin_pipeline_row_unignore_gone();
                        onremediated?.();
                        return;
                    }
                }
            }
            pending = null;
            onremediated?.();
        } catch (e) {
            actionError = (e as Error).message;
        }
    }

    /**
     * Start an express, item-scoped run of one step. Reports what actually
     * happened rather than a blanket success: joining a run the sweep already
     * started is a different outcome from jumping the queue, and the operator
     * watching for their poster needs to know which one they got.
     */
    async function prioritize(stage: TimelineStage): Promise<void> {
        prioritizeState = {
            ...prioritizeState,
            [stage.stageId]: { busy: true, message: null },
        };
        let message: string;
        try {
            const res = await fetch(`/api/admin/media/${mediaItemId}/pipeline/prioritize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stageId: stage.stageId }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as {
                started?: boolean;
                deduped?: boolean;
            };
            message = !body.started
                ? m.admin_pipeline_row_prioritize_unavailable()
                : body.deduped
                  ? m.admin_pipeline_row_prioritize_deduped()
                  : m.admin_pipeline_row_prioritize_started();
            if (body.started) onremediated?.();
        } catch (e) {
            message = m.admin_pipeline_row_prioritize_failed({ error: (e as Error).message });
        }
        prioritizeState = {
            ...prioritizeState,
            [stage.stageId]: { busy: false, message },
        };
    }

    function toggleBlast(stageId: string): void {
        blastOpen = { ...blastOpen, [stageId]: !blastOpen[stageId] };
    }
</script>

<div class="space-y-3">
    <!-- Header-level "all stages" actions mirror the all-stages body shape. -->
    <div class="flex flex-wrap gap-2">
        {#if hasFailed}
            <button
                type="button"
                class="btn btn-red btn-sm"
                onclick={() => openAction('retry', null, 'all failed steps')}>
                Retry all failed
            </button>
        {/if}
        {#if hasReevaluable}
            <button
                type="button"
                class="btn btn-blue btn-sm"
                onclick={() => openAction('reevaluate', null, 'all applicable steps')}>
                Re-evaluate all
            </button>
        {/if}
    </div>

    {#if hasReevaluable}<p class="text-xs text-zinc-400">{m.pipeline_reevaluate_hint()}</p>{/if}
    <ol class="space-y-2">
        {#each stages as stage (stage.stageId)}
            <!-- Bound once as an immediate child of the {#each} so the {#if}
                 below narrows `string | null` to `string`. Calling
                 owningTaskHint() separately in the guard and the body left it
                 unnarrowed at the call site (TS cannot relate two calls). -->
            {@const owningTask = owningTaskHint(stage)}
            <li class="rounded bg-zinc-900/40 p-3 {stateStyle(stage).row}">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="flex min-w-0 flex-col gap-1.5">
                        <div class="flex flex-wrap items-center gap-2">
                            <span
                                class="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {stateStyle(
                                    stage,
                                ).pill}">
                                {stateLabel(stage)}
                            </span>
                            <span class="text-sm font-medium text-zinc-100"
                                >{pipelineStepName(stage.stageId)}</span>
                            {#if owningTask}
                                <span class="text-xs text-zinc-500"
                                    >{m.admin_pipeline_step_part_of({
                                        task: owningTask,
                                    })}</span>
                            {/if}
                            {#if stepDescription(stage)}
                                <Tooltip
                                    text={stepDescription(stage)}
                                    position="bottom"
                                    fixed
                                    wrap
                                    inline>
                                    <button
                                        type="button"
                                        aria-label={m.admin_pipeline_step_help_aria()}
                                        class="cursor-help rounded-full text-zinc-500 hover:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-sky-500">
                                        <Icon src={QuestionMarkCircle} class="h-4 w-4" />
                                    </button>
                                </Tooltip>
                            {/if}
                            {#if devMode}
                                <span class="font-mono text-[11px] text-zinc-500"
                                    >{stage.stageId}</span>
                                {#if stage.taskId}
                                    <span class="font-mono text-[11px] text-zinc-600"
                                        >{stage.taskId}</span>
                                {/if}
                            {/if}
                            <span class="text-[11px] text-zinc-600"
                                >v{stage.processingVersion}</span>
                            {#if stage.attempt > 0}
                                <span class="text-[11px] text-zinc-600"
                                    >attempt {stage.attempt}</span>
                            {/if}
                        </div>

                        <!--
                            The one line the operator actually reads. Exactly one
                            of the five branches renders, so the row can never be
                            ambiguous between "waiting" and "broken".
                        -->
                        {#if stage.inputScope && stage.inputScope !== 'current'}
                            <p class="text-xs text-amber-300">
                                {stage.inputScope === 'earlier'
                                    ? m.media_source_failure_earlier()
                                    : m.media_source_failure_unverified()}
                            </p>
                            {#if stage.lastError}<details>
                                    <summary class="text-xs cursor-pointer"
                                        >{m.media_source_retained_details()}</summary
                                    ><StageErrorBlock error={stage.lastError} />
                                </details>{/if}
                        {/if}
                        {#if stage.operatorState === 'done'}
                            <span class="text-xs text-zinc-400">{doneLine(stage)}</span>
                        {:else if stage.operatorState === 'off'}
                            <span class="text-xs text-amber-200"
                                >{m.admin_pipeline_row_off_summary()}</span>
                            {#if offByLine(stage)}
                                <span class="text-[11px] text-zinc-500">{offByLine(stage)}</span>
                            {/if}
                            <span class="text-[11px] text-zinc-500"
                                >{m.admin_pipeline_row_off_killswitch_hint()}</span>
                        {:else if stage.operatorState === 'skipped'}
                            <span class="text-xs text-zinc-400">{skippedLine(stage)}</span>
                        {:else if stage.operatorState === 'waiting'}
                            {#if stage.queueWait}
                                <Tooltip
                                    text={m.admin_pipeline_row_waiting_position_title()}
                                    position="bottom"
                                    fixed
                                    wrap
                                    inline>
                                    <span class="text-xs text-sky-200">
                                        {aheadLabel(stage)}{#if etaLabel(stage)}<span
                                                class="text-zinc-400">
                                                · {etaLabel(stage)}</span
                                            >{/if}
                                    </span>
                                </Tooltip>
                            {/if}
                            <!--
                                A waiting row that is waiting on SOMETHING (a
                                breaker, a lock, backpressure, a backoff) has no
                                queue position; the diagnosis badge is the whole
                                explanation in that case.
                            -->
                            {#if stage.diagnosis && stage.diagnosis.reason !== 'none' && stage.diagnosis.reason !== 'running-healthy'}
                                <StageDiagnosisBadge diagnosis={stage.diagnosis} />
                            {:else if stage.diagnosis?.detail.coordination === 'season-cohort'}
                                <span class="text-xs text-zinc-400">{stage.diagnosis.summary}</span>
                            {/if}
                        {:else if stage.operatorState === 'failed'}
                            {#if stage.lastError}
                                <StageErrorBlock error={stage.lastError} />
                            {:else}
                                <span class="text-xs text-red-300"
                                    >{m.admin_pipeline_row_failed_no_detail()}</span>
                            {/if}
                            {#if blastLine(stage)}
                                <div class="flex flex-col gap-0.5">
                                    <div class="flex flex-wrap items-center gap-2">
                                        <span
                                            class="text-xs {(stage.blastRadius?.otherItems ?? 0) > 0
                                                ? 'text-amber-300'
                                                : 'text-zinc-400'}">
                                            {blastLine(stage)}
                                        </span>
                                        {#if (stage.blastRadius?.samples.length ?? 0) > 0}
                                            <button
                                                type="button"
                                                class="text-[11px] text-sky-400 hover:underline"
                                                onclick={() => toggleBlast(stage.stageId)}>
                                                {blastOpen[stage.stageId]
                                                    ? m.admin_pipeline_row_blast_hide()
                                                    : m.admin_pipeline_row_blast_show()}
                                            </button>
                                        {/if}
                                    </div>
                                    {#if (stage.blastRadius?.otherItems ?? 0) > 0}
                                        <span class="text-[11px] text-zinc-500"
                                            >{m.admin_pipeline_row_blast_hint()}</span>
                                    {/if}
                                    {#if blastOpen[stage.stageId] && stage.blastRadius}
                                        <ul class="mt-0.5 flex flex-col gap-0.5">
                                            {#each stage.blastRadius.samples as sample (sample.mediaItemId)}
                                                <li>
                                                    <a
                                                        class="text-[11px] text-sky-400 hover:underline"
                                                        href={resolve(
                                                            `/admin/library/media/${sample.mediaItemId}?tab=pipeline`,
                                                        )}>
                                                        {sample.title}
                                                    </a>
                                                </li>
                                            {/each}
                                        </ul>
                                    {/if}
                                </div>
                            {/if}
                            <!--
                                A failure on a step that is ALSO switched off:
                                the error stays the headline, but the retry the
                                status promises is never coming.
                            -->
                            {#if stage.paused}
                                <span class="text-[11px] text-amber-300"
                                    >{m.admin_pipeline_row_off_also_failed()}</span>
                            {/if}
                            {#if stage.diagnosis && stage.diagnosis.reason !== 'none' && stage.diagnosis.reason !== 'running-healthy'}
                                <StageDiagnosisBadge diagnosis={stage.diagnosis} />
                            {:else if stage.diagnosis?.detail.coordination === 'season-cohort'}
                                <span class="text-xs text-zinc-400">{stage.diagnosis.summary}</span>
                            {/if}
                        {/if}

                        {#if prioritizeState[stage.stageId]?.message}
                            <span class="text-[11px] text-emerald-300"
                                >{prioritizeState[stage.stageId]?.message}</span>
                        {/if}

                        <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-zinc-500">
                            {#if stage.startedAt}
                                <span
                                    >{currentAttemptIsLive(stage)
                                        ? m.pipeline_timing_current_started({
                                              time: new Date(stage.startedAt).toLocaleString(),
                                          })
                                        : m.pipeline_timing_historical_started({
                                              time: new Date(stage.startedAt).toLocaleString(),
                                          })}</span>
                            {/if}
                            {#if timeInStageLabel(stage)}
                                <span>{timeInStageLabel(stage)}</span>
                            {/if}
                            {#if retryCountdownLabel(stage)}
                                <span class="text-amber-400">{retryCountdownLabel(stage)}</span>
                            {/if}
                        </div>
                    </div>

                    <div class="flex flex-col items-end gap-2">
                        {#if stage.run}
                            {#if historicalRun(stage)}<span class="text-[11px] text-zinc-500"
                                    >{m.pipeline_timing_historical_run()}</span
                                >{/if}
                            <RunRefChip run={stage.run} />
                        {/if}
                        <div class="flex flex-wrap justify-end gap-1.5">
                            {#if stage.operatorState === 'off' && stage.paused}
                                <button
                                    type="button"
                                    class="btn btn-blue btn-xs"
                                    onclick={() =>
                                        openAction(
                                            'resume',
                                            stage.stageId,
                                            pipelineStepName(stage.stageId),
                                            stage.paused?.taskId,
                                        )}>
                                    {m.admin_pipeline_row_off_resume()}
                                </button>
                            {/if}
                            {#if canPrioritize(stage)}
                                <button
                                    type="button"
                                    class="btn btn-blue btn-xs"
                                    title={m.admin_pipeline_row_prioritize_title()}
                                    disabled={prioritizeState[stage.stageId]?.busy}
                                    onclick={() => void prioritize(stage)}>
                                    {m.admin_pipeline_row_prioritize()}
                                </button>
                            {/if}
                            {#if canRetry(stage)}
                                <button
                                    type="button"
                                    class="btn btn-red btn-xs"
                                    onclick={() =>
                                        openAction(
                                            'retry',
                                            stage.stageId,
                                            pipelineStepName(stage.stageId),
                                        )}>
                                    Retry
                                </button>
                            {/if}
                            {#if canReevaluate(stage)}
                                <button
                                    type="button"
                                    class="btn btn-blue btn-xs"
                                    onclick={() =>
                                        openAction(
                                            'reevaluate',
                                            stage.stageId,
                                            pipelineStepName(stage.stageId),
                                        )}>
                                    Re-evaluate
                                </button>
                            {/if}
                            {#if canGiveUp(stage)}
                                <button
                                    type="button"
                                    class="btn btn-gray btn-xs"
                                    onclick={() =>
                                        openAction(
                                            'give-up',
                                            stage.stageId,
                                            pipelineStepName(stage.stageId),
                                        )}>
                                    Give up
                                </button>
                            {/if}
                            {#if canUnignore(stage)}
                                <button
                                    type="button"
                                    class="btn btn-blue btn-xs"
                                    title={m.admin_pipeline_row_unignore_title()}
                                    onclick={() =>
                                        openAction(
                                            'unignore',
                                            stage.stageId,
                                            pipelineStepName(stage.stageId),
                                        )}>
                                    {m.admin_pipeline_row_unignore()}
                                </button>
                            {/if}
                        </div>
                    </div>
                </div>
            </li>
        {/each}
    </ol>
</div>

{#if pending}
    <ActionModal
        title={pending.kind === 'retry'
            ? 'Retry failed step(s)?'
            : pending.kind === 'give-up'
              ? 'Give up on this step?'
              : pending.kind === 'resume'
                ? m.admin_pipeline_row_off_resume_title()
                : pending.kind === 'unignore'
                  ? m.admin_pipeline_row_unignore_title()
                  : 'Check again?'}
        confirmText={pending.kind === 'retry'
            ? 'Retry'
            : pending.kind === 'give-up'
              ? 'Give up'
              : pending.kind === 'resume'
                ? m.admin_pipeline_row_off_resume()
                : pending.kind === 'unignore'
                  ? m.admin_pipeline_row_unignore()
                  : 'Re-evaluate'}
        confirmColor={pending.kind === 'reevaluate' ||
        pending.kind === 'resume' ||
        pending.kind === 'unignore'
            ? 'blue'
            : 'red'}
        onclose={() => (pending = null)}
        onconfirm={confirmAction}>
        <p class="text-sm text-zinc-300">
            {#if pending.kind === 'retry'}
                This puts <strong>{pending.label}</strong> back in line so the pipeline tries it again
                after it had given up.
            {:else if pending.kind === 'give-up'}
                <!--
                  This used to promise "you can bring it back later by retrying".
                  It could not: Retry is gated on `failed_permanent`, while
                  giving up writes `skipped_permanent`, so the button it pointed
                  at never appeared. Un-ignore is the real way back.
                -->
                This stops the pipeline from retrying <strong>{pending.label}</strong> for this item
                and marks it ignored. You can lift that later with <strong>Un-ignore</strong>, and
                it comes back on its own if the file changes.
            {:else if pending.kind === 'unignore'}
                {m.admin_pipeline_row_unignore_body({ label: pending.label })}
            {:else if pending.kind === 'resume'}
                {m.admin_pipeline_row_off_resume_body()}
            {:else}
                {m.pipeline_reevaluate_scope({ label: pending.label })}
            {/if}
        </p>
        {#if actionError}
            <p class="text-sm text-red-400">Error: {actionError}</p>
        {/if}
    </ActionModal>
{/if}
