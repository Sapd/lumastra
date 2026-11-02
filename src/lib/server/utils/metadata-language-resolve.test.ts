// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfig, mockGetLocale, mockGetHint } = vi.hoisted(() => ({
    mockConfig: {
        TMDB_LANGUAGE: 'en-US',
        METADATA_ADDITIONAL_LANGUAGES: ['de', 'ja'] as string[],
    },
    mockGetLocale: vi.fn<() => string>(() => 'en'),
    mockGetHint: vi.fn<() => { cookieLocale: string | null; acceptLanguage: string | null } | null>(
        () => null,
    ),
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

vi.mock('$lib/paraglide/runtime.js', () => ({
    getLocale: mockGetLocale,
}));

vi.mock('$lib/server/utils/request-language-context.js', () => ({
    getRequestLanguageHint: mockGetHint,
}));

import { resolveMetadataLanguage } from './metadata-language-resolve.js';

describe('resolveMetadataLanguage', () => {
    beforeEach(() => {
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de', 'ja'];
        mockGetLocale.mockReset();
        mockGetLocale.mockReturnValue('en');
        mockGetHint.mockReset();
        mockGetHint.mockReturnValue(null);
    });

    it('null pref follows app locale when admin-enabled; returns nulls when locale is primary', () => {
        mockGetLocale.mockReturnValue('de');
        const enabled = resolveMetadataLanguage({
            metadata_language: null,
            metadata_title_language: null,
        });
        expect(enabled).toEqual({ titleLang: 'de', textLang: 'de' });

        mockGetLocale.mockReturnValue('en');
        const primary = resolveMetadataLanguage({
            metadata_language: null,
            metadata_title_language: null,
        });
        expect(primary).toEqual({ titleLang: null, textLang: null });
    });

    it('explicit pref no longer admin-enabled → null (fallback to primary)', () => {
        const result = resolveMetadataLanguage({
            metadata_language: 'fr',
            metadata_title_language: 'fr',
        });
        expect(result).toEqual({ titleLang: null, textLang: null });
    });

    it('explicit admin-enabled pref is used verbatim, independently per field', () => {
        const result = resolveMetadataLanguage({
            metadata_language: 'ja',
            metadata_title_language: 'de',
        });
        expect(result).toEqual({ titleLang: 'de', textLang: 'ja' });
    });

    it('explicit pref equal to the primary language resolves to null', () => {
        const bare = resolveMetadataLanguage({
            metadata_language: 'en',
            metadata_title_language: null,
        });
        expect(bare.textLang).toBeNull();

        const full = resolveMetadataLanguage({
            metadata_language: 'en-US',
            metadata_title_language: null,
        });
        expect(full.textLang).toBeNull();
    });

    it('getLocale throwing is treated as primary (never throws)', () => {
        mockGetLocale.mockImplementation(() => {
            throw new Error('no request context');
        });
        const result = resolveMetadataLanguage({
            metadata_language: null,
            metadata_title_language: null,
        });
        expect(result).toEqual({ titleLang: null, textLang: null });
    });

    it('null prefs object behaves like both fields null (follows locale)', () => {
        mockGetLocale.mockReturnValue('ja');
        const result = resolveMetadataLanguage(null);
        expect(result).toEqual({ titleLang: 'ja', textLang: 'ja' });
    });

    it('locale not admin-enabled → null', () => {
        mockGetLocale.mockReturnValue('fr');
        const result = resolveMetadataLanguage({
            metadata_language: null,
            metadata_title_language: null,
        });
        expect(result).toEqual({ titleLang: null, textLang: null });
    });

    describe('bare-vs-full locale fallback (locale/null-pref path only)', () => {
        it("bare locale 'de' with admin enabled ['de-DE'] resolves to the enabled entry 'de-DE'", () => {
            mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE', 'ja'];
            mockGetLocale.mockReturnValue('de');
            const result = resolveMetadataLanguage({
                metadata_language: null,
                metadata_title_language: null,
            });
            expect(result).toEqual({ titleLang: 'de-DE', textLang: 'de-DE' });
        });

        it("admin enabled ['de'] (bare) with locale 'de' resolves unchanged to 'de' (exact match, no fallback needed)", () => {
            mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de', 'ja'];
            mockGetLocale.mockReturnValue('de');
            const result = resolveMetadataLanguage({
                metadata_language: null,
                metadata_title_language: null,
            });
            expect(result).toEqual({ titleLang: 'de', textLang: 'de' });
        });

        it('an explicit (non-null) pref does NOT get the bare-language fallback — exact match only', () => {
            mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE', 'ja'];
            const result = resolveMetadataLanguage({
                metadata_language: 'de',
                metadata_title_language: 'de',
            });
            expect(result).toEqual({ titleLang: null, textLang: null });
        });
    });
});

