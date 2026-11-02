<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { onNavigate } from '$app/navigation';
    import type { Snippet } from 'svelte';
    import { PlayerController, type VideoPlayerProps } from './player-controller.svelte';

    import PlayerControls from './PlayerControls.svelte';
    import PlayerOverlay from './PlayerOverlay.svelte';
    import LiveTvOverlay from './LiveTvOverlay.svelte';
    import ChannelSwitcher from './ChannelSwitcher.svelte';
    import StreamFailureOverlay from '$lib/components/livetv/StreamFailureOverlay.svelte';
    import LiveTvFailureCard from '$lib/components/livetv/LiveTvFailureCard.svelte';
    import { liveTvSimpleContext } from '$lib/components/livetv/simple/simple-context.svelte.js';
    import LiveTvKickedOverlay from '$lib/components/livetv/LiveTvKickedOverlay.svelte';
    import WatchTogetherOverlay from './WatchTogetherOverlay.svelte';
    import WatchPartyAvatarCluster from './WatchPartyAvatarCluster.svelte';
    import WatchTogetherToast from './WatchTogetherToast.svelte';
    import ReactionOverlay from './ReactionOverlay.svelte';
    import PluginPlayerRegion from '$lib/components/plugins/PluginPlayerRegion.svelte';
    import { createPlaybackBridge } from './plugin-playback-bridge.js';
    import { page } from '$app/stores';
    import ScreenEffectsOverlay from './ScreenEffectsOverlay.svelte';
    import SyncStatusIndicator from './SyncStatusIndicator.svelte';
    import { watchPartySyncPin } from './watch-party-sync-pin.svelte';
    import VideoOverlays from './VideoOverlays.svelte';
    import TextSubtitleOverlay from './TextSubtitleOverlay.svelte';
    import WatchPartyBackDialog from './WatchPartyBackDialog.svelte';
    import AnnotationsSidebar from './AnnotationsSidebar.svelte';
    import AnnotationPopup from './AnnotationPopup.svelte';
    import AutoplayMutedPrompt from './AutoplayMutedPrompt.svelte';
    import TabConflictModal from './TabConflictModal.svelte';

    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import { playbackPreferences } from './preferences-sync.svelte';
    import { playerStore } from './playerStore.svelte';
    import { DeferredPlayerPanel } from './deferred-player-panel.svelte';
    import { waitForModals } from '$lib/stores/modal-registry.store';
    import { toasts } from '$lib/stores/toast.store';
    import { isEpisode as isEpisodeType } from '$lib/shared/media-types';
    import { noteEpisodeArrival, startViewerActivityTracking } from './still-watching';
    import { liveTvLogoUrl } from '$lib/components/player/livetv-logo-url';
    import * as m from '$lib/paraglide/messages';

    interface ExtendedVideoPlayerProps extends VideoPlayerProps {
        /**
         * Optional snippet rendered inside the player container — shells use this for
         * side rails (episode list, lesson list, event clip strip).
         * When not provided, the default VOD EpisodeBrowser / PlaylistBrowser rails apply.
         */
        rail?: Snippet;
        /**
         * Optional snippet rendered below the player fold — shells use this for
         * metadata strips, resource tabs, event context, etc.
         * When not provided, nothing is rendered below the fold (VOD behavior).
         */
        belowFold?: Snippet;
    }

    let props: ExtendedVideoPlayerProps = $props();
    // svelte-ignore state_referenced_locally
    const c = new PlayerController(props);

    // Keep panel instances mounted after the first open so closing/reopening
    // retains their state, without putting their code on the first-frame path.
    const moviePanel = new DeferredPlayerPanel(() =>
        Promise.all([import('./MovieSidebar.svelte'), waitForModals()]).then(([m]) => m.default),
    );
    const episodePanel = new DeferredPlayerPanel(() =>
        Promise.all([import('./EpisodeBrowser.svelte'), waitForModals()]).then(([m]) => m.default),
    );
    const playlistPanel = new DeferredPlayerPanel(() =>
        Promise.all([import('./PlaylistBrowser.svelte'), waitForModals()]).then(([m]) => m.default),
    );
    const searchPanel = new DeferredPlayerPanel(() =>
        Promise.all([import('$lib/Search.svelte'), waitForModals()]).then(([m]) => m.default),
    );
    let panelOwnerActive = true;

    function loadPanel<T>(panel: DeferredPlayerPanel<T>, close: () => void): void {
        void panel.load().catch(() => {
            if (!panelOwnerActive) return;
            close();
            toasts.error(m.error_default());
        });
    }
    $effect(() => {
        if (c.showMovieSidebar)
            untrack(() =>
                loadPanel(moviePanel, () => {
                    c.showMovieSidebar = false;
                }),
            );
    });
    $effect(() => {
        if (c.showEpisodeBrowser)
            untrack(() =>
                loadPanel(episodePanel, () => {
                    c.showEpisodeBrowser = false;
                }),
            );
    });
    $effect(() => {
        if (c.showPlaylistBrowser)
            untrack(() =>
                loadPanel(playlistPanel, () => {
                    c.showPlaylistBrowser = false;
                }),
            );
    });
    $effect(() => {
        if (c.showSearch || c.showWatchPartySearch)
            untrack(() =>
                loadPanel(searchPanel, () => {
                    c.showSearch = false;
                    c.showWatchPartySearch = false;
                }),
            );
    });

    // Sync per-user next-episode-prompt preferences into the player store so the
    // (store-owned) showNextItemPrompt trigger honors them. Reactive so changes
    // made in settings mid-playback take effect immediately. Lead falls back to
    // the admin config, then 0; the no-outro window falls back to 30s.
    $effect(() => {
        playerStore.showNextEpisodePopup = playbackPreferences.showNextEpisodePopup;
        playerStore.nextItemPromptLeadSeconds =
            playbackPreferences.nextEpisodePromptLeadSeconds ??
            props.nextEpisodePromptLeadSeconds ??
            0;
        playerStore.noOutroFallbackSeconds = playbackPreferences.noOutroFallbackSeconds ?? 30;
    });

    function nonpassiveWheel(node: HTMLElement): { destroy(): void } {
        return c.nonpassiveWheel(node);
    }

    onMount(async () => {
        try {
            await c.mount();
        } catch (e) {
            console.error('[Player] mount failed:', e);
        }
    });

    // Stop the play session via fetch before SPA navigation completes.
    // onNavigate awaits the returned Promise, ensuring the COMPLETED PUT
    // reaches the server before the component is destroyed. The onDestroy
    // beacon is a fallback for hard navigation / tab close.
    onNavigate(async () => {
        try {
            await c.stopAndCleanup();
        } catch {
            /* non-fatal — destroy() beacon is the fallback */
        }
    });

    onDestroy(() => {
        panelOwnerActive = false;
        c.destroy();
    });

    // Anything a person does anywhere on the page clears the unattended-episode
    // streak that feeds the "are you still watching?" prompt. Raw input events
    // rather than player callbacks: `onPlay` fires for an auto-played episode
    // too, and hanging this off playback would reset the very count it feeds.
    // Always on — the streak is cheap, and reading a stale one after the viewer
    // enables the preference mid-binge would ask the question on the spot.
    $effect(() => startViewerActivityTracking(window));

    // The listener above only exists while the player is mounted, so an episode
    // picked from a browse page produces no input event to clear the streak
    // with. Check each arrival against the episode the countdown aimed at;
    // anything else was chosen by a person. Idempotent, so no re-entry guard.
    //
    // Reads the PROP, never playerStore.itemId: advancing an episode runs the
    // outgoing player's destroy() — and its playerStore.reset() — from inside
    // the {#key itemId} remount of the in-flight goto(), so the shared store
    // can still be holding the previous episode (or a null) when this effect
    // first runs. Checking a stale id against the one the countdown aimed at
    // would clear the streak on every advance and the prompt would never fire,
    // silently. The prop is this component's own episode from its first render.
    $effect(() => {
        noteEpisodeArrival(props.playbackInfo.itemId);
    });

    // ── Plugin player widgets ────────────────────────────────────────────────
    //
    // Everything here stays inert unless a plugin actually declares a `player`
    // widget. The bridge is what costs something — it samples playback state at
    // 2Hz — so it is only built when there is a subscriber for it, and torn
    // down with the component.
    const pluginPlayerWidgets = $derived(
        ($page.data?.playerWidgets ?? []) as Array<{
            id: string;
            featureId: string;
            widgetId: string;
            title: string;
            entry: string;
            placement: string;
            playerRegion?: string;
            minHeightPx?: number;
        }>,
    );

    const pluginUser = $derived(
        ($page.data?.user ?? null) as {
            userId: string;
            username: string;
            groups: string[];
            isAdmin: boolean;
        } | null,
    );

    let playbackBridge = $state<ReturnType<typeof createPlaybackBridge> | null>(null);

    // The effect depends on this NUMBER, not on the widgets array.
    //
    // `$page.data` is replaced on every invalidation, so the array identity
    // changes even when its contents do not — depending on it would tear down
    // and rebuild the bridge mid-playback each time anything invalidated. A
    // derived primitive only propagates when the value actually changes. Same
    // bug this codebase already hit with the home-page widget slots.
    const pluginPlayerWidgetCount = $derived(pluginPlayerWidgets.length);

    $effect(() => {
        if (pluginPlayerWidgetCount === 0) return;
        const bridge = createPlaybackBridge(
            // Getters, so the bridge samples LIVE store values rather than a
            // snapshot taken when the effect ran.
            {
                get itemId() {
                    return props.playbackInfo.itemId;
                },
                get mediaType() {
                    return props.playbackInfo.mediaType ?? 'movie';
                },
                get currentTime() {
                    return playerStore.currentTime;
                },
                get duration() {
                    return playerStore.duration;
                },
                get isPaused() {
                    return playerStore.isPaused;
                },
                get isLive() {
                    return playerStore.isLive;
                },
            },
            {
                onDisarm: (reason) =>
                    console.warn(`[plugin-playback] subscriber disarmed: ${reason}`),
            },
        );
        playbackBridge = bridge;
        // The bridge itself decides what to deliver — it rate-limits to 2Hz and
        // fires on edges (pause/resume/item change), so calling notify on a
        // plain interval does not mean 4 deliveries a second.
        const timer = setInterval(() => bridge.notify(), 250);
        return () => {
            clearInterval(timer);
            bridge.destroy?.();
            playbackBridge = null;
        };
    });
