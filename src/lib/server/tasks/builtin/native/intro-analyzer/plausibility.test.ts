// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * plausibility.ts — unit tests.
 *
 * The anchor case is Drifting Clouds S03E12 (file duration 2832.672 s): blackframe
 * reported `Outro 2632.672 → 2832.672` because its backward walk ran out of
 * search window inside a night exterior, while the mkv's untitled chapter mark
 * at 2789.412 s is the real credits start. The gate must reject the first and
 * accept the second on identical inputs.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    checkPlausibility,
    filterPlausible,
    type PlausibilityConfig,
    type PlausibilityContext,
    type PlausibilityRejection,
    type PlausibilityVerdict,
} from './plausibility.js';
import type { DetectedSegment, DetectedSegmentType, DetectionMethod } from './types.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** Drifting Clouds S03E12, as measured on prod. */
const BB_DURATION = 2832.672;
const BB_BLACKFRAME_START = 2632.672;
const BB_CHAPTER_MARK_START = 2789.412;

function makeConfig(overrides: Partial<PlausibilityConfig> = {}): PlausibilityConfig {
    return {
        minSegmentDuration: 15,
        maxIntroDuration: 120,
        introWindowMaxSec: 600,
        maxPlausibleCreditsDuration: 90,
        maxPlausibleMovieCreditsDuration: 900,
        outroMinStartFraction: 0.8,
        ...overrides,
    };
}

function makeContext(overrides: Partial<PlausibilityContext> = {}): PlausibilityContext {
    return { durationSeconds: BB_DURATION, isMovie: false, ...overrides };
}

function makeSegment(
    startTime: number,
    endTime: number,
    type: DetectedSegmentType = 'Outro',
    method: DetectionMethod = 'blackframe',
): DetectedSegment {
    return { type, startTime, endTime, method };
}

