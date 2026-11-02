// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Decision Helpers
 *
 * Utility functions for playback decisions: quality profile checks and quality comparison.
 * The actual HLS/DirectPlay/Transcode routing lives in stream-url-builder.ts.
 */

import type { TranscodingProfile, QualityMode } from '$lib/types/playback';

// PlayMethod is owned by playback-display.ts (display domain) and re-exported here
// so decision-domain consumers have a single import path. (ref: DL-008)
export type { PlayMethod } from './playback-display';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine if we should force transcoding based on quality profile
 * @param profile - The quality profile (null for original)
 * @param mode - The quality mode ('original', 'auto', 'fixed')
 * @param sourceBitrate - Optional source video bitrate in bps
 * @returns true if transcoding should be forced
 */
export function shouldForceTranscode(
    profile: TranscodingProfile | null,
    mode: QualityMode,
    sourceBitrate?: number,
): boolean {
    // No profile or original mode = don't force transcode
    if (profile === null) return false;
    if (mode === 'original') return false;
    if (profile.mode === 'original') return false;

    // Auto mode doesn't force transcode - it adapts
    if (mode === 'auto') return false;
    if (profile.mode === 'auto') return false;

    // Fixed bitrate profile - only force transcode if source exceeds the limit
    // If source bitrate is unknown or below the limit, no need to transcode
    if (sourceBitrate && profile.maxBitrate) {
        // Add 10% buffer - don't transcode if source is close to or below limit
        const threshold = profile.maxBitrate * 1.1;
        if (sourceBitrate <= threshold) {
            return false;
        }
    }

    // Source exceeds limit or bitrate unknown - force transcode
    return true;
}

/**
 * Check if the current quality matches the requested quality
 * Used to prevent unnecessary stream restarts
 */
export function isSameQuality(
    currentMode: QualityMode,
    currentProfile: TranscodingProfile | null,
    newProfile: TranscodingProfile | null,
): boolean {
    // Determine new mode from profile
    let newMode: QualityMode = 'fixed';
    if (newProfile === null || newProfile.mode === 'original') {
        newMode = 'original';
    } else if (newProfile.mode === 'auto') {
        newMode = 'auto';
    } else if (newProfile.mode === 'audio-only') {
        newMode = 'audio-only';
    }

    // If modes differ, not the same quality
    if (currentMode !== newMode) return false;

    // For fixed mode, also compare bitrate
    if (newMode === 'fixed') {
        return newProfile?.maxBitrate === currentProfile?.maxBitrate;
    }

    // Original and auto modes are same if mode matches
    return true;
}

/**
 * Build codec preference list based on browser capabilities.
 * Order: most efficient first (AV1 > HEVC > H264)
 *
 * Re-exports from codec-support.ts for backwards compatibility.
 */
export { getCodecPreferenceList as buildCodecPreferenceList } from './codec-support';

// Display helpers live in playback-display.ts; decision logic stays here.
// Re-exported so callers importing from ./playback-decision continue to resolve. (ref: DL-008)
export { getPlayMethodLabel, getPlayMethodBadgeClass } from './playback-display';
