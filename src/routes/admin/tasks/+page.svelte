<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/tasks — the classic scheduled-task list.

  Operators coming from Jellyfin / Emby / Plex expect one list: tasks grouped
  by category, one row each with last run, next run and ▶ Run. That is the
  whole page now. The Status / Catalog views, the card grid, the status chips,
  the Common / All tier and the summary strip are gone — each counted problems
  its own way, the source of most "N here, M there" review findings.

  Problems are layered ON the list, not beside it: a failing task keeps its
  place (rows are name-sorted and never move) with an amber icon and a
  one-line reason, and a "Needs attention (N)" box above the list — rendered
  only when N > 0 — lists each problem with its action inline. Row, box,
  sidebar dot and the system-task visibility rule all read one definition
  (`needsAttention` over the attention board joined by `findingsByTask`).
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import {
        adminWorkspaceUrl,
        writeAdminWorkspaceUrl,
    } from '$lib/components/admin/admin-workspace-url';
    import { z } from 'zod';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages.js';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { apiGet } from '$lib/api/client.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { runDetailPanel } from '$lib/stores/run-detail-panel.js';
    import { runLogDrawer } from '$lib/stores/run-log-drawer.js';
    import { TaskListResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import type { AdminStatusResponse } from '$lib/schemas/api-admin-responses.js';
    import { getLibraryPaths } from '$lib/api/admin.js';
    import { closeDetail, parseTaskDetailPath } from '$lib/components/admin/detail/detail-url.js';
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import RunDetailPanel from '$lib/components/admin/runs/RunDetailPanel.svelte';
    import RunLogDrawer from '$lib/components/admin/runs/RunLogDrawer.svelte';
    import {
        computeTaskAggregates,
        type TaskAggregate,
        type TaskMetadata,
    } from '$lib/stores/task-aggregates.js';
    import type { MonitoringContext } from '$lib/components/admin/task-dashboard/monitoring-groups.js';
    import { findingsByTask } from '$lib/components/admin/task-dashboard/task-findings.js';
    import { isListedTask } from '$lib/components/admin/task-dashboard/task-visibility.js';
    import { adminStatus as attentionStatus } from '$lib/stores/admin-status.store.svelte.js';
    import LibraryProcessingHero from '$lib/components/admin/LibraryProcessingHero.svelte';
    import TaskDetail from '$lib/components/admin/task-catalog/TaskDetail.svelte';
    import TaskList from '$lib/components/admin/task-catalog/TaskList.svelte';
    import TaskAttentionBox from '$lib/components/admin/task-catalog/TaskAttentionBox.svelte';
    import { failuresWithoutFinding } from '$lib/components/admin/task-catalog/task-row-status.js';
    import type {
        TaskDefinitionSummary,
        TaskPurpose,
    } from '$lib/schemas/task-definition.schema.js';
    import { buildInfrastructureRows, type InfrastructureRow } from './infrastructure-rows.js';
    import { PURPOSE_ORDER, taskPurposeLabel, emptyPurposeGroups } from './task-purpose.js';
    import { resourceClassLabel } from '$lib/utils/operator-labels';
    import { resolve } from '$lib/paths';

    interface BacklogStage {
        stage_id: string;
        backlog: number;
    }

    const BacklogResponseSchema = z.object({
        stages: z.array(z.object({ stage_id: z.string(), backlog: z.number() })),
    });

    /** `'all'` or any resource class a loaded task declares (see `classOptions`). */
    type ResourceClassFilter = string;

    /**
     * Display order for the class filter. The dropdown lists only classes some
     * task actually declares, in this order, with any unknown class appended —
     * a hand-written option list had drifted both ways (no "Discovery", which a
     * task uses; three kinds no task declared).
     */
    const CLASS_ORDER = [
        'cpu',
        'io',
        'embedding',
        'discovery',
        'maintenance',
        'ingest',
        'bulk',
        'analysis',
    ];

    // `PURPOSE_ORDER` / `taskPurposeLabel` / `emptyPurposeGroups` live in
    // `task-purpose.ts` — see its header for why they are not a local record.
    function groupByPurpose(
        tasksIn: TaskDefinitionSummary[],
    ): Array<{ purpose: TaskPurpose; label: string; tasks: TaskDefinitionSummary[] }> {
        const groups = emptyPurposeGroups<TaskDefinitionSummary>();
        for (const task of tasksIn) {
            // Unset purpose ⇒ Maintenance: an unclassified task never goes missing.
            groups[task.purpose ?? 'maintenance'].push(task);
        }
        // Name order, never live state: a row must not move under the pointer
        // because its task started, finished or failed.
        return PURPOSE_ORDER.map((purpose) => ({
            purpose,
            label: taskPurposeLabel(purpose),
            tasks: groups[purpose].sort((a, b) => a.name.localeCompare(b.name)),
        }));
    }

    let tasks = $state<TaskDefinitionSummary[]>([]);
    let registrationErrors = $state<
        Array<{
            name: string;
            message: string;
            kind: string;
            timestamp: string;
        }>
    >([]);
    // Infrastructure rows read the SAME /api/admin/status payload the shared
    // attention store already polls (30s, paused while hidden).
    let adminStatus = $derived<AdminStatusResponse | null>(attentionStatus.payload?.system ?? null);
    let infraNow = $derived(attentionStatus.lastUpdatedAt?.getTime() ?? Date.now());
    // null = not yet known (avoid a false "no libraries" flash).
    let libraryPathCount = $state<number | null>(null);
    let hasNoLibraries = $derived(libraryPathCount === 0);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let search = $state(adminWorkspaceUrl($page.url, $page.state).searchParams.get('search') ?? '');
    let resourceClassFilter = $state<ResourceClassFilter>(
        (adminWorkspaceUrl($page.url, $page.state).searchParams.get(
            'class',
        ) as ResourceClassFilter | null) ?? 'all',
    );

    // Restore filters on back/forward, but retain them while a shallow task
    // detail replaces the URL with its own shareable route.
    $effect(() => {
        if ($page.state.detailPanel) return;
        const params = adminWorkspaceUrl($page.url, $page.state).searchParams;
        search = params.get('search') ?? '';
        resourceClassFilter = (params.get('class') as ResourceClassFilter) || 'all';
        // Back/forward restores the toggle too; without it the button stayed
        // "on" over a URL (and list) that said off.
        showSystem = params.get('system') === '1' || storedShowSystem();
    });

    function syncListUrl(): void {
        const url = new URL(adminWorkspaceUrl($page.url, $page.state));
        const values: Array<[string, string, string]> = [
            ['search', search, ''],
            ['class', resourceClassFilter, 'all'],
            ['system', showSystem ? '1' : '', ''],
        ];
        for (const [key, value, defaultValue] of values) {
            if (value && value !== defaultValue) url.searchParams.set(key, value);
            else url.searchParams.delete(key);
        }
        // Parameters of the retired Status / Catalog layout: drop them from
        // old bookmarks so the URL states only what the page applies.
        for (const key of ['view', 'tier', 'triage']) url.searchParams.delete(key);
        writeAdminWorkspaceUrl(url, $page.state, true);
    }

    // ------------------------------------------------------------------
    // One definition of "needs attention", shared by rows, box and visibility
    // ------------------------------------------------------------------

    let taskFindings = $derived(
        findingsByTask(attentionStatus.payload?.attention.items ?? [], tasks),
    );
    let monitoringCtx = $derived<MonitoringContext>({
        findingTaskIds: new Set(taskFindings.keys()),
    });

    // ------------------------------------------------------------------
    // System tasks: hidden behind a toggle, never when they need attention
    // ------------------------------------------------------------------

    const SHOW_SYSTEM_KEY = 'lumastra.admin.tasks.showSystem';
    /** The per-browser preference; the URL's `?system=1` wins over it. */
    function storedShowSystem(): boolean {
        try {
            return (
                typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_SYSTEM_KEY) === '1'
            );
        } catch {
            return false;
        }
    }
    let showSystem = $state(
        adminWorkspaceUrl($page.url, $page.state).searchParams.get('system') === '1' ||
            storedShowSystem(),
    );

    function setShowSystem(next: boolean): void {
        showSystem = next;
        try {
            localStorage.setItem(SHOW_SYSTEM_KEY, next ? '1' : '0');
        } catch {
            // A preference; never throw over it.
        }
        syncListUrl();
    }

    const isListed = (t: TaskDefinitionSummary): boolean =>
        isListedTask(t, showSystem, monitoringCtx);

    let listedTasks = $derived(tasks.filter(isListed));
    let hiddenSystemCount = $derived(
        tasks.filter((t) => t.visibility === 'system' && !isListed(t)).length,
    );
    let systemTaskCount = $derived(tasks.filter((t) => t.visibility === 'system').length);

    let classOptions = $derived.by((): string[] => {
        const present = new Set(
            listedTasks.map((t) => t.resourceClass).filter((c): c is string => !!c),
        );
        const known = CLASS_ORDER.filter((c) => present.has(c));
        const unknown = [...present].filter((c) => !CLASS_ORDER.includes(c)).sort();
        return [...known, ...unknown];
    });

    let filtersActive = $derived(search.trim().length > 0 || resourceClassFilter !== 'all');

    function clearFilters(): void {
        search = '';
        resourceClassFilter = 'all';
        syncListUrl();
    }

    // ------------------------------------------------------------------
    // First-run setup gate (§6.2)
    // ------------------------------------------------------------------

    /**
     * Live processing state, reported up by `LibraryProcessingHero` so this
     * page doesn't duplicate its two fetches. `null` until the first coherent
     * snapshot lands — which is why `firstPassRunning` below is false while it
     * is null: the list must never be hidden on a guess.
     */
    interface ProcessingState {
        state: 'loading' | 'empty' | 'working' | 'done';
        pct: number;
        eligible: number;
        remaining: number;
        activePct: number;
        activeEligible: number;
        activeRemaining: number;
        permanentFailed: number;
    }
    let processing = $state<ProcessingState | null>(null);

    /**
     * Operator escape hatch, remembered per browser. Set by "Show all tasks
     * anyway", and also set permanently the first time this browser observes a
     * settled library — which is what retires the setup view for good and turns
     * the finish moment into a one-time event rather than a banner that
     * reappears every time a few new episodes are imported.
     *
     * 🔴 KNOWN LIMITATION: localStorage is per-browser, so a first pass that
     * completes while the operator is on another machine will still show them
     * the finish moment once. A durable server-side "first pass completed"
     * marker would be the correct home for this, but it needs a new column and
     * therefore a migration.
     */
    const SETUP_SEEN_KEY = 'lumastra.admin.tasks.setupComplete';
    /** Set the first time this browser actually observes a first pass in flight. */
    const SETUP_WATCHED_KEY = 'lumastra.admin.tasks.setupWatched';
    let setupRetired = $state(false);
    let watchedFirstPass = $state(false);

    function rememberFlag(key: string): void {
        try {
            localStorage.setItem(key, '1');
        } catch {
            // Private mode / storage disabled — works for this session only.
        }
    }

    function retireSetup(): void {
        setupRetired = true;
        rememberFlag(SETUP_SEEN_KEY);
    }

    /**
     * A first pass is "running" when a substantial majority of the library is
     * still unprocessed. Deliberately NOT "anything is working": a settled
     * server importing five new episodes is also `working`, and hiding the list
     * from an experienced operator every time that happens would be worse than
     * the problem this solves. The 200-item floor keeps a toy library out.
     *
     * 🔴 Every threshold here reads the ACTIVE-only numbers, never the
     * aggregate. On a stock install `trickplay-generation` and
     * `library-embeddings` hold eligible rows they can never complete, so the
     * aggregate percentage is pinned low and `state` never leaves `'working'`.
     */
    const FIRST_PASS_MIN_ITEMS = 200;
    const FIRST_PASS_MAX_PCT = 80;
    let firstPassRunning = $derived(
        !setupRetired &&
            processing !== null &&
            processing.state === 'working' &&
            processing.activeEligible >= FIRST_PASS_MIN_ITEMS &&
            processing.activeRemaining > 0 &&
            processing.activePct < FIRST_PASS_MAX_PCT,
    );

    /**
     * §6.6, the finish moment. Shown once, only to a browser that actually
     * WATCHED a first pass.
     */
    let librarySettled = $derived(
        processing !== null &&
            processing.state !== 'loading' &&
            processing.activeEligible > 0 &&
            processing.activeRemaining === 0,
    );
    let showFinishMoment = $derived(!setupRetired && watchedFirstPass && librarySettled);

    function onProcessingState(s: ProcessingState): void {
        processing = s;
    }

    $effect(() => {
        if (firstPassRunning && !watchedFirstPass) {
            watchedFirstPass = true;
            rememberFlag(SETUP_WATCHED_KEY);
        }
        if (librarySettled && !watchedFirstPass && !setupRetired) {
            retireSetup();
        }
    });

    // Coverage-backlog stage counts feed each row's "N items waiting".
    let backlogStages = $state<BacklogStage[]>([]);

    let panelRunId = $state<string | null>(null);
    let logRunId = $state<string | null>(null);

    // The task detail is URL-backed via shallow routing (openDetail /
    // closeDetail); `page.state.detailPanel.path` names the task and an
    // optional `?tab=`.
    let openTaskDetail = $derived.by(() => {
        const panel = $page.state.detailPanel;
        return panel ? parseTaskDetailPath(panel.path) : null;
    });
    let openTaskId = $derived(openTaskDetail?.taskId ?? null);
    let openTaskTab = $derived(openTaskDetail?.tab);
    let devToolsEnabled = $derived($page.data.devToolsEnabled === true);

    let unsubPanel: (() => void) | undefined;
    let unsubLog: (() => void) | undefined;
    let unsubSSE: (() => void) | undefined;
    let destroyed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let initialLoadDone = false;
    let loadSeq = 0;

    let infrastructureRows = $derived<InfrastructureRow[]>(
        buildInfrastructureRows(adminStatus, infraNow, hasNoLibraries),
    );
    let warnInfrastructure = $derived(infrastructureRows.filter((r) => r.severity === 'warn'));
    // The "no libraries — file watching starts once you add one" row says what
    // the page's own no-library hint already says; showing both stacked two
    // near-identical notices.
    let infoInfrastructure = $derived(
        infrastructureRows.filter((r) => r.severity === 'info' && !r.showLibraryLink),
    );

    let filteredTasks = $derived.by(() => {
        const q = search.trim().toLowerCase();
        return listedTasks.filter((t) => {
            const matchesSearch =
                !q ||
                t.id.toLowerCase().includes(q) ||
                t.name.toLowerCase().includes(q) ||
                (t.resourceClass ?? '').toLowerCase().includes(q);
            const matchesClass =
                resourceClassFilter === 'all' || (t.resourceClass ?? '') === resourceClassFilter;
            return matchesSearch && matchesClass;
        });
    });

    let grouped = $derived(groupByPurpose(filteredTasks));

    /** Failing tasks the attention board has no finding for — listed in the box too. */
    let unfoundFailures = $derived(
        failuresWithoutFinding(listedTasks, monitoringCtx.findingTaskIds ?? new Set()),
    );

    /**
     * Render box and list together, only once BOTH the task list and the
     * attention payload are in: the box sits above the list, so letting it
     * arrive half a second later pushed every row down under the pointer.
     * A failed attention fetch does not hold the list back.
     */
    let ready = $derived(
        !loading && (attentionStatus.payload !== null || attentionStatus.error !== null),
    );

    // Page-level run-bus subscription: `busVersion` is bumped on any change so
    // `taskAggregates` re-derives. The ONLY onAnyChange callback on the page —
    // per-row subscriptions compounded into "effect update depth exceeded" at
    // ~4 Hz progress per run × N runs.
    let busVersion = $state(0);
    let unsubBus: (() => void) | undefined;

    let taskCoveredStages = $derived.by((): Map<string, readonly string[]> => {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const map = new Map<string, readonly string[]>();
        for (const t of tasks) {
            if (t.coveredStageIds && t.coveredStageIds.length > 0) {
                map.set(t.id, t.coveredStageIds);
            }
        }
        return map;
    });

    let stageBacklogs = $derived.by((): Map<string, number> => {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const map = new Map<string, number>();
        for (const row of backlogStages) map.set(row.stage_id, row.backlog);
        return map;
    });

    let taskItemsPerHour = $derived.by((): Map<string, number | null> => {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const map = new Map<string, number | null>();
        for (const t of tasks) {
            if (t.itemsPerHour !== undefined) map.set(t.id, t.itemsPerHour);
        }
        return map;
    });

    let taskMetadataMap = $derived.by((): Map<string, TaskMetadata> => {
        // eslint-disable-next-line svelte/prefer-svelte-reactivity
        const map = new Map<string, TaskMetadata>();
        for (const t of tasks) {
            map.set(t.id, {
                name: t.name,
                resourceClass: t.resourceClass,
                lastFailedError: t.lastFailedError,
                recentFailCount: t.recentFailCount,
                taskPriority: t.taskPriority,
            });
        }
        return map;
    });

    let taskAggregates = $derived.by((): Map<string, TaskAggregate> => {
        void busVersion;
        return computeTaskAggregates(
            runSSEBus.runs.values(),
            taskCoveredStages,
            stageBacklogs,
            taskItemsPerHour,
            taskMetadataMap,
        );
    });

    async function load(): Promise<void> {
        // Only the very first load shows the loading state; SSE-triggered
        // refreshes update rows in place so scroll position is preserved.
        if (!initialLoadDone) loading = true;
        const seq = ++loadSeq;
        const { data, error } = await apiGet('/api/tasks', TaskListResponseSchema);
        if (destroyed) return;
        if (seq !== loadSeq) return;
        if (error || !data) {
            // With a list on screen a failed SSE-triggered refresh keeps it
            // (with a notice); the full error panel is for "nothing to show".
            if (tasks.length === 0) loadError = error ?? m.route_admin_tasks_load_error();
            else refreshFailed = true;
        } else {
            refreshFailed = false;
            tasks = data.items;
            registrationErrors = data.registrationErrors ?? [];
            loadError = null;
        }
        loading = false;
        initialLoadDone = true;
    }

    async function loadBacklog(): Promise<void> {
        const { data } = await apiGet('/api/admin/coverage/backlog', BacklogResponseSchema);
        if (destroyed || !data) return;
        backlogStages = data.stages;
    }

    // Set when a background refresh failed while the list is shown.
    let refreshFailed = $state(false);

    async function loadLibraryPathCount(): Promise<void> {
        const { data } = await getLibraryPaths();
        if (destroyed || !data) return;
        libraryPathCount = data.items.length;
    }

    function scheduleRefresh(): void {
        // The SSE bus fires from its initial seed fetch — skip until the first
        // load resolves; debounce subsequent bursts.
        if (!initialLoadDone) return;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            void load();
            // Backlog counts ("N items waiting") were fetched once at mount and
            // went stale; refresh them with the list on run transitions.
            void loadBacklog();
        }, 500);
    }

    onMount(() => {
        try {
            setupRetired = localStorage.getItem(SETUP_SEEN_KEY) === '1';
            watchedFirstPass = localStorage.getItem(SETUP_WATCHED_KEY) === '1';
        } catch {
            // Storage unavailable — the escape hatch still works for the session.
        }

        runSSEBus.connect();
        // Ref-counted, shared with the bell and the sidebar dot.
        attentionStatus.start();
        void load();
        void loadBacklog();
        void loadLibraryPathCount();

        // Transition events only → debounced reload of the task list (progress
        // events at ~4 Hz would keep resetting the debounce).
        unsubSSE = runSSEBus.onTransitionChange(() => {
            scheduleRefresh();
        });
        // Every change incl. progress → live row aggregates (rAF-throttled).
        unsubBus = runSSEBus.onAnyChange(() => {
            busVersion += 1;
        });
        busVersion += 1;

        unsubPanel = runDetailPanel.subscribe((v) => {
            panelRunId = v.runId;
        });
        unsubLog = runLogDrawer.subscribe((v) => {
            logRunId = v.runId;
        });
    });

    onDestroy(() => {
        destroyed = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        runSSEBus.disconnect();
        attentionStatus.stop();
        unsubSSE?.();
        unsubBus?.();
        unsubPanel?.();
        unsubLog?.();
    });
