// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { mapTypeParam } from './suggestions-handler';

describe('mapTypeParam', () => {
    it("maps 'Movie' to 'movie'", () => {
        expect(mapTypeParam('Movie')).toBe('movie');
    });

    it("maps 'Series' to 'tv'", () => {
        expect(mapTypeParam('Series')).toBe('tv');
    });

    it('returns undefined for null', () => {
        expect(mapTypeParam(null)).toBeUndefined();
    });

    it('returns undefined for unknown string', () => {
        expect(mapTypeParam('Episode')).toBeUndefined();
        expect(mapTypeParam('Audio')).toBeUndefined();
        expect(mapTypeParam('')).toBeUndefined();
    });
});
