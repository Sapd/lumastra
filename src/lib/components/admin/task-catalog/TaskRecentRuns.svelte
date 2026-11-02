<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import { apiGet } from '$lib/api/client.js';
    import { RunListResponseSchema } from '$lib/schemas/run.schema.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { RUN_STATE_BADGE } from '$lib/components/admin/tasks/run-state-badges.js';
    import TaskStatusBadge from '$lib/components/admin/tasks/TaskStatusBadge.svelte';
    import { stripTaskIdPrefix, explainRunError } from '$lib/utils/admin/run-error-display.js';
    import { formatAgo } from '$lib/utils/admin/formatters.js';
    import { collapseRunStreaks } from '$lib/components/admin/runs/run-streaks.js';
    import type { Run } from '$lib/schemas/run.schema.js';
    import { runDetailPanel } from '$lib/stores/run-detail-panel.js';
    import { runItemsProcessed } from '$lib/components/admin/runs/run-items-processed.js';
    import { stopReasonLabel, triggerLabel } from '$lib/components/admin/runs/run-labels.js';
    import { formatCount } from '$lib/utils/admin/formatters.js';

    interface Props {
        taskId: string;
        limit?: number;
    }

    let { taskId, limit = 20 }: Props = $props();

    /** How many runs to raise the load "raise the limit and re-fetch"
     *  step by, matching the initial page size. */
    const LOAD_MORE_STEP = 20;

    function initialLimit(): number {
        return limit;
    }

    let runs = $state<Run[]>([]);
    let currentLimit = $state(initialLimit());
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let loadingMore = $state(false);
    let fetchToken = 0;
    let unsubSSE: (() => void) | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    let expandedStreakIds = new SvelteSet<string>();

    // Consecutive failed runs sharing the same displayed failure line collapse
    // into a single row + toggle (see run-streaks.ts) — same treatment RunList
    // gives the runs page, so a task failing the same way over and over
    // doesn't bury the one useful signal under a wall of identical rows here
    // either.
    let streakItems = $derived(collapseRunStreaks(runs));

    function toggleStreak(id: string): void {
        if (expandedStreakIds.has(id)) {
            expandedStreakIds.delete(id);
        } else {
            expandedStreakIds.add(id);
        }
    }

    /** Heuristic: a full page of `currentLimit` rows means there may be
     *  more beyond it (the endpoint has no `total` count to check against). */
    let hasMore = $derived(runs.length >= currentLimit);

    function badgeProps(state: Run['state']) {
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
        return RUN_STATE_BADGE[key] ?? RUN_STATE_BADGE.idle;
    }

    function formatElapsed(r: Run): string {
        const start = Date.parse(r.startedAt);
        if (!Number.isFinite(start)) return '—';
        const end = r.completedAt ? Date.parse(r.completedAt) : Date.now();
        const ms = Math.max(0, end - start);
        if (ms < 1000) return `${ms}ms`;
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        return `${m}m ${s % 60}s`;
    }

    function formatDate(iso: string): string {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    /**
     * Inline failure line for a failed run row. `text` is the truncated
     * single-line summary shown under the row; `title` carries the full raw
     * message for the hover tooltip. Tasks bake their own id into the raw
     * message (noise inside this already task-scoped list), and runner-
     * internal phrasings ("orphaned_at_recovery" etc.) get a plain-language
     * summary via `explainRunError` when recognized.
     */
    function failureLine(run: Run): { text: string; title: string } | null {
        const raw = run.error?.message;
        if (!raw) return null;
        const stripped = stripTaskIdPrefix(raw, taskId);
        const explanation = explainRunError(stripped);
        return { text: explanation ? explanation.summary : stripped, title: raw };
    }

    async function load(more = false): Promise<void> {
        const my = ++fetchToken;
        if (more) {
            loadingMore = true;
        } else {
            // Only the first load shows the placeholder; a bus-triggered
            // refresh must not blank the list on every run event.
            loading = runs.length === 0;
        }

        const params = { taskId, limit: String(currentLimit) };
        const qs = new URLSearchParams(params).toString();
        const { data, error } = await apiGet(`/api/runs?${qs}`, RunListResponseSchema);

        if (my !== fetchToken || destroyed) return;

        if (error || !data) {
            // Keep rows already on screen; the error box is for "nothing to show".
            if (runs.length === 0) loadError = error ?? 'Could not load runs';
        } else {
            loadError = null;
            const sseMap = runSSEBus.runs;
            runs = data.items.map((r) => {
                const sseRun = sseMap.get(r.id);
                return sseRun
                    ? { ...sseRun, countSummary: sseRun.countSummary ?? r.countSummary }
                    : r;
            });
        }
        loading = false;
        loadingMore = false;
    }

    function loadMore(): void {
        if (loadingMore) return;
        currentLimit += LOAD_MORE_STEP;
        void load(true);
    }

    onMount(() => {
        unsubSSE = runSSEBus.onAnyChange(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (!destroyed) void load();
            }, 400);
        });
    });

    onDestroy(() => {
        destroyed = true;
        clearTimeout(debounceTimer);
        unsubSSE?.();
    });

    $effect(() => {
        // Reading taskId makes this effect re-run when the prop changes.
        // $effect fires once on mount, so no separate onMount load() needed.
        // Skip the load when taskId is missing — a parent passing undefined
        // during initial render would otherwise hit /api/runs?taskId=undefined.
        if (!taskId) return;
        // untrack: load() reads currentLimit synchronously, which made
        // `currentLimit` a dependency of this effect — "Load more" bumped it,
        // the effect re-ran, reset it to `limit` and reloaded page 1.
        untrack(() => {
            runs = [];
            currentLimit = limit;
            void load();
        });
    });
