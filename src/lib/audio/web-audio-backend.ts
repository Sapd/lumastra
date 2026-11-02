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
import { CrossfadeEngine, type AudioDeck } from '$lib/utils/crossfade-engine';
import { calculateCrossfadeDuration, resolveIncomingStartSec } from '$lib/utils/beat-math';
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
    registerVisibilityHandlers,
    startIncomingDeck,
    seekWhenReady,
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
 * Desktop + Android audio backend — A/B deck crossfade with Web Audio API.
 *
 * Uses two HTMLAudioElement + MediaElementAudioSourceNode + GainNode decks for
 * seamless equal-power crossfade. A shadow audio element provides background
 * playback when the AudioContext is suspended (Android background).
 *
 * Key preserved behaviors from the original store:
 * - Gain automation cleanup (cancelScheduledValues(0))
 * - Safari deferred cleanup (100ms guard on fromDeck.audio.src = '')
 * - setTimeout fallback in CrossfadeEngine for frozen RAF
 * - userPaused guard for pause/resume race condition
 * - Shadow-to-deck position sync on visibility change
 */
/** Upper bound on waiting for the incoming deck's metadata before its pre-seek. */
const PRE_SEEK_TIMEOUT_MS = 3000;

export class WebAudioBackend implements AudioBackend {
    readonly supportsCrossfade = true;
    readonly supportsVolumeControl = true;
    // WebAudio ramps playbackRate smoothly over ~2s in normalizePlaybackRate().
    readonly normalizationStyle = 'gradual' as const;

    /**
     * Whether to use the shadow audio element for background playback.
     * Only needed on Android where the OS suspends AudioContext in background.
     * Desktop browsers (including Safari) keep AudioContext running in background
     * tabs, so the shadow swap would cause an unnecessary audio glitch.
     */
    private readonly useShadowAudio: boolean;

    private audioContext: AudioContext | null = null;
    private crossfadeEngine: CrossfadeEngine | null = null;
    /**
     * Both decks (and the engine's echo tail) sum here before the destination.
     * Held at 1 except while muted DURING a fade: the engine owns both deck
     * gains then (per frame, or a scheduled curve), so a mute written to a deck
     * gain would be overwritten — or miss the incoming deck entirely.
     */
    private muteBus: GainNode | null = null;
    private deckA: AudioDeck | null = null;
    private deckB: AudioDeck | null = null;
    private activeDeck: 'A' | 'B' = 'A';
    private shadowAudio: HTMLAudioElement | null = null;
    private shadowActive = false;
    // Start paused — only play() or successful autoResume should clear this.
    // Prevents handleAudioContextStateChange from auto-playing on page load.
    private userPaused = true;
    private callbacks: AudioBackendCallbacks | null = null;
    private timeUpdateInterval: ReturnType<typeof setInterval> | null = null;
    private cleanupWakeLockReacquisition: (() => void) | null = null;
    private cleanupVisibilityHandler: (() => void) | null = null;
    private silentKeepalive: ReturnType<typeof createSilentAudioKeepalive> | null = null;
    private mediaSessionInitialized = false;
    private lastPositionUpdateMs = 0;
    private initialized = false;
    private currentVolume = 0.8;
    private isMuted = false;
    private _isCrossfading = false;
    /** Bumped per triggerCrossfade; see its generation check. */
    private crossfadeGeneration = 0;
    /** Set when setVolume/mute/unmute is called during an active crossfade.
     *  triggerCrossfade re-applies currentVolume/isMuted to the now-active deck
     *  after the fade so a mid-fade user volume change is not lost (B6). */
    private volumeChangedDuringCrossfade = false;
    private resumeAttempts = 0;
    private currentMetadata: TrackMetadata | null = null;
    /** False only for the audiobook player, which owns MediaSession itself. */
    private manageMediaSession = true;
    private readonly advanceScheduler = new GaplessAdvanceScheduler();
    private advanceRequest: GaplessAdvanceRequest | null = null;
    /**
     * True from arming a gapless advance until the swap has been accounted for.
     *
     * The outgoing element reaches its natural end at the swap instant and
     * fires `ended`. The deck-identity guard on that listener has not flipped
     * yet at that moment, so without this flag the store would receive an
     * `onTrackEnded` for a boundary the backend has already handled and advance
     * a second time — one file skipped, silently, every nine minutes.
     */
    private advancePending = false;
    /** Dedicated hidden element used only for next-track prefetch buffering. */
    private prefetchAudio: HTMLAudioElement | null = null;
    private static readonly MAX_RESUME_ATTEMPTS = 3;

    constructor(options?: { useShadowAudio?: boolean }) {
        this.useShadowAudio = options?.useShadowAudio ?? false;
    }

    // -- Deck helpers --

    private getActiveDeck(): AudioDeck | null {
        return this.activeDeck === 'A' ? this.deckA : this.deckB;
    }

    private getInactiveDeck(): AudioDeck | null {
        return this.activeDeck === 'A' ? this.deckB : this.deckA;
    }

    /**
     * Returns the HTMLAudioElement that is currently the source of truth
     * for playback position. When the shadow is active (background),
     * this is the shadow element; otherwise the active Web Audio deck.
     */
    private getPlaybackAudio(): HTMLAudioElement | null {
        if (this.shadowActive && this.shadowAudio && !this.shadowAudio.paused) {
            return this.shadowAudio;
        }
        return this.getActiveDeck()?.audio ?? null;
    }

    // -- Shadow audio for background playback --

