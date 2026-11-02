<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { LiveTvStation, LiveTvAiring } from '$lib/schemas/livetv';
    import { pickNowNext } from '$lib/shared/livetv-now-next';
    import { progressPercent } from '$lib/components/livetv/simple/simple-lineup';
    import './player-presentation.css';
    import { Z } from '$lib/utils/z-index';
    import { SvelteDate, SvelteSet } from 'svelte/reactivity';

    import { onMount, tick, untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { fade, fly } from 'svelte/transition';
    import { Icon, XMark, ChevronRight, Play, Tv, MagnifyingGlass, Star } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import * as playbackApi from '$lib/api/playback';
    import * as liveTvPlaybackApi from '$lib/api/livetv-playback';
    import { getLiveTvFavorites, setLiveTvFavorite } from '$lib/api/livetv-favorites';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { toasts } from '$lib/stores/toast.store.js';

    interface Props {
        isOpen?: boolean;
        currentChannelId?: string | null;
        onclose?: () => void;
        onselectchannel?: (detail: { channelId: string }) => void;
    }

    let { isOpen = false, currentChannelId = null, onclose, onselectchannel }: Props = $props();

    type Channel = LiveTvStation;

    interface Program {
        id: string;
        title: string;
        description?: string;
        startTime: string;
        endTime: string;
        progressPercent?: number;
        isCurrentlyAiring: boolean;
        genres?: string[];
    }

    let lineup: Channel[] = $state.raw([]);
    let loaded = false;
    let loadedAt = 0;
    let fetching = false;
    let nowMs = $state(Date.now());
    let channels = $derived(
        lineup.map((channel) => ({
            ...channel,
            nowNext: pickNowNext(
                [channel.nowNext.current, channel.nowNext.next].filter((p) => p !== null),
                nowMs,
            ),
        })),
    );
    onMount(() => {
        const clock = setInterval(() => {
            nowMs = Date.now();
        }, 30_000);
        return () => clearInterval(clock);
    });
    let loading = $state(true);
    let error = $state<string | null>(null);
    let favoriteChannelIds = new SvelteSet<string>();

    // Search
    let searchQuery = $state('');
    let searchInput: HTMLInputElement | undefined = $state();

    // Expanded channel for schedule window view
    let expandedChannelId = $state<string | null>(null);
    let expandedAirings = $state<LiveTvAiring[]>([]);
    let expandedChannelPrograms: Program[] = $derived.by(() => {
        const current = pickNowNext(expandedAirings, nowMs).current;
        return expandedAirings.map((airing) => ({
            ...airing,
            isCurrentlyAiring: airing.id === current?.id,
            progressPercent: airing.id === current?.id ? progressPercent(airing, nowMs) : undefined,
        }));
    });
    let loadingPrograms = $state(false);
    let scheduleRequest = 0;
    let hasScrolledToCurrentChannel = $state(false);

    // Normalize once per lineup/clock update, rather than on every keystroke.
    let searchIndex = $derived(
        channels.map((channel) => ({
            channel,
            text: `${channel.name}\n${channel.channelNumber ?? ''}\n${channel.nowNext.current?.title ?? ''}`.toLowerCase(),
        })),
    );
    let query = $derived(searchQuery.trim().toLowerCase());
    let filteredChannels = $derived(
        query
            ? searchIndex
                  .filter((entry) => entry.text.includes(query))
                  .map((entry) => entry.channel)
            : channels,
    );

    let listEl: HTMLDivElement | undefined = $state();
    let scrollTop = $state(0);
    let viewportHeight = $state(800);
    let measuredHeights = $state.raw<Record<string, number>>({});
    // Measurements include the expanded schedule: rows are deliberately not fixed-height.
    let offsets = $derived.by(() => {
        const result = [0];
        for (const channel of filteredChannels) {
            result.push(result[result.length - 1] + (measuredHeights[channel.id] ?? 100));
        }
        return result;
    });
    function indexAt(position: number): number {
        let low = 0;
        let high = filteredChannels.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (offsets[mid + 1] <= position) low = mid + 1;
            else high = mid;
        }
        return low;
    }
    let startIndex = $derived(Math.max(0, indexAt(scrollTop) - 5));
    let endIndex = $derived(
        Math.min(filteredChannels.length, indexAt(scrollTop + viewportHeight) + 6),
    );
    let visibleChannels = $derived(filteredChannels.slice(startIndex, endIndex));

    // Preserve the channel at the viewport's top when estimates above it change.
    function updateHeights(heights: Record<string, number>): void {
        const anchor = indexAt(scrollTop);
        const oldOffset = offsets[anchor];
        measuredHeights = heights;
        const delta = offsets[anchor] - oldOffset;
        if (delta && listEl) {
            scrollTop = Math.max(0, scrollTop + delta);
            listEl.scrollTop = scrollTop;
        }
    }

    function measureRow(node: HTMLElement, id: string): { destroy: () => void } {
        function measure(): void {
            const height = node.getBoundingClientRect().height;
            if (height > 0 && measuredHeights[id] !== height) {
                updateHeights({ ...measuredHeights, [id]: height });
            }
        }
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        measure();
        return {
            destroy: () => {
                observer.disconnect();
                if (node.contains(document.activeElement)) listEl?.focus({ preventScroll: true });
            },
        };
    }

    // Keep every channel reachable by Tab even though offscreen rows are unmounted.
    async function handleListKeydown(event: KeyboardEvent): Promise<void> {
        if (event.key !== 'Tab' || !listEl) return;
        if (event.target === listEl) {
            event.preventDefault();
            listEl.querySelector<HTMLButtonElement>('[data-channel-id] button')?.focus();
            return;
        }
        const buttons = [...listEl.querySelectorAll<HTMLButtonElement>('[data-channel-id] button')];
        const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
        if (event.target !== edge) return;
        const next = event.shiftKey ? startIndex - 1 : endIndex;
        if (next < 0 || next >= filteredChannels.length) return;
        event.preventDefault();
        scrollTop = offsets[next];
        listEl.scrollTop = scrollTop;
        await tick();
        const row = [...listEl.querySelectorAll<HTMLElement>('[data-channel-id]')].find(
            (node) => node.dataset.channelId === filteredChannels[next]?.id,
        );
        const nextButtons = row?.querySelectorAll<HTMLButtonElement>('button');
        const target = event.shiftKey ? nextButtons?.[nextButtons.length - 1] : nextButtons?.[0];
        target?.focus();
    }

    function setSearchQuery(value: string): void {
        searchQuery = value;
        scrollTop = 0;
        if (listEl) listEl.scrollTop = 0;
    }

    // Format time for display (e.g., "20:30")
    function formatTime(isoString: string): string {
        const date = new SvelteDate(isoString);
        return date.toLocaleTimeString(getLocale(), {
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    // Format time range (e.g., "20:30 - 21:15")
    function formatTimeRange(start: string, end: string): string {
        return `${formatTime(start)} - ${formatTime(end)}`;
    }

    // Handle image error - show fallback
    function handleImageError(e: Event) {
        const img = e.target as HTMLImageElement;
        img.style.display = 'none';
        const parent = img.parentElement;
        if (parent) {
            const fallback = parent.querySelector('.logo-fallback') as HTMLElement | null;
            if (fallback) fallback.style.display = 'flex';
        }
    }

    // Fetch channels
    async function fetchChannels() {
        if (!browser || fetching || (loaded && Date.now() - loadedAt < 60_000)) return;
        fetching = true;
        loading = !loaded;
        error = null;

        try {
            const { data, error: channelsError } = await playbackApi.getLiveTvChannels();
            if (!channelsError && data) {
                lineup = data.items || [];
                loaded = true;
                loadedAt = Date.now();
            } else {
                if (!loaded) error = 'Failed to load channels';
            }
        } catch (e) {
            console.error('[ChannelSwitcher] Error fetching channels:', e);
            if (!loaded) error = 'Failed to load channels';
        } finally {
            loading = false;
            fetching = false;
        }
    }

    // Fetch favorite channel ids
    async function fetchFavorites() {
        if (!browser) return;

        try {
            const { data, error: favoritesError } = await getLiveTvFavorites();
            if (!favoritesError && data) {
                favoriteChannelIds.clear();
                for (const id of data.stationIds) {
                    favoriteChannelIds.add(id);
                }
            }
        } catch (e) {
            console.error('[ChannelSwitcher] Error fetching favorites:', e);
        }
    }

    // Toggle favorite state for a channel (optimistic, reverts on failure)
    async function toggleFavorite(channel: Channel) {
        const wasFavorite = favoriteChannelIds.has(channel.id);
        if (wasFavorite) {
            favoriteChannelIds.delete(channel.id);
        } else {
            favoriteChannelIds.add(channel.id);
        }

        const { error: toggleError } = await setLiveTvFavorite(channel.id, !wasFavorite);
        if (toggleError) {
            if (wasFavorite) {
                favoriteChannelIds.add(channel.id);
            } else {
                favoriteChannelIds.delete(channel.id);
            }
            toasts.error(toggleError);
        }
    }

    // Fetch the recent and upcoming programs for a channel
    async function fetchWindowPrograms(channelId: string) {
        if (!browser) return;

        const request = ++scheduleRequest;
        loadingPrograms = true;
        expandedAirings = [];

        try {
            const now = Date.now();
            const { data, error } = await liveTvPlaybackApi.getChannelPrograms(
                channelId,
                new Date(now - 30 * 60_000).toISOString(),
                new Date(now + 12 * 3600_000).toISOString(),
            );
            if (request !== scheduleRequest || expandedChannelId !== channelId) return;
            if (!error && data) {
                expandedAirings = data.airings;
                nowMs = Date.now();
                // Scroll to current program after render
                await tick();
                scrollToCurrentProgram();
            }
        } catch (e) {
            console.error('[ChannelSwitcher] Error fetching programs:', e);
        } finally {
            if (request === scheduleRequest) loadingPrograms = false;
        }
    }

    // Scroll to the currently airing program in the expanded view
    function scrollToCurrentProgram() {
        const request = scheduleRequest;
        setTimeout(() => {
            if (!isOpen || request !== scheduleRequest) return;
            const currentProgramEl = listEl?.querySelector('.program-current');
            if (currentProgramEl) {
                currentProgramEl.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center',
                });
            }
        }, 100);
    }

    // Toggle expanded channel
    function toggleExpandChannel(channelId: string) {
        // An offscreen expanded row cannot report its collapsed height.
        const heights = { ...measuredHeights };
        if (expandedChannelId) delete heights[expandedChannelId];
        delete heights[channelId];
        updateHeights(heights);
        if (expandedChannelId === channelId) {
            expandedChannelId = null;
            scheduleRequest++;
            expandedAirings = [];
        } else {
            expandedChannelId = channelId;
            fetchWindowPrograms(channelId);
        }
    }

    // Handle channel selection (watch now)
    function handleSelectChannel(channelId: string) {
        if (channelId !== currentChannelId) {
            onselectchannel?.({ channelId });
        }
        onclose?.();
    }

    // Close the switcher
    function close() {
        onclose?.();
    }

    // Handle escape key
    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            event.stopImmediatePropagation(); // Prevent VideoPlayer from also handling this ESC
            close();
        }
    }

    // Scroll to current channel when opened
    function scrollToCurrentChannel(): void {
        const index = filteredChannels.findIndex((channel) => channel.id === currentChannelId);
        if (index < 0) return;
        scrollTop = Math.max(0, offsets[index] - viewportHeight / 2 + 50);
        if (listEl) listEl.scrollTop = scrollTop;
    }

    // Handle drawer open/close
    function onDrawerOpen() {
        void fetchChannels();
        fetchFavorites();
        expandedChannelId = null;
        scheduleRequest++;
        expandedAirings = [];
        measuredHeights = {};
        setSearchQuery('');
        hasScrolledToCurrentChannel = false;
        // Focus search input after drawer opens
        tick().then(() => {
            if (searchInput) searchInput.focus();
        });
    }

    // Track previous isOpen state to detect changes
    let wasOpen = $state(false);
    $effect(() => {
        if (browser && isOpen && !wasOpen) {
            wasOpen = true;
            untrack(onDrawerOpen);
        } else if (!isOpen && wasOpen) {
            wasOpen = false;
        }
    });

    // Scroll to current channel when channels first load (only once per open)
    $effect(() => {
        if (
            isOpen &&
            listEl &&
            !loading &&
            channels.length > 0 &&
            currentChannelId &&
            !hasScrolledToCurrentChannel &&
            !searchQuery
        ) {
            hasScrolledToCurrentChannel = true;
            untrack(scrollToCurrentChannel);
        }
    });

    onMount(() => {
        // Use capture phase to intercept ESC before VideoPlayer handles it
        window.addEventListener('keydown', handleKeydown, true);
        return () => window.removeEventListener('keydown', handleKeydown, true);
    });
