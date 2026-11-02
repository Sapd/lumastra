// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Centralized Codec Support System
 *
 * Single source of truth for all codec compatibility information.
 * Used by both client-side player components and server-side HLS utilities.
 *
 * Audio codec tables are imported from $lib/shared/codec-tables.ts to ensure
 * consistency between client and server code.
 */

// Import from codec-types.ts, not browserCapabilities.ts, to avoid the circular dep. (ref: DL-003)
import type { BrowserCapabilities } from './codec-types';
import { AUDIO_CODEC_TABLE, type AudioCodecTableEntry } from '$lib/shared/codec-tables';

// =============================================================================
// AUDIO CODEC SUPPORT TABLE
// =============================================================================

export interface AudioCodecInfo extends AudioCodecTableEntry {
    /** Browser capability key to check (null if not in BrowserCapabilities) */
    capabilityKey: keyof BrowserCapabilities | null;
}

/**
 * Browser capability keys for each audio codec.
 * Maps codec display names to BrowserCapabilities keys.
 */
const AUDIO_CODEC_CAPABILITY_KEYS: Record<string, keyof BrowserCapabilities | null> = {
    EAC3: 'eac3',
    AC3: 'ac3',
    'DTS-HD': 'dts',
    DTS: 'dts',
    TrueHD: 'truehd',
    FLAC: 'flac',
    PCM: null,
    Vorbis: null,
    Opus: 'opus',
    AAC: 'aac',
    MP3: null,
    ALAC: null,
};

/**
 * Complete audio codec support table with browser capability keys.
 * Built from shared AUDIO_CODEC_TABLE with added capability keys.
 */
export const AUDIO_CODECS: AudioCodecInfo[] = AUDIO_CODEC_TABLE.map((entry) => ({
    ...entry,
    capabilityKey: AUDIO_CODEC_CAPABILITY_KEYS[entry.displayName] ?? null,
}));

// =============================================================================
// VIDEO CODEC SUPPORT TABLE
// =============================================================================

export interface VideoCodecInfo {
    /** Patterns to match this codec (lowercase) */
    patterns: string[];
    /** Browser capability key to check */
    capabilityKey: keyof BrowserCapabilities;
    /** Human-readable display name */
    displayName: string;
    /** Can carry HDR metadata */
    hdrCapable: boolean;
    /** Safari has native support */
    safariNative: boolean;
    /** Reason template when browser lacks support ({browser} is replaced) */
    transcodeReason: string;
}

/**
 * Complete video codec support table.
 */
export const VIDEO_CODECS: VideoCodecInfo[] = [
    {
        patterns: ['h264', 'avc', 'avc1'],
        capabilityKey: 'h264',
        displayName: 'H.264',
        hdrCapable: false,
        safariNative: true,
        transcodeReason: '', // Universal support
    },
    {
        patterns: ['hevc', 'h265', 'hvc1', 'hev1'],
        capabilityKey: 'h265',
        displayName: 'HEVC',
        hdrCapable: true,
        safariNative: true,
        transcodeReason: '{browser} lacks HEVC/H.265 hardware decoding support',
    },
    {
        patterns: ['vp9', 'vp09'],
        capabilityKey: 'vp9',
        displayName: 'VP9',
        hdrCapable: true,
        safariNative: false,
        transcodeReason: '{browser} lacks VP9 decoding support',
    },
    {
        patterns: ['av1', 'av01'],
        capabilityKey: 'av1',
        displayName: 'AV1',
        hdrCapable: true,
        safariNative: false,
        transcodeReason: '{browser} lacks AV1 hardware decoding support',
    },
    {
        patterns: ['mpeg2', 'mpeg2video', 'mp2v'],
        capabilityKey: 'h264', // Not actually supported, will always fail
        displayName: 'MPEG-2',
        hdrCapable: false,
        safariNative: false,
        transcodeReason: 'MPEG-2 not supported in browsers',
    },
];

