<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    export type SortDirection = 'asc' | 'desc';
</script>

<script lang="ts">
    import { Icon, ChevronUp, ChevronDown, ChevronUpDown } from 'svelte-hero-icons';

    interface Props {
        label: string;
        /** The active sort direction, or null when another column sorts the table. */
        direction: SortDirection | null;
        onsort: () => void;
        align?: 'left' | 'center';
        /** Optional explanation shown on hover. */
        title?: string;
    }

    let { label, direction, onsort, align = 'center', title }: Props = $props();

    let ariaSort = $derived<'ascending' | 'descending' | 'none'>(
        direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none',
    );
</script>

<th
    class="px-4 py-3 text-surface-400 font-medium {align === 'left' ? 'text-left' : 'text-center'}"
    aria-sort={ariaSort}
    scope="col">
    <button
        type="button"
        class="inline-flex items-center gap-1 rounded hover:text-surface-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 {direction
            ? 'text-surface-100'
            : ''}"
        {title}
        onclick={onsort}>
        {label}
        <Icon
            src={direction === 'asc'
                ? ChevronUp
                : direction === 'desc'
                  ? ChevronDown
                  : ChevronUpDown}
            class="w-3.5 h-3.5 {direction ? '' : 'opacity-40'}"
            aria-hidden="true" />
    </button>
</th>
