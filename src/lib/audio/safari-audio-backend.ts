// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    AudioBackend,
    AudioBackendCallbacks,
    BackendInitOptions,
    MediaSessionActions,
    TrackMetadata,
    CrossfadeOptions,
    GaplessAdvanceRequest,
    PlaybackRateOptions,
    PlayOptions,
    ReloadSrcOptions,
    TimeUpdateInfo,
} from './types';
import {
    calculateCrossfadeDuration,
    calculatePlaybackRate,
    computeBlendGains,
    resolveIncomingStartSec,
    BPM_NATIVE_RATE_MAX_GAP,
} from '$lib/utils/beat-math';
import {
    updateMediaSessionPlaybackState,
    updateMediaSessionPositionState,
    clearMediaSession,
} from '$lib/utils/media-session';
import { registerMediaSessionHandlers } from './media-session-helpers';
import {
    applyPlaybackRate,
    elementFailure,
    playMediaElement,
    seekWhenReady,
    startIncomingDeck,
    waitForMetadata,
    watchMediaErrors,
} from './audio-element-helpers';
import { GaplessAdvanceScheduler } from './gapless-advance';
import {
    requestWakeLock,
    releaseWakeLock,
    setupWakeLockReacquisition,
    destroyWakeLock,
} from '$lib/utils/wake-lock';
import { createSilentAudioKeepalive } from '$lib/utils/background-playback';

/**
 * Safari desktop audio backend — A/B deck crossfade using HTMLAudioElement.volume.
 *
 * Avoids the Web Audio API entirely because Safari's MediaElementAudioSourceNode
 * has multiple open, unfixed bugs (WebKit #221334, #293891, #212125) that cause
 * permanent audio corruption during crossfade.
 *
 * Uses two plain <audio> elements with .volume animation for crossfade.
 * Blend-only (no filter/echo effects). BPM rate-matching via native playbackRate.
 */
/** Hidden-page fade driver cadence (browsers throttle it further in the background). */
const HIDDEN_FADE_TICK_MS = 250;
/** Per-step progress cap while hidden — throttled timers fire ~1/s, not per frame. */
const HIDDEN_FADE_MAX_STEP_MS = 1500;

export class SafariAudioBackend implements AudioBackend {
    readonly supportsCrossfade = true;
    readonly supportsVolumeControl = true;
    readonly normalizationStyle = 'instant' as const;

    private deckA: HTMLAudioElement | null = null;
    private deckB: HTMLAudioElement | null = null;
    private activeDeck: 'A' | 'B' = 'A';
    private callbacks: AudioBackendCallbacks | null = null;
    private storedMediaSessionActions: MediaSessionActions | null = null;
    private timeUpdateInterval: ReturnType<typeof setInterval> | null = null;
    private cleanupWakeLockReacquisition: (() => void) | null = null;
    private mediaSessionInitialized = false;
    private lastPositionUpdateMs = 0;
    private initialized = false;
    private currentVolume = 0.8;
    private isMuted = false;
    // Start paused — only play() or successful autoResume should clear this.
    private userPaused = true;
    private _isCrossfading = false;
    /** Bumped per triggerCrossfade; see its generation check. */
    private crossfadeGeneration = 0;
    private crossfadeAnimationId: number | null = null;
    private crossfadeFallbackTimerId: ReturnType<typeof setTimeout> | null = null;
    /** Invalidated by cancelCrossfadeAnimation: a stray tick chain of an older fade stops. */
    private fadeAnimationToken = 0;
    /** Detaches the hidden-page driver of the fade in progress (see animateCrossfade). */
    private crossfadeHiddenCleanup: (() => void) | null = null;
    // Resolver for the in-flight animateCrossfade() Promise. cancelCrossfadeAnimation()
    // must invoke this so a cancel mid-fade unblocks the awaited triggerCrossfade()
    // in the store (otherwise crossfadePending never resets — permanent crossfade hang).
    private crossfadeResolve: (() => void) | null = null;
    // Tracks a mid-fade volume/mute change (B6) so triggerCrossfade re-applies the live
    // user volume/mute to the now-active deck once the Safari fade completes.
    private volumeChangedDuringCrossfade = false;
    private currentMetadata: TrackMetadata | null = null;
    private silentKeepalive: ReturnType<typeof createSilentAudioKeepalive> | null = null;
    /** Dedicated hidden element used only for next-track prefetch buffering. */
    private prefetchAudio: HTMLAudioElement | null = null;
    /** False only for the audiobook player, which owns MediaSession itself. */
    private manageMediaSession = true;
    private readonly advanceScheduler = new GaplessAdvanceScheduler();
    private advanceRequest: GaplessAdvanceRequest | null = null;
    /** See the identically-named field in WebAudioBackend for why this exists. */
    private advancePending = false;
    /** Handle for the timed volume flip, so a cancel can stop it firing. */
    private advanceSwapTimer: ReturnType<typeof setTimeout> | null = null;

