// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import {
    HLS_TAIL_MERGE_SECONDS,
    isPastProducedEnd,
    uniformSegmentCount,
    uniformSegmentDuration,
} from './hls-segment-grid';

function durations(total: number, segment: number): number[] {
    return Array.from({ length: uniformSegmentCount(total, segment) }, (_v, i) =>
        uniformSegmentDuration(i, total, segment),
    );
}

describe('uniform HLS segment grid', () => {
    it('folds a 0.021 s remainder into the previous segment', () => {
        expect(uniformSegmentCount(12.021, 6)).toBe(2);
        const d = durations(12.021, 6);
        expect(d[0]).toBe(6);
        expect(d[1]).toBeCloseTo(6.021, 9);
    });

    it('an exact multiple has no remainder entry', () => {
        expect(durations(12, 6)).toEqual([6, 6]);
        expect(durations(6, 6)).toEqual([6]);
    });

    it('a remainder just under one segment keeps its own entry', () => {
        const d = durations(17.99, 6);
        expect(d).toHaveLength(3);
        expect(d[2]).toBeCloseTo(5.99, 9);
    });

    it('keeps a remainder at the threshold, folds one just below it', () => {
        expect(uniformSegmentCount(12 + HLS_TAIL_MERGE_SECONDS, 6)).toBe(3);
        expect(uniformSegmentCount(12 + HLS_TAIL_MERGE_SECONDS - 0.001, 6)).toBe(2);
    });

    it('float noise past a boundary does not add an entry', () => {
        expect(durations(6.000000000000001, 6)).toHaveLength(1);
        expect(uniformSegmentCount(0.1 + 0.2 + 5.7, 6)).toBe(1);
    });

    it('a timeline shorter than one segment, even shorter than the threshold, is one entry', () => {
        expect(durations(3, 6)).toEqual([3]);
        expect(durations(0.2, 6)).toEqual([0.2]);
    });

    it('the durations always add up to the timeline', () => {
        for (const total of [12.021, 12, 17.99, 18.3, 3, 7262.042]) {
            const sum = durations(total, 6).reduce((a, b) => a + b, 0);
            expect(sum).toBeCloseTo(total, 6);
        }
    });

    it('no duration is ever below 1 ms or above segment + threshold', () => {
        for (const total of [0.0001, 6.0004, 12.499, 12.5, 100.25]) {
            for (const d of durations(total, 6)) {
                expect(d).toBeGreaterThanOrEqual(0.001);
                expect(d).toBeLessThan(6 + HLS_TAIL_MERGE_SECONDS);
            }
        }
    });

    it('invalid input yields an empty grid', () => {
        for (const [t, s] of [
            [0, 6],
            [-1, 6],
            [Number.NaN, 6],
            [Number.POSITIVE_INFINITY, 6],
            [12, 0],
            [12, Number.NaN],
        ]) {
            expect(uniformSegmentCount(t, s)).toBe(0);
        }
    });
});

describe('isPastProducedEnd', () => {
    const manifest = (files: number[], ended: boolean): string =>
        [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MAP:URI="init_1.mp4"',
            ...files.flatMap((i) => [
                '#EXTINF:6.000000,',
                `#EXT-X-PROGRAM-DATE-TIME:2026-10-06T16:33:07.591+0000`,
                `segment_${String(i).padStart(5, '0')}.m4s`,
            ]),
            ...(ended ? ['#EXT-X-ENDLIST'] : []),
            '',
        ].join('\n');

    it('closed one short of the grid: the last grid entry is past the end', () => {
        expect(isPastProducedEnd(manifest([0, 1], true), 2, 3)).toBe(true);
    });

    it('still being written: not past the end', () => {
        expect(isPastProducedEnd(manifest([0, 1], false), 2, 3)).toBe(false);
    });

    it('stopped well before the end (ENDLIST from a graceful kill): not past the end', () => {
        expect(isPastProducedEnd(manifest([0, 1], true), 2, 10)).toBe(false);
    });

    it('a produced segment is never past the end', () => {
        expect(isPastProducedEnd(manifest([0, 1, 2], true), 2, 3)).toBe(false);
    });

    it('works with absolute numbering after a seek and with .ts segments', () => {
        expect(isPastProducedEnd(manifest([500, 501], true), 502, 503)).toBe(true);
        expect(
            isPastProducedEnd('#EXTM3U\n#EXTINF:6,\nsegment_00007.ts\n#EXT-X-ENDLIST\n', 8, 9),
        ).toBe(true);
    });

    it('an empty or garbage manifest is not past the end', () => {
        expect(isPastProducedEnd('', 2, 3)).toBe(false);
        expect(isPastProducedEnd('#EXTM3U\n#EXT-X-ENDLIST\n', 2, 3)).toBe(false);
    });
});
