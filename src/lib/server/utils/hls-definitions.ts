// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Definitions and Playlist Builders
 *
 * Centralizes all HLS (HTTP Live Streaming) constants, tags, and playlist generation utilities.
 * Based on Apple's HLS specification (RFC 8216) and extensions.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8216
 * @see https://developer.apple.com/documentation/http-live-streaming
 */

// =============================================================================
// HLS VERSION CONSTANTS
// =============================================================================

/**
 * HLS protocol versions and their key features.
 * Higher versions add features but may reduce client compatibility.
 */
export const HLS_VERSION = {
    /** Basic HLS support (legacy) */
    V3: 3,
    /** I-frame playlists, byte range support */
    V4: 4,
    /** EXT-X-MAP for fMP4 init segments */
    V6: 6,
    /** fMP4 segments, SERVICE attribute for audio */
    V7: 7,
} as const;

/** Default HLS version for media playlists (fMP4 support) */
export const DEFAULT_HLS_VERSION = HLS_VERSION.V7;

/** HLS version for I-frame playlists (byte range support) */
export const IFRAME_HLS_VERSION = HLS_VERSION.V4;

// =============================================================================
// HLS TAG CONSTANTS
// =============================================================================

/**
 * Core HLS tags used in playlist generation.
 * These are the raw tag names without values.
 */
export const HLS_TAGS = {
    // Playlist markers
    HEADER: '#EXTM3U',
    VERSION: '#EXT-X-VERSION',
    ENDLIST: '#EXT-X-ENDLIST',

    // Playlist type and behavior
    PLAYLIST_TYPE: '#EXT-X-PLAYLIST-TYPE',
    TARGET_DURATION: '#EXT-X-TARGETDURATION',
    MEDIA_SEQUENCE: '#EXT-X-MEDIA-SEQUENCE',
    DISCONTINUITY_SEQUENCE: '#EXT-X-DISCONTINUITY-SEQUENCE',
    START: '#EXT-X-START',

    // Segment information
    EXTINF: '#EXTINF',
    BYTERANGE: '#EXT-X-BYTERANGE',
    DISCONTINUITY: '#EXT-X-DISCONTINUITY',
    MAP: '#EXT-X-MAP',
    PROGRAM_DATE_TIME: '#EXT-X-PROGRAM-DATE-TIME',

    // Renditions and variants
    MEDIA: '#EXT-X-MEDIA',
    STREAM_INF: '#EXT-X-STREAM-INF',
    I_FRAME_STREAM_INF: '#EXT-X-I-FRAME-STREAM-INF',

    // I-frame playlists
    I_FRAMES_ONLY: '#EXT-X-I-FRAMES-ONLY',

    // Image/trickplay playlists (Apple extension)
    IMAGE_STREAM_INF: '#EXT-X-IMAGE-STREAM-INF',
    IMAGES_ONLY: '#EXT-X-IMAGES-ONLY',
    TILES: '#EXT-X-TILES',
} as const;

/**
 * Playlist type values for #EXT-X-PLAYLIST-TYPE
 */
export const PLAYLIST_TYPE = {
    /** Live playlist that never changes */
    EVENT: 'EVENT',
    /** Complete playlist (all segments known) */
    VOD: 'VOD',
} as const;

/**
 * Media type values for #EXT-X-MEDIA:TYPE
 */
export const MEDIA_TYPE = {
    AUDIO: 'AUDIO',
    VIDEO: 'VIDEO',
    SUBTITLES: 'SUBTITLES',
    CLOSED_CAPTIONS: 'CLOSED-CAPTIONS',
} as const;

// =============================================================================
// CONTENT TYPES AND MIME TYPES
// =============================================================================

/**
 * MIME types for HLS content
 */
export const HLS_CONTENT_TYPE = {
    /** HLS playlist (.m3u8) */
    PLAYLIST: 'application/vnd.apple.mpegurl',
    /** fMP4 init segment (.mp4) */
    INIT_SEGMENT: 'video/mp4',
    /** fMP4 media segment (.m4s) */
    MEDIA_SEGMENT: 'video/mp4',
    /** MPEG-TS segment (.ts) - used for synthetic I-frame segments */
    TS_SEGMENT: 'video/mp2t',
    /** WebVTT subtitle segment (.vtt) */
    WEBVTT: 'text/vtt',
} as const;

// =============================================================================
// CODEC STRING CONSTANTS
// =============================================================================