/** Narrow a verdict to its rejection branch, failing loudly if it was accepted. */
function expectRejected(verdict: PlausibilityVerdict): PlausibilityRejection {
    if (verdict.ok) throw new Error('expected the segment to be rejected, but it passed the gate');
    return verdict;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('checkPlausibility — the Drifting Clouds case', () => {
    it('rejects the blackframe window-edge Outro (200s of "credits")', () => {
        const verdict = checkPlausibility(
            makeSegment(BB_BLACKFRAME_START, BB_DURATION),
            makeContext(),
            makeConfig(),
        );

        const rejection = expectRejected(verdict);
        expect(rejection.rule).toBe('outro-too-long');
        expect(rejection.detail).toContain('maxPlausibleCreditsDuration');
    });

    it('accepts the chapter-mark Outro (43.26s) on the same file', () => {
        const verdict = checkPlausibility(
            makeSegment(BB_CHAPTER_MARK_START, BB_DURATION, 'Outro', 'chapter-mark'),
            makeContext(),
            makeConfig(),
        );

        expect(verdict.ok).toBe(true);
    });
});

describe('checkPlausibility — the Outro start-fraction interaction', () => {
    // A 22-minute episode. 0.80 of 1320s leaves 264s, so maxPlausibleCreditsDuration
    // is unreachable here at any setting above 264 — this is the interaction the
    // derived cap exists to make visible.
    const SHORT_EPISODE = 1320;

    it('binds at (1 - fraction) x runtime, not at the configured cap', () => {
        const verdict = checkPlausibility(
            makeSegment(SHORT_EPISODE - 280, SHORT_EPISODE),
            makeContext({ durationSeconds: SHORT_EPISODE }),
            makeConfig({ maxPlausibleCreditsDuration: 300 }),
        );

        const rejection = expectRejected(verdict);
        expect(rejection.rule).toBe('outro-too-long');
        // The 300s setting is dead config at this runtime; the detail must say so.
        expect(rejection.detail).toContain('start fraction');
        expect(rejection.detail).toContain('264s');
    });

    it('accepts an Outro just inside the derived 264s cap', () => {
        const verdict = checkPlausibility(
            makeSegment(SHORT_EPISODE - 260, SHORT_EPISODE),
            makeContext({ durationSeconds: SHORT_EPISODE }),
            makeConfig({ maxPlausibleCreditsDuration: 300 }),
        );

        expect(verdict.ok).toBe(true);
    });

    it('rejects a mid-file Outro even when its length alone would pass', () => {
        // 264s long — exactly the derived cap — but starting at 100s, i.e. 7.6%
        // into the episode. Folding the position rule into the cap catches this;
        // a bare 20%-of-runtime length cap would not.
        const verdict = checkPlausibility(
            makeSegment(100, 364),
            makeContext({ durationSeconds: SHORT_EPISODE }),
            makeConfig({ maxPlausibleCreditsDuration: 300 }),
        );

        expect(expectRejected(verdict).rule).toBe('outro-too-long');
    });
});

describe('checkPlausibility — movies', () => {
    const MOVIE_DURATION = 7200;

    it('accepts an 8-minute credit roll on a movie', () => {
        const verdict = checkPlausibility(
            makeSegment(MOVIE_DURATION - 480, MOVIE_DURATION),
            makeContext({ durationSeconds: MOVIE_DURATION, isMovie: true }),
            makeConfig(),
        );

        expect(verdict.ok).toBe(true);
    });

    it('rejects the same 480s Outro when the item is an episode', () => {
        const verdict = checkPlausibility(
            makeSegment(MOVIE_DURATION - 480, MOVIE_DURATION),
            makeContext({ durationSeconds: MOVIE_DURATION, isMovie: false }),
            makeConfig(),
        );

        expect(expectRejected(verdict).rule).toBe('outro-too-long');
    });

    it('still enforces the movie credits bound', () => {
        const verdict = checkPlausibility(
            makeSegment(MOVIE_DURATION - 1200, MOVIE_DURATION),
            makeContext({ durationSeconds: MOVIE_DURATION, isMovie: true }),
            makeConfig(),
        );

        const rejection = expectRejected(verdict);
        expect(rejection.rule).toBe('outro-too-long');
        expect(rejection.detail).toContain('maxPlausibleMovieCreditsDuration');
    });
});

describe('checkPlausibility — generic bounds', () => {
    it('rejects an inverted segment', () => {
        const verdict = checkPlausibility(makeSegment(1320, 1200), makeContext(), makeConfig());
        expect(expectRejected(verdict).rule).toBe('non-positive-duration');
    });

    it('rejects a zero-length segment', () => {
        const verdict = checkPlausibility(makeSegment(1000, 1000), makeContext(), makeConfig());
        expect(expectRejected(verdict).rule).toBe('non-positive-duration');
    });

    it('rejects a segment ending past the file duration', () => {
        const verdict = checkPlausibility(
            makeSegment(BB_DURATION - 60, BB_DURATION + 30),
            makeContext(),
            makeConfig(),
        );

        const rejection = expectRejected(verdict);
        expect(rejection.rule).toBe('end-past-duration');
        expect(rejection.detail).toContain('2832.672s');
    });

    it('tolerates float32 slop of less than the epsilon past the duration', () => {
        const verdict = checkPlausibility(
            makeSegment(1290, 1320.4, 'Preview', 'anime-synth'),
            makeContext({ durationSeconds: 1320 }),
            makeConfig(),
        );

        expect(verdict.ok).toBe(true);
    });

    it('rejects a negative start', () => {
        const verdict = checkPlausibility(makeSegment(-5, 100), makeContext(), makeConfig());
        expect(expectRejected(verdict).rule).toBe('negative-start');
    });

    it('rejects a segment shorter than minSegmentDuration', () => {
        const verdict = checkPlausibility(
            makeSegment(BB_DURATION - 10, BB_DURATION),
            makeContext(),
            makeConfig(),
        );

        expect(expectRejected(verdict).rule).toBe('below-min-duration');
    });

    it('rejects non-finite bounds', () => {
        const verdict = checkPlausibility(
            makeSegment(Number.NaN, BB_DURATION),
            makeContext(),
            makeConfig(),
        );

        expect(expectRejected(verdict).rule).toBe('non-finite-bounds');
    });

    it('refuses to vouch for anything when the runtime is unknown', () => {
        const verdict = checkPlausibility(
            makeSegment(100, 200),
            makeContext({ durationSeconds: 0 }),
            makeConfig(),
        );

        expect(expectRejected(verdict).rule).toBe('unknown-duration');
    });
});

describe('checkPlausibility — Intro', () => {
    it('rejects an Intro that ends outside the intro window', () => {
        const verdict = checkPlausibility(
            makeSegment(640, 700, 'Intro', 'chromaprint'),
            makeContext(),
            makeConfig(),
        );

        const rejection = expectRejected(verdict);
        expect(rejection.rule).toBe('intro-outside-window');
        expect(rejection.detail).toContain('600s');
    });

    it('rejects an Intro longer than maxIntroDuration', () => {
        const verdict = checkPlausibility(
            makeSegment(0, 200, 'Intro', 'chromaprint'),
            makeContext(),
            makeConfig(),
        );

        expect(expectRejected(verdict).rule).toBe('intro-too-long');
    });

    it('accepts a normal 90s Intro', () => {
        const verdict = checkPlausibility(
            makeSegment(30, 120, 'Intro', 'chromaprint'),
            makeContext(),
            makeConfig(),
        );

        expect(verdict.ok).toBe(true);
    });
});

describe('checkPlausibility — Recap / Preview / Commercial are bounds-only', () => {
    it.each<DetectedSegmentType>(['Recap', 'Preview', 'Commercial'])(
        'accepts a long in-bounds %s with no type-specific cap',
        (type) => {
            const verdict = checkPlausibility(
                makeSegment(0, 400, type, 'chapter-title'),
                makeContext(),
                makeConfig(),
            );

            expect(verdict.ok).toBe(true);
        },
    );

    it('still applies the generic bounds to them', () => {
        const verdict = checkPlausibility(
            makeSegment(0, 10, 'Recap', 'chapter-title'),
            makeContext(),
            makeConfig(),
        );

        expect(expectRejected(verdict).rule).toBe('below-min-duration');
    });
});

describe('filterPlausible', () => {
    it('keeps plausible segments and drops the rest', () => {
        const keep = makeSegment(BB_CHAPTER_MARK_START, BB_DURATION, 'Outro', 'chapter-mark');
        const drop = makeSegment(BB_BLACKFRAME_START, BB_DURATION);
        const intro = makeSegment(30, 120, 'Intro', 'chromaprint');

        const result = filterPlausible([intro, keep, drop], makeContext(), makeConfig());

        expect(result).toEqual([intro, keep]);
    });

    it('reports every rejection to onReject with the rule that fired', () => {
        const onReject = vi.fn();
        const drop = makeSegment(BB_BLACKFRAME_START, BB_DURATION);

        const result = filterPlausible([drop], makeContext(), makeConfig(), onReject);

        expect(result).toEqual([]);
        expect(onReject).toHaveBeenCalledOnce();
        expect(onReject).toHaveBeenCalledWith(
            drop,
            expect.objectContaining({ ok: false, rule: 'outro-too-long' }),
        );
    });

    it('does not call onReject for accepted segments', () => {
        const onReject = vi.fn();
        const keep = makeSegment(BB_CHAPTER_MARK_START, BB_DURATION, 'Outro', 'chapter-mark');

        const result = filterPlausible([keep], makeContext(), makeConfig(), onReject);

        expect(result).toEqual([keep]);
        expect(onReject).not.toHaveBeenCalled();
    });

    it('drops silently-but-safely when no onReject is supplied', () => {
        const drop = makeSegment(BB_BLACKFRAME_START, BB_DURATION);

        expect(() => filterPlausible([drop], makeContext(), makeConfig())).not.toThrow();
        expect(filterPlausible([drop], makeContext(), makeConfig())).toEqual([]);
    });

    it('returns an empty array for an empty input', () => {
        expect(filterPlausible([], makeContext(), makeConfig())).toEqual([]);
    });
});

describe('manual overrides and the policy bounds', () => {
    const EPISODE = { durationSeconds: 2832.672, isMovie: false };

    it('accepts a human credit roll that exceeds the automatic bound', () => {
        // The 90s episode bound is a heuristic for detectors. An operator
        // setting a 200s outro is overruling it on purpose.
        const verdict = checkPlausibility(
            {
                type: 'Outro',
                startTime: 2632.672,
                endTime: 2832.672,
                method: 'manual',
            },
            EPISODE,
            makeConfig(),
        );
        expect(verdict.ok).toBe(true);
    });

    it('still rejects a human answer that is not a real region of the file', () => {
        for (const bad of [
            { startTime: -5, endTime: 100 },
            { startTime: 200, endTime: 200 },
            { startTime: 300, endTime: 100 },
            { startTime: 100, endTime: 99_999 },
        ]) {
            const verdict = checkPlausibility(
                { type: 'Outro', method: 'manual', ...bad },
                EPISODE,
                makeConfig(),
            );
            expect(verdict.ok).toBe(false);
        }
    });

    it('does not extend the exemption to any detector', () => {
        const verdict = checkPlausibility(
            {
                type: 'Outro',
                startTime: 2632.672,
                endTime: 2832.672,
                method: 'blackframe',
            },
            EPISODE,
            makeConfig(),
        );
        expect(verdict.ok).toBe(false);
    });
});