    private activateShadowAudio(): void {
        if (!this.useShadowAudio) return;
        if (!this.shadowAudio || this.shadowActive || this.userPaused) return;
        // Mid-fade the engine owns both deck gains (and hands the rest of the
        // curve to the audio clock on hide): a shadow of the outgoing deck now
        // would play it twice. triggerCrossfade activates it once the fade is done.
        if (this._isCrossfading) return;
        const deck = this.getActiveDeck();
        if (!deck || deck.audio.paused) return;

        // The shadow is a SINGLE element — there is no B deck behind it, and
        // the gain swap an armed advance scheduled would land on a deck that is
        // muted anyway. Backgrounded Android therefore falls back to the
        // cold-start boundary via `shadowAudio.onended`.
        this.cancelGaplessAdvance();

        this.shadowAudio.src = deck.audio.src;
        this.shadowAudio.currentTime = deck.audio.currentTime;
        this.shadowAudio.volume = this.isMuted ? 0 : this.currentVolume;
        this.shadowAudio.onended = () => this.callbacks?.onTrackEnded();

        // Mute the Web Audio deck to prevent double playback on Android
        deck.gain.gain.cancelScheduledValues(0);
        deck.gain.gain.value = 0;

        this.shadowActive = true;

        this.shadowAudio.play().then(undefined, () => {
            // Shadow play failed — restore the active deck's gain so audio continues
            deck.gain.gain.cancelScheduledValues(0);
            deck.gain.gain.value = this.isMuted ? 0 : this.currentVolume;
            this.shadowActive = false;
        });
        console.debug('[WebAudioBackend] Shadow audio activated for background playback');
    }

    private deactivateShadowAudio(): void {
        if (!this.shadowAudio || !this.shadowActive) return;
        const deck = this.getActiveDeck();

        if (deck && this.shadowAudio.currentTime > 0) {
            deck.audio.currentTime = this.shadowAudio.currentTime;
            deck.gain.gain.cancelScheduledValues(0);
            deck.gain.gain.value = this.isMuted ? 0 : this.currentVolume;

            if (!deck.audio.paused) {
                // already playing
            } else {
                void deck.audio.play().catch(() => {});
            }
        }

        this.shadowAudio.pause();
        this.shadowAudio.onended = null;
        this.shadowAudio.src = '';
        this.shadowActive = false;
        console.debug('[WebAudioBackend] Shadow audio deactivated, Web Audio resumed');
    }

    // -- AudioContext state change handler --

    private handleAudioContextStateChange = (): void => {
        if (!this.audioContext) return;
        if (this.userPaused) return;
        if (this.audioContext.state === 'running') {
            this.resumeAttempts = 0;
            const deck = this.getActiveDeck();
            if (deck && deck.audio.paused) {
                void deck.audio.play().catch(() => {});
            }
        } else if (this.audioContext.state === 'suspended') {
            if (this.resumeAttempts >= WebAudioBackend.MAX_RESUME_ATTEMPTS) return;
            this.resumeAttempts++;
            void this.audioContext.resume();
        }
    };

    // -- Visibility / resume handlers (I7) --

    /**
     * Register the visibilitychange + page-resume listeners via the shared
     * registrar. Both init() and stop() use this so the transition logic lives
     * in exactly one place. Returns the cleanup function to store in
     * `cleanupVisibilityHandler`.
     */
    private registerVisibilityHandlers(): () => void {
        return registerVisibilityHandlers({
            onHidden: () => this.activateShadowAudio(),
            onVisible: () => {
                this.deactivateShadowAudio();
                if (this.audioContext?.state === 'suspended' && !this.userPaused) {
                    void this.audioContext.resume();
                }
            },
            onResume: () => {
                if (this.userPaused) return;
                this.deactivateShadowAudio();
                if (this.audioContext?.state === 'suspended') {
                    void this.audioContext.resume();
                }
                const deck = this.getActiveDeck();
                if (deck && deck.audio.paused) {
                    void deck.audio.play().catch(() => {});
                }
            },
        });
    }

    // -- MediaSession helpers --

    private registerMediaSessionHandlers(
        metadata: TrackMetadata | null = this.currentMetadata,
    ): void {
        if (!this.manageMediaSession) return;
        if (!this.storedMediaSessionActions) return;
        registerMediaSessionHandlers(metadata, this.storedMediaSessionActions);
        this.mediaSessionInitialized = true;
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
        // The audiobook player reports BOOK time across many files; this deck's
        // clock is file time. Whichever wrote last would win the lock-screen
        // scrubber, so the two never both write.
        if (!this.manageMediaSession) return;
        const now = performance.now();
        if (!force && now - this.lastPositionUpdateMs < 5000) return;
        this.lastPositionUpdateMs = now;
        const durationMs = this.getDurationMs();
        const currentMs = this.getCurrentTimeMs();
        if (durationMs > 0) {
            updateMediaSessionPositionState(durationMs / 1000, currentMs / 1000);
        }
    }

    // -- Lifecycle --

    /** Stored so we can re-register after stop() clears them */
    private storedMediaSessionActions: MediaSessionActions | null = null;

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

        // Create audio elements
        const audioElementA = document.createElement('audio');
        audioElementA.preload = 'auto';
        const audioElementB = document.createElement('audio');
        audioElementB.preload = 'auto';
        this.shadowAudio = document.createElement('audio');
        this.shadowAudio.preload = 'none';

        // Wire ended events on both decks
        audioElementA.addEventListener('ended', () => {
            if (this.activeDeck === 'A' && !this._isCrossfading && !this.advancePending) {
                this.callbacks?.onTrackEnded();
            }
        });
        audioElementB.addEventListener('ended', () => {
            if (this.activeDeck === 'B' && !this._isCrossfading && !this.advancePending) {
                this.callbacks?.onTrackEnded();
            }
        });
        // During a crossfade the store already promoted the incoming track, so
        // the outgoing (still active) deck failing is not the current track.
        for (const [el, id] of [
            [audioElementA, 'A'],
            [audioElementB, 'B'],
        ] as const) {
            watchMediaErrors(
                el,
                () => this.activeDeck === id && !this._isCrossfading,
                (error) => this.callbacks?.onPlaybackError?.(error),
            );
        }

        // Set up Web Audio graph
        try {
            this.audioContext = new AudioContext();
        } catch (err) {
            console.warn('[WebAudioBackend] AudioContext creation failed:', err);
            this.audioContext = null;
            return;
        }
        this.muteBus = this.audioContext.createGain();
        this.muteBus.gain.value = 1;
        this.muteBus.connect(this.audioContext.destination);
        this.crossfadeEngine = new CrossfadeEngine(this.audioContext, this.muteBus);

