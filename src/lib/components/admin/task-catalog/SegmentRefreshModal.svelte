<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Scope picker for a library-wide intro/outro re-detection.

  This is a choice rather than a plain confirm because the run RETRACTS: a pass
  that can no longer justify a marker removes it. Narrowing the scope is how an
  operator says "re-decide outros, but do not touch the intros I am happy with".
-->

<script module lang="ts">
    export type SegmentScopeChoice = 'both' | 'intro' | 'outro';
</script>

<script lang="ts">
    import { modals } from '$lib/stores/modal.store';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        onConfirm: (scope: SegmentScopeChoice) => void | Promise<void>;
        onCancel?: (() => void) | undefined;
    }

    let { onConfirm, onCancel = undefined }: Props = $props();

    let scope = $state<SegmentScopeChoice>('both');
    let loading = $state(false);

    const OPTIONS: { value: SegmentScopeChoice; label: () => string; hint: () => string }[] = [
        {
            value: 'both',
            label: m.admin_task_segment_refresh_scope_both,
            hint: m.admin_task_segment_refresh_scope_both_hint,
        },
        {
            value: 'intro',
            label: m.admin_task_segment_refresh_scope_intro,
            hint: m.admin_task_segment_refresh_scope_intro_hint,
        },
        {
            value: 'outro',
            label: m.admin_task_segment_refresh_scope_outro,
            hint: m.admin_task_segment_refresh_scope_outro_hint,
        },
    ];

    async function handleConfirm(): Promise<void> {
        if (loading) return;
        loading = true;
        try {
            await onConfirm(scope);
            await modals.close();
        } catch (error) {
            console.error('Segment re-detection failed to start:', error);
            loading = false;
        }
    }

    async function handleCancel(): Promise<void> {
        if (onCancel) onCancel();
        await modals.close();
    }
</script>

<div
    class="segment-refresh-modal card w-modal p-6 shadow-xl"
    aria-describedby="segment-refresh-desc">
    <header class="modal-header mb-4">
        <h3 class="h3">{m.admin_task_segment_refresh_modal_title()}</h3>
    </header>

    <article class="modal-body mb-6 flex flex-col gap-4">
        <p id="segment-refresh-desc" class="text-sm text-surface-300">
            {m.admin_task_segment_refresh_modal_body()}
        </p>

        <div class="flex flex-col gap-2" role="radiogroup">
            {#each OPTIONS as option (option.value)}
                <label
                    class="flex cursor-pointer items-start gap-3 rounded border p-3 transition-colors {scope ===
                    option.value
                        ? 'border-primary-600/60 bg-primary-950/20'
                        : 'border-surface-600/50 hover:border-surface-500'}">
                    <input
                        type="radio"
                        name="segment-scope"
                        class="mt-0.5"
                        value={option.value}
                        checked={scope === option.value}
                        onchange={() => (scope = option.value)}
                        disabled={loading} />
                    <span class="flex flex-col gap-0.5">
                        <span class="text-sm font-medium text-surface-100">{option.label()}</span>
                        <span class="text-xs text-surface-400">{option.hint()}</span>
                    </span>
                </label>
            {/each}
        </div>
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
            class="btn variant-filled-primary"
            onclick={handleConfirm}
            disabled={loading}>
            {loading ? m.admin_task_run_queuing() : m.admin_task_segment_refresh_confirm()}
        </button>
    </footer>
</div>

<style>
    .segment-refresh-modal {
        max-width: 540px;
    }
</style>
