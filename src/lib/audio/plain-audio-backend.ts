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
    updateMediaSessionPositionState,
    updateMediaSessionPlaybackState,
    clearMediaSession,
} from '$lib/utils/media-session';
import {
    requestWakeLock,
    releaseWakeLock,
    setupWakeLockReacquisition,
    destroyWakeLock,
} from '$lib/utils/wake-lock';
import { registerMediaSessionHandlers } from './media-session-helpers';
import {
    applyPlaybackRate,
    playMediaElement,
    seekWhenReady,
    waitForMetadata,
    watchMediaErrors,
} from './audio-element-helpers';
import { GaplessAdvanceScheduler } from './gapless-advance';

/**
 * iOS audio backend — single plain `<audio>` element.
 *
 * No Web Audio API, no crossfade. Reliable background playback on iOS
 * because the element is never captured into the "ambient" audio session.
 *
 * Volume control is a no-op: iOS ignores HTMLMediaElement.volume
 * (always returns 1, writes are silently ignored). Volume is hardware-only.
 *
 * ## The opt-in gapless graph
 *
 * Prototype 4a's answer (predictive A/B decks, scheduled gain swap) needs two
 * decks and a way to silence one of them. Neither exists here by default, and
 * on iOS specifically `element.volume` cannot supply the second: it is the
 * documented no-op above. A `GainNode` *does* work on iOS — the constraint is
 * on the element property, not on Web Audio — so the fix is a minimal graph
 * (two elements → two gains → destination), not adopting {@link
 * WebAudioBackend} wholesale.
 *
 * **It is opt-in, and that is the decision, not an accident.** The single bare
 * element is the reason iOS background playback is reliable here; a
 * `MediaElementAudioSourceNode` captures the element into the Web Audio graph
 * and that is exactly the property the plain path exists to avoid.
 *
 * ## NOBODY currently passes the flag, and that is also the decision
 *
 * The audiobook player used to. Measured on a real device 2026-08-04: with the
 * graph on, backgrounding the app stops playback — iOS suspends the
 * `AudioContext`, and WebKit will not resume one without a user gesture that a
 * backgrounded app cannot produce. The seam the graph removes (21 ms+ every
 * ~9 minutes) is not worth a player that stops when you lock your phone, so
 * `createAudiobookBackend` no longer passes it and iOS takes the cold-start
 * boundary. The flag stays because the graph itself is correct and tested; what
 * it cannot survive is being backgrounded.
 *
 * If the `AudioContext` cannot be built, the backend silently stays in plain
 * mode and {@link supportsGaplessAdvance} reports false — callers fall back to
 * the cold-start boundary rather than failing. That is now the iOS path in
 * every case.
 */
export class PlainAudioBackend implements AudioBackend {
    readonly supportsCrossfade = false;
    readonly supportsVolumeControl = false;
    readonly normalizationStyle = 'instant' as const;

    /** Deck A is the only element unless the gapless graph is enabled. */
    private deckA: HTMLAudioElement | null = null;
    private deckB: HTMLAudioElement | null = null;
    private activeDeck: 'A' | 'B' = 'A';
    private audioContext: AudioContext | null = null;
    private gainA: GainNode | null = null;
    private gainB: GainNode | null = null;
    private readonly wantGaplessGraph: boolean;
    private readonly advanceScheduler = new GaplessAdvanceScheduler();
    private advanceRequest: GaplessAdvanceRequest | null = null;
    /** See the identically-named field in WebAudioBackend for why this exists. */
    private advancePending = false;
    /** False only for the audiobook player, which owns MediaSession itself. */
    private manageMediaSession = true;

    constructor(options?: { gaplessGraph?: boolean }) {
        this.wantGaplessGraph = options?.gaplessGraph === true;
    }

    /** The element currently producing audio. */
    private get audio(): HTMLAudioElement | null {
        return this.activeDeck === 'A' ? this.deckA : this.deckB;
    }

    private get inactiveAudio(): HTMLAudioElement | null {
        return this.activeDeck === 'A' ? this.deckB : this.deckA;
    }

    private get activeGain(): GainNode | null {
        return this.activeDeck === 'A' ? this.gainA : this.gainB;
    }

