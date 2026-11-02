<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    // Tree-shaken Chart.js imports - only import what we need
    import {
        Chart,
        CategoryScale,
        LinearScale,
        BarElement,
        ArcElement,
        BarController,
        DoughnutController,
        Title,
        Tooltip,
        Legend,
        Filler,
        type ChartConfiguration,
    } from 'chart.js';
    import * as m from '$lib/paraglide/messages';

    type TooltipContext = {
        dataIndex: number;
        parsed: { y?: number } | number;
    };

    // Register only the components we actually use (including controllers)
    Chart.register(
        CategoryScale,
        LinearScale,
        BarElement,
        ArcElement,
        BarController,
        DoughnutController,
        Title,
        Tooltip,
        Legend,
        Filler,
    );

    interface Props {
        data?: Array<{
            label: string;
            count: number;
            minutes?: number;
            percentage: number;
        }>;
        title?: string;
        type?: 'bar' | 'doughnut';
        color?: string;
        valueType?: string; // 'count', 'minutes', or 'auto'
        showWrapper?: boolean; // Whether to show the outer wrapper
        /** Override the "1+ min each" filter description in the tooltip.
         *  Pass an empty string to suppress that line entirely.
         *  Defaults to m.stats_chart_items_filter_1min() */
        tooltipFilterLabel?: string | null;
        /** Override the "Total: N items" line below the chart, e.g. to say
         *  "sessions". Receives the summed count. */
        summaryLabel?: (total: number) => string;
    }

    let {
        data = [],
        title = 'Activity Chart',
        type = 'bar',
        color = '#3b82f6',
        valueType = 'count',
        showWrapper = true,
        tooltipFilterLabel = undefined,
        summaryLabel = undefined,
    }: Props = $props();

    let canvas: HTMLCanvasElement | undefined = $state();
    let chart: Chart | undefined = $state();

    // 10-color palette so slices 8–10 don't repeat colors 1–3
    const DOUGHNUT_COLORS = [
        '#3b82f6', // blue-500
        '#8b5cf6', // violet-500
        '#06b6d4', // cyan-500
        '#10b981', // emerald-500
        '#f59e0b', // amber-500
        '#ef4444', // red-500
        '#f97316', // orange-500
        '#ec4899', // pink-500
        '#84cc16', // lime-500
        '#6366f1', // indigo-500
    ];

    /** Resolved label for the tooltip filter line */
    function resolvedFilterLabel(): string {
        if (tooltipFilterLabel === null) return '';
        if (tooltipFilterLabel !== undefined) return tooltipFilterLabel;
        return m.stats_chart_items_filter_1min();
    }

    onMount(() => {
        if (!canvas || !data.length) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Prepare chart data - use minutes if available, otherwise count
        const labels = data.map((item) => item.label);
        const values = data.map((item) => item.minutes || item.count);

        // Create gradient for bars
        const gradient = ctx.createLinearGradient(0, 0, 0, 400);
        gradient.addColorStop(0, color + '90');
        gradient.addColorStop(1, color + '20');

        // Chart.js canvas colors can't resolve CSS custom properties, so read the
        // themed surface-800 triplet once here and build a plain rgba() string.
        const surface800 =
            getComputedStyle(document.documentElement)
                .getPropertyValue('--color-surface-800-rgb')
                .trim() || '44 54 86';
        const tooltipBg = `rgba(${surface800.split(/\s+/).join(', ')}, 0.9)`;

        const filterLabel = resolvedFilterLabel();

        const chartConfig = {
            type: type,
            data: {
                labels: labels,
                datasets: [
                    {
                        label:
                            data[0]?.minutes !== undefined
                                ? m.stats_chart_dataset_minutes()
                                : m.sessions(),
                        data: values,
                        backgroundColor: type === 'bar' ? gradient : DOUGHNUT_COLORS,
                        borderColor: color,
                        borderWidth: 2,
                        borderRadius: type === 'bar' ? 6 : 0,
                        borderSkipped: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: type === 'doughnut',
                        position: 'bottom' as const,
                        labels: {
                            color: '#e5e7eb',
                            usePointStyle: true,
                            padding: 20,
                        },
                    },
                    title: {
                        display: false,
                    },
                    tooltip: {
                        backgroundColor: tooltipBg,
                        titleColor: '#f3f4f6',
                        bodyColor: '#f3f4f6',
                        borderColor: color,
                        borderWidth: 1,
                        callbacks: {
                            label: function (context: TooltipContext) {
                                const item = data[context.dataIndex];
                                if (item.minutes !== undefined) {
                                    const lines = [
                                        m.stats_chart_tooltip_minutes_watched({
                                            minutes: item.minutes,
                                        }),
                                    ];
                                    if (filterLabel) {
                                        lines.push(
                                            m.stats_chart_tooltip_items_count({
                                                count: item.count,
                                                filterLabel,
                                            }),
                                        );
                                    } else {
                                        lines.push(
                                            m.stats_chart_tooltip_items_count_no_filter({
                                                count: item.count,
                                            }),
                                        );
                                    }
                                    lines.push(
                                        m.stats_chart_tooltip_percentage({
                                            percentage: item.percentage,
                                        }),
                                    );
                                    return lines;
                                }
                                const parsed =
                                    typeof context.parsed === 'number'
                                        ? context.parsed
                                        : context.parsed.y || 0;
                                return m.stats_chart_tooltip_sessions({
                                    count: parsed,
                                    percentage: item.percentage,
                                });
                            },
                        },
                    },
                },
                scales:
                    type === 'bar'
                        ? {
                              y: {
                                  beginAtZero: true,
                                  grid: {
                                      color: 'rgba(107, 114, 128, 0.3)',
                                  },
                                  ticks: {
                                      color: '#9ca3af',
                                  },
                              },
                              x: {
                                  grid: {
                                      color: 'rgba(107, 114, 128, 0.3)',
                                  },
                                  ticks: {
                                      color: '#9ca3af',
                                      maxRotation: 45,
                                  },
                              },
                          }
                        : undefined,
                animation: {
                    duration: 1000,
                    easing: 'easeOutQuart',
                },
                interaction: {
                    intersect: false,
                    mode: 'index' as const,
                },
            },
        };

        chart = new Chart(ctx, chartConfig as ChartConfiguration);
    });

    // Update chart when data changes
    $effect(() => {
        if (chart && data) {
            const labels = data.map((item) => item.label);
            const values = data.map((item) => item.minutes || item.count);

            chart.data.labels = labels;
            chart.data.datasets[0].data = values;
            chart.data.datasets[0].label =
                data[0]?.minutes !== undefined ? m.stats_chart_dataset_minutes() : m.sessions();
            chart.update('active');
        }
    });

    onDestroy(() => {
        if (chart) {
            chart.destroy();
        }
    });

    /** Aria label for the canvas — summarises the chart title + item count */
    let canvasAriaLabel = $derived(
        data.length > 0
            ? m.stats_chart_aria_label({ title, count: data.length })
            : m.stats_chart_aria_label_empty({ title }),
    );

    /** Summary text shown below the chart */
    let summaryText = $derived(
        summaryLabel
            ? summaryLabel(data.reduce((sum, item) => sum + item.count, 0))
            : valueType === 'minutes' || (valueType === 'auto' && data[0]?.minutes !== undefined)
              ? m.stats_chart_summary_minutes({
                    minutes: data.reduce((sum, item) => sum + (item.minutes || 0), 0),
                    items: data.reduce((sum, item) => sum + item.count, 0),
                })
              : m.stats_chart_summary_items({
                    items: data.reduce((sum, item) => sum + item.count, 0),
                }),
    );
