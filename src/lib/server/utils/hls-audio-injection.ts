// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS track types and subtitle codec helpers.
 *
 * Track info is built from the DB / ffprobe (see media-stream-mapper.ts). The
 * former Jellyfin fetchers that lived here had no callers and were removed.
 */

import type { AbsoluteStreamIndex } from '$lib/shared/stream-index';

export interface AudioTrackInfo {
    /**
     * ABSOLUTE ffmpeg stream index (counts video+audio+subtitle), populated from
     * the DB `stream_index` or ffprobe `absoluteIndex`. This is NOT a 0-based
     * audio-relative index. Select by this value with
     * `resolveAudioTrackByAbsoluteIndex()` from `$lib/shared/stream-index`
     * rather than indexing the array directly.
     *
     * BRANDED on purpose. `AudioStreamInfo` — whose `index` is audio-relative —
     * is otherwise a structural superset of this type, so a plain
     * `audioRows.map(dbRowToAudioStreamInfo)` used to land here with no cast and
     * no error, quietly putting a relative index on the absolute-index path.
     * The brand makes that a compile error. Build these with
     * `dbRowToAudioTrackInfo`, or tag a known-absolute number with
     * `asAbsoluteStreamIndex()`.
     */
    index: AbsoluteStreamIndex;
    displayTitle: string;
    language?: string;
    channels: number;
    codec: string;
    bitrate?: number; // Source bitrate in bps (e.g., 768000 for 768 kbps)
    isDefault: boolean;
}

export interface SubtitleTrackInfo {
    index: number;
    displayTitle: string;
    language?: string;
    codec: string;
    isDefault: boolean;
    isForced: boolean;
    /** Whether the subtitle is text-based (can be converted to WebVTT) */
    isTextBased: boolean;
}

/**
 * Text-based subtitle codecs that can be converted to WebVTT.
 * Uses an allowlist approach for safety - only known text formats are supported.
 */
const TEXT_BASED_SUBTITLE_CODECS = new Set([
    // Primary formats
    'srt', // SubRip
    'subrip', // SubRip (alternative name)
    'ass', // Advanced SubStation Alpha
    'ssa', // SubStation Alpha
    'webvtt', // WebVTT
    'vtt', // WebVTT (short name)

    // Additional text formats supported by FFmpeg
    'sami', // SAMI
    'microdvd', // MicroDVD
    'jacosub', // JACOsub
    'mpl2', // MPL2
    'pjs', // PJS (Phoenix Japanimation Society)
    'realtext', // RealText
    'subviewer', // SubViewer
    'subviewer1', // SubViewer v1
    'vplayer', // VPlayer
    'stl', // Spruce subtitle format (text variant)
    'mov_text', // MP4 timed text
    'text', // Generic text subtitle (FFmpeg internal)
]);

/**
 * Check if a subtitle codec is text-based (can be converted to WebVTT).
 *
 * Uses an ALLOWLIST approach - only known text-based formats return true.
 * Image-based formats (PGS, VobSub, DVB, etc.) are rejected by default.
 *
 * @param codec - Subtitle codec name from Jellyfin/FFmpeg
 * @returns true if codec is in the allowlist, false otherwise
 */
export function isTextBasedSubtitle(codec: string | undefined): boolean {
    if (!codec) return false; // Unknown codec - reject for safety
    const codecLower = codec.toLowerCase();
    return TEXT_BASED_SUBTITLE_CODECS.has(codecLower);
}
