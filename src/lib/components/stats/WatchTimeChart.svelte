<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Chart,
        CategoryScale,
        LinearScale,
        BarElement,
        BarController,
        Title,
        Tooltip,
        Legend,
        Filler,
        type ChartConfiguration,
    } from 'chart.js';
    import {
        Icon,
        ChartBarSquare,
        ArrowTrendingUp,
        ArrowTrendingDown,
        Minus,
    } from 'svelte-hero-icons';
    import type { WatchTimeStats } from '$lib/types/personal-stats';
    import type { StatsPeriod } from '$lib/schemas/personal-stats-types';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    // Register Chart.js components
    Chart.register(
        CategoryScale,
        LinearScale,
        BarElement,
        BarController,
        Title,
        Tooltip,
        Legend,
        Filler,
    );

    interface Props {
        data: WatchTimeStats;
        period?: StatsPeriod;
    }

    let { data, period = 'all' }: Props = $props();

    let canvas: HTMLCanvasElement | undefined = $state();

    function formatHours(seconds: number): string {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes}m`;
    }

    /** A tick step of whole hours (about eight ticks), or Chart.js's own below two hours. */
    function hourStepMinutes(maxMinutes: number): number | undefined {
        if (maxMinutes <= 120) return undefined;
        return 60 * Math.max(1, Math.ceil(maxMinutes / 60 / 8));
    }

    function formatDateLabel(isoDate: string): string {
        const date = new Date(isoDate);
        return date.toLocaleDateString(getLocale(), {
            month: 'short',
            day: 'numeric',
        });
    }

    function formatDateTooltipTitle(isoDate: string): string {
        return new Date(isoDate).toLocaleDateString(getLocale(), {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
    }

    // Clamp trend percentage to ±999 so the badge never overflows
    let clampedTrendPercentage = $derived(Math.max(-999, Math.min(999, data.trendPercentage)));

    // "Periods Tracked" unit: 7d period shows days, others show weeks
    let periodsTrackedLabel = $derived(
        period === '7d'
            ? m.stats_watch_time_days_tracked({ count: data.periods.length })
            : m.stats_watch_time_weeks_tracked({ count: data.periods.length }),
    );

    // Aria label for the chart canvas summarising the data
    let chartAriaLabel = $derived(
        m.stats_watch_time_chart_aria({
            total: formatHours(data.totalWatchTimeSeconds),
            count: data.periods.length,
        }),
    );

    // Aria label for the trend badge
    let trendBadgeAriaLabel = $derived(
        data.trend === 'stable'
            ? m.stats_watch_time_stable()
            : m.stats_watch_time_trend_badge({
                  value: `${clampedTrendPercentage > 0 ? '+' : ''}${clampedTrendPercentage}%`,
              }),
    );

    // Recreate the chart when the fetched series or canvas changes. Cleanup runs
    // before replacement, including nonempty → empty → nonempty transitions.
    $effect(() => {
        if (!canvas || !data.periods.length) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Chart.js canvas colors can't resolve CSS custom properties, so read the
        // themed rgb triplets once and build plain rgba() strings.
        const rootStyle = getComputedStyle(document.documentElement);
        const primary500 =
            rootStyle.getPropertyValue('--color-primary-500-rgb').trim() || '99 102 241';
        const surface800 =
            rootStyle.getPropertyValue('--color-surface-800-rgb').trim() || '44 54 86';
        const primaryRgba = (alpha: number) =>
            `rgba(${primary500.split(/\s+/).join(', ')}, ${alpha})`;
        const surfaceRgba = (alpha: number) =>
            `rgba(${surface800.split(/\s+/).join(', ')}, ${alpha})`;

        // Create gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, primaryRgba(0.8));
        gradient.addColorStop(1, primaryRgba(0.2));

        const chartConfig: ChartConfiguration = {
            type: 'bar',
            data: {
                labels: data.periods.map((p) => formatDateLabel(p.period)),
                datasets: [
                    {
                        label: m.stats_watch_time_chart_label(),
                        data: data.periods.map((p) => Math.round(p.watchTimeSeconds / 60)), // Convert to minutes
                        backgroundColor: gradient,
                        borderColor: primaryRgba(1),
                        borderWidth: 2,
                        borderRadius: 6,
                        borderSkipped: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false,
                    },
                    tooltip: {
                        backgroundColor: surfaceRgba(0.95),
                        titleColor: '#f3f4f6',
                        bodyColor: '#f3f4f6',
                        borderColor: primaryRgba(0.5),
                        borderWidth: 1,
                        padding: 12,
                        callbacks: {
                            title: function (context) {
                                const idx = context[0].dataIndex;
                                const p = data.periods[idx];
                                return formatDateTooltipTitle(p.period);
                            },
                            label: function (context) {
                                const idx = context.dataIndex;
                                const p = data.periods[idx];
                                return [
                                    m.stats_watch_time_tooltip_label({
                                        value: formatHours(p.watchTimeSeconds),
                                    }),
                                    m.stats_watch_time_tooltip_sessions({ count: p.sessionCount }),
                                ];
                            },
                        },
                    },
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(107, 114, 128, 0.2)',
                        },
                        ticks: {
                            color: '#9ca3af',
                            // Whole-hour steps once the scale passes two hours. Left to
                            // itself Chart.js stepped in 50 minutes, and rounding those
                            // to hours printed "8h" twice and a stray "50m".
                            stepSize: hourStepMinutes(
                                Math.max(0, ...data.periods.map((p) => p.watchTimeSeconds / 60)),
                            ),
                            callback: function (value) {
                                const minutes = value as number;
                                if (minutes >= 60) {
                                    return `${+(minutes / 60).toFixed(1)}h`;
                                }
                                return `${minutes}m`;
                            },
                        },
                    },
                    x: {
                        grid: {
                            display: false,
                        },
                        ticks: {
                            color: '#9ca3af',
                            maxRotation: 45,
                        },
                    },
                },
                animation: {
                    duration: 800,
                    easing: 'easeOutQuart',
                },
            },
        };

        const chart = new Chart(ctx, chartConfig);
        return () => chart.destroy();
    });

    // Trend icon and color
    let trendIcon = $derived(
        data.trend === 'up' ? ArrowTrendingUp : data.trend === 'down' ? ArrowTrendingDown : Minus,
    );
    let trendColor = $derived(
        data.trend === 'up'
            ? 'text-green-400'
            : data.trend === 'down'
              ? 'text-red-400'
              : 'text-gray-400',
    );
    let trendBg = $derived(
        data.trend === 'up'
            ? 'bg-green-900/30'
            : data.trend === 'down'
              ? 'bg-red-900/30'
              : 'bg-gray-700/50',
    );
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-6">
        <div class="flex items-center gap-2">
            <Icon src={ChartBarSquare} class="w-5 h-5 text-blue-400" aria-hidden="true" />
            <h3 class="text-lg font-bold text-white">
                {m.stats_watch_time_title()}
            </h3>
        </div>

        <!-- Trend indicator -->
        <div class="flex items-center gap-4 flex-shrink-0">
            <div class="text-center">
                <p class="text-muted">
                    {m.stats_watch_time_avg_per_period()}
                </p>
                <p class="text-lg font-semibold text-blue-400">
                    {formatHours(data.avgPerPeriod)}
                </p>
            </div>
            <div
                class="{trendBg} rounded-lg px-3 py-2 flex items-center gap-2"
                aria-label={trendBadgeAriaLabel}>
                <Icon src={trendIcon} class="w-4 h-4 {trendColor}" aria-hidden="true" />
                <span class="{trendColor} text-sm font-medium" aria-hidden="true">
                    {#if data.trend === 'stable'}
                        {m.stats_watch_time_stable()}
                    {:else}
                        {clampedTrendPercentage > 0 ? '+' : ''}{clampedTrendPercentage}%
                    {/if}
                </span>
            </div>
        </div>
    </div>

    {#if data.periods.length > 0}
        <figure class="relative h-64 m-0" role="img" aria-label={chartAriaLabel}>
            <canvas bind:this={canvas} class="w-full h-full"></canvas>
        </figure>

        <!-- Summary stats -->
        <div class="grid grid-cols-3 gap-4 mt-6 pt-4 border-t border-gray-700">
            <div class="text-center min-w-0">
                <p class="text-label truncate">
                    {m.stats_watch_time_total()}
                </p>
                <p class="text-lg font-semibold text-white truncate">
                    {formatHours(data.totalWatchTimeSeconds)}
                </p>
            </div>
            <div class="text-center min-w-0">
                <p class="text-label truncate">
                    {m.stats_watch_time_total_sessions()}
                </p>
                <p class="text-lg font-semibold text-white">
                    {data.periods.reduce((sum, p) => sum + p.sessionCount, 0)}
                </p>
            </div>
            <div class="text-center min-w-0">
                <p class="text-label truncate">
                    {m.stats_watch_time_periods_tracked()}
                </p>
                <p class="text-lg font-semibold text-white truncate">
                    {periodsTrackedLabel}
                </p>
            </div>
        </div>
    {:else}
        <div class="relative h-64 center">
            <p class="text-gray-500">{m.stats_watch_time_no_data()}</p>
        </div>
    {/if}
</div>
