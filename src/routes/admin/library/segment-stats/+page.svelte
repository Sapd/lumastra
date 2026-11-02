<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { z } from 'zod';
    import { Icon, ArrowPath, ChartBar } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { apiGet } from '$lib/api/client.js';
    import * as m from '$lib/paraglide/messages.js';

    const METHODS = [
        'manual',
        'chapter-title',
        'cohort',
        'chromaprint',
        'anime-synth',
        'chapter-mark',
        'blackframe',
        'stale-manual',
    ] as const;
    const SEGMENT_TYPES = ['Intro', 'Outro', 'Preview', 'Recap', 'Commercial'] as const;
    const MAX_DISPLAY_BUCKETS = 300;
    const BUCKET_LIMITS = { min: 1, max: 300 } as const;
    const THRESHOLD_LIMITS = { min: 1, max: 3600 } as const;
    type SegmentType = (typeof SEGMENT_TYPES)[number];

    const StatsSchema = z.object({
        type: z.enum(SEGMENT_TYPES),
        bucketSeconds: z.number(),
        histogram: z.array(
            z.object({
                method: z.string(),
                bucketStart: z.number(),
                items: z.number(),
            }),
        ),
        summary: z.array(
            z.object({
                method: z.string(),
                items: z.number(),
                p50: z.number(),
                p90: z.number(),
                p99: z.number(),
                maxSeconds: z.number(),
                snappedToChapter: z.number(),
            }),
        ),
        configCohorts: z.array(
            z.object({
                configHash: z.string().nullable(),
                detectorVersion: z.number(),
                items: z.number(),
                methods: z.number(),
                oldest: z.string().nullable(),
                newest: z.string().nullable(),
            }),
        ),
        repairBacklog: z
            .object({
                minLengthSeconds: z.number(),
                items: z.number(),
                lengths: z.array(z.object({ bucketStart: z.number(), items: z.number() })),
            })
            .nullable(),
    });

    type Stats = z.infer<typeof StatsSchema>;

    let stats = $state<Stats | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let segmentType = $state<SegmentType>('Outro');
    let bucketSeconds = $state(15);
    let minLength = $state(90);
    let requestGeneration = 0;

    const methodLabel = (method: string): string => method.replaceAll('-', ' ');
    // m:ss, not rounded minutes: whole minutes collapsed every p90/p99 onto
    // "2m" and labelled the 150 s bucket "3m", which is exactly the resolution
    // this screen exists to show.
    const seconds = (value: number): string => {
        const total = Math.round(value);
        if (total < 60) return `${total}s`;
        return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    };
    const rangeLabel = (start: number, width: number): string =>
        `${seconds(start)}–${seconds(start + width)}`;
    const percent = (part: number, whole: number): string =>
        whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–';
    const clampInt = (value: unknown, limits: { min: number; max: number }, fallback: number) => {
        // An emptied number input binds null, and Number(null) is 0.
        if (value === null || value === undefined || value === '') return fallback;
        const parsed = Math.floor(Number(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(limits.max, Math.max(limits.min, parsed));
    };
    const dateLabel = (value: string | null): string =>
        value ? new Date(value).toLocaleDateString() : m.admin_segment_stats_unknown();

    type HistogramBucket = Stats['histogram'][number];

    function buildDisplayHistogram(value: Stats | null): {
        buckets: HistogramBucket[];
        starts: number[];
        step: number;
    } {
        if (!value || value.histogram.length === 0) return { buckets: [], starts: [], step: 1 };

        const sourceStep = Math.max(1, Math.floor(value.bucketSeconds));
        let maxStart = 0;
        for (const bucket of value.histogram) maxStart = Math.max(maxStart, bucket.bucketStart);
        const sourceBucketCount = Math.floor(maxStart / sourceStep) + 1;
        const displayStep =
            sourceStep * Math.max(1, Math.ceil(sourceBucketCount / MAX_DISPLAY_BUCKETS));

        const merged: Record<string, HistogramBucket> = {};
        for (const bucket of value.histogram) {
            const bucketStart = Math.floor(bucket.bucketStart / displayStep) * displayStep;
            const key = `${bucket.method}:${bucketStart}`;
            const existing = merged[key];
            if (existing) existing.items += bucket.items;
            else merged[key] = { ...bucket, bucketStart };
        }

        const starts: number[] = [];
        const maxDisplayStart = Math.floor(maxStart / displayStep) * displayStep;
        for (let start = 0; start <= maxDisplayStart; start += displayStep) starts.push(start);
        return { buckets: Object.values(merged), starts, step: displayStep };
    }

    function maximumItems(buckets: { items: number }[]): number {
        let max = 1;
        for (const bucket of buckets) max = Math.max(max, bucket.items);
        return max;
    }

    /** Axis labels at the first, middle and last bucket edge. */
    function axisTicks(starts: number[], step: number): number[] {
        if (starts.length === 0) return [];
        const end = (starts.at(-1) ?? 0) + step;
        const mid = Math.round(end / 2 / step) * step;
        return [...new Set([starts[0] ?? 0, mid, end])];
    }

    let displayHistogram = $derived(buildDisplayHistogram(stats));
    let bucketStarts = $derived(displayHistogram.starts);
    let histogramTicks = $derived(axisTicks(bucketStarts, displayHistogram.step));
    let axisEnd = $derived((bucketStarts.at(-1) ?? 0) + displayHistogram.step);
    // The threshold the loaded data was computed with, not the live input.
    let threshold = $derived(stats?.repairBacklog?.minLengthSeconds ?? null);
    // Detectors listed in the summary's order (most candidates first) so the
    // bars and the table read in the same sequence; unknown methods the page
    // has no constant for still get a row.
    let methodOrder = $derived([
        ...new Set([
            ...(stats?.summary.map((row) => row.method) ?? []),
            ...METHODS,
            ...displayHistogram.buckets.map((bucket) => bucket.method),
        ]),
    ]);
    let histogramByMethod = $derived(
        methodOrder
            .map((method) => {
                const buckets = bucketStarts.map((bucketStart) => ({
                    bucketStart,
                    items:
                        displayHistogram.buckets.find(
                            (bucket) =>
                                bucket.method === method && bucket.bucketStart === bucketStart,
                        )?.items ?? 0,
                }));
                return {
                    method,
                    buckets,
                    // Scaled per detector: one shared scale flattened every
                    // detector but the largest, and the question here is each
                    // detector's SHAPE, not their relative volume.
                    max: maximumItems(buckets),
                    summary: stats?.summary.find((summary) => summary.method === method),
                    hasData: buckets.some((bucket) => bucket.items > 0),
                };
            })
            .filter((row) => row.hasData || row.summary),
    );
    let backlogLengths = $derived(stats?.repairBacklog?.lengths ?? []);
    let backlogStep = $derived(
        backlogLengths.length > 1
            ? Math.max(
                  1,
                  (backlogLengths[1]?.bucketStart ?? 0) - (backlogLengths[0]?.bucketStart ?? 0),
              )
            : 1,
    );
    let backlogMax = $derived(maximumItems(backlogLengths));

    async function loadStats(): Promise<void> {
        // An emptied or out-of-range field used to go to the server as-is and
        // come back as a 400 that replaced the whole page with an error.
        bucketSeconds = clampInt(bucketSeconds, BUCKET_LIMITS, 15);
        minLength = clampInt(minLength, THRESHOLD_LIMITS, 90);
        const generation = ++requestGeneration;
        loading = true;
        error = null;
        const params = new URLSearchParams({
            type: segmentType,
            bucketSeconds: String(bucketSeconds),
            minLength: String(minLength),
        });
        const result = await apiGet(`/api/admin/media-segments/stats?${params}`, StatsSchema);
        if (generation !== requestGeneration) return;
        if (result.data) stats = result.data;
        else error = result.error ?? m.admin_segment_stats_load_failed();
        loading = false;
    }

    function refresh(): void {
        void loadStats();
    }

    onMount(() => {
        void loadStats();
    });
</script>

<svelte:head>
    <title>{m.route_admin_segment_stats_title()}</title>
</svelte:head>

{#snippet bars(
    buckets: { bucketStart: number; items: number }[],
    max: number,
    width: number,
    threshold: number | null,
)}
    <div class="flex h-20 items-end gap-px border-b border-surface-700 sm:gap-0.5">
        {#each buckets as bucket (bucket.bucketStart)}
            {@const over = threshold !== null && bucket.bucketStart >= threshold}
            <!-- h-full: the bar's % height needs a definite column height;
                 without it every bar resolved to 0 px. -->
            <div
                class="group flex h-full min-w-0 flex-1 items-end"
                title={`${rangeLabel(bucket.bucketStart, width)} · ${bucket.items.toLocaleString()} ${m.admin_segment_stats_items()}`}>
                <div
                    class="w-full rounded-t-sm transition-colors {over
                        ? 'bg-amber-500/70 group-hover:bg-amber-400'
                        : 'bg-cyan-500/70 group-hover:bg-cyan-400'}"
                    style={`height: ${bucket.items === 0 ? 0 : Math.max(3, (bucket.items / max) * 100)}%`}>
                </div>
            </div>
        {/each}
    </div>
{/snippet}

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/segment-stats']}
        title={m.route_admin_segment_stats_title()}
        description={m.route_admin_segment_stats_description()}>
        <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg bg-surface-800 px-3 py-2 text-sm text-surface-200 hover:bg-surface-700 disabled:opacity-50"
            onclick={refresh}
            disabled={loading}>
            <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
            {m.admin_segment_stats_refresh()}
        </button>
    </AdminPageHeader>

    <div
        class="flex flex-wrap items-end gap-3 rounded-lg border border-surface-700 bg-surface-800/40 p-4">
        <label class="flex flex-col gap-1 text-xs text-surface-400">
            {m.admin_segment_stats_type()}
            <select
                bind:value={segmentType}
                onchange={refresh}
                class="rounded bg-surface-900 px-3 py-2 text-sm text-surface-100">
                {#each SEGMENT_TYPES as type (type)}
                    <option value={type}>{type}</option>
                {/each}
            </select>
        </label>
        <label class="flex flex-col gap-1 text-xs text-surface-400">
            {m.admin_segment_stats_bucket()}
            <input
                bind:value={bucketSeconds}
                onchange={refresh}
                type="number"
                min="1"
                max="300"
                class="w-24 rounded bg-surface-900 px-3 py-2 text-sm text-surface-100" />
        </label>
        <!-- The repair backlog exists only for Outro; the field did nothing
             for any other type. -->
        {#if segmentType === 'Outro'}
            <label class="flex flex-col gap-1 text-xs text-surface-400">
                {m.admin_segment_stats_backlog_threshold()}
                <input
                    bind:value={minLength}
                    onchange={refresh}
                    type="number"
                    min="1"
                    max="3600"
                    class="w-24 rounded bg-surface-900 px-3 py-2 text-sm text-surface-100" />
            </label>
        {/if}
    </div>

    {#if loading && !stats}
        <div
            class="rounded-lg border border-surface-700 bg-surface-800/40 p-10 text-center text-surface-400">
            {m.admin_segment_stats_loading()}
        </div>
    {:else if error}
        <div class="rounded-lg border border-red-900/60 bg-red-950/30 p-5 text-red-300">
            <p>{error}</p>
            <button type="button" class="mt-3 text-sm underline" onclick={refresh}
                >{m.btn_retry()}</button>
        </div>
    {:else if stats}
        <div class="space-y-6 transition-opacity {loading ? 'opacity-60' : ''}" aria-busy={loading}>
            <section class="rounded-lg border border-surface-700 bg-surface-800/40 p-5">
                <div class="mb-1 flex items-center gap-2">
                    <Icon src={ChartBar} class="h-5 w-5 text-cyan-400" />
                    <h2 class="text-base font-semibold text-surface-100">
                        {m.admin_segment_stats_histogram()}
                    </h2>
                </div>
                <p class="mb-5 text-xs text-surface-500">
                    {m.admin_segment_stats_scale_hint()}
                    {#if threshold !== null}
                        {m.admin_segment_stats_threshold_hint({ seconds: threshold })}
                    {/if}
                </p>
                {#if histogramByMethod.length === 0}
                    <p class="text-sm text-surface-500">{m.admin_segment_stats_no_candidates()}</p>
                {:else}
                    <div class="space-y-5">
                        {#each histogramByMethod as row (row.method)}
                            <div>
                                <div class="mb-2 flex items-center justify-between text-sm">
                                    <span class="capitalize text-surface-200"
                                        >{methodLabel(row.method)}</span>
                                    {#if row.summary}
                                        <span class="text-xs tabular-nums text-surface-500"
                                            >{m.admin_segment_stats_p50()}
                                            {seconds(row.summary.p50)} · p90
                                            {seconds(row.summary.p90)} ·
                                            {row.summary.items.toLocaleString()}
                                            {m.admin_segment_stats_items()}</span>
                                    {/if}
                                </div>
                                {@render bars(
                                    row.buckets,
                                    row.max,
                                    displayHistogram.step,
                                    threshold,
                                )}
                                <div
                                    class="relative mt-1 h-3 text-[10px] tabular-nums text-surface-500">
                                    {#each histogramTicks as tick, i (tick)}
                                        <span
                                            class="absolute {i === 0
                                                ? ''
                                                : i === histogramTicks.length - 1
                                                  ? '-translate-x-full'
                                                  : '-translate-x-1/2'}"
                                            style={`left: ${(tick / axisEnd) * 100}%`}
                                            >{seconds(tick)}</span>
                                    {/each}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </section>

            <section class="rounded-lg border border-surface-700 bg-surface-800/40 p-5">
                <h2 class="mb-4 text-base font-semibold text-surface-100">
                    {m.admin_segment_stats_summary()}
                </h2>
                <div class="overflow-x-auto">
                    <table class="w-full min-w-[620px] text-left text-sm tabular-nums">
                        <thead class="text-xs uppercase text-surface-500">
                            <tr>
                                <th class="pb-2">{m.admin_segment_stats_method()}</th>
                                <th class="pb-2 text-right"
                                    >{m.admin_segment_stats_items_column()}</th>
                                <th class="pb-2 text-right">{m.admin_segment_stats_p50()}</th>
                                <th class="pb-2 text-right">p90</th>
                                <th class="pb-2 text-right">p99</th>
                                <th class="pb-2 text-right">{m.admin_segment_stats_max()}</th>
                                <th class="pb-2 text-right"
                                    >{m.admin_segment_stats_chapter_snapped()}</th>
                            </tr>
                        </thead>
                        <tbody class="text-surface-300">
                            {#each stats.summary as row (row.method)}
                                <tr class="border-t border-surface-700/70">
                                    <td class="py-2 capitalize text-surface-200"
                                        >{methodLabel(row.method)}</td>
                                    <td class="text-right">{row.items.toLocaleString()}</td>
                                    <td class="text-right">{seconds(row.p50)}</td>
                                    <td
                                        class="text-right {threshold !== null &&
                                        row.p90 >= threshold
                                            ? 'text-amber-300'
                                            : ''}">{seconds(row.p90)}</td>
                                    <td class="text-right">{seconds(row.p99)}</td>
                                    <td class="text-right">{seconds(row.maxSeconds)}</td>
                                    <td class="text-right"
                                        >{row.snappedToChapter.toLocaleString()}
                                        <span class="text-xs text-surface-500"
                                            >({percent(row.snappedToChapter, row.items)})</span
                                        ></td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            </section>

            {#if stats.repairBacklog}
                <section class="rounded-lg border border-amber-900/50 bg-amber-950/20 p-5">
                    <h2 class="text-base font-semibold text-amber-200">
                        {m.admin_segment_stats_repair_backlog()}
                    </h2>
                    <div class="mt-2 flex flex-col gap-4 sm:flex-row sm:items-end">
                        <div class="shrink-0">
                            <p class="text-2xl font-semibold tabular-nums text-amber-100">
                                {stats.repairBacklog.items.toLocaleString()}
                            </p>
                            <p class="text-sm text-amber-300/80">
                                {m.admin_segment_stats_repair_description({
                                    seconds: stats.repairBacklog.minLengthSeconds,
                                })}
                            </p>
                        </div>
                        {#if backlogLengths.length > 0}
                            <div class="min-w-0 flex-1">
                                {@render bars(backlogLengths, backlogMax, backlogStep, 0)}
                                <div
                                    class="mt-1 flex justify-between text-[10px] tabular-nums text-amber-300/60">
                                    <span>{seconds(backlogLengths[0]?.bucketStart ?? 0)}</span>
                                    <span
                                        >{seconds(
                                            (backlogLengths.at(-1)?.bucketStart ?? 0) + backlogStep,
                                        )}</span>
                                </div>
                            </div>
                        {/if}
                    </div>
                </section>
            {/if}

            <section class="rounded-lg border border-surface-700 bg-surface-800/40 p-5">
                <h2 class="mb-4 text-base font-semibold text-surface-100">
                    {m.admin_segment_stats_cohorts()}
                </h2>
                {#if stats.configCohorts.length === 0}
                    <p class="text-sm text-surface-500">{m.admin_segment_stats_no_cohorts()}</p>
                {:else}
                    <div class="space-y-2">
                        <!-- Cohorts are grouped by (config_hash, detector_version): a detector bump
                         with an unchanged config yields two rows with one hash. -->
                        {#each stats.configCohorts as cohort, index (`${cohort.configHash ?? `unknown-${index}`}:${cohort.detectorVersion}`)}
                            <div
                                class="flex flex-wrap items-center justify-between gap-3 border-t border-surface-700/70 py-3 text-sm">
                                <span class="flex items-center gap-2 text-surface-200"
                                    >{m.admin_segment_stats_cohort({ number: index + 1 })}
                                    {#if cohort.configHash}
                                        <code class="text-xs text-surface-500"
                                            >{cohort.configHash.slice(0, 8)}</code>
                                    {/if}
                                    {#if index === 0}
                                        <span
                                            class="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-cyan-300"
                                            >{m.admin_segment_stats_current()}</span>
                                    {/if}
                                </span>
                                <span class="tabular-nums text-surface-400"
                                    >v{cohort.detectorVersion} · {cohort.methods}
                                    {m.admin_segment_stats_methods()} · {cohort.items.toLocaleString()}
                                    {m.admin_segment_stats_items()}</span>
                                <span class="text-xs text-surface-500"
                                    >{dateLabel(cohort.oldest)} – {dateLabel(cohort.newest)}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            </section>
        </div>
    {/if}
</div>
