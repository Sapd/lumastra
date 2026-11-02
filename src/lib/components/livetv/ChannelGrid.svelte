<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import { goto, replaceState } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { page } from '$app/state';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import type { LiveTvStation, LiveTvCategory } from '$lib/schemas/livetv.js';
    import * as m from '$lib/paraglide/messages.js';
    import { filterChannels } from '$lib/shared/livetv-transforms.js';
    import {
        groupNumberedFamilies,
        isChannelFamily,
        type ChannelFamily,
    } from '$lib/shared/livetv-channel-groups.js';
    import {
        getStreamInfoWithLimitCheck,
        handoffPlaybackSession,
        leaveChannel,
    } from '$lib/api/livetv-playback.js';
    import { getLiveTvChannels } from '$lib/api/playback.js';
    import { createProgramRefreshController } from '$lib/components/browse/channel-view.js';
    import { modals } from '$lib/stores/modal.store.js';
    import { saveReturnPath } from '$lib/stores/playerNavigation.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import ChannelCard from './ChannelCard.svelte';
    import ChannelSearchBar from './ChannelSearchBar.svelte';
    import StreamLimitMessage from './StreamLimitMessage.svelte';
    import StreamFailureModal from './StreamFailureModal.svelte';
    import ChannelFamilyModal from './ChannelFamilyModal.svelte';
    import { getAvailabilityContext } from '$lib/shared/livetv-availability-context.js';
    import TableOfContents from '$lib/components/TableOfContents.svelte';
    import { getLiveTvQualityPreference } from '$lib/components/player/livetv-quality-preference.js';
    import { deriveIsAdmin } from '$lib/utils/permissions';
    import { liveTvFailurePresentation } from '$lib/components/player/livetv-failure-presentation.js';
    import FeedMenu from './FeedMenu.svelte';
    import { clearPreferredFeed, getPreferredFeed, setPreferredFeed } from './feed-preference.js';
    import type { LiveTvFeed } from '$lib/schemas/livetv.js';

    interface Props {
        channels: LiveTvStation[];
        categories: LiveTvCategory[];
        showSearchBar?: boolean;
        favoriteChannelIds?: Set<string> | ReadonlySet<string>;
        onToggleFavorite?: (channel: LiveTvStation) => void;
        /** The administrator lets viewers pick another feed of a station (LIVETV_VIEWER_FEED_CHOICE). */
        feedChoice?: boolean;
    }

    let {
        channels,
        categories,
        showSearchBar = true,
        favoriteChannelIds,
        onToggleFavorite,
        feedChoice = false,
    }: Props = $props();

    // The feed menu (right-click / long-press on a card of a multi-feed station).
    let feedMenu = $state<{ channel: LiveTvStation; x: number; y: number } | null>(null);

    function openFeeds(channel: LiveTvStation, x: number, y: number): void {
        feedMenu = { channel, x, y };
    }

    /** Cards get the feed menu only where there is a choice to offer. */
    function feedsHandler(
        channel: LiveTvStation,
    ): ((channel: LiveTvStation, x: number, y: number) => void) | undefined {
        return feedChoice && channel.id ? openFeeds : undefined;
    }

    function pickFeed(
        channel: LiveTvStation,
        feed: LiveTvFeed,
        stationId: string | undefined,
    ): void {
        feedMenu = null;
        setPreferredFeed(stationId ?? channel.id, feed.id, feed.isDefault);
        void handleChannelClick(channel, feed.id);
    }

    interface ChannelGroup {
        id: string;
        name: string;
        channels: LiveTvStation[];
    }

    let searchQuery: string = $state(page.url.searchParams.get('q') ?? '');
    let retryInFlight = $state(false);
    let favoritesOnly = $state(false);

    // Local, refreshable copy of the SSR-provided channels. The `nowNext`
    // (now-playing) data is only accurate at page-load time, so we periodically
    // reassign this (see the refresh controller below) to update it. A writable
    // $derived: it tracks the prop (re-seeding on navigation) yet tolerates the
    // in-place override until the prop next changes.
    let liveChannels = $derived(channels);

    let now = $state(Date.now());
    // Tick drives per-card progress/remaining-time recomputation. Gated behind
    // document.hidden so a backgrounded tab doesn't recompute derived state.
    $effect(() => {
        const id = setInterval(() => {
            if (!document.hidden) now = Date.now();
        }, 60_000);
        return () => clearInterval(id);
    });

    /**
     * Refresh now-playing data. Fetches the current channel list and merges the
     * fresh `nowNext` into the existing channels by id — preserving the
     * SSR channel set, order, and categorization (only the airing program
     * changes). Skipped while the tab is hidden.
     */
    let refreshingNowPlaying = false;
    async function refreshNowPlaying(): Promise<void> {
        // In-flight guard so an interval tick and a visibility-triggered refresh
        // can't resolve out of order and overwrite fresh data with stale.
        if (document.hidden || refreshingNowPlaying) return;
        refreshingNowPlaying = true;
        try {
            const result = await getLiveTvChannels();
            if (result.error || !result.data?.items) return;

            const programById: Record<string, LiveTvStation['nowNext']> = {};
            for (const ch of result.data.items) programById[ch.id] = ch.nowNext;

            liveChannels = liveChannels.map((ch) =>
                Object.hasOwn(programById, ch.id) ? { ...ch, nowNext: programById[ch.id] } : ch,
            );
        } finally {
            refreshingNowPlaying = false;
        }
    }

    $effect(() => {
        const controller = createProgramRefreshController(refreshNowPlaying);
        controller.start();

        // Refresh immediately when the tab becomes visible again (mirrors
        // LiveTvWidget) so stale now-playing data corrects on return.
        function onVisibilityChange(): void {
            if (!document.hidden) void refreshNowPlaying();
        }
        document.addEventListener('visibilitychange', onVisibilityChange);

        return () => {
            controller.stop();
            document.removeEventListener('visibilitychange', onVisibilityChange);
        };
    });

    // Build sorted groups from categories + channels
    let channelGroups = $derived.by((): ChannelGroup[] => {
        if (categories.length === 0) return [];

        const sortedCats = [...categories].sort((a, b) => a.sortOrder - b.sortOrder);
        const groups: ChannelGroup[] = [];

        // One pass over the channels, not one filter per category: a large
        // provider has ~300 categories and 11k+ channels.
        const byCategory: Record<string, LiveTvStation[]> = {};
        for (const ch of liveChannels) {
            (byCategory[ch.categoryId ?? ''] ??= []).push(ch);
        }

        for (const cat of sortedCats) {
            const catChannels = (byCategory[cat.id] ?? []).sort(
                (a, b) => a.sortOrder - b.sortOrder,
            );
            if (catChannels.length > 0) {
                groups.push({
                    id: cat.id,
                    name: cat.name,
                    channels: catChannels,
                });
            }
        }

        // Uncategorized channels (no categoryId)
        const knownCategoryIds = new Set(categories.map((category) => category.id));
        const uncategorized = liveChannels
            .filter((ch) => !ch.categoryId || !knownCategoryIds.has(ch.categoryId))
            .sort((a, b) => a.sortOrder - b.sortOrder);
        if (uncategorized.length > 0) {
            groups.push({
                id: 'uncategorized',
                name: m.viewer_livetv_other(),
                channels: uncategorized,
            });
        }

        return groups;
    });

    // Flat sorted list for Jellyfin (no categories) or search mode
    let flatChannels = $derived([...liveChannels].sort((a, b) => a.sortOrder - b.sortOrder));

    // Search-filtered channels
    let filteredChannels = $derived(
        (searchQuery ? filterChannels(flatChannels, searchQuery) : flatChannels).filter(
            (channel) => !favoritesOnly || favoriteChannelIds?.has(channel.id),
        ),
    );

    // TOC items for category quick jump
    let tocItems = $derived(
        channelGroups.map((g) => ({
            id: g.id,
            name: g.name,
            imageUrl:
                g.channels.find((ch) => ch.images?.primary?.href)?.images?.primary?.href ??
                undefined,
        })),
    );

    let hasGroups = $derived(channelGroups.length > 0 && !searchQuery && !favoritesOnly);

    // Per-category numbered-family grouping (e.g. "ZAVO EVENT 1"..."ZAVO EVENT 30")
    // collapsed behind a single group card. Disabled entirely while searching —
    // search results stay flat.
    let groupedItemsByCategory = $derived(
        new Map<string, Array<LiveTvStation | ChannelFamily>>(
            channelGroups.map((group) => [group.id, groupNumberedFamilies(group.channels).items]),
        ),
    );

    // Logo URLs that 404'd (`fallback=none`): the family card shows the monogram
    // instead of a broken-image glyph, same as ChannelCard.
    const failedFamilyLogos = new SvelteSet<string>();

    // Render budget. A large provider lists 11k+ channels in ~300 categories:
    // rendering every card put 100k DOM nodes and ~20 MB of HTML on the page.
    // A category renders its cards once it scrolls near the viewport (the first
    // few at once, also on the server), SECTION_PREVIEW of them, then FLAT_PAGE
    // more per click, as flat lists do: one "General" category can hold
    // thousands of channels.
    const SECTION_PREVIEW = 24;
    const EAGER_SECTIONS = 4;
    const FLAT_PAGE = 120;
    const revealedSections = new SvelteSet<string>();
    const sectionLimits = new SvelteMap<string, number>();
    let flatLimit = $state(FLAT_PAGE);

    // A new search, filter or channel set (another genre) starts at the first page again.
    $effect(() => {
        void searchQuery;
        void favoritesOnly;
        void channels;
        flatLimit = FLAT_PAGE;
        sectionLimits.clear();
    });

    function reveal(node: HTMLElement, id: string): { destroy: () => void } | undefined {
        if (revealedSections.has(id)) return;
        if (typeof IntersectionObserver === 'undefined') {
            revealedSections.add(id);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    revealedSections.add(id);
                    observer.disconnect();
                }
            },
            { rootMargin: '800px 0px' },
        );
        observer.observe(node);
        return { destroy: () => observer.disconnect() };
    }

    /**
     * Rows a not-yet-rendered section will take at 1/2/3/4 columns (the grid's
     * breakpoints), so its placeholder is about as tall as the cards will be and
     * scroll positions and TOC jumps stay put when it renders.
     */
    function placeholderRows(count: number): string {
        const n = Math.min(count, SECTION_PREVIEW);
        return [1, 2, 3, 4].map((cols) => `--rows-${cols}: ${Math.ceil(n / cols)}`).join('; ');
    }

    // Read at init: the family dialog renders outside this component's context.
    const getAvailability = getAvailabilityContext();

    // A numbered family ("StreamTV Live Event 1..10") opens as a dialog; it used
    // to expand inline and push every card below it down the page.
    function openFamily(family: ChannelFamily): void {
        modals.open(
            ChannelFamilyModal,
            {
                label: family.label,
                channels: family.channels,
                now,
                favoriteChannelIds,
                onToggleFavorite,
                getAvailability,
                onPick: (channel: LiveTvStation) => {
                    void modals.close();
                    void handleChannelClick(channel);
                },
                onClose: () => void modals.close(),
            },
            { closeOnBackdrop: true, closeOnEscape: true },
        );
    }

    function updateUrlSearchParam(query: string): void {
        const url = new URL(page.url);
        if (query) {
            url.searchParams.set('q', query);
        } else {
            url.searchParams.delete('q');
        }
        replaceState(url.pathname + url.search, {});
    }

    function handleSearchQuery(query: string): void {
        searchQuery = query;
        updateUrlSearchParam(query);
    }

    function gotoWatch(channelId: string): void {
        saveReturnPath();
        goto(resolve(`/watch/${channelId}`));
    }

    /**
     * Open a station: `feedId` when the viewer just picked one, else the feed
     * they picked last time on this device, else the card's (the default) feed.
     */
    let startGeneration = 0;
    onDestroy(() => {
        startGeneration++;
    });

    async function handleChannelClick(channel: LiveTvStation, feedId?: string): Promise<void> {
        const generation = ++startGeneration;
        const remembered = feedChoice ? getPreferredFeed(channel.id) : undefined;
        const targetId = channel.id;
        const selectedFeed = feedId ?? remembered;
        const result = await getStreamInfoWithLimitCheck(
            targetId,
            getLiveTvQualityPreference(),
            undefined,
            selectedFeed,
        );

        if (generation !== startGeneration) {
            if (result.ok) void leaveChannel(result.streamInfo.playbackSessionId);
            return;
        }
        if (result.ok) {
            handoffPlaybackSession(result.streamInfo);
            gotoWatch(targetId);
            return;
        }

        // A remembered feed the server no longer offers (removed, its category
        // hidden, feed choice turned off: 404) is forgotten and the default plays
        // instead. Other failures keep the choice and surface as usual.
        if (!feedId && remembered !== undefined && 'error' in result && result.status === 404) {
            clearPreferredFeed(channel.id);
            return handleChannelClick(channel);
        }

        if ('kicked' in result) {
            toasts.warning(m.livetv_stream_kicked_message());
            return;
        }

        if ('streamLimit' in result) {
            openStreamLimitModal(targetId, result.streamLimit);
            return;
        }

        if ('failure' in result) {
            const failure = result.failure;
            const index = channels.findIndex((c) => c.id === channel.id);
            const another =
                channels.length > 1 ? channels[(index + 1) % channels.length] : undefined;
            modals.open(
                StreamFailureModal,
                {
                    channelName: channel.name,
                    failure,
                    isAdmin: deriveIsAdmin(page.data),
                    onRetry: () => {
                        modals.close();
                        handleChannelClick(channel, selectedFeed);
                    },
                    onAnotherChannel:
                        another && another.id !== channel.id
                            ? () => {
                                  modals.close();
                                  void handleChannelClick(another);
                              }
                            : undefined,
                    onClose: () => {
                        modals.close();
                    },
                },
                { closeOnBackdrop: true, closeOnEscape: true },
            );
            return;
        }

        // Other error — navigate anyway, let the watch page handle it
        gotoWatch(targetId);
    }

    function openStreamLimitModal(
        channelId: string,
        streamLimit: {
            limit: number;
            active: Array<{
                channelId: string;
                channelName: string;
                viewers: number;
            }>;
            showActiveStreams: boolean;
        },
    ): void {
        modals.open(
            StreamLimitMessage,
            {
                limit: streamLimit.limit,
                activeChannels: streamLimit.active,
                showActiveStreams: streamLimit.showActiveStreams,
                onJoinChannel: (joinChannelId: string) => {
                    modals.close();
                    // The server reports active streams by feed; the watch route takes a station.
                    gotoWatch(
                        channels.find((c) => c.feedId === joinChannelId)?.id ?? joinChannelId,
                    );
                },
                onRetry: async () => {
                    if (retryInFlight) return;
                    retryInFlight = true;
                    modals.close();
                    try {
                        const retryResult = await getStreamInfoWithLimitCheck(
                            channelId,
                            getLiveTvQualityPreference(),
                        );
                        if (retryResult.ok) {
                            handoffPlaybackSession(retryResult.streamInfo);
                            gotoWatch(channelId);
                        } else if ('streamLimit' in retryResult) {
                            openStreamLimitModal(channelId, retryResult.streamLimit);
                        } else if ('failure' in retryResult) {
                            // The channel itself does not play: do not open it.
                            toasts.error(
                                liveTvFailurePresentation(retryResult.failure.code, {
                                    simple: false,
                                    isAdmin: false,
                                    retryable: retryResult.failure.retryable,
                                }).message,
                            );
                        } else {
                            gotoWatch(channelId);
                        }
                    } catch (e) {
                        console.warn('[ChannelGrid] Stream retry failed', e);
                        gotoWatch(channelId);
                    } finally {
                        retryInFlight = false;
                    }
                },
                onClose: () => {
                    modals.close();
                },
            },
            { closeOnBackdrop: true, closeOnEscape: true },
        );
    }
