<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import {
        Chart,
        CategoryScale,
        LinearScale,
        LineElement,
        PointElement,
        LineController,
        Title,
        Tooltip,
        Legend,
        Filler,
        TimeScale,
    } from 'chart.js';
    import 'chartjs-adapter-date-fns';

    // Register Chart.js components
    Chart.register(
        CategoryScale,
        LinearScale,
        LineElement,
        PointElement,
        LineController,
        Title,
        Tooltip,
        Legend,
        Filler,
        TimeScale,
    );

    interface Props {
        history?: Array<{
            timestamp: number;
            hlsSegmentsMbps: number;
            directPlayMbps: number;
            liveTVMbps: number;
            proxiedStreamsMbps: number;
            imagesMbps: number;
            subtitlesMbps: number;
            trickplayMbps: number;
            totalMbps: number;
            hlsSegmentsPeakMbps: number;
            directPlayPeakMbps: number;
            liveTVPeakMbps: number;
            proxiedStreamsPeakMbps: number;
            imagesPeakMbps: number;
            subtitlesPeakMbps: number;
            trickplayPeakMbps: number;
            totalPeakMbps: number;
        }>;
    }

    let { history = [] }: Props = $props();

    let canvas: HTMLCanvasElement | undefined = $state();
    let chart: Chart | undefined = $state();

    onMount(() => {
        createChart();
    });

    onDestroy(() => {
        if (chart) chart.destroy();
    });

    function createChart() {
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Chart.js canvas colors can't resolve CSS custom properties, so read the
        // themed surface-800 triplet once here and build a plain rgba() string.
        const surface800 =
            getComputedStyle(document.documentElement)
                .getPropertyValue('--color-surface-800-rgb')
                .trim() || '44 54 86';
        const tooltipBg = `rgba(${surface800.split(/\s+/).join(', ')}, 0.95)`;

        chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [
                    // Average datasets (solid lines with fill)
                    {
                        label: 'Total',
                        data: [],
                        borderColor: 'rgb(251, 146, 60)',
                        backgroundColor: 'rgba(251, 146, 60, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'HLS',
                        data: [],
                        borderColor: 'rgb(167, 139, 250)',
                        backgroundColor: 'rgba(167, 139, 250, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Direct',
                        data: [],
                        borderColor: 'rgb(52, 211, 153)',
                        backgroundColor: 'rgba(52, 211, 153, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'LiveTV',
                        data: [],
                        borderColor: 'rgb(251, 191, 36)',
                        backgroundColor: 'rgba(251, 191, 36, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Proxied',
                        data: [],
                        borderColor: 'rgb(96, 165, 250)',
                        backgroundColor: 'rgba(96, 165, 250, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Images',
                        data: [],
                        borderColor: 'rgb(244, 114, 182)',
                        backgroundColor: 'rgba(244, 114, 182, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Subtitles',
                        data: [],
                        borderColor: 'rgb(148, 163, 184)',
                        backgroundColor: 'rgba(148, 163, 184, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Trickplay',
                        data: [],
                        borderColor: 'rgb(192, 132, 252)',
                        backgroundColor: 'rgba(192, 132, 252, 0.08)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    // Peak datasets (dashed lines, no fill)
                    {
                        label: 'Total (Peak)',
                        data: [],
                        borderColor: 'rgba(251, 146, 60, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'HLS (Peak)',
                        data: [],
                        borderColor: 'rgba(167, 139, 250, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Direct (Peak)',
                        data: [],
                        borderColor: 'rgba(52, 211, 153, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'LiveTV (Peak)',
                        data: [],
                        borderColor: 'rgba(251, 191, 36, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Proxied (Peak)',
                        data: [],
                        borderColor: 'rgba(96, 165, 250, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Images (Peak)',
                        data: [],
                        borderColor: 'rgba(244, 114, 182, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Subtitles (Peak)',
                        data: [],
                        borderColor: 'rgba(148, 163, 184, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                    {
                        label: 'Trickplay (Peak)',
                        data: [],
                        borderColor: 'rgba(192, 132, 252, 0.5)',
                        borderWidth: 1,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: 'rgb(156, 163, 175)', // surface-400
                            usePointStyle: true,
                            padding: 15,
                        },
                    },
                    tooltip: {
                        backgroundColor: tooltipBg, // themed surface-800
                        titleColor: 'rgb(243, 244, 246)', // surface-100
                        bodyColor: 'rgb(209, 213, 219)', // surface-300
                        borderColor: 'rgb(75, 85, 99)', // surface-600
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            label: function (context) {
                                const value = context.parsed.y;
                                if (value === null) return '';
                                return `${context.dataset.label}: ${value.toFixed(2)} Mbps`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'minute',
                            displayFormats: {
                                minute: 'HH:mm',
                            },
                            tooltipFormat: 'HH:mm:ss',
                        },
                        grid: {
                            color: 'rgba(75, 85, 99, 0.3)', // surface-600 with opacity
                        },
                        ticks: {
                            color: 'rgb(156, 163, 175)', // surface-400
                            maxRotation: 0,
                        },
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(75, 85, 99, 0.3)', // surface-600 with opacity
                        },
                        ticks: {
                            color: 'rgb(156, 163, 175)', // surface-400
                            callback: function (value) {
                                return value + ' Mbps';
                            },
                        },
                    },
                },
            },
        });

        updateChart();
    }

    function updateChart() {
        if (!chart || !history) return;

        const map = (fn: (p: (typeof history)[0]) => number) =>
            history.map((p) => ({ x: p.timestamp, y: fn(p) }));

        // Average datasets (indices 0-7)
        chart.data.datasets[0].data = map((p) => p.totalMbps);
        chart.data.datasets[1].data = map((p) => p.hlsSegmentsMbps);
        chart.data.datasets[2].data = map((p) => p.directPlayMbps ?? 0);
        chart.data.datasets[3].data = map((p) => p.liveTVMbps ?? 0);
        chart.data.datasets[4].data = map((p) => p.proxiedStreamsMbps);
        chart.data.datasets[5].data = map((p) => p.imagesMbps ?? 0);
        chart.data.datasets[6].data = map((p) => p.subtitlesMbps ?? 0);
        chart.data.datasets[7].data = map((p) => p.trickplayMbps ?? 0);

        // Peak datasets (indices 8-15)
        chart.data.datasets[8].data = map((p) => p.totalPeakMbps);
        chart.data.datasets[9].data = map((p) => p.hlsSegmentsPeakMbps);
        chart.data.datasets[10].data = map((p) => p.directPlayPeakMbps ?? 0);
        chart.data.datasets[11].data = map((p) => p.liveTVPeakMbps ?? 0);
        chart.data.datasets[12].data = map((p) => p.proxiedStreamsPeakMbps);
        chart.data.datasets[13].data = map((p) => p.imagesPeakMbps ?? 0);
        chart.data.datasets[14].data = map((p) => p.subtitlesPeakMbps ?? 0);
        chart.data.datasets[15].data = map((p) => p.trickplayPeakMbps ?? 0);

        chart.update('none');
    }
    $effect(() => {
        if (chart && history) {
            updateChart();
        }
    });
</script>

<div class="w-full h-64">
    <canvas bind:this={canvas}></canvas>
</div>
