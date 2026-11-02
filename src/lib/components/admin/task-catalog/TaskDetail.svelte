<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Admin IA redesign, spec §3.3/§6: the ONE task-detail view. Replaces the old
  sidebar `TaskDetailPanel.svelte` (with its own "Full page" escape-hatch
  link) and the separately-maintained `operations/jobs/[taskId]/+page.svelte`
  full-page markup — both are now this single component, rendered inside the
  shared `DetailPanel` shell. The hosting route decides `mode`
  ('panel' from the task list, 'page' for a direct hit); this component only
  knows how to fetch and display one task.

  Tab set: Overview / Runs / Failures / Backlog / Settings (+ Definition in
  dev mode) — the spec's fixed list. There is no more separate "Pause
  status"/circuit tab: Overview already surfaces the circuit state as a stat
  tile (`fromTaskSummary`), and the full breaker control (force-enable /
  history) now lives at the bottom of Settings, next to the task's other
  operational controls.

  Two distinct pauses are surfaced here, and they must not be conflated:
  `circuitState` is the system pausing ITSELF after repeated failures
  ("Auto-pause"), while `schedulePaused` is a person having stopped the
  schedule via PUT …/state. The latter had no representation on any surface
  until now, so a paused task kept rendering as "Healthy & idle" forever.
