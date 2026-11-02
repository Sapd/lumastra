// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
    buildTsQueryFromText,
    escapeLikePattern,
    buildLikePattern,
    searchNeedsTrigramThreshold,
    searchSupportsSubstringMatch,
} from './search-filter.builder.js';

describe('buildTsQueryFromText', () => {
    it('restricts every prefix token to title weight only when requested', () => {
        expect(buildTsQueryFromText('space station', 2, 'A')).toBe('space:*A & station:*A');
        expect(buildTsQueryFromText('space station')).toBe('space:* & station:*');
        expect(buildTsQueryFromText('a !', 2, 'A')).toBeNull();
    });
});

describe('escapeLikePattern', () => {
    it('escapes LIKE metacharacters with backslash', () => {
        expect(escapeLikePattern('50%')).toBe('50\\%');
        expect(escapeLikePattern('a_b')).toBe('a\\_b');
        expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
    });
    it('leaves plain text untouched', () => {
        expect(escapeLikePattern('disney')).toBe('disney');
    });
});

describe('buildLikePattern', () => {
    it('wraps the escaped query in % … %', () => {
        expect(buildLikePattern('50%')).toBe('%50\\%%');
        expect(buildLikePattern('disney')).toBe('%disney%');
    });
});

describe('searchNeedsTrigramThreshold', () => {
    it('is true when a word of length >= 3 survives', () => {
        expect(searchNeedsTrigramThreshold('hafentage')).toBe(true);
        expect(searchNeedsTrigramThreshold('abc de')).toBe(true);
    });
    it('is false for empty, null, or only sub-3-char words (trigram degenerates)', () => {
        expect(searchNeedsTrigramThreshold('')).toBe(false);
        expect(searchNeedsTrigramThreshold(null)).toBe(false);
        expect(searchNeedsTrigramThreshold('a')).toBe(false);
        expect(searchNeedsTrigramThreshold('aa')).toBe(false);
        expect(searchNeedsTrigramThreshold('ab cd')).toBe(false);
        expect(searchNeedsTrigramThreshold('  ')).toBe(false);
    });
});

describe('searchSupportsSubstringMatch', () => {
    it('is true for queries of 3+ chars (spaces count — substring match is on the whole query)', () => {
        expect(searchSupportsSubstringMatch('abc')).toBe(true);
        expect(searchSupportsSubstringMatch('ab cd')).toBe(true);
    });
    it('is false for short queries where %needle% degenerates on trigram indexes', () => {
        expect(searchSupportsSubstringMatch('aa')).toBe(false);
        expect(searchSupportsSubstringMatch(' aa ')).toBe(false);
        expect(searchSupportsSubstringMatch('')).toBe(false);
        expect(searchSupportsSubstringMatch(null)).toBe(false);
    });
});
