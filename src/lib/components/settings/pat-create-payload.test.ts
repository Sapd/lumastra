// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { patCreatePayload, type PatExpiryChoice } from './pat-create-payload';

describe('patCreatePayload', () => {
    // Regression: the modal promised "read and write access" but posted only
    // `{ name }`. The endpoint then applied its `['read']` default, so every
    // POST made with the resulting token failed with `insufficient_scope`.
    test('requests read+write explicitly rather than relying on the server default', () => {
        expect(patCreatePayload('claude2', 'write', '365')).toEqual({
            name: 'claude2',
            scopes: ['read', 'write'],
            expiresInDays: 365,
        });
    });

    test('narrows to read-only when the user picks read access', () => {
        expect(patCreatePayload('tautulli', 'read', '365').scopes).toEqual(['read']);
    });

    // The same dropped payload left `expiresAt` null on every self-service
    // token, so each expiry choice has to survive the mapping.
    test.each<[PatExpiryChoice, number | null]>([
        ['30', 30],
        ['90', 90],
        ['365', 365],
        ['never', null],
    ])('maps the %s expiry choice to %s days', (choice, expected) => {
        expect(patCreatePayload('t', 'write', choice).expiresInDays).toBe(expected);
    });

    test('trims the typed name', () => {
        expect(patCreatePayload('  spaced  ', 'write', '30').name).toBe('spaced');
    });

    // A stray choice must not coerce to NaN: that serialises to JSON null, which
    // the endpoint reads as "never expires" — a silent lifetime upgrade.
    test('rejects an unrecognised expiry choice instead of defaulting to never', () => {
        expect(() => patCreatePayload('t', 'write', '3650' as unknown as PatExpiryChoice)).toThrow(
            /Unsupported PAT expiry choice/,
        );
    });
});
