<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { z } from 'zod';
    import { SvelteSet, SvelteMap } from 'svelte/reactivity';
    import {
        Icon,
        Bolt,
        QueueList,
        ExclamationTriangle,
        ArrowTrendingUp,
        ShieldCheck,
        Cog6Tooth,
        PlayCircle,
        PauseCircle,
        type IconSource,
    } from 'svelte-hero-icons';
    import StatCard from '$lib/components/admin/StatCard.svelte';
    import ActionModal from '$lib/components/admin/ActionModal.svelte';
    import CoverageBar from './CoverageBar.svelte';
    import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '$lib/api/client.js';
    import { FailuresResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import { runLogDrawer } from '$lib/stores/run-log-drawer.js';
    import { runDetailPanel } from '$lib/stores/run-detail-panel.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import type {
        TaskDashboardData,
        StatTile,
        TaskAction,
    } from '$lib/schemas/task-dashboard.schema.js';

    interface Props {
        data: TaskDashboardData;
        /** Optional header icon. */
        icon?: IconSource;
        /** Invoked after an action fires successfully (e.g. to refetch). */
        onRefreshed?: () => void;
        /**
         * Render the task name as a heading. Off inside the detail panel,
         * whose own header already names the task — it read twice in a row.
         */
        showTitle?: boolean;
        /**
         * Open the host's Failures tab. The overview used to embed the whole
         * 50-row failure list the Failures tab already shows; it now states
         * the count and links there.
         */
        onShowFailures?: () => void;
    }

    let { data, icon, onRefreshed, showTitle = true, onShowFailures }: Props = $props();

    /** Unresolved items the task gave up on (`null` until known). */
    let failedItemCount = $state<number | null>(null);
    // A failed count lookup is shown as such, not as an endless "Loading…".
    let failedItemCountError = $state(false);
    $effect(() => {
        if (!data.failures?.show) return;
        const id = data.taskId;
        let cancelled = false;
        // Another task's count must not linger while this one loads.
        failedItemCount = null;
        failedItemCountError = false;
        void apiGet(`/api/tasks/${encodeURIComponent(id)}/failures`, FailuresResponseSchema, {
            params: { limit: '1' },
        }).then(({ data: res }) => {
            if (cancelled) return;
            failedItemCount = res ? res.page.total : null;
            failedItemCountError = !res;
        });
        return () => {
            cancelled = true;
        };
    });

    // Loose response contract — `runId`/`deduped` are read (for
    // openLogsOnRunId + the inline "Run started" / "Already running" line).
    const ActionResponseSchema = z
        .object({ runId: z.string().optional(), deduped: z.boolean().optional() })
        .passthrough();

    // Per-action loading state, keyed by action id.
    let loadingActions = new SvelteSet<string>();
    // The action whose confirm dialog is currently open (null = none).
    let pendingConfirm = $state<TaskAction | null>(null);
    // Last successful enqueue result per action id — drives the inline
    // "Run started — View run →" / "Already running — View" line under the
    // button, since the drawer otherwise gave no visible feedback beyond a
    // toast that can be missed.
    let lastRunResult = new SvelteMap<string, { runId: string; deduped: boolean }>();

    /** Resolve a stat tile's icon from its opaque iconKey (falling back on key). */
    function statIcon(stat: StatTile): IconSource {
        const key = stat.iconKey ?? stat.key;
        switch (key) {
            case 'active':
                return Bolt;
            case 'backlog':
                return QueueList;
            case 'failures':
                return ExclamationTriangle;
            case 'throughput':
                return ArrowTrendingUp;
            case 'circuit':
                return ShieldCheck;
            default:
                return Cog6Tooth;
        }
    }

    /**
     * Explanatory tooltip for a stat tile, resolved from its opaque key.
     * `StatTile` carries no tooltip field (the schema is shared and
     * server-producible), so the one tile that needs a term-of-art footnote
     * gets it here — same key-driven pattern as `statIcon`.
     */
    function statTooltip(stat: StatTile): string | undefined {
        const key = stat.iconKey ?? stat.key;
        // "Auto-pause" is the operator's name for it; "circuit breaker" is the
        // term to search the web (and this codebase) for. Advanced users get
        // the latter on hover without it heading the card.
        if (key === 'circuit')
            return `${m.admin_task_auto_pause_aka()} ${m.admin_task_auto_pause_tooltip()}`;
        return undefined;
    }

    /** Button glyph for an action. Pause is the one action Play would misdescribe. */
    function actionIcon(action: TaskAction): IconSource {
        return action.id === 'pause-schedule' ? PauseCircle : PlayCircle;
    }

    /**
     * Success toast for an action. The generic “{label}” started reads wrong
     * for a state change — “Pause” started is not what happened.
     */
    function successMessage(action: TaskAction): string {
        if (action.id === 'pause-schedule') return m.admin_task_pause_toast();
        if (action.id === 'resume-schedule') return m.admin_task_resume_toast();
        return m.admin_task_dashboard_action_started({ label: action.label });
    }

    function buttonClass(style: TaskAction['style']): string {
        switch (style) {
            case 'primary':
                return 'btn-primary';
            case 'secondary':
                return 'btn-secondary';
            case 'danger':
                return 'btn-red';
        }
    }

    async function dispatch(
        req: TaskAction['request'],
    ): Promise<{ data: z.infer<typeof ActionResponseSchema> | null; error: string | null }> {
        const { method, url, body } = req;
        switch (method) {
            case 'POST':
                return apiPost(url, ActionResponseSchema, body);
            case 'PUT':
                return apiPut(url, ActionResponseSchema, body);
            case 'PATCH':
                return apiPatch(url, ActionResponseSchema, body);
            case 'DELETE':
                return apiDelete(url, ActionResponseSchema, body);
        }
    }

    /** Actually fire an action's request (bypassing confirm). */
    async function fire(action: TaskAction): Promise<void> {
        if (loadingActions.has(action.id)) return;
        loadingActions.add(action.id);
        try {
            const { data: res, error } = await dispatch(action.request);
            if (error || !res) {
                toasts.error(
                    error ?? m.admin_task_dashboard_action_failed({ label: action.label }),
                );
                return;
            }
            if (action.openLogsOnRunId && res.runId) {
                lastRunResult.set(action.id, { runId: res.runId, deduped: res.deduped === true });
                runLogDrawer.open(res.runId);
                toasts.success(m.admin_task_dashboard_run_started({ id: res.runId.slice(0, 8) }));
            } else {
                toasts.success(successMessage(action));
            }
            onRefreshed?.();
        } finally {
            loadingActions.delete(action.id);
        }
    }

    /** Button entry point: open confirm dialog if configured, else fire. */
    function onActionClick(action: TaskAction): void {
        if (action.confirm) {
            pendingConfirm = action;
            return;
        }
        void fire(action);
    }

    /** Confirm dialog accepted — fire, then close. */
    async function onConfirm(): Promise<void> {
        const action = pendingConfirm;
        if (!action) return;
        await fire(action);
        pendingConfirm = null;
    }

    let allActions = $derived([
        ...(data.primaryAction ? [data.primaryAction] : []),
        ...data.secondaryActions,
    ]);