</script>

<div class="mx-auto max-w-7xl space-y-4 p-4">
    {#if showSearchBar}
        <ChannelSearchBar bind:value={searchQuery} onquery={handleSearchQuery} />
    {/if}
    {#if favoriteChannelIds}
        <div
            class="flex flex-wrap items-center gap-2"
            role="group"
            aria-label={m.viewer_livetv_channel_filter()}>
            <button
                type="button"
                aria-pressed={!favoritesOnly}
                class="min-h-10 rounded-lg px-4 text-sm {!favoritesOnly
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-800 text-surface-300'}"
                onclick={() => (favoritesOnly = false)}>{m.livetv_all_channels()}</button>
            <button
                type="button"
                aria-pressed={favoritesOnly}
                class="min-h-10 rounded-lg px-4 text-sm {favoritesOnly
                    ? 'bg-primary-600 text-white'
                    : 'bg-surface-800 text-surface-300'}"
                onclick={() => (favoritesOnly = true)}>{m.viewer_livetv_favorites()}</button>
        </div>
    {/if}

    {#if searchQuery || favoritesOnly}
        <!-- Flat search results -->
        {#if filteredChannels.length === 0}
            <div class="flex items-center justify-center py-12">
                <p class="text-surface-400">
                    {favoritesOnly && !searchQuery
                        ? m.viewer_livetv_no_favorites()
                        : m.livetv_no_search_results({ query: searchQuery })}
                </p>
            </div>
        {:else}
            <p class="text-sm text-surface-400">
                {m.livetv_channels_count({ count: filteredChannels.length })}
            </p>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {#each filteredChannels.slice(0, flatLimit) as channel (channel.id)}
                    <ChannelCard
                        {channel}
                        {now}
                        onclick={handleChannelClick}
                        favorite={favoriteChannelIds?.has(channel.id)}
                        {onToggleFavorite}
                        onOpenFeeds={feedsHandler(channel)} />
                {/each}
            </div>
            {#if filteredChannels.length > flatLimit}
                <button
                    type="button"
                    class="mx-auto block min-h-10 rounded-lg bg-surface-800 px-4 text-sm text-surface-200 hover:bg-surface-700"
                    onclick={() => (flatLimit += FLAT_PAGE)}>{m.livetv_show_more()}</button>
            {/if}
        {/if}
    {:else if hasGroups}
        <!-- Grouped by category -->
        {#each channelGroups as group, groupIndex (group.id)}
            {@const rendered = groupIndex < EAGER_SECTIONS || revealedSections.has(group.id)}
            {@const items = groupedItemsByCategory.get(group.id) ?? []}
            {@const limit = sectionLimits.get(group.id) ?? SECTION_PREVIEW}
            {@const shownItems = items.slice(0, limit)}
            <section data-toc-id={group.id} use:reveal={group.id}>
                <h2
                    class="mb-3 text-sm font-semibold uppercase tracking-wide text-surface-400 border-b border-surface-700/50 pb-2">
                    {group.name}
                    <span class="ml-2 text-surface-600 font-normal normal-case"
                        >{group.channels.length}</span>
                </h2>
                {#if !rendered}
                    <div
                        class="section-placeholder rounded-lg bg-surface-800/30"
                        style={placeholderRows(items.length)}
                        aria-hidden="true">
                    </div>
                {:else}
                    <div
                        class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {#each shownItems as item (isChannelFamily(item) ? `family-${group.id}-${item.key}` : item.id)}
                            {#if isChannelFamily(item)}
                                {@const familyLogo = item.channels[0]?.images?.primary?.href}
                                <button
                                    type="button"
                                    class="group flex w-full items-center gap-3 rounded-lg bg-surface-800 p-3 text-left transition-all
                                    hover:bg-surface-700 hover:shadow-lg active:scale-[0.98]"
                                    onclick={() => openFamily(item)}
                                    aria-haspopup="dialog"
                                    aria-label={item.label}>
                                    <div class="relative shrink-0">
                                        {#if familyLogo && !failedFamilyLogos.has(familyLogo)}
                                            <img
                                                src={familyLogo}
                                                alt={item.label}
                                                class="h-12 w-12 rounded-md object-contain bg-surface-900"
                                                loading="lazy"
                                                onerror={() => failedFamilyLogos.add(familyLogo)} />
                                        {:else}
                                            <div
                                                class="flex h-12 w-12 items-center justify-center rounded-md text-lg font-bold text-white bg-surface-600">
                                                {item.label.charAt(0).toUpperCase()}
                                            </div>
                                        {/if}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <span class="truncate font-medium text-surface-100 block"
                                            >{item.label}</span>
                                        <span class="text-sm text-surface-400">
                                            {m.livetv_channels_count({
                                                count: item.channels.length,
                                            })}
                                        </span>
                                    </div>
                                    <span class="shrink-0 text-xs font-medium text-primary-400">
                                        {m.livetv_group_expand({ count: item.channels.length })}
                                    </span>
                                </button>
                            {:else}
                                <ChannelCard
                                    channel={item}
                                    {now}
                                    onclick={handleChannelClick}
                                    favorite={favoriteChannelIds?.has(item.id)}
                                    {onToggleFavorite}
                                    onOpenFeeds={feedsHandler(item)} />
                            {/if}
                        {/each}
                    </div>
                    {#if items.length > limit}
                        <button
                            type="button"
                            class="mt-3 min-h-10 rounded-lg bg-surface-800 px-4 text-sm text-surface-200 hover:bg-surface-700"
                            onclick={() => sectionLimits.set(group.id, limit + FLAT_PAGE)}
                            >{items.length - limit <= FLAT_PAGE
                                ? m.livetv_group_expand({ count: group.channels.length })
                                : m.livetv_show_more()}</button>
                    {/if}
                {/if}
            </section>
        {/each}
    {:else}
        <!-- Flat list (Jellyfin or no categories) -->
        {#if flatChannels.length === 0}
            <div class="flex items-center justify-center py-12">
                <p class="text-surface-400">{m.livetv_no_channels()}</p>
            </div>
        {:else}
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {#each flatChannels.slice(0, flatLimit) as channel (channel.id)}
                    <ChannelCard
                        {channel}
                        {now}
                        onclick={handleChannelClick}
                        favorite={favoriteChannelIds?.has(channel.id)}
                        {onToggleFavorite}
                        onOpenFeeds={feedsHandler(channel)} />
                {/each}
            </div>
            {#if flatChannels.length > flatLimit}
                <button
                    type="button"
                    class="mx-auto block min-h-10 rounded-lg bg-surface-800 px-4 text-sm text-surface-200 hover:bg-surface-700"
                    onclick={() => (flatLimit += FLAT_PAGE)}>{m.livetv_show_more()}</button>
            {/if}
        {/if}
    {/if}
</div>

<!-- TOC quick jump: only show when grouped and > 2 categories -->
{#if hasGroups && tocItems.length > 2}
    <TableOfContents items={tocItems} />
{/if}

{#if feedMenu}
    {@const menuChannel = feedMenu.channel}
    <FeedMenu
        channelId={menuChannel.id}
        name={menuChannel.name}
        currentId={getPreferredFeed(menuChannel.id)}
        x={feedMenu.x}
        y={feedMenu.y}
        onpick={(feed, groupId) => pickFeed(menuChannel, feed, groupId)}
        onclose={() => (feedMenu = null)} />
{/if}

<style>
    /* One card row is ~80px plus the 12px gap; columns follow the grid classes. */
    .section-placeholder {
        height: calc(var(--rows-1) * 92px);
    }
    @media (min-width: 640px) {
        .section-placeholder {
            height: calc(var(--rows-2) * 92px);
        }
    }
    @media (min-width: 1024px) {
        .section-placeholder {
            height: calc(var(--rows-3) * 92px);
        }
    }
    @media (min-width: 1280px) {
        .section-placeholder {
            height: calc(var(--rows-4) * 92px);
        }
    }
</style>