// =============================================================================
// CONTAINER SUPPORT TABLE
// =============================================================================

export interface ContainerInfo {
    /** Patterns to match this container (lowercase) */
    patterns: string[];
    /** Human-readable display name */
    displayName: string;
    /** Can play directly in <video> element */
    browserDirectPlay: boolean;
    /** Requires HLS remuxing for browser playback */
    needsHlsRemux: boolean;
}

/**
 * Container support table.
 */
export const CONTAINERS: ContainerInfo[] = [
    {
        patterns: ['mp4', 'm4v', 'mov'],
        displayName: 'MP4',
        browserDirectPlay: true,
        needsHlsRemux: false,
    },
    {
        patterns: ['webm'],
        displayName: 'WebM',
        browserDirectPlay: true,
        needsHlsRemux: false,
    },
    {
        patterns: ['mkv', 'matroska'],
        displayName: 'MKV',
        browserDirectPlay: false,
        needsHlsRemux: true,
    },
    {
        patterns: ['ts', 'mpegts', 'm2ts'],
        displayName: 'MPEG-TS',
        browserDirectPlay: false, // Only via HLS
        needsHlsRemux: false, // Already HLS-compatible
    },
    {
        patterns: ['avi'],
        displayName: 'AVI',
        browserDirectPlay: false,
        needsHlsRemux: true,
    },
];

// =============================================================================
// HDR FORMAT SUPPORT TABLE
// =============================================================================

export interface HdrFormatInfo {
    /** Jellyfin VideoRangeType values that match this format */
    rangeTypes: string[];
    /** Jellyfin VideoRange values that match this format */
    videoRanges: string[];
    /** Human-readable display name */
    displayName: string;
    /** Requires HDR-to-SDR tone mapping */
    requiresToneMapping: boolean;
    /** Only Safari can decode this format */
    safariOnly: boolean;
    /** Has fallback layer (for Dolby Vision profiles) */
    hasFallbackLayer: boolean;
}

/**
 * HDR format support table.
 * Order matters - check DV profiles before generic HDR.
 */
export const HDR_FORMATS: HdrFormatInfo[] = [
    {
        rangeTypes: ['DOVI'],
        videoRanges: [],
        displayName: 'Dolby Vision (Profile 7)',
        requiresToneMapping: true, // No fallback layer
        safariOnly: true,
        hasFallbackLayer: false,
    },
    {
        rangeTypes: ['DOVIWithHDR10'],
        videoRanges: [],
        displayName: 'Dolby Vision (Profile 8)',
        requiresToneMapping: false, // Has HDR10 fallback layer
        safariOnly: true,
        hasFallbackLayer: true,
    },
    {
        rangeTypes: ['DOVIWithHLG'],
        videoRanges: [],
        displayName: 'Dolby Vision (HLG)',
        requiresToneMapping: false,
        safariOnly: true,
        hasFallbackLayer: true,
    },
    {
        rangeTypes: ['DOVIWithSDR'],
        videoRanges: [],
        displayName: 'Dolby Vision (Profile 5)',
        requiresToneMapping: false,
        safariOnly: true,
        hasFallbackLayer: true,
    },
    {
        rangeTypes: ['HDR10Plus'],
        videoRanges: ['HDR10+'],
        displayName: 'HDR10+',
        requiresToneMapping: false,
        safariOnly: false,
        hasFallbackLayer: false,
    },
    {
        rangeTypes: ['HDR10'],
        videoRanges: ['HDR10', 'HDR'],
        displayName: 'HDR10',
        requiresToneMapping: false,
        safariOnly: false,
        hasFallbackLayer: false,
    },
    {
        rangeTypes: ['HLG'],
        videoRanges: ['HLG'],
        displayName: 'HLG',
        requiresToneMapping: false,
        safariOnly: false,
        hasFallbackLayer: false,
    },
];

