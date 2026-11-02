// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Credit-first artist keying for the smart queue's diversity cap.
 */

import { describe, it, expect } from 'vitest';
import { effectiveArtistKey, primaryCreditArtistName } from './music-artist-key.js';

// ---------------------------------------------------------------------------
// primaryCreditArtistName + credit-first keying
// ---------------------------------------------------------------------------

describe('primaryCreditArtistName', () => {
    it('returns the first structured credit', () => {
        expect(
            primaryCreditArtistName([
                { id: 'a', title: 'Eloren' },
                { id: 'b', title: '50 Sparks' },
            ]),
        ).toBe('Eloren');
    });

    it('returns undefined for absent, empty or blank lists so callers fall back', () => {
        expect(primaryCreditArtistName(null)).toBeUndefined();
        expect(primaryCreditArtistName(undefined)).toBeUndefined();
        expect(primaryCreditArtistName([])).toBeUndefined();
        expect(primaryCreditArtistName([{ id: 'a', title: '   ' }])).toBeUndefined();
    });

    it('unifies a multi-credit line with the solo artist — the prod failure', () => {
        // Autoplay served "Eloren Ft 50 Sparks & Dr. Vale" straight after
        // "Eloren" because the display strings differ. Keyed off the credit
        // list, both collapse to one bucket and the hard rule fires.
        const combined = effectiveArtistKey({
            id: 't1',
            artistName: primaryCreditArtistName([
                { id: 'a', title: 'Eloren' },
                { id: 'b', title: '50 Sparks' },
            ]),
        });
        const solo = effectiveArtistKey({
            id: 't2',
            artistName: primaryCreditArtistName([{ id: 'a', title: 'Eloren' }]),
        });
        expect(combined).toBe(solo);
    });

    it('still differs from the display-string key it replaces', () => {
        // Guards the regression: if a caller forgets the helper and passes the
        // display string, it must NOT accidentally match.
        const credit = effectiveArtistKey({ id: 't1', artistName: 'Eloren' });
        const display = effectiveArtistKey({
            id: 't1',
            artistName: 'Eloren Ft 50 Sparks & Dr. Vale',
        });
        expect(credit).not.toBe(display);
    });
});
