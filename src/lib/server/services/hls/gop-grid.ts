// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyframe grid for demux copy-video "GOP mode".
 *
 * In GOP mode FFmpeg writes one file per keyframe (video) and short parts
 * (audio), and `gop-segment-assembler.ts` joins them into playlist entries.
 * Entry `n` of the grid spans the keyframes `firstKeyframe[n] ..
 * firstKeyframe[n+1]-1`, starting at `starts[n]` and lasting `durations[n]`.
 * The cut rule is `computeSegmentsFromKeyframes` (the same one muxed copy and
 * the I-frame logic use), so it is not duplicated here.
 *
 * Why exact grid entries matter: hls.js anchors its timeline on the first
 * fragment it loads (`initPTS = tfdt - declaredStart`). When the declared
 * start is off, picture and audio shift for the whole session and bitmap
 * subtitles (source time) land off by the same amount. FFmpeg's HLS muxer
 * cuts relative to where each run starts, so only per-GOP output can give
 * every generation the same entry boundaries.
 */

import { computeSegmentsFromKeyframes } from '../ffmpeg-transcode.service.js';

export interface GopGrid {
    /** Entry start times (seconds), `starts[n] = keyframes[firstKeyframe[n]]`. */
    starts: number[];
    /** Entry durations (seconds), exactly `computeSegmentsFromKeyframes`. */
    durations: number[];
    /** Index into `keyframes` of each entry's first keyframe. */
    firstKeyframe: number[];
    keyframes: number[];
    count: number;
    totalSeconds: number;
}

/** Shortest average GOP GOP mode accepts; below it a source is (near) all-intra. */
const MIN_AVERAGE_GOP_SECONDS = 0.5;
/** Upper bound on files FFmpeg writes per generation. */
const MAX_KEYFRAMES = 50_000;
/** Largest share of a keyframe gap the start seek may advance into. */
const MAX_SEEK_LEAD_SECONDS = 0.5;
/** Longest GOP GOP mode accepts: an entry is assembled only once it is complete. */
const MAX_GOP_SECONDS = 60;
/** The grid's cut rule starts at 0; a source whose video starts later is not on it. */
const MAX_FIRST_KEYFRAME_SECONDS = 0.5;

export function buildGopGrid(
    keyframes: number[],
    totalSeconds: number,
    segmentSeconds: number,
): GopGrid | null {
    if (keyframes.length === 0 || !(totalSeconds > 0) || !(segmentSeconds > 0)) return null;
    const durations = computeSegmentsFromKeyframes(keyframes, totalSeconds, segmentSeconds);
    if (durations.length === 0) return null;

    const starts: number[] = [];
    const firstKeyframe: number[] = [];
    let kfIdx = 0;
    let start = 0;
    if (keyframes[0] > MAX_FIRST_KEYFRAME_SECONDS) return null;
    for (const duration of durations) {
        // Entry starts are keyframes (the first is keyframe 0); find it by value
        // rather than re-deriving the cut rule.
        while (kfIdx < keyframes.length - 1 && keyframes[kfIdx] < start - 1e-6) kfIdx++;
        // Every entry must begin on its own keyframe, exactly where the durations
        // put it — otherwise the grid cannot be served as declared.
        const previous = firstKeyframe[firstKeyframe.length - 1];
        if (previous !== undefined && kfIdx <= previous) return null;
        if (firstKeyframe.length > 0 && Math.abs(keyframes[kfIdx] - start) > 1e-3) return null;
        starts.push(firstKeyframe.length === 0 ? 0 : keyframes[kfIdx]);
        firstKeyframe.push(kfIdx);
        start = (firstKeyframe.length === 1 ? 0 : keyframes[kfIdx]) + duration;
    }
    return {
        starts,
        durations,
        firstKeyframe,
        keyframes,
        count: durations.length,
        totalSeconds,
    };
}

