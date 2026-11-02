// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChapterInput } from './types.js';

/** Default `snapToleranceSec`: how far a derived boundary may move to reach a mark. */
export const DEFAULT_SNAP_TOLERANCE_SEC = 10;

export interface SnapResult {
    /** Seconds. The snapped boundary, or the input when nothing was in range. */
    time: number;
    snapped: boolean;
}

/**
 * Pull an audio- or luma-derived boundary onto the nearest authored chapter
 * mark, when one is close enough that they plainly describe the same cut.
 *
 * A fingerprint boundary is quantized to ~124 ms of audio and a blackframe
 * boundary to a 4 s bucket; a chapter mark is frame-exact and was authored by
 * someone who watched the cut. Where both exist within a few seconds of each
 * other, the mark is the better answer — but only the *nearest* one, because
 * snapping to a distant mark would move the boundary onto a different cut
 * entirely rather than refine this one.
 *
 * Ties break toward the EARLIER mark: an Outro that starts a moment early
 * costs a viewer nothing, while one that starts late clips content the
 * detector was asked to preserve.
 *
 * Takes and returns SECONDS. ChapterInput carries milliseconds; the
 * conversion happens here so no caller has to.
 */
export function snapToChapterMark(
    timeSec: number,
    chapters: ChapterInput[],
    toleranceSec: number = DEFAULT_SNAP_TOLERANCE_SEC,
): SnapResult {
    if (!Number.isFinite(timeSec)) return { time: timeSec, snapped: false };
    if (!Number.isFinite(toleranceSec) || toleranceSec < 0) {
        return { time: timeSec, snapped: false };
    }

    let bestSec: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const chapter of chapters) {
        if (!Number.isFinite(chapter.startTimeMs)) continue;
        const markSec = chapter.startTimeMs / 1000;
        const distance = Math.abs(markSec - timeSec);
        if (distance > toleranceSec) continue;
        // Chapter order is not a contract, so the earlier-wins tie-break is
        // decided by comparing marks, not by relying on iteration order.
        const isCloser = distance < bestDistance;
        const isEarlierTie = distance === bestDistance && bestSec !== null && markSec < bestSec;
        if (isCloser || isEarlierTie) {
            bestDistance = distance;
            bestSec = markSec;
        }
    }

    if (bestSec === null) return { time: timeSec, snapped: false };
    return { time: bestSec, snapped: true };
}
