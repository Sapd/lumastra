// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { def } from '$lib/server/api/defs/watchlist/index.js';
import {
    WatchlistListResponseSchema,
    WatchlistItemSchema,
} from '$lib/schemas/api-watchlist-responses.js';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Contract tests for the GET /api/v1/watchlist item shape.
 *
 * These matter more than usual on this endpoint: mount() runs `.parse()` on the
 * 2xx body and Zod STRIPS keys the schema doesn't declare. A field that the
 * handler emits but the schema omits vanishes silently on the wire — which is
 * exactly how the internal id could go missing. Every assertion below that
 * checks a field "survives" is guarding against that strip.
 */
describe('WatchlistItemSchema — canonical envelope', () => {
    it('publishes the canonical list schema on the route def', () => {
        expect(def.docs?.GET?.responses[200]).toMatchObject({
            schema: WatchlistListResponseSchema,
        });
    });
    const validItem = {
        id: '11111111-2222-4333-a444-555555555555',
        catalogId: '11111111-2222-4333-a444-555555555555',
        type: 'movie',
        title: 'The Lantern',
        year: 1999,
        ids: {
            tmdb: '603',
            imdb: 'tt0133093',
            jellyfin: 'abcdef123456',
        },
        images: {
            poster: {
                href: '/api/v1/media/uuid/images/poster?v=1',
                variants: { card: '/api/v1/media/uuid/images/poster?size=card&v=1' },
                source: 'self',
                revision: '1',
            },
        },
        overview: 'A hacker discovers reality is a simulation.',
        rating: 8.7,
        criticRating: 88,
        runtimeMinutes: 136,
        genres: ['Action', 'Sci-Fi'],
        certification: 'R',
        ratings: {
            letterboxd: 4.3,
            letterboxdVotes: 12345,
            rtAudience: 85,
            mdblist: 90,
            trakt: 91,
            mal: null,
        },
        availability: { isAvailable: true, canRequest: false },
        isSaved: true,
        savedAt: '2026-07-01T00:00:00.000Z',
        watched: false,
    };

    it('accepts the full canonical item and preserves catalog identity', () => {
        const result = WatchlistItemSchema.safeParse(validItem);

        expect(result.success).toBe(true);
        if (!result.success) return;

        // The whole point of the reshape: a flat id and catalogId with external-only ids.
        expect(result.data.id).toBe('11111111-2222-4333-a444-555555555555');
        expect(result.data.catalogId).toBe(result.data.id);
        expect(result.data.ids).not.toHaveProperty('internal');
        expect(result.data.ids.jellyfin).toBe('abcdef123456');
    });

    it('preserves the aggregate ratings block (declared, so not stripped)', () => {
        const result = WatchlistItemSchema.safeParse(validItem);
        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.data.ratings).toEqual({
            letterboxd: 4.3,
            letterboxdVotes: 12345,
            rtAudience: 85,
            mdblist: 90,
            trakt: 91,
            mal: null,
        });
    });

    it("uses the canonical 'series' discriminator, never 'tv'", () => {
        const series = WatchlistItemSchema.safeParse({
            ...validItem,
            type: 'series',
        });
        expect(series.success).toBe(true);
        if (series.success) expect(series.data.type).toBe('series');
    });

    it('accepts an available item with no jellyfin id (non-Jellyfin library)', () => {
        // isAvailable is media_items.has_files, deliberately decoupled from
        // Jellyfin presence — so this combination is valid, not a contradiction.
        const { jellyfin: _jellyfin, ...idsWithoutJellyfin } = validItem.ids;
        const result = WatchlistItemSchema.safeParse({
            ...validItem,
            ids: idsWithoutJellyfin,
            availability: { isAvailable: true, canRequest: false },
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.ids.jellyfin).toBeUndefined();
        expect(result.data.availability?.isAvailable).toBe(true);
    });

    it('accepts a minimal item (only the required media fields)', () => {
        const result = WatchlistItemSchema.safeParse({
            id: 'tmdb:1:movie',
            catalogId: null,
            type: 'movie',
            title: 'Untitled',
            ids: { tmdb: '1' },
            images: {},
            isSaved: true,
            watched: false,
        });

        expect(result.success).toBe(true);
    });

    it('requires watched — a client must never have to infer it from absence', () => {
        const { watched: _watched, ...withoutWatched } = validItem;
        expect(WatchlistItemSchema.safeParse(withoutWatched).success).toBe(false);
    });

    it('accepts series progress and preserves both counts', () => {
        const result = WatchlistItemSchema.safeParse({
            ...validItem,
            type: 'series',
            watched: false,
            episodeProgress: { watched: 4, total: 10 },
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.episodeProgress).toEqual({ watched: 4, total: 10 });
    });

    it('accepts a watched series whose progress is short of the total', () => {
        // Prod case: a series explicitly marked watched (or synced from
        // Jellyfin) whose episode rollup lags because specials/unaired inflate
        // the denominator. The two fields are independent — do not couple them.
        const result = WatchlistItemSchema.safeParse({
            ...validItem,
            type: 'series',
            watched: true,
            episodeProgress: { watched: 24, total: 50 },
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.watched).toBe(true);
        expect(result.data.episodeProgress?.total).toBe(50);
    });

    it('omits progress for a movie without failing the contract', () => {
        const result = WatchlistItemSchema.safeParse({ ...validItem, watched: true });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.progress).toBeUndefined();
    });

    it('rejects an item missing the media block', () => {
        const result = WatchlistItemSchema.safeParse({
            isAvailable: true,
            canRequest: false,
            isSaved: true,
            watched: false,
        });
        expect(result.success).toBe(false);
    });

    it('rejects media without an id or ids map', () => {
        expect(
            WatchlistItemSchema.safeParse({
                catalogId: null,
                type: 'movie',
                title: 'X',
                ids: {},
                images: {},
                isSaved: true,
                watched: false,
            }).success,
        ).toBe(false);

        expect(
            WatchlistItemSchema.safeParse({
                id: 'tmdb:1:movie',
                catalogId: null,
                type: 'movie',
                title: 'X',
                images: {},
                isSaved: true,
                watched: false,
            }).success,
        ).toBe(false);
    });

    it('rejects isSaved: false — this endpoint only lists saved items', () => {
        const result = WatchlistItemSchema.safeParse({ ...validItem, isSaved: false });
        expect(result.success).toBe(false);
    });

    it('strips keys the schema does not declare (mirrors mount() behaviour)', () => {
        const result = WatchlistItemSchema.safeParse({
            ...validItem,
            somethingUndeclared: 'should not survive',
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data).not.toHaveProperty('somethingUndeclared');
    });
});
