<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, XMark, Plus } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    // Chip item type
    type ChipItem =
        | string
        | {
              id: string;
              label: string;
              color?: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';
          };

    // Additional classes
    interface Props {
        // Props
        items?: ChipItem[];
        // Allow removing chips
        removable?: boolean;
        // Allow adding chips
        addable?: boolean;
        // Placeholder for add input
        addPlaceholder?: string;
        // Maximum items (0 = unlimited)
        maxItems?: number;
        // Size
        size?: 'sm' | 'md';
        class?: string;
        onremove?: (detail: { item: ChipItem; index: number }) => void;
        onadd?: (detail: { value: string }) => void;
    }

    let {
        items = [],
        removable = false,
        addable = false,
        addPlaceholder = 'Add...',
        maxItems = 0,
        size = 'sm',
        class: className = '',
        onremove,
        onadd,
    }: Props = $props();

    // Normalize items to objects
    let normalizedItems = $derived(
        items.map((item, index) =>
            typeof item === 'string'
                ? {
                      id: `chip-${index}`,
                      label: item,
                      color: 'default' as const,
                  }
                : { ...item, color: item.color || ('default' as const) },
        ),
    );

    // Add input state
    let addInputValue = $state('');
    let showAddInput = $state(false);
    let addInputRef: HTMLInputElement | undefined = $state();

    // Size classes
    const chipSizeClasses: Record<typeof size, string> = {
        sm: 'px-2 py-0.5 text-xs gap-1',
        md: 'px-3 py-1 text-sm gap-1.5',
    };

    const iconSizeClasses: Record<typeof size, string> = {
        sm: 'w-3 h-3',
        md: 'w-4 h-4',
    };

    // Color classes
    const colorClasses: Record<string, string> = {
        default: 'bg-surface-700 text-surface-200 hover:bg-surface-600',
        primary: 'bg-primary-500/20 text-primary-300 hover:bg-primary-500/30',
        success: 'bg-green-500/20 text-green-300 hover:bg-green-500/30',
        warning: 'bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30',
        error: 'bg-red-500/20 text-red-300 hover:bg-red-500/30',
        info: 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30',
    };

    function handleRemove(item: ChipItem, index: number) {
        onremove?.({ item: items[index], index });
    }

    function handleAdd() {
        if (!addInputValue.trim()) return;
        if (maxItems > 0 && items.length >= maxItems) return;

        onadd?.({ value: addInputValue.trim() });
        addInputValue = '';
        showAddInput = false;
    }

    function handleAddKeydown(event: KeyboardEvent) {
        if (event.key === 'Enter') {
            event.preventDefault();
            handleAdd();
        } else if (event.key === 'Escape') {
            showAddInput = false;
            addInputValue = '';
        }
    }

    let canAdd = $derived(addable && (maxItems === 0 || items.length < maxItems));
</script>

<div class="chip-list flex flex-wrap gap-2 {className}">
    {#each normalizedItems as item, index (item.id)}
        <span
            class="chip inline-flex items-center rounded-full transition-colors {chipSizeClasses[
                size
            ]} {colorClasses[item.color]}">
            <span>{item.label}</span>

            {#if removable}
                <button
                    type="button"
                    onclick={() => handleRemove(item, index)}
                    class="ml-0.5 p-0.5 rounded-full hover:bg-black/20 transition-colors"
                    aria-label="Remove {item.label}">
                    <Icon src={XMark} class={iconSizeClasses[size]} />
                </button>
            {/if}
        </span>
    {/each}

    {#if canAdd}
        {#if showAddInput}
            <div class="flex items-center gap-1">
                <input
                    type="text"
                    bind:this={addInputRef}
                    bind:value={addInputValue}
                    onkeydown={handleAddKeydown}
                    onblur={() => {
                        if (!addInputValue) showAddInput = false;
                    }}
                    placeholder={addPlaceholder}
                    class="input input-sm w-24 py-0.5" />
                <button
                    type="button"
                    onclick={handleAdd}
                    disabled={!addInputValue.trim()}
                    class="p-1 rounded hover:bg-surface-700 disabled:opacity-50"
                    aria-label={m.ui_confirm_add_aria()}>
                    <Icon src={Plus} class={iconSizeClasses[size]} />
                </button>
            </div>
        {:else}
            <button
                type="button"
                onclick={() => {
                    showAddInput = true;
                    // Use tick to ensure DOM is updated before focusing
                    setTimeout(() => addInputRef?.focus(), 0);
                }}
                class="chip inline-flex items-center rounded-full border border-dashed border-surface-600 text-surface-500 hover:border-surface-500 hover:text-surface-400 transition-colors {chipSizeClasses[
                    size
                ]}">
                <Icon src={Plus} class={iconSizeClasses[size]} />
                <span>Add</span>
            </button>
        {/if}
    {/if}
</div>
