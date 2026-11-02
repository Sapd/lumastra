// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TranscodeJob } from '../transcoding/types.js';
import {
    shouldTriggerBackwardSeek,
    shouldTriggerForwardSeek,
} from '../../utils/hls-segment-utils.js';

export type HlsSegmentAction =
    | {
          type: 'gone_deleted';
          branch: 'deleted';
      }
    | {
          type: 'trigger_seek';
          direction: 'backward' | 'forward';
          branch:
              | 'backward_seek'
              | 'forward_seek'
              | 'far_from_origin_seek'
              | 'repeated_pressure_forward_seek'
              | 'speed_aware_forward_seek';
      }
    | {
          type: 'not_found';
          branch: 'negative_non_authoritative' | 'segment_not_found';
      }
    | {
          type: 'serve_file';
          branch: 'serve_file';
      }
    | {
          type: 'serve_tail_cache';
          branch: 'tail_cache';
      }
    | {
          type: 'wait_current';
          branch: 'wait_current';
      };

/**
 * Restart FFmpeg at the target once waiting for the current run to get there
 * would take longer than this. A plain wait gives up after
 * HLS_SEGMENT_WAIT_TIMEOUT_MS (10 s), and a restart has to deliver its first
 * segment inside the web client's 20 s time-to-first-byte limit, FFmpeg startup
 * included. 6 s leaves headroom for both.
 */
export const SPEED_AWARE_FORWARD_SEEK_BUDGET_SECONDS = 6;

/**
 * Never restart for a target this close to production: the restart costs a
 * startup of its own, and a short gap is normal buffering ahead.
 */
export const SPEED_AWARE_FORWARD_SEEK_MIN_GAP = 3;

/**
 * Segments the current generation must have produced before its `speed=` is
 * trusted. FFmpeg reports speed as an average since the run started, and the
 * start includes probing, hardware init and the input seek, so the first
 * readings (every ~0.5 s) are far below the steady rate. Trusting them right
 * after a restart would make the next request look slow and restart again.
 */
export const SPEED_AWARE_FORWARD_SEEK_MIN_PRODUCED = 2;

/**
 * Seconds the current run needs to finish `requestedSegmentNum`, or undefined
 * when the speed is unknown (the job clears it on every respawn). Progress
 * counts COMPLETED segments, so the requested one is ready after gap + 1.
 */
export function estimateForwardWaitSeconds(input: {
    requestedSegmentNum: number;
    currentProgress: number;
    segmentDurationSeconds?: number;
    transcodeSpeed?: number;
}): number | undefined {
    const { transcodeSpeed, segmentDurationSeconds } = input;
    if (!transcodeSpeed || !Number.isFinite(transcodeSpeed) || transcodeSpeed <= 0) {
        return undefined;
    }
    if (!segmentDurationSeconds || segmentDurationSeconds <= 0) return undefined;
    const gap = input.requestedSegmentNum - input.currentProgress;
    return ((gap + 1) * segmentDurationSeconds) / transcodeSpeed;
}

function isSpeedAwareForwardSeek(input: PlanHlsSegmentActionInput): boolean {
    if (input.currentProgress === undefined || input.isSequentialPlayback) return false;
    // A generation that has served nothing on this stream yet is fresh from a
    // (re)spawn: its speed is still startup-skewed and isSequentialPlayback
    // cannot be known.
    if (input.isFirstStreamAccess) return false;
    if (input.currentProgress - input.segmentOffset < SPEED_AWARE_FORWARD_SEEK_MIN_PRODUCED) {
        return false;
    }
    const gap = input.requestedSegmentNum - input.currentProgress;
    if (gap < SPEED_AWARE_FORWARD_SEEK_MIN_GAP) return false;
    const waitSeconds = estimateForwardWaitSeconds({
        requestedSegmentNum: input.requestedSegmentNum,
        currentProgress: input.currentProgress,
        segmentDurationSeconds: input.segmentDurationSeconds,
        transcodeSpeed: input.transcodeSpeed,
    });
    return waitSeconds !== undefined && waitSeconds > SPEED_AWARE_FORWARD_SEEK_BUDGET_SECONDS;
}

export interface PlanHlsSegmentActionInput {
    isSegment: boolean;
    isIframeRequest: boolean | string | null;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    canSeek: boolean;
    fileExists: boolean;
    isDeleted: boolean;
    jobStatus: TranscodeJob['status'];
    jobIsSeeking: boolean;
    isVideoTranscoded?: boolean;
    isSequentialPlayback?: boolean;
    currentProgress?: number;
    forwardSeekThreshold?: number;
    /**
     * Last FFmpeg `speed=` of the current run; undefined right after a (re)spawn.
     * Pass undefined for sessions that must never restart FFmpeg (cache-backed
     * previews), or a skipped seek would answer without waiting.
     */
    transcodeSpeed?: number;
    /** Segment duration of the requested stream, for the speed-aware forward seek. */
    segmentDurationSeconds?: number;
    farFromOriginThreshold?: number;
    isRepeatedSegmentPressure?: boolean;
    repeatedPressureForwardSeekThreshold?: number;
    isTailProbe?: boolean;
    /** The tail cache holds THIS request's playlist entry (end-segment-cache.ts). */
    hasTailCache?: boolean;
    /** True when this stream has never been served before (first rendition access). */
    isFirstStreamAccess?: boolean;
}