/**
 * Audio codec strings for HLS playlists.
 *
 * Note: For pass-through audio (direct stream), the actual codec depends on source.
 * These are the codec strings used in HLS CODECS attribute.
 */
export const AUDIO_CODEC = {
    // AAC family (most compatible, used for transcoding)
    /** AAC-LC (Low Complexity) - most compatible, default for transcoding */
    AAC_LC: 'mp4a.40.2',
    /** HE-AAC v1 (AAC+ / aacPlus) - better at low bitrates */
    HE_AAC: 'mp4a.40.5',
    /** HE-AAC v2 (eAAC+ / aacPlus v2) - stereo at very low bitrates */
    HE_AAC_V2: 'mp4a.40.29',

    // Dolby family (pass-through for compatible devices)
    /** AC-3 (Dolby Digital) - 5.1 surround, widely supported */
    AC3: 'ac-3',
    /** E-AC-3 (Dolby Digital Plus / DD+) - improved AC-3, up to 7.1 */
    EAC3: 'ec-3',
    /** Dolby Atmos (E-AC-3 with JOC - Joint Object Coding) */
    ATMOS: 'ec-3',
    /** Dolby TrueHD (lossless, Blu-ray) - typically transcoded to AC3/EAC3 for streaming */
    TRUEHD: 'mlpa',

    // DTS family (pass-through for compatible devices)
    /** DTS (Digital Theater Systems) - 5.1 surround */
    DTS: 'dtsc',
    /** DTS-HD Master Audio (lossless) - typically transcoded for streaming */
    DTS_HD_MA: 'dtsl',
    /** DTS:X (object-based, similar to Atmos) */
    DTS_X: 'dtsx',

    // Other formats
    /** FLAC (Free Lossless Audio Codec) - lossless, open format */
    FLAC: 'fLaC',
    /** Opus - excellent at all bitrates, WebM/WebRTC standard */
    OPUS: 'Opus',
    /** Vorbis - open format, commonly in WebM */
    VORBIS: 'vorbis',
    /** MP3 (MPEG-1 Audio Layer III) - legacy compatibility */
    MP3: 'mp4a.40.34',
    /** ALAC (Apple Lossless) */
    ALAC: 'alac',
} as const;

/** Default audio codec for HLS (AAC-LC for maximum compatibility) */
export const DEFAULT_AUDIO_CODEC = AUDIO_CODEC.AAC_LC;

/**
 * Video codec profile/level strings for HLS.
 *
 * Format varies by codec:
 * - H.264: avc1.PPCCLL (Profile, Constraints, Level)
 * - HEVC: hvc1/hev1.P.T.Lxxx.Cx (Profile, Tier, Level, Constraints)
 * - Dolby Vision: dvh1/dvhe.PP.LL (Profile, Level)
 *
 * Note: We use hvc1 for HEVC in HLS (Apple requires it).
 * hvc1 = parameter sets only in sample entry; hev1 = also in-band.
 * Safari silently rejects hev1 in HLS master playlist CODECS strings.
 */
