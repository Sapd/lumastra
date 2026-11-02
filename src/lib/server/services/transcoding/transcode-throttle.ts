// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcode throttle decisions.
 *
 * FFmpeg otherwise encodes at full speed to the end of the file, long after the
 * player has all it needs. With `TRANSCODE_THROTTLE` on, once FFmpeg is
 * `THROTTLE_AFTER_SECONDS` ahead of the newest segment the player requested,
 * the service stops the process (SIGSTOP) and continues it
 * (SIGCONT) once the player has caught up to half that lead. The gap between the
 * two thresholds keeps the process from flapping on every segment request.
 *
 * Everything is measured in media seconds, not segment indexes: remux,
 * transcode and keyframe-aligned streams number their segments differently, and
 * per-stream target durations differ (remux video ~10 s, audio 6 s).
 *
 * The decision itself is pure so it can be unit tested without a live job.
 */

import type { TranscodeJob } from './types.js';

export type ThrottleDecision = 'pause' | 'resume' | 'none';

/** Media time FFmpeg has produced, in seconds from the start of the file. */
export function producedMediaSeconds(
    job: Pick<TranscodeJob, 'segmentOffset' | 'segmentsReady' | 'segmentDurationSeconds'>,
): number {
    return (job.segmentOffset + job.segmentsReady) * job.segmentDurationSeconds;
}

/**
 * Media time the player has requested up to — the furthest of the per-stream
 * latest requests (the stream that is furthest along is the one that will
 * need the next segment first). Undefined until a segment was requested.
 */
export function requestedMediaSeconds(
    job: Pick<TranscodeJob, 'requestedMediaSeconds'>,
): number | undefined {
    const perStream = job.requestedMediaSeconds;
    if (!perStream || perStream.size === 0) return undefined;
    return Math.max(...perStream.values());
}

/** Seconds of media FFmpeg is ahead of the player, or undefined when unknown. */
export function bufferAheadSeconds(
    job: Pick<
        TranscodeJob,
        'segmentOffset' | 'segmentsReady' | 'segmentDurationSeconds' | 'requestedMediaSeconds'
    >,
): number | undefined {
    const requested = requestedMediaSeconds(job);
    if (requested === undefined) return undefined;
    return producedMediaSeconds(job) - requested;
}

export interface ThrottleInput {
    enabled: boolean;
    /** Whether the process is currently stopped by the throttle. */
    throttled: boolean;
    /** From {@link bufferAheadSeconds}; undefined = the player has not requested anything. */
    aheadSeconds: number | undefined;
    /** Lead at which FFmpeg is paused (`THROTTLE_AFTER_SECONDS`). */
    pauseAfterSeconds: number;
}

/**
 * Pause above `pauseAfterSeconds` of lead, resume below half of it. Disabling
 * the throttle, or losing track of the player, resumes a paused process.
 */
export function decideThrottle(input: ThrottleInput): ThrottleDecision {
    if (
        !input.enabled ||
        input.aheadSeconds === undefined ||
        !Number.isFinite(input.aheadSeconds) ||
        !Number.isFinite(input.pauseAfterSeconds)
    ) {
        return input.throttled ? 'resume' : 'none';
    }
    if (input.throttled) {
        return input.aheadSeconds < input.pauseAfterSeconds / 2 ? 'resume' : 'none';
    }
    return input.aheadSeconds > input.pauseAfterSeconds ? 'pause' : 'none';
}
