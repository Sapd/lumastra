// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { normalizeEpisodeTitle } from './episode-title-match.js';
import { isGenericChapterName, bestMatchAboveThreshold } from './string-similarity.js';

describe('isGenericChapterName', () => {
    it.each(['Episode N', 'Main!', 'Start:', 'Episode.51', '...', '---'])(
        'filters normalized placeholder %s',
        (title) => {
            expect(isGenericChapterName(title)).toBe(true);
        },
    );
    it.each(['星の郵便屋', 'Лунный почтальон', 'Σεληνιακό γράμμα', 'رسالة القمر'])(
        'keeps the invented content title %s',
        (title) => expect(isGenericChapterName(title)).toBe(false),
    );
    it.each(['123', '１２３', '... 42 ---', '   '])('filters a bare marker %s', (title) => {
        expect(isGenericChapterName(title)).toBe(true);
    });
    it('keeps Unicode title words and digits when folding accents', () => {
        expect(normalizeEpisodeTitle('Café 太郎 １２')).toBe('cafe 太郎 12');
        expect(normalizeEpisodeTitle('Café 花子')).not.toBe(normalizeEpisodeTitle('Café 太郎'));
    });
    it('keeps kana voicing marks and Indic vowel signs, so different titles stay different', () => {
        expect(normalizeEpisodeTitle('かが')).not.toBe(normalizeEpisodeTitle('かか'));
        expect(normalizeEpisodeTitle('ばは')).toBe('ばは');
        expect(normalizeEpisodeTitle('कि')).toBe('कि');
    });
    it('flags sequential/structural chapter labels', () => {
        for (const name of [
            'Episode',
            'Main',
            'Start',
            'Intro/Credits',
            'TBA',
            'TBD',
            'Folge 19',
            'Chapter 1',
            'chapter 12',
            'Kapitel 3',
            'Teil 2',
            'Part 4',
            'Intro',
            'Opening',
            'Credits',
            'Ending',
            'Recap',
            '00:12:33',
        ]) {
            expect(isGenericChapterName(name)).toBe(true);
        }
    });
    it('does not flag real content titles', () => {
        for (const name of [
            'Wo sind Spinellis Eltern?',
            'Die vierte Dimension',
            'The One Where Ross Finds Out',
        ]) {
            expect(isGenericChapterName(name)).toBe(false);
        }
    });
    it('treats null/empty as generic', () => {
        expect(isGenericChapterName(null)).toBe(true);
        expect(isGenericChapterName('   ')).toBe(true);
    });
});

describe('bestMatchAboveThreshold', () => {
    it('returns the match when score >= threshold', () => {
        const r = bestMatchAboveThreshold(
            'Wo sind Spinellis Eltern',
            ['Das Experiment', 'Wo sind Spinellis Eltern?', 'Die vierte Dimension'],
            0.8,
        );
        expect(r.bestIndex).toBe(1);
        expect(r.bestScore).toBeGreaterThanOrEqual(0.8);
    });
    it('returns bestIndex -1 when below threshold', () => {
        const r = bestMatchAboveThreshold('xyzzy', ['Das Experiment'], 0.8);
        expect(r.bestIndex).toBe(-1);
    });
});