    // -- Deck helpers --

    private getActiveDeck(): HTMLAudioElement | null {
        return this.activeDeck === 'A' ? this.deckA : this.deckB;
    }

    private getInactiveDeck(): HTMLAudioElement | null {
        return this.activeDeck === 'A' ? this.deckB : this.deckA;
    }

    // -- Lifecycle --

    init(
        callbacks: AudioBackendCallbacks,
        mediaSessionActions: MediaSessionActions,
        options?: BackendInitOptions,
    ): void {
        if (this.initialized) return;
        this.initialized = true;
        this.callbacks = callbacks;
        this.storedMediaSessionActions = mediaSessionActions;
        this.manageMediaSession = options?.manageMediaSession !== false;

        this.deckA = document.createElement('audio');
        this.deckA.preload = 'auto';
        this.deckB = document.createElement('audio');
        this.deckB.preload = 'auto';

        // Wire ended events on both decks
        this.deckA.addEventListener('ended', () => {
            if (this.activeDeck === 'A' && !this._isCrossfading && !this.advancePending) {
                this.callbacks?.onTrackEnded();
            }
        });
        this.deckB.addEventListener('ended', () => {
            if (this.activeDeck === 'B' && !this._isCrossfading && !this.advancePending) {
                this.callbacks?.onTrackEnded();
            }
        });
        // During a crossfade the store already promoted the incoming track, so
        // the outgoing (still active) deck failing is not the current track.
        for (const [el, id] of [
            [this.deckA, 'A'],
            [this.deckB, 'B'],
        ] as const) {
            watchMediaErrors(
                el,
                () => this.activeDeck === id && !this._isCrossfading,
                (error) => this.callbacks?.onPlaybackError?.(error),
            );
        }

        // MediaSession
        if (!this.mediaSessionInitialized) {
            this.registerMediaSession(this.currentMetadata);
            this.mediaSessionInitialized = true;
        }

        // Wake lock
        this.cleanupWakeLockReacquisition = setupWakeLockReacquisition(
            () => !this.userPaused && this.getActiveDeck()?.paused === false,
        );

        if (!this.silentKeepalive) {
            this.silentKeepalive = createSilentAudioKeepalive({});
        }

        this.startTimeUpdates();
    }

    destroy(): void {
        this.cancelGaplessAdvance();
        this.stopTimeUpdates();
        this.cancelCrossfadeAnimation();

        if (this.deckA) {
            this.deckA.pause();
            this.deckA.src = '';
        }
        if (this.deckB) {
            this.deckB.pause();
            this.deckB.src = '';
        }

        this.clearOwnedMediaSession();
        destroyWakeLock();
        this.cleanupWakeLockReacquisition?.();
        this.cleanupWakeLockReacquisition = null;
        this.silentKeepalive?.stop();

        if (this.prefetchAudio) {
            this.prefetchAudio.src = '';
            this.prefetchAudio.remove();
            this.prefetchAudio = null;
        }

        this.deckA = null;
        this.deckB = null;
        this.callbacks = null;
        this.initialized = false;
        this.mediaSessionInitialized = false;
        this.currentMetadata = null;
    }

    // -- Playback --

    async play(src: string, metadata: TrackMetadata, options?: PlayOptions): Promise<void> {
        this.userPaused = false;
        this.cancelGaplessAdvance();

        if (this._isCrossfading) {
            this.cancelCrossfadeAnimation();
            this._isCrossfading = false;
        }

        const deck = this.getActiveDeck();
        if (!deck) return;

        deck.src = src;
        deck.volume = this.isMuted ? 0 : this.currentVolume;
        this.currentMetadata = metadata;

        // Silence the inactive deck
        const inactive = this.getInactiveDeck();
        if (inactive) {
            inactive.pause();
            inactive.volume = 0;
            inactive.src = '';
        }

        this.startTimeUpdates();

        if (options?.playbackRate !== undefined) {
            applyPlaybackRate(deck, options.playbackRate, options.preservePitch !== false);
        }
        // Seek BEFORE play(): play-then-seek is audible, and on a resume it is
        // the difference between continuing a book and restarting a file.
        if (options?.startAtMs !== undefined && options.startAtMs > 0) {
            await seekWhenReady(deck, options.startAtMs);
        }

        // A load/decode failure rejects out of here. An autoplay block or a
        // superseding load resolves `false`, and still registers the session
        // so the lock screen can start playback with a gesture.
        await playMediaElement(deck);

        this.registerMediaSession(metadata);
        this.setMediaSessionState('playing');
        void requestWakeLock();
        this.silentKeepalive?.start();
    }

    pause(): void {
        this.userPaused = true;
        // See WebAudioBackend.pause(): an armed advance would otherwise make
        // its incoming deck audible a moment after the user pressed pause.
        this.cancelGaplessAdvance();
        this.getActiveDeck()?.pause();
        this.setMediaSessionState('paused');
        void releaseWakeLock();
        this.silentKeepalive?.stop();
    }

