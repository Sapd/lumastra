// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { heroButtonLabel, userMenuLinkLabel } from './hero-button-labels';
import { pickLabel, localizeItems, cleanLabels } from '$lib/shared/localized-label';

describe('heroButtonLabel', () => {
    // On a production install, buttons created by a German-speaking admin read "Suchen" for
    // everyone.
    it('shows a stored built-in default in the viewer’s language', () => {
        expect(heroButtonLabel({ action: 'search', label: 'Suchen' }, 'en')).toBe('Search');
        expect(heroButtonLabel({ action: 'browse', label: 'Browse' }, 'de')).toBe('Stöbern');
    });

    it('recognises the old Jellyfin-connect preset text', () => {
        expect(
            heroButtonLabel(
                {
                    action: 'link',
                    label: 'Jellyfin Client Verbinden',
                    url: '/settings/connections?connect=jellyfin',
                },
                'en',
            ),
        ).toBe('Set up a Jellyfin app');
    });

    it('keeps an admin’s own wording', () => {
        expect(heroButtonLabel({ action: 'search', label: 'Find stuff' }, 'de')).toBe('Find stuff');
    });

    it('an explicit translation wins', () => {
        expect(
            heroButtonLabel(
                {
                    action: 'link',
                    label: 'Jellyfin Client Verbinden',
                    labels: { en: 'Connect Jellyfin' },
                },
                'en',
            ),
        ).toBe('Connect Jellyfin');
    });
});

describe('localized labels', () => {
    it('falls back to the plain label', () => {
        expect(pickLabel({ label: 'Alle Apps', labels: { en: ' ' } }, 'en')).toBe('Alle Apps');
        expect(pickLabel({ label: 'Alle Apps', labels: { en: 'All apps' } }, 'en')).toBe(
            'All apps',
        );
    });

    it('localizeItems resolves label and leaves untranslated items untouched', () => {
        const plain = { label: 'X' };
        const [a, b] = localizeItems([{ label: 'Y', labels: { de: 'Ypsilon' } }, plain], 'de');
        expect(a.label).toBe('Ypsilon');
        expect(b).toBe(plain);
    });

    it('cleanLabels drops empty translations', () => {
        expect(cleanLabels({ en: ' ', de: '' })).toBeUndefined();
        expect(cleanLabels({ en: 'A ', de: '' })).toEqual({ en: 'A' });
    });
});

describe('userMenuLinkLabel', () => {
    it('translates the seeded defaults, old English and German spellings alike', () => {
        expect(userMenuLinkLabel({ label: 'Alle Apps' }, 'en')).toBe('All apps');
        expect(userMenuLinkLabel({ label: 'Change Password' }, 'de')).toBe('Passwort ändern');
    });

    it('leaves an admin’s own link text alone', () => {
        expect(userMenuLinkLabel({ label: 'Wiki' }, 'de')).toBe('Wiki');
    });
});