/** Entry containing `t`; a boundary belongs to the later entry. Clamped to the grid. */
export function gridIndexForTime(grid: GopGrid, t: number): number {
    let lo = 0;
    let hi = grid.count - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (grid.starts[mid] <= t + 1e-6) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * `-ss` value that makes `-noaccurate_seek` land on exactly the keyframe that
 * starts `entry`: past it (an exact keyframe time can resolve to the previous
 * one, Jellyfin's +0.5 s trick) but never as far as the next keyframe.
 */
export function gopStartSeekSeconds(grid: GopGrid, entry: number): number {
    const kfIdx = grid.firstKeyframe[Math.max(0, Math.min(entry, grid.count - 1))];
    const kf = grid.keyframes[kfIdx];
    // The next keyframe, or the end of the file: -ss must never pass either.
    const next = grid.keyframes[kfIdx + 1] ?? grid.totalSeconds;
    return kf + Math.min(MAX_SEEK_LEAD_SECONDS, Math.max(0, next - kf) / 2);
}

/**
 * Where a GOP-mode generation starts. A fresh job (or resume) starts on the
 * grid entry holding `requestedSeconds`; a seek to `seekTargetEntry` starts one
 * entry EARLY — the player primes its decoder with audio `target-1`, and audio
 * cannot trigger a seek of its own, so that entry must exist in the new
 * generation. Either way the start is exactly an entry's keyframe.
 */
export function resolveGopGenerationStart(
    grid: GopGrid,
    request: { requestedSeconds: number } | { seekTargetEntry: number },
): { entry: number; startTimeSeconds: number | undefined } {
    const entry =
        'seekTargetEntry' in request
            ? Math.max(0, Math.min(request.seekTargetEntry, grid.count - 1) - 1)
            : request.requestedSeconds > 0
              ? gridIndexForTime(grid, request.requestedSeconds)
              : 0;
    return { entry, startTimeSeconds: entry > 0 ? gopStartSeekSeconds(grid, entry) : undefined };
}

type GopEligibilityInput = {
    hlsAudioMode?: string;
    hlsContainer?: string;
    videoAction?: string;
    audioTrackCount: number;
    keyframes?: number[];
    totalSeconds?: number;
    isPreview?: boolean;
    enabled: boolean;
};

/**
 * Why a job cannot use the GOP grid, or null when it can. The reasons that
 * apply to a demux COPY job (keyframes absent, too sparse, too dense) leave it
 * on the legacy fixed-length cut; the caller logs them.
 */
export function gopIneligibleReason(o: GopEligibilityInput): string | null {
    if (!o.enabled) return 'disabled';
    if (o.isPreview) return 'preview';
    if (o.hlsAudioMode !== 'demux' || o.videoAction !== 'copy') return 'not_demux_copy';
    // Must match the strategy's split (full-transcode-strategy.ts isVideoCopyGop):
    // fMP4 only, and at least one audio output to carry master.m3u8.
    if ((o.hlsContainer ?? 'fmp4') !== 'fmp4' || o.audioTrackCount < 1) return 'container_or_audio';
    const keyframes = o.keyframes;
    const total = o.totalSeconds ?? 0;
    if (!keyframes || keyframes.length === 0 || !(total > 0)) return 'no_keyframes';
    if (keyframes.length > MAX_KEYFRAMES) return 'too_many_keyframes';
    if (keyframes[0] > MAX_FIRST_KEYFRAME_SECONDS) return 'late_first_keyframe';
    if (total / keyframes.length < MIN_AVERAGE_GOP_SECONDS) return 'gop_too_short';
    // One huge GOP would hold its entry back for minutes (an entry is served
    // only once complete) and make a giant segment.
    let maxGap = total - keyframes[keyframes.length - 1];
    for (let i = 1; i < keyframes.length; i++) {
        maxGap = Math.max(maxGap, keyframes[i] - keyframes[i - 1]);
    }
    return maxGap <= MAX_GOP_SECONDS ? null : 'gop_too_long';
}

export function isGopSegmentsEligible(o: GopEligibilityInput): boolean {
    return gopIneligibleReason(o) === null;
}

export { isGopModeJob } from './gop-mode.js';