</script>

<div
    bind:this={c.playerContainer}
    class="player-container"
    class:fullscreen={playerStore.isFullscreen}
    class:hide-cursor={!playerStore.showControls &&
        !c.isControlMenuOpen &&
        playerStore.isPlaying &&
        !playerStore.isPaused}
    onmousemove={(e) => c.handleMouseMove(e)}
    onmouseleave={() => c.handleMouseLeave()}
    use:nonpassiveWheel
    role="application"
    aria-label="Video player">
    <!-- Video element - subtitle tracks are added dynamically -->
    <video
        bind:this={c.videoElement}
        class="video-element"
        playsinline
        onplay={() => c.onPlay()}
        onplaying={() => c.onPlaying()}
        onpause={() => c.onPause()}
        ontimeupdate={() => c.onTimeUpdate()}
        onprogress={() => c.onProgress()}
        onwaiting={() => c.onWaiting()}
        onstalled={() => c.onStalled()}
        oncanplay={() => c.onCanPlay()}
        onseeking={() => c.onSeeking()}
        onseeked={() => c.onSeeked()}
        onended={() => c.onEnded()}
        onerror={() => c.onError()}
        onvolumechange={() => c.onVolumeChange()}
        onloadedmetadata={() => c.onLoadedMetadata()}
        onclick={() => c.handleVideoClick()}
        ondblclick={() => c.toggleFullscreen()}
        ontouchend={(e) => c.handleVideoTap(e)}>
        <!-- Subtitle tracks are added dynamically -->
    </video>

    <!-- Custom subtitle overlay: full-width DOM rendering for SRT/VTT when native
         ::cue is unreliable — portrait (cue overflow) and Safari (ignores ::cue
         background + mis-positions cues -> empty boxes). In those modes the native
         track is kept 'hidden' and this div renders the text instead. -->
    {#if c.useSubtitleOverlay && c.activeSrtCue}
        <TextSubtitleOverlay
            cue={c.activeSrtCue}
            inlineStyle={c.portraitSubtitleInlineStyle}
            positionY={c.effectiveSubtitleLineY} />
    {/if}

    <!-- Video Overlays (skip animation, logo, skip button, next item, toast, volume, speed, frame, seek) -->
    <VideoOverlays
        skipAnimation={c.skipAnimation}
        logoUrl={playerStore.isLive ? null : c.logoUrl}
        bind:logoLoaded={c.logoLoaded}
        showLogo={!playerStore.isLoading && (playerStore.showControls || playerStore.isPaused)}
        activeSegment={c.startupPositionResolved ? playerStore.activeSegment : null}
        nextItem={playerStore.effectiveNextItem}
        showNextItemPrompt={c.startupPositionResolved && playerStore.showNextItemPrompt}
        toast={playerStore.toast}
        volumeIndicator={c.osdIndicators.volumeIndicator}
        volumeIndicatorKey={c.osdIndicators.volumeIndicatorKey}
        speedIndicator={c.osdIndicators.speedIndicator}
        speedIndicatorKey={c.osdIndicators.speedIndicatorKey}
        frameStepIndicator={c.osdIndicators.frameStepIndicator}
        frameStepIndicatorKey={c.osdIndicators.frameStepIndicatorKey}
        seekPercentIndicator={c.osdIndicators.seekPercentIndicator}
        seekPercentIndicatorKey={c.osdIndicators.seekPercentIndicatorKey}
        autoSkipIntroEnabled={playbackPreferences.skipIntroAutomatically}
        autoSkipCreditsEnabled={playbackPreferences.skipCreditsAutomatically}
        autoPlayNextEnabled={playbackPreferences.autoplayNextEpisode}
        autoSkipCreditsDelay={playbackPreferences.nextEpisodeCountdownSeconds ??
            playbackPreferences.nextEpisodeCountdownSecondsDefault}
        autoDismissNextItemEnabled={playbackPreferences.autoDismissNextEpisodePopup}
        stillWatchingEnabled={playbackPreferences.stillWatchingEnabled}
        isWatchPartyGuest={c.isWatchPartyGuest}
        cancelTrigger={c.cancelTrigger}
        onskipsegment={() => c.skipSegment()}
        onnextitem={(e) => c.goToNextItem(e)}
        onautoskipactivechange={(active) => c.handleAutoSkipActiveChange(active)}
        onlogoload={(url) => c.log(' Logo loaded:', url)}
        onlogoerror={(url) => c.log(' Logo failed to load:', url)} />

    <!-- Autoplay Muted Prompt - shown when browser blocked autoplay with sound -->
    <AutoplayMutedPrompt
        visible={c.showAutoplayMutedPrompt}
        showTutorial={c.showAutoplayTutorial}
        onunmute={() => c.handleAutoplayUnmute()}
        ondismiss={() => c.handleAutoplayDismiss()} />

    <!-- Tab conflict modal — same-browser probe found another tab playing
         the same media. The user picks Continue (server supersedes the
         other tab) or Cancel (no-op). -->
    <TabConflictModal
        visible={c.tabConflictVisible}
        onResolve={(proceed) => c.resolveTabConflict(proceed)} />

    <!-- Overlay (loading, error, title, badges) -->
    <PlayerOverlay
        title={playerStore.fullTitle}
        isInWatchParty={watchTogether.isInWatchParty}
        capabilities={c.caps}
        itemId={c.currentPlaybackInfo.itemId}
        onback={() => {
            if (c.isActiveWatchPartyHost) {
                c.showWatchPartyBackConfirm = true;
            } else {
                props.onback?.();
            }
        }} />

    <!-- Controls: kept mounted and toggled via `visible` so the subtree
         (ProgressBar + its TrickplayLoader cache) survives auto-hide/show
         instead of being destroyed and recreated on every mouse move. -->
    <PlayerControls
        bind:this={c.playerControlsRef}
        visible={playerStore.showControls || playerStore.isPaused || playerStore.isBuffering}
        onplay={() => c.togglePlayPause()}
        onseek={(v) => c.handleSeek(v)}
        onvolume={(v) => c.handleVolume(v)}
        onmute={() => {
            playerStore.toggleMute();
            if (c.videoElement) c.videoElement.muted = playerStore.isMuted;
        }}
        onfullscreen={() => c.toggleFullscreen()}
        onpip={() => c.togglePip()}
        onairplay={() => c.toggleAirPlay()}
        airplayActive={c.isAirplayActive}
        enableAirPlay={props.enableAirPlay}
        autoQualityEnabled={props.autoQualityEnabled}
        volumeCurve={props.volumeCurve}
        onversionchange={(v) => c.handleVersionChange(v)}
        onlivequalitychange={(choice) => c.switchLiveTvQuality(choice)}
        onopenepisodebrowser={() => (c.showEpisodeBrowser = true)}
        onopenplaylistbrowser={() => (c.showPlaylistBrowser = true)}
        onopenchannelswitcher={() => (c.showChannelSwitcher = true)}
        onselectfeed={(feedId) => c.switchLiveTvFeed(feedId)}
        liveTvFeedId={c.liveTvCurrentFeedId}
        onopenmoviesidebar={() => (c.showMovieSidebar = true)}
        onopenannotations={() => (c.showAnnotationsSidebar = true)}
        showAnnotations={props.showAnnotations}
        pins={c.annotationPins}
        showAnnotationMarkers={playbackPreferences.showAnnotationMarkers}
        onopensearch={() => {
            if (c.isActiveWatchPartyHost) {
                c.showWatchPartySearch = true;
                watchTogether.broadcastActivity('searching', 'Sucht nach neuem Inhalt...');
            } else {
                c.showSearch = true;
            }
        }}
        ontogglereactions={() => (c.showReactionPicker = !c.showReactionPicker)}
        onnextepisode={() => c.goToNextEpisode()}
        onseektolive={() => c.seekToLive()} />

    <!-- Plugin player widgets.
         Guarded on there being any: with none — the case on every deployment
         that has not installed a player plugin — no overlay renders and the
         2Hz bridge below is never created, so the cost to everyone else is one
         array-length check. -->
    {#if pluginPlayerWidgets.length > 0 && playbackBridge}
        <PluginPlayerRegion
            widgets={pluginPlayerWidgets}
            user={pluginUser}
            playback={playbackBridge}
            region="top-right" />
    {/if}

    <!-- LiveTV Program Info Overlay -->
    <LiveTvOverlay />

    <!-- LiveTV Stream Failure Overlay -->
    {#if playerStore.isLive && c.liveTvFailure}
        {#if c.liveTvFailure.type === 'kicked'}
            <LiveTvKickedOverlay
                channelName={props.playbackInfo.title ?? props.playbackInfo.itemId}
                channelLogo={props.playbackInfo.itemId
                    ? liveTvLogoUrl(props.playbackInfo.itemId)
                    : undefined}
                title={c.liveTvFailure.blocked?.title}
                message={c.liveTvFailure.blocked?.message}
                onBrowseChannels={() => c.handleLiveTvSwitchChannel()} />
        {:else if c.liveTvFailure.type === 'stream_failed' && c.liveTvFailure.failure}
            <LiveTvFailureCard
                channelName={props.playbackInfo.title ?? props.playbackInfo.itemId}
                channelLogo={props.playbackInfo.itemId
                    ? liveTvLogoUrl(props.playbackInfo.itemId)
                    : undefined}
                failure={c.liveTvFailure.failure}
                simple={liveTvSimpleContext.active}
                isAdmin={pluginUser?.isAdmin === true}
                onRetry={() => c.handleLiveTvRetry()}
                onCancelRetry={() => c.handleLiveTvCancelRetry()}
                onAnotherChannel={() => void c.handleLiveTvAnotherChannel()}
                onBack={() => c.handleLiveTvSwitchChannel()} />
        {:else if c.liveTvFailure.type !== 'stream_failed'}
            <StreamFailureOverlay
                channelName={props.playbackInfo.title ?? props.playbackInfo.itemId}
                channelLogo={props.playbackInfo.itemId
                    ? liveTvLogoUrl(props.playbackInfo.itemId)
                    : undefined}
                failureType={c.liveTvFailure.type}
                diagnostic={c.liveTvFailure.diagnostic}
                onRetry={() => c.handleLiveTvRetry()}
                onSwitchChannel={() => c.handleLiveTvSwitchChannel()} />
        {/if}
    {/if}

    <!-- Watch Together Overlay (disabled for LiveTV) -->
    {#if !playerStore.isLive}
        <!-- Audio-only and watch parties are mutually exclusive — hide the
             watch-together control while audio-only is active, so it can't be
             used to START a party. Never hide it while ALREADY in a party:
             the popup panel (WatchTogetherOverlay) holds the only guest-facing
             "Leave" button, and the mutual-exclusion revert in
             watchTogether.svelte.ts (applyAudioOnlyPartyExclusion) already
             takes qualityMode back out of 'audio-only' as soon as a party is
             joined — this OR keeps the control reachable in the brief window
             before that revert lands, instead of trapping the user. -->
        {#if playerStore.qualityMode !== 'audio-only' || watchTogether.isInWatchParty}
            <WatchPartyAvatarCluster
                isInParty={watchTogether.isInWatchParty}
                participants={watchTogether.watchPartyParticipants}
                currentUserId={props.userId}
                hostUserId={watchTogether.session?.host.userId}
                avatarUrl={props.avatarUrl}
                displayName={props.username}
                isOpen={c.watchPartyPanelOpen}
                ontoggle={() => c.toggleWatchPartyPanel()}
                onclose={() => c.closeWatchPartyPanel()}>
                <WatchTogetherOverlay
                    itemId={c.currentPlaybackInfo.itemId}
                    mediaType={c.currentPlaybackInfo.mediaType}
                    title={playerStore.fullTitle}
                    userId={props.userId}
                    fileId={playerStore.currentMediaSource?.id}
                    isOpen={c.watchPartyPanelOpen} />
            </WatchPartyAvatarCluster>
        {/if}

        <!-- Watch Together Toast Notifications -->
        <WatchTogetherToast bind:this={c.watchTogetherToast} />

        <!-- Watch Party Reactions -->
        {#if watchTogether.isInWatchParty}
            <ReactionOverlay bind:showPicker={c.showReactionPicker} />
            <ScreenEffectsOverlay playerContainer={c.playerContainer} />
        {/if}

        <!-- Pinned sync status: top-right under the avatar, visible for guests even
             when the controls are hidden. Hidden while the panel is open — the
             panel drops into this spot and shows the status itself. -->
        {#if watchTogether.isInWatchParty && !watchTogether.isWatchPartyHost && watchPartySyncPin.pinned && !c.watchPartyPanelOpen}
            <SyncStatusIndicator standalone />
        {/if}

        <!-- Watch-party guest end-of-video affordance. Guests can't advance (only
             the host controls navigation), so instead of a dead-end frozen frame
             show a passive "waiting for the host" card — covers both end-of-episode
             (next item available) and end-of-movie. -->
        {#if c.isWatchPartyGuest && playerStore.hasEnded}
            <div class="wp-waiting" role="status" aria-live="polite">
                <div class="wp-waiting-spinner" aria-hidden="true"></div>
                <div class="wp-waiting-text">
                    <span class="wp-waiting-title">
                        {watchTogether.session?.host.displayName
                            ? m.watch_party_waiting_for_host({
                                  host: watchTogether.session.host.displayName,
                              })
                            : m.watch_party_waiting_for_host_generic()}
                    </span>
                    <span class="wp-waiting-sub">
                        {playerStore.effectiveNextItem
                            ? m.watch_party_waiting_next_episode()
                            : m.watch_party_waiting_pick_next()}
                    </span>
                </div>
            </div>
        {/if}
    {/if}

    <!-- Channel Switcher (LiveTV only) -->
    <ChannelSwitcher
        isOpen={c.showChannelSwitcher}
        currentChannelId={props.playbackInfo.itemId}
        onclose={() => (c.showChannelSwitcher = false)}
        onselectchannel={(ch) => c.handleSelectChannel(ch)} />

    <!-- Movie Sidebar (Movies only) -->
    {#if moviePanel.component}
        {@const MovieSidebar = moviePanel.component}
        <MovieSidebar
            isOpen={c.showMovieSidebar}
            onseek={(seconds) => c.handleSeek(seconds)}
            itemId={props.playbackInfo.itemId}
            readOnly={c.hasWatchPartyGuestRestrictions}
            onclose={() => (c.showMovieSidebar = false)}
            onabandon={() => {
                if (c.videoElement) {
                    c.videoElement.pause();
                }
                props.onback?.();
            }}
            onplaymovie={(data) => c.handlePlayMovie(data)} />
    {/if}

    <!-- Episode Browser (Episodes only) -->
    {#if isEpisodeType(props.playbackInfo.mediaType) && props.playbackInfo.seriesId}
        {#if episodePanel.component}
            {@const EpisodeBrowser = episodePanel.component}
            <EpisodeBrowser
                seriesId={props.playbackInfo.seriesId}
                currentSeasonNumber={c.currentPlaybackInfo.seasonNumber || 1}
                currentEpisodeId={c.currentPlaybackInfo.itemId}
                seriesName={props.playbackInfo.seriesName || ''}
                isOpen={c.showEpisodeBrowser}
                readOnly={c.hasWatchPartyGuestRestrictions}
                onclose={() => (c.showEpisodeBrowser = false)}
                onselectepisode={(ep) => c.handleSelectEpisode(ep)} />
        {/if}
    {/if}

    <!-- Playlist Browser (Playlist mode only) -->
    {#if playerStore.isPlaylistMode && playerStore.playlistContext}
        {#if playlistPanel.component}
            {@const PlaylistBrowser = playlistPanel.component}
            <PlaylistBrowser
                playlistId={playerStore.playlistContext.playlistId}
                currentPosition={playerStore.playlistContext.currentPosition}
                currentItemId={c.currentPlaybackInfo.itemId}
                playlistName={playerStore.playlistContext.playlistName}
                isOpen={c.showPlaylistBrowser}
                readOnly={c.hasWatchPartyGuestRestrictions}
                onclose={() => (c.showPlaylistBrowser = false)}
                onselectitem={(item) => c.handleSelectPlaylistItem(item)} />
        {/if}
    {/if}

    <!-- Annotations Sidebar (Community chat + timestamp pins) -->
    {#if props.showAnnotations}
        <AnnotationsSidebar
            isOpen={c.showAnnotationsSidebar}
            mediaId={c.currentMediaDbId ?? c.currentPlaybackInfo.itemId}
            mediaTitle={props.annotationsMediaTitle}
            currentTime={playerStore.currentTime}
            username={props.username}
            showChat={props.showChat ?? false}
            maxPins={props.annotationsMaxPins}
            isAdmin={props.annotationsIsAdmin}
            showAnnotationMarkers={playbackPreferences.showAnnotationMarkers}
            autoShowAnnotations={playbackPreferences.autoShowAnnotations}
            onclose={() => (c.showAnnotationsSidebar = false)}
            onseek={(t) => c.seekTo(t)}
            onpinmarkers={(pins) => (c.annotationPins = pins)} />
        <AnnotationPopup
            currentTime={playerStore.currentTime}
            duration={playerStore.duration}
            pins={c.annotationPins}
            enabled={playbackPreferences.autoShowAnnotations} />
    {/if}

    <!-- Watch Party Host Back Confirmation Dialog -->
    <WatchPartyBackDialog
        isOpen={c.showWatchPartyBackConfirm}
        onclose={() => (c.showWatchPartyBackConfirm = false)}
        onsearch={() => {
            c.showWatchPartyBackConfirm = false;
            c.showWatchPartySearch = true;
            watchTogether.broadcastActivity('searching', m.watch_party_searching_activity());
        }}
        onleave={async () => {
            c.showWatchPartyBackConfirm = false;
            await watchTogether.leaveSession();
            props.onback?.();
        }} />

    {#if searchPanel.component}
        {@const Search = searchPanel.component}
        <!-- Watch Party Search (for selecting new content) -->
        <Search
            playerMode={true}
            bind:isOpen={c.showWatchPartySearch}
            watchPartyMode={true}
            onclose={() => {
                c.showWatchPartySearch = false;
                if (c.isActiveWatchPartyHost) {
                    watchTogether.broadcastActivity('watching');
                }
            }}
            onselectitem={(item) => c.handleWatchPartySearchSelect(item)} />

        <!-- General Search (for browsing other content when not in watch party or not a guest) -->
        <Search
            playerMode={true}
            bind:isOpen={c.showSearch}
            onclose={() => (c.showSearch = false)}
            onselectitem={(item) => c.handleSearchSelect(item)} />
    {/if}

    <!-- Shell rail injection point — shells supply their own rail snippet here
         (lesson list, event clip strip, etc.). When absent, the existing
         EpisodeBrowser / PlaylistBrowser above already handle the VOD rails. -->
    {#if props.rail}
        {@render props.rail()}
    {/if}
</div>

<!-- Below-fold shell injection — event context strip, resource tabs, metadata. -->
{#if props.belowFold}
    {@render props.belowFold()}
{/if}

<style>
    .player-container {
        position: relative;
        width: 100%;
        height: 100%;
        background-color: #000;
        overflow: hidden;
        user-select: none;
    }

    .player-container.hide-cursor,
    .player-container.hide-cursor * {
        cursor: none !important;
    }

    .player-container.fullscreen {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        /* Use dvh for dynamic viewport that adjusts for browser URL bar */
        height: 100dvh;
        z-index: 9000; /* Z.PLAYER */
    }

    /* Mobile fullscreen - account for safe areas (notch, home indicator) */
    @media (max-width: 920px) {
        .player-container.fullscreen {
            /* Ensure the player fills the full dynamic viewport */
            height: 100dvh;
            /* Padding for safe areas handled by child components */
        }
    }

    .video-element {
        width: 100%;
        height: 100%;
        object-fit: contain;
        cursor: pointer;
        /* Positioned (with no offsets, so layout is unaffected) so it can be
           compared via a normal z-index against AudioOnlyBackdrop, which
           needs to paint behind it — including its native <track> cue layer
           — while audio-only. Was previously unpositioned, which is what let
           the backdrop (any positioned z-index:auto sibling) paint above it
           regardless of DOM order. See the z-index comment on
           AudioOnlyBackdrop.svelte's .audio-only-backdrop for the full
           picture.

           Local tier scale for direct children of .player-container that sit
           at/near this stack level (no stacking context on .player-container
           itself, so these compare via plain z-index): 0 = AudioOnlyBackdrop,
           1 = this video, 2 = PlayerOverlay's .top-overlay/.center-overlay,
           3 = PlayerControls' .controls-container. ANY positioned descendant
           of .player-container left at z-index:auto paints BEHIND this video
           (CSS painting-order step 6 vs step 7) and silently swallows clicks
           even though it's visually drawn on top — this bit PlayerControls'
           .controls-container and PlayerOverlay's .top-overlay/.center-overlay
           once already (see git history), so give any new overlay/control
           layer here an explicit z-index >= 2 rather than leaving it auto.
           Layers already far above this tier (toasts, sidebars, modals —
           mostly z-index >= 5, many using Z.PLAYER_* from $lib/utils/z-index)
           are unaffected and need no change. */
        position: relative;
        z-index: 1;
    }

    /* AkariSub (ASS/SSA subtitle renderer) creates its own wrapper div as a
       sibling of .video-element and never sets a z-index on it — left at the
       default z-index:auto it paints in CSS painting-order step 6, behind
       .video-element's step 7 (see the tier comment above), so subtitles sit
       behind the video the instant a real frame is opaque. Same local tier
       rule as everything else here: >= 2. */
    :global(.AkariSub) {
        z-index: 2;
    }

    /* libbitsub (PGS/VobSub) mounts its canvas next to .video-element with an
       inline z-index of 10, which put image subtitles above PlayerControls'
       .controls-container (tier 3) and so over the trickplay hover preview.
       Subtitles belong on the overlay tier (2), under the control bar; the
       inline style needs !important to override. SubtitleRenderer tags the
       canvas with data-libbitsub-owner when it is added. */
    :global(canvas[data-libbitsub-owner]) {
        z-index: 2 !important;
    }

    /* Subtitle styling is now dynamically generated via svelte:head
       based on user preferences in SubtitleStyleSelector */

    /* Watch-party guest "waiting for the host" card (end of video) */
    .wp-waiting {
        position: absolute;
        left: 50%;
        bottom: 15%;
        transform: translateX(-50%);
        z-index: 45;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        max-width: min(420px, 90vw);
        padding: 0.85rem 1.25rem;
        background: rgba(0, 0, 0, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        backdrop-filter: blur(6px);
        pointer-events: none;
    }

    .wp-waiting-spinner {
        flex-shrink: 0;
        width: 22px;
        height: 22px;
        border: 2.5px solid rgba(139, 92, 246, 0.25);
        border-top-color: #a855f7;
        border-radius: 50%;
        animation: wp-waiting-spin 0.9s linear infinite;
    }

    @keyframes wp-waiting-spin {
        to {
            transform: rotate(360deg);
        }
    }

    .wp-waiting-text {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        text-align: left;
    }

    .wp-waiting-title {
        font-size: 0.95rem;
        font-weight: 600;
        color: #fff;
    }

    .wp-waiting-sub {
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.65);
    }
</style>
