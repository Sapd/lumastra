// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    runWithRequestLanguage,
    getRequestLanguageHint,
    escapeRequestLanguage,
} from './request-language-context.js';

describe('request language context', () => {
    it('returns null outside any scope', () => {
        expect(getRequestLanguageHint()).toBeNull();
    });

    it('exposes the hint inside a scope', () => {
        const hint = { cookieLocale: 'de', acceptLanguage: 'de-DE,de;q=0.9' };
        const seen = runWithRequestLanguage(hint, () => getRequestLanguageHint());
        expect(seen).toEqual(hint);
    });

    it('clears the hint after the scope ends', () => {
        runWithRequestLanguage({ cookieLocale: 'de', acceptLanguage: null }, () => undefined);
        expect(getRequestLanguageHint()).toBeNull();
    });

    it('propagates across await boundaries', async () => {
        const hint = { cookieLocale: null, acceptLanguage: 'fr' };
        const seen = await runWithRequestLanguage(hint, async () => {
            await Promise.resolve();
            await new Promise((r) => setTimeout(r, 1));
            return getRequestLanguageHint();
        });
        expect(seen).toEqual(hint);
    });

    it('isolates concurrent scopes from each other', async () => {
        const readAfterTick = async (tag: string): Promise<string | null> =>
            runWithRequestLanguage({ cookieLocale: tag, acceptLanguage: null }, async () => {
                await new Promise((r) => setTimeout(r, 5));
                return getRequestLanguageHint()?.cookieLocale ?? null;
            });

        const [a, b] = await Promise.all([readAfterTick('de'), readAfterTick('fr')]);
        expect(a).toBe('de');
        expect(b).toBe('fr');
    });

    it('does not leak into unrelated async work started outside the scope', async () => {
        const outside = (async () => {
            await new Promise((r) => setTimeout(r, 5));
            return getRequestLanguageHint();
        })();

        runWithRequestLanguage({ cookieLocale: 'de', acceptLanguage: null }, () => undefined);

        expect(await outside).toBeNull();
    });

    it('escapeRequestLanguage hides the hint inside a scope, then restores it', () => {
        const hint = { cookieLocale: 'de', acceptLanguage: 'de-DE,de;q=0.9' };
        runWithRequestLanguage(hint, () => {
            const seenInsideEscape = escapeRequestLanguage(() => getRequestLanguageHint());
            expect(seenInsideEscape).toBeNull();

            // Restored after the escape hatch returns, still inside the outer scope.
            expect(getRequestLanguageHint()).toEqual(hint);
        });
    });
});