// =============================================================================
// LOOKUP FUNCTIONS
// =============================================================================

/**
 * Find audio codec info by codec string.
 * Returns AudioCodecInfo with browser capability key included.
 */
export function findAudioCodec(codec: string | undefined): AudioCodecInfo | undefined {
    if (!codec) return undefined;
    const codecLower = codec.toLowerCase();

    for (const info of AUDIO_CODECS) {
        for (const pattern of info.patterns) {
            if (codecLower.includes(pattern)) {
                return info;
            }
        }
    }

    return undefined;
}

/**
 * Find video codec info by codec string.
 */
export function findVideoCodec(codec: string | undefined): VideoCodecInfo | undefined {
    if (!codec) return undefined;
    const codecLower = codec.toLowerCase();

    for (const info of VIDEO_CODECS) {
        for (const pattern of info.patterns) {
            if (codecLower.includes(pattern)) {
                return info;
            }
        }
    }

    return undefined;
}

/**
 * Find container info by container string.
 */
export function findContainer(container: string | undefined): ContainerInfo | undefined {
    if (!container) return undefined;
    const containerLower = container.toLowerCase();

    for (const info of CONTAINERS) {
        for (const pattern of info.patterns) {
            if (containerLower.includes(pattern)) {
                return info;
            }
        }
    }

    return undefined;
}

/**
 * Match HDR format by iterating through formats and checking a property.
 */
function matchHdrProperty<T>(
    formats: HdrFormatInfo[],
    getValues: (format: HdrFormatInfo) => T[],
    match: (value: T, searchString: string) => boolean,
    searchString: string,
): HdrFormatInfo | undefined {
    for (const format of formats) {
        const values = getValues(format);
        for (const value of values) {
            if (match(value, searchString)) {
                return format;
            }
        }
    }
    return undefined;
}

/**
 * Find HDR format info by range type and video range.
 */
export function findHdrFormat(
    rangeType: string | undefined,
    videoRange: string | undefined,
): HdrFormatInfo | undefined {
    const rangeTypeLower = rangeType?.toLowerCase() || '';
    const videoRangeLower = videoRange?.toLowerCase() || '';

    // Check for Dolby Vision in video range string
    if (videoRangeLower.includes('dolby vision')) {
        // Find the appropriate DV profile
        for (const info of HDR_FORMATS) {
            if (info.displayName.includes('Dolby Vision')) {
                for (const rt of info.rangeTypes) {
                    if (rt.toLowerCase() === rangeTypeLower) {
                        return info;
                    }
                }
            }
        }
        // Generic DV if no specific profile match
        return HDR_FORMATS.find((f) => f.rangeTypes.includes('DOVI'));
    }

    // Check by range type first (most specific)
    const byRangeType = matchHdrProperty(
        HDR_FORMATS,
        (f) => f.rangeTypes,
        (v, s) => v.toLowerCase() === s,
        rangeTypeLower,
    );
    if (byRangeType) return byRangeType;

    // Check by video range
    const byVideoRange = matchHdrProperty(
        HDR_FORMATS,
        (f) => f.videoRanges,
        (v, s) => v.toLowerCase() === s || s.includes(v.toLowerCase()),
        videoRangeLower,
    );
    if (byVideoRange) return byVideoRange;

    return undefined;
}

// =============================================================================
// COMPATIBILITY CHECK FUNCTIONS
// =============================================================================

export interface AudioTranscodeResult {
    needsTranscode: boolean;
    reason: string;
    codecInfo: AudioCodecInfo | undefined;
}

/**
 * Check if an audio codec needs transcoding based on browser capabilities.
 *
 * @param codec - Audio codec string from media source
 * @param caps - Browser capabilities (null = assume no special codec support)
 * @returns Object with needsTranscode flag, reason, and codec info
 */
