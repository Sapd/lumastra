// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MediaPlaybackError } from './audio-element-helpers';

/**
 * Platform-specific audio backend interface.
 *
 * The music player store operates exclusively through this interface.
 * Implementations handle platform-specific audio element management,
 * Web Audio API usage, crossfade mechanics, and MediaSession integration.
 */

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

/** Fired by the backend on a regular interval with current position. */
export interface TimeUpdateInfo {
    /** Current playback position in milliseconds */
    currentTimeMs: number;
    /** Total duration in milliseconds (0 if unknown) */
    durationMs: number;
    /** Current playback rate (1.0 = normal, adjusted during BPM matching) */
    playbackRate: number;
}

/** Fired during an active crossfade to report beat-level progress. */
export interface CrossfadeProgressInfo {
    /** 0-1 progress through the crossfade */
    ratio: number;
    /** Current beat number (1-based) */
    currentBeat: number;
    /** Total beats in this crossfade */
    totalBeats: number;
}

/** Debug info about crossfade alignment decisions. */
export interface CrossfadeDebugInfo {
    /** ID of the incoming track this debug info was computed for */
    inTrackId: string;
    alignmentMethod: 'phase-aligned' | 'downbeat-snap' | 'beat-grid-snap' | 'intro-end' | 'none';
    outHasDownbeats: boolean;
    inHasDownbeats: boolean;
    inHasBeatGrid: boolean;
    outBarPhase: number | null;
    inStartSec: number;
    outBpm: number | null;
    inBpm: number | null;
    bpmGapPercent: number | null;
    syncTechnique: 'rate-match' | 'time-stretch' | 'no-sync';
    outKey: string | null;
    inKey: string | null;
    fadeMode: 'blend' | 'cut' | 'filter' | 'echo' | 'bassswap';
    fadeReason: string;
    /** How the crossfade trigger point was determined (optional for backward compat) */
    outroSource?: 'downbeat' | 'percentage' | 'fade' | 'dj-outro' | 'dynamic-lead';
}

/** Reported once a scheduled gapless advance has actually swapped decks. */
export interface GaplessAdvanceCommittedInfo {
    /** The `src` that is now audible. */
    src: string;
    /**
     * Position of the now-active deck at the instant of the swap, in ms.
     *
     * MEASURED, not assumed: a predictive advance starts the incoming deck
     * `leadMs` of wall-clock time before the boundary, so at the swap it is
     * already `leadMs * rate` into the file. Consumers that maintain a virtual
     * timeline must rebase from THIS value rather than from the requested
     * `startAtMs`, or the book position drifts by one lead per file boundary —
     * roughly every nine minutes on a real multi-file book.
     */
    positionMs: number;
}

export interface AudioBackendCallbacks {
    /** Called when the current track reaches its natural end (not during crossfade). */
    onTrackEnded: () => void;
    /**
     * Called on a fixed interval (~50ms) with current playback position.
     * Uses setInterval, NOT requestAnimationFrame, so it fires in background.
     */
    onTimeUpdate: (info: TimeUpdateInfo) => void;
    /** Called during crossfade with beat-level progress. */
    onCrossfadeProgress?: (info: CrossfadeProgressInfo) => void;
    /**
     * Called immediately after a {@link AudioBackend.scheduleGaplessAdvance}
     * swap becomes audible. Never fires for the cold-start fallback path — that
     * one still arrives as `onTrackEnded`.
     */
    onGaplessAdvanceCommitted?: (info: GaplessAdvanceCommittedInfo) => void;
    /**
     * The current track's element failed to load or decode AFTER `play()`
     * returned (a mid-stream network drop, a decode error). A failure while
     * `play()` is pending rejects that call instead and is never reported here.
     */
    onPlaybackError?: (error: MediaPlaybackError) => void;
}

// ---------------------------------------------------------------------------
// Track metadata for MediaSession
// ---------------------------------------------------------------------------

export interface TrackMetadata {
    title: string;
    artist?: string;
    album?: string;
    artworkUrl?: string;
    /**
     * Live radio stream — disables prev/next/seek MediaSession actions on the
     * iOS lock screen and Android notification controls. The "track" id is
     * the station, so prev/next would be no-ops and seek is meaningless on a
     * live stream.
     */
    isRadio?: boolean;
}

// ---------------------------------------------------------------------------
// Crossfade options
// ---------------------------------------------------------------------------

/**
 * Options for triggering a crossfade transition.
 *
 * Backends MUST silently ignore options they do not support:
 * - PlainAudioBackend: ignores everything except the track src, performs instant switch
 * - WebAudioBackend: full support for all options
 */
