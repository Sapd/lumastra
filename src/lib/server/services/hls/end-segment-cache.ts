// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The per-stream end-segment cache (`job.endSegmentCache`): one buffer per
 * stream dir that answers a tail probe instantly while FFmpeg is busy
 * elsewhere (see "Tail Cache" in ./README.md).
 *
 * Each buffer answers exactly ONE playlist entry. It used to be served for any
 * tail-window miss (index >= streamTotal - 3), so a playlist entry FFmpeg never
 * wrote for that stream — copy audio ending >= 0.5 s before the container, the
 * last grid entry past it — got a neighbouring segment's bytes and the player
 * repeated them. A miss now falls through to the normal wait / 404 path.
 *
 * Two kinds of entry:
 * - `segment`: a real output file served for playlist index `segmentIndex`.
 * - `tail_run`: the last segment of a tail-cache worker's own `-ss` run, whose
 *   file numbers mean nothing on the playlist. It answers only the LAST grid
 *   entry, and only when the stream's media reaches into that entry. The grid
 *   is resolved at lookup time because a stream's cadence
 *   (`streamTargetDurations`) is often learned after the worker finished.
 */

import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';

export type EndSegmentCacheEntry =
    | { kind: 'segment'; segmentIndex: number; buffer: Buffer }
    | {
          kind: 'tail_run';
          /** Estimated end of this stream's media on the source timeline, seconds. */
          mediaEndSeconds: number;
          buffer: Buffer;
      };

export type EndSegmentCache = Map<string, EndSegmentCacheEntry>;

/** The uniform grid a stream's playlist is numbered on. */
export interface EndSegmentGrid {
    totalSeconds: number;
    segmentSeconds: number;
}

/**
 * How far a `tail_run` stream must reach past the start of the last grid entry
 * to answer it. Covers the timing estimate's error (first-sample composition
 * offset, AAC priming: tens of ms); a stream inside this band is skipped,
 * which costs only the instant answer, never correctness.
 */
export const TAIL_RUN_REACH_MARGIN_SECONDS = 0.25;

/** The playlist index an entry answers on `grid`, or -1 for none. */
export function endSegmentEntryIndex(entry: EndSegmentCacheEntry, grid: EndSegmentGrid): number {
    if (entry.kind === 'segment') return entry.segmentIndex;
    const count = uniformSegmentCount(grid.totalSeconds, grid.segmentSeconds);
    if (count === 0) return -1;
    const lastStart = (count - 1) * grid.segmentSeconds;
    return entry.mediaEndSeconds > lastStart + TAIL_RUN_REACH_MARGIN_SECONDS ? count - 1 : -1;
}

/** The cached buffer for exactly `requestedIndex` of this stream, if any. */
export function lookupEndSegment(
    cache: EndSegmentCache,
    streamDir: string,
    requestedIndex: number,
    grid: EndSegmentGrid,
): Buffer | undefined {
    const entry = cache.get(streamDir);
    if (!entry || requestedIndex < 0) return undefined;
    return endSegmentEntryIndex(entry, grid) === requestedIndex ? entry.buffer : undefined;
}

/**
 * Store `entry` unless the stream already holds a better one: a later playlist
 * index wins (the duration probe asks for the last entry), and at the same
 * index a real output file beats a tail-run estimate. Returns whether stored.
 *
 * `grid` only ranks the two entries. A tail-run entry that answers nothing on
 * it is still kept for an empty stream: the stream's own cadence is often
 * learned later, and every lookup resolves the entry again on its grid.
 */
export function storeEndSegment(
    cache: EndSegmentCache,
    streamDir: string,
    entry: EndSegmentCacheEntry,
    grid: EndSegmentGrid,
): boolean {
    const nextIndex = endSegmentEntryIndex(entry, grid);
    const current = cache.get(streamDir);
    if (nextIndex < 0) {
        if (entry.kind !== 'tail_run' || current) return false;
        cache.set(streamDir, entry);
        return true;
    }
    if (current) {
        const currentIndex = endSegmentEntryIndex(current, grid);
        if (currentIndex > nextIndex) return false;
        if (currentIndex === nextIndex && current.kind === 'segment' && entry.kind === 'tail_run') {
            return false;
        }
    }
    cache.set(streamDir, entry);
    return true;
}

/** One stream of a tail-cache worker run, timed on that run's own clock. */
export interface TailRunStream {
    streamDir: string;
    buffer: Buffer;
    /** End of the stream's last segment on the run's clock, seconds. */
    runEndSeconds: number;
}

/**
 * Place each stream of a tail run on the source timeline. The run's clock has
 * an unknown origin (`-ss` lands on a keyframe, then `-avoid_negative_ts`
 * shifts it), but it is shared by every stream of the run, so the gaps between
 * their ends are exact. The longest stream is taken to end where the container
 * does: `mediaEnd = totalSeconds - (longestEnd - runEnd)`.
 *
 * Needs two streams or more. A lone stream has nothing to be measured against,
 * and it need not be the one the container's duration came from (a
 * video-disabled run writes only the audio of a file whose video is longer).
 */
export function tailRunEntries(
    streams: TailRunStream[],
    totalSeconds: number,
): Map<string, EndSegmentCacheEntry> {
    const out = new Map<string, EndSegmentCacheEntry>();
    if (streams.length < 2 || !(totalSeconds > 0)) return out;
    const longestEnd = Math.max(...streams.map((s) => s.runEndSeconds));
    for (const s of streams) {
        out.set(s.streamDir, {
            kind: 'tail_run',
            mediaEndSeconds: totalSeconds - (longestEnd - s.runEndSeconds),
            buffer: s.buffer,
        });
    }
    return out;
}

/** Duration of the last `#EXTINF` in an HLS media playlist, or null. */
export function lastExtinfSeconds(playlist: string): number | null {
    let last: number | null = null;
    for (const match of playlist.matchAll(/^#EXTINF:([0-9.]+)/gm)) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) last = value;
    }
    return last;
}