    resume(): void {
        this.userPaused = false;
        void this.getActiveDeck()
            ?.play()
            .then(
                () => {
                    this.registerMediaSession(this.currentMetadata);
                    this.syncMediaSessionPosition(true);
                },
                () => {},
            );
        this.setMediaSessionState('playing');
        void requestWakeLock();
        this.silentKeepalive?.start();
    }

    stop(): void {
        this.cancelGaplessAdvance();
        this.userPaused = true;
        this.cancelCrossfadeAnimation();
        this._isCrossfading = false;

        if (this.deckA) {
            this.deckA.pause();
            this.deckA.src = '';
        }
        if (this.deckB) {
            this.deckB.pause();
            this.deckB.src = '';
        }

        this.stopTimeUpdates();
        this.currentMetadata = null;
        this.clearOwnedMediaSession();
        if (this.mediaSessionInitialized && this.storedMediaSessionActions) {
            this.registerMediaSession(null);
        }
        destroyWakeLock();
        this.cleanupWakeLockReacquisition?.();
        this.cleanupWakeLockReacquisition = null;

        // Re-register wake lock for next play
        this.cleanupWakeLockReacquisition = setupWakeLockReacquisition(
            () => !this.userPaused && this.getActiveDeck()?.paused === false,
        );

        this.silentKeepalive?.stop();
    }

    seekTo(ms: number): void {
        // The swap was scheduled against a boundary this seek just moved.
        this.cancelGaplessAdvance();
        const deck = this.getActiveDeck();
        if (deck) {
            deck.currentTime = ms / 1000;
            this.syncMediaSessionPosition(true);
        }
    }

    // -- Volume --

    setVolume(volume: number): void {
        this.currentVolume = volume;
        this.isMuted = volume === 0;
        const deck = this.getActiveDeck();
        if (deck && !this._isCrossfading) {
            deck.volume = volume;
        } else if (this._isCrossfading) {
            // animateCrossfade owns the deck volumes via its per-tick automation, so a
            // one-shot write here would be stomped on the next frame. Defer it: settle
            // the live volume on the now-active deck once the fade completes (B6).
            this.volumeChangedDuringCrossfade = true;
        }
    }

    mute(): void {
        this.isMuted = true;
        const deck = this.getActiveDeck();
        if (deck) deck.volume = 0;
        if (this._isCrossfading) this.volumeChangedDuringCrossfade = true;
    }

    unmute(restoreVolume: number): void {
        this.isMuted = false;
        this.currentVolume = restoreVolume;
        const deck = this.getActiveDeck();
        if (deck && !this._isCrossfading) {
            deck.volume = restoreVolume;
        } else if (this._isCrossfading) {
            // Defer to the post-fade re-apply (animateCrossfade owns volumes mid-fade).
            this.volumeChangedDuringCrossfade = true;
        }
    }

    // -- Crossfade --