        const sourceA = this.audioContext.createMediaElementSource(audioElementA);
        const gainA = this.audioContext.createGain();

        // Shelving EQ filters — always in path, 0dB = transparent.
        // Used by bass-swap crossfade to control per-band volume.
        // Signal chain: source → eqLow → eqHigh → gain → muteBus → destination
        const eqLowA = this.audioContext.createBiquadFilter();
        eqLowA.type = 'lowshelf';
        eqLowA.frequency.value = 200;
        eqLowA.gain.value = 0; // transparent
        const eqHighA = this.audioContext.createBiquadFilter();
        eqHighA.type = 'highshelf';
        eqHighA.frequency.value = 3000;
        eqHighA.gain.value = 0;

        sourceA.connect(eqLowA);
        eqLowA.connect(eqHighA);
        eqHighA.connect(gainA);
        gainA.connect(this.muteBus);

        const sourceB = this.audioContext.createMediaElementSource(audioElementB);
        const gainB = this.audioContext.createGain();

        const eqLowB = this.audioContext.createBiquadFilter();
        eqLowB.type = 'lowshelf';
        eqLowB.frequency.value = 200;
        eqLowB.gain.value = 0;
        const eqHighB = this.audioContext.createBiquadFilter();
        eqHighB.type = 'highshelf';
        eqHighB.frequency.value = 3000;
        eqHighB.gain.value = 0;

        sourceB.connect(eqLowB);
        eqLowB.connect(eqHighB);
        eqHighB.connect(gainB);
        gainB.connect(this.muteBus);

        this.deckA = {
            audio: audioElementA,
            source: sourceA,
            gain: gainA,
            eqLow: eqLowA,
            eqHigh: eqHighA,
        };
        this.deckB = {
            audio: audioElementB,
            source: sourceB,
            gain: gainB,
            eqLow: eqLowB,
            eqHigh: eqHighB,
        };

        gainA.gain.value = 1;
        gainB.gain.value = 0;

        this.audioContext.addEventListener('statechange', this.handleAudioContextStateChange);

        if (!this.silentKeepalive) {
            this.silentKeepalive = createSilentAudioKeepalive({
                audioContext: this.audioContext ?? undefined,
            });
        }

        // MediaSession
        if (!this.mediaSessionInitialized) {
            this.registerMediaSessionHandlers();
        }

        // Wake Lock reacquisition
        this.cleanupWakeLockReacquisition = setupWakeLockReacquisition(
            () => !this.userPaused && this.getActiveDeck()?.audio.paused === false,
        );

        // Visibility change + iOS freeze/resume: handle background/foreground
        // transitions via the shared registrar (single registration site).
        this.cleanupVisibilityHandler = this.registerVisibilityHandlers();

