<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        Eye,
        EyeSlash,
        Check,
        XMark,
        Link,
        ExclamationTriangle,
        Bars3,
        EllipsisVertical,
    } from 'svelte-hero-icons';
    import type { AdminChannel } from '$lib/schemas/livetv.js';
    import type { ChannelViewerStatus } from './channel-viewer-status.js';
    import * as m from '$lib/paraglide/messages.js';
    import { markLogoFailed, usableLogo } from '$lib/components/livetv/failed-logos.svelte.js';
    import { channelEpgStatus } from './channel-epg-status.js';
    import ChannelNumberBadge from './ChannelNumberBadge.svelte';
    import FeedHealthBadge from './FeedHealthBadge.svelte';

    interface Props {
        channel: AdminChannel;
        mode: 'table' | 'card';
        /**
         * Why this row does or does not reach viewers. Only the backup group's
         * primary is served, so a "visible" row can still be withheld — without
         * this the eye icon is the only signal and it would be lying.
         */
        viewerStatus?: ChannelViewerStatus;
        showDragHandle?: boolean;
        isSelectionMode?: boolean;
        isSelected?: boolean;
        /** Size of the active multi-select group (>1 shows a badge on selected rows). */
        groupDragCount?: number;
        onKeyboardReorder?: (direction: 'up' | 'down') => void;
        onToggleSelect?: (channelId: string) => void;
        onVisibilityToggle?: (channelId: string, newState: boolean) => void;
        onNameUpdate?: (channelId: string, newName: string) => Promise<void>;
        onQualityUpdate?: (channelId: string, newTier: string) => Promise<void>;
        onContextMenu?: (channelId: string, x: number, y: number) => void;
        /** Channel numbers (the station's; all feeds of a backup group share it). */
        onNumberSave?: (channelId: string, number: number) => Promise<unknown>;
        onNumberUnpin?: (channelId: string) => Promise<unknown>;
        /** Clears the feed's failure streak (shown as a Reset button on failing/offline feeds). */
        onHealthReset?: (channelId: string) => Promise<unknown>;
    }

    let {
        channel,
        mode,
        viewerStatus,
        showDragHandle = false,
        isSelectionMode = false,
        isSelected = false,
        groupDragCount = 0,
        onKeyboardReorder,
        onToggleSelect,
        onVisibilityToggle,
        onNameUpdate,
        onQualityUpdate,
        onContextMenu,
        onNumberSave,
        onNumberUnpin,
        onHealthReset,
    }: Props = $props();

    let epgStatus = $derived(channelEpgStatus(channel));
    let epgLabel = $derived.by((): string => {
        switch (epgStatus) {
            case 'matched':
                return m.admin_livetv_epg_matched();
            case 'shared':
                return m.admin_livetv_epg_shared();
            case 'low':
                return m.admin_livetv_epg_confidence_medium();
            case 'unmatched':
                return m.admin_livetv_epg_unmatched();
        }
    });
    let epgClass = $derived(
        epgStatus === 'matched' || epgStatus === 'shared' ? 'text-green-400' : 'text-amber-400',
    );
    let epgTitle = $derived(
        channel.epgMatchConfidence === undefined
            ? undefined
            : m.admin_livetv_epg_confidence_percent({
                  percent: Math.round(channel.epgMatchConfidence * 100),
              }),
    );
    let hasBackup = $derived(!!channel.backupGroupId);

    /** Null when the row needs no warning (shown to viewers, or plainly hidden). */
    let viewerWarning = $derived.by((): string | null => {
        switch (viewerStatus?.kind) {
            case 'superseded':
                // The feed viewers get can be outside a source-filtered payload,
                // so the name is optional — the row is withheld either way.
                return viewerStatus.shownName === undefined
                    ? m.admin_livetv_not_shown_superseded_unnamed()
                    : m.admin_livetv_not_shown_superseded({
                          primaryName: viewerStatus.shownName,
                      });
            case 'category-hidden':
                return m.admin_livetv_not_shown_category_hidden();
            default:
                return null;
        }
    });
    // On a selected row while a multi-select group exists, the handle shows the group size
    // to signal that dragging it moves the whole group.
    let showGroupBadge = $derived(isSelectionMode && isSelected && groupDragCount > 1);

    // --- Inline name editing state ---
    let isEditingName = $state(false);
    let editNameValue = $state('');
    let isSavingName = $state(false);

    // --- Quality picker state ---
    let isQualityPickerOpen = $state(false);

    // --- Saved highlight animation ---
    let showSavedHighlight = $state(false);

    const qualityColors: Record<string, string> = {
        uhd: 'bg-purple-900/50 text-purple-300 border-purple-700/50',
        fhd: 'bg-blue-900/50 text-blue-300 border-blue-700/50',
        hd: 'bg-green-900/50 text-green-300 border-green-700/50',
        sd: 'bg-surface-700/50 text-surface-400 border-surface-600/50',
    };

    const qualityLabels: Record<string, () => string> = {
        uhd: () => m.admin_livetv_quality_uhd(),
        fhd: () => m.admin_livetv_quality_fhd(),
        hd: () => m.admin_livetv_quality_hd(),
        sd: () => m.admin_livetv_quality_sd(),
    };

    const qualityTiers = ['uhd', 'fhd', 'hd', 'sd'] as const;

    function autoFocus(node: HTMLElement): void {
        node.focus();
    }

    function handleDragHandleKeydown(e: KeyboardEvent): void {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onKeyboardReorder?.(e.key === 'ArrowUp' ? 'up' : 'down');
        } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
            // Keyboard-open the context menu anchored to the focused handle.
            e.preventDefault();
            openContextMenuAt(e.currentTarget as HTMLElement);
        }
    }

    function openContextMenuAt(anchor: HTMLElement): void {
        const rect = anchor.getBoundingClientRect();
        onContextMenu?.(channel.id, rect.left, rect.bottom);
    }

    function handleContextMenu(e: MouseEvent): void {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(channel.id, e.clientX, e.clientY);
    }

    function toggleVisibility(e: Event): void {
        e.stopPropagation();
        onVisibilityToggle?.(channel.id, !channel.isVisible);
    }

    function handleRowClick(): void {
        if (isSelectionMode) {
            onToggleSelect?.(channel.id);
        }
    }

    // --- Name editing ---

    function startNameEdit(e: Event): void {
        e.stopPropagation();
        if (isSelectionMode) return;
        isEditingName = true;
        editNameValue = channel.adminDisplayName ?? channel.name;
    }

    async function saveNameEdit(): Promise<void> {
        const trimmed = editNameValue.trim();
        if (!trimmed || trimmed === (channel.adminDisplayName ?? channel.name)) {
            isEditingName = false;
            return;
        }
        isSavingName = true;
        try {
            await onNameUpdate?.(channel.id, trimmed);
            showSavedHighlight = true;
            setTimeout(() => {
                showSavedHighlight = false;
            }, 1500);
        } finally {
            isSavingName = false;
            isEditingName = false;
        }
    }

    function handleNameKeydown(e: KeyboardEvent): void {
        if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
            editNameValue = channel.adminDisplayName ?? channel.name;
            isEditingName = false;
        }
    }

    // --- Quality picker ---

    function toggleQualityPicker(e: Event): void {
        e.stopPropagation();
        if (isSelectionMode) return;
        isQualityPickerOpen = !isQualityPickerOpen;
    }

    function handleQualitySelect(tier: string): void {
        isQualityPickerOpen = false;
        if (tier === channel.qualityTier) return;
        onQualityUpdate?.(channel.id, tier);
    }

    function handleQualityPickerKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            isQualityPickerOpen = false;
        }
    }

    // Close quality picker on outside click
    $effect(() => {
        if (!isQualityPickerOpen) return;
        function handleClickOutside(e: MouseEvent): void {
            const target = e.target as HTMLElement;
            if (!target.closest('.quality-picker-container')) {
                isQualityPickerOpen = false;
            }
        }
        document.addEventListener('click', handleClickOutside, true);
        return () => document.removeEventListener('click', handleClickOutside, true);
    });
