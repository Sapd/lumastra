<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §3.3 Runs row: "grouped by task" is the DEFAULT
  view of the runs list. Rows keep DOM identity across SSE-triggered reloads
  (keyed `{#each groups as group (group.taskId)}` below, and RunList's own
  keyed `{#each runs as run (run.id)}` inside each expanded group) so a
  click never races a live refresh (spec §5 "live updates patch, never
  replace").
-->
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { apiGet } from '$lib/api/client.js';
    import { RunGroupedResponseSchema, type RunGroup } from '$lib/schemas/run.schema.js';
    import type { RunState } from '$lib/schemas/run.schema.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { formatCount } from '$lib/utils/admin/formatters.js';
    import { sinceParamForView, type RunWindow } from '$lib/utils/admin/run-window.js';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import RunList from './RunList.svelte';

    interface Props {
        stateFilter?: RunState[];
        /** 24h/7d/all window applied to `started_at`, default 'all'. Threaded
         * down to each expanded group's nested `RunList` too, so the group
         * counts and its expanded rows always reflect the same window. */
        sinceWindow?: RunWindow;
    }

    let { stateFilter, sinceWindow = 'all' }: Props = $props();

    let groups: RunGroup[] = $state([]);
    let loading = $state(true);
    let loadError = $state<ClassifiedError | null>(null);
    // Background refresh failed with groups on screen: keep them, flag stale.
    let refreshFailed = $state(false);
    let expandedTaskIds = new SvelteSet<string>();
    // Groups already auto-expanded once for having failures. Each poll used to
    // re-add every failed group, re-opening the ones the operator collapsed.
    const autoExpandedTaskIds = new SvelteSet<string>();

    // Which of the six state-count buckets this header may show. The
    // backend already scopes `stateCounts` to the active `state` filter (a
    // group's counts for excluded states come back 0), but the pills below
    // additionally gate on the filter directly — belt-and-suspenders so a
    // header can never show a badge for a state outside what's currently
    // selected (e.g. a blue "running" pill while the Completed filter is
    // active), regardless of any staleness between polls. `undefined`
    // (the "All runs" filter) shows every non-zero bucket, as before.
    let visibleStates = $derived<ReadonlySet<RunState>>(
        stateFilter && stateFilter.length > 0
            ? new Set(stateFilter)
            : new Set(['pending', 'active', 'cancelling', 'completed', 'failed', 'cancelled']),
    );

    let fetchToken = 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let unsubSSE: (() => void) | undefined;
    let sseReloadTimer: ReturnType<typeof setTimeout> | undefined;
    const SSE_RELOAD_DEBOUNCE_MS = 500;
    let destroyed = false;

    /**
     * Running, then failed, then the rest by most recent run. Sorting purely by
     * recency put the only two failing groups (EPG, M3U) under ~55 green ones,
     * with the four every-minute housekeeping tasks always on top.
     */
    let sortedGroups = $derived(
        [...groups].sort((a, b) => {
            const rank = (g: (typeof groups)[number]): number =>
                g.stateCounts.active + g.stateCounts.cancelling + g.stateCounts.pending > 0
                    ? 0
                    : g.stateCounts.failed > 0
                      ? 1
                      : 2;
            const r = rank(a) - rank(b);
            if (r !== 0) return r;
            return Date.parse(b.latestRun.startedAt) - Date.parse(a.latestRun.startedAt);
        }),
    );

    async function load(): Promise<void> {
        const my = ++fetchToken;
        loading = groups.length === 0;

        const params: Record<string, string> = {};
        if (stateFilter && stateFilter.length > 0) {
            params.state = stateFilter.join(',');
        }
        // Per request, so a page left open keeps a moving window.
        // Live-only views (the Running tab) ignore the started_at window.
        const since = sinceParamForView(sinceWindow, stateFilter);
        if (since) params.since = since;

        const qs = new URLSearchParams(params).toString();
        const { data, error, status } = await apiGet(`/api/runs/groups?${qs}`, RunGroupedResponseSchema);

        if (my !== fetchToken || destroyed) return;

        if (error || !data) {
            if (groups.length === 0) {
                loadError = classifyError(new Error(error ?? undefined), { status });
            } else {
                refreshFailed = true;
            }
        } else {
            groups = data.items;
            loadError = null;
            refreshFailed = false;
            // Auto-expand groups that have failed runs so failures are visible
            // by default without requiring an extra click — once per group, so
            // a collapse sticks across polls.
            for (const g of data.items) {
                if (g.stateCounts.failed > 0 && !autoExpandedTaskIds.has(g.taskId)) {
                    autoExpandedTaskIds.add(g.taskId);
                    expandedTaskIds.add(g.taskId);
                }
            }
        }

        loading = false;
    }

    function scheduleSSEReload(): void {
        if (destroyed) return;
        if (sseReloadTimer) clearTimeout(sseReloadTimer);
        sseReloadTimer = setTimeout(() => {
            sseReloadTimer = undefined;
            if (!destroyed) void load();
        }, SSE_RELOAD_DEBOUNCE_MS);
    }

    function toggleExpand(taskId: string): void {
        if (expandedTaskIds.has(taskId)) {
            expandedTaskIds.delete(taskId);
        } else {
            expandedTaskIds.add(taskId);
        }
    }

    function formatRelative(isoString: string): string {
        const ms = Date.now() - Date.parse(isoString);
        if (!Number.isFinite(ms) || ms < 0) return '—';
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s ago`;
        const mins = Math.floor(s / 60);
        if (mins < 60) return `${mins}m ago`;
        const h = Math.floor(mins / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    onMount(() => {
        void load();
        pollTimer = setInterval(() => void load(), 15_000);
        unsubSSE = runSSEBus.onAnyChange(scheduleSSEReload);
    });

    onDestroy(() => {
        destroyed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (sseReloadTimer) {
            clearTimeout(sseReloadTimer);
            sseReloadTimer = undefined;
        }
        unsubSSE?.();
    });
</script>

<AsyncSection
    {loading}
    error={loadError}
    empty={!loading && !loadError && groups.length === 0}
    emptyMessage={m.admin_runs_empty()}
    onretry={() => void load()}>
    {#if refreshFailed}
        <p class="mb-2 text-xs text-amber-300" role="status">{m.admin_runs_refresh_failed()}</p>
    {/if}
    <div class="space-y-1">
        {#each sortedGroups as group (group.taskId)}
            {@const isExpanded = expandedTaskIds.has(group.taskId)}
            {@const hasActive =
                group.stateCounts.active +
                    group.stateCounts.cancelling +
                    group.stateCounts.pending >
                0}
            {@const hasFailed = group.stateCounts.failed > 0}

            <div class="rounded border border-surface-700/60 overflow-hidden">
                <!-- Group header row -->
                <button
                    type="button"
                    class="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-surface-800/60 transition-colors {isExpanded
                        ? 'bg-surface-800/40'
                        : 'bg-surface-900/40'}"
                    aria-expanded={isExpanded}
                    onclick={() => toggleExpand(group.taskId)}>
                    <!-- Expand chevron -->
                    <span
                        class="text-surface-500 shrink-0 transition-transform duration-150 {isExpanded
                            ? 'rotate-90'
                            : ''}"
                        aria-hidden="true">
                        ›
                    </span>

                    <!-- Task name + count -->
                    <span class="flex-1 min-w-0 flex items-baseline gap-2">
                        <span
                            class="text-sm font-medium text-surface-200 truncate"
                            title={group.taskId}>
                            {group.name}
                        </span>
                        <span class="text-xs text-surface-500 shrink-0">
                            {formatCount(group.count, 'runs')}
                        </span>
                        {#if group.stateCounts.pending > 0 && visibleStates.has('pending')}
                            <span class="text-xs font-medium text-blue-300 shrink-0">
                                {group.stateCounts.pending.toLocaleString()} queued
                            </span>
                        {/if}
                    </span>

                    <!-- Status breakdown pills -->
                    <span class="flex items-center gap-1 shrink-0">
                        {#if group.stateCounts.active > 0 && visibleStates.has('active')}
                            <span
                                class="rounded px-1.5 py-px text-[10px] font-medium bg-blue-900/40 text-blue-300 border border-blue-700/40"
                                title="{group.stateCounts.active.toLocaleString()} running">
                                {group.stateCounts.active.toLocaleString()} running
                            </span>
                        {/if}
                        {#if group.stateCounts.cancelling > 0 && visibleStates.has('cancelling')}
                            <span
                                class="rounded px-1.5 py-px text-[10px] font-medium bg-orange-900/40 text-orange-300 border border-orange-700/40"
                                title="{group.stateCounts.cancelling.toLocaleString()} stopping">
                                {group.stateCounts.cancelling.toLocaleString()} stopping
                            </span>
                        {/if}
                        {#if group.stateCounts.pending > 0 && visibleStates.has('pending')}
                            <span
                                class="rounded px-1.5 py-px text-[10px] font-medium bg-surface-700/60 text-surface-400 border border-surface-600/40"
                                title="{group.stateCounts.pending.toLocaleString()} queued">
                                {group.stateCounts.pending.toLocaleString()} queued
                            </span>
                        {/if}
                        {#if hasFailed && visibleStates.has('failed')}
                            <span
                                class="rounded px-1.5 py-px text-[10px] font-medium bg-red-900/40 text-red-300 border border-red-700/40"
                                title="{group.stateCounts.failed.toLocaleString()} failed">
                                {group.stateCounts.failed.toLocaleString()} failed
                            </span>
                        {/if}
                        {#if group.stateCounts.completed > 0 && visibleStates.has('completed') && !hasActive && !hasFailed}
                            <span
                                class="rounded px-1.5 py-px text-[10px] font-medium bg-green-900/30 text-green-400 border border-green-700/30"
                                title="{group.stateCounts.completed.toLocaleString()} done">
                                {group.stateCounts.completed.toLocaleString()} done
                            </span>
                        {/if}
                        {#if group.stateCounts.cancelled > 0 && visibleStates.has('cancelled') && !hasActive && !hasFailed && group.stateCounts.completed === 0}
                            <span
                                class="rounded px-1.5 py-px text-[10px] font-medium bg-surface-700/40 text-surface-400 border border-surface-600/30"
                                title="{group.stateCounts.cancelled.toLocaleString()} stopped">
                                {group.stateCounts.cancelled.toLocaleString()} stopped
                            </span>
                        {/if}
                    </span>

                    <!-- Latest run timestamp -->
                    <span class="text-xs text-surface-500 shrink-0 ml-1">
                        {formatRelative(group.latestRun.startedAt)}
                    </span>
                </button>

                <!-- Expanded flat RunList scoped to this task -->
                {#if isExpanded}
                    <div class="border-t border-surface-700/40 px-3 py-3">
                        <RunList taskId={group.taskId} {stateFilter} limit={50} {sinceWindow} />
                    </div>
                {/if}
            </div>
        {/each}
    </div>
</AsyncSection>
