<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §3.3 Runs row: one row per run. Failure reason
  renders INLINE on the row (plain words + a "details" disclosure for the
  raw stack — spec §7's error contract), and items-processed renders inline
  via the shared `formatCount` (spec §5 "every count names its unit").
-->
<script lang="ts">
    import AriaProgressBar from '$lib/components/ui/AriaProgressBar.svelte';
    import CompactRunProgress from './CompactRunProgress.svelte';
    import { RUN_STATE_BADGE } from '$lib/components/admin/tasks/run-state-badges.js';
    import TaskStatusBadge from '$lib/components/admin/tasks/TaskStatusBadge.svelte';
    import { runDetailPanel } from '$lib/stores/run-detail-panel.js';
    import { formatCount } from '$lib/utils/admin/formatters.js';
    import { runItemsProcessed } from './run-items-processed.js';
    import { resumeLabel } from './run-labels.js';
    import {
        explainRunError,
        stripTaskIdPrefix,
        classifyRunErrorSeverity,
    } from '$lib/utils/admin/run-error-display.js';
    import * as m from '$lib/paraglide/messages.js';
    import type { RunWithMediaItem } from '$lib/schemas/run.schema.js';
    import type { BadgeProps } from '$lib/components/admin/tasks/badge-types.js';

    interface Props {
        run: RunWithMediaItem;
    }

    let { run }: Props = $props();

    function elapsedMs(r: RunWithMediaItem): number | null {
        const anchor = r.state === 'pending' ? r.startedAt : r.executionStartedAt;
        if (!anchor) return null;
        const start = Date.parse(anchor);
        if (!Number.isFinite(start)) return null;
        const end = r.completedAt ? Date.parse(r.completedAt) : Date.now();
        return Math.max(0, end - start);
    }

    // NOT `formatDurationMs` from the shared formatters module — that one
    // bottoms out at minute granularity (`formatDurationHoursMinutes`),
    // which is right for schedule/expiry copy but would render every
    // sub-minute run (the common case) as an undifferentiated "0 min". Run
    // rows need second-level granularity, so this keeps its own formatter.
    function formatElapsed(ms: number | null): string {
        if (ms === null || !Number.isFinite(ms) || ms < 0) return m.admin_run_execution_unknown();
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const mins = Math.floor(s / 60);
        const r = s % 60;
        if (mins < 60) return `${mins}m ${r}s`;
        const h = Math.floor(mins / 60);
        return `${h}h ${mins % 60}m`;
    }

    function badgeProps(r: RunWithMediaItem): BadgeProps {
        if (r.state === 'pending') {
            if (r.admissionObservation === 'playback-deferred')
                return { color: 'yellow', label: m.admin_run_playback_deferred() };
            if (r.admissionObservation === 'waiting')
                return { color: 'blue', label: m.admin_run_confirmed_waiting() };
            return { color: 'gray', label: m.admin_run_recorded_unconfirmed() };
        }
        if (
            (r.state === 'active' || r.state === 'cancelling') &&
            r.admissionObservation !== 'active'
        )
            return { color: 'gray', label: m.admin_run_recorded_unconfirmed() };
        const state = r.state;
        const key =
            state === 'active'
                ? 'running'
                : state === 'cancelling'
                  ? 'cancelling'
                  : state === 'cancelled'
                    ? 'cancelled'
                    : state === 'completed'
                      ? 'completed'
                      : state === 'failed'
                        ? 'failed'
                        : state === 'pending'
                          ? 'queued'
                          : 'idle';
        const base = RUN_STATE_BADGE[key] ?? RUN_STATE_BADGE.idle;
        // Self-healing failures (rate limits, quotas — expected to resume on
        // their own) wear amber instead of the red used for real outages, so
        // an operator scanning the row can tell "this needs no action" apart
        // from "this needs attention" at a glance.
        if (key === 'failed' && isExpectedFailure) {
            return { ...base, color: 'amber', tooltip: m.admin_run_error_expected_badge_tooltip() };
        }
        return base;
    }

    function actorLabel(r: RunWithMediaItem): string {
        if (r.trigger.kind === 'scheduled') return m.admin_run_actor_scheduled();
        if (r.actor.id) return m.admin_run_actor_by({ actor: r.actor.id });
        return r.trigger.kind;
    }

    /**
     * Pull a short item-context label from `run.input` when the task is
     * per-item. Without this, 200 simultaneous `Trickplay Generation`
     * runs all look identical — admins can't tell them apart at-a-glance.
     * Shows the first 8 chars of the UUID (enough to disambiguate, fits
     * the row), then full UUID in the title attribute for copy/paste.
     *
     * Gated on the UUID shape because a future task could legitimately
     * put a non-UUID into `mediaItemId` (a sentinel like `'global'`, a
     * scope identifier, etc.) — rendering "global  " as if it were an
     * ID prefix is worse than showing no chip.
     */
    const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}/i;
    function extractItemContext(input: unknown): { short: string; full: string } | null {
        if (typeof input !== 'object' || input === null) return null;
        const obj = input as Record<string, unknown>;
        const id = obj.mediaItemId;
        if (typeof id !== 'string' || !UUID_PREFIX.test(id)) return null;
        return { short: id.slice(0, 8), full: id };
    }
    let itemContext = $derived(extractItemContext(run.input));

    let activeStage = $derived(run.stages.find((s) => s.state === 'active') ?? null);
    let stageProgress = $derived.by((): number => {
        if (!activeStage || !activeStage.total || activeStage.total === 0) {
            return activeStage?.state === 'completed' ? 100 : 0;
        }
        return Math.min(100, ((activeStage.processed ?? 0) / activeStage.total) * 100);
    });
    let showProgress = $derived(
        activeStage !== null && activeStage.total !== undefined && activeStage.total > 0,
    );

    // Items processed by the whole run, for the row's inline count (spec
    // §3.3 "items-processed on the row") — shared with RunDetailPanel's
    // Summary tab via `run-items-processed.ts` so both agree on one number.
    let itemsProcessed = $derived(runItemsProcessed(run));

    // "Resumed after restart (n/3)" — the server started this run to continue
    // one a restart interrupted.
    let resumed = $derived(resumeLabel(run.trigger));

    // Plain-language failure line (spec: "humanize internal run errors").
    // `explainRunError` recognizes known runner-internal phrasings
    // ("orphaned_at_recovery", "exceeded hard timeout", raw JS crashes, …)
    // and returns a one-sentence explanation; task-authored messages (e.g.
    // "upstream outage — 0 enriched with 3 error(s)") pass through, only
    // stripped of this row's own task-id prefix since the row is already
    // scoped under the task's name. The raw message always stays available
    // via the title attribute for anyone who needs the exact wording.
    let errorDisplay = $derived.by(() => {
        if (!run.error) return null;
        const explained = explainRunError(run.error.message);
        return {
            text: explained ? explained.summary : stripTaskIdPrefix(run.error.message, run.taskId),
            raw: run.error.message,
        };
    });

    // Self-healing failures (rate limits, quotas — resume automatically) get
    // amber instead of red, both on the status badge (via `badgeProps`) and
    // the failure line below — the same amber already used for
    // `failed_transient` elsewhere in the admin UI.
    let isExpectedFailure = $derived(
        run.error ? classifyRunErrorSeverity(run.error.message) === 'expected' : false,
    );
