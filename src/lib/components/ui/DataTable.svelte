<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, ChevronUp, ChevronDown } from 'svelte-hero-icons';

    import { stopPropagation } from '$lib/utils/event-helpers';

    // Generic type for data rows
    type T = Record<string, unknown>;

    // Column definition
    type Column<T> = {
        key: keyof T | string;
        label: string;
        sortable?: boolean;
        width?: string;
        align?: 'left' | 'center' | 'right';
        // Custom cell renderer can be provided via slot
    };

    // Additional classes
    interface Props {
        // Props
        columns?: Column<T>[];
        data?: T[];
        loading?: boolean;
        emptyMessage?: string;
        // Sorting
        sortKey?: string;
        sortDirection?: 'asc' | 'desc';
        sortable?: boolean;
        // Row selection
        selectable?: boolean;
        selectedRows?: Set<number>;
        // Striped rows
        striped?: boolean;
        // Hover effect
        hoverable?: boolean;
        // Compact mode
        compact?: boolean;
        class?: string;
        actions?: import('svelte').Snippet<[{ row: T; index: number }]>;
        empty?: import('svelte').Snippet;
        cell?: import('svelte').Snippet<
            [{ column: Column<T>; row: T; index: number; value: unknown }]
        >;
        onsort?: (detail: { key: string; direction: 'asc' | 'desc' }) => void;
        onrowClick?: (detail: { row: T; index: number }) => void;
        onselect?: (detail: { selectedRows: Set<number> }) => void;
    }

    let {
        columns = [],
        data = [],
        loading = false,
        emptyMessage = 'No data available',
        sortKey = $bindable(''),
        sortDirection = $bindable('asc'),
        sortable = true,
        selectable = false,
        selectedRows = $bindable(new SvelteSet()),
        striped = true,
        hoverable = true,
        compact = false,
        class: className = '',
        actions,
        empty,
        cell,
        onsort,
        onrowClick,
        onselect,
    }: Props = $props();

    // Get value from row by key (supports nested keys like "user.name")
    function getValue(row: T, key: string): unknown {
        const keys = key.split('.');
        let value: unknown = row;
        for (const k of keys) {
            if (value && typeof value === 'object' && k in value) {
                value = (value as Record<string, unknown>)[k];
            } else {
                return undefined;
            }
        }
        return value;
    }

    // Handle column sort
    function handleSort(column: Column<T>): void {
        if (!sortable || !column.sortable) return;

        const key = String(column.key);
        if (sortKey === key) {
            sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            sortKey = key;
            sortDirection = 'asc';
        }

        onsort?.({ key: sortKey, direction: sortDirection });
    }

    // Handle row click
    function handleRowClick(row: T, index: number) {
        onrowClick?.({ row, index });
    }

    // Handle row selection
    function toggleRowSelection(index: number) {
        if (selectedRows.has(index)) {
            selectedRows.delete(index);
        } else {
            selectedRows.add(index);
        }
        selectedRows = new SvelteSet(selectedRows); // Trigger reactivity
        onselect?.({ selectedRows });
    }

    // Handle select all
    function toggleSelectAll() {
        if (selectedRows.size === data.length) {
            selectedRows.clear();
        } else {
            selectedRows = new SvelteSet(data.map((_, i) => i));
        }
        onselect?.({ selectedRows });
    }

    // Cell padding based on compact mode
    let cellPadding = $derived(compact ? 'px-3 py-2' : 'px-4 py-3');
    let headerPadding = $derived(compact ? 'px-3 py-2' : 'px-4 py-3');
</script>

