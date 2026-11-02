<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { fade } from 'svelte/transition';
    import { SvelteSet } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages.js';
    import { computePosition, autoUpdate, offset, flip, shift } from '@floating-ui/dom';
    import type { MetroLineDef, ItemStageRow } from './ingest-map.constants.js';
    import type { StageActivityEntry, QueueDepthEntry } from './ingest-map.types.js';
    import {
        currentStationIndex,
        formatTrainHeadline,
        formatTrainSubtitle,
        truncateForPill,
        STATION_INFO,
        STAGE_RESOURCE_CLASS,
        stageAppliesTo,
    } from './ingest-map.constants.js';
    import { pipelineStepName, pipelineStepShortName } from '$lib/config/pipeline-step-names.js';
    import { taskStatusLabel, resourceClassLabel } from '$lib/utils/operator-labels';
    import { apiPost } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { queuePauseResponseSchema } from '$lib/schemas/admin.js';
    import { appPath } from '$lib/shared/api-urls.js';
    import { resolve } from '$lib/paths';

    interface MapItem {
        media_item_id: string;
        media_type: string;
        title: string;
        series_title?: string | null;
        season_number?: number | null;
        episode_number?: number | null;
        created_at: string;
        stages: ItemStageRow[];
    }

    interface Props {
        line: MetroLineDef;
        items: MapItem[];
        /** Maximum trains per station before aggregation. */
        maxTrainsPerStation?: number;
        /**
         * Per-stage activity snapshot — feeds the "last completed N ago"
         * caption + the running/throughput hints under each station. The
         * parent re-fetches every map refresh and on window change.
         */
        stageActivity?: StageActivityEntry[];
        /**
         * Per-resource-class queue depth + concurrency cap. Surfaced in the
         * station tooltip so an operator sees "this station has 5 pending
         * but the cpu queue has 450 items ahead of it in the same pool".
         * Distinguishes "station is genuinely stuck" from "station is just
         * waiting its turn behind a different task on the same worker".
         */
        queueDepths?: QueueDepthEntry[];
        /**
         * Server-side error message from the queueDepths fetch. When set,
         * the tooltip section renders "queue info unavailable" instead
         * of silently hiding (which looks the same as "no contention").
         */
        queueDepthsError?: string | null;
        /**
         * Wall-clock tick from the parent. Drives reactivity of the "N
         * seconds ago" captions without each MetroLine maintaining its
         * own setInterval.
         */
        nowTick?: number;
        /**
         * Called after a pause/resume action lands successfully, so the
         * parent can re-fetch queueDepths immediately instead of waiting
         * for its own poll tick — the PAUSED badge would otherwise look
         * stale for up to 20 s after the operator acts on it.
         */
        onQueueChanged?: () => void;
        /**
         * Show raw stage ids (admin IA redesign, spec §3.3: "raw ids only in
         * dev mode"). Threaded down from `$page.data.devToolsEnabled` by the
         * pipeline page. When false, the station tooltip's technical id line
         * is hidden — operators see only `pipelineStepName()`'s friendly
         * name.
         */
        devMode?: boolean;
    }

    const {
        line,
        items,
        maxTrainsPerStation = 4,
        stageActivity = [],
        queueDepths = [],
        queueDepthsError = null,
        nowTick = Date.now(),
        onQueueChanged,
        devMode = false,
    }: Props = $props();

    /** Quick lookup of queue depth by resourceClass. Empty → no data. */
    const queueByClass = $derived.by((): Record<string, QueueDepthEntry> => {
        const out: Record<string, QueueDepthEntry> = {};
        for (const q of queueDepths) out[q.resourceClass] = q;
        return out;
    });

    /** Quick lookup of activity by stage_id. Empty entries → no data. */
    const activityByStage = $derived.by((): Record<string, StageActivityEntry> => {
        const out: Record<string, StageActivityEntry> = {};
        for (const a of stageActivity) out[a.stage_id] = a;
        return out;
    });

    /**
     * Format the relative-time caption shown under each station label.
     * Returns short strings like "12s", "5m", "2h" — small enough to fit
     * a station's footer without crowding the count. Returns "—" when
     * the stage has never completed anything (no row OR last_completed_at
     * is null).
     */
    function activityCaption(stageId: string): string {
        const a = activityByStage[stageId];
        if (!a || !a.last_completed_at) return '—';
        const ms = nowTick - Date.parse(a.last_completed_at);
        if (!Number.isFinite(ms) || ms < 0) return '—';
        if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
        if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
        if (ms < 24 * 60 * 60_000) return `${Math.round(ms / 3_600_000)}h`;
        return `${Math.round(ms / 86_400_000)}d`;
    }

    /** "last done 5m ago · 12 in 5 min" — the caption under a station, with units. */
    function activityCaptionText(stageId: string, completed5m: number): string {
        const ago = activityCaption(stageId);
        const last =
            ago === '—' ? m.admin_pipeline_station_never() : m.admin_pipeline_station_last({ ago });
        return completed5m > 0
            ? `${last} · ${m.admin_pipeline_station_rate({ count: completed5m })}`
            : last;
    }

    function stationAriaLabel(stageId: string, count: number): string {
        const a = activityByStage[stageId];
        return m.admin_pipeline_station_aria({
            name: pipelineStepName(stageId),
            count,
            activity: activityCaptionText(stageId, a?.completed_5m ?? 0),
        });
    }

    /** Stale > 1h is the soft "this stage looks dead" threshold. */
    function activityIsStale(stageId: string): boolean {
        const a = activityByStage[stageId];
        if (!a || !a.last_completed_at) return false;
        const ms = nowTick - Date.parse(a.last_completed_at);
        return Number.isFinite(ms) && ms > 60 * 60_000;
    }

    // Track which station has its overflow popover expanded.
    let expandedStationIdx = $state<number | null>(null);

    // Hover-driven tooltip state. Anchored to the actual hovered SVG element
    // via Floating UI so we get viewport-collision handling, flip, shift, and
    // autoUpdate for free. Only one tooltip is visible at a time — train
    // hover hides any station tooltip and vice versa.
    interface TrainTooltip {
        kind: 'train';
        item: MapItem;
        mode: TrainAtStation['mode'];
        stationIdx: number;
    }
    interface StationTooltip {
        kind: 'station';
        stageId: string;
        stationIdx: number;
    }
    let tooltip = $state<TrainTooltip | StationTooltip | null>(null);
    let tooltipEl: HTMLDivElement | undefined = $state();
    let referenceEl: Element | null = $state(null);
    let floatingCleanup: (() => void) | undefined;

    function showTrainTooltip(
        ev: MouseEvent,
        item: MapItem,
        mode: TrainAtStation['mode'],
        stationIdx: number,
    ): void {
        cancelScheduledHide();
        referenceEl = ev.currentTarget as Element;
        tooltip = { kind: 'train', item, mode, stationIdx };
    }

    function showStationTooltip(ev: Event, stageId: string, stationIdx: number): void {
        cancelScheduledHide();
        referenceEl = ev.currentTarget as Element;
        tooltip = { kind: 'station', stageId, stationIdx };
    }

    function hideTooltip(): void {
        tooltip = null;
        referenceEl = null;
    }

    // Grace-period hide: the station tooltip's queue pause/resume button
    // (below) needs pointer-events re-enabled to be clickable, so moving
    // the cursor from the station icon into the tooltip must not lose it
    // to the station's onmouseleave firing first. scheduleHideTooltip
    // defers the hide briefly; cancelScheduledHide (called when the
    // cursor lands on the tooltip's interactive area) cancels it.
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    function scheduleHideTooltip(): void {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideTooltip, 150);
    }

    function cancelScheduledHide(): void {
        clearTimeout(hideTimer);
    }

    /** In-flight pause/resume requests, keyed by resource class — prevents
     *  duplicate submissions and drives the button's pending label. */
    const queueActionPending = new SvelteSet<string>();

    async function toggleQueue(resourceClass: string, pause: boolean): Promise<void> {
        if (queueActionPending.has(resourceClass)) return;
        queueActionPending.add(resourceClass);
        try {
            const { data, error } = await apiPost(
                `/api/queues/${encodeURIComponent(resourceClass)}/${pause ? 'pause' : 'resume'}`,
                queuePauseResponseSchema,
                pause ? {} : undefined,
            );
            if (error || !data) {
                // `queue.paused` can be up to 20s stale or changed by another
                // admin, so a redundant pause/resume click is expected. Neither
                // endpoint currently returns a benign-error status for that
                // case — resume() signals it via `wasAlreadyResumed` on an
                // otherwise-successful response (handled below) and pause()
                // has no equivalent yet — but this text match is the minimal
                // safe fallback if either ever starts returning an
                // "already paused/resumed"-worded error instead.
                if (error && /already (paused|resumed)/i.test(error)) {
                    toasts.info(error);
                } else {
                    toasts.error(error ?? `Failed to ${pause ? 'pause' : 'resume'} the queue`);
                }
            } else {
                // resume() reports a redundant call via `wasAlreadyResumed` on
                // a 200 response — surface it as info rather than success so
                // it doesn't read as "this action changed something" when it
                // didn't.
                if (data.wasAlreadyResumed) {
                    toasts.info(data.message);
                } else {
                    toasts.success(data.message);
                }
                onQueueChanged?.();
            }
        } finally {
            queueActionPending.delete(resourceClass);
        }
    }

    function findStageError(
        item: MapItem,
        stations: readonly string[],
        stationIdx: number,
    ): ItemStageRow | null {
        const target = stations[stationIdx];
        const row = item.stages.find((s) => s.stage_id === target);
        return row ?? null;
    }

    // Floating UI driver: wires `referenceEl` (the hovered SVG element) to
    // `tooltipEl` (the rendered popover) with offset + flip + shift so the
    // tooltip never crowds the cursor or escapes the viewport. autoUpdate
    // re-positions on scroll / window resize.
    $effect(() => {
        floatingCleanup?.();
        floatingCleanup = undefined;
        const ref = referenceEl;
        const flo = tooltipEl;
        if (!ref || !flo || !tooltip) return;
        // Hover-cleanup: if a previous referenceEl was detached from the
        // DOM by an SSE re-render before its mouseleave fired, the tooltip
        // would point at a ghost element. Clear it.
        if (!document.contains(ref)) {
            tooltip = null;
            referenceEl = null;
            return;
        }
        floatingCleanup = autoUpdate(ref, flo, () => {
            // `fixed`: the map scrolls sideways inside an overflow-x box, and an
            // absolutely positioned tooltip was clipped at the card edge.
            void computePosition(ref, flo, {
                strategy: 'fixed',
                placement: 'top',
                middleware: [offset(8), flip(), shift({ padding: 8 })],
            }).then(({ x, y }) => {
                Object.assign(flo.style, {
                    left: `${x}px`,
                    top: `${y}px`,
                });
            });
        });
        return () => {
            floatingCleanup?.();
            floatingCleanup = undefined;
        };
    });

    interface TrainAtStation {
        item: MapItem;
        mode: ReturnType<typeof currentStationIndex>['mode'];
    }

    // Group items by their current station index. Plain Record (not Map)
    // because svelte/prefer-svelte-reactivity rejects `new Map()` in component
    // scripts. The record is rebuilt fresh inside $derived.by on every read.
    const trainsByStation = $derived.by((): Record<number, TrainAtStation[]> => {
        const out: Record<number, TrainAtStation[]> = {};
        for (const item of items) {
            // Pass the item's media_type so currentStationIndex can skip
            // ghost stations (stages that structurally don't apply to
            // this item type — e.g. a series-typed item passing through
            // trickplay-* stations, or an album passing through every
            // station except album-enrichment). Without this, the train
            // would park at the first ghost station and never move.
            const { index, mode } = currentStationIndex(
                line.stations,
                item.stages,
                item.media_type,
            );
            const list = out[index] ?? [];
            list.push({ item, mode });
            out[index] = list;
        }
        return out;
    });

    // Returns 'solid' when this station applies to EVERY media_type the
    // line carries; 'partial' when at least one media_type stops here and
    // at least one skips; 'ghost' when no media_type in this line stops
    // here at all.
    //
    // Visual semantics:
    //   solid  — full stroke, normal label (universal station)
    //   partial — half-opacity stroke, italic label (some items pass through)
    //   ghost  — dashed stroke, italic dim label (no item on this line stops here)
    //
    // The Series line's `series-sync` is partial (tv stops, episode passes
    // through), `trickplay-*` are partial too (episode stops, tv passes
    // through). The Music line is heavily partial — most stations only
    // apply to one of the three music media_types. Solid-only would be
    // misleading; ghost-only never triggers because most stations apply
    // to at least one type. Three-state communicates the partial case
    // accurately.
    function stationApplicability(stationId: string): 'solid' | 'partial' | 'ghost' {
        let anyApplies = false;
        let anySkips = false;
        for (const mt of line.mediaTypes) {
            if (stageAppliesTo(stationId, mt)) anyApplies = true;
            else anySkips = true;
        }
        if (anyApplies && anySkips) return 'partial';
        if (anyApplies) return 'solid';
        return 'ghost';
    }

    // SVG layout constants.
    const VIEW_HEIGHT = 230;
    const PADDING_X = 80;
    const TRACK_Y = 60;
    // How far the track + forward arrow extend past the last station's
    // x-coordinate, so the arrowhead clears the station circle (r=9)
    // instead of rendering on top of it.
    const TRACK_END_OVERSHOOT = 28;
    // Train pill metrics.
    const TRAIN_WIDTH = 132;
    const TRAIN_HEIGHT = 18;
    const TRAIN_GAP = 4;
    // 44 (was 14): trains sit further below the track to leave headroom
    // for the two-line activity caption stack (relative time + 5m count
    // on the first line, failure warning on the second). Without the
    // extra room the failure caption collides with the train pill at
    // index 0.
    const TRAIN_TOP_OFFSET = 44;

    function stationX(index: number, stationsLen: number, viewBoxWidth: number): number {
        if (stationsLen <= 1) return viewBoxWidth / 2;
        return PADDING_X + (index / (stationsLen - 1)) * (viewBoxWidth - 2 * PADDING_X);
    }

    // Keep the rendered width at least the viewBox width so 16-unit station labels remain 16px.
    const VIEW_WIDTH = 1400;

    // Literal lookup tables so Tailwind JIT sees all class strings at build time.
    const FILL_LIVE: Record<string, string> = {
        sky: 'fill-sky-500',
        violet: 'fill-violet-500',
        emerald: 'fill-emerald-500',
    };
    // Dimmed per-line fill for queued-but-not-yet-running trains. Previously
    // 'waiting' shared FILL_LIVE with 'running' and was distinguished only
    // by a subtle stroke-opacity difference (trainBorderClass below) — too
    // subtle to read at pill size.
    const FILL_WAITING: Record<string, string> = {
        sky: 'fill-sky-800/50',
        violet: 'fill-violet-800/50',
        emerald: 'fill-emerald-800/50',
    };
    // 'done' trains render one shared color across every line — matches
    // CoverageGrid's "completed" swatch and the "Completed last hour"
    // ticker's chips below, instead of three different per-line shades that
    // disagreed with the ticker for the exact same item.
    const FILL_DONE_CLASS = 'fill-emerald-700/60';

    function trainFillClass(
        baseColor: string,
        mode: TrainAtStation['mode'],
        /**
         * Status of the stage the train is currently parked at, only read
         * when mode === 'failed'. Distinguishes an auto-retrying failure
         * (amber) from one that's given up and needs a manual retry (red)
         * — a split the hover tooltip already makes in text but the fill
         * color previously collapsed into a single red.
         */
        failedStatus?: ItemStageRow['status'],
    ): string {
        if (mode === 'failed') {
            return failedStatus === 'failed_transient' ? 'fill-amber-600' : 'fill-red-600';
        }
        if (mode === 'done') return FILL_DONE_CLASS;
        if (mode === 'waiting') return FILL_WAITING[baseColor] ?? 'fill-zinc-600';
        return FILL_LIVE[baseColor] ?? 'fill-zinc-500';
    }

    function trainBorderClass(mode: TrainAtStation['mode']): string {
        if (mode === 'failed') return 'stroke-red-300';
        if (mode === 'running') return 'stroke-white/80';
        return 'stroke-white/30';
    }

    function navigateToItem(itemId: string): void {
        void goto(appPath(`/admin/library/media/${itemId}?tab=pipeline`));
    }

    function toggleExpanded(idx: number): void {
        expandedStationIdx = expandedStationIdx === idx ? null : idx;
    }

    /**
     * Color the parenthetical count under a station label so non-zero
     * counts pop out of the sea of (0)s. >100 also gets bold + larger
     * type so a backlog stands out at-a-glance.
     */
    function stationCountFillClass(count: number): string {
        if (count === 0) return 'fill-zinc-400';
        if (count >= 100) return 'fill-amber-300 font-bold';
        return 'fill-amber-400';
    }
    function stationCountFontSize(count: number): string {
        // The SVG never renders narrower than 1400px; counts retain this readable size.
        return count >= 100 ? '15px' : '14px';
    }

    // Collapsed mode: items.length === 0 → render a single-line header
    // instead of the full SVG. The full layout still renders when at
    // least one item is loaded. The parent IngestMap.svelte sets
    // `defaultCollapsed` per-line; an empty line can also be expanded
    // manually with the chevron in the header.
    let manuallyExpanded = $state(false);
    const hasItems = $derived(items.length > 0);
    const showFull = $derived(hasItems || manuallyExpanded);