describe('resolveMetadataLanguage — request hint chain', () => {
    beforeEach(() => {
        mockConfig.TMDB_LANGUAGE = 'en-US';
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['de-DE', 'fr'];
        mockGetHint.mockReset();
        mockGetHint.mockReturnValue(null);
    });

    it('negotiates the header when no cookie is present', () => {
        mockGetHint.mockReturnValue({
            cookieLocale: null,
            acceptLanguage: 'de-DE,de;q=0.9,en;q=0.5',
        });
        expect(resolveMetadataLanguage(null)).toEqual({
            titleLang: 'de-DE',
            textLang: 'de-DE',
        });
    });

    it('lets the cookie win over the header', () => {
        mockGetHint.mockReturnValue({ cookieLocale: 'fr', acceptLanguage: 'de-DE' });
        expect(resolveMetadataLanguage(null)).toEqual({ titleLang: 'fr', textLang: 'fr' });
    });

    it('STOPS at primary when the cookie is primary, ignoring the header', () => {
        mockGetHint.mockReturnValue({ cookieLocale: 'en', acceptLanguage: 'de-DE' });
        expect(resolveMetadataLanguage(null)).toEqual({ titleLang: null, textLang: null });
    });

    it('STOPS at primary when the cookie is present but unsatisfiable', () => {
        // Cookie asks for German, only fr is enabled, header asks for French.
        // Serving French here would be a language the user never chose.
        mockConfig.METADATA_ADDITIONAL_LANGUAGES = ['fr'];
        mockGetHint.mockReturnValue({ cookieLocale: 'de', acceptLanguage: 'fr' });
        expect(resolveMetadataLanguage(null)).toEqual({ titleLang: null, textLang: null });
    });

    it('does not let the header override an explicit stored preference', () => {
        mockGetHint.mockReturnValue({ cookieLocale: null, acceptLanguage: 'fr' });
        expect(
            resolveMetadataLanguage({
                metadata_language: 'de-DE',
                metadata_title_language: 'de-DE',
            }),
        ).toEqual({ titleLang: 'de-DE', textLang: 'de-DE' });
    });

    it('stops at primary for a stored pref whose language was disabled', () => {
        mockGetHint.mockReturnValue({ cookieLocale: null, acceptLanguage: 'fr' });
        expect(
            resolveMetadataLanguage({
                metadata_language: 'ja',
                metadata_title_language: 'ja',
            }),
        ).toEqual({ titleLang: null, textLang: null });
    });

    it('resolves title and text independently', () => {
        mockGetHint.mockReturnValue({ cookieLocale: null, acceptLanguage: 'fr' });
        expect(
            resolveMetadataLanguage({
                metadata_language: null,
                metadata_title_language: 'de-DE',
            }),
        ).toEqual({ titleLang: 'de-DE', textLang: 'fr' });
    });

    it('applies bare-language fallback from the header to the enabled spelling', () => {
        mockGetHint.mockReturnValue({ cookieLocale: null, acceptLanguage: 'de' });
        expect(resolveMetadataLanguage(null)).toEqual({
            titleLang: 'de-DE',
            textLang: 'de-DE',
        });
    });

    it('falls back to the legacy UI-locale path when no hint exists', () => {
        mockGetHint.mockReturnValue(null);
        mockGetLocale.mockReturnValue('fr');
        expect(resolveMetadataLanguage(null)).toEqual({ titleLang: 'fr', textLang: 'fr' });
    });
});