    async triggerCrossfade(
        nextSrc: string,
        metadata: TrackMetadata,
        options?: CrossfadeOptions,
    ): Promise<void> {
        // Both mechanisms want the inactive deck; the crossfade is the
        // explicit user-visible transition, so it wins.
        this.cancelGaplessAdvance();

        this._isCrossfading = true;
        // Identifies THIS fade: a cancelled fade resuming from an await must not
        // mistake a newer fade's flag for its own (it would swap decks twice).
        const generation = ++this.crossfadeGeneration;
        this.volumeChangedDuringCrossfade = false;

        const fromDeck = this.getActiveDeck();
        const toDeck = this.getInactiveDeck();
        if (!fromDeck || !toDeck) {
            this._isCrossfading = false;
            // Throw (not silent resolve): the store promoted the incoming
            // track before awaiting us — its catch hard-cuts to that track.
            throw new Error('crossfade unavailable: missing deck');
        }

        // Ensure clean volume state
        fromDeck.volume = this.isMuted ? 0 : this.currentVolume;
        toDeck.volume = 0;
        toDeck.src = nextSrc;
        this.currentMetadata = metadata;

        // BPM rate matching (native playbackRate only, no time-stretch)
        const outgoingBpm = options?.outgoingBpm;
        const incomingBpm = options?.incomingBpm;
        if (outgoingBpm && incomingBpm) {
            const rate = calculatePlaybackRate(incomingBpm, outgoingBpm);
            const gap = Math.abs(1 - rate);
            if (gap <= BPM_NATIVE_RATE_MAX_GAP) {
                // ≤15% gap: native playbackRate (pitch shift masked by crossfade)
                toDeck.playbackRate = rate;
            }
            // >15% gap: skip rate matching (no SoundTouch available without Web Audio)
        }

        // Buffer where the fade will enter (intro end snapped to a downbeat)
        // before the readiness wait; the phase-aligned start computed after it
        // is less than a bar further, so it lands in buffered audio.
        const alignment = {
            incomingIntroEndMs: options?.incomingIntroEndMs,
            outgoingDownbeats: options?.outgoingDownbeats,
            incomingDownbeats: options?.incomingDownbeats,
            incomingBeatGrid: options?.incomingBeatGrid,
            incomingBpm: options?.incomingBpm,
        };
        const preSeekSec = resolveIncomingStartSec(
            { ...alignment, outgoingDownbeats: undefined },
            0,
        );
        if (preSeekSec > 0) {
            toDeck.currentTime = preSeekSec;
        }

        try {
            await startIncomingDeck(toDeck);
        } catch (err) {
            // Source failure, autoplay refusal, or a play() that never settles.
            // Rethrow so the store's catch can hard-cut to the already-promoted
            // incoming track (mirrors WebAudioBackend.triggerCrossfade).
            if (generation === this.crossfadeGeneration) this._isCrossfading = false;
            throw err;
        }

        // A successful play() only means the autoplay policy let us start — it does
        // NOT mean the incoming element has buffered enough audio to render sound.
        // If we begin the equal-power blend now and the element is still stalling on
        // the network, the outgoing track fades out over silence and we hear a gap.
        // Wait for the incoming deck to be ready (canplay/canplaythrough) before
        // starting the blend (B3). If it stalls past the timeout, fall back to an
        // instant cut swap instead of fading across a dead deck. (Mirrors
        // WebAudioBackend.triggerCrossfade.)
        const incomingReady = await this.waitForIncomingReady(toDeck, 2000);

        // play()/preload()/stop() or a skip may have cancelled us while we awaited
        // buffering — bail without touching the decks if so.
        if (!this._isCrossfading || generation !== this.crossfadeGeneration) return;

        // The incoming stream failed while buffering: abandon the fade rather
        // than silence the outgoing track for a dead deck (mirrors WebAudioBackend).
        const failure = elementFailure(toDeck);
        if (failure) {
            toDeck.pause();
            toDeck.volume = 0;
            this.volumeChangedDuringCrossfade = false;
            this._isCrossfading = false;
            throw failure;
        }

        // Beat alignment now that the deck is ready: the outgoing position is
        // read fresh (not before the wait) and the duration is known, so the
        // end-of-track clamp applies.
        const startSec = resolveIncomingStartSec(
            { ...alignment, outgoingCurrentTimeSec: fromDeck.currentTime },
            isFinite(toDeck.duration) ? toDeck.duration : 0,
        );
        if (startSec > 0 && Math.abs(toDeck.currentTime - startSec) > 0.02) {
            toDeck.currentTime = startSec;
        }

        // Calculate fade duration
        const beats = options?.beats ?? 8;
        const bpm = options?.paceBpm ?? outgoingBpm ?? incomingBpm ?? 0;
        // On a stall, fade duration 0 -> animateCrossfade resolves on its first tick
        // (t >= 1 immediately), producing a clean instant cut rather than a long
        // fade across a still-buffering deck.
        // Never longer than the outgoing audio left NOW: the pre-seek and
        // readiness waits ate into the lead the planner reserved (1s for
        // end-aligned fades), and a fade outliving the outgoing track just
        // fades in over silence.
        const outgoingLeftMs = isFinite(fromDeck.duration)
            ? (fromDeck.duration - fromDeck.currentTime) * 1000 - 250
            : Infinity;
        const fadeDurationMs = incomingReady
            ? Math.max(0, Math.min(calculateCrossfadeDuration(bpm, beats), outgoingLeftMs))
            : 0;
        const toVol = options?.incomingVolume ?? options?.volume ?? this.currentVolume;
        const fromVol = options?.outgoingVolume ?? options?.volume ?? this.currentVolume;

        // Animate crossfade
        await this.animateCrossfade(fromDeck, toDeck, fadeDurationMs, toVol, beats, fromVol);

        // If the fade was cancelled (by pause, skip, play, or stop), cancelCrossfade
        // already swapped the active deck and cleared _isCrossfading, and the resolved
        // Promise is just the cancel resolving — don't run the post-crossfade swap
        // again (it would double-swap back to the outgoing deck).
        if (!this._isCrossfading || generation !== this.crossfadeGeneration) return;

        // Swap active deck
        this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
        this._isCrossfading = false;

        // Re-apply the user's live volume/mute to the now-active deck (B6).
        // animateCrossfade left this deck at the LUFS-adjusted incoming volume, which
        // is correct only if the user didn't mute or change volume mid-fade. If such a
        // change arrived while crossfading we deferred it; settle it now.
        if (this.volumeChangedDuringCrossfade) {
            const nowActive = this.getActiveDeck();
            if (nowActive) {
                nowActive.volume = this.isMuted ? 0 : this.currentVolume;
            }
            this.volumeChangedDuringCrossfade = false;
        }

        // Update lock screen
        this.registerMediaSession(metadata);

        // Pause outgoing deck (no src clear needed — avoids Safari quirks)
        fromDeck.pause();

        // A failure during the fade fired while this deck was inactive (ignored
        // by watchMediaErrors); it is the current track now, so report it.
        const lateFailure = elementFailure(toDeck);
        if (lateFailure) this.callbacks?.onPlaybackError?.(lateFailure);
    }

