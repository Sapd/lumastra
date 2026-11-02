// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { computeSegmentsFromKeyframes } from '../ffmpeg-transcode.service.js';
import {
    buildGopGrid,
    gopStartSeekSeconds,
    gridIndexForTime,
    isGopModeJob,
    isGopSegmentsEligible,
    gopIneligibleReason,
    resolveGopGenerationStart,
} from './gop-grid.js';

// Irregular GOPs incl. one longer than 20 s (31.031 → 52.01) and a short burst.
const KF = [0, 3.504, 13.263, 14.014, 27.903, 31.031, 52.01, 52.6, 63.772, 71.28, 80.414, 95.012];
const TOTAL = 101.5;

describe('buildGopGrid', () => {
    it('matches computeSegmentsFromKeyframes exactly', () => {
        const grid = buildGopGrid(KF, TOTAL, 10)!;
        const durations = computeSegmentsFromKeyframes(KF, TOTAL, 10);
        expect(grid.durations).toEqual(durations);
        expect(grid.count).toBe(durations.length);
        let acc = 0;
        grid.starts.forEach((start, i) => {
            expect(start).toBeCloseTo(acc, 9);
            acc += durations[i];
        });
    });

    it('records the first keyframe index of every entry', () => {
        const grid = buildGopGrid(KF, TOTAL, 10)!;
        grid.firstKeyframe.forEach((kfIdx, n) => {
            expect(KF[kfIdx]).toBeCloseTo(grid.starts[n], 9);
        });
        // Entries are contiguous keyframe ranges.
        for (let n = 1; n < grid.count; n++) {
            expect(grid.firstKeyframe[n]).toBeGreaterThan(grid.firstKeyframe[n - 1]);
        }
    });

    it('covers a GOP longer than two grid steps with one entry', () => {
        const grid = buildGopGrid(KF, TOTAL, 10)!;
        const long = grid.starts.indexOf(31.031);
        expect(long).toBeGreaterThan(-1);
        expect(grid.durations[long]).toBeCloseTo(52.01 - 31.031, 6);
    });

    it('returns null for unusable input', () => {
        expect(buildGopGrid([], TOTAL, 10)).toBeNull();
        expect(buildGopGrid(KF, 0, 10)).toBeNull();
        expect(buildGopGrid(KF, TOTAL, 0)).toBeNull();
    });
});

describe('gridIndexForTime', () => {
    const grid = buildGopGrid(KF, TOTAL, 10)!;
    it('returns the entry containing t, boundaries belonging to the later entry', () => {
        expect(gridIndexForTime(grid, 0)).toBe(0);
        expect(gridIndexForTime(grid, -5)).toBe(0);
        for (let n = 0; n < grid.count; n++) {
            expect(gridIndexForTime(grid, grid.starts[n])).toBe(n);
            expect(gridIndexForTime(grid, grid.starts[n] + grid.durations[n] / 2)).toBe(n);
        }
        expect(gridIndexForTime(grid, TOTAL + 100)).toBe(grid.count - 1);
    });
});

describe('gopStartSeekSeconds', () => {
    const grid = buildGopGrid(KF, TOTAL, 10)!;
    it('lands strictly between the entry keyframe and the next keyframe', () => {
        for (let n = 0; n < grid.count; n++) {
            const kfIdx = grid.firstKeyframe[n];
            const t = gopStartSeekSeconds(grid, n);
            expect(t).toBeGreaterThan(KF[kfIdx]);
            const next = KF[kfIdx + 1] ?? TOTAL;
            expect(t).toBeLessThan(next);
            expect(t - KF[kfIdx]).toBeLessThanOrEqual(0.5);
        }
    });

    it('halves a short gap instead of overshooting into the next GOP', () => {
        const n = grid.starts.indexOf(52.01);
        expect(gopStartSeekSeconds(grid, n)).toBeCloseTo(52.01 + 0.59 / 2, 6);
    });
});

describe('isGopSegmentsEligible', () => {
    const base = {
        hlsAudioMode: 'demux',
        videoAction: 'copy',
        keyframes: KF,
        totalSeconds: TOTAL,
        isPreview: false,
        enabled: true,
        audioTrackCount: 1,
        hlsContainer: 'fmp4',
    };
    it('accepts demux copy with sane keyframes', () => {
        expect(isGopSegmentsEligible(base)).toBe(true);
    });
    it.each([
        ['disabled', { enabled: false }],
        ['muxed', { hlsAudioMode: 'muxed' }],
        ['transcoded video', { videoAction: 'transcode' }],
        ['preview', { isPreview: true }],
        ['no audio track', { audioTrackCount: 0 }],
        ['mpegts', { hlsContainer: 'mpegts' }],
        ['no keyframes', { keyframes: [] }],
        ['missing keyframes', { keyframes: undefined }],
        ['no duration', { totalSeconds: 0 }],
        [
            'all-intra (avg GOP < 0.5 s)',
            { keyframes: Array.from({ length: 2000 }, (_, i) => i * 0.04) },
        ],
        [
            'more than 50000 keyframes',
            { keyframes: Array.from({ length: 50001 }, (_, i) => i), totalSeconds: 50001 },
        ],
    ])('rejects %s', (_label, override) => {
        expect(isGopSegmentsEligible({ ...base, ...override })).toBe(false);
    });
});

