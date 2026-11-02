<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack, onDestroy } from 'svelte';
    import MetroLine from './MetroLine.svelte';
    import {
        getIngestMap,
        getIngestScanIssues,
        getIngestStageActivity,
        getIngestDiagnostics,
        getIngestQueueDepths,
    } from '$lib/api/admin.js';
    import {
        LINES,
        SUMMARY_BUCKETS,
        lineForMediaType,
        currentStationIndex,
        formatTrainHeadline,
        recentlyCompleted,
        type ItemStageRow,
    } from './ingest-map.constants.js';
    import type {
        MapItem,
        MapResponse,
        ScanIssueRow,
        StageActivityEntry,
        QueueDepthEntry,
        SummaryBucketCount,
        PipelineSummary,
        StuckItemEntry,
        DeadLetterEntry,
        ErrorGroupEntry,
    } from './ingest-map.types.js';
    import HealthStrip from './HealthStrip.svelte';
    import DiagnosticsPanels from './DiagnosticsPanels.svelte';
    import { UNLINKED_FILE_HEALTH_ISSUE_TYPES } from '$lib/types/pipeline.js';
    import { fileHealthIssueLabel } from '$lib/utils/file-health-issue.js';
    import {
        isMovie as _isMovie,
        isSeries as _isSeries,
        isEpisode as _isEpisode,
    } from '$lib/shared/media-types';
    import * as m from '$lib/paraglide/messages.js';
    import { apiUrl } from '$lib/shared/api-urls.js';
    import { resolve } from '$lib/paths';

    interface Props {
        initial: MapResponse;
        /** Default window key. */
        defaultWindow?: '1h' | '24h' | '7d' | '30d' | 'all';
        /** Inject EventSource for testing. */
        eventSourceFactory?: (url: string) => EventSourceLike;
        /**
         * Show raw stage ids in station tooltips (admin IA redesign, spec
         * §3.3: "raw ids only in dev mode"). Threaded from
         * `$page.data.devToolsEnabled`.
         */
        devMode?: boolean;
    }

    interface EventSourceLike {
        addEventListener(type: string, listener: (ev: { data: string }) => void): void;
        close(): void;
        /**
         * Some EventSourceLike test fakes don't expose readyState. We touch
         * it best-effort in $effect to drive the live indicator; treat
         * undefined as "open" (test stubs imply a working connection).
         */
        readyState?: number;
    }

    const { initial, defaultWindow = '24h', eventSourceFactory, devMode = false }: Props = $props();

    type WindowKey = '1h' | '24h' | '7d' | '30d' | 'all';

    // Snapshot the initial-render props once. These do NOT track changes to
    // the parent-provided values — IngestMap owns its state after mount and
    // re-fetches via the window selector. Reading them via `untrack` so Svelte
    // doesn't flag a state_referenced_locally warning.
    let windowKey = $state<WindowKey>(untrack(() => defaultWindow));
    let loadedWindowKey = $state<WindowKey>(untrack(() => defaultWindow));
    let items = $state<MapItem[]>(untrack(() => initial.items));
    let summaryBuckets = $state<SummaryBucketCount[]>(untrack(() => initial.summaryBuckets ?? []));
    let scanIssues = $state<ScanIssueRow[]>(untrack(() => initial.scanIssues ?? []));
    let scanIssuesExpanded = $state(false);
    let stageActivity = $state<StageActivityEntry[]>(untrack(() => initial.stageActivity ?? []));
    let queueDepths = $state<QueueDepthEntry[]>(untrack(() => initial.queueDepths ?? []));
    let queueDepthsError = $state<string | null>(untrack(() => initial.queueDepthsError ?? null));
    let truncated = $state<boolean>(untrack(() => initial.truncated ?? false));
    // Diagnostic datasets — health strip + stuck-items + dead-letter + error groups.
    // All four refresh together via the /api/admin/ingest/diagnostics endpoint.
    let pipelineSummary = $state<PipelineSummary | null>(
        untrack(() => initial.pipelineSummary ?? null),
    );
    let stuckItems = $state<StuckItemEntry[]>(untrack(() => initial.stuckItems ?? []));
    let deadLetter = $state<DeadLetterEntry[]>(untrack(() => initial.deadLetter ?? []));
    let errorGroups = $state<ErrorGroupEntry[]>(untrack(() => initial.errorGroups ?? []));

    // Client-side filters. All apply over the already-loaded `items` set
    // — the server still bounds by `windowKey` + limit, but title-search
    // and media-type slicing happen in-browser so the user gets
    // instant feedback without re-fetching.
    let searchQuery = $state('');
    let mediaTypeFilter = $state<'all' | 'movie' | 'series' | 'music' | 'other'>('all');
    /**
     * Case-insensitive, accent-insensitive search over title + series_title.
     * Both sides go through the same NFD-strip-combining pipeline so a
     * query of "Mëtallica" matches a haystack title of "Metallica" and
     * vice-versa. Returns true when the query is empty so the unfiltered
     * case stays cheap.
     */
    function foldDiacritics(s: string): string {
        // U+0300–U+036F is the Combining Diacritical Marks block.
        // Use explicit Unicode escapes rather than embedding literal
        // combining characters in the regex — editors and diff tools
        // render them invisibly, and a resave through a normalising
        // editor can silently widen or collapse the range.
        return s
            .normalize('NFD')
            .replace(/[\u0300-\u036F]/g, '')
            .toLowerCase();
    }
    function matchesSearch(item: MapItem): boolean {
        const q = foldDiacritics(searchQuery.trim());
        if (q.length === 0) return true;
        const haystack = foldDiacritics((item.title ?? '') + ' ' + (item.series_title ?? ''));
        return haystack.includes(q);
    }
    function matchesMediaType(item: MapItem): boolean {
        if (mediaTypeFilter === 'all') return true;
        if (mediaTypeFilter === 'movie') return _isMovie(item.media_type);
        if (mediaTypeFilter === 'series')
            return _isSeries(item.media_type) || _isEpisode(item.media_type);
        if (mediaTypeFilter === 'music')
            return (
                item.media_type === 'track' ||
                item.media_type === 'album' ||
                item.media_type === 'artist'
            );
        // 'other' — anything not on a metro line. Mirrors lineForMediaType returning null.
        return lineForMediaType(item.media_type) === null;
    }
    const filteredItems = $derived(items.filter((it) => matchesSearch(it) && matchesMediaType(it)));
    // SSE health — drives the "Live · 12s ago" indicator next to the
    // Live Pipeline Map heading. `sseState` mirrors EventSource.readyState
    // semantics (open vs connecting/disconnected); `lastEventAt` is wall-
    // clock ms of the most recent applied event so the user can tell at a
    // glance whether the page is fresh.
    let sseState = $state<'connecting' | 'open' | 'closed'>('connecting');
    let lastEventAt = $state<number | null>(null);
    let loadingWindow = $state(false);
    let viewMode = $state<'map' | 'table'>('map');
    let lastError = $state<string | null>(null);
    // Tick to keep "completed last hour" derivations fresh.
    let nowTick = $state(Date.now());

    // Group items by line. Plain Record (not Map) to satisfy
    // svelte/prefer-svelte-reactivity — the lint rule flags `new Map()` even
    // though this map is rebuilt fresh inside $derived.by on every read.
    // media_types that have a dedicated summary chip — exclude these from the
    // "unrecognised media type" line below so we don't double-report them.
    const summaryBucketTypes = new Set<string>(SUMMARY_BUCKETS.flatMap((b) => [...b.mediaTypes]));

    const itemsByLine = $derived.by(
        (): { buckets: Record<string, MapItem[]>; unknown: MapItem[] } => {
            const buckets: Record<string, MapItem[]> = {};
            for (const line of LINES) buckets[line.id] = [];
            const unknown: MapItem[] = [];
            // Apply client-side filters (search + media-type) here so every
            // downstream consumer (metro lines, table view, "in flight"
            // header) sees a consistent view.
            for (const item of filteredItems) {
                const line = lineForMediaType(item.media_type);
                if (line) {
                    buckets[line.id].push(item);
                } else if (!summaryBucketTypes.has(item.media_type)) {
                    unknown.push(item);
                }
            }
            return { buckets, unknown };
        },
    );

    // Build a lookup so the template can pull bucket counts by id without an
    // O(N) scan per render. Plain Record (not Map) for the same reason as
    // itemsByLine above — svelte-prefer-svelte-reactivity flags `new Map()`.
    const bucketCountsById = $derived.by((): Record<string, SummaryBucketCount> => {
        const out: Record<string, SummaryBucketCount> = {};
        for (const b of summaryBuckets) out[b.bucket_id] = b;
        return out;
    });

    // Tailwind JIT needs to see every concrete class string at build time.
    const SUMMARY_CHIP_CLASSES: Record<string, string> = {
        amber: 'bg-amber-900/30 text-amber-100 ring-amber-700/40 hover:bg-amber-900/50',
        zinc: 'bg-zinc-800/60 text-zinc-200 ring-zinc-700/60 hover:bg-zinc-800',
    };
    function chipClasses(color: string): string {
        return SUMMARY_CHIP_CLASSES[color] ?? SUMMARY_CHIP_CLASSES.zinc;
    }

    // Items that completed within the last hour. Used for the ticker.
    const recentlyDone = $derived.by(() => {
        const now = nowTick;
        const result: MapItem[] = [];
        for (const item of items) {
            const line = lineForMediaType(item.media_type);
            if (!line) continue;
            if (recentlyCompleted(line.stations, item.stages, now)) {
                result.push(item);
            }
        }
        return result.slice(0, 25);
    });

    /** Individual steps finished in the last 5 min (same source as the progress card). */
    let stepsDone5m = $derived(stageActivity.reduce((n, a) => n + (a.completed_5m ?? 0), 0));

    const WINDOW_TEXT: Record<string, () => string> = {
        '1h': () => m.admin_pipeline_window_1h(),
        '24h': () => m.admin_pipeline_window_24h(),
        '7d': () => m.admin_pipeline_window_7d(),
        '30d': () => m.admin_pipeline_window_30d(),
        all: () => m.admin_pipeline_window_all(),
    };

    /** Only the newest request may write: a slow response for the old window landed last. */
    let mapGen = 0;

    async function refetchMap(): Promise<void> {
        const gen = ++mapGen;
        const requestedWindow = windowKey;
        loadingWindow = true;
        lastError = null;
        try {
            // Fetch map data + scan issues in parallel. Scan issues are
            // independent of the window selector but worth refreshing
            // when the user manually re-triggers a load.
            const [mapResult, issuesResult, activityResult, diagnosticsResult] = await Promise.all([
                getIngestMap(requestedWindow),
                getIngestScanIssues(),
                getIngestStageActivity(),
                getIngestDiagnostics(),
            ]);
            if (gen !== mapGen) return;
            if (mapResult.error || !mapResult.data) {
                throw new Error(
                    mapResult.status
                        ? `HTTP ${mapResult.status}`
                        : (mapResult.error ?? 'Failed to load'),
                );
            }
            items = mapResult.data.items as MapItem[];
            loadedWindowKey = requestedWindow;
            summaryBuckets = (mapResult.data.summaryBuckets ?? []) as SummaryBucketCount[];
            truncated = mapResult.data.page.hasMore;
            if (!issuesResult.error && issuesResult.data) {
                scanIssues = issuesResult.data.issues as ScanIssueRow[];
            }
            if (!activityResult.error && activityResult.data) {
                stageActivity = activityResult.data.stages as StageActivityEntry[];
            }
            if (!diagnosticsResult.error && diagnosticsResult.data) {
                pipelineSummary = diagnosticsResult.data.summary as PipelineSummary;
                stuckItems = (diagnosticsResult.data.stuckItems ?? []) as StuckItemEntry[];
                deadLetter = (diagnosticsResult.data.deadLetter ?? []) as DeadLetterEntry[];
                errorGroups = (diagnosticsResult.data.errorGroups ?? []) as ErrorGroupEntry[];
            }
        } catch (e) {
            if (gen === mapGen) lastError = (e as Error).message;
        } finally {
            if (gen === mapGen) loadingWindow = false;
        }
    }

    function onWindowChange(ev: Event): void {
        const target = ev.target as HTMLSelectElement;
        windowKey = target.value as WindowKey;
        void refetchMap();
    }

    // Apply an SSE stage-state-changed event in-place. If the item isn't loaded,
    // schedule a debounced refetch so newly-seeded items appear.
    interface SseEvent {
        mediaItemId: string;
        stageId: string;
        newStatus: ItemStageRow['status'];
        processingVersion: number;
        timestamp: string;
        kind?: string;
    }

    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    // Guards state writes from in-flight fetches that resolve after this
    // component has unmounted (e.g. a route nav away while
    // refreshQueueDepths — triggered by MetroLine's onQueueChanged callback
    // after a pause/resume — is still awaiting the network). Same pattern as
    // TaskRecentRuns.svelte / TaskFailuresList.svelte.
    let destroyed = false;

    function scheduleRefetch(): void {
        if (refetchTimer) clearTimeout(refetchTimer);
        refetchTimer = setTimeout(() => {
            refetchTimer = null;
            void refetchMap();
        }, 1500);
    }

    // Cancel any pending debounced refetch when the component unmounts so a
    // user navigating away mid-window doesn't trigger refetchMap on a stale
    // (destroyed) component and waste a server round-trip.
    onDestroy(() => {
        destroyed = true;
        if (refetchTimer) {
            clearTimeout(refetchTimer);
            refetchTimer = null;
        }
    });

    function applyEvent(evt: SseEvent): void {
        if (evt.kind === 'delete') {
            items = items.filter((i) => i.media_item_id !== evt.mediaItemId);
            return;
        }
        const idx = items.findIndex((i) => i.media_item_id === evt.mediaItemId);
        if (idx < 0) {
            // New item seeded outside our window — refetch (debounced).
            scheduleRefetch();
            return;
        }
        const current = items[idx];
        const stageIdx = current.stages.findIndex((s) => s.stage_id === evt.stageId);
        // Preserve fields the SSE payload doesn't carry — otherwise every
        // event silently strips `skipped_reason` / `next_eligible_at` /
        // `last_error` from the existing stage row, blanking the train
        // tooltip until the next full refetch. The transition itself can
        // invalidate stale state though: a row moving to running /
        // completed must NOT keep the prior `skipped_reason` or it reads
        // as "currently running but parked for X reason" in the tooltip.
        const existing = stageIdx >= 0 ? current.stages[stageIdx] : null;
        const newStatus = evt.newStatus;
        const isTransientNow =
            newStatus === 'failed_transient' || newStatus === 'skipped_transient';
        const isSkippedNow = newStatus.startsWith('skipped');
        const newStage: ItemStageRow = {
            stage_id: evt.stageId,
            status: newStatus,
            processing_version: evt.processingVersion,
            attempt: existing?.attempt ?? 0,
            last_error: existing?.last_error ?? null,
            updated_at: evt.timestamp,
            // skipped_reason is only meaningful while the row IS skipped.
            // Clear on any non-skipped transition.
            skipped_reason: isSkippedNow ? (existing?.skipped_reason ?? null) : null,
            // next_eligible_at is only meaningful while the row is in a
            // retry-waiting state. Clear on any other transition.
            next_eligible_at: isTransientNow ? (existing?.next_eligible_at ?? null) : null,
        };
        // Brand-new stage row arriving in a failed/skipped state: we lack
        // the per-row context (last_error message, skipped_reason). Kick
        // a debounced refetch so the tooltip fills in within ≤1.5 s.
        // `skipped_permanent` is included so the new
        // `predicate-false-on-invalidation` path also surfaces its reason
        // (see stage-state.service.ts:invalidateByEvent ineligible branch).
        if (
            existing === null &&
            (newStatus.startsWith('failed') ||
                newStatus === 'skipped_transient' ||
                newStatus === 'skipped_permanent')
        ) {
            scheduleRefetch();
        }
        const nextStages =
            stageIdx >= 0
                ? current.stages.map((s, i) => (i === stageIdx ? newStage : s))
                : [...current.stages, newStage];
        // Replace item to trigger reactivity.
        const next = items.slice();
        next[idx] = { ...current, stages: nextStages };
        items = next;
    }

    $effect(() => {
        const factory =
            eventSourceFactory ?? ((url: string) => new EventSource(url) as EventSourceLike);
        const es = factory(apiUrl('internal', '/admin/ingest/stream'));
        // Hook EventSource lifecycle so the UI can reflect "live" vs
        // "reconnecting" without polling. Falls back to optimistic 'open'
        // for stub factories that don't implement these properties.
        const onOpen = (): void => {
            sseState = 'open';
        };
        const onError = (): void => {
            sseState = 'closed';
        };
        if (typeof EventSource !== 'undefined' && es instanceof EventSource) {
            es.addEventListener('open', onOpen);
            es.addEventListener('error', onError);
        } else {
            // Test stub — assume open.
            sseState = 'open';
        }
        const handler = (ev: { data: string }): void => {
            let parsed: SseEvent;
            try {
                parsed = JSON.parse(ev.data) as SseEvent;
            } catch {
                return;
            }
            lastEventAt = Date.now();
            // An event implies the connection is alive even if the 'open'
            // handler hasn't fired (browser may have skipped it on reconnect).
            sseState = 'open';
            applyEvent(parsed);
        };
        es.addEventListener('stage-state-changed', handler);
        return () => {
            es.close();
        };
    });

    /**
     * Human-readable "fresh / stale" label for the SSE indicator. The
     * nowTick state (updated every 5 s — see below) drives reactivity;
     * we read it inside the $derived so the label refreshes without a
     * dedicated timer.
     */
    const liveLabel = $derived.by((): { text: string; tone: 'live' | 'stale' | 'down' } => {
        if (sseState === 'closed') return { text: 'Reconnecting…', tone: 'down' };
        if (lastEventAt === null) return { text: 'Live · waiting for first event', tone: 'live' };
        const ageMs = nowTick - lastEventAt;
        if (ageMs < 60_000) {
            return {
                text: `Live · ${Math.max(1, Math.round(ageMs / 1000))}s ago`,
                tone: 'live',
            };
        }
        if (ageMs < 5 * 60_000) {
            return {
                text: `Live · ${Math.round(ageMs / 60_000)}m ago`,
                tone: 'live',
            };
        }
        return {
            text: `Stale · ${Math.round(ageMs / 60_000)}m ago`,
            tone: 'stale',
        };
    });

    // Refresh the "now" tick every 5 seconds. Was 60s when the ticker was
    // the only consumer; the live-indicator label now also reads it and
    // wants finer resolution (a "Live · 1s ago" → "Live · 30s ago" beat).
    $effect(() => {
        const id = setInterval(() => {
            nowTick = Date.now();
        }, 5_000);
        return () => clearInterval(id);
    });

    // Refresh queueDepths every 20 s. The initial page payload includes
    // a snapshot but is otherwise frozen (the SSE stream broadcasts
    // Postgres stage_state events, not BullMQ counts). Polling keeps the
    // tooltip's "Waiting in queue: N" number current as items drain.
    // 20 s is conservative — the tooltip is hover-only so a one-poll
    // delay matters less than the orchestrator load of more frequent
    // BullMQ getJobCounts calls (each is a small Valkey round-trip,
    // but multiplied across all admins watching the page).
    async function refreshQueueDepths(): Promise<void> {
        const { data } = await getIngestQueueDepths();
        if (destroyed) return;
        if (data) {
            queueDepths = data.queueDepths as QueueDepthEntry[];
            queueDepthsError = data.error ?? null;
        }
        // Network/transient — keep last-known values; the
        // next poll tick will retry. queueDepthsError stays
        // at whatever the server reported on the last good
        // response, so the UI still shows the most recent
        // server-side state rather than reflecting transient
        // browser-side network blips.
    }

    $effect(() => {
        const id = setInterval(() => void refreshQueueDepths(), 20_000);
        return () => clearInterval(id);
    });

    // Pre-compute the table view rows (flat list with current stage).
    interface TableRow {
        id: string;
        title: string;
        media_type: string;
        line: string;
        current_stage: string;
        mode: ReturnType<typeof currentStationIndex>['mode'];
    }

    const tableRows = $derived.by((): TableRow[] => {
        const out: TableRow[] = [];
        for (const item of filteredItems) {
            const line = lineForMediaType(item.media_type);
            if (!line) {
                out.push({
                    id: item.media_item_id,
                    title: formatTrainHeadline(item),
                    media_type: item.media_type,
                    line: '—',
                    current_stage: '—',
                    mode: 'waiting',
                });
                continue;
            }
            const { index, mode } = currentStationIndex(line.stations, item.stages);
            const stage = line.stations[Math.min(index, line.stations.length - 1)];
            out.push({
                id: item.media_item_id,
                title: formatTrainHeadline(item),
                media_type: item.media_type,
                line: line.label,
                current_stage: stage,
                mode,
            });
        }
        return out;
    });