    /**
     * Resolve once the incoming element is buffered enough to render sound
     * (`readyState >= HAVE_FUTURE_DATA`), or `false` if it does not reach that state
     * within `timeoutMs`. Used by triggerCrossfade (B3) to avoid fading out the
     * outgoing deck over a still-buffering incoming deck — if it stalls, the caller
     * hard-cuts instead. Mirrors WebAudioBackend.waitForIncomingReady.
     */
    private waitForIncomingReady(el: HTMLAudioElement, timeoutMs: number): Promise<boolean> {
        // An element that already errored will never become ready — cut immediately.
        if (el.error) {
            return Promise.resolve(false);
        }
        // HAVE_FUTURE_DATA (3): at least the next frame is decoded and the element
        // can advance currentTime without immediately stalling.
        if (el.readyState >= 3) {
            return Promise.resolve(true);
        }

        return new Promise<boolean>((resolve) => {
            let settled = false;
            const cleanup = (): void => {
                el.removeEventListener('canplaythrough', onReady);
                el.removeEventListener('canplay', onReady);
                el.removeEventListener('error', onError);
                clearTimeout(timer);
            };
            const onReady = (): void => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(true);
            };
            const onError = (): void => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(false);
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                // Treat any forward progress as "good enough" on timeout —
                // HAVE_CURRENT_DATA (2) can still feed a short fade. Below that,
                // report a stall so the caller cuts.
                resolve(el.readyState >= 2);
            }, timeoutMs);

