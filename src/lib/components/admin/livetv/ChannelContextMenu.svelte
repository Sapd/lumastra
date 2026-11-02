<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        ArrowUp,
        ArrowDown,
        FolderArrowDown,
        Eye,
        EyeSlash,
        Sparkles,
        CheckCircle,
        Signal,
        Star,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { isDegradedFeedName } from './channel-viewer-status.js';
    import { getChannelStore } from './channel-store.svelte.js';
    import CategoryPicker, { type PickerCategory } from './CategoryPicker.svelte';
    import * as m from '$lib/paraglide/messages.js';

    const store = getChannelStore();

    // The menu only mounts while store.contextMenu is set (ChannelTable guards it), but read
    // defensively so a race during close can't crash.
    let menu = $derived(store.contextMenu);
    let channelId = $derived(menu?.channelId ?? '');
    let targetCount = $derived(menu ? store.contextTargetCount(menu.channelId) : 1);
    let channel = $derived(menu ? store.channelById(menu.channelId) : undefined);
    let isVisible = $derived(channel?.isVisible ?? true);
    // The clicked channel's own category — excluded from the move-to-category submenu so
    // "move to category" never lists the category the channel already lives in.
    let currentCategoryId = $derived(channel?.categoryId ?? 'uncategorized');
    let pickerCategories = $derived<PickerCategory[]>(
        store.categories
            .filter((c) => c.id !== currentCategoryId)
            .map((c) => ({
                id: c.id,
                name: c.id === 'uncategorized' ? m.admin_livetv_uncategorized() : c.name,
                // Same count the list shows: hidden channels only when they are on screen.
                count: store.showHidden
                    ? c.channels.length
                    : c.channels.filter((ch) => ch.isVisible).length,
            })),
    );

    let menuEl = $state<HTMLDivElement | null>(null);
    let showCategorySub = $state(false);
    let showQualitySub = $state(false);
    let showFeedsSub = $state(false);
    // The station's feeds (its backup group) — one row only, not a multi-selection.
    let feeds = $derived(menu && targetCount === 1 ? store.groupFeeds(menu.channelId) : []);
    let shownFeedId = $derived(
        channel?.backupGroupId
            ? store.channelIndex.shownByGroup.get(channel.backupGroupId)
            : undefined,
    );

    function feedName(feed: { name: string; adminDisplayName?: string }): string {
        return feed.adminDisplayName ?? feed.name;
    }

    function playFeed(feedId: string): void {
        // A new tab: this page holds unsaved drag state and the open category tree.
        globalThis.open(resolve(`/watch/${feedId}`), '_blank', 'noopener');
        close();
    }

    function makePrimary(feedId: string): void {
        void store.setGroupPrimary(feedId);
        close();
    }
    let restoreFocusEl: HTMLElement | null = null;

    const qualityTiers = [
        { value: 'uhd', label: (): string => m.admin_livetv_quality_uhd() },
        { value: 'fhd', label: (): string => m.admin_livetv_quality_fhd() },
        { value: 'hd', label: (): string => m.admin_livetv_quality_hd() },
        { value: 'sd', label: (): string => m.admin_livetv_quality_sd() },
    ];

    // Clamp the menu within the viewport.
    let pos = $derived.by(() => {
        if (!menu) return { left: 0, top: 0 };
        const width = 240;
        // The category picker (search + list) makes the menu taller while open.
        const height = showCategorySub ? 600 : showFeedsSub ? 360 + feeds.length * 72 : 320;
        const left = Math.min(menu.x, (globalThis.innerWidth || 1280) - width - 8);
        const top = Math.min(menu.y, (globalThis.innerHeight || 800) - height - 8);
        return { left: Math.max(8, left), top: Math.max(8, top) };
    });

    function close(): void {
        store.closeContextMenu();
        restoreFocusEl?.focus?.();
    }

    function menuItems(): HTMLButtonElement[] {
        if (!menuEl) return [];
        return [...menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
    }

    function handleKeydown(e: KeyboardEvent): void {
        const items = menuItems();
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            items[(idx + 1 + items.length) % items.length]?.focus();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            items[(idx - 1 + items.length) % items.length]?.focus();
        } else if (e.key === 'Home') {
            e.preventDefault();
            items[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            items[items.length - 1]?.focus();
        }
    }

    // Mount: remember the element to restore focus to, focus the first item, wire outside-click.
    $effect(() => {
        restoreFocusEl = document.activeElement as HTMLElement;
        const items = menuItems();
        items[0]?.focus();

        function onDocPointerDown(e: PointerEvent): void {
            if (menuEl && !menuEl.contains(e.target as Node)) close();
        }
        document.addEventListener('pointerdown', onDocPointerDown, true);
        return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
    });
</script>

{#if menu}
    <div
        bind:this={menuEl}
        class="fixed z-[60] min-w-[220px] max-h-[calc(100vh-16px)] overflow-y-auto bg-surface-800 border border-surface-700 rounded-lg shadow-2xl py-1 text-sm"
        style="left: {pos.left}px; top: {pos.top}px;"
        role="menu"
        tabindex="-1"
        aria-label={m.admin_livetv_context_menu_label()}
        onkeydown={handleKeydown}>
        {#if targetCount > 1}
            <div class="px-3 py-1.5 text-xs text-surface-500 border-b border-surface-700">
                {m.admin_livetv_selected_count({ count: targetCount })}
            </div>
        {/if}

        <button
            type="button"
            role="menuitem"
            class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2"
            onclick={() => store.contextMoveToTop(channelId)}>
            <Icon src={ArrowUp} class="w-4 h-4 text-surface-400" />
            {m.admin_livetv_context_move_top()}
        </button>
        <button
            type="button"
            role="menuitem"
            class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2"
            onclick={() => store.contextMoveToBottom(channelId)}>
            <Icon src={ArrowDown} class="w-4 h-4 text-surface-400" />
            {m.admin_livetv_context_move_bottom()}
        </button>

        <!-- Move to category submenu -->
        <div>
            <button
                type="button"
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={showCategorySub}
                class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                onclick={() => {
                    showCategorySub = !showCategorySub;
                    showQualitySub = false;
                    showFeedsSub = false;
                }}>
                <Icon src={FolderArrowDown} class="w-4 h-4 text-surface-400" />
                {m.admin_livetv_context_move_to_category()}
            </button>
            {#if showCategorySub}
                <div class="bg-surface-850 border-y border-surface-700">
                    <CategoryPicker
                        categories={pickerCategories}
                        onPick={(id, position) =>
                            store.contextMoveToCategory(channelId, id, position)} />
                </div>
            {/if}
        </div>

        <!-- Hide / Show -->
        <button
            type="button"
            role="menuitem"
            class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2"
            onclick={() => store.contextToggleVisibility(channelId)}>
            {#if isVisible}
                <Icon src={EyeSlash} class="w-4 h-4 text-surface-400" />
                {m.admin_livetv_bulk_hide()}
            {:else}
                <Icon src={Eye} class="w-4 h-4 text-surface-400" />
                {m.admin_livetv_bulk_show()}
            {/if}
        </button>

        <!-- Set quality submenu -->
        <div>
            <button
                type="button"
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={showQualitySub}
                class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                onclick={() => {
                    showQualitySub = !showQualitySub;
                    showCategorySub = false;
                    showFeedsSub = false;
                }}>
                <Icon src={Sparkles} class="w-4 h-4 text-surface-400" />
                {m.admin_livetv_context_set_quality()}
            </button>
            {#if showQualitySub}
                <div class="bg-surface-850 border-y border-surface-700">
                    {#each qualityTiers as tier (tier.value)}
                        <button
                            type="button"
                            role="menuitem"
                            class="w-full px-6 py-1.5 text-left text-surface-300 hover:bg-surface-700 hover:text-white"
                            onclick={() => store.contextSetQuality(channelId, tier.value)}>
                            {tier.label()}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>

        <!-- Feeds of this station: play one, or make it the primary -->
        {#if feeds.length > 1}
            <div>
                <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="true"
                    aria-expanded={showFeedsSub}
                    class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2"
                    onclick={() => {
                        showFeedsSub = !showFeedsSub;
                        showCategorySub = false;
                        showQualitySub = false;
                    }}>
                    <Icon src={Signal} class="w-4 h-4 text-surface-400" />
                    {m.admin_livetv_context_feeds()}
                </button>
                {#if showFeedsSub}
                    <ul class="bg-surface-850 border-y border-surface-700 py-1" role="none">
                        {#each feeds as feed (feed.id)}
                            {@const isPrimary = feed.groupPrimaryChannelId === feed.id}
                            <li class="px-3 py-1" role="none">
                                <button
                                    type="button"
                                    role="menuitem"
                                    class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-700 {feed.id ===
                                    channelId
                                        ? 'text-white'
                                        : 'text-surface-300'}"
                                    aria-label={m.admin_livetv_feed_play({ name: feedName(feed) })}
                                    onclick={() => playFeed(feed.id)}>
                                    <span class="min-w-0 flex-1 truncate">{feedName(feed)}</span>
                                    {#if feed.qualityTier}
                                        <span
                                            class="shrink-0 rounded bg-surface-700 px-1 text-[10px] font-semibold uppercase"
                                            >{feed.qualityTier}</span>
                                    {/if}
                                </button>
                                <div class="flex flex-wrap items-center gap-x-2 px-2 text-[11px]">
                                    {#if isPrimary}
                                        <span class="text-primary-300"
                                            >{m.admin_livetv_backup_group_primary()}</span>
                                    {/if}
                                    {#if feed.id === shownFeedId}
                                        <span class="text-green-400"
                                            >{m.livetv_feed_default()}</span>
                                    {/if}
                                    {#if !feed.isVisible}
                                        <span class="text-surface-500"
                                            >{m.admin_livetv_feed_hidden()}</span>
                                    {/if}
                                    {#if isDegradedFeedName(feed.name)}
                                        <span class="text-amber-300"
                                            >{m.livetv_feed_degraded()}</span>
                                    {/if}
                                    {#if !isPrimary}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            class="ml-auto flex items-center gap-1 rounded px-1 text-surface-300 hover:bg-surface-700 hover:text-white"
                                            aria-label={m.admin_livetv_feed_make_primary_named({
                                                name: feedName(feed),
                                            })}
                                            onclick={() => makePrimary(feed.id)}>
                                            <Icon src={Star} class="w-3 h-3" />
                                            {m.admin_livetv_feed_make_primary()}
                                        </button>
                                    {/if}
                                </div>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </div>
        {/if}

        <!-- Select -->
        <button
            type="button"
            role="menuitem"
            class="w-full px-3 py-2 text-left text-surface-200 hover:bg-surface-700 flex items-center gap-2 border-t border-surface-700"
            onclick={() => store.contextSelect(channelId)}>
            <Icon src={CheckCircle} class="w-4 h-4 text-surface-400" />
            {m.admin_livetv_select()}
        </button>
    </div>
{/if}
