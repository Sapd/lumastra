<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts" module>
    export interface PickerCategory {
        id: string;
        name: string;
        count: number;
    }
</script>

<script lang="ts">
    // "Move to category" picker shared by the channel context menu and the bulk
    // action bar. A large lineup has ~35 genre categories, too many to scan in a
    // plain list: type to narrow it, arrows + Enter to pick, and choose whether the
    // channels go to the end or the top of the category.
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        categories: PickerCategory[];
        onPick: (categoryId: string, position: 'top' | 'bottom') => void;
        /** Search field text; defaults to "Find a category…". */
        placeholder?: string;
        /** Offer "At the end / At the top" (off for a list that has no order, e.g. groups). */
        showPosition?: boolean;
    }

    let { categories, onPick, placeholder, showPosition = true }: Props = $props();
    let searchLabel = $derived(placeholder ?? m.admin_livetv_move_search());

    let query = $state('');
    let position = $state<'top' | 'bottom'>('bottom');
    let activeIndex = $state(0);
    let inputEl = $state<HTMLInputElement | null>(null);
    const uid = $props.id();
    const listId = `category-picker-${uid}`;

    // Names starting with the query first, then the rest that contain it.
    let matches = $derived.by(() => {
        const q = query.trim().toLowerCase();
        if (!q) return categories;
        const starts: PickerCategory[] = [];
        const contains: PickerCategory[] = [];
        for (const cat of categories) {
            const name = cat.name.toLowerCase();
            if (name.startsWith(q)) starts.push(cat);
            else if (name.includes(q)) contains.push(cat);
        }
        return [...starts, ...contains];
    });

    // Focus the search with a mouse/trackpad; on touch it would pop the keyboard
    // over the bulk bar's list.
    $effect(() => {
        if (globalThis.matchMedia?.('(pointer: coarse)').matches) return;
        inputEl?.focus();
    });

    function setQuery(value: string): void {
        query = value;
        activeIndex = 0;
    }

    function pick(cat: PickerCategory | undefined): void {
        if (cat) onPick(cat.id, position);
    }

    // The list can shrink under the highlight (typing, a counts refresh).
    let current = $derived(Math.max(0, Math.min(activeIndex, matches.length - 1)));

    function handleKeydown(e: KeyboardEvent): void {
        if (e.isComposing) return;
        if (e.key === 'Escape' && query) {
            // First Escape clears the search; the next one closes the surrounding menu.
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            activeIndex = Math.max(0, Math.min(current + 1, matches.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            activeIndex = Math.max(current - 1, 0);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            pick(matches[current]);
        } else if (e.key !== 'Escape' && e.key !== 'Tab') {
            // Typing, Home/End stay in the field; a surrounding menu must not take them.
            e.stopPropagation();
            return;
        } else {
            return;
        }
        e.stopPropagation();
        document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' });
    }
</script>

<div class="category-picker p-2 space-y-2">
    <input
        bind:this={inputEl}
        type="text"
        value={query}
        oninput={(e) => setQuery(e.currentTarget.value)}
        onkeydown={handleKeydown}
        placeholder={searchLabel}
        aria-label={searchLabel}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={matches.length > 0 ? `${listId}-${current}` : undefined}
        class="w-full px-2 py-1.5 text-sm bg-surface-700 border border-surface-600 rounded text-white placeholder-surface-500 focus:outline-none focus:border-yellow-500" />
    {#if showPosition}
        <div class="flex gap-1 text-xs" role="group" aria-label={m.admin_livetv_move_position()}>
            <button
                type="button"
                class="flex-1 px-2 py-1 rounded {position === 'bottom'
                    ? 'bg-surface-600 text-white'
                    : 'bg-surface-700/50 text-surface-400 hover:text-surface-200'}"
                aria-pressed={position === 'bottom'}
                onclick={() => (position = 'bottom')}>
                {m.admin_livetv_move_position_bottom()}
            </button>
            <button
                type="button"
                class="flex-1 px-2 py-1 rounded {position === 'top'
                    ? 'bg-surface-600 text-white'
                    : 'bg-surface-700/50 text-surface-400 hover:text-surface-200'}"
                aria-pressed={position === 'top'}
                onclick={() => (position = 'top')}>
                {m.admin_livetv_move_position_top()}
            </button>
        </div>
    {/if}
    <ul id={listId} role="listbox" class="max-h-56 overflow-y-auto -mx-2">
        {#each matches as cat, i (cat.id)}
            <!-- Keyboard picks through the search field (combobox + aria-activedescendant). -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
                id="{listId}-{i}"
                role="option"
                aria-selected={i === current}
                class="flex items-center gap-2 px-4 py-1.5 text-sm cursor-pointer {i === current
                    ? 'bg-surface-700 text-white'
                    : 'text-surface-300 hover:bg-surface-700 hover:text-white'}"
                onclick={() => pick(cat)}
                onpointermove={() => (activeIndex = i)}>
                <span class="truncate flex-1">{cat.name}</span>
                <span class="text-xs text-surface-500 tabular-nums">{cat.count}</span>
            </li>
        {/each}
        {#if matches.length === 0}
            <li class="px-4 py-1.5 text-xs text-surface-500">{m.admin_livetv_move_no_match()}</li>
        {/if}
    </ul>
</div>