</script>

<section class="metro-line min-w-0" aria-label="{line.label} pipeline line">
    <header class="mb-2 flex flex-wrap items-baseline justify-between gap-2 px-2">
        <h3 class="text-sm font-semibold uppercase tracking-wider text-zinc-300">
            {line.label}
        </h3>
        <div class="flex items-baseline gap-3">
            <span class="text-xs {hasItems ? 'text-zinc-300' : 'text-zinc-400'}">
                {m.admin_pipeline_line_items({ count: items.length.toLocaleString() })}
            </span>
            {#if !hasItems}
                <button
                    type="button"
                    class="rounded px-2 py-1 text-sm text-zinc-300 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                    onclick={() => (manuallyExpanded = !manuallyExpanded)}
                    aria-expanded={showFull}>
                    {showFull ? m.admin_pipeline_line_collapse() : m.admin_pipeline_line_expand()}
                </button>
            {/if}
        </div>
    </header>

    {#if !showFull}
        <!-- Compact idle row: the line has 0 loaded items, so the full
             SVG would be a wall of "(0)"s. The expand toggle in the header
             lets operators inspect the empty pipeline manually. -->
        <p class="px-2 pb-1 text-sm text-zinc-400">
            {m.admin_pipeline_line_empty()}
        </p>
    {:else}
        <div class="max-w-full overflow-x-auto">
            <div class="relative min-w-[1400px]" onmouseleave={hideTooltip} role="presentation">
                <svg
                    viewBox="0 0 {VIEW_WIDTH} {VIEW_HEIGHT}"
                    preserveAspectRatio="xMidYMid meet"
                    class="block h-auto w-full"
                    role="img"
                    aria-label="{line.label} pipeline stations and items">
                    <!-- Track — extends a bit past the last station so the
                     forward arrow clears the station circle instead of
                     landing on top of it (they previously shared the same
                     x-coordinate, so the arrowhead was mostly hidden behind
                     the circle's fill). -->
                    <line
                        x1={PADDING_X}
                        y1={TRACK_Y}
                        x2={VIEW_WIDTH - PADDING_X + TRACK_END_OVERSHOOT}
                        y2={TRACK_Y}
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-linecap="round"
                        class="text-zinc-700" />

                    <!-- Forward arrow -->
                    <polygon
                        points="{VIEW_WIDTH -
                            PADDING_X +
                            TRACK_END_OVERSHOOT +
                            4},{TRACK_Y} {VIEW_WIDTH -
                            PADDING_X +
                            TRACK_END_OVERSHOOT -
                            8},{TRACK_Y - 8} {VIEW_WIDTH -
                            PADDING_X +
                            TRACK_END_OVERSHOOT -
                            8},{TRACK_Y + 8}"
                        class="fill-zinc-700" />

                    <!-- Stations -->
                    {#each line.stations as stage, idx (stage)}
                        {@const cx = stationX(idx, line.stations.length, VIEW_WIDTH)}
                        {@const activity = activityByStage[stage]}
                        {@const isRunning = (activity?.running ?? 0) > 0}
                        {@const stationCount = trainsByStation[idx]?.length ?? 0}
                        {@const applicability = stationApplicability(stage)}
                        <!-- Focusable, with its facts in the accessible name: the
                             details used to be hover-only (role="presentation"),
                             unreachable by keyboard, touch or a screen reader. -->
                        <g
                            class="station cursor-help focus:outline-none"
                            onmouseenter={(ev: MouseEvent) => showStationTooltip(ev, stage, idx)}
                            onmouseleave={scheduleHideTooltip}
                            onfocus={(ev: FocusEvent) => showStationTooltip(ev, stage, idx)}
                            onblur={scheduleHideTooltip}
                            role="button"
                            tabindex="0"
                            aria-label={stationAriaLabel(stage, stationCount)}
                            aria-expanded={tooltip?.kind === 'station' &&
                                tooltip.stationIdx === idx}
                            onkeydown={(ev: KeyboardEvent) => {
                                if (ev.key === 'Escape') hideTooltip();
                            }}>
                            <circle
                                {cx}
                                cy={TRACK_Y}
                                r="9"
                                stroke-width="2"
                                stroke-dasharray={applicability === 'ghost'
                                    ? '3 3'
                                    : applicability === 'partial'
                                      ? '6 2'
                                      : undefined}
                                class={isRunning
                                    ? 'fill-amber-500/30 stroke-amber-400'
                                    : applicability === 'ghost'
                                      ? 'fill-zinc-900/40 stroke-zinc-600'
                                      : applicability === 'partial'
                                        ? 'fill-zinc-900/70 stroke-zinc-500'
                                        : 'fill-zinc-900 stroke-zinc-400'}
                                opacity={applicability === 'ghost'
                                    ? 0.55
                                    : applicability === 'partial'
                                      ? 0.85
                                      : 1}>
                                {#if isRunning}
                                    <!-- Pulse so the eye catches active stages -->
                                    <animate
                                        attributeName="r"
                                        values="9;11;9"
                                        dur="1.6s"
                                        repeatCount="indefinite" />
                                {/if}
                            </circle>
                            <text
                                x={cx}
                                y={TRACK_Y + 30}
                                text-anchor="middle"
                                class={applicability === 'ghost'
                                    ? 'fill-zinc-400 text-[16px] font-medium italic'
                                    : applicability === 'partial'
                                      ? 'fill-zinc-300 text-[16px] font-medium italic'
                                      : 'fill-zinc-100 text-[16px] font-medium'}>
                                {pipelineStepShortName(stage)}
                            </text>
                            <text
                                x={cx}
                                y={TRACK_Y + 47}
                                text-anchor="middle"
                                class={stationCountFillClass(stationCount)}
                                style:font-size={stationCountFontSize(stationCount)}>
                                ({stationCount})
                            </text>
                            <!-- Activity caption: "12s · 24/5m" tells the operator
                         at-a-glance whether the stage is alive. Greys out
                         when the last completion is >1h old. Hidden when
                         we have no activity row for this stage. -->
                            {#if activity}
                                {@const completed5m = activity.completed_5m}
                                {@const failed1h = activity.failed_1h}
                                {@const stale = activityIsStale(stage)}
                                <!-- No <title> here: the surrounding <g class="station">
                             already wires its own custom hover tooltip via
                             showStationTooltip → tooltipEl popover. SVG-native
                             <title> elements compete with that for hover
                             focus and render as the OS's plain grey box,
                             which looked off-brand. The activity stats now
                             live in the custom popover (see the station
                             tooltip branch below). -->
                                <text
                                    x={cx}
                                    y={TRACK_Y + 63}
                                    text-anchor="middle"
                                    class={stale
                                        ? 'fill-zinc-600'
                                        : completed5m > 0 || isRunning
                                          ? 'fill-emerald-400'
                                          : 'fill-zinc-500'}
                                    style:font-size="13px">
                                    <!-- Was "5m · 12/5m" with no unit on either number. -->
                                    {activityCaptionText(stage, completed5m)}
                                </text>
                                {#if failed1h > 0}
                                    <text
                                        x={cx}
                                        y={TRACK_Y + 78}
                                        text-anchor="middle"
                                        class="fill-red-400"
                                        style:font-size="13px">
                                        ⚠ {failed1h} fail
                                    </text>
                                {/if}
                            {/if}
                        </g>
                    {/each}

                    <!-- Trains -->
                    {#each line.stations as _stage, stationIdx (stationIdx)}
                        {@const cx = stationX(stationIdx, line.stations.length, VIEW_WIDTH)}
                        {@const trains = trainsByStation[stationIdx] ?? []}
                        {@const visible = trains.slice(0, maxTrainsPerStation)}
                        {@const overflow = trains.length - visible.length}

                        {#each visible as train, trainIdx (train.item.media_item_id)}
                            {@const yOffset =
                                TRACK_Y +
                                TRAIN_TOP_OFFSET +
                                30 +
                                trainIdx * (TRAIN_HEIGHT + TRAIN_GAP)}
                            {@const isFailed = train.mode === 'failed'}
                            {@const failedStageRow = isFailed
                                ? findStageError(train.item, line.stations, stationIdx)
                                : null}
                            {@const yPos = isFailed
                                ? TRACK_Y -
                                  TRAIN_TOP_OFFSET -
                                  TRAIN_HEIGHT -
                                  trainIdx * (TRAIN_HEIGHT + TRAIN_GAP) -
                                  26
                                : yOffset + 14}
                            {@const headline = formatTrainHeadline(train.item)}
                            <g
                                class="train cursor-pointer transition-transform duration-500 ease-out"
                                transform="translate({cx - TRAIN_WIDTH / 2}, {yPos})"
                                in:fade={{ duration: 200 }}
                                out:fade={{ duration: 900 }}
                                onclick={() => navigateToItem(train.item.media_item_id)}
                                onmouseenter={(ev: MouseEvent) =>
                                    showTrainTooltip(ev, train.item, train.mode, stationIdx)}
                                onmouseleave={hideTooltip}
                                onkeydown={(e: KeyboardEvent) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        navigateToItem(train.item.media_item_id);
                                    }
                                }}
                                role="link"
                                tabindex="0"
                                aria-label="{headline} — {train.mode}">
                                <!-- No <title> here either: the custom train
                             tooltip below already renders headline +
                             media_type + mode + stationLabel with
                             richer formatting. The OS-native <title>
                             box would compete for hover focus. -->
                                <rect
                                    width={TRAIN_WIDTH}
                                    height={TRAIN_HEIGHT}
                                    rx="4"
                                    class="{trainFillClass(
                                        line.trainColor,
                                        train.mode,
                                        failedStageRow?.status,
                                    )} {trainBorderClass(train.mode)} {train.mode === 'running'
                                        ? 'train-pulse'
                                        : ''}"
                                    stroke-width="1" />
                                <text
                                    x={TRAIN_WIDTH / 2}
                                    y={TRAIN_HEIGHT / 2 + 4}
                                    text-anchor="middle"
                                    class="pointer-events-none fill-white text-[11px] font-medium">
                                    {truncateForPill(headline)}
                                </text>
                            </g>
                        {/each}

                        {#if overflow > 0}
                            {@const yPos =
                                TRACK_Y +
                                TRAIN_TOP_OFFSET +
                                30 +
                                maxTrainsPerStation * (TRAIN_HEIGHT + TRAIN_GAP) +
                                14}
                            <g
                                class="overflow-marker cursor-pointer"
                                transform="translate({cx - TRAIN_WIDTH / 2}, {yPos})"
                                onclick={() => toggleExpanded(stationIdx)}
                                onkeydown={(e: KeyboardEvent) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        toggleExpanded(stationIdx);
                                    }
                                }}
                                role="button"
                                tabindex="0"
                                aria-label="Show {overflow} more items at this station"
                                aria-expanded={expandedStationIdx === stationIdx}>
                                <rect
                                    width={TRAIN_WIDTH}
                                    height={TRAIN_HEIGHT}
                                    rx="4"
                                    class="fill-zinc-700 stroke-zinc-500"
                                    stroke-width="1"
                                    stroke-dasharray="3 2" />
                                <text
                                    x={TRAIN_WIDTH / 2}
                                    y={TRAIN_HEIGHT / 2 + 4}
                                    text-anchor="middle"
                                    class="pointer-events-none fill-zinc-200 text-[11px] font-medium">
                                    + {overflow} more
                                </text>
                            </g>
                        {/if}
                    {/each}
                </svg>

                <!-- Expanded-overflow popover (HTML overlay above the SVG) -->
                {#if expandedStationIdx !== null}
                    {@const trains = trainsByStation[expandedStationIdx] ?? []}
                    {@const overflow = trains.slice(maxTrainsPerStation)}
                    <div
                        class="absolute right-2 top-2 z-10 w-72 rounded border border-zinc-700 bg-zinc-900/95 p-3 shadow-lg backdrop-blur"
                        role="dialog"
                        aria-label="Overflow items">
                        <div class="mb-2 flex items-center justify-between">
                            <span class="text-xs font-medium uppercase tracking-wide text-zinc-400">
                                {pipelineStepName(line.stations[expandedStationIdx])} · {overflow.length}
                                more
                            </span>
                            <button
                                type="button"
                                class="text-zinc-400 hover:text-zinc-100"
                                onclick={() => (expandedStationIdx = null)}
                                aria-label="Close overflow list">
                                ×
                            </button>
                        </div>
                        <ul class="max-h-64 space-y-1 overflow-y-auto text-sm">
                            {#each overflow as train (train.item.media_item_id)}
                                {@const trainHeadline = formatTrainHeadline(train.item)}
                                <li>
                                    <a
                                        href={resolve(
                                            `/admin/library/media/${train.item.media_item_id}?tab=pipeline`,
                                        )}
                                        class="block truncate rounded px-2 py-1 text-zinc-200 hover:bg-zinc-800 hover:text-white"
                                        title={trainHeadline}>
                                        {trainHeadline}
                                    </a>
                                </li>
                            {/each}
                        </ul>
                        <!-- Escape hatch when the popover's max-h-64 isn't enough.
                     Drops the operator into the table view scrolled (where
                     possible) to all items at this station via a focus
                     fragment that the IngestMap table sees. -->
                        {#if overflow.length > 10}
                            <a
                                href="?view=table&focus={encodeURIComponent(
                                    line.stations[expandedStationIdx],
                                )}#scan-issues"
                                class="mt-2 inline-block w-full rounded border border-zinc-700 px-2 py-1 text-center text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white">
                                See all {overflow.length} in table view →
                            </a>
                        {/if}
                    </div>
                {/if}

                <!-- Hover tooltip — single shared <div> positioned by Floating UI.
             Anchored to the hovered SVG element so it tracks under scroll +
             flips when near the viewport edge. `pointer-events: none` so the
             tooltip never eats hover events from the elements beneath. -->
                {#if tooltip}
                    <div
                        bind:this={tooltipEl}
                        class="pointer-events-none fixed left-0 top-0 z-50 w-80 rounded border border-zinc-700 bg-zinc-950/95 p-3 text-xs shadow-xl backdrop-blur"
                        role="tooltip">
                        {#if tooltip.kind === 'train'}
                            {@const headline = formatTrainHeadline(tooltip.item)}
                            {@const subtitle = formatTrainSubtitle(tooltip.item)}
                            {@const stageRow = findStageError(
                                tooltip.item,
                                line.stations,
                                tooltip.stationIdx,
                            )}
                            {@const stationLabel = pipelineStepName(
                                line.stations[tooltip.stationIdx],
                            )}
                            <div class="mb-1 font-semibold text-zinc-100">
                                {headline}
                            </div>
                            {#if subtitle && subtitle !== headline}
                                <div class="mb-2 text-[11px] italic text-zinc-400">
                                    {subtitle}
                                </div>
                            {/if}
                            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
                                <dt class="text-zinc-500">Type</dt>
                                <dd class="text-zinc-200">
                                    {tooltip.item.media_type}
                                </dd>
                                <dt class="text-zinc-500">Stage</dt>
                                <dd class="text-zinc-200">{stationLabel}</dd>
                                <dt class="text-zinc-500">Status</dt>
                                <dd
                                    class={stageRow?.status?.startsWith('failed')
                                        ? 'text-red-300'
                                        : stageRow?.status?.startsWith('skipped')
                                          ? 'text-amber-300'
                                          : 'text-zinc-200'}>
                                    {tooltip.mode}{#if stageRow}{` · ${taskStatusLabel(stageRow.status)}`}{/if}
                                </dd>
                                {#if stageRow?.attempt && stageRow.attempt > 0}
                                    <dt class="text-zinc-500">Attempt</dt>
                                    <dd
                                        class={stageRow.attempt >= 3
                                            ? 'font-semibold text-amber-300'
                                            : 'text-zinc-200'}
                                        title={stageRow.attempt >= 3
                                            ? 'Lots of retries — this item is struggling and getting close to giving up'
                                            : undefined}>
                                        {stageRow.attempt}{#if stageRow.attempt >= 3}
                                            ⚠{/if}
                                    </dd>
                                {/if}
                                {#if stageRow?.skipped_reason}
                                    <dt class="text-zinc-500">Why skipped</dt>
                                    <dd
                                        class="font-mono text-amber-300"
                                        title="Why this step was skipped for this item. 'predicate-false' means this step does not apply to this item; other values come from the specific feature.">
                                        {stageRow.skipped_reason}
                                    </dd>
                                {/if}
                                {#if stageRow?.next_eligible_at}
                                    {@const retryParsed = Date.parse(
                                        stageRow.next_eligible_at as string,
                                    )}
                                    {@const retryValid = Number.isFinite(retryParsed)}
                                    {@const retryDeltaMs = retryValid ? retryParsed - nowTick : 0}
                                    <dt class="text-zinc-500">Next retry</dt>
                                    <dd
                                        class={!retryValid
                                            ? 'text-amber-300'
                                            : retryDeltaMs > 0
                                              ? 'text-zinc-300'
                                              : 'text-emerald-300'}
                                        title={retryValid
                                            ? new Date(retryParsed).toLocaleString()
                                            : `Malformed retry timestamp: ${String(stageRow.next_eligible_at)}`}>
                                        {#if !retryValid}
                                            invalid timestamp
                                        {:else if retryDeltaMs > 86_400_000}
                                            in {Math.round(retryDeltaMs / 86_400_000)}d
                                        {:else if retryDeltaMs > 3_600_000}
                                            in {Math.round(retryDeltaMs / 3_600_000)}h
                                        {:else if retryDeltaMs > 60_000}
                                            in {Math.round(retryDeltaMs / 60_000)}m
                                        {:else if retryDeltaMs > 0}
                                            in {Math.max(1, Math.round(retryDeltaMs / 1000))}s
                                        {:else}
                                            any moment now
                                        {/if}
                                    </dd>
                                {:else if stageRow?.status === 'failed_transient' || stageRow?.status === 'skipped_transient'}
                                    <!-- Transient status without a next_eligible_at
                                 means the row will be picked back up on the
                                 next stage-sweep tick rather than at a
                                 scheduled time. Surface that explicitly so
                                 the absence of a countdown doesn't read as
                                 "retry never scheduled, abandoned forever". -->
                                    <dt class="text-zinc-500">Next retry</dt>
                                    <dd
                                        class="text-emerald-300"
                                        title="No specific retry time set — this will be picked up again within about a minute.">
                                        any moment now
                                    </dd>
                                {:else if stageRow?.status === 'failed_permanent' || stageRow?.status === 'obsolete'}
                                    <!-- Terminal non-success states: the pipeline
                                 will NOT retry on its own. Make this
                                 explicit so the operator can distinguish
                                 "abandoned" from "scheduler picks up next"
                                 (above) and decide whether to manually
                                 retry from the item's pipeline tab. -->
                                    <dt class="text-zinc-500">Next retry</dt>
                                    <dd
                                        class="text-zinc-500"
                                        title="This step won't retry on its own. Retry it by hand from the item's Pipeline tab to resume.">
                                        never (retry by hand)
                                    </dd>
                                {/if}
                            </dl>
                            {#if stageRow?.last_error?.message}
                                <div
                                    class="mt-2 rounded bg-red-950/40 px-2 py-1 text-[11px] text-red-200">
                                    {stageRow.last_error.message}
                                </div>
                            {/if}
                            <div class="mt-2 text-[10px] uppercase tracking-wide text-zinc-500">
                                Click to open pipeline tab →
                            </div>
                        {:else}
                            {@const stationStageId = tooltip.stageId}
                            {@const info = STATION_INFO[stationStageId]}
                            {@const count = trainsByStation[tooltip.stationIdx]?.length ?? 0}
                            {@const stationActivity = activityByStage[stationStageId]}
                            {@const appliesTypes = line.mediaTypes.filter((mt) =>
                                stageAppliesTo(stationStageId, mt),
                            )}
                            {@const skipsTypes = line.mediaTypes.filter(
                                (mt) => !stageAppliesTo(stationStageId, mt),
                            )}
                            <div class="mb-1 font-semibold text-zinc-100">
                                {pipelineStepName(stationStageId)}
                            </div>
                            {#if devMode}
                                <div
                                    class="mb-2 font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                                    {tooltip.stageId}
                                </div>
                            {/if}
                            {#if info?.description}
                                <p class="text-[11px] leading-snug text-zinc-300">
                                    {info.description}
                                </p>
                            {/if}
                            <div
                                class="mt-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-400">
                                {count} item{count === 1 ? '' : 's'} parked here
                            </div>
                            <!-- Per-media-type applicability. The metro line aggregates
                         multiple media_types but each station only structurally
                         applies to a subset (e.g. trickplay-generation runs on
                         movie/episode, not series). This callout makes the
                         "trains pass through but don't stop here" rule explicit
                         instead of just rendering a dashed circle. -->
                            {#if skipsTypes.length > 0}
                                <div
                                    class="mt-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-400">
                                    <div>
                                        Applies to:
                                        <span class="text-zinc-200">
                                            {appliesTypes.length === 0
                                                ? '— (none on this line)'
                                                : appliesTypes.join(', ')}
                                        </span>
                                    </div>
                                    <div class="text-zinc-500">
                                        Pass-through for:
                                        <span class="italic">{skipsTypes.join(', ')}</span>
                                    </div>
                                </div>
                            {/if}
                            <!-- Activity stats — surfaces what used to be in the
                         native browser-title attribute on the SVG <text>
                         elements below the station (which competed with
                         this custom tooltip for hover focus). -->
                            {#if stationActivity}
                                <dl
                                    class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-zinc-800 pt-2 text-[11px] text-zinc-400">
                                    <dt class="text-zinc-500">Last completed</dt>
                                    <dd class="font-mono text-zinc-300">
                                        {stationActivity.last_completed_at
                                            ? new Date(
                                                  stationActivity.last_completed_at,
                                              ).toLocaleString()
                                            : '—'}
                                    </dd>
                                    <dt class="text-zinc-500">Completed (5 min)</dt>
                                    <dd
                                        class="font-mono {stationActivity.completed_5m > 0
                                            ? 'text-emerald-400'
                                            : 'text-zinc-300'}">
                                        {stationActivity.completed_5m}
                                    </dd>
                                    <dt class="text-zinc-500">Running</dt>
                                    <dd
                                        class="font-mono {stationActivity.running > 0
                                            ? 'text-emerald-400'
                                            : 'text-zinc-300'}">
                                        {stationActivity.running}
                                    </dd>
                                    <dt class="text-zinc-500">Failed (1 h)</dt>
                                    <dd
                                        class="font-mono {stationActivity.failed_1h > 0
                                            ? 'text-red-400'
                                            : 'text-zinc-300'}">
                                        {stationActivity.failed_1h}
                                    </dd>
                                </dl>
                            {/if}
                            <!-- Worker-pool queue context. Distinguishes "this stage
                         is stuck" from "this stage shares a worker with
                         other tasks and there are 450 of those ahead in
                         line". Without this, operators have no way to tell
                         that a station with 5 pending and 0 throughput is
                         actually waiting for a different task to drain. -->
                            {@const resourceClass = STAGE_RESOURCE_CLASS[tooltip.stageId]}
                            {@const queue = resourceClass ? queueByClass[resourceClass] : undefined}
                            <!-- Surface fetch errors so an unavailable queue-depths
                         endpoint doesn't masquerade as a quiet pool. The
                         silent-hide branch (no queue + no error) is the
                         legitimate "no contention" case; the error branch
                         is the operator-actionable one. -->
                            {#if !queue && queueDepthsError && resourceClass}
                                <div
                                    class="mt-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
                                    <div class="text-zinc-500">
                                        Shared with: <span
                                            >{resourceClassLabel(resourceClass)}</span> jobs
                                    </div>
                                    <p class="mt-1 italic text-amber-300/70">
                                        Queue info unavailable ({queueDepthsError.slice(0, 80)}).
                                    </p>
                                </div>
                            {/if}
                            <!-- Hide on quiet pools so the tooltip stays compact for
                         the common case. Operators only see the worker-pool
                         section when there's something to communicate. -->
                            {#if queue && (queue.active > 0 || queue.waiting > 0 || queue.paused)}
                                <div
                                    class="mt-2 border-t border-zinc-800 pt-2 text-[11px] text-zinc-400">
                                    <!-- pointer-events-auto: the tooltip container is
                                 pointer-events-none so it never eats hover from
                                 the SVG elements underneath it. This row is the
                                 one exception — it holds the pause/resume button,
                                 so it re-enables pointer events for itself and
                                 uses the hide-timer pair (cancelScheduledHide /
                                 scheduleHideTooltip) so the cursor can travel
                                 from the station icon onto the button without
                                 the tooltip disappearing first. -->
                                    <div
                                        class="mb-1 flex flex-wrap items-center gap-2 pointer-events-auto text-zinc-500"
                                        role="presentation"
                                        onmouseenter={cancelScheduledHide}
                                        onmouseleave={scheduleHideTooltip}>
                                        <span>
                                            Shared with: <span class="text-zinc-200"
                                                >{resourceClassLabel(resourceClass)}</span> jobs
                                        </span>
                                        {#if queue.paused}
                                            <span
                                                class="inline-block rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] text-amber-200"
                                                >PAUSED</span>
                                        {/if}
                                        {#if resourceClass}
                                            {@const pending = queueActionPending.has(resourceClass)}
                                            <button
                                                type="button"
                                                class="ml-auto shrink-0 rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
                                                disabled={pending}
                                                aria-label={queue.paused
                                                    ? `Resume the ${resourceClassLabel(resourceClass)} queue`
                                                    : `Pause the ${resourceClassLabel(resourceClass)} queue`}
                                                onclick={() =>
                                                    void toggleQueue(resourceClass, !queue.paused)}>
                                                {pending
                                                    ? '…'
                                                    : queue.paused
                                                      ? m.hero_resume()
                                                      : m.player_pause()}
                                            </button>
                                        {/if}
                                    </div>
                                    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                                        <dt class="text-zinc-500">Running now</dt>
                                        <dd
                                            class="font-mono {queue.active >=
                                                queue.concurrencyCap && queue.concurrencyCap > 0
                                                ? 'text-emerald-400'
                                                : 'text-zinc-300'}">
                                            {queue.active} / {queue.concurrencyCap}
                                        </dd>
                                        <dt class="text-zinc-500">Waiting in queue</dt>
                                        <dd
                                            class="font-mono {queue.waiting > 100
                                                ? 'text-amber-300'
                                                : queue.waiting > 0
                                                  ? 'text-zinc-300'
                                                  : 'text-zinc-500'}">
                                            {queue.waiting}
                                        </dd>
                                    </dl>
                                    <!-- Threshold scales with the pool's concurrency cap
                                 so the advisory fires when contention is
                                 meaningful relative to throughput, not at a
                                 fixed magic number. Floor of 50 keeps small
                                 pools (concurrency=1) from spamming the
                                 advisory on routine 1-2 item queues.
                                 Expression inlined (not {@const}) because
                                 Svelte 5 requires {@const} to be the immediate
                                 child of an {#if}/{#each}/etc., not a <div>. -->
                                    {#if queue.waiting > Math.max(50, queue.concurrencyCap * 25) && (!stationActivity || stationActivity.completed_5m === 0)}
                                        <p class="mt-1 text-[10px] italic text-amber-300">
                                            This step shares capacity with other {resourceClassLabel(
                                                resourceClass,
                                            )} jobs. Items here may be waiting their turn behind {queue.waiting}
                                            other jobs.
                                        </p>
                                    {/if}
                                </div>
                            {/if}
                        {/if}
                    </div>
                {/if}
            </div>
        </div>
    {/if}
</section>

<style>
    .metro-line {
        contain: layout;
    }

    /* Pulse animation for running trains. CSS transform-friendly so SVG transitions still work. */
    :global(.train-pulse) {
        animation: train-pulse 1.4s ease-in-out infinite;
    }

    @keyframes train-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.55;
        }
    }

    .train:focus-visible {
        outline: 2px solid rgb(56 189 248); /* sky-400 */
        outline-offset: 2px;
    }

    .overflow-marker:focus-visible {
        outline: 2px solid rgb(161 161 170); /* zinc-400 */
        outline-offset: 2px;
    }
</style>
