// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle Utilities
 *
 * Centralized logic for subtitle handling including:
 * - Codec detection (PGS, ASS/SSA, VTT, SRT, etc.)
 * - Burn-in requirements
 * - URL building for different subtitle formats
 */

import type { SubtitleStreamInfo } from '$lib/types/playback';

// ============================================================================
// Codec Constants
// ============================================================================

/** PGS/Blu-ray bitmap subtitle codecs */
export const PGS_CODECS = ['pgs', 'pgssub', 'hdmv_pgs_subtitle'];

/** ASS/SSA styled text subtitle codecs */
export const ASS_CODECS = ['ass', 'ssa'];

/** VobSub/DVD subtitle codecs (now renderable client-side via libbitsub) */
export const VOBSUB_CODECS = ['dvdsub', 'vobsub', 'dvd_subtitle'];

/**
 * Bitmap subtitles that require server-side burn-in (no client renderer available).
 *
 * **SINGLE SOURCE OF TRUTH** — all burn-in checks must use this list or the
 * `isBurnInCodec()` / `subtitleRequiresBurnIn()` functions. No other module
 * should define its own burn-in codec list.
 */
export const BURN_IN_CODECS = ['dvbsub', 'dvb_subtitle', 'xsub'];

/** Text-based subtitles that can be converted to VTT */
export const TEXT_CODECS = ['srt', 'subrip', 'vtt', 'webvtt', 'mov_text', 'ttml', 'dfxp'];

/** Canonical family token for capability matching, independent of ffprobe spelling. */
export function normalizeSubtitleCodec(codec: string): string {
    const token = codec.toLowerCase();
    if (PGS_CODECS.includes(token)) return 'pgs';
    if (ASS_CODECS.includes(token)) return 'ass';
    if (VOBSUB_CODECS.includes(token)) return 'vobsub';
    if (token === 'dvb_subtitle') return 'dvbsub';
    if (token === 'webvtt') return 'vtt';
    if (token === 'subrip') return 'srt';
    return token;
}

/** Unknown capability tokens do not change the server's renderer decisions. */
export function supportedSubtitleFormats(formats: Iterable<string>): Set<string> {
    const known = new Set(['vtt', 'srt', 'ass', 'pgs', 'vobsub']);
    return new Set(
        Array.from(formats, normalizeSubtitleCodec).filter((format) => known.has(format)),
    );
}

const SUBTITLE_REFERENCE_HEIGHT = 1080;
const PORTRAIT_MIN_FONT_PX = 22;
const PORTRAIT_MAX_FLOOR_PX = 28;
const PORTRAIT_FONT_VIEWPORT_RATIO = 0.06;

/**
 * Calculate the shared native cue and DOM overlay font size in CSS pixels.
 *
 * Landscape and desktop players follow the rendered-height scale used by native
 * cues. Portrait players also get a width-based readability floor because the
 * movie occupies only a shallow letterboxed strip on a tall phone display.
 */
export function calculateSubtitleOverlayFontSize(
    videoHeight: number,
    viewportWidth: number,
    isPortrait: boolean,
    fontScale: number,
    sizeMultiplier: number,
    srtScale = 140,
): number {
    const safeVideoHeight = Number.isFinite(videoHeight) ? Math.max(0, videoHeight) : 0;
    const safeFontScale = Number.isFinite(fontScale) ? Math.max(0, fontScale) : 1;
    const safeSizeMultiplier = Number.isFinite(sizeMultiplier) ? Math.max(0, sizeMultiplier) : 1;
    const safeSrtScale = Number.isFinite(srtScale) && srtScale > 0 ? srtScale : 140;
    const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
    const scaledSize =
        safeFontScale *
        safeSizeMultiplier *
        28 *
        (safeVideoHeight / SUBTITLE_REFERENCE_HEIGHT) *
        (safeSrtScale / 140);
    const heightScaledSize = Number.isFinite(scaledSize) ? Math.round(scaledSize) : 0;

    if (!isPortrait) return Math.max(16, heightScaledSize);

    const widthBasedFloor = Math.max(
        PORTRAIT_MIN_FONT_PX,
        Math.min(
            PORTRAIT_MAX_FLOOR_PX,
            Math.round(safeViewportWidth * PORTRAIT_FONT_VIEWPORT_RATIO),
        ),
    );
    return Math.max(widthBasedFloor, heightScaledSize);
}

// ============================================================================
// Codec Detection Functions
// ============================================================================

