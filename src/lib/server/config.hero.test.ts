// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { config } from '$lib/server/config';

describe('HERO_* config defaults', () => {
    it('exposes sensible hero defaults', () => {
        expect(typeof config.HERO_AUTOPLAY_ENABLED).toBe('boolean');
        expect(config.HERO_AUTOPLAY_INTERVAL_MS).toBeGreaterThanOrEqual(3000);
        expect(config.HERO_AUTOPLAY_INTERVAL_MS).toBeLessThanOrEqual(60000);
        expect(config.HERO_TRANSITION_MS).toBeGreaterThanOrEqual(0);
        expect(config.HERO_TRANSITION_MS).toBeLessThanOrEqual(2000);
        expect(config.HERO_MAX_SLIDES).toBeGreaterThanOrEqual(1);
        expect(config.HERO_MAX_SLIDES).toBeLessThanOrEqual(15);
        expect(['trending', 'random']).toContain(config.HERO_FALLBACK_SOURCE);
    });
});
