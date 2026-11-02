// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formatCategoryFiltersParam, parseCategoryFiltersParam } from './category-filters';

const CHIP_KEYS = [
    'movie',
    'tv',
    'episode',
    'music',
    'book',
    'manga',
    'comic',
    'audiobook',
    'anfragen',
    'tvchannel',
    'livetv_program',
    'home_video',
    'training',
    'educational',
    'personal',
];
const KNOWN = new Set(CHIP_KEYS);

describe('category filter URL param', () => {
    it('writes the tv chip as the public series token, sorted', () => {
        expect(formatCategoryFiltersParam(['tv', 'movie'])).toBe('movie,series');
    });

    it('drops the param when nothing is selected', () => {
        expect(formatCategoryFiltersParam([])).toBeNull();
    });

    it.each(CHIP_KEYS)('round-trips the %s chip unchanged', (key) => {
        expect(parseCategoryFiltersParam(formatCategoryFiltersParam([key]), KNOWN)).toEqual([key]);
    });

    it('reads series and the internal tv token as the tv chip', () => {
        expect(parseCategoryFiltersParam('movie,series', KNOWN)).toEqual(['movie', 'tv']);
        expect(parseCategoryFiltersParam('TV', KNOWN)).toEqual(['tv']);
    });

    it('drops unknown, empty and duplicate tokens', () => {
        expect(parseCategoryFiltersParam('movie,,bogus,series,tv, movie ', KNOWN)).toEqual([
            'movie',
            'tv',
        ]);
    });

    it('returns null when the param is absent, so the persisted selection applies', () => {
        expect(parseCategoryFiltersParam(null, KNOWN)).toBeNull();
    });
});
