// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * resolve.test.ts — precedence and materialization rules.
 *
 * The Drifting Clouds S03E12 numbers appear throughout: file duration 2832.672 s,
 * a blackframe candidate at 2632.672 (200 s of "credits" — a search-window
 * truncation) and the untitled mkv chapter mark at 2789.412 that carries the
 * real boundary. The gate cannot separate those two (200 s is plausible for a
 * 47-minute episode); precedence can.
 */

import { describe, it, expect } from 'vitest';
import {
    METHOD_RANK,
    NON_RESOLVING_METHODS,
    compareCandidates,
    isResolvableMethod,
    pickBestCandidate,
    resolveSegments,
    type ResolveContext,
} from './resolve.js';
import type { PlausibilityConfig } from './plausibility.js';
import type { DetectedSegment } from './types.js';

const PLAUSIBILITY: PlausibilityConfig = {
    minSegmentDuration: 15,
    maxIntroDuration: 120,
    introWindowMaxSec: 600,
    maxPlausibleCreditsDuration: 300,
    maxPlausibleMovieCreditsDuration: 900,
    outroMinStartFraction: 0.8,
};

const BB_DURATION = 2832.672;
const EPISODE: ResolveContext = { durationSeconds: BB_DURATION, isMovie: false };

const BLACKFRAME_OUTRO: DetectedSegment = {
    type: 'Outro',
    startTime: 2632.672,
    endTime: BB_DURATION,
    method: 'blackframe',
    confidence: 0.35,
};

const CHAPTER_MARK_OUTRO: DetectedSegment = {
    type: 'Outro',
    startTime: 2789.412,
    endTime: BB_DURATION,
    method: 'chapter-mark',
    confidence: 0.6,
};

describe('METHOD_RANK', () => {
    it('orders evidence strongest first', () => {
        expect(METHOD_RANK.manual).toBeLessThan(METHOD_RANK['chapter-title']);
        expect(METHOD_RANK['chapter-title']).toBeLessThan(METHOD_RANK.cohort);
        expect(METHOD_RANK.cohort).toBeLessThan(METHOD_RANK.chromaprint);
        expect(METHOD_RANK.chromaprint).toBeLessThan(METHOD_RANK['chapter-mark']);
        expect(METHOD_RANK['chapter-mark']).toBeLessThan(METHOD_RANK.blackframe);
    });

    it('lets a season consensus overrule every detector it judges, but not an authored title', () => {
        // The cohort layer only speaks when an episode disagrees with its
        // siblings. If it ranked below the method that produced the outlier,
        // re-resolution would re-pick that outlier and the layer would be a
        // no-op for everything above blackframe — which is the opposite of the
        // method-agnostic property it exists to provide.
        for (const judged of ['chromaprint', 'chapter-mark', 'blackframe'] as const) {
            expect(METHOD_RANK.cohort).toBeLessThan(METHOD_RANK[judged]);
        }
        // But a genuinely long finale credit roll, authored as a chapter title,
        // must not be overridden by twelve ordinary siblings.
        expect(METHOD_RANK['chapter-title']).toBeLessThan(METHOD_RANK.cohort);
    });

    it('resolves the cohort verdict over the chromaprint outlier it rejected', () => {
        const outlier: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 200,
            endTime: BB_DURATION,
            method: 'chromaprint',
            confidence: 0.9,
        };
        const verdict: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 46,
            endTime: BB_DURATION,
            method: 'cohort',
            confidence: 0.45,
        };

        const resolved = resolveSegments([outlier, verdict], EPISODE, PLAUSIBILITY);

        expect(resolved).toHaveLength(1);
        expect(resolved[0].method).toBe('cohort');
        expect(resolved[0].startTime).toBeCloseTo(BB_DURATION - 46, 3);
    });

    it('ranks anime-synth below chapter-title', () => {
        expect(METHOD_RANK['anime-synth']).toBeGreaterThan(METHOD_RANK['chapter-title']);
    });

    it('excludes stale-manual explicitly, not by sentinel value', () => {
        expect(NON_RESOLVING_METHODS.has('stale-manual')).toBe(true);
        expect(isResolvableMethod('stale-manual')).toBe(false);
        expect(isResolvableMethod('manual')).toBe(true);
    });
});

