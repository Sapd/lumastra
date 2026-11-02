// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Probe Service
 *
 * Shared probe logic for HLS transcoding routes.
 * Resolves stream metadata (audio tracks, video codec, dimensions, duration)
 * from the DB cache first, falling back to FFprobe when no cached streams exist.
 */

import type postgres from 'postgres';
import {
    type AudioTrackInfo,
    type SubtitleTrackInfo,
    isTextBasedSubtitle,
} from '$lib/server/utils/hls-audio-injection.js';
import { type MediaStreamInfo } from '$lib/server/services/transcoding/types.js';
import {
    getStreamsForMediaItem,
    getStreamsForFile,
    replaceStreamsForFile,
} from '$lib/server/database/queries/media-streams.queries.js';
import {
    getMediaFileDuration,
    getMediaFileTotalBitrate,
    getMediaItemRuntime,
} from '$lib/server/database/queries/media-lookup.queries.js';
import { capComparableBitrate } from './quality-cap.js';
import {
    deriveBitDepthFromPixelFormat,
    isInterlacedFieldOrder,
    probeMediaFile,
    probeStreamCounts,
    type MediaProbeResult as FFProbeResult,
} from '$lib/server/utils/ffprobe.js';
import {
    dbRowToAudioTrackInfo,
    mapFFprobeToDbRows,
} from '$lib/server/utils/media-stream-mapper.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MediaProbeService');

// ============================================================================
// Types
// ============================================================================

export interface MediaProbeResult {
    audioTracks: AudioTrackInfo[];
    subtitleTracks: SubtitleTrackInfo[];
    streams: MediaStreamInfo[];
    videoCodec: string;
    videoWidth: number;
    videoHeight: number;
    videoBitrate?: number;
    /**
     * The bitrate a quality cap is compared against — the container's overall
     * bitrate, else the video stream's (`capComparableBitrate`, the planner's
     * formula; the DB path reads the scanner's `media_files.total_bitrate`,
     * which is the same value). Undefined when genuinely unknown.
     */
    capBitrate?: number;
    videoRange?: string;
    /** Average frame rate (e.g. 23.976, 24, 25, 29.97) */
    frameRate?: number;
    /** Dolby Vision profile number (5, 7, 8) */
    dvProfile?: number;
    /** Dolby Vision level */
    dvLevel?: number;
    /** Dolby Vision base layer signal compatibility ID (1=HDR10, 2=SDR, 4=HLG) */
    dvBlSignalCompatibilityId?: number;
    /** Video bit depth (8, 10, 12) */
    bitDepth?: number;
    /** Video profile name (e.g. 'Main', 'Main 10', 'High') */
    videoProfile?: string;
    /** Source video codec level as general_level_idc (HEVC: 120 = L4.0, 153 = L5.1) */
    videoLevel?: number;
    /** Jellyfin-style video range type (SDR, HDR10, HLG, DOVI) */
    videoRangeType?: string;
    durationSeconds?: number;
    source: 'db' | 'ffprobe';
}

// ============================================================================
// Service function
// ============================================================================

/**
 * Probe a media item for stream metadata needed to start a transcode job.
 *
 * Resolution order:
 * 1. Duration: `durationOverride`, else the file's own `getMediaFileDuration()`
 *    when `options.fileId` is given, else the item's `getMediaItemRuntime()`
 * 2. Streams: DB cache via `getStreamsForMediaItem()` (instant, no process spawn)
 * 3. Streams fallback: `probeMediaFile()` on `containerPath` (1–3 s FFprobe call)
 *
 * @param sql           Active postgres.Sql connection
 * @param internalId    Internal UUID of the media item
 * @param containerPath Absolute path to the media file for FFprobe fallback
 * @param durationOverride Skip the DB duration lookup and use this value directly
 * @param options.forceFileProbe  Always FFprobe instead of using DB cache
 * @param options.fileId          When provided, use file-scoped streams AND the
 *                                file's own probed duration instead of the item's.
 *                                Prevents mixing codec profiles from different
 *                                files of the same media item, and — for a
 *                                multi-file combined episode, where each file is
 *                                one physical segment shorter than the combined
 *                                item's runtime — prevents building a job around
 *                                a duration the actual file can't fill (FFmpeg
 *                                then hits real EOF far short of the advertised
 *                                segment count / playlist duration).
 *
 * @throws Error when the FFprobe fallback is needed but fails
 */
