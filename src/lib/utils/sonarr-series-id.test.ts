// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { toSonarrSeriesId } from './modal-utils.js';

describe('toSonarrSeriesId', () => {
    it('passes a genuine Sonarr integer through', () => {
        expect(toSonarrSeriesId(1234)).toBe(1234);
        expect(toSonarrSeriesId('1234')).toBe(1234);
    });

    it('returns undefined for a media_items UUID rather than NaN', () => {
        // The actual production value, from the DB-backed calendar path.
        // `Number(...)` gives NaN, and `x ? Number(x) : undefined` does not
        // catch it because the string is truthy — so NaN reached the URL as
        // /api/image/sonarr/NaN/poster.
        expect(toSonarrSeriesId('974d7f8d-cacb-4cfb-b9c9-243d92a2b9e0')).toBeUndefined();
    });

    it('returns undefined for a UUID that BEGINS with digits', () => {
        // The nasty case for any parseInt-flavoured fix: parseInt('974d7f8d…')
        // happily returns 974, a plausible-looking Sonarr id for a completely
        // different series.
        expect(toSonarrSeriesId('974d7f8d-cacb-4cfb-b9c9-243d92a2b9e0')).toBeUndefined();
        expect(toSonarrSeriesId('12abc')).toBeUndefined();
    });

    it('returns undefined for empty, null, undefined and non-scalars', () => {
        for (const v of ['', '   ', null, undefined, {}, [], true]) {
            expect(toSonarrSeriesId(v)).toBeUndefined();
        }
    });

    it('rejects non-integers and unsafe integers', () => {
        expect(toSonarrSeriesId(1.5)).toBeUndefined();
        expect(toSonarrSeriesId(Number.NaN)).toBeUndefined();
        expect(toSonarrSeriesId('999999999999999999999')).toBeUndefined();
    });
});