    private get inactiveGain(): GainNode | null {
        return this.activeDeck === 'A' ? this.gainB : this.gainA;
    }
    private callbacks: AudioBackendCallbacks | null = null;
    private storedMediaSessionActions: MediaSessionActions | null = null;
    private timeUpdateInterval: ReturnType<typeof setInterval> | null = null;
    private cleanupWakeLockReacquisition: (() => void) | null = null;
    private initialized = false;
    private currentMetadata: TrackMetadata | null = null;
    private lastPositionUpdateMs = 0;
    /** Dedicated hidden element used only for next-track prefetch buffering. */
    private prefetchAudio: HTMLAudioElement | null = null;

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

        this.deckA = this.createDeckElement('A');

        if (this.wantGaplessGraph) {
            this.deckB = this.createDeckElement('B');
            this.buildGaplessGraph();
        }

        this.registerMediaSession(null);

        // Wake lock reacquisition on visibility change
        this.cleanupWakeLockReacquisition = setupWakeLockReacquisition(
            () => this.audio !== null && !this.audio.paused,
        );
    }

    destroy(): void {
        this.cancelGaplessAdvance();
        this.stopTimeUpdates();
        for (const deck of [this.deckA, this.deckB]) {
            if (!deck) continue;
            deck.pause();
            deck.src = '';
            deck.remove();
        }
        this.deckA = null;
        this.deckB = null;
        this.activeDeck = 'A';
        this.gainA = null;
        this.gainB = null;
        if (this.audioContext) {
            void this.audioContext.close().catch(() => {});
            this.audioContext = null;
        }
        if (this.prefetchAudio) {
            this.prefetchAudio.src = '';
            this.prefetchAudio.remove();
            this.prefetchAudio = null;
        }
        this.clearOwnedMediaSession();
        destroyWakeLock();
        this.cleanupWakeLockReacquisition?.();
        this.cleanupWakeLockReacquisition = null;
        this.callbacks = null;
        this.initialized = false;
        this.currentMetadata = null;
    }

    async play(src: string, metadata: TrackMetadata, options?: PlayOptions): Promise<void> {
        this.cancelGaplessAdvance();
        const audio = this.audio;
        if (!audio) return;

        audio.src = src;
        this.currentMetadata = metadata;
        this.silenceInactiveDeck();

        if (options?.playbackRate !== undefined) {
            applyPlaybackRate(audio, options.playbackRate, options.preservePitch !== false);
        }
        // Seek BEFORE play(): play-then-seek is audible, and on a resume it is
        // the difference between continuing a book and restarting a file.
        if (options?.startAtMs !== undefined && options.startAtMs > 0) {
            await seekWhenReady(audio, options.startAtMs);
        }

        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume().catch(() => {});
        }

        // A load/decode failure rejects out of here; an autoplay block or a
        // superseding load returns without playing.
        if (!(await playMediaElement(audio))) return;

        this.registerMediaSession(metadata);
        this.setMediaSessionState('playing');
        this.syncMediaSessionPosition(true);
        void requestWakeLock();
        this.startTimeUpdates();
    }

    pause(): void {
        // See WebAudioBackend.pause(): an armed advance would otherwise make
        // its incoming deck audible a moment after the user pressed pause.
        this.cancelGaplessAdvance();
        this.audio?.pause();
        this.setMediaSessionState('paused');
        void releaseWakeLock();
    }

    resume(): void {
        // With the gapless graph on, ALL audio routes through the AudioContext,
        // and iOS suspends it on an interruption (a call, Siri, another app).
        // play() and the advance path both resume it; without the same guard
        // here, tapping play after an interruption plays into a suspended graph
        // — silent, while currentTime advances and positions the listener never
        // heard get reported upstream.
        if (this.audioContext?.state === 'suspended') {
            void this.audioContext.resume().catch(() => {});
        }
        if (this.audio) {
            void this.audio.play().then(
                () => {
                    this.registerMediaSession(this.currentMetadata);
                    this.syncMediaSessionPosition(true);
                },
                () => {},
            );
        }
        this.setMediaSessionState('playing');
        this.syncMediaSessionPosition(true);
        void requestWakeLock();
        this.startTimeUpdates();
    }

    stop(): void {
        this.cancelGaplessAdvance();
        this.stopTimeUpdates();
        if (this.audio) {
            this.audio.pause();
            this.audio.src = '';
        }
        this.silenceInactiveDeck();
        this.currentMetadata = null;
        // Clear lock screen metadata, then re-register handlers so lock screen
        // controls still work after stop (clearMediaSession removes them)
        this.clearOwnedMediaSession();
        this.registerMediaSession(null);
        destroyWakeLock();
    }

    seekTo(ms: number): void {
        // The swap was scheduled against a boundary this seek just moved.
        this.cancelGaplessAdvance();
        if (this.audio) {
            this.audio.currentTime = ms / 1000;
            this.syncMediaSessionPosition(true);
        }
    }

    setVolume(_volume: number): void {
        // iOS ignores HTMLMediaElement.volume — hardware only
    }

    mute(): void {
        // Use .muted property which DOES work on iOS.
        // Both decks: the incoming one of a pending advance is about to become
        // audible, and it would arrive unmuted.
        if (this.deckA) this.deckA.muted = true;
        if (this.deckB) this.deckB.muted = true;
    }

    unmute(_restoreVolume: number): void {
        if (this.deckA) this.deckA.muted = false;
        if (this.deckB) this.deckB.muted = false;
    }

    async triggerCrossfade(
        nextSrc: string,
        metadata: TrackMetadata,
        _options?: CrossfadeOptions,
    ): Promise<void> {
        // No crossfade on iOS — instant track switch
        this.cancelGaplessAdvance();
        if (!this.audio) return;
        this.audio.src = nextSrc;
        this.currentMetadata = metadata;
        try {
            await this.audio.play();
        } catch (err) {
            if (err instanceof DOMException && err.name === 'NotAllowedError') return;
            console.warn('[PlainAudioBackend] triggerCrossfade play() failed:', err);
        }
        this.registerMediaSession(metadata);
        this.syncMediaSessionPosition(true);
    }

    cancelCrossfade(): void {
        // No-op — no crossfade on iOS
    }

    normalizePlaybackRate(): void {
        // No-op — no BPM matching on iOS
    }

    // -- Playback rate --

    setPlaybackRate(rate: number, options: PlaybackRateOptions): void {
        const audio = this.audio;
        if (audio) applyPlaybackRate(audio, rate, options.preservePitch);
    }

    // -- Gapless file-boundary advance --

    /**
     * True only when the opt-in graph was requested AND actually built. Both
     * halves matter: an `AudioContext` that failed to construct must report
     * false so the caller degrades instead of scheduling a swap into nothing.
     */
    get supportsGaplessAdvance(): boolean {
        return this.gainA !== null && this.gainB !== null && this.deckB !== null;
    }

    scheduleGaplessAdvance(request: GaplessAdvanceRequest | null): boolean {
        if (request === null) {
            this.cancelGaplessAdvance();
            return false;
        }
        if (!this.supportsGaplessAdvance) return false;

        const from = this.audio;
        const to = this.inactiveAudio;
        const fromGain = this.activeGain;
        const toGain = this.inactiveGain;
        if (!from || !to || !fromGain || !toGain) return false;

        this.advanceRequest = request;
        const scheduled = this.advanceScheduler.start(
            {
                getOutgoingTimeMs: () => from.currentTime * 1000,
                getOutgoingDurationMs: () =>
                    Number.isFinite(from.duration) ? from.duration * 1000 : 0,
                getPlaybackRate: () => from.playbackRate || 1,
                prepareIncoming: async () => {
                    toGain.gain.cancelScheduledValues(0);
                    toGain.gain.value = 0;
                    to.src = request.src;
                    applyPlaybackRate(
                        to,
                        request.playbackRate ?? from.playbackRate ?? 1,
                        request.preservePitch !== false,
                    );
                    await seekWhenReady(to, request.startAtMs ?? 0);
                },
                playIncomingSilent: async () => {
                    if (this.audioContext?.state === 'suspended') {
                        await this.audioContext.resume().catch(() => {});
                    }
                    try {
                        await to.play();
                        return true;
                    } catch {
                        // WebKit refuses play() and AudioContext without a
                        // trusted user gesture (measured). A refusal here is
                        // the cold-start fallback, not a failure to report.
                        return false;
                    }
                },
                commitSwap: (delaySec) => {
                    const ctx = this.audioContext;
                    if (!ctx) return;
                    const at = ctx.currentTime + delaySec;
                    fromGain.gain.cancelScheduledValues(at);
                    fromGain.gain.setValueAtTime(0, at);
                    toGain.gain.cancelScheduledValues(at);
                    // Gain 1, never `currentVolume`: this backend has no
                    // software volume — the property is a hardware no-op on iOS
                    // — so anything else would quietly attenuate the book.
                    toGain.gain.setValueAtTime(this.isMutedViaElement() ? 0 : 1, at);
                },
                abortSwap: () => {
                    toGain.gain.cancelScheduledValues(0);
                    toGain.gain.value = 0;
                    to.pause();
                    // See WebAudioBackend: a commitSwap that already ran left a
                    // drop-to-zero scheduled on the outgoing deck, and it fires
                    // regardless of the cancellation.
                    fromGain.gain.cancelScheduledValues(0);
                    fromGain.gain.value = 1;
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
        this.advanceScheduler.cancel();
        this.advancePending = false;
        this.advanceRequest = null;
    }

    private completeGaplessAdvance(): void {
        const request = this.advanceRequest;
        this.advanceRequest = null;
        if (!request) return;

        const outgoing = this.audio;
        const outgoingGain = this.activeGain;
        this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
        if (outgoingGain) {
            outgoingGain.gain.cancelScheduledValues(0);
            outgoingGain.gain.value = 0;
        }
        outgoing?.pause();

        this.currentMetadata = request.metadata;
        this.registerMediaSession(request.metadata);
        this.advancePending = false;

        this.callbacks?.onGaplessAdvanceCommitted?.({
            src: request.src,
            positionMs: this.getCurrentTimeMs(),
        });
    }

    getCurrentTimeMs(): number {
        return this.audio ? this.audio.currentTime * 1000 : 0;
    }

    getDurationMs(): number {
        if (!this.audio) return 0;
        const d = this.audio.duration;
        return d && isFinite(d) ? d * 1000 : 0;
    }

    getPlaybackRate(): number {
        return this.audio?.playbackRate ?? 1;
    }

    isCrossfading(): boolean {
        return false;
    }

    getAudioElement(): HTMLAudioElement | null {
        return this.audio;
    }

    getAllAudioElements(): HTMLAudioElement[] {
        // Both decks when the gapless graph is on: the AirPlay detector needs
        // to observe wireless transitions on whichever deck is about to become
        // audible, not only on the one that currently is.
        return [this.deckA, this.deckB].filter((el): el is HTMLAudioElement => el !== null);
    }

    async preload(
        src: string,
        metadata: TrackMetadata,
        positionMs: number,
        _volume: number,
        autoResume: boolean,
    ): Promise<{ resumed: boolean }> {
        if (!this.audio) return { resumed: false };

        const audio = this.audio;
        audio.src = src;
        this.currentMetadata = metadata;

        this.registerMediaSession(metadata);

        return waitForMetadata(
            audio,
            async () => {
                if (!this.audio) return { resumed: false };

                if (positionMs > 0) {
                    audio.currentTime = positionMs / 1000;
                }

                if (autoResume) {
                    try {
                        await audio.play();
                        this.registerMediaSession(metadata);
                        this.setMediaSessionState('playing');
                        this.syncMediaSessionPosition(true);
                        void requestWakeLock();
                        this.startTimeUpdates();
                        return { resumed: true };
                    } catch {
                        return { resumed: false };
                    }
                } else {
                    return { resumed: false };
                }
            },
            () => ({ resumed: false }),
        );
    }

    async reloadCurrentSrc(src: string, opts: ReloadSrcOptions = {}): Promise<boolean> {
        const audio = this.audio;
        if (!audio) return false;

        const positionMs = opts.positionMs ?? audio.currentTime * 1000;
        const wasPlaying = opts.resume ?? !audio.paused;
        audio.src = src;
        const reloadedSrc = audio.src;

        return waitForMetadata(
            audio,
            async () => {
                if (!this.audio) return false;
                // A later load (next track, skip) re-pointed the element while we
                // waited: restoring now would seek/resume THAT track to this one's
                // position.
                if (audio.src !== reloadedSrc) return false;
                if (positionMs > 0) {
                    audio.currentTime = positionMs / 1000;
                }
                if (wasPlaying) {
                    try {
                        await audio.play();
                        this.setMediaSessionState('playing');
                        this.startTimeUpdates();
                        return true;
                    } catch {
                        return false;
                    }
                } else {
                    return true;
                }
            },
            () => false,
        );
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

    // -- Private --

    private createDeckElement(deck: 'A' | 'B'): HTMLAudioElement {
        const el = document.createElement('audio');
        el.preload = 'auto';
        el.style.display = 'none';
        document.body.appendChild(el);
        el.addEventListener('ended', () => {
            // Deck identity matters once there are two: without it the
            // silently-finishing outgoing deck would report the boundary the
            // gapless swap has already handled.
            if (this.activeDeck !== deck) return;
            if (this.advancePending) return;
            this.callbacks?.onTrackEnded();
        });
        watchMediaErrors(
            el,
            () => this.activeDeck === deck,
            (error) => this.callbacks?.onPlaybackError?.(error),
        );
        return el;
    }

    /**
     * Two elements → two gains → destination. Nothing else: this is not a
     * crossfade graph, it is the minimum needed to silence one deck on a
     * platform where `element.volume` cannot.
     */
    private buildGaplessGraph(): void {
        if (!this.deckA || !this.deckB) return;
        try {
            const Ctor: typeof AudioContext | undefined =
                typeof AudioContext !== 'undefined'
                    ? AudioContext
                    : (globalThis as { webkitAudioContext?: typeof AudioContext })
                          .webkitAudioContext;
            if (!Ctor) return;

            const ctx = new Ctor();
            const srcA = ctx.createMediaElementSource(this.deckA);
            const srcB = ctx.createMediaElementSource(this.deckB);
            const gainA = ctx.createGain();
            const gainB = ctx.createGain();
            srcA.connect(gainA);
            srcB.connect(gainB);
            gainA.connect(ctx.destination);
            gainB.connect(ctx.destination);
            gainA.gain.value = 1;
            gainB.gain.value = 0;

            this.audioContext = ctx;
            this.gainA = gainA;
            this.gainB = gainB;
        } catch (err) {
            // Degrade to the plain single-element path rather than failing to
            // init: a book that plays with a 21 ms seam beats one that does not
            // play at all.
            console.warn('[PlainAudioBackend] gapless graph unavailable:', err);
            this.audioContext = null;
            this.gainA = null;
            this.gainB = null;
        }
    }

    private silenceInactiveDeck(): void {
        const gain = this.inactiveGain;
        if (gain) {
            gain.gain.cancelScheduledValues(0);
            gain.gain.value = 0;
        }
        const el = this.inactiveAudio;
        if (el) {
            el.pause();
            el.src = '';
        }
    }

    /**
     * Mute state lives on `element.muted` here — `.volume` is the documented
     * iOS no-op — so the graph mirrors it rather than owning it.
     */
    private isMutedViaElement(): boolean {
        return this.audio?.muted === true;
    }

    /**
     * Guarded funnel for lock-screen handler registration. See
     * {@link BackendInitOptions.manageMediaSession}.
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
        if (!this.audio) return;

        const now = performance.now();
        if (!force && now - this.lastPositionUpdateMs < 5000) return;
        this.lastPositionUpdateMs = now;

        const durationMs = this.getDurationMs();
        if (durationMs > 0) {
            updateMediaSessionPositionState(
                durationMs / 1000,
                this.audio.currentTime,
                this.audio.playbackRate,
            );
        }
    }

    private startTimeUpdates(): void {
        this.stopTimeUpdates();
        this.timeUpdateInterval = setInterval(() => {
            if (!this.audio || this.audio.paused) return;
            const info: TimeUpdateInfo = {
                currentTimeMs: this.audio.currentTime * 1000,
                durationMs: this.getDurationMs(),
                playbackRate: this.audio.playbackRate,
            };
            this.callbacks?.onTimeUpdate(info);
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
