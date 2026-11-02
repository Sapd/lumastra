// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Stream Mapper
 *
 * Maps between Jellyfin MediaStream objects, database rows, and application types.
 * Centralizes the mapping logic previously duplicated across playback.service.ts,
 * hls-lumastra, and hls-audio-injection.
 */

import type {
    MediaStreamInsert,
    MediaStreamRow,
} from '../database/queries/media-streams.queries.js';
import type { AudioStreamInfo, VideoStreamInfo } from '$lib/schemas/playback-types.js';
import type { AudioTrackInfo } from './hls-audio-injection.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { deriveBitDepthFromPixelFormat, normalizeColorTag } from './ffprobe.js';
import type { VideoStreamInfo as FFprobeVideoStreamInfo, MediaProbeResult } from './ffprobe.js';

// ============================================================================
// Raw Jellyfin stream shape (superset of JellyfinMediaStream)
// Used when parsing raw API responses from Jellyfin library scans
// ============================================================================

export interface RawJellyfinStream {
    Index: number;
    Type: string;
    Codec?: string;
    CodecTag?: string;
    Profile?: string;
    Level?: number;
    Language?: string;
    DisplayTitle?: string;
    Title?: string;
    Channels?: number;
    ChannelLayout?: string;
    BitRate?: number;
    SampleRate?: number;
    Width?: number;
    Height?: number;
    BitDepth?: number;
    VideoRange?: string;
    VideoRangeType?: string;
    ColorSpace?: string;
    ColorPrimaries?: string;
    ColorTransfer?: string;
    PixelFormat?: string;
    RefFrames?: number;
    AspectRatio?: string;
    AverageFrameRate?: number;
    IsAnamorphic?: boolean;
    IsExternal?: boolean;
    IsTextSubtitleStream?: boolean;
    IsDefault?: boolean;
    IsForced?: boolean;
}

// ============================================================================
// Jellyfin → DB row mapping
// ============================================================================

/**
 * Map an array of raw Jellyfin MediaStream objects to DB insert rows.
 * Filters to audio/video/subtitle types only (skips 'Data', 'EmbeddedImage', etc.).
 */
export function mapJellyfinStreamsToDbRows(
    mediaItemId: string,
    jellyfinStreams: RawJellyfinStream[],
): Omit<MediaStreamInsert, 'file_id'>[] {
    const rows: Omit<MediaStreamInsert, 'file_id'>[] = [];

    for (const s of jellyfinStreams) {
        const type = s.Type?.toLowerCase();
        if (type !== 'audio' && type !== 'video' && type !== 'subtitle') {
            continue;
        }

        rows.push({
            stream_type: type as 'audio' | 'video' | 'subtitle',
            stream_index: s.Index ?? 0,
            codec: s.Codec || 'unknown',
            codec_tag: s.CodecTag ?? null,
            profile: s.Profile ?? null,
            level: s.Level ?? null,
            language: s.Language ?? null,
            display_title: s.DisplayTitle ?? null,
            title: s.Title ?? null,
            channels: s.Channels ?? null,
            channel_layout: s.ChannelLayout ?? null,
            sample_rate: s.SampleRate ?? null,
            width: s.Width ?? null,
            height: s.Height ?? null,
            // Jellyfin omits BitDepth for some containers/streams while still
            // reporting PixelFormat. Derive rather than store NULL: a NULL depth
            // makes a GPU decode-capability lesson un-keyable (see
            // markSourceNotHardwareDecodable) and hides Hi10P from the admin UI.
            bit_depth: s.BitDepth ?? deriveBitDepthFromPixelFormat(s.PixelFormat) ?? null,
            video_range: s.VideoRange ?? null,
            video_range_type: s.VideoRangeType ?? null,
            color_space: normalizeColorTag(s.ColorSpace),
            color_primaries: normalizeColorTag(s.ColorPrimaries),
            color_transfer: normalizeColorTag(s.ColorTransfer),
            pixel_format: s.PixelFormat ?? null,
            ref_frames: typeof s.RefFrames === 'number' && s.RefFrames > 0 ? s.RefFrames : null,
            aspect_ratio: s.AspectRatio ?? null,
            average_frame_rate: s.AverageFrameRate ?? null,
            is_anamorphic: s.IsAnamorphic ?? null,
            is_external: s.IsExternal ?? null,
            is_text_subtitle: s.IsTextSubtitleStream ?? null,
            bitrate: s.BitRate ?? null,
            is_default: s.IsDefault || false,
            is_forced: s.IsForced || false,
        });
    }

    return rows;
}

// ============================================================================
// DB row → application type mapping
// ============================================================================

