// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfig } = vi.hoisted(() => ({
    mockConfig: { FORCE_LOCALE: '' as string },
}));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

import { buildRequestLanguageHint } from './hooks.language.js';

const evt = (opts: {
    cookie?: string | null;
    header?: string | null;
}): Parameters<typeof buildRequestLanguageHint>[0] =>
    ({
        cookies: { get: () => opts.cookie ?? undefined },
        request: { headers: { get: () => opts.header ?? null } },
    }) as unknown as Parameters<typeof buildRequestLanguageHint>[0];

describe('buildRequestLanguageHint', () => {
    beforeEach(() => {
        mockConfig.FORCE_LOCALE = '';
    });

    it('reads the explicit language cookie in the real default state (FORCE_LOCALE unset)', () => {
        // Pins the actual production default: FORCE_LOCALE is '' (never null/undefined),
        // so this must come from the cookie, not fall through to the header/baseLocale.
        expect(buildRequestLanguageHint(evt({ cookie: 'de', header: 'fr-FR' })).cookieLocale).toBe(
            'de',
        );
    });

    it('captures the cookie and the header', () => {
        expect(buildRequestLanguageHint(evt({ cookie: 'de', header: 'de-DE,de;q=0.9' }))).toEqual({
            cookieLocale: 'de',
            acceptLanguage: 'de-DE,de;q=0.9',
        });
    });

    it('reports nulls when neither signal is present', () => {
        expect(buildRequestLanguageHint(evt({}))).toEqual({
            cookieLocale: null,
            acceptLanguage: null,
        });
    });

    it('lets FORCE_LOCALE stand in for the cookie', () => {
        mockConfig.FORCE_LOCALE = 'de';
        expect(buildRequestLanguageHint(evt({ cookie: null, header: 'fr' }))).toEqual({
            cookieLocale: 'de',
            acceptLanguage: 'fr',
        });
    });

    it('prefers FORCE_LOCALE over a real cookie', () => {
        mockConfig.FORCE_LOCALE = 'de';
        expect(buildRequestLanguageHint(evt({ cookie: 'fr', header: null })).cookieLocale).toBe(
            'de',
        );
    });
});
