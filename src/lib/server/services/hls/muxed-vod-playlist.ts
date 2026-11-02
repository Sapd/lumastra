// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The server-owned muxed VOD playlist (the public timeline hls.js reads) and
 * the rule for which segment grid it uses. Split out of playback.service.ts so
 * the playlist can be tested against the segment side without that module's
 * database/probe import graph.
 */

import { withHlsParams } from '../../utils/hls-uri.js';
import { Logger } from '$lib/server/utils/logger.js';
import { MAX_PLAUSIBLE_RUNTIME_SECONDS } from '$lib/server/utils/media-duration.js';
import { uniformSegmentCount, uniformSegmentDuration } from '$lib/server/utils/hls-segment-grid.js';
import {
    computeSegmentsFromKeyframes,
    computeSegmentsWithSeekGrid,
} from '../ffmpeg-transcode.service.js';

const logger = Logger.for('HlsPlaybackService');

/**
 * Whether the public muxed VOD playlist must use the COPY-MODE (keyframe) grid.
 *
 * Decided by the JOB, never by this request. The segment side — offsets,
 * backward/forward-seek detection, file mapping (segment-request-state,
 * generation-router, getStreamSegmentOffsetForJob) — reads
 * `job.transcodeDecisionResult.videoAction`, so the playlist has to number
 * segments on the same grid or every index it hands out is interpreted on a
 * different one.
 *
 * The two disagree whenever the job's decision is changed after the request
 * resolved its codec, e.g. the quality-cap safety net flipping a copy
 * plan to a transcode because a per-request quality cap binds, or a reused
 * job that was created for a different request. Windows e2e 2026-09-27: a
 * "1080p 10 Mbps" pick on a remux plan produced a transcoded job (uniform
 * 6 s grid, offset 9 for a 55 s start) behind a keyframe-grid playlist; the
 * player's first request (keyframe segment 5) read as a backward seek and
 * spawned a second generation from 30 s. Every switch cost two jobs and
 * 15-18 s. Falls back to the request's view only for a job with no decision.
 */
export function playlistUsesCopyGrid(
    job: {
        config?: { effectivePlan?: { grid: string } };
        transcodeDecisionResult?: { videoAction: string } | null;
    },
    requestIsVideoCopy: boolean,
): boolean {
    if (job.config?.effectivePlan) return job.config.effectivePlan.grid !== 'uniform';
    const decided = job.transcodeDecisionResult?.videoAction;
    return decided ? decided === 'copy' : requestIsVideoCopy;
}

/** The slice of a transcode decision the manifest's video info depends on. */
export interface ManifestDecision {
    videoAction?: string;
    gpuEncoder?: string;
    targetCodec?: { video?: string };
    needsTonemapping?: boolean;
    outputVideoRange?: string;
}

/** Codec family ('h264' | 'hevc' | 'av1') an encoder id produces, if recognisable. */
function encoderFamily(encoder: string | undefined): string | undefined {
    const e = (encoder ?? '').toLowerCase();
    if (!e) return undefined;
    if (e.includes('264')) return 'h264';
    if (e.includes('hevc') || e.includes('265')) return 'hevc';
    if (e.includes('av1')) return 'av1';
    return undefined;
}

/**
 * The master playlist's video codec / transcode / range facts, taken from the
 * JOB's decision — the same job-first rule as {@link playlistUsesCopyGrid}.
 *
 * Built from the request, a job whose decision changed after the request
 * resolved its codec (the quality-cap safety net flipping a copy plan, a
 * reused job) advertised the SOURCE codec as a copy — CODECS, and the HDR
 * range of a stream that is now re-encoded. Native-HLS clients configure the
 * decoder and the display from exactly these attributes.
 *
 * Returns overrides to spread over the request-derived video info; empty for
 * a job without a decision (nothing better to go on).
 */
export function jobManifestVideoOverrides(
    decision: ManifestDecision | null | undefined,
    sourceCodec: string,
    effectivePlan?: {
        video?: { action: string; encoder?: string };
        codecRequestHdr?: { kind: string };
        tonemapBurnInToSdr?: boolean;
    },
): { outputCodec?: string; isTranscoded?: boolean; videoRange?: string; videoRangeType?: string } {
    const action = effectivePlan?.video?.action ?? decision?.videoAction;
    if (!action) return {};
    if (action === 'copy') {
        return { outputCodec: sourceCodec, isTranscoded: false };
    }
    const family =
        encoderFamily(effectivePlan?.video?.encoder) ??
        encoderFamily(decision?.gpuEncoder) ??
        encoderFamily(decision?.targetCodec?.video);
    return {
        ...(family ? { outputCodec: family } : {}),
        isTranscoded: true,
        // A tone-mapped transcode leaves HDR behind: don't advertise the
        // source's PQ/HLG range for SDR frames.
        ...(decision?.needsTonemapping ||
        decision?.outputVideoRange === 'SDR' ||
        effectivePlan?.codecRequestHdr?.kind === 'tonemap' ||
        effectivePlan?.tonemapBurnInToSdr
            ? { videoRange: 'SDR', videoRangeType: 'SDR' }
            : {}),
    };
}

