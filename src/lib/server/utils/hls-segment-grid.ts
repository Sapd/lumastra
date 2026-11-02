// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The uniform HLS segment grid: a timeline of `totalSeconds` cut every
 * `segmentSeconds`, the way a transcode (`-force_key_frames` on the grid +
 * `-hls_time`) and every audio rendition split it.
 *
 * A remainder shorter than {@link HLS_TAIL_MERGE_SECONDS} is folded into the
 * previous segment instead of getting an entry of its own. The media duration
 * we know is the CONTAINER's, which usually runs past the last video frame by
 * an audio frame or so (12.021 s for 12.000 s of 24 fps video). A plain
 * `ceil(total / segment)` listed that sliver as a final 0.021 s segment, but
 * FFmpeg only starts a video segment on a frame at or past the cut, and the
 * last frame starts before it: the video rendition has one file fewer than the
 * playlist. The request for that phantom entry was answered from the tail cache
 * with the previous segment's bytes, so the end of the video repeated.
 * Measured with the app's own args: video 2 files, audio 3 (the last 0.043 s).
 *
 * Folding drops at most this much from the very end of the timeline on the
 * streams that did write the sliver (credits black, a trailing audio frame),
 * while a phantom entry repeats or stalls the ending. A bigger tail keeps its
 * entry; when FFmpeg still writes no video for it, the segment handler refuses
 * it on FFmpeg's closed manifest ({@link isPastProducedEnd}).
 */
export const HLS_TAIL_MERGE_SECONDS = 0.5;

/** Number of entries on the uniform grid; 0 for a non-positive or invalid input. */
export function uniformSegmentCount(totalSeconds: number, segmentSeconds: number): number {
    if (!(totalSeconds > 0) || !(segmentSeconds > 0) || !Number.isFinite(totalSeconds)) return 0;
    const count = Math.ceil(totalSeconds / segmentSeconds);
    if (count <= 1) return 1;
    const remainder = totalSeconds - (count - 1) * segmentSeconds;
    // Short cadences fold at most a quarter segment, so the stretched last
    // EXTINF stays a plausible segment and rounds within TARGETDURATION.
    return remainder < Math.min(HLS_TAIL_MERGE_SECONDS, segmentSeconds / 4) ? count - 1 : count;
}

/**
 * Duration of entry `index` on the uniform grid. The last entry carries
 * whatever is left, which after folding can exceed `segmentSeconds` by less
 * than {@link HLS_TAIL_MERGE_SECONDS}. Never below 1 ms.
 */
export function uniformSegmentDuration(
    index: number,
    totalSeconds: number,
    segmentSeconds: number,
): number {
    const count = uniformSegmentCount(totalSeconds, segmentSeconds);
    if (index < count - 1) return segmentSeconds;
    return Math.max(0.001, totalSeconds - index * segmentSeconds);
}

/**
 * Whether FFmpeg has finished a stream one segment short of the grid: its own
 * manifest is closed (`#EXT-X-ENDLIST`), its last file is the second-to-last
 * grid entry, and `requestedIndex` is past that file.
 *
 * This is the case {@link HLS_TAIL_MERGE_SECONDS} cannot fold, a container
 * that outlasts the video by more than that (a long audio overhang). The
 * missing entry will never exist, so the request must fail rather than wait or
 * be answered with another segment's bytes. Requires FFmpeg's file numbers to
 * equal the playlist's (transcode mode: `-start_number` = offset).
 *
 * A generation stopped early does not match: it either writes no ENDLIST
 * (killed) or its last file is further from the end of the grid.
 */
export function isPastProducedEnd(
    ffmpegManifest: string,
    requestedIndex: number,
    gridCount: number,
): boolean {
    if (!/^#EXT-X-ENDLIST\s*$/m.test(ffmpegManifest)) return false;
    let lastIndex = -1;
    for (const match of ffmpegManifest.matchAll(/^segment_(\d+)\.[a-z0-9]+\s*$/gm)) {
        lastIndex = Math.max(lastIndex, Number(match[1]));
    }
    return lastIndex >= 0 && lastIndex >= gridCount - 2 && requestedIndex > lastIndex;
}
