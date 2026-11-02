<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import {
        Icon,
        Bars3,
        Eye,
        EyeSlash,
        EllipsisVertical,
        PencilSquare,
        Hashtag,
        ArrowsRightLeft,
        ArrowUp,
        ArrowDown,
        ChevronDoubleUp,
        ChevronDoubleDown,
        Trash,
    } from 'svelte-hero-icons';
    import type { AdminChannelCategory, AdminChannel } from '$lib/schemas/livetv.js';
    import { CategoryChannelCountResponseSchema } from '$lib/schemas/livetv.js';
    import { apiGet } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import ChannelRow from './ChannelRow.svelte';
    import { CHANNEL_DND_TYPE, getChannelStore } from './channel-store.svelte.js';
    import { mergeWindowedPayload, type CategoryMove } from './channel-reconcile.js';
    import { getChannelViewerStatus } from './channel-viewer-status.js';
    import type { ChannelViewerStatus } from './channel-viewer-status.js';
    import * as m from '$lib/paraglide/messages.js';

    const flipDurationMs = 200;

    interface Props {
        category: AdminChannelCategory;
        /** All of the category's channels; `category.channels` may be a filtered view. */
        totalChannels?: number;
        expanded: boolean;
        onToggle: () => void;
        mode: 'table' | 'card';
        dragDisabled?: boolean;
        showDragHandle?: boolean;
        isSelectionMode?: boolean;
        selectedIds?: Set<string>;
        /** When >1, a multi-select group exists; shown as a badge on selected rows' handles. */
        groupDragCount?: number;
        allCategories?: AdminChannelCategory[];
        onChannelReorder?: (
            categoryId: string,
            channels: AdminChannel[],
            leaderId?: string,
            trigger?: string,
        ) => void;
        onChannelConsider?: (leaderId: string, trigger: string) => void;
        onChannelContextMenu?: (channelId: string, x: number, y: number) => void;
        onCategoryKeyboardReorder?: (direction: 'up' | 'down') => void;
        /** Move this category in the category order (menu, Alt+arrow keys). */
        onCategoryMove?: (move: CategoryMove) => void;
        onToggleSelect?: (channelId: string) => void;
        onSelectAllInCategory?: (categoryId: string) => void;
        onVisibilityToggle?: (channelId: string, newState: boolean) => void;
        onCategoryVisibilityToggle?: (categoryId: string, newState: boolean) => void;
        onNameUpdate?: (channelId: string, newName: string) => Promise<void>;
        onQualityUpdate?: (channelId: string, newTier: string) => Promise<void>;
        onCategoryRename?: (categoryId: string, newName: string) => Promise<void>;
        onCategoryMerge?: (sourceCategoryId: string, targetCategoryId: string) => Promise<void>;
        onCategoryDelete?: (categoryId: string) => Promise<void>;
    }

    let {
        category,
        totalChannels,
        expanded,
        onToggle,
        mode,
        dragDisabled = false,
        showDragHandle = true,
        isSelectionMode = false,
        selectedIds = new Set<string>(),
        groupDragCount = 0,
        allCategories = [],
        onChannelReorder,
        onChannelConsider,
        onChannelContextMenu,
        onCategoryKeyboardReorder,
        onCategoryMove,
        onToggleSelect,
        onSelectAllInCategory,
        onVisibilityToggle,
        onCategoryVisibilityToggle,
        onNameUpdate,
        onQualityUpdate,
        onCategoryRename,
        onCategoryMerge,
        onCategoryDelete,
    }: Props = $props();

    // A backup group's primary can live in another category, so the lookup must
    // span the whole install. The store derives it once for every pane.
    const channelStore = getChannelStore();
    function viewerStatusFor(channel: AdminChannel): ChannelViewerStatus {
        return getChannelViewerStatus(channel, category.isVisible, channelStore.channelIndex);
    }

    let isUncategorized = $derived(category.id === 'uncategorized');
    // Delete, merge and the count go by every channel, not just the ones on screen:
    // a category of hidden channels looks empty with "Show hidden" off.
    let channelTotal = $derived(totalChannels ?? category.channels.length);
    let displayName = $derived(isUncategorized ? m.admin_livetv_uncategorized() : category.name);

    // =========================================================================
    // Inline rename state
    // =========================================================================
    let isEditing = $state(false);
    let editValue = $state('');
    let inputEl = $state<HTMLInputElement | null>(null);

    function startEdit(): void {
        if (isUncategorized) return;
        editValue = category.name;
        isEditing = true;
    }

    $effect(() => {
        if (isEditing && inputEl) inputEl.focus();
    });

    async function saveEdit(): Promise<void> {
        const trimmed = editValue.trim();
        if (trimmed && trimmed !== category.name) {
            await onCategoryRename?.(category.id, trimmed);
        }
        isEditing = false;
    }

    function cancelEdit(): void {
        isEditing = false;
    }

    function handleEditKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveEdit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        }
    }

    // =========================================================================
    // Kebab menu state
    // =========================================================================
    let showMenu = $state(false);
    let showMergeDropdown = $state(false);
    let mergeTarget = $state<{ id: string; name: string } | null>(null);
    let mergeChannelCount = $state<number | null>(null);
    let isFetchingCount = $state(false);

    let mergeTargets = $derived(
        allCategories.filter((c) => c.id !== category.id && c.id !== 'uncategorized'),
    );

    function toggleMenu(e: Event): void {
        e.stopPropagation();
        showMenu = !showMenu;
        if (!showMenu) {
            showMergeDropdown = false;
            mergeTarget = null;
            mergeChannelCount = null;
        }
    }

    function handleMenuRename(e: Event): void {
        e.stopPropagation();
        showMenu = false;
        startEdit();
    }

    /** "Numbers start at": the first channel number of this category (empty or 0 removes it). */
    function handleMenuNumberStart(e: Event): void {
        e.stopPropagation();
        showMenu = false;
        const answer = prompt(
            m.admin_livetv_number_start_prompt({ name: category.name }),
            category.numberStart === undefined ? '' : String(category.numberStart),
        );
        if (answer === null) return;
        const start = answer.trim() === '' ? 0 : Number(answer.trim());
        if (!Number.isInteger(start) || start < 0 || start > 9999) {
            toasts.error(m.admin_livetv_number_start_invalid());
            return;
        }
        if (start === (category.numberStart ?? 0)) return;
        void channelStore.setCategoryNumberStart(category.id, start);
    }

    function handleMenuMerge(e: Event): void {
        e.stopPropagation();
        showMergeDropdown = !showMergeDropdown;
    }

    async function handleMergeTargetSelect(
        target: { id: string; name: string },
        e: Event,
    ): Promise<void> {
        e.stopPropagation();
        mergeTarget = target;
        showMergeDropdown = false;
        isFetchingCount = true;
        const { data } = await apiGet(
            `/api/admin/livetv/categories/${category.id}/channel-count`,
            CategoryChannelCountResponseSchema,
        );
        mergeChannelCount = data?.count ?? channelTotal;
        isFetchingCount = false;
    }

    async function confirmMerge(e: Event): Promise<void> {
        e.stopPropagation();
        if (!mergeTarget) return;
        await onCategoryMerge?.(category.id, mergeTarget.id);
        showMenu = false;
        mergeTarget = null;
        mergeChannelCount = null;
    }

    function cancelMerge(e: Event): void {
        e.stopPropagation();
        mergeTarget = null;
        mergeChannelCount = null;
    }

    async function handleMenuDelete(e: Event): Promise<void> {
        e.stopPropagation();
        showMenu = false;
        await onCategoryDelete?.(category.id);
    }

    // Close menu on outside click
    function handleDocumentClick(): void {
        if (showMenu) {
            showMenu = false;
            showMergeDropdown = false;
            mergeTarget = null;
            mergeChannelCount = null;
        }
    }

    $effect(() => {
        if (showMenu) {
            document.addEventListener('click', handleDocumentClick);
            return () => document.removeEventListener('click', handleDocumentClick);
        }
    });

    // Local channel list for DnD — mutable copy synced from prop (rollback, refetch)
    let localChannels = $derived(category.channels.map((ch) => ({ ...ch })));

    let allInCategorySelected = $derived(
        localChannels.length > 0 && localChannels.every((ch) => selectedIds.has(ch.id)),
    );

    function handleChannelConsider(
        e: CustomEvent<{
            items: Array<AdminChannel & { id: string }>;
            info: { id: string; trigger: string };
        }>,
    ): void {
        windowChannels = e.detail.items;
        onChannelConsider?.(e.detail.info.id, e.detail.info.trigger);
    }

    function handleChannelFinalize(
        e: CustomEvent<{
            items: Array<AdminChannel & { id: string }>;
            info: { id: string; trigger: string };
        }>,
    ): void {
        const dropped = e.detail.items.filter((item) => item.id !== SHADOW_PLACEHOLDER_ITEM_ID);
        // The zone only holds the rendered window; the rows after it keep their order.
        localChannels = mergeWindowedPayload(localChannels, dropped, visibleLimit);
        // A drop on the window's last slot lands past it: keep that row rendered.
        const landedAt = dropped.findIndex((item) => item.id === e.detail.info.id);
        if (landedAt >= visibleLimit) visibleLimit = landedAt + 1;
        // info.id identifies the grabbed channel (the group-drag leader); info.trigger
        // distinguishes a real drop from an abort ('droppedOutsideOfAny').
        onChannelReorder?.(category.id, localChannels, e.detail.info.id, e.detail.info.trigger);
    }

    function handleChannelKeyboardReorder(index: number, direction: 'up' | 'down'): void {
        const newIndex = direction === 'up' ? index - 1 : index + 1;
        if (newIndex < 0 || newIndex >= localChannels.length) return;

        const updated = [...localChannels];
        const [moved] = updated.splice(index, 1);
        updated.splice(newIndex, 0, moved);
        localChannels = updated;
        if (newIndex >= visibleLimit) visibleLimit = newIndex + 1;
        // No leaderId → a keyboard reorder is never a group drag.
        onChannelReorder?.(category.id, localChannels);
    }

    function handleCategoryHandleKeydown(e: KeyboardEvent): void {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            e.stopPropagation();
            onCategoryKeyboardReorder?.(e.key === 'ArrowUp' ? 'up' : 'down');
        }
    }

    /** Alt+↑/↓ moves the category one place, Alt+Home/End to the top/bottom. */
    function categoryMoveForKey(e: KeyboardEvent): CategoryMove | null {
        if (!e.altKey) return null;
        if (e.key === 'ArrowUp') return 'up';
        if (e.key === 'ArrowDown') return 'down';
        if (e.key === 'Home') return 'top';
        if (e.key === 'End') return 'bottom';
        return null;
    }

    function handleHeaderKeydown(e: KeyboardEvent): void {
        const move = onCategoryMove ? categoryMoveForKey(e) : null;
        if (move) {
            e.preventDefault();
            onCategoryMove?.(move);
            return;
        }
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
        }
    }

    function handleMenuMove(move: CategoryMove, e: Event): void {
        e.stopPropagation();
        showMenu = false;
        onCategoryMove?.(move);
    }

    const MOVES: Array<{ move: CategoryMove; icon: typeof ArrowUp; label: () => string }> = [
        { move: 'up', icon: ArrowUp, label: () => m.admin_livetv_category_move_up() },
        { move: 'down', icon: ArrowDown, label: () => m.admin_livetv_category_move_down() },
        { move: 'top', icon: ChevronDoubleUp, label: () => m.admin_livetv_category_move_top() },
        {
            move: 'bottom',
            icon: ChevronDoubleDown,
            label: () => m.admin_livetv_category_move_bottom(),
        },
    ];

    function handleCategoryVisibilityClick(e: Event): void {
        e.stopPropagation();
        onCategoryVisibilityToggle?.(category.id, !category.isVisible);
    }

    // Progressive rendering for large categories: a genre of a large provider holds
    // 1,000–2,000 channels, and rendering them all (each row a drag item) froze the
    // page. Only the first rows render, with or without drag; the drag zone works on
    // that window and the finalize merges it back into the full list.
    const CHANNEL_PAGE_SIZE = 100;
    let visibleLimit = $state(CHANNEL_PAGE_SIZE);
    // Channel DnD is active whenever the parent hasn't disabled it. In selection mode the
    // parent keeps it disabled until a multi-select group exists, so group drag can engage
    // (rows stay tap-to-select; an actual drag moves the group).
    let isDndActive = $derived(!dragDisabled);
    // Overridden by the drag zone's consider events while a drag is live.
    let windowChannels = $derived(localChannels.slice(0, visibleLimit));
    let remainingChannels = $derived(Math.max(0, localChannels.length - visibleLimit));
    // "Show all" on 2,000 draggable rows is the freeze this window avoids.
    const SHOW_ALL_MAX = 500;

    // Reset limit when category collapses
    $effect(() => {
        if (!expanded) visibleLimit = CHANNEL_PAGE_SIZE;
    });

    function handleNameClick(e: Event): void {
        if (!isUncategorized && onCategoryRename) {
            e.stopPropagation();
            startEdit();
        }
    }
