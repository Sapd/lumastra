// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How much of the file a playback session has transcoded.
 *
 * The player's progress readout used to be the encoder's POSITION:
 * (segmentOffset + segmentsReady) / total. After a seek to 50 % it opened at
 * 50 % and could read "complete" with the first half never encoded. Coverage
 * is the union of the media ranges every generation of the session encoded:
 * a seek retires the current generation's range into `config.coveredRanges`
 * of the next one (see seekToSegment), so a seek back over encoded ground does
 * not count twice and a skipped stretch does not count at all. Living in the
 * config, the ranges are persisted with the job row and survive a restore.
 *
 * "Transcoded" is not "still on disk": with DELETE_SEGMENTS the sliding
 * window removes segments behind the playhead, and retained generations are
 * retired after FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS.
 */

import { producedMediaSeconds } from './transcode-throttle.js';
import type { TranscodeJob } from './types.js';

export type MediaRange = [start: number, end: number];

/** Sorted union of ranges; empty and inverted ranges are dropped. */
export function mergeRanges(ranges: readonly MediaRange[]): MediaRange[] {
    const sorted = ranges
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
        .map(([start, end]): MediaRange => [start, end])
        .sort((a, b) => a[0] - b[0]);
    const merged: MediaRange[] = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push(range);
    }
    return merged;
}

/** The range the job's current FFmpeg run has encoded, clipped to the file. */
export function currentGenerationRange(
    job: Pick<TranscodeJob, 'segmentOffset' | 'segmentsReady' | 'segmentDurationSeconds'>,
    totalDurationSeconds: number,
): MediaRange {
    const start = job.segmentOffset * job.segmentDurationSeconds;
    const end = producedMediaSeconds(job);
    const cap = totalDurationSeconds > 0 ? totalDurationSeconds : Infinity;
    return [Math.min(start, cap), Math.min(end, cap)];
}

/** Earlier generations' ranges plus the current one, merged. */
export function sessionCoveredRanges(
    job: Pick<TranscodeJob, 'segmentOffset' | 'segmentsReady' | 'segmentDurationSeconds'> & {
        config: { coveredRanges?: MediaRange[] };
    },
    totalDurationSeconds: number,
): MediaRange[] {
    return mergeRanges([
        ...(job.config.coveredRanges ?? []),
        currentGenerationRange(job, totalDurationSeconds),
    ]);
}

export function coveredSeconds(ranges: readonly MediaRange[]): number {
    return ranges.reduce((sum, [start, end]) => sum + (end - start), 0);
}

/**
 * Whole percent covered. Rounded DOWN so 100 means the whole file really is
 * transcoded — a session missing its last few seconds stays at 99.
 */
export function coveragePercent(covered: number, totalDurationSeconds: number): number {
    if (!(totalDurationSeconds > 0)) return 0;
    // Tolerate float noise in the ranges' arithmetic at the very end.
    if (covered >= totalDurationSeconds - 0.001) return 100;
    return Math.min(99, Math.floor((covered / totalDurationSeconds) * 100));
}

/** Ranges as [start %, end %] of the file, one decimal, for the progress bar. */
export function rangesAsPercent(
    ranges: readonly MediaRange[],
    totalDurationSeconds: number,
): MediaRange[] {
    if (!(totalDurationSeconds > 0)) return [];
    const pct = (seconds: number): number =>
        Math.round(Math.min(100, Math.max(0, (seconds / totalDurationSeconds) * 100)) * 10) / 10;
    return ranges.map(([start, end]): MediaRange => [pct(start), pct(end)]);
}
