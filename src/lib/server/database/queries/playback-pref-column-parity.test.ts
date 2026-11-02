// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A preference the API accepts but the column whitelist does not know is
 * silently dropped on write: the PUT returns 200, the setting never sticks,
 * and nothing logs. Keep the two in lockstep.
 */

import { describe, expect, it } from 'vitest';
import { playbackPreferencesSchema } from '$lib/schemas/user.js';
import { PLAYBACK_PREF_COLUMNS } from './user-preferences.queries.js';

function schemaKeys(): string[] {
    const shape = (playbackPreferencesSchema as unknown as { shape?: Record<string, unknown> })
        .shape;
    expect(shape, 'playbackPreferencesSchema no longer exposes .shape').toBeTypeOf('object');
    return Object.keys(shape!);
}

describe('playback preference column whitelist', () => {
    it('maps every persisted preference the update schema accepts', () => {
        // writeOrder is transport metadata consumed by the ordered-write handler.
        const unmapped = schemaKeys().filter(
            (key) => key !== 'writeOrder' && !(key in PLAYBACK_PREF_COLUMNS),
        );
        expect(unmapped).toEqual([]);
    });

    it('keeps write ordering metadata separate from preference columns', () => {
        expect(schemaKeys()).toContain('writeOrder');
        expect(PLAYBACK_PREF_COLUMNS).not.toHaveProperty('writeOrder');
    });

    it('carries the still-watching preference', () => {
        expect(schemaKeys()).toContain('stillWatchingEnabled');
        expect(PLAYBACK_PREF_COLUMNS).toHaveProperty(
            'stillWatchingEnabled',
            'still_watching_enabled',
        );
    });
});
