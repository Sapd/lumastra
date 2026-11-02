// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * chapter.test.ts — unit tests for the chapter-derived detectors.
 *
 * Two detectors share this module: `chapter-title` (a chapter whose title
 * matches a mode pattern) and `chapter-mark` (the last authored boundary,
 * read positionally). The interesting cases are the interaction between them
 * and the acceptance bounds of the mark detector, since a mark accepted too
 * eagerly produces a confident wrong Outro — exactly what it exists to fix.
 */

import { describe, it, expect } from 'vitest';
import {
    analyzeChapters,
    findLastMarkOutro,
    findMatchingChapter,
    DEFAULT_CHAPTER_CONFIG,
    DEFAULT_OUTRO_MIN_START_FRACTION,
    type ChapterAnalyzerConfig,
} from './chapter.js';
import type { ChapterInput } from './types.js';

// Drifting Clouds S03E12: file duration 2832.672 s, chapters titled with
// timecodes by the Bluray ripper, credits starting at the final mark.
const S03E12_DURATION_MS = 2832672;
const S03E12_LAST_MARK_MS = 2789412;

function chapter(startTimeMs: number, endTimeMs: number, title: string | null): ChapterInput {
    return { index: 0, title, startTimeMs, endTimeMs };
}

/** Timecode-titled chapter list — the shape that made title matching useless. */
function s03e12Chapters(): ChapterInput[] {
    return [
        chapter(0, 402402, '00:00:00.000'),
        chapter(402402, 1013012, '00:06:42.402'),
        chapter(1013012, 1789788, '00:16:53.012'),
        chapter(1789788, 2413036, '00:29:49.788'),
        chapter(2413036, S03E12_LAST_MARK_MS, '00:40:13.036'),
        chapter(S03E12_LAST_MARK_MS, S03E12_DURATION_MS, '00:46:29.412'),
    ].map((c, index) => ({ ...c, index }));
}

describe('findMatchingChapter', () => {
    it('reports title matches under the chapter-title method', () => {
        const chapters = [
            chapter(0, 2700000, 'Episode'),
            chapter(2700000, S03E12_DURATION_MS, 'End Credits'),
        ];

        const segment = findMatchingChapter(chapters, S03E12_DURATION_MS, {
            type: 'Outro',
            pattern: DEFAULT_CHAPTER_CONFIG.creditsPattern,
            minDuration: DEFAULT_CHAPTER_CONFIG.minDuration,
            maxDuration: DEFAULT_CHAPTER_CONFIG.maxCreditsDuration,
            reversed: true,
        });

        expect(segment).not.toBeNull();
        expect(segment?.method).toBe('chapter-title');
        expect(segment?.startTime).toBe(2700);
    });
});