</script>

<svelte:head><title>{m.route_admin_tasks_title()} · Admin</title></svelte:head>

<!-- Infrastructure warnings (e.g. "file watcher hasn't checked in") render
     INSIDE the attention box and count toward its total. -->
{#snippet infraWarnings()}
    {#each warnInfrastructure as row (row.id)}
        <div class="flex items-center gap-2 text-xs text-amber-200">
            <span aria-hidden="true">{row.icon}</span>
            <span>
                {row.message}
                {#if row.showLogsLink}
                    —
                    <a
                        href={resolve('/admin/system/health')}
                        class="underline hover:text-amber-100">
                        {m.admin_task_filewatcher_check_logs()}
                    </a>
                {/if}
            </span>
        </div>
    {/each}
{/snippet}

<div>
    <AdminPageHeader
        icon={adminPageIcons['/admin/tasks']}
        title={m.route_admin_tasks_title()}
        description={m.route_admin_tasks_description()}>
        <HelpPopover learnMoreHref={resolve('/admin/help/tasks#catalog')}>
            <p>{m.admin_tasks_help_what()}</p>
            <p>{m.admin_tasks_help_healthy()}</p>
            <p>{m.admin_tasks_help_paused()}</p>
        </HelpPopover>
    </AdminPageHeader>

    <!-- Registration-error banner — builtin task modules that failed to load
         at boot. Without it the task silently disappears from the list and
         the reason is only in container logs. -->
    {#if registrationErrors.length > 0}
        <div class="my-5 rounded border border-red-500/50 bg-red-950/30 px-4 py-3 text-sm">
            <div class="mb-2 flex items-center gap-2">
                <span class="text-base">⚠️</span>
                <span class="font-medium text-red-200">
                    {m.admin_jobs_registration_failed({ count: registrationErrors.length })}
                </span>
            </div>
            <p class="mb-2 text-xs text-red-300/80">
                {m.admin_jobs_registration_failed_help()}
            </p>
            <ul class="space-y-1 text-xs">
                {#each registrationErrors as err (err.name + err.timestamp)}
                    <li class="rounded bg-red-950/40 px-2 py-1 font-mono text-red-200">
                        <span class="text-red-400">{err.kind}</span>
                        <span class="text-red-300">·</span>
                        <span class="font-semibold">{err.name}</span>
                        <span class="text-red-300">·</span>
                        <span class="text-red-200/90">{err.message}</span>
                    </li>
                {/each}
            </ul>
        </div>
    {/if}

    <!--
      Mounted UNCONDITIONALLY: it is the only thing that fetches the coverage
      snapshot `firstPassRunning` reasons about; `variant` picks its face.
    -->
    <div class="my-5">
        <LibraryProcessingHero
            variant={firstPassRunning ? 'setup' : 'default'}
            onstate={onProcessingState} />
    </div>

    {#if showFinishMoment}
        <!-- §6.6 finish moment — the ONE place the suppressed first-pass
             failure count is finally stated. -->
        <div class="mb-5 rounded-xl border border-emerald-700/40 bg-emerald-950/20 px-4 py-3.5">
            <h2 class="text-sm font-semibold text-surface-100">
                ✓ {m.admin_setup_ready_title()}
            </h2>
            <p class="mt-1 text-sm text-surface-300">
                {#if processing && processing.permanentFailed > 0}
                    {m.admin_setup_ready_problems({ count: processing.permanentFailed })} —
                    <a href={resolve('/admin/tasks/pipeline')} class="underline hover:text-white"
                        >{m.admin_setup_ready_review()}</a>
                {:else}
                    {m.admin_setup_ready_none()}
                {/if}
            </p>
            <button
                type="button"
                class="mt-2 text-xs text-emerald-300 underline hover:text-emerald-200"
                onclick={retireSetup}>{m.admin_setup_ready_dismiss()}</button>
        </div>
    {/if}

    {#if hasNoLibraries}
        <div
            class="mb-5 rounded border border-sky-800/40 bg-sky-950/20 px-4 py-2.5 text-xs text-sky-200">
            {m.admin_tasks_catalog_no_libraries_hint()}
            <a href={resolve('/admin/library')} class="underline hover:text-sky-100">
                {m.admin_tasks_add_library_link()}
            </a>
        </div>
    {/if}

    {#if infoInfrastructure.length}
        <div class="mb-5 space-y-1">
            {#each infoInfrastructure as row (row.id)}
                <div
                    class="flex items-center gap-2 rounded border border-surface-700/50 bg-surface-800/40 px-3 py-1.5 text-xs text-surface-300">
                    <span aria-hidden="true">{row.icon}</span>
                    <span>
                        {row.message}
                        {#if row.showLibraryLink}
                            <a href={resolve('/admin/library')} class="underline hover:text-white">
                                {m.admin_tasks_add_library_link()}
                            </a>
                        {/if}
                    </span>
                </div>
            {/each}
        </div>
    {/if}

    {#if loading}
        <div class="py-12 text-center text-sm text-surface-500">
            {m.loading_default()}
        </div>
    {:else if loadError}
        <div class="rounded border border-red-700/30 bg-red-900/20 p-4 text-sm text-red-300">
            {loadError}
            <button
                type="button"
                class="ml-3 text-xs text-red-200 underline"
                onclick={() => void load()}>{m.common_retry()}</button>
        </div>
    {:else if ready}
        {#if refreshFailed}
            <p class="mb-3 text-xs text-amber-300" role="status">
                {m.route_admin_tasks_load_error()}
            </p>
        {/if}
        <TaskAttentionBox
            failures={unfoundFailures}
            extra={warnInfrastructure.length ? infraWarnings : undefined}
            extraCount={warnInfrastructure.length} />

        {#if firstPassRunning}
            <!-- While the first pass runs the list is noise next to the setup
                 view above; hidden, never removed, and the choice sticks. -->
            <p class="mb-6 text-xs text-surface-500">
                {m.admin_setup_show_catalog_hint()}
                <button
                    type="button"
                    class="ml-1 underline hover:text-surface-300"
                    onclick={retireSetup}>{m.admin_setup_show_catalog()}</button>
            </p>
        {:else}
            <div class="mb-5 flex flex-wrap items-center gap-3">
                <input
                    type="search"
                    aria-label={m.route_admin_tasks_filter_placeholder()}
                    placeholder={m.route_admin_tasks_filter_placeholder()}
                    class="w-full max-w-sm rounded border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm text-surface-200 placeholder-surface-600 focus:border-surface-500 focus:outline-none"
                    bind:value={search}
                    oninput={syncListUrl} />
                <select
                    aria-label={m.route_admin_tasks_filter_all_classes()}
                    class="rounded border border-surface-700 bg-surface-900 px-3 py-1.5 text-sm text-surface-200 focus:border-surface-500 focus:outline-none"
                    bind:value={resourceClassFilter}
                    onchange={syncListUrl}>
                    <option value="all">{m.route_admin_tasks_filter_all_classes()}</option>
                    {#each classOptions as cls (cls)}
                        <option value={cls}>{resourceClassLabel(cls)}</option>
                    {/each}
                    {#if resourceClassFilter !== 'all' && !classOptions.includes(resourceClassFilter)}
                        <!-- A shared link naming a class no task declares still
                             shows what it filtered on. -->
                        <option value={resourceClassFilter}
                            >{resourceClassLabel(resourceClassFilter)}</option>
                    {/if}
                </select>
                {#if filtersActive}
                    <p class="text-xs text-surface-400">
                        {m.admin_tasks_showing_filtered({
                            shown: filteredTasks.length,
                            total: listedTasks.length,
                        })}
                        <button
                            type="button"
                            class="ml-1 text-primary-300 underline hover:text-white"
                            onclick={clearFilters}>{m.admin_tasks_clear_filters()}</button>
                    </p>
                {/if}
            </div>

            {#if filteredTasks.length === 0}
                <p class="py-8 text-center text-sm text-surface-400">
                    {m.admin_tasks_list_empty()}
                </p>
            {:else}
                <TaskList
                    groups={grouped}
                    aggregates={taskAggregates}
                    findings={taskFindings}
                    ctx={monitoringCtx} />
            {/if}

            <!-- System tasks toggle (§1.3): internal machinery is hidden by
                 default, one click away, and never hidden while it has a
                 problem (those rows are listed regardless). -->
            {#if systemTaskCount > 0}
                <div class="mt-6 flex justify-center">
                    <button
                        type="button"
                        class="rounded border border-surface-700 px-3 py-1.5 text-xs text-surface-400 hover:border-surface-500 hover:text-surface-200"
                        aria-pressed={showSystem}
                        onclick={() => setShowSystem(!showSystem)}>
                        {showSystem
                            ? m.admin_tasks_hide_system()
                            : m.admin_tasks_show_system({ count: hiddenSystemCount })}
                    </button>
                </div>
            {/if}
        {/if}
    {:else}
        <div class="py-12 text-center text-sm text-surface-500">
            {m.loading_default()}
        </div>
    {/if}
</div>

{#if openTaskId}
    <TaskDetail
        taskId={openTaskId}
        initialTab={openTaskTab}
        mode="auto"
        onclose={() => closeDetail('/admin/tasks')}
        {devToolsEnabled} />
{/if}

<!-- After the task panel on purpose: both are same-z dialogs, so DOM order
     decides which is on top, and a run opened from a task's Recent Runs must
     stack OVER that task (closing it returns to the task). -->
{#if panelRunId}
    <RunDetailPanel runId={panelRunId} onclose={() => runDetailPanel.close()} />
{/if}

{#if logRunId}
    <RunLogDrawer runId={logRunId} onclose={() => runLogDrawer.close()} />
{/if}
