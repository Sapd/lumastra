<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    AzSortDropdown.svelte
    Compact native <select> for choosing the /browse A-Z sort order. Styled to
    match the .raf-trigger / az-type-chip pill aesthetic in the controls bar.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type { BrowseSort } from '$lib/stores/azBrowse';

    interface SortOption {
        value: BrowseSort;
        label: () => string;
    }

    // Labels are message FUNCTIONS, called at render, so they follow the
    // active locale rather than freezing whichever one was active at import.
    const SORT_OPTIONS: SortOption[] = [
        { value: 'title_asc', label: m.az_sort_title_asc },
        { value: 'title_desc', label: m.az_sort_title_desc },
        { value: 'added_desc', label: m.az_sort_added_desc },
        { value: 'year_desc', label: m.az_sort_year_desc },
        { value: 'year_asc', label: m.az_sort_year_asc },
        { value: 'rating_desc', label: m.az_sort_rating_desc },
    ];

    interface Props {
        sort?: BrowseSort;
        /** Fired after the selection changes so the parent can refetch + persist. */
        onChange?: () => void;
    }

    let { sort = $bindable('title_asc'), onChange }: Props = $props();

    function handleChange(e: Event): void {
        sort = (e.currentTarget as HTMLSelectElement).value as BrowseSort;
        onChange?.();
    }
</script>

<label class="az-sort">
    <span class="az-sort-label">{m.az_sort_label()}</span>
    <select
        class="az-sort-select"
        value={sort}
        onchange={handleChange}
        aria-label={m.az_sort_aria()}>
        {#each SORT_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label()}</option>
        {/each}
    </select>
</label>

<style lang="postcss">
    .az-sort {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
    }

    .az-sort-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-surface-400);
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .az-sort-select {
        appearance: none;
        display: inline-flex;
        align-items: center;
        padding: 0.5rem 2rem 0.5rem 1rem;
        border-radius: 0.55rem;
        min-height: 44px;
        background: rgb(var(--color-surface-700-rgb) / 0.5);
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-300);
        font-size: 0.875rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
        /* Chevron */
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 0.75rem center;
    }

    .az-sort-select:hover {
        background-color: rgb(var(--color-surface-600-rgb) / 0.5);
        color: var(--color-surface-100);
    }

    .az-sort-select:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
    }

    .az-sort-select option {
        background: var(--color-surface-800);
        color: var(--color-surface-100);
    }
</style>