describe('resolveSegments — precedence', () => {
    it('takes the chapter mark over the blackframe truncation for Drifting Clouds S03E12', () => {
        const resolved = resolveSegments(
            [BLACKFRAME_OUTRO, CHAPTER_MARK_OUTRO],
            EPISODE,
            PLAUSIBILITY,
        );
        expect(resolved).toHaveLength(1);
        expect(resolved[0].startTime).toBeCloseTo(2789.412, 3);
        expect(resolved[0].method).toBe('chapter-mark');
    });

    it('does not let confidence promote a candidate past a better method', () => {
        const overconfidentBlackframe: DetectedSegment = { ...BLACKFRAME_OUTRO, confidence: 0.99 };
        const timidChapterMark: DetectedSegment = { ...CHAPTER_MARK_OUTRO, confidence: 0.05 };

        const resolved = resolveSegments(
            [overconfidentBlackframe, timidChapterMark],
            EPISODE,
            PLAUSIBILITY,
        );
        expect(resolved[0].method).toBe('chapter-mark');
    });

    it('breaks ties within a method by confidence', () => {
        const low: DetectedSegment = { ...BLACKFRAME_OUTRO, startTime: 2700, confidence: 0.2 };
        const high: DetectedSegment = { ...BLACKFRAME_OUTRO, startTime: 2650, confidence: 0.8 };

        const resolved = resolveSegments([low, high], EPISODE, PLAUSIBILITY);
        expect(resolved[0].startTime).toBe(2650);
    });

    it('breaks remaining Outro ties by proximity to the end of the file', () => {
        const early: DetectedSegment = { ...BLACKFRAME_OUTRO, startTime: 2632.672 };
        const late: DetectedSegment = { ...BLACKFRAME_OUTRO, startTime: 2760 };

        const resolved = resolveSegments([early, late], EPISODE, PLAUSIBILITY);
        expect(resolved[0].startTime).toBe(2760);
    });

    it('breaks remaining Intro ties by proximity to the start of the file', () => {
        const first: DetectedSegment = {
            type: 'Intro',
            startTime: 30,
            endTime: 120,
            method: 'chromaprint',
            confidence: 0.7,
        };
        const later: DetectedSegment = { ...first, startTime: 200, endTime: 290 };

        const resolved = resolveSegments([first, later], EPISODE, PLAUSIBILITY);
        expect(resolved[0].startTime).toBe(30);
    });
});

describe('resolveSegments — non-resolving methods', () => {
    it('never materializes a stale-manual candidate, even as the only one', () => {
        const stale: DetectedSegment = { ...CHAPTER_MARK_OUTRO, method: 'stale-manual' };
        expect(resolveSegments([stale], EPISODE, PLAUSIBILITY)).toEqual([]);
    });

    it('lets a real candidate through while a stale-manual sits beside it', () => {
        const stale: DetectedSegment = {
            type: 'Outro',
            startTime: 2400,
            endTime: BB_DURATION,
            method: 'stale-manual',
        };
        const resolved = resolveSegments([stale, CHAPTER_MARK_OUTRO], EPISODE, PLAUSIBILITY);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].method).toBe('chapter-mark');
    });

    it('excludes stale-manual from pickBestCandidate too', () => {
        const stale: DetectedSegment = { ...CHAPTER_MARK_OUTRO, method: 'stale-manual' };
        expect(pickBestCandidate([stale], 'Outro')).toBeNull();
    });
});

describe('resolveSegments — plausibility is re-applied to the winner', () => {
    it('falls back to the runner-up when the winner fails a POLICY rule', () => {
        // 700 s of "credits" on a 47-minute episode: beyond both the absolute
        // episode bound and 20 % of runtime. Ranking must not launder it — but
        // `outro-too-long` is a POLICY rule, a claim about THIS candidate, not
        // about the file. The plausible chapter mark below it is untouched by
        // that verdict and is a better answer than no marker at all.
        const implausible: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 700,
            endTime: BB_DURATION,
            method: 'chapter-title',
            confidence: 0.9,
        };

        const resolved = resolveSegments([implausible, CHAPTER_MARK_OUTRO], EPISODE, PLAUSIBILITY);
        expect(resolved).toEqual([CHAPTER_MARK_OUTRO]);
    });

    it('vetoes the whole type when the winner fails a STRUCTURAL rule', () => {
        // `end-past-duration` says the segment cannot describe a real region of
        // this file. That impeaches the ITEM, not one witness — every candidate
        // shares the same runtime — so there is nothing credible to fall back
        // to and the type drops.
        const structural: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 60,
            endTime: BB_DURATION + 120,
            method: 'chapter-title',
            confidence: 0.9,
        };

        const resolved = resolveSegments([structural, CHAPTER_MARK_OUTRO], EPISODE, PLAUSIBILITY);
        expect(resolved).toEqual([]);
    });

    it('reports every discard, distinguishing a veto from a fallback', () => {
        // A silently dropped winner is indistinguishable from a detector that
        // never fired — the blind spot filterPlausible grew onReject to close.
        const tooLong: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 700,
            endTime: BB_DURATION,
            method: 'chapter-title',
            confidence: 0.9,
        };
        const seen: Array<{ rule: string; outcome: string }> = [];
        resolveSegments([tooLong, CHAPTER_MARK_OUTRO], EPISODE, PLAUSIBILITY, (_s, v, outcome) =>
            seen.push({ rule: v.rule, outcome }),
        );
        expect(seen).toEqual([{ rule: 'outro-too-long', outcome: 'fallback' }]);
    });

    it('applies the movie bound for movies', () => {
        const movie: ResolveContext = { durationSeconds: 7000, isMovie: true };
        const creditRoll: DetectedSegment = {
            type: 'Outro',
            startTime: 6500,
            endTime: 7000,
            method: 'chapter-title',
            confidence: 0.9,
        };

        expect(resolveSegments([creditRoll], movie, PLAUSIBILITY)).toHaveLength(1);
        // The same 500 s answer on an episode is rejected by the episode bound.
        expect(
            resolveSegments([creditRoll], { durationSeconds: 7000, isMovie: false }, PLAUSIBILITY),
        ).toEqual([]);
    });
});

