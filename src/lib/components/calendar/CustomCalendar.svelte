<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { SvelteDate, SvelteMap } from 'svelte/reactivity';
    import { stopPropagation } from '$lib/utils/event-helpers';

    // Exported types for consumers
    export interface CalendarEvent {
        start: Date;
        end: Date;
        titleHTML: string;
        imageUrl?: string;
        backdropUrl?: string;
        extendedProps: Record<string, unknown>;
        allDay?: boolean;
    }

    export interface EventSource {
        events: (info: { start: Date; end: Date }) => Promise<CalendarEvent[]>;
    }
</script>

<script lang="ts">
    import { onMount, onDestroy, tick } from 'svelte';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { browser } from '$app/environment';
    import { debounce } from '$lib/utils/debounce';
    import {
        Icon,
        ChevronLeft,
        ChevronRight,
        ListBullet,
        CalendarDays,
        ViewColumns,
    } from 'svelte-hero-icons';
    import { fade, fly } from 'svelte/transition';
    import { computePosition, autoUpdate, flip, shift, offset } from '@floating-ui/dom';
    import {
        SWIPE_THRESHOLD,
        getSwipeDirection,
        isCancelledByVerticalScroll,
        canScrollFurther,
        findHorizontalScroller,
        type ScrollMetrics,
    } from './calendar-swipe';

    // View mode constants — declared before Props so CalendarViewType can be derived
    const CALENDAR_VIEW = {
        MONTH: 'dayGridMonth',
        WEEK: 'week',
        LIST: 'listWeek',
    } as const;
    type CalendarViewType = (typeof CALENDAR_VIEW)[keyof typeof CALENDAR_VIEW];

    // Persist the chosen view (List/Week/Month) across page loads.
    const VIEW_STORAGE_KEY = 'lumastra:calendar-view';
    function isValidView(v: string | null): v is CalendarViewType {
        return v === CALENDAR_VIEW.MONTH || v === CALENDAR_VIEW.WEEK || v === CALENDAR_VIEW.LIST;
    }

    // Week view has two rendering styles — persisted independently of the
    // List/Week/Month view choice above.
    type WeekStyle = 'compact' | 'detailed';
    const WEEK_STYLE_STORAGE_KEY = 'calendar-week-style';
    function isValidWeekStyle(v: string | null): v is WeekStyle {
        return v === 'compact' || v === 'detailed';
    }

    interface Props {
        // Props
        view?: CalendarViewType;
        locale?: string;
        firstDay?: number; // 0 = Sunday, 1 = Monday
        eventSources?: EventSource[];
        buttonText?: Record<string, string>;
        /** Keep previews out of the way while the parent context menu is open. */
        contextMenuOpen?: boolean;
        // Callbacks
        onEventClick?: (detail: { event: { extendedProps: Record<string, unknown> } }) => void;
        /** False for entries with nothing to open; their touch preview gets no Details button. */
        canOpenEvent?: (extendedProps: Record<string, unknown>) => boolean;
        onEventDidMount?: (detail: {
            event: { extendedProps: Record<string, unknown> };
            el: HTMLElement;
        }) => void;
    }

    let {
        view = $bindable('dayGridMonth'),
        locale = 'de-DE',
        firstDay = 1,
        eventSources = [],
        buttonText = {
            today: 'Today',
            dayGridMonth: 'Month',
            week: 'Week',
            listWeek: 'List',
        },
        contextMenuOpen = false,
        onEventClick,
        canOpenEvent = () => true,
        onEventDidMount,
    }: Props = $props();

    // State
    let currentDate = new SvelteDate();
    let events: CalendarEvent[] = [];
    let loading = $state(false);
    let fetchError = $state<string | null>(null);
    // Generation counter — incremented on every navigation/refetch so that
    // a stale in-flight fetch can detect it has been superseded and discard
    // its result (M3: rapid month-nav fetch race prevention).
    let fetchGeneration = 0;
    let isMobile = $state(false);
    let selectedMobileDate = $state<Date | null>(null);
    let transitionDirection: 'left' | 'right' = $state('right');
    let contentKey = $state(0); // For triggering transitions
    const MONTH_EVENT_LIMIT = 4;
    let expandedDates = $state<Record<number, boolean>>({});
    // Week view rendering style — compact day-strip (default) vs the
    // full-height rail-column layout. Independent of `view`/VIEW_STORAGE_KEY.
    let weekStyle = $state<WeekStyle>('compact');

    // --- Week thumb hover/focus tooltip (single instance for the whole strip) ---
    const TOOLTIP_HOVER_DELAY_MS = 150;
    const WEEK_TOOLTIP_ID = 'calendar-week-thumb-tooltip';
    // Keep the source event identity for the trigger's aria-describedby comparison.
    let tooltipEvent = $state.raw<CalendarEvent | null>(null);
    let tooltipEl = $state<HTMLDivElement | null>(null);
    let tooltipAnchor = $state<HTMLElement | null>(null);
    let tooltipHoverTimer: ReturnType<typeof setTimeout> | null = null;
    // Touch has no hover: a tap fires focus (opens the preview) and then click.
    // A touch tap therefore only PINS the preview; the release opens from its
    // Details button (or a second tap on the same entry).
    const TOUCH_TAP_WINDOW_MS = 1000;
    let lastTouchAt = Number.NEGATIVE_INFINITY;
    let previewPinned = $state(false);

    // Swipe tracking - discriminated union eliminates stale-coordinate bugs.
    // `scrollAtStart` is the geometry of the horizontally scrollable container the
    // gesture started in (the mobile week strip), sampled BEFORE the strip scrolls,
    // so week navigation only fires once that strip is at its edge.
    type TouchState =
        | { active: false }
        | {
              active: true;
              startX: number;
              startY: number;
              scrollAtStart: ScrollMetrics | null;
          };
    let touchState: TouchState = { active: false };
    let calendarRoot = $state<HTMLDivElement | null>(null);

    function getWeekDays(short = false): string[] {
        const days: string[] = [];
        const baseDate = new SvelteDate(2024, 0, firstDay);
        for (let i = 0; i < 7; i++) {
            const date = new SvelteDate(baseDate);
            date.setDate(baseDate.getDate() + i);
            days.push(
                new Intl.DateTimeFormat(locale, {
                    weekday: short ? 'narrow' : 'short',
                }).format(date),
            );
        }
        return days;
    }

    function getCalendarDays(
        year: number,
        month: number,
        firstDayOfWeek: number,
    ): Array<{ date: Date; isCurrentMonth: boolean; isToday: boolean }> {
        const days: Array<{
            date: Date;
            isCurrentMonth: boolean;
            isToday: boolean;
        }> = [];
        const firstOfMonth = new SvelteDate(year, month, 1);
        const lastOfMonth = new SvelteDate(year, month + 1, 0);
        const today = new SvelteDate();
        today.setHours(0, 0, 0, 0);

        let startDay = firstOfMonth.getDay() - firstDayOfWeek;
        if (startDay < 0) startDay += 7;

        for (let i = startDay - 1; i >= 0; i--) {
            const date = new SvelteDate(year, month, -i);
            days.push({
                date,
                isCurrentMonth: false,
                isToday: date.getTime() === today.getTime(),
            });
        }

        for (let d = 1; d <= lastOfMonth.getDate(); d++) {
            const date = new SvelteDate(year, month, d);
            days.push({
                date,
                isCurrentMonth: true,
                isToday: date.getTime() === today.getTime(),
            });
        }

        const remaining = 42 - days.length;
        for (let i = 1; i <= remaining; i++) {
            const date = new SvelteDate(year, month + 1, i);
            days.push({
                date,
                isCurrentMonth: false,
                isToday: date.getTime() === today.getTime(),
            });
        }

        return days;
    }

    function getViewStart(): Date {
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();

        if (view === CALENDAR_VIEW.LIST || view === CALENDAR_VIEW.WEEK) {
            const start = new SvelteDate(currentDate);
            const day = start.getDay();
            const diff = day - firstDay;
            start.setDate(start.getDate() - (diff < 0 ? diff + 7 : diff));
            start.setHours(0, 0, 0, 0);
            return start;
        }
        const firstOfMonth = new SvelteDate(year, month, 1);
        let startDay = firstOfMonth.getDay() - firstDay;
        if (startDay < 0) startDay += 7;
        const start = new SvelteDate(year, month, 1 - startDay);
        start.setHours(0, 0, 0, 0);
        return start;
    }

    function getViewEnd(): Date {
        const start = getViewStart();
        if (view === CALENDAR_VIEW.WEEK) {
            const end = new SvelteDate(start);
            end.setDate(end.getDate() + 7);
            end.setHours(23, 59, 59, 999);
            return end;
        }
        if (view === CALENDAR_VIEW.LIST) {
            const end = new SvelteDate(start);
            end.setDate(end.getDate() + 14);
            end.setHours(23, 59, 59, 999);
            return end;
        }
        const end = new SvelteDate(start);
        end.setDate(end.getDate() + 42);
        end.setHours(23, 59, 59, 999);
        return end;
    }

    function getEventsForDate(date: Date): CalendarEvent[] {
        const dayStart = new SvelteDate(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new SvelteDate(date);
        dayEnd.setHours(23, 59, 59, 999);

        return events.filter((event) => {
            const eventDate = new SvelteDate(event.start);
            return eventDate >= dayStart && eventDate <= dayEnd;
        });
    }

    function getEventsForWeek(weekOffset = 0): Array<{ date: Date; events: CalendarEvent[] }> {
        const weekEvents: Array<{ date: Date; events: CalendarEvent[] }> = [];
        const start = getViewStart();
        const offsetStart = new SvelteDate(start);
        offsetStart.setDate(offsetStart.getDate() + weekOffset * 7);

        for (let i = 0; i < 7; i++) {
            const date = new SvelteDate(offsetStart);
            date.setDate(offsetStart.getDate() + i);
            weekEvents.push({
                date,
                events: getDaySummary(getEventsForDate(date)).icons,
            });
        }

        return weekEvents.filter((d) => d.events.length > 0);
    }

    function getWeekLabel(weekOffset: number): string {
        const start = getViewStart();
        const weekStart = new SvelteDate(start);
        weekStart.setDate(weekStart.getDate() + weekOffset * 7);
        const weekEnd = new SvelteDate(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);

        const startStr = new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'short',
        }).format(weekStart);
        const endStr = new Intl.DateTimeFormat(locale, {
            day: 'numeric',
            month: 'short',
        }).format(weekEnd);

        return `${startStr} - ${endStr}`;
    }

    async function fetchEvents() {
        const start = getViewStart();
        const end = getViewEnd();
        // Capture the current generation at call time so we can detect if a
        // newer fetch has superseded us before we write back results (M3).
        const generation = ++fetchGeneration;
        loading = true;
        fetchError = null;
        try {
            const allEvents: CalendarEvent[] = [];
            for (const source of eventSources) {
                const sourceEvents = await source.events({ start, end });
                allEvents.push(...sourceEvents);
            }
            // Only commit if no newer fetch has been started (M3 race guard).
            if (generation === fetchGeneration) {
                events = allEvents;
                fetchError = null;
            }
        } catch (error) {
            console.error('Failed to fetch calendar events:', error);
            if (generation === fetchGeneration) {
                events = [];
                fetchError = error instanceof Error ? error.message : String(error); // M9: propagate error
            }
        } finally {
            if (generation === fetchGeneration) {
                loading = false;
            }
        }
    }

    // Deselects a mobile date and triggers a transition — called on every navigation
    function resetMobileSelection() {
        selectedMobileDate = null;
        contentKey++;
        hideTooltip(); // the thumb strip re-renders — its anchor element is gone
    }

    // Navigation with transition direction
    // IMPORTANT: mutate currentDate in-place (SvelteDate tracks mutations reactively).
    // Reassigning to a new SvelteDate breaks $derived reactivity since the variable is not $state.
    function goToToday() {
        expandedDates = {};
        const now = new Date();
        transitionDirection = now.getTime() < currentDate.getTime() ? 'left' : 'right';
        currentDate.setTime(now.getTime());
        resetMobileSelection();
        fetchEvents();
    }

    function goToPrev() {
        expandedDates = {};
        transitionDirection = 'left';
        if (view === CALENDAR_VIEW.LIST || view === CALENDAR_VIEW.WEEK) {
            currentDate.setDate(currentDate.getDate() - 7);
        } else {
            currentDate.setDate(1); // Set day first to avoid month overflow (e.g. March 31 → Feb)
            currentDate.setMonth(currentDate.getMonth() - 1);
        }
        resetMobileSelection();
        fetchEvents();
    }

    function goToNext() {
        expandedDates = {};
        transitionDirection = 'right';
        if (view === CALENDAR_VIEW.LIST || view === CALENDAR_VIEW.WEEK) {
            currentDate.setDate(currentDate.getDate() + 7);
        } else {
            currentDate.setDate(1); // Set day first to avoid month overflow
            currentDate.setMonth(currentDate.getMonth() + 1);
        }
        resetMobileSelection();
        fetchEvents();
    }

    function setView(newView: CalendarViewType) {
        view = newView;
        if (browser) {
            try {
                localStorage.setItem(VIEW_STORAGE_KEY, newView);
            } catch {
                /* localStorage unavailable (private mode / quota) — non-fatal */
            }
        }
        resetMobileSelection();
        fetchEvents();
    }

    function setWeekStyle(newStyle: WeekStyle) {
        weekStyle = newStyle;
        hideTooltip();
        if (browser) {
            try {
                localStorage.setItem(WEEK_STYLE_STORAGE_KEY, newStyle);
            } catch {
                /* localStorage unavailable (private mode / quota) — non-fatal */
            }
        }
    }

    function handleEventClick(event: CalendarEvent, el: HTMLElement, individual = false): void {
        if (!individual && getSeriesEpisodes(event).length > 1) {
            showTooltipNow(event, el);
            void tick().then(() => tooltipEl?.querySelector('button')?.focus());
            return;
        }
        const touchTap = performance.now() - lastTouchAt < TOUCH_TAP_WINDOW_MS;
        if (!individual && touchTap) {
            if (!(previewPinned && tooltipEvent === event)) {
                showTooltipNow(event, el);
                previewPinned = true;
                return;
            }
            // Second tap on a pinned entry: open it, or close a preview with nothing to open.
            if (!canOpenEvent(event.extendedProps)) {
                hideTooltip();
                return;
            }
        }
        openEventDetails(event);
    }

    function openEventDetails(event: CalendarEvent): void {
        hideTooltip();
        onEventClick?.({
            event: { extendedProps: event.extendedProps },
        });
    }

    function handleEventMount(event: CalendarEvent, el: HTMLElement) {
        onEventDidMount?.({
            event: { extendedProps: event.extendedProps },
            el,
        });
    }

    function handleMobileDayClick(date: Date, eventCount: number) {
        if (eventCount > 0) {
            if (selectedMobileDate?.getTime() === date.getTime()) {
                selectedMobileDate = null;
            } else {
                selectedMobileDate = date;
            }
        }
    }

    // Swipe gesture handlers — discriminated union prevents stale coordinate reuse
    function handleTouchStart(e: TouchEvent) {
        // Below 900px the week rail is itself a horizontal scroller. Its touches
        // bubble up here, so a drag meant to scroll the day strip used to also
        // flip the week. Record where that scroller stood when the gesture began.
        const scroller = calendarRoot
            ? findHorizontalScroller(e.target as Element | null, calendarRoot)
            : null;
        touchState = {
            active: true,
            startX: e.touches[0].clientX,
            startY: e.touches[0].clientY,
            scrollAtStart: scroller
                ? {
                      scrollLeft: scroller.scrollLeft,
                      scrollWidth: scroller.scrollWidth,
                      clientWidth: scroller.clientWidth,
                  }
                : null,
        };
    }

    function handleTouchMove(e: TouchEvent) {
        if (!touchState.active) return;
        const deltaX = e.touches[0].clientX - touchState.startX;
        const deltaY = e.touches[0].clientY - touchState.startY;
        if (isCancelledByVerticalScroll(deltaX, deltaY)) {
            touchState = { active: false };
        }
    }

    function handleTouchEnd(e: TouchEvent) {
        if (!touchState.active) return;
        const direction = getSwipeDirection(touchState.startX, e.changedTouches[0].clientX);
        const scrollAtStart = touchState.scrollAtStart;
        touchState = { active: false };
        if (direction === null) return;
        // The inner strip owns the gesture until it is scrolled to the edge;
        // only then does a further swipe change the week.
        if (scrollAtStart && canScrollFurther(scrollAtStart, direction)) return;
        if (direction === 'prev') goToPrev();
        else goToNext();
    }

    // Svelte action for mounting events
    function mountEvent(node: HTMLElement, event: CalendarEvent) {
        handleEventMount(event, node);
        if (node.classList.contains('calendar-day-thumb')) return;
        if (getSeriesEpisodes(event).length > 1) node.setAttribute('aria-haspopup', 'dialog');
        const enter = (): void => scheduleTooltip(event, node);
        const focus = (): void => showTooltipNow(event, node);
        const keydown = (e: KeyboardEvent): void => {
            if (
                e.key === 'Tab' &&
                !e.shiftKey &&
                tooltipEvent === event &&
                getSeriesEpisodes(event).length > 1
            ) {
                e.preventDefault();
                tooltipEl?.querySelector('button')?.focus();
            }
        };
        node.addEventListener('mouseenter', enter);
        node.addEventListener('mouseleave', scheduleTooltipHide);
        node.addEventListener('focus', focus);
        node.addEventListener('blur', scheduleTooltipHide);
        node.addEventListener('keydown', keydown);
        return {
            destroy(): void {
                node.removeEventListener('mouseenter', enter);
                node.removeEventListener('mouseleave', scheduleTooltipHide);
                node.removeEventListener('focus', focus);
                node.removeEventListener('blur', scheduleTooltipHide);
                node.removeEventListener('keydown', keydown);
            },
        };
    }

    // Re-escape a raw URL for safe inclusion in a `style="background-image:
    // url('...')"` attribute value — mirrors the escaping MovieCalendar.svelte
    // applies before embedding it in titleHTML.
    function escapeCssUrl(url: string): string {
        return url.replace(/[\\']/g, '\\$&').replace(/[\n\r\f]/g, ' ');
    }

    // Best-effort human label for a thumbnail's aria-label / fallback letter.
    function getEventLabel(event: CalendarEvent): string {
        const seriesName = eventContext(event)?.series?.title;
        const { title } = event.extendedProps as {
            seriesName?: unknown;
            title?: unknown;
        };
        if (typeof seriesName === 'string' && seriesName.length > 0) return seriesName;
        if (typeof title === 'string' && title.length > 0) return title;
        return '';
    }

    function eventContext(
        event: CalendarEvent,
    ): import('$lib/schemas/api-media-preview').MediaPreviewContext | undefined {
        return event.extendedProps.context as
            import('$lib/schemas/api-media-preview').MediaPreviewContext | undefined;
    }

    function getSeriesKey(event: CalendarEvent): string | null {
        return eventContext(event)?.series?.id ?? null;
    }

    function getSeriesEpisodes(event: CalendarEvent): CalendarEvent[] {
        const key = getSeriesKey(event);
        if (!key) return [event];
        return getEventsForDate(event.start)
            .filter((candidate) => getSeriesKey(candidate) === key)
            .sort(
                (a, b) =>
                    Number(eventContext(a)?.seasonNumber) - Number(eventContext(b)?.seasonNumber) ||
                    Number(eventContext(a)?.episodeNumber ?? 0) -
                        Number(eventContext(b)?.episodeNumber ?? 0) ||
                    a.start.getTime() - b.start.getTime(),
            );
    }

    function getEntrySubLabel(event: CalendarEvent): string {
        const count = getSeriesEpisodes(event).length;
        return count > 1 ? m.calendar_summary_episodes({ count }) : getTooltipSubLabel(event);
    }

    function scheduleTooltipHide(): void {
        // A pinned (tapped) preview stays until an outside tap or Escape: iOS
        // blurs the anchor without focusing the Details button inside it.
        if (previewPinned) return;
        clearTooltipTimer();
        tooltipHoverTimer = setTimeout(hideTooltip, TOOLTIP_HOVER_DELAY_MS);
    }

    function getDaySummary(dayEvents: CalendarEvent[]): {
        icons: CalendarEvent[];
        label: string;
    } {
        const series = new SvelteMap<string, CalendarEvent>();
        const icons: CalendarEvent[] = [];
        let episodes = 0;
        let movies = 0;
        let other = 0;
        for (const event of dayEvents) {
            const props = event.extendedProps;
            if (eventContext(event)?.seasonNumber !== undefined) {
                episodes++;
                const key = getSeriesKey(event) ?? `unknown-${icons.length}`;
                if (!series.has(key)) {
                    series.set(key, event);
                    icons.push(event);
                }
            } else {
                icons.push(event);
                if (props.type === 'movie') movies++;
                else other++;
            }
        }
        const parts: string[] = [];
        if (series.size > 0)
            parts.push(
                series.size === 1
                    ? m.calendar_summary_series_one()
                    : m.calendar_summary_series({ count: series.size }),
            );
        if (episodes > 0)
            parts.push(
                episodes === 1
                    ? m.calendar_summary_episode_one()
                    : m.calendar_summary_episodes({ count: episodes }),
            );
        if (movies > 0)
            parts.push(
                movies === 1
                    ? m.calendar_summary_movie_one()
                    : m.calendar_summary_movies({ count: movies }),
            );
        if (other > 0)
            parts.push(
                other === 1 ? m.calendar_day_title_one() : m.calendar_day_titles({ count: other }),
            );
        return { icons, label: parts.join(' · ') };
    }

    function getBackdropStyle(event: CalendarEvent): string | undefined {
        return event.backdropUrl
            ? `background-image: linear-gradient(180deg, rgb(9 15 28 / 0.28), rgb(9 15 28 / 0.9)), url('${escapeCssUrl(event.backdropUrl)}')`
            : undefined;
    }

    // --- Week thumb tooltip: content helpers --------------------------------
    // Status dot semantics mirror MovieCalendar.svelte's event-card dot:
    // on-server items get no visual "needs attention" flag there, but the
    // tooltip surfaces it explicitly as a third (success) state.
    type TooltipStatusKind = 'airing' | 'release' | 'on-server';
    function getTooltipStatusKind(event: CalendarEvent): TooltipStatusKind {
        const availability = event.extendedProps.availability as
            { isAvailable?: boolean } | undefined;
        if (availability?.isAvailable === true) return 'on-server';
        return event.extendedProps.type === 'episode' ? 'airing' : 'release';
    }

    // "Special {episode}" for specials, "S{season}E{episode}" for regular
    // episodes, followed by the title. Falls back to the
    // release-type label (Air Date / In Cinemas / …) MovieCalendar attaches
    // to movie events, which have no season/episode.
    function getTooltipSubLabel(event: CalendarEvent): string {
        const { seasonNumber, episodeNumber } = eventContext(event) ?? {};
        const { title, releaseLabel } = event.extendedProps as {
            seasonNumber?: unknown;
            episodeNumber?: unknown;
            title?: unknown;
            releaseLabel?: unknown;
        };
        if (typeof seasonNumber === 'number') {
            const episode = typeof episodeNumber === 'number' ? episodeNumber : '?';
            const episodeTitle = typeof title === 'string' ? title : '';
            const label =
                seasonNumber === 0
                    ? m.calendar_special_episode({ episode: String(episode) })
                    : `S${seasonNumber}E${episode}`;
            return `${label}${episodeTitle ? ` · ${episodeTitle}` : ''}`;
        }
        return typeof releaseLabel === 'string' ? releaseLabel : '';
    }

    // Only present the description when the CalendarItem actually carries one
    // (no fetching — this is display-only from already-loaded extendedProps).
    function getTooltipOverview(event: CalendarEvent): string | null {
        const { overview } = event.extendedProps as { overview?: unknown };
        return typeof overview === 'string' && overview.trim().length > 0 ? overview : null;
    }

    // --- Week thumb tooltip: hover/focus + floating-ui positioning ----------
    // One tooltip instance for the whole strip: `tooltipEvent` tracks which
    // event/anchor is active rather than mounting a tooltip per thumb.
    function clearTooltipTimer() {
        if (tooltipHoverTimer !== null) {
            clearTimeout(tooltipHoverTimer);
            tooltipHoverTimer = null;
        }
    }

    /**
     * Positioning runs in a reactive $effect, NOT imperatively after the show
     * call: an `await tick()` + one-shot computePosition silently left the
     * tooltip at 0,0 whenever the element binding wasn't ready yet (observed
     * in prod: tooltip pinned to the viewport's top-left). The effect re-runs
     * the moment `tooltipEl` binds, and mirrors the app's proven pattern in
     * ui/Tooltip.svelte: floating-ui autoUpdate (repositions on any ancestor
     * scroll/resize — including the app shell's inner scroller) + rAF, writing
     * styles directly to the node. strategy 'fixed' matches position:fixed on
     * the body-portaled element.
     */
    $effect(() => {
        const anchor = tooltipAnchor;
        const floating = tooltipEl;
        if (!tooltipEvent || !anchor || !floating) return;
        const narrow = isMobile;
        let cleanup: (() => void) | undefined;
        const raf = requestAnimationFrame(() => {
            cleanup = autoUpdate(anchor, floating, () => {
                // A re-render (navigation, view switch, events arriving) can
                // drop the anchor while its preview is open: close it rather
                // than leave it floating over unrelated days.
                if (!anchor.isConnected) {
                    hideTooltip();
                    return;
                }
                void computePosition(anchor, floating, {
                    strategy: 'fixed',
                    // Beside the anchor (flipping to the other side at the viewport
                    // edge) so it never covers the thumbs above/below and the
                    // neighbouring days stay reachable.
                    // Phones have no room beside a thumb (the preview got clipped at
                    // the left edge), so there it opens below/above instead.
                    placement: narrow ? 'bottom' : 'right-start',
                    middleware: [offset(12), flip(), shift({ padding: 8, crossAxis: narrow })],
                }).then(({ x, y }) => {
                    Object.assign(floating.style, { left: `${x}px`, top: `${y}px` });
                });
            });
        });
        return () => {
            cancelAnimationFrame(raf);
            cleanup?.();
        };
    });

    function showTooltip(event: CalendarEvent, anchor: HTMLElement) {
        if (contextMenuOpen) return;
        if (tooltipEvent !== event) previewPinned = false;
        tooltipAnchor = anchor;
        tooltipEvent = event;
    }

    // Hover: delayed so a quick mouse pass over the strip doesn't flash tooltips.
    function scheduleTooltip(event: CalendarEvent, anchor: HTMLElement) {
        clearTooltipTimer();
        if (contextMenuOpen) return;
        tooltipHoverTimer = setTimeout(() => {
            showTooltip(event, anchor);
        }, TOOLTIP_HOVER_DELAY_MS);
    }

    // Keyboard focus: shown immediately (no artificial delay for a11y).
    function showTooltipNow(event: CalendarEvent, anchor: HTMLElement) {
        clearTooltipTimer();
        showTooltip(event, anchor);
    }

    function hideTooltip() {
        clearTooltipTimer();
        previewPinned = false;
        tooltipEvent = null;
        tooltipAnchor = null;
    }

    // Cancel both an existing preview and its pending hover timer. Merely
    // raising the menu's z-index would leave grouped preview buttons active.
    $effect(() => {
        if (contextMenuOpen) hideTooltip();
    });

    // Public method for refetching events
    export function refetchEvents() {
        fetchEvents();
    }

    function checkMobile() {
        isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
        hideTooltip(); // viewport change can invalidate the anchor's position
    }

    const debouncedCheckMobile = debounce(checkMobile, 150);

    onMount(() => {
        checkMobile();
        // Restore the persisted view choice before the first fetch so the initial
        // window matches the restored view (no extra fetch, no month→saved flash
        // after data loads).
        if (browser) {
            try {
                const saved = localStorage.getItem(VIEW_STORAGE_KEY);
                if (isValidView(saved)) view = saved;
            } catch {
                /* localStorage unavailable (private mode) — keep the default view */
            }
            try {
                const savedWeekStyle = localStorage.getItem(WEEK_STYLE_STORAGE_KEY);
                if (isValidWeekStyle(savedWeekStyle)) weekStyle = savedWeekStyle;
            } catch {
                /* localStorage unavailable (private mode) — keep the default 'compact' style */
            }
        }
        window.addEventListener('resize', debouncedCheckMobile);
        window.addEventListener('pointerdown', recordTouch, true);
        window.addEventListener('pointerup', recordTouch, true);
        window.addEventListener('keydown', clearTouch, true);
        if (eventSources.length > 0) {
            fetchEvents();
        }
    });

    // pointerup too: a slow tap's click can land more than the window after pointerdown.
    function recordTouch(e: PointerEvent): void {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') lastTouchAt = performance.now();
    }

    // A keyboard activation right after a tap is not a tap.
    function clearTouch(): void {
        lastTouchAt = Number.NEGATIVE_INFINITY;
    }

    onDestroy(() => {
        if (typeof window !== 'undefined') {
            window.removeEventListener('pointerdown', recordTouch, true);
            window.removeEventListener('pointerup', recordTouch, true);
            window.removeEventListener('keydown', clearTouch, true);
            window.removeEventListener('resize', debouncedCheckMobile);
        }
    });

    function formatDateHeader(date: Date): string {
        return new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
        }).format(date);
    }

    function formatDateShort(date: Date): string {
        return new Intl.DateTimeFormat(locale, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
        }).format(date);
    }

    function formatDateFull(date: Date): string {
        return new Intl.DateTimeFormat(locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
        }).format(date);
    }

    function formatTime(date: Date): string {
        return new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    }

    // Generate skeleton rows for loading state
    const skeletonDays = Array(42).fill(null);
    // Computed values
    let currentMonth = $derived(currentDate.getMonth());
    let currentYear = $derived(currentDate.getFullYear());
    let monthName = $derived(
        new Intl.DateTimeFormat(locale, {
            month: 'long',
            year: 'numeric',
        }).format(currentDate),
    );
    // Get days of week headers
    let weekDays = $derived(getWeekDays());
    let weekDaysShort = $derived(getWeekDays(true));
    // Get calendar grid
    let calendarDays = $derived(getCalendarDays(currentYear, currentMonth, firstDay));
    // Chunk the flat days array into weeks of 7 so each week can be a role="row"
    // (ARIA grid requires gridcells to live under a row). The row wrapper uses
    // display:contents so the cells remain direct CSS-grid items visually.
    let calendarWeeks = $derived.by(
        (): Array<Array<{ date: Date; isCurrentMonth: boolean; isToday: boolean }>> => {
            const weeks: Array<Array<{ date: Date; isCurrentMonth: boolean; isToday: boolean }>> =
                [];
            for (let i = 0; i < calendarDays.length; i += 7) {
                weeks.push(calendarDays.slice(i, i + 7));
            }
            return weeks;
        },
    );
    // Week Rail view: the 7 dates of the current week. Computed INLINE in the
    // template (inside {#key contentKey}) rather than as a $derived — mirroring
    // getEventsForWeek used by the list view. A component-level derived went
    // stale on same-month ±7d navigation (currentDate's month/year don't change,
    // so the derived didn't retrigger), collapsing the week onto one column.
    function getWeekRailDates(): Array<{ date: Date; isToday: boolean }> {
        const start = getViewStart();
        const todayStr = new SvelteDate().toDateString();
        const days: Array<{ date: Date; isToday: boolean }> = [];
        for (let i = 0; i < 7; i++) {
            const date = new SvelteDate(start);
            date.setDate(start.getDate() + i);
            days.push({ date, isToday: date.toDateString() === todayStr });
        }
        return days;
    }
    // Get events for selected mobile date
    let selectedDateEvents = $derived(
        selectedMobileDate ? getDaySummary(getEventsForDate(selectedMobileDate)).icons : [],
    );
    // Accessible month label for screen readers
    let ariaMonthLabel = $derived(
        new Intl.DateTimeFormat(locale, {
            month: 'long',
            year: 'numeric',
        }).format(currentDate),
    );

    // Escape dismisses the week-thumb tooltip regardless of whether it was
    // opened by hover or focus — listener only lives while it's open.
    $effect(() => {
        if (!browser || tooltipEvent === null) return;
        function onKeydown(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                if (tooltipEl?.contains(document.activeElement)) tooltipAnchor?.focus();
                hideTooltip();
            }
        }
        function onPointerDown(e: PointerEvent): void {
            if (
                e.target instanceof Node &&
                !tooltipEl?.contains(e.target) &&
                !tooltipAnchor?.contains(e.target)
            )
                hideTooltip();
        }
        window.addEventListener('keydown', onKeydown);
        window.addEventListener('pointerdown', onPointerDown);
        return () => {
            window.removeEventListener('keydown', onKeydown);
            window.removeEventListener('pointerdown', onPointerDown);
        };
    });