export function needsAudioTranscode(
    codec: string | undefined,
    caps: BrowserCapabilities | null,
): AudioTranscodeResult {
    const codecInfo = findAudioCodec(codec);

    if (!codecInfo) {
        // Unknown codec - safer to transcode
        return {
            needsTranscode: true,
            reason: `Unknown audio codec "${codec}" - transcoding for compatibility`,
            codecInfo: undefined,
        };
    }

    // Codecs with no browser support always need transcoding
    if (codecInfo.noBrowserSupport) {
        return {
            needsTranscode: true,
            reason: codecInfo.transcodeReason,
            codecInfo,
        };
    }

    // Check browser capability if applicable
    if (codecInfo.capabilityKey && caps) {
        const capValue = caps[codecInfo.capabilityKey];
        const isSupported = typeof capValue === 'boolean' ? capValue : capValue?.supported;

        if (!isSupported && codecInfo.transcodeReason) {
            return {
                needsTranscode: true,
                reason: codecInfo.transcodeReason,
                codecInfo,
            };
        }
    }

    // AAC, MP3, and other universally supported codecs
    return {
        needsTranscode: false,
        reason: '',
        codecInfo,
    };
}

export interface VideoTranscodeResult {
    needsTranscode: boolean;
    reason: string;
    codecInfo: VideoCodecInfo | undefined;
}

/**
 * Check if a video codec needs transcoding based on browser capabilities.
 *
 * @param codec - Video codec string from media source
 * @param caps - Browser capabilities
 * @param isSafari - Whether the browser is Safari
 * @param browserName - Browser name for error messages
 * @returns Object with needsTranscode flag, reason, and codec info
 */
export function needsVideoTranscode(
    codec: string | undefined,
    caps: BrowserCapabilities | null,
    isSafari: boolean,
    browserName: string = 'Browser',
): VideoTranscodeResult {
    const codecInfo = findVideoCodec(codec);

    if (!codecInfo) {
        // Unknown codec - assume it needs transcoding
        return {
            needsTranscode: true,
            reason: `Unknown video codec "${codec}" requires transcoding`,
            codecInfo: undefined,
        };
    }

    // H.264 is universally supported
    if (codecInfo.displayName === 'H.264') {
        return {
            needsTranscode: false,
            reason: '',
            codecInfo,
        };
    }

    // Safari with native support for HEVC
    if (isSafari && codecInfo.safariNative) {
        return {
            needsTranscode: false,
            reason: '',
            codecInfo,
        };
    }

    // Check browser capability
    if (caps) {
        const capValue = caps[codecInfo.capabilityKey];
        const isSupported = typeof capValue === 'boolean' ? capValue : capValue?.supported;

        if (isSupported) {
            return {
                needsTranscode: false,
                reason: '',
                codecInfo,
            };
        }
    }

    // Browser doesn't support this codec
    const reason = codecInfo.transcodeReason.replace('{browser}', browserName);
    return {
        needsTranscode: true,
        reason,
        codecInfo,
    };
}

/**
 * Build codec preference list for HLS transcoding (most efficient first).
 */
export function getCodecPreferenceList(
    caps: BrowserCapabilities | null,
    isSafari: boolean,
): string[] {
    const codecPreference: string[] = [];

    const supportsAv1 = caps?.av1?.supported || false;
    const browserSupportsHevc = caps?.h265?.supported || false;
    const supportsHevc = isSafari || browserSupportsHevc;

    if (supportsAv1) codecPreference.push('av1');
    if (supportsHevc) codecPreference.push('hevc');
    codecPreference.push('h264'); // Always fallback

    return codecPreference;
}

// =============================================================================
// MSE/HLS COMPATIBILITY FUNCTIONS
// =============================================================================

/**
 * Check if audio codec is compatible with HLS.js/MSE (for non-Safari browsers).
 * Safari handles all codecs natively, but Chrome/Firefox via hls.js have limited support.
 *
 * Compatible: aac, mp3
 * Incompatible: ac3, eac3, flac, dts, truehd, pcm, vorbis, opus (in HLS)
 */
