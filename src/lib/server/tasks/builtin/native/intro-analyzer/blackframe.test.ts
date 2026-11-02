// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * blackframe.test.ts — unit tests for the black-frame credits detector.
 *
 * The headline case is a REGRESSION FIXTURE recorded from real media: Breaking
 * Bad S03E12 "Half Measures" (file duration 2832.672s). Running the detector's
 * exact ffmpeg invocation against that file
 *
 *     blackframe=amount=50:threshold=32   (over scale=320, fps=5)
 *
 * reports black frames continuously from the end of the file back past 42:12 —
 * the closing act is a night exterior measuring pblack 51-69, and the widest
 * non-black gap in the whole stretch is 8s against a 12s bridge tolerance. The
 * backward walk therefore never terminates on a boundary; it runs out of search
 * window. The shipped bug was reporting that window edge as the credits start,
 * 2.5 minutes before the real one (2789.412s, an untitled chapter mark).
 *
 * The fixture below stores the measured black RUNS rather than all 1222 frame
 * timestamps; the frames are re-expanded at the recorded 5fps sampling rate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDetectBlackFrames } = vi.hoisted(() => ({ mockDetectBlackFrames: vi.fn() }));
vi.mock('$lib/server/utils/ffmpeg-analysis.js', () => ({
    detectBlackFrames: mockDetectBlackFrames,
}));

import { analyzeBlackFrames, DEFAULT_BLACKFRAME_CONFIG } from './blackframe.js';
import type { BlackFrameConfig } from './blackframe.js';

/** Measured black runs, in absolute seconds, for Drifting Clouds S03E12. */
const BB_S03E12_BLACK_RUNS: Array<[number, number]> = [
    [2532.67, 2589.07],
    [2594.67, 2606.27],
    [2609.47, 2673.27],
    [2677.27, 2706.27],
    [2709.27, 2714.87],
    [2722.87, 2740.87],
    [2744.87, 2765.87],
    [2771.07, 2771.47],
    [2775.07, 2777.27],
    [2779.47, 2780.87],
    [2784.67, 2825.27],
    [2829.67, 2832.47],
];

const BB_S03E12_DURATION = 2832.672;
/** The real credits boundary, from the file's (untitled) last chapter mark. */
const BB_S03E12_TRUE_CREDITS_START = 2789.412;
/** What the buggy detector used to report. */
const BB_S03E12_BAD_ANSWER = 2632.672;

const SAMPLE_STEP = 0.2; // fps=5

function expandRuns(
    runs: Array<[number, number]>,
): Array<{ time: number; blackPercentage: number }> {
    const frames: Array<{ time: number; blackPercentage: number }> = [];
    for (const [start, end] of runs) {
        for (let t = start; t <= end + 1e-9; t += SAMPLE_STEP) {
            frames.push({ time: Number(t.toFixed(3)), blackPercentage: 60 });
        }
    }
    return frames.sort((a, b) => a.time - b.time);
}

/** Frames covering [from, to] continuously — i.e. an unbounded dark region. */
function solidBlack(from: number, to: number): Array<{ time: number; blackPercentage: number }> {
    return expandRuns([[from, to]]);
}

const EPISODE_CONFIG: BlackFrameConfig = {
    ...DEFAULT_BLACKFRAME_CONFIG,
    maxSearchDistance: 300,
};

beforeEach(() => {
    mockDetectBlackFrames.mockReset();
});

