<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	MediaPreviewPlayer.svelte

	Lightweight video player for preview-only playback (Continue Watching, Next Up).
	Shows video at resume position with minimal controls (mute button only).

	Features:
	- HLS.js streaming support
	- Position tracking for seamless resume handoff
	- Auto-cleanup on unmount
	- Error fallback to backdrop image

	@example
	<MediaPreviewPlayer
		itemId={item.id}
		jellyfinId={item.mediaId}
		startPositionSeconds={resumePosition}
		muted={true}
		onTimeUpdate={(time) => handleTimeUpdate(time)}
		onError={(error) => handleError(error)}
		onCleanup={() => cleanupSession()}
	/>
-->
<script lang="ts">
    import { onMount, onDestroy, untrack } from 'svelte';
    import { PREVIEW_KEEPALIVE_INTERVAL_MS } from '$lib/shared/preview-heartbeat.js';
    import { getStreamInfoWithLimitCheck, leaveChannel } from '$lib/api/livetv-playback.js';
    import { LiveTvHeartbeat } from '$lib/components/player/livetv-heartbeat.js';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import type Hls from 'hls.js';
    import type { ErrorData } from 'hls.js';
    import { requireValue } from '$lib/utils/runtime-validation';
    import {
        createPreviewSession as apiCreatePreviewSession,
        releasePreviewPlayback,
    } from '$lib/api/playback.js';
    import { decideHoverLoopCap, readHoverMaxSeconds } from './media-preview-hover-cap';
    import { isPreviewReadyFromNetworkDetails } from './media-preview-network-readiness';
    import { buildPreviewHlsConfig, shouldRetainBackBuffer } from './preview-hls-config';
    import { NoTrailerSignal } from './media-preview-no-trailer-signal';
    import { previewAudio, nextPreviewAudioId } from '$lib/stores/preview-audio.svelte';
    import { PREVIEW_FALLBACK_START_SECONDS } from '$lib/utils/video-player-utils';
    import {
        previewSessionKey,
        acquirePreviewSession,
        releasePreviewSession,
        invalidatePreviewSession,
        markPreviewSessionReady,
        type PreviewSessionHandle,
        type PreviewSessionValue,
    } from '$lib/utils/preview-session-cache';

    // =========================================================================
    // Props
    // =========================================================================

    interface Props {
        /**
         * Internal media ID. Optional because some hero surfaces (e.g. a
         * server-driven Featured Pick item) carry only `externalIds.internal`
         * and no top-level `id` — the player then falls back to `internalId`
         * for the API path instead of rendering a literal "undefined" URL.
         */
        itemId?: string;
        /** Media provider item ID (e.g. Jellyfin UUID) */
        jellyfinId?: string;
        /** Internal UUID (alternative to jellyfinId) */
        internalId?: string;
        /** Specific file ID to use for multi-file items */
        fileId?: string;
        /** Start position in seconds */
        startPositionSeconds: number;
        /**
         * Total runtime in seconds, when known. Used ONLY to stop the
         * studio-logo skip floor from seeking past the end of short content —
         * the server does not clamp seek to duration (preview-session.service
         * takes startPositionSeconds verbatim), so an over-long seek yields a
         * black frame or an instantly-ending preview.
         */
        durationSeconds?: number;
        /** Whether this is a live TV channel (enables strict rate limiting) */
        isLiveTv?: boolean;
        /**
         * Station descriptor URL for standalone live TV channels.
         * When set, starts a Live TV playback session for the station and retains
         * its handle for heartbeat and teardown.
         */
        nativeStreamUrl?: string;
        /** Whether preview should be muted */
        muted?: boolean;
        /** Show the mute overlay on the video. Off when the parent has its
         *  own mute button (hover card), so there aren't two. */
        showMuteButton?: boolean;
        /**
         * Shared audio-owner id. When a controlling parent (hero, hover card)
         * mounts this player it passes its own id so the parent's mute button
         * and this player's mute button toggle the SAME exclusive-audio owner.
         * When omitted (standalone use) the player mints its own id.
         */
        audioOwnerId?: string;
        /**
         * Loop the preview snippet. When true the clip seeks back to its start
         * once it ends (or once `durationCapSeconds` elapses) instead of
         * stopping. Used by the homepage hero for an endless ambient clip.
         */
        loop?: boolean;
        /**
         * Optional bound (in seconds of source playback) on how long the clip
         * plays before it restarts. When set, on each timeupdate past
         * `sourceSeekSeconds + durationCapSeconds` the video seeks back to the
         * playlist start, producing a bounded repeating clip. Ignored unless
         * `loop` is also true.
         */
        durationCapSeconds?: number;
        /**
         * Force the most compatible codec (h264/AAC) on the server for a shared
         * hero preview. Forwarded to POST /playback/previews as `heroSafeCodec`.
         */
        heroSafeCodec?: boolean;
        /** Ask the server for the item's local trailer (full-length) instead of a snippet. */
        trailerPreferred?: boolean;
        /** With trailerPreferred: server answers mode 'none' when no trailer exists. */
        trailerRequired?: boolean;
        /** Fired when the server answered mode 'none' (no local trailer). */
        onNoTrailer?: () => void;
        /** Fired once the preview session is created, with the RESOLVED item id
         *  the session actually plays (for trailer mode: the trailer child's own
         *  UUID — lets callers offer "open in full player"). */
        onSessionResolved?: (sessionItemId: string) => void;
        /** Fired when non-looping playback reaches the end (trailer finished). */
        onEnded?: () => void;
        /** How the video fills its box: ambient previews crop (cover, default);
         *  full-attention playback (trailer overlay) letterboxes (contain). */
        objectFit?: 'cover' | 'contain';
        /** Callback when playback position updates */
        onTimeUpdate?: (currentTime: number) => void;
        /** Callback when error occurs */
        onError?: (error: string) => void;
        /**
         * Callback when the hover preview reaches its total time limit
         * (`PREVIEW_HOVER_MAX_SECONDS`) and is no longer actively hovered.
         * This is a benign, expected transition — the parent should swap the
         * video back to the backdrop WITHOUT logging an error. Separate from
         * `onError` precisely so a normal cap-expiry produces no error logs.
         */
        onExpire?: () => void;
        /** Callback when cleanup should happen */
        onCleanup?: () => void;
        /** Callback the first time the video element actually starts playing */
        onPlaying?: () => void;
        /**
         * Backdrop/still image shown underneath the video while the preview
         * session loads and as a silent fallback when it errors. The video
         * fades in over it, so the popup never shows a bare black box.
         */
        backdropUrl?: string;
    }

    let {
        itemId,
        jellyfinId,
        internalId,
        fileId,
        startPositionSeconds,
        durationSeconds,
        isLiveTv = false,
        nativeStreamUrl,
        muted = true,
        showMuteButton = true,
        audioOwnerId,
        loop = false,
        durationCapSeconds,
        heroSafeCodec,
        trailerPreferred = false,
        trailerRequired = false,
        objectFit = 'cover',
        onNoTrailer,
        onSessionResolved,
        onEnded,
        onTimeUpdate,
        onError,
        onExpire,
        onCleanup,
        onPlaying,
        backdropUrl,
    }: Props = $props();

    // =========================================================================
    // Internal State
    // =========================================================================

    let videoElement = $state<HTMLVideoElement | null>(null);
    let hls: Hls | null = null;
    let isLoading = $state(true);
    let hasError = $state(false);
    let errorMessage = $state('');

    // Exclusive-audio ownership. This player is audible only while it owns audio;
    // unmuting it claims ownership (silencing every other preview/hero), muting
    // or unmounting releases it. A controlling parent may pass a shared id so its
    // mute button and ours drive the same owner; otherwise we mint our own.
    // The owner id is fixed for this player's lifetime — capture the prop's
    // initial value once (untrack avoids a "captures initial value" warning) and
    // fall back to a freshly-minted id when used standalone.
    const audioId = untrack(() => audioOwnerId) ?? nextPreviewAudioId('preview');
    let isMuted = $derived(!previewAudio.owns(audioId));

    // Keep the actual <video> element in sync with ownership: whenever this player
    // loses (or gains) audio ownership — including when ANOTHER player claims it —
    // apply the muted state to the element.
    $effect(() => {
        if (videoElement) videoElement.muted = isMuted;
    });
    let playSessionId = $state<string | null>(null);
    // Handle into the client-side preview-session memo (Task 8,
    // `$lib/utils/preview-session-cache`). Owns the lifecycle of the memo
    // entry backing `playSessionId`/`streamUrl` below — acquired in
    // `createPreviewSession`, marked ready once the manifest confirms the
    // artifact is playable, invalidated before a self-heal recreate, and
    // released (never raw-deleted) everywhere this component is done with
    // the session. Null whenever no session is currently held (including the
    // `mode === 'none'` no-trailer case, which never acquires one).
    let sessionHandle: PreviewSessionHandle | null = null;
    // Id used in every /api/playback/{id}/... path. Falls back to internalId
    // when the caller has no top-level item id (id-less Featured Pick items
    // used to POST to a literal "/api/playback/undefined/preview-session").
    const apiItemId = untrack(() => itemId ?? internalId ?? '');
    let sessionItemId = $state(apiItemId);
    let streamUrl = $state<string | null>(null);
    let deliveryKind: 'file' | 'hls' = 'hls';
    let fadeIn = $state(false);
    // Backdrop layer under the video (loading/error fallback). Hidden only
    // when the image itself fails to load — the video simply covers it once
    // it fades in, so we never unmount it (avoids a black flash mid-fade).
    let backdropFailed = $state(false);
    // The backdrop underlay exists for the LOADING phase (no black box while
    // the session spins up). Once the video has actually faded in (fadeIn is
    // one-way), the layer is removed permanently for this player instance —
    // a live, playing video must never be covered by its own still image
    // again (the "backdrop reappears over the video" bug, 2026-07-17). Error
    // fallback after playback started is the PARENT's swapToBackdrop, which
    // itself refuses to cover a still-playing video.
    const showBackdrop = $derived(!!backdropUrl && !backdropFailed && !fadeIn);
    // Delivery start position in seconds: file-absolute for files, playlist-relative for HLS.
    // An HLS preview playlist is FFmpeg's raw output starting at the seek point, so segment 0
    // already contains the resume frame — start position 0 plays it. We do NOT
    // pass the absolute seek time here: the playlist only spans the few seconds
    // FFmpeg has produced so far, and any value outside that range silently
    // collapses to the wrong start position.
    let hlsStartPosition = 0;
    // Where FFmpeg seeked the source. video.currentTime is playlist-relative
    // (0 = first segment = the seek frame), so absolute source time =
    // sourceSeekSeconds + video.currentTime. Used by the preview→full-player
    // handoff so the parent receives absolute time directly.
    let sourceSeekSeconds = 0;

    // Position update tracking (throttled to 1 second)
    let lastUpdateTime = 0;
    const UPDATE_INTERVAL = 1000; // ms

    // Heartbeat tracking (keep session alive)
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    // Set in onDestroy. Guards the async continuations in createPreviewSession
    // that resolve AFTER the component is torn down — e.g. a hover preview whose
    // POST /playback/previews is still in flight when the user un-hovers, the hero
    // rotates, or the user presses Play. Without this the continuation would set
    // playSessionId and arm a 10s heartbeat on a dead component, leaking an
    // orphaned server-side preview session (and its ffmpeg) that PATCHes forever.
    let destroyed = false;
    const HEARTBEAT_INTERVAL = PREVIEW_KEEPALIVE_INTERVAL_MS;

    // Safari native-HLS readiness: the initial poll in initializePlayer only
    // ever samples the master playlist ONCE, before playback starts — an
    // artifact that finishes warming mid-playback is never observed, so the
    // memo never learns it is safe to retain (see checkSafariReadinessOnce
    // below). Guards a single one-shot re-check per session so repeated
    // `ontimeupdate` firing does not spam the server with HEAD requests.
    let safariReadinessRechecked = false;

    // =========================================================================
    // HLS fatal-error retry caps
    // =========================================================================
    // Without a cap, HLS.js's own internal manifest-retry backoff (see
    // `manifestLoadingMaxRetryTimeout: 10000` below) exhausts after ~10s and
    // re-fires a fatal NETWORK_ERROR; the old handler called `hls.startLoad()`
    // unconditionally on every fatal NETWORK_ERROR, re-arming that same ~10s
    // internal retry cycle forever — this was the "Fatal HLS error every ~10s
    // for the whole session" bug. MEDIA_ERROR had the same unconditional-retry
    // shape via `recoverMediaError()`. Cap both, then treat the error as
    // terminal (cleanup once, notify parent) once the cap is exceeded.
    const MAX_NETWORK_ERROR_RETRIES = 2;
    const MAX_MEDIA_ERROR_RETRIES = 2;
    let networkErrorRetryCount = 0;
    let mediaErrorRetryCount = 0;
    // One-shot self-heal: when the in-instance retries are exhausted, re-create
    // the WHOLE session (fresh POST → new stream URL → new hls attach) once
    // before surrendering to the backdrop. Covers the cases where the stream
    // itself is dead but a new session would work immediately — a deploy roll
    // resetting in-flight segment connections, a server-side session loss, a
    // stale artifact. Without this, a viewer mid-preview during a deploy always
    // ends on the backdrop even though a re-hover would play fine.
    let sessionRecreateAttempted = false;
    // Guards against double-teardown: once a fatal error is handled as
    // terminal for this hls instance, ignore any further ERROR events that
    // might still be in flight (e.g. queued before `hls.destroy()` completes).
    let hlsFatalHandled = false;
    // Only the FIRST fatal HLS error per source is logged at error level;
    // repeats during the bounded retry window are logged at debug level so a
    // real production console isn't spammed while still preserving the signal
    // for local debugging.
    let fatalErrorLogCount = 0;

    /** Reset the retry/log counters once real playback resumes. */
    function resetHlsErrorState(): void {
        networkErrorRetryCount = 0;
        mediaErrorRetryCount = 0;
        fatalErrorLogCount = 0;
    }

    function logFatalHlsError(data: ErrorData): void {
        fatalErrorLogCount++;
        if (fatalErrorLogCount === 1) {
            console.error('[MediaPreviewPlayer] Fatal HLS error:', data);
        } else {
            console.debug('[MediaPreviewPlayer] Fatal HLS error (retrying):', data);
        }
    }

    // =========================================================================
    // Hover-loop total-time cap (PREVIEW_HOVER_MAX_SECONDS)
    // =========================================================================
    // Fallback used only when `page.data.hover.maxSeconds` hasn't hydrated yet
    // (e.g. very first paint) — mirrors the PREVIEW_HOVER_MAX_SECONDS schema
    // default. The server config value (threaded via +layout.server.ts) is
    // always the source of truth once available.
    const DEFAULT_HOVER_MAX_SECONDS = 60;

    let hoverMaxSeconds = $derived(
        readHoverMaxSeconds($page.data?.hover, DEFAULT_HOVER_MAX_SECONDS),
    );

    // This cap only governs the (non-hero) hover-card preview. The homepage
    // hero passes `loop` explicitly for its own intentionally-unbounded
    // ambient background (bounded only by `durationCapSeconds` per replay,
    // never by a total cap) — that existing behavior must not regress. Live
    // TV streams are excluded too: their HLS playlist doesn't "end" the same
    // way a short transcoded snippet does, and seeking back to position 0 on
    // a live stream doesn't make sense.
    let hoverCapActive = $derived(!loop && !isLiveTv && !trailerPreferred && hoverMaxSeconds > 0);

    // Wall-clock start of the CURRENT hover-cap window (ms). 0 until playback
    // actually starts; reset to "now" each time the window re-arms because
    // the viewer is still actively hovering when the cap is reached.
    let hoverCapWindowStartedAt = 0;

    // Local, narrow hover signal: is the pointer currently resting on THIS
    // preview's own DOM? Distinct from the parent MediaHoverCard's popup-wide
    // hover state (which can stay "open" while the pointer has moved off the
    // video onto the title/actions area below it) — deliberately not wired
    // through a prop so this feature needs no MediaHoverCard changes.
    // Defaults true: the popup is shown centered over the element the user
    // was already hovering, so the pointer is over this area at mount time.
    // NOTE: this default can be stale until the first pointerenter/leave
    // crossing fires; MediaHoverCard's coarser ~150ms unhover teardown is the
    // backstop that guarantees the preview is torn down when the popup closes.
    let isPointerOverPreview = $state(true);

    // Start the hover-cap window the first time the video is actually shown
    // (fadeIn only ever transitions false -> true, so this fires once).
    $effect(() => {
        if (fadeIn && hoverCapWindowStartedAt === 0) {
            hoverCapWindowStartedAt = Date.now();
        }
    });

    // =========================================================================
    // Session Creation
    // =========================================================================

    /**
     * The memo's `onDelete`: fires when an entry this component (or a peer
     * holder sharing its key) acquired is actually torn down — immediately
     * on last release for a session that never reached "ready", or after the
     * retention window for one that did. Deliberately takes the `value`
     * handed back by the memo rather than closing over component state, so
     * it deletes the RIGHT session even if this component has since moved on
     * to a different one.
     */
    function deletePreviewSessionOnServer(value: PreviewSessionValue): void {
        releasePreviewPlayback(value.playSessionId);
    }

    /**
     * Shared readiness check for every hls.js loader event whose response can
     * carry `X-Lumastra-Preview-Static`: the header is set only when the
     * artifact's `.ready` marker exists, so it is our readiness signal (only
     * a ready session is worth retaining — a warming one still has a live
     * FFmpeg job behind it). It is emitted on the master playlist, the media
     * playlist, AND segment responses
     * (`lumastra-segment-handler.ts:268/279/305`) — an artifact that finishes
     * transcoding mid-playback is only ever observed via a LATER load, so
     * sampling only the master playlist (MANIFEST_LOADED) would silently
     * miss it and delay the caching win by a whole extra revisit. Called from
     * both MANIFEST_LOADED and LEVEL_LOADED (the media-playlist load).
     *
     * The header→ready decision itself lives in
     * `isPreviewReadyFromNetworkDetails` (`./media-preview-network-readiness`)
     * so it is unit-testable directly — happy-dom has no `MediaSource`, so
     * this hls.js code path cannot be driven through a mounted component
     * test the way the Safari native-HLS readiness call site can. Calling
     * the SAME function the component ships keeps that test honest.
     * `markPreviewSessionReady` itself is idempotent, so calling this from
     * multiple loader events for the same session is harmless.
     */
    function markReadyFromNetworkDetails(networkDetails: unknown): void {
        if (isPreviewReadyFromNetworkDetails(networkDetails) && sessionHandle) {
            markPreviewSessionReady(sessionHandle);
        }
    }

    /**
     * Safari/iOS native-HLS twin of `markReadyFromNetworkDetails` above.
     *
     * The native-HLS branch in `initializePlayer` samples the master
     * playlist's `X-Lumastra-Preview-Static` header exactly ONCE, via a poll
     * loop that runs and exits BEFORE `videoElement.src` is even set — so a
     * first-ever play of an artifact that is still warming at that point
     * never gets sampled again, and the session-reuse memo never learns it
     * became safe to retain. hls.js gets a second look via LEVEL_LOADED
     * (the media-playlist load, which happens throughout playback); native
     * HLS has no equivalent hook, so this does one more HEAD request after
     * playback has actually started (first `ontimeupdate`, see
     * `handleTimeUpdate`) and reuses the SAME `markPreviewSessionReady` call
     * the hls.js path bottoms out on. `safariReadinessRechecked` makes this
     * fire at most once per session; `destroyed`/`sessionHandle` make it a
     * no-op if the component tore down (or the session was invalidated)
     * while the request was in flight.
     */
    async function checkSafariReadinessOnce(): Promise<void> {
        if (safariReadinessRechecked || !streamUrl || !sessionHandle) return;
        safariReadinessRechecked = true;
        try {
            const res = await fetch(streamUrl, {
                method: 'HEAD',
                signal: AbortSignal.timeout(500),
            });
            if (destroyed) return; // torn down while the HEAD was in flight
            if (res.ok && res.headers.get('X-Lumastra-Preview-Static') && sessionHandle) {
                markPreviewSessionReady(sessionHandle);
            }
        } catch {
            /* expected: HEAD request may fail on network error or timeout — this is a
               best-effort re-sample, not required for playback, so just drop it */
        }
    }

    let liveTvHeartbeat: LiveTvHeartbeat | null = null;

    async function createPreviewSession(): Promise<void> {
        safariReadinessRechecked = false;
        try {
            // Standalone live TV path: fetch stream info from the native endpoint,
            // then play the returned HLS URL and retain the session handle.
            if (nativeStreamUrl) {
                const stationId = internalId ?? itemId ?? nativeStreamUrl.split('/').pop();
                if (!stationId) throw new Error('Live TV station is unavailable');
                const result = await getStreamInfoWithLimitCheck(
                    stationId,
                    'server',
                    undefined,
                    undefined,
                    'preview',
                );
                if (!result.ok) throw new Error('Live TV preview unavailable');
                const info = result.streamInfo;
                if (destroyed) {
                    void leaveChannel(info.playbackSessionId);
                    return;
                }
                streamUrl = info.delivery.url;
                deliveryKind = 'hls';
                hlsStartPosition = 0;
                liveTvHeartbeat = new LiveTvHeartbeat(
                    info,
                    info.reporting.intervalMs,
                    () =>
                        void handleErrorWithCleanup(
                            new Error('Live TV preview session expired'),
                            'Live TV preview unavailable',
                        ),
                    undefined,
                    () =>
                        void handleErrorWithCleanup(
                            new Error('Live TV preview taken over'),
                            'Live TV preview unavailable',
                        ),
                    undefined,
                    async () => {
                        if (destroyed || streamUrl === info.delivery.url) return;
                        streamUrl = info.delivery.url;
                        await initializePlayer();
                    },
                );
                await initializePlayer();
                return;
            }

            // Skip ahead if starting from the beginning to avoid studio logos
            // and opening beats in previews. The old floor was a flat 30s, which
            // is INSIDE the distributor logo window for most movies (they run
            // 30-90s) — that was the whole bug. Callers normally hand us a
            // runtime-proportional position already; this only catches the
            // no-runtime case.
            // BUT: Live TV must start from 0 (current live position, can't seek)
            // Trailers always start from 0 too — there's no "resume point" to
            // skip past for a full-length trailer.
            const flooredStartPosition =
                startPositionSeconds < PREVIEW_FALLBACK_START_SECONDS
                    ? PREVIEW_FALLBACK_START_SECONDS
                    : startPositionSeconds;
            // Never seek past the midpoint of content whose length we know:
            // the floor above is a blind constant and would overshoot anything
            // shorter than ~2 minutes.
            const cappedStartPosition =
                durationSeconds && durationSeconds > 0
                    ? Math.min(flooredStartPosition, Math.floor(durationSeconds / 2))
                    : flooredStartPosition;
            const effectiveStartPosition = trailerPreferred
                ? 0
                : isLiveTv
                  ? 0
                  : cappedStartPosition;
            sourceSeekSeconds = effectiveStartPosition;

            // Built from EXACTLY the POST body fields below (same 7 fields,
            // same values) — see `previewSessionKey`'s own doc comment for why
            // `transcodeMode` must stay out of both if it's ever added to the
            // body.
            const memoKey = previewSessionKey({
                internalId: internalId ?? apiItemId,
                startPositionSeconds: effectiveStartPosition,
                fileId,
                isLiveTv,
                heroSafeCodec,
                trailerPreferred,
                trailerRequired,
            });

            let handle: PreviewSessionHandle;
            try {
                handle = await acquirePreviewSession(
                    memoKey,
                    async (): Promise<PreviewSessionValue> => {
                        const {
                            data,
                            error: previewError,
                            status,
                        } = await apiCreatePreviewSession(apiItemId, {
                            startPositionSeconds: effectiveStartPosition,
                            // Both props are optional; `apiItemId` above already
                            // resolves the same fallback chain and is always a
                            // string.
                            internalId: internalId ?? apiItemId,
                            fileId,
                            isLiveTv,
                            heroSafeCodec,
                            trailerPreferred,
                            trailerRequired,
                        });

                        if (previewError || !data) {
                            const err = new Error(
                                previewError ?? `HTTP ${status ?? 0}`,
                            ) as Error & { status?: number };
                            err.status = status;
                            throw err;
                        }

                        // Narrow the create-response union BEFORE touching any
                        // session fields (playSessionId/streamUrl only exist on
                        // the non-'none' member). No local trailer exists for
                        // this item — throw a sentinel so `acquirePreviewSession`
                        // never stores an entry with no server session behind
                        // it (see the doc comment in media-preview-no-trailer-signal.ts).
                        if (data.mode === 'none') {
                            throw new NoTrailerSignal();
                        }

                        return {
                            playSessionId: data.playSessionId,
                            sessionItemId: data.sessionItemId ?? apiItemId,
                            streamUrl: data.streamUrl,
                            // Dedicated previews return HLS; retain an explicitly issued file.
                            deliveryKind:
                                'deliveryKind' in data && data.deliveryKind === 'file'
                                    ? ('file' as const)
                                    : ('hls' as const),
                            hlsStartPosition: data.hlsStartPosition ?? 0,
                            reporting: data.reporting,
                        };
                    },
                    { onDelete: deletePreviewSessionOnServer },
                );
            } catch (error) {
                if (error instanceof NoTrailerSignal) {
                    if (destroyed) return;
                    onNoTrailer?.();
                    return;
                }
                throw error;
            }

            // The component may have been torn down while the POST was in flight
            // (hover ended / hero rotated / user pressed Play). onDestroy already
            // ran and its cleanupPreviewSession() no-oped because sessionHandle was
            // still null at that point. RELEASE (not raw-delete) the handle the
            // memo just handed us so the session's lifecycle stays owned in one
            // place — the memo decides whether that deletes it now or retains it.
            if (destroyed) {
                releasePreviewSession(handle);
                return;
            }

            sessionHandle = handle;
            playSessionId = handle.value.playSessionId;
            sessionItemId = handle.value.sessionItemId;
            streamUrl = handle.value.streamUrl;
            deliveryKind = handle.value.deliveryKind;
            hlsStartPosition = handle.value.hlsStartPosition;
            onSessionResolved?.(sessionItemId);

            // Start heartbeat to keep session alive
            startHeartbeat();

            // Initialize HLS player
            await initializePlayer();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Session creation failed';
            await handleErrorWithCleanup(error, message);
        }
    }

    // =========================================================================
    // HLS Player Initialization
    // =========================================================================

    async function initializePlayer(): Promise<void> {
        if (!browser || !videoElement || !streamUrl) return;

        try {
            if (deliveryKind === 'file') {
                // File time is absolute; apply the envelope's position after
                // metadata is available, without handing MP4 bytes to hls.js.
                const video = videoElement;
                video.addEventListener(
                    'loadedmetadata',
                    () => {
                        if (!destroyed && videoElement === video)
                            video.currentTime = hlsStartPosition;
                    },
                    { once: true },
                );
                video.src = streamUrl;
                video.muted = isMuted;
                try {
                    await video.play();
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return;
                    if (isMuted) throw error;
                    video.muted = true;
                    await video.play();
                    previewAudio.release(audioId);
                }
                if (destroyed) return;
                if (sessionHandle) markPreviewSessionReady(sessionHandle);
                isLoading = false;
                fadeIn = true;
                return;
            }

            // Dynamically import HLS.js
            const HlsModule = await import('hls.js');
            const HlsClass = HlsModule.default;

            if (!HlsClass.isSupported()) {
                // Try native HLS support (Safari)
                if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
                    // The server returns the stream URL before FFmpeg has produced the
                    // first segment (to avoid blocking the POST response).  HLS.js handles
                    // this with built-in manifest retries (300 ms × 15 attempts), but
                    // Safari's native HLS retrier uses a much slower backoff (~2-3 s),
                    // causing the visible startup delay.
                    //
                    // Fix: poll the master playlist ourselves at 300 ms intervals — the
                    // same cadence as HLS.js — so Safari always gets a ready manifest.
                    //
                    // Safari native HLS: do NOT set #t= or currentTime.  The server
                    // already positions FFmpeg at the resume point, so the manifest's
                    // first segment IS the resume position.  Seeking within the stream
                    // causes out-of-order segment probing.
                    const POLL_INTERVAL = 300;
                    const MAX_ATTEMPTS = 20; // 6 s total
                    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                        if (!videoElement) return; // unmounted while waiting
                        try {
                            const res = await fetch(streamUrl, {
                                method: 'HEAD',
                                signal: AbortSignal.timeout(500),
                            });
                            if (res.ok) {
                                // X-Lumastra-Preview-Static is set only when the
                                // artifact's .ready marker exists — our
                                // readiness signal for the memo. See
                                // `markReadyFromNetworkDetails` below for the
                                // matching hls.js-path handlers (MANIFEST_LOADED
                                // / LEVEL_LOADED); this Safari path only ever
                                // observes the master playlist, since it polls
                                // the master URL directly rather than loading a
                                // media playlist through hls.js.
                                if (res.headers.get('X-Lumastra-Preview-Static') && sessionHandle) {
                                    markPreviewSessionReady(sessionHandle);
                                }
                                break;
                            }
                        } catch {
                            /* expected: HEAD request may fail on network error or timeout — keep retrying */
                        }
                        if (attempt < MAX_ATTEMPTS - 1) {
                            await new Promise<void>((resolve) =>
                                setTimeout(resolve, POLL_INTERVAL),
                            );
                        }
                    }
                    if (!videoElement) return; // unmounted during poll

                    videoElement.src = streamUrl;
                    videoElement.muted = isMuted;

                    try {
                        await videoElement.play();
                        isLoading = false;
                        fadeIn = true;
                        return;
                    } catch (error) {
                        // Benign race condition — component unmounted while loading
                        if (error instanceof DOMException && error.name === 'AbortError') {
                            return;
                        }
                        // If unmuted autoplay failed due to browser policy, try muted
                        if (!isMuted) {
                            console.warn(
                                '[MediaPreviewPlayer] Unmuted autoplay blocked, falling back to muted',
                            );
                            try {
                                videoElement.muted = true;
                                await videoElement.play();
                                // Browser blocked unmuted autoplay — hand audio
                                // ownership back so the UI reflects muted.
                                previewAudio.release(audioId);
                                isLoading = false;
                                fadeIn = true;
                                return;
                            } catch (mutedError) {
                                if (
                                    mutedError instanceof DOMException &&
                                    mutedError.name === 'AbortError'
                                ) {
                                    return;
                                }
                                console.error(
                                    '[MediaPreviewPlayer] Even muted autoplay failed:',
                                    mutedError,
                                );
                            }
                        }
                        // If muted autoplay also failed, continue to throw
                        throw error;
                    }
                }
                throw new Error('HLS not supported');
            }

            // Create HLS instance. The infinite back buffer only pays off for
            // a BOUNDED, endlessly-looping snippet — that's the hero
            // (`loop === true`) AND the hover popup (`hoverCapActive`, which
            // loops the same capped snippet internally without ever setting
            // `loop`). A full-length trailer or a live-TV stream (isLiveTv /
            // nativeStreamUrl) is either far longer than the snippet cap or
            // literally unbounded, so those get the finite buffer instead.
            // See preview-hls-config.ts's docstring for the full rationale.
            hls = new HlsClass(
                buildPreviewHlsConfig({
                    retainBackBuffer: shouldRetainBackBuffer({
                        loop,
                        hoverCapActive,
                        isLiveTv: !!isLiveTv,
                        nativeStreamUrl: !!nativeStreamUrl,
                    }),
                }),
            );

            // Attach to video element
            hls.loadSource(streamUrl);
            hls.attachMedia(videoElement);

            // Handle events
            hls.on(HlsClass.Events.MANIFEST_LOADED, (_event, data) => {
                markReadyFromNetworkDetails(data?.networkDetails);
            });

            // The media-playlist load: an artifact still warming at the time
            // of MANIFEST_LOADED can finish transcoding mid-playback, and its
            // .ready marker only shows up on a SUBSEQUENT playlist/segment
            // response — see `markReadyFromNetworkDetails` above.
            hls.on(HlsClass.Events.LEVEL_LOADED, (_event, data) => {
                markReadyFromNetworkDetails(data?.networkDetails);
            });

            hls.on(HlsClass.Events.MANIFEST_PARSED, async () => {
                try {
                    // Always 0: the preview FFmpeg has already seeked the input
                    // to the resume point, so segment 0 of the playlist IS the
                    // resume frame. See `hlsStartPosition` comment above.
                    const hlsInstance = requireValue(
                        hls,
                        'hls instance must exist in MANIFEST_PARSED handler',
                    );
                    const video = requireValue(
                        videoElement,
                        'videoElement must exist in MANIFEST_PARSED handler',
                    );
                    hlsInstance.startLoad(hlsStartPosition);
                    video.muted = isMuted;
                    await video.play();
                    isLoading = false;
                    fadeIn = true;
                } catch (error) {
                    // AbortError ("play() interrupted by pause()") is a benign race condition:
                    // the component was unmounted (user moved mouse away) while HLS was loading.
                    // Silently discard — the session is already being cleaned up by onDestroy.
                    if (error instanceof DOMException && error.name === 'AbortError') {
                        return;
                    }

                    // If unmuted autoplay failed due to browser policy, try muted
                    if (!isMuted) {
                        console.warn(
                            '[MediaPreviewPlayer] Unmuted autoplay blocked, falling back to muted',
                        );
                        try {
                            const video = requireValue(
                                videoElement,
                                'videoElement must exist in muted retry',
                            );
                            video.muted = true;
                            await video.play();
                            // Browser blocked unmuted autoplay — hand audio
                            // ownership back so the UI reflects muted.
                            previewAudio.release(audioId);
                            isLoading = false;
                            fadeIn = true;
                            return;
                        } catch (mutedError) {
                            // Also ignore AbortError on muted retry
                            if (
                                mutedError instanceof DOMException &&
                                mutedError.name === 'AbortError'
                            ) {
                                return;
                            }
                            console.error(
                                '[MediaPreviewPlayer] Even muted autoplay failed:',
                                mutedError,
                            );
                        }
                    }
                    // If muted autoplay also failed (NotAllowedError), show error and cleanup
                    await handleErrorWithCleanup(error, 'Autoplay failed');
                }
            });

            hls.on(HlsClass.Events.ERROR, (event, data) => {
                if (!data.fatal || hlsFatalHandled) return;

                logFatalHlsError(data);

                switch (data.type) {
                    case HlsClass.ErrorTypes.NETWORK_ERROR:
                        networkErrorRetryCount++;
                        if (networkErrorRetryCount <= MAX_NETWORK_ERROR_RETRIES) {
                            hls?.startLoad();
                            return;
                        }
                        break;
                    case HlsClass.ErrorTypes.MEDIA_ERROR:
                        mediaErrorRetryCount++;
                        if (mediaErrorRetryCount <= MAX_MEDIA_ERROR_RETRIES) {
                            hls?.recoverMediaError();
                            return;
                        }
                        break;
                    default:
                        // Not a recoverable error type - fall through to teardown.
                        break;
                }

                // Retry cap exceeded (or a non-recoverable error type):
                // terminal for THIS hls instance. Before surrendering to the
                // backdrop, try ONE full session re-create (see
                // sessionRecreateAttempted above) — the video element stays
                // mounted, so a successful re-create resumes with at most a
                // brief freeze instead of reverting to the still image.
                hlsFatalHandled = true;
                hls?.destroy();
                hls = null;
                if (!sessionRecreateAttempted && !destroyed && !nativeStreamUrl) {
                    sessionRecreateAttempted = true;
                    // Invalidate FIRST: the entry the memo holds for this key
                    // points at the dead `streamUrl` we just tore down. Without
                    // this, the recreate below re-acquires the SAME dead entry
                    // from the memo (a hit) and loops instead of POSTing fresh.
                    if (sessionHandle) invalidatePreviewSession(sessionHandle);
                    void recreateSessionAfterFatal(data.type);
                    return;
                }
                // Fire-and-forget cleanup (event handler can't be async)
                void handleErrorWithCleanup(
                    new Error(`HLS error: ${data.type}`),
                    `HLS error: ${data.type}`,
                );
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Player initialization failed';
            await handleErrorWithCleanup(error, message);
        }
    }

    // =========================================================================
    // Playback Controls
    // =========================================================================

    function toggleMute(): void {
        // Unmuting claims exclusive audio (silencing every other preview/hero);
        // muting releases it. The $effect above applies the result to the
        // <video> element; we also apply synchronously for immediate feedback.
        if (previewAudio.owns(audioId)) {
            previewAudio.release(audioId);
        } else {
            previewAudio.claim(audioId);
        }
        if (videoElement) {
            videoElement.muted = !previewAudio.owns(audioId);
        }
    }

    function seekToStart(): void {
        if (!videoElement) return;
        try {
            // hlsStartPosition is the playlist-relative start (0 for previews —
            // FFmpeg has already seeked the source to the resume point), so
            // seeking there replays the snippet from its first frame.
            videoElement.currentTime = hlsStartPosition;
            // currentTime assignment pauses some browsers mid-seek; nudge play.
            void videoElement.play().catch(() => {
                /* expected: play() may reject if unmounted mid-loop */
            });
        } catch {
            /* expected: video may be detaching */
        }
    }

    function handleEnded(): void {
        // Loop the snippet by replaying from the start when the (short) preview
        // playlist ends. Without `loop` the video simply stops on the last frame.
        if (loop) {
            seekToStart();
            return;
        }
        // Hover-card preview (not the hero's explicit `loop`): bounded looping
        // governed by the total-elapsed hover cap instead.
        if (hoverCapActive) {
            advanceOrExpireHoverLoop();
            return;
        }
        // Nothing loops this playback (e.g. a trailer) — it reached its end.
        onEnded?.();
    }

    /**
     * Decides what happens when a (non-hero) hover preview reaches the end of
     * its looped snippet: keep looping, re-arm the cap window because the
     * viewer is still actively hovering, or stop and hand off to the
     * existing error/backdrop-transition path. The actual continue/rearm/
     * expire decision is a pure function (`decideHoverLoopCap`) so it can be
     * unit-tested without DOM/timers — see media-preview-hover-cap.test.ts.
     */
    function advanceOrExpireHoverLoop(): void {
        const elapsedSeconds = (Date.now() - hoverCapWindowStartedAt) / 1000;
        const decision = decideHoverLoopCap(elapsedSeconds, hoverMaxSeconds, isPointerOverPreview);

        switch (decision) {
            case 'continue':
                seekToStart();
                break;
            case 'rearm':
                // Still actively hovered — reset the window and keep looping.
                hoverCapWindowStartedAt = Date.now();
                seekToStart();
                break;
            case 'expire':
                // No longer actively hovered — stop and revert to the backdrop.
                void expireToBackdrop();
                break;
        }
    }

    /**
     * Benign teardown for a hover preview that reached its time limit. Runs the
     * SAME session cleanup sequence as an error (stopHeartbeat +
     * cleanupPreviewSession / DELETE) and triggers the backdrop transition, but
     * deliberately does NOT `console.error` — a cap-expiry is an expected UI
     * transition, not a failure, and must produce zero error-level logs. The
     * parent swaps the video back to a still backdrop via the dedicated
     * `onExpire` callback (which, unlike `onError`, does not log either).
     */
    async function expireToBackdrop(): Promise<void> {
        // Pause first: the parent's swapToBackdrop refuses to cover a video
        // that is still playing (spurious-expire guard), so a DELIBERATE
        // expiry must stop playback before asking for the swap.
        try {
            videoElement?.pause();
        } catch {
            /* expected: element may be detaching */
        }
        // Mark stopped so no further loop/timeupdate logic runs. Uses the same
        // `hasError` flag the error path sets; the parent's onExpire swaps the
        // container DOM before the "Preview unavailable" fallback is ever seen.
        hasError = true;
        onExpire?.();
        await cleanupPreviewSession();
        stopHeartbeat();
    }

    function handleTimeUpdate(): void {
        if (!videoElement) return;

        // Safari/iOS native-HLS only (hls.js gets its second look via
        // LEVEL_LOADED instead — see markReadyFromNetworkDetails). Fire-and-
        // forget: checkSafariReadinessOnce is itself guarded to run at most
        // once and to no-op on a torn-down component.
        if (deliveryKind === 'hls' && !hls && !nativeStreamUrl) void checkSafariReadinessOnce();

        // Bounded repeating clip: once the snippet has played for the configured
        // cap, jump back to the start. Measured against the playlist-relative
        // currentTime (0 = the seek frame), so the cap is "seconds of preview
        // playback". Only active when looping.
        if (
            loop &&
            durationCapSeconds !== undefined &&
            durationCapSeconds > 0 &&
            videoElement.currentTime >= hlsStartPosition + durationCapSeconds
        ) {
            seekToStart();
            return;
        }

        if (!onTimeUpdate) return;

        // Wait for at least a tick of real playback before reporting position
        // — the very first ontimeupdate after attach can fire at currentTime≈0
        // before the source has started, and the parent uses "any callback
        // fired" as the signal to enable the preview→full-player handoff.
        if (videoElement.currentTime <= 0) return;

        const now = Date.now();
        if (now - lastUpdateTime >= UPDATE_INTERVAL) {
            lastUpdateTime = now;
            // Files already use absolute source time. HLS uses playlist time,
            // so add the source's FFmpeg seek offset for the full-player handoff.
            onTimeUpdate(
                (deliveryKind === 'file' ? 0 : sourceSeekSeconds) + videoElement.currentTime,
            );
        }
    }

    // =========================================================================
    // Heartbeat (Keep-Alive)
    // =========================================================================

    async function sendHeartbeat(): Promise<void> {
        if (!playSessionId || hasError) return;

        const reporting = sessionHandle?.value.reporting;
        if (!reporting) return;
        try {
            const res = await fetch(reporting.href, {
                method: reporting.method,
            });

            // The session no longer exists server-side (auto-expired, evicted,
            // or deleted by a peer). 404 = gone / not owned; 410 = expired.
            // If the video is still actively playing, the session record dying
            // is NOT a reason to kill a working preview — self-heal by
            // re-creating the session once (same one-shot as the fatal-HLS
            // path). Only when playback isn't running (or the heal was already
            // spent) fall back to the benign backdrop expiry.
            if (res.status === 404 || res.status === 410) {
                const playing =
                    !!videoElement &&
                    !videoElement.paused &&
                    !videoElement.ended &&
                    videoElement.readyState >= 2;
                if (playing && !destroyed) {
                    // Keep playing from the buffer. If fragment loads later
                    // fail because the session is gone, the fatal-HLS path's
                    // one-shot session re-create takes over; if the clip loops
                    // within its buffer, nothing breaks at all. Stop the
                    // heartbeat (no point renewing a dead id) and drop the id
                    // so a later unmount doesn't DELETE a reused id.
                    console.info(
                        `[MediaPreviewPlayer] Session gone server-side (heartbeat ${res.status}) — continuing playback from buffer`,
                    );
                    stopHeartbeat();
                    playSessionId = null;
                    // Invalidate the memo entry too (not just the local
                    // pointer): the server just told us this session is dead,
                    // but the memo doesn't know that. Left alone, an unmount
                    // within the next few seconds would hand this KNOWN-dead
                    // entry a 20s retention window; a remount inside that
                    // window would inherit the dead `streamUrl`, 410 on first
                    // segment, and burn the one-shot `sessionRecreateAttempted`
                    // self-heal on a session that was never going to work —
                    // leaving a LATER genuine fatal in that same mount with no
                    // self-heal budget left. Invalidating removes the entry so
                    // no remount can inherit it; `releasePreviewSession` later
                    // (from `cleanupPreviewSession`) then finds nothing (or a
                    // newer entry with a different epoch) and safely no-ops.
                    if (sessionHandle) invalidatePreviewSession(sessionHandle);
                    return;
                }
                void expireToBackdrop();
            }
        } catch (error) {
            console.error('[MediaPreviewPlayer] Heartbeat failed:', error);
        }
    }

    function startHeartbeat(): void {
        if (destroyed || heartbeatInterval) return;

        // Send initial heartbeat
        sendHeartbeat();

        // Send heartbeat every 10 seconds
        heartbeatInterval = setInterval(() => {
            sendHeartbeat();
        }, sessionHandle?.value.reporting?.intervalMs ?? HEARTBEAT_INTERVAL);
    }

    function stopHeartbeat(): void {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }

    // =========================================================================
    // Session Cleanup
    // =========================================================================

    async function cleanupPreviewSession(): Promise<void> {
        // Native stream: release the live TV session via the leave endpoint
        if (nativeStreamUrl) {
            const heartbeat = liveTvHeartbeat;
            liveTvHeartbeat = null;
            await heartbeat?.destroy();
            return;
        }

        if (!sessionHandle) return;

        // RELEASE, not a raw DELETE: the memo owns the decision of whether
        // this session is torn down immediately (never reached "ready") or
        // retained for a short window so a quick remount (A -> B -> A) reuses
        // it instead of re-POSTing and minting a new `playSessionId` — which
        // is the whole point, since a changing `playSessionId` busts the
        // immutable browser cache on every segment URL. Clear the local
        // pointers up front so a handle can't be released twice from this
        // component (releasePreviewSession is itself idempotent per handle,
        // but there is no reason to hold a stale reference around either).
        const handle = sessionHandle;
        sessionHandle = null;
        playSessionId = null;
        releasePreviewSession(handle);
    }

    /**
     * Handle error and ensure session cleanup
     * This is critical for live TV previews which have strict rate limits
     */
    /**
     * One-shot recovery from a fatal HLS error: release the (likely dead)
     * server session, then run the normal create flow again — fresh POST,
     * fresh stream URL, fresh hls attach onto the still-mounted video element.
     * Deliberately NOT an error path: no onError, no hasError, no backdrop —
     * if the re-create fails, its own error handling (handleErrorWithCleanup)
     * takes over and the backdrop fallback happens then. Guarded to one
     * attempt per component instance via sessionRecreateAttempted.
     */
    async function recreateSessionAfterFatal(errorType: string): Promise<void> {
        console.info(`[MediaPreviewPlayer] Fatal ${errorType} — re-creating preview session once`);
        stopHeartbeat();
        await cleanupPreviewSession();
        if (destroyed) return;
        playSessionId = null;
        streamUrl = null;
        networkErrorRetryCount = 0;
        mediaErrorRetryCount = 0;
        hlsFatalHandled = false;
        await createPreviewSession();
    }

    async function handleErrorWithCleanup(error: unknown, message: string): Promise<void> {
        // 404 is an expected fallback case: the server told us the item has
        // no local file available to preview. The parent will fall back to
        // backdrop — no need to raise the alarm in the console.
        const status =
            error instanceof Error && 'status' in error
                ? (error as Error & { status?: number }).status
                : undefined;
        if (status === 404) {
            console.info(`[MediaPreviewPlayer] ${message}`);
        } else {
            console.error(`[MediaPreviewPlayer] ${message}:`, error);
        }
        hasError = true;
        errorMessage = message;
        onError?.(errorMessage);

        // CRITICAL: Clean up session immediately to free up rate limit slots
        // This is especially important for live TV which has server-wide limits
        await cleanupPreviewSession();
        stopHeartbeat();
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * `pagehide` fires reliably on tab close / hard navigation / bfcache
     * entry — unlike a plain `fetch`, which the browser is free to cancel the
     * instant it tears down the page, and unlike Svelte's `onDestroy`, which
     * never runs at all for a hard unload (there is no component teardown on
     * a page going away, only on this component unmounting within a live
     * page). This releases only the session THIS component instance still
     * holds via `sessionHandle` — i.e. one this component has not already
     * released. Go straight to a `keepalive` fetch rather than through
     * `releasePreviewSession`: the memo's own eviction path is a plain
     * (non-keepalive) fetch on a `setTimeout`, which is not reliable during
     * an unload.
     *
     * What this does NOT cover: a session already handed back to the memo's
     * short retention window by a prior release of THIS component (or any
     * other) is out of reach here. `cleanupPreviewSession` nulls
     * `sessionHandle` before calling `releasePreviewSession`, so the guard
     * below is already a no-op by the time an entry is retained; and a
     * retained entry's former holder has, by definition, already unmounted
     * and removed its own `pagehide` listener, so there is no live listener
     * left to reach it anyway. The memo exposes no enumeration API to walk
     * retained entries from here, and none is added for this — a retained
     * session is reclaimed by the server's 30s no-heartbeat sweep
     * (`PREVIEW_HEARTBEAT_TIMEOUT_MS`, `preview-session.service.ts:214`)
     * regardless of whether the tab that retained it is still open.
     */
    function releaseSessionOnPageHide(): void {
        liveTvHeartbeat?.destroyViaBeacon();
        liveTvHeartbeat = null;
        if (!sessionHandle || nativeStreamUrl) return;
        const { playSessionId: psid } = sessionHandle.value;
        void fetch(`/api/playback/previews/${encodeURIComponent(psid)}`, {
            method: 'DELETE',
            keepalive: true,
        });
    }

    onMount(() => {
        if (browser) {
            createPreviewSession();
            window.addEventListener('pagehide', releaseSessionOnPageHide);
        }
    });

    onDestroy(() => {
        // Mark destroyed FIRST so any in-flight createPreviewSession continuation
        // that resolves after this releases (not adopts) the session it created.
        destroyed = true;

        if (browser) {
            window.removeEventListener('pagehide', releaseSessionOnPageHide);
        }

        // Release exclusive audio if we held it, so unmounting (hover ends, hero
        // rotates) doesn't leave a phantom owner that keeps everyone else muted.
        previewAudio.release(audioId);

        // Stop heartbeat
        stopHeartbeat();

        // Stop playback
        if (videoElement) {
            videoElement.pause();
            videoElement.src = '';
        }

        // Destroy HLS instance
        if (hls) {
            hls.destroy();
            hls = null;
        }

        // Cleanup server-side session
        cleanupPreviewSession();

        // Notify parent
        onCleanup?.();
    });
</script>

<!-- ========================================================================= -->
<!-- Template -->
<!-- ========================================================================= -->

<!-- Pointer tracking only (hover-cap signal below) — no keyboard-reachable interaction is added. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="relative w-full h-full overflow-hidden rounded-lg bg-black"
    onpointerenter={() => (isPointerOverPreview = true)}
    onpointerleave={() => (isPointerOverPreview = false)}>
    {#if showBackdrop}
        <!-- Bottom layer: still backdrop shown while the preview session loads
             and as a silent fallback on error. The video fades in on top. -->
        <img
            src={backdropUrl}
            alt=""
            class="absolute inset-0 w-full h-full object-cover"
            onerror={() => (backdropFailed = true)} />
    {/if}
    {#if hasError}
        <!-- Error state: backdrop (above) is the fallback; only show text when
             there is no backdrop to fall back to. Parent handles the swap. -->
        {#if !showBackdrop}
            <div class="absolute inset-0 flex items-center justify-center text-error-500 text-sm">
                <span>Preview unavailable</span>
            </div>
        {/if}
    {:else}
        <!-- Video player -->
        <video
            bind:this={videoElement}
            class="w-full h-full transition-opacity duration-300"
            class:object-cover={objectFit === 'cover'}
            class:object-contain={objectFit === 'contain'}
            class:opacity-0={!fadeIn}
            class:opacity-100={fadeIn}
            playsinline
            disablepictureinpicture
            oncontextmenu={(e) => e.preventDefault()}
            ontimeupdate={handleTimeUpdate}
            onplaying={() => {
                // Real playback resumed (initial start, or recovery from a
                // mid-stream MEDIA_ERROR/NETWORK_ERROR) - the stream is
                // healthy again, so forgive past retries.
                resetHlsErrorState();
                onPlaying?.();
            }}
            onended={handleEnded}>
            <track kind="captions" />
        </video>

        <!-- Loading spinner: with a backdrop showing, the card already looks
             complete — demote to a small corner indicator (same spot the mute
             button takes over) instead of covering the artwork. Only a bare
             black box gets the big centered spinner. -->
        {#if isLoading}
            {#if showBackdrop}
                <div class="absolute bottom-2 right-2 p-2 rounded-full bg-black/60">
                    <div
                        class="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin">
                    </div>
                </div>
            {:else}
                <div class="absolute inset-0 flex items-center justify-center">
                    <div
                        class="w-8 h-8 border-4 border-primary-500 border-t-transparent rounded-full animate-spin">
                    </div>
                </div>
            {/if}
        {/if}

        <!-- Mute button overlay -->
        {#if showMuteButton && !isLoading && !hasError}
            <button
                type="button"
                class="absolute bottom-2 right-2 p-2 rounded-full bg-black/60 hover:bg-black/80 transition-colors"
                onclick={toggleMute}
                aria-label={isMuted ? 'Unmute' : 'Mute'}>
                {#if isMuted}
                    <!-- Muted icon -->
                    <svg
                        class="w-5 h-5 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                            clip-rule="evenodd" />
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
                    </svg>
                {:else}
                    <!-- Unmuted icon -->
                    <svg
                        class="w-5 h-5 text-white"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                    </svg>
                {/if}
            </button>
        {/if}
    {/if}
</div>

<style>
    /* Prevent text selection on video */
    video {
        user-select: none;
        -webkit-user-select: none;
    }
</style>