/**
 * Convert a DB audio stream row to the application `AudioStreamInfo` type.
 *
 * ## Two index conventions, and why the caller supplies one of them
 *
 * `AudioStreamInfo` carries BOTH: `index` is 0-based AUDIO-RELATIVE (the
 * display / `-map 0:a:N` value the player uses) and `absoluteIndex` is the raw
 * ffmpeg stream index (the canonical value for selecting a track on the wire).
 * A single DB row only knows the absolute one — `stream_index` — so the
 * relative ordinal has to come from the caller's position in the audio-only
 * row list.
 *
 * `audioRelativeIndex` is REQUIRED rather than derived or defaulted on purpose:
 * a caller that has not thought about which convention it holds should not
 * compile. Pass the array index from a list of audio rows ordered by
 * `stream_index` — both feeder queries (`getStreamsForFile`,
 * `getStreamsForMediaItem`, `getAudioStreamsForMediaItem`) already
 * `ORDER BY ... stream_index`, which is exactly the order `-map 0:a:N` counts in.
 *
 * If you need the transcoding pipeline's `AudioTrackInfo` instead — whose
 * `.index` is ABSOLUTE — use `dbRowToAudioTrackInfo` below. Do not hand an
 * `AudioStreamInfo` to a consumer expecting `AudioTrackInfo`; see that
 * function's note on why the compiler will not stop you.
 */
export function dbRowToAudioStreamInfo(
    row: MediaStreamRow,
    audioRelativeIndex: number,
): AudioStreamInfo {
    return {
        index: audioRelativeIndex,
        absoluteIndex: row.stream_index,
        codec: row.codec,
        codecTag: row.codec_tag ?? undefined,
        language: row.language ?? undefined,
        languageCode: row.language ?? undefined,
        displayTitle: row.display_title || row.title || `Audio ${row.stream_index}`,
        title: row.title ?? undefined,
        channels: row.channels ?? 2,
        channelLayout: row.channel_layout ?? undefined,
        bitrate: row.bitrate ?? undefined,
        sampleRate: row.sample_rate ?? undefined,
        isDefault: row.is_default,
        isForced: row.is_forced,
    };
}

/**
 * Convert a DB audio stream row to the transcoding pipeline's `AudioTrackInfo`.
 *
 * ## Why this exists as its own function
 *
 * `AudioTrackInfo.index` is the ABSOLUTE ffmpeg stream index — the exact
 * opposite convention from `AudioStreamInfo.index` above, which is
 * audio-relative. The pipeline needs absolute because that is what arrives on
 * the wire (`hlsAudioTrackIndex`, Jellyfin's `AudioStreamIndex`) and what
 * `resolveAudioTrackByAbsoluteIndex` matches on.
 *
 * ## The trap this closes, and the one it does not
 *
 * `AudioStreamInfo` is a structural SUPERSET of `AudioTrackInfo`, so
 * TypeScript happily accepts one where the other is expected — for a long time
 * `media-probe.service.ts` built its `AudioTrackInfo[]` by mapping
 * `dbRowToAudioStreamInfo` directly, with no cast and no error. That is why
 * the mismatched `index` convention stayed invisible: nothing at the boundary
 * had an opinion.
 *
 * Giving each type its own producer removes the REASON to write the bad
 * assignment. It does not make it illegal — assigning an `AudioStreamInfo`
 * value to an `AudioTrackInfo` still type-checks today. Branding
 * `AudioTrackInfo.index` as `AbsoluteStreamIndex` is what would close that
 * hole for good.
 */
export function dbRowToAudioTrackInfo(row: MediaStreamRow): AudioTrackInfo {
    return {
        // `media_streams.stream_index` is the raw ffprobe index — absolute by
        // definition, so this is a tag rather than a conversion.
        index: asAbsoluteStreamIndex(row.stream_index),
        displayTitle: row.display_title || row.title || `Audio ${row.stream_index}`,
        language: row.language ?? undefined,
        channels: row.channels ?? 2,
        codec: row.codec,
        bitrate: row.bitrate ?? undefined,
        isDefault: row.is_default,
    };
}

/**
 * Convert a DB video stream row to the application VideoStreamInfo type.
 * Used for DB-first video info in preview session / hls-lumastra.
 */
export function dbRowToVideoStreamInfo(row: MediaStreamRow): VideoStreamInfo {
    return {
        index: row.stream_index,
        codec: row.codec,
        codecTag: row.codec_tag ?? undefined,
        profile: row.profile ?? undefined,
        level: row.level ?? undefined,
        width: row.width || 0,
        height: row.height || 0,
        bitrate: row.bitrate ?? undefined,
        // Rows written before bit_depth was populated (and any provider that
        // never reported it) still carry pixel_format — derive so every consumer
        // sees the real depth instead of "unknown". Mirrors media-probe.service.
        bitDepth: row.bit_depth ?? deriveBitDepthFromPixelFormat(row.pixel_format),
        videoRange: row.video_range || 'SDR',
        videoRangeType: row.video_range_type ?? undefined,
        colorSpace: row.color_space ?? undefined,
        aspectRatio: row.aspect_ratio ?? undefined,
        averageFrameRate: row.average_frame_rate ?? undefined,
        isDefault: row.is_default,
        isAnamorphic: row.is_anamorphic ?? undefined,
    };
}