</script>

{#if mode === 'table'}
    <!-- Grid row (div-based for DnD compatibility) -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="channel-grid-row hover:bg-surface-800/30 {isSelectionMode
            ? 'selecting'
            : ''} {channel.isVisible ? '' : 'opacity-60'} {isSelected
            ? 'bg-yellow-900/20'
            : ''} {showSavedHighlight ? 'saved-highlight' : ''}"
        data-channel-id={channel.id}
        onclick={handleRowClick}
        oncontextmenu={handleContextMenu}>
        {#if isSelectionMode}
            <div class="flex items-center justify-center">
                <input
                    type="checkbox"
                    checked={isSelected}
                    onchange={() => onToggleSelect?.(channel.id)}
                    onclick={(e) => e.stopPropagation()}
                    class="w-4 h-4 rounded border-surface-600 bg-surface-700 text-yellow-500 focus:ring-yellow-500" />
            </div>
        {/if}
        <div class="flex items-center justify-center">
            {#if showDragHandle}
                <div
                    class="relative cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 p-1"
                    tabindex="0"
                    role="button"
                    aria-label={m.admin_livetv_reorder_handle_tooltip()}
                    title={m.admin_livetv_reorder_handle_tooltip()}
                    onkeydown={handleDragHandleKeydown}>
                    <Icon src={Bars3} class="w-4 h-4" />
                    {#if showGroupBadge}
                        <span
                            aria-hidden="true"
                            class="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 flex items-center justify-center rounded-full bg-yellow-500 text-surface-900 text-[9px] font-bold leading-none">
                            {groupDragCount}
                        </span>
                    {/if}
                </div>
            {/if}
        </div>
        <div class="flex items-center px-4 py-2">
            {#if usableLogo(channel.images?.primary?.href)}
                <img
                    src={channel.images?.primary?.href}
                    alt=""
                    class="w-6 h-6 rounded object-contain bg-surface-900"
                    width="24"
                    height="24"
                    loading="lazy"
                    onerror={() => markLogoFailed(channel.images?.primary?.href)} />
            {:else}
                <div class="w-6 h-6 rounded bg-surface-700 flex items-center justify-center">
                    <svg
                        class="w-4 h-4 text-surface-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="1.5">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125z" />
                    </svg>
                </div>
            {/if}
        </div>
        <div class="flex items-center px-4 py-2 min-w-0">
            {#if onNumberSave && onNumberUnpin}
                <ChannelNumberBadge
                    {channel}
                    disabled={isSelectionMode}
                    onSave={onNumberSave}
                    onUnpin={onNumberUnpin} />
            {/if}
            {#if isEditingName}
                <input
                    type="text"
                    bind:value={editNameValue}
                    onblur={saveNameEdit}
                    onkeydown={handleNameKeydown}
                    onclick={(e) => e.stopPropagation()}
                    disabled={isSavingName}
                    placeholder={m.admin_livetv_edit_name_placeholder()}
                    class="w-full bg-surface-700 border border-surface-600 rounded px-2 py-0.5 text-white text-sm focus:outline-none focus:border-yellow-500 {isSavingName
                        ? 'opacity-60'
                        : ''}"
                    aria-label={m.admin_livetv_edit_name()}
                    use:autoFocus />
            {:else}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="text-white truncate {isSelectionMode
                        ? ''
                        : 'cursor-pointer hover:bg-surface-700/50 rounded px-1 -mx-1'}"
                    title={channel.name}
                    onclick={startNameEdit}>
                    {channel.adminDisplayName ?? channel.name}
                </div>
            {/if}
            {#if viewerWarning}
                <div
                    class="flex items-center gap-1 mt-0.5 text-[11px] leading-tight text-amber-400"
                    data-testid="viewer-warning">
                    <Icon src={ExclamationTriangle} class="w-3 h-3 shrink-0" />
                    <span class="truncate" title={viewerWarning}>{viewerWarning}</span>
                </div>
            {/if}
            <FeedHealthBadge
                health={channel.health}
                onReset={onHealthReset ? () => onHealthReset(channel.id) : undefined} />
        </div>
        <div class="flex items-center px-4 py-2 relative quality-picker-container">
            {#if channel.qualityTier}
                <span
                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border {qualityColors[
                        channel.qualityTier
                    ] ?? ''} {isSelectionMode
                        ? ''
                        : 'cursor-pointer hover:ring-1 hover:ring-surface-500'}"
                    onclick={toggleQualityPicker}
                    onkeydown={handleQualityPickerKeydown}
                    tabindex="0"
                    role="button">
                    {qualityLabels[channel.qualityTier]?.() ?? channel.qualityTier.toUpperCase()}
                </span>
            {:else}
                <span
                    class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-surface-600 text-surface-500 {isSelectionMode
                        ? ''
                        : 'cursor-pointer hover:ring-1 hover:ring-surface-500'}"
                    onclick={toggleQualityPicker}
                    onkeydown={handleQualityPickerKeydown}
                    tabindex="0"
                    role="button">
                    —
                </span>
            {/if}
            {#if isQualityPickerOpen}
                <div
                    class="absolute top-full left-4 mt-1 z-50 bg-surface-800 border border-surface-600 rounded-lg shadow-lg py-1 min-w-[80px]">
                    {#each qualityTiers as tier (tier)}
                        <button
                            type="button"
                            class="w-full px-3 py-1.5 text-left text-xs hover:bg-surface-700 flex items-center gap-2"
                            onclick={() => handleQualitySelect(tier)}>
                            <span
                                class="inline-block w-2 h-2 rounded-full {qualityColors[
                                    tier
                                ]?.split(' ')[0] ?? ''}"></span>
                            <span
                                class={channel.qualityTier === tier
                                    ? 'text-white font-medium'
                                    : 'text-surface-300'}>
                                {qualityLabels[tier]?.() ?? tier.toUpperCase()}
                            </span>
                            {#if channel.qualityTier === tier}
                                <Icon src={Check} class="w-3 h-3 text-yellow-400 ml-auto" />
                            {/if}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
        <div class="flex items-center justify-center px-4 py-2">
            <button
                type="button"
                class="p-1 hover:bg-surface-700 rounded"
                onclick={toggleVisibility}
                aria-label={channel.isVisible
                    ? m.admin_livetv_bulk_hide()
                    : m.admin_livetv_bulk_show()}>
                {#if channel.isVisible}
                    <Icon src={Eye} class="w-4 h-4 text-green-400" />
                {:else}
                    <Icon src={EyeSlash} class="w-4 h-4 text-surface-500" />
                {/if}
            </button>
        </div>
        <div class="flex items-center px-2 py-2">
            <span
                class="flex items-center gap-1 whitespace-nowrap text-xs {epgClass}"
                title={epgTitle}>
                <Icon src={epgStatus === 'unmatched' ? XMark : Check} class="w-4 h-4" />
                {epgLabel}
            </span>
        </div>
        <div class="flex items-center justify-center px-4 py-2">
            {#if hasBackup}
                <Icon
                    src={Link}
                    class="w-4 h-4 text-blue-400"
                    aria-label={m.admin_livetv_in_backup_group()}
                    title={m.admin_livetv_in_backup_group()} />
            {/if}
        </div>
    </div>
{:else}
    <!-- Mobile card -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="px-4 py-3 {channel.isVisible ? '' : 'opacity-60'} {isSelected
            ? 'bg-yellow-900/20'
            : ''} {showSavedHighlight ? 'saved-highlight' : ''}"
        data-channel-id={channel.id}
        onclick={handleRowClick}
        oncontextmenu={handleContextMenu}>
        <div class="flex items-center gap-3">
            {#if isSelectionMode}
                <input
                    type="checkbox"
                    checked={isSelected}
                    onchange={() => onToggleSelect?.(channel.id)}
                    onclick={(e) => e.stopPropagation()}
                    class="w-4 h-4 rounded border-surface-600 bg-surface-700 text-yellow-500 focus:ring-yellow-500 shrink-0" />
            {/if}
            {#if showDragHandle}
                <div
                    class="relative cursor-grab active:cursor-grabbing text-surface-500 hover:text-surface-300 shrink-0 p-1"
                    tabindex="0"
                    role="button"
                    aria-label={m.admin_livetv_reorder_handle_tooltip()}
                    title={m.admin_livetv_reorder_handle_tooltip()}
                    onkeydown={handleDragHandleKeydown}>
                    <Icon src={Bars3} class="w-5 h-5" />
                    {#if showGroupBadge}
                        <span
                            aria-hidden="true"
                            class="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-0.5 flex items-center justify-center rounded-full bg-yellow-500 text-surface-900 text-[9px] font-bold leading-none">
                            {groupDragCount}
                        </span>
                    {/if}
                </div>
            {/if}
            {#if usableLogo(channel.images?.primary?.href)}
                <img
                    src={channel.images?.primary?.href}
                    alt=""
                    class="w-8 h-8 rounded object-contain bg-surface-900 shrink-0"
                    width="32"
                    height="32"
                    loading="lazy"
                    onerror={() => markLogoFailed(channel.images?.primary?.href)} />
            {:else}
                <div
                    class="w-8 h-8 rounded bg-surface-700 flex items-center justify-center shrink-0">
                    <svg
                        class="w-5 h-5 text-surface-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="1.5">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125z" />
                    </svg>
                </div>
            {/if}
            {#if onNumberSave && onNumberUnpin}
                <ChannelNumberBadge
                    {channel}
                    disabled={isSelectionMode}
                    onSave={onNumberSave}
                    onUnpin={onNumberUnpin} />
            {/if}
            <div class="flex-1 min-w-0">
                {#if isEditingName}
                    <input
                        type="text"
                        bind:value={editNameValue}
                        onblur={saveNameEdit}
                        onkeydown={handleNameKeydown}
                        onclick={(e) => e.stopPropagation()}
                        disabled={isSavingName}
                        placeholder={m.admin_livetv_edit_name_placeholder()}
                        class="w-full bg-surface-700 border border-surface-600 rounded px-2 py-0.5 text-white text-sm focus:outline-none focus:border-yellow-500 {isSavingName
                            ? 'opacity-60'
                            : ''}"
                        aria-label={m.admin_livetv_edit_name()}
                        use:autoFocus />
                {:else}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span
                        class="text-white text-sm truncate block {isSelectionMode
                            ? ''
                            : 'cursor-pointer hover:bg-surface-700/50 rounded px-1 -mx-1'}"
                        onclick={startNameEdit}>
                        {channel.adminDisplayName ?? channel.name}
                    </span>
                {/if}
                {#if viewerWarning}
                    <div
                        class="flex items-center gap-1 mt-0.5 text-[11px] leading-tight text-amber-400"
                        data-testid="viewer-warning">
                        <Icon src={ExclamationTriangle} class="w-3 h-3 shrink-0" />
                        <span class="truncate" title={viewerWarning}>{viewerWarning}</span>
                    </div>
                {/if}
                <FeedHealthBadge
                    health={channel.health}
                    onReset={onHealthReset ? () => onHealthReset(channel.id) : undefined} />
            </div>
            <div class="relative quality-picker-container shrink-0">
                {#if channel.qualityTier}
                    <span
                        class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border {qualityColors[
                            channel.qualityTier
                        ] ?? ''} {isSelectionMode
                            ? ''
                            : 'cursor-pointer hover:ring-1 hover:ring-surface-500'}"
                        onclick={toggleQualityPicker}
                        onkeydown={handleQualityPickerKeydown}
                        tabindex="0"
                        role="button">
                        {qualityLabels[channel.qualityTier]?.() ??
                            channel.qualityTier.toUpperCase()}
                    </span>
                {:else}
                    <span
                        class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-surface-600 text-surface-500 {isSelectionMode
                            ? ''
                            : 'cursor-pointer hover:ring-1 hover:ring-surface-500'}"
                        onclick={toggleQualityPicker}
                        tabindex="0"
                        role="button">
                        —
                    </span>
                {/if}
                {#if isQualityPickerOpen}
                    <div
                        class="absolute top-full right-0 mt-1 z-50 bg-surface-800 border border-surface-600 rounded-lg shadow-lg py-1 min-w-[80px]">
                        {#each qualityTiers as tier (tier)}
                            <button
                                type="button"
                                class="w-full px-3 py-1.5 text-left text-xs hover:bg-surface-700 flex items-center gap-2"
                                onclick={() => handleQualitySelect(tier)}>
                                <span
                                    class="inline-block w-2 h-2 rounded-full {qualityColors[
                                        tier
                                    ]?.split(' ')[0] ?? ''}"></span>
                                <span
                                    class={channel.qualityTier === tier
                                        ? 'text-white font-medium'
                                        : 'text-surface-300'}>
                                    {qualityLabels[tier]?.() ?? tier.toUpperCase()}
                                </span>
                                {#if channel.qualityTier === tier}
                                    <Icon src={Check} class="w-3 h-3 text-yellow-400 ml-auto" />
                                {/if}
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
        </div>
        <div
            class="flex items-center gap-4 mt-1.5 {showDragHandle
                ? 'ml-16'
                : isSelectionMode
                  ? 'ml-15'
                  : 'ml-11'} text-xs">
            <button
                type="button"
                class="p-0.5 hover:bg-surface-700 rounded"
                onclick={toggleVisibility}
                aria-label={channel.isVisible
                    ? m.admin_livetv_bulk_hide()
                    : m.admin_livetv_bulk_show()}>
                {#if channel.isVisible}
                    <span class="text-green-400"
                        ><Icon src={Eye} class="w-3.5 h-3.5 inline" /></span>
                {:else}
                    <span class="text-surface-500"
                        ><Icon src={EyeSlash} class="w-3.5 h-3.5 inline" /></span>
                {/if}
            </button>
            <span class={epgClass} title={epgTitle}
                ><Icon src={epgStatus === 'unmatched' ? XMark : Check} class="w-3.5 h-3.5 inline" />
                {epgLabel}</span>
            {#if hasBackup}
                <span class="text-blue-400" title={m.admin_livetv_in_backup_group()}>
                    <Icon
                        src={Link}
                        class="w-3.5 h-3.5 inline"
                        aria-label={m.admin_livetv_in_backup_group()} />
                </span>
            {/if}
            {#if onContextMenu}
                <button
                    type="button"
                    class="ml-auto p-0.5 -my-0.5 rounded hover:bg-surface-700 text-surface-400 hover:text-white"
                    aria-label={m.admin_livetv_context_menu_open()}
                    onclick={(e) => {
                        e.stopPropagation();
                        openContextMenuAt(e.currentTarget);
                    }}>
                    <Icon src={EllipsisVertical} class="w-4 h-4" />
                </button>
            {/if}
        </div>
    </div>
{/if}

<style>
    /* Columns live in this component's own scoped CSS (not an inherited --channel-grid var)
       so the row keeps its grid layout even when svelte-dnd-action clones it onto
       document.body as the drag image — otherwise the var is undefined off-tree and the
       cells collapse into a stacked box. Must match ChannelPane's .channel-grid-header. */
    .channel-grid-row {
        display: grid;
        grid-template-columns: 40px 56px 1fr 80px 60px 128px 72px;
        border-bottom: 1px solid rgb(55, 65, 81);
    }
    .channel-grid-row.selecting {
        grid-template-columns: 32px 40px 56px 1fr 80px 60px 128px 72px;
    }

    @keyframes saved-highlight {
        from {
            background-color: rgb(34 197 94 / 0.15);
        }
        to {
            background-color: transparent;
        }
    }

    .saved-highlight {
        animation: saved-highlight 1.5s ease-out;
    }
</style>
