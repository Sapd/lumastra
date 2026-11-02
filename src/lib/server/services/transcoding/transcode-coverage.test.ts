// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    coveragePercent,
    coveredSeconds,
    currentGenerationRange,
    mergeRanges,
    rangesAsPercent,
    sessionCoveredRanges,
} from './transcode-coverage.js';

describe('mergeRanges', () => {
    it('sorts, merges overlapping and touching ranges, drops empty ones', () => {
        expect(
            mergeRanges([
                [300, 360],
                [0, 30],
                [20, 60],
                [60, 90],
                [500, 500],
                [700, 650],
            ]),
        ).toEqual([
            [0, 90],
            [300, 360],
        ]);
    });

    it('does not mutate its input', () => {
        const input: [number, number][] = [
            [0, 30],
            [10, 50],
        ];
        mergeRanges(input);
        expect(input).toEqual([
            [0, 30],
            [10, 50],
        ]);
    });
});

describe('currentGenerationRange / sessionCoveredRanges', () => {
    const job = { segmentOffset: 50, segmentsReady: 10, segmentDurationSeconds: 6 };

    it("is the current run's stretch, clipped to the file", () => {
        expect(currentGenerationRange(job, 600)).toEqual([300, 360]);
        expect(currentGenerationRange({ ...job, segmentsReady: 100 }, 600)).toEqual([300, 600]);
    });

    it('a seek back over encoded ground does not count twice', () => {
        const ranges = sessionCoveredRanges(
            { ...job, segmentOffset: 10, config: { coveredRanges: [[0, 120]] } },
            600,
        );
        expect(ranges).toEqual([[0, 120]]);
        expect(coveredSeconds(ranges)).toBe(120);
    });
});

describe('coveragePercent', () => {
    it('rounds down so 100 means really done', () => {
        expect(coveragePercent(599, 600)).toBe(99);
        expect(coveragePercent(600, 600)).toBe(100);
        expect(coveragePercent(59.9, 600)).toBe(9);
    });

    it('is 0 without a known duration', () => {
        expect(coveragePercent(60, 0)).toBe(0);
    });
});

describe('rangesAsPercent', () => {
    it('converts to one-decimal percentages of the file', () => {
        expect(
            rangesAsPercent(
                [
                    [0, 100],
                    [300, 360],
                ],
                3000,
            ),
        ).toEqual([
            [0, 3.3],
            [10, 12],
        ]);
    });
});
