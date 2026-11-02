// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { resolveTmdbLanguagePrefill } from './metadata-language-prefill';

describe('resolveTmdbLanguagePrefill', () => {
    // The resume-path regression this pins: a wizard re-entered after a saved
    // custom TMDB_LANGUAGE (resume: true — admin exists, no library) must show
    // the SAVED value, never the browser-locale guess — otherwise Finish/Skip
    // silently reverts the saved config to the guess.
    it('returns the saved value verbatim, ignoring the UI locale', () => {
        expect(resolveTmdbLanguagePrefill('fr-FR', 'de')).toBe('fr-FR');
        expect(resolveTmdbLanguagePrefill('de-DE', 'en')).toBe('de-DE');
    });

    it('falls back to the locale-derived guess only when unset', () => {
        expect(resolveTmdbLanguagePrefill(null, 'de')).toBe('de-DE');
        expect(resolveTmdbLanguagePrefill(null, 'en')).toBe('en-US');
    });

    it('uses the -US region fallback for locales without a REGION_PREFERENCE entry', () => {
        expect(resolveTmdbLanguagePrefill(null, 'xx')).toBe('xx-US');
    });

    it('treats a blank saved value like unset', () => {
        expect(resolveTmdbLanguagePrefill('   ', 'de')).toBe('de-DE');
    });
});
