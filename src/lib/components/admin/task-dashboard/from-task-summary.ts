// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure mapper: TaskDefinitionSummary → TaskDashboardData.
 *
 * Turns the generic task summary (as returned by GET /api/v1/tasks/[taskId])
 * into the declarative dashboard model consumed by <TaskDashboard>. This is the
 * baseline projection every task gets for free; richer per-task pages can build
 * their own TaskDashboardData (e.g. with real coverage bars) instead.
 *
 * No coverage bars are emitted here: the summary carries `backlogRemaining`
 * (items still to process) but no completed/eligible total, so a truthful
 * coverage percentage cannot be derived. Adopters with a real total supply
 * their own `coverage` entries.
 *
 * NOTE ON LOCATION: the design named this `src/lib/server/tasks/dashboard/…`,
 * but it is imported by a client `+page.svelte`. `$lib/server/*` is
 * server-only in SvelteKit and importing it into client code breaks
 * `vite build`, so it lives beside the component instead. Kept pure and
 * side-effect-free as specified.
 */

import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
import type {
    TaskDashboardData,
    StatTile,
    TaskAction,
} from '$lib/schemas/task-dashboard.schema.js';
import { taskDescription, taskImpact } from '$lib/utils/admin/task-descriptions.js';
import { stripTaskIdPrefix } from '$lib/utils/admin/run-error-display.js';
import * as m from '$lib/paraglide/messages.js';

/**
 * Operator-facing wording for a breaker state. The three message keys hold the
 * same vocabulary as `circuitStateLabel()` in `$lib/utils/operator-labels` —
 * "Running" / "Paused" / "Testing recovery", never the raw closed/open/
 * half-open codes, which invert their plain-English meaning ("Closed" reads as
 * broken to anyone who has not met a circuit breaker). The keys are kept
 * instead of calling `circuitStateLabel()` directly because these strings
 * render in the admin UI and must be translatable; `operator-labels` is
 * English-only.
 */
function circuitLabel(state: NonNullable<TaskDefinitionSummary['circuitState']>): string {
    switch (state) {
        case 'closed':
            return m.admin_task_stat_circuit_value_closed();
        case 'open':
            return m.admin_task_stat_circuit_value_open();
        case 'half_open':
            return m.admin_task_stat_circuit_value_half_open();
    }
}

/** Sub-caption under the auto-pause tile — one per state, not a healthy/tripped binary. */
function circuitSubtitle(state: NonNullable<TaskDefinitionSummary['circuitState']>): string {
    switch (state) {
        case 'closed':
            return m.admin_task_stat_circuit_healthy();
        case 'open':
            return m.admin_task_stat_circuit_tripped();
        case 'half_open':
            return m.admin_task_stat_circuit_recovering();
    }
}

/**
 * Build the baseline dashboard model from a task summary. Pure — same input
 * always yields the same output, no I/O.
 */
