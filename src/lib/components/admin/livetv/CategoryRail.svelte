<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Category quick-jump for Channel Management. A large lineup has ~35 categories
    // and thousands of rows: the rail lists them with counts beside the list and marks
    // the one being scrolled through; where there is no room (phones, split view) the
    // same jump is a "Jump to…" select.
    import { dndzone, SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';
    import type { PickerCategory } from './CategoryPicker.svelte';
    import type { CategoryMove } from './channel-reconcile.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        categories: PickerCategory[];
        variant: 'rail' | 'select';
        activeId?: string | null;
        /** Height of the list beside it (px), so the rail ends where the list ends. */
        maxHeight?: number | null;
        onJump: (categoryId: string) => void;
        /**
         * Reorder the categories here: drag an entry, or Alt+↑/↓ (Home/End) on a
         * focused one. Off while a search narrows the list (it must hold them all).
         */
        reorderable?: boolean;
        onReorder?: (orderedIds: string[], movedId: string) => void;
        onMove?: (categoryId: string, move: CategoryMove) => void;
    }

    let {
        categories,
        variant,
        activeId = null,
        maxHeight = null,
        onJump,
        reorderable = false,
        onReorder,
        onMove,
    }: Props = $props();

    // Overridden by the drag zone while a drag is live.
    let items = $derived(categories.map((c) => ({ ...c })));

    function handleConsider(e: CustomEvent<{ items: PickerCategory[] }>): void {
        items = e.detail.items;
    }

    function handleFinalize(
        e: CustomEvent<{ items: PickerCategory[]; info: { id: string; trigger: string } }>,
    ): void {
        items = e.detail.items.filter((i) => i.id !== SHADOW_PLACEHOLDER_ITEM_ID);
        if (e.detail.info.trigger === 'droppedOutsideOfAny') return;
        onReorder?.(
            items.map((i) => i.id),
            e.detail.info.id,
        );
    }

    function handleKeydown(e: KeyboardEvent, id: string): void {
        if (!reorderable || !e.altKey) return;
        const move: CategoryMove | null =
            e.key === 'ArrowUp'
                ? 'up'
                : e.key === 'ArrowDown'
                  ? 'down'
                  : e.key === 'Home'
                    ? 'top'
                    : e.key === 'End'
                      ? 'bottom'
                      : null;
        if (!move) return;
        e.preventDefault();
        onMove?.(id, move);
    }

    let navEl = $state<HTMLElement | null>(null);

    // Keep the highlighted entry in view inside the rail (never scroll the page).
    $effect(() => {
        if (!navEl || !activeId) return;
        const btn = navEl.querySelector<HTMLElement>(`[data-rail-id="${activeId}"]`);
        if (!btn) return;
        const top = btn.offsetTop;
        const bottom = top + btn.offsetHeight;
        if (top < navEl.scrollTop) navEl.scrollTop = top;
        else if (bottom > navEl.scrollTop + navEl.clientHeight)
            navEl.scrollTop = bottom - navEl.clientHeight;
    });

    function handleSelect(e: Event & { currentTarget: HTMLSelectElement }): void {
        const id = e.currentTarget.value;
        e.currentTarget.value = '';
        if (id) onJump(id);
    }
</script>

{#if variant === 'rail'}
    <nav
        bind:this={navEl}
        aria-label={m.admin_livetv_category_rail()}
        style={maxHeight ? `max-height: ${maxHeight}px` : undefined}
        class="category-rail relative w-52 shrink-0 max-h-[calc(100vh-16rem)] overflow-y-auto rounded-lg bg-surface-800 py-1 text-sm">
        {#if reorderable}
            <p class="px-3 pb-1.5 pt-0.5 text-[11px] leading-tight text-surface-500">
                {m.admin_livetv_category_rail_reorder_hint()}
            </p>
        {/if}
        <div
            use:dndzone={{
                items,
                type: 'livetv-category-rail',
                flipDurationMs: 0,
                dragDisabled: !reorderable,
                dropTargetStyle: {},
                // The entries are buttons with their own keys (Alt+↑/↓): keep the
                // drag wrappers out of the Tab order and their roles neutral.
                zoneTabIndex: -1,
                zoneItemTabIndex: -1,
                autoAriaDisabled: true,
            }}
            data-rail-zone
            onconsider={handleConsider}
            onfinalize={handleFinalize}>
            {#each items as cat (cat.id)}
                <div role="none">
                    <button
                        type="button"
                        data-rail-id={cat.id}
                        aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                        onkeydown={(e) => handleKeydown(e, cat.id)}
                        aria-current={cat.id === activeId ? 'true' : undefined}
                        class="flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left transition-colors {cat.id ===
                        activeId
                            ? 'border-yellow-500 bg-surface-700/60 text-white'
                            : 'border-transparent text-surface-400 hover:bg-surface-700/40 hover:text-surface-200'}"
                        onclick={() => onJump(cat.id)}>
                        <span class="flex-1 truncate">{cat.name}</span>
                        <span class="text-xs tabular-nums text-surface-500">{cat.count}</span>
                    </button>
                </div>
            {/each}
        </div>
    </nav>
{:else}
    <select
        aria-label={m.admin_livetv_jump_to_category()}
        onchange={handleSelect}
        class="w-full rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 text-sm text-surface-200 focus:border-yellow-500 focus:outline-none">
        <option value="">{m.admin_livetv_jump_to_category()}</option>
        {#each categories as cat (cat.id)}
            <option value={cat.id}>{cat.name} ({cat.count})</option>
        {/each}
    </select>
{/if}