export const VIDEO_CODEC = {
    // =========================================================================
    // H.264 (AVC) - Widest compatibility
    // =========================================================================
    /** H.264 Baseline Profile Level 3.0 (most compatible, mobile) */
    H264_BASELINE_30: 'avc1.42E01E',
    /** H.264 Main Profile Level 3.1 (standard def) */
    H264_MAIN_31: 'avc1.4D401F',
    /** H.264 High Profile Level 4.0 (720p) */
    H264_HIGH_40: 'avc1.640028',
    /** H.264 High Profile Level 4.1 (1080p @ 30fps) */
    H264_HIGH_41: 'avc1.640029',
    /** H.264 High Profile Level 4.2 (1080p @ 60fps) */
    H264_HIGH_42: 'avc1.64002A',
    /** H.264 High Profile Level 5.1 (4K @ 30fps) */
    H264_HIGH_51: 'avc1.640033',
    /** H.264 High Profile Level 5.2 (4K @ 60fps) */
    H264_HIGH_52: 'avc1.640034',

    // =========================================================================
    // H.265 (HEVC) - HDR support, better compression
    // =========================================================================
    /** HEVC Main Profile Level 4.0 (1080p SDR) */
    HEVC_MAIN_40: 'hvc1.1.6.L120.B0',
    /** HEVC Main Profile Level 5.0 (4K SDR) */
    HEVC_MAIN_50: 'hvc1.1.6.L150.B0',
    /** HEVC Main Profile Level 5.1 (4K60 SDR) */
    HEVC_MAIN_51: 'hvc1.1.6.L153.B0',
    /** HEVC Main 10 Profile Level 4.0 (1080p HDR) */
    HEVC_MAIN10_40: 'hvc1.2.4.L120.B0',
    /** HEVC Main 10 Profile Level 5.0 (4K HDR10) */
    HEVC_MAIN10_50: 'hvc1.2.4.L150.B0',
    /** HEVC Main 10 Profile Level 5.1 (4K60 HDR10) */
    HEVC_MAIN10_51: 'hvc1.2.4.L153.B0',

    // =========================================================================
    // Dolby Vision (HEVC-based)
    // =========================================================================
    // Prefix explanation:
    // - dvh1: NAL length-prefixed (for fMP4/ISOBMFF) ← We use this
    // - dvhe: NAL start-code prefixed (for MPEG-TS)
    //
    // Profile explanation:
    // - Profile 5: Single-layer, non-cross-compatible (requires DV decoder)
    // - Profile 7: Dual-layer, non-cross-compatible (requires DV decoder)
    // - Profile 8: Single-layer, cross-compatible (HDR10/HLG fallback)
    //   - 8.1: HDR10 base layer
    //   - 8.4: HLG base layer
    //
    // For Profile 8 content, we use HEVC codec in CODECS and DV codec in
    // SUPPLEMENTAL-CODECS (allows non-DV devices to play HDR10 fallback).

    /** Dolby Vision Profile 5 Level 6 (non-cross-compatible, DV only) */
    DV_PROFILE_5: 'dvh1.05.06',
    /** Dolby Vision Profile 7 Level 6 (non-cross-compatible, dual-layer) */
    DV_PROFILE_7: 'dvh1.07.06',
    /** Dolby Vision Profile 8 Level 6 (cross-compatible with HDR10/HLG) */
    DV_PROFILE_8: 'dvh1.08.06',

    // =========================================================================
    // AV1 - Next-gen codec (limited device support)
    // =========================================================================
    /** AV1 Main Profile Level 5.0 (4K) */
    AV1_MAIN_50: 'av01.0.12M.08',
    /** AV1 Main Profile Level 5.1 (4K60) */
    AV1_MAIN_51: 'av01.0.13M.08',
    /** AV1 High Profile Level 5.0 (4K HDR10) */
    AV1_HIGH_50: 'av01.0.12H.10',
    /** AV1 High Profile Level 5.1 (4K60 HDR10) */
    AV1_HIGH_51: 'av01.0.13H.10',
} as const;

// =============================================================================
// VIDEO RANGE CONSTANTS
// =============================================================================

/**
 * HLS VIDEO-RANGE attribute values.
 * Used in #EXT-X-STREAM-INF to signal HDR capability.
 */
export const VIDEO_RANGE = {
    /** Standard Dynamic Range (8-bit, BT.709) */
    SDR: 'SDR',
    /** Perceptual Quantizer (HDR10, HDR10+, Dolby Vision) */
    PQ: 'PQ',
    /** Hybrid Log-Gamma (BBC/NHK HDR standard) */
    HLG: 'HLG',
} as const;

/**
 * Jellyfin VideoRangeType values (source metadata).
 * These are mapped to HLS VIDEO_RANGE values.
 */
export const JELLYFIN_VIDEO_RANGE = {
    SDR: 'SDR',
    HDR: 'HDR',
    HDR10: 'HDR10',
    HDR10_PLUS: 'HDR10Plus',
    HLG: 'HLG',
    DOVI: 'DOVI',
    DOVI_WITH_HDR10: 'DOVIWithHDR10',
    DOVI_WITH_HLG: 'DOVIWithHLG',
    DOVI_WITH_SDR: 'DOVIWithSDR',
} as const;

/**
 * Map Jellyfin VideoRangeType to HLS VIDEO-RANGE attribute.
 */
export function mapVideoRangeToHls(jellyfinRange?: string): string | undefined {
    if (!jellyfinRange) return undefined;

    const range = jellyfinRange.toUpperCase();

    // SDR - no VIDEO-RANGE attribute needed (it's the default)
    if (range === 'SDR') return undefined;

    // HLG content
    if (range === 'HLG' || range.includes('HLG')) return VIDEO_RANGE.HLG;

    // PQ content (HDR10, HDR10+, Dolby Vision)
    if (
        range === 'HDR' ||
        range === 'HDR10' ||
        range === 'HDR10PLUS' ||
        range.includes('DOVI') ||
        range.includes('DOLBY')
    ) {
        return VIDEO_RANGE.PQ;
    }

    return undefined;
}

