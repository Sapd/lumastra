// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    iso639ToDisplayCode,
    localizedLanguageName,
    normalizeToIso6391,
} from './language-codes.js';

describe('iso639ToDisplayCode', () => {
    it('converts common 3-letter codes to 2-letter', () => {
        expect(iso639ToDisplayCode('eng')).toBe('EN');
        expect(iso639ToDisplayCode('jpn')).toBe('JA');
        expect(iso639ToDisplayCode('fra')).toBe('FR');
        expect(iso639ToDisplayCode('fre')).toBe('FR');
        expect(iso639ToDisplayCode('deu')).toBe('DE');
        expect(iso639ToDisplayCode('ger')).toBe('DE');
        expect(iso639ToDisplayCode('spa')).toBe('ES');
        expect(iso639ToDisplayCode('zho')).toBe('ZH');
        expect(iso639ToDisplayCode('chi')).toBe('ZH');
        expect(iso639ToDisplayCode('kor')).toBe('KO');
    });

    it('is case-insensitive', () => {
        expect(iso639ToDisplayCode('ENG')).toBe('EN');
        expect(iso639ToDisplayCode('Jpn')).toBe('JA');
    });

    it('falls back to first 2 chars uppercased for unknown codes', () => {
        expect(iso639ToDisplayCode('xyz')).toBe('XY');
        expect(iso639ToDisplayCode('abc')).toBe('AB');
    });

    it('handles "und" (undetermined) gracefully', () => {
        expect(iso639ToDisplayCode('und')).toBe('??');
    });

    it('distinguishes Malayalam (mal→ML) from Malay (msa→MS)', () => {
        expect(iso639ToDisplayCode('mal')).toBe('ML');
        expect(iso639ToDisplayCode('msa')).toBe('MS');
    });
});

describe('normalizeToIso6391', () => {
    it('maps 639-2/B and /T variants to one 639-1 code', () => {
        expect(normalizeToIso6391('ger')).toBe('de');
        expect(normalizeToIso6391('deu')).toBe('de');
        expect(normalizeToIso6391('eng')).toBe('en');
        expect(normalizeToIso6391('fre')).toBe('fr');
    });
    it('passes through existing 639-1 codes lowercased', () => {
        expect(normalizeToIso6391('EN')).toBe('en');
        expect(normalizeToIso6391('de')).toBe('de');
    });
    it('returns null for undetermined / empty', () => {
        expect(normalizeToIso6391('und')).toBeNull();
        expect(normalizeToIso6391('zxx')).toBeNull();
        expect(normalizeToIso6391('')).toBeNull();
        expect(normalizeToIso6391(null)).toBeNull();
        expect(normalizeToIso6391(undefined)).toBeNull();
    });
    it('drops unmapped 3-letter tags instead of emitting a wrong code', () => {
        expect(normalizeToIso6391('gsw')).toBeNull();
    });
    it('maps a 639-2 tag the old table lacked now that the tables are unified', () => {
        // 'est' (Estonian) is genuinely mapped in the shared table now — it is
        // not truncated or guessed, so this is not the "unmapped tag" case above.
        expect(normalizeToIso6391('est')).toBe('et');
    });
});

describe('localizedLanguageName', () => {
    it('renders a language name in the requested locale', () => {
        expect(localizedLanguageName('ja', 'en')).toBe('Japanese');
        expect(localizedLanguageName('ja', 'de')).toBe('Japanisch');
        expect(localizedLanguageName('en', 'de')).toBe('Englisch');
    });

    it('covers languages the hand-maintained display table never had', () => {
        // These normalize correctly but had no DISPLAY_CODE_TO_NAME entry, so
        // they used to surface to users as a bare "TA" / "FA" / "CA".
        expect(localizedLanguageName('ta', 'en')).toBe('Tamil');
        expect(localizedLanguageName('fa', 'en')).toBe('Persian');
        expect(localizedLanguageName('ca', 'en')).toBe('Catalan');
        expect(localizedLanguageName('te', 'en')).toBe('Telugu');
    });

    it('accepts ISO 639-2 tags, not just 639-1', () => {
        expect(localizedLanguageName('jpn', 'en')).toBe('Japanese');
        expect(localizedLanguageName('ger', 'en')).toBe('German');
    });

    it('returns an empty string for absent or meaningless tags', () => {
        expect(localizedLanguageName(null, 'en')).toBe('');
        expect(localizedLanguageName('', 'en')).toBe('');
        expect(localizedLanguageName('und', 'en')).toBe('');
        expect(localizedLanguageName('xx', 'en')).toBe('');
    });

    it('falls back to the uppercased code for a genuinely unknown tag', () => {
        expect(localizedLanguageName('qqq', 'en')).toBe('QQQ');
    });
});