            el.addEventListener('canplaythrough', onReady, { once: true });
            el.addEventListener('canplay', onReady, { once: true });
            el.addEventListener('error', onError, { once: true });
        });
    }

    cancelCrossfade(): void {
        this.cancelCrossfadeAnimation();

        if (this._isCrossfading) {
            const outgoing = this.getActiveDeck();
            this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
            const incoming = this.getActiveDeck();

            if (incoming) {
                incoming.volume = this.isMuted ? 0 : this.currentVolume;
                incoming.playbackRate = 1;
            }
            if (outgoing) {
                outgoing.volume = 0;
                outgoing.pause();
            }
        }

        // cancelCrossfade already applied isMuted/currentVolume to the incoming deck
        // above, so any deferred mid-fade volume change is now settled.
        this.volumeChangedDuringCrossfade = false;
        this._isCrossfading = false;
    }

    normalizePlaybackRate(): void {
        const deck = this.getActiveDeck();
        if (!deck || deck.playbackRate === 1) return;
        // Safari's HTMLAudioElement emits a click on every playbackRate write.
        // Stepwise smoothing produced ~20 clicks over 2s — audible distortion.
        // One snap at the swap moment is masked by the track transition.
        deck.playbackRate = 1;
    }

    // -- Playback rate --

    setPlaybackRate(rate: number, options: PlaybackRateOptions): void {
        const deck = this.getActiveDeck();
        if (deck) applyPlaybackRate(deck, rate, options.preservePitch);
    }

    // -- Gapless file-boundary advance --

    /**
     * Safari desktop CAN butt-join: element `.volume` is honoured here (the
     * no-op is iOS-only), so the A/B swap needs no Web Audio graph — which is
     * the whole reason this backend avoids one.
     */
    readonly supportsGaplessAdvance = true;

    scheduleGaplessAdvance(request: GaplessAdvanceRequest | null): boolean {
        if (request === null) {
            this.cancelGaplessAdvance();
            return false;
        }
        if (this._isCrossfading) return false;

        const from = this.getActiveDeck();
        const to = this.getInactiveDeck();
        if (!from || !to) return false;

        this.advanceRequest = request;
        const scheduled = this.advanceScheduler.start(
            {
                getOutgoingTimeMs: () => from.currentTime * 1000,
                getOutgoingDurationMs: () =>
                    Number.isFinite(from.duration) ? from.duration * 1000 : 0,
                getPlaybackRate: () => from.playbackRate || 1,
                prepareIncoming: async () => {
                    to.volume = 0;
                    to.src = request.src;
                    applyPlaybackRate(
                        to,
                        request.playbackRate ?? from.playbackRate ?? 1,
                        request.preservePitch !== false,
                    );
                    await seekWhenReady(to, request.startAtMs ?? 0);
                },
                playIncomingSilent: async () => {
                    try {
                        await to.play();
                        return true;
                    } catch {
                        return false;
                    }
                },
                commitSwap: (delaySec) => {
                    // No audio clock here, so the swap is timed. The handle is
                    // kept because a cancel arriving between scheduling and
                    // firing must be able to stop it — an orphaned timer would
                    // later set `from.volume = 0` on whatever deck is active by
                    // then, silencing an unrelated track.
                    const flip = (): void => {
                        this.advanceSwapTimer = null;
                        to.volume = this.isMuted ? 0 : this.currentVolume;
                        from.volume = 0;
                    };
                    if (delaySec <= 0) flip();
                    else this.advanceSwapTimer = setTimeout(flip, delaySec * 1000);
                },
                abortSwap: () => {
                    if (this.advanceSwapTimer !== null) {
                        clearTimeout(this.advanceSwapTimer);
                        this.advanceSwapTimer = null;
                    }
                    to.volume = 0;
                    to.pause();
                    // Restore the outgoing deck in case the flip already ran.
                    from.volume = this.isMuted ? 0 : this.currentVolume;
                },
            },
            {
                leadMs: request.leadMs,
                onCommitted: () => this.completeGaplessAdvance(),
                onCancelled: () => this.cancelGaplessAdvance(),
            },
        );

        this.advancePending = scheduled;
        if (!scheduled) this.advanceRequest = null;
        return scheduled;
    }

    private cancelGaplessAdvance(): void {
        if (this.advanceSwapTimer !== null) {
            clearTimeout(this.advanceSwapTimer);
            this.advanceSwapTimer = null;
        }
        this.advanceScheduler.cancel();
        this.advancePending = false;
        this.advanceRequest = null;
    }

    private completeGaplessAdvance(): void {
        const request = this.advanceRequest;
        this.advanceRequest = null;
        if (!request) return;

        const outgoing = this.getActiveDeck();
        this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
        if (outgoing) {
            outgoing.volume = 0;
            outgoing.pause();
        }

        this.currentMetadata = request.metadata;
        this.registerMediaSession(request.metadata);
        this.advancePending = false;

        this.callbacks?.onGaplessAdvanceCommitted?.({
            src: request.src,
            positionMs: this.getCurrentTimeMs(),
        });
    }

    // -- State queries --

    getCurrentTimeMs(): number {
        const el = this.getActiveDeck();
        return el ? el.currentTime * 1000 : 0;
    }

    getDurationMs(): number {
        const el = this.getActiveDeck();
        if (!el) return 0;
        const d = el.duration;
        return d && isFinite(d) ? d * 1000 : 0;
    }

    getPlaybackRate(): number {
        return this.getActiveDeck()?.playbackRate ?? 1;
    }

    getCrossfadeIncomingTimeMs(): number | null {
        // During a fade the active deck is still the outgoing track; the
        // incoming track plays on the inactive deck until the completion swap.
        if (!this._isCrossfading) return null;
        const el = this.getInactiveDeck();
        return el ? el.currentTime * 1000 : null;
    }

    isCrossfading(): boolean {
        return this._isCrossfading;
    }

    getAudioElement(): HTMLAudioElement | null {
        return this.getActiveDeck();
    }

    getAllAudioElements(): HTMLAudioElement[] {
        const elements: HTMLAudioElement[] = [];
        if (this.deckA) elements.push(this.deckA);
        if (this.deckB) elements.push(this.deckB);
        return elements;
    }

    // -- Persistence --

    async preload(
        src: string,
        metadata: TrackMetadata,
        positionMs: number,
        volume: number,
        autoResume: boolean,
    ): Promise<{ resumed: boolean }> {
        this.currentVolume = volume;
        this.currentMetadata = metadata;

        this.registerMediaSession(metadata);

        const deck = this.getActiveDeck();
        if (!deck) return { resumed: false };

        deck.src = src;
        deck.volume = volume;

        const onMetadataReady = (): Promise<{ resumed: boolean }> => {
            return new Promise((resolve) => {
                if (positionMs > 0) {
                    deck.currentTime = positionMs / 1000;
                }
                if (autoResume) {
                    deck.play().then(
                        () => {
                            this.userPaused = false;
                            this.registerMediaSession(metadata);
                            this.setMediaSessionState('playing');
                            void requestWakeLock();
                            this.silentKeepalive?.start();
                            resolve({ resumed: true });
                        },
                        () => resolve({ resumed: false }),
                    );
                } else {
                    resolve({ resumed: false });
                }
            });
        };

        return waitForMetadata(deck, onMetadataReady);
    }

    async reloadCurrentSrc(src: string, opts: ReloadSrcOptions = {}): Promise<boolean> {
        const deck = this.getActiveDeck();
        if (!deck) return false;

        const positionMs = opts.positionMs ?? deck.currentTime * 1000;
        const wasPlaying = opts.resume ?? !deck.paused;

        deck.src = src;
        const reloadedSrc = deck.src;
        deck.volume = this.isMuted ? 0 : this.currentVolume;

        const restore = (): Promise<boolean> =>
            new Promise((resolve) => {
                // A later load (next track, skip) re-pointed the element while
                // we waited: restoring now would seek/resume THAT track to this
                // one's position.
                if (deck.src !== reloadedSrc) {
                    resolve(false);
                    return;
                }
                if (positionMs > 0) {
                    deck.currentTime = positionMs / 1000;
                }
                if (wasPlaying) {
                    deck.play().then(
                        () => {
                            this.userPaused = false;
                            this.setMediaSessionState('playing');
                            this.startTimeUpdates();
                            resolve(true);
                        },
                        () => resolve(false),
                    );
                } else {
                    resolve(true);
                }
            });

        return waitForMetadata(deck, restore, () => false);
    }

    prefetchNext(src: string): void {
        if (!this.initialized) return;
        if (!this.prefetchAudio) {
            this.prefetchAudio = document.createElement('audio');
            this.prefetchAudio.preload = 'auto';
            this.prefetchAudio.style.display = 'none';
            this.prefetchAudio.volume = 0;
            document.body.appendChild(this.prefetchAudio);
        }
        if (this.prefetchAudio.src !== src) {
            this.prefetchAudio.src = src;
        }
    }

    // -- Private: crossfade animation --

    /**
     * Equal-power crossfade using .volume animation.
     * Uses requestAnimationFrame with a setTimeout fallback for backgrounded tabs.
     */
    private animateCrossfade(
        fromDeck: HTMLAudioElement,
        toDeck: HTMLAudioElement,
        durationMs: number,
        volume: number,
        totalBeats: number,
        fromVolume: number,
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            const startTime = performance.now();
            let accumulatedMs = 0;
            let lastTickTime = startTime;
            let resolved = false;
            // Cancel bumps the token: any tick chain still queued for THIS fade
            // (e.g. a rAF requested before a hide/show) stops instead of driving
            // the decks along a stale curve or completing a newer fade.
            const token = ++this.fadeAnimationToken;
            const dead = (): boolean => resolved || token !== this.fadeAnimationToken;

            // Expose this Promise's resolver so cancelCrossfadeAnimation() can unblock
            // the awaiting triggerCrossfade() if a cancel arrives mid-fade.
            this.crossfadeResolve = resolve;

            const complete = (): void => {
                if (dead()) return;
                resolved = true;
                fromDeck.volume = 0;
                toDeck.volume = this.isMuted ? 0 : volume;
                // Clear the saved resolver BEFORE cancelCrossfadeAnimation() so it
                // doesn't double-invoke resolve() — we resolve exactly once here.
                this.crossfadeResolve = null;
                this.cancelCrossfadeAnimation();
                resolve();
            };

            // Fallback: if RAF freezes (tab backgrounded), ensure crossfade completes
            this.crossfadeFallbackTimerId = setTimeout(complete, durationMs + 200);

            const tick = (now: number, maxDeltaMs = 100): void => {
                if (dead()) return;

                // Use delta from last tick to accumulate elapsed time.
                // This is robust against Safari throttling performance.now() in
                // background tabs, which would otherwise cause volume to jump on
                // the next foreground frame.
                const delta = now - lastTickTime;
                lastTickTime = now;
                accumulatedMs += Math.min(delta, maxDeltaMs); // cap: no single-frame jumps
                const t = Math.min(accumulatedMs / durationMs, 1);

                // Equal-power curve
                const { gainOut: outVol, gainIn: inVol } = computeBlendGains(t, fromVolume, volume);

                if (!this.isMuted) {
                    fromDeck.volume = Math.max(0, Math.min(1, outVol));
                    toDeck.volume = Math.max(0, Math.min(1, inVol));
                }

                // Report progress
                if (this.callbacks?.onCrossfadeProgress) {
                    const currentBeat = Math.min(Math.floor(t * totalBeats) + 1, totalBeats);
                    this.callbacks.onCrossfadeProgress({
                        ratio: t,
                        currentBeat,
                        totalBeats,
                    });
                }

                if (t < 1) {
                    if (!hiddenTimer) this.crossfadeAnimationId = requestAnimationFrame(tick);
                } else {
                    complete();
                }
            };

            // requestAnimationFrame does not run in a hidden tab, so a fade that
            // starts or continues in the background never moved: the incoming
            // deck played silently and the fallback timer hard-swapped at the
            // end. There is no audio clock to hand the curve to (this backend
            // avoids Web Audio), so drive it from a timer while hidden — coarse
            // where the browser throttles background timers, but still a fade.
            let hiddenTimer: ReturnType<typeof setInterval> | null = null;
            const syncDriver = (): void => {
                if (dead()) return;
                if (document.hidden) {
                    // The rAF requested while visible stays queued (paused) and
                    // would fire on show next to the new one — two tick chains.
                    if (this.crossfadeAnimationId !== null) {
                        cancelAnimationFrame(this.crossfadeAnimationId);
                        this.crossfadeAnimationId = null;
                    }
                    hiddenTimer ??= setInterval(
                        () => tick(performance.now(), HIDDEN_FADE_MAX_STEP_MS),
                        HIDDEN_FADE_TICK_MS,
                    );
                } else if (hiddenTimer) {
                    clearInterval(hiddenTimer);
                    hiddenTimer = null;
                    lastTickTime = performance.now();
                    this.crossfadeAnimationId = requestAnimationFrame(tick);
                }
            };
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', syncDriver);
                this.crossfadeHiddenCleanup = () => {
                    document.removeEventListener('visibilitychange', syncDriver);
                    if (hiddenTimer) clearInterval(hiddenTimer);
                    hiddenTimer = null;
                };
                syncDriver();
            }

            if (!hiddenTimer) this.crossfadeAnimationId = requestAnimationFrame(tick);
        });
    }

    private cancelCrossfadeAnimation(): void {
        this.fadeAnimationToken++;
        this.crossfadeHiddenCleanup?.();
        this.crossfadeHiddenCleanup = null;
        if (this.crossfadeAnimationId !== null) {
            cancelAnimationFrame(this.crossfadeAnimationId);
            this.crossfadeAnimationId = null;
        }
        if (this.crossfadeFallbackTimerId !== null) {
            clearTimeout(this.crossfadeFallbackTimerId);
            this.crossfadeFallbackTimerId = null;
        }
        // Resolve any in-flight animateCrossfade() Promise so the awaiting
        // triggerCrossfade() unblocks (otherwise the store's crossfadePending never
        // resets). Mirrors CrossfadeEngine.cancel() invoking pendingResolve(). Null it
        // first so the normal-completion path (which nulls before calling us) and a
        // cancel path each resolve exactly once.
        if (this.crossfadeResolve !== null) {
            const resolve = this.crossfadeResolve;
            this.crossfadeResolve = null;
            resolve();
        }
    }

    // -- Private: time updates --

    /**
     * Guarded funnel for lock-screen handler registration.
     *
     * A backend that does not own MediaSession must not re-register handlers:
     * the audiobook player maps `nexttrack` to a CHAPTER, and the music-shaped
     * registration here would quietly replace that with a file skip.
     */
    private registerMediaSession(metadata: TrackMetadata | null): void {
        if (!this.manageMediaSession) return;
        registerMediaSessionHandlers(metadata, this.storedMediaSessionActions);
    }

    /**
     * Guarded lock-screen playback-state write.
     *
     * Same reason as {@link registerMediaSession}: when the caller owns
     * MediaSession, the backend must not write ANY part of it. Guarding only
     * handler registration and position state left playback-state and clear
     * unguarded, which made {@link BackendInitOptions.manageMediaSession}'s
     * "owns MediaSession outright" a stronger claim than the code kept.
     */
    private setMediaSessionState(state: 'playing' | 'paused' | 'none'): void {
        if (!this.manageMediaSession) return;
        updateMediaSessionPlaybackState(state);
    }

    /** Guarded lock-screen teardown; see {@link setMediaSessionState}. */
    private clearOwnedMediaSession(): void {
        if (!this.manageMediaSession) return;
        clearMediaSession();
    }

    private syncMediaSessionPosition(force = false): void {
        // File time would fight the audiobook player's book time; see
        // BackendInitOptions.manageMediaSession.
        if (!this.manageMediaSession) return;
        const deck = this.getActiveDeck();
        if (!deck) return;

        const now = performance.now();
        if (!force && now - this.lastPositionUpdateMs < 5000) return;
        this.lastPositionUpdateMs = now;

        const currentMs = deck.currentTime * 1000;
        const rawDuration = deck.duration;
        const durationMs = rawDuration && isFinite(rawDuration) ? rawDuration * 1000 : 0;

        if (durationMs > 0) {
            updateMediaSessionPositionState(durationMs / 1000, currentMs / 1000, deck.playbackRate);
        }
    }

    private startTimeUpdates(): void {
        this.stopTimeUpdates();
        this.timeUpdateInterval = setInterval(() => {
            const deck = this.getActiveDeck();
            if (!deck || deck.paused) return;

            const currentMs = deck.currentTime * 1000;
            const rawDuration = deck.duration;
            const durationMs = rawDuration && isFinite(rawDuration) ? rawDuration * 1000 : 0;

            const info: TimeUpdateInfo = {
                currentTimeMs: currentMs,
                durationMs,
                playbackRate: deck.playbackRate,
            };
            this.callbacks?.onTimeUpdate(info);

            // Throttled MediaSession position sync
            this.syncMediaSessionPosition();
        }, 50);
    }

    private stopTimeUpdates(): void {
        if (this.timeUpdateInterval !== null) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }
}