// =============================================================================
// GROUP IDs
// =============================================================================

/**
 * Standard GROUP-ID values for renditions
 */
export const GROUP_ID = {
    AUDIO: 'audio',
    SUBTITLES: 'subs',
} as const;

// =============================================================================
// SEGMENT PATTERNS
// =============================================================================

/**
 * File naming patterns for HLS segments
 */
export const SEGMENT_PATTERN = {
    /** Init segment filename pattern: init_%v.mp4 (%v = variant index, each stream is in its own directory) */
    INIT: 'init_%v.mp4',
    /** Media segment pattern: segment_00000.m4s */
    MEDIA: 'segment_%05d.m4s',
    /** Stream directory pattern: stream_0/, stream_1/ */
    STREAM_DIR: 'stream_%v',
    /** Variant playlist: index.m3u8 */
    VARIANT_PLAYLIST: 'index.m3u8',
    /** Subtitle segment pattern: seg_00000.vtt */
    SUBTITLE: 'seg_%05d.vtt',
    /**
     * Synthetic I-frame segment pattern: iframe_00000.ts
     * Uses MPEG-TS (.ts) because each I-frame is a self-contained single-frame
     * video segment (ftyp+moov+mdat in one file), avoiding init segment issues.
     */
    IFRAME: 'iframe_%05d.ts',
} as const;

// =============================================================================
// DEFAULT VALUES
// =============================================================================

/**
 * Default segment duration in seconds.
 * Apple recommends 6 seconds for most use cases.
 */
export const DEFAULT_SEGMENT_DURATION = 6;

/**
 * Default number of segments to keep behind current position
 * for rewind buffer (100 segments * 6s = 10 minutes)
 */
export const DEFAULT_SEGMENTS_KEEP_BEHIND = 100;

// =============================================================================
// PLAYLIST BUILDERS
// =============================================================================

/**
 * Options for building a media playlist
 */
export interface MediaPlaylistOptions {
    /** HLS version (default: 7) */
    version?: number;
    /** Target segment duration in seconds */
    targetDuration: number;
    /** Playlist type: VOD or EVENT */
    playlistType?: 'VOD' | 'EVENT';
    /** Starting media sequence number (default: 0) */
    mediaSequence?: number;
    /** Include #EXT-X-ENDLIST tag (default: true for VOD) */
    includeEndlist?: boolean;
}

/**
 * Options for building an I-frame playlist
 */
export interface IFramePlaylistOptions {
    /** HLS version (default: 4 for byte range support) */
    version?: number;
    /** Target duration (max I-frame duration) */
    targetDuration: number;
    /** Playlist type: VOD or EVENT */
    playlistType?: 'VOD' | 'EVENT';
    /** Include #EXT-X-ENDLIST tag */
    includeEndlist?: boolean;
}

/**
 * I-frame entry for building I-frame playlists
 */
export interface IFrameEntry {
    /** Duration in seconds */
    duration: number;
    /** URI to the segment (or segment + byte range) */
    uri: string;
    /** Optional byte range: size@offset */
    byteRange?: { size: number; offset: number };
}

/**
 * Segment entry for building media playlists
 */
export interface SegmentEntry {
    /** Duration in seconds */
    duration: number;
    /** URI to the segment */
    uri: string;
    /** Optional title/description after EXTINF */
    title?: string;
}

/**
 * Builder class for HLS playlists.
 * Provides a fluent interface for constructing playlist content.
 */
/**
 * Strip CR/LF from a value bound for a single playlist line.
 *
 * `uri`/`title` on `segment`/`segmentWithByteRange` and the raw line on
 * `raw()` are joined into the playlist with `\n`. A caller-supplied value
 * that itself contains CR or LF (e.g. an unescaped query fragment carrying a
 * `fileId` from the request) would otherwise inject extra playlist lines —
 * including forged HLS tags like a second `#EXT-X-ENDLIST`.
 */
function stripCrlf(value: string): string {
    return value.replace(/[\r\n]/g, '');
}

export class HlsPlaylistBuilder {
    private lines: string[] = [];

    /**
     * Start a new playlist with #EXTM3U header
     */
    header(): this {
        this.lines.push(HLS_TAGS.HEADER);
        return this;
    }

    /**
     * Add #EXT-X-VERSION tag
     */
    version(v: number): this {
        this.lines.push(`${HLS_TAGS.VERSION}:${v}`);
        return this;
    }

