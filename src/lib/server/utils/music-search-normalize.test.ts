// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildMusicTsQuery, normalizeMusicSearch } from './music-search-normalize.js';

describe('normalizeMusicSearch', () => {
    it.each(['Vol.100', 'Vol. 100', 'Vol 100', 'Volume 100', 'Vol100', 'vol.100', '100'])(
        'canonicalizes %s',
        (volume) => {
            expect(normalizeMusicSearch(`Night Drive Sessions ${volume}`)).toBe(
                'night drive sessions 100',
            );
        },
    );

    it.each([
        ['Night.Drive-Sessions_[Volume,003]', 'night drive sessions 3'],
        ['Night Drive Sessions Vol17', 'night drive sessions 17'],
        ['Night Drive Sessions Vol. 17', 'night drive sessions 17'],
        ['CD2 Vol 000', 'cd 2 0'],
        ['Revolver 03', 'revolver 3'],
        ['Volume Control', 'volume control'],
        ['Échos_日本 Vol03', 'échos 日本 3'],
        ['한국 ガガ Vol.2', '한국 ガガ 2'],
        ['', ''],
        ['---', ''],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeMusicSearch(input)).toBe(expected);
        expect(normalizeMusicSearch(expected)).toBe(expected);
    });

    it('keeps full numeric tokens, including single digits, with word completion', () => {
        expect(buildMusicTsQuery('Night Drive Vol 03')).toBe('night:* & drive:* & 3');
        expect(buildMusicTsQuery('10')).toBe('10');
        expect(buildMusicTsQuery('100')).toBe('100');
        expect(buildMusicTsQuery('...')).toBeNull();
    });

    it('keeps one-letter tokens as whole lexemes instead of leaving a bare number', () => {
        expect(buildMusicTsQuery('U2')).toBe('u & 2');
        expect(buildMusicTsQuery('P!nk')).toBe('p & nk:*');
    });

    it('does not decompose Hangul or strip kana voicing marks', () => {
        expect(buildMusicTsQuery('한국')).toBe('한국:*');
        expect(buildMusicTsQuery('ガガ')).toBe('ガガ:*');
    });
});
