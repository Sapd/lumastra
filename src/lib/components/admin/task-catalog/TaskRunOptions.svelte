<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The extra run modes a task page offers beyond the list's ▶ Run: a full run
  (and, where the task has an `onWipe` hook, a destructive force rebuild) and,
  for the intro analyzer, a segment refresh scoped to intros, outros or both.
  The server already advertises `supportsFullRun` / `supportsForceRun` on the
  task summary and `POST /tasks/{id}/run` carries `input`; this restores the
  operator UI the classic task list (2026-09-27) dropped.
-->

<script lang="ts">
    import { Icon, Play } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { modals } from '$lib/stores/modal.store';
    import { RunTriggerResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
    import RunScopeModal, { type RunScopeChoice } from './RunScopeModal.svelte';
    import SegmentRefreshModal, { type SegmentScopeChoice } from './SegmentRefreshModal.svelte';

    interface Props {
        task: TaskDefinitionSummary;
        /** A run of this task is in progress — a second full pass is refused here. */
        running: boolean;
        /** Called after a run was started (or deduped) so the page can refresh. */
        onStarted?: () => void;
    }

    let { task, running, onStarted }: Props = $props();

    /** The task that owns intro/outro detection (segment refresh scopes). */
    const SEGMENT_TASK_ID = 'lumastra-intro-analyzer';

    let fullRunTriggering = $state(false);
    let segmentTriggering = $state(false);
    let busy = $derived(fullRunTriggering || segmentTriggering);
    let destructive = $derived(task.destructive === true);
    let showFullRun = $derived(task.supportsFullRun === true);
    let showSegments = $derived(task.id === SEGMENT_TASK_ID);

    const SCOPE_SEGMENT_TYPES: Record<SegmentScopeChoice, ('Intro' | 'Outro')[]> = {
        both: ['Intro', 'Outro'],
        intro: ['Intro'],
        outro: ['Outro'],
    };

    function idempotencyKey(): string {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
        } catch {
            // fall through
        }
        return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    async function doFullRun(scope: RunScopeChoice): Promise<void> {
        if (fullRunTriggering || running) return;
        fullRunTriggering = true;
        try {
            // A full run can hold the worker for hours: a double tap must not queue two.
            const { data, error } = await apiPost(
                `/api/tasks/${encodeURIComponent(task.id)}/run`,
                RunTriggerResponseSchema,
                { input: { mode: scope } },
                { headers: { 'Idempotency-Key': idempotencyKey() } },
            );
            if (error || !data) {
                toasts.error(m.admin_task_run_error({ error: error ?? m.toast_unknown_error() }));
                return;
            }
            if (data.deduped === true) {
                // After a confirmed destructive rebuild, "already running" alone
                // would hide that the wipe did NOT happen — say so.
                toasts.info(
                    scope === 'force'
                        ? m.admin_task_force_run_deduped()
                        : m.admin_task_run_already_running(),
                );
            } else {
                toasts.success(
                    scope === 'force'
                        ? m.admin_task_force_run_started()
                        : m.admin_task_full_run_started(),
                );
            }
            onStarted?.();
        } finally {
            fullRunTriggering = false;
        }
    }

    async function doSegmentRefresh(scope: SegmentScopeChoice): Promise<void> {
        if (segmentTriggering || running) return;
        segmentTriggering = true;
        try {
            const { data, error } = await apiPost(
                `/api/tasks/${encodeURIComponent(task.id)}/run`,
                RunTriggerResponseSchema,
                { input: { segmentTypes: SCOPE_SEGMENT_TYPES[scope] } },
            );
            if (error || !data) {
                toasts.error(m.admin_task_run_error({ error: error ?? m.toast_unknown_error() }));
                return;
            }
            // Every scope shares one run identity (two library-wide FFmpeg passes
            // must never run at once), so a dedup may be a different scope.
            if (data.deduped === true) toasts.info(m.admin_task_run_already_running_other_scope());
            else toasts.success(m.admin_task_segment_refresh_started());
            onStarted?.();
        } finally {
            segmentTriggering = false;
        }
    }

    function openFullRun(): void {
        if (busy || running) return;
        modals.open(RunScopeModal, {
            // Force only where an onWipe hook exists; otherwise the drain degrades
            // to a plain manual run and the destructive option would promise a
            // rebuild that never happens.
            allowForce: task.supportsForceRun === true,
            onConfirm: (scope: RunScopeChoice) =>
                doFullRun(scope).catch(() => {
                    fullRunTriggering = false;
                    toasts.error(m.admin_task_run_error({ error: m.toast_unknown_error() }));
                }),
        });
    }

    function openSegmentRefresh(): void {
        if (busy || running) return;
        modals.open(SegmentRefreshModal, {
            onConfirm: (scope: SegmentScopeChoice) => doSegmentRefresh(scope),
        });
    }
</script>

{#if showFullRun || showSegments}
    <div class="flex flex-wrap items-center gap-2">
        {#if showFullRun}
            <button
                type="button"
                class="flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {destructive
                    ? 'border-red-700/50 text-red-300 hover:border-red-600 hover:bg-red-950/30 hover:text-red-200'
                    : 'border-surface-600/50 text-surface-200 hover:border-surface-500 hover:bg-surface-800/40 hover:text-white'}"
                onclick={openFullRun}
                disabled={busy || running || task.notManuallyRunnable === true}
                title={task.notManuallyRunnable
                    ? m.admin_task_run_not_manually_runnable_title()
                    : running || busy
                      ? m.admin_task_full_run_disabled()
                      : m.admin_task_full_run_title()}>
                <Icon src={Play} class="h-3.5 w-3.5" />
                {fullRunTriggering ? m.admin_task_run_queuing() : m.admin_task_full_run()}
            </button>
        {/if}
        {#if showSegments}
            <button
                type="button"
                class="flex items-center gap-1.5 rounded border border-primary-600/50 px-2.5 py-1.5 text-xs font-medium text-primary-300 transition-colors hover:border-primary-500 hover:bg-primary-950/30 hover:text-primary-200 disabled:cursor-not-allowed disabled:opacity-50"
                onclick={openSegmentRefresh}
                disabled={busy || running || task.notManuallyRunnable === true}
                title={m.admin_task_segment_refresh_title()}>
                <Icon src={Play} class="h-3.5 w-3.5" />
                {segmentTriggering ? m.admin_task_run_queuing() : m.admin_task_segment_refresh()}
            </button>
        {/if}
    </div>
{/if}
