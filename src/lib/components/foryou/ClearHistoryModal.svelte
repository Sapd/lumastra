<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Clear History Modal Component
     * Modal for clearing continue watching progress
     */
    import { Icon, Trash, XMark, ArrowPath } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    import { Z } from '$lib/utils/z-index';
    import { stopPropagation } from '$lib/utils/event-helpers';

    interface Props {
        show?: boolean;
        clearType?: 'movies' | 'episodes' | 'both';
        isClearing?: boolean;
        onclose?: () => void;
        onconfirm?: (detail: { clearType: 'movies' | 'episodes' | 'both' }) => void;
    }

    let {
        show = false,
        clearType = $bindable('both'),
        isClearing = false,
        onclose,
        onconfirm,
    }: Props = $props();

    function handleClose() {
        onclose?.();
    }

    function handleConfirm() {
        onconfirm?.({ clearType });
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            e.preventDefault();
            handleClose();
        }
    }
</script>

{#if show}
    <div
        class="modal-overlay modal-overlay-70"
        style="z-index: {Z.MODAL}"
        onclick={handleClose}
        onkeydown={handleKeydown}
        role="button"
        tabindex="0"
        aria-label="Close dialog">
        <div
            class="bg-surface-800 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl border border-surface-600"
            onclick={stopPropagation()}
            onkeydown={handleKeydown}
            role="dialog"
            aria-modal="true"
            aria-label="Reset watch progress"
            tabindex="-1">
            <!-- Header -->
            <div class="between mb-4">
                <h3 class="text-lg font-semibold text-white flex items-center gap-2">
                    <Icon src={Trash} class="w-5 h-5 text-red-400" />
                    {m.foryou_reset_progress()}
                </h3>
                <button
                    class="p-1 rounded-full hover:bg-surface-600 transition-colors"
                    onclick={handleClose}>
                    <Icon src={XMark} class="w-5 h-5 text-gray-400" />
                </button>
            </div>

            <!-- Description -->
            <p class="text-gray-300 text-sm mb-4">
                {m.foryou_reset_progress_desc()}
            </p>

            <!-- Clear Type Options -->
            <div class="space-y-2 mb-6">
                <label
                    for="clearType-movies"
                    class="flex items-center gap-3 p-3 rounded-lg bg-surface-700 hover:bg-surface-600 cursor-pointer transition-colors">
                    <input
                        type="radio"
                        name="clearType"
                        value="movies"
                        bind:group={clearType}
                        id="clearType-movies"
                        class="w-4 h-4 text-red-500" />
                    <span class="text-white">{m.foryou_movies_only()}</span>
                </label>
                <label
                    for="clearType-episodes"
                    class="flex items-center gap-3 p-3 rounded-lg bg-surface-700 hover:bg-surface-600 cursor-pointer transition-colors">
                    <input
                        type="radio"
                        name="clearType"
                        value="episodes"
                        bind:group={clearType}
                        id="clearType-episodes"
                        class="w-4 h-4 text-red-500" />
                    <span class="text-white">{m.foryou_episodes_only()}</span>
                </label>
                <label
                    for="clearType-both"
                    class="flex items-center gap-3 p-3 rounded-lg bg-surface-700 hover:bg-surface-600 cursor-pointer transition-colors">
                    <input
                        type="radio"
                        name="clearType"
                        value="both"
                        bind:group={clearType}
                        id="clearType-both"
                        class="w-4 h-4 text-red-500" />
                    <span class="text-white">{m.foryou_both()}</span>
                </label>
            </div>

            <!-- Actions -->
            <div class="flex gap-3">
                <button
                    class="flex-1 px-4 py-2 rounded-lg bg-surface-600 hover:bg-surface-500 text-white font-medium transition-colors"
                    onclick={handleClose}>
                    {m.cancel()}
                </button>
                <button
                    class="btn btn-red flex-1 font-medium center gap-2"
                    onclick={handleConfirm}
                    disabled={isClearing}>
                    {#if isClearing}
                        <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                        {m.foryou_deleting()}
                    {:else}
                        <Icon src={Trash} class="w-4 h-4" />
                        {m.foryou_reset_btn()}
                    {/if}
                </button>
            </div>
        </div>
    </div>
{/if}
