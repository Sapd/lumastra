<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, XMark, EyeSlash, Eye } from 'svelte-hero-icons';
    import type { AdminChannelCategory } from '$lib/schemas/livetv.js';
    import CategoryPicker, { type PickerCategory } from './CategoryPicker.svelte';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        selectedCount: number;
        categories: AdminChannelCategory[];
        /** Hidden channels on screen? Counts then include them, as the list does. */
        showHidden?: boolean;
        onBulkHide: () => void;
        onBulkShow: () => void;
        onBulkMoveToCategory: (categoryId: string, position: 'top' | 'bottom') => void;
        onBulkSetQuality: (qualityTier: string) => void;
        onDeselectAll: () => void;
    }

    let {
        selectedCount,
        categories,
        showHidden = true,
        onBulkHide,
        onBulkShow,
        onBulkMoveToCategory,
        onBulkSetQuality,
        onDeselectAll,
    }: Props = $props();

    let showCategoryDropdown = $state(false);
    let showQualityDropdown = $state(false);
    let barRef: HTMLDivElement | undefined = $state();
    let categoryTrigger = $state<HTMLButtonElement | null>(null);
    let qualityTrigger = $state<HTMLButtonElement | null>(null);

    function handleDocumentClick(e: MouseEvent): void {
        if (barRef && !barRef.contains(e.target as Node)) {
            showCategoryDropdown = false;
            showQualityDropdown = false;
        }
    }

    $effect(() => {
        if (showCategoryDropdown || showQualityDropdown) {
            document.addEventListener('click', handleDocumentClick);
            return () => document.removeEventListener('click', handleDocumentClick);
        }
    });

    const qualityOptions = [
        { value: 'uhd', label: 'UHD' },
        { value: 'fhd', label: 'FHD' },
        { value: 'hd', label: 'HD' },
        { value: 'sd', label: 'SD' },
    ];

    let pickerCategories = $derived<PickerCategory[]>(
        categories.map((c) => ({
            id: c.id,
            name: c.id === 'uncategorized' ? m.admin_livetv_uncategorized() : c.name,
            count: showHidden ? c.channels.length : c.channels.filter((ch) => ch.isVisible).length,
        })),
    );

    function handleMoveToCategory(categoryId: string, position: 'top' | 'bottom'): void {
        showCategoryDropdown = false;
        onBulkMoveToCategory(categoryId, position);
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && (showCategoryDropdown || showQualityDropdown)) {
            e.preventDefault();
            const trigger = showCategoryDropdown ? categoryTrigger : qualityTrigger;
            showCategoryDropdown = false;
            showQualityDropdown = false;
            // The open list held focus; give it back to the button that opened it.
            trigger?.focus();
        }
    }

    function handleSetQuality(tier: string): void {
        showQualityDropdown = false;
        onBulkSetQuality(tier);
    }

    function toggleCategoryDropdown(): void {
        showCategoryDropdown = !showCategoryDropdown;
        showQualityDropdown = false;
    }

    function toggleQualityDropdown(): void {
        showQualityDropdown = !showQualityDropdown;
        showCategoryDropdown = false;
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    bind:this={barRef}
    onkeydown={handleKeydown}
    class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-surface-900 border border-surface-700 rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3 animate-slide-up">
    <!-- Selected count -->
    <span class="text-sm text-surface-300 whitespace-nowrap">
        {m.admin_livetv_selected_count({ count: selectedCount })}
    </span>

    <div class="w-px h-6 bg-surface-700"></div>

    <!-- Hide button -->
    <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-white transition-colors"
        onclick={onBulkHide}>
        <Icon src={EyeSlash} class="w-4 h-4" />
        {m.admin_livetv_bulk_hide()}
    </button>

    <!-- Show button -->
    <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-white transition-colors"
        onclick={onBulkShow}>
        <Icon src={Eye} class="w-4 h-4" />
        {m.admin_livetv_bulk_show()}
    </button>

    <!-- Move to category dropdown -->
    <div class="relative">
        <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-white transition-colors"
            bind:this={categoryTrigger}
            onclick={toggleCategoryDropdown}>
            {m.admin_livetv_bulk_move_to_category()}
            <svg
                class="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
        </button>
        {#if showCategoryDropdown}
            <div
                class="absolute bottom-full left-0 mb-2 bg-surface-800 border border-surface-700 rounded-lg shadow-xl w-64">
                <CategoryPicker categories={pickerCategories} onPick={handleMoveToCategory} />
            </div>
        {/if}
    </div>

    <!-- Set quality dropdown -->
    <div class="relative">
        <button
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-surface-800 hover:bg-surface-700 text-surface-300 hover:text-white transition-colors"
            bind:this={qualityTrigger}
            onclick={toggleQualityDropdown}>
            {m.admin_livetv_bulk_set_quality()}
            <svg
                class="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
        </button>
        {#if showQualityDropdown}
            <div
                class="absolute bottom-full left-0 mb-2 bg-surface-800 border border-surface-700 rounded-lg shadow-xl overflow-hidden min-w-[120px]">
                {#each qualityOptions as opt (opt.value)}
                    <button
                        type="button"
                        class="w-full text-left px-4 py-2 text-sm text-surface-300 hover:bg-surface-700 hover:text-white"
                        onclick={() => handleSetQuality(opt.value)}>
                        {opt.label}
                    </button>
                {/each}
            </div>
        {/if}
    </div>

    <div class="w-px h-6 bg-surface-700"></div>

    <!-- Deselect all -->
    <button
        type="button"
        class="p-1.5 rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white transition-colors"
        onclick={onDeselectAll}
        aria-label={m.admin_livetv_deselect_all()}
        title={m.admin_livetv_deselect_all()}>
        <Icon src={XMark} class="w-5 h-5" />
    </button>
</div>

<style>
    @keyframes slide-up {
        from {
            transform: translate(-50%, 100%);
            opacity: 0;
        }
        to {
            transform: translate(-50%, 0);
            opacity: 1;
        }
    }

    .animate-slide-up {
        animation: slide-up 0.2s ease-out;
    }
</style>