    /**
     * Add #EXT-X-TARGETDURATION tag
     */
    targetDuration(seconds: number): this {
        this.lines.push(`${HLS_TAGS.TARGET_DURATION}:${Math.ceil(seconds)}`);
        return this;
    }

    /**
     * Add #EXT-X-PLAYLIST-TYPE tag
     */
    playlistType(type: 'VOD' | 'EVENT'): this {
        this.lines.push(`${HLS_TAGS.PLAYLIST_TYPE}:${type}`);
        return this;
    }

    /**
     * Add #EXT-X-MEDIA-SEQUENCE tag
     */
    mediaSequence(seq: number): this {
        this.lines.push(`${HLS_TAGS.MEDIA_SEQUENCE}:${seq}`);
        return this;
    }

    /**
     * Add #EXT-X-I-FRAMES-ONLY tag
     */
    iFramesOnly(): this {
        this.lines.push(HLS_TAGS.I_FRAMES_ONLY);
        return this;
    }

    /**
     * Add #EXT-X-IMAGES-ONLY tag (Apple extension for trickplay)
     */
    imagesOnly(): this {
        this.lines.push(HLS_TAGS.IMAGES_ONLY);
        return this;
    }

    /**
     * Add #EXT-X-MAP tag for init segment
     */
    mapUri(uri: string): this {
        this.lines.push(`${HLS_TAGS.MAP}:URI="${uri}"`);
        return this;
    }

    /**
     * Add #EXT-X-START tag for start time offset
     */
    startOffset(timeOffset: number, precise: boolean = true): this {
        this.lines.push(
            `${HLS_TAGS.START}:TIME-OFFSET=${timeOffset.toFixed(3)},PRECISE=${precise ? 'YES' : 'NO'}`,
        );
        return this;
    }

    /**
     * Add #EXT-X-PROGRAM-DATE-TIME tag.
     * Required by Safari for synchronizing audio/video renditions when switching tracks.
     */
    programDateTime(date: Date): this {
        this.lines.push(`${HLS_TAGS.PROGRAM_DATE_TIME}:${date.toISOString()}`);
        return this;
    }

    /**
     * Add a segment with #EXTINF
     */
    segment(duration: number, uri: string, title?: string): this {
        const titlePart = title ? stripCrlf(title) : '';
        this.lines.push(`${HLS_TAGS.EXTINF}:${duration.toFixed(6)},${titlePart}`);
        this.lines.push(stripCrlf(uri));
        return this;
    }

    /**
     * Add a segment with byte range
     */
    segmentWithByteRange(
        duration: number,
        uri: string,
        byteSize: number,
        byteOffset: number,
    ): this {
        this.lines.push(`${HLS_TAGS.EXTINF}:${duration.toFixed(6)},`);
        this.lines.push(`${HLS_TAGS.BYTERANGE}:${byteSize}@${byteOffset}`);
        this.lines.push(stripCrlf(uri));
        return this;
    }

    /**
     * Add #EXT-X-TILES tag for image playlists
     */
    tiles(resolution: string, layout: string, duration: number): this {
        this.lines.push(
            `${HLS_TAGS.TILES}:RESOLUTION=${resolution},LAYOUT=${layout},DURATION=${duration.toFixed(3)}`,
        );
        return this;
    }

    /**
     * Add #EXT-X-DISCONTINUITY tag
     */
    discontinuity(): this {
        this.lines.push(HLS_TAGS.DISCONTINUITY);
        return this;
    }

    /**
     * Add #EXT-X-ENDLIST tag
     */
    endlist(): this {
        this.lines.push(HLS_TAGS.ENDLIST);
        return this;
    }

    /**
     * Add a blank line
     */
    blank(): this {
        this.lines.push('');
        return this;
    }

    /**
     * Add a raw line (for custom tags or comments)
     */
    raw(line: string): this {
        this.lines.push(stripCrlf(line));
        return this;
    }

    /**
     * Build the final playlist string
     */
    build(): string {
        return this.lines.join('\n') + '\n';
    }

