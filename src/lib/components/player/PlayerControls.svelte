<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import PlayerIcon from './PlayerIcon.svelte';
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import { playerStore } from './playerStore.svelte';
    import { playbackPreferences } from './preferences-sync.svelte';
    import { playerSkipSeconds } from '$lib/stores/client-tuning';
    import TrackSelector from './TrackSelector.svelte';
    import QualitySelector from './QualitySelector.svelte';
    import PlayerFeedButton from './PlayerFeedButton.svelte';
    import SpeedSelector from './SpeedSelector.svelte';
    import ProgressBar from './ProgressBar.svelte';
    import VolumeControl from './VolumeControl.svelte';
    import type { VolumeCurve } from './volume-control';
    import type { AnnotationData } from '$lib/types/media-annotations';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { popup, type PopupSettings } from '$lib/utils/popup';
    import { getCatalogThumbUrl } from '$lib/utils/image-utils';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import { isEpisode as isEpisodeType, isMovie as isMovieType } from '$lib/shared/media-types';
    import type { LiveTvQualityChoice } from './livetv-quality-preference';
    import { base } from '$app/paths';
    import { isPWAInstalled } from '$lib/pwa';
    import { buildWatchShareUrl, shareOrCopy } from '$lib/utils/web-share';

    // Popup settings for next episode preview
    const nextEpisodePopupId = 'next-episode-preview';
    const nextEpisodePopupSettings: PopupSettings = {
        event: 'hover',
        target: nextEpisodePopupId,
        placement: 'top-start',
    };

    // In watch party, guests cannot seek (only host can seek, but anyone can play/pause)
    let isGuestInWatchParty = $derived(
        watchTogether.isInWatchParty && !watchTogether.isWatchPartyHost,
    );

    let endsAtTime = $derived.by(() => {
        if (playerStore.duration <= 0) return null;
        const remaining = playerStore.duration - playerStore.currentTime;
        if (remaining <= 0) return null;
        const rate = playerStore.playbackRate > 0 ? playerStore.playbackRate : 1;
        const endDate = new Date(Date.now() + (remaining / rate) * 1000);
        return endDate.toLocaleTimeString(getLocale(), {
            hour: '2-digit',
            minute: '2-digit',
        });
    });

    interface Props {
        /** Whether the control bar is currently shown (fades out when false) */
        visible?: boolean;
        // Props for cast state (controlled by VideoPlayer)
        airplayActive?: boolean;
        /** Whether AirPlay feature is enabled (requires FEATURE_DEVICE_AUTH) */
        enableAirPlay?: boolean;
        /** Whether auto quality mode is enabled (from config) */
        autoQualityEnabled?: boolean;
        /** Volume curve setting from config */
        volumeCurve?: VolumeCurve;
        onplay?: () => void;
        onseek?: (time: number) => void;
        onvolume?: (volume: number) => void;
        onmute?: () => void;
        onfullscreen?: () => void;
        onpip?: () => void;
        onairplay?: () => void;
        onversionchange?: (fileId: string) => void;
        onlivequalitychange?: (choice: LiveTvQualityChoice) => Promise<boolean>;
        onopenepisodebrowser?: () => void;
        onopenplaylistbrowser?: () => void;
        onopenchannelswitcher?: () => void;
        /** Live TV: play another feed of this station. */
        onselectfeed?: (feedId: string) => void;
        liveTvFeedId?: string;
        onopenmoviesidebar?: () => void;
        onopenannotations?: () => void;
        showAnnotations?: boolean;
        pins?: AnnotationData[];
        showAnnotationMarkers?: boolean;
        onopensearch?: () => void;
        ontogglereactions?: () => void;
        onnextepisode?: () => void;
        onseektolive?: () => void;
    }

    let {
        visible = true,
        airplayActive = false,
        enableAirPlay = false,
        autoQualityEnabled = true,
        volumeCurve = 'linear',
        onplay,
        onseek,
        onvolume,
        onmute,
        onfullscreen,
        onpip,
        onairplay,
        onversionchange,
        onlivequalitychange,
        onopenepisodebrowser,
        onopenplaylistbrowser,
        onopenchannelswitcher,
        onselectfeed,
        liveTvFeedId,
        onopenmoviesidebar,
        onopenannotations,
        showAnnotations = false,
        pins = [],
        showAnnotationMarkers = true,
        onopensearch,
        ontogglereactions,
        onnextepisode,
        onseektolive,
    }: Props = $props();

    // PiP support detection
    let pipSupported = $state(false);
    let isPipActive = $state(false);

    // AirPlay support detection (Safari only)
    let airplaySupported = $state(false);

    // Share button. Installed as a PWA there is no address bar, so the link to
    // what you are watching is otherwise unreachable — in a normal browser tab
    // it would be redundant chrome, so it stays hidden there. Resolved in
    // onMount because isPWAInstalled() touches `window`.
    let isInstalledPWA = $state(false);
    let canShare = $derived(isInstalledPWA && !!playerStore.itemId);

    function handleShare(): void {
        // Live TV: /watch/ takes the station id, not the shown feed's media item id.
        const itemId = playerStore.isLive ? playerStore.liveTvStationId : playerStore.itemId;
        if (!itemId) return;
        void shareOrCopy({
            title: playerStore.title || itemId,
            url: buildWatchShareUrl({
                origin: window.location.origin,
                basePath: base,
                itemId,
                // Anchors the link at what the sharer is watching right now.
                currentTime: playerStore.currentTime,
                params: new URL(window.location.href).searchParams,
            }),
        });
    }

    type WebkitVideo = HTMLVideoElement & {
        webkitSupportsPresentationMode?: () => boolean;
    };

    // Sync external cast state to local (for button display)
    let isAirplayActive = $derived(airplayActive);

    // Check feature support on mount
    onMount(() => {
        if (!browser) return;

        // Check for standard PiP API or Safari's webkit API
        const testVideo = document.createElement('video') as WebkitVideo;
        const hasPipSupport =
            document.pictureInPictureEnabled ||
            typeof testVideo.webkitSupportsPresentationMode === 'function';

        const handlePipEnter = () => {
            isPipActive = true;
        };
        const handlePipLeave = () => {
            isPipActive = false;
        };

        if (hasPipSupport) {
            pipSupported = true;
            document.addEventListener('enterpictureinpicture', handlePipEnter);
            document.addEventListener('leavepictureinpicture', handlePipLeave);
        }

        // Check for AirPlay support (Safari only)
        if ('WebKitPlaybackTargetAvailabilityEvent' in window) {
            airplaySupported = true;
        }

        isInstalledPWA = isPWAInstalled();

        return () => {
            if (hasPipSupport) {
                document.removeEventListener('enterpictureinpicture', handlePipEnter);
                document.removeEventListener('leavepictureinpicture', handlePipLeave);
            }
        };
    });

    // Check if current media is an episode (show episode browser button)
    let isEpisode = $derived(isEpisodeType(playerStore.playbackInfo?.mediaType));

    // Check if current media is LiveTV (show channel switcher button)
    let isTvChannel = $derived(playerStore.playbackInfo?.mediaType === 'tvchannel');

    // Check if current media is a movie (show movie sidebar button)
    let isMovie = $derived(isMovieType(playerStore.playbackInfo?.mediaType));

    // Derived: chapters from playbackInfo
    let chapters = $derived(playerStore.chapters || []);

    // Menu state
    let showTrackMenu = $state(false);
    let showQualityMenu = $state(false);
    let showSpeedMenu = $state(false);
    let showFeedMenu = $state(false);

    $effect(() => {
        if (!isTvChannel || !playerStore.liveTvStationId || !onselectfeed) showFeedMenu = false;
    });

    // An explicitly opened menu outlives the transport auto-hide timer.
    export function hasOpenMenu(): boolean {
        return showTrackMenu || showQualityMenu || showSpeedMenu || showFeedMenu;
    }

    // Skip buttons (disabled for guests in watch party). The jump distance is
    // the user's per-account seek step (falls back to PLAYER_SKIP_SECONDS).
    function seekStep(): number {
        const v = playbackPreferences.seekStepSeconds;
        return v != null && v > 0 ? v : playerSkipSeconds();
    }
    // The buttons' accessible names say how far they jump.
    const skipSeconds = $derived(seekStep());
    function skipBackward() {
        if (isGuestInWatchParty) return;
        onseek?.(Math.max(0, playerStore.currentTime - seekStep()));
    }

    function skipForward() {
        if (isGuestInWatchParty) return;
        onseek?.(Math.min(playerStore.duration, playerStore.currentTime + seekStep()));
    }

    // Close menus when clicking elsewhere
    function handleContainerClick(event: MouseEvent) {
        const target = event.target as HTMLElement;
        if (!target.closest('.track-menu-container')) {
            showTrackMenu = false;
        }
        if (!target.closest('.quality-menu-container')) {
            showQualityMenu = false;
        }
        if (!target.closest('.feed-menu-container')) {
            showFeedMenu = false;
        }
        if (!target.closest('.speed-menu-container')) {
            showSpeedMenu = false;
        }
    }

    // Handle volume changes from VolumeControl
    function handleVolumeChange(newVolume: number) {
        onvolume?.(newVolume);
        playerStore.setVolume(newVolume);
    }

    function handleMute() {
        onmute?.();
    }

    // Close all open menus - returns true if any menu was closed
    export function closeAllMenus(): boolean {
        const hadOpenMenu = showTrackMenu || showQualityMenu || showSpeedMenu || showFeedMenu;
        showTrackMenu = false;
        showQualityMenu = false;
        showSpeedMenu = false;
        showFeedMenu = false;
        return hadOpenMenu;
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
    class="controls-container"
    class:controls-hidden={!visible && !hasOpenMenu()}
    onclick={handleContainerClick}
    role="toolbar"
    aria-label={m.player_video_controls()}
    tabindex="0">
    <!-- Mobile backdrop to close popups.
         It MUST live inside .controls-container, not beside it: the container
         is `z-index: 3` (see the tier comment below), which makes it a
         stacking context, so the popups' `z-index: 100` only ranks them
         against their siblings INSIDE it — it cannot lift them past anything
         outside. As a sibling of the container this backdrop (z-index 99)
         therefore painted over the very popup it is meant to sit behind, and
         on mobile portrait every tap on a subtitle/audio/quality option hit
         the backdrop and closed the menu instead of selecting the track. -->
    {#if showQualityMenu || showSpeedMenu || showTrackMenu || showFeedMenu}
        <button
            class="mobile-popup-backdrop"
            onclick={() => {
                showQualityMenu = false;
                showSpeedMenu = false;
                showTrackMenu = false;
                showFeedMenu = false;
            }}
            aria-label={m.player_close_menu()}></button>
    {/if}

    <!-- Progress bar (hidden for live streams) -->
    {#if !playerStore.isLive}
        <ProgressBar
            currentTime={playerStore.currentTime}
            duration={playerStore.duration}
            bufferedPercent={playerStore.bufferedPercent}
            progressPercent={playerStore.progressPercent}
            {chapters}
            {isGuestInWatchParty}
            {pins}
            {showAnnotationMarkers}
            onseek={(time) => onseek?.(time)} />
    {/if}

    <!-- Bottom controls -->
    <div class="bottom-controls">
        <!-- Left side: Play, skip, time -->
        <div class="controls-left">
            <!-- Play/Pause - anyone in watch party can control -->
            <button
                class="control-button"
                onclick={() => onplay?.()}
                aria-label={playerStore.isPlaying ? m.player_pause() : m.player_play()}>
                {#if playerStore.isPlaying}
                    <PlayerIcon name="pause" size={28} />
                {:else}
                    <PlayerIcon name="play" size={28} />
                {/if}
            </button>

            {#if !playerStore.isLive}
                <!-- Skip backward (hidden on portrait) -->
                <Tooltip
                    text={isGuestInWatchParty ? m.player_host_only_control() : ''}
                    position="top"
                    fixed>
                    <button
                        class="control-button hide-portrait"
                        class:disabled={isGuestInWatchParty}
                        onclick={skipBackward}
                        disabled={isGuestInWatchParty}
                        aria-label={m.player_skip_back_seconds({ seconds: skipSeconds })}>
                        <PlayerIcon name="back" size={24} />
                    </button>
                </Tooltip>

                <!-- Skip forward (hidden on portrait) -->
                <Tooltip
                    text={isGuestInWatchParty ? m.player_host_only_control() : ''}
                    position="top"
                    fixed>
                    <button
                        class="control-button hide-portrait"
                        class:disabled={isGuestInWatchParty}
                        onclick={skipForward}
                        disabled={isGuestInWatchParty}
                        aria-label={m.player_skip_forward_seconds({ seconds: skipSeconds })}>
                        <PlayerIcon name="forward" size={24} />
                    </button>
                </Tooltip>

                <!-- Next Episode (only for series with next episode) - placed next to skip buttons -->
                {#if isEpisode && playerStore.nextEpisode}
                    <div
                        class="next-episode-control"
                        role="group"
                        aria-label={m.player_next_episode_controls_aria()}>
                        <button
                            class="control-button hide-portrait"
                            class:disabled={isGuestInWatchParty}
                            onclick={() => !isGuestInWatchParty && onnextepisode?.()}
                            disabled={isGuestInWatchParty}
                            aria-label={m.player_next_episode_aria()}
                            use:popup={nextEpisodePopupSettings}>
                            <PlayerIcon name="next" size={24} />
                        </button>

                        <!-- Hover Preview - positioned by floating-ui -->
                        <div
                            class="next-episode-preview player-menu"
                            data-popup={nextEpisodePopupId}>
                            <img
                                src={getCatalogThumbUrl(
                                    playerStore.nextEpisode.internalId ||
                                        playerStore.nextEpisode.itemId,
                                    { size: 'thumb' },
                                )}
                                alt={m.player_next_episode()}
                                class="next-preview-thumbnail" />
                            <div class="next-preview-info">
                                <span class="next-preview-label">
                                    {#if playerStore.nextEpisode.isNewSeason}
                                        {m.player_next_season()}
                                    {:else}
                                        {m.player_next_episode()}
                                    {/if}
                                </span>
                                <span class="next-preview-episode">
                                    S{String(playerStore.nextEpisode.seasonNumber).padStart(
                                        2,
                                        '0',
                                    )}E{String(playerStore.nextEpisode.episodeNumber).padStart(
                                        2,
                                        '0',
                                    )}
                                </span>
                                <span class="next-preview-title"
                                    >{playerStore.nextEpisode.title}</span>
                                {#if playerStore.nextEpisode.overview}
                                    <span class="next-preview-overview"
                                        >{playerStore.nextEpisode.overview}</span>
                                {/if}
                            </div>
                        </div>
                    </div>
                {/if}

                <!-- Time -->
                <div class="time-display">
                    <span>{playerStore.formattedCurrentTime}</span>
                    <span class="time-separator">/</span>
                    <span>{playerStore.formattedDuration}</span>
                </div>

                {#if endsAtTime}
                    <div class="ends-at hide-portrait">
                        {m.player_ends_at({ time: endsAtTime })}
                    </div>
                {/if}
            {:else}
                <!-- LIVE indicator for live streams - clickable when behind live edge -->
                <Tooltip
                    text={playerStore.isAtLiveEdge ? '' : m.player_go_to_live()}
                    position="top"
                    fixed>
                    <button
                        class="live-indicator"
                        class:behind-live={!playerStore.isAtLiveEdge}
                        onclick={() => !playerStore.isAtLiveEdge && onseektolive?.()}
                        disabled={playerStore.isAtLiveEdge}
                        aria-label={playerStore.isAtLiveEdge
                            ? m.player_live()
                            : m.player_go_to_live()}>
                        <span class="live-dot"></span>
                        <span>{m.player_live()}</span>
                    </button>
                </Tooltip>
            {/if}
        </div>

        <!-- Right side: Volume, tracks, quality, fullscreen -->
        <div class="controls-right">
            <!-- Volume Control -->
            <VolumeControl
                volume={playerStore.volume}
                isMuted={playerStore.isMuted}
                {volumeCurve}
                onvolume={handleVolumeChange}
                onmute={handleMute} />

            <!-- Subtitles/Audio/Version -->
            {#if playerStore.subtitleTracks.length > 0 || playerStore.audioTracks.length > 1 || playerStore.mediaSources.length > 1}
                <div class="track-menu-container">
                    <button
                        class="control-button"
                        onclick={() => {
                            showTrackMenu = !showTrackMenu;
                            showFeedMenu = false;
                            showSpeedMenu = false;
                            showQualityMenu = false;
                        }}
                        aria-label={m.player_audio_subtitle_tracks()}
                        class:active={showTrackMenu}>
                        <PlayerIcon name="tracks" size={24} />
                    </button>

                    {#if showTrackMenu}
                        <TrackSelector onclose={() => (showTrackMenu = false)} />
                    {/if}
                </div>
            {/if}

            <!-- Quality -->
            <div class="quality-menu-container">
                <button
                    class="control-button"
                    onclick={() => {
                        showQualityMenu = !showQualityMenu;
                        showFeedMenu = false;
                        showSpeedMenu = false;
                        showTrackMenu = false;
                    }}
                    aria-label={m.player_video_quality()}
                    class:active={showQualityMenu}>
                    <PlayerIcon name="settings" size={24} />
                </button>

                {#if showQualityMenu}
                    <QualitySelector
                        {autoQualityEnabled}
                        {showAnnotations}
                        onclose={() => (showQualityMenu = false)}
                        {onversionchange}
                        {onlivequalitychange} />
                {/if}
            </div>

            <!-- Playback Speed (hide for live streams and watch parties) -->
            {#if !playerStore.isLive && !watchTogether.isInWatchParty}
                <div class="speed-menu-container hide-portrait">
                    <Tooltip text={m.player_speed()} position="top" fixed>
                        <button
                            class="control-button"
                            onclick={() => {
                                showSpeedMenu = !showSpeedMenu;
                                showFeedMenu = false;
                                showQualityMenu = false;
                                showTrackMenu = false;
                            }}
                            aria-label={m.player_playback_speed_aria()}
                            class:active={showSpeedMenu}>
                            <span class="speed-indicator"
                                >{playerStore.playbackRate === 1
                                    ? '1x'
                                    : playerStore.playbackRate + 'x'}</span>
                        </button>
                    </Tooltip>

                    {#if showSpeedMenu}
                        <SpeedSelector onclose={() => (showSpeedMenu = false)} />
                    {/if}
                </div>
            {/if}

            <!-- Episodes (only for series) -->
            {#if isEpisode}
                <Tooltip text={m.episodes()} position="top" fixed>
                    <button
                        class="control-button"
                        onclick={() => onopenepisodebrowser?.()}
                        aria-label={m.player_browse_episodes_aria()}>
                        <PlayerIcon name="episodes" size={24} />
                    </button>
                </Tooltip>
            {/if}

            <!-- Playlist Browser (only in playlist mode) -->
            {#if playerStore.isPlaylistMode && playerStore.playlistContext}
                <Tooltip text={m.playlist_button_label()} position="top" fixed>
                    <button
                        class="control-button"
                        onclick={() => onopenplaylistbrowser?.()}
                        aria-label={m.player_browse_playlist_aria()}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path
                                d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Feed of this station (only for LiveTV with a choice of feeds) -->
            {#if isTvChannel && playerStore.liveTvStationId && onselectfeed}
                <div class="feed-menu-container">
                    <PlayerFeedButton
                        bind:isOpen={showFeedMenu}
                        onopen={() => {
                            closeAllMenus();
                        }}
                        channelId={playerStore.liveTvStationId}
                        feedId={liveTvFeedId}
                        name={playerStore.playbackInfo?.title ?? ''}
                        {onselectfeed} />
                </div>
            {/if}

            <!-- Channel Switcher (only for LiveTV) -->
            {#if isTvChannel}
                <Tooltip text={m.player_switch_channel()} position="top" fixed>
                    <button
                        class="control-button"
                        onclick={() => onopenchannelswitcher?.()}
                        aria-label={m.player_switch_channel_aria()}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path
                                d="M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 14H3V8h18v12zM9 10v8l7-4z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Movie Info Sidebar (only for Movies) -->
            {#if isMovie}
                <Tooltip text={m.player_movie_info()} position="top" fixed>
                    <button
                        class="control-button hide-portrait"
                        onclick={() => onopenmoviesidebar?.()}
                        aria-label={m.player_movie_info_aria()}>
                        <PlayerIcon name="info" size={24} />
                    </button>
                </Tooltip>
            {/if}

            <!-- Community Notes (annotations sidebar) -->
            {#if showAnnotations}
                <Tooltip text={m.player_community_notes()} position="top" fixed>
                    <button
                        class="control-button hide-portrait"
                        onclick={() => onopenannotations?.()}
                        aria-label={m.player_community_notes()}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path
                                d="M17 4a2 2 0 0 1 2 2v1l-2 2v5l2 1v1a1 1 0 0 1-1 1h-4.17A3 3 0 0 1 11 19a3 3 0 0 1-2.83-2H4a1 1 0 0 1-1-1v-1l2-1V9L3 7V6a2 2 0 0 1 2-2h12z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Search button (visible to all except watch party guests) -->
            {#if !isGuestInWatchParty}
                <Tooltip text={m.search()} position="top" fixed>
                    <button
                        class="control-button hide-portrait"
                        onclick={() => onopensearch?.()}
                        aria-label={m.player_search_aria()}>
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="24"
                            height="24">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Share (installed PWA only — see canShare). Deliberately NOT
                 `hide-portrait`: a phone PWA is the case with no address bar at
                 all, so this is where the button matters most. -->
            {#if canShare}
                <Tooltip text={m.player_share()} position="top" fixed>
                    <button
                        class="control-button"
                        onclick={handleShare}
                        aria-label={m.player_share_aria()}>
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            width="24"
                            height="24">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Reactions (only in Watch Party) -->
            {#if watchTogether.isInWatchParty}
                <Tooltip text={m.player_send_reaction()} position="top" fixed>
                    <button
                        class="control-button"
                        onclick={() => ontogglereactions?.()}
                        aria-label={m.player_send_reaction_aria()}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path
                                d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Picture-in-Picture. Hidden while audio-only (there is no video to
                 show) — but NEVER while a PiP window is already open: switching to
                 audio-only mid-PiP would otherwise orphan an empty floating window
                 with no in-app control to close it. Hide the ENTER action, never
                 the EXIT action. -->
            {#if pipSupported && (playerStore.qualityMode !== 'audio-only' || isPipActive)}
                <Tooltip text={m.player_picture_in_picture()} position="top" fixed>
                    <button
                        class="control-button"
                        onclick={() => onpip?.()}
                        aria-label={isPipActive ? m.player_exit_pip() : m.player_enter_pip()}>
                        {#if isPipActive}
                            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                                <path
                                    d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z" />
                                <path d="M9 9h6v6H9z" />
                            </svg>
                        {:else}
                            <PlayerIcon name="pip" size={24} />
                        {/if}
                    </button>
                </Tooltip>
            {/if}

            <!-- AirPlay (Safari only, requires device auth to be enabled) -->
            {#if airplaySupported && enableAirPlay}
                <Tooltip text={m.player_airplay()} position="top" fixed>
                    <button
                        class="control-button hide-portrait"
                        class:active={isAirplayActive}
                        onclick={() => onairplay?.()}
                        aria-label={isAirplayActive
                            ? m.player_airplay_connected()
                            : m.player_airplay()}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path
                                d="M6 22h12l-6-6-6 6zM21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h4v-2H3V5h18v12h-4v2h4c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                        </svg>
                    </button>
                </Tooltip>
            {/if}

            <!-- Fullscreen. Hidden while audio-only (there is no video to show) —
                 but NEVER while already fullscreen: on a touch device there is no
                 Esc key, so removing the button is the only way out and the user
                 is trapped. Hide the ENTER action, never the EXIT action. -->
            {#if playerStore.qualityMode !== 'audio-only' || playerStore.isFullscreen}
                <button
                    class="control-button"
                    onclick={() => onfullscreen?.()}
                    aria-label={playerStore.isFullscreen
                        ? m.player_exit_fullscreen()
                        : m.player_enter_fullscreen()}>
                    {#if playerStore.isFullscreen}
                        <PlayerIcon name="exitFullscreen" size={24} />
                    {:else}
                        <PlayerIcon name="fullscreen" size={24} />
                    {/if}
                </button>
            {/if}
        </div>
    </div>
</div>

<style>
    .controls-container {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        /* Local player-container z-index tier (see the comment on
           VideoPlayer.svelte's .video-element): backdrop 0, video 1,
           overlays 2, controls 3. Without this, a positioned descendant of
           .player-container defaults to z-index:auto and paints BEHIND the
           video (z-index:1) per CSS painting order, so every click on the
           control bar hits the <video> instead — that's the exact
           regression this fixes. */
        z-index: 3;
        background: linear-gradient(transparent, rgba(0, 0, 0, 0.9));
        padding: 2rem 1rem 1rem;
        visibility: visible;
        transition: opacity 0.3s ease;
    }

    /* Hidden state: fade out, then become inert. `visibility` is delayed until
       the opacity transition finishes so the fade is still visible, while
       removing the bar from pointer/tab interaction once hidden. */
    .controls-container.controls-hidden {
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition:
            opacity 0.3s ease,
            visibility 0s linear 0.3s;
    }

    .bottom-controls {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 0.5rem;
    }

    .controls-left,
    .controls-right {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .control-button {
        background: none;
        border: none;
        color: white;
        cursor: pointer;
        padding: 0.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background-color 0.2s;
    }

    .control-button:hover {
        background: rgba(255, 255, 255, 0.1);
    }

    .control-button.active {
        background: rgba(255, 255, 255, 0.2);
    }

    .control-button.disabled,
    .control-button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .control-button.disabled:hover,
    .control-button:disabled:hover {
        background: none;
    }

    .time-display {
        color: white;
        font-size: 14px;
        font-variant-numeric: tabular-nums;
        padding: 0 0.5rem;
        white-space: nowrap;
        display: flex;
        align-items: center;
    }

    .time-separator {
        margin: 0 0.25rem;
        opacity: 0.7;
    }

    .ends-at {
        color: white;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        opacity: 0.6;
        padding: 0 0.5rem;
        white-space: nowrap;
    }

    /* LIVE indicator for live streams */
    .live-indicator {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        color: white;
        font-size: 14px;
        font-weight: 600;
        padding: 0.25rem 0.75rem;
        background: rgba(239, 68, 68, 0.9);
        border: none;
        border-radius: 4px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        cursor: default;
        transition:
            background-color 0.2s,
            opacity 0.2s;
    }

    /* When at live edge (default state) - not clickable */
    .live-indicator:disabled {
        cursor: default;
        opacity: 1;
    }

    /* When behind live edge - clickable, dimmed appearance */
    .live-indicator.behind-live {
        background: rgba(100, 100, 100, 0.8);
        cursor: pointer;
    }

    .live-indicator.behind-live:hover {
        background: rgba(239, 68, 68, 0.9);
    }

    .live-indicator.behind-live .live-dot {
        animation: none;
        opacity: 0.5;
    }

    .live-indicator.behind-live:hover .live-dot {
        animation: pulse-live 1.5s ease-in-out infinite;
        opacity: 1;
    }

    .live-dot {
        width: 8px;
        height: 8px;
        background: white;
        border-radius: 50%;
        animation: pulse-live 1.5s ease-in-out infinite;
        transition: opacity 0.2s;
    }

    @keyframes pulse-live {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.4;
        }
    }

    .track-menu-container,
    .quality-menu-container,
    .speed-menu-container,
    .feed-menu-container {
        position: relative;
        /* Nested inline-flex tooltip triggers must not add a text baseline gap. */
        display: flex;
        align-items: center;
    }

    /* Speed indicator text */
    .speed-indicator {
        font-size: 13px;
        font-weight: 600;
        min-width: 28px;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }

    /* Mobile adjustments - Portrait */
    @media (max-width: 640px) {
        .controls-container {
            padding: 0.75rem 0.75rem;
            padding-bottom: env(safe-area-inset-bottom, 0.25rem);
            background: linear-gradient(transparent 0%, rgba(0, 0, 0, 0.95) 30%);
        }

        .bottom-controls {
            margin-top: 0.25rem;
        }

        .time-display {
            font-size: 11px;
        }

        .control-button {
            padding: 0.35rem;
        }

        .control-button svg {
            width: 22px;
            height: 22px;
        }

        .controls-left,
        .controls-right {
            gap: 0.25rem;
        }
    }

    /* Mobile Portrait - iPhone specific with safe area */
    @media (max-width: 640px) and (orientation: portrait) {
        .controls-container {
            padding-bottom: env(safe-area-inset-bottom, 0.25rem) !important;
        }

        .hide-portrait {
            display: none !important;
        }
    }

    /* PWA standalone mode */
    @media (max-width: 640px) and (orientation: portrait) and (display-mode: standalone) {
        .controls-container {
            padding: 0.75rem 0.75rem;
            padding-bottom: calc(0.25rem + env(safe-area-inset-bottom, 0px));
        }
    }

    /* Mobile popup backdrop */
    .mobile-popup-backdrop {
        display: none;
    }

    @media (max-width: 640px) and (orientation: portrait) {
        .mobile-popup-backdrop {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.5);
            /* Below the popups (z-index: 100 in TrackSelector / QualitySelector
               / SpeedSelector), above the rest of the control bar. This only
               holds while the backdrop stays a child of .controls-container —
               see the markup comment there. */
            z-index: 99;
            border: none;
            cursor: pointer;
        }
    }

    /* Mobile Landscape */
    @media (max-width: 920px) and (orientation: landscape) {
        .controls-container {
            padding: 0.75rem 1rem;
            padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
            padding-left: max(1rem, env(safe-area-inset-left));
            padding-right: max(1rem, env(safe-area-inset-right));
            background: linear-gradient(transparent 0%, rgba(0, 0, 0, 0.9) 20%);
        }

        .bottom-controls {
            margin-top: 0.25rem;
        }

        .control-button svg {
            width: 20px;
            height: 20px;
        }

        .time-display {
            font-size: 11px;
        }
    }

    /* Next Episode Control with Hover Preview */
    .next-episode-control {
        position: relative;
    }

    .next-episode-preview {
        display: none;
        overflow: hidden;
        min-width: 240px;
        max-width: 320px;
        z-index: 100;
    }

    .next-episode-preview:global(.popup-visible) {
        display: block;
        animation: previewFadeIn 0.2s ease-out;
    }

    @keyframes previewFadeIn {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    .next-preview-thumbnail {
        width: 100%;
        height: auto;
        display: block;
    }

    .next-preview-info {
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .next-preview-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: #e50914;
    }

    .next-preview-episode {
        font-size: 12px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.7);
    }

    .next-preview-title {
        font-size: 14px;
        font-weight: 600;
        color: white;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .next-preview-overview {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.55);
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        margin-top: 2px;
    }

    /* Hide preview on mobile */
    @media (max-width: 640px) {
        .next-episode-preview {
            display: none;
        }
    }
</style>