</script>

{#if isOpen}
    <!-- Backdrop -->
    <button
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.PLAYER_SIDEBAR};"
        transition:fade={{ duration: 200 }}
        onclick={close}
        aria-label="Close channel switcher"></button>

    <!-- Drawer -->
    <div
        class="player-drawer fixed right-0 top-0 bottom-0 w-[420px] max-w-[90vw] flex flex-col"
        style="z-index: {Z.PLAYER_SIDEBAR_CONTENT};"
        transition:fly={{ x: 420, duration: 300 }}>
        <!-- Header -->
        <div class="player-drawer-header">
            <div class="flex items-center gap-3">
                <Icon src={Tv} class="w-5 h-5 text-primary-400" />
                <h2 class="text-lg font-semibold">{m.player_channels()}</h2>
            </div>
            <button
                class="p-2 hover:bg-surface-700 rounded-lg transition-colors"
                onclick={close}
                aria-label="Close">
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </div>

        <!-- Search -->
        <div class="p-3 border-b border-surface-700">
            <div class="relative">
                <Icon
                    src={MagnifyingGlass}
                    class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400" />
                <input
                    bind:this={searchInput}
                    bind:value={() => searchQuery, setSearchQuery}
                    type="text"
                    placeholder={m.player_search_channel()}
                    class="w-full pl-9 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-white placeholder-surface-400 focus:outline-hidden focus:border-primary-500 transition-colors" />
                {#if searchQuery}
                    <button
                        class="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-surface-700 rounded transition-colors"
                        onclick={() => {
                            setSearchQuery('');
                            searchInput?.focus();
                        }}
                        aria-label="Clear search">
                        <Icon src={XMark} class="w-4 h-4 text-surface-400" />
                    </button>
                {/if}
            </div>
            {#if searchQuery && filteredChannels.length !== channels.length}
                <div class="text-xs text-surface-500 mt-2">
                    {m.player_channels_of({
                        filtered: filteredChannels.length,
                        total: channels.length,
                    })}
                </div>
            {/if}
        </div>

        <!-- Channel List -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
            class="flex-1 min-h-0 overflow-y-auto channel-list"
            bind:this={listEl}
            tabindex="-1"
            role="list"
            aria-label={m.player_channels()}
            bind:clientHeight={viewportHeight}
            onscroll={() => {
                scrollTop = listEl?.scrollTop ?? 0;
            }}
            onkeydown={handleListKeydown}>
            {#if loading}
                <div class="center p-8">
                    <span class="loading-spinner loading-spinner-lg loading-spinner-primary"></span>
                </div>
            {:else if error}
                <div class="center-col p-8 text-surface-400">
                    <span>{error}</span>
                    <button
                        class="mt-2 px-4 py-2 bg-surface-700 hover:bg-surface-600 rounded-lg transition-colors"
                        onclick={fetchChannels}>
                        Retry
                    </button>
                </div>
            {:else if channels.length === 0}
                <div class="text-center text-surface-400 p-8">
                    {m.player_no_channels()}
                </div>
            {:else if filteredChannels.length === 0}
                <div class="text-center text-surface-400 p-8">
                    <p>{m.player_no_channels_for({ query: searchQuery })}</p>
                    <button
                        class="mt-2 text-sm text-primary-400 hover:text-primary-300"
                        onclick={() => {
                            setSearchQuery('');
                        }}>
                        {m.player_reset_filter()}
                    </button>
                </div>
            {:else}
                <div aria-hidden="true" style:height={`${offsets[startIndex]}px`}></div>
                {#each visibleChannels as channel, visibleIndex (channel.id)}
                    {@const isCurrentChannel = channel.id === currentChannelId}
                    {@const isExpanded = expandedChannelId === channel.id}
                    {@const isFavorite = favoriteChannelIds.has(channel.id)}

                    <div
                        use:measureRow={channel.id}
                        data-channel-id={channel.id}
                        role="listitem"
                        aria-setsize={filteredChannels.length}
                        aria-posinset={startIndex + visibleIndex + 1}
                        class="border-b border-surface-800 {isCurrentChannel
                            ? 'channel-current'
                            : ''}">
                        <!-- Channel Row -->
                        <div
                            class="group flex items-center gap-3 p-3 {isCurrentChannel
                                ? 'bg-primary-500/10'
                                : ''}">
                            <!-- Channel Logo -->
                            <div class="channel-logo shrink-0 w-14 h-10 relative">
                                {#if channel.images?.primary?.href}
                                    <img
                                        src={channel.images?.primary?.href}
                                        alt={channel.name}
                                        class="w-full h-full object-contain"
                                        onerror={handleImageError} />
                                {/if}
                                <div
                                    class="logo-fallback absolute inset-0 bg-surface-700 rounded center text-surface-400 font-bold text-xs"
                                    style:display={channel.images?.primary?.href ? 'none' : 'flex'}>
                                    {channel.channelNumber || channel.name.charAt(0)}
                                </div>
                            </div>

                            <!-- Channel Info -->
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2">
                                    {#if channel.channelNumber}
                                        <span class="text-xs text-surface-500"
                                            >{channel.channelNumber}</span>
                                    {/if}
                                    <span class="font-medium truncate">{channel.name}</span>
                                    {#if isCurrentChannel}
                                        <span
                                            class="flex items-center gap-1 text-xs text-primary-400 font-semibold">
                                            <span
                                                class="w-2 h-2 bg-primary-500 rounded-full animate-pulse"
                                            ></span>
                                            {m.livetv_live_now()}
                                        </span>
                                    {/if}
                                </div>

                                <!-- Current Program -->
                                {#if channel.nowNext.current}
                                    <div class="mt-1">
                                        <div class="text-sm text-surface-300 truncate">
                                            {channel.nowNext.current.title}
                                        </div>
                                        <div class="flex items-center gap-2 mt-0.5">
                                            <span class="text-xs text-surface-500">
                                                {formatTime(channel.nowNext.current.startTime)}
                                            </span>
                                            <div
                                                class="flex-1 h-1 bg-surface-700 rounded-full overflow-hidden max-w-[100px]">
                                                <div
                                                    class="h-full bg-primary-500 transition-all"
                                                    style="width: {progressPercent(
                                                        channel.nowNext.current,
                                                        nowMs,
                                                    )}%">
                                                </div>
                                            </div>
                                            <span class="text-xs text-surface-500">
                                                {formatTime(channel.nowNext.current.endTime)}
                                            </span>
                                        </div>
                                    </div>
                                {:else}
                                    <div class="text-sm text-surface-500 italic mt-1">
                                        {m.player_no_program()}
                                    </div>
                                {/if}
                            </div>

                            <!-- Action Buttons -->
                            <div class="flex items-center gap-1 shrink-0">
                                <!-- Favorite Toggle -->
                                <Tooltip
                                    text={isFavorite
                                        ? m.livetv_favorite_remove({ name: channel.name })
                                        : m.livetv_favorite_add({ name: channel.name })}
                                    position="left"
                                    fixed>
                                    <button
                                        type="button"
                                        class="p-2 rounded-lg transition-colors {isFavorite
                                            ? 'text-yellow-400'
                                            : 'text-surface-300 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-yellow-400'}"
                                        onclick={stopPropagation(() => toggleFavorite(channel))}
                                        aria-pressed={isFavorite}
                                        aria-label={isFavorite
                                            ? m.livetv_favorite_remove({ name: channel.name })
                                            : m.livetv_favorite_add({ name: channel.name })}>
                                        <Icon src={Star} solid={isFavorite} class="w-4 h-4" />
                                    </button>
                                </Tooltip>

                                <!-- Play Button -->
                                <Tooltip
                                    text={isCurrentChannel
                                        ? m.player_currently_playing()
                                        : m.player_watch_now()}
                                    position="left"
                                    fixed>
                                    <button
                                        class="p-2 rounded-lg transition-colors {isCurrentChannel
                                            ? 'bg-primary-500 text-white'
                                            : 'bg-surface-700 hover:bg-surface-600 text-surface-300 hover:text-white'}"
                                        onclick={() => handleSelectChannel(channel.id)}>
                                        <Icon src={Play} class="w-4 h-4" solid={isCurrentChannel} />
                                    </button>
                                </Tooltip>

                                <!-- Expand Button -->
                                <Tooltip text={m.player_show_program()} position="left" fixed>
                                    <button
                                        class="p-2 rounded-lg bg-surface-700 hover:bg-surface-600 text-surface-300 hover:text-white transition-colors"
                                        onclick={() => toggleExpandChannel(channel.id)}>
                                        <Icon
                                            src={ChevronRight}
                                            class="w-4 h-4 transition-transform {isExpanded
                                                ? 'rotate-90'
                                                : ''}" />
                                    </button>
                                </Tooltip>
                            </div>
                        </div>

                        <!-- Expanded Day Program -->
                        {#if isExpanded}
                            <div
                                class="bg-surface-800/50 border-t border-surface-700"
                                transition:fly={{ y: -10, duration: 200 }}>
                                {#if loadingPrograms}
                                    <div class="center p-4">
                                        <span class="loading-spinner loading-spinner-primary"
                                        ></span>
                                    </div>
                                {:else if expandedChannelPrograms.length === 0}
                                    <div class="text-center text-surface-500 p-4 text-sm">
                                        {m.player_no_program_info()}
                                    </div>
                                {:else}
                                    <div class="max-h-[300px] overflow-y-auto program-list">
                                        {#each expandedChannelPrograms as program (program.id)}
                                            <div
                                                class="flex gap-3 p-3 border-b border-surface-700/50 last:border-b-0
                                                       {program.isCurrentlyAiring
                                                    ? 'bg-primary-500/5 program-current'
                                                    : ''}">
                                                <!-- Time -->
                                                <div class="shrink-0 w-24 text-right">
                                                    <div
                                                        class="text-sm font-medium {program.isCurrentlyAiring
                                                            ? 'text-primary-400'
                                                            : 'text-surface-300'}">
                                                        {formatTime(program.startTime)}
                                                    </div>
                                                    <div class="text-xs text-surface-500">
                                                        - {formatTime(program.endTime)}
                                                    </div>
                                                </div>

                                                <!-- Program Info -->
                                                <div class="flex-1 min-w-0">
                                                    <div class="flex items-center gap-2">
                                                        <span
                                                            class="font-medium {program.isCurrentlyAiring
                                                                ? 'text-primary-400'
                                                                : 'text-white'}">
                                                            {program.title}
                                                        </span>
                                                        {#if program.isCurrentlyAiring}
                                                            <span
                                                                class="text-[10px] px-1.5 py-0.5 bg-primary-500 text-white rounded font-semibold">
                                                                {m.player_now_badge()}
                                                            </span>
                                                        {/if}
                                                    </div>
                                                    {#if program.description && program.description.trim() !== program.title.trim()}
                                                        <div
                                                            class="text-xs text-surface-400 mt-1 line-clamp-2">
                                                            {program.description}
                                                        </div>
                                                    {/if}
                                                    {#if program.genres && program.genres.length > 0}
                                                        <div class="flex flex-wrap gap-1 mt-1">
                                                            {#each program.genres.slice(0, 3) as genre, genreIdx (genre + '-' + genreIdx)}
                                                                <span
                                                                    class="text-[10px] px-1.5 py-0.5 bg-surface-700 text-surface-400 rounded">
                                                                    {genre}
                                                                </span>
                                                            {/each}
                                                        </div>
                                                    {/if}
                                                    {#if program.isCurrentlyAiring && program.progressPercent !== undefined}
                                                        <div
                                                            class="mt-2 h-1 bg-surface-700 rounded-full overflow-hidden">
                                                            <div
                                                                class="h-full bg-primary-500"
                                                                style="width: {program.progressPercent}%">
                                                            </div>
                                                        </div>
                                                    {/if}
                                                </div>
                                            </div>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                        {/if}
                    </div>
                {/each}
                <div
                    aria-hidden="true"
                    style:height={`${offsets[offsets.length - 1] - offsets[endIndex]}px`}>
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    .channel-list {
        overflow-anchor: none;
    }

    .channel-list::-webkit-scrollbar,
    .program-list::-webkit-scrollbar {
        width: 4px;
    }

    .channel-list::-webkit-scrollbar-track,
    .program-list::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);
        border-radius: 2px;
    }

    .channel-list::-webkit-scrollbar-thumb,
    .program-list::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
    }

    .channel-list::-webkit-scrollbar-thumb:hover,
    .program-list::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.5);
    }

    .channel-logo img {
        filter: brightness(0.9);
    }
</style>