    /**
     * Get the current lines (for inspection)
     */
    getLines(): readonly string[] {
        return this.lines;
    }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an empty/placeholder HLS playlist.
 * Useful for error responses that need a valid playlist format.
 */
export function createEmptyPlaylist(version: number = DEFAULT_HLS_VERSION): string {
    return new HlsPlaylistBuilder().header().version(version).playlistType('VOD').endlist().build();
}

/**
 * Create a VOD media playlist header.
 * Does not include segments - use addSegments() to add them.
 */
export function createVodPlaylistHeader(options: MediaPlaylistOptions): HlsPlaylistBuilder {
    const builder = new HlsPlaylistBuilder()
        .header()
        .version(options.version ?? DEFAULT_HLS_VERSION)
        .targetDuration(options.targetDuration)
        .playlistType(options.playlistType ?? 'VOD')
        .mediaSequence(options.mediaSequence ?? 0);

    return builder;
}

/**
 * Create an I-frame playlist header.
 * Does not include I-frame entries - add them with segment methods.
 */
export function createIFramePlaylistHeader(options: IFramePlaylistOptions): HlsPlaylistBuilder {
    const builder = new HlsPlaylistBuilder()
        .header()
        .version(options.version ?? IFRAME_HLS_VERSION)
        .targetDuration(options.targetDuration)
        .playlistType(options.playlistType ?? 'VOD')
        .iFramesOnly();

    return builder;
}

/**
 * Create a trickplay image playlist header.
 * Uses Apple's #EXT-X-IMAGES-ONLY extension.
 */
export function createImagePlaylistHeader(targetDuration: number): HlsPlaylistBuilder {
    return new HlsPlaylistBuilder()
        .header()
        .imagesOnly()
        .targetDuration(targetDuration)
        .playlistType('VOD');
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Format a segment filename with zero-padded index.
 *
 * @param index - Segment index
 * @param prefix - Filename prefix (default: 'segment')
 * @param extension - File extension (default: 'm4s')
 * @param padding - Number of digits for zero-padding (default: 5)
 */
export function formatSegmentFilename(
    index: number,
    prefix: string = 'segment',
    extension: string = 'm4s',
    padding: number = 5,
): string {
    return `${prefix}_${String(index).padStart(padding, '0')}.${extension}`;
}

/**
 * Calculate segment duration for a specific segment in a VOD.
 * The last segment may be shorter than the target duration.
 *
 * @param segmentIndex - Index of the segment (0-based)
 * @param totalSegments - Total number of segments
 * @param targetDuration - Target segment duration in seconds
 * @param totalDuration - Total media duration in seconds
 */
export function calculateSegmentDuration(
    segmentIndex: number,
    totalSegments: number,
    targetDuration: number,
    totalDuration: number,
): number {
    if (segmentIndex === totalSegments - 1) {
        // Last segment: calculate remaining duration
        const previousSegmentsDuration = segmentIndex * targetDuration;
        return Math.max(0.001, totalDuration - previousSegmentsDuration);
    }
    return targetDuration;
}

/**
 * Parse segment index from a segment filename.
 *
 * @param filename - Segment filename (e.g., 'segment_00042.m4s')
 * @returns Segment index or null if not parseable
 */
export function parseSegmentIndex(filename: string): number | null {
    const match = filename.match(/_(\d+)\.[^.]+$/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Determine if a file path is an HLS playlist.
 */
export function isPlaylistPath(path: string): boolean {
    return path.endsWith('.m3u8');
}

/**
 * Determine if a file path is an init segment.
 */
export function isInitSegmentPath(path: string): boolean {
    return path.includes('init_') && path.endsWith('.mp4');
}

/**
 * Determine if a file path is a media segment (.m4s or .ts).
 */
export function isMediaSegmentPath(path: string): boolean {
    return path.includes('segment_') && (path.endsWith('.m4s') || path.endsWith('.ts'));
}

/**
 * Get CORS headers for HLS responses
 */
export function getHlsCorsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
    };
}

/**
 * Get cache headers for HLS content.
 *
 * @param type - Type of content
 * @param isVod - Whether this is VOD content (allows longer caching)
 */
export function getHlsCacheHeaders(
    type: 'playlist' | 'init' | 'segment',
    isVod: boolean = false,
): Record<string, string> {
    switch (type) {
        case 'playlist':
            // Playlists should be revalidated frequently for live, cacheable for VOD
            return isVod
                ? { 'Cache-Control': 'public, max-age=3600' }
                : { 'Cache-Control': 'no-cache, no-store, must-revalidate' };
        case 'init':
            // Init segments are immutable
            return { 'Cache-Control': 'public, max-age=31536000, immutable' };
        case 'segment':
            // Media segments are immutable once created
            return { 'Cache-Control': 'public, max-age=31536000, immutable' };
    }
}
