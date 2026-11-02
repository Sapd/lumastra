<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { apiGet } from '$lib/api/client.js';
    import {
        TrendsResponseSchema,
        type TaskMetricsSnapshot,
    } from '$lib/schemas/task-system-failure-detection.schema.js';
    import { deltaSeries } from './trend-series.js';

    let points = $state<TaskMetricsSnapshot[]>([]);
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let sinceHours = $state(168);

    const windowOptions: { label: string; hours: number }[] = [
        { label: '24h', hours: 24 },
        { label: '7d', hours: 168 },
        { label: '30d', hours: 720 },
    ];

    // Only the newest window's response may set the points (30d is slow).
    let loadSeq = 0;

    async function load(): Promise<void> {
        const seq = ++loadSeq;
        loading = true;
        const { data, error } = await apiGet(
            `/api/admin/task-system/trends?sinceHours=${sinceHours}`,
            TrendsResponseSchema,
        );
        if (seq !== loadSeq) return;
        if (error || !data) {
            loadError = error ?? 'Could not load trends';
        } else {
            points = data.points;
            loadError = null;
        }
        loading = false;
    }

    async function changeWindow(hours: number): Promise<void> {
        sinceHours = hours;
        await load();
    }

    // p95 duration series (ms → seconds for the label).
    const p95Series = $derived.by(() =>
        points.map((p) => (p.durationP95Ms != null ? p.durationP95Ms / 1000 : 0)),
    );
    // Total queue depth per snapshot (sum across classes).
    const queueSeries = $derived.by(() =>
        points.map((p) => Object.values(p.queueDepth).reduce((a, b) => a + b, 0)),
    );

    // Run throughput per interval. runsCompleted/runsFailed are CUMULATIVE
    // process counters, so we diff adjacent snapshots. A process restart resets
    // the counter to 0, making the diff negative — clamp those to 0 rather than
    // render a garbage downward spike (restart-safe per spec §8). The writer is
    // leader-gated, so with several replicas consecutive rows can come from
    // different processes whose counters are unrelated: a change of instance is
    // treated like a restart (0), never diffed.
    const completedSeries = $derived.by(() => deltaSeries(points, (p) => p.runsCompleted));
    const failedSeries = $derived.by(() => deltaSeries(points, (p) => p.runsFailed));
    // Shared scale so the completed/failed lines on the throughput chart are
    // directly comparable.
    const throughputMax = $derived(Math.max(maxOf(completedSeries), maxOf(failedSeries)));

    const W = 600;
    const H = 80;

    /**
     * Build an SVG polyline `points` string scaling a series to the WxH box.
     * Pass `maxOverride` to scale several series against a shared maximum (so
     * two lines on one chart are directly comparable).
     */
    function polyline(series: number[], maxOverride?: number): string {
        if (series.length === 0) return '';
        const max = Math.max(1, maxOverride ?? Math.max(...series));
        const stepX = series.length > 1 ? W / (series.length - 1) : W;
        return series
            .map((v, i) => {
                const x = i * stepX;
                const y = H - (v / max) * (H - 4) - 2;
                return `${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(' ');
    }

    function maxOf(series: number[]): number {
        return series.length > 0 ? Math.max(...series) : 0;
    }

    function sumOf(series: number[]): number {
        return series.reduce((a, b) => a + b, 0);
    }

    function formatSeconds(s: number): string {
        if (s >= 3600) return `${(s / 3600).toFixed(1)}h`;
        if (s >= 60) return `${(s / 60).toFixed(1)}m`;
        return `${s.toFixed(1)}s`;
    }
</script>

<section
    class="rounded-lg border border-surface-700 bg-surface-900/40 p-4"
    aria-label="Task-system trends">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
            <h2 class="text-sm font-semibold uppercase tracking-wide text-surface-300">Trends</h2>
            <p class="mt-1 text-xs text-surface-500">
                Measured roughly every 5 minutes. The
                <span
                    class="cursor-help underline decoration-dotted"
                    title="p95 is the time under which 95% of jobs finish — a way to track the slowest jobs without one extreme outlier skewing the picture.">
                    p95</span> line shows how long the slower jobs take.
            </p>
        </div>
        <div class="flex items-center gap-2">
            {#each windowOptions as opt (opt.hours)}
                <button
                    type="button"
                    class="rounded px-2.5 py-1 text-xs transition-colors {sinceHours === opt.hours
                        ? 'bg-cyan-700 text-white'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                    onclick={() => changeWindow(opt.hours)}>
                    {opt.label}
                </button>
            {/each}
        </div>
    </div>

    {#if loading}
        <p class="py-6 text-center text-sm text-surface-400">Loading trends…</p>
    {:else if loadError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {loadError}
        </div>
    {:else if points.length < 2}
        <div
            class="rounded border border-surface-700/40 bg-surface-900/30 py-8 text-center text-sm text-surface-400">
            Trends build up after the system has been running for a while. Check back once a few
            measurements have been recorded.
        </div>
    {:else}
        <div class="grid gap-4 md:grid-cols-2">
            <div>
                <div class="mb-1 flex items-center justify-between text-xs text-surface-400">
                    <span>how long jobs take (p95)</span>
                    <span class="tabular-nums text-surface-300"
                        >peak {formatSeconds(maxOf(p95Series))}</span>
                </div>
                <svg
                    viewBox="0 0 {W} {H}"
                    class="h-20 w-full"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="How long jobs take (p95) over time">
                    <polyline
                        points={polyline(p95Series)}
                        fill="none"
                        stroke="#22d3ee"
                        stroke-width="1.5"
                        vector-effect="non-scaling-stroke" />
                </svg>
            </div>
            <div>
                <div class="mb-1 flex items-center justify-between text-xs text-surface-400">
                    <span>jobs waiting to run</span>
                    <span class="tabular-nums text-surface-300">peak {maxOf(queueSeries)}</span>
                </div>
                <svg
                    viewBox="0 0 {W} {H}"
                    class="h-20 w-full"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Jobs waiting to run over time">
                    <polyline
                        points={polyline(queueSeries)}
                        fill="none"
                        stroke="#a78bfa"
                        stroke-width="1.5"
                        vector-effect="non-scaling-stroke" />
                </svg>
            </div>
            <div>
                <div class="mb-1 flex items-center justify-between text-xs text-surface-400">
                    <span>jobs finished over time</span>
                    <span class="tabular-nums">
                        <span class="text-emerald-300">{sumOf(completedSeries)} ok</span>
                        <span class="text-surface-500"> · </span>
                        <span class="text-red-300">{sumOf(failedSeries)} failed</span>
                    </span>
                </div>
                <svg
                    viewBox="0 0 {W} {H}"
                    class="h-20 w-full"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Jobs finished over time: succeeded (green) and failed (red)">
                    <polyline
                        points={polyline(completedSeries, throughputMax)}
                        fill="none"
                        stroke="#34d399"
                        stroke-width="1.5"
                        vector-effect="non-scaling-stroke" />
                    <polyline
                        points={polyline(failedSeries, throughputMax)}
                        fill="none"
                        stroke="#f87171"
                        stroke-width="1.5"
                        vector-effect="non-scaling-stroke" />
                </svg>
            </div>
        </div>
    {/if}
</section>
