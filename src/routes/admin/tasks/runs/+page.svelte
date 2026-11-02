<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §3.3 Runs row: ONE list, state filter chips
  (replaces the old Live/History view split and the standalone Mission
  Control page it absorbed — both are gone, not merged forward). Grouped by
  task by default (`RunList`/`RunGroupedList`); every row keeps DOM identity
  across SSE-triggered reloads so a click never races a live refresh (spec
  §5). Row click opens the run DetailPanel (URL-backed via `?run=`, decided
  in the plan's step-0 log as a query param rather than a path segment,
  since there's no per-run page route). Servers + error-feed render as
  info-rail mini-views (spec §6.2), not second copies of a bigger page.
-->
<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages.js';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { Tabs } from '$lib/components/ui/index.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { runDetailPanel } from '$lib/stores/run-detail-panel.js';
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import { resolve } from '$lib/paths';
    import { taskDisplayName } from '$lib/utils/admin/task-names.js';
    import RunList from '$lib/components/admin/runs/RunList.svelte';
    import RunDetailPanel from '$lib/components/admin/runs/RunDetailPanel.svelte';
    import RunServersRail from '$lib/components/admin/runs/RunServersRail.svelte';
    import RunErrorFeedRail from '$lib/components/admin/runs/RunErrorFeedRail.svelte';
    import type { RunState } from '$lib/schemas/run.schema.js';
    import type { RunWindow } from '$lib/utils/admin/run-window.js';

    type FilterId = 'running' | 'failed' | 'completed' | 'all';

    const filterItems = tabItemsOf(searchMeta) as { id: FilterId; label: string }[];

    const FILTER_STATES: Record<FilterId, RunState[] | undefined> = {
        running: ['pending', 'active', 'cancelling'],
        failed: ['failed', 'cancelled'],
        completed: ['completed'],
        all: undefined,
    };

    /**
     * Opens on ALL runs, not 'running'.
     *
     * 'running' maps to ['pending','active','cancelling'], which on any healthy
     * IDLE server is empty — so a page titled "Runs" greeted the operator with
     * "No runs found." while the same session's home page said "3098 runs
     * completed in the last 12h". The likeliest reading of that is "runs are
     * broken" or "nothing ever runs"; both are wrong, and both are the first
     * impression.
     *
     * The window filter (default 24h) already bounds the list, so opening on
     * `all` shows what exists rather than what happens to be mid-flight.
     * 'Running' stays one click away, where it is useful precisely because
     * someone went looking for it.
     */
    // Filters live in the URL (?status=, ?view=, ?since=) so Back and a shared
    // link keep them — every other admin list already does this.
    const FILTER_IDS: readonly FilterId[] = ['running', 'failed', 'completed', 'all'];
    const WINDOWS: readonly RunWindow[] = ['24h', '7d', 'all'];
    function readParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
        const raw = $page.url.searchParams.get(name);
        return allowed.includes(raw as T) ? (raw as T) : fallback;
    }

    const activeFilter = $derived(readParam('status', FILTER_IDS, 'all'));

    // Lifted OUTSIDE `{#key activeFilter}` below: RunList must remount on a
    // status-filter change (neither RunList nor RunGroupedList react to a
    // changed `stateFilter` prop on their own — they only (re)fetch on
    // mount/poll/SSE), but a remount also reset RunList's own By-task/All-
    // runs toggle to its default. Owning the toggle here instead means it
    // survives filter-tab switches — flipping either control never resets
    // the other.
    const groupedOverride = $derived(
        $page.url.searchParams.get('view') === 'all'
            ? false
            : $page.url.searchParams.get('view') === 'grouped'
              ? true
              : null,
    );

    // Same rationale as `groupedOverride` above: lifted outside `{#key}` so
    // the 24h/7d/all window choice survives a status-filter remount, and
    // included IN the key itself (see the template below) since a window
    // change needs the same "remount to refetch" treatment `activeFilter`
    // already gets — RunList/RunGroupedList don't reactively refetch on a
    // changed prop.
    // Defaults to 24h, NOT 'all'. With 'all' the Failed tab renders every
    // failure the server has ever had, with no decay — on a month-old install
    // that is ~47 red task groups reading e.g. "1212 runs, 1212 failed", each
    // lazily loading its own spinner. Meanwhile /admin says "3 failed runs,
    // last 24 h" and /admin/system/health says the task system is HEALTHY, so
    // the operator sees three surfaces contradicting each other and concludes
    // the dashboard is lying. A bounded default window makes this page agree
    // with the rollups that already use one; 7d/All time stay one click away.
    const sinceWindow = $derived(readParam('since', WINDOWS, '24h'));

    // Read navigation state from the URL; only user actions write it.
    function setFilter(key: string, value: string | null): void {
        const url = new URL($page.url);
        if (value === null) url.searchParams.delete(key);
        else url.searchParams.set(key, value);
        void goto(url.pathname + url.search + url.hash, {
            replaceState: true,
            noScroll: true,
            keepFocus: true,
        });
    }

    // Optional `?taskId=` scope — a real, functional deep-link target now
    // (the pre-existing `LibraryProcessingHero` "View runs →" link built this
    // query param but the old page never read it; fixed while grep-fixing
    // paths into this route, matching the tasks-overview step's precedent
    // for dead `?task=`/`?filter=` links). Present → the page shows a flat,
    // task-scoped list instead of the grouped wall.
    let scopedTaskId = $derived($page.url.searchParams.get('taskId') || null);

    function clearTaskScope(): void {
        const url = new URL($page.url);
        url.searchParams.delete('taskId');
        void goto(url.pathname + url.search, {
            replaceState: true,
            noScroll: true,
            keepFocus: true,
        });
    }

    // ── Run detail panel: bidirectional `?run=` URL sync ───────────────────
    //
    // `runDetailPanel` is the APP-WIDE store other pages (Task Detail, System
    // Health, Library, the bell) also call `.open()` on to pop this same
    // panel — this page must not fight those callers, only reflect ITS OWN
    // panel state into ITS OWN URL when the panel happens to be open while
    // the user is on this page. `lastSyncedRunId` is the single guard both
    // directions check-and-set before acting, so a URL→store update never
    // triggers a redundant store→URL write and vice versa (no ping-pong).
    let panelRunId = $state<string | null>(null);
    let lastSyncedRunId: string | null = null;
    let unsubPanel: (() => void) | undefined;

    function readRunIdFromUrl(): string | null {
        const raw = $page.url.searchParams.get('run');
        return raw && raw !== 'null' && raw !== 'undefined' ? raw : null;
    }

    $effect(() => {
        const urlRunId = readRunIdFromUrl();
        if (urlRunId === lastSyncedRunId) return;
        lastSyncedRunId = urlRunId;
        if (urlRunId) {
            runDetailPanel.open(urlRunId);
        } else if (panelRunId) {
            runDetailPanel.close();
        }
    });

    onMount(() => {
        runSSEBus.connect();

        unsubPanel = runDetailPanel.subscribe((v) => {
            panelRunId = v.runId;
            if (v.runId === lastSyncedRunId) return;
            lastSyncedRunId = v.runId;
            const url = new URL($page.url);
            if (v.runId) {
                url.searchParams.set('run', v.runId);
            } else {
                url.searchParams.delete('run');
            }
            // replaceState: opening/closing the panel is not a distinct
            // history entry of its own — it rides on the runs list's entry
            // (matches the old page's view-toggle convention).
            void goto(url.pathname + url.search, {
                replaceState: true,
                noScroll: true,
                keepFocus: true,
            });
        });
    });

    onDestroy(() => {
        runSSEBus.disconnect();
        unsubPanel?.();
    });
