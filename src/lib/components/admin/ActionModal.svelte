<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';

    interface Props {
        title: string;
        confirmText?: string;
        cancelText?: string;
        confirmColor?: 'green' | 'blue' | 'purple' | 'red';
        disabled?: boolean;
        children?: import('svelte').Snippet;
        /** Replaces the default Cancel/Confirm row entirely when provided. */
        footer?: import('svelte').Snippet;
        onclose?: () => void;
        onconfirm?: () => void;
        /**
         * Render in place as a section instead of an overlay — for dialogs
         * folded into a surrounding panel (the user drawer's Access tab). The
         * default Cancel/Confirm row is dropped (there is nothing to dismiss);
         * a custom `footer` still renders, since it carries real actions.
         */
        inline?: boolean;
    }

    let {
        title,
        confirmText = 'Start',
        cancelText = 'Cancel',
        confirmColor = 'blue',
        disabled = false,
        children,
        footer,
        onclose,
        onconfirm,
        inline = false,
    }: Props = $props();

    const colorClasses = {
        green: 'btn-green',
        blue: 'btn-blue',
        purple: 'btn-purple',
        red: 'btn-red',
    };

    let submitting = $state(false);

    async function handleConfirm(): Promise<void> {
        if (submitting) return;
        submitting = true;
        try {
            await onconfirm?.();
        } finally {
            submitting = false;
        }
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            // Do not close when focus is inside an input or textarea — the user
            // may be clearing text. Let the browser handle Escape natively there
            // and only close when focus is on a non-editable element.
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            onclose?.();
        }
    }
</script>

<!--
    Focus trap lives on the inner dialog so Tab/Shift+Tab cycles within
    the buttons rather than leaking to the page behind the overlay.
    The Cancel button carries [data-autofocus] so keyboard users land on
    the safe dismissal action for destructive confirmations.
    Escape is handled on the wrapper so it fires regardless of which
    descendant has focus (inner keydowns bubble through stopPropagation
    only for click, not keydown).

    When callers supply child content with their own [data-autofocus] (e.g.
    a typed-confirm input), the first in document order wins — this is the
    correct behaviour for typed-confirm flows where the input should autofocus.
-->
{#if inline}
    <section class="rounded-lg border border-surface-700/60 bg-surface-800/30 p-4">
        <h4 class="mb-3 text-sm font-medium text-white">{title}</h4>
        <div class="space-y-4">
            {@render children?.()}
        </div>
        {#if footer}
            <div class="mt-4">{@render footer()}</div>
        {/if}
    </section>
{:else}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <!--
    Z.MODAL + 2: these dialogs are opened FROM the admin user drawer, whose panel
    sits at Z.MODAL + 1 — at plain Z.MODAL the dialog rendered underneath it with
    its confirm button covered.
-->
    <div
        class="modal-overlay modal-overlay-blur"
        style="z-index: {Z.MODAL + 2}"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabindex="-1"
        onclick={() => (submitting ? undefined : onclose?.())}
        onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="card-bordered p-6 max-w-md w-full mx-4 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain"
            role="document"
            use:trapFocus
            onclick={stopPropagation()}>
            <h3 class="text-xl font-semibold mb-4 text-white">{title}</h3>

            <div class="space-y-4 mb-6">
                {@render children?.()}
            </div>

            {#if footer}
                {@render footer()}
            {:else}
                <div class="flex gap-3">
                    <button
                        type="button"
                        class="btn btn-gray flex-1"
                        data-autofocus
                        disabled={submitting}
                        onclick={() => onclose?.()}>
                        {cancelText}
                    </button>
                    <button
                        type="button"
                        class="btn {colorClasses[confirmColor]} flex-1 font-medium"
                        onclick={() => void handleConfirm()}
                        disabled={disabled || submitting}>
                        {confirmText}
                    </button>
                </div>
            {/if}
        </div>
    </div>
{/if}
