<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  BrowseCard — reusable card used by all four browse layout sub-components.
  Preserves all Wave 1 affordances: poster/fallback, completion badge, admin
  quick-edit, drawer button, bulk-select checkbox.
-->

<script lang="ts">
    import { getCatalogPosterUrl } from '$lib/utils/image-utils';
    import { renderSubtitleTemplate } from '$lib/shared/library-type-templates';
    import type { LibraryTypeTemplate } from '$lib/shared/library-type-templates';
    import type { SvelteSet } from 'svelte/reactivity';
    import type { BrowseItem } from '$lib/shared/browse-layout-utils';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        item: BrowseItem;
        libraryType: string;
        template: LibraryTypeTemplate;
        groupKey: string;
        progressMeaning: 'watch_progress' | 'completion';
        isAdmin: boolean;
        bulkModeActive: boolean;
        selectedIds: SvelteSet<string>;
        failedPosters: SvelteSet<string>;
        editingItemId: string | null;
        editCategoryValue: string;
        savingCategory: boolean;
        onNavigate: (item: BrowseItem) => void;
        onEditStart: (item: BrowseItem) => void;
        onEditSave: (itemId: string) => void;
        onEditCancel: () => void;
        onPosterError: (itemId: string) => void;
        onToggleSelect: (id: string) => void;
        onOpenDrawer: (item: BrowseItem) => void;
    }

    let {
        item,
        libraryType,
        template,
        groupKey,
        progressMeaning,
        isAdmin,
        bulkModeActive,
        selectedIds,
        failedPosters,
        editingItemId,
        editCategoryValue,
        savingCategory,
        onNavigate,
        onEditStart,
        onEditSave,
        onEditCancel,
        onPosterError,
        onToggleSelect,
        onOpenDrawer,
    }: Props = $props();

    function handleClick(): void {
        if (bulkModeActive) {
            onToggleSelect(item.id);
            return;
        }
        if (editingItemId !== item.id) {
            onNavigate(item);
        }
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') handleClick();
    }
</script>

<div
    class="group cursor-pointer"
    role="link"
    tabindex="0"
    onclick={handleClick}
    onkeydown={handleKeydown}>
    <div
        class="aspect-video rounded-lg overflow-hidden bg-surface-700 mb-2 relative {bulkModeActive &&
        selectedIds.has(item.id)
            ? 'ring-2 ring-primary-500'
            : ''}">
        {#if !failedPosters.has(item.id)}
            <img
                src={getCatalogPosterUrl(item.id, { size: 'card' })}
                alt={item.title}
                class="w-full h-full object-cover group-hover:scale-105 transition-transform"
                onerror={() => onPosterError(item.id)} />
        {:else}
            <div class="w-full h-full flex items-center justify-center text-surface-500">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
            </div>
        {/if}

        <!-- Completion checkmark badge (completion libraries only) -->
        {#if progressMeaning === 'completion' && item.episode_count > 0 && item.completed_count === item.episode_count}
            <div
                class="absolute top-1 left-1 w-6 h-6 rounded-full bg-green-500 flex items-center justify-center shadow"
                title="Completed">
                <svg
                    class="w-4 h-4 text-white"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2.5"
                        d="M5 13l4 4L19 7" />
                </svg>
            </div>
        {/if}

        <!-- Bulk-select checkbox overlay (admin-only) -->
        {#if isAdmin && bulkModeActive}
            <div
                class="absolute top-1 right-1"
                role="presentation"
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => e.stopPropagation()}>
                <input
                    type="checkbox"
                    class="w-4 h-4 rounded accent-primary-500 cursor-pointer"
                    checked={selectedIds.has(item.id)}
                    onchange={() => onToggleSelect(item.id)} />
            </div>
        {:else if isAdmin}
            <!-- Admin: full-edit drawer button -->
            <button
                class="absolute bottom-1 right-1 text-xs px-1.5 py-0.5 rounded bg-primary-700/90 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                onclick={(e) => {
                    e.stopPropagation();
                    onOpenDrawer(item);
                }}>
                Edit
            </button>
            <!-- Admin: quick-edit groupKey button -->
            <button
                class="absolute bottom-1 left-1 text-xs px-1.5 py-0.5 rounded bg-surface-800/80 text-surface-300 opacity-0 group-hover:opacity-100 transition-opacity"
                onclick={(e) => {
                    e.stopPropagation();
                    onEditStart(item);
                }}>
                Quick
            </button>
        {/if}
    </div>

    <p class="text-sm text-white truncate">{item.title}</p>
    <p class="text-xs text-surface-400 truncate">
        {renderSubtitleTemplate(template.cardConfig.subtitleTemplate, item.custom_metadata)}
    </p>

    {#if item.episode_count > 0}
        <p class="text-xs text-surface-500">
            {item.episode_count}
            {item.episode_count === 1
                ? (template.cardConfig.clipLabel.slice(0, -1).toLowerCase() ?? 'clip')
                : (template.cardConfig.clipLabel.toLowerCase() ?? 'clips')}
        </p>
    {/if}

    <!-- Completion pill: show for completion-type libraries with >1 episode -->
    {#if progressMeaning === 'completion' && item.episode_count > 1}
        <p
            class="text-xs mt-0.5 {item.completed_count === item.episode_count
                ? 'text-green-400'
                : item.completed_count > 0
                  ? 'text-primary-400'
                  : 'text-surface-500'}">
            {m.library_x_of_y_done({
                completed: item.completed_count,
                total: item.episode_count,
            })}
        </p>
    {/if}

    <!-- Inline category quick-editor -->
    {#if editingItemId === item.id}
        <div
            class="mt-1 flex gap-1"
            role="presentation"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}>
            <input
                type="text"
                class="px-2 py-1 bg-surface-800 border border-surface-600 rounded text-xs text-white flex-1"
                placeholder="Category..."
                bind:value={editCategoryValue}
                onkeydown={(e) => {
                    if (e.key === 'Enter') onEditSave(item.id);
                    if (e.key === 'Escape') onEditCancel();
                }} />
            <button
                class="px-2 py-1 bg-primary-600 text-white rounded text-xs"
                disabled={savingCategory}
                onclick={() => onEditSave(item.id)}>
                {savingCategory ? '...' : 'OK'}
            </button>
            <button
                class="px-2 py-1 bg-surface-700 text-surface-300 rounded text-xs"
                onclick={onEditCancel}>
                X
            </button>
        </div>
    {/if}
</div>