        // Start time update interval
        this.startTimeUpdates();
    }

    destroy(): void {
        this.stopTimeUpdates();
        this.cancelGaplessAdvance();
        this.crossfadeEngine?.destroy();

        this.deckA?.audio.pause();
        this.deckB?.audio.pause();
        if (this.deckA) this.deckA.audio.src = '';
        if (this.deckB) this.deckB.audio.src = '';

        if (this.shadowAudio) {
            this.shadowAudio.pause();
            this.shadowAudio.src = '';
            this.shadowAudio = null;
        }

        if (this.prefetchAudio) {
            this.prefetchAudio.src = '';
            this.prefetchAudio.remove();
            this.prefetchAudio = null;
        }

        if (this.audioContext) {
            this.audioContext.removeEventListener(
                'statechange',
                this.handleAudioContextStateChange,
            );
            void this.audioContext.close();
            this.audioContext = null;
        }

        this.clearOwnedMediaSession();
        destroyWakeLock();
        this.cleanupWakeLockReacquisition?.();
        this.cleanupWakeLockReacquisition = null;
        this.cleanupVisibilityHandler?.();
        this.cleanupVisibilityHandler = null;
        this.silentKeepalive?.stop();

        this.crossfadeEngine = null;
        this.muteBus = null;
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
        this.resumeAttempts = 0;

        // A pending advance is scheduled against the OLD deck's boundary; this
        // load replaces it. Dropping it here rather than in the caller keeps
        // the invariant local to the machinery that owns it.
        this.advanceScheduler.cancel();
        this.advancePending = false;
        this.advanceRequest = null;

        if (this._isCrossfading && this.crossfadeEngine) {
            this.crossfadeEngine.cancel();
            this.setCrossfading(false);
        }

        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
        }

        const deck = this.getActiveDeck();
        if (!deck) return;

        deck.audio.src = src;
        deck.gain.gain.cancelScheduledValues(0);
        // Mute-aware: a mute that lived on the bus during a fade this play()
        // just cancelled must carry over to the deck, not be dropped.
        deck.gain.gain.value = this.isMuted ? 0 : this.currentVolume;
        this.currentMetadata = metadata;

        // Silence the inactive deck in case it was mid-crossfade
        const inactive = this.getInactiveDeck();
        if (inactive) {
            inactive.gain.gain.cancelScheduledValues(0);
            inactive.gain.gain.value = 0;
            inactive.audio.pause();
            inactive.audio.src = '';
        }

        // If shadow is active (Android background), switch the shadow to the new track
        if (this.shadowActive && this.shadowAudio) {
            this.shadowAudio.src = src;
            // Mirrors the deck's start offset, not 0: the shadow element IS the
            // audible one while Android has the AudioContext suspended, so a
            // hardcoded 0 would restart the file on a backgrounded resume.
            this.shadowAudio.currentTime = (options?.startAtMs ?? 0) / 1000;
            void this.shadowAudio.play().catch(() => {});
        }

        // Restart time updates if they were killed by stop()
        this.startTimeUpdates();

        if (options?.playbackRate !== undefined) {
            applyPlaybackRate(deck.audio, options.playbackRate, options.preservePitch !== false);
        }

        // Seek BEFORE play(): play-then-seek is audible as a blip, and it is
        // the difference between resuming a 20-hour book and restarting a file.
        if (options?.startAtMs !== undefined && options.startAtMs > 0) {
            await seekWhenReady(deck.audio, options.startAtMs);
        }

        // A load/decode failure rejects out of here. An autoplay block or a
        // superseding load resolves `false`, and still registers the session
        // so the lock screen can start playback with a gesture.
        await playMediaElement(deck.audio);

        this.registerMediaSessionHandlers(metadata);
        this.setMediaSessionState('playing');
        void requestWakeLock();
        this.silentKeepalive?.start();
    }

    pause(): void {
        this.userPaused = true;
        // An armed advance has already scheduled its gain swap on the audio
        // clock and its incoming deck is playing. Pausing only the active deck
        // would leave that one to become audible a moment later — i.e. pause
        // would resume the book.
        this.cancelGaplessAdvance();
        this.getActiveDeck()?.audio.pause();
        if (this.shadowAudio && this.shadowActive) {
            this.shadowAudio.pause();
        }
        this.setMediaSessionState('paused');
        void releaseWakeLock();
        this.silentKeepalive?.stop();
    }

    resume(): void {
        this.userPaused = false;
        this.resumeAttempts = 0;
        if (this.audioContext?.state === 'suspended') {
            void this.audioContext.resume();
        }
        void this.getActiveDeck()
            ?.audio.play()
            .then(
                () => {
                    this.registerMediaSessionHandlers(this.currentMetadata);
                    this.syncMediaSessionPosition(true);
                },
                () => {},
            );
        // If in background, also resume shadow element
        if (this.shadowAudio && this.shadowActive && document.visibilityState === 'hidden') {
            const deck = this.getActiveDeck();
            if (deck) {
                this.shadowAudio.currentTime = deck.audio.currentTime;
                void this.shadowAudio.play().catch(() => {});
            }
        }
        this.setMediaSessionState('playing');
        void requestWakeLock();
        this.silentKeepalive?.start();
    }

    stop(): void {
        this.userPaused = true;
        this.cancelGaplessAdvance();
        this.crossfadeEngine?.cancel();
        this.setCrossfading(false);
        this.deckA?.audio.pause();
        this.deckB?.audio.pause();
        if (this.deckA) this.deckA.audio.src = '';
        if (this.deckB) this.deckB.audio.src = '';

        if (this.shadowAudio) {
            this.shadowAudio.pause();
            this.shadowAudio.src = '';
            this.shadowActive = false;
        }

        this.stopTimeUpdates();
        this.currentMetadata = null;

        // Clear lock screen metadata & release wake lock.
        // Re-register handlers immediately: clearMediaSession() removes them
        this.clearOwnedMediaSession();
        if (this.mediaSessionInitialized && this.storedMediaSessionActions) {
            this.registerMediaSessionHandlers();
        }
        destroyWakeLock();
        this.cleanupWakeLockReacquisition?.();
        this.cleanupWakeLockReacquisition = null;
        this.cleanupVisibilityHandler?.();
        this.cleanupVisibilityHandler = null;

        if (this.audioContext) {
            // Re-register so AudioContext resumes after stop()+play() and
            // background/foreground transitions keep working.
            this.cleanupVisibilityHandler = this.registerVisibilityHandlers();

            this.cleanupWakeLockReacquisition = setupWakeLockReacquisition(
                () => !this.userPaused && this.getActiveDeck()?.audio.paused === false,
            );
        }

        this.silentKeepalive?.stop();
    }

    seekTo(ms: number): void {
        // The swap was scheduled against a boundary this seek just moved.
        this.cancelGaplessAdvance();
        const deck = this.getActiveDeck();
        if (deck) {
            deck.audio.currentTime = ms / 1000;
            if (this.shadowAudio && this.shadowActive) {
                this.shadowAudio.currentTime = ms / 1000;
            }
            this.syncMediaSessionPosition(true);
        }
    }

    // -- Volume --

    setVolume(volume: number): void {
        this.currentVolume = volume;
        this.isMuted = volume === 0;
        const deck = this.getActiveDeck();
        if (deck) {
            if (this._isCrossfading) {
                // During a fade the CrossfadeEngine owns the deck gains via its
                // per-tick automation, so a one-shot write here would be stomped
                // on the next frame. Mark that the user changed volume mid-fade
                // so triggerCrossfade re-applies it to the now-active deck once
                // the fade completes (B6). Mute (0) takes effect immediately
                // because silence mid-fade is more jarring than a level tweak;
                // the engine clamps to <=1 but never below the muted floor we
                // set here within the same frame.
                this.volumeChangedDuringCrossfade = true;
                this.syncMuteBus();
            } else {
                deck.gain.gain.value = volume;
            }
        }
        if (this.shadowAudio && this.shadowActive) {
            this.shadowAudio.volume = volume;
        }
    }

    mute(): void {
        this.isMuted = true;
        const deck = this.getActiveDeck();
        if (deck && this.audioContext) {
            if (this._isCrossfading) {
                // Mid-fade the engine owns both deck gains; silence the bus
                // instead. The post-fade re-apply in triggerCrossfade moves the
                // mute onto the now-active deck and releases the bus.
                this.volumeChangedDuringCrossfade = true;
                this.syncMuteBus();
            } else {
                deck.gain.gain.cancelScheduledValues(0);
                deck.gain.gain.setValueAtTime(0, this.audioContext.currentTime);
            }
        }
        if (this.shadowAudio && this.shadowActive) {
            this.shadowAudio.volume = 0;
        }
    }

    unmute(restoreVolume: number): void {
        this.isMuted = false;
        this.currentVolume = restoreVolume;
        const deck = this.getActiveDeck();
        if (deck && this.audioContext) {
            if (this._isCrossfading) {
                // Defer the level to the post-fade re-apply (engine owns gains
                // mid-fade); the fade itself becomes audible again right away.
                this.volumeChangedDuringCrossfade = true;
                this.syncMuteBus();
            } else {
                deck.gain.gain.setValueAtTime(restoreVolume, this.audioContext.currentTime);
            }
        }
        if (this.shadowAudio && this.shadowActive) {
            this.shadowAudio.volume = restoreVolume;
        }
    }

    // -- Crossfade --

    async triggerCrossfade(
        nextSrc: string,
        metadata: TrackMetadata,
        options?: CrossfadeOptions,
    ): Promise<void> {
        // Throw (rather than silently resolve) when the fade cannot run at
        // all: the store promotes the incoming track BEFORE awaiting us, so a
        // silent bail would leave state on the new track while audio keeps
        // playing the old one. A rejection routes to the store's catch, which
        // hard-cuts to the promoted track.
        if (!this.audioContext || !this.crossfadeEngine) {
            throw new Error('crossfade unavailable: no AudioContext/engine');
        }

        // Both mechanisms want the inactive deck; the crossfade wins because
        // it is the explicit user-visible transition.
        this.cancelGaplessAdvance();

        // Also engages the mute bus when muted before the fade — the gains set
        // below would otherwise un-mute it.
        this.setCrossfading(true);
        // Identifies THIS fade: a cancelled fade resuming from an await must not
        // mistake a newer fade's flag for its own (it would swap decks twice).
        const generation = ++this.crossfadeGeneration;
        this.volumeChangedDuringCrossfade = false;

        const fromDeck = this.getActiveDeck();
        const toDeck = this.getInactiveDeck();
        if (!fromDeck || !toDeck) {
            this.setCrossfading(false);
            throw new Error('crossfade unavailable: missing deck');
        }

        // Ensure clean gain state.
        // For bass-swap: leave outgoing gain untouched (the EQ handles the
        // per-band crossfade, and changing to LUFS-adjusted causes a volume drop).
        // For other modes: set to LUFS-adjusted outgoing volume.
        if (options?.fadeMode !== 'bassswap') {
            const initialFromVolume =
                options?.outgoingVolume ?? options?.volume ?? this.currentVolume;
            fromDeck.gain.gain.cancelScheduledValues(0);
            fromDeck.gain.gain.value = initialFromVolume;
        }
        toDeck.gain.gain.cancelScheduledValues(0);
        toDeck.gain.gain.value = 0;

        toDeck.audio.src = nextSrc;
        this.currentMetadata = metadata;

        // Buffer where the fade will enter, BEFORE the readiness wait: the
        // engine's phase-aligned start is the nearest downbeat to the intro end
        // plus less than one bar, so it then lands in already-buffered audio.
        // Seeking there only after the wait (from position 0) re-buffered at
        // the start of the fade and shifted the alignment by the re-buffer.
        const preSeekSec = resolveIncomingStartSec(
            {
                incomingIntroEndMs: options?.incomingIntroEndMs,
                incomingDownbeats: options?.incomingDownbeats,
                incomingBeatGrid: options?.incomingBeatGrid,
                incomingBpm: options?.incomingBpm,
            },
            0,
        );
        if (preSeekSec > 0) {
            // A seek that loses the race must not land later and undo the
            // engine's phase-aligned position.
            let abandoned = false;
            await Promise.race([
                waitForMetadata(
                    toDeck.audio,
                    async () => {
                        if (!abandoned) toDeck.audio.currentTime = preSeekSec;
                    },
                    () => undefined,
                ),
                new Promise<void>((resolve) => setTimeout(resolve, PRE_SEEK_TIMEOUT_MS)),
            ]);
            abandoned = true;
            if (!this._isCrossfading || generation !== this.crossfadeGeneration) return;
        }

        if (this.audioContext.state === 'suspended') {
            // Bounded: resume() can stay pending (Android with the shadow
            // element active), which would stall the fade flag forever.
            await Promise.race([
                this.audioContext.resume(),
                new Promise<void>((resolve) => setTimeout(resolve, 2000)),
            ]);
        }

        try {
            await startIncomingDeck(toDeck.audio);
        } catch (err) {
            console.warn('[WebAudioBackend] Crossfade: incoming deck did not start', err);
            if (generation === this.crossfadeGeneration) this.setCrossfading(false);
            // Rethrow so the store's catch can hard-cut to the promoted track
            // (see the unavailable-throw above for why resolving would desync).
            throw err;
        }

        // A successful play() only means the autoplay policy let us start — it
        // does NOT mean the incoming element has buffered enough audio to render
        // sound. If we begin the equal-power fade now and the element is still
        // stalling on the network, the outgoing track fades out over silence and
        // we hear a gap. Wait for the incoming deck to be ready to play through
        // (HAVE_FUTURE_DATA / canplaythrough) before starting the fade. If it
        // does not become ready within the timeout, treat it as a stall and fall
        // back to a hard CUT so the transition is at worst a clean splice rather
        // than a long fade across a dead deck.
        const incomingReady = await this.waitForIncomingReady(toDeck.audio, 2000);

        // play()/preload() or a skip may have cancelled us while we awaited
        // buffering — bail without touching the decks if so.
        if (!this._isCrossfading || generation !== this.crossfadeGeneration) return;

        // The incoming stream failed while buffering (expired token, 404,
        // transcode error). Fading — or cutting — to it would silence the
        // outgoing track for a deck that never sounds, and the element's error
        // event already fired while it was inactive, so nothing would recover
        // it. Abandon the fade; the store's catch hard-cuts with token recovery.
        const failure = elementFailure(toDeck.audio);
        if (failure) {
            toDeck.audio.pause();
            toDeck.gain.gain.cancelScheduledValues(0);
            toDeck.gain.gain.value = 0;
            this.volumeChangedDuringCrossfade = false;
            this.setCrossfading(false);
            throw failure;
        }

        const effectiveFadeMode = incomingReady ? options?.fadeMode : 'cut';
        if (!incomingReady) {
            console.warn(
                '[WebAudioBackend] Crossfade: incoming deck stalled buffering — falling back to cut',
            );
        }

        // Never longer than the outgoing audio left NOW: the pre-seek and
        // readiness waits ate into the lead the planner reserved (1s for
        // end-aligned and bass-swap fades), and a fade outliving the outgoing
        // track just fades in over silence.
        const paceBpm = options?.paceBpm ?? options?.outgoingBpm ?? options?.incomingBpm ?? 0;
        let fadeBeats = options?.beats;
        const outgoingLeftMs = isFinite(fromDeck.audio.duration)
            ? (fromDeck.audio.duration - fromDeck.audio.currentTime) * 1000 - 250
            : Infinity;
        if (
            fadeBeats !== undefined &&
            calculateCrossfadeDuration(paceBpm, fadeBeats) > outgoingLeftMs
        ) {
            const beatMs = calculateCrossfadeDuration(paceBpm, 1);
            fadeBeats = Math.max(1, Math.floor(Math.max(outgoingLeftMs, 0) / beatMs));
        }

        await this.crossfadeEngine.startCrossfade(fromDeck, toDeck, {
            beats: fadeBeats,
            paceBpm: options?.paceBpm,
            volume: options?.incomingVolume ?? options?.volume ?? this.currentVolume,
            outgoingVolume: options?.outgoingVolume ?? options?.volume ?? this.currentVolume,
            fadeMode: effectiveFadeMode,
            outgoingBpm: options?.outgoingBpm,
            outgoingDownbeats: options?.outgoingDownbeats,
            // Read NOW, after the readiness wait (100-500ms typically): the
            // caller's value was captured before it, and aligning to a stale
            // position flams the downbeats by exactly that wait.
            outgoingCurrentTimeSec: fromDeck.audio.currentTime,
            incomingBpm: options?.incomingBpm,
            incomingBeatGrid: options?.incomingBeatGrid,
            incomingDownbeats: options?.incomingDownbeats,
            incomingIntroEndMs: options?.incomingIntroEndMs,
            onProgress: (progress) => {
                this.callbacks?.onCrossfadeProgress?.({
                    ratio: progress.ratio,
                    currentBeat: progress.currentBeat,
                    totalBeats: progress.totalBeats,
                });
            },
        });

        // If the crossfade was cancelled (by pause, skip, or play), cancelCrossfade
        // already swapped the active deck and cleared _isCrossfading. The resolved
        // Promise is just the cancel resolving — don't do post-crossfade cleanup.
        if (!this._isCrossfading || generation !== this.crossfadeGeneration) return;

        // Swap active deck. currentVolume is not updated here — the store
        // re-syncs it right after this resolves (setVolume with the incoming
        // track's LUFS-adjusted volume), which also corrects any volume change
        // that arrived mid-fade with the wrong track's normalization.
        this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
        this.setCrossfading(false);

        // Re-apply the user's volume/mute to the now-active deck (B6).
        // The engine's setFinalGains left this deck at the LUFS-adjusted
        // incoming `volume`, which is correct for steady-state playback only
        // when the user hasn't muted or changed volume mid-fade. If a mute or
        // volume change arrived while crossfading we deferred it; settle it now
        // so the deck reflects the live user state rather than the LUFS target.
        // Also whenever muted: a mute that was already on when the fade began
        // lived only on the bus, and the engine left this deck at its fade level.
        if (this.volumeChangedDuringCrossfade || this.isMuted) {
            const nowActive = this.getActiveDeck();
            if (nowActive) {
                nowActive.gain.gain.cancelScheduledValues(0);
                nowActive.gain.gain.value = this.isMuted ? 0 : this.currentVolume;
            }
            this.volumeChangedDuringCrossfade = false;
        }

        // If shadow is active (Android background), switch it to the new track
        if (this.shadowActive && this.shadowAudio) {
            this.shadowAudio.src = toDeck.audio.src;
            this.shadowAudio.currentTime = toDeck.audio.currentTime;
            void this.shadowAudio.play().catch(() => {});
        } else if (typeof document !== 'undefined' && document.hidden) {
            // Hidden during the fade (shadow activation is deferred while
            // fading): hand the now-current track to the shadow element as the
            // visibility handler would have.
            this.activateShadowAudio();
        }

        // Update lock screen for the new track
        this.registerMediaSessionHandlers(metadata);

        // A failure DURING the fade fired its error event while this deck was
        // still the inactive one, which watchMediaErrors ignores. It is the
        // current track now — report it so the store's recovery runs.
        const lateFailure = elementFailure(toDeck.audio);
        if (lateFailure) this.callbacks?.onPlaybackError?.(lateFailure);

        // Just pause the outgoing deck — do NOT clear audio.src.
        // On Safari, setting audio.src = '' on a MediaElementAudioSourceNode
        // briefly interrupts the entire AudioContext (causing ~500ms silence on
        // the new active deck). The src is naturally replaced when this deck is
        // next used as the incoming deck in a crossfade or play() call.
        fromDeck.audio.pause();
    }

    /**
     * Resolve once the incoming element is buffered enough to render sound
     * (`readyState >= HAVE_FUTURE_DATA`), or `false` if it does not reach that
     * state within `timeoutMs`. Used by triggerCrossfade (B3) to avoid fading
     * out the outgoing deck over a still-buffering incoming deck — if it
     * stalls, the caller hard-cuts instead.
     */
    private waitForIncomingReady(el: HTMLAudioElement, timeoutMs: number): Promise<boolean> {
        // Pre-attached error: the element is already in a failed state.
        if (el.error !== null) {
            return Promise.resolve(false);
        }

        // HAVE_FUTURE_DATA (3) means at least the next frame is decoded and the
        // element can advance currentTime without immediately stalling.
        if (el.readyState >= 3) {
            return Promise.resolve(true);
        }

        return new Promise<boolean>((resolve) => {
            let settled = false;
            const cleanup = (): void => {
                el.removeEventListener('canplaythrough', onReady);
                el.removeEventListener('canplay', onReady);
                el.removeEventListener('error', onError);
                el.removeEventListener('stalled', onStall);
                el.removeEventListener('abort', onStall);
                el.removeEventListener('emptied', onStall);
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
            // 'stalled', 'abort', and 'emptied' mean the browser has given up
            // buffering (at least temporarily). Treat them as a stall signal:
            // resolve with the same readyState-based heuristic as the timeout so
            // the caller can cut immediately rather than waiting the full timeout.
            const onStall = (): void => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(el.readyState >= 2);
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
            el.addEventListener('stalled', onStall, { once: true });
            el.addEventListener('abort', onStall, { once: true });
            el.addEventListener('emptied', onStall, { once: true });
        });
    }

    cancelCrossfade(): void {
        if (this.crossfadeEngine) {
            this.crossfadeEngine.cancel();
        }

        if (this._isCrossfading) {
            // Swap to the incoming deck (which has the new track loaded)
            const outgoing = this.getActiveDeck();
            this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
            const incoming = this.getActiveDeck();

            // Set incoming deck to full volume
            if (incoming) {
                incoming.gain.gain.cancelScheduledValues(0);
                incoming.gain.gain.value = this.isMuted ? 0 : this.currentVolume;
                incoming.audio.playbackRate = 1;
            }

            // Silence and pause outgoing deck (don't clear src — Safari AudioContext bug)
            if (outgoing) {
                outgoing.gain.gain.cancelScheduledValues(0);
                outgoing.gain.gain.value = 0;
                outgoing.audio.pause();
            }
        }

        // cancelCrossfade already applied isMuted/currentVolume to the incoming
        // deck above, so any deferred mid-fade volume change is now settled.
        this.volumeChangedDuringCrossfade = false;
        this.setCrossfading(false);
    }

    private setCrossfading(value: boolean): void {
        this._isCrossfading = value;
        this.syncMuteBus();
    }

    /** Bus at 0 only while muted during a fade (see {@link muteBus}). */
    private syncMuteBus(): void {
        if (!this.muteBus || !this.audioContext) return;
        const gain = this.muteBus.gain;
        const now = this.audioContext.currentTime;
        // Short glide, not a step: a hard 0/1 jump on a playing signal clicks.
        gain.cancelScheduledValues(0);
        gain.setValueAtTime(gain.value, now);
        gain.setTargetAtTime(this._isCrossfading && this.isMuted ? 0 : 1, now, 0.005);
    }

    normalizePlaybackRate(): void {
        const deck = this.getActiveDeck();
        if (deck && this.crossfadeEngine) {
            this.crossfadeEngine.normalizePlaybackRate(deck);
        }
    }

    // -- Playback rate --

    setPlaybackRate(rate: number, options: PlaybackRateOptions): void {
        const deck = this.getActiveDeck();
        if (deck) applyPlaybackRate(deck.audio, rate, options.preservePitch);
        // The shadow element is what Android actually hears in the background,
        // so a rate applied only to the deck silently reverts to 1× there.
        if (this.shadowAudio) applyPlaybackRate(this.shadowAudio, rate, options.preservePitch);
    }

    // -- Gapless file-boundary advance --

    readonly supportsGaplessAdvance = true;

    scheduleGaplessAdvance(request: GaplessAdvanceRequest | null): boolean {
        if (request === null) {
            this.advanceScheduler.cancel();
            this.advancePending = false;
            this.advanceRequest = null;
            return false;
        }

        if (!this.audioContext || this._isCrossfading || this.shadowActive) return false;
        const from = this.getActiveDeck();
        const to = this.getInactiveDeck();
        if (!from || !to) return false;

        this.advanceRequest = request;
        const scheduled = this.advanceScheduler.start(
            {
                getOutgoingTimeMs: () => from.audio.currentTime * 1000,
                getOutgoingDurationMs: () => {
                    const d = from.audio.duration;
                    return Number.isFinite(d) ? d * 1000 : 0;
                },
                getPlaybackRate: () => from.audio.playbackRate || 1,
                prepareIncoming: async () => {
                    to.gain.gain.cancelScheduledValues(0);
                    to.gain.gain.value = 0;
                    to.audio.src = request.src;
                    // Rate goes on before playback: a freshly loaded deck is at
                    // 1×, and applying it after the swap is audible as a lurch.
                    applyPlaybackRate(
                        to.audio,
                        request.playbackRate ?? from.audio.playbackRate ?? 1,
                        request.preservePitch !== false,
                    );
                    await seekWhenReady(to.audio, request.startAtMs ?? 0);
                },
                playIncomingSilent: async () => {
                    if (this.audioContext?.state === 'suspended') {
                        await this.audioContext.resume().catch(() => {});
                    }
                    try {
                        await to.audio.play();
                        return true;
                    } catch {
                        return false;
                    }
                },
                commitSwap: (delaySec) => {
                    const ctx = this.audioContext;
                    if (!ctx) return;
                    const at = ctx.currentTime + delaySec;
                    const level = this.isMuted ? 0 : this.currentVolume;
                    // setValueAtTime, not a ramp: prototype 4a's answer is a
                    // scheduled hard swap. A zero-length fade is not the same
                    // thing — it re-introduces the gap it was meant to remove.
                    from.gain.gain.cancelScheduledValues(at);
                    from.gain.gain.setValueAtTime(0, at);
                    to.gain.gain.cancelScheduledValues(at);
                    to.gain.gain.setValueAtTime(level, at);
                },
                abortSwap: () => {
                    to.gain.gain.cancelScheduledValues(0);
                    to.gain.gain.value = 0;
                    to.audio.pause();
                    // The outgoing deck matters as much as the incoming one: a
                    // commitSwap that already ran left a drop-to-zero on the
                    // audio clock, and it fires whether or not the swap was
                    // cancelled. Clearing it is the difference between a
                    // cancelled advance and the book going silent.
                    from.gain.gain.cancelScheduledValues(0);
                    from.gain.gain.value = this.isMuted ? 0 : this.currentVolume;
                },
            },
            {
                leadMs: request.leadMs,
                onCommitted: () => this.completeGaplessAdvance(),
                // Without this, a give-up leaves advancePending latched and the
                // outgoing deck's real `ended` is swallowed forever.
                onCancelled: () => this.cancelGaplessAdvance(),
            },
        );

        this.advancePending = scheduled;
        if (!scheduled) this.advanceRequest = null;
        return scheduled;
    }

    /** Drop any scheduled advance and forget its request. */
    private cancelGaplessAdvance(): void {
        this.advanceScheduler.cancel();
        this.advancePending = false;
        this.advanceRequest = null;
    }

    /** Flip deck identity after the audio swap has already happened. */
    private completeGaplessAdvance(): void {
        const request = this.advanceRequest;
        this.advanceRequest = null;
        if (!request) return;

        const outgoing = this.getActiveDeck();
        this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
        if (outgoing) {
            outgoing.gain.gain.cancelScheduledValues(0);
            outgoing.gain.gain.value = 0;
            // Pause rather than leave it running to its own `ended`: it is
            // inaudible either way, but a paused element stops decoding.
            outgoing.audio.pause();
        }

        this.currentMetadata = request.metadata;
        this.registerMediaSessionHandlers(request.metadata);
        this.advancePending = false;

        this.callbacks?.onGaplessAdvanceCommitted?.({
            src: request.src,
            // Read, never assumed: the incoming deck has been playing for the
            // lead, so this is past `startAtMs` by design.
            positionMs: this.getCurrentTimeMs(),
        });
    }

    // -- State queries --

    getCurrentTimeMs(): number {
        const el = this.getPlaybackAudio();
        return el ? el.currentTime * 1000 : 0;
    }

    getDurationMs(): number {
        const el = this.getPlaybackAudio();
        if (!el) return 0;
        const d = el.duration;
        return d && isFinite(d) ? d * 1000 : 0;
    }

    getPlaybackRate(): number {
        return this.getActiveDeck()?.audio.playbackRate ?? 1;
    }

    getCrossfadeIncomingTimeMs(): number | null {
        // During a fade the active deck is still the outgoing track; the
        // incoming track plays on the inactive deck until the completion swap.
        if (!this._isCrossfading) return null;
        const el = this.getInactiveDeck()?.audio;
        return el ? el.currentTime * 1000 : null;
    }

    isCrossfading(): boolean {
        return this._isCrossfading;
    }

    getAudioElement(): HTMLAudioElement | null {
        return this.getActiveDeck()?.audio ?? null;
    }

    getAllAudioElements(): HTMLAudioElement[] {
        const elements: HTMLAudioElement[] = [];
        if (this.deckA?.audio) elements.push(this.deckA.audio);
        if (this.deckB?.audio) elements.push(this.deckB.audio);
        return elements;
    }

    supportsOutputSelection(): boolean {
        return (
            typeof AudioContext !== 'undefined' &&
            'setSinkId' in AudioContext.prototype &&
            this.audioContext !== null
        );
    }

    async setOutputDevice(deviceId: string): Promise<boolean> {
        // Both decks route through MediaElementSource → context.destination,
        // so the AudioContext sink governs output; per-element sinkIds would
        // be ignored while the elements are bound to the graph.
        const ctx = this.audioContext as
            (AudioContext & { setSinkId?: (sinkId: string) => Promise<void> }) | null;
        if (!ctx?.setSinkId) return false;
        try {
            await ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
            return true;
        } catch (err) {
            console.warn('[WebAudioBackend] setSinkId failed:', err);
            return false;
        }
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

        // Show track metadata on lock screen even before user presses play
        this.registerMediaSessionHandlers(metadata);

        const deck = this.getActiveDeck();
        if (!deck) return { resumed: false };

        deck.audio.src = src;
        deck.gain.gain.value = volume;

        const onMetadataReady = (): Promise<{ resumed: boolean }> => {
            return new Promise((resolve) => {
                if (positionMs > 0) {
                    deck.audio.currentTime = positionMs / 1000;
                }

                if (autoResume) {
                    deck.audio.play().then(
                        () => {
                            this.userPaused = false;
                            this.registerMediaSessionHandlers(metadata);
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

        return waitForMetadata(deck.audio, onMetadataReady);
    }

    async reloadCurrentSrc(src: string, opts: ReloadSrcOptions = {}): Promise<boolean> {
        const deck = this.getActiveDeck();
        if (!deck) return false;

        const positionMs = opts.positionMs ?? deck.audio.currentTime * 1000;
        const wasPlaying = opts.resume ?? !deck.audio.paused;

        // Re-point the SAME deck element. The MediaElementSource node is bound
        // to the element (not the URL), so it stays attached — no graph rewire.
        deck.audio.src = src;
        const reloadedSrc = deck.audio.src;
        deck.gain.gain.cancelScheduledValues(0);
        deck.gain.gain.value = this.currentVolume;

        // Mirror the Android background shadow element if it is active.
        if (this.shadowActive && this.shadowAudio) {
            this.shadowAudio.src = src;
        }

        const restore = (): Promise<boolean> =>
            new Promise((resolve) => {
                // A later load (next track, skip) re-pointed the element while
                // we waited: restoring now would seek/resume THAT track to this
                // one's position.
                if (deck.audio.src !== reloadedSrc) {
                    resolve(false);
                    return;
                }
                if (positionMs > 0) {
                    deck.audio.currentTime = positionMs / 1000;
                    if (this.shadowActive && this.shadowAudio) {
                        this.shadowAudio.currentTime = positionMs / 1000;
                    }
                }
                if (wasPlaying) {
                    deck.audio.play().then(
                        () => {
                            if (this.shadowActive && this.shadowAudio) {
                                void this.shadowAudio.play().catch(() => {});
                            }
                            this.startTimeUpdates();
                            this.setMediaSessionState('playing');
                            resolve(true);
                        },
                        () => resolve(false),
                    );
                } else {
                    resolve(true);
                }
            });

        return waitForMetadata(deck.audio, restore, () => false);
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

    // -- Time updates --

    private startTimeUpdates(): void {
        this.stopTimeUpdates();
        this.timeUpdateInterval = setInterval(() => {
            const playbackEl = this.getPlaybackAudio();
            if (!playbackEl || playbackEl.paused) return;

            const currentMs = playbackEl.currentTime * 1000;
            const rawDuration = playbackEl.duration;
            const durationMs = rawDuration && isFinite(rawDuration) ? rawDuration * 1000 : 0;
            const rate = this.getActiveDeck()?.audio.playbackRate ?? 1;

            const info: TimeUpdateInfo = {
                currentTimeMs: currentMs,
                durationMs,
                playbackRate: rate,
            };
            this.callbacks?.onTimeUpdate(info);

            // Throttled MediaSession position update
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