</script>

<button
    type="button"
    class="w-full text-left rounded border border-surface-700/60 bg-surface-900/40 px-3 py-2 flex items-center gap-3 hover:bg-surface-800/60 transition-colors"
    aria-label="{run.label}, {run.state} — open details"
    aria-haspopup="dialog"
    onclick={() => runDetailPanel.open(run.id)}>
    <TaskStatusBadge {...badgeProps(run)} />

    <span class="text-sm font-medium text-surface-200 truncate flex-1 min-w-0" title={run.label}>
        {run.label}
        {#if itemContext}
            {#if run.mediaItem}
                <span
                    class="ml-1 inline-flex max-w-full items-baseline gap-1 rounded bg-surface-800/60 px-1.5 py-px text-[11px] font-normal text-surface-300"
                    title={run.mediaItem.fileName
                        ? `${run.mediaItem.title} · ${run.mediaItem.fileName}`
                        : run.mediaItem.title}
                    aria-label="Media item {run.mediaItem.title}">
                    <span class="truncate">{run.mediaItem.title}</span>
                    {#if run.mediaItem.fileName}
                        <span class="shrink-0 font-mono text-[10px] text-surface-500">
                            {run.mediaItem.fileName}
                        </span>
                    {/if}
                </span>
            {:else}
                <span
                    class="ml-1 rounded bg-surface-800/60 px-1 py-px font-mono text-[10px] text-surface-400"
                    title={`Item: ${itemContext.full}`}
                    aria-label="item {itemContext.short}">
                    {itemContext.short}
                </span>
            {/if}
        {/if}
    </span>

    {#if resumed}
        <span class="text-[10px] text-amber-300/90 shrink-0">{resumed}</span>
    {/if}

    {#if run.state === 'active' || run.state === 'cancelling'}
        <CompactRunProgress stages={run.stages} />
    {/if}

    {#if itemsProcessed !== null}
        <span class="text-xs tabular-nums text-surface-500 shrink-0">
            {formatCount(itemsProcessed.count, itemsProcessed.unit)}
        </span>
    {/if}

    {#if run.ownerInstanceId}
        <span
            class="text-[10px] font-mono text-surface-500 shrink-0 truncate max-w-24"
            title={`Running on server ${run.ownerInstanceId}`}
            aria-label="Running on server {run.ownerInstanceId}">
            {run.ownerInstanceId}
        </span>
    {/if}

    <span class="text-xs text-surface-500 shrink-0">{formatElapsed(elapsedMs(run))}</span>
    <span class="text-xs text-surface-500 shrink-0">{actorLabel(run)}</span>
</button>

{#if showProgress && activeStage}
    <div class="mt-1 px-3">
        <AriaProgressBar label={activeStage.label} value={stageProgress} />
    </div>
{/if}

{#if run.state === 'failed' && run.error && errorDisplay}
    <div class="mt-1 px-3 text-xs {isExpectedFailure ? 'text-amber-300' : 'text-red-300'}">
        <p title={errorDisplay.raw}>
            {errorDisplay.text}
            {#if isExpectedFailure}
                <span class="text-amber-400/80" title={m.admin_run_error_expected_badge_tooltip()}>
                    · {m.admin_run_error_expected_suffix()}
                </span>
            {/if}
        </p>
        {#if run.error.stack}
            <details class="mt-0.5 text-red-300/70">
                <summary class="cursor-pointer">{m.admin_error_details_toggle()}</summary>
                <p class="mt-1 whitespace-pre-wrap font-mono text-[11px]">{run.error.stack}</p>
            </details>
        {/if}
    </div>
{/if}