-->
<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import { TaskDefinitionSummarySchema } from '$lib/schemas/task-definition.schema.js';
    import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
    import { resourceClassLabel } from '$lib/utils/operator-labels';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import DetailPanel from '$lib/components/admin/detail/DetailPanel.svelte';
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import TermTooltip from '$lib/components/admin/glossary/TermTooltip.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import TaskDashboard from '$lib/components/admin/task-dashboard/TaskDashboard.svelte';
    import { fromTaskSummary } from '$lib/components/admin/task-dashboard/from-task-summary.js';
    import TaskRecentRuns from './TaskRecentRuns.svelte';
    import TaskFailuresList from './TaskFailuresList.svelte';
    import FailurePatternsPanel from '$lib/components/admin/task-system/FailurePatternsPanel.svelte';
    import BacklogCard from './BacklogCard.svelte';
    import CircuitBreakerStatus from './CircuitBreakerStatus.svelte';
    import TaskRunOptions from './TaskRunOptions.svelte';
    import TaskSettingsPanel from './TaskSettingsPanel.svelte';
    import TaskTriggers from './TaskTriggers.svelte';
    import PipelineSection from './PipelineSection.svelte';

    type TabId = 'overview' | 'runs' | 'failures' | 'backlog' | 'settings' | 'definition';

    interface Props {
        taskId: string;
        mode?: 'auto' | 'panel' | 'page';
        onclose?: () => void;
        /** Page mode only — "← back to the task list" link. */
        backHref?: string;
        backLabel?: string;
        /** Gates the Definition tab (spec §3.7 — raw ids/internals are Developer-only). */
        devToolsEnabled?: boolean;
        /**
         * Deep-link into a specific tab (e.g. `?tab=failures` from a health
         * finding's "open this task" link) instead of always landing on
         * Overview. Falls back to 'overview' when unset or not a known tab id.
         */
        initialTab?: TabId;
    }

    let {
        taskId,
        mode = 'auto',
        onclose,
        backHref,
        backLabel,
        devToolsEnabled = false,
        initialTab,
    }: Props = $props();

    let task = $state<TaskDefinitionSummary | null>(null);
    let loading = $state(true);
    let loadError = $state<ClassifiedError | null>(null);
    let activeTab = $state<TabId>('overview');
    let fetchToken = 0;
    let destroyed = false;
    let sseVersion = $state(0);
    let unsubSSE: (() => void) | undefined;

    let supportsRetry = $derived(task?.supportsPerItemRetry === true);
    let schedulePaused = $derived(task?.schedulePaused === true);
    /**
     * "Paused by X on Y" byline, or null when the pause carries no timestamp.
     * `scheduler_state.paused_by` holds a user id, which for a browser-session
     * pause is a raw UUID — that is noise rather than attribution, so the
     * "who" is dropped unless it reads as a name.
     */
    let pausedByline = $derived.by((): string | null => {
        const at = task?.schedulePausedAt;
        if (!at) return null;
        const parsed = new Date(at);
        const when = isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
        const by = task?.schedulePausedBy;
        const isUuid = by ? /^[0-9a-f-]{32,36}$/i.test(by) : false;
        return by && !isUuid
            ? m.admin_task_paused_by_at({ by, at: when })
            : m.admin_task_paused_at({ at: when });
    });
    let hasBacklog = $derived(task?.backlog !== undefined);
    let hasSettings = $derived(task?.settings !== undefined && task.settings.fields.length > 0);
    let isRunning = $derived.by(() => {
        // sseVersion bumps on every SSE event so this re-evaluates reactively.
        sseVersion;
        return (
            (task?.observedActiveCount ?? 0) > 0 ||
            runSSEBus.activeRuns.some(
                (r) => r.taskId === task?.id && r.admissionObservation === 'active',
            )
        );
    });
    let hasInFlight = $derived.by(() => {
        sseVersion;
        return (
            (task?.activeCount ?? 0) > 0 || runSSEBus.activeRuns.some((r) => r.taskId === task?.id)
        );
    });
    let waitingObservation = $derived.by(() => {
        sseVersion;
        const runs = runSSEBus.activeRuns.filter((r) => r.taskId === task?.id);
        if (runs.some((r) => r.admissionObservation === 'playback-deferred'))
            return m.admin_run_playback_deferred();
        if (runs.some((r) => r.admissionObservation === 'waiting'))
            return m.admin_run_confirmed_waiting();
        return m.admin_task_admission_unknown();
    });

    let tabs = $derived.by((): { id: TabId; label: string }[] => {
        const list: { id: TabId; label: string }[] = [
            { id: 'overview', label: m.admin_task_overview() },
            { id: 'runs', label: m.admin_task_recent_runs() },
            { id: 'failures', label: m.admin_task_failures() },
            { id: 'backlog', label: m.admin_tasks_backlog() },
            { id: 'settings', label: m.admin_task_settings() },
        ];
        if (devToolsEnabled) list.push({ id: 'definition', label: m.admin_task_definition() });
        return list;
    });

    async function loadTask(id: string): Promise<void> {
        const my = ++fetchToken;
        // A refresh of the task already shown (after a trigger save or Run now)
        // keeps the tabs mounted: AsyncSection swaps its children for a spinner
        // while `loading`, which threw away unsaved settings and form state.
        const refreshing = task !== null && task.id === id;
        loading = !refreshing;
        loadError = null;
        const { data, error, status } = await apiGet(
            `/api/tasks/${encodeURIComponent(id)}`,
            TaskDefinitionSummarySchema,
        );
        if (my !== fetchToken || destroyed) return;
        if (error || !data) {
            // Prefer the server's own (already specific, e.g. "Task not
            // found") message over classifyError's generic per-class copy —
            // the class/retryable envelope still comes from the HTTP status,
            // so a 404 correctly renders without a Retry button (retrying a
            // bad id can't help) while a network/5xx failure keeps one.
            const base = classifyError(new Error(error ?? undefined), { status });
            if (refreshing) {
                // The action that asked for this refresh already succeeded;
                // keep the task on screen and only say the refresh failed.
                toasts.error(error ?? m.admin_err_server());
            } else {
                loadError = { ...base, message: error ?? m.admin_jobs_task_not_found() };
            }
        } else {
            task = data;
        }
        loading = false;
    }

    // Reset and re-fetch whenever the panel is reused for a different taskId
    // (SvelteKit reuses this component instance across shallow-routed opens
    // of different tasks from the same list — only the id changes).
    $effect(() => {
        const id = taskId;
        const tab = initialTab;
        // untrack: loadTask() reads `task` synchronously; tracked, this effect
        // would depend on the state it resets and loop.
        untrack(() => {
            task = null;
            activeTab = tab ?? 'overview';
            void loadTask(id);
        });
    });

    onMount(() => {
        runSSEBus.connect();
        unsubSSE = runSSEBus.onAnyChange(() => {
            sseVersion++;
        });
    });

    onDestroy(() => {
        destroyed = true;
        runSSEBus.disconnect();
        unsubSSE?.();
    });
</script>

<!-- The browser tab names the task on its own page; it kept the catalog's
     title, so several task tabs were indistinguishable. -->
