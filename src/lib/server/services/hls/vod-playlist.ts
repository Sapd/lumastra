// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withHlsParams } from '../../utils/hls-uri.js';

import * as fs from 'fs/promises';
import * as path from 'path';

import { Logger } from '../../utils/logger.js';
import { createVodPlaylistHeader, HlsPlaylistBuilder } from '../../utils/hls-definitions.js';
import type { GopGrid } from './gop-grid.js';

const logger = Logger.for('HlsVodPlaylist');
import {
    isDistinctStreamDuration,
    resolveEffectiveStreamDuration,
} from '../../utils/hls-stream-duration.js';
import { uniformSegmentCount, uniformSegmentDuration } from '../../utils/hls-segment-grid.js';

/**
 * VOD manifest information for generating HLS playlists.
 * Used by both generateCompleteVodManifest and generateFullVodManifest.
 */
export interface VodManifestInfo {
    totalDurationSeconds: number;
    segmentDurationSeconds: number;
    totalSegments: number;
    isComplete: boolean;
    /** Current segment offset (FFmpeg segment 0 = VOD segment segmentOffset) */
    segmentOffset?: number;
    /** Exact FFmpeg start time for the current generation, if known */
    startTimeSeconds?: number;
    /**
     * Pre-computed segment durations from keyframe data for copy/remux video.
     * When present, VOD playlist uses these instead of synthetic uniform durations.
     */
    keyframeSegmentDurations?: number[];
    /**
     * Keyframe segment index that covers the FFmpeg start time.
     * Used as streamOffset when keyframeSegmentDurations is present,
     * because keyframe segments diverge from uniform segment numbering.
     */
    keyframeStreamOffset?: number;
    /**
     * Lower bound for TARGETDURATION, known before FFmpeg writes anything (the
     * longest planned copy-mode keyframe segment). Keeps the declared value
     * stable across refetches instead of jumping once a long GOP is produced.
     */
    minTargetDurationSeconds?: number;
}

/** Parsed segment info from FFmpeg's actual manifest output */
export interface FFmpegSegmentInfo {
    duration: number;
    programDateTime?: string;
}

/** Parsed FFmpeg manifest data including per-stream target duration */
export interface FFmpegManifestData {
    segments: FFmpegSegmentInfo[];
    /** EXT-X-TARGETDURATION from this stream's manifest (varies per rendition) */
    targetDuration?: number;
}

/**
 * Rewrite segment URLs in media playlist to include query parameters.
 *
 * FFmpeg generates:
 *   init_0.mp4
 *   segment_00000.m4s
 *
 * We keep paths relative but ensure the client's fetch includes required params.
 * HLS clients resolve paths but do not inherit the parent URL's query.
 */
export function rewriteMediaPlaylist(
    content: string,
    params: URLSearchParams,
    origin?: string,
): string {
    const withParams = (uri: string): string => withHlsParams(uri, params, origin);
    return content
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) {
                return line.replace(
                    /URI="([^"]+)"/g,
                    (_match: string, uri: string) => `URI="${withParams(uri)}"`,
                );
            }
            return trimmed ? withParams(trimmed) : line;
        })
        .join('\n');
}

/**
 * Parse FFmpeg's manifest to extract actual segment durations, PROGRAM-DATE-TIME,
 * and the stream's TARGETDURATION. Video streams in remux mode have different
 * target durations (~10s) than audio streams (~6s) because FFmpeg can only split
 * video on existing keyframes.
 */