/** Exported for tests; see the muxed branch of startHlsPlayback. */
export function buildMuxedVodPlaylist(options: {
    runtimeSeconds: number;
    segmentDuration: number;
    segmentBase: string;
    segmentParams: URLSearchParams;
    segmentExtension: 'm4s' | 'ts';
    keyframeData?: number[];
    /** When set (> 0), post-seek grid is used from this point onward so EXTINF
     *  values match FFmpeg's actual segment durations after the seek. */
    seekStartTime?: number;
}): string {
    const {
        runtimeSeconds: requestedRuntimeSeconds,
        segmentDuration,
        segmentBase,
        segmentParams,
        segmentExtension,
        keyframeData,
        seekStartTime,
    } = options;
    if (!Number.isFinite(requestedRuntimeSeconds) || requestedRuntimeSeconds <= 0) {
        return '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-ENDLIST\n';
    }

    // Last-resort bound, like generateVodPlaylist's: a duration that slipped
    // past reconcileRuntimeSeconds (an item runtime stored before it existed,
    // no stream/keyframe evidence) must not list a month of segments.
    const runtimeSeconds = Math.min(requestedRuntimeSeconds, MAX_PLAUSIBLE_RUNTIME_SECONDS);
    if (runtimeSeconds < requestedRuntimeSeconds) {
        logger.warn('Muxed VOD runtime implausible; capping the playlist', {
            requestedRuntimeSeconds,
            runtimeSeconds,
        });
    }

    const safeSegmentDuration =
        Number.isFinite(segmentDuration) && segmentDuration > 0 ? segmentDuration : 10;
    const durations =
        keyframeData && keyframeData.length > 0
            ? seekStartTime && seekStartTime > 0
                ? computeSegmentsWithSeekGrid(
                      keyframeData,
                      runtimeSeconds,
                      safeSegmentDuration,
                      seekStartTime,
                  )
                : computeSegmentsFromKeyframes(keyframeData, runtimeSeconds, safeSegmentDuration)
            : [];

    // DEBUG: Log grid alignment info for muxed copy-mode diagnostics
    if (durations.length > 0) {
        // Show where the cumulative EXTINF sum diverges from the absolute grid
        let cumulative = 0;
        let maxDrift = 0;
        let maxDriftIndex = 0;
        for (let i = 0; i < durations.length; i++) {
            cumulative += durations[i];
            const gridPoint = (i + 1) * safeSegmentDuration;
            const drift = cumulative - gridPoint;
            if (Math.abs(drift) > Math.abs(maxDrift)) {
                maxDrift = drift;
                maxDriftIndex = i;
            }
        }
        logger.info('[MUXED VOD DEBUG] Keyframe segment durations computed', {
            totalSegments: durations.length,
            totalDuration: cumulative.toFixed(3),
            runtimeSeconds: runtimeSeconds.toFixed(3),
            segmentDuration: safeSegmentDuration,
            maxGridDrift: maxDrift.toFixed(3),
            maxDriftAtSegment: maxDriftIndex,
            first5Durations: durations.slice(0, 5).map((d) => d.toFixed(3)),
            last5Durations: durations.slice(-5).map((d) => d.toFixed(3)),
        });
    }
    const segmentDurations =
        durations.length > 0
            ? durations
            : Array.from(
                  { length: uniformSegmentCount(runtimeSeconds, safeSegmentDuration) },
                  (_value, index) =>
                      uniformSegmentDuration(index, runtimeSeconds, safeSegmentDuration),
              );
    const withParams = (name: string) => withHlsParams(`${segmentBase}/${name}`, segmentParams);
    // A loop, not Math.max(...spread): a long timeline overflows the call stack.
    let longestSegment = 1;
    for (const d of segmentDurations) if (d > longestSegment) longestSegment = d;
    const targetDuration = Math.ceil(longestSegment);
    const padWidth = Math.max(5, String(segmentDurations.length - 1).length);

    let playlist = '#EXTM3U\n';
    playlist += `#EXT-X-VERSION:${segmentExtension === 'm4s' ? 7 : 3}\n`;
    playlist += '#EXT-X-PLAYLIST-TYPE:VOD\n';
    playlist += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
    playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
    playlist += '#EXT-X-INDEPENDENT-SEGMENTS\n';

    if (segmentExtension === 'm4s') {
        playlist += `#EXT-X-MAP:URI="${withParams('init_0.mp4')}"\n`;
    }

    for (let i = 0; i < segmentDurations.length; i++) {
        const segmentName = `segment_${i.toString().padStart(padWidth, '0')}.${segmentExtension}`;
        playlist += `#EXTINF:${segmentDurations[i].toFixed(6)},\n`;
        playlist += `${withParams(segmentName)}\n`;
    }

    playlist += '#EXT-X-ENDLIST\n';
    return playlist;
}
