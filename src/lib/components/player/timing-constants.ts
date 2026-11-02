// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video Player Timing Constants
 *
 * Centralized constants for the video player to avoid magic numbers.
 * Extracted from VideoPlayer.svelte for reusability and documentation.
 */

/**
 * General timing constants for player operations
 */
export const TIMING = {
    /** How long to show quality switch toasts (ms) */
    TOAST_DURATION_MS: 2500,
    /** Wait for playback to stabilize after quality switch (ms) */
    STABILIZATION_WAIT_MS: 500,
    /** Short delay before retry operations (ms) */
    RETRY_DELAY_MS: 100,
    /** Minimum interval between bandwidth telemetry records (ms) */
    TELEMETRY_THROTTLE_MS: 10000,
    /** How long to wait before broadcasting stall to watch party (ms) */
    WATCH_PARTY_STALL_TIMEOUT_MS: 2000,
    /** Delay before showing autoplay tutorial (ms) */
    AUTOPLAY_TUTORIAL_DELAY_MS: 3000,
    /** How long skip animation shows (ms) */
    SKIP_ANIMATION_DURATION_MS: 800,
    /** Timeout for audio track listener cleanup (ms) */
    AUDIO_TRACK_CLEANUP_MS: 5000,
    /** Minimum interval between MediaSession position state updates (ms) */
    MEDIA_SESSION_POSITION_INTERVAL_MS: 5000,
} as const;

/**
 * Seek-related constants
 */
export const SEEK = {
    /** Default seek amount for keyboard shortcuts (seconds) */
    DEFAULT_SECONDS: 10,
    /** Only show spinner if seeking takes longer than this (ms) */
    BUFFERING_DELAY_MS: 200,
    /** Don't count buffering within this time after seek as rebuffer (ms) */
    GRACE_PERIOD_MS: 3000,
    /** Interval for accelerating seek on long-press (ms) */
    ACCELERATE_INTERVAL_MS: 200,
    /** Maximum multiplier for accelerating seek */
    MAX_MULTIPLIER: 5,
    /** Number of repeats before increasing multiplier */
    ACCELERATE_THRESHOLD: 3,
} as const;

/**
 * Buffer and bandwidth thresholds for adaptive quality
 */
export const BUFFER_THRESHOLDS = {
    /** Consider buffer full at this coverage ratio (0-1) */
    FULLY_LOADED: 0.95,
    /** Minimum buffer growth to measure bandwidth (seconds) */
    MIN_GROWTH_S: 0.5,
    /** Minimum time to measure growth over (seconds) */
    MIN_TIME_ELAPSED_S: 0.2,
    /** Maximum time window for measurement (seconds) */
    MAX_TIME_ELAPSED_S: 10,
    /** Sanity check - buffer can't grow 100x faster than real-time */
    MAX_GROWTH_RATIO: 100,
} as const;

/**
 * Subtitle-related constants
 */
export const SUBTITLE = {
    /** Retry failed client-renderer initialization twice, with exponential backoff. */
    INIT_MAX_RETRIES: 2,
    INIT_RETRY_DELAY_MS: 1000,
    /** Allow cold subtitle extraction, but never wait indefinitely for an attempt. */
    INIT_TIMEOUT_MS: 120_000,
    /** Debounce subtitle reload after seek (ms) */
    RELOAD_DEBOUNCE_MS: 150,
    /** Max attempts waiting for cues to load */
    MAX_CUE_WAIT_ATTEMPTS: 10,
    /** Interval between cue wait attempts (ms) */
    CUE_WAIT_INTERVAL_MS: 50,
    /** Delay before verifying track mode (ms) */
    VERIFY_DELAY_MS: 100,
    /** Delay for Safari audio track re-application (ms) */
    SAFARI_AUDIO_FIX_DELAY_MS: 100,
} as const;

/**
 * Frame stepping constants
 */
export const FRAME = {
    /** Assumed FPS for frame stepping (most common) */
    DEFAULT_FPS: 24,
} as const;

/**
 * Playback rate constants
 */
export const PLAYBACK_RATE = {
    /** Available speed levels matching SpeedSelector.svelte */
    SPEED_LEVELS: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const,
    /** Default playback rate */
    DEFAULT: 1,
    /** Minimum playback rate */
    MIN: 0.25,
    /** Maximum playback rate */
    MAX: 2,
} as const;

/**
 * Quality/bitrate constants
 */
export const QUALITY = {
    /** Minimum bitrate for "low" quality (bps) */
    LOW_BITRATE: 1_000_000,
    /** Minimum bitrate for "medium" quality (bps) */
    MEDIUM_BITRATE: 4_000_000,
    /** Minimum bitrate for "high" quality (bps) */
    HIGH_BITRATE: 8_000_000,
} as const;

/**
 * Type for timing constant values
 */
export type TimingConstant = (typeof TIMING)[keyof typeof TIMING];
export type SeekConstant = (typeof SEEK)[keyof typeof SEEK];
export type BufferThreshold = (typeof BUFFER_THRESHOLDS)[keyof typeof BUFFER_THRESHOLDS];
export type SubtitleConstant = (typeof SUBTITLE)[keyof typeof SUBTITLE];
export type FrameConstant = (typeof FRAME)[keyof typeof FRAME];
export type PlaybackRateConstant = (typeof PLAYBACK_RATE)[keyof typeof PLAYBACK_RATE];

/**
 * Player error messages
 */
export const PLAYER_ERRORS = {
    /** Shown when the file requires transcoding but HLS is unavailable */
    TRANSCODING_UNAVAILABLE:
        'This file cannot be played \u2014 transcoding is required but not available',
} as const;