export async function probeForTranscode(
    sql: postgres.Sql,
    internalId: string,
    containerPath: string,
    durationOverride?: number,
    options?: { forceFileProbe?: boolean; fileId?: string },
): Promise<MediaProbeResult> {
    // Step 1: Resolve duration
    let durationSeconds: number | undefined = durationOverride;
    if (durationSeconds === undefined && options?.fileId) {
        const fileDurationSeconds = await getMediaFileDuration(sql, options.fileId);
        if (fileDurationSeconds !== null) {
            durationSeconds = fileDurationSeconds;
        }
    }
    if (durationSeconds === undefined) {
        const runtimeSeconds = await getMediaItemRuntime(sql, internalId);
        if (runtimeSeconds !== null) {
            durationSeconds = runtimeSeconds;
        }
    }

    // Step 2: Try DB streams (cached, no FFprobe needed).
    // Prefer file-scoped streams when a fileId is available to avoid mixing
    // codec profiles from different files (e.g. 1080p vs 4K versions).
    const dbStreams = options?.fileId
        ? await getStreamsForFile(sql, options.fileId)
        : await getStreamsForMediaItem(sql, internalId);

    // Smart consistency check: detect cases where media_streams was
    // populated by an earlier scan (or legacy code path) and no longer
    // reflects the current file — most commonly a missing audio track. A
    // cheap stream-count probe catches the failure that bites hardest:
    // wrong audio_count makes FFmpeg pick the wrong -map index, so the
    // user hears the file's default track regardless of selection.
    //
    // We check both video and audio counts. The audio check catches the
    // primary bug. The video check is included for completeness; the rare
    // legitimate multi-video file (multi-angle / 3D BD) will hit the
    // fallback every time but still play correctly — just without the DB
    // cache speedup. That trade-off is acceptable until those files
    // become common.
    //
    // Skip the check when forcing or when no DB data exists. On mismatch
    // we also schedule a heal that reuses the full probe result from the
    // fallback below, so subsequent requests hit the fast cached path.
    const canUseDb = dbStreams.length > 0 && !options?.forceFileProbe;
    let dbDataIsConsistent = canUseDb;
    // media_streams has no field-order column, so the DB path learns whether the
    // video is interlaced from the count probe below. Unknown (probe failed) =
    // not interlaced — the pre-existing behaviour, never a spurious deinterlace.
    let dbVideoInterlaced = false;
    if (canUseDb) {
        const dbVideoCount = dbStreams.filter((r) => r.stream_type === 'video').length;
        const dbAudioCount = dbStreams.filter((r) => r.stream_type === 'audio').length;
        const dbSubtitleCount = dbStreams.filter((r) => r.stream_type === 'subtitle').length;
        const actualCounts = await probeStreamCounts(containerPath);
        dbVideoInterlaced = isInterlacedFieldOrder(actualCounts?.videoFieldOrder);
        if (
            actualCounts &&
            (actualCounts.video !== dbVideoCount ||
                actualCounts.audio !== dbAudioCount ||
                // Stale/missing subtitle rows would make the streams list omit a
                // subtitle, silently dropping a requested burn-in — re-probe.
                actualCounts.subtitle !== dbSubtitleCount)
        ) {
            logger.warn('media_streams inconsistent with file — falling back to ffprobe', {
                internalId,
                fileId: options?.fileId,
                db: { video: dbVideoCount, audio: dbAudioCount, subtitle: dbSubtitleCount },
                actual: actualCounts,
            });
            dbDataIsConsistent = false;
        }
    }

    if (canUseDb && dbDataIsConsistent) {
        const videoRow = dbStreams.find((r) => r.stream_type === 'video');
        const audioRows = dbStreams.filter((r) => r.stream_type === 'audio');
        const subtitleRows = dbStreams.filter(
            (r) =>
                r.stream_type === 'subtitle' &&
                (r.is_text_subtitle === true || isTextBasedSubtitle(r.codec)),
        );

        // `audioRows` is the audio subset of a `stream_index`-ordered query, so
        // its array order IS the `-map 0:a:N` order. dbRowToAudioTrackInfo puts
        // the ABSOLUTE `stream_index` in `.index`, which is what this pipeline
        // and the ffprobe fallback below (`index: s.absoluteIndex`) both use.
        const audioTracks: AudioTrackInfo[] = audioRows.map(dbRowToAudioTrackInfo);
        const subtitleTracks: SubtitleTrackInfo[] = subtitleRows.map((row) => ({
            index: row.stream_index,
            displayTitle:
                row.display_title ?? row.title ?? row.language ?? `Subtitle ${row.stream_index}`,
            language: row.language ?? undefined,
            codec: row.codec,
            isDefault: row.is_default,
            isForced: row.is_forced,
            isTextBased: true,
        }));
        const streams: MediaStreamInfo[] = [];

        let videoCodec = 'h264';
        let videoWidth = 1920;
        let videoHeight = 1080;
        let videoBitrate: number | undefined;
        let videoRange: string | undefined;
        let frameRate: number | undefined;

        let dvProfile: number | undefined;
        let dvLevel: number | undefined;
        let dvBlSignalCompatibilityId: number | undefined;

        // The native scanner historically never persisted bit_depth (NULL for
        // every row), while pixel_format IS stored — derive depth from it so
        // decode-capability decisions and learn-on-failure keying see the real
        // bit depth. A Hi10P lesson keyed as bare "h264" (depth unknown) once
        // poisoned hardware decode for ALL H.264 sources.
        const videoBitDepth = videoRow
            ? (videoRow.bit_depth ?? deriveBitDepthFromPixelFormat(videoRow.pixel_format))
            : undefined;

        if (videoRow) {
            // Build hdr10Metadata from DB columns (mastering data + DV fields)
            const hasMasteringData = videoRow.master_display !== null || videoRow.max_cll !== null;
            const hasDoviData = videoRow.dv_profile !== null;
            const hdr10Metadata =
                hasMasteringData || hasDoviData
                    ? {
                          masteringDisplayMetadata: videoRow.master_display ?? undefined,
                          maxCll: videoRow.max_cll ?? undefined,
                          dvProfile: videoRow.dv_profile ?? undefined,
                          dvLevel: videoRow.dv_level ?? undefined,
                          dvBlCompatId: videoRow.dv_bl_signal_compatibility_id ?? undefined,
                      }
                    : undefined;

            streams.push({
                type: 'Video',
                index: videoRow.stream_index,
                codec: videoRow.codec,
                width: videoRow.width ?? 1920,
                height: videoRow.height ?? 1080,
                videoRange: videoRow.video_range ?? undefined,
                videoRangeType: videoRow.video_range_type ?? undefined,
                bitDepth: videoBitDepth,
                isInterlaced: dbVideoInterlaced,
                hdr10Metadata,
            });
            videoCodec = videoRow.codec || 'h264';
            videoWidth = videoRow.width ?? 1920;
            videoHeight = videoRow.height ?? 1080;
            videoBitrate = videoRow.bitrate ?? undefined;
            videoRange = videoRow.video_range ?? undefined;
            frameRate = videoRow.average_frame_rate ?? undefined;
            dvProfile = videoRow.dv_profile ?? undefined;
            dvLevel = videoRow.dv_level ?? undefined;
            dvBlSignalCompatibilityId = videoRow.dv_bl_signal_compatibility_id ?? undefined;
        }

        for (const row of audioRows) {
            streams.push({
                type: 'Audio',
                index: row.stream_index,
                codec: row.codec,
                channels: row.channels ?? 2,
                language: row.language ?? undefined,
                isDefault: row.is_default,
            });
        }

        // ALL subtitle streams (text AND bitmap) — subtitleTracks above keeps only
        // text subs for sidecar delivery, but the streams list must carry every
        // subtitle so callers (e.g. burn-in validation) can look one up by its
        // absolute index and its codec.
        for (const row of dbStreams.filter((r) => r.stream_type === 'subtitle')) {
            streams.push({
                type: 'Subtitle',
                index: row.stream_index,
                codec: row.codec,
                language: row.language ?? undefined,
                isDefault: row.is_default,
            });
        }

        // DB streams exist but duration may be missing — probe for it
        // Without duration, VOD manifest can't be generated and seeking breaks
        // (playlist stays EVENT/live type instead of VOD with full timeline)
        if (durationSeconds === undefined) {
            const durationProbe = await probeMediaFile(containerPath);
            if (durationProbe.success && durationProbe.duration) {
                durationSeconds = durationProbe.duration;
                logger.info('Duration resolved via FFprobe fallback', {
                    internalId,
                    durationSeconds: durationProbe.duration,
                });
            }
        }

        logger.debug('probeForTranscode: using DB stream data', {
            internalId,
            videoCodec,
            videoRange,
            audioTracks: audioTracks.length,
        });

        const fileTotalBitrate = options?.fileId
            ? await getMediaFileTotalBitrate(sql, options.fileId)
            : null;
        return {
            audioTracks,
            subtitleTracks,
            streams,
            videoCodec,
            videoWidth,
            videoHeight,
            videoBitrate,
            capBitrate: capComparableBitrate({
                formatBitrate: fileTotalBitrate,
                videoBitrate,
            }),
            videoRange,
            frameRate,
            dvProfile,
            dvLevel,
            dvBlSignalCompatibilityId,
            bitDepth: videoBitDepth,
            videoProfile: videoRow?.profile ?? undefined,
            videoLevel: videoRow?.level ?? undefined,
            videoRangeType: videoRow?.video_range_type ?? undefined,
            durationSeconds,
            source: 'db',
        };
    }

    // Step 3: FFprobe fallback
    const probe = await probeMediaFile(containerPath);

    // If we got here because the DB was inconsistent, heal it now using the
    // probe result we already have — avoids a third ffprobe call from a
    // separate background re-scan and means subsequent requests hit the fast
    // cached path. Fire-and-forget; failure to heal never blocks playback.
    // Logged at warn level because a heal failure means the bug persists
    // for future requests (full ffprobe cost forever) and operators should
    // be able to see it without enabling debug logging.
    if (canUseDb && !dbDataIsConsistent && options?.fileId && probe.success) {
        const fileId = options.fileId;
        void healMediaStreams(sql, fileId, probe).catch((err) => {
            logger.warn('media_streams heal failed', {
                fileId,
                error: String(err),
            });
        });
    }

    if (!probe.success) {
        throw new Error(`Failed to probe media file: ${probe.error ?? 'unknown'}`);
    }

    const audioTracks: AudioTrackInfo[] = probe.audioStreams.map((s, i) => ({
        index: s.absoluteIndex,
        displayTitle: s.title ?? s.language ?? `Track ${i + 1}`,
        language: s.language,
        channels: s.channels,
        codec: s.codec,
        bitrate: s.bitRate,
        isDefault: s.isDefault,
    }));
    const subtitleTracks: SubtitleTrackInfo[] = probe.subtitleStreams
        .filter((s) => isTextBasedSubtitle(s.codec))
        .map((s, i) => ({
            index: s.index,
            displayTitle: s.title ?? s.language ?? `Subtitle ${i + 1}`,
            language: s.language ?? undefined,
            codec: s.codec,
            isDefault: s.isDefault,
            isForced: s.isForced,
            isTextBased: true,
        }));

    const streams: MediaStreamInfo[] = [];
    let videoCodec = 'h264';
    let videoWidth = 1920;
    let videoHeight = 1080;
    let videoBitrate: number | undefined;

    if (probe.video) {
        // Map FFprobe HDR enum to Jellyfin-style video_range string
        const hdrToRange: Record<string, string> = {
            hdr10: 'HDR10',
            hdr10plus: 'HDR10',
            hlg: 'HLG',
            dovi: 'Dolby Vision',
            dovi_hdr10: 'DOVIWithHDR10',
        };
        const videoRange =
            probe.video.hdr !== 'sdr' ? (hdrToRange[probe.video.hdr] ?? undefined) : undefined;

        // Build HDR10 metadata from ffprobe side_data if available
        const hasMasteringData = probe.video.masterDisplay || probe.video.maxCll;
        const hasDoviData = probe.video.dvProfile !== undefined;
        const hdr10Metadata =
            hasMasteringData || hasDoviData
                ? {
                      masteringDisplayMetadata: probe.video.masterDisplay ?? undefined,
                      maxCll: probe.video.maxCll ?? undefined,
                      dvProfile: probe.video.dvProfile,
                      dvLevel: probe.video.dvLevel,
                      dvBlCompatId: probe.video.dvBlSignalCompatibilityId,
                  }
                : undefined;

        // Derive video range type for CODECS string generation
        const videoRangeType =
            probe.video.hdr === 'sdr'
                ? 'SDR'
                : probe.video.hdr === 'hdr10'
                  ? 'HDR10'
                  : probe.video.hdr === 'hdr10plus'
                    ? 'HDR10'
                    : probe.video.hdr === 'hlg'
                      ? 'HLG'
                      : probe.video.hdr === 'dovi'
                        ? 'DOVI'
                        : probe.video.hdr === 'dovi_hdr10'
                          ? 'DOVI'
                          : undefined;

        const bitDepth = deriveBitDepthFromPixelFormat(probe.video.pixelFormat);

        streams.push({
            type: 'Video',
            index: probe.video.index,
            codec: probe.video.codec,
            width: probe.video.width,
            height: probe.video.height,
            videoRange,
            videoRangeType,
            bitDepth,
            pixelFormat: probe.video.pixelFormat ?? undefined,
            profile: probe.video.profile ?? undefined,
            isInterlaced: isInterlacedFieldOrder(probe.video.fieldOrder),
            hdr10Metadata,
        });
        videoCodec = probe.video.codec;
        videoWidth = probe.video.width;
        videoHeight = probe.video.height;
        videoBitrate = probe.video.bitrate ?? undefined;
    }

    if (durationSeconds === undefined && probe.duration) {
        durationSeconds = probe.duration;
    }

    for (const a of probe.audioStreams) {
        streams.push({
            type: 'Audio',
            index: a.absoluteIndex,
            codec: a.codec,
            channels: a.channels,
            language: a.language,
            isDefault: a.isDefault,
        });
    }

    // ALL subtitle streams (text AND bitmap) — subtitleTracks above keeps only
    // text subs; the streams list must carry every subtitle so callers (e.g.
    // burn-in validation) can look one up by its absolute index and its codec.
    for (const s of probe.subtitleStreams) {
        streams.push({
            type: 'Subtitle',
            index: s.index,
            codec: s.codec,
            language: s.language ?? undefined,
            isDefault: s.isDefault,
        });
    }

    // Extract videoRange from the stream we just built (it was computed above
    // from ffprobe HDR detection but never propagated to the return value).
    const videoStream = streams.find((s) => s.type === 'Video');
    const probeVideoRange = videoStream?.videoRange;

    logger.debug('probeForTranscode: using FFprobe data', {
        internalId,
        videoCodec,
        videoRange: probeVideoRange,
        audioTracks: audioTracks.length,
    });

    return {
        audioTracks,
        subtitleTracks,
        streams,
        videoCodec,
        videoWidth,
        videoHeight,
        videoBitrate,
        capBitrate: capComparableBitrate({
            formatBitrate: probe.formatBitrate,
            videoBitrate,
        }),
        videoRange: probeVideoRange,
        frameRate: probe.video?.fps ?? undefined,
        dvProfile: probe.video?.dvProfile,
        dvLevel: probe.video?.dvLevel,
        dvBlSignalCompatibilityId: probe.video?.dvBlSignalCompatibilityId,
        bitDepth: videoStream?.bitDepth,
        videoProfile: probe.video?.profile ?? undefined,
        videoLevel: probe.video?.level ?? undefined,
        videoRangeType: videoStream?.videoRangeType,
        durationSeconds,
        source: 'ffprobe',
    };
}

/**
 * Replace media_streams rows for a file using a probe result we already
 * have. Called after the consistency check detected stale DB data so the
 * next playback request hits the fast DB path instead of paying the
 * ffprobe cost again. Concurrent calls for the same fileId serialize
 * cleanly inside the DELETE+INSERT transaction in replaceStreamsForFile
 * — the second run is wasteful but idempotent, so no in-process dedup
 * is needed (and wouldn't help on multi-replica deployments anyway).
 *
 * Empty rows are allowed through so a probe that legitimately returns
 * zero streams can flush stale DB data instead of leaving it to trigger
 * the consistency mismatch forever.
 */
async function healMediaStreams(
    sql: postgres.Sql,
    fileId: string,
    probe: FFProbeResult,
): Promise<void> {
    const streamRows = mapFFprobeToDbRows(fileId, probe);
    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await replaceStreamsForFile(tx, fileId, streamRows);
    });
}