export function planHlsSegmentAction(input: PlanHlsSegmentActionInput): HlsSegmentAction {
    if (input.isSegment && input.actualSegmentIndex >= 0 && input.isDeleted) {
        return {
            type: 'gone_deleted',
            branch: 'deleted',
        };
    }

    // `segmentOffset` records where the ENCODER was told to start, which is not
    // the same as "nothing below this exists". For a TRANSCODED generation the
    // two came apart on 2026-08-28: FFmpeg gets `-start_number N`, so files are
    // numbered absolutely and `segment_00042.m4s` is segment 42's content
    // whatever the offset says — and a restore that resumes at the viewer's
    // position leaves real segments below its offset. Re-transcoding one of
    // those instead of serving it retires the in-flight forward generation for
    // content already sitting on disk.
    //
    // Only for absolute numbering. In copy mode names are RELATIVE
    // (`translateToActualIndex` = requested - offset), so a below-offset request
    // resolves to a negative index and any file at that name holds DIFFERENT
    // content — serving it would be a correctness bug. Copy mode keeps seeking.
    //
    // Audio already behaves this way, via `canSeek` being false for audio
    // streams; this closes the same gap for video.
    if (
        input.canSeek &&
        input.isSegment &&
        !input.isIframeRequest &&
        !(input.isVideoTranscoded && input.fileExists) &&
        shouldTriggerBackwardSeek(input.requestedSegmentNum, input.segmentOffset)
    ) {
        return {
            type: 'trigger_seek',
            direction: 'backward',
            branch: 'backward_seek',
        };
    }

    if (input.isSegment && !input.canSeek && !input.jobIsSeeking && input.actualSegmentIndex < 0) {
        return {
            type: 'not_found',
            branch: 'negative_non_authoritative',
        };
    }

    // Far-from-origin seek: segment exists on disk from a previous FFmpeg run
    // but is far from the current offset — restart FFmpeg closer to the target.
    // Checked before serve_file so stale segments don't cause long seeks later.
    // Guards:
    //   - Tail probes must serve the cached end segment for VOD.
    //   - First stream access means the segment is fresh (audio rendition switch).
    //   - Segments within current production (≤ currentProgress) are not stale.
    if (
        input.canSeek &&
        input.isSegment &&
        !input.isIframeRequest &&
        !input.isVideoTranscoded &&
        !input.isSequentialPlayback &&
        !input.isFirstStreamAccess &&
        !input.isTailProbe &&
        (input.currentProgress === undefined ||
            input.requestedSegmentNum > input.currentProgress) &&
        input.requestedSegmentNum - input.segmentOffset >
            (input.farFromOriginThreshold ?? Number.POSITIVE_INFINITY)
    ) {
        return {
            type: 'trigger_seek',
            direction: 'forward',
            branch: 'far_from_origin_seek',
        };
    }

    if (input.fileExists) {
        return {
            type: 'serve_file',
            branch: 'serve_file',
        };
    }

    if (input.isSegment && input.isTailProbe && input.hasTailCache) {
        return {
            type: 'serve_tail_cache',
            branch: 'tail_cache',
        };
    }

    if (
        input.canSeek &&
        input.isSegment &&
        !input.isIframeRequest &&
        input.currentProgress !== undefined &&
        shouldTriggerForwardSeek(
            input.requestedSegmentNum,
            input.currentProgress,
            input.forwardSeekThreshold,
        )
    ) {
        return {
            type: 'trigger_seek',
            direction: 'forward',
            branch: 'forward_seek',
        };
    }

    // The fixed threshold alone waited out a 15-segment gap on a 4.5x transcode
    // (~20 s) and timed out; a fast GPU covers the same gap in under 5 s. So
    // also restart whenever the wait would blow the budget. Its own branch,
    // because the executor applies the seek cooldown to it at ANY distance —
    // the distance-gated cooldown never covers a gap under the fixed threshold.
    if (
        input.canSeek &&
        input.isSegment &&
        !input.isIframeRequest &&
        isSpeedAwareForwardSeek(input)
    ) {
        return {
            type: 'trigger_seek',
            direction: 'forward',
            branch: 'speed_aware_forward_seek',
        };
    }

    if (
        input.canSeek &&
        input.isSegment &&
        !input.isIframeRequest &&
        input.isRepeatedSegmentPressure &&
        input.currentProgress !== undefined &&
        input.requestedSegmentNum - input.currentProgress >
            (input.repeatedPressureForwardSeekThreshold ?? Number.POSITIVE_INFINITY)
    ) {
        return {
            type: 'trigger_seek',
            direction: 'forward',
            branch: 'repeated_pressure_forward_seek',
        };
    }

    if (
        input.isSegment &&
        input.jobStatus !== 'error' &&
        (input.jobStatus !== 'stopped' || input.jobIsSeeking)
    ) {
        return {
            type: 'wait_current',
            branch: 'wait_current',
        };
    }

    return {
        type: 'not_found',
        branch: 'segment_not_found',
    };
}
