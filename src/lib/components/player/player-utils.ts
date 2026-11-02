// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Player utility functions and types
 * Pure functions with no component state dependencies
 */

import {
    findHdrFormat,
    isHevcCodec as isHevcCodecFromTable,
    isAv1Codec as isAv1CodecFromTable,
    isAudioCodecMseCompatible as isMseCompatibleFromTable,
    isDolbyVision as isDolbyVisionFromTable,
    isDolbyVisionPure as isDolbyVisionPureFromTable,
    isHdrContent,
} from './codec-support';

// ============================================================================
// HDR Detection
// ============================================================================

export interface HdrDetectionResult {
    isHdr: boolean;
    isDolbyVision: boolean;
    isDolbyVisionPure: boolean; // Profile 7 - no fallback layer
    sourceFormat: string | null;
}

/**
 * Detect HDR format from video stream metadata.
 * Uses centralized codec support tables.
 */
export function detectHdrFormat(rangeType: string, videoRange: string): HdrDetectionResult {
    const hdrFormat = findHdrFormat(rangeType, videoRange);
    const isDolbyVision = isDolbyVisionFromTable(rangeType, videoRange);
    const isDolbyVisionPure = isDolbyVisionPureFromTable(rangeType);
    const isHdr = isHdrContent(rangeType, videoRange);

    // Build source format string
    let sourceFormat: string | null = null;
    if (hdrFormat) {
        // Map display names to short format codes
        if (hdrFormat.displayName.includes('Profile 7')) {
            sourceFormat = 'DV P7';
        } else if (hdrFormat.displayName.includes('Profile 8')) {
            sourceFormat = 'DV P8';
        } else if (hdrFormat.displayName.includes('Profile 5')) {
            sourceFormat = 'DV P5';
        } else if (hdrFormat.displayName.includes('HLG') && isDolbyVision) {
            sourceFormat = 'DV HLG';
        } else if (isDolbyVision) {
            sourceFormat = 'DV';
        } else if (hdrFormat.displayName === 'HDR10+') {
            sourceFormat = 'HDR10+';
        } else if (hdrFormat.displayName === 'HDR10') {
            sourceFormat = 'HDR10';
        } else if (hdrFormat.displayName === 'HLG') {
            sourceFormat = 'HLG';
        } else {
            sourceFormat = 'HDR';
        }
    } else if (videoRange?.includes('HDR')) {
        // Fallback for generic HDR detection
        sourceFormat = 'HDR';
    }

    return { isHdr, isDolbyVision, isDolbyVisionPure, sourceFormat };
}

// ============================================================================
// Codec Detection - Re-exported from codec-support.ts
// ============================================================================

/**
 * Check if codec is HEVC/H.265
 */
export function isHevcCodec(codec: string | undefined): boolean {
    return isHevcCodecFromTable(codec);
}

/**
 * Check if codec is AV1
 */
export function isAv1Codec(codec: string | undefined): boolean {
    return isAv1CodecFromTable(codec);
}

/**
 * Check if audio codec is compatible with HLS.js/MSE.
 * Safari handles all codecs natively, but Chrome/Firefox via hls.js have limited support.
 *
 * Compatible: aac, mp3
 * Incompatible: ac3, eac3, flac, dts, truehd, pcm, vorbis, opus (in HLS)
 */
export function isAudioCodecMseCompatible(codec: string | undefined): boolean {
    return isMseCompatibleFromTable(codec);
}

// ============================================================================
// Adaptive Bitrate Constants
// ============================================================================

/** Wait 10 seconds after start before any quality switching */
export const INITIAL_STABILITY_PERIOD = 10000;

/** 10 seconds cooldown after switching down */
export const SWITCH_DOWN_COOLDOWN = 10000;

/** 30 seconds cooldown after switching up */
export const SWITCH_UP_COOLDOWN = 30000;

/** Number of bandwidth samples to average */
export const BANDWIDTH_SAMPLE_COUNT = 5;

/** Need at least 3 samples before first switch */
export const MIN_SAMPLES_BEFORE_SWITCH = 3;

/** Minimum bitrate for adaptive switching (2 Mbps) */
export const MIN_ADAPTIVE_BITRATE = 2000000;

// ============================================================================
// Bandwidth Utilities
// ============================================================================

/**
 * Get smoothed bandwidth from recent samples using median filter
 */
export function getSmoothedBandwidth(
    samples: number[],
    newSample: number,
): { smoothed: number; samples: number[] } {
    const updatedSamples = [...samples, newSample];
    if (updatedSamples.length > BANDWIDTH_SAMPLE_COUNT) {
        updatedSamples.shift();
    }
    // Return median to filter out spikes
    const sorted = [...updatedSamples].sort((a, b) => a - b);
    const smoothed = sorted[Math.floor(sorted.length / 2)];
    return { smoothed, samples: updatedSamples };
}

// ============================================================================
// Time Utilities
// Time utilities co-located with bandwidth and codec helpers.
// Also exported via playerStore.ts and index.ts so imports from those paths resolve. (ref: DL-006)
// ============================================================================

/** Formats seconds as HH:MM:SS or MM:SS. Returns '0:00' for non-finite input. */
export function formatTime(seconds: number): string {
    if (!isFinite(seconds) || Number.isNaN(seconds)) {
        return '0:00';
    }

    const totalSeconds = Math.floor(Math.abs(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** Converts seconds to Jellyfin ticks (100-nanosecond units, 10^7 per second). */
export function secondsToTicks(seconds: number): number {
    return Math.floor(seconds * 10000000);
}

/** Converts Jellyfin ticks to seconds. */
export function ticksToSeconds(ticks: number): number {
    return ticks / 10000000;
}

/**
 * Whether the next-episode/next-item prompt is due. The one rule the Apple apps
 * share (`NextEpisodePrompt.isDue`):
 * - With credits (Outro segments): from the EARLIEST Outro start minus `leadSeconds`
 *   (negative lead = after the credits begin). An Outro starting in the first half
 *   is a mis-detection and is ignored, or the prompt (and its auto-advance) would
 *   stay up for most of the episode. In a Watch Together party the host's prompt
 *   moves everyone.
 * - Without (valid) credits: the last `noOutroFallbackSeconds` (0 disables), never
 *   before the midpoint, so a clip shorter than the window doesn't prompt at once.
 */
export function isNextItemPromptDue(args: {
    currentTime: number;
    duration: number;
    outroStarts: number[];
    leadSeconds: number;
    noOutroFallbackSeconds: number;
}): boolean {
    const { currentTime, duration, outroStarts, leadSeconds, noOutroFallbackSeconds } = args;
    // Drop first-half Outros BEFORE picking the earliest: picking first and rejecting
    // after threw away the real credits whenever a false early Outro existed.
    const valid = outroStarts.filter((start) => duration <= 0 || start >= duration / 2);
    if (valid.length > 0) {
        return currentTime >= Math.min(...valid) - leadSeconds;
    }
    return (
        noOutroFallbackSeconds > 0 &&
        duration > 0 &&
        currentTime >= duration / 2 &&
        duration - currentTime <= noOutroFallbackSeconds
    );
}
