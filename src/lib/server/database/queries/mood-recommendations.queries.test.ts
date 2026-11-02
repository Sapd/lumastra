// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for mood-recommendations query module exports and types
 */

import { describe, it, expect } from 'vitest';
import {
    findMoodMediaPersonalized,
    findMoodMedia,
    findTrendingMoodMedia,
} from './mood-recommendations.queries.js';
import type { MoodMediaRow, MoodQueryProfile } from './mood-recommendations.queries.js';
import { scopedCacheKey } from '$lib/server/utils/search-access-context.js';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context.js';

describe('mood-recommendations.queries', () => {
    it('exports findMoodMediaPersonalized as a function', () => {
        expect(typeof findMoodMediaPersonalized).toBe('function');
    });

    it('exports findMoodMedia as a function', () => {
        expect(typeof findMoodMedia).toBe('function');
    });

    it('exports findTrendingMoodMedia as a function', () => {
        expect(typeof findTrendingMoodMedia).toBe('function');
    });

    it('MoodMediaRow type compiles with all fields', () => {
        const row: MoodMediaRow = {
            primary_ext_id: 'tmdb-550',
            title: 'Quiet Orbit',
            media_type: 'movie',
            overview: 'A movie about soap',
            imdb_rating: 8.8,
            rt_rating: 79,
            rt_audience_score: 96,
            letterboxd_rating: 4.4,
            mdblist_score: 88,
            release_date: '1999-10-15',
            popularity: 61.4,
            runtime_minutes: 139,
            is_available: true,
            can_request: false,
            trailer_url: 'https://example.com/trailer',
            genres: [18, 53],
            mdblist_keywords: ['dark', 'psychological'],
            ai_similarity: 0.87,
            relevance_score: 42.5,
        };
        expect(row.title).toBe('Quiet Orbit');
        expect(row.media_type).toBe('movie');
    });

    it('MoodMediaRow type allows nullable fields', () => {
        const row: MoodMediaRow = {
            primary_ext_id: 'tmdb-999',
            title: 'Unknown',
            media_type: 'tv',
            overview: null,
            imdb_rating: null,
            rt_rating: null,
            rt_audience_score: null,
            letterboxd_rating: null,
            mdblist_score: null,
            release_date: null,
            popularity: null,
            runtime_minutes: null,
            is_available: null,
            can_request: null,
            trailer_url: null,
            genres: null,
            mdblist_keywords: null,
            ai_similarity: null,
            relevance_score: null,
        };
        expect(row.media_type).toBe('tv');
    });

    it('MoodQueryProfile type compiles', () => {
        const profile: MoodQueryProfile = {
            keywords: ['action', 'thriller'],
            genres: [28, 53],
            excludeGenres: [27],
            excludeKeywords: ['gore'],
            minRuntime: 90,
            maxRuntime: 180,
            minRating: 6.5,
            maxRating: undefined,
            maxPopularity: undefined,
            minPopularity: 20,
            minYear: 2000,
            maxYear: 2023,
        };
        expect(profile.keywords).toContain('action');
        expect(profile.genres).toContain(28);
    });

    it('MoodQueryProfile type compiles with only required fields', () => {
        const profile: MoodQueryProfile = {
            keywords: ['comedy'],
            genres: [35],
            excludeGenres: [],
            excludeKeywords: [],
        };
        expect(profile.keywords).toContain('comedy');
    });
});

/**
 * Cache-key partitioning for this module's two callers.
 *
 * Both `/api/mood-recommendations` and MoodRecommendationsService cache whole
 * result lists under a `scopedCacheKey(..., accessCtx)`. Callers with different
 * access MUST NOT share an entry.
 *
 * The concrete bug this locks down: the route used to spell the key as
 * `accessCtx ? scopedCacheKey(base, accessCtx) : base`, and `accessCtx` was
 * only populated when the DB handle existed. A request that skipped context
 * construction therefore keyed on the BARE string with no access component —
 * readable by any other access scope. The route now builds the context
 * unconditionally (it bails earlier when there is no DB), so the bare-key
 * branch is gone and every key carries a scope suffix.
 *
 * NOTE ON `all` vs `denyAll`: the spec calls out that both collapsing to an
 * empty key component would let an admin and a see-nothing caller share an
 * entry. That collision is not reachable through this module: `scopedCacheKey`
 * keys off `SearchAccessContext`, and no context can currently express
 * `denyAll` (`unauthenticatedSearchAccessContext` maps to `age: limit(-1)`, as
 * `searchAccessBoundary`'s contract documents). Fixing that belongs to
 * `buildSearchAccessCacheKey` in the foundation, not here — asserted here only
 * for the boundaries this module's callers can actually produce.
 */
describe('mood-recommendations cache keys partition by access scope', () => {
    const BASE = 'user-1:cozy:evening:all:v8:nd:supK0A0';

    function ctx(over: Partial<SearchAccessContext>): SearchAccessContext {
        return {
            username: 'u',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: false,
            showUnavailableMedia: true,
            ...over,
        };
    }

    it('gives an unrestricted and a library-restricted caller different keys', () => {
        const open = scopedCacheKey(BASE, ctx({}));
        const restricted = scopedCacheKey(BASE, ctx({ deniedGroupIds: ['group-a'] }));
        expect(restricted).not.toBe(open);
    });

    it('gives callers denied different library groups different keys', () => {
        const a = scopedCacheKey(BASE, ctx({ deniedGroupIds: ['group-a'] }));
        const b = scopedCacheKey(BASE, ctx({ deniedGroupIds: ['group-b'] }));
        expect(a).not.toBe(b);
    });

    it('partitions on the age axis independently of the library axis', () => {
        const open = scopedCacheKey(BASE, ctx({}));
        const aged = scopedCacheKey(
            BASE,
            ctx({ ageRating: { maxAgeRating: 12, allowUnrated: false } }),
        );
        expect(aged).not.toBe(open);
    });

    it('always emits a scope suffix for a restricted caller — never the bare key', () => {
        // Guards the deleted `accessCtx ? scopedCacheKey(...) : base` fallback:
        // a restricted caller's key must never equal the unscoped string.
        const restricted = scopedCacheKey(BASE, ctx({ deniedGroupIds: ['group-a'] }));
        expect(restricted).not.toBe(BASE);
        expect(restricted).toContain('denied:group-a');
    });
});