describe('analyzeBlackFrames — window-edge abstention', () => {
    it('abstains on Drifting Clouds S03E12 instead of reporting the window edge', async () => {
        mockDetectBlackFrames.mockResolvedValue(expandRuns(BB_S03E12_BLACK_RUNS));

        const outcome = await analyzeBlackFrames('/x.mkv', BB_S03E12_DURATION, EPISODE_CONFIG);

        expect(outcome.kind).toBe('abstain');
        if (outcome.kind === 'abstain') {
            expect(outcome.reason).toBe('window-edge-truncated');
        }
    });

    it('never reports the old wrong answer under any window the fixture covers', async () => {
        mockDetectBlackFrames.mockResolvedValue(expandRuns(BB_S03E12_BLACK_RUNS));

        // The fixture was recorded over the final 300s only, so its earliest
        // entry looks like a boundary to a wider window. Windows beyond 300s
        // are untestable against it rather than passing — don't fake coverage.
        for (const maxSearchDistance of [200, 300]) {
            const outcome = await analyzeBlackFrames('/x.mkv', BB_S03E12_DURATION, {
                ...DEFAULT_BLACKFRAME_CONFIG,
                maxSearchDistance,
            });
            if (outcome.kind === 'segment') {
                expect(outcome.segment.startTime).not.toBeCloseTo(BB_S03E12_BAD_ANSWER, 1);
                // And it must never claim a boundary earlier than the truth.
                expect(outcome.segment.startTime).toBeGreaterThan(
                    BB_S03E12_TRUE_CREDITS_START - 60,
                );
            }
        }
    });

    it('abstains when the dark region fills the entire search window', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1500, duration));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('abstain');
        if (outcome.kind === 'abstain') expect(outcome.reason).toBe('window-edge-truncated');
    });

    it('keeps window-edge abstention even when the unbounded tail is 100% black', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(
            solidBlack(1500, duration).map((frame) => ({ ...frame, blackPercentage: 100 })),
        );

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome).toEqual({ kind: 'abstain', reason: 'window-edge-truncated' });
    });

    it('does not accept a branded-tail fade that starts at the search-window edge', async () => {
        const duration = 1800;
        const frames = [
            { time: 1500, blackPercentage: 80 },
            ...expandRuns([[1500.2, 1760]]).map((frame) => ({ ...frame, blackPercentage: 92 })),
            ...expandRuns([[1760, duration]]).map((frame) => ({ ...frame, blackPercentage: 10 })),
        ];
        mockDetectBlackFrames.mockResolvedValue(frames.sort((a, b) => a.time - b.time));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome).toEqual({ kind: 'abstain', reason: 'window-edge-truncated' });
    });

    it('abstains when the run starts within the edge margin, not just exactly at the edge', async () => {
        // searchStart = 1800 - 300 = 1500. Margin = precision * (maxGapBuckets + 1) = 16s.
        // A run beginning at 1510 is 10s in — still inside the margin, still unbounded.
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1510, duration));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('abstain');
    });
});

describe('analyzeBlackFrames — genuine detections still work', () => {
    it('anchors a dark-scene tail at its sustained near-total-black credits cut', async () => {
        // Production regression: S01E01 of A Keeper of the Seven Lanterns is
        // already 85–95% black before the real credits cut at ~2388s. The
        // legacy 50% walk therefore starts in the scene; the 100% plateau is
        // the reliable boundary and sits within two seconds of the annotated
        // 39:50 reference.
        const duration = 2515.488;
        mockDetectBlackFrames.mockResolvedValue(
            expandRuns([
                [2300, duration],
                [2388, 2444],
            ]).map((frame) => ({
                ...frame,
                blackPercentage: frame.time >= 2388 && frame.time <= 2444 ? 100 : 60,
            })),
        );

        const outcome = await analyzeBlackFrames('/s01e01.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.startTime).toBeCloseTo(2388, 1);
        }
    });

    it('does not borrow a high-black title card before the terminal credits run', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(
            [
                ...solidBlack(1680, 1700).map((frame) => ({ ...frame, blackPercentage: 100 })),
                ...solidBlack(1740, duration).map((frame) => ({ ...frame, blackPercentage: 60 })),
            ].sort((a, b) => a.time - b.time),
        );

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.startTime).toBeGreaterThanOrEqual(1736);
            expect(outcome.segment.startTime).toBeLessThanOrEqual(1744);
        }
    });

    it('does not turn one dark flash per bucket into terminal credits', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(
            Array.from({ length: 30 }, (_, index) => ({
                time: 1680 + index * 4,
                blackPercentage: 60,
            })),
        );

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome).toEqual({ kind: 'abstain', reason: 'no-detection' });
    });

    it('includes a short bright network-logo tail after a sustained credits fade', async () => {
        const duration = 2764;
        const frames = [
            ...expandRuns([[2674, 2675]]).map((frame) => ({ ...frame, blackPercentage: 80 })),
            ...expandRuns([[2675, 2682]]).map((frame) => ({ ...frame, blackPercentage: 82 })),
            ...expandRuns([[2682, 2732]]).map((frame) => ({ ...frame, blackPercentage: 92 })),
            ...expandRuns([[2732, duration]]).map((frame) => ({ ...frame, blackPercentage: 10 })),
        ];
        mockDetectBlackFrames.mockResolvedValue(frames.sort((a, b) => a.time - b.time));

        const outcome = await analyzeBlackFrames('/tng-s03e12.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.startTime).toBeCloseTo(2682, 1);
            expect(outcome.segment.endTime).toBe(duration);
        }
    });

    it.each([
        [2062.336, 1935],
        [2201.088, 2075],
        [1842.624, 1718],
    ])('keeps the frame-accurate high-black transition at %ds', async (duration, creditsStart) => {
        mockDetectBlackFrames.mockResolvedValue(
            expandRuns([[creditsStart - 40, duration]]).map((frame) => ({
                ...frame,
                blackPercentage: frame.time >= creditsStart ? 99 : 70,
            })),
        );

        const outcome = await analyzeBlackFrames('/episode.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.startTime).toBeCloseTo(creditsStart, 1);
        }
    });

    it('returns a bounded credit roll that ends well clear of the window edge', async () => {
        const duration = 1800;
        // Credits occupy the last 60s; everything before 1740 is bright.
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1740, duration));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.type).toBe('Outro');
            expect(outcome.segment.method).toBe('blackframe');
            expect(outcome.segment.endTime).toBe(duration);
            expect(outcome.segment.startTime).toBeGreaterThanOrEqual(1736);
            expect(outcome.segment.startTime).toBeLessThanOrEqual(1744);
        }
    });

    it('carries a low confidence — luma evidence must not outrank real signals', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1740, duration));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.confidence).toBeLessThan(0.5);
        }
    });

    it('abstains when ffmpeg reports no black frames at all', async () => {
        mockDetectBlackFrames.mockResolvedValue([]);

        const outcome = await analyzeBlackFrames('/x.mkv', 1800, EPISODE_CONFIG);

        expect(outcome.kind).toBe('abstain');
        if (outcome.kind === 'abstain') expect(outcome.reason).toBe('no-detection');
    });

    it('abstains on unusable input without shelling ffmpeg', async () => {
        const outcome = await analyzeBlackFrames('/x.mkv', 10, EPISODE_CONFIG);

        expect(outcome.kind).toBe('abstain');
        if (outcome.kind === 'abstain') expect(outcome.reason).toBe('unusable-input');
        expect(mockDetectBlackFrames).not.toHaveBeenCalled();
    });

    it('abstains when the dark run is shorter than minCreditsDuration', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1795, duration));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('abstain');
    });

    it('does not skip a rejected short terminal run to reuse an older dark scene', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(
            expandRuns([
                [1680, 1760],
                [1795, duration],
            ]),
        );

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome).toEqual({ kind: 'abstain', reason: 'no-detection' });
    });

    it('does not stretch an earlier dark scene across a bright EOF tail', async () => {
        const duration = 1800;
        // A long dark scene ends 20s before EOF. With a 12s gap tolerance it is
        // not terminal evidence and must never become a 80s Outro ending at EOF.
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1720, 1780));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome).toEqual({ kind: 'abstain', reason: 'no-detection' });
    });

    it('still bridges a short bright EOF tail within the gap tolerance', async () => {
        const duration = 1800;
        mockDetectBlackFrames.mockResolvedValue(solidBlack(1740, 1788));

        const outcome = await analyzeBlackFrames('/x.mkv', duration, EPISODE_CONFIG);

        expect(outcome.kind).toBe('segment');
        if (outcome.kind === 'segment') {
            expect(outcome.segment.startTime).toBeGreaterThanOrEqual(1736);
            expect(outcome.segment.startTime).toBeLessThanOrEqual(1744);
            expect(outcome.segment.endTime).toBe(duration);
        }
    });
});