</script>

{#snippet categoryActions()}
    {#if !isUncategorized}
        <button
            type="button"
            class="p-1 hover:bg-surface-600 rounded"
            onclick={handleCategoryVisibilityClick}
            aria-label={category.isVisible
                ? m.admin_livetv_bulk_hide()
                : m.admin_livetv_bulk_show()}>
            {#if category.isVisible}
                <Icon src={Eye} class="w-4 h-4 text-green-400" />
            {:else}
                <Icon src={EyeSlash} class="w-4 h-4 text-surface-500" />
            {/if}
        </button>
        {#if onCategoryRename || onCategoryMerge || onCategoryDelete || onCategoryMove}
            <div class="relative">
                <button
                    type="button"
                    class="p-1 hover:bg-surface-600 rounded"
                    onclick={toggleMenu}
                    aria-label="Category actions">
                    <Icon src={EllipsisVertical} class="w-4 h-4 text-surface-400" />
                </button>
                {#if showMenu}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <div
                        class="absolute right-0 top-full mt-1 z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-lg py-1 min-w-[180px]"
                        onclick={(e) => e.stopPropagation()}>
                        {#if onCategoryMove}
                            {#each MOVES as item (item.move)}
                                <button
                                    type="button"
                                    class="w-full px-3 py-2 text-left text-sm text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                                    onclick={(e) => handleMenuMove(item.move, e)}>
                                    <Icon src={item.icon} class="w-4 h-4" />
                                    {item.label()}
                                </button>
                            {/each}
                            <div class="my-1 border-t border-surface-700"></div>
                        {/if}
                        {#if onCategoryRename}
                            <button
                                type="button"
                                class="w-full px-3 py-2 text-left text-sm text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                                onclick={handleMenuRename}>
                                <Icon src={PencilSquare} class="w-4 h-4" />
                                {m.admin_livetv_category_rename()}
                            </button>
                        {/if}
                        {#if !isUncategorized}
                            <button
                                type="button"
                                class="w-full px-3 py-2 text-left text-sm text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                                onclick={handleMenuNumberStart}>
                                <Icon src={Hashtag} class="w-4 h-4" />
                                {m.admin_livetv_number_start_menu()}
                            </button>
                        {/if}
                        {#if onCategoryMerge}
                            <div class="relative">
                                <button
                                    type="button"
                                    class="w-full px-3 py-2 text-left text-sm text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                                    onclick={handleMenuMerge}>
                                    <Icon src={ArrowsRightLeft} class="w-4 h-4" />
                                    {m.admin_livetv_category_merge()}
                                </button>
                                {#if showMergeDropdown}
                                    <div
                                        class="border-t border-surface-700 bg-surface-750 max-h-48 overflow-y-auto">
                                        {#each mergeTargets as target (target.id)}
                                            <button
                                                type="button"
                                                class="w-full px-4 py-1.5 text-left text-sm text-surface-300 hover:bg-surface-700 hover:text-white"
                                                onclick={(e) => handleMergeTargetSelect(target, e)}>
                                                {target.name}
                                            </button>
                                        {/each}
                                        {#if mergeTargets.length === 0}
                                            <p class="px-4 py-2 text-xs text-surface-500">
                                                No other categories
                                            </p>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        {/if}
                        {#if onCategoryDelete}
                            <button
                                type="button"
                                class="w-full px-3 py-2 text-left text-sm flex items-center gap-2
                                    {channelTotal === 0
                                    ? 'text-red-400 hover:bg-surface-700'
                                    : 'text-surface-600 cursor-not-allowed'}"
                                onclick={channelTotal === 0 ? handleMenuDelete : undefined}
                                disabled={channelTotal > 0}
                                title={channelTotal > 0
                                    ? m.admin_livetv_category_delete_disabled()
                                    : undefined}>
                                <Icon src={Trash} class="w-4 h-4" />
                                {m.admin_livetv_category_delete()}
                            </button>
                        {/if}
                    </div>
                {/if}
            </div>
        {/if}
    {/if}
{/snippet}

{#snippet channelCount()}
    {#if channelTotal !== category.channels.length}
        {m.admin_livetv_category_count_shown({
            shown: category.channels.length,
            total: channelTotal,
        })}
    {:else}
        {channelTotal}
    {/if}
{/snippet}

{#snippet showMore()}
    {#if remainingChannels > 0}
        <div class="flex items-center justify-center gap-3 py-2 text-sm">
            <button
                type="button"
                class="text-yellow-400 hover:text-yellow-300 transition-colors"
                onclick={() => {
                    visibleLimit += CHANNEL_PAGE_SIZE;
                }}>
                {m.admin_livetv_show_more_channels({
                    count: Math.min(CHANNEL_PAGE_SIZE, remainingChannels),
                    remaining: remainingChannels,
                })}
            </button>
            {#if remainingChannels <= SHOW_ALL_MAX || !isDndActive}
                <span class="text-surface-600">|</span>
                <button
                    type="button"
                    class="text-yellow-400 hover:text-yellow-300 transition-colors"
                    onclick={() => {
                        visibleLimit = localChannels.length;
                    }}>
                    {m.admin_livetv_show_all_channels()}
                </button>
            {/if}
        </div>
    {/if}
{/snippet}

{#snippet categoryName()}
    {#if isEditing}
        <input
            type="text"
            bind:this={inputEl}
            bind:value={editValue}
            onblur={saveEdit}
            onkeydown={handleEditKeydown}
            onclick={(e) => e.stopPropagation()}
            class="bg-surface-700 border border-yellow-500 rounded px-2 py-0.5 text-sm text-white focus:outline-none w-40" />
    {:else if isUncategorized}
        <span class="font-medium text-surface-500">{displayName}</span>
    {:else}
        <button
            type="button"
            class="font-medium text-surface-200 hover:text-yellow-400 cursor-pointer bg-transparent border-none p-0"
            onclick={handleNameClick}>
            {displayName}
        </button>
    {/if}
    {#if category.numberStart !== undefined}
        <span
            class="ml-2 text-xs text-surface-400 tabular-nums"
            data-testid="category-number-start">
            {m.admin_livetv_number_start_badge({ start: String(category.numberStart) })}
        </span>
    {/if}
    {#if category.numberOverflow}
        <span class="ml-2 text-xs text-amber-400" data-testid="category-number-overflow">
            {m.admin_livetv_number_start_overflow({ count: String(category.numberOverflow) })}
        </span>
    {/if}
{/snippet}

{#if mode === 'table'}
    <!-- Grid mode: category header + channel rows -->
    <div class="category-group">
        <!-- Category header row -->
        <div
            class="category-header cursor-pointer hover:bg-surface-700/50 select-none {showMenu
                ? 'menu-open'
                : ''}"
            onclick={onToggle}
            onkeydown={handleHeaderKeydown}
            aria-keyshortcuts={onCategoryMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
            role="button"
            tabindex="0">
            <div class="flex items-center gap-2 px-4 py-2">
                {#if isSelectionMode}
                    <input
                        type="checkbox"
                        checked={allInCategorySelected}
                        onchange={() => onSelectAllInCategory?.(category.id)}
                        onclick={(e) => e.stopPropagation()}
                        class="w-4 h-4 rounded border-surface-600 bg-surface-700 text-yellow-500 focus:ring-yellow-500" />
                {/if}
                {#if showDragHandle}
                    <div
                        class="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 p-1"
                        onclick={(e) => e.stopPropagation()}
                        onkeydown={(e) => {
                            e.stopPropagation();
                            handleCategoryHandleKeydown(e);
                        }}
                        tabindex="0"
                        role="button"
                        aria-label={m.admin_livetv_reorder_handle_tooltip()}
                        title={m.admin_livetv_reorder_handle_tooltip()}>
                        <Icon src={Bars3} class="w-4 h-4" />
                    </div>
                {/if}
                <svg
                    class="w-4 h-4 transition-transform duration-150 text-surface-400 {expanded
                        ? 'rotate-90'
                        : ''}"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {@render categoryName()}
                <span class="text-xs text-surface-500 bg-surface-700 px-2 py-0.5 rounded-full">
                    {@render channelCount()}
                </span>
                <div class="ml-auto flex items-center gap-1">
                    {@render categoryActions()}
                </div>
            </div>
            <!-- Merge confirmation inline -->
            {#if mergeTarget}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="flex items-center gap-2 px-4 py-2 bg-yellow-900/20 border-t border-yellow-800/30 text-sm"
                    onclick={(e) => e.stopPropagation()}>
                    {#if isFetchingCount}
                        <span class="text-surface-400">Loading...</span>
                    {:else}
                        <span class="text-yellow-200">
                            {m.admin_livetv_category_merge_confirm({
                                count: mergeChannelCount ?? 0,
                                target: mergeTarget.name,
                            })}
                        </span>
                        <button
                            type="button"
                            class="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded"
                            onclick={confirmMerge}>
                            {m.confirm()}
                        </button>
                        <button
                            type="button"
                            class="px-2 py-1 text-xs bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                            onclick={cancelMerge}>
                            {m.cancel()}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>
        {#if expanded}
            {#if isDndActive}
                <div
                    class={localChannels.length === 0 ? 'min-h-[44px]' : ''}
                    use:dndzone={{
                        items: windowChannels,
                        flipDurationMs,
                        type: CHANNEL_DND_TYPE,
                        dragDisabled: false,
                        dropTargetStyle: {
                            outline: '2px dashed rgba(234, 179, 8, 0.4)',
                            borderRadius: '4px',
                        },
                    }}
                    onconsider={handleChannelConsider}
                    onfinalize={handleChannelFinalize}>
                    {#each windowChannels as channel, index (channel.id)}
                        <div animate:flip={{ duration: flipDurationMs }}>
                            <ChannelRow
                                viewerStatus={viewerStatusFor(channel)}
                                {channel}
                                mode="table"
                                showDragHandle={true}
                                {isSelectionMode}
                                isSelected={selectedIds.has(channel.id)}
                                {groupDragCount}
                                onKeyboardReorder={(dir) =>
                                    handleChannelKeyboardReorder(index, dir)}
                                {onToggleSelect}
                                {onVisibilityToggle}
                                {onNameUpdate}
                                {onQualityUpdate}
                                onNumberSave={(id, num) => channelStore.setChannelNumber(id, num)}
                                onNumberUnpin={(id) => channelStore.unpinChannelNumber(id)}
                                onHealthReset={(id) => channelStore.resetHealth(id)}
                                onContextMenu={onChannelContextMenu} />
                        </div>
                    {/each}
                </div>
                {@render showMore()}
            {:else}
                <div>
                    {#each windowChannels as channel (channel.id)}
                        <ChannelRow
                            viewerStatus={viewerStatusFor(channel)}
                            {channel}
                            mode="table"
                            showDragHandle={false}
                            {isSelectionMode}
                            isSelected={selectedIds.has(channel.id)}
                            {onToggleSelect}
                            {onVisibilityToggle}
                            {onNameUpdate}
                            {onQualityUpdate}
                            onNumberSave={(id, num) => channelStore.setChannelNumber(id, num)}
                            onNumberUnpin={(id) => channelStore.unpinChannelNumber(id)}
                            onHealthReset={(id) => channelStore.resetHealth(id)}
                            onContextMenu={onChannelContextMenu} />
                    {/each}
                    {@render showMore()}
                </div>
            {/if}
        {/if}
    </div>
{:else}
    <!-- Card mode -->
    <div class="bg-surface-800 rounded-lg overflow-hidden">
        <div class="flex items-center">
            {#if isSelectionMode}
                <div class="p-3">
                    <input
                        type="checkbox"
                        checked={allInCategorySelected}
                        onchange={() => onSelectAllInCategory?.(category.id)}
                        class="w-4 h-4 rounded border-surface-600 bg-surface-700 text-yellow-500 focus:ring-yellow-500" />
                </div>
            {/if}
            {#if showDragHandle}
                <div
                    class="cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 p-3"
                    onkeydown={(e) => {
                        e.stopPropagation();
                        handleCategoryHandleKeydown(e);
                    }}
                    tabindex="0"
                    role="button"
                    aria-label={m.admin_livetv_reorder_handle_tooltip()}
                    title={m.admin_livetv_reorder_handle_tooltip()}>
                    <Icon src={Bars3} class="w-4 h-4" />
                </div>
            {/if}
            <button
                type="button"
                class="flex-1 px-4 py-3 flex items-center gap-2 hover:bg-surface-700/50 {showDragHandle
                    ? '!pl-0'
                    : ''}"
                onclick={onToggle}>
                <svg
                    class="w-4 h-4 transition-transform duration-150 text-surface-400 {expanded
                        ? 'rotate-90'
                        : ''}"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {@render categoryName()}
                <span class="text-xs text-surface-500 bg-surface-700 px-2 py-0.5 rounded-full">
                    {@render channelCount()}
                </span>
            </button>
            <div class="flex items-center gap-1 pr-2">
                {@render categoryActions()}
            </div>
        </div>
        <!-- Merge confirmation inline (card mode) -->
        {#if mergeTarget}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="flex items-center gap-2 px-4 py-2 bg-yellow-900/20 border-t border-yellow-800/30 text-sm"
                onclick={(e) => e.stopPropagation()}>
                {#if isFetchingCount}
                    <span class="text-surface-400">Loading...</span>
                {:else}
                    <span class="text-yellow-200">
                        {m.admin_livetv_category_merge_confirm({
                            count: mergeChannelCount ?? 0,
                            target: mergeTarget.name,
                        })}
                    </span>
                    <button
                        type="button"
                        class="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded"
                        onclick={confirmMerge}>
                        Confirm
                    </button>
                    <button
                        type="button"
                        class="px-2 py-1 text-xs bg-surface-700 hover:bg-surface-600 text-surface-300 rounded"
                        onclick={cancelMerge}>
                        {m.cancel()}
                    </button>
                {/if}
            </div>
        {/if}
        {#if expanded}
            {#if isDndActive}
                <div
                    class="divide-y divide-surface-700 {localChannels.length === 0
                        ? 'min-h-[44px]'
                        : ''}"
                    use:dndzone={{
                        items: windowChannels,
                        flipDurationMs,
                        type: CHANNEL_DND_TYPE,
                        dragDisabled: false,
                        dropTargetStyle: {
                            outline: '2px dashed rgba(234, 179, 8, 0.4)',
                            borderRadius: '4px',
                        },
                    }}
                    onconsider={handleChannelConsider}
                    onfinalize={handleChannelFinalize}>
                    {#each windowChannels as channel, index (channel.id)}
                        <div animate:flip={{ duration: flipDurationMs }}>
                            <ChannelRow
                                viewerStatus={viewerStatusFor(channel)}
                                {channel}
                                mode="card"
                                showDragHandle={true}
                                {isSelectionMode}
                                isSelected={selectedIds.has(channel.id)}
                                {groupDragCount}
                                onKeyboardReorder={(dir) =>
                                    handleChannelKeyboardReorder(index, dir)}
                                {onToggleSelect}
                                {onVisibilityToggle}
                                {onNameUpdate}
                                {onQualityUpdate}
                                onNumberSave={(id, num) => channelStore.setChannelNumber(id, num)}
                                onNumberUnpin={(id) => channelStore.unpinChannelNumber(id)}
                                onHealthReset={(id) => channelStore.resetHealth(id)}
                                onContextMenu={onChannelContextMenu} />
                        </div>
                    {/each}
                </div>
                {@render showMore()}
            {:else}
                <div class="divide-y divide-surface-700">
                    {#each windowChannels as channel (channel.id)}
                        <ChannelRow
                            viewerStatus={viewerStatusFor(channel)}
                            {channel}
                            mode="card"
                            showDragHandle={false}
                            {isSelectionMode}
                            isSelected={selectedIds.has(channel.id)}
                            {onToggleSelect}
                            {onVisibilityToggle}
                            {onNameUpdate}
                            {onQualityUpdate}
                            onNumberSave={(id, num) => channelStore.setChannelNumber(id, num)}
                            onNumberUnpin={(id) => channelStore.unpinChannelNumber(id)}
                            onHealthReset={(id) => channelStore.resetHealth(id)}
                            onContextMenu={onChannelContextMenu} />
                    {/each}
                    {@render showMore()}
                </div>
            {/if}
        {/if}
    </div>
{/if}

<style>
    /* An expanded category's header (name, count, collapse) stays in view below the
       pane's sticky column header while its rows scroll; it lets go at the category's end. */
    .category-header {
        background-color: rgb(38, 42, 51);
        position: sticky;
        top: var(--channel-col-header-h, 0px);
        z-index: 10;
    }
    /* The kebab menu must stay above the next category's sticky header. */
    .category-header.menu-open {
        z-index: 15;
    }
</style>
