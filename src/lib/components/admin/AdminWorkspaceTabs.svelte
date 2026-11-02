<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    let {
        label,
        items,
        value,
        onchange,
    }: {
        label: string;
        items: Array<{ id: string; label: string; count?: number }>;
        value: string;
        onchange: (id: string) => void;
    } = $props();
</script>

<nav aria-label={label} class="flex flex-wrap gap-2">
    {#each items as item (item.id)}
        <button
            type="button"
            aria-pressed={value === item.id}
            class="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400 {value ===
            item.id
                ? 'border-primary-400/50 bg-primary-500/10 text-primary-200'
                : 'border-surface-700 bg-surface-800/40 text-surface-400 hover:border-surface-500 hover:text-white'}"
            onclick={() => onchange(item.id)}>
            {item.label}
            {#if item.count !== undefined}
                <span class="rounded bg-surface-700/60 px-1.5 py-0.5 text-xs tabular-nums"
                    >{item.count.toLocaleString()}</span>
            {/if}
        </button>
    {/each}
</nav>
