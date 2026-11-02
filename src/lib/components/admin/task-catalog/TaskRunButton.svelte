<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The ▶ Run button of a task-list row (spec 2026-09-27 §1.1 — the classic
  scheduled-task list's play button). Same request and safeguards as the
  catalog card it replaces: a unique Idempotency-Key against double taps, the
  confirm dialog for `confirmBeforeRun` tasks, the stated cost for
  `destructive` ones, and disabled for `notManuallyRunnable`. The extra run
  modes (full run / force rebuild, segment refresh) are TaskRunOptions on the
  task page's Overview tab.
-->

<script lang="ts">
    import { Icon, Play } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { modals } from '$lib/stores/modal.store';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { RunTriggerResponseSchema } from '$lib/schemas/task-definition.schema.js';
    import type { TaskDefinitionSummary } from '$lib/schemas/task-definition.schema.js';
    import { taskDescription } from '$lib/utils/admin/task-descriptions.js';

    interface Props {
        task: TaskDefinitionSummary;
        /** Any in-flight row exists, including rows outside the bus's 200-run seed. */
        running?: boolean;
    }

    let { task, running = false }: Props = $props();

    let triggering = $state(false);
    let destructive = $derived(task.destructive === true);

    function idempotencyKey(): string {
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                return crypto.randomUUID();
            }
        } catch {
            // Locked-down browser policy — fall through.
        }
        return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    async function fire(): Promise<void> {
        if (triggering || running) return;
        triggering = true;
        try {
            const { data, error } = await apiPost(
                `/api/tasks/${encodeURIComponent(task.id)}/run`,
                RunTriggerResponseSchema,
                {},
                { headers: { 'Idempotency-Key': idempotencyKey() } },
            );
            if (error || !data) {
                toasts.error(m.admin_task_run_error({ error: error ?? m.toast_unknown_error() }));
            } else if (data.deduped) {
                toasts.info(m.admin_task_run_already_running());
            } else {
                toasts.success(m.admin_task_run_started());
            }
        } finally {
            triggering = false;
        }
    }

    function onClick(e: MouseEvent): void {
        // The row itself is a link to the task; the button must not follow it.
        e.preventDefault();
        e.stopPropagation();
        if (triggering || running) return;
        if (task.confirmBeforeRun) {
            const description = taskDescription(task.id, task.description);
            const body = destructive
                ? `${description ?? m.admin_task_run_confirm_body_fallback()} ${m.admin_task_run_destructive_cost()}`
                : (description ?? m.admin_task_run_confirm_body_fallback());
            modals.open(ConfirmModal, {
                title: m.admin_task_run_confirm_title({ name: task.name }),
                body,
                confirmText: m.admin_task_run_confirm_button(),
                confirmVariant: destructive ? 'danger' : 'primary',
                onConfirm: () => fire(),
            });
            return;
        }
        void fire();
    }
</script>

<button
    type="button"
    class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 {destructive
        ? 'border-red-700/50 text-red-300 hover:bg-red-950/30'
        : 'border-surface-600/60 text-surface-300 hover:border-surface-500 hover:text-white'}"
    onclick={onClick}
    disabled={triggering || running || task.notManuallyRunnable}
    aria-label={m.admin_task_run_row_label({ name: task.name })}
    title={task.notManuallyRunnable
        ? m.admin_task_run_not_manually_runnable_title()
        : running
          ? m.admin_task_run_already_running()
          : destructive
            ? m.admin_task_run_destructive_title()
            : m.admin_task_run_title()}>
    <Icon src={Play} class="h-3.5 w-3.5" />
    <span class="hidden sm:inline"
        >{triggering ? m.admin_task_run_queuing() : m.admin_task_run()}</span>
</button>