</script>

<div class="ingest-map min-w-0 space-y-6 text-zinc-100">
    <HealthStrip summary={pipelineSummary} />

    <header class="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-0 space-y-1">
                <h2 class="text-lg font-semibold">{m.admin_pipeline_map_heading()}</h2>
                <p class="text-sm text-zinc-400">{m.admin_pipeline_window_scope()}</p>
            </div>
            <span
                class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium
                    {liveLabel.tone === 'live'
                    ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-300'
                    : liveLabel.tone === 'stale'
                      ? 'border-amber-700/50 bg-amber-950/40 text-amber-300'
                      : 'border-red-700/50 bg-red-950/40 text-red-300'}"
                title={sseState === 'open'
                    ? m.admin_pipeline_live_connected()
                    : sseState === 'connecting'
                      ? m.admin_pipeline_live_connecting()
                      : m.admin_pipeline_live_disconnected()}>
                <span
                    class="h-2 w-2 rounded-full {liveLabel.tone === 'live'
                        ? 'bg-emerald-400'
                        : liveLabel.tone === 'stale'
                          ? 'bg-amber-400'
                          : 'bg-red-400'}"
                    aria-hidden="true"></span>
                {liveLabel.text}
            </span>
        </div>
        <div class="flex min-w-0 flex-wrap items-end gap-4">
            <label class="min-w-0 flex-1 basis-64 space-y-1.5 text-sm text-zinc-300">
                <span>{m.admin_pipeline_filter_title()}</span>
                <input
                    type="search"
                    placeholder={m.admin_pipeline_search_titles()}
                    class="block w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                    bind:value={searchQuery} />
            </label>
            <label class="space-y-1.5 text-sm text-zinc-300">
                <span>{m.admin_pipeline_time_window()}</span>
                <select
                    class="block max-w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                    value={windowKey}
                    onchange={onWindowChange}>
                    <option value="1h">{m.admin_pipeline_window_1h()}</option>
                    <option value="24h">{m.admin_pipeline_window_24h()}</option>
                    <option value="7d">{m.admin_pipeline_window_7d()}</option>
                    <option value="30d">{m.admin_pipeline_window_30d()}</option>
                    <option value="all">{m.admin_pipeline_window_all()}</option>
                </select>
            </label>
            <div
                class="flex flex-wrap gap-1 rounded-lg border border-zinc-700 bg-zinc-900 p-1"
                role="group"
                aria-label={m.admin_pipeline_display_mode()}>
                <button
                    type="button"
                    class="rounded-md px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 {viewMode ===
                    'map'
                        ? 'bg-sky-700 text-white'
                        : 'text-zinc-300 hover:bg-zinc-800'}"
                    onclick={() => (viewMode = 'map')}
                    aria-pressed={viewMode === 'map'}>{m.admin_pipeline_map_view()}</button>
                <button
                    type="button"
                    class="rounded-md px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 {viewMode ===
                    'table'
                        ? 'bg-sky-700 text-white'
                        : 'text-zinc-300 hover:bg-zinc-800'}"
                    onclick={() => (viewMode = 'table')}
                    aria-pressed={viewMode === 'table'}>{m.admin_pipeline_table_view()}</button>
            </div>
        </div>
        <div
            class="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3">
            <div
                class="flex flex-wrap gap-1.5"
                role="group"
                aria-label={m.admin_pipeline_media_filter()}>
                {#each ['all', 'movie', 'series', 'music', 'other'] as const as mt (mt)}
                    <button
                        type="button"
                        class="rounded-md border px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 {mediaTypeFilter ===
                        mt
                            ? 'border-sky-600 bg-sky-950 text-sky-200'
                            : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}"
                        onclick={() => (mediaTypeFilter = mt)}
                        aria-pressed={mediaTypeFilter === mt}>
                        {mt === 'all'
                            ? m.tab_all()
                            : mt === 'movie'
                              ? m.movies()
                              : mt === 'series'
                                ? m.media_series()
                                : mt === 'music'
                                  ? m.media_music()
                                  : m.admin_pipeline_other_media()}
                    </button>
                {/each}
            </div>
            {#if searchQuery || mediaTypeFilter !== 'all'}
                <button
                    type="button"
                    class="rounded px-2 py-1 text-sm text-sky-300 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                    onclick={() => {
                        searchQuery = '';
                        mediaTypeFilter = 'all';
                    }}>{m.admin_pipeline_reset_filters()}</button>
            {/if}
        </div>
        <p class="text-sm text-zinc-300" role="status">
            {#if searchQuery.trim() || mediaTypeFilter !== 'all'}
                {m.admin_pipeline_filtered_window({
                    count: filteredItems.length.toLocaleString(),
                    total: items.length.toLocaleString(),
                    window: WINDOW_TEXT[loadedWindowKey]?.() ?? loadedWindowKey,
                })}
            {:else}
                {m.admin_pipeline_items_in_window({
                    count: items.length.toLocaleString(),
                    window: WINDOW_TEXT[loadedWindowKey]?.() ?? loadedWindowKey,
                })}
            {/if}
            {#if truncated}<span class="ml-1 text-amber-300">{m.admin_pipeline_newest_only()}</span
                >{/if}
            {#if loadingWindow}<span class="ml-2 text-zinc-400">{m.common_loading()}</span>{/if}
        </p>
        {#if lastError}<p class="text-sm text-red-300">
                {m.admin_pipeline_load_failed()}
                {lastError}
            </p>{/if}
    </header>

    {#if viewMode === 'map'}
        <div
            class="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-sm text-zinc-300"
            role="group"
            aria-label={m.admin_pipeline_legend()}>
            <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
                <span class="font-medium text-zinc-100">{m.admin_pipeline_legend()}</span>
                <span class="inline-flex items-center gap-2"
                    ><span
                        class="h-2.5 w-2.5 rounded-full border-2 border-amber-400 bg-amber-500/30"
                        aria-hidden="true"></span
                    >{m.admin_pipeline_legend_running()}</span>
                <span class="inline-flex items-center gap-2"
                    ><span class="h-2.5 w-2.5 rounded-sm bg-amber-600" aria-hidden="true"></span
                    >{m.admin_pipeline_legend_retry()}</span>
                <span class="inline-flex items-center gap-2"
                    ><span class="h-2.5 w-2.5 rounded-sm bg-red-600" aria-hidden="true"></span
                    >{m.admin_pipeline_legend_stopped()}</span>
                <span class="inline-flex items-center gap-2"
                    ><span class="h-2.5 w-2.5 rounded-sm bg-emerald-700" aria-hidden="true"></span
                    >{m.admin_pipeline_legend_done()}</span>
            </div>
            <details class="border-t border-zinc-800 pt-2">
                <summary
                    class="w-fit cursor-pointer rounded py-1 text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
                    >{m.admin_pipeline_legend_details()}</summary>
                <div class="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                    <span class="inline-flex items-center gap-2"
                        ><span class="h-2.5 w-2.5 rounded-full bg-sky-500" aria-hidden="true"></span
                        >{m.admin_pipeline_legend_movies()}</span>
                    <span class="inline-flex items-center gap-2"
                        ><span class="h-2.5 w-2.5 rounded-full bg-violet-500" aria-hidden="true"
                        ></span
                        >{m.admin_pipeline_legend_series()}</span>
                    <span class="inline-flex items-center gap-2"
                        ><span class="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden="true"
                        ></span
                        >{m.admin_pipeline_legend_music()}</span>
                    <span class="inline-flex items-center gap-2"
                        ><span class="h-2.5 w-2.5 rounded-full bg-sky-800/50" aria-hidden="true"
                        ></span
                        >{m.admin_pipeline_legend_waiting()}</span>
                    <span class="inline-flex items-center gap-2"
                        ><span
                            class="h-2.5 w-2.5 rounded-full border-2 border-dashed border-zinc-400"
                            aria-hidden="true"></span
                        >{m.admin_pipeline_legend_partial()}</span>
                    <span class="inline-flex items-center gap-2"
                        ><span
                            class="h-2.5 w-2.5 rounded-full border border-dotted border-zinc-400"
                            aria-hidden="true"></span
                        >{m.admin_pipeline_legend_unused()}</span>
                </div>
            </details>
            <p class="text-xs text-zinc-400">{m.admin_pipeline_legend_hint()}</p>
        </div>

        <!-- Three metro lines + summary buckets -->
        <div class="min-w-0 space-y-5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 sm:p-4">
            {#each LINES as line (line.id)}
                <MetroLine
                    {line}
                    items={itemsByLine.buckets[line.id] ?? []}
                    {stageActivity}
                    {queueDepths}
                    {queueDepthsError}
                    {nowTick}
                    onQueueChanged={refreshQueueDepths}
                    {devMode} />
            {/each}

            {#if summaryBuckets.length > 0}
                <!-- Library totals for media types with no applicable pipeline
                     stages (Live TV channels, home videos, training videos, etc).
                     Rendered as inventory chips — the count is "items in your
                     library", NOT "items currently processing". Items added
                     within the active time window also get a `+N new` badge. -->
                <div class="border-t border-zinc-800 pt-3">
                    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                        Library totals
                        <span class="ml-1 normal-case tracking-normal text-zinc-600"
                            >(no pipeline stages apply)</span>
                    </h3>
                    <ul class="flex flex-wrap gap-2">
                        {#each SUMMARY_BUCKETS as bucket (bucket.id)}
                            {@const count = bucketCountsById[bucket.id]}
                            {@const total = count?.total ?? 0}
                            {@const recent = count?.recent ?? 0}
                            {@const unit = total === 1 ? bucket.unitSingular : bucket.unitPlural}
                            {#if total > 0 || recent > 0}
                                <li>
                                    {#if bucket.drillHref}
                                        <a
                                            href={bucket.drillHref}
                                            class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ring-1 transition-colors {chipClasses(
                                                bucket.color,
                                            )}"
                                            title={`${bucket.mediaTypes.join(', ')} — no pipeline stages apply`}>
                                            <span class="font-medium">{bucket.label}</span>
                                            <span class="text-zinc-400">·</span>
                                            <span class="tabular-nums"
                                                >{total.toLocaleString()}
                                                {unit}</span>
                                            {#if recent > 0}
                                                <span
                                                    class="rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                                                    +{recent} new
                                                </span>
                                            {/if}
                                        </a>
                                    {:else}
                                        <span
                                            class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ring-1 {chipClasses(
                                                bucket.color,
                                            )}"
                                            title={`${bucket.mediaTypes.join(', ')} — no pipeline stages apply`}>
                                            <span class="font-medium">{bucket.label}</span>
                                            <span class="text-zinc-400">·</span>
                                            <span class="tabular-nums"
                                                >{total.toLocaleString()}
                                                {unit}</span>
                                            {#if recent > 0}
                                                <span
                                                    class="rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                                                    +{recent} new
                                                </span>
                                            {/if}
                                        </span>
                                    {/if}
                                </li>
                            {/if}
                        {/each}
                    </ul>
                </div>
            {/if}

            {#if itemsByLine.unknown.length > 0}
                <!-- When the operator explicitly filtered to "other", show
                     the actual items rather than just a count — the metro
                     map has nothing to render for them and an empty map
                     with a footer line is confusing UX. -->
                {#if mediaTypeFilter === 'other'}
                    <!-- Dedupe by media_item_id before slicing — duplicate
                         ids in `unknown` would trip Svelte's keyed-each
                         collision warning and produce non-deterministic
                         DOM updates. Defensive against upstream data
                         quirks (multiple rows in media_items for the
                         same uuid, etc.). -->
                    {@const uniqueUnknown = (() => {
                        // Plain Record (not Set) so the project's
                        // svelte/prefer-svelte-reactivity lint stays
                        // happy — same convention as itemsByLine /
                        // bucketCountsById above.
                        const seen: Record<string, boolean> = {};
                        const out: typeof itemsByLine.unknown = [];
                        for (const it of itemsByLine.unknown) {
                            if (seen[it.media_item_id]) continue;
                            seen[it.media_item_id] = true;
                            out.push(it);
                        }
                        return out;
                    })()}
                    <div class="rounded border border-zinc-800 bg-zinc-900/40 p-2">
                        <p class="mb-1 text-xs text-zinc-400">
                            {uniqueUnknown.length} other-media item{uniqueUnknown.length === 1
                                ? ''
                                : 's'} — no processing pipeline applies.
                        </p>
                        <ul class="space-y-0.5 text-xs">
                            {#each uniqueUnknown.slice(0, 30) as item (item.media_item_id)}
                                <li class="flex items-baseline gap-2 truncate">
                                    <span
                                        class="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-400">
                                        {item.media_type}
                                    </span>
                                    <a
                                        href={resolve(
                                            `/admin/library/media/${item.media_item_id}?tab=pipeline`,
                                        )}
                                        class="truncate text-zinc-200 hover:text-white hover:underline">
                                        {formatTrainHeadline(item)}
                                    </a>
                                </li>
                            {/each}
                        </ul>
                        {#if uniqueUnknown.length > 30}
                            <p class="mt-1 text-[11px] text-zinc-500">
                                + {uniqueUnknown.length - 30} more (switch to Table view for the full
                                list)
                            </p>
                        {/if}
                    </div>
                {:else}
                    <!-- Every badge is a link (spec §2 principle 3): switches the
                         media-type filter to 'other', which renders the actual
                         filtered item list above instead of just a count. -->
                    <button
                        type="button"
                        class="text-xs text-zinc-500 underline decoration-dotted underline-offset-2 hover:text-zinc-300"
                        onclick={() => (mediaTypeFilter = 'other')}>
                        {m.admin_pipeline_unrecognised_media_type({
                            count: itemsByLine.unknown.length,
                        })}
                    </button>
                {/if}
            {/if}
        </div>

        <!-- Completed ticker (collapses to a thin row when empty to save space) -->
        {#if recentlyDone.length > 0}
            <section class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <header class="mb-2 flex items-baseline gap-2">
                    <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        {m.admin_pipeline_items_finished_heading()}
                    </h3>
                    <span class="text-xs text-emerald-400">({recentlyDone.length})</span>
                </header>
                <ul class="flex flex-wrap gap-2 text-xs">
                    {#each recentlyDone as item (item.media_item_id)}
                        <li>
                            <a
                                href={resolve(
                                    `/admin/library/media/${item.media_item_id}?tab=pipeline`,
                                )}
                                class="rounded bg-emerald-900/30 px-2 py-1 text-emerald-200 hover:bg-emerald-800/50 hover:text-emerald-100">
                                {formatTrainHeadline(item)}
                            </a>
                        </li>
                    {/each}
                </ul>
            </section>
        {:else}
            <!-- Item-level: an item that finished EVERY step in the last hour.
                 "Completed last hour · 0 — nothing finished" read as the
                 pipeline being idle while the progress card above said "85 done
                 in last 5 min" (steps). Both numbers are shown, each named. -->
            <p class="px-1 text-xs text-zinc-600">
                <span class="font-semibold uppercase tracking-wider"
                    >{m.admin_pipeline_items_finished_heading()}</span>
                · {m.admin_pipeline_items_finished_none({
                    steps: stepsDone5m.toLocaleString(),
                })}
            </p>
        {/if}

        <!-- Scan issues — files the scanner refused to ingest because tag
             parsing failed. Persists across scans with attempt_count +
             cooldown so admins can decide whether to investigate the file
             on disk or wait for the next retry. Collapses to a thin row
             when empty (the scanner is happy). -->
        {#if scanIssues.length > 0}
            <section class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                <header class="mb-2 flex items-baseline justify-between gap-2">
                    <div class="flex items-baseline gap-2">
                        <h3 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                            Scan issues
                        </h3>
                        <span class="text-xs text-amber-400">
                            ({scanIssues.length})
                        </span>
                    </div>
                    <button
                        type="button"
                        class="text-xs text-zinc-400 hover:text-zinc-200"
                        onclick={() => (scanIssuesExpanded = !scanIssuesExpanded)}>
                        {scanIssuesExpanded ? 'Collapse' : 'Show all'}
                    </button>
                </header>
                <p class="mb-2 max-w-3xl text-xs text-zinc-400">
                    {m.admin_pipeline_scan_issues_explain()}
                </p>
                <ul class="space-y-1 text-xs">
                    {#each scanIssuesExpanded ? scanIssues : scanIssues.slice(0, 5) as row (row.file_path)}
                        {@const primary =
                            row.issues.find((i) =>
                                UNLINKED_FILE_HEALTH_ISSUE_TYPES.some((t) => t === i.type),
                            ) ?? row.issues[0]}
                        {@const basename = row.file_path.split('/').pop() ?? row.file_path}
                        {@const reason = primary ? fileHealthIssueLabel(primary.type) : 'unknown'}
                        {@const attempts = primary?.attempt_count ?? 1}
                        {@const retryAt = primary?.next_retry_at
                            ? new Date(primary.next_retry_at)
                            : null}
                        {@const retryInFuture = retryAt && retryAt.getTime() > Date.now()}
                        <li
                            class="flex items-start gap-3 rounded bg-zinc-900/60 px-2 py-1.5"
                            title={row.file_path}>
                            <span
                                class="mt-0.5 inline-block min-w-[5rem] rounded px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-700/40">
                                {reason}
                            </span>
                            <span class="min-w-0 flex-1 truncate font-mono text-zinc-200">
                                {basename}
                            </span>
                            <span class="whitespace-nowrap text-zinc-500">
                                attempt {attempts}
                            </span>
                            {#if retryAt}
                                <span
                                    class="whitespace-nowrap {retryInFuture
                                        ? 'text-zinc-500'
                                        : 'text-emerald-400'}">
                                    {retryInFuture
                                        ? `retry ${retryAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
                                        : 'retry next scan'}
                                </span>
                            {:else}
                                <span class="whitespace-nowrap text-emerald-400"
                                    >retry next scan</span>
                            {/if}
                        </li>
                    {/each}
                </ul>
                {#if !scanIssuesExpanded && scanIssues.length > 5}
                    <p class="mt-2 text-xs text-zinc-500">
                        Showing 5 of {scanIssues.length} — click
                        <em>Show all</em> to expand.
                    </p>
                {/if}
            </section>
        {:else}
            <p class="px-1 text-xs text-zinc-600">
                <span class="font-semibold uppercase tracking-wider">Scan issues</span>
                · 0 — no files failed parsing recently.
            </p>
        {/if}
    {:else}
        <!-- Accessibility table fallback -->
        <div class="overflow-x-auto rounded border border-zinc-800">
            <table class="w-full text-sm">
                <caption class="sr-only">
                    Pipeline coverage table: one row per in-progress or recently-added media item.
                </caption>
                <thead>
                    <tr
                        class="border-b border-zinc-800 bg-zinc-900/60 text-left text-xs uppercase tracking-wide text-zinc-400">
                        <th scope="col" class="px-3 py-2">Title</th>
                        <th scope="col" class="px-3 py-2">Type</th>
                        <th scope="col" class="px-3 py-2">Line</th>
                        <th scope="col" class="px-3 py-2">Current stage</th>
                        <th scope="col" class="px-3 py-2">Status</th>
                    </tr>
                </thead>
                <tbody>
                    {#if tableRows.length === 0}
                        <tr>
                            <td colspan="5" class="px-3 py-6 text-center text-zinc-500">
                                No items match the current window.
                            </td>
                        </tr>
                    {/if}
                    {#each tableRows as row (row.id)}
                        <tr class="border-t border-zinc-800 hover:bg-zinc-800/30">
                            <td class="px-3 py-1.5">
                                <a
                                    href={resolve(`/admin/library/media/${row.id}?tab=pipeline`)}
                                    class="text-sky-400 hover:text-sky-300 hover:underline">
                                    {row.title}
                                </a>
                            </td>
                            <td class="px-3 py-1.5 text-xs text-zinc-400">
                                {_isSeries(row.media_type) ? 'series' : row.media_type}
                            </td>
                            <td class="px-3 py-1.5 text-xs text-zinc-400">{row.line}</td>
                            <td class="px-3 py-1.5 font-mono text-xs">{row.current_stage}</td>
                            <td class="px-3 py-1.5 text-xs">
                                <span
                                    class="rounded px-1.5 py-0.5 {row.mode === 'running'
                                        ? 'bg-sky-900/40 text-sky-200'
                                        : row.mode === 'failed'
                                          ? 'bg-red-900/40 text-red-200'
                                          : row.mode === 'done'
                                            ? 'bg-emerald-900/40 text-emerald-200'
                                            : 'bg-zinc-800 text-zinc-300'}">
                                    {row.mode}
                                </span>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}

    <!-- Diagnostics panels — stuck items, dead letter, error groups.
             Anchored so the HealthStrip chips can deep-link to each.
             Each panel collapses to a single-line message when empty,
             so a healthy library sees just three thin rows. -->
    <DiagnosticsPanels
        {stuckItems}
        {deadLetter}
        {errorGroups}
        deadLetterTotal={pipelineSummary?.deadLetterItems}
        onchanged={() => void refetchMap()} />
</div>

<style>
    /* Container query: stack metro lines vertically with no horizontal overflow on narrow screens. */
    @media (max-width: 768px) {
        .ingest-map {
            font-size: 0.875rem;
        }
    }
</style>