<div class="data-table-wrapper overflow-x-auto {className}">
    <table class="w-full text-left">
        <thead class="bg-surface-800 border-b border-surface-700">
            <tr>
                {#if selectable}
                    <th class="{headerPadding} w-12">
                        <input
                            type="checkbox"
                            checked={selectedRows.size === data.length && data.length > 0}
                            indeterminate={selectedRows.size > 0 && selectedRows.size < data.length}
                            onchange={toggleSelectAll}
                            class="checkbox"
                            disabled={loading || data.length === 0} />
                    </th>
                {/if}

                {#each columns as column (column.key)}
                    <th
                        class="{headerPadding} text-sm font-medium text-surface-300 {column.align ===
                        'center'
                            ? 'text-center'
                            : column.align === 'right'
                              ? 'text-right'
                              : 'text-left'}"
                        style={column.width ? `width: ${column.width}` : ''}>
                        {#if sortable && column.sortable}
                            <button
                                type="button"
                                onclick={() => handleSort(column)}
                                class="inline-flex items-center gap-1 hover:text-white transition-colors">
                                <span>{column.label}</span>
                                <span class="w-4 h-4">
                                    {#if sortKey === String(column.key)}
                                        <Icon
                                            src={sortDirection === 'asc' ? ChevronUp : ChevronDown}
                                            class="w-4 h-4" />
                                    {/if}
                                </span>
                            </button>
                        {:else}
                            {column.label}
                        {/if}
                    </th>
                {/each}

                {#if actions}
                    <th class="{headerPadding} text-right text-sm font-medium text-surface-300">
                        Actions
                    </th>
                {/if}
            </tr>
        </thead>

        <tbody>
            {#if loading}
                <tr>
                    <td
                        colspan={columns.length + (selectable ? 1 : 0) + (actions ? 1 : 0)}
                        class="{cellPadding} text-center">
                        <div class="flex items-center justify-center gap-2 py-8">
                            <span class="loading-spinner loading-spinner-primary w-5 h-5"></span>
                            <span class="text-surface-400">Loading...</span>
                        </div>
                    </td>
                </tr>
            {:else if data.length === 0}
                <tr>
                    <td
                        colspan={columns.length + (selectable ? 1 : 0) + (actions ? 1 : 0)}
                        class="{cellPadding} text-center">
                        {#if empty}
                            {@render empty?.()}
                        {:else}
                            <div class="py-8 text-surface-500">
                                {emptyMessage}
                            </div>
                        {/if}
                    </td>
                </tr>
            {:else}
                {#each data as row, index (index)}
                    <tr
                        class="border-b border-surface-700/50 {striped && index % 2 === 1
                            ? 'bg-surface-800/30'
                            : ''} {hoverable ? 'hover:bg-surface-700/30' : ''} {selectedRows.has(
                            index,
                        )
                            ? 'bg-primary-500/10'
                            : ''}"
                        onclick={() => handleRowClick(row, index)}>
                        {#if selectable}
                            <td class={cellPadding}>
                                <input
                                    type="checkbox"
                                    checked={selectedRows.has(index)}
                                    onchange={() => toggleRowSelection(index)}
                                    onclick={stopPropagation()}
                                    class="checkbox" />
                            </td>
                        {/if}

                        {#each columns as column (column.key)}
                            <td
                                class="{cellPadding} text-sm text-surface-200 {column.align ===
                                'center'
                                    ? 'text-center'
                                    : column.align === 'right'
                                      ? 'text-right'
                                      : 'text-left'}">
                                {#if cell}{@render cell({
                                        column,
                                        row,
                                        index,
                                        value: getValue(row, String(column.key)),
                                    })}{:else}
                                    {getValue(row, String(column.key)) ?? '—'}
                                {/if}
                            </td>
                        {/each}

                        {#if actions}
                            <td class="{cellPadding} text-right">
                                {@render actions?.({ row, index })}
                            </td>
                        {/if}
                    </tr>
                {/each}
            {/if}
        </tbody>
    </table>
</div>

<style>
    /* Ensure table doesn't shrink columns too much */
    table {
        min-width: 100%;
    }

    /* Checkbox indeterminate state styling */
    input[type='checkbox']:indeterminate {
        background-color: var(--color-primary-500);
        background-image: url("data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M4 8h8' stroke='white' stroke-width='2' stroke-linecap='round'/%3e%3c/svg%3e");
    }
</style>
