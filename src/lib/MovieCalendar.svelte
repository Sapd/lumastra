<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { mediaPreviewToUniversal } from '$lib/utils/media-preview';
    import { SvelteDate } from 'svelte/reactivity';
    import CustomCalendar from '$lib/components/calendar/CustomCalendar.svelte';
    import type {
        CalendarEvent,
        EventSource,
    } from '$lib/components/calendar/CustomCalendar.svelte';
    import { env } from '$env/dynamic/public';
    import { openMediaModal, confirmDialog } from '$lib/utils/modal-utils';
    import { Icon, EyeSlash, XMark, Bell } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import * as contentApi from '$lib/api/content';
    import { followSeries } from '$lib/api/notifications';
    import { computePosition, flip, shift, offset } from '@floating-ui/dom';
    import { tick } from 'svelte';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { isMovie } from '$lib/shared/media-types';
    import {
        calendarContextActions,
        calendarMuteIdentity,
        type MuteIdentity,
    } from '$lib/utils/calendar-mute';
    import { escapeHtml } from '$lib/utils/assistant-utils';
    import {
        calendarEventImageUrl,
        calendarModalImageUrl,
        type CalendarImageSource,
    } from '$lib/utils/calendar-image';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /**
         * Both variants render the same full CustomCalendar (with its own
         * month/week/list toolbar) — 'agenda' merely STARTS in the compact
         * one-row week view (used by the home-page embed), while 'full'
         * (default) starts in the month grid. The viewer can switch views
         * freely in either variant.
         */
        variant?: 'full' | 'agenda';
    }

    let { variant = 'full' }: Props = $props();

    // Excluded series management
    interface ExcludedSeries {
        /** Flag row id, the handle for unmuting. */
        id: string;
        seriesName: string;
        excludedAt: string;
    }

    let showExcludedManager = $state(false);
    let excludedSeries: ExcludedSeries[] = $state([]);
    let loadingExcluded = $state(false);

    // Calendar reference for refetching
    let calendarRef = $state<CustomCalendar | null>(null);

    /**
     * Initial CustomCalendar view — the home embed (variant='agenda') starts
     * in the compact week row; CustomCalendar's own toolbar updates this via
     * bind:view when the viewer switches to month/list.
     */
    let calendarView = $state<'dayGridMonth' | 'week' | 'listWeek'>('dayGridMonth');
    $effect(() => {
        if (variant === 'agenda') calendarView = 'week';
    });

    // Context menu state
    let contextMenu = $state<ContextMenuState | null>(null);
    let contextMenuEl = $state<HTMLDivElement | null>(null);

    async function loadExcludedSeries() {
        loadingExcluded = true;
        try {
            const { data } = await contentApi.getExcludedSeries();
            if (data) {
                excludedSeries = (data.items || []) as ExcludedSeries[];
            }
        } catch (error) {
            console.error('Failed to load excluded series:', error);
        } finally {
            loadingExcluded = false;
        }
    }

    /**
     * Mute a series or movie on the calendar. The server keys the mute by the
     * catalog id when the entry has one, else by its TMDB id (see
     * `calendarMuteIdentity`); the name is the label.
     */
    async function excludeSeries(seriesName: string, item: CalendarItem, identity: MuteIdentity) {
        const movieItem = isMovie(item.type);
        try {
            const { error } = await contentApi.excludeSeries({ seriesName, ...identity });

            if (!error) {
                toasts.success(
                    movieItem ? m.upcoming_movie_excluded() : m.upcoming_series_excluded(),
                    3000,
                );
                // Refresh the calendar to remove the excluded series
                if (calendarRef) {
                    (calendarRef as { refetchEvents: () => void }).refetchEvents();
                }
                // Refresh excluded list if manager is open
                if (showExcludedManager) {
                    await loadExcludedSeries();
                }
            } else {
                // A denied or unknown id answers 404; say so instead of
                // leaving the title on the calendar without a word.
                toasts.error(m.toast_hide_failed());
            }
        } catch (error) {
            console.error('Failed to exclude series:', error);
            toasts.error(m.toast_hide_failed());
        }
    }

    async function unexcludeSeries(id: string) {
        try {
            const { error } = await contentApi.unexcludeSeries(id);

            if (!error) {
                excludedSeries = excludedSeries.filter((s) => s.id !== id);
                // Refresh the calendar to show the unexcluded series
                if (calendarRef) {
                    (calendarRef as { refetchEvents: () => void }).refetchEvents();
                }
            } else {
                toasts.error(m.toast_restore_failed());
            }
        } catch (error) {
            console.error('Failed to unexclude series:', error);
            toasts.error(m.toast_restore_failed());
        }
    }

    async function promptExcludeSeries(media: CalendarItem) {
        const movieItem = isMovie(media.type);
        const name = media.context?.series?.title || media.title;
        if (!name) return;
        const identity = calendarMuteIdentity(media, movieItem);
        if (!identity) return;

        try {
            await confirmDialog({
                title: movieItem ? m.upcoming_exclude_movie() : m.upcoming_exclude_series(),
                body: movieItem
                    ? m.upcoming_exclude_movie_title({ movieName: name })
                    : m.upcoming_exclude_series_title({ seriesName: name }),
                confirmText: m.upcoming_exclude_series_confirm(),
                cancelText: m.upcoming_exclude_series_cancel(),
            });
            await excludeSeries(name, media, identity); // L10: await the async call
        } catch {
            // User cancelled
        }
    }

    function toggleExcludedManager() {
        showExcludedManager = !showExcludedManager;
        if (showExcludedManager) {
            // M10: always reload on open so the list is never stale from a
            // previous session; the old guard (length === 0) missed updates
            // made while the panel was closed.
            void loadExcludedSeries();
        } else {
            // Clear on close so the next open always shows a fresh fetch
            // rather than instantly flashing stale data before the load.
            excludedSeries = [];
        }
    }

    async function handleCalendarContextMenu(event: MouseEvent) {
        // Find the closest event element with our data
        const target = event.target as HTMLElement;
        const eventEl = target.closest('[data-event-data]') as HTMLElement;

        if (eventEl?.dataset.eventData) {
            try {
                const item = JSON.parse(eventEl.dataset.eventData) as CalendarItem;
                // An entry with no action (no usable id) opens no menu rather
                // than a header-only one; the browser's own menu stays.
                const actions = calendarContextActions(item, isMovie(item.type));
                if (!actions.mute && !actions.follow) return;
                event.preventDefault();
                event.stopPropagation();
                // Initialize position at mouse location (will be refined by floating-ui)
                contextMenu = {
                    item,
                    position: { x: event.clientX, y: event.clientY },
                };

                // Wait for the menu to render, then refine position with floating-ui
                await tick();
                if (contextMenuEl && contextMenu) {
                    // Create a virtual element at the mouse position
                    const virtualEl = {
                        getBoundingClientRect() {
                            return {
                                width: 0,
                                height: 0,
                                x: event.clientX,
                                y: event.clientY,
                                top: event.clientY,
                                left: event.clientX,
                                right: event.clientX,
                                bottom: event.clientY,
                            };
                        },
                    };

                    const { x, y } = await computePosition(virtualEl, contextMenuEl, {
                        strategy: 'fixed',
                        placement: 'bottom-start',
                        middleware: [
                            offset(4),
                            flip({
                                fallbackPlacements: ['top-start', 'bottom-end', 'top-end'],
                            }),
                            shift({ padding: 8 }),
                        ],
                    });

                    // Re-check after await — user may have closed the menu during positioning
                    if (contextMenu) {
                        contextMenu = { ...contextMenu, position: { x, y } };
                    }
                }
            } catch (error) {
                console.error('Failed to parse event data:', error);
            }
        }
    }

    function closeContextMenu() {
        contextMenu = null;
        contextMenuEl = null;
    }

    function handleExcludeFromContext() {
        if (contextMenu) {
            const item = contextMenu.item;
            const name = item.context?.series?.title || item.title;
            const identity = calendarMuteIdentity(item, isMovie(item.type));
            if (name && identity) {
                void excludeSeries(name, item, identity); // L10: void the floating promise
            }
            closeContextMenu();
        }
    }

    async function followSeriesFromContext(): Promise<void> {
        const seriesId = contextMenu?.item.context?.series?.catalogId;
        const title = contextMenu?.item.context?.series?.title;
        if (!seriesId || !title) return;
        const { error } = await followSeries(seriesId);
        if (error) {
            toasts.error(m.series_notifications_follow_failed());
        } else {
            toasts.success(m.series_notifications_followed({ title }));
        }
        closeContextMenu();
    }

    interface ContextMenuState {
        item: CalendarItem;
        position: { x: number; y: number };
    }

    /**
     * Extends CalendarImageSource so the identifier fields the image policy
     * reads — `seriesMediaId` (a `media_items` UUID) and `sourceSeriesId` (the
     * genuine numeric Sonarr id) — are inherited rather than restated here.
     * They cannot silently drift out of this component's view of an item.
     *
     * The wire also carries `seriesMediaId` under the legacy name
     * `sonarrSeriesId`. That name is a misnomer — it is not a Sonarr id — so
     * this client deliberately does not declare or read it.
     */
    type CalendarItem = CalendarImageSource;

    // Calendar event sources
    const eventSources: EventSource[] = [
        {
            events: async function (fetchInfo: {
                start: Date;
                end: Date;
            }): Promise<CalendarEvent[]> {
                return (await fetchCalendar(fetchInfo.start, fetchInfo.end)) as CalendarEvent[];
            },
        },
    ];

    // L11: wire button labels to i18n messages instead of hardcoded German strings
    const buttonText = {
        today: m.calendar_today(),
        dayGridMonth: m.calendar_month(),
        week: m.calendar_week(),
        listWeek: m.calendar_list(),
    };

    // Monitored (arr-only) entries have no catalog UUID — there is nothing to
    // open a detail/playback modal for. Leave them as informational cards.
    // A Sonarr/Radarr-only row opens only when its series is in the catalog
    // (the server matched it by TMDB/TVDB id and sent the series UUID).
    function isOpenable(extendedProps: Record<string, unknown>): boolean {
        return typeof extendedProps.id === 'string';
    }

    // Handle calendar event click
    function handleEventClick(detail: { event: { extendedProps: Record<string, unknown> } }) {
        if (!isOpenable(detail.event.extendedProps)) return;
        openDescription(detail.event.extendedProps as unknown as CalendarItem);
    }

    // Handle event mount (for context menu data)
    function handleEventDidMount(detail: {
        event: { extendedProps: Record<string, unknown> };
        el: HTMLElement;
    }) {
        detail.el.dataset.eventData = JSON.stringify(detail.event.extendedProps);
    }

    /**
     * Handle clicking an event to open the details modal
     */
    async function openDescription(media: CalendarItem) {
        // Determine correct image source. Policy (including the Season-0 case)
        // lives in $lib/utils/calendar-image so it can be unit-tested.
        const image = calendarModalImageUrl(media);

        openMediaModal(
            {
                externalIds: mediaPreviewToUniversal(media).externalIds,
                mediaType: media.type,
                title: media.title,
                overview: media.overview,
                seriesInternalId: media.context?.series?.id,
                seriesName: media.context?.series?.title,
                seasonNumber: media.context?.seasonNumber,
                episodeNumber: media.context?.episodeNumber,
                isAvailable: media.availability?.isAvailable ?? false,
                canRequest: media.availability?.canRequest ?? false,
            },
            image,
        );
    }

    /** Injected into event HTML to indicate a file that was not downloaded in time */
    const MISSING_FILE_ICON_SVG = `<svg class="inline w-4 h-4 mr-1 text-slate-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" /></svg>`;

    /**
     * Helper to build the HTML string for a calendar event
     */
    function buildEventHtml(item: CalendarItem, date: Date, imgUrl: string, label: string): string {
        // M5: use != null so Season 0 (specials) are not treated as falsy
        const episodeLabel =
            item.context?.seasonNumber === 0
                ? m.calendar_special_episode({
                      episode: String(item.context?.episodeNumber ?? '?'),
                  })
                : `S${item.context?.seasonNumber}E${item.context?.episodeNumber}`;
        const episodeInfo =
            item.context?.seasonNumber != null
                ? `<small class="inline truncate">${escapeHtml(episodeLabel)}${item.context?.absoluteNumber ? ` (${escapeHtml(String(item.context?.absoluteNumber))})` : ''} - ${escapeHtml(item.title ?? '')}</small>`
                : '';

        const releaseLabel =
            item.context?.seasonNumber == null ? `<small>${escapeHtml(label)}</small>` : '';
        const missingIcon = !item.hasFile && date < new SvelteDate() ? MISSING_FILE_ICON_SVG : '';

        // Status dot (explained by the legend beneath the calendar). No dot at
        // all means "on the server / playable now" — that's the expected
        // state for a personal library, so it stays unmarked and the dot only
        // flags something that needs attention:
        //   amber  = episode airing / upcoming (not on server)
        //   violet = movie release (not on server)
        const statusDot = item.availability?.isAvailable
            ? ''
            : `<span class="calendar-status-dot calendar-status-dot-${item.context?.seasonNumber == null ? 'release' : 'airing'}" aria-hidden="true"></span>`;

        // Defense-in-depth: imgUrl lands in two nested contexts — the HTML
        // style="" attribute and the CSS url() token. Quote it as a CSS string
        // and backslash-escape the chars that could terminate the string or the
        // url() (so neither layer can be broken out of, even if the underlying
        // *arr IDs ever stop being plain integers).
        const cssUrl = `url('${imgUrl.replace(/[\\']/g, '\\$&').replace(/[\n\r\f]/g, ' ')}')`;

        return `
            <div class="calendar-image">
                <span class="calendar-poster" aria-hidden="true" style="background-image: ${escapeHtml(cssUrl)}"></span>
                ${statusDot}
                <div class="calendar-content">
                    <div class="font-bold truncate" title="${escapeHtml(item.context?.series?.title || item.title || '')}">${escapeHtml(item.context?.series?.title || item.title || '')}</div>
                    ${releaseLabel}
                    <div class="flex justify-between items-center mt-1" title="${escapeHtml(item.title ?? '')}">
                        ${episodeInfo}
                        ${missingIcon}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Fetch calendar data and transform into event objects
     */
    async function fetchCalendar(start: Date, end: Date) {
        try {
            const { data, error: apiError } = await contentApi.getCalendar(
                start.toISOString(),
                end.toISOString(),
            );
            if (apiError) throw new Error(apiError);

            // New contract: {items, page} — items are typed CalendarItem objects.
            const calendarData = data?.items ?? [];

            // Transform API data into Calendar Events
            return calendarData.flatMap((item) => {
                const events: Array<{
                    start: Date;
                    end: Date;
                    resourceId: number;
                    extendedProps: Record<string, unknown>;
                    allDay: boolean;
                    titleHTML: string;
                    imageUrl: string;
                    backdropUrl: string;
                }> = [];

                const imgUrl = calendarEventImageUrl(item);

                // Helper to push specific release type events
                const addEvent = (dateStr: string | undefined, releaseLabel: string) => {
                    if (!dateStr) return;
                    const dateObj = new SvelteDate(dateStr);

                    // N6: spread a fresh copy per event so each event's
                    // extendedProps is independent (shared reference would
                    // cause all release-type events for one movie to point at
                    // the same object, making the last write win).
                    events.push({
                        start: dateObj,
                        end: dateObj,
                        resourceId: 1,
                        extendedProps: {
                            ...(item as unknown as Record<string, unknown>),
                            releaseLabel,
                        },
                        allDay: false,
                        imageUrl: imgUrl,
                        backdropUrl: calendarEventImageUrl(item, 'backdrop'),
                        titleHTML: buildEventHtml(item, dateObj, imgUrl, releaseLabel),
                    });
                };

                addEvent(item.context?.airDate, 'Air Date');

                return events;
            });
        } catch (error) {
            console.error('Failed to fetch calendar:', error);
            // M9: rethrow so CustomCalendar's fetchEvents() can catch and
            // surface an error state instead of silently returning [].
            throw error;
        }
    }
</script>

<div class="container mx-auto mt-6">
    <div class="card variant-soft p-4 shadow-xl">
        <!-- Header with excluded series manager toggle -->
        <div class="flex justify-between items-center mb-4">
            <h2 class="text-xl font-bold">
                {m.calendar()}
            </h2>
            <button
                class="btn btn-sm variant-ghost-surface flex items-center gap-2"
                onclick={toggleExcludedManager}
                title={m.upcoming_manage_excluded()}>
                <Icon src={EyeSlash} class="w-5 h-5" />
                <span class="hidden sm:inline">{m.upcoming_manage_excluded()}</span>
            </button>
        </div>

        <!-- Excluded series manager panel -->
        {#if showExcludedManager}
            <div class="mb-4 p-4 bg-surface-700/50 rounded-lg">
                <div class="flex justify-between items-center mb-3">
                    <h3 class="font-semibold">{m.upcoming_excluded_items()}</h3>
                    <button
                        class="btn btn-sm variant-ghost"
                        onclick={() => (showExcludedManager = false)}>
                        <Icon src={XMark} class="w-5 h-5" />
                    </button>
                </div>

                {#if loadingExcluded}
                    <div class="text-center py-4">
                        <span class="loading loading-spinner loading-sm"></span>
                    </div>
                {:else if excludedSeries.length === 0}
                    <p class="text-surface-400 text-sm">
                        {m.upcoming_no_excluded_series()}
                    </p>
                {:else}
                    <div class="space-y-2 max-h-48 overflow-y-auto">
                        {#each excludedSeries as series (series.id)}
                            <div
                                class="flex justify-between items-center p-2 bg-surface-600/50 rounded">
                                <span class="truncate">{series.seriesName}</span>
                                <button
                                    class="btn btn-xs variant-ghost-success"
                                    onclick={() => unexcludeSeries(series.id)}>
                                    {m.upcoming_unexclude()}
                                </button>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>
        {/if}

        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div oncontextmenu={handleCalendarContextMenu}>
            <CustomCalendar
                {eventSources}
                {buttonText}
                contextMenuOpen={contextMenu !== null}
                locale={getLocale()}
                firstDay={1}
                bind:view={calendarView}
                bind:this={calendarRef}
                onEventClick={handleEventClick}
                canOpenEvent={isOpenable}
                onEventDidMount={handleEventDidMount} />
        </div>

        <!-- Status-dot legend -->
        <div class="calendar-legend" role="list" aria-label={m.calendar_legend_label()}>
            <span class="calendar-legend-item" role="listitem">
                {m.calendar_status_on_server()}
            </span>
            <span class="calendar-legend-item" role="listitem">
                <span class="calendar-legend-swatch calendar-status-dot-airing"></span>
                {m.calendar_status_airing()}
            </span>
            <span class="calendar-legend-item" role="listitem">
                <span class="calendar-legend-swatch calendar-status-dot-release"></span>
                {m.calendar_status_release()}
            </span>
        </div>
    </div>
</div>

<!-- Context menu for excluding series (L9: role="menu" + Escape) -->
{#if contextMenu}
    <div
        bind:this={contextMenuEl}
        use:bodyPortal
        class="fixed z-50 bg-surface-800 rounded-lg shadow-xl border border-surface-600 py-1 min-w-48"
        style="left: {contextMenu.position.x}px; top: {contextMenu.position.y}px;"
        role="menu"
        tabindex="-1"
        aria-label={contextMenu.item.context?.series?.title ||
            contextMenu.item.title ||
            m.calendar()}
        onkeydown={(e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu()}>
        <div
            class="px-3 py-2 text-sm text-surface-300 border-b border-surface-600 truncate max-w-64"
            role="presentation">
            {contextMenu.item.context?.series?.title || contextMenu.item.title}
        </div>
        {#if calendarMuteIdentity(contextMenu.item, isMovie(contextMenu.item.type))}
            <button
                class="w-full px-3 py-2 text-left text-sm hover:bg-surface-700 flex items-center gap-2"
                role="menuitem"
                aria-label={isMovie(contextMenu.item.type)
                    ? m.upcoming_exclude_movie()
                    : m.upcoming_exclude_series()}
                onclick={handleExcludeFromContext}>
                <Icon src={EyeSlash} class="w-4 h-4" aria-hidden="true" />
                {isMovie(contextMenu.item.type)
                    ? m.upcoming_exclude_movie()
                    : m.upcoming_exclude_series()}
            </button>
        {/if}
        {#if calendarContextActions(contextMenu.item, isMovie(contextMenu.item.type)).follow}
            <button
                class="w-full px-3 py-2 text-left text-sm hover:bg-surface-700 flex items-center gap-2"
                role="menuitem"
                onclick={followSeriesFromContext}>
                <Icon src={Bell} class="w-4 h-4" aria-hidden="true" />
                {m.series_notifications_follow()}
            </button>
        {/if}
    </div>
{/if}

<!-- Close context menu when clicking outside -->
<svelte:window
    onclick={(e: MouseEvent) => {
        if (e.button === 0 && e.target instanceof Node && !contextMenuEl?.contains(e.target)) {
            closeContextMenu();
        }
    }}
    onkeydown={(e: KeyboardEvent) => e.key === 'Escape' && closeContextMenu()} />

<style>
    /* Status dot on each event card (injected via {@html}); explained by the
       legend below the calendar. The dark ring keeps it legible on any backdrop. */
    :global(.calendar-status-dot) {
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 11;
        width: 8px;
        height: 8px;
        border-radius: 9999px;
        box-shadow:
            0 0 0 2px rgba(9, 11, 22, 0.4),
            0 1px 2px rgba(0, 0, 0, 0.4);
    }
    :global(.calendar-status-dot-airing) {
        background: rgba(251, 191, 36, 0.75);
    }
    :global(.calendar-status-dot-release) {
        background: rgba(196, 181, 253, 0.75);
    }

    /* Legend */
    .calendar-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem 1.1rem;
        margin-top: 0.85rem;
        padding-top: 0.75rem;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        font-size: 0.78rem;
        color: var(--color-surface-300, #9eabcc);
    }
    .calendar-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
    }
    .calendar-legend-swatch {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 9999px;
        flex: none;
    }
</style>