/**
 * Check if subtitle codec is PGS (Blu-ray bitmap format)
 * PGS subtitles are rendered client-side via libpgs
 */
export function isPgsCodec(codec: string | undefined): boolean {
    const codecLower = codec?.toLowerCase() || '';
    return PGS_CODECS.some((c) => codecLower.includes(c));
}

/**
 * Check if subtitle codec is ASS/SSA (styled text format)
 * ASS/SSA subtitles are rendered client-side via AkariSub
 */
export function isAssCodec(codec: string | undefined): boolean {
    const codecLower = codec?.toLowerCase() || '';
    return ASS_CODECS.some((c) => codecLower === c || codecLower.includes(c));
}

/**
 * Check if subtitle codec is VobSub/DVD (bitmap format)
 * VobSub subtitles are now rendered client-side via libbitsub
 */
export function isVobsubCodec(codec: string | undefined): boolean {
    const codecLower = codec?.toLowerCase() || '';
    return VOBSUB_CODECS.some((c) => codecLower.includes(c));
}

/**
 * Check if subtitle codec is a text-based format
 */
export function isTextCodec(codec: string | undefined): boolean {
    const codecLower = codec?.toLowerCase() || '';
    return TEXT_CODECS.some((c) => codecLower.includes(c)) || isAssCodec(codec);
}

/**
 * Check if subtitle codec requires server-side burn-in
 * (bitmap formats without client-side renderer support)
 */
export function isBurnInCodec(codec: string | undefined): boolean {
    const codecLower = codec?.toLowerCase() || '';
    return BURN_IN_CODECS.some((c) => codecLower.includes(c));
}

// ============================================================================
// Subtitle Stream Analysis
// ============================================================================

export type SubtitleRenderMethod = 'native' | 'pgs' | 'ass' | 'vobsub' | 'burn-in' | 'none';

export interface SubtitleAnalysis {
    /** How this subtitle should be rendered */
    renderMethod: SubtitleRenderMethod;
    /** Whether this subtitle requires server-side burn-in during transcoding */
    requiresBurnIn: boolean;
    /** Whether this subtitle can be rendered client-side */
    canRenderClientSide: boolean;
    /** The detected codec category */
    codecType: 'pgs' | 'ass' | 'vobsub' | 'text' | 'bitmap' | 'unknown';
}

/**
 * Analyze a subtitle stream to determine how it should be handled
 */
export function analyzeSubtitleStream(stream: SubtitleStreamInfo | undefined): SubtitleAnalysis {
    if (!stream) {
        return {
            renderMethod: 'none',
            requiresBurnIn: false,
            canRenderClientSide: false,
            codecType: 'unknown',
        };
    }

    const codec = stream.codec?.toLowerCase() || '';
    // A started delivery can encode even a client-capable codec into the video.
    if (stream.deliveryMethod === 'Encode') {
        return {
            renderMethod: 'burn-in',
            requiresBurnIn: true,
            canRenderClientSide: false,
            codecType: 'bitmap',
        };
    }

    // PGS subtitles - render client-side via libbitsub
    if (isPgsCodec(codec)) {
        return {
            renderMethod: 'pgs',
            requiresBurnIn: false,
            canRenderClientSide: true,
            codecType: 'pgs',
        };
    }

    // ASS/SSA subtitles - render client-side via AkariSub
    if (isAssCodec(codec)) {
        return {
            renderMethod: 'ass',
            requiresBurnIn: false,
            canRenderClientSide: true,
            codecType: 'ass',
        };
    }

    // VobSub/DVD subtitles - render client-side via libbitsub
    if (isVobsubCodec(codec)) {
        return {
            renderMethod: 'vobsub',
            requiresBurnIn: false,
            canRenderClientSide: true,
            codecType: 'vobsub',
        };
    }

    // Text subtitles (SRT, VTT, etc.) - render via native video element
    if (isTextCodec(codec) || stream.isTextSubtitleStream) {
        return {
            renderMethod: 'native',
            requiresBurnIn: false,
            canRenderClientSide: true,
            codecType: 'text',
        };
    }

    // Bitmap subtitles that need burn-in (DVB, XSUB, etc.)
    if (isBurnInCodec(codec)) {
        return {
            renderMethod: 'burn-in',
            requiresBurnIn: true,
            canRenderClientSide: false,
            codecType: 'bitmap',
        };
    }

    // Unknown codec - assume text if it supports external stream
    if (stream.supportsExternalStream) {
        return {
            renderMethod: 'native',
            requiresBurnIn: false,
            canRenderClientSide: true,
            codecType: 'text',
        };
    }

    return {
        renderMethod: 'none',
        requiresBurnIn: false,
        canRenderClientSide: false,
        codecType: 'unknown',
    };
}

