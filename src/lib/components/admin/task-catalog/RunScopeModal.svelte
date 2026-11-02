<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Picks how much work a manually started run should take on.

  The three modes are easy to confuse and one of them destroys data, so they are
  named by what they DO rather than by their internal mode strings, and the
  scheduled mode is explained here too — it is the one an operator never picks
  but always sees the results of.
-->

<script module lang="ts">
    export type RunScopeChoice = 'manual' | 'force';
</script>

<script lang="ts">
    import { modals } from '$lib/stores/modal.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Force is only offered where an `onWipe` hook actually exists. */
        allowForce: boolean;
        onConfirm: (scope: RunScopeChoice) => void | Promise<void>;
        onCancel?: (() => void) | undefined;
    }

    let { allowForce, onConfirm, onCancel = undefined }: Props = $props();

    let scope = $state<RunScopeChoice>('manual');
    let acknowledged = $state(false);
    let loading = $state(false);

    // Re-arming on every switch away from force is deliberate: an acknowledgement
    // ticked, then abandoned for another mode, must not still be standing if the
    // operator comes back to force.
    $effect(() => {
        if (scope !== 'force') acknowledged = false;
    });

    let blocked = $derived(scope === 'force' && !acknowledged);

    async function handleConfirm(): Promise<void> {
        if (loading || blocked) return;
        loading = true;
        try {
            await onConfirm(scope);
            await modals.close();
        } catch (error) {
            console.error('Run failed to start:', error);
            loading = false;
        }
    }

    async function handleCancel(): Promise<void> {
        if (onCancel) onCancel();
        await modals.close();
    }
</script>

<div class="run-scope-modal card w-modal p-6 shadow-xl" aria-describedby="run-scope-desc">
    <header class="modal-header mb-4">
        <h3 class="h3">{m.admin_task_run_scope_modal_title()}</h3>
    </header>

    <article class="modal-body mb-6 flex flex-col gap-4">
        <p id="run-scope-desc" class="text-sm text-surface-300">
            {m.admin_task_run_scope_modal_body()}
        </p>

        <div class="flex flex-col gap-2" role="radiogroup">
            <label
                class="flex cursor-pointer items-start gap-3 rounded border p-3 transition-colors {scope ===
                'manual'
                    ? 'border-primary-600/60 bg-primary-950/20'
                    : 'border-surface-600/50 hover:border-surface-500'}">
                <input
                    type="radio"
                    name="run-scope"
                    class="mt-0.5"
                    value="manual"
                    checked={scope === 'manual'}
                    onchange={() => (scope = 'manual')}
                    disabled={loading} />
                <span class="flex flex-col gap-0.5">
                    <span class="text-sm font-medium text-surface-100"
                        >{m.admin_task_run_scope_manual()}</span>
                    <span class="text-xs text-surface-400"
                        >{m.admin_task_run_scope_manual_hint()}</span>
                </span>
            </label>

            {#if allowForce}
                <label
                    class="flex cursor-pointer items-start gap-3 rounded border p-3 transition-colors {scope ===
                    'force'
                        ? 'border-red-600/60 bg-red-950/20'
                        : 'border-surface-600/50 hover:border-surface-500'}">
                    <input
                        type="radio"
                        name="run-scope"
                        class="mt-0.5"
                        value="force"
                        checked={scope === 'force'}
                        onchange={() => (scope = 'force')}
                        disabled={loading} />
                    <span class="flex flex-col gap-0.5">
                        <span class="text-sm font-medium text-red-300"
                            >{m.admin_task_run_scope_force()}</span>
                        <span class="text-xs text-surface-400"
                            >{m.admin_task_run_scope_force_hint()}</span>
                    </span>
                </label>
            {/if}
        </div>

        {#if scope === 'force'}
            <div class="rounded border border-red-700/50 bg-red-950/30 p-3">
                <p class="mb-3 text-xs text-red-200">{m.admin_task_run_scope_force_warning()}</p>
                <label class="flex cursor-pointer items-start gap-2">
                    <input
                        type="checkbox"
                        class="mt-0.5"
                        bind:checked={acknowledged}
                        disabled={loading} />
                    <span class="text-xs font-medium text-red-200"
                        >{m.admin_task_run_scope_force_ack()}</span>
                </label>
            </div>
        {/if}

        <p class="text-xs text-surface-500">{m.admin_task_run_scope_catchup_note()}</p>
    </article>

    <footer class="modal-footer flex justify-end gap-2">
        <button
            type="button"
            class="btn variant-ghost-surface"
            onclick={handleCancel}
            disabled={loading}>
            {m.dialog_cancel_button()}
        </button>
        <button
            type="button"
            class="btn {scope === 'force' ? 'variant-filled-error' : 'variant-filled-primary'}"
            onclick={handleConfirm}
            disabled={loading || blocked}>
            {loading ? m.admin_task_run_queuing() : m.admin_task_run_scope_confirm()}
        </button>
    </footer>
</div>

<style>
    .run-scope-modal {
        max-width: 560px;
    }
</style>