</script>

{#if showWrapper}
    <div class="card-base !p-6">
        <h3 class="text-lg font-medium mb-4 text-center">{title}</h3>
        {#if data.length > 0}
            <div class="relative h-64" role="img" aria-label={canvasAriaLabel}>
                <canvas bind:this={canvas} class="w-full h-full" aria-hidden="true"></canvas>
            </div>
            <div class="mt-4 text-center text-muted">
                {summaryText}
            </div>
        {:else}
            <div class="relative h-64 center">
                <div class="text-center">
                    <p class="text-gray-400 font-medium">{m.stats_chart_no_data()}</p>
                    <p class="text-muted mt-1">{m.stats_chart_no_data_hint()}</p>
                </div>
            </div>
        {/if}
    </div>
{:else if data.length > 0}
    <div class="relative h-64" role="img" aria-label={canvasAriaLabel}>
        <canvas bind:this={canvas} class="w-full h-full" aria-hidden="true"></canvas>
    </div>
    <div class="mt-4 text-center text-muted">
        {summaryText}
    </div>
{:else}
    <div class="relative h-64 center">
        <div class="text-center">
            <p class="text-gray-400 font-medium">{m.stats_chart_no_data()}</p>
            <p class="text-muted mt-1">{m.stats_chart_no_data_hint()}</p>
        </div>
    </div>
{/if}
