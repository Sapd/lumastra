<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteDate } from 'svelte/reactivity';

    import { onMount, onDestroy, untrack } from 'svelte';
    import { playerStore } from './playerStore.svelte';
    import { getLocale } from '$lib/paraglide/runtime';
    import { liveTvLogoUrl } from './livetv-logo-url';
    import * as liveTvPlaybackApi from '$lib/api/livetv-playback';
    import * as m from '$lib/paraglide/messages.js';

    import { pickNowNext } from '$lib/shared/livetv-now-next';
    import type { LiveTvAiring } from '$lib/schemas/livetv';

    // Program info from API
    let airings = $state<LiveTvAiring[]>([]);
    let nowMs = $state(Date.now());
    let selected = $derived(pickNowNext(airings, nowMs));
    let currentProgram = $derived(selected.current);
    let nextProgram = $derived(selected.next);

    // Live-calculated values (updated every second)
    let liveProgressPercent = $state(0);
    let liveTimeRemaining = $state('');

    let loading = $state(false);
    let refreshInterval: ReturnType<typeof setInterval> | null = null;
    let progressInterval: ReturnType<typeof setInterval> | null = null;
    let lastFetchedChannelId = $state<string | null>(null);
    let programEndFetchPending = false; // Prevent rapid fetches when program ends

    // Get channel ID from playback info
    // The schedule is keyed by station (the watch URL's id); the logo by the shown feed's media item.
    let channelId = $derived(playerStore.liveTvStationId);
    let logoItemId = $derived(playerStore.itemId);
    let channelName = $derived(playerStore.title);
    let controlsVisible = $derived(playerStore.showControls);

    // Build channel logo URL (using catalog image proxy, same as channel grid)
    let channelLogoUrl = $derived(logoItemId ? liveTvLogoUrl(logoItemId) : null);

    // Format time for display (e.g., "20:30")
    function formatTime(isoString: string): string {
        const date = new SvelteDate(isoString);
        return date.toLocaleTimeString(getLocale(), {
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    // Calculate progress and time remaining client-side (runs every second when visible)
    function updateLiveProgress() {
        const displayedCurrent = currentProgram;
        nowMs = Date.now();
        const lastEnd = Math.max(...airings.map((airing) => Date.parse(airing.endTime)));
        const needsRefresh =
            (displayedCurrent && nowMs >= Date.parse(displayedCurrent.endTime)) ||
            (!selected.current && (airings.length === 0 || lastEnd <= nowMs + 5 * 60_000));
        if (needsRefresh && !programEndFetchPending && !loading) {
            programEndFetchPending = true;
            void fetchProgramInfo(true);
        }
        if (!currentProgram) return;

        const now = Date.now();
        const start = new SvelteDate(currentProgram.startTime).getTime();
        const end = new SvelteDate(currentProgram.endTime).getTime();
        const duration = end - start;

        if (duration <= 0) return;

        // Calculate progress percentage
        const elapsed = now - start;
        liveProgressPercent = Math.min(100, Math.max(0, (elapsed / duration) * 100));

        // Calculate time remaining
        const remainingMs = end - now;
        const remainingMins = Math.ceil(remainingMs / 60000);

        if (remainingMins <= 0) {
            liveTimeRemaining = 'ending';
        } else if (remainingMins < 60) {
            liveTimeRemaining = `${remainingMins} min`;
        } else {
            const hours = Math.floor(remainingMins / 60);
            const mins = remainingMins % 60;
            liveTimeRemaining = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
    }

    // Start/stop progress updates based on visibility
    function startProgressUpdates(intervalMs: number) {
        if (progressInterval) return;
        updateLiveProgress(); // Immediate update
        progressInterval = setInterval(updateLiveProgress, intervalMs);
    }

    function stopProgressUpdates() {
        if (progressInterval) {
            clearInterval(progressInterval);
            progressInterval = null;
        }
    }

    // React to controls visibility - only run timer when visible
    $effect(() => {
        if (playerStore.isLive && controlsVisible) {
            const intervalMs = currentProgram ? 1000 : 30_000;
            untrack(() => {
                stopProgressUpdates();
                startProgressUpdates(intervalMs);
            });
        } else {
            stopProgressUpdates();
        }
    });

    // Fetch program info
    async function fetchProgramInfo(forceRefresh = false) {
        if (!channelId || !playerStore.isLive) return;

        // Skip if we already fetched for this channel (unless forced refresh)
        if (!forceRefresh && lastFetchedChannelId === channelId) return;
        if (lastFetchedChannelId !== channelId) airings = [];
        lastFetchedChannelId = channelId;
        const fetchedChannelId = channelId;

        loading = true;
        try {
            const { data, error } = await liveTvPlaybackApi.getChannelPrograms(
                channelId,
                new Date(Date.now() - 30 * 60_000).toISOString(),
                new Date(Date.now() + 12 * 3600_000).toISOString(),
            );
            if (channelId !== fetchedChannelId) return;
            if (!error && data) {
                airings = data.airings;
                nowMs = Date.now();
                programEndFetchPending = false; // Reset flag after successful fetch
                // Update live values immediately after fetch
                updateLiveProgress();
            } else {
                airings = [];
                programEndFetchPending = false;
            }
        } catch (error) {
            if (channelId !== fetchedChannelId) return;
            airings = [];
            console.error('[LiveTvOverlay] Failed to fetch program info:', error);
            programEndFetchPending = false; // Reset on error to allow retry
        } finally {
            if (channelId === fetchedChannelId) loading = false;
        }
    }

    onMount(() => {
        if (playerStore.isLive && channelId) {
            // Initial fetch
            fetchProgramInfo();

            // Background refresh every 60 seconds as safety net
            refreshInterval = setInterval(() => fetchProgramInfo(true), 60000);
        }
    });

    onDestroy(() => {
        if (refreshInterval) {
            clearInterval(refreshInterval);
        }
        stopProgressUpdates();
    });

    // Refetch when channel changes (only if it's actually a different channel)
    $effect(() => {
        if (channelId !== lastFetchedChannelId) {
            airings = [];
            programEndFetchPending = false;
            if (channelId && playerStore.isLive) void fetchProgramInfo();
        }
    });

    // Handle image load errors
    function handleImageError(e: Event) {
        const img = e.target as HTMLImageElement;
        if (img) {
            img.style.display = 'none';
        }
    }
</script>

{#if playerStore.isLive && playerStore.showControls}
    <div class="livetv-overlay">
        <!-- Channel Logo -->
        <div class="channel-section">
            {#if channelLogoUrl}
                <img
                    src={channelLogoUrl}
                    alt={channelName}
                    class="channel-logo"
                    onerror={handleImageError} />
            {/if}
        </div>

        <!-- Current Program -->
        {#if currentProgram}
            <div class="program-section current">
                <div class="program-label">{m.player_now_badge()}</div>
                <div class="program-name">{currentProgram.title}</div>
                <div class="program-time">
                    <span
                        >{formatTime(currentProgram.startTime)} - {formatTime(
                            currentProgram.endTime,
                        )}</span>
                    <span class="time-remaining">{liveTimeRemaining || 'ending'} left</span>
                </div>
                <!-- Progress bar (live-updated) -->
                <div class="program-progress">
                    <div class="progress-fill" style="width: {liveProgressPercent}%"></div>
                </div>
            </div>
        {:else if !loading}
            <div class="program-section current">
                <div class="program-label">{m.player_now_badge()}</div>
                <div class="program-name no-info">No program info</div>
            </div>
        {/if}

        <!-- Next Program -->
        {#if nextProgram}
            <div class="program-section next">
                <div class="program-label">{m.player_next_badge()}</div>
                <div class="program-name">{nextProgram.title}</div>
                <div class="program-time">
                    {formatTime(nextProgram.startTime)}
                </div>
            </div>
        {/if}
    </div>
{/if}

<style>
    .livetv-overlay {
        position: absolute;
        bottom: 80px; /* Above the controls */
        left: 1.5rem;
        display: flex;
        align-items: flex-end;
        gap: 1rem;
        z-index: 10;
        pointer-events: none;
        opacity: 0;
        animation: fadeIn 0.2s ease forwards;
    }

    @keyframes fadeIn {
        to {
            opacity: 1;
        }
    }

    .channel-section {
        flex-shrink: 0;
        width: 72px;
        height: 48px;
        overflow: hidden;
    }

    .channel-logo {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        object-position: center;
        border-radius: 6px;
        background: rgba(0, 0, 0, 0.5);
        padding: 4px;
        box-sizing: border-box;
    }

    .program-section {
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(10px);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        min-width: 180px;
        max-width: 280px;
    }

    .program-section.current {
        border-left: 3px solid #ef4444;
    }

    .program-section.next {
        border-left: 3px solid rgba(255, 255, 255, 0.3);
    }

    .program-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        color: rgba(255, 255, 255, 0.6);
        margin-bottom: 0.25rem;
    }

    .program-section.current .program-label {
        color: #ef4444;
    }

    .program-name {
        font-size: 14px;
        font-weight: 600;
        color: white;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 0.25rem;
    }

    .program-name.no-info {
        color: rgba(255, 255, 255, 0.5);
        font-style: italic;
    }

    .program-time {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.7);
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .time-remaining {
        color: rgba(255, 255, 255, 0.5);
    }

    .program-progress {
        margin-top: 0.5rem;
        height: 3px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 2px;
        overflow: hidden;
    }

    .progress-fill {
        height: 100%;
        background: #ef4444;
        border-radius: 2px;
        transition: width 0.3s ease;
    }

    /* Mobile adjustments */
    @media (max-width: 640px) {
        .livetv-overlay {
            left: 1rem;
            bottom: 70px;
            gap: 0.5rem;
        }

        .channel-section {
            width: 56px;
            height: 36px;
        }

        .program-section {
            padding: 0.5rem 0.75rem;
            min-width: 140px;
            max-width: 200px;
        }

        .program-name {
            font-size: 12px;
        }

        .program-time {
            font-size: 10px;
        }

        /* Hide next program on mobile */
        .program-section.next {
            display: none;
        }
    }
</style>
