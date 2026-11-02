<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts" module>
    import type { IconSource } from 'svelte-hero-icons';
    import type { MetricColor } from '$lib/utils/metric-styles';

    /** One stat card in the top grid (eligible / completed / pending / …). */
    export interface CoverageStat {
        title: string;
        value: number | string;
        /** Defaults to the dashboard icon. */
        icon?: IconSource;
        color?: MetricColor;
        subtitle?: string;
        /** true → green, false → red, null/undefined → use `color`. */
        healthy?: boolean | null;
    }

    /** A coverage progress bar ("X of Y items have embeddings"). */
    export interface CoverageBar {
        label: string;
        description: string;
        /** 0–100. */
        percent: number;
        /** Fill gradient — defaults to blue→purple. */
        gradient?: 'blue-purple' | 'green-teal' | 'cyan-blue';
    }

    /** A row in the optional status-breakdown table. */
    export interface CoverageStatusRow {
        label: string;
        value: number | string;
        /** Tailwind text color class for the value (e.g. 'text-green-400'). */
        colorClass?: string;
    }

    /** A primary/secondary action button with its own loading state. */
    export interface CoverageAction {
        id: string;
        label: string;
        description: string;
        variant?: 'primary' | 'secondary';
        loading?: boolean;
        onclick: () => void;
    }

    export interface CoverageDashboardProps {
        title: string;
        description: string;
        icon: IconSource;
        /** Whole-dashboard loading (initial fetch). */
        loading?: boolean;
        stats?: CoverageStat[];
        coverageBars?: CoverageBar[];
        statusBreakdown?: CoverageStatusRow[];
        actions?: CoverageAction[];
        /** Defaults to "How it works". */
        infoTitle?: string;
        infoItems?: string[];
        /** When provided, a Refresh button is shown in the header. */
        onRefresh?: () => void;
    }

    const GRADIENTS: Record<NonNullable<CoverageBar['gradient']>, string> = {
        'blue-purple': 'from-blue-500 to-purple-500',
        'green-teal': 'from-green-500 to-teal-500',
        'cyan-blue': 'from-cyan-500 to-blue-500',
    };

    /** Coverage % health color — green ≥80, yellow ≥50, red below. */
    function percentColor(percent: number): string {
        if (percent >= 80) return 'text-green-400';
        if (percent >= 50) return 'text-yellow-400';
        return 'text-red-400';
    }
</script>

<script lang="ts">
    import { Icon, Sparkles } from 'svelte-hero-icons';
    import AdminPageHeader from './AdminPageHeader.svelte';
    import StatCard from './StatCard.svelte';

    let {
        title,
        description,
        icon,
        loading = false,
        stats,
        coverageBars,
        statusBreakdown,
        actions,
        infoTitle = 'How it works',
        infoItems,
        onRefresh,
    }: CoverageDashboardProps = $props();

    let hasStats = $derived(!!stats && stats.length > 0);
</script>

<div class="space-y-6">
    <AdminPageHeader {icon} {title} {description}>
        {#if onRefresh}
            <button
                class="btn btn-sm btn-blue flex items-center gap-2"
                onclick={onRefresh}
                disabled={loading}>
                {#if loading}
                    <span class="loading-spinner"></span>
                {/if}
                Refresh
            </button>
        {/if}
    </AdminPageHeader>

    {#if loading && !hasStats}
        <div class="card-base p-8">
            <div class="flex items-center gap-3 justify-center">
                <span class="loading-spinner loading-spinner-primary"></span>
                <p class="text-surface-400">Loading statistics...</p>
            </div>
        </div>
    {:else}
        {#if hasStats && stats}
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
                {#each stats as stat (stat.title)}
                    <StatCard
                        icon={stat.icon ?? icon ?? Sparkles}
                        title={stat.title}
                        color={stat.color ?? 'blue'}
                        value={typeof stat.value === 'number'
                            ? stat.value.toLocaleString()
                            : stat.value}
                        healthy={stat.healthy ?? null}
                        subtitle={stat.subtitle} />
                {/each}
            </div>
        {/if}

        {#if coverageBars}
            {#each coverageBars as bar (bar.label)}
                <div class="card-base">
                    <div class="mb-6">
                        <h3 class="text-lg font-semibold text-white mb-2">{bar.label}</h3>
                        <p class="text-surface-400">{bar.description}</p>
                    </div>

                    <div class="w-full bg-surface-700 rounded-full h-3 overflow-hidden">
                        <div
                            data-coverage-fill
                            class="bg-gradient-to-r {GRADIENTS[
                                bar.gradient ?? 'blue-purple'
                            ]} h-full transition-all duration-500"
                            style={`width: ${bar.percent}%`}>
                        </div>
                    </div>

                    <div class="mt-3 text-right">
                        <span class="text-lg font-bold {percentColor(bar.percent)}">
                            {bar.percent}%
                        </span>
                    </div>
                </div>
            {/each}
        {/if}

        {#if statusBreakdown && statusBreakdown.length > 0}
            <div class="card-base">
                <h3 class="text-lg font-semibold text-white mb-4">Status Breakdown</h3>
                <div class="space-y-3">
                    {#each statusBreakdown as row, i (row.label)}
                        <div
                            class="flex items-center justify-between py-2 {i <
                            statusBreakdown.length - 1
                                ? 'border-b border-surface-700/50'
                                : ''}">
                            <span class="text-surface-300">{row.label}</span>
                            <span class="font-mono {row.colorClass ?? 'text-surface-200'}">
                                {typeof row.value === 'number'
                                    ? row.value.toLocaleString()
                                    : row.value}
                            </span>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}

        {#if actions}
            {#each actions as action (action.id)}
                <div class="card-base">
                    <h3 class="text-lg font-semibold text-white mb-4">{action.label}</h3>
                    <p class="text-surface-400 mb-4">{action.description}</p>
                    <button
                        class="btn btn-lg flex items-center gap-2 {action.variant === 'secondary'
                            ? 'btn-secondary'
                            : 'btn-primary'}"
                        onclick={action.onclick}
                        disabled={action.loading || loading}>
                        {#if action.loading}
                            <span class="loading-spinner"></span>
                        {:else}
                            <Icon src={icon ?? Sparkles} class="w-5 h-5" />
                        {/if}
                        {action.label}
                    </button>
                </div>
            {/each}
        {/if}

        {#if infoItems && infoItems.length > 0}
            <div class="bg-surface-800/50 rounded-lg p-4 border border-surface-700">
                <h4 class="font-semibold text-white mb-3">{infoTitle}</h4>
                <ul class="space-y-2 text-sm text-surface-300">
                    {#each infoItems as item (item)}
                        <li>• {item}</li>
                    {/each}
                </ul>
            </div>
        {/if}
    {/if}
</div>
