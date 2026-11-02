// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    chapterBoundaries,
    evenBoundaries,
    formatOffset,
    parseOffset,
    validateManualWindows,
    windowsFromBoundaries,
} from './manual-file-segments.js';

const D = 1_320_000; // 22 min

describe('windowsFromBoundaries', () => {
    it('covers the file from 0 to EOF without gaps', () => {
        expect(windowsFromBoundaries(D, [660_000])).toEqual([
            { startMs: 0, endMs: 660_000 },
            { startMs: 660_000, endMs: D },
        ]);
    });

    it('a single episode is the whole file', () => {
        expect(windowsFromBoundaries(D, [])).toEqual([{ startMs: 0, endMs: D }]);
    });
});

describe('evenBoundaries', () => {
    it('splits into equal shares', () => {
        expect(evenBoundaries(D, 2)).toEqual([660_000]);
        expect(evenBoundaries(900_000, 3)).toEqual([300_000, 600_000]);
        expect(evenBoundaries(D, 1)).toEqual([]);
    });
});

describe('chapterBoundaries', () => {
    it('snaps each even boundary to the nearest chapter start', () => {
        // Scene markers plus the real join at 11:04.
        const chapters = [0, 95_000, 664_000, 1_200_000];
        expect(chapterBoundaries(D, 2, chapters)).toEqual([664_000]);
    });

    it('keeps boundaries in order and gives each its own chapter', () => {
        // Three episodes, two chapters close to the first target only.
        const chapters = [290_000, 310_000, 900_000];
        expect(chapterBoundaries(900_000 + 300_000, 3, chapters)).toEqual([310_000, 900_000]);
    });

    it('ignores marks at the very start and past the end', () => {
        expect(chapterBoundaries(D, 2, [0, 5_000, D + 1])).toBeNull();
    });

    it('returns null when there are too few chapters', () => {
        expect(chapterBoundaries(D, 3, [600_000])).toBeNull();
    });
});

describe('validateManualWindows', () => {
    const two = windowsFromBoundaries(D, [660_000]);

    it('accepts gapless windows that cover the file', () => {
        expect(validateManualWindows(D, 2, two)).toBeNull();
    });

    it('a single episode needs no window', () => {
        expect(validateManualWindows(null, 1, null)).toBeNull();
    });

    it('several episodes need windows and a probed duration', () => {
        expect(validateManualWindows(D, 2, null)).toMatch(/window/);
        expect(validateManualWindows(null, 2, two)).toMatch(/duration/);
    });

    it('rejects a gap, an overlap, a late first start and a short window', () => {
        expect(
            validateManualWindows(D, 2, [
                { startMs: 0, endMs: 600_000 },
                { startMs: 660_000, endMs: D },
            ]),
        ).toMatch(/previous/);
        expect(
            validateManualWindows(D, 2, [
                { startMs: 0, endMs: 700_000 },
                { startMs: 660_000, endMs: D },
            ]),
        ).toMatch(/previous/);
        expect(
            validateManualWindows(D, 2, [
                { startMs: 1_000, endMs: 660_000 },
                { startMs: 660_000, endMs: D },
            ]),
        ).toMatch(/0:00/);
        expect(validateManualWindows(D, 2, windowsFromBoundaries(D, [5_000]))).toMatch(/shorter/);
    });

    it('allows the last end to be a little off the stored duration, not more', () => {
        expect(validateManualWindows(D, 2, windowsFromBoundaries(D - 900, [660_000]))).toBeNull();
        expect(validateManualWindows(D, 2, windowsFromBoundaries(D - 5_000, [660_000]))).toMatch(
            /end of the file/,
        );
    });

    it('rejects a count mismatch and fractional bounds', () => {
        expect(validateManualWindows(D, 3, two)).toMatch(/exactly one/);
        expect(validateManualWindows(D, 2, windowsFromBoundaries(D, [660_000.5]))).toMatch(/whole/);
    });
});

describe('formatOffset / parseOffset', () => {
    it('round-trips m:ss and h:mm:ss', () => {
        expect(formatOffset(664_000)).toBe('11:04');
        expect(formatOffset(3_725_000)).toBe('1:02:05');
        expect(formatOffset(664_300)).toBe('11:04.3');
        expect(parseOffset('11:04')).toBe(664_000);
        expect(parseOffset('1:02:05')).toBe(3_725_000);
        expect(parseOffset('11:04.3')).toBe(664_300);
        expect(parseOffset('90')).toBe(90_000);
    });

    it('rejects text that is not a time', () => {
        expect(parseOffset('')).toBeNull();
        expect(parseOffset('11:75')).toBeNull();
        expect(parseOffset('1:2:3:4')).toBeNull();
        expect(parseOffset('abc')).toBeNull();
        expect(parseOffset('-5')).toBeNull();
    });
});

it('preserves every millisecond through editable offsets and rejects non-finite times', () => {
    for (const ms of [1, 12, 123, 29999, 30123, 3725123]) {
        expect(parseOffset(formatOffset(ms))).toBe(ms);
    }
    for (const ms of [Number.NaN, Infinity, -Infinity]) expect(formatOffset(ms)).toBe('—');
    expect(parseOffset('9'.repeat(400))).toBeNull();
});
