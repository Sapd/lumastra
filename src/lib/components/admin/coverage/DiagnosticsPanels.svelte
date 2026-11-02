<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    Three diagnostics panels stacked below the metro map:

    1. Stuck Items   — stages selected by running-age, attempt-count, or dormant-pending criteria.
    2. Dead Letter   — failed_permanent items that stopped retrying (any reason —
                        NOT the narrower "needs re-identification" population;
                        see the doc comment on the HealthStrip chip of the same
                        name and `IngestPipelineSummary.reidentifyItems`).
    3. Error Groups  — recent errors clustered by fingerprint with counts.

    All three are anchored (`id="stuck-items"`, `id="dead-letter"`,
    `id="error-groups"`) so the HealthStrip chips can deep-link.

    Empty states collapse to a single muted line so the page doesn't
    grow visually heavy on a healthy install.
-->
<script lang="ts">
    import { Icon, ChevronRight } from 'svelte-hero-icons';
    import { SvelteSet } from 'svelte/reactivity';
    import { formatTrainHeadline } from './ingest-map.constants.js';
    import { pipelineStepName } from '$lib/config/pipeline-step-names.js';
    import { taskStatusLabel } from '$lib/utils/operator-labels';
    import { formatAttempts } from '$lib/utils/admin/formatters';
    // These two panel headings are the operator's first encounter with the
    // two least-guessable words in the whole task system. Both glossary
    // entries now carry a docHref into the matching troubleshooting recipe,
    // so tooltipping the heading also buys the deep link for free.
    import TermTooltip from '$lib/components/admin/glossary/TermTooltip.svelte';
    import { explainRunError } from '$lib/utils/admin/run-error-display';
    import * as m from '$lib/paraglide/messages.js';
    import type { StuckItemEntry, DeadLetterEntry, ErrorGroupEntry } from './ingest-map.types.js';
    import { resolve } from '$lib/paths';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { modals } from '$lib/stores/modal.store';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import {
        PipelineResetResponseSchema,
        PipelineReevaluateResponseSchema,
    } from '$lib/schemas/pipeline-timeline.schema.js';
    import { StageActionResponseSchema } from '$lib/schemas/api-attention-responses.js';

    interface Props {
        stuckItems: StuckItemEntry[];
        deadLetter: DeadLetterEntry[];
        errorGroups: ErrorGroupEntry[];
        /**
         * True total dead-letter item count — the same number the
         * HealthStrip "stopped retrying" chip shows. `deadLetter` itself is
         * capped server-side (diagnostics endpoint limit), so when this is
         * larger than `deadLetter.length` the header shows "showing first N
         * of TOTAL" instead of silently rendering a partial list as if it
         * were complete.
         */
        deadLetterTotal?: number;
        /** Re-fetch the diagnostics after an action changed them. */
        onchanged?: () => void;
    }

    const { stuckItems, deadLetter, errorGroups, deadLetterTotal, onchanged }: Props = $props();

    function stuckReasonLabel(reason: StuckItemEntry['reason'], attempt: number): string {
        switch (reason) {
            case 'running_stale':
                return m.admin_pipeline_stuck_reason_running_stale();
            case 'attempt_threshold':
                return m.admin_pipeline_stuck_reason_attempt_threshold({ count: attempt });
            case 'pending_dormant':
                return m.admin_pipeline_stuck_reason_pending_dormant();
            default:
                return m.admin_pipeline_stuck_reason_unknown();
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────
    // These panels listed stuck and given-up items with nothing to do about
    // them but open each media page. The endpoints already existed (per-item
    // reset / re-evaluate, stage-wide retry) — they just had no button here.
    const busy = new SvelteSet<string>();

    async function retryItem(item: DeadLetterEntry): Promise<void> {
        const key = `${item.media_item_id}:${item.stage_id}`;
        if (busy.has(key)) return;
        busy.add(key);
        try {
            const { data, error } = await apiPost(
                `/api/admin/media/${encodeURIComponent(item.media_item_id)}/pipeline`,
                PipelineResetResponseSchema,
                { stageId: item.stage_id },
            );
            if (error || !data)
                toasts.error(m.admin_pipeline_action_failed({ error: error ?? '' }));
            else {
                toasts.success(m.admin_pipeline_retry_item_done());
                onchanged?.();
            }
        } finally {
            busy.delete(key);
        }
    }

    async function processNow(item: StuckItemEntry): Promise<void> {
        const key = `${item.media_item_id}:${item.stage_id}`;
        if (busy.has(key)) return;
        busy.add(key);
        try {
            const { data, error } = await apiPost(
                `/api/admin/media/${encodeURIComponent(item.media_item_id)}/pipeline/reevaluate`,
                PipelineReevaluateResponseSchema,
                { stageId: item.stage_id },
            );
            if (error || !data)
                toasts.error(m.admin_pipeline_action_failed({ error: error ?? '' }));
            else if (data.enqueued > 0) {
                toasts.success(m.admin_pipeline_process_now_done());
                onchanged?.();
            } else toasts.info(m.admin_pipeline_process_now_skipped());
        } finally {
            busy.delete(key);
        }
    }

    async function doRetryAll(): Promise<void> {
        if (busy.has('*')) return;
        busy.add('*');
        try {
            // Every stage is tried even if one fails (see TaskFailuresList).
            let reset = 0;
            let firstError: string | null = null;
            for (const stageId of new Set(deadLetter.map((d) => d.stage_id))) {
                const { data, error } = await apiPost(
                    '/api/admin/task-system/pipeline/retry-stage',
                    StageActionResponseSchema,
                    { stageId },
                );
                if (error || !data) {
                    firstError ??= error ?? '';
                    continue;
                }
                reset += data.count;
            }
            if (reset > 0 || firstError === null) {
                toasts.success(m.admin_pipeline_retry_all_done({ count: reset }));
            }
            if (firstError !== null) {
                toasts.error(m.admin_pipeline_action_failed({ error: firstError }));
            }
            onchanged?.();
        } finally {
            busy.delete('*');
        }
    }

    function retryAll(): void {
        modals.open(ConfirmModal, {
            title: m.admin_pipeline_retry_all(),
            body: m.admin_pipeline_retry_all_body(),
            confirmText: m.admin_pipeline_retry_all(),
            confirmVariant: 'primary',
            onConfirm: () => doRetryAll(),
        });
    }

    /**
     * Attempt wording per list. "before the first attempt" under "stopped
     * retrying" read as a contradiction: for a given-up row it means the very
     * first try failed permanently; for a stuck row, that it was never tried.
     */
    function deadAttempts(attempt: number): string {
        return attempt > 0 ? formatAttempts(attempt) : m.admin_pipeline_gave_up_first_try();
    }
    function stuckAttempts(attempt: number): string {
        return attempt > 0 ? formatAttempts(attempt) : m.admin_pipeline_not_tried_yet();
    }

    // Mirrors the diagnostics endpoint's hardcoded per-list LIMIT (see
    // src/routes/api/admin/ingest/diagnostics/+server.ts). Stuck items and
    // error groups have no true-total query backing them (unlike dead
    // letter, which reuses `PipelineSummary.deadLetterItems`), so those two
    // panels can only signal "the cap was probably hit", not an exact total.
    const DIAGNOSTICS_LIST_LIMIT = 20;

    // Which dead-letter row (keyed by `media_item_id:stage_id`, same as the
    // `{#each}` key) currently has its raw error expanded below the row.
    const expandedErrors = new SvelteSet<string>();
    function toggleError(key: string): void {
        if (expandedErrors.has(key)) expandedErrors.delete(key);
        else expandedErrors.add(key);
    }

    /**
     * Humanize a delta-in-seconds for the "stuck 3h 12m" column.
     * Matches the format used elsewhere in the page (HealthStrip,
     * MetroLine activity caption) so the numbers read consistently.
     */
    function formatAge(sec: number): string {
        if (!Number.isFinite(sec) || sec < 0) return '—';
        if (sec < 60) return `${sec}s`;
        if (sec < 3600) return `${Math.round(sec / 60)}m`;
        if (sec < 86400) return `${Math.round(sec / 3600)}h`;
        return `${Math.round(sec / 86400)}d`;
    }

    /**
     * `pipelineStepName` is the canonical stage id → friendly display name
     * map (admin IA redesign, spec §3.3 "friendly step names everywhere").
     * Falls back to a humanized form of the id for plugin stages we don't
     * have a curated name for yet — never the raw kebab-case id.
     */
    function stageLabel(stageId: string): string {
        return pipelineStepName(stageId);
    }

    /**
     * Take the first line of `last_error.message` and cap at 140 chars
     * so a multi-paragraph stack trace doesn't blow up the row height.
     * Full message is exposed via the title attribute.
     */
    function shortError(msg: string | undefined): string {
        if (!msg) return '—';
        const first = msg.split('\n')[0];
        return first.length > 140 ? first.slice(0, 137) + '…' : first;
    }

    /** Status pill palette — mirrors PipelineTab + StageCell so colors are consistent. */
    function statusClass(s: string): string {
        if (s === 'running') return 'bg-sky-900/40 text-sky-200';
        if (s === 'pending') return 'bg-zinc-800/60 text-zinc-300';
        if (s === 'failed_transient') return 'bg-amber-900/40 text-amber-200';
        if (s === 'failed_permanent') return 'bg-red-900/40 text-red-200';
        if (s === 'skipped_transient') return 'bg-amber-900/20 text-amber-300';
        if (s === 'skipped_permanent') return 'bg-zinc-700/40 text-zinc-300';
        if (s === 'completed') return 'bg-emerald-900/30 text-emerald-200';
        if (s === 'obsolete') return 'bg-purple-900/40 text-purple-200';
        return 'bg-zinc-900/60 text-zinc-500';
    }
</script>

<!-- ── Stuck Items ───────────────────────────────────────────────── -->
<section
    id="stuck-items"
    class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
    aria-label={m.admin_pipeline_stuck_items_aria()}>
    <header class="mb-2 flex items-baseline justify-between gap-2">
        <div class="flex items-baseline gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <TermTooltip term="stuck-wedged">
                    {m.admin_pipeline_stuck_items_heading()}
                </TermTooltip>
            </h3>
            <span class="text-xs {stuckItems.length > 0 ? 'text-amber-400' : 'text-zinc-500'}">
                {#if stuckItems.length >= DIAGNOSTICS_LIST_LIMIT}
                    ({m.admin_pipeline_showing_first_capped({ shown: stuckItems.length })})
                {:else}
                    ({stuckItems.length})
                {/if}
            </span>
        </div>
        <span class="text-xs text-zinc-600" title={m.admin_pipeline_stuck_items_criteria_title()}>
            {m.admin_pipeline_stuck_items_criteria()}
        </span>
    </header>
    {#if stuckItems.length === 0}
        <p class="text-xs text-zinc-600">
            {m.admin_pipeline_stuck_items_empty()}
        </p>
    {:else}
        <ul class="space-y-1 text-xs">
            {#each stuckItems as item (item.media_item_id + ':' + item.stage_id)}
                {@const headline = formatTrainHeadline({
                    media_type: item.media_type,
                    title: item.title,
                    series_title: item.series_title,
                    season_number: item.season_number,
                    episode_number: item.episode_number,
                })}
                <li class="flex items-start gap-3 rounded bg-zinc-900/60 px-2 py-1.5">
                    <span
                        class="mt-0.5 inline-block min-w-[3.5rem] text-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-200 ring-1 ring-amber-700/40"
                        title={m.admin_pipeline_stuck_age_title()}>
                        {formatAge(item.stuck_age_sec)}
                    </span>
                    <span
                        class="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide {statusClass(
                            item.status,
                        )}">
                        {taskStatusLabel(item.status)}
                    </span>
                    <span class="min-w-0 flex-1">
                        <a
                            href={resolve(
                                `/admin/library/media/${item.media_item_id}?tab=pipeline`,
                            )}
                            class="block truncate font-medium text-zinc-200 hover:text-white hover:underline"
                            title={headline}>
                            {headline}
                        </a>
                        <span class="block truncate text-[11px] text-zinc-500">
                            at <span>{stageLabel(item.stage_id)}</span>
                            · {stuckAttempts(item.attempt)}
                            {#if item.last_error?.message}
                                · <span class="text-zinc-400" title={item.last_error.message}
                                    >{shortError(item.last_error.message)}</span>
                            {/if}
                        </span>
                        <span class="block truncate text-[11px] text-zinc-400">
                            {m.admin_pipeline_stuck_reason_label()}:
                            {stuckReasonLabel(item.reason, item.attempt)}
                        </span>
                    </span>
                    <button
                        type="button"
                        class="shrink-0 self-center rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        disabled={busy.has(`${item.media_item_id}:${item.stage_id}`)}
                        title={m.admin_pipeline_process_now_title()}
                        onclick={() => void processNow(item)}>
                        {m.admin_pipeline_process_now()}
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
</section>

<!-- ── Dead Letter ──────────────────────────────────────────────── -->
<section
    id="dead-letter"
    class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
    aria-label={m.admin_pipeline_deadletter_aria()}>
    <header class="mb-2 flex items-baseline justify-between gap-2">
        <div class="flex items-baseline gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <TermTooltip term="dead-letter">
                    {m.admin_pipeline_deadletter_heading()}
                </TermTooltip>
            </h3>
            <span class="text-xs {deadLetter.length > 0 ? 'text-red-400' : 'text-zinc-500'}">
                {#if deadLetterTotal !== undefined && deadLetterTotal > deadLetter.length}
                    ({m.admin_pipeline_showing_first_of_total({
                        shown: deadLetter.length,
                        total: deadLetterTotal,
                    })})
                {:else}
                    ({deadLetter.length})
                {/if}
            </span>
        </div>
        <span class="flex items-center gap-3">
            <span
                class="text-xs text-zinc-600"
                title={m.admin_pipeline_deadletter_criteria_title()}>
                {m.admin_pipeline_deadletter_criteria()}
            </span>
            {#if deadLetter.length > 0}
                <button
                    type="button"
                    class="rounded border border-amber-700/50 bg-amber-900/20 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-900/40 disabled:opacity-50"
                    disabled={busy.has('*')}
                    onclick={retryAll}>
                    {m.admin_pipeline_retry_all()}
                </button>
            {/if}
        </span>
    </header>
    {#if deadLetter.length === 0}
        <p class="text-xs text-zinc-600">{m.admin_pipeline_deadletter_empty()}</p>
    {:else}
        <ul class="space-y-1 text-xs">
            {#each deadLetter as item (item.media_item_id + ':' + item.stage_id)}
                {@const headline = formatTrainHeadline({
                    media_type: item.media_type,
                    title: item.title,
                    series_title: item.series_title,
                    season_number: item.season_number,
                    episode_number: item.episode_number,
                })}
                {@const rowKey = item.media_item_id + ':' + item.stage_id}
                {@const errorMessage = item.last_error?.message}
                {@const explained = errorMessage ? explainRunError(errorMessage) : null}
                {@const expanded = expandedErrors.has(rowKey)}
                <li class="rounded bg-zinc-900/60 transition-colors hover:bg-zinc-800/70">
                    <div class="flex items-center gap-2 pr-2">
                        <a
                            href={resolve(
                                `/admin/library/media/${item.media_item_id}?tab=pipeline`,
                            )}
                            class="group flex min-w-0 flex-1 items-start gap-3 px-2 py-1.5"
                            title={headline}>
                            <span
                                class="mt-0.5 inline-block min-w-[3.5rem] text-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-red-200 ring-1 ring-red-700/40"
                                title={m.admin_pipeline_deadletter_gave_up_title({
                                    age: formatAge(item.dead_age_sec),
                                })}>
                                {formatAge(item.dead_age_sec)}
                            </span>
                            <span class="min-w-0 flex-1">
                                <span
                                    class="block truncate font-medium text-zinc-200 group-hover:text-white group-hover:underline">
                                    {headline}
                                </span>
                                <!-- flex (not `truncate` text) because the error text lives in a
                                 <button>: an atomic inline that overflows a text-overflow
                                 container is elided ENTIRELY by the browser — the message
                                 would render as a bare "…". A min-w-0 flex child truncates
                                 itself instead. -->
                                <span
                                    class="flex min-w-0 gap-1 text-[11px] whitespace-nowrap text-zinc-500">
                                    <span class="shrink-0"
                                        >at <span>{stageLabel(item.stage_id)}</span>
                                        · {deadAttempts(item.attempt)}</span>
                                    {#if errorMessage}
                                        <span class="shrink-0">·</span>
                                        <button
                                            type="button"
                                            class="min-w-0 truncate text-left text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
                                            title={errorMessage}
                                            aria-expanded={expanded}
                                            aria-label={expanded
                                                ? m.admin_pipeline_error_hide_details()
                                                : m.admin_pipeline_error_show_details()}
                                            onclick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                toggleError(rowKey);
                                            }}>
                                            {explained
                                                ? explained.summary
                                                : shortError(errorMessage)}
                                        </button>
                                    {/if}
                                </span>
                            </span>
                            <Icon
                                src={ChevronRight}
                                class="mt-0.5 h-3.5 w-3.5 shrink-0 self-center text-zinc-600 transition-colors group-hover:text-zinc-300"
                                aria-hidden="true" />
                        </a>
                        <button
                            type="button"
                            class="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                            disabled={busy.has(rowKey)}
                            onclick={() => void retryItem(item)}>
                            {m.admin_pipeline_retry_item()}
                        </button>
                    </div>
                    {#if expanded && errorMessage}
                        <div
                            class="mx-2 mb-1.5 rounded bg-red-950/30 px-2 py-1.5 text-[11px] break-words whitespace-pre-wrap text-red-200">
                            {#if explained}
                                <p class="mb-1 text-zinc-300">{explained.hint}</p>
                            {/if}
                            {errorMessage}
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</section>

<!-- ── Error Groups ─────────────────────────────────────────────── -->
<section
    id="error-groups"
    class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
    aria-label={m.admin_pipeline_error_groups_aria()}>
    <header class="mb-2 flex items-baseline justify-between gap-2">
        <div class="flex items-baseline gap-2">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {m.admin_pipeline_error_groups_heading()}
            </h3>
            <span class="text-xs {errorGroups.length > 0 ? 'text-amber-400' : 'text-zinc-500'}">
                ({errorGroups.length})
            </span>
        </div>
        <span class="text-xs text-zinc-600" title={m.admin_pipeline_error_groups_criteria_title()}>
            {m.admin_pipeline_error_groups_criteria()}
        </span>
    </header>
    {#if errorGroups.length === 0}
        <!-- Scoped to pipeline STEPS. "No errors in the last 24 hours. Nice."
             sat on prod while three task runs had failed that morning — those
             live on the Runs page, and this line now says so. -->
        <p class="text-xs text-zinc-600">
            {m.admin_pipeline_error_groups_empty()}
            <a
                href="{resolve('/admin/tasks/runs')}?status=failed"
                class="text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
                >{m.admin_pipeline_error_groups_runs_link()}</a>
        </p>
    {:else}
        <ul class="space-y-1 text-xs">
            {#each errorGroups as group (group.stage_id + ':' + group.fingerprint)}
                <li class="rounded bg-zinc-900/60 px-2 py-1.5">
                    <div class="flex items-baseline gap-2">
                        <span
                            class="inline-block min-w-[3rem] text-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-700/40"
                            title={m.admin_pipeline_error_groups_count_title()}>
                            ×{group.count}
                        </span>
                        <span class="text-[11px] text-zinc-400">{stageLabel(group.stage_id)}</span>
                        {#if group.error_code}
                            <span
                                class="rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                                >{group.error_code}</span>
                        {/if}
                        <span class="ml-auto text-[10px] text-zinc-500">
                            {m.admin_pipeline_error_groups_last_seen({
                                age: formatAge(
                                    Math.max(
                                        0,
                                        Math.round(
                                            (Date.now() - Date.parse(group.last_seen)) / 1000,
                                        ),
                                    ),
                                ),
                            })}
                        </span>
                    </div>
                    <div class="mt-1 truncate text-zinc-300" title={group.sample_message}>
                        {shortError(group.sample_message)}
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</section>
