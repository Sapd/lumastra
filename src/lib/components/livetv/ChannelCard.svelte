<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { pickNowNext } from '$lib/shared/livetv-now-next';
    import { getAvailabilityContext } from '$lib/shared/livetv-availability-context.js';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import {
        getRemainingMinutes,
        isOffAirProgram,
        formatRemainingTime,
    } from '$lib/shared/livetv-transforms.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, Star } from 'svelte-hero-icons';
    import { stopPropagation } from '$lib/utils/event-helpers';

    interface Props {
        channel: LiveTvStation;
        now: number;
        onclick: (channel: LiveTvStation) => void;
        favorite?: boolean;
        /** Search results need the full matchup, including event names used as channel names. */
        showFullTitles?: boolean;
        onToggleFavorite?: (channel: LiveTvStation) => void;
        /**
         * Open the station's feed menu at (x, y): right-click, long-press, or the
         * context-menu key. Absent when there is no choice to offer.
         */
        onOpenFeeds?: (channel: LiveTvStation, x: number, y: number) => void;
    }

    let {
        channel,
        now,
        onclick,
        favorite = false,
        showFullTitles = false,
        onToggleFavorite,
        onOpenFeeds,
    }: Props = $props();

    const getAvailability = getAvailabilityContext();
    let failed = $derived(
        ['upstream', 'service'].includes(
            getAvailability?.()?.channels[channel.feedId] ?? 'unknown',
        ),
    );
    let isLoading = $state(false);
    let loadingTimer: ReturnType<typeof setTimeout> | null = null;

    // Channels can carry a logo URL whose (proxied) image is missing/404s — fall
    // back to the generated name monogram instead of the browser's broken-image
    // glyph. Tracking the failed URL (not a boolean) means a corrected URL is
    // retried automatically, since it no longer matches the recorded failure.
    let failedLogoUrl = $state<string | undefined>(undefined);

    // Clean up pending loading timer on component destroy
    $effect(() => {
        return () => {
            if (loadingTimer) {
                clearTimeout(loadingTimer);
                loadingTimer = null;
            }
        };
    });

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
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    }

    let logoColor = $derived(LOGO_COLORS[hashString(channel.name) % LOGO_COLORS.length]);
    let firstLetter = $derived(channel.name.charAt(0).toUpperCase());

    let currentProgram = $derived(
        pickNowNext(
            [channel.nowNext.current, channel.nowNext.next].filter((p) => p !== null),
            now,
        ).current,
    );
    let programActive = $derived(currentProgram !== null);

    let remainingMinutes = $derived(
        programActive ? getRemainingMinutes(currentProgram?.endTime, now) : undefined,
    );

    const OFF_AIR_LONG_THRESHOLD_MS = 20 * 60 * 60 * 1000;

    let offAir = $derived(currentProgram ? isOffAirProgram(currentProgram.title) : false);

    let offAirIsLong = $derived(
        offAir && currentProgram
            ? new Date(currentProgram.endTime).getTime() -
                  new Date(currentProgram.startTime).getTime() >=
                  OFF_AIR_LONG_THRESHOLD_MS
            : false,
    );

    let offAirEndLabel = $derived(
        currentProgram
            ? new Date(currentProgram.endTime).toLocaleTimeString(getLocale(), {
                  hour: '2-digit',
                  minute: '2-digit',
              })
            : '',
    );

    // Long-press on touch opens the feed menu; the click that follows the lift is swallowed.
    const LONG_PRESS_MS = 500;
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressStart: { x: number; y: number } | null = null;
    let suppressClick = false;

    function cancelPress(): void {
        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = null;
        pressStart = null;
    }

    function handlePointerDown(e: PointerEvent): void {
        suppressClick = false;
        if (!onOpenFeeds || e.pointerType !== 'touch') return;
        pressStart = { x: e.clientX, y: e.clientY };
        const { clientX, clientY } = e;
        pressTimer = setTimeout(() => {
            pressTimer = null;
            suppressClick = true;
            onOpenFeeds?.(channel, clientX, clientY);
        }, LONG_PRESS_MS);
    }

    function handlePointerMove(e: PointerEvent): void {
        if (!pressStart) return;
        // A scroll, not a press.
        if (Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
    }

    function handlePointerUp(): void {
        cancelPress();
        // The click after a long-press lands right after the lift, if at all;
        // don't let a stale flag eat the next real tap.
        if (suppressClick) setTimeout(() => (suppressClick = false), 400);
    }

    function handleContextMenu(e: MouseEvent): void {
        if (!onOpenFeeds) return;
        e.preventDefault();
        // Touch browsers fire contextmenu on long-press too; the timer already opened it.
        if (suppressClick) return;
        // A touch press in progress (Android fires contextmenu before our timer):
        // the click that follows the lift must not also open the channel.
        if (pressStart) suppressClick = true;
        cancelPress();
        const target = e.currentTarget as HTMLElement;
        // The context-menu key / Shift+F10 reports (0, 0): anchor at the card.
        if (e.clientX === 0 && e.clientY === 0) {
            const rect = target.getBoundingClientRect();
            onOpenFeeds(channel, rect.left, rect.bottom);
        } else {
            onOpenFeeds(channel, e.clientX, e.clientY);
        }
    }

    $effect(() => cancelPress);

    function handleClick() {
        if (suppressClick) {
            suppressClick = false;
            return;
        }
        if (isLoading) return;
        isLoading = true;
        // Reset loading state after 3s as safety net (navigation failure or slow load)
        loadingTimer = setTimeout(() => {
            isLoading = false;
            loadingTimer = null;
        }, 3000);
        onclick(channel);
    }
</script>

<div class="group relative" class:full-titles={showFullTitles}>
    {#if onToggleFavorite}
        <button
            type="button"
            class="absolute right-1 top-1 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-surface-900/60 transition-opacity
                {favorite
                ? 'opacity-100 text-yellow-400'
                : 'text-surface-300 hover:text-yellow-400'}"
            onclick={stopPropagation(() => onToggleFavorite?.(channel))}
            aria-pressed={favorite}
            aria-label={favorite
                ? m.livetv_favorite_remove({ name: channel.name })
                : m.livetv_favorite_add({ name: channel.name })}>
            <Icon src={Star} solid={favorite} class="h-4 w-4" />
        </button>
    {/if}
    <button
        type="button"
        disabled={isLoading}
        aria-busy={isLoading}
        class="flex w-full items-center gap-3 rounded-lg bg-surface-800 p-3 text-left transition-all
			hover:bg-surface-700 hover:shadow-lg active:scale-[0.98]
			{isLoading ? 'opacity-60 pointer-events-none' : offAir ? 'opacity-60' : ''}"
        class:h-full={showFullTitles}
        onclick={handleClick}
        oncontextmenu={handleContextMenu}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointercancel={handlePointerUp}
        aria-haspopup={onOpenFeeds ? 'menu' : undefined}
        style:-webkit-touch-callout={onOpenFeeds ? 'none' : undefined}
        aria-label="{channel.name}{programActive && currentProgram
            ? ` - ${currentProgram.title}`
            : ''}">
        <!-- Logo / Fallback -->
        <div class="relative shrink-0">
            {#if channel.images?.primary?.href && channel.images?.primary?.href !== failedLogoUrl}
                <div class="flex h-12 w-12 items-center justify-center rounded-md bg-white/10 p-1">
                    <img
                        src={channel.images?.primary?.href}
                        alt={channel.name}
                        class="h-full w-full object-contain"
                        loading="lazy"
                        onerror={() => (failedLogoUrl = channel.images?.primary?.href)} />
                </div>
            {:else}
                <div
                    class="flex h-12 w-12 items-center justify-center rounded-md text-lg font-bold text-white"
                    style="background-color: {logoColor}">
                    {firstLetter}
                </div>
            {/if}
        </div>

        <!-- Channel Info -->
        <div class="min-w-0 flex-1" class:pr-11={Boolean(onToggleFavorite)}>
            <span
                class="channel-title font-medium text-surface-100 block"
                class:truncate={!showFullTitles}>{channel.name}</span>

            {#if failed}<span class="block text-xs text-amber-300"
                    >{m.livetv_availability_channel()}</span
                >{/if}
            {#if currentProgram}
                {#if offAir}
                    <div class="mt-0.5 flex items-center gap-1 text-sm text-surface-400">
                        <span class="truncate">
                            {offAirIsLong
                                ? m.livetv_off_air()
                                : m.livetv_off_air_until({ time: offAirEndLabel })}
                        </span>
                    </div>
                {:else if programActive}
                    <div
                        class="mt-0.5 text-sm text-surface-400"
                        class:flex={!showFullTitles}
                        class:items-center={!showFullTitles}
                        class:gap-1={!showFullTitles}>
                        <span class="program-title" class:truncate={!showFullTitles}
                            >{currentProgram.title}</span>
                        {#if remainingMinutes}
                            <span
                                class="text-xs text-surface-500"
                                class:ml-auto={!showFullTitles}
                                class:shrink-0={!showFullTitles}
                                class:block={showFullTitles}
                                class:mt-1={showFullTitles}>
                                {formatRemainingTime(remainingMinutes)}
                            </span>
                        {/if}
                    </div>
                {/if}
            {:else}
                <span class="mt-0.5 block truncate text-sm text-surface-400/50 italic">
                    {m.livetv_no_guide_data()}
                </span>
            {/if}
        </div>
    </button>
</div>

<style>
    .full-titles .channel-title,
    .full-titles .program-title {
        white-space: normal;
        overflow-wrap: anywhere;
    }
</style>