<svelte:head>
    {#if mode === 'page' && task}
        <title>{task.name} · {m.route_admin_tasks_title()} · Admin</title>
    {/if}
</svelte:head>

<DetailPanel
    titleText={task?.name ?? taskId}
    subtitle={devToolsEnabled ? taskId : undefined}
    {tabs}
    {activeTab}
    onTabChange={(id) => (activeTab = id as TabId)}
    {mode}
    {onclose}
    {backHref}
    {backLabel}>
    {#snippet headerActions()}
        {#if schedulePaused}
            <span
                class="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-700/40 bg-amber-900/40 px-2 py-0.5 text-[10px] font-medium text-amber-300"
                title={m.admin_task_paused_badge_title()}>
                <span class="h-1.5 w-1.5 rounded-full bg-amber-400"></span>
                {m.admin_task_paused_badge()}
            </span>
        {/if}
        {#if isRunning}
            <span
                class="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue-700/40 bg-blue-900/50 px-2 py-0.5 text-[10px] font-medium text-blue-300">
                <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400"></span>
                {m.admin_task_running()}
            </span>
        {/if}
        {#if hasInFlight && !isRunning}
            <span
                class="inline-flex shrink-0 items-center rounded-full border border-blue-700/40 px-2 py-0.5 text-[10px] font-medium text-blue-300">
                {waitingObservation}
            </span>
        {/if}
        <!-- The one task screen that had no help affordance, and the one where
             the pause/resume, retry and settings controls live. Last in the
             row so the "?" sits just left of the panel's close button, the
             same place it sits on every other task screen's header. -->
        <HelpPopover learnMoreHref={resolve('/admin/help/tasks#catalog')}>
            <p>{m.admin_task_detail_help_what()}</p>
            <p>{m.admin_task_detail_help_tabs()}</p>
            <p>{m.admin_task_detail_help_paused()}</p>
        </HelpPopover>
    {/snippet}
    {#snippet children(tab)}
        <AsyncSection {loading} error={loadError} onretry={() => void loadTask(taskId)}>
            {#if task}
                {#if tab === 'overview'}
                    {#if schedulePaused}
                        <div
                            class="mb-6 rounded border border-amber-700/40 bg-amber-900/20 p-4 text-sm">
                            <p class="font-medium text-amber-300">
                                {m.admin_task_paused_notice_heading()}
                            </p>
                            <p class="mt-1 text-surface-300">
                                {m.admin_task_paused_notice_body()}
                            </p>
                            {#if pausedByline}
                                <p class="mt-1 text-xs text-surface-500">{pausedByline}</p>
                            {/if}
                        </div>
                    {/if}
                    {#if task.circuitState === 'open' || task.circuitState === 'half_open'}
                        <section class="mb-6">
                            <h2
                                class="mb-3 text-sm font-semibold uppercase tracking-wide text-amber-400">
                                <TermTooltip term="circuit-breaker"
                                    >{m.admin_task_auto_pause()}</TermTooltip>
                            </h2>
                            <CircuitBreakerStatus taskId={task.id} />
                        </section>
                    {/if}
                    <div class="mb-4">
                        <TaskRunOptions
                            {task}
                            running={hasInFlight}
                            onStarted={() => void loadTask(taskId)} />
                    </div>
                    <TaskDashboard
                        data={fromTaskSummary(task)}
                        showTitle={false}
                        onShowFailures={() => (activeTab = 'failures')}
                        onRefreshed={() => void loadTask(taskId)} />
                {:else if tab === 'runs'}
                    <TaskRecentRuns taskId={task.id} limit={20} />
                {:else if tab === 'failures'}
                    <div class="space-y-6">
                        <!-- 7 days, not 24h: a task's unresolved items are often
                             older than a day, and a 1-day window put "No failures
                             in this window" directly above 54 of them. -->
                        <FailurePatternsPanel taskId={task.id} defaultHours={168} />
                        <TaskFailuresList
                            taskId={task.id}
                            supportsRetry={Boolean(supportsRetry)}
                            coveredStageIds={task.coveredStageIds ?? []} />
                    </div>
                {:else if tab === 'backlog'}
                    {#if hasBacklog}
                        <BacklogCard
                            taskId={task.id}
                            unitLabel={task.backlog?.unitLabel}
                            fallbackCount={task.backlogRemaining} />
                    {:else if task.backlogRemaining !== undefined}
                        <!-- This task has no stages() drill-down (`hasBacklog` false),
                             but the catalog card's lane total (`backlogRemaining`, summed
                             from coveredStageIds) IS known — show that instead of
                             claiming the task tracks no backlog at all, which would
                             contradict the catalog card showing a real number.

                             Zero gets its OWN sentence rather than the estimate copy:
                             "About 0 items pending" hedges the one number that needs
                             no hedging. It must NOT fall through to the empty state
                             either — that says "no backlog definition", which is
                             false for a task whose backlog is merely empty, and is
                             the exact contradiction this branch exists to avoid. -->
                        <div
                            class="rounded border border-surface-700/40 bg-surface-900/30 p-4 text-sm">
                            <p class="text-surface-300">
                                <TermTooltip term="backlog"
                                    >{task.backlogRemaining === 0
                                        ? m.admin_task_backlog_empty()
                                        : m.admin_task_backlog_estimate_only({
                                              count: task.backlogRemaining.toLocaleString(),
                                              unit: 'items',
                                          })}</TermTooltip>
                            </p>
                        </div>
                    {:else}
                        <div
                            class="rounded border border-surface-700/40 bg-surface-900/30 p-6 text-center text-sm text-surface-500">
                            {m.admin_jobs_no_backlog_definition()}
                        </div>
                    {/if}
                {:else if tab === 'settings'}
                    <!-- Schedule first: it is the setting an operator changes
                         most. It used to appear twice on this tab — once inside
                         TaskSettingsPanel, once here. -->
                    <div class="space-y-6">
                        <section>
                            <h2
                                class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                {m.admin_task_triggers_title()}
                            </h2>
                            <TaskTriggers
                                taskId={task.id}
                                onchanged={() => void loadTask(taskId)} />
                        </section>
                        {#if hasSettings}
                            <TaskSettingsPanel taskId={task.id} />
                        {:else}
                            <div
                                class="rounded border border-surface-700/40 bg-surface-900/30 p-6 text-center text-sm text-surface-500">
                                {m.admin_jobs_no_settings()}
                            </div>
                        {/if}
                        <section>
                            <h2
                                class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                <TermTooltip term="circuit-breaker"
                                    >{m.admin_task_auto_pause()}</TermTooltip>
                            </h2>
                            <CircuitBreakerStatus taskId={task.id} />
                        </section>
                    </div>
                {:else if tab === 'definition'}
                    <div class="space-y-6">
                        {#if task.notes}
                            <section>
                                <h2
                                    class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                    {m.admin_task_notes()}
                                </h2>
                                <p
                                    class="whitespace-pre-line rounded border border-surface-700/40 bg-surface-900/30 p-4 text-sm text-surface-400">
                                    {task.notes}
                                </p>
                            </section>
                        {/if}
                        <section>
                            <h2
                                class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                {m.admin_task_core()}
                            </h2>
                            <dl
                                class="divide-y divide-surface-700/40 rounded border border-surface-700/40 text-sm">
                                <div class="flex gap-4 px-4 py-2.5">
                                    <dt class="w-40 shrink-0 text-surface-500">
                                        {m.admin_jobs_def_id()}
                                    </dt>
                                    <dd class="font-mono text-surface-300">{task.id}</dd>
                                </div>
                                <div class="flex gap-4 px-4 py-2.5">
                                    <dt class="w-40 shrink-0 text-surface-500">
                                        {m.route_admin_cluster_col_version()}
                                    </dt>
                                    <dd class="text-surface-300">{task.version ?? '—'}</dd>
                                </div>
                                <div class="flex gap-4 px-4 py-2.5">
                                    <dt class="w-40 shrink-0 text-surface-500">
                                        {m.admin_task_processing_version()}
                                    </dt>
                                    <dd class="text-surface-300">
                                        {task.processingVersion ?? '—'}
                                    </dd>
                                </div>
                                <div class="flex gap-4 px-4 py-2.5">
                                    <dt class="w-40 shrink-0 text-surface-500">
                                        <TermTooltip term="resource-class"
                                            >{m.admin_task_resource_class()}</TermTooltip>
                                    </dt>
                                    <dd class="text-surface-300">
                                        {task.resourceClass
                                            ? resourceClassLabel(task.resourceClass)
                                            : '—'}
                                    </dd>
                                </div>
                                {#if task.timeout}
                                    <div class="flex gap-4 px-4 py-2.5">
                                        <dt class="w-40 shrink-0 text-surface-500">
                                            {m.admin_jobs_def_timeout()}
                                        </dt>
                                        <dd class="text-surface-300">
                                            <span
                                                title={m.admin_title_hard_timeout__the_run_is_force_killed_at_this_poin()}
                                                >{task.timeout.hard}</span>
                                            <span class="text-surface-500"
                                                >{m.admin_jobs_def_timeout_soft_sep()}</span>
                                            <span
                                                title={m.admin_title_soft_timeout__the_runner_stops_accepting_new_work_()}
                                                >{task.timeout.soft}</span>
                                        </dd>
                                    </div>
                                {/if}
                            </dl>
                        </section>

                        {#if task.schedule}
                            <section>
                                <h2
                                    class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                    {m.admin_task_schedule()}
                                </h2>
                                <dl
                                    class="divide-y divide-surface-700/40 rounded border border-surface-700/40 text-sm">
                                    {#if task.schedule.every}
                                        <div class="flex gap-4 px-4 py-2.5">
                                            <dt class="w-40 shrink-0 text-surface-500">
                                                {m.admin_task_every()}
                                            </dt>
                                            <dd class="text-surface-300">{task.schedule.every}</dd>
                                        </div>
                                    {/if}
                                    <div class="flex gap-4 px-4 py-2.5">
                                        <dt class="w-40 shrink-0 text-surface-500">
                                            {m.admin_task_run_on_startup()}
                                        </dt>
                                        <dd class="text-surface-300">
                                            {task.schedule.runOnStartup
                                                ? m.media_status_yes()
                                                : m.providers_fallback_no()}
                                        </dd>
                                    </div>
                                    {#if task.schedule.envOverride}
                                        <div class="flex gap-4 px-4 py-2.5">
                                            <dt class="w-40 shrink-0 text-surface-500">
                                                {m.admin_task_env_override()}
                                            </dt>
                                            <dd class="font-mono text-surface-300">
                                                {task.schedule.envOverride}
                                            </dd>
                                        </div>
                                    {/if}
                                </dl>
                            </section>
                        {/if}

                        {#if task.retry}
                            <section>
                                <h2
                                    class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                    {m.retry()}
                                </h2>
                                <dl
                                    class="divide-y divide-surface-700/40 rounded border border-surface-700/40 text-sm">
                                    <div class="flex gap-4 px-4 py-2.5">
                                        <dt class="w-40 shrink-0 text-surface-500">
                                            {m.admin_task_attempts()}
                                        </dt>
                                        <dd class="text-surface-300">{task.retry.attempts}</dd>
                                    </div>
                                    {#if task.retry.backoff}
                                        <div class="flex gap-4 px-4 py-2.5">
                                            <dt class="w-40 shrink-0 text-surface-500">
                                                {m.admin_task_backoff()}
                                            </dt>
                                            <dd class="text-surface-300">{task.retry.backoff}</dd>
                                        </div>
                                    {/if}
                                </dl>
                            </section>
                        {/if}

                        {#if task.pipeline}
                            <PipelineSection {task} devMode={devToolsEnabled} />
                        {/if}

                        {#if task.capabilities && Object.keys(task.capabilities).length > 0}
                            <section>
                                <h2
                                    class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                    {m.admin_task_capabilities()}
                                </h2>
                                <div class="flex flex-wrap gap-1.5">
                                    {#each Object.keys(task.capabilities) as cap (cap)}
                                        <span
                                            class="rounded border border-surface-700/40 bg-surface-800 px-2 py-1 text-xs text-surface-400">
                                            {cap}
                                        </span>
                                    {/each}
                                </div>
                            </section>
                        {/if}

                        {#if task.exclusiveWith}
                            <section>
                                <h2
                                    class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-300">
                                    {m.admin_task_exclusive_with()}
                                </h2>
                                <div class="flex flex-wrap gap-1.5">
                                    <span
                                        class="rounded border border-surface-700/40 bg-surface-800 px-2 py-1 font-mono text-xs text-surface-400">
                                        {task.exclusiveWith.scope}
                                        {#if task.exclusiveWith.ttl}
                                            · {task.exclusiveWith.ttl}
                                        {/if}
                                    </span>
                                </div>
                            </section>
                        {/if}
                    </div>
                {/if}
            {/if}
        </AsyncSection>
    {/snippet}
</DetailPanel>
