<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { AdminChannelCategory } from '$lib/schemas/livetv.js';
    import ChannelPane from './ChannelPane.svelte';
    import ChannelActionBar from './ChannelActionBar.svelte';
    import ChannelContextMenu from './ChannelContextMenu.svelte';
    import { ChannelStore, setChannelStore } from './channel-store.svelte.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        categories: AdminChannelCategory[];
        /** Accepted for API compatibility with the page; the store derives expand defaults
         *  from the loaded categories, so this isn't read here. */
        totalChannels?: number;
        /** Reload the list after a channel-number change (it can move other rows too). */
        onNumbersChanged?: () => void;
    }

    let { categories, onNumbersChanged }: Props = $props();

    // Single source of truth, shared with the pane(s) via context.
    const store = new ChannelStore();
    setChannelStore(store);
    $effect(() => {
        store.onNumbersChanged = onNumbersChanged ?? null;
    });

    // Imperative seed (NOT $derived): a benign prop/refetch must not clobber an in-flight
    // optimistic mutation or drag (the store guards via isMutating + payload identity).
    $effect(() => {
        store.seed(categories);
    });

    // Client only (after hydration): the remembered "Show hidden" choice.
    $effect(() => {
        store.loadShowHidden();
    });

    // -------------------------------------------------------------------------
    // Split view — two side-by-side panes over the SAME store, each with its own
    // search box, so the operator can drag channels between filtered views.
    // Desktop only: two panes don't fit a phone (forced single below lg).
    // -------------------------------------------------------------------------
    let splitView = $state<'single' | 'split'>('single');
    let isWide = $state(false);

    $effect(() => {
        const mq = window.matchMedia('(min-width: 1024px)');
        isWide = mq.matches;
        const handler = (e: MediaQueryListEvent): void => {
            isWide = e.matches;
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    });

    let effectiveSplit = $derived(splitView === 'split' && isWide);

    // Surface the split-view tip only when the list is long enough that dragging a channel a
    // long distance is actually painful (and only in single view, where it helps).
    let totalChannels = $derived(store.categories.reduce((n, cat) => n + cat.channels.length, 0));
    let showSingleTip = $derived(isWide && !effectiveSplit && totalChannels > 50);
</script>

<div class="space-y-3">
    {#if isWide}
        <div class="flex items-center justify-end gap-3">
            {#if effectiveSplit}
                <span class="text-xs text-surface-500 mr-auto">
                    {m.admin_livetv_view_split_hint()}
                </span>
            {:else if showSingleTip}
                <span class="text-xs text-surface-500 mr-auto">
                    {m.admin_livetv_view_single_hint()}
                </span>
            {/if}
            <div class="view-toggle" role="group" aria-label={m.admin_livetv_view_layout()}>
                <button
                    type="button"
                    class="toggle-seg {splitView === 'single' ? 'active' : ''}"
                    onclick={() => (splitView = 'single')}
                    aria-pressed={splitView === 'single'}
                    title={m.admin_livetv_view_single()}>
                    <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <rect x="1" y="2" width="14" height="2.5" rx="1" />
                        <rect x="1" y="6.5" width="14" height="2.5" rx="1" />
                        <rect x="1" y="11" width="14" height="2.5" rx="1" />
                    </svg>
                    {m.admin_livetv_view_single()}
                </button>
                <button
                    type="button"
                    class="toggle-seg {splitView === 'split' ? 'active' : ''}"
                    onclick={() => (splitView = 'split')}
                    aria-pressed={splitView === 'split'}
                    title={m.admin_livetv_view_split_hint()}>
                    <svg class="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <rect x="1" y="1" width="6" height="14" rx="1" />
                        <rect x="9" y="1" width="6" height="6" rx="1" />
                        <rect x="9" y="9" width="6" height="6" rx="1" />
                    </svg>
                    {m.admin_livetv_view_split()}
                </button>
            </div>
        </div>
    {/if}

    <div class={effectiveSplit ? 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start' : ''}>
        <!-- The category rail needs room: single view only; split panes get a Jump to… list. -->
        <ChannelPane showRail={isWide && !effectiveSplit} />
        {#if effectiveSplit}
            <ChannelPane isSecondary showRail={false} />
        {/if}
    </div>
</div>

<!-- Right-click / keyboard / touch context menu -->
{#if store.contextMenu}
    <ChannelContextMenu />
{/if}

<!-- Polite announcer for drag-free moves + keyboard reorder -->
<div class="sr-only" role="status" aria-live="polite">{store.announcement}</div>

<!-- Floating action bar when channels selected -->
{#if store.isSelectionMode && store.selectedCount > 0}
    <ChannelActionBar
        selectedCount={store.selectedCount}
        categories={store.categories}
        showHidden={store.showHidden}
        onBulkHide={() => store.bulkHide()}
        onBulkShow={() => store.bulkShow()}
        onBulkMoveToCategory={(id, position) => store.bulkMoveToCategory(id, position)}
        onBulkSetQuality={(q) => store.bulkSetQuality(q)}
        onDeselectAll={() => store.exitSelectionMode()} />
{/if}

<!-- Undo toast -->
{#if store.undoState}
    <div
        class="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-lg px-4 py-2.5 flex items-center gap-3 text-sm">
        <span class="text-surface-200">{store.undoState.message}</span>
        <button
            type="button"
            class="text-yellow-400 hover:text-yellow-300 font-medium"
            onclick={() => store.performUndo()}>
            {m.admin_livetv_undo()}
        </button>
    </div>
{/if}

<!-- Floating save status pill -->
{#if store.isSaving || store.showSaved}
    <div
        class="fixed bottom-6 right-6 z-50 px-4 py-2 rounded-full text-sm font-medium shadow-lg transition-opacity duration-300
            {store.isSaving ? 'bg-surface-700 text-surface-200' : 'bg-green-700/80 text-green-200'}
            {store.showSaved ? 'opacity-0' : 'opacity-100'}"
        style="transition-delay: {store.showSaved ? '1.7s' : '0s'}">
        {#if store.isSaving}
            {m.admin_livetv_saving()}
        {:else}
            {m.admin_livetv_saved()}
        {/if}
    </div>
{/if}

<style>
    /* Segmented Single|Split layout toggle — mirrors ModalSeasons' episode-layout toggle. */
    .view-toggle {
        display: flex;
        background: rgba(255, 255, 255, 0.07);
        border-radius: 6px;
        padding: 2px;
        gap: 2px;
        flex-shrink: 0;
    }

    .toggle-seg {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 3px 8px;
        border-radius: 4px;
        font-size: 11px;
        color: rgb(var(--color-surface-400-rgb));
        background: transparent;
        border: none;
        cursor: pointer;
        transition:
            background 120ms ease,
            color 120ms ease;
        white-space: nowrap;
    }

    .toggle-seg:hover {
        color: rgb(var(--color-surface-200-rgb));
    }

    .toggle-seg.active {
        background: rgba(255, 255, 255, 0.13);
        color: rgb(var(--color-surface-100-rgb));
    }
</style>
