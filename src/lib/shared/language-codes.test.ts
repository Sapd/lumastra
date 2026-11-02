// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    isUnknownLanguage,
    languagesMatch,
    normalizeLanguage,
    toIso6392B,
    toIso6392T,
} from './language-codes';

describe('one language table', () => {
    it('normalizes 639-2/B, 639-2/T and TMDB tags to 639-1', () => {
        expect(normalizeLanguage('ger')).toBe('de');
        expect(normalizeLanguage('deu')).toBe('de');
        expect(normalizeLanguage('cn')).toBe('zh'); // TMDB's own tag
    });

    it('agrees with itself on tags that name no language', () => {
        for (const tag of ['', 'und', 'mis', 'mul', 'zxx', 'xx']) {
            expect(isUnknownLanguage(tag)).toBe(true);
        }
    });

    it('produces 639-2/B for HLS manifests', () => {
        expect(toIso6392B('de')).toBe('ger');
        expect(toIso6392B('ja')).toBe('jpn');
        expect(toIso6392B('und')).toBeNull();
    });

    it('never truncates an unmapped 3-letter tag onto a different language', () => {
        // 'est' (Estonian) must not become 'es' (Spanish).
        expect(languagesMatch('es', 'est')).toBe(false);
    });
});

describe('country codes are NOT folded into languages', () => {
    // `cn` is safe to alias because it is not an ISO 639-1 code at all — TMDB
    // misuses the country code for Chinese-language titles, so nothing is
    // shadowed. That does NOT generalise, and this suite exists to make the
    // refusal visible to whoever extends the table next: a positive-only suite
    // would let the next country-code alias in without argument.
    //
    // Contributed by the tvOS session, which hit the `cn` gap independently in
    // its own Swift table and drew this line while fixing it.
    it("maps TMDB's cn to Chinese, because cn is not a language code", () => {
        expect(normalizeLanguage('cn')).toBe('zh');
    });

    it('does NOT map se to Swedish — se is Northern Sami', () => {
        // Aliasing the country code for Sweden would trade a visible bug
        // (a Swedish track not matching) for an invisible one (a Northern Sami
        // track silently matching as Swedish).
        expect(normalizeLanguage('se')).not.toBe('sv');
        expect(languagesMatch('se', 'swe')).toBe(false);
    });

    it('does not map other country codes onto their majority language', () => {
        // Each of these is either a real ISO 639-1 code for a different
        // language, or simply not a language at all.
        expect(normalizeLanguage('at')).not.toBe('de'); // Austria / Assamese-adjacent trap
        expect(normalizeLanguage('br')).not.toBe('pt'); // Brazil / Breton
        expect(normalizeLanguage('ch')).not.toBe('de'); // Switzerland / Chamorro
        expect(normalizeLanguage('in')).not.toBe('hi'); // India / Indonesian (old code)
    });
});

describe('toIso6392T (Jellyfin 10.11+ culture codes)', () => {
    it('uses the terminological form where it differs from the bibliographic one', () => {
        expect(toIso6392T('de')).toBe('deu');
        expect(toIso6392T('ger')).toBe('deu');
        expect(toIso6392T('fr')).toBe('fra');
        expect(toIso6392T('zh')).toBe('zho');
        expect(toIso6392T('nl')).toBe('nld');
    });
    it('keeps codes that are the same in both', () => {
        expect(toIso6392T('en')).toBe('eng');
        expect(toIso6392T('ja')).toBe('jpn');
    });
    it('is null for tags that name no language', () => {
        expect(toIso6392T('und')).toBeNull();
        expect(toIso6392T(null)).toBeNull();
    });
});

it('matches regional tags to an unqualified base without collapsing conflicting qualified tags', () => {
    expect(normalizeLanguage('ENG_US')).toBe('en-us');
    expect(normalizeLanguage('tiếng việt')).toBe('vi');
    expect(languagesMatch('en', 'en-US')).toBe(true);
    expect(languagesMatch('en-US', 'eng')).toBe(true);
    expect(languagesMatch('zh-Hans', 'zh-Hant')).toBe(false);
    expect(languagesMatch('en-US', 'en-GB')).toBe(false);
    expect(languagesMatch('und', 'und')).toBe(false);
});

it.each(['constructor', '__proto__', 'constructor-US', '__proto__-US'])(
    'normalizes inherited object key %s as a string',
    (value) => {
        const normalized = normalizeLanguage(value);
        expect(typeof normalized).toBe('string');
        expect(() => isUnknownLanguage(value)).not.toThrow();
        expect(languagesMatch(value, 'en')).toBe(false);
        expect(toIso6392B(value)).toBeNull();
        expect(toIso6392T(value)).toBeNull();
    },
);
