<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { getAvailabilityContext } from '$lib/shared/livetv-availability-context.js';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';
    import { onMount, onDestroy, untrack } from 'svelte';
    import { SvelteDate, SvelteSet } from 'svelte/reactivity';
    import { Icon, ChevronDown } from 'svelte-hero-icons';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { computePosition, offset, shift, flip } from '@floating-ui/dom';
    import type { LiveTvStation, LiveTvCategory, LiveTvAiring } from '$lib/schemas/livetv.js';
    import { pickNowNext } from '$lib/shared/livetv-now-next';
    import { fetchGuidePrograms } from '$lib/api/livetv-playback.js';
    import { modals } from '$lib/stores/modal.store.js';
    import ProgramDetailsPopover from './ProgramDetailsPopover.svelte';

    interface Props {
        channels: LiveTvStation[];
        categories: LiveTvCategory[];
        onChannelClick?: ((channel: LiveTvStation) => void) | undefined;
        /** Fetch programs for these channels only (a dialog showing a few rows). */
        scoped?: boolean;
        /** CSS height of the guide; defaults to the remaining viewport. */
        height?: string;
        /**
         * A prefix every row shares (a channel family's label): rows show only
         * the rest ("ZAVO EVENT GRD 3" -> "3"), the part that tells them apart
         * in the narrow name column. The full name stays the title.
         */
        sharedPrefix?: string;
    }

    const getAvailability = getAvailabilityContext();
    let guideUnavailable = $derived(
        getAvailability?.()?.sources.some((s) => s.guideFeed.state === 'failed'),
    );
    let {
        channels,
        categories,
        onChannelClick = undefined,
        scoped = false,
        height = undefined,
        sharedPrefix = undefined,
    }: Props = $props();

    function rowLabel(name: string): string {
        if (!sharedPrefix) return name;
        const head = name.slice(0, sharedPrefix.length);
        // Same prefix and a word boundary after it: "Orb Sport" does not cut
        // "Orb Sports News" into "s News".
        if (head.localeCompare(sharedPrefix, undefined, { sensitivity: 'accent' }) !== 0)
            return name;
        const next = name.charAt(sharedPrefix.length);
        if (next && /[\p{L}\p{N}]/u.test(next)) return name;
        const rest = name
            .slice(sharedPrefix.length)
            .replace(/^[\s|:•\-–]+/u, '')
            .trim();
        return rest || name;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------
    const PX_PER_MIN = 4;
    const CHANNEL_ROW_H = 56;
    const CATEGORY_ROW_H = 36;
    const SIDEBAR_W = 160;
    const TIMELINE_H = 48;
    const OVERSCAN = 8;
    const INITIAL_WINDOW_H = 6; // hours — wide enough that extend doesn't fire immediately on load
    const EXTEND_WINDOW_H = 2; // hours added when scrolling right
    const SHORT_PROGRAM_PX = 60; // programs narrower than this get a hover tooltip

    // -------------------------------------------------------------------------
    // Time window
    // -------------------------------------------------------------------------
    function makeWindowStartMs(): number {
        // Round down to nearest 30-min boundary, then step back one more
        const THIRTY_MIN = 30 * 60 * 1000;
        return Math.floor(Date.now() / THIRTY_MIN) * THIRTY_MIN - THIRTY_MIN;
    }

    const initialStartMs = makeWindowStartMs();
    // Store as timestamps to avoid svelte/prefer-svelte-reactivity lint error
    let windowStartMs = $state(initialStartMs);
    let windowEndMs = $state(initialStartMs + INITIAL_WINDOW_H * 3600 * 1000);

    let windowStart = $derived(new SvelteDate(windowStartMs));
    let windowEnd = $derived(new SvelteDate(windowEndMs));

    // -------------------------------------------------------------------------
    // Programs data
    // -------------------------------------------------------------------------
    // $state.raw — shallow reactivity only. We always replace the whole object
    // (never mutate individual keys), so deep proxying 1000+ channel arrays
    // would create ~50k+ proxy objects on each extend and freeze the browser.
    let programsByChannel = $state.raw<Record<string, LiveTvAiring[]>>({});
    let loading = $state(true);
    // True when the initial guide fetch threw (provider/network failure). Kept
    // distinct from "loaded successfully but the EPG has no programs" so the UI
    // can offer a retry vs. an informational empty-state.
    let loadError = $state(false);
    let previousGuideObservation: string | undefined;
    $effect(() => {
        const observation = getAvailability?.()
            ?.sources.map(
                (s) => `${s.sourceId}:${s.guideFeed.state}:${s.guideFeed.observedAt ?? ''}`,
            )
            .join('|');
        if (previousGuideObservation !== undefined && observation !== previousGuideObservation) {
            // Refresh the already-scrolled window without resetting its boundaries or scroll.
            void untrack(() => loadPrograms(windowStart, windowEnd))
                .then((programs) => {
                    programsByChannel = programs;
                    loadError = false;
                })
                .catch(() => {
                    loadError = true;
                });
        }
        previousGuideObservation = observation;
    });
    let extendingRight = $state(false);
    let extendError = $state(false);

    // Whether the loaded window has any program data at all. When false (and no
    // error), the channels still list in the sidebar but the grid has no blocks —
    // we show a "no EPG data" notice instead of a silent blank grid.
    let hasAnyPrograms = $derived(
        Object.values(programsByChannel).some((progs) => progs.length > 0),
    );

    async function loadPrograms(from: Date, to: Date): Promise<Record<string, LiveTvAiring[]>> {
        // A scoped guide asks for at most 200 stations. An empty scope must
        // not fall back to the full guide.
        if (scoped && channels.length === 0) return {};
        const result = await fetchGuidePrograms(
            from,
            to,
            scoped ? channels.slice(0, 200).map((ch) => ch.id) : undefined,
        );
        // The API client returns errors in-band (never throws), so a provider/
        // network failure surfaces as result.error with data === null. Surface it
        // as a throw so callers can distinguish a real failure from a genuinely
        // empty EPG (both previously collapsed to a silent empty grid).
        if (result.error) {
            throw new Error(result.error);
        }
        return Object.fromEntries(
            (result.data?.stations ?? []).map((station) => [station.stationId, station.airings]),
        );
    }

    // -------------------------------------------------------------------------
    // Virtual scroll rows
    // -------------------------------------------------------------------------
    type CategoryRow = {
        type: 'category';
        id: string;
        name: string;
        y: number;
    };
    type ChannelRow = { type: 'channel'; channel: LiveTvStation; y: number };
    type GuideRow = CategoryRow | ChannelRow;

    let rows = $derived.by((): GuideRow[] => {
        const result: GuideRow[] = [];
        let y = 0;

        const sortedCats = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);

        for (const cat of sortedCats) {
            const catChannels = channels
                .filter((ch) => ch.categoryId === cat.id)
                .sort((a, b) => a.sortOrder - b.sortOrder);
            if (catChannels.length === 0) continue;

            result.push({ type: 'category', id: cat.id, name: cat.name, y });
            y += CATEGORY_ROW_H;
            for (const ch of catChannels) {
                result.push({ type: 'channel', channel: ch, y });
                y += CHANNEL_ROW_H;
            }
        }

        // Uncategorized
        const uncategorized = channels
            .filter((ch) => !categories.some((category) => category.id === ch.categoryId))
            .sort((a, b) => a.sortOrder - b.sortOrder);
        if (uncategorized.length > 0) {
            if (categories.length > 0) {
                result.push({
                    type: 'category',
                    id: 'uncategorized',
                    name: m.viewer_livetv_other(),
                    y,
                });
                y += CATEGORY_ROW_H;
            }
            for (const ch of uncategorized) {
                result.push({ type: 'channel', channel: ch, y });
                y += CHANNEL_ROW_H;
            }
        }

        return result;
    });

    let totalHeight = $derived(
        rows.length === 0
            ? 0
            : rows[rows.length - 1].y +
                  (rows[rows.length - 1].type === 'channel' ? CHANNEL_ROW_H : CATEGORY_ROW_H),
    );

    // -------------------------------------------------------------------------
    // Scroll state
    // -------------------------------------------------------------------------
    let scrollTop = $state(0);
    let viewportH = $state(500);

    let visibleRows = $derived.by((): GuideRow[] => {
        const top = scrollTop - OVERSCAN * CHANNEL_ROW_H;
        const bottom = scrollTop + viewportH + OVERSCAN * CHANNEL_ROW_H;
        return rows.filter((row) => {
            const h = row.type === 'channel' ? CHANNEL_ROW_H : CATEGORY_ROW_H;
            return row.y + h > top && row.y < bottom;
        });
    });

    // -------------------------------------------------------------------------
    // Category jump
    // -------------------------------------------------------------------------
    let showCategoryMenu = $state(false);

    let categoryRows = $derived(rows.filter((r): r is CategoryRow => r.type === 'category'));

    // Track which category header is currently at/above the scroll position
    let activeCategoryName = $derived.by(() => {
        let name = '';
        for (const row of categoryRows) {
            if (row.y <= scrollTop + 4) name = row.name;
            else break;
        }
        return name;
    });

    function jumpToCategory(y: number): void {
        if (!gridEl || !sidebarEl) return;
        gridEl.scrollTop = y;
        sidebarEl.scrollTop = y;
        scrollTop = y;
        showCategoryMenu = false;
    }

    // -------------------------------------------------------------------------
    // Timeline
    // -------------------------------------------------------------------------
    let totalWidth = $derived(((windowEndMs - windowStartMs) / 60000) * PX_PER_MIN);

    let timeMarkers = $derived.by(() => {
        const STEP_MS = 30 * 60 * 1000;
        const startMs = windowStartMs;
        const endMs = windowEndMs;
        const markers: { offset: number; label: string; isHour: boolean }[] = [];
        let t = Math.ceil(startMs / STEP_MS) * STEP_MS;
        while (t <= endMs) {
            const d = new Date(t);
            markers.push({
                offset: ((t - startMs) / 60000) * PX_PER_MIN,
                label: d.toLocaleTimeString(getLocale(), {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
                isHour: d.getMinutes() === 0,
            });
            t += STEP_MS;
        }
        return markers;
    });

    // Day boundary markers — one per midnight crossing within the window.
    let dayMarkers = $derived.by(() => {
        const DAY_MS = 24 * 60 * 60 * 1000;
        const markers: { offset: number; label: string }[] = [];
        // First midnight at or after windowStartMs
        const firstMidnight = Math.ceil(windowStartMs / DAY_MS) * DAY_MS;
        for (let t = firstMidnight; t < windowEndMs; t += DAY_MS) {
            const d = new Date(t);
            markers.push({
                offset: ((t - windowStartMs) / 60000) * PX_PER_MIN,
                label: d.toLocaleDateString(getLocale(), {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short',
                }),
            });
        }
        return markers;
    });

    // -------------------------------------------------------------------------
    // Now indicator
    // -------------------------------------------------------------------------
    let nowMs = $state(Date.now());
    let nowOffset = $derived(Math.max(0, ((nowMs - windowStartMs) / 60000) * PX_PER_MIN));
    let nowVisible = $derived(nowOffset > 0 && nowOffset < totalWidth);

    $effect(() => {
        const id = setInterval(() => {
            nowMs = Date.now();
        }, 30_000);
        return () => clearInterval(id);
    });

    // -------------------------------------------------------------------------
    // DOM refs + scroll sync
    // -------------------------------------------------------------------------
    let gridEl: HTMLElement | undefined = $state();
    let timelineEl: HTMLElement | undefined = $state();
    let sidebarEl: HTMLElement | undefined = $state();
    let scrollRafId: number | null = null;

    // -------------------------------------------------------------------------
    // Drag-to-scroll (mouse pan)
    // -------------------------------------------------------------------------
    let isDragging = false;
    let didDrag = false; // true once we've moved >4px — suppresses click
    let dragStartX = 0;
    let dragStartY = 0;
    let dragScrollLeft = 0;
    let dragScrollTop = 0;

    function onGridMouseDown(e: MouseEvent): void {
        if (!gridEl || e.button !== 0) return;
        isDragging = true;
        didDrag = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragScrollLeft = gridEl.scrollLeft;
        dragScrollTop = gridEl.scrollTop;
        gridEl.style.cursor = 'grabbing';
        gridEl.style.userSelect = 'none';
        e.preventDefault();
    }

    function onGridMouseMove(e: MouseEvent): void {
        if (!isDragging || !gridEl) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!didDrag && Math.abs(dx) + Math.abs(dy) > 4) didDrag = true;
        gridEl.scrollLeft = dragScrollLeft - dx;
        gridEl.scrollTop = dragScrollTop - dy;
    }

    function onGridMouseUp(): void {
        if (!isDragging || !gridEl) return;
        isDragging = false;
        gridEl.style.cursor = 'grab';
        gridEl.style.userSelect = '';
    }

    function onGridClick(e: MouseEvent): void {
        // Suppress click events that are the tail-end of a drag gesture.
        // Uses capture phase (onclickcapture) so this fires before any child
        // button handlers, preventing accidental channel/program opens after pan.
        if (didDrag) {
            e.stopPropagation();
            e.preventDefault();
            didDrag = false;
        }
    }

    function handleGridScroll(): void {
        if (!gridEl || !timelineEl || !sidebarEl) return;

        // Dismiss any short-program tooltip while scrolling
        if (tooltipProg) {
            tooltipProg = null;
            tooltipRef = null;
        }

        // Sync header + sidebar immediately (visual, no state update needed)
        timelineEl.scrollLeft = gridEl.scrollLeft;
        sidebarEl.scrollTop = gridEl.scrollTop;

        // Throttle reactive state updates + extend check to one per animation
        // frame — prevents spamming visibleRows recomputation on fast scrolling
        // across 1000 channel rows.
        if (scrollRafId !== null) return;
        scrollRafId = requestAnimationFrame(() => {
            scrollRafId = null;
            if (!gridEl) return;
            scrollTop = gridEl.scrollTop;

            // Extend when less than 60 min of grid remains to the right.
            const remainingPx = totalWidth - (gridEl.scrollLeft + gridEl.clientWidth);
            if (!extendingRight && !extendError && remainingPx < 60 * PX_PER_MIN) {
                void extendRight();
            }
        });
    }

    async function extendRight(): Promise<void> {
        if (extendingRight) return;
        extendingRight = true;
        extendError = false;
        const prevWindowEndMs = windowEndMs;
        const newEndMs = prevWindowEndMs + EXTEND_WINDOW_H * 3600 * 1000;
        try {
            const extra = await loadPrograms(new Date(prevWindowEndMs), new Date(newEndMs));
            // Build merged map outside reactive state then assign once.
            // $state.raw means one assignment = one Svelte update, no deep proxy.
            const merged: Record<string, LiveTvAiring[]> = {};
            for (const [id, progs] of Object.entries(programsByChannel)) {
                merged[id] = progs;
            }
            for (const [channelId, programs] of Object.entries(extra)) {
                const byId = new Map(
                    [...(merged[channelId] ?? []), ...programs].map((program) => [
                        program.id,
                        program,
                    ]),
                );
                merged[channelId] = [...byId.values()].sort(
                    (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
                );
            }
            programsByChannel = merged;
            windowEndMs = newEndMs;
        } catch (e) {
            extendError = true;
            // Extend failed (provider/network). Leave the window unchanged — the
            // next rightward scroll will retry. loadPrograms now throws on error,
            // so we keep it non-fatal here but log for observability.
            console.warn('[ProgramGuide] extendRight failed', e);
        } finally {
            extendingRight = false;
        }
    }

    // -------------------------------------------------------------------------
    // Program block helpers
    // -------------------------------------------------------------------------
    function programLeft(prog: LiveTvAiring): number {
        return Math.max(
            0,
            ((new Date(prog.startTime).getTime() - windowStartMs) / 60000) * PX_PER_MIN,
        );
    }

    let currentByStation = $derived.by(() =>
        Object.fromEntries(
            Object.entries(programsByChannel).map(([id, airings]) => [
                id,
                pickNowNext(airings, nowMs).current?.id,
            ]),
        ),
    );
    function isNowProgram(prog: LiveTvAiring): boolean {
        return currentByStation[prog.stationId] === prog.id;
    }

    function progressPercent(prog: LiveTvAiring): number {
        const start = new Date(prog.startTime).getTime();
        const end = new Date(prog.endTime).getTime();
        return Math.round(Math.max(0, Math.min(100, ((nowMs - start) / (end - start)) * 100)));
    }

    // -------------------------------------------------------------------------
    // Overlap clipping: shorten program visuals so they don't overlap the next
    // -------------------------------------------------------------------------
    /**
     * For a sorted array of programs on one channel, return the effective visual
     * end time for each program. If program N's endTime extends past program
     * N+1's startTime, we clip N's visual width to end at N+1's start.
     */
    function getClippedWidth(prog: LiveTvAiring, nextProg: LiveTvAiring | undefined): number {
        const startMs = new Date(prog.startTime).getTime();
        let endMs = new Date(prog.endTime).getTime();

        // Clip to next program's start if overlapping
        if (nextProg) {
            const nextStartMs = new Date(nextProg.startTime).getTime();
            if (endMs > nextStartMs) {
                endMs = nextStartMs;
            }
        }

        const left = ((startMs - windowStartMs) / 60000) * PX_PER_MIN;
        const right = ((endMs - windowStartMs) / 60000) * PX_PER_MIN;
        return Math.max(0, Math.min(totalWidth, right) - Math.max(0, left));
    }

    // -------------------------------------------------------------------------
    // Program details popover — clicking a program block opens details instead
    // of tuning immediately; "Watch channel" inside the popover is the tune path.
    // -------------------------------------------------------------------------
    function openProgramDetails(prog: LiveTvAiring, channel: LiveTvStation): void {
        modals.open(
            ProgramDetailsPopover,
            {
                program: prog,
                channelName: channel.name,
                channelLogoUrl: channel.images?.primary?.href,
                onWatchChannel: () => {
                    modals.close();
                    onChannelClick?.(channel);
                },
                onClose: () => {
                    modals.close();
                },
            },
            { closeOnBackdrop: true, closeOnEscape: true },
        );
    }

    // -------------------------------------------------------------------------
    // Tooltip for short programs (floating-ui, fixed strategy to escape overflow)
    // -------------------------------------------------------------------------
    let tooltipProg = $state<LiveTvAiring | null>(null);
    let tooltipEl: HTMLDivElement | undefined = $state();
    let tooltipRef: HTMLElement | null = null;
    let tooltipHideTimeout: ReturnType<typeof setTimeout> | undefined;

    function showProgramTooltip(e: MouseEvent, prog: LiveTvAiring): void {
        clearTimeout(tooltipHideTimeout);
        tooltipRef = e.currentTarget as HTMLElement;
        tooltipProg = prog;
        requestAnimationFrame(positionTooltip);
    }

    function hideProgramTooltip(): void {
        tooltipHideTimeout = setTimeout(() => {
            tooltipProg = null;
            tooltipRef = null;
        }, 100);
    }

    function positionTooltip(): void {
        if (!tooltipRef || !tooltipEl) return;
        void computePosition(tooltipRef, tooltipEl, {
            placement: 'top',
            strategy: 'fixed',
            middleware: [offset(6), flip(), shift({ padding: 8 })],
        }).then(({ x, y }) => {
            if (!tooltipEl) return;
            tooltipEl.style.left = `${x}px`;
            tooltipEl.style.top = `${y}px`;
        });
    }

    // Reposition when the tooltip element mounts (conditional {#if} render)
    $effect(() => {
        if (tooltipEl && tooltipRef) {
            positionTooltip();
        }
    });

    onDestroy(() => {
        clearTimeout(tooltipHideTimeout);
    });

    // -------------------------------------------------------------------------
    // Logo fallback
    // -------------------------------------------------------------------------
    const LOGO_COLORS = [
        '#6366f1',
        '#ec4899',
        '#f59e0b',
        '#10b981',
        '#3b82f6',
        '#8b5cf6',
        '#ef4444',
        '#14b8a6',
        '#f97316',
        '#06b6d4',
    ];

    function hashString(str: string): number {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    function logoColor(name: string): string {
        return LOGO_COLORS[hashString(name) % LOGO_COLORS.length];
    }

    // Logo URLs that failed to load (missing/404) — render the name monogram
    // instead of a broken-image glyph. Keyed by URL (not channel id) so a
    // corrected URL is retried automatically.
    const failedLogoUrls = new SvelteSet<string>();

    // -------------------------------------------------------------------------
    // Initial load + "jump to now"
    // -------------------------------------------------------------------------
    /**
     * (Re)load the initial guide window. On failure sets loadError so the UI can
     * render a retry affordance instead of a silent blank grid. Re-runnable from
     * the retry button.
     */
    async function loadInitialPrograms(): Promise<void> {
        loading = true;
        loadError = false;
        try {
            programsByChannel = await loadPrograms(windowStart, windowEnd);
        } catch {
            loadError = true;
            programsByChannel = {};
        } finally {
            loading = false;
        }
    }

    /** Scroll the grid so the "now" line sits just inside the left edge. */
    async function scrollToNow(): Promise<void> {
        if (!gridEl) return;
        // If the tab was left open long enough that "now" is past the loaded
        // window, extend first so we don't just clamp to a stale right edge.
        if (Date.now() > windowEndMs) {
            await extendRight();
        }
        const nowPx = ((Date.now() - windowStartMs) / 60000) * PX_PER_MIN;
        gridEl.scrollLeft = Math.max(0, nowPx - 60);
    }

    // -------------------------------------------------------------------------
    // Mount: load initial programs + measure viewport
    // -------------------------------------------------------------------------
    onMount(async () => {
        if (gridEl) {
            viewportH = gridEl.clientHeight;

            // Keep viewportH in sync with container resizes (e.g. browser resize,
            // split-pane changes) so virtual scroll window stays accurate.
            const ro = new ResizeObserver(([entry]) => {
                viewportH = entry.contentRect.height;
            });
            ro.observe(gridEl);
            $effect(() => () => ro.disconnect());
        }

        await loadInitialPrograms();

        // Scroll so current programs are visible on first paint.
        scrollToNow();
    });
</script>

<!-- Guide container: 4-cell CSS grid filling remaining viewport -->
<div
    class="guide-container"
    style="--sidebar-w: {SIDEBAR_W}px; --timeline-h: {TIMELINE_H}px{height
        ? `; height: ${height}`
        : ''}">
    <!-- Corner (top-left): category jump dropdown when categories exist -->
    <div class="corner bg-surface-800 border-b border-r border-surface-700/50">
        {#if categoryRows.length > 1}
            <details class="relative h-full w-full" bind:open={showCategoryMenu}>
                <summary
                    class="flex h-full cursor-pointer list-none items-center gap-1.5 px-2 transition-colors hover:bg-surface-700/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500">
                    <span class="min-w-0 flex-1 truncate text-xs font-medium text-surface-200">
                        {activeCategoryName || m.program_guide_jump_to()}
                    </span>
                    <Icon
                        src={ChevronDown}
                        class="h-3 w-3 shrink-0 text-surface-400 transition-transform {showCategoryMenu
                            ? 'rotate-180'
                            : ''}" />
                </summary>
                <!-- Dropdown: appears below the corner, scrollable, closes on outside click -->
                <div
                    class="absolute left-0 top-full z-50 max-h-72 w-52 overflow-y-auto rounded-b-lg border border-t-0 border-surface-600/50 bg-surface-800 shadow-2xl">
                    {#each categoryRows as cat (cat.id)}
                        <button
                            class="w-full px-3 py-2 text-left text-sm text-surface-200 transition-colors hover:bg-surface-700 {activeCategoryName ===
                            cat.name
                                ? 'text-primary-400 font-medium'
                                : ''}"
                            onclick={() => jumpToCategory(cat.y)}>
                            {cat.name}
                        </button>
                    {/each}
                </div>
            </details>
        {:else}
            <div class="flex h-full items-end px-2 pb-1">
                <span class="text-xs font-medium uppercase tracking-wide text-surface-500"
                    >{m.media_channel()}</span>
            </div>
        {/if}
    </div>

    <!-- Timeline (top-right, scrolls H only) -->
    <div class="timeline border-b border-surface-700/50 bg-surface-800" bind:this={timelineEl}>
        <div class="relative" style="width: {totalWidth}px; height: {TIMELINE_H}px">
            {#each dayMarkers as day (day.offset)}
                <!-- Day boundary: full-height divider + day name badge -->
                <div
                    class="absolute top-0 bottom-0 w-px bg-primary-500/50 z-10"
                    style="left: {day.offset}px">
                </div>
                <div class="absolute top-1 z-10" style="left: {day.offset + 6}px">
                    <span
                        class="text-xs font-bold text-primary-300 whitespace-nowrap bg-surface-800/80 px-1.5 py-0.5 rounded">
                        {day.label}
                    </span>
                </div>
            {/each}
            {#each timeMarkers as marker (marker.offset)}
                <div
                    class="absolute top-0 bottom-0 flex flex-col justify-end pb-1"
                    style="left: {marker.offset}px">
                    <div
                        class="h-2 w-px mb-1 {marker.isHour ? 'bg-surface-500' : 'bg-surface-700'}">
                    </div>
                    <span class="text-xs text-surface-400 whitespace-nowrap pl-1">
                        {marker.label}
                    </span>
                </div>
            {/each}
            {#if nowVisible}
                <div
                    class="absolute top-0 bottom-0 w-0.5 bg-red-500/80"
                    style="left: {nowOffset}px">
                </div>
            {/if}
        </div>
    </div>

    <!-- Sidebar (bottom-left, scrolls V only) -->
    <div class="sidebar border-r border-surface-700/50 bg-surface-800" bind:this={sidebarEl}>
        <div class="relative" style="height: {totalHeight}px">
            {#each visibleRows as row (row.type === 'channel' ? `ch-${row.channel.id}` : `cat-${row.id}`)}
                {#if row.type === 'category'}
                    <div
                        class="absolute left-0 right-0 flex items-center px-2 bg-surface-600/70 border-y border-surface-500/40"
                        style="top: {row.y}px; height: {CATEGORY_ROW_H}px">
                        <div class="w-1 h-4 rounded-full bg-primary-400 mr-2 shrink-0"></div>
                        <span
                            class="text-xs font-bold uppercase tracking-wider text-surface-100 truncate">
                            {row.name}
                        </span>
                    </div>
                {:else}
                    <button
                        class="absolute left-0 right-0 flex items-center gap-2 px-2 hover:bg-surface-700/40 transition-colors text-left border-b border-surface-700/20"
                        style="top: {row.y}px; height: {CHANNEL_ROW_H}px"
                        onclick={() => onChannelClick?.(row.channel)}
                        title={row.channel.name}
                        aria-label={row.channel.name}>
                        {#if row.channel.images?.primary?.href && !failedLogoUrls.has(row.channel.images?.primary?.href)}
                            <img
                                src={row.channel.images?.primary?.href}
                                alt={row.channel.name}
                                class="h-8 w-8 shrink-0 rounded object-contain bg-surface-900"
                                loading="lazy"
                                onerror={() =>
                                    row.channel.images?.primary?.href &&
                                    failedLogoUrls.add(row.channel.images?.primary?.href)} />
                        {:else}
                            <div
                                class="h-8 w-8 shrink-0 rounded flex items-center justify-center text-sm font-bold text-white"
                                style="background-color: {logoColor(row.channel.name)}">
                                {row.channel.name.charAt(0).toUpperCase()}
                            </div>
                        {/if}
                        <span class="truncate text-sm font-medium text-surface-200">
                            {rowLabel(row.channel.name)}
                        </span>
                    </button>
                {/if}
            {/each}
        </div>
    </div>

    <!-- Grid (bottom-right, scrolls both axes) -->
    <!-- The scroll region needs focus for native arrow/PageUp/PageDown scrolling.
         It contains normal buttons, so application/grid widget semantics would
         incorrectly require custom keyboard interaction. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div
        class="grid-scroll bg-surface-900 overflow-auto"
        role="region"
        tabindex="0"
        aria-busy={loading}
        aria-label={m.program_guide_timeline_aria()}
        style="cursor: grab"
        bind:this={gridEl}
        onscroll={handleGridScroll}
        onmousedown={onGridMouseDown}
        onmousemove={onGridMouseMove}
        onmouseup={onGridMouseUp}
        onmouseleave={onGridMouseUp}
        onclickcapture={onGridClick}>
        {#if loading}
            <div class="flex items-center justify-center h-full min-h-32">
                <span class="text-surface-400 text-sm">{m.program_guide_loading()}</span>
            </div>
        {:else if loadError}
            <div class="flex h-full min-h-32 flex-col items-center justify-center gap-3 px-4">
                <span class="text-surface-300 text-sm text-center"
                    >{m.program_guide_load_error()}</span>
                <button
                    class="rounded-full bg-primary-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-500"
                    onclick={() => void loadInitialPrograms()}>
                    {m.program_guide_retry()}
                </button>
            </div>
        {:else if !hasAnyPrograms}
            <div class="flex flex-col gap-3 items-center justify-center h-full min-h-32 px-4">
                <span class="text-surface-400 text-sm text-center"
                    >{guideUnavailable
                        ? m.livetv_availability_guide_empty()
                        : m.program_guide_no_epg_data()}</span>
                <a class="text-primary-400 underline" href={resolve('/livetv')}
                    >{m.livetv_availability_back()}</a>
            </div>
        {:else}
            <div class="relative" style="width: {totalWidth}px; height: {totalHeight}px">
                <!-- Day boundary vertical lines -->
                {#each dayMarkers as day (day.offset)}
                    <div
                        class="absolute top-0 bottom-0 w-px bg-primary-500/25 z-10 pointer-events-none"
                        style="left: {day.offset}px">
                    </div>
                {/each}
                <!-- Now indicator vertical line -->
                {#if nowVisible}
                    <div
                        class="absolute top-0 bottom-0 w-0.5 bg-red-500/60 z-10 pointer-events-none"
                        style="left: {nowOffset}px">
                    </div>
                {/if}

                {#each visibleRows as row (row.type === 'channel' ? `ch-${row.channel.id}` : `cat-${row.id}`)}
                    {#if row.type === 'category'}
                        <!-- Category separator row in grid -->
                        <div
                            class="absolute left-0 right-0 bg-surface-600/70 border-y border-surface-500/40 flex items-center"
                            style="top: {row.y}px; height: {CATEGORY_ROW_H}px; width: {totalWidth}px">
                            <span
                                class="px-4 text-xs font-bold uppercase tracking-wider text-surface-200 opacity-60 select-none"
                                >{row.name}</span>
                        </div>
                    {:else}
                        {@const channelPrograms = programsByChannel[row.channel.id] ?? []}
                        <!-- Channel program row -->
                        <div
                            class="absolute left-0 border-b border-surface-700/20"
                            style="top: {row.y}px; height: {CHANNEL_ROW_H}px; width: {totalWidth}px">
                            {#if channelPrograms.length === 0}
                                <!-- No-EPG filler: nothing to detail, tunes the channel directly -->
                                <button
                                    class="absolute top-1 bottom-1 left-0 flex items-center rounded border border-dashed border-surface-700/40 px-3 text-xs text-surface-500 transition-colors hover:bg-surface-800/40 hover:text-surface-400"
                                    style="width: {totalWidth - 2}px"
                                    onclick={() => onChannelClick?.(row.channel)}>
                                    {m.program_guide_no_data_row()}
                                </button>
                            {:else}
                                {#each channelPrograms as prog, idx (prog.id || prog.title + prog.startTime)}
                                    {@const nextProg = channelPrograms[idx + 1]}
                                    {@const w = getClippedWidth(prog, nextProg)}
                                    {#if w > 4}
                                        {@const isCurrent = isNowProgram(prog)}
                                        {@const isShort = w < SHORT_PROGRAM_PX}
                                        <!-- No overflow-hidden on the block: the labels are
                                             position:sticky against the horizontal scroller so a
                                             program that started off-screen keeps its title pinned
                                             at the visible left edge (truncate clips each span). -->
                                        <button
                                            class="absolute top-1 bottom-1 rounded text-left transition-opacity {isCurrent
                                                ? 'bg-primary-900/60 border border-primary-600/40 hover:bg-primary-800/60'
                                                : 'bg-surface-700/60 border border-surface-600/20 hover:bg-surface-700'}"
                                            style="left: {programLeft(prog)}px; width: {w - 2}px"
                                            onclick={() => openProgramDetails(prog, row.channel)}
                                            aria-label={`${row.channel.name}: ${prog.title} (${new Date(prog.startTime).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })} – ${new Date(prog.endTime).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })})`}
                                            title={isShort
                                                ? undefined
                                                : `${prog.title} (${new Date(prog.startTime).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })} – ${new Date(prog.endTime).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })})`}
                                            onmouseenter={isShort
                                                ? (e) => showProgramTooltip(e, prog)
                                                : undefined}
                                            onmouseleave={isShort ? hideProgramTooltip : undefined}>
                                            <div
                                                class="px-2 py-1 h-full flex flex-col justify-center gap-0.5">
                                                <span
                                                    class="sticky left-2 self-start max-w-full text-xs font-medium text-surface-100 truncate leading-tight">
                                                    {prog.title}
                                                </span>
                                                {#if w > 80}
                                                    <span
                                                        class="sticky left-2 self-start max-w-full text-xs text-surface-400 truncate leading-tight">
                                                        {new Date(
                                                            prog.startTime,
                                                        ).toLocaleTimeString(getLocale(), {
                                                            hour: '2-digit',
                                                            minute: '2-digit',
                                                        })}
                                                        –
                                                        {new Date(prog.endTime).toLocaleTimeString(
                                                            getLocale(),
                                                            {
                                                                hour: '2-digit',
                                                                minute: '2-digit',
                                                            },
                                                        )}
                                                    </span>
                                                {/if}
                                            </div>

                                            {#if isCurrent}
                                                <!-- Progress bar at bottom of current program.
                                                     rounded-b + own overflow clip since the block
                                                     button no longer clips (sticky labels). -->
                                                <div
                                                    class="absolute bottom-0 left-0 right-0 h-0.5 rounded-b overflow-hidden bg-surface-600/50">
                                                    <div
                                                        class="h-full bg-primary-500"
                                                        style="width: {progressPercent(prog)}%">
                                                    </div>
                                                </div>
                                            {/if}
                                        </button>
                                    {/if}
                                {/each}
                            {/if}
                        </div>
                    {/if}
                {/each}
            </div>
        {/if}
    </div>

    <!-- Persistent "jump to now" affordance — scroll-to-now only fires on mount,
         so this lets the user return to the current time after panning. -->
    {#if !loading && !loadError && hasAnyPrograms}
        <button class="now-button" onclick={scrollToNow} title={m.program_guide_jump_to_now()}>
            {m.program_guide_now()}
        </button>
    {/if}

    {#if extendingRight}
        <div class="extend-indicator" role="status">
            <span class="text-xs text-surface-400">{m.program_guide_loading_more()}</span>
        </div>
    {/if}
    {#if extendError}
        <div
            class="extend-indicator flex max-w-[calc(100%_-_2rem)] flex-wrap items-center gap-2"
            role="alert">
            <span class="text-sm">{m.program_guide_load_error()}</span>
            <button
                type="button"
                class="min-h-10 rounded-lg bg-primary-600 px-3 text-sm text-white"
                onclick={() => void extendRight()}>{m.program_guide_retry()}</button>
        </div>
    {/if}
</div>

<!-- Floating tooltip for short programs (fixed positioning, escapes overflow) -->
{#if tooltipProg}
    <div bind:this={tooltipEl} class="program-tooltip" role="tooltip">
        <div class="font-medium text-surface-100">{tooltipProg.title}</div>
        <div class="text-surface-400">
            {new Date(tooltipProg.startTime).toLocaleTimeString(getLocale(), {
                hour: '2-digit',
                minute: '2-digit',
            })}
            –
            {new Date(tooltipProg.endTime).toLocaleTimeString(getLocale(), {
                hour: '2-digit',
                minute: '2-digit',
            })}
        </div>
        {#if tooltipProg.description}
            <div class="text-surface-300 mt-1 line-clamp-2">
                {tooltipProg.description}
            </div>
        {/if}
    </div>
{/if}

<style>
    .guide-container {
        position: relative;
        display: grid;
        grid-template:
            'corner  timeline' var(--timeline-h)
            'sidebar grid' 1fr
            / var(--sidebar-w) 1fr;
        height: calc(100dvh - 9rem);
        overflow: hidden;
        background: var(--color-surface-900, #0f0f0f);
    }

    .now-button {
        min-height: 40px;
        position: absolute;
        top: calc(var(--timeline-h) + 0.5rem);
        right: 0.75rem;
        z-index: 30;
        padding: 0.375rem 0.875rem;
        font-size: 0.75rem;
        font-weight: 500;
        color: #fff;
        background: var(--color-primary-600, #4f46e5);
        border-radius: 9999px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        transition: background-color 0.15s ease;
    }

    .now-button:hover {
        background: var(--color-primary-500, #6366f1);
    }

    .corner {
        grid-area: corner;
    }
    .timeline {
        grid-area: timeline;
        overflow: hidden;
    }
    .sidebar {
        grid-area: sidebar;
        overflow: hidden;
    }
    .grid-scroll {
        grid-area: grid;
    }

    .grid-scroll:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: -2px;
    }

    @media (max-width: 480px) {
        .guide-container {
            grid-template-columns: 120px minmax(0, 1fr);
        }
    }

    .extend-indicator {
        position: fixed;
        bottom: 1.5rem;
        right: 1.5rem;
        background: rgb(var(--color-surface-700-rgb) / 0.9);
        padding: 0.375rem 0.75rem;
        border-radius: 9999px;
        z-index: 50;
        border: 1px solid rgb(var(--color-surface-600-rgb) / 0.5);
    }

    .program-tooltip {
        position: fixed;
        z-index: 2000; /* Z.TOOLTIP */
        pointer-events: none;
        max-width: 280px;
        padding: 0.5rem 0.75rem;
        font-size: 0.75rem;
        line-height: 1.3;
        background: rgb(30, 30, 30);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 0.5rem;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        animation: tooltip-appear 0.12s ease-out;
    }

    @keyframes tooltip-appear {
        from {
            opacity: 0;
            transform: translateY(4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
</style>
