<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import type { BadgeProps } from './badge-types';

    let { color, label, icon, sublabel, animate = false, tooltip }: BadgeProps = $props();

    let tooltipId = $derived(
        `badge-tooltip-${label.replace(/\W+/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    let tooltipSettings = $derived<PopupSettings>({
        event: 'hover',
        target: tooltipId,
        placement: 'top',
        middleware: { offset: 6, shift: true, flip: true },
    });
</script>

{#if tooltip}
    <span
        class="badge-pill badge-pill-{color} flex items-center gap-1 {animate
            ? 'animate-pulse'
            : ''} cursor-default"
        use:popup={tooltipSettings}>
        {#if icon}
            <Icon src={icon} class="w-3 h-3" />
        {:else}
            <span class="w-1.5 h-1.5 bg-white rounded-full"></span>
        {/if}
        {label}
        {#if sublabel}
            <span class="text-xs opacity-75">({sublabel})</span>
        {/if}
    </span>
    <div
        data-popup={tooltipId}
        class="card px-2 py-1 bg-surface-900 border border-surface-700 rounded text-xs text-surface-300 z-20 shadow-lg whitespace-nowrap">
        {tooltip}
    </div>
{:else}
    <span
        class="badge-pill badge-pill-{color} flex items-center gap-1 {animate
            ? 'animate-pulse'
            : ''}">
        {#if icon}
            <Icon src={icon} class="w-3 h-3" />
        {:else}
            <span class="w-1.5 h-1.5 bg-white rounded-full"></span>
        {/if}
        {label}
        {#if sublabel}
            <span class="text-xs opacity-75">({sublabel})</span>
        {/if}
    </span>
{/if}
