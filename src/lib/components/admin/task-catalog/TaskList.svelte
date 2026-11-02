<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The classic scheduled-task list (spec 2026-09-27 §1.1), the way Jellyfin /
  Emby / Plex operators know it: tasks grouped by category, one row each —
  status, name, last run and how long it took, next run, a progress bar while
  running, ▶ Run. Rows are sorted by name and NEVER move on a live update; a
  problem is shown ON its row (icon + one-line reason), not by relocating it.
  This replaces the Status/Catalog views, the card grid and the status chips.
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { openDetail } from '$lib/components/admin/detail/detail-url.js';
    import { resolve } from '$lib/paths';
    import { formatDurationMs } from '$lib/utils/admin/formatters.js';
    import { formatElapsed } from '$lib/utils/metric-formatters.js';
    import { taskDescription } from '$lib/utils/admin/task-descriptions.js';
    import {
        humanizeErrorDurations,
        stripTaskIdPrefix,
    } from '$lib/utils/admin/run-error-display.js';
    import { useNow } from '$lib/utils/use-now.svelte';
    import type { AttentionItem } from '$lib/schemas/api-attention-responses.js';
    import type {
        StaleEdgeAlert,
        TaskDefinitionSummary,
        TaskPurpose,
    } from '$lib/schemas/task-definition.schema.js';
    import type { TaskAggregate } from '$lib/stores/task-aggregates.js';
    import type { MonitoringContext } from '$lib/components/admin/task-dashboard/monitoring-groups.js';
    import TaskRunButton from './TaskRunButton.svelte';
    import { taskRowState, type TaskRowState } from './task-row-status.js';

    interface Group {
        purpose: TaskPurpose;
        label: string;
        tasks: TaskDefinitionSummary[];
    }

    interface Props {
        groups: Group[];
        aggregates: Map<string, TaskAggregate>;
        /** Open attention-board findings per task (`findingsByTask`). */
        findings: Map<string, AttentionItem[]>;
        /** Same context the strip and the visibility rule use. */
        ctx: MonitoringContext;
    }

    let { groups, aggregates, findings, ctx }: Props = $props();

    const now = useNow(15_000);

    function isRunning(task: TaskDefinitionSummary): boolean {
        return (
            (aggregates.get(task.id)?.runningCount ?? 0) > 0 || (task.observedActiveCount ?? 0) > 0
        );
    }

    function hasInFlight(task: TaskDefinitionSummary): boolean {
        return (
            (task.activeCount ?? 0) > 0 ||
            (aggregates.get(task.id)?.runningCount ?? 0) > 0 ||
            (aggregates.get(task.id)?.queuedCount ?? 0) > 0 ||
            (aggregates.get(task.id)?.deferredCount ?? 0) > 0
        );
    }

    function waiting(task: TaskDefinitionSummary): number {
        const live = aggregates.get(task.id)?.coverageBacklog;
        return live ?? task.backlogRemaining ?? 0;
    }

    function rowState(task: TaskDefinitionSummary): TaskRowState {
        return taskRowState(
            task,
            {
                running: isRunning(task),
                queued: (aggregates.get(task.id)?.queuedCount ?? 0) > 0,
                deferred: (aggregates.get(task.id)?.deferredCount ?? 0) > 0,
                inFlight: hasInFlight(task),
                waiting: waiting(task),
            },
            ctx,
        );
    }

    /** The one line under the name that says what is going on, or null. */
    function reason(task: TaskDefinitionSummary, state: TaskRowState): string | null {
        if (state === 'problem') {
            const list = findings.get(task.id) ?? [];
            if (list.length > 0) {
                return list.length > 1
                    ? m.admin_tasks_row_more({ first: list[0].title, count: list.length - 1 })
                    : list[0].title;
            }
            if (task.lastFailedError) {
                return m.admin_tasks_row_failed({
                    error: humanizeErrorDurations(stripTaskIdPrefix(task.lastFailedError, task.id)),
                });
            }
            return m.admin_tasks_row_failed_plain({ count: task.recentFailCount ?? 1 });
        }
        if (state === 'paused') return m.admin_tasks_row_paused();
        if (state === 'queued') return m.admin_run_confirmed_waiting();
        if (state === 'deferred') return m.admin_run_playback_deferred();
        if (state === 'in-flight') return m.admin_task_admission_unknown();
        if (state === 'waiting') {
            if (task.id === 'trickplay-params-sync') {
                return m.admin_task_backlog_waiting({
                    count: waiting(task).toLocaleString(),
                    unit: m.admin_task_backlog_unit_file_links(),
                });
            }
            return m.admin_task_waiting_items({ count: waiting(task) });
        }
        const stale = task.staleUpstreams?.[0];
        return stale ? staleAlertText(stale) : null;
    }

    function formatAge(ms: number): string {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        const min = Math.round(ms / 60_000);
        if (min < 60) return `${min}m`;
        const h = Math.round(ms / 3_600_000);
        if (h < 24) return `${h}h`;
        return `${Math.round(ms / 86_400_000)}d`;
    }

    /** "X has not run since Y last completed" — moved here from under the old cards. */
    function staleAlertText(alert: StaleEdgeAlert): string {
        const age = formatAge(alert.staleByMs);
        if (!alert.downstreamCompletedAt) {
            return m.admin_jobs_stale_never_run({
                downstream: alert.downstreamId,
                upstream: alert.upstreamId,
                age,
            });
        }
        return m.admin_jobs_stale_not_run_since({
            downstream: alert.downstreamId,
            age,
            upstream: alert.upstreamId,
        });
    }

    function progress(task: TaskDefinitionSummary): { done: number; total: number } | null {
        const stage = aggregates.get(task.id)?.primaryStage;
        if (!stage || !stage.total) return null;
        return { done: stage.processed ?? 0, total: stage.total };
    }

    function lastRun(task: TaskDefinitionSummary): string {
        if (!task.lastCompletedAt) return m.admin_tasks_row_no_recent_run();
        const ms = now.value - Date.parse(task.lastCompletedAt);
        const ago =
            !Number.isFinite(ms) || ms < 60_000
                ? m.admin_tasks_just_now()
                : m.admin_tasks_ago({ time: formatDurationMs(ms) });
        const d = task.lastDurationMs;
        if (d == null) return ago;
        // Seconds matter here: most runs take 1–59 s, which minute rounding
        // turned into "took 0m".
        const took =
            d < 1000 ? m.admin_tasks_row_took_short() : formatElapsed(Math.round(d / 1000));
        return m.admin_tasks_row_last_run({ ago, took });
    }

    function nextRun(task: TaskDefinitionSummary): string {
        if (task.schedulePaused === true) return m.admin_tasks_row_paused_short();
        if (!task.schedule?.every) return m.admin_tasks_row_on_demand();
        if (!task.nextRunAt) return '—';
        const ms = Date.parse(task.nextRunAt) - now.value;
        if (!Number.isFinite(ms)) return '—';
        if (ms < 60_000) return m.admin_tasks_next_due();
        return m.admin_tasks_next_in({ time: formatDurationMs(ms) });
    }

    const ICON: Record<TaskRowState, { glyph: string; cls: string; label: () => string }> = {
        running: { glyph: '●', cls: 'text-blue-400 animate-pulse', label: m.admin_task_running },
        queued: { glyph: '◔', cls: 'text-blue-300', label: m.admin_run_confirmed_waiting },
        deferred: { glyph: '◔', cls: 'text-amber-300', label: m.admin_run_playback_deferred },
        'in-flight': { glyph: '◌', cls: 'text-blue-300', label: m.admin_task_admission_unknown },
        problem: { glyph: '⚠', cls: 'text-amber-400', label: m.admin_tasks_row_state_problem },
        paused: { glyph: '⏸', cls: 'text-amber-300', label: m.admin_task_paused_badge },
        waiting: { glyph: '◔', cls: 'text-purple-300', label: m.route_admin_tasks_lane_pending },
        ok: { glyph: '✓', cls: 'text-emerald-400/80', label: m.admin_tasks_row_state_ok },
        idle: { glyph: '–', cls: 'text-surface-500', label: m.admin_tasks_row_state_idle },
    };

    function detailPath(task: TaskDefinitionSummary): string {
        return `/admin/tasks/${encodeURIComponent(task.id)}`;
    }