export interface CrossfadeOptions {
    /** Crossfade duration in beats (default: 8) */
    beats?: number;
    /** Target volume for the incoming deck (0-1, default: current volume) */
    volume?: number;
    /** Fade curve mode. Unsupported modes fall back to 'blend'. */
    fadeMode?: 'blend' | 'cut' | 'filter' | 'echo' | 'bassswap';
    /** BPM that paces the fade (beats → ms). The planner's choice — the
     *  outgoing BPM, else the incoming — passed explicitly because unsynced
     *  transitions omit `incomingBpm`. Falls back to outgoing ?? incoming. */
    paceBpm?: number;
    /** BPM of the outgoing track (for rate matching) */
    outgoingBpm?: number;
    /** BPM of the incoming track (for rate matching) */
    incomingBpm?: number;
    /** Downbeat timestamps of outgoing track (seconds, sorted) */
    outgoingDownbeats?: number[];
    /** Current playback position of outgoing track (seconds) */
    outgoingCurrentTimeSec?: number;
    /** Beat grid of incoming track (seconds) */
    incomingBeatGrid?: number[];
    /** Downbeat timestamps of incoming track (seconds, sorted) */
    incomingDownbeats?: number[];
    /** Effective intro end point of incoming track (ms).
     *  Already resolved: uses dj_intro_end_ms when available, else intro_end_ms. */
    incomingIntroEndMs?: number;
    /** LUFS-adjusted volume for the outgoing deck (0-1). Defaults to `volume` if omitted. */
    outgoingVolume?: number;
    /** LUFS-adjusted volume for the incoming deck (0-1). Defaults to `volume` if omitted. */
    incomingVolume?: number;
}

// ---------------------------------------------------------------------------
// Playback rate / start offset / gapless advance
// ---------------------------------------------------------------------------

export interface PlaybackRateOptions {
    /**
     * Keep pitch constant while changing tempo.
     *
     * NOT optional on purpose. Rate exists in this interface for BPM matching,
     * where the pitch shift IS the effect being asked for; an audiobook at 1.5×
     * with the same setting is chipmunks. Neither caller may inherit the
     * other's default, so every call states which it wants.
     */
    preservePitch: boolean;
}

export interface PlayOptions {
    /**
     * Begin at this offset inside the source, in ms.
     *
     * `play()` on its own resets to 0, so resuming a book or landing on a file
     * boundary would otherwise be play-then-seek — an audible blip at every
     * resume and every ~9-minute file seam.
     */
    startAtMs?: number;
    /** Applied to the loaded deck before playback starts. */
    playbackRate?: number;
    /** Required alongside `playbackRate`; see {@link PlaybackRateOptions}. */
    preservePitch?: boolean;
}

/**
 * A predictive A/B-deck advance across a file boundary.
 *
 * Prototype 4a measured four strategies against a continuous tone split over
 * two files, with a forced-200 ms control validating the instrument on every
 * run. Only this one reached 0 ms on every engine and format; cold-starting an
 * element at the boundary costs 21 ms on AAC in Chromium and far more on
 * WebKit.
 */
export interface GaplessAdvanceRequest {
    src: string;
    metadata: TrackMetadata;
    /** Offset inside the incoming source to begin at. Default 0. */
    startAtMs?: number;
    /**
     * Rate to apply to the incoming deck.
     *
     * Both crossfade-capable backends hard-set a freshly loaded deck to rate 1
     * (`web-audio-backend.ts` / `safari-audio-backend.ts`, in `cancelCrossfade`
     * and on load), so a 1.5× listener would silently drop to 1× at every file
     * boundary if the rate were not re-applied as part of the advance.
     */
    playbackRate?: number;
    /** Required alongside `playbackRate`; see {@link PlaybackRateOptions}. */
    preservePitch?: boolean;
    /**
     * Wall-clock lead: how long before the boundary the incoming deck starts
     * playing (silently). Default {@link DEFAULT_GAPLESS_LEAD_MS}.
     *
     * This is a real trade-off, not a tuning knob with a free side. The
     * incoming element must ALREADY be rendering audio at the swap instant —
     * that is the entire difference between 0 ms and 21 ms — so at the swap it
     * has necessarily consumed `leadMs` of its own head, and that audio is
     * never heard. Larger values are safer against a slow element start;
     * smaller values clip less. There is no setting that avoids both.
     */
    leadMs?: number;
}

/**
 * Default wall-clock lead for {@link GaplessAdvanceRequest}.
 *
 * Sized against the measured cold-start cost (21 ms on AAC in Chromium) with
 * roughly 7× headroom, and against the audible cost of the head-clip it buys:
 * 150 ms once per file, on a median 9-minute file. Flagged for the human-ear
 * pass — it is the one number here that test output cannot settle.
 */
export const DEFAULT_GAPLESS_LEAD_MS = 150;

/** How far ahead of the lead the incoming deck's src is attached and buffered. */
export const DEFAULT_GAPLESS_PREWARM_MS = 8000;