export function parseFFmpegManifest(manifest: string): FFmpegManifestData {
    const segments: FFmpegSegmentInfo[] = [];
    const lines = manifest.split('\n');
    let targetDuration: number | undefined;

    let pendingPDT: string | undefined;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXT-X-TARGETDURATION:')) {
            const val = parseInt(trimmed.slice('#EXT-X-TARGETDURATION:'.length), 10);
            if (!isNaN(val)) {
                targetDuration = val;
            }
        } else if (trimmed.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
            pendingPDT = trimmed.slice('#EXT-X-PROGRAM-DATE-TIME:'.length);
        } else if (trimmed.startsWith('#EXTINF:')) {
            const durationStr = trimmed.slice('#EXTINF:'.length).split(',')[0];
            const duration = parseFloat(durationStr);
            if (!isNaN(duration)) {
                segments.push({
                    duration,
                    programDateTime: pendingPDT,
                });
            }
            pendingPDT = undefined;
        } else if (!trimmed.startsWith('#') && trimmed.length > 0) {
            pendingPDT = undefined;
        }
    }
    return { segments, targetDuration };
}

function buildVodManifestContent(
    initSegmentUri: string,
    vodInfo: VodManifestInfo,
    params: URLSearchParams,
    startSegment: number = 0,
    ffmpegData?: FFmpegManifestData,
): string {
    const streamSegmentDuration = resolveEffectiveStreamDuration(
        vodInfo.segmentDurationSeconds,
        ffmpegData?.targetDuration,
        ffmpegData?.segments,
    );
    const hasDistinctStreamDuration = isDistinctStreamDuration(
        streamSegmentDuration,
        vodInfo.segmentDurationSeconds,
    );
    const kfDurations =
        vodInfo.keyframeSegmentDurations && vodInfo.keyframeSegmentDurations.length > 0
            ? vodInfo.keyframeSegmentDurations
            : undefined;

    const streamTotalSegments = kfDurations
        ? kfDurations.length
        : hasDistinctStreamDuration
          ? uniformSegmentCount(vodInfo.totalDurationSeconds, streamSegmentDuration)
          : vodInfo.totalSegments;

    const startTimeSeconds =
        vodInfo.startTimeSeconds ?? (vodInfo.segmentOffset ?? 0) * vodInfo.segmentDurationSeconds;

    let streamOffset: number;
    if (kfDurations) {
        // Use keyframe-space offset — keyframe segments diverge from uniform
        // numbering at high indices (e.g. uniform 1097 vs keyframe 1051 at ~10970s)
        streamOffset =
            vodInfo.keyframeStreamOffset ??
            Math.floor(startTimeSeconds / vodInfo.segmentDurationSeconds);
    } else if (hasDistinctStreamDuration) {
        streamOffset = Math.floor(startTimeSeconds / streamSegmentDuration);
    } else {
        streamOffset = Math.floor(startTimeSeconds / vodInfo.segmentDurationSeconds);
    }

    const keyframeTargetDuration = kfDurations
        ? kfDurations.reduce(
              (max, duration) =>
                  Number.isFinite(duration) && duration > 0 ? Math.max(max, duration) : max,
              0,
          )
        : undefined;
    const baseTargetDuration = Math.max(
        keyframeTargetDuration && keyframeTargetDuration > 0
            ? Math.ceil(keyframeTargetDuration)
            : streamSegmentDuration,
        Number.isFinite(vodInfo.minTargetDurationSeconds)
            ? Math.ceil(vodInfo.minTargetDurationSeconds ?? 0)
            : 0,
    );

    const ffmpegSegments = ffmpegData?.segments;

    // Synthetic PROGRAM-DATE-TIME for every segment.
    // Safari/AVPlayer syncs demuxed audio and video by PDT, not segment number.
    // Without PDT on all segments, AVPlayer falls back to segment-number matching
    // which breaks when audio (uniform ~10s) and video (keyframe ~10.4s) playlists
    // have different segment counts and durations.
    const PDT_EPOCH = new Date('2026-01-01T00:00:00.000Z').getTime();
    let cumulativeSeconds = 0;

    // DEBUG: measure cumulative EXTINF drift at the stream offset.
    // Safari native HLS derives video.currentTime from EXTINF sums, not fMP4
    // tfdt. If the sum at streamOffset doesn't match the actual start PTS,
    // video.currentTime will be offset from real content → subtitle desync.
    if (kfDurations && streamOffset > 0 && startTimeSeconds > 0) {
        let kfCumulativeAtOffset = 0;
        for (let i = 0; i < streamOffset && i < kfDurations.length; i++) {
            kfCumulativeAtOffset +=
                Number.isFinite(kfDurations[i]) && kfDurations[i] > 0
                    ? kfDurations[i]
                    : vodInfo.segmentDurationSeconds;
        }
        const drift = kfCumulativeAtOffset - startTimeSeconds;
        logger.info('[VOD TIMELINE DEBUG] EXTINF cumulative vs actual start', {
            streamOffset,
            kfCumulativeAtOffset: kfCumulativeAtOffset.toFixed(3),
            actualStartTime: startTimeSeconds.toFixed(3),
            drift: drift.toFixed(3),
            kfDurationsLength: kfDurations.length,
            totalSegments: streamTotalSegments,
            hasFFmpegData: !!ffmpegData?.segments?.length,
        });
    }

    const entries: { duration: number; uri: string; programDateTime: Date }[] = [];
    for (let i = startSegment; i < streamTotalSegments; i++) {
        const ffmpegIndex = i - streamOffset;
        const hasRealData =
            ffmpegSegments && ffmpegIndex >= 0 && ffmpegIndex < ffmpegSegments.length;

        let segmentDuration: number;
        if (hasRealData) {
            segmentDuration = ffmpegSegments[ffmpegIndex].duration;
        } else if (
            kfDurations &&
            i >= streamOffset &&
            i < kfDurations.length &&
            Number.isFinite(kfDurations[i]) &&
            kfDurations[i] > 0
        ) {
            segmentDuration = kfDurations[i];
        } else if (!kfDurations) {
            // The uniform grid, whose last entry absorbs a sub-HLS_TAIL_MERGE_SECONDS
            // remainder (see hls-segment-grid.ts).
            segmentDuration = uniformSegmentDuration(
                i,
                vodInfo.totalDurationSeconds,
                streamSegmentDuration,
            );
        } else {
            const isLastSegment = i === streamTotalSegments - 1;
            const remainingDuration = vodInfo.totalDurationSeconds - i * streamSegmentDuration;
            segmentDuration = isLastSegment
                ? Math.max(0.001, Math.min(remainingDuration, streamSegmentDuration))
                : streamSegmentDuration;
        }

        // Always use synthetic PDT derived from cumulative EXTINF durations.
        // Mixing FFmpeg's real PDT with synthetic would create discontinuities.
        const segmentName = `segment_${i.toString().padStart(5, '0')}.m4s`;
        entries.push({
            duration: segmentDuration,
            uri: withHlsParams(segmentName, params),
            programDateTime: new Date(PDT_EPOCH + cumulativeSeconds * 1000),
        });
        cumulativeSeconds += segmentDuration;
    }

    // TARGETDURATION must cover every EXTINF (RFC 8216 §4.3.3.1: each duration,
    // rounded to the nearest integer, ≤ TARGETDURATION). The base value is the
    // uniform grid, but produced segments carry FFmpeg's REAL copy-mode durations
    // — one long GOP makes a 17–22 s segment under a declared 10, and AVPlayer
    // rejects the whole media playlist (CoreMedia -12642 "Playlist parse error"),
    // leaving the video rendition unplayable.
    const targetDuration = entries.reduce(
        (max, entry) => Math.max(max, Math.round(entry.duration)),
        baseTargetDuration,
    );

    const builder = createVodPlaylistHeader({
        targetDuration,
        playlistType: 'VOD',
        mediaSequence: startSegment,
    });

    const initUri = withHlsParams(initSegmentUri, params);
    builder.mapUri(initUri);
    builder.blank();
    for (const entry of entries) {
        builder.programDateTime(entry.programDateTime);
        builder.segment(entry.duration, entry.uri);
    }

    return builder.endlist().build();
}