describe('resolveSegments — Intro/Outro overlap', () => {
    const SHORT: ResolveContext = { durationSeconds: 300, isMovie: false };
    const overlappingIntro: DetectedSegment = {
        type: 'Intro',
        startTime: 140,
        endTime: 255,
        method: 'chromaprint',
        confidence: 0.7,
    };
    const overlappingOutro: DetectedSegment = {
        type: 'Outro',
        startTime: 250,
        endTime: 300,
        method: 'chapter-mark',
        confidence: 0.6,
    };

    it('drops the lower-ranked side', () => {
        const resolved = resolveSegments([overlappingIntro, overlappingOutro], SHORT, PLAUSIBILITY);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].type).toBe('Intro');
    });

    it('keeps the Outro when the two sides rank equally', () => {
        const sameRankOutro: DetectedSegment = { ...overlappingOutro, method: 'chromaprint' };
        const resolved = resolveSegments([overlappingIntro, sameRankOutro], SHORT, PLAUSIBILITY);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].type).toBe('Outro');
    });

    it('keeps both when they do not overlap', () => {
        const earlyIntro: DetectedSegment = { ...overlappingIntro, startTime: 20, endTime: 110 };
        const resolved = resolveSegments([earlyIntro, overlappingOutro], SHORT, PLAUSIBILITY);
        expect(resolved.map((segment) => segment.type)).toEqual(['Intro', 'Outro']);
    });
});

describe('resolveSegments — output shape', () => {
    it('returns at most one segment per type, ordered by start time', () => {
        const intro: DetectedSegment = {
            type: 'Intro',
            startTime: 5,
            endTime: 95,
            method: 'chapter-title',
            confidence: 0.9,
        };
        const titledOutro: DetectedSegment = {
            type: 'Outro',
            startTime: 2600,
            endTime: 2780,
            method: 'chapter-title',
            confidence: 0.9,
        };
        const preview: DetectedSegment = {
            type: 'Preview',
            startTime: 2785,
            endTime: BB_DURATION,
            method: 'anime-synth',
            confidence: 0.5,
        };

        const resolved = resolveSegments(
            [preview, BLACKFRAME_OUTRO, titledOutro, intro],
            EPISODE,
            PLAUSIBILITY,
        );
        expect(resolved.map((segment) => segment.type)).toEqual(['Intro', 'Outro', 'Preview']);
        expect(resolved[1].method).toBe('chapter-title');
    });

    it('returns an empty array for an empty candidate pool', () => {
        expect(resolveSegments([], EPISODE, PLAUSIBILITY)).toEqual([]);
    });
});

describe('compareCandidates', () => {
    it('is usable directly as an Array#sort comparator', () => {
        const sorted = [BLACKFRAME_OUTRO, CHAPTER_MARK_OUTRO].sort(compareCandidates);
        expect(sorted[0].method).toBe('chapter-mark');
    });
});

describe('resolveSegments — discard reporting reaches production', () => {
    it('names the rule and the losing candidate on a fallback', () => {
        const tooLong: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 700,
            endTime: BB_DURATION,
            method: 'chromaprint',
            confidence: 0.9,
        };
        const seen: Array<{ method: string; rule: string; outcome: string }> = [];
        const resolved = resolveSegments(
            [tooLong, CHAPTER_MARK_OUTRO],
            EPISODE,
            PLAUSIBILITY,
            (segment, verdict, outcome) =>
                seen.push({ method: segment.method, rule: verdict.rule, outcome }),
        );
        expect(seen).toEqual([
            { method: 'chromaprint', rule: 'outro-too-long', outcome: 'fallback' },
        ]);
        expect(resolved[0].method).toBe('chapter-mark');
    });

    it('reports a veto and stops, rather than walking the rest of the pool', () => {
        const structural: DetectedSegment = {
            type: 'Outro',
            startTime: BB_DURATION - 60,
            endTime: BB_DURATION + 120,
            method: 'chromaprint',
            confidence: 0.9,
        };
        const seen: string[] = [];
        resolveSegments([structural, CHAPTER_MARK_OUTRO], EPISODE, PLAUSIBILITY, (_s, v, o) =>
            seen.push(`${v.rule}:${o}`),
        );
        // exactly one report — the chapter mark is never even evaluated
        expect(seen).toEqual(['end-past-duration:veto']);
    });

    it('reports nothing when the winner is plausible', () => {
        const seen: string[] = [];
        resolveSegments([CHAPTER_MARK_OUTRO], EPISODE, PLAUSIBILITY, (_s, v) => seen.push(v.rule));
        expect(seen).toEqual([]);
    });
});