describe('findLastMarkOutro', () => {
    it('derives the credits start from the last untitled mark (Drifting Clouds S03E12)', () => {
        const segment = findLastMarkOutro(s03e12Chapters(), S03E12_DURATION_MS);

        expect(segment).toEqual({
            type: 'Outro',
            startTime: 2789.412,
            endTime: 2832.672,
            method: 'chapter-mark',
            confidence: 0.6,
        });
    });

    it('returns nothing for a single-chapter file', () => {
        const chapters = [chapter(0, S03E12_DURATION_MS, 'Chapter 1')];
        expect(findLastMarkOutro(chapters, S03E12_DURATION_MS)).toBeNull();
    });

    it('accepts a generic final chapter label (Star Harbor: NG S03E12)', () => {
        const durationMs = 2764704;
        const chapters = [
            chapter(0, 2683764, 'Chapter 06'),
            chapter(2683764, durationMs, 'Chapter 07'),
        ];

        expect(findLastMarkOutro(chapters, durationMs)?.startTime).toBe(2683.764);
    });

    it('does not call a semantically named final chapter credits', () => {
        const chapters = [chapter(0, 2680000, 'Chapter 06'), chapter(2680000, 2764704, 'Preview')];

        expect(findLastMarkOutro(chapters, 2764704)).toBeNull();
    });

    it('does not treat a final story part as a generic chapter mark', () => {
        const chapters = [chapter(0, 2680000, 'Part I'), chapter(2680000, 2764704, 'Part II')];

        expect(findLastMarkOutro(chapters, 2764704)).toBeNull();
    });

    it('returns nothing when there are no chapters at all', () => {
        expect(findLastMarkOutro([], S03E12_DURATION_MS)).toBeNull();
    });

    it('returns nothing when the duration is unknown', () => {
        expect(findLastMarkOutro(s03e12Chapters(), 0)).toBeNull();
    });

    it('rejects a mark that sits too early in the runtime', () => {
        // 1100/1440 = 0.764 — inside the length bounds, outside the position bound.
        const chapters = [
            chapter(0, 1100000, 'Chapter 01'),
            chapter(1100000, 1440000, 'Chapter 02'),
        ];
        expect(findLastMarkOutro(chapters, 1440000)).toBeNull();
    });

    it('honours an overridden outroMinStartFraction', () => {
        const chapters = [
            chapter(0, 1100000, 'Chapter 01'),
            chapter(1100000, 1440000, 'Chapter 02'),
        ];
        const config: ChapterAnalyzerConfig = {
            ...DEFAULT_CHAPTER_CONFIG,
            outroMinStartFraction: 0.5,
        };

        const segment = findLastMarkOutro(chapters, 1440000, config);
        expect(segment?.startTime).toBe(1100);
        expect(segment?.endTime).toBe(1440);
    });

    it('rejects a tail shorter than minDuration', () => {
        const chapters = [chapter(0, 1430000, 'A'), chapter(1430000, 1440000, 'B')];
        expect(findLastMarkOutro(chapters, 1440000)).toBeNull();
    });

    it('rejects a tail longer than maxCreditsDuration', () => {
        // 800 s of tail at 84 % of runtime: positionally fine, far too long to be credits.
        const chapters = [chapter(0, 4200000, 'A'), chapter(4200000, 5000000, 'B')];
        expect(findLastMarkOutro(chapters, 5000000)).toBeNull();
    });

    it('rejects a mark at or past the file duration', () => {
        const chapters = [chapter(0, 1440000, 'A'), chapter(1440000, 1440000, 'B')];
        expect(findLastMarkOutro(chapters, 1440000)).toBeNull();
    });

    it('uses the latest mark regardless of array order', () => {
        const ordered = s03e12Chapters();
        const shuffled = [ordered[5], ordered[0], ordered[3], ordered[1], ordered[4], ordered[2]];

        expect(findLastMarkOutro(shuffled, S03E12_DURATION_MS)?.startTime).toBe(2789.412);
    });

    it('defaults the position bound to 0.80', () => {
        expect(DEFAULT_OUTRO_MIN_START_FRACTION).toBe(0.8);
    });
});

describe('analyzeChapters', () => {
    it('emits the mark Outro when no title matched', () => {
        const results = analyzeChapters(s03e12Chapters(), S03E12_DURATION_MS);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            type: 'Outro',
            startTime: 2789.412,
            endTime: 2832.672,
            method: 'chapter-mark',
        });
    });

    it('suppresses the mark Outro when a title-matched Outro exists', () => {
        const chapters = [
            chapter(0, 2700000, '00:00:00.000'),
            chapter(2700000, S03E12_LAST_MARK_MS, 'End Credits'),
            chapter(S03E12_LAST_MARK_MS, S03E12_DURATION_MS, '00:46:29.412'),
        ];

        const results = analyzeChapters(chapters, S03E12_DURATION_MS);
        const outros = results.filter((s) => s.type === 'Outro');

        expect(outros).toHaveLength(1);
        expect(outros[0].method).toBe('chapter-title');
        expect(outros[0].startTime).toBe(2700);
    });

    it('still emits the mark Outro alongside a title-matched Intro', () => {
        const chapters = [
            chapter(0, 90000, 'Opening'),
            chapter(90000, S03E12_LAST_MARK_MS, '00:01:30.000'),
            chapter(S03E12_LAST_MARK_MS, S03E12_DURATION_MS, '00:46:29.412'),
        ];

        const results = analyzeChapters(chapters, S03E12_DURATION_MS);

        expect(results.map((s) => s.method)).toEqual(['chapter-title', 'chapter-mark']);
        expect(results[0].type).toBe('Intro');
        expect(results[1].type).toBe('Outro');
    });

    it('returns nothing for a single-chapter file', () => {
        const chapters = [chapter(0, S03E12_DURATION_MS, '00:00:00.000')];
        expect(analyzeChapters(chapters, S03E12_DURATION_MS)).toEqual([]);
    });

    it('returns nothing without chapters or duration', () => {
        expect(analyzeChapters([], S03E12_DURATION_MS)).toEqual([]);
        expect(analyzeChapters(s03e12Chapters(), 0)).toEqual([]);
    });
});
