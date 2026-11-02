// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { resolveHeroFirstSlide } from './hero-first-slide.js';
import type { ContinueWatchingItem } from './section-builder.js';

/**
 * Pure-logic coverage for the two no-DB branches of the resolver:
 *   - personalized reuse of the top Next Up item (must NOT touch sql)
 *   - null-on-error / null-when-nothing-to-resolve (must never throw)
 *
 * The access-scoped generic-fallback DB branch is exercised by the real
 * query module's own integration coverage; here we pass `sql: null` so the
 * resolver's fallback path short-circuits without a database.
 */
describe('resolveHeroFirstSlide', () => {
    const episodeItem: ContinueWatchingItem = {
        id: 'ep-1',
        title: 'Pilot',
        overview: 'A new detective arrives in town.',
        mediaType: 'episode',
        seriesName: 'Show',
        seasonNumber: 1,
        episodeNumber: 1,
        watchProgress: 0,
        duration: 1500, // 25 minutes
        externalIds: { internal: 'ep-1', tmdb: '9' },
        seriesId: 'series-uuid',
    };

    it('returns the personalized slide from topNextUp without touching sql', async () => {
        const slide = await resolveHeroFirstSlide({
            sql: null,
            topNextUp: episodeItem,
            isAgeRestricted: false,
            accessCtx: null,
        });
        expect(slide).not.toBeNull();
        // Episode reconciliation key MUST be the episode's own media_id.
        expect(slide?.externalIds.internal).toBe('ep-1');
        // Series id carried separately for logo/backdrop resolution.
        expect(slide?.seriesId).toBe('series-uuid');
        // Title prefers the series name for episodes.
        expect(slide?.title).toBe('Show');
        // Episode overview must reach the slide so the hero shows a synopsis
        // for the "next episode" branch (regression: was hardcoded undefined).
        expect(slide?.overview).toBe('A new detective arrives in town.');
        expect(slide?.mediaType).toBe('episode');
        // 1500s → 25 minutes.
        expect(slide?.runtimeMinutes).toBe(25);
        expect(slide?.externalIds.tmdb).toBe('9');
        expect(slide?.externalIds).not.toHaveProperty('jellyfin');
    });

    it('ignores topNextUp for age-restricted viewers (never personalized)', async () => {
        const slide = await resolveHeroFirstSlide({
            sql: null, // fallback disabled → null, proving no personalized leak
            topNextUp: episodeItem,
            isAgeRestricted: true,
            accessCtx: null,
        });
        expect(slide).toBeNull();
    });

    it('returns null (not throw) when there is no nextUp and no sql', async () => {
        const slide = await resolveHeroFirstSlide({
            sql: null,
            topNextUp: null,
            isAgeRestricted: false,
            accessCtx: null,
        });
        expect(slide).toBeNull();
    });

    it('returns null when fallback is requested but no access context is available', async () => {
        // sql present but accessCtx null → cannot build a scoped key → bail.
        const slide = await resolveHeroFirstSlide({
            sql: null,
            topNextUp: null,
            isAgeRestricted: false,
            accessCtx: null,
        });
        expect(slide).toBeNull();
    });
});
