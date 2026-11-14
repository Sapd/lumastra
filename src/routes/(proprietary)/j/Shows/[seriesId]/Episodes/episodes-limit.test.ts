// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { EPISODES_MAX_LIMIT, parseEpisodesLimit } from './episodes-limit';

describe('parseEpisodesLimit', () => {
    it('returns every episode when the client sends no Limit, like Jellyfin', () => {
        // Infuse asks without a Limit and builds its season list from the one page.
        // A 100 default cut South Park (368 episodes) off after season 7.
        expect(parseEpisodesLimit(null)).toBe(EPISODES_MAX_LIMIT);
        expect(parseEpisodesLimit(null)).toBeGreaterThanOrEqual(5_000);
    });

    it('honours an explicit Limit above the old 500 cap', () => {
        expect(parseEpisodesLimit('1000')).toBe(1000);
    });

    it('keeps an explicit small Limit', () => {
        expect(parseEpisodesLimit('20')).toBe(20);
    });

    it('caps a huge Limit', () => {
        expect(parseEpisodesLimit('999999')).toBe(EPISODES_MAX_LIMIT);
    });

    it('treats garbage, zero and negatives as no Limit / at least one', () => {
        expect(parseEpisodesLimit('abc')).toBe(EPISODES_MAX_LIMIT);
        expect(parseEpisodesLimit('')).toBe(EPISODES_MAX_LIMIT);
        expect(parseEpisodesLimit('-5')).toBe(1);
    });
});
