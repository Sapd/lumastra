// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { normalizeLanguageTag, pickTranslationEntry, splitLanguageTag } from './metadata-language';

describe('normalizeLanguageTag', () => {
    it('accepts bare and regioned tags', () => {
        expect(normalizeLanguageTag(' de ')).toBe('de');
        expect(normalizeLanguageTag('pt-br')).toBe('pt-BR');
        expect(normalizeLanguageTag('german')).toBeNull();
        expect(normalizeLanguageTag('')).toBeNull();
    });
});

describe('pickTranslationEntry (spec §1 determinism rule)', () => {
    const entries = [
        { iso_639_1: 'pt', iso_3166_1: 'PT', data: { overview: 'pt-PT text' } },
        { iso_639_1: 'pt', iso_3166_1: 'BR', data: { overview: 'pt-BR text' } },
        { iso_639_1: 'de', iso_3166_1: 'DE', data: { overview: '' } },
        { iso_639_1: 'de', iso_3166_1: 'AT', data: { overview: 'at text' } },
    ];
    it('exact region match when admin code has one', () => {
        expect(pickTranslationEntry(entries, 'pt-PT')?.data?.overview).toBe('pt-PT text');
    });
    it('bare code prefers non-empty overview, tie-broken by REGION_PREFERENCE', () => {
        expect(pickTranslationEntry(entries, 'pt')?.iso_3166_1).toBe('BR'); // pt→BR preference
        expect(pickTranslationEntry(entries, 'de')?.iso_3166_1).toBe('AT'); // DE entry empty → AT wins on non-empty overview
    });
    it('returns null when no language match', () => {
        expect(pickTranslationEntry(entries, 'ja')).toBeNull();
    });
});

describe('TMDB primary language tags', () => {
    it.each([
        ['es-419', 'es-419'],
        ['zh-hans', 'zh-Hans'],
        ['en-001', 'en-001'],
        ['zh-hant-tw', 'zh-Hant-TW'],
        ['fil-PH', 'fil-PH'],
    ])('accepts and canonicalizes %s', (input, expected) => {
        expect(normalizeLanguageTag(input)).toBe(expected);
    });
    it('finds the region after a script instead of treating the script as a region', () => {
        expect(splitLanguageTag('zh-Hans-CN')).toEqual({ lang: 'zh', region: 'CN' });
        expect(splitLanguageTag('zh-Hans')).toEqual({ lang: 'zh', region: null });
        expect(splitLanguageTag('es-419')).toEqual({ lang: 'es', region: '419' });
    });
});