/**
 * Check if a subtitle stream requires burn-in during transcoding
 * This is used to determine if we need to add subtitle parameters to the HLS URL
 */
export function subtitleRequiresBurnIn(
    streams: SubtitleStreamInfo[] | undefined,
    subtitleIndex: number | null,
): boolean {
    if (subtitleIndex === null || !streams) return false;

    const stream = streams.find((s) => s.index === subtitleIndex);
    if (!stream) return false;

    const analysis = analyzeSubtitleStream(stream);
    return analysis.requiresBurnIn;
}

/**
 * Check if a subtitle index refers to a PGS subtitle
 */
export function isPgsSubtitle(
    streams: SubtitleStreamInfo[] | undefined,
    subtitleIndex: number | null,
): boolean {
    if (subtitleIndex === null || !streams) return false;

    const stream = streams.find((s) => s.index === subtitleIndex);
    return analyzeSubtitleStream(stream).renderMethod === 'pgs';
}

/**
 * Check if a subtitle index refers to an ASS/SSA subtitle
 */
export function isAssSubtitle(
    streams: SubtitleStreamInfo[] | undefined,
    subtitleIndex: number | null,
): boolean {
    if (subtitleIndex === null || !streams) return false;

    const stream = streams.find((s) => s.index === subtitleIndex);
    return analyzeSubtitleStream(stream).renderMethod === 'ass';
}

/**
 * Check if a subtitle index refers to a VobSub/DVD subtitle
 */
export function isVobsubSubtitle(
    streams: SubtitleStreamInfo[] | undefined,
    subtitleIndex: number | null,
): boolean {
    if (subtitleIndex === null || !streams) return false;

    const stream = streams.find((s) => s.index === subtitleIndex);
    return analyzeSubtitleStream(stream).renderMethod === 'vobsub';
}

// ============================================================================
// Subtitle Positioning
// ============================================================================

/**
 * Position VTT subtitle cues above the video controls
 * @param track - The TextTrack to position
 * @param isMobile - Whether the device is mobile (needs more space)
 * @param customPosition - Optional custom position (0-100 percentage from top)
 */
export function positionSubtitleCues(
    track: TextTrack,
    isMobile: boolean,
    customPosition?: number,
): void {
    // Use percentage-based positioning from top
    // Custom position takes precedence, otherwise:
    // Mobile: 70% from top (30% from bottom) - needs more space for touch controls
    // Desktop: 85% from top (15% from bottom) - controls are smaller
    const linePosition = customPosition ?? (isMobile ? 70 : 85);

    // Set line position for existing cues
    if (track.cues) {
        for (let i = 0; i < track.cues.length; i++) {
            const cue = track.cues[i] as VTTCue;
            cue.snapToLines = false; // Use percentage instead of line numbers
            cue.line = linePosition;
        }
    }

    // Note: We don't set oncuechange here anymore because:
    // 1. It captures the linePosition at call time (closure issue)
    // 2. When user changes position dynamically, the old handler would reset it
    // Instead, the VideoPlayer handles dynamic repositioning via reactive statements
}

// ============================================================================
// Subtitle Display Name Formatting
// ============================================================================

/**
 * Get a user-friendly display name for a subtitle stream
 */
export function getSubtitleDisplayName(stream: SubtitleStreamInfo): string {
    if (stream.displayTitle) {
        return stream.displayTitle;
    }

    const parts: string[] = [];

    // Language
    if (stream.language) {
        parts.push(stream.language);
    } else if (stream.languageCode) {
        parts.push(stream.languageCode.toUpperCase());
    }

    // Codec info for special types
    const codec = stream.codec?.toLowerCase() || '';
    if (isPgsCodec(codec)) {
        parts.push('(PGS)');
    } else if (isAssCodec(codec)) {
        parts.push('(ASS)');
    }

    // Forced indicator
    if (stream.isForced) {
        parts.push('[Forced]');
    }

    // Default indicator
    if (stream.isDefault) {
        parts.push('[Default]');
    }

    return parts.join(' ') || `Track ${stream.index}`;
}
