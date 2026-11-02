<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { Icon, XMark, Sparkles } from 'svelte-hero-icons';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        open: boolean;
        title: string;
        /** Free-form reason text — typically an AI-generated explanation
         * pulled from UniversalMediaItem.reason. Empty/null falls back
         * to a generic "no explanation available" line. */
        reason?: string | null;
        onClose: () => void;
    }

    let { open, title, reason, onClose }: Props = $props();

    function handleBackdrop(e: MouseEvent): void {
        if (e.target === e.currentTarget) onClose();
    }

    function handleKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }
</script>

{#if open}
    <div
        class="fixed inset-0 flex items-center justify-center bg-black/50 px-4"
        style="z-index: {Z.FLOATING_MODAL}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="why-here-title"
        tabindex="-1"
        onclick={handleBackdrop}
        onkeydown={handleKey}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
            use:trapFocus
            role="document"
            class="w-full max-w-md rounded-lg border border-surface-700 bg-surface-900 shadow-2xl"
            onclick={stopPropagation()}
            onkeydown={handleKey}>
            <header
                class="flex items-start justify-between gap-3 border-b border-surface-700 px-4 py-3">
                <div class="flex min-w-0 items-start gap-2">
                    <Icon src={Sparkles} class="mt-0.5 h-5 w-5 shrink-0 text-primary-400" />
                    <div class="min-w-0">
                        <h2
                            id="why-here-title"
                            class="truncate text-base font-semibold text-surface-100">
                            {m.card_why_here_title()}
                        </h2>
                        <p class="truncate text-xs text-surface-400">{title}</p>
                    </div>
                </div>
                <button
                    type="button"
                    class="text-surface-400 hover:text-surface-100"
                    aria-label={m.close()}
                    onclick={onClose}>
                    <Icon src={XMark} class="h-5 w-5" />
                </button>
            </header>

            <div class="px-4 py-4">
                {#if reason && reason.trim().length > 0}
                    <p class="text-sm leading-relaxed text-surface-200">
                        {reason}
                    </p>
                {:else}
                    <p class="text-sm text-surface-400">
                        {m.card_why_here_no_reason()}
                    </p>
                {/if}
            </div>
        </div>
    </div>
{/if}