</script>

<div class="space-y-6">
    <!-- Header -->
    <div class="flex items-start gap-3">
        {#if icon}
            <div class="p-2 rounded-lg bg-surface-800/70 border border-surface-700">
                <Icon src={icon} class="w-6 h-6 text-blue-400" />
            </div>
        {/if}
        <div>
            {#if showTitle}
                <h2 class="text-xl font-semibold text-surface-100">{data.title}</h2>
            {/if}
            {#if data.description}
                <p class="{showTitle ? 'mt-1' : ''} text-sm text-surface-400">{data.description}</p>
            {/if}
            {#if data.impact}
                <p class="mt-1 text-sm text-surface-300">
                    <span class="font-medium text-surface-200">{m.admin_task_impact_label()}</span>
                    {data.impact}
                </p>
            {/if}
        </div>
    </div>

    <!-- Coverage headline -->
    {#if data.coverage.length > 0}
        <div class="space-y-4">
            {#each data.coverage as bar, i (i)}
                <CoverageBar {bar} />
            {/each}
        </div>
    {/if}

    <!-- Stat grid -->
    {#if data.stats.length > 0}
        <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {#each data.stats as stat, i (i)}
                <StatCard
                    icon={statIcon(stat)}
                    title={stat.title}
                    color={stat.color}
                    value={stat.value}
                    healthy={stat.healthy ?? null}
                    tooltip={statTooltip(stat)}
                    subtitle={stat.subtitle} />
            {/each}
        </div>
    {/if}

    <!-- Actions -->
    {#if allActions.length > 0}
        <div class="card-base">
            <h3 class="text-lg font-semibold text-surface-100 mb-4">
                {m.admin_task_dashboard_actions_heading()}
            </h3>
            <div class="flex flex-wrap gap-3">
                {#each allActions as action, i (i)}
                    <div class="flex flex-col gap-1">
                        <button
                            type="button"
                            class="btn {buttonClass(action.style)} flex items-center gap-2"
                            onclick={() => onActionClick(action)}
                            disabled={loadingActions.has(action.id)}
                            title={action.warning ?? action.description}>
                            {#if loadingActions.has(action.id)}
                                <span class="loading-spinner"></span>
                            {:else}
                                <Icon src={actionIcon(action)} class="w-5 h-5" />
                            {/if}
                            {action.label}
                        </button>
                        {#if action.warning}
                            <span class="text-xs text-amber-400 max-w-xs">{action.warning}</span>
                        {:else if action.description}
                            <span class="text-xs text-surface-500 max-w-xs"
                                >{action.description}</span>
                        {/if}
                        {#if lastRunResult.get(action.id)}
                            {@const result = lastRunResult.get(action.id)}
                            <span class="text-xs text-emerald-400 max-w-xs">
                                {result?.deduped
                                    ? m.admin_task_run_now_deduped_prefix()
                                    : m.admin_task_run_now_success_prefix()}
                                <a
                                    href="{resolve('/admin/tasks/runs')}?run={result?.runId}"
                                    class="underline hover:text-emerald-300"
                                    onclick={(e) => {
                                        if (
                                            !result?.runId ||
                                            e.button !== 0 ||
                                            e.metaKey ||
                                            e.ctrlKey ||
                                            e.shiftKey
                                        )
                                            return;
                                        e.preventDefault();
                                        runDetailPanel.open(result.runId);
                                    }}>
                                    {result?.deduped
                                        ? m.admin_task_run_now_deduped_link()
                                        : m.admin_task_run_now_success_link()}
                                </a>
                            </span>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Failures -->
    {#if data.failures?.show}
        <div class="card-base">
            <!--
                Deliberately NOT titled "Recent failures" any more. This list is
                unresolved per-item plugin_failure_events with no time window;
                the stat tile above counts failed RUNS in the last 24h. Sharing
                one title made "Recent failures: 2" and "No unresolved failures"
                read as a contradiction a few inches apart.
            -->
            <h3 class="text-lg font-semibold text-surface-100 mb-1">
                {m.admin_task_failed_items_heading()}
            </h3>
            <p class="mb-3 text-xs text-surface-500">{m.admin_task_failed_items_hint()}</p>
            {#if failedItemCountError}
                <p class="text-sm text-red-300">{m.admin_task_failed_items_load_error()}</p>
            {:else if failedItemCount === null}
                <p class="text-sm text-surface-500">{m.common_loading_ellipsis()}</p>
            {:else if failedItemCount === 0}
                <p class="text-sm text-surface-400">{m.admin_task_overview_failed_items_none()}</p>
            {:else}
                <div class="flex flex-wrap items-center gap-3">
                    <p class="text-sm text-amber-300">
                        {m.admin_task_overview_failed_items({
                            count: failedItemCount.toLocaleString(),
                        })}
                    </p>
                    {#if onShowFailures}
                        <button
                            type="button"
                            class="rounded border border-amber-700/40 bg-amber-900/20 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-900/40"
                            onclick={onShowFailures}>
                            {m.admin_task_overview_open_failures()}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>
    {/if}

    <!-- How it works -->
    {#if data.help.length > 0}
        <div class="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
            <h4 class="font-semibold text-surface-100 mb-3">
                {m.admin_task_dashboard_how_it_works_heading()}
            </h4>
            <ul class="space-y-2 text-sm text-surface-300">
                {#each data.help as line, i (i)}
                    <li>• {line}</li>
                {/each}
            </ul>
        </div>
    {/if}
</div>

{#if pendingConfirm?.confirm}
    <ActionModal
        title={pendingConfirm.confirm.title}
        confirmText={pendingConfirm.confirm.confirmText}
        confirmColor={pendingConfirm.confirm.confirmColor}
        onclose={() => (pendingConfirm = null)}
        onconfirm={onConfirm}>
        {#if pendingConfirm.confirm.body}
            <p class="text-sm text-surface-300">{pendingConfirm.confirm.body}</p>
        {/if}
    </ActionModal>
{/if}
