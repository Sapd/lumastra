<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ChevronRight, Home } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';

    interface Crumb {
        label: string;
        href?: string;
    }

    interface Props {
        crumbs: Crumb[];
    }

    let { crumbs }: Props = $props();
</script>

<nav
    class="flex items-center gap-1 text-sm text-surface-400 overflow-x-auto whitespace-nowrap px-1 py-2">
    <a href={resolve('/admin')} class="hover:text-surface-200 transition-colors shrink-0">
        <Icon src={Home} class="w-4 h-4" />
    </a>
    {#each crumbs as crumb, i (i)}
        <Icon src={ChevronRight} class="w-3 h-3 text-surface-600 shrink-0" />
        {#if crumb.href && i < crumbs.length - 1}
            <a
                href={resolve(crumb.href)}
                class="hover:text-surface-200 transition-colors truncate max-w-[200px]">
                {crumb.label}
            </a>
        {:else}
            <span class="text-surface-200 truncate max-w-[200px]">{crumb.label}</span>
        {/if}
    {/each}
</nav>
