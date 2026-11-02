// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Codec Tables
 *
 * Platform-agnostic codec information tables that can be used by both
 * client-side (player components) and server-side (HLS utilities) code.
 *
 * This file should NOT import any browser-specific or server-specific modules.
 */

// =============================================================================
// AUDIO CODEC INFO
// =============================================================================

export interface AudioCodecTableEntry {
    /** Patterns to match this codec (lowercase) */
    patterns: string[];
    /** Human-readable display name */
    displayName: string;
    /** Works in HLS/fMP4 segments (Apple TV, iOS, etc.) */
    hlsCompatible: boolean;
    /** Works with HLS.js/MSE in Chrome/Firefox */
    mseCompatible: boolean;
    /** No browser supports this codec (always must transcode) */
    noBrowserSupport: boolean;
    /** Reason message when transcoding is needed */
    transcodeReason: string;
}

/**
 * Complete audio codec table.
 * Order matters for pattern matching - more specific patterns should come first.
 */
export const AUDIO_CODEC_TABLE: AudioCodecTableEntry[] = [
    {
        patterns: ['eac3', 'ec-3', 'e-ac-3', 'eac-3'],
        displayName: 'EAC3',
        hlsCompatible: true,
        mseCompatible: false,
        noBrowserSupport: false,
        transcodeReason: 'EAC3 (Dolby Digital Plus) not supported in Chrome/Firefox',
    },
    {
        patterns: ['ac3', 'ac-3', 'dolby'],
        displayName: 'AC3',
        hlsCompatible: true,
        mseCompatible: false,
        noBrowserSupport: false,
        transcodeReason: 'AC3 (Dolby Digital) not supported in Chrome/Firefox',
    },
    {
        patterns: ['dts-hd ma', 'dts-hd', 'dtshd'],
        displayName: 'DTS-HD',
        hlsCompatible: false,
        mseCompatible: false,
        noBrowserSupport: true,
        transcodeReason: 'DTS-HD audio requires licensing - no browser support',
    },
    {
        patterns: ['dts'],
        displayName: 'DTS',
        hlsCompatible: false,
        mseCompatible: false,
        noBrowserSupport: true,
        transcodeReason: 'DTS audio requires licensing - no browser support',
    },
    {
        patterns: ['truehd', 'mlp'],
        displayName: 'TrueHD',
        hlsCompatible: false,
        mseCompatible: false,
        noBrowserSupport: true,
        transcodeReason: 'Dolby TrueHD requires licensing - no browser support',
    },
    {
        patterns: ['flac'],
        displayName: 'FLAC',
        hlsCompatible: false,
        mseCompatible: false,
        noBrowserSupport: false,
        transcodeReason: 'FLAC audio not supported in HLS',
    },
    {
        patterns: ['pcm', 'lpcm'],
        displayName: 'PCM',
        hlsCompatible: false,
        mseCompatible: false,
        noBrowserSupport: true,
        transcodeReason: 'PCM audio (uncompressed) too large for streaming',
    },
    {
        patterns: ['vorbis'],
        displayName: 'Vorbis',
        hlsCompatible: false,
        mseCompatible: false,
        noBrowserSupport: false,
        transcodeReason: 'Vorbis audio not supported in HLS/fMP4',
    },
    {
        patterns: ['opus'],
        displayName: 'Opus',
        hlsCompatible: false,
        mseCompatible: true,
        noBrowserSupport: false,
        transcodeReason: 'Opus has limited HLS support',
    },
    {
        patterns: ['aac', 'mp4a'],
        displayName: 'AAC',
        hlsCompatible: true,
        mseCompatible: true,
        noBrowserSupport: false,
        transcodeReason: '',
    },
    {
        patterns: ['mp3', 'mp2'],
        displayName: 'MP3',
        hlsCompatible: true,
        mseCompatible: true,
        noBrowserSupport: false,
        transcodeReason: '',
    },
    {
        patterns: ['alac'],
        displayName: 'ALAC',
        hlsCompatible: true,
        mseCompatible: false,
        noBrowserSupport: false,
        transcodeReason: 'ALAC (Apple Lossless) only supported on Apple devices',
    },
];

// =============================================================================
// LOOKUP FUNCTIONS
// =============================================================================

/**
 * Find audio codec info by codec string.
 */
export function findAudioCodecEntry(codec: string | undefined): AudioCodecTableEntry | undefined {
    if (!codec) return undefined;
    const codecLower = codec.toLowerCase().trim();

    for (const entry of AUDIO_CODEC_TABLE) {
        for (const pattern of entry.patterns) {
            if (codecLower.includes(pattern)) {
                return entry;
            }
        }
    }

    return undefined;
}

/**
 * Check if audio codec is HLS-compatible (can be copied into fMP4 segments).
 */
export function isHlsCompatibleAudioCodec(codec: string | undefined): boolean {
    const entry = findAudioCodecEntry(codec);
    return entry?.hlsCompatible ?? false;
}

/**
 * Check if audio codec requires transcoding for HLS.
 */
export function requiresAudioTranscodeForHls(codec: string | undefined): boolean {
    if (!codec) return true; // Unknown codec - safer to transcode

    const entry = findAudioCodecEntry(codec);
    if (!entry) return true; // Unknown codec - safer to transcode

    return !entry.hlsCompatible;
}

// =============================================================================
// SET GENERATORS (for backwards compatibility with existing code)
// =============================================================================

/**
 * Generate HLS-compatible audio codec patterns Set.
 * This is for backwards compatibility with code that uses Sets.
 */
export function getHlsCompatibleAudioCodecPatterns(): Set<string> {
    const set = new Set<string>();
    for (const entry of AUDIO_CODEC_TABLE) {
        if (entry.hlsCompatible) {
            for (const pattern of entry.patterns) {
                set.add(pattern);
            }
        }
    }
    return set;
}

/**
 * Generate HLS-incompatible audio codec patterns Set.
 * This is for backwards compatibility with code that uses Sets.
 */
export function getHlsIncompatibleAudioCodecPatterns(): Set<string> {
    const set = new Set<string>();
    for (const entry of AUDIO_CODEC_TABLE) {
        if (!entry.hlsCompatible) {
            for (const pattern of entry.patterns) {
                set.add(pattern);
            }
        }
    }
    return set;
}