</script>

<div class="space-y-6">
    {#each groups as group (group.purpose)}
        {#if group.tasks.length > 0}
            <section
                aria-labelledby="task-group-{group.purpose}"
                class={group.purpose === 'repair' ? 'border-t-2 border-amber-700/30 pt-5' : ''}>
                <h2
                    id="task-group-{group.purpose}"
                    class="mb-2 flex items-baseline gap-2 text-sm font-semibold uppercase tracking-wide text-surface-300">
                    {group.label}
                    <span class="text-xs font-normal normal-case text-surface-500"
                        >{group.tasks.length}</span>
                </h2>
                {#if group.purpose === 'repair'}
                    <p class="mb-2 text-xs text-amber-300/70">
                        {m.admin_tasks_purpose_repair_hint()}
                    </p>
                {/if}
                <div class="overflow-hidden rounded-lg border border-surface-700/50">
                    <table class="w-full table-fixed text-left text-sm">
                        <thead class="bg-surface-900/60 text-xs text-surface-400">
                            <tr>
                                <th scope="col" class="w-8 px-2 py-2"
                                    ><span class="sr-only">{m.admin_tasks_row_state_header()}</span
                                    ></th>
                                <th scope="col" class="px-2 py-2 font-medium"
                                    >{m.admin_tasks_table_task()}</th>
                                <th
                                    scope="col"
                                    class="hidden w-60 px-2 py-2 font-medium md:table-cell"
                                    >{m.admin_tasks_table_last()}</th>
                                <th
                                    scope="col"
                                    class="hidden w-32 px-2 py-2 font-medium sm:table-cell"
                                    >{m.admin_tasks_table_next()}</th>
                                <th scope="col" class="w-14 px-2 py-2 sm:w-20"
                                    ><span class="sr-only">{m.admin_task_run()}</span></th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-surface-800/70">
                            {#each group.tasks as task (task.id)}
                                {@const state = rowState(task)}
                                {@const why = reason(task, state)}
                                {@const running = isRunning(task)}
                                {@const bar = running ? progress(task) : null}
                                {@const icon = ICON[state]}
                                <tr class="align-top hover:bg-surface-800/30">
                                    <td class="px-2 py-2 text-center">
                                        <span
                                            class="inline-block w-4 {icon.cls}"
                                            role="img"
                                            aria-label={icon.label()}
                                            title={icon.label()}>{icon.glyph}</span>
                                    </td>
                                    <td class="min-w-0 px-2 py-2">
                                        <a
                                            href={resolve(detailPath(task))}
                                            class="font-medium text-surface-100 hover:underline"
                                            title={taskDescription(task.id, task.description)}
                                            onclick={(e) => {
                                                if (
                                                    e.button !== 0 ||
                                                    e.metaKey ||
                                                    e.ctrlKey ||
                                                    e.shiftKey
                                                )
                                                    return;
                                                e.preventDefault();
                                                openDetail(detailPath(task));
                                            }}>{task.name}</a>
                                        {#if task.visibility === 'system'}
                                            <span
                                                class="ml-1.5 rounded-full border border-surface-600/50 px-1.5 text-[10px] text-surface-400"
                                                title={m.admin_task_system_badge_title()}
                                                >{m.admin_task_system_badge()}</span>
                                        {/if}
                                        {#if task.pluginId}
                                            <span
                                                class="ml-1.5 rounded-full border border-surface-600/50 px-1.5 text-[10px] text-surface-400"
                                                title={m.admin_task_from_plugin_title({
                                                    id: task.pluginId,
                                                })}
                                                >{m.admin_task_from_plugin({
                                                    id: task.pluginId,
                                                })}</span>
                                        {/if}
                                        {#if why}
                                            <p
                                                class="mt-0.5 truncate text-xs {state === 'problem'
                                                    ? 'text-amber-300/90'
                                                    : 'text-surface-400'}"
                                                title={why}>
                                                {why}
                                            </p>
                                        {/if}
                                        {#if running}
                                            <div
                                                class="mt-1 h-1 w-full max-w-sm overflow-hidden rounded-full bg-surface-800"
                                                role="progressbar"
                                                aria-label={m.admin_task_running()}
                                                aria-valuemin={0}
                                                aria-valuemax={bar?.total}
                                                aria-valuenow={bar?.done}>
                                                <div
                                                    class="h-full rounded-full bg-blue-500 {bar
                                                        ? ''
                                                        : 'w-1/3 animate-pulse'}"
                                                    style:width={bar
                                                        ? `${Math.min(100, (bar.done / bar.total) * 100)}%`
                                                        : undefined}>
                                                </div>
                                            </div>
                                        {/if}
                                        <!-- Phone: the last-run column is hidden, so it rides here. -->
                                        <p class="mt-0.5 text-xs text-surface-500 md:hidden">
                                            {lastRun(task)}
                                        </p>
                                    </td>
                                    <td
                                        class="hidden px-2 py-2 text-xs text-surface-300 md:table-cell">
                                        {lastRun(task)}
                                    </td>
                                    <td
                                        class="hidden px-2 py-2 text-xs text-surface-300 sm:table-cell"
                                        title={task.nextRunAt ?? undefined}>
                                        {nextRun(task)}
                                    </td>
                                    <td class="px-2 py-1.5 text-right">
                                        <TaskRunButton {task} running={hasInFlight(task)} />
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </section>
        {/if}
    {/each}
</div>