export function fromTaskSummary(task: TaskDefinitionSummary): TaskDashboardData {
    const unitLabel =
        task.backlog?.unitLabel === 'file links'
            ? m.admin_task_backlog_unit_file_links()
            : (task.backlog?.unitLabel ?? 'items');
    // The lane fields are absent when the server could not read them (task DB
    // unreachable). Show "—" and no health colour: 0 with a green tile would
    // read as "no backlog, no failures".
    const UNKNOWN = '—';
    const activeCount = task.activeCount ?? UNKNOWN;
    const backlogRemaining = task.backlogRemaining;
    const recentFailCount = task.recentFailCount;

    const stats: StatTile[] = [
        {
            key: 'active',
            title: m.admin_task_stat_active_title(),
            value: activeCount,
            color: 'cyan',
            subtitle: m.admin_task_stat_active_subtitle(),
        },
        {
            key: 'backlog',
            title: m.admin_tasks_backlog(),
            value: backlogRemaining ?? UNKNOWN,
            color: 'blue',
            healthy: backlogRemaining === undefined ? undefined : backlogRemaining === 0,
            subtitle: m.admin_task_stat_backlog_subtitle({ unit: unitLabel }),
        },
        {
            // Counts FAILED RUNS from task_history in the last 24h — a
            // different population from the "Items it could not process"
            // panel below, which lists unresolved per-item
            // plugin_failure_events with no time window. A task can fail
            // every run without ever writing a per-item row (fribb-anime-sync
            // does exactly that), which read as a flat contradiction while
            // both were titled "Recent failures". The title now names the
            // unit and the window, and the subtitle carries the actual error
            // so the Overview an admin lands on stops being the one surface
            // that hides it.
            key: 'failures',
            title: m.admin_task_stat_failed_runs_title(),
            value: recentFailCount ?? UNKNOWN,
            color: 'red',
            healthy: recentFailCount === undefined ? undefined : recentFailCount === 0,
            subtitle: task.lastFailedError
                ? m.admin_task_stat_failed_runs_last({
                      error: stripTaskIdPrefix(task.lastFailedError, task.id),
                  })
                : m.admin_task_stat_failed_runs_subtitle(),
        },
    ];

    if (task.itemsPerHour != null) {
        stats.push({
            key: 'throughput',
            title: m.admin_task_stat_throughput_title(),
            value: `${task.itemsPerHour.toLocaleString()}/h`,
            color: 'green',
            subtitle: m.admin_task_stat_throughput_subtitle({ unit: unitLabel }),
        });
    }

    if (task.circuitState) {
        stats.push({
            key: 'circuit',
            title: m.admin_task_auto_pause(),
            value: circuitLabel(task.circuitState),
            healthy: task.circuitState === 'closed',
            subtitle: circuitSubtitle(task.circuitState),
        });
    }

    // Two independent switches, deliberately kept apart:
    //  - breakerPaused  — the system tripped itself after repeated failures.
    //    A manual run can still be DENIED while it holds.
    //  - schedulePaused — a person stopped the schedule. `scheduler.ts` is the
    //    only reader of that flag, so a manual run is unaffected; the copy
    //    below must not imply otherwise.
    const breakerPaused = task.circuitState === 'open' || task.circuitState === 'half_open';
    const schedulePaused = task.schedulePaused === true;
    const isDestructive = task.destructive === true;

    // Curated one-liner, computed once — feeds both the header description
    // and (for destructive tasks) the confirm dialog's cost statement below.
    const description = taskDescription(task.id, task.description);

    const primaryAction: TaskAction = {
        id: 'run-now',
        label: m.admin_task_run_confirm_button(),
        style: isDestructive ? 'danger' : 'primary',
        description: m.admin_task_run_now_description(),
        // The circuit breaker can still deny a manual run while paused (it
        // isn't silently ignored — the request errors), so the button stays
        // enabled but carries a warning pointing at the notice above it.
        // Destructive tasks (e.g. embedding-reset) take priority over the
        // paused hint — an operator needs to know data will be deleted
        // before they need to know a run might currently be denied. The
        // breaker outranks the schedule pause for the same reason: only the
        // breaker can make this button fail.
        warning: isDestructive
            ? m.admin_task_run_destructive_title()
            : breakerPaused
              ? m.admin_task_run_now_paused_hint()
              : schedulePaused
                ? m.admin_task_run_now_schedule_paused_hint()
                : undefined,
        // Destructive tasks must state the cost before the delete fires, not
        // just ask for a click. No task summary field carries a reliable
        // count of what a given destructive run would remove (there is no
        // generic "rows this will delete" number), so the body sticks to the
        // task's own curated description (already names what gets deleted,
        // e.g. embedding-reset) plus the one fact that is always true for
        // every `destructive: true` task: it cannot be undone.
        confirm: isDestructive
            ? {
                  title: m.admin_task_run_confirm_title({ name: task.name }),
                  body: `${description ?? m.admin_task_run_confirm_body_fallback()} ${m.admin_task_run_destructive_cost()}`,
                  confirmText: m.admin_task_run_confirm_button(),
                  confirmColor: 'red',
              }
            : undefined,
        request: {
            method: 'POST',
            url: `/api/tasks/${encodeURIComponent(task.id)}/run`,
            body: {},
        },
        openLogsOnRunId: true,
    };

    // Read the DERIVED flag, not a capabilities key. `capabilities` is a
    // closed shape with no 'per-item-retry' member, so this condition was
    // unsatisfiable: the Retry button never rendered for any task, including
    // the ones that implement `failures.retry`.
    const supportsRetry = task.supportsPerItemRetry === true;

    // Pause / Resume. `PATCH …/state` with `{ schedule }` has existed and been
    // scope-gated on tasks:admin since the state endpoint landed, but until now
    // the only caller was an attention-feed action that appears solely after a
    // breaker trip — so an admin who simply wanted to stop a CPU-heavy task had
    // no button anywhere. Reversible in one click, so no confirm dialog.
    //
    // `/api/tasks/…` (not `/api/v1/…`) matches the surface AttentionItemRow
    // already calls for this exact request: the internal forward-auth/cookie
    // mount, which an admin browser session is authenticated against.
    //
    // Offered only when the schedule state is KNOWN. `schedulePaused` is absent
    // (not false) when the task database was unreachable, and offering "Pause"
    // for a task that may already be paused would be a guess.
    const secondaryActions: TaskAction[] = [];
    if (task.schedulePaused !== undefined) {
        secondaryActions.push(
            schedulePaused
                ? {
                      id: 'resume-schedule',
                      label: m.admin_task_resume(),
                      style: 'primary',
                      description: m.admin_task_resume_description(),
                      request: {
                          method: 'PATCH',
                          url: `/api/tasks/${encodeURIComponent(task.id)}/state`,
                          body: { schedule: 'active' },
                      },
                  }
                : {
                      id: 'pause-schedule',
                      label: m.admin_task_pause(),
                      style: 'secondary',
                      description: m.admin_task_pause_description(),
                      request: {
                          method: 'PATCH',
                          url: `/api/tasks/${encodeURIComponent(task.id)}/state`,
                          body: { schedule: 'paused' },
                      },
                  },
        );
    }

    const help: string[] = [];
    help.push(m.admin_task_help_run_now());
    if (schedulePaused) {
        help.push(m.admin_task_help_paused());
    }
    if (task.schedule?.every) {
        help.push(m.admin_task_help_schedule_every({ every: task.schedule.every }));
    } else {
        help.push(m.admin_task_help_no_schedule());
    }
    help.push(m.admin_task_help_backlog_counts({ unit: unitLabel }));
    if (supportsRetry) {
        help.push(m.admin_task_help_retry_individual());
    }

    return {
        taskId: task.id,
        title: task.name,
        // Admin IA redesign step:task-descriptions — the curated Paraglide
        // one-liner (en+de) wins over the SDK author's raw `description`,
        // same precedence as the catalog card / confirmBeforeRun dialog.
        description,
        // "If this stops, you'd notice" consequence line — undefined for the
        // four watch-sync registry stubs and any task with no curated entry
        // (see `taskImpact()`); the component renders nothing in that case.
        impact: taskImpact(task.id),
        coverage: [],
        stats,
        primaryAction,
        secondaryActions,
        failures: { show: true, supportsRetry },
        help,
    };
}