export function isAudioCodecMseCompatible(codec: string | undefined): boolean {
    const codecInfo = findAudioCodec(codec);

    if (!codecInfo) {
        // Unknown codec - assume incompatible with MSE
        return false;
    }

    return codecInfo.mseCompatible;
}

/**
 * Check if audio codec is HLS-compatible (can be copied into fMP4 segments).
 * This is broader than MSE compatibility - includes AC3/EAC3 for Apple devices.
 */
export function isHlsCompatibleAudioCodec(codec: string | undefined): boolean {
    const codecInfo = findAudioCodec(codec);

    if (!codecInfo) {
        return false;
    }

    return codecInfo.hlsCompatible;
}

/**
 * Check if audio codec requires transcoding for HLS.
 */
export function requiresAudioTranscodeForHls(codec: string | undefined): boolean {
    const codecInfo = findAudioCodec(codec);

    if (!codecInfo) {
        // Unknown codec - safer to transcode
        return true;
    }

    return !codecInfo.hlsCompatible;
}

/**
 * Check if audio codec requires transcoding for HLS playback in a specific browser.
 *
 * Safari uses native HLS which supports AC3/EAC3.
 * Chrome/Firefox use hls.js/MSE which only supports AAC/MP3.
 *
 * @param codec - Audio codec string
 * @param isSafari - Whether the browser is Safari (uses native HLS)
 * @returns true if the codec needs transcoding for this browser
 */
export function needsAudioTranscodeForBrowser(
    codec: string | undefined,
    isSafari: boolean,
): boolean {
    const codecInfo = findAudioCodec(codec);

    if (!codecInfo) {
        // Unknown codec - safer to transcode
        return true;
    }

    // Safari uses native HLS which supports more codecs (AC3, EAC3, ALAC)
    // Other browsers use hls.js/MSE which only supports AAC, MP3
    return isSafari ? !codecInfo.hlsCompatible : !codecInfo.mseCompatible;
}

// =============================================================================
// VIDEO CODEC HELPER FUNCTIONS
// =============================================================================

/**
 * Check if codec is HEVC/H.265.
 */
export function isHevcCodec(codec: string | undefined): boolean {
    const codecInfo = findVideoCodec(codec);
    return codecInfo?.displayName === 'HEVC';
}

/**
 * Check if codec is AV1.
 */
export function isAv1Codec(codec: string | undefined): boolean {
    const codecInfo = findVideoCodec(codec);
    return codecInfo?.displayName === 'AV1';
}

// isVp9Codec and isH264Codec removed — confirmed dead code with no callers
// across the entire src/ tree. (ref: DL-005)

// =============================================================================
// HDR HELPER FUNCTIONS
// =============================================================================

/**
 * Check if content is Dolby Vision (any profile).
 */
export function isDolbyVision(
    rangeType: string | undefined,
    videoRange: string | undefined,
): boolean {
    const hdrFormat = findHdrFormat(rangeType, videoRange);
    return hdrFormat?.displayName.includes('Dolby Vision') || false;
}

/**
 * Check if content is Dolby Vision Profile 7 (no fallback layer).
 */
export function isDolbyVisionPure(rangeType: string | undefined): boolean {
    return rangeType === 'DOVI';
}

/**
 * Check if content is any HDR format.
 */
export function isHdrContent(
    rangeType: string | undefined,
    videoRange: string | undefined,
): boolean {
    return findHdrFormat(rangeType, videoRange) !== undefined;
}

// =============================================================================
// RE-EXPORTS FROM SHARED MODULE
// =============================================================================

// Re-export shared codec table functions for server-side compatibility
export {
    getHlsCompatibleAudioCodecPatterns as getHlsCompatibleAudioCodecSet,
    getHlsIncompatibleAudioCodecPatterns as getHlsIncompatibleAudioCodecSet,
} from '$lib/shared/codec-tables';
