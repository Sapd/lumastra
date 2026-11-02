<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon } from 'svelte-hero-icons';
    import type { ComponentType } from 'svelte';
    import ActivityChart from '$lib/components/ActivityChart.svelte';

    interface Props {
        title: string;
        subtitle?: string;
        icon?: ComponentType | null;
        data: Array<{
            label: string;
            count: number;
            minutes?: number;
            percentage: number;
        }>;
        chartType?: 'bar' | 'doughnut';
        chartColor?: string;
        gradient?: string;
        borderColor?: string;
        subtitleColor?: string;
        valueType?: string;
        /** Passed to ActivityChart: override the "Total: N items" line. */
        summaryLabel?: (total: number) => string;
    }

    let {
        title,
        subtitle = '',
        icon = null,
        data,
        chartType = 'bar',
        chartColor = '#3b82f6',
        gradient = 'from-surface-800 via-surface-850 to-surface-900',
        borderColor = 'border-surface-700',
        subtitleColor = 'text-surface-300',
        valueType = 'count',
        summaryLabel = undefined,
    }: Props = $props();
</script>

<div class="bg-gradient-to-br {gradient} rounded-xl p-6 border {borderColor} shadow-2xl">
    <div class="flex items-center gap-3 mb-4">
        {#if icon}
            <div class="p-2 bg-white/10 rounded-lg backdrop-blur-sm">
                <Icon src={icon} class="w-6 h-6 text-white" />
            </div>
        {/if}
        <div>
            <h3 class="text-lg font-bold text-white">{title}</h3>
            {#if subtitle}
                <p class="text-sm {subtitleColor}">{subtitle}</p>
            {/if}
        </div>
    </div>
    <ActivityChart
        {data}
        {title}
        type={chartType}
        color={chartColor}
        {valueType}
        {summaryLabel}
        showWrapper={false} />
</div>