export interface BackendInitOptions {
    /**
     * Whether the backend owns `navigator.mediaSession`. Default true.
     *
     * The music path wants this: the backend's own metadata, playback state
     * and 5-second `setPositionState` cadence are correct for a track, because
     * a track IS the media element's timeline.
     *
     * An audiobook's is not. Its lock-screen scrubber must read BOOK time
     * across a whole multi-file book, and `nexttrack` must move a chapter
     * rather than a file — neither of which the backend can know. With the
     * backend also writing file-time position state every 5 s, the two would
     * fight on the lock screen.
     *
     * Set false and the backend writes NO part of `navigator.mediaSession` —
     * not handlers, not metadata, not position state, not playback state, and
     * it does not clear the session on stop or destroy. The caller owns all of
     * it.
     */
    manageMediaSession?: boolean;
}

// ---------------------------------------------------------------------------
// MediaSession action callbacks (from lock screen controls)
// ---------------------------------------------------------------------------

export interface MediaSessionActions {
    onPlay: () => void;
    onPause: () => void;
    onNextTrack: () => void;
    onPreviousTrack: () => void;
    onSeekTo: (timeSeconds: number) => void;
    onSeekForward: (offsetSeconds?: number) => void;
    onSeekBackward: (offsetSeconds?: number) => void;
    onStop: () => void;
}

// ---------------------------------------------------------------------------
// AudioBackend interface
// ---------------------------------------------------------------------------

/** Overrides for {@link AudioBackend.reloadCurrentSrc}. */
export interface ReloadSrcOptions {
    /** Resume here instead of the element's current position. */
    positionMs?: number;
    /** Play after the reload (true) or stay paused (false) instead of mirroring `paused`. */
    resume?: boolean;
}

export interface AudioBackend {
    // -- Lifecycle --

    /**
     * Initialize audio resources (AudioContext, elements, MediaSession).
     * Must be called from a user gesture context on mobile.
     * Safe to call multiple times (subsequent calls are no-ops).
     */
    init(
        callbacks: AudioBackendCallbacks,
        mediaSessionActions: MediaSessionActions,
        options?: BackendInitOptions,
    ): void;

    /** Tear down all audio resources, event listeners, and intervals. */
    destroy(): void;

    // -- Playback --

    /**
     * Load and play a track from the given URL.
     *
     * Resets position to 0 unless `options.startAtMs` is given.
     *
     * Rejects with a `MediaPlaybackError` when the source fails to load or
     * decode. Resolves without playing on an autoplay-policy block
     * (`NotAllowedError`) or when a newer load interrupted it (`AbortError`).
     */
    play(src: string, metadata: TrackMetadata, options?: PlayOptions): Promise<void>;

    /** Pause playback. Preserves position. */
    pause(): void;

    /** Resume from paused state. */
    resume(): void;

    /** Stop playback entirely. Releases audio resources. */
    stop(): void;

    /** Seek to an absolute position in milliseconds. */
    seekTo(ms: number): void;

    // -- Volume --

    /** Set master volume (0-1). No-op on iOS (hardware-only). */
    setVolume(volume: number): void;

    /** Mute audio output. */
    mute(): void;

    /** Unmute audio output, restoring previous volume. */
    unmute(restoreVolume: number): void;

    // -- Crossfade --

    /**
     * Begin crossfading to a new track.
     * On PlainAudioBackend: instant switch (resolves immediately).
     * On WebAudioBackend: full A/B deck equal-power crossfade.
     */
    triggerCrossfade(
        nextSrc: string,
        metadata: TrackMetadata,
        options?: CrossfadeOptions,
    ): Promise<void>;

    /** Cancel an in-progress crossfade. No-op if not crossfading. */
    cancelCrossfade(): void;

    /** Normalize playback rate back to 1.0 after BPM matching. No-op if not needed. */
    normalizePlaybackRate(): void;

    // -- Playback rate --

    /**
     * Set the playback rate of the audible deck.
     *
     * Distinct from the BPM-matching path (`normalizePlaybackRate`), which owns
     * rate during a crossfade. Callers that set rate deliberately must re-apply
     * it after any load — see {@link GaplessAdvanceRequest.playbackRate}.
     */
    setPlaybackRate(rate: number, options: PlaybackRateOptions): void;

    // -- Gapless file-boundary advance --

    /**
     * Whether {@link scheduleGaplessAdvance} can actually butt-join.
     *
     * False means the backend has no second deck it can pre-roll, so a caller
     * must fall back to advancing on `onTrackEnded` and accept the cold-start
     * gap. Read this rather than sniffing the platform.
     */
    readonly supportsGaplessAdvance: boolean;

