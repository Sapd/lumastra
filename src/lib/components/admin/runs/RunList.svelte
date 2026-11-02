<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { apiGet } from '$lib/api/client.js';
    import {
        RunListResponseSchema,
        type Run,
        type RunState,
        type RunWithMediaItem,
    } from '$lib/schemas/run.schema.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { formatAgo } from '$lib/utils/admin/formatters.js';
    import {
        isLiveOnlyFilter,
        sinceParamForView,
        type RunWindow,
    } from '$lib/utils/admin/run-window.js';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import RunCard from './RunCard.svelte';
    import RunGroupedList from './RunGroupedList.svelte';
    import { collapseRunStreaks } from './run-streaks.js';
    import { mergeActiveStageProgress } from './run-live-progress.js';

    interface Props {
        stateFilter?: RunState[];
        taskId?: string;
        limit?: number;
        /**
         * Controlled By-task/All-runs toggle. Callers that re-key this
         * component on an unrelated change (the Runs page remounts it on
         * every status-filter switch — see +page.svelte's `{#key
         * activeFilter}`) should lift this state up and pass it here so the
         * user's grouping choice survives the remount instead of silently
         * resetting to the default. Omit for the previous uncontrolled
         * behavior (the component owns its own toggle state).
         */
        groupedOverride?: boolean | null;
        onGroupedOverrideChange?: (next: boolean) => void;
        /**
         * 24h/7d/all window applied to `started_at`, default 'all' (no
         * filtering — matches the previous, unfiltered behavior). Callers
         * that want the selector's choice to survive a remount (the Runs
         * page remounts on filter/window changes — see +page.svelte's
         * `{#key}`) should lift this to state and pass it here, same
         * rationale as `groupedOverride`. The selector UI itself is hidden
         * whenever the By-task/All-runs toggle is (i.e. when `taskId` scopes
         * the list) — `since` is still applied to the fetch either way.
         */
        sinceWindow?: RunWindow;
        onSinceWindowChange?: (next: RunWindow) => void;
    }

    let {
        stateFilter,
        taskId,
        limit = 50,
        groupedOverride: groupedOverrideProp,
        onGroupedOverrideChange,
        sinceWindow = 'all',
        onSinceWindowChange,
    }: Props = $props();

    // When a taskId filter is active, grouping is pointless (all rows belong to
    // the same task). Default to grouped on the unrestricted wall view — spec
    // §3.3 "grouped by task" is the Runs page's default.
    // groupedOverride = null means "use the smart default"; true/false means the
    // user has explicitly toggled via setGrouped().
    let localGroupedOverride = $state<boolean | null>(null);
    let groupedOverride = $derived(
        groupedOverrideProp !== undefined ? groupedOverrideProp : localGroupedOverride,
    );
    let grouped = $derived(groupedOverride !== null ? groupedOverride : !taskId);

    let runs: RunWithMediaItem[] = $state([]);
    let nextCursor: string | undefined = $state(undefined);
    // Start loading=true only in taskId-scoped flat mode (polling starts on
    // mount). Without taskId the component defaults to grouped view and the flat
    // path is entered on an explicit user toggle — no spinner needed until then.
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);
    // A background refresh failed while rows are on screen: keep them and say
    // they may be stale, instead of swapping the whole list for an error box.
    let refreshFailed = $state(false);
    let loadingMore = $state(false);
    let expandedStreakIds = new SvelteSet<string>();

    // Consecutive failed runs sharing the same displayed failure line collapse
    // into a single row + toggle (see run-streaks.ts) — a task failing the
    // same way 81 times in a row otherwise buries the one useful signal
    // ("it keeps failing the same way") under a wall of identical rows.
    let streakItems = $derived(collapseRunStreaks(runs));

    function toggleStreak(id: string): void {
        if (expandedStreakIds.has(id)) {
            expandedStreakIds.delete(id);
        } else {
            expandedStreakIds.add(id);
        }
    }

    // Page-1 refreshes and load-more pages have separate tokens: a 10 s poll
    // must not discard a "Load more" the operator just clicked.
    let fetchToken = 0;
    let moreToken = 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let unsubSSE: (() => void) | undefined;
    // 500ms debounce on SSE-triggered reloads: a burst of related events (stage
    // completed → stage completed → run completed) used to fire one /api/runs
    // fetch per event, which both pummeled the API and let later responses
    // overwrite earlier-but-fresher SSE state by virtue of arriving in any order.
    let sseReloadTimer: ReturnType<typeof setTimeout> | undefined;
    const SSE_RELOAD_DEBOUNCE_MS = 500;
    let destroyed = false;

    function runTimestampMs(r: Run): number {
        // Match runSSEBus.runTimestamp: heartbeat (most recent for active runs)
        // → completedAt (set on terminal) → startedAt (always present). Returns
        // 0 for unparseable inputs so optimistic-then-API never silently wins
        // because of a bad date string.
        const ts = r.heartbeatAt ?? r.completedAt ?? r.startedAt;
        if (!ts) return 0;
        const ms = Date.parse(ts);
        return Number.isFinite(ms) ? ms : 0;
    }

    function mergeFreshest(apiRuns: RunWithMediaItem[]): RunWithMediaItem[] {
        // Per-row reconcile: keep whichever side carries the newer timestamp.
        // The SSE bus already merges incoming events with the same rule, so
        // this preserves optimistic upsertRun() mutations that haven't yet
        // round-tripped through the API. Rows are keyed on `run.id` in the
        // template below, so replacing an entry's object here still patches
        // the existing DOM node in place — it never remounts the row (spec
        // §5 "live updates patch, never replace").
        const sseMap = runSSEBus.runs;
        return apiRuns.map((apiRow) => {
            const sseRow = sseMap.get(apiRow.id);
            // `input`/`result` are carried by the API row but NOT by SSE
            // lifecycle frames (they ship the redacted RunEvent projection).
            // A run first seen over SSE therefore has neither, so fall back to
            // the API row's copy rather than blanking the item-context chip
            // and the items-processed count.
            const freshest =
                sseRow && runTimestampMs(sseRow) >= runTimestampMs(apiRow)
                    ? {
                          ...sseRow,
                          input: sseRow.input ?? apiRow.input,
                          result: sseRow.result ?? apiRow.result,
                          countSummary: sseRow.countSummary ?? apiRow.countSummary,
                          mediaItem: apiRow.mediaItem,
                      }
                    : apiRow;

            // A terminal snapshot is authoritative. Otherwise retain progress
            // reported by an SSE event even when its enclosing heartbeat is
            // older than this API snapshot (progress events intentionally do
            // not update heartbeats).
            if (
                freshest.state === 'completed' ||
                freshest.state === 'failed' ||
                freshest.state === 'cancelled'
            ) {
                return freshest;
            }

            const currentRow = runs.find((run) => run.id === apiRow.id);
            let stages = mergeActiveStageProgress(freshest.stages, apiRow.stages);
            if (currentRow) stages = mergeActiveStageProgress(stages, currentRow.stages);
            if (sseRow) stages = mergeActiveStageProgress(stages, sseRow.stages);
            return { ...freshest, stages };
        });
    }

    async function load(cursor?: string): Promise<void> {
        const my = cursor ? ++moreToken : ++fetchToken;
        if (!cursor) {
            // Only show the loading state on the FIRST fetch (no rows yet).
            // A background refresh (poll / SSE-triggered reload) with rows
            // already on screen must never flip `loading` back to true —
            // AsyncSection would swap from its "children" branch to its
            // "loading" branch and back, destroying and recreating every row
            // (the exact "Runs list re-render" bug spec §5/§8 calls out:
            // "no live surface may rebuild a list the user is reading").
            loading = runs.length === 0;
        } else {
            loadingMore = true;
        }

        const params: Record<string, string> = { limit: String(limit) };
        if (stateFilter && stateFilter.length > 0) {
            params.state = stateFilter.join(',');
        }
        if (taskId) params.taskId = taskId;
        if (cursor) params.cursor = cursor;
        // Recomputed per request: a page left open must not keep a frozen
        // "24h ago" lower bound from when it mounted.
        // Live-only views (the Running tab) ignore the window: it bounds
        // started_at and would hide long-running or stuck runs.
        const since = sinceParamForView(sinceWindow, stateFilter);
        if (since) params.since = since;

        const qs = new URLSearchParams(params).toString();
        const { data, error, status } = await apiGet(`/api/runs?${qs}`, RunListResponseSchema);

        if (my !== (cursor ? moreToken : fetchToken) || destroyed) return;

        if (error || !data) {
            if (cursor) {
                refreshFailed = true;
            } else if (runs.length === 0) {
                loadError = classifyError(new Error(error ?? undefined), { status });
            } else {
                refreshFailed = true;
            }
        } else {
            if (cursor) {
                // Dedup on append: a cursor page can re-include a run already loaded
                // if rows shifted between fetches, which would throw each_key_duplicate.
                const existingRunIds = new Set(runs.map((r) => r.id));
                runs = [...runs, ...data.items.filter((r) => !existingRunIds.has(r.id))];
                nextCursor = data.page.nextCursor;
            } else {
                const fresh = mergeFreshest(data.items);
                // Pages the operator loaded with "Load more" survive a page-1
                // refresh: keep loaded rows OLDER than the refreshed page (rows
                // inside its range that are gone left the filter, e.g. a run
                // that finished on the Running tab) and keep the deeper cursor.
                const oldestMs =
                    fresh.length > 0 ? Date.parse(fresh[fresh.length - 1].startedAt) : NaN;
                const freshIds = new Set(fresh.map((r) => r.id));
                const tail =
                    data.page.nextCursor && Number.isFinite(oldestMs)
                        ? runs.filter(
                              (r) => !freshIds.has(r.id) && Date.parse(r.startedAt) < oldestMs,
                          )
                        : [];
                runs = [...fresh, ...tail];
                if (tail.length === 0) nextCursor = data.page.nextCursor;
            }
            loadError = null;
            refreshFailed = false;
        }

        if (cursor) loadingMore = false;
        else loading = false;
    }

    function scheduleSSEReload(): void {
        if (destroyed) return;
        if (sseReloadTimer) clearTimeout(sseReloadTimer);
        sseReloadTimer = setTimeout(() => {
            sseReloadTimer = undefined;
            if (!destroyed) void load();
        }, SSE_RELOAD_DEBOUNCE_MS);
    }

    async function loadMore(): Promise<void> {
        if (!nextCursor || loadingMore) return;
        await load(nextCursor);
    }

    // Flat-list polling runs only while the flat list is shown; in grouped mode
    // RunGroupedList owns its own polling loop.
    function startFlatPolling(): void {
        if (pollTimer) return;
        void load();
        pollTimer = setInterval(() => void load(), 10_000);
        if (!unsubSSE) unsubSSE = runSSEBus.onAnyChange(scheduleSSEReload);
    }

    function stopFlatPolling(): void {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        if (sseReloadTimer) clearTimeout(sseReloadTimer);
        sseReloadTimer = undefined;
        unsubSSE?.();
        unsubSSE = undefined;
    }

    onMount(() => {
        // Flat when scoped to a task, or when the page restores "All runs"
        // (?view=all) — that mount used to fetch nothing and show "No runs".
        if (!grouped || taskId) startFlatPolling();
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

    function setGrouped(next: boolean): void {
        if (onGroupedOverrideChange) {
            onGroupedOverrideChange(next);
        } else {
            localGroupedOverride = next;
        }
        // Flat mode polls; back to grouped stops it (the hidden flat list
        // kept fetching every 10 s next to RunGroupedList's own poll).
        if (!next) startFlatPolling();
        else if (!taskId) stopFlatPolling();
    }
</script>

<!-- Grouping is useful only without a task scope. Scoped workspace lists keep
     their time-window selector; compact detail embeds without a callback hide it. -->
{#if !taskId || onSinceWindowChange}
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        {#if !taskId}
            <div class="flex items-center gap-1">
                <button
                    type="button"
                    aria-pressed={grouped}
                    class="rounded px-2.5 py-1 text-xs transition-colors {grouped
                        ? 'bg-surface-700/70 text-surface-200'
                        : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800/50'}"
                    onclick={() => setGrouped(true)}>
                    {m.admin_runs_group_by_task()}
                </button>
                <button
                    type="button"
                    aria-pressed={!grouped}
                    class="rounded px-2.5 py-1 text-xs transition-colors {!grouped
                        ? 'bg-surface-700/70 text-surface-200'
                        : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800/50'}"
                    onclick={() => setGrouped(false)}>
                    {m.admin_runs_group_all()}
                </button>
            </div>
        {/if}
        {#if !isLiveOnlyFilter(stateFilter)}
            <div
                class="flex items-center gap-1"
                role="group"
                aria-label={m.admin_runs_window_label()}>
                {#each [['24h', m.admin_runs_window_24h()], ['7d', m.admin_runs_window_7d()], ['all', m.admin_runs_window_all()]] as [id, label] (id)}
                    <button
                        type="button"
                        aria-pressed={sinceWindow === id}
                        class="rounded px-2.5 py-1 text-xs transition-colors {sinceWindow === id
                            ? 'bg-surface-700/70 text-surface-200'
                            : 'text-surface-500 hover:text-surface-300 hover:bg-surface-800/50'}"
                        onclick={() => onSinceWindowChange?.(id as RunWindow)}>
                        {label}
                    </button>
                {/each}
            </div>
        {/if}
    </div>
{/if}

{#if grouped && !taskId}
    <RunGroupedList {stateFilter} {sinceWindow} />
{:else}
    <AsyncSection
        {loading}
        error={loadError}
        empty={runs.length === 0}
        emptyMessage={m.admin_runs_empty()}
        onretry={() => void load()}>
        {#if refreshFailed}
            <p class="mb-2 text-xs text-amber-300" role="status">{m.admin_runs_refresh_failed()}</p>
        {/if}
        <div class="space-y-1.5">
            <!-- Key must be namespaced by kind: a streak marker reuses its newest
                 run's id (that run renders as its own row right above), so a bare
                 id would be a duplicate each-key and crash the whole list. -->
            {#each streakItems as item (item.kind === 'run' ? item.run.id : `streak:${item.id}`)}
                {#if item.kind === 'run'}
                    <RunCard run={item.run} />
                {:else}
                    {@const isStreakExpanded = expandedStreakIds.has(item.id)}
                    <div class="pl-3">
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
                        <div class="space-y-1.5 border-l border-surface-700/40 pl-3">
                            {#each item.collapsed as collapsedRun (collapsedRun.id)}
                                <RunCard run={collapsedRun} />
                            {/each}
                        </div>
                    {/if}
                {/if}
            {/each}
        </div>

        {#if nextCursor}
            <div class="mt-4 text-center">
                <button
                    type="button"
                    class="btn btn-sm variant-ghost-surface"
                    disabled={loadingMore}
                    onclick={loadMore}>
                    {loadingMore ? m.admin_runs_loading_more() : m.admin_runs_load_more()}
                </button>
            </div>
        {/if}
    </AsyncSection>
{/if}
