// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * snap.test.ts — unit tests for chapter-mark snapping.
 *
 * The bounds matter more than the happy path: snapping too far moves a
 * boundary onto a different cut, and snapping late clips content. Both the
 * tolerance edge and the tie-break direction are pinned here.
 */

import { describe, it, expect } from 'vitest';
import { snapToChapterMark, DEFAULT_SNAP_TOLERANCE_SEC } from './snap.js';
import type { ChapterInput } from './types.js';

function marks(...startsSec: number[]): ChapterInput[] {
    return startsSec.map((startSec, index) => ({
        index,
        title: null,
        startTimeMs: startSec * 1000,
        endTimeMs: (startsSec[index + 1] ?? startSec + 60) * 1000,
    }));
}

describe('snapToChapterMark', () => {
    it('snaps to the nearest mark inside the tolerance', () => {
        expect(snapToChapterMark(2787.9, marks(0, 600, 2789.412), 10)).toEqual({
            time: 2789.412,
            snapped: true,
        });
    });

    it('prefers the nearest mark when several are in range', () => {
        expect(snapToChapterMark(104, marks(100, 106, 130), 10)).toEqual({
            time: 106,
            snapped: true,
        });
    });

    it('leaves the boundary alone when no mark is in range', () => {
        expect(snapToChapterMark(2600, marks(0, 600, 2789.412), 10)).toEqual({
            time: 2600,
            snapped: false,
        });
    });

    it('treats the tolerance as inclusive', () => {
        expect(snapToChapterMark(110, marks(100), 10)).toEqual({ time: 100, snapped: true });
        expect(snapToChapterMark(110, marks(100), 9.99)).toEqual({ time: 110, snapped: false });
    });

    it('breaks ties toward the earlier mark', () => {
        expect(snapToChapterMark(110, marks(100, 120), 10)).toEqual({ time: 100, snapped: true });
    });

    it('breaks ties toward the earlier mark regardless of chapter order', () => {
        const unordered = [...marks(100, 120)].reverse();
        expect(snapToChapterMark(110, unordered, 10)).toEqual({ time: 100, snapped: true });
    });

    it('reports snapped for a boundary already sitting on a mark', () => {
        expect(snapToChapterMark(100, marks(100, 200), 10)).toEqual({ time: 100, snapped: true });
    });

    it('handles an empty chapter list', () => {
        expect(snapToChapterMark(42, [], 10)).toEqual({ time: 42, snapped: false });
    });

    it('passes non-finite input through untouched', () => {
        expect(snapToChapterMark(Number.NaN, marks(100), 10).snapped).toBe(false);
        expect(snapToChapterMark(Number.POSITIVE_INFINITY, marks(100), 10).snapped).toBe(false);
    });

    it('ignores a non-finite chapter start', () => {
        const broken: ChapterInput[] = [
            { index: 0, title: null, startTimeMs: Number.NaN, endTimeMs: 1000 },
            { index: 1, title: null, startTimeMs: 105000, endTimeMs: 200000 },
        ];
        expect(snapToChapterMark(110, broken, 10)).toEqual({ time: 105, snapped: true });
    });

    it('refuses to snap under a non-finite or negative tolerance', () => {
        expect(snapToChapterMark(110, marks(100), Number.NaN).snapped).toBe(false);
        expect(snapToChapterMark(110, marks(100), -1).snapped).toBe(false);
    });

    it('snaps only exact hits at zero tolerance', () => {
        expect(snapToChapterMark(100, marks(100), 0)).toEqual({ time: 100, snapped: true });
        expect(snapToChapterMark(100.5, marks(100), 0)).toEqual({ time: 100.5, snapped: false });
    });

    it('defaults the tolerance to 10 s', () => {
        expect(DEFAULT_SNAP_TOLERANCE_SEC).toBe(10);
        expect(snapToChapterMark(110, marks(100))).toEqual({ time: 100, snapped: true });
    });
});