</script>

{#snippet entryContent(event: CalendarEvent)}
    {#if getSeriesEpisodes(event).length > 1}
        <span class="block p-2"
            ><span class="block font-bold text-sm">{getEventLabel(event)}</span><span
                class="block text-xs">{getEntrySubLabel(event)}</span
            ></span>
    {:else}
        {@html event.titleHTML}
    {/if}
{/snippet}

{#snippet listEvent(event: CalendarEvent)}
    {@const thumbUrl = event.imageUrl}
    {@const label = getEventLabel(event)}
    {@const hasTime =
        !event.allDay && (event.start.getHours() !== 0 || event.start.getMinutes() !== 0)}
    <button
        type="button"
        class="calendar-event calendar-list-event"
        data-event-data={JSON.stringify(event.extendedProps)}
        onclick={stopPropagation((e) => handleEventClick(event, e.currentTarget))}
        use:mountEvent={event}>
        <span
            class="calendar-list-poster"
            aria-hidden="true"
            style={thumbUrl ? `background-image: url('${escapeCssUrl(thumbUrl)}')` : undefined}>
            {#if !thumbUrl}{label.slice(0, 1)}{/if}
        </span>
        <span class="calendar-list-copy">{@render entryContent(event)}</span>
        {#if hasTime}
            <time class="calendar-list-time" datetime={event.start.toISOString()}
                >{formatTime(event.start)}</time>
        {/if}
    </button>
{/snippet}

<div
    class="custom-calendar"
    role="application"
    aria-label="Calendar"
    bind:this={calendarRoot}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}>
    <!-- Header Toolbar -->
    <div
        class="calendar-header flex flex-wrap items-center justify-between gap-2 mb-4 p-2"
        role="toolbar"
        aria-label="Calendar navigation">
        <!-- Title -->
        <h2
            class="calendar-title font-heading tracking-tight text-lg sm:text-xl font-semibold"
            aria-live="polite"
            aria-atomic="true">
            {monthName}
        </h2>

        <!-- Controls -->
        <div class="flex flex-wrap items-center gap-1 sm:gap-2">
            <!-- View Switcher -->
            <div class="flex gap-1" role="group" aria-label={m.calendar_view_options()}>
                <button
                    class="btn btn-sm variant-ghost p-2 sm:px-3"
                    class:variant-filled-primary={view === CALENDAR_VIEW.LIST}
                    onclick={() => setView(CALENDAR_VIEW.LIST)}
                    aria-label={m.calendar_switch_list_view()}
                    aria-pressed={view === CALENDAR_VIEW.LIST}
                    title={buttonText.listWeek || m.calendar_list()}>
                    <Icon src={ListBullet} class="w-4 h-4" aria-hidden="true" />
                    <span class="hidden sm:inline ml-1"
                        >{buttonText.listWeek || m.calendar_list()}</span>
                </button>
                <button
                    class="btn btn-sm variant-ghost p-2 sm:px-3"
                    class:variant-filled-primary={view === CALENDAR_VIEW.WEEK}
                    onclick={() => setView(CALENDAR_VIEW.WEEK)}
                    aria-label={m.calendar_switch_week_view()}
                    aria-pressed={view === CALENDAR_VIEW.WEEK}
                    title={buttonText.week || m.calendar_week()}>
                    <Icon src={ViewColumns} class="w-4 h-4" aria-hidden="true" />
                    <span class="hidden sm:inline ml-1"
                        >{buttonText.week || m.calendar_week()}</span>
                </button>
                <button
                    class="btn btn-sm variant-ghost p-2 sm:px-3"
                    class:variant-filled-primary={view === CALENDAR_VIEW.MONTH}
                    onclick={() => setView(CALENDAR_VIEW.MONTH)}
                    aria-label={m.calendar_switch_month_view()}
                    aria-pressed={view === CALENDAR_VIEW.MONTH}
                    title={buttonText.dayGridMonth || m.calendar_month()}>
                    <Icon src={CalendarDays} class="w-4 h-4" aria-hidden="true" />
                    <span class="hidden sm:inline ml-1"
                        >{buttonText.dayGridMonth || m.calendar_month()}</span>
                </button>
            </div>

            <!-- Week Style Switcher — only meaningful while the week view is active -->
            {#if view === CALENDAR_VIEW.WEEK}
                <div
                    class="flex gap-1"
                    role="group"
                    aria-label={m.calendar_week()}
                    transition:fade={{ duration: 120 }}>
                    <button
                        class="btn btn-sm variant-ghost px-2 sm:px-3"
                        class:variant-filled-primary={weekStyle === 'compact'}
                        onclick={() => setWeekStyle('compact')}
                        aria-pressed={weekStyle === 'compact'}
                        title={m.calendar_week_compact()}>
                        <span class="text-xs sm:text-sm">{m.calendar_week_compact()}</span>
                    </button>
                    <button
                        class="btn btn-sm variant-ghost px-2 sm:px-3"
                        class:variant-filled-primary={weekStyle === 'detailed'}
                        onclick={() => setWeekStyle('detailed')}
                        aria-pressed={weekStyle === 'detailed'}
                        title={m.calendar_week_detailed()}>
                        <span class="text-xs sm:text-sm">{m.calendar_week_detailed()}</span>
                    </button>
                </div>
            {/if}

            <!-- Today Button -->
            <button
                class="btn btn-sm variant-ghost px-2 sm:px-3"
                onclick={goToToday}
                aria-label={m.calendar_go_to_today()}>
                <span class="sm:hidden" aria-hidden="true">⊙</span>
                <span class="hidden sm:inline">{buttonText.today || m.calendar_today()}</span>
            </button>

            <!-- Navigation -->
            <div class="flex gap-1" role="group" aria-label={m.calendar_navigate_months()}>
                <button
                    class="btn btn-sm variant-ghost p-2"
                    onclick={goToPrev}
                    aria-label={view === CALENDAR_VIEW.LIST || view === CALENDAR_VIEW.WEEK
                        ? m.calendar_previous_week()
                        : m.calendar_previous_month()}>
                    <Icon src={ChevronLeft} class="w-4 h-4" aria-hidden="true" />
                </button>
                <button
                    class="btn btn-sm variant-ghost p-2"
                    onclick={goToNext}
                    aria-label={view === CALENDAR_VIEW.LIST || view === CALENDAR_VIEW.WEEK
                        ? m.calendar_next_week()
                        : m.calendar_next_month()}>
                    <Icon src={ChevronRight} class="w-4 h-4" aria-hidden="true" />
                </button>
            </div>
        </div>
    </div>

    {#if loading}
        <!-- Loading Skeleton -->
        <div class="calendar-days-grid" aria-busy="true" aria-label="Loading calendar">
            <!-- Week Day Headers Skeleton -->
            <div class="grid grid-cols-7 mb-1">
                {#each weekDays as day, i (i)}
                    <div
                        class="calendar-day-head font-heading text-center text-xs sm:text-sm font-semibold uppercase tracking-wide text-surface-400 py-1 sm:py-2">
                        <span class="opacity-50">{day}</span>
                    </div>
                {/each}
            </div>

            <!-- Calendar Days Skeleton -->
            <div
                class="calendar-days-container calendar-skeleton"
                class:calendar-days-mobile={isMobile}>
                {#each skeletonDays as _, i (i)}
                    <div class="calendar-day calendar-day-skeleton p-1 bg-surface-800/50">
                        <div class="calendar-day-number-skeleton"></div>
                        {#if !isMobile && i % 4 === 0}
                            <div class="calendar-event-skeleton mt-2"></div>
                        {/if}
                        {#if !isMobile && i % 7 === 3}
                            <div class="calendar-event-skeleton mt-1"></div>
                            <div class="calendar-event-skeleton mt-1"></div>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>
    {:else if fetchError}
        <!-- Error state (M9) -->
        <div class="calendar-error-state text-center py-12" role="alert">
            <p class="text-error-400 mb-4">{m.error_loading({ error: fetchError })}</p>
            <button
                class="btn btn-sm variant-ghost-primary"
                onclick={() => fetchEvents()}
                aria-label="Retry loading calendar">
                ↻
            </button>
        </div>
    {:else if view === CALENDAR_VIEW.MONTH}
        <!-- Month Grid View -->
        {#key contentKey}
            <div
                class="calendar-days-grid"
                in:fly={{
                    x: transitionDirection === 'right' ? 30 : -30,
                    duration: 200,
                }}
                role="grid"
                aria-label={`Calendar for ${ariaMonthLabel}`}>
                <!-- Week Day Headers -->
                <div class="grid grid-cols-7 mb-1" role="row">
                    {#each isMobile ? weekDaysShort : weekDays as day, i (i)}
                        <div
                            class="calendar-day-head font-heading text-center text-xs sm:text-sm font-semibold uppercase tracking-wide text-surface-400 py-1 sm:py-2"
                            role="columnheader">
                            {day}
                        </div>
                    {/each}
                </div>

                <!-- Calendar Days -->
                <div
                    class="calendar-days-container"
                    class:calendar-days-mobile={isMobile}
                    role="rowgroup">
                    {#each calendarWeeks as week (week[0].date.getTime())}
                        <!-- display:contents keeps cells as direct grid items visually -->
                        <div class="calendar-week-row" role="row">
                            {#each week as { date, isCurrentMonth, isToday } (date.getTime())}
                                {@const dayEvents = getDaySummary(getEventsForDate(date)).icons}
                                {@const isSelected =
                                    selectedMobileDate?.getTime() === date.getTime()}
                                {@const dateLabel = formatDateFull(date)}
                                {@const eventCount = dayEvents.length}
                                {@const expanded = expandedDates[date.getTime()] ?? false}
                                <div
                                    class="calendar-day p-1"
                                    class:calendar-today={isToday}
                                    class:calendar-selected={isSelected}
                                    class:opacity-50={!isCurrentMonth}
                                    class:cursor-pointer={isMobile && eventCount > 0}
                                    role="gridcell"
                                    tabindex={isCurrentMonth ? 0 : -1}
                                    aria-label={`${dateLabel}${eventCount > 0 ? `, ${eventCount} event${eventCount > 1 ? 's' : ''}` : ''}`}
                                    aria-selected={isSelected}
                                    aria-current={isToday ? 'date' : undefined}
                                    onclick={() =>
                                        isMobile && handleMobileDayClick(date, eventCount)}
                                    onkeydown={(e) => {
                                        if (e.target !== e.currentTarget) return;
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            if (isMobile) handleMobileDayClick(date, eventCount);
                                        }
                                    }}>
                                    <!-- Day Number -->
                                    <div
                                        class="calendar-day-number font-heading text-xs sm:text-sm font-semibold mb-1"
                                        class:text-primary-400={isToday}>
                                        <span aria-hidden="true">{date.getDate()}</span>
                                        {#if isMobile && eventCount > 0}
                                            <span class="calendar-event-dot" aria-hidden="true"
                                                >{eventCount}</span>
                                        {/if}
                                    </div>

                                    <!-- Events (Desktop only) -->
                                    {#if !isMobile}
                                        <div class="space-y-1">
                                            {#each expanded ? dayEvents : dayEvents.slice(0, MONTH_EVENT_LIMIT) as event, eventIndex (`${date.getTime()}-${eventIndex}`)}
                                                <div
                                                    class="calendar-event text-xs rounded cursor-pointer overflow-hidden"
                                                    title={getEventLabel(event)}
                                                    data-event-data={JSON.stringify(
                                                        event.extendedProps,
                                                    )}
                                                    role="button"
                                                    tabindex="0"
                                                    onclick={stopPropagation((e) =>
                                                        handleEventClick(
                                                            event,
                                                            e.currentTarget as HTMLElement,
                                                        ),
                                                    )}
                                                    onkeydown={(e) => {
                                                        if (e.key === 'Enter' || e.key === ' ') {
                                                            e.preventDefault();
                                                            handleEventClick(
                                                                event,
                                                                e.currentTarget as HTMLElement,
                                                            );
                                                        }
                                                    }}
                                                    use:mountEvent={event}>
                                                    {@render entryContent(event)}
                                                </div>
                                            {/each}
                                            {#if eventCount > MONTH_EVENT_LIMIT}
                                                <button
                                                    type="button"
                                                    class="calendar-more"
                                                    aria-expanded={expanded}
                                                    aria-label={`${dateLabel}: ${expanded ? m.section_show_less() : m.section_show_more()} (${eventCount - MONTH_EVENT_LIMIT})`}
                                                    onclick={stopPropagation(() => {
                                                        expandedDates[date.getTime()] = !expanded;
                                                    })}>
                                                    {expanded
                                                        ? m.section_show_less()
                                                        : `+${eventCount - MONTH_EVENT_LIMIT} · ${m.section_show_more()}`}
                                                </button>
                                            {/if}
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    {/each}
                </div>

                <!-- Mobile: Selected date events -->
                {#if isMobile && selectedMobileDate && selectedDateEvents.length > 0}
                    <div
                        class="calendar-mobile-events mt-4 p-3 bg-surface-800/70 rounded-lg"
                        role="region"
                        aria-label={`Events for ${formatDateShort(selectedMobileDate)}`}
                        transition:fade={{ duration: 150 }}>
                        <div class="text-sm font-semibold mb-3 text-surface-200">
                            {formatDateShort(selectedMobileDate)}
                        </div>
                        <div class="space-y-2">
                            {#each selectedDateEvents as event, eventIndex (eventIndex)}
                                <div
                                    class="calendar-event rounded-lg cursor-pointer hover:opacity-80 overflow-hidden"
                                    data-event-data={JSON.stringify(event.extendedProps)}
                                    role="button"
                                    tabindex="0"
                                    onclick={stopPropagation((e) =>
                                        handleEventClick(event, e.currentTarget as HTMLElement),
                                    )}
                                    onkeydown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            handleEventClick(event, e.currentTarget as HTMLElement);
                                        }
                                    }}
                                    use:mountEvent={event}>
                                    {@render entryContent(event)}
                                </div>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>
        {/key}
    {:else if view === CALENDAR_VIEW.WEEK}
        <!-- Week view - user-selectable compact day-strip or detailed rail-column style -->
        {#key contentKey}
            <div
                class="calendar-week-rail"
                class:calendar-week-rail-detailed={weekStyle === 'detailed'}
                in:fly={{
                    x: transitionDirection === 'right' ? 30 : -30,
                    duration: 200,
                }}
                role="region"
                aria-label={`Week view for ${ariaMonthLabel}`}>
                {#each getWeekRailDates() as { date, isToday }, i (date.getTime())}
                    {@const dayEvents = getEventsForDate(date)}
                    {#if weekStyle === 'compact'}
                        {@const expanded = expandedDates[date.getTime()] ?? false}
                        {@const summary = getDaySummary(dayEvents)}
                        {@const visibleEvents = summary.icons}
                        <div
                            class="calendar-day-card flex flex-col gap-2 p-2"
                            class:calendar-day-card-today={isToday}
                            role="group"
                            aria-label={formatDateFull(date)}
                            aria-current={isToday ? 'date' : undefined}>
                            <!-- Header: weekday (left) + day-of-month (right) -->
                            <div
                                class="calendar-compact-day-header flex items-center justify-between px-0.5">
                                <span
                                    class="font-heading text-xs font-semibold uppercase tracking-wide"
                                    class:text-surface-400={!isToday}
                                    class:text-primary-400={isToday}>{weekDays[i]}</span>
                                <span
                                    class="font-heading font-bold text-sm leading-none"
                                    class:text-surface-200={!isToday}
                                    class:text-primary-400={isToday}>{date.getDate()}</span>
                            </div>

                            <!-- Poster icons expand into readable rows for this day on demand. -->
                            <div
                                class="calendar-day-thumbs"
                                class:calendar-day-thumbs-expanded={expanded}>
                                {#if dayEvents.length === 0}
                                    <div class="calendar-day-thumb-empty" aria-hidden="true">—</div>
                                {:else}
                                    {#each visibleEvents as event, eventIndex (`week-${date.getTime()}-${eventIndex}`)}
                                        {@const thumbUrl = event.imageUrl}
                                        {@const eventLabel = getEventLabel(event)}
                                        {@const subLabel = getEntrySubLabel(event)}
                                        {@const statusKind = getTooltipStatusKind(event)}
                                        <button
                                            type="button"
                                            class="calendar-day-thumb"
                                            style={expanded ? getBackdropStyle(event) : undefined}
                                            data-event-data={JSON.stringify(event.extendedProps)}
                                            aria-expanded={getSeriesEpisodes(event).length > 1
                                                ? tooltipEvent === event
                                                : undefined}
                                            aria-label={subLabel
                                                ? `${eventLabel}: ${subLabel}`
                                                : eventLabel}
                                            aria-haspopup={getSeriesEpisodes(event).length > 1
                                                ? 'dialog'
                                                : undefined}
                                            aria-controls={tooltipEvent === event &&
                                            getSeriesEpisodes(event).length > 1
                                                ? WEEK_TOOLTIP_ID
                                                : undefined}
                                            aria-describedby={tooltipEvent === event &&
                                            getSeriesEpisodes(event).length === 1
                                                ? WEEK_TOOLTIP_ID
                                                : undefined}
                                            onclick={stopPropagation((e) =>
                                                handleEventClick(
                                                    event,
                                                    e.currentTarget as HTMLElement,
                                                ),
                                            )}
                                            onkeydown={(e) => {
                                                if (
                                                    e.key === 'Tab' &&
                                                    !e.shiftKey &&
                                                    tooltipEvent === event &&
                                                    getSeriesEpisodes(event).length > 1
                                                ) {
                                                    e.preventDefault();
                                                    tooltipEl?.querySelector('button')?.focus();
                                                } else if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    handleEventClick(
                                                        event,
                                                        e.currentTarget as HTMLElement,
                                                    );
                                                } else if (e.key === 'Escape') {
                                                    hideTooltip();
                                                }
                                            }}
                                            onmouseenter={(e) =>
                                                scheduleTooltip(
                                                    event,
                                                    e.currentTarget as HTMLElement,
                                                )}
                                            onmouseleave={scheduleTooltipHide}
                                            onfocus={(e) =>
                                                showTooltipNow(
                                                    event,
                                                    e.currentTarget as HTMLElement,
                                                )}
                                            onblur={scheduleTooltipHide}
                                            use:mountEvent={event}>
                                            <span
                                                class="calendar-week-poster"
                                                aria-hidden="true"
                                                style={thumbUrl
                                                    ? `background-image: url('${escapeCssUrl(thumbUrl)}')`
                                                    : undefined}>
                                                {#if !thumbUrl}
                                                    <span class="calendar-day-thumb-fallback"
                                                        >{eventLabel.slice(0, 1)}</span>
                                                {/if}
                                            </span>
                                            {#if !expanded && getSeriesEpisodes(event).length > 1}
                                                <span
                                                    class="absolute bottom-0 right-0 rounded bg-surface-900/90 px-1 text-[10px] font-bold text-surface-100"
                                                    >{getSeriesEpisodes(event).length}</span>
                                            {/if}
                                            {#if expanded}
                                                <span class="calendar-week-copy">
                                                    <span class="calendar-week-title"
                                                        >{eventLabel}</span>
                                                    {#if subLabel}<span
                                                            class="calendar-week-subtitle"
                                                            >{subLabel}</span
                                                        >{/if}
                                                </span>
                                            {/if}
                                            {#if statusKind !== 'on-server'}
                                                <span
                                                    class="calendar-week-status calendar-tooltip-status-dot calendar-tooltip-status-dot-{statusKind}"
                                                    aria-hidden="true"></span>
                                            {/if}
                                        </button>
                                    {/each}
                                {/if}
                            </div>

                            {#if dayEvents.length > 0}
                                <button
                                    type="button"
                                    class="calendar-day-count calendar-more"
                                    aria-expanded={expanded}
                                    aria-label={`${formatDateFull(date)}: ${expanded ? m.section_show_less() : m.section_show_more()}`}
                                    onclick={() => {
                                        hideTooltip();
                                        expandedDates[date.getTime()] = !expanded;
                                    }}>
                                    <span>{summary.label}</span>
                                    <span aria-hidden="true">{expanded ? '−' : '+'}</span>
                                </button>
                            {/if}
                        </div>
                    {:else}
                        <!-- Detailed style: full-height rail column, one full event card per item -->
                        <div
                            class="calendar-rail-col flex flex-col gap-2 p-2"
                            class:calendar-rail-today={isToday}
                            role="group"
                            aria-label={formatDateFull(date)}
                            aria-current={isToday ? 'date' : undefined}>
                            <div
                                class="calendar-week-day-header flex items-baseline gap-1.5 px-1 pb-2">
                                <span
                                    class="font-heading text-xs font-semibold uppercase tracking-wide"
                                    class:text-surface-400={!isToday}
                                    class:text-primary-400={isToday}>{weekDays[i]}</span>
                                <span
                                    class="font-heading font-bold text-lg leading-none"
                                    class:text-primary-400={isToday}>{date.getDate()}</span>
                                {#if isToday}
                                    <span
                                        class="font-heading ml-auto text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary-500 text-surface-900"
                                        >{buttonText.today || m.calendar_today()}</span>
                                {/if}
                            </div>
                            <div class="flex flex-col gap-1.5 min-h-0">
                                {#if dayEvents.length === 0}
                                    <div class="text-center text-surface-500 text-sm py-3">—</div>
                                {:else}
                                    {#each getDaySummary(dayEvents).icons as event, eventIndex (`week-detailed-${date.getTime()}-${eventIndex}`)}
                                        <div
                                            class="calendar-event calendar-backdrop-event rounded-lg cursor-pointer overflow-hidden"
                                            style={getBackdropStyle(event)}
                                            title={getEntrySubLabel(event)}
                                            data-event-data={JSON.stringify(event.extendedProps)}
                                            role="button"
                                            tabindex="0"
                                            onclick={stopPropagation((e) =>
                                                handleEventClick(
                                                    event,
                                                    e.currentTarget as HTMLElement,
                                                ),
                                            )}
                                            onkeydown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    handleEventClick(
                                                        event,
                                                        e.currentTarget as HTMLElement,
                                                    );
                                                }
                                            }}
                                            use:mountEvent={event}>
                                            {@render entryContent(event)}
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        </div>
                    {/if}
                {/each}
            </div>
        {/key}
    {:else}
        <!-- List View - Two columns on large screens -->
        {#key contentKey}
            <div
                class="calendar-list-container grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6"
                in:fly={{
                    x: transitionDirection === 'right' ? 30 : -30,
                    duration: 200,
                }}
                role="region"
                aria-label="Event list">
                <!-- This Week -->
                <section class="calendar-list-week" aria-labelledby="week-0-header">
                    <h3
                        id="week-0-header"
                        class="calendar-week-header text-sm font-semibold text-surface-300 mb-3 pb-2 border-b border-surface-600">
                        {getWeekLabel(0)}
                    </h3>
                    <div class="space-y-4">
                        {#each getEventsForWeek(0) as { date, events: dayEvents } (date.getTime())}
                            <article
                                class="calendar-day"
                                class:calendar-today={date.toDateString() ===
                                    new SvelteDate().toDateString()}>
                                <h4
                                    class="calendar-day-head font-medium text-surface-300 mb-2 pb-2 border-b border-surface-700">
                                    {formatDateHeader(date)}
                                </h4>
                                <ul class="space-y-2" role="list">
                                    {#each dayEvents as event, eventIndex (`week0-${date.getTime()}-${eventIndex}`)}
                                        <li>
                                            {@render listEvent(event)}
                                        </li>
                                    {/each}
                                </ul>
                            </article>
                        {/each}

                        {#if getEventsForWeek(0).length === 0}
                            <p class="text-center text-surface-400 py-8">No events this week</p>
                        {/if}
                    </div>
                </section>

                <!-- Next Week -->
                <section class="calendar-list-week" aria-labelledby="week-1-header">
                    <h3
                        id="week-1-header"
                        class="calendar-week-header text-sm font-semibold text-surface-300 mb-3 pb-2 border-b border-surface-600">
                        {getWeekLabel(1)}
                    </h3>
                    <div class="space-y-4">
                        {#each getEventsForWeek(1) as { date, events: dayEvents } (date.getTime())}
                            <article
                                class="calendar-day"
                                class:calendar-today={date.toDateString() ===
                                    new SvelteDate().toDateString()}>
                                <h4
                                    class="calendar-day-head font-medium text-surface-300 mb-2 pb-2 border-b border-surface-700">
                                    {formatDateHeader(date)}
                                </h4>
                                <ul class="space-y-2" role="list">
                                    {#each dayEvents as event, eventIndex (`week1-${date.getTime()}-${eventIndex}`)}
                                        <li>
                                            {@render listEvent(event)}
                                        </li>
                                    {/each}
                                </ul>
                            </article>
                        {/each}

                        {#if getEventsForWeek(1).length === 0}
                            <p class="text-center text-surface-400 py-8">No events next week</p>
                        {/if}
                    </div>
                </section>
            </div>
        {/key}
    {/if}

    <!-- Shared release preview for every calendar view. -->
    {#if tooltipEvent}
        {@const episodes = getSeriesEpisodes(tooltipEvent)}
        {@const grouped = episodes.length > 1}
        {@const thumbUrl = tooltipEvent.imageUrl}
        {@const label = getEventLabel(tooltipEvent)}
        {@const subLabel = getTooltipSubLabel(tooltipEvent)}
        {@const overview = getTooltipOverview(tooltipEvent)}
        {@const statusKind = getTooltipStatusKind(tooltipEvent)}
        {@const hasTime =
            tooltipEvent.start.getHours() !== 0 || tooltipEvent.start.getMinutes() !== 0}
        <!-- bodyPortal is load-bearing: an ancestor with a transform (the
                 home page's dnd widget wrapper) hijacks position:fixed's
                 containing block, landing viewport coords at the page's
                 top-left. Portaling to <body> keeps fixed truly viewport-
                 relative no matter where the calendar is embedded. -->
        <div
            bind:this={tooltipEl}
            use:bodyPortal
            id={WEEK_TOOLTIP_ID}
            role={grouped || previewPinned ? 'dialog' : 'tooltip'}
            aria-label={grouped
                ? `${label}: ${getEntrySubLabel(tooltipEvent)}`
                : previewPinned
                  ? label
                  : undefined}
            onmouseenter={clearTooltipTimer}
            onmouseleave={scheduleTooltipHide}
            onfocusin={clearTooltipTimer}
            onfocusout={scheduleTooltipHide}
            onkeydown={(e) => {
                if (e.key !== 'Tab') return;
                const buttons = tooltipEl?.querySelectorAll('button');
                const edge = e.shiftKey ? buttons?.[0] : buttons?.[buttons.length - 1];
                if (document.activeElement !== edge) return;
                if (e.shiftKey) e.preventDefault();
                tooltipAnchor?.focus();
                hideTooltip();
            }}
            class:pointer-events-none={!grouped && !previewPinned}
            class="calendar-thumb-tooltip fixed z-50 w-56 overflow-hidden rounded-xl border border-surface-700/60 bg-surface-900/95 shadow-2xl backdrop-blur-md"
            style="left: -9999px; top: 0;">
            <div
                class="calendar-thumb-tooltip-poster relative h-28 w-full bg-surface-800"
                style={thumbUrl ? `background-image: url('${escapeCssUrl(thumbUrl)}')` : undefined}>
                {#if !thumbUrl}
                    <span class="calendar-thumb-tooltip-fallback" aria-hidden="true"
                        >{label.slice(0, 1)}</span>
                {/if}
                <span class="calendar-thumb-tooltip-scrim" aria-hidden="true"></span>
            </div>
            <div class="p-3">
                <div
                    class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-surface-400">
                    {#if !grouped}<span
                            class="calendar-tooltip-status-dot calendar-tooltip-status-dot-{statusKind}"
                            aria-hidden="true"></span
                        >{/if}
                    <span
                        >{formatDateShort(tooltipEvent.start)}{hasTime && !grouped
                            ? ` · ${formatTime(tooltipEvent.start)}`
                            : ''}</span>
                </div>
                <div class="font-heading text-sm font-bold leading-snug text-surface-100 mt-1">
                    {label}
                </div>
                {#if grouped}
                    <div class="text-xs text-surface-300 mt-0.5">
                        {getEntrySubLabel(tooltipEvent)}
                    </div>
                    <div
                        class="calendar-tooltip-episodes mt-2 flex flex-col gap-1 overflow-y-auto overscroll-contain"
                        style="max-height: min(20rem, 40vh)">
                        {#each episodes as episode (episode)}
                            <button
                                type="button"
                                class="rounded-md bg-surface-800/70 p-2 text-left text-xs text-surface-200 hover:bg-surface-700 focus-visible:outline focus-visible:outline-primary-400"
                                onclick={(e) => {
                                    handleEventClick(episode, e.currentTarget, true);
                                    hideTooltip();
                                }}>
                                <span class="flex items-start gap-2">
                                    <span
                                        class="calendar-tooltip-status-dot calendar-tooltip-status-dot-{getTooltipStatusKind(
                                            episode,
                                        )} mt-1 shrink-0"
                                        aria-hidden="true"></span>
                                    <span>{getTooltipSubLabel(episode)}</span>
                                </span>
                                {#if getTooltipOverview(episode)}<span
                                        class="mt-1 block text-surface-400 line-clamp-2"
                                        >{getTooltipOverview(episode)}</span
                                    >{/if}
                            </button>
                        {/each}
                    </div>
                {:else if subLabel}
                    <div class="text-xs text-surface-300 mt-0.5">{subLabel}</div>
                {/if}
                {#if !grouped && overview}
                    <p
                        class="calendar-thumb-tooltip-overview text-xs text-surface-400 mt-2 line-clamp-4">
                        {overview}
                    </p>
                {/if}
                {#if !grouped && previewPinned && canOpenEvent(tooltipEvent.extendedProps)}
                    {@const pinnedEvent = tooltipEvent}
                    <button
                        type="button"
                        class="btn btn-sm variant-filled-primary mt-3 w-full"
                        onclick={() => openEventDetails(pinnedEvent)}>
                        {m.calendar_preview_details()}
                    </button>
                {/if}
            </div>
        </div>
    {/if}

    <!-- Screen reader announcements -->
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {#if loading}
            Loading calendar events...
        {/if}
    </div>
</div>

<style>
    /* Screen reader only utility */
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }

    /* Grid container - 7 equal columns, rows auto-size to content */
    .calendar-days-container {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        grid-auto-rows: minmax(80px, auto);
        gap: 1px;
        background-color: rgb(var(--color-surface-700-rgb) / 0.3);
    }

    /* Mobile: compact grid with fixed height rows */
    .calendar-days-container.calendar-days-mobile {
        grid-auto-rows: minmax(44px, auto);
    }

    /* Semantic ARIA row wrapper: display:contents so the gridcells remain
       direct CSS-grid items and the 7-column layout is preserved exactly */
    .calendar-week-row {
        display: contents;
    }

    /* Ensure day cells don't overflow */
    .calendar-day {
        min-width: 0;
        overflow: hidden;
        background: rgb(var(--color-surface-900-rgb) / 0.65);
        transition:
            background-color 0.15s ease,
            border-color 0.15s ease;
    }

    .calendar-event {
        min-width: 0;
        word-break: break-word;
        transition:
            opacity 0.15s ease,
            transform 0.15s ease;
    }

    .calendar-event:focus {
        outline: 2px solid rgb(var(--color-primary-500-rgb) / 0.5);
        outline-offset: 2px;
    }

    .calendar-day.calendar-today {
        /* Match the week rail's today treatment: indigo primary ring + subtle
           tint + soft glow (inset ring so the 1px grid gap isn't overlapped). */
        background: color-mix(in srgb, var(--color-primary-500) 12%, transparent);
        box-shadow:
            inset 0 0 0 1.5px var(--color-primary-500),
            0 10px 26px -18px var(--color-primary-500);
        border-radius: 8px;
        position: relative;
        z-index: 1;
    }

    .calendar-day.calendar-selected {
        background: rgb(var(--color-primary-500-rgb) / 0.2);
        border: 2px solid rgb(var(--color-primary-500-rgb) / 0.5);
        border-radius: 8px;
    }

    .calendar-day:focus {
        outline: 2px solid rgb(var(--color-primary-500-rgb) / 0.5);
        outline-offset: -2px;
    }

    .calendar-event {
        background-color: rgb(var(--color-surface-700-rgb) / 0.25);
        border-radius: 7px;
    }

    .calendar-event:hover {
        background-color: color-mix(in srgb, var(--color-primary-500) 13%, transparent);
    }

    .calendar-more {
        width: 100%;
        min-height: 32px;
        padding: 5px 8px;
        text-align: left;
        font-size: 11px;
        color: var(--color-primary-300);
        border-radius: 5px;
        cursor: pointer;
    }

    .calendar-more:hover {
        background: rgb(var(--color-primary-500-rgb) / 0.12);
    }

    .calendar-more:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: -2px;
    }

    .calendar-header {
        background-color: rgba(246, 246, 246, 0.05);
        border-radius: 8px;
    }

    .calendar-header button[aria-pressed='true'] {
        background: color-mix(in srgb, var(--color-primary-500) 24%, transparent);
        color: var(--color-primary-200);
        box-shadow: inset 0 -2px 0 var(--color-primary-400);
    }

    .calendar-day-head {
        background-color: rgba(246, 246, 246, 0.03);
    }

    .calendar-day-number {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 3px 5px;
        /* No pill background — the Bricolage number floats over the cell for a
           cleaner look consistent with the week rail's date treatment. */
    }

    /* Event count dot for mobile */
    .calendar-event-dot {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 4px;
        font-size: 10px;
        font-weight: 600;
        background: linear-gradient(135deg, var(--color-primary-500), var(--color-primary-400));
        border-radius: 9px;
        color: white;
    }

    /* Mobile events panel */
    .calendar-mobile-events {
        animation: slideDown 0.2s ease-out;
    }

    @keyframes slideDown {
        from {
            opacity: 0;
            transform: translateY(-8px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    /* Loading skeleton styles */
    .calendar-skeleton .calendar-day-skeleton {
        animation: skeleton-pulse 1.5s ease-in-out infinite;
    }

    .calendar-day-number-skeleton {
        width: 24px;
        height: 20px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 4px;
        animation: skeleton-pulse 1.5s ease-in-out infinite;
    }

    .calendar-event-skeleton {
        height: 40px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        animation: skeleton-pulse 1.5s ease-in-out infinite;
    }

    @keyframes skeleton-pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.5;
        }
    }

    /* Artwork carries the character; copy has a quiet, consistent surface. */
    :global(.calendar-image) {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px;
        min-height: 68px;
    }

    :global(.calendar-poster) {
        flex: 0 0 36px;
        height: 54px;
        border-radius: 4px;
        background-color: rgb(var(--color-surface-700-rgb) / 0.5);
        background-size: cover;
        background-position: center;
    }

    :global(.calendar-content) {
        flex: 1;
        min-width: 0;
        position: relative;
        padding-right: 5px;
        font-size: 12px;
        line-height: 1.4;
        color: var(--color-surface-100);
    }

    :global(.calendar-content > .font-bold) {
        font-weight: 500;
    }

    :global(.calendar-content small) {
        font-size: 11px;
        color: var(--color-surface-300);
    }

    .calendar-list-week {
        min-width: 0;
    }

    /* Week Day Strip: seven equal day-cards on desktop; below the breakpoint
       cards keep a fixed min-width and the row scrolls horizontally instead
       of wrapping, so cards never crush down to unreadable widths. */
    .calendar-week-rail {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 0.5rem;
        align-items: start;
    }

    .calendar-day-card,
    .calendar-rail-col {
        min-width: 0;
        border-radius: 8px;
        border-top: 2px solid transparent;
        background-color: rgb(var(--color-surface-900-rgb) / 0.3);
        transition:
            background-color 0.15s ease,
            box-shadow 0.15s ease;
    }

    .calendar-day-card-today,
    .calendar-rail-today {
        border-top-color: var(--color-primary-400);
        background-color: color-mix(in srgb, var(--color-primary-500) 8%, transparent);
    }

    /* Poster thumbnail row */
    .calendar-day-thumbs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem;
        min-height: 2.25rem;
    }

    .calendar-day-thumb {
        position: relative;
        width: 36px;
        height: 44px;
        flex: 0 0 auto;
        padding: 0;
        border: none;
        border-radius: 6px;
        background-color: rgb(var(--color-surface-700-rgb) / 0.2);
        display: flex;
        align-items: center;
        text-align: left;
        cursor: pointer;
        transition: background-color 0.15s ease;
    }

    .calendar-day-thumb:hover {
        background-color: color-mix(in srgb, var(--color-primary-500) 13%, transparent);
    }

    .calendar-week-poster {
        display: grid;
        place-items: center;
        width: 100%;
        height: 100%;
        border-radius: 3px;
        background: rgb(var(--color-surface-700-rgb) / 0.5) center / cover;
    }

    .calendar-day-thumbs-expanded {
        display: grid;
    }

    .calendar-day-thumbs-expanded .calendar-day-thumb {
        width: 100%;
        height: auto;
        min-height: 88px;
        min-width: 0;
        padding: 12px 9px;
        align-items: flex-end;
        background-size: cover;
        background-position: center;
    }

    .calendar-day-thumbs-expanded .calendar-week-poster {
        display: none;
    }

    .calendar-day-count {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
    }

    .calendar-week-copy {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
        padding-right: 7px;
    }

    .calendar-week-title,
    .calendar-week-subtitle {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        line-height: 1.35;
    }

    .calendar-week-title {
        color: #fff;
        font-size: 12px;
        font-weight: 600;
        white-space: normal;
        overflow-wrap: anywhere;
    }

    .calendar-week-subtitle {
        color: #e2e8f0;
        font-size: 11px;
        white-space: normal;
        overflow-wrap: anywhere;
    }

    .calendar-week-copy {
        text-shadow: 0 1px 3px rgb(0 0 0 / 0.8);
    }

    .calendar-backdrop-event {
        background-color: rgb(var(--color-surface-800-rgb) / 0.8);
        background-size: cover;
        background-position: center;
    }

    .calendar-backdrop-event :global(.calendar-image) {
        min-height: 88px;
        padding: 12px 9px;
        align-items: flex-end;
    }

    .calendar-backdrop-event :global(.calendar-poster) {
        display: none;
    }

    .calendar-backdrop-event :global(.calendar-content) {
        color: #fff;
        text-shadow: 0 1px 3px rgb(0 0 0 / 0.8);
    }

    .calendar-backdrop-event :global(.calendar-content small) {
        color: #e2e8f0;
    }

    .calendar-week-status {
        position: absolute;
        top: 6px;
        right: 5px;
    }

    .calendar-week-day-header {
        border-bottom: 1px solid rgb(var(--color-surface-300-rgb) / 0.12);
    }

    .calendar-rail-col :global(.calendar-content > .font-bold),
    .calendar-rail-col :global(.calendar-content small) {
        white-space: normal;
        overflow-wrap: anywhere;
    }

    .calendar-day-thumb:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 2px;
    }

    .calendar-day-thumb-fallback {
        font-size: 0.75rem;
        font-weight: 700;
        color: rgb(var(--color-surface-300-rgb));
    }

    .calendar-day-thumb-empty {
        color: rgb(var(--color-surface-500-rgb));
        font-size: 0.75rem;
        padding: 0.25rem 0;
    }

    /* Detailed week style: full-height rail columns (recovered pre-day-strip
       layout) — each column stacks full event cards instead of thumbnails. */
    .calendar-rail-col {
        min-width: 0;
    }

    @media (max-width: 1200px) {
        .calendar-week-rail {
            grid-template-columns: none;
            grid-auto-flow: column;
            grid-auto-columns: 180px;
            overflow-x: auto;
            scroll-snap-type: x proximity;
            padding-bottom: 0.5rem;
        }
        .calendar-day-card {
            min-width: 0;
            scroll-snap-align: start;
        }
        /* Detailed columns need much more room per day than compact thumbs do. */
        .calendar-week-rail.calendar-week-rail-detailed {
            grid-auto-columns: 230px;
        }
        .calendar-rail-col {
            scroll-snap-align: start;
        }
    }

    /* Phone portrait layout: seven day rows, with wrapping poster icons. */
    @media (max-width: 640px) {
        .calendar-week-rail,
        .calendar-week-rail.calendar-week-rail-detailed {
            grid-template-columns: minmax(0, 1fr);
            grid-auto-flow: row;
            grid-auto-columns: auto;
            overflow-x: visible;
        }

        .calendar-day-card {
            display: grid;
            grid-template-columns: 40px minmax(0, 1fr);
            align-items: start;
            column-gap: 12px;
        }

        .calendar-compact-day-header {
            flex-direction: column;
            gap: 6px;
            padding-top: 5px;
        }

        .calendar-day-thumbs {
            align-items: center;
            min-height: 44px;
        }

        .calendar-day-count {
            grid-column: 2;
            padding: 0;
            min-height: 28px;
        }
    }

    /* Week thumb hover/focus tooltip (Feature B) */
    .calendar-thumb-tooltip {
        animation: calendarTooltipIn 140ms ease-out;
    }

    .calendar-thumb-tooltip-poster {
        background-size: cover;
        background-position: center;
    }

    .calendar-thumb-tooltip-scrim {
        position: absolute;
        inset-inline: 0;
        bottom: 0;
        height: 3rem;
        background: linear-gradient(to top, rgb(var(--color-surface-900-rgb) / 0.95), transparent);
    }

    .calendar-thumb-tooltip-fallback {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.75rem;
        font-weight: 700;
        color: rgb(var(--color-surface-300-rgb) / 1);
    }

    .calendar-thumb-tooltip-overview {
        display: -webkit-box;
        -webkit-line-clamp: 4;
        line-clamp: 4;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .calendar-tooltip-status-dot {
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: 9999px;
    }

    .calendar-tooltip-status-dot-airing {
        background-color: rgb(var(--color-warning-500-rgb));
    }

    .calendar-tooltip-status-dot-release {
        background-color: rgb(var(--color-primary-500-rgb));
    }

    .calendar-tooltip-status-dot-on-server {
        background-color: rgb(var(--color-success-500-rgb));
    }

    @keyframes calendarTooltipIn {
        from {
            opacity: 0;
            transform: translateY(4px) scale(0.98);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    .calendar-week-header {
        background-color: rgba(255, 255, 255, 0.03);
        padding: 8px 12px;
        border-radius: 6px;
        margin-bottom: 12px;
    }

    .calendar-list-container .calendar-day.calendar-today {
        background: color-mix(in srgb, var(--color-primary-500) 12%, transparent);
        box-shadow:
            inset 0 0 0 1.5px var(--color-primary-500),
            0 10px 26px -18px var(--color-primary-500);
        border-radius: 8px;
        padding: 12px;
    }

    /* List entries keep the existing event markup and indicators, but present
       artwork beside the text instead of underneath it. */
    .calendar-list-container .calendar-day {
        padding: 10px;
        border-radius: 8px;
        background: rgb(var(--color-surface-900-rgb) / 0.4);
    }
    .calendar-list-container .calendar-day-head {
        background: none;
        border: 0;
        padding: 0;
        margin-bottom: 10px;
        font-size: 13px;
        color: var(--color-surface-400);
    }
    .calendar-list-container .calendar-week-header {
        border: 0;
    }
    .calendar-list-event {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 6px;
        border: 0;
        border-radius: 6px;
        text-align: left;
        background: rgb(var(--color-surface-700-rgb) / 0.25);
        cursor: pointer;
        transition: background-color 150ms ease;
    }
    .calendar-list-event:hover {
        background: rgb(var(--color-primary-500-rgb) / 0.15);
    }
    .calendar-list-poster {
        display: grid;
        place-items: center;
        flex: 0 0 36px;
        width: 36px;
        height: 48px;
        border-radius: 5px;
        background-color: rgb(var(--color-surface-700-rgb) / 0.5);
        background-size: cover;
        background-position: center;
        color: var(--color-surface-400);
    }
    .calendar-list-copy {
        flex: 1;
        min-width: 0;
    }
    .calendar-list-copy :global(.calendar-image) {
        background-image: none !important;
        min-height: 0;
        padding: 0;
    }
    .calendar-list-copy :global(.calendar-poster) {
        display: none;
    }
    .calendar-list-copy :global(.calendar-content) {
        text-shadow: none;
        font-size: 13px;
        line-height: 1.4;
        color: var(--color-surface-100);
    }
    .calendar-list-copy :global(.calendar-content > .font-bold) {
        font-weight: 500;
        white-space: normal;
        overflow-wrap: anywhere;
        padding-right: 12px;
    }
    .calendar-list-copy :global(small) {
        font-size: 11px;
        color: var(--color-surface-400);
    }
    .calendar-list-time {
        flex-shrink: 0;
        align-self: flex-start;
        margin-top: 3px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--color-surface-400);
    }

    /* Touch-friendly sizing on mobile */
    @media (max-width: 639px) {
        .calendar-day {
            min-height: 44px;
        }

        .calendar-day-number {
            flex-direction: column;
            gap: 3px;
            padding: 3px 0;
        }

        :global(.calendar-image) {
            min-height: 70px;
            padding: 10px;
        }

        :global(.calendar-content) {
            font-size: 0.875rem;
        }
    }

    /* Reduce motion for users who prefer it */
    @media (prefers-reduced-motion: reduce) {
        .calendar-day,
        .calendar-event,
        .calendar-mobile-events,
        .calendar-thumb-tooltip {
            transition: none;
            animation: none;
        }
    }
</style>