    /**
     * Pre-roll the next source on the inactive deck and hard-swap to it at the
     * current source's end.
     *
     * Returns false when the advance was not scheduled — no support, no
     * inactive deck, or the current deck has no usable duration to schedule
     * against (a live stream, or metadata that never loaded). A false return is
     * a normal outcome the caller handles by falling back to `onTrackEnded`,
     * not an error.
     *
     * Pass `null` to cancel a scheduled-but-uncommitted advance; that is
     * mandatory before any seek, since a seek invalidates the boundary the
     * swap was scheduled against.
     */
    scheduleGaplessAdvance(request: GaplessAdvanceRequest | null): boolean;

    // -- State queries --

    /** Current playback position in milliseconds. */
    getCurrentTimeMs(): number;

    /** Total duration in milliseconds (0 if unknown). */
    getDurationMs(): number;

    /** Current playback rate (1.0 = normal). */
    getPlaybackRate(): number;

    /**
     * Playback position of the INCOMING track while a crossfade is in
     * progress, in milliseconds — null when not crossfading or unsupported.
     * During a fade the incoming track is already the store's currentTrack
     * (promoted at fade start) but still plays on the inactive deck; this lets
     * the store mirror its clock until the completion swap.
     */
    getCrossfadeIncomingTimeMs?(): number | null;

    /** Whether a crossfade is currently in progress. */
    isCrossfading(): boolean;

    // -- Capabilities --

    /** Whether the backend supports crossfade. */
    readonly supportsCrossfade: boolean;

    /** Whether the backend supports programmatic volume control. */
    readonly supportsVolumeControl: boolean;

    /**
     * How the backend applies playback rate normalization.
     * - 'gradual': WebAudio backend ramps playbackRate smoothly over 100ms.
     * - 'instant': Safari and Plain backends apply rate changes immediately (hard-snap).
     */
    readonly normalizationStyle: 'gradual' | 'instant';

    // -- Audio output --

    /**
     * Returns the active HTMLAudioElement for output routing (AirPlay, setSinkId).
     * Returns null if no element is available (e.g. before init).
     */
    getAudioElement(): HTMLAudioElement | null;

    /**
     * Returns every <audio> element the backend may currently route audio through.
     * Used by the AirPlay detector so it observes wireless transitions on each
     * deck, not just the currently-active one. Order is not significant.
     *
     * - PlainAudioBackend: [this.audio] (single element)
     * - WebAudioBackend / SafariAudioBackend: both decks A and B
     *
     * Returns an empty array when the backend has not been initialized yet.
     */
    getAllAudioElements(): HTMLAudioElement[];

    /**
     * Whether the backend can route output to a user-selected device right
     * now (AudioContext.setSinkId support). Optional — backends without a
     * routable graph simply omit it and the device-picker UI stays hidden.
     */
    supportsOutputSelection?(): boolean;

    /**
     * Route audio output to a specific device (a sinkId from
     * enumerateDevices 'audiooutput'). '' or 'default' selects the system
     * default. Resolves false when unsupported or the switch failed.
     */
    setOutputDevice?(deviceId: string): Promise<boolean>;

    // -- Persistence helpers --

    /**
     * Pre-load a track without playing it (for hydration from saved state).
     * Seeks to the given position once loaded.
     * If autoResume is true, begins playback after loading.
     * Returns a promise that resolves when load is complete.
     */
    preload(
        src: string,
        metadata: TrackMetadata,
        positionMs: number,
        volume: number,
        autoResume: boolean,
    ): Promise<{ resumed: boolean }>;

    /**
     * Swap the stream URL of the currently-active deck in place, preserving the
     * playback position, play/pause state, and existing track metadata.
     *
     * Unlike play()/preload(), this does NOT change the logical track — it only
     * re-points the SAME track at a new URL (e.g. a tokenized /api/v1 URL for
     * AirPlay). The active <audio> element is retained, and on WebAudio its
     * bound MediaElementSource node stays attached, so no audio-graph teardown
     * occurs (mutating the raw element src from outside the backend would).
     *
     * `opts` overrides the position and play state otherwise read from the
     * element. A caller recovering from a failed load passes them: after a
     * media `error` the element's `currentTime`/`paused` no longer describe
     * where playback was.
     *
     * Returns true if the reload was issued, false if there is no active element.
     */
    reloadCurrentSrc(src: string, opts?: ReloadSrcOptions): Promise<boolean>;

    /**
     * Warm the browser's network buffer for an upcoming track without playing it.
     *
     * Uses a dedicated hidden <audio> element (separate from the active and
     * crossfade decks) so that buffering happens in parallel with the currently
     * playing track and does NOT affect playback or the crossfade transition.
     * Calling this method again with a different src replaces the prefetch target.
     * No-op before the backend is initialized.
     */
    prefetchNext(src: string): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type PlatformType = 'desktop' | 'ios' | 'android';