</script>

<svelte:head>
    <title>{m.admin_nav_page_tasks_runs()} - Admin</title>
</svelte:head>

<div>
    <AdminPageHeader
        icon={adminPageIcons['/admin/tasks/runs']}
        title={m.route_admin_runs_title()}
        description={m.route_admin_runs_description()}>
        <!-- Three paragraphs max (HelpPopover's budget). "Click any run to
             open its details" went: the rows are already clickable and the
             panel it opens is self-describing. -->
        <HelpPopover learnMoreHref={resolve('/admin/help/tasks#runs')}>
            <p>{m.admin_runs_help_what()}</p>
            <p>{m.admin_runs_help_filters()}</p>
            <p>{m.admin_runs_help_retry()}</p>
        </HelpPopover>
    </AdminPageHeader>

    <div class="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div class="min-w-0">
            {#if scopedTaskId}
                <div
                    class="mb-3 flex items-center justify-between gap-3 rounded border border-surface-700/50 bg-surface-900/40 px-3 py-2 text-xs text-surface-400">
                    <span
                        >{m.admin_runs_scoped_to_task({
                            task: taskDisplayName(scopedTaskId),
                        })}</span>
                    <button
                        type="button"
                        class="shrink-0 text-blue-400 hover:text-blue-300 hover:underline"
                        onclick={clearTaskScope}>
                        {m.admin_runs_clear_scope()}
                    </button>
                </div>
            {/if}

            <div class="mb-4">
                <Tabs
                    items={filterItems}
                    active={activeFilter}
                    variant="pills"
                    size="sm"
                    onchange={(detail) =>
                        setFilter('status', detail.id === 'all' ? null : detail.id)} />
            </div>

            {#key `${scopedTaskId}:${activeFilter}:${sinceWindow}`}
                {#if scopedTaskId}
                    <RunList
                        taskId={scopedTaskId}
                        {sinceWindow}
                        onSinceWindowChange={(next) =>
                            setFilter('since', next === '24h' ? null : next)}
                        stateFilter={FILTER_STATES[activeFilter]}
                        limit={100} />
                {:else}
                    <RunList
                        stateFilter={FILTER_STATES[activeFilter]}
                        {groupedOverride}
                        onGroupedOverrideChange={(next) =>
                            setFilter('view', next === null ? null : next ? 'grouped' : 'all')}
                        {sinceWindow}
                        onSinceWindowChange={(next) =>
                            setFilter('since', next === '24h' ? null : next)} />
                {/if}
            {/key}
        </div>

        <div class="space-y-4">
            <RunServersRail />
            <RunErrorFeedRail />
        </div>
    </div>
</div>

{#if panelRunId}
    <RunDetailPanel runId={panelRunId} onclose={() => runDetailPanel.close()} />
{/if}
