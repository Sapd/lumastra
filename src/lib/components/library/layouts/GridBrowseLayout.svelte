<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  GridBrowseLayout — flat wide grid for personal libraries.
  All items from all groups are concatenated (no group headers).
  6 columns on xl, 5 on lg, 4 on md, 3 on sm, 2 on default.
-->

<script lang="ts">
    import type { BrowseLayoutProps } from './layout-props';
    import BrowseCard from './BrowseCard.svelte';

    let {
        libraryType,
        template,
        groupedItems,
        onNavigate,
        onEditStart,
        editingItemId,
        editCategoryValue,
        onEditSave,
        onEditCancel,
        savingCategory,
        failedPosters,
        onPosterError,
        progressMeaning,
        isAdmin,
        bulkModeActive,
        selectedIds,
        onToggleSelect,
        onOpenDrawer,
        groupKey,
    }: BrowseLayoutProps = $props();

    // Flatten all groups into a single ordered list.
    const allItems = $derived([...groupedItems.values()].flat());
</script>

<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
    {#each allItems as item (item.id)}
        <BrowseCard
            {item}
            {libraryType}
            {template}
            {groupKey}
            {progressMeaning}
            {isAdmin}
            {bulkModeActive}
            {selectedIds}
            {failedPosters}
            {editingItemId}
            {editCategoryValue}
            {savingCategory}
            {onNavigate}
            {onEditStart}
            {onEditSave}
            {onEditCancel}
            {onPosterError}
            {onToggleSelect}
            {onOpenDrawer} />
    {/each}
</div>
