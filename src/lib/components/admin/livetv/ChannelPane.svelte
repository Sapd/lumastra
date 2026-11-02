<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import type { AdminChannelCategory } from '$lib/schemas/livetv.js';
    import { tick } from 'svelte';
    import CategoryGroup from './CategoryGroup.svelte';
    import CategoryRail from './CategoryRail.svelte';
    import type { PickerCategory } from './CategoryPicker.svelte';
    import { channelMatches, normalizeFilter, type PaneFilter } from './channel-reconcile.js';
    import { isFeedOffline } from './feed-health.js';
    import {
        getChannelStore,
        CHANNEL_DND_TYPE,
        CATEGORY_DND_TYPE,
    } from './channel-store.svelte.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** Secondary panes can't reorder categories (avoids two competing category orders). */
        isSecondary?: boolean;
        /** Category rail beside the list (wide single view); otherwise a Jump to… select. */
        showRail?: boolean;
    }

    let { isSecondary = false, showRail = false }: Props = $props();

    const store = getChannelStore();
    const flipDurationMs = 200;

    // -------------------------------------------------------------------------
    // Pane-local SEARCH state. Expand/collapse lives in the SHARED store so opening or
    // closing a category syncs across both panes.
    // -------------------------------------------------------------------------
    let filterText = $state('');
    let isFiltering = $derived(!!filterText.trim());

    // Hidden channels (a lineup's other countries, lower-quality feeds) are left
    // out unless the admin asks for them (store.showHidden, shared by both panes);
    // moving a channel carries the hidden feeds anchored after it (channel-reconcile.ts).
    let showHidden = $derived(store.showHidden);
    let hiddenCount = $derived(
        store.categories.reduce(
            (n, cat) => n + cat.channels.filter((ch) => !ch.isVisible).length,
            0,
        ),
    );
    // "Offline only": feeds that failed 3+ times in a row (pane-local, like the search).
    let offlineOnly = $state(false);
    let offlineCount = $derived(
        store.categories.reduce(
            (n, cat) => n + cat.channels.filter((ch) => isFeedOffline(ch.health)).length,
            0,
        ),
    );
    let paneFilter = $derived<PaneFilter>({
        query: filterText,
        hideHidden: !showHidden,
        keep: store.keepShown,
        offlineOnly,
    });
    let channelTotals = $derived(new Map(store.categories.map((c) => [c.id, c.channels.length])));

    let allCollapsed = $derived(Object.values(store.expandedMap).every((v) => !v));
    // Category reorder needs all categories collapsed (you drag the collapsed cards) and is
    // disabled in a secondary pane. A search filter or selection mode also blocks it.
    let isCategoryDragDisabled = $derived(
        isFiltering || store.isSelectionMode || !allCollapsed || isSecondary,
    );
    // Channel reorder happens inside an expanded category, so it must NOT require all
    // categories collapsed. A search filter still allows drag (finalize reconciles the
    // filtered subset back into the full list). In selection mode channel drag stays OFF
    // while building a selection (≤1 selected) and turns ON once a group exists (>1) so a
    // selected row can be grabbed to drag the whole group; dragging a single selected row
    // then moves the group, an unselected row moves just itself.
    let isChannelDragDisabled = $derived(store.isSelectionMode && store.selectedIds.size <= 1);
    let groupDragCount = $derived(store.groupDragCount);

    // Show the "why can't I reorder" hint only for the category-reorder case.
    let showCategoryHint = $derived(
        !isSecondary && (isFiltering || store.isSelectionMode || !allCollapsed),
    );

    let filteredCategories = $derived.by(() => {
        const filter = normalizeFilter(paneFilter);
        const cats = store.categories.map((cat) => ({
            ...cat,
            channels: cat.channels.filter((ch) => channelMatches(ch, filter)),
        }));
        // A search shows only categories with matches; hiding hidden channels
        // alone keeps every category (an empty one can still be filled or moved).
        return filter.query || filter.offlineOnly
            ? cats.filter((cat) => cat.channels.length > 0)
            : cats;
    });

    // Categories rendered in this pane: the filtered view when searching or
    // leaving hidden channels out, else the full list.
    let visibleCategories = $derived(
        filterText.trim() || offlineOnly || (!showHidden && hiddenCount > 0)
            ? filteredCategories
            : store.categories,
    );

    // =========================================================================
    // Layout: mount ONE of the table (md+) or the card list, not both with one
    // hidden by CSS — each copy rendered every expanded row.
    // =========================================================================
    const DESKTOP_QUERY = '(min-width: 768px)';
    // null until known on the client: neither layout renders on the server, so a
    // phone never hydrates the table markup.
    let isDesktop = $state<boolean | null>(null);
    $effect(() => {
        const mq = globalThis.matchMedia?.(DESKTOP_QUERY);
        if (!mq) {
            isDesktop = true;
            return;
        }
        isDesktop = mq.matches;
        const handler = (e: MediaQueryListEvent): void => {
            isDesktop = e.matches;
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    });

    // =========================================================================
    // Category rail / Jump to…
    // =========================================================================
    let paneEl = $state<HTMLDivElement | null>(null);
    let scrollEl = $state<HTMLDivElement | null>(null);
    // The sticky column header's height: an expanded category's header sticks below it.
    let columnHeaderHeight = $state(44);
    let activeCategoryId = $state<string | null>(null);

    let railCategories = $derived<PickerCategory[]>(
        visibleCategories.map((cat) => ({
            id: cat.id,
            name: cat.id === 'uncategorized' ? m.admin_livetv_uncategorized() : cat.name,
            count: cat.channels.length,
        })),
    );

    // The current category is the first one crossing the band just below the sticky
    // headers (same IntersectionObserver approach as the viewer's ChannelGrid TOC).
    // Keyed on the id list only: a rename or visibility toggle must not rebuild it.
    let categoryIdsKey = $derived(visibleCategories.map((c) => c.id).join('\n'));
    $effect(() => {
        const root = scrollEl;
        const ids = categoryIdsKey.split('\n');
        if (!showRail || !root || typeof IntersectionObserver === 'undefined') return;
        const intersecting = new Set<string>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- observer bookkeeping, not rendered
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const id = (entry.target as HTMLElement).dataset.categoryId;
                    if (!id) continue;
                    if (entry.isIntersecting) intersecting.add(id);
                    else intersecting.delete(id);
                }
                const first = ids.find((id) => intersecting.has(id));
                if (first) activeCategoryId = first;
                else if (activeCategoryId && !ids.includes(activeCategoryId))
                    activeCategoryId = null;
            },
            { root, rootMargin: `-${columnHeaderHeight}px 0px -70% 0px` },
        );
        for (const el of root.querySelectorAll<HTMLElement>('[data-category-id]')) {
            observer.observe(el);
        }
        return () => observer.disconnect();
    });

    // One scroll surface: the settings header stack above the list is ~700px tall,
    // so the list cannot fit below it. The list is as tall as the window, and a
    // downward scroll over it first moves the page until the list reaches the top,
    // then scrolls the list (otherwise its bottom stays below the fold while the
    // wheel scrolls only the list).
    const LIST_MIN_HEIGHT = 480;
    let listHeight = $state<number | null>(null);

    function pageScroller(el: HTMLElement): HTMLElement {
        for (let p = el.parentElement; p; p = p.parentElement) {
            const { overflowY } = getComputedStyle(p);
            if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight)
                return p;
        }
        return document.scrollingElement as HTMLElement;
    }

    /** How far the list box sits below the top of the page's visible area. */
    function listOffset(scroller: HTMLElement): number {
        const viewTop =
            scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
        return (scrollEl?.getBoundingClientRect().top ?? 0) - viewTop;
    }

    function measureListHeight(): void {
        if (!scrollEl) return;
        const scroller = pageScroller(scrollEl);
        const viewHeight =
            scroller === document.scrollingElement ? window.innerHeight : scroller.clientHeight;
        listHeight = Math.max(LIST_MIN_HEIGHT, Math.floor(viewHeight - 16));
    }

    $effect(() => {
        const el = scrollEl;
        if (!el) return;
        measureListHeight();
        const onWheel = (e: WheelEvent): void => {
            if (e.deltaY <= 0) return;
            const scroller = pageScroller(el);
            const offset = listOffset(scroller);
            if (offset <= 8) return;
            e.preventDefault();
            scroller.scrollBy({ top: Math.min(e.deltaY, offset - 8) });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener('resize', measureListHeight);
        return () => {
            el.removeEventListener('wheel', onWheel);
            window.removeEventListener('resize', measureListHeight);
        };
    });

    async function jumpToCategory(id: string): Promise<void> {
        if (!isFiltering && !store.isExpanded(id)) store.toggleCategory(id);
        activeCategoryId = id;
        await tick();
        // Let the expanded rows lay out before measuring where to scroll.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        // Scoped to this pane: in split view both panes list the same categories.
        const el = paneEl?.querySelector<HTMLElement>(`[data-category-id="${id}"]`);
        if (!el) return;
        if (isDesktop && scrollEl) {
            const offset = el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
            scrollEl.scrollTo({
                top: scrollEl.scrollTop + offset - columnHeaderHeight,
                behavior: 'smooth',
            });
        } else {
            el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }
    }

    // =========================================================================
    // New category inline creation
    // =========================================================================
    let isCreatingCategory = $state(false);
    let newCategoryName = $state('');
    let newCategoryInput = $state<HTMLInputElement | null>(null);

    function startCreateCategory(): void {
        newCategoryName = '';
        isCreatingCategory = true;
    }

    $effect(() => {
        if (isCreatingCategory && newCategoryInput) newCategoryInput.focus();
    });

    async function saveNewCategory(): Promise<void> {
        const name = newCategoryName.trim();
        if (!name) {
            isCreatingCategory = false;
            return;
        }
        isCreatingCategory = false;
        await store.createCategory(name);
    }

    function handleNewCategoryKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveNewCategory();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            isCreatingCategory = false;
        }
    }

    // =========================================================================
    // Mobile long-press → selection mode
    // =========================================================================
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;

    function handlePointerDown(e: PointerEvent): void {
        if (store.isSelectionMode || e.pointerType !== 'touch') return;
        longPressTimer = setTimeout(() => {
            store.enterSelectionMode();
            const row = (e.target as HTMLElement).closest('[data-channel-id]');
            if (row) {
                const channelId = row.getAttribute('data-channel-id');
                if (channelId) store.toggleSelect(channelId);
            }
        }, 500);
    }

    function handlePointerUp(): void {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    // =========================================================================
    // Filter + expand
    // =========================================================================
    function toggleCategory(id: string): void {
        // Shared across panes.
        store.toggleCategory(id);
    }

    // While searching, matching categories are shown expanded as a VIEW concern (see the
    // `expanded` prop below) — we deliberately don't mutate the shared expand state, so a
    // search on one pane doesn't open/close categories on the other.
    function handleFilterInput(value: string): void {
        filterText = value;
    }

    function clearFilter(): void {
        filterText = '';
    }

    // =========================================================================
    // Category DnD handlers → store
    // =========================================================================
    function handleCategoryConsider(e: CustomEvent<{ items: AdminChannelCategory[] }>): void {
        store.setCategoriesDuringDrag(e.detail.items);
    }

    function handleCategoryFinalize(e: CustomEvent<{ items: AdminChannelCategory[] }>): void {
        store.finalizeCategoryReorder(
            e.detail.items.filter((item) => item.id !== SHADOW_PLACEHOLDER_ITEM_ID),
        );
    }

    // Channel drag finalize. With a leaderId (pointer drag) route through applyChannelDrop
    // (handles group drag + cross-category / cross-pane + filtered reconcile); without one
    // (keyboard ArrowUp/Down reorder) go straight to the single-zone reconcile.
    function handleChannelReorder(
        categoryId: string,
        channels: AdminChannelCategory['channels'],
        leaderId?: string,
        trigger?: string,
    ): void {
        if (leaderId !== undefined)
            store.applyChannelDrop(categoryId, channels, leaderId, paneFilter, trigger);
        else store.applyChannelZone(categoryId, channels, paneFilter);
    }

    function handleChannelConsider(leaderId: string, trigger: string): void {
        store.noteChannelDragConsider(leaderId, trigger);
    }
</script>

<div
    bind:this={paneEl}
    class="space-y-4"
    role="presentation"
    onpointerdown={handlePointerDown}
    onpointerup={handlePointerUp}
    onpointercancel={handlePointerUp}>
    <!-- Search filter + Select button -->
    <div class="flex gap-2">
        <div class="relative flex-1">
            <input
                type="text"
                value={filterText}
                oninput={(e) => handleFilterInput(e.currentTarget.value)}
                placeholder={m.admin_livetv_search_channels()}
                aria-label={m.admin_livetv_search_channels()}
                class="w-full px-4 py-2 bg-surface-800 border border-surface-700 rounded-lg text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500" />
            {#if filterText}
                <button
                    type="button"
                    onclick={clearFilter}
                    class="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-white"
                    aria-label="Clear filter">
                    &times;
                </button>
            {/if}
        </div>
        {#if hiddenCount > 0}
            <label
                class="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-surface-700 bg-surface-800 px-3 text-sm text-surface-300">
                <input
                    type="checkbox"
                    checked={showHidden}
                    onchange={(e) => store.setShowHidden(e.currentTarget.checked)}
                    class="w-4 h-4 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                {m.admin_livetv_show_hidden({ count: hiddenCount })}
            </label>
        {/if}
        {#if offlineCount > 0 || offlineOnly}
            <button
                type="button"
                aria-pressed={offlineOnly}
                data-testid="offline-only-chip"
                class="shrink-0 rounded-lg border px-3 text-sm transition-colors {offlineOnly
                    ? 'border-red-600 bg-red-900/50 text-red-200'
                    : 'border-surface-700 bg-surface-800 text-surface-300 hover:bg-surface-700 hover:text-white'}"
                onclick={() => (offlineOnly = !offlineOnly)}>
                {m.admin_livetv_health_filter_offline({ count: offlineCount })}
            </button>
        {/if}
        <button
            type="button"
            class="px-4 py-2 text-sm rounded-lg border transition-colors {store.isSelectionMode
                ? 'bg-yellow-600 border-yellow-500 text-white hover:bg-yellow-700'
                : 'bg-surface-800 border-surface-700 text-surface-300 hover:bg-surface-700 hover:text-white'}"
            onclick={() =>
                store.isSelectionMode ? store.exitSelectionMode() : store.enterSelectionMode()}>
            {store.isSelectionMode ? m.admin_livetv_cancel_selection() : m.admin_livetv_select()}
        </button>
    </div>

    {#if !showRail && railCategories.length > 1}
        <CategoryRail
            categories={railCategories}
            variant="select"
            onJump={(id) => void jumpToCategory(id)} />
    {/if}

    <!-- Inline hint when category reorder is blocked -->
    {#if showCategoryHint}
        <p class="text-xs text-surface-500 -mt-2">
            {#if store.isSelectionMode}
                {m.admin_livetv_exit_selection_to_reorder()}
            {:else if filterText.trim()}
                {m.admin_livetv_clear_search_to_reorder()}
            {:else if !allCollapsed}
                {m.admin_livetv_collapse_to_reorder()}
            {/if}
        </p>
    {/if}

    <!-- Desktop grid layout — bounded scroll container so svelte-dnd-action autoscrolls
         this region while dragging near the top/bottom edge (rather than the small per-
         category zone). overflow-y-auto also clips horizontally, preserving rounded corners. -->
    {#if isDesktop === null}
        <!-- Layout not known yet (server render / first client tick). -->
    {:else if isDesktop}
        <div class="flex items-start gap-3">
            {#if showRail}
                <CategoryRail
                    categories={railCategories}
                    variant="rail"
                    maxHeight={listHeight}
                    activeId={activeCategoryId}
                    reorderable={!isFiltering && !isSecondary}
                    onReorder={(ids, movedId) => store.reorderCategoriesByIds(ids, movedId)}
                    onMove={(id, move) => store.moveCategory(id, move)}
                    onJump={(id) => void jumpToCategory(id)} />
            {/if}
            <div
                bind:this={scrollEl}
                style="--channel-col-header-h: {columnHeaderHeight}px;{listHeight
                    ? ` max-height: ${listHeight}px`
                    : ''}"
                class="relative flex-1 min-w-0 bg-surface-800 rounded-lg overflow-y-auto max-h-[calc(100vh-16rem)]">
                <!-- Grid header (sticky so column labels stay visible while the list scrolls) -->
                <div
                    bind:offsetHeight={columnHeaderHeight}
                    class="channel-grid-header sticky top-0 z-20 bg-surface-700 text-sm font-medium text-surface-300 {store.isSelectionMode
                        ? 'selecting'
                        : ''}">
                    {#if store.isSelectionMode}
                        <div class="flex items-center justify-center px-2 py-3">
                            <input
                                type="checkbox"
                                checked={store.allSelected()}
                                onchange={() => store.toggleSelectAll()}
                                class="w-4 h-4 rounded border-surface-600 bg-surface-700 text-yellow-500 focus:ring-yellow-500"
                                aria-label={m.admin_livetv_select_all()} />
                        </div>
                    {/if}
                    <div class="px-2 py-3"></div>
                    <div class="px-2 py-3 text-center">Logo</div>
                    <div class="px-4 py-3">Name</div>
                    <div class="px-4 py-3">Quality</div>
                    <div class="px-4 py-3 text-center">Visible</div>
                    <div class="px-4 py-3">EPG</div>
                    <div class="px-4 py-3 text-center">Backup</div>
                </div>

                <!-- Category DnD zone -->
                <div
                    use:dndzone={{
                        items: visibleCategories,
                        flipDurationMs,
                        type: CATEGORY_DND_TYPE,
                        dragDisabled: isCategoryDragDisabled,
                        dropFromOthersDisabled: true,
                        dropTargetStyle: {
                            outline: '2px dashed rgba(234, 179, 8, 0.5)',
                            borderRadius: '8px',
                        },
                    }}
                    onconsider={handleCategoryConsider}
                    onfinalize={handleCategoryFinalize}>
                    {#each visibleCategories as category (category.id)}
                        <div
                            animate:flip={{ duration: flipDurationMs }}
                            data-category-id={category.id}>
                            <CategoryGroup
                                {category}
                                totalChannels={channelTotals.get(category.id)}
                                expanded={isFiltering || store.isExpanded(category.id)}
                                onToggle={() => toggleCategory(category.id)}
                                mode="table"
                                dragDisabled={isChannelDragDisabled}
                                showDragHandle={!isCategoryDragDisabled}
                                isSelectionMode={store.isSelectionMode}
                                selectedIds={store.selectedIds}
                                {groupDragCount}
                                allCategories={store.categories}
                                onChannelReorder={handleChannelReorder}
                                onChannelConsider={handleChannelConsider}
                                onChannelContextMenu={(id, x, y) => store.openContextMenu(id, x, y)}
                                onCategoryKeyboardReorder={(dir) =>
                                    store.moveCategory(category.id, dir)}
                                onCategoryMove={isSecondary
                                    ? undefined
                                    : (move) => store.moveCategory(category.id, move)}
                                onToggleSelect={(id) => store.toggleSelect(id)}
                                onSelectAllInCategory={(id) => store.selectAllInCategory(id)}
                                onVisibilityToggle={(id, s) => store.toggleVisibility(id, s)}
                                onCategoryVisibilityToggle={(id, s) =>
                                    store.toggleCategoryVisibility(id, s)}
                                onNameUpdate={(id, n) => store.updateName(id, n)}
                                onQualityUpdate={(id, q) => store.updateQuality(id, q)}
                                onCategoryRename={(id, n) => store.renameCategory(id, n)}
                                onCategoryMerge={(src, tgt) => store.mergeCategory(src, tgt)}
                                onCategoryDelete={(id) => store.deleteCategory(id)} />
                        </div>
                    {/each}
                </div>

                <!-- + New Category button -->
                <div class="border-t border-surface-700">
                    {#if isCreatingCategory}
                        <div class="px-4 py-2">
                            <input
                                type="text"
                                bind:this={newCategoryInput}
                                bind:value={newCategoryName}
                                onblur={saveNewCategory}
                                onkeydown={handleNewCategoryKeydown}
                                placeholder={m.admin_livetv_category_new_placeholder()}
                                class="bg-surface-700 border border-yellow-500 rounded px-3 py-1.5 text-sm text-white placeholder-surface-500 focus:outline-none w-64" />
                        </div>
                    {:else}
                        <button
                            type="button"
                            class="w-full px-4 py-2 text-sm text-surface-400 hover:text-yellow-400 hover:bg-surface-700/50 text-left flex items-center gap-2"
                            onclick={startCreateCategory}>
                            <span class="text-lg leading-none">+</span>
                            {m.admin_livetv_category_new()}
                        </button>
                    {/if}
                </div>
            </div>
        </div>
    {:else}
        <!-- Mobile card layout -->
        <div
            class="space-y-2"
            use:dndzone={{
                items: visibleCategories,
                flipDurationMs,
                type: CATEGORY_DND_TYPE,
                dragDisabled: isCategoryDragDisabled,
                dropFromOthersDisabled: true,
                dropTargetStyle: {
                    outline: '2px dashed rgba(234, 179, 8, 0.5)',
                    borderRadius: '8px',
                },
            }}
            onconsider={handleCategoryConsider}
            onfinalize={handleCategoryFinalize}>
            {#each visibleCategories as category (category.id)}
                <div
                    animate:flip={{ duration: flipDurationMs }}
                    data-category-id={category.id}
                    class="scroll-mt-20">
                    <CategoryGroup
                        {category}
                        totalChannels={channelTotals.get(category.id)}
                        expanded={isFiltering || store.isExpanded(category.id)}
                        onToggle={() => toggleCategory(category.id)}
                        mode="card"
                        dragDisabled={isCategoryDragDisabled}
                        showDragHandle={!isCategoryDragDisabled}
                        isSelectionMode={store.isSelectionMode}
                        selectedIds={store.selectedIds}
                        {groupDragCount}
                        allCategories={store.categories}
                        onChannelReorder={handleChannelReorder}
                        onChannelConsider={handleChannelConsider}
                        onChannelContextMenu={(id, x, y) => store.openContextMenu(id, x, y)}
                        onCategoryKeyboardReorder={(dir) => store.moveCategory(category.id, dir)}
                        onCategoryMove={isSecondary
                            ? undefined
                            : (move) => store.moveCategory(category.id, move)}
                        onToggleSelect={(id) => store.toggleSelect(id)}
                        onSelectAllInCategory={(id) => store.selectAllInCategory(id)}
                        onVisibilityToggle={(id, s) => store.toggleVisibility(id, s)}
                        onCategoryVisibilityToggle={(id, s) =>
                            store.toggleCategoryVisibility(id, s)}
                        onNameUpdate={(id, n) => store.updateName(id, n)}
                        onQualityUpdate={(id, q) => store.updateQuality(id, q)}
                        onCategoryRename={(id, n) => store.renameCategory(id, n)}
                        onCategoryMerge={(src, tgt) => store.mergeCategory(src, tgt)}
                        onCategoryDelete={(id) => store.deleteCategory(id)} />
                </div>
            {/each}
        </div>

        <!-- Mobile + New Category button -->
        <div>
            {#if isCreatingCategory}
                <div class="px-4 py-2 bg-surface-800 rounded-lg">
                    <input
                        type="text"
                        bind:this={newCategoryInput}
                        bind:value={newCategoryName}
                        onblur={saveNewCategory}
                        onkeydown={handleNewCategoryKeydown}
                        placeholder={m.admin_livetv_category_new_placeholder()}
                        class="bg-surface-700 border border-yellow-500 rounded px-3 py-1.5 text-sm text-white placeholder-surface-500 focus:outline-none w-full" />
                </div>
            {:else}
                <button
                    type="button"
                    class="w-full px-4 py-3 text-sm text-surface-400 hover:text-yellow-400 bg-surface-800 rounded-lg hover:bg-surface-700/50 text-left flex items-center gap-2"
                    onclick={startCreateCategory}>
                    <span class="text-lg leading-none">+</span>
                    {m.admin_livetv_category_new()}
                </button>
            {/if}
        </div>
    {/if}
</div>

<style>
    /* Columns are defined here (not via an inherited CSS var) so they match ChannelRow's
       own scoped grid — see ChannelRow.svelte for why the var approach broke the drag mirror. */
    .channel-grid-header {
        display: grid;
        grid-template-columns: 40px 56px 1fr 80px 60px 128px 72px;
    }
    .channel-grid-header.selecting {
        grid-template-columns: 32px 40px 56px 1fr 80px 60px 128px 72px;
    }
</style>
