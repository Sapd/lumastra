// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isSeasonPremiere } from './series-interest.service.js';

describe('isSeasonPremiere', () => {
    it('is episode 1 of a regular season', () => {
        expect(isSeasonPremiere({ seasonNumber: 4, episodeNumber: 1 })).toBe(true);
    });

    it('is never a mid-season episode', () => {
        expect(isSeasonPremiere({ seasonNumber: 4, episodeNumber: 2 })).toBe(false);
    });

    it('is never a special, even S00E01', () => {
        expect(isSeasonPremiere({ seasonNumber: 0, episodeNumber: 1 })).toBe(false);
    });

    it('is never an episode with unknown numbering', () => {
        expect(isSeasonPremiere({ seasonNumber: null, episodeNumber: 1 })).toBe(false);
        expect(isSeasonPremiere({ seasonNumber: 2, episodeNumber: null })).toBe(false);
    });
});