// ============================================================================
// FFprobe → DB row mapping
// ============================================================================

const TEXT_SUBTITLE_CODECS = new Set([
    'subrip',
    'srt',
    'ass',
    'ssa',
    'webvtt',
    'vtt',
    'mov_text',
    'ttml',
    'dfxp',
    'sami',
    'microdvd',
    'text',
]);

export function isTextCodec(codec: string): boolean {
    return TEXT_SUBTITLE_CODECS.has(codec.toLowerCase());
}

/** Map HDR enum from FFprobe to Jellyfin-style COARSE video_range string */
function mapHdrToVideoRange(hdr: FFprobeVideoStreamInfo['hdr']): string | null {
    switch (hdr) {
        case 'hdr10':
            return 'HDR10';
        case 'hdr10plus':
            return 'HDR10';
        case 'hlg':
            return 'HLG';
        case 'dovi':
            return 'Dolby Vision';
        case 'dovi_hdr10':
            return 'DOVIWithHDR10';
        case 'sdr':
            return 'SDR';
        default:
            return null;
    }
}

/**
 * Map FFprobe's HDR enum → Jellyfin-vocabulary `video_range_type` (the FINE
 * classification, one vocabulary in the column). Unlike `mapHdrToVideoRange`
 * this preserves the HDR10+ distinction, which is what the media_item_quality
 * `hdr_type` projection (and the API videoRange badge) keys off. detectHdr()
 * already computes this — persisting it here is the local-scan half of the fix.
 */
function mapHdrToVideoRangeType(hdr: FFprobeVideoStreamInfo['hdr']): string | null {
    switch (hdr) {
        case 'hdr10':
            return 'HDR10';
        case 'hdr10plus':
            return 'HDR10Plus';
        case 'hlg':
            return 'HLG';
        case 'dovi':
            return 'DOVI';
        case 'dovi_hdr10':
            return 'DOVIWithHDR10';
        case 'sdr':
            return 'SDR';
        default:
            return null;
    }
}

/**
 * Map an FFprobe MediaProbeResult to DB insert rows for media_streams.
 * Counterpart to mapJellyfinStreamsToDbRows() — used when probing files directly.
 */
export function mapFFprobeToDbRows(fileId: string, probe: MediaProbeResult): MediaStreamInsert[] {
    const rows: MediaStreamInsert[] = [];

    // Video stream
    if (probe.video) {
        const v = probe.video;
        rows.push({
            file_id: fileId,
            stream_type: 'video',
            stream_index: v.index,
            codec: v.codec,
            profile: v.profile ?? null,
            level: v.level ?? null,
            width: v.width,
            height: v.height,
            // Persist depth so decode-capability keying (h264 vs h264@10bit)
            // works from the DB fast path without re-probing the file.
            bit_depth: deriveBitDepthFromPixelFormat(v.pixelFormat) ?? null,
            bitrate: v.bitrate,
            average_frame_rate: v.fps ?? null,
            video_range: mapHdrToVideoRange(v.hdr),
            video_range_type: mapHdrToVideoRangeType(v.hdr),
            color_space: v.colorSpace,
            is_default: true,
            is_forced: false,
            dv_profile: v.dvProfile ?? null,
            dv_level: v.dvLevel ?? null,
            dv_bl_signal_compatibility_id: v.dvBlSignalCompatibilityId ?? null,
            master_display: v.masterDisplay ?? null,
            max_cll: v.maxCll ?? null,
            pixel_format: v.pixelFormat ?? null,
            ref_frames: v.refFrames ?? null,
            color_primaries: v.colorPrimaries ?? null,
            color_transfer: v.colorTransfer ?? null,
            has_closed_captions: v.closedCaptions,
        });
    }

    // Audio streams
    for (const a of probe.audioStreams) {
        rows.push({
            file_id: fileId,
            stream_type: 'audio',
            stream_index: a.absoluteIndex,
            codec: a.codec,
            profile: a.profile ?? null,
            language: a.language ?? null,
            title: a.title ?? null,
            display_title: a.title ?? a.language ?? `Audio ${a.absoluteIndex}`,
            channels: a.channels,
            channel_layout: a.channelLayout ?? null,
            sample_rate: a.sampleRate ?? null,
            bitrate: a.bitRate ?? null,
            is_default: a.isDefault,
            is_forced: false,
            is_visual_impaired: a.isVisualImpaired,
        });
    }

    // Subtitle streams
    for (const s of probe.subtitleStreams) {
        rows.push({
            file_id: fileId,
            stream_type: 'subtitle',
            stream_index: s.index,
            codec: s.codec,
            language: s.language ?? null,
            title: s.title ?? null,
            display_title: s.title ?? s.language ?? `Subtitle ${s.index}`,
            is_default: s.isDefault,
            is_forced: s.isForced,
            is_text_subtitle: isTextCodec(s.codec),
            is_external: false,
            is_hearing_impaired: s.isHearingImpaired,
        });
    }

    return rows;
}