it('preserves the explicit automatic thread override for the decoder', async () => {
    mockDetectBlackFrames.mockResolvedValue([]);
    await analyzeBlackFrames('/episode.mkv', 1800, DEFAULT_BLACKFRAME_CONFIG, 0);
    expect(mockDetectBlackFrames).toHaveBeenCalledWith(
        '/episode.mkv',
        expect.any(Number),
        1800,
        expect.objectContaining({ threads: 0 }),
    );
});

describe('bounded wall time for the actual media window', () => {
    beforeEach(() => {
        mockDetectBlackFrames.mockReset();
        mockDetectBlackFrames.mockResolvedValue([]);
    });
    it.each([
        [600, 1_200_000],
        [900, 1_800_000],
        [40, 300_000],
        [1e12, 1_800_000],
    ])(
        'allows a %ss window a finite %sms budget without changing the detector',
        async (window, timeout) => {
            const signal = new AbortController().signal;
            await analyzeBlackFrames(
                '/movie.mkv',
                window + 100,
                {
                    ...DEFAULT_BLACKFRAME_CONFIG,
                    maxSearchDistance: window,
                },
                2,
                signal,
            );
            expect(mockDetectBlackFrames).toHaveBeenCalledWith(
                '/movie.mkv',
                100,
                window + 100,
                expect.objectContaining({
                    timeout,
                    threads: 2,
                    abortSignal: signal,
                    minimumBlackPct: 0,
                }),
            );
        },
    );
    it.each([NaN, Infinity, -Infinity, 0, -1])(
        'does not spawn for invalid duration %s',
        async (duration) => {
            expect(await analyzeBlackFrames('/movie.mkv', duration)).toEqual({
                kind: 'abstain',
                reason: 'unusable-input',
            });
            expect(mockDetectBlackFrames).not.toHaveBeenCalled();
        },
    );
});
