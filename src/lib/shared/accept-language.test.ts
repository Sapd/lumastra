// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { negotiateLanguage } from './accept-language.js';

const enabled = (...tags: string[]): Set<string> => new Set(tags);

describe('negotiateLanguage', () => {
    it('returns null for absent or empty headers', () => {
        expect(negotiateLanguage(null, enabled('en', 'de'))).toBeNull();
        expect(negotiateLanguage(undefined, enabled('en', 'de'))).toBeNull();
        expect(negotiateLanguage('', enabled('en', 'de'))).toBeNull();
    });

    it('returns null when the enabled set is empty', () => {
        expect(negotiateLanguage('de', enabled())).toBeNull();
    });

    it('matches an exact enabled tag', () => {
        expect(negotiateLanguage('de-DE', enabled('en-US', 'de-DE'))).toBe('de-DE');
    });

    it('orders candidates by q-value, highest first', () => {
        expect(negotiateLanguage('en;q=0.5,de;q=0.9', enabled('en', 'de'))).toBe('de');
    });

    it('keeps header order for equal q-values (stable sort)', () => {
        expect(negotiateLanguage('de,fr;q=1', enabled('de', 'fr'))).toBe('de');
    });

    it('falls back on bare language and returns the ENABLED spelling', () => {
        expect(negotiateLanguage('de', enabled('en-US', 'de-DE'))).toBe('de-DE');
        expect(negotiateLanguage('de-CH', enabled('en-US', 'de-DE'))).toBe('de-DE');
    });

    it('prefers an exact match over a bare-language fallback', () => {
        expect(negotiateLanguage('pt-BR', enabled('pt', 'pt-BR'))).toBe('pt-BR');
    });

    it('ignores wildcard and q=0 entries', () => {
        expect(negotiateLanguage('*', enabled('en', 'de'))).toBeNull();
        expect(negotiateLanguage('de;q=0', enabled('en', 'de'))).toBeNull();
    });

    it('skips malformed q-values rather than ranking them as 1', () => {
        expect(negotiateLanguage('de;q=abc,fr;q=0.5', enabled('de', 'fr'))).toBe('fr');
    });

    it('skips unparseable tags without throwing', () => {
        expect(negotiateLanguage('!!!,de', enabled('de'))).toBe('de');
        expect(() => negotiateLanguage(';;;', enabled('de'))).not.toThrow();
    });

    it('returns null when nothing in the header is enabled', () => {
        expect(negotiateLanguage('fr,es', enabled('en', 'de'))).toBeNull();
    });
});