</script>

{#if loading}
    <div class="py-6 text-center text-sm text-surface-500">Loading runs…</div>
{:else if loadError}
    <div class="rounded border border-red-700/30 bg-red-900/20 p-3 text-sm text-red-300">
        {loadError}
        <button
            type="button"
            class="ml-3 text-xs text-red-200 underline"
            onclick={() => void load()}>
            Retry
        </button>
    </div>
{:else if runs.length === 0}
    <div
        class="rounded border border-surface-700/40 bg-surface-900/30 p-6 text-center text-sm text-surface-500">
        {m.admin_runs_empty()}
    </div>
{:else}
    <div class="text-xs text-surface-500 mb-3 flex items-center justify-between gap-3">
        <span>{m.admin_task_runs_showing({ count: runs.length, more: hasMore ? '+' : '' })}</span>
        <a
            href="{resolve('/admin/tasks/runs')}?taskId={encodeURIComponent(taskId)}"
            class="text-surface-300 underline underline-offset-4 hover:text-white">
            {m.admin_redesign_tasks_history()}
        </a>
    </div>

    {#snippet runRow(run: Run)}
        {@const failure = run.state === 'failed' ? failureLine(run) : null}
        {@const count = runItemsProcessed(run)}
        {@const outcome = stopReasonLabel(run.result, run.countSummary)}
        <!-- Opens the run ON TOP of this task (the run panel stacks over the
             task panel; closing it returns here). It used to navigate to the
             Runs page and drop the task. The href stays for new-tab clicks. -->
        <a
            href="{resolve('/admin/tasks/runs')}?run={run.id}"
            class="flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors hover:bg-surface-800/60"
            onclick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                runDetailPanel.open(run.id);
            }}>
            <div class="flex items-center gap-3">
                <TaskStatusBadge {...badgeProps(run.state)} />
                <!-- Every row of a task's own list repeated the task name;
                     what differs per run is why it started and what it did. -->
                <span class="flex-1 min-w-0 truncate text-sm text-surface-300">
                    {triggerLabel(run.trigger)}{#if count !== null}<span class="text-surface-400">
                            · {formatCount(count.count, count.unit)}</span
                        >{/if}{#if outcome}<span class="text-surface-500"> · {outcome}</span>{/if}
                </span>
                <span class="shrink-0 text-xs tabular-nums text-surface-500">
                    {formatElapsed(run)}
                </span>
                <span class="shrink-0 text-xs text-surface-600">
                    {formatDate(run.startedAt)}
                </span>
            </div>
            {#if failure}
                <p class="truncate text-xs text-red-400" title={failure.title}>
                    {failure.text}
                </p>
            {/if}
        </a>
    {/snippet}

    <div class="divide-y divide-surface-700/40 rounded border border-surface-700/40">
        <!-- Key must be namespaced by kind: a streak marker reuses its newest
             run's id (that run renders as its own row right above), so a bare
             id would be a duplicate each-key and crash the whole list. -->
        {#each streakItems as item (item.kind === 'run' ? item.run.id : `streak:${item.id}`)}
            {#if item.kind === 'run'}
                {@render runRow(item.run)}
            {:else}
                {@const isStreakExpanded = expandedStreakIds.has(item.id)}
                <div class="px-4 py-1.5">
                    <button
                        type="button"
                        class="flex items-center gap-1 text-xs text-surface-500 hover:text-surface-300 transition-colors"
                        aria-expanded={isStreakExpanded}
                        onclick={() => toggleStreak(item.id)}>
                        <span
                            class="transition-transform duration-150 {isStreakExpanded
                                ? 'rotate-90'
                                : ''}"
                            aria-hidden="true">
                            ›
                        </span>
                        {m.admin_runs_same_failure_streak({
                            count: item.collapsed.length,
                            oldest: formatAgo(Date.now() - Date.parse(item.oldestStartedAt)),
                        })}
                    </button>
                </div>
                {#if isStreakExpanded}
                    {#each item.collapsed as collapsedRun (collapsedRun.id)}
                        {@render runRow(collapsedRun)}
                    {/each}
                {/if}
            {/if}
        {/each}
    </div>

    {#if hasMore}
        <div class="mt-3 text-center">
            <button
                type="button"
                class="btn btn-sm variant-ghost-surface"
                disabled={loadingMore}
                onclick={loadMore}>
                {loadingMore ? m.common_loading_ellipsis() : m.section_load_more()}
            </button>
        </div>
    {/if}
{/if}