/**
 * The init segment FFmpeg will write for a given stream directory.
 *
 * FFmpeg names the init to match its stream: `stream_3/init_3.mp4`. The VOD
 * manifest has to name that file even when it is not on disk YET — the playlist
 * is served the moment the client asks, which for a slow first segment (subtitle
 * burn-in re-encodes video, so its first init takes seconds) is well before
 * FFmpeg has written anything.
 *
 * Guessing `init_0.mp4` there is only ever right for stream_0. On any other
 * stream the client caches a VOD playlist pointing at a file that will never
 * exist and 404s forever — and the failure is silent: AVPlayer keeps downloading
 * media segments happily, but with no moov it never configures a decoder, so
 * there is no error callback, just a permanent spinner.
 *
 * Falls back to `init_0.mp4` for a directory that is not `stream_<N>` (muxed
 * mode writes its init at the session root).
 */
export function initSegmentNameForStreamDir(streamDir: string): string {
    const match = /^stream_(\d+)$/.exec(path.basename(streamDir));
    return match ? `init_${match[1]}.mp4` : 'init_0.mp4';
}

/**
 * Generate a complete VOD manifest from an existing FFmpeg manifest.
 * Parses the FFmpeg manifest to extract init segment info.
 */
export function generateCompleteVodManifest(
    ffmpegManifest: string,
    vodInfo: VodManifestInfo,
    params: URLSearchParams,
    startSegment: number = 0,
    fallbackInitUri: string = 'init_0.mp4',
): string {
    let initSegmentUri = fallbackInitUri;
    const initMatch = ffmpegManifest.match(/#EXT-X-MAP:URI="([^"]+)"/);
    if (initMatch) {
        initSegmentUri = initMatch[1];
    }

    const ffmpegData = ffmpegManifest ? parseFFmpegManifest(ffmpegManifest) : undefined;

    return buildVodManifestContent(initSegmentUri, vodInfo, params, startSegment, ffmpegData);
}

/**
 * GOP-mode media playlist (services/hls/gop-grid.ts): every keyframe-grid entry
 * with its exact duration, the same for audio and video renditions, so both
 * declare identical counts and times and every entry starts where it says.
 * Independent of what has been produced: the assembler writes exactly these
 * entries, in every generation.
 */
export function buildGopGridManifest(
    grid: Pick<GopGrid, 'durations' | 'count'>,
    initSegmentUri: string,
    params: URLSearchParams,
): string {
    const PDT_EPOCH = new Date('2026-01-01T00:00:00.000Z').getTime();
    const targetDuration = grid.durations.reduce((max, d) => Math.max(max, Math.round(d)), 1);
    const builder = createVodPlaylistHeader({
        targetDuration,
        playlistType: 'VOD',
        mediaSequence: 0,
    });
    builder.mapUri(withHlsParams(initSegmentUri, params));
    builder.blank();
    let cumulative = 0;
    for (let i = 0; i < grid.count; i++) {
        const name = `segment_${i.toString().padStart(5, '0')}.m4s`;
        builder.programDateTime(new Date(PDT_EPOCH + cumulative * 1000));
        builder.segment(grid.durations[i], withHlsParams(name, params));
        cumulative += grid.durations[i];
    }
    return builder.endlist().build();
}

/**
 * Add VOD markers to media playlist when transcode is complete.
 */
export function addVodMarkers(content: string): string {
    let result = content.replace(/#EXT-X-PLAYLIST-TYPE:EVENT/g, '#EXT-X-PLAYLIST-TYPE:VOD');

    if (!result.includes('#EXT-X-ENDLIST')) {
        result = result.trimEnd() + '\n#EXT-X-ENDLIST\n';
    }

    return result;
}

/**
 * Generate a full VOD manifest by reading the stream directory.
 * Finds init segment from filesystem.
 */
export async function generateFullVodManifest(
    streamDir: string,
    vodInfo: VodManifestInfo,
    params: URLSearchParams,
    startSegment: number = 0,
): Promise<string> {
    // Derive the fallback from the stream directory rather than guessing
    // `init_0.mp4`: FFmpeg names its init `init_<N>.mp4` to match `stream_<N>`,
    // so the guess is only ever right for stream_0.
    let initSegmentUri = initSegmentNameForStreamDir(streamDir);
    let ffmpegData: FFmpegManifestData | undefined;
    try {
        const files = await fs.readdir(streamDir);
        const initFile = files.find((f) => f.startsWith('init_') && f.endsWith('.mp4'));
        if (initFile) {
            initSegmentUri = initFile;
        }

        const manifestFile = files.find((f) => f.endsWith('.m3u8'));
        if (manifestFile) {
            const manifest = await fs.readFile(path.join(streamDir, manifestFile), 'utf-8');
            ffmpegData = parseFFmpegManifest(manifest);
        }
    } catch {
        // Use defaults while FFmpeg is still creating the stream directory.
    }

    return buildVodManifestContent(initSegmentUri, vodInfo, params, startSegment, ffmpegData);
}

/**
 * Options for generating a pre-generated VOD playlist.
 * Used by the /j/ master.m3u8 endpoint to create a complete playlist
 * with all segments listed upfront (Jellyfin-style VOD behavior).
 */
export interface VodPlaylistOptions {
    /** Item ID for segment URLs */
    itemId: string;
    /** Total runtime in seconds */
    runtimeSeconds: number;
    /** Segment duration in seconds (default: FFMPEG_SEGMENT_DURATION) */
    segmentDuration: number;
    /** Play session ID for segment URLs */
    playSessionId: string;
    /** API key for auth in segment URLs (optional) */
    apiKey?: string;
}

/**
 * Generate a pre-generated VOD playlist with all segments listed upfront.
 *
 * Security fix C23 (2026-09-16): this used to build segment lines with
 * manual string concatenation, reflecting `playSessionId`/`apiKey` verbatim
 * into every line — a value carrying a raw CR/LF could inject arbitrary HLS
 * tags (e.g. a forged `#EXT-X-ENDLIST`) into the requester's own manifest.
 * `buildVodManifestContent` (above, same file) already builds through
 * `HlsPlaylistBuilder.segment()`, which strips CR/LF from the URI — this is
 * the collapse onto that one escaped builder instead of a second,
 * hand-rolled one. `URLSearchParams` also percent-encodes the values as
 * defense in depth beyond the CRLF strip.
 */
export function generateVodPlaylist(options: VodPlaylistOptions): string {
    const { itemId, playSessionId, apiKey } = options;

    const segmentDuration =
        Number.isFinite(options.segmentDuration) && options.segmentDuration > 0
            ? options.segmentDuration
            : 6;

    const MAX_RUNTIME_SECONDS = 86400;
    let runtimeSeconds = options.runtimeSeconds;
    if (!Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0) {
        return new HlsPlaylistBuilder()
            .header()
            .version(3)
            .targetDuration(1)
            .mediaSequence(0)
            .playlistType('VOD')
            .endlist()
            .build();
    }
    runtimeSeconds = Math.min(runtimeSeconds, MAX_RUNTIME_SECONDS);

    const totalSegments = uniformSegmentCount(runtimeSeconds, segmentDuration);
    const padWidth = Math.max(5, String(totalSegments - 1).length);

    const builder = new HlsPlaylistBuilder()
        .header()
        .version(3)
        .targetDuration(Math.ceil(segmentDuration) + 1)
        .mediaSequence(0)
        .playlistType('VOD');

    for (let i = 0; i < totalSegments; i++) {
        const segStart = i * segmentDuration;
        const segDuration = uniformSegmentDuration(i, runtimeSeconds, segmentDuration);
        const runtimeTicks = Math.round(segStart * 10_000_000);
        const segmentName = `segment_${i.toString().padStart(padWidth, '0')}.ts`;

        const params = new URLSearchParams({
            PlaySessionId: playSessionId,
            runtimeTicks: String(runtimeTicks),
        });
        if (apiKey) params.set('api_key', apiKey);

        builder.segment(segDuration, `/j/Videos/${itemId}/hls/${segmentName}?${params.toString()}`);
    }

    return builder.endlist().build();
}
