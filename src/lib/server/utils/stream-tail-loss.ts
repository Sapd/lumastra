// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure decision: does a file's container duration claim material video that
 * the streams do not contain? Shared by media-probe (`truncated_video`) and
 * trickplay (`video_ends_early`) so both judge a file the same way. Kept free
 * of task/DB imports so trickplay can use it without loading the media-probe
 * task.
 */

/** A gap must exceed this many seconds to count, whatever the file length. */
export const TRUNCATION_MIN_GAP_S = 10;
/** …and this share of the container duration when the real video end is known. */
export const TRUNCATION_MIN_GAP_SHARE_EXACT = 0.05;

/** Seconds of container-over-video gap that is tolerated for a file this long. */
export function streamLossToleranceSeconds(containerDuration: number): number {
    return Math.max(TRUNCATION_MIN_GAP_S, containerDuration * TRUNCATION_MIN_GAP_SHARE_EXACT);
}

export interface StreamLossInput {
    /** Duration the container header claims, in seconds. */
    containerDuration: number;
    /** Where the video stream really ends (last video packet PTS), in seconds. */
    videoEnd: number;
    /** Where the audio stream really ends, null when unknown. */
    audioEnd: number | null;
    /** Whether the file has an audio stream at all. */
    hasAudio: boolean;
    /** ffprobe reported the demuxer hit end-of-file early (a cut file). */
    endedPrematurely: boolean;
}

/**
 * True when the container claims materially more than the video delivers AND
 * the file shows the content really stops there.
 *
 * Measured on prod 2026-10-21 (137 flagged files):
 * - 52 complete files: video and audio end together at the real runtime, the
 *   demuxer reaches EOF cleanly, but the header over-reports (subtitle tracks,
 *   old mkvmerge; one claims 13600 s for a 1360 s episode). Audio agrees with
 *   video and nothing is premature, so they are NOT flagged.
 * - 13 files really cut off: `File ended prematurely` on stderr. Flagged.
 * - 26 files where audio runs materially past the video end (video 1203 s,
 *   audio 1419 s; or an 85 s audio-only tail). Flagged.
 * - No audio stream and video well short of the container: flagged.
 */
export function isMaterialStreamLoss(input: StreamLossInput): boolean {
    const { containerDuration, videoEnd, audioEnd, hasAudio, endedPrematurely } = input;
    const tolerance = streamLossToleranceSeconds(containerDuration);
    if (containerDuration - videoEnd <= tolerance) return false;
    return endedPrematurely || !hasAudio || audioEnd == null || audioEnd - videoEnd > tolerance;
}
