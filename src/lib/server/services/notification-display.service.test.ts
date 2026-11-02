// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { buildNotificationPresentation } from './notification-display.service.js';

const linkUrl = 'https://lumastra.example/settings/connections?connect=jellyfin';

describe('read-only Jellyfin token notice', () => {
    it.each([
        ['en', 'cannot play anything', 'client password', 'Connect a Jellyfin app'],
        ['de', 'kann nichts abspielen', 'Client-Passwort', 'Jellyfin-App verbinden'],
    ] as const)(
        'explains how to sign in without exposing a legacy external link (%s)',
        (locale, noPlay, password, dialog) => {
            const result = buildNotificationPresentation(
                {
                    kind: 'jellyfin.readonly_token',
                    payload: { linkUrl },
                },
                { locale, surface: 'v1' },
            );
            expect(result.display.body).toContain(noPlay);
            expect(result.display.body).toContain('Quick Connect');
            expect(result.display.body).toContain(password);
            expect(result.display.body).toContain(dialog);
            expect(result.link).toBeUndefined();
        },
    );
});