describe('gopIneligibleReason (iOS demux copy without a grid stays demux, legacy cut)', () => {
    const base = {
        hlsAudioMode: 'demux',
        videoAction: 'copy',
        keyframes: KF,
        totalSeconds: TOTAL,
        isPreview: false,
        enabled: true,
        audioTrackCount: 1,
        hlsContainer: 'fmp4',
    };
    it('is null when the grid is usable', () => {
        expect(gopIneligibleReason(base)).toBeNull();
    });
    it.each([
        ['no_keyframes', { keyframes: [] }],
        ['gop_too_long', { keyframes: [0, 10, 20, 150, 160] }],
        [
            'too_many_keyframes',
            { keyframes: Array.from({ length: 50001 }, (_, i) => i), totalSeconds: 50001 },
        ],
    ])('names %s so the caller can log the legacy cut', (reason, override) => {
        expect(gopIneligibleReason({ ...base, ...override })).toBe(reason);
        expect(isGopSegmentsEligible({ ...base, ...override })).toBe(false);
    });
});

describe('isGopModeJob', () => {
    it('requires the config flag and keyframes', () => {
        expect(isGopModeJob({ config: { gopSegments: true } as never, keyframeData: KF })).toBe(
            true,
        );
        expect(isGopModeJob({ config: { gopSegments: true } as never, keyframeData: [] })).toBe(
            false,
        );
        expect(isGopModeJob({ config: {} as never, keyframeData: KF })).toBe(false);
    });
});

describe('resolveGopGenerationStart', () => {
    const grid = buildGopGrid(KF, TOTAL, 10)!;
    it('starts a fresh job on the entry holding the requested time', () => {
        expect(resolveGopGenerationStart(grid, { requestedSeconds: 0 })).toEqual({
            entry: 0,
            startTimeSeconds: undefined,
        });
        const at = grid.starts[3] + 1;
        const r = resolveGopGenerationStart(grid, { requestedSeconds: at });
        expect(r.entry).toBe(3);
        expect(r.startTimeSeconds).toBe(gopStartSeekSeconds(grid, 3));
    });

    it('starts a seek one entry early (audio target-1 must exist)', () => {
        expect(resolveGopGenerationStart(grid, { seekTargetEntry: 4 }).entry).toBe(3);
        expect(resolveGopGenerationStart(grid, { seekTargetEntry: 1 })).toEqual({
            entry: 0,
            startTimeSeconds: undefined,
        });
        expect(resolveGopGenerationStart(grid, { seekTargetEntry: 999 }).entry).toBe(
            grid.count - 2,
        );
    });
});

describe('grid and gate hardening', () => {
    it('rejects a source whose first keyframe is not at the start', () => {
        expect(buildGopGrid([2, 12, 24], 30, 10)).toBeNull();
        expect(
            isGopSegmentsEligible({
                enabled: true,
                hlsAudioMode: 'demux',
                videoAction: 'copy',
                audioTrackCount: 1,
                keyframes: [2, 12, 24],
                totalSeconds: 30,
            }),
        ).toBe(false);
    });

    it('rejects a GOP longer than 60 s (an entry would be held back for minutes)', () => {
        const base = {
            enabled: true,
            hlsAudioMode: 'demux',
            videoAction: 'copy',
            audioTrackCount: 1,
            totalSeconds: 200,
        };
        expect(isGopSegmentsEligible({ ...base, keyframes: [0, 10, 20, 150, 160] })).toBe(false);
        expect(isGopSegmentsEligible({ ...base, keyframes: [0, 10, 20] })).toBe(false); // 180 s tail
        expect(
            isGopSegmentsEligible({
                ...base,
                keyframes: Array.from({ length: 20 }, (_, i) => i * 10),
            }),
        ).toBe(true);
    });

    it('never seeks past the end of the file from the last keyframe', () => {
        const grid = buildGopGrid([0, 12, 25, 99.8], 100, 10)!;
        const last = grid.count - 1;
        expect(grid.starts[last]).toBe(99.8);
        const t = gopStartSeekSeconds(grid, last);
        expect(t).toBeGreaterThan(99.8);
        expect(t).toBeLessThan(100);
    });
});
