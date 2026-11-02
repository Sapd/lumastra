// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BecauseYouWatchedStrategy — domain routing.
 *
 * The strategy is domain-scoped: `domain=music` (the default) seeds from recent
 * audio plays; `domain=video` seeds from the user's most-recently-watched
 * LIBRARY video (movie/series) and expands it via `fetchSimilarMedia`. A video
 * Home surface passes `?domain=video` so music can never bleed into the rail.
 *
 * These tests cover the video path in isolation: every dynamic import inside
 * `#fetchVideo` is mocked at its module path, so no DB/AI is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import type { AccessContext, RecommenderOptions } from '../recommender.js';

const mockGetDb = vi.hoisted(() => vi.fn());
const mockGetRecentMovies = vi.hoisted(() => vi.fn());
const mockGetRecentTv = vi.hoisted(() => vi.fn());
const mockFetchSimilar = vi.hoisted(() => vi.fn());
const mockGetUserWatchedItems = vi.hoisted(() => vi.fn());
const mockResolveUuid = vi.hoisted(() => vi.fn());
const mockFilterAccessible = vi.hoisted(() => vi.fn());
const mockGetTranslationMapForItems = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/embedding-similarity.queries.js', () => ({
    resolveUuidToProvider: (...a: unknown[]) => mockResolveUuid(...a),
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    // Echo the rows back = "allowed" by default; individual tests override.
    filterAccessibleRows: (_sql: unknown, rows: unknown[]) => mockFilterAccessible(rows),
}));
vi.mock('$lib/server/database/queries/media-translations.queries.js', () => ({
    getTranslationMapForItems: (...a: unknown[]) => mockGetTranslationMapForItems(...a),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/index.js', () => ({
    getRecentWatchedMoviesWithEmbeddings: { all: (...a: unknown[]) => mockGetRecentMovies(...a) },
    getRecentWatchedTvWithEmbeddings: { all: (...a: unknown[]) => mockGetRecentTv(...a) },
}));

vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    restrictedAccess: vi.fn().mockReturnValue({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

vi.mock('$lib/server/services/for-you.service.js', () => ({
    fetchSimilarMedia: (...args: unknown[]) => mockFetchSimilar(...args),
}));

vi.mock('$lib/server/utils/user-watch-history.js', () => ({
    getUserWatchedItems: (...args: unknown[]) => mockGetUserWatchedItems(...args),
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    createExternalIds: (obj: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = v;
        return out;
    },
    getExternalIdFor: (extIds: Record<string, unknown> | null | undefined, key: string) =>
        extIds?.[key],
}));

// Real-ish mapBatch: echo similar rows into recommendation items so we can
// assert the strategy's own seed/label decoration on top.
vi.mock('../../for-you/item-mapper.js', () => ({
    mapBatch: (
        rows: Array<{ externalIds: Record<string, unknown>; mediaType: string; title: string }>,
        limit: number,
        reasonKind: string,
        _surface: 'internal' | 'v1',
        scoreFn?: (r: unknown) => number | undefined,
    ) => ({
        items: rows.slice(0, limit).map((r) => ({
            media: { id: r.externalIds.internal, type: r.mediaType, title: r.title, ids: {} },
            ...(scoreFn?.(r) !== undefined ? { score: scoreFn(r) } : {}),
            reason: { kind: reasonKind },
        })),
        hasMore: rows.length > limit,
    }),
    // Rail-metadata hydration is a separate DB round trip this suite doesn't
    // exercise — every dynamic import in #fetchVideo is mocked so no DB is
    // needed, and this rail's own seed/reason-decoration logic is what's under
    // test here.
    hydrateRailMetadata: vi.fn().mockResolvedValue(undefined),
}));

const { becauseYouWatchedStrategy } = await import('./because-you-watched.strategy.js');

function makeCtx(partial: Partial<AccessContext> = {}): AccessContext {
    return {
        userId: 'usr_00000000-0000-0000-0000-000000000001' as UserId,
        username: 'alice',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
        ...partial,
    };
}

function makeOpts(partial: Partial<RecommenderOptions> = {}): RecommenderOptions {
    return { surface: 'internal', limit: 10, offset: 0, ...partial };
}

const MOVIE_SEED = {
    media_id: 'mov-uuid',
    tmdb_id: '603',
    media_type: 'movie',
    title: 'The Lantern',
    watched_at: '2026-07-21T10:00:00.000Z',
};
const TV_SEED = {
    media_id: 'tv-uuid',
    tmdb_id: '1396',
    media_type: 'tv',
    title: 'Drifting Clouds',
    watched_at: '2026-07-20T10:00:00.000Z',
};

describe('BecauseYouWatchedStrategy — domain=video', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGetUserWatchedItems.mockResolvedValue([]);
        mockFilterAccessible.mockImplementation((rows) => rows);
        mockGetTranslationMapForItems.mockResolvedValue(new Map());
    });

    it('defaults an unqualified request to the video domain', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([]);
        mockFetchSimilar.mockResolvedValue([
            {
                externalIds: { internal: 'sim-default-video' },
                mediaType: 'movie',
                title: 'John Wick',
                similarity: 88,
                isAvailable: true,
            },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(makeCtx(), makeOpts({ limit: 10 }));

        expect(mockFetchSimilar).toHaveBeenCalledTimes(1);
        expect(result.items[0]?.media.type).toBe('movie');
    });

    it('seeds from the most-recently-watched video and decorates items with a because-you-watched reason', async () => {
        // Movie watched more recently than the show → the movie is the seed.
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([TV_SEED]);
        mockFetchSimilar.mockResolvedValue([
            {
                externalIds: { internal: 'sim-1' },
                mediaType: 'movie',
                title: 'John Wick',
                similarity: 88,
                isAvailable: true,
            },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx(),
            makeOpts({ limit: 10, extra: { domain: 'video' } }),
        );

        // fetchSimilarMedia called with the MOVIE seed's media type ('movie').
        expect(mockFetchSimilar).toHaveBeenCalledTimes(1);
        expect(mockFetchSimilar.mock.calls[0][2]).toBe('movie');

        expect(result.items).toHaveLength(1);
        expect(result.items[0].reason).toEqual({
            kind: 'because-you-watched',
            seed: 'mov-uuid',
            label: 'The Lantern',
        });
    });

    it.each([
        [false, true],
        [true, false],
    ])(
        'showUnavailableMedia=%s asks the similarity query for availableOnly=%s',
        async (showUnavailableMedia, expectedAvailableOnly) => {
            mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
            mockGetRecentTv.mockResolvedValue([]);
            mockFetchSimilar.mockResolvedValue([
                {
                    externalIds: { internal: 'sim-owned' },
                    mediaType: 'movie',
                    title: 'Owned',
                    similarity: 90,
                    isAvailable: true,
                    canRequest: false,
                },
            ]);

            const result = await becauseYouWatchedStrategy.fetch(
                makeCtx({ showUnavailableMedia }),
                makeOpts({ extra: { domain: 'video' } }),
            );

            // The filter lives in the query (so `limit` counts available rows), not in JS.
            expect(mockFetchSimilar.mock.calls[0][8]).toEqual({
                availableOnly: expectedAvailableOnly,
            });
            expect(result.items.map((i) => i.media.id)).toEqual(['sim-owned']);
        },
    );

    it('keeps file-less rows the query returns when unavailable media is visible', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([]);
        mockFetchSimilar.mockResolvedValue([
            {
                externalIds: { internal: 'sim-ghost' },
                mediaType: 'movie',
                title: 'Ghost',
                similarity: 80,
                isAvailable: false,
                canRequest: true,
            },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx({ showUnavailableMedia: true }),
            makeOpts({ extra: { domain: 'video' } }),
        );

        expect(result.items.map((i) => i.media.id)).toEqual(['sim-ghost']);
    });

    it('picks the show as the seed when it was watched more recently than any movie', async () => {
        mockGetRecentMovies.mockResolvedValue([
            { ...MOVIE_SEED, watched_at: '2026-07-19T10:00:00.000Z' },
        ]);
        mockGetRecentTv.mockResolvedValue([TV_SEED]); // 2026-07-20 — newer
        mockFetchSimilar.mockResolvedValue([
            {
                externalIds: { internal: 'sim-2' },
                mediaType: 'tv',
                title: 'The Wisp',
                similarity: 77,
            },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx(),
            makeOpts({ extra: { domain: 'video' } }),
        );

        expect(mockFetchSimilar.mock.calls[0][2]).toBe('tv');
        expect(result.items[0].reason).toMatchObject({ seed: 'tv-uuid', label: 'Drifting Clouds' });
    });

    it('returns empty (no similar call) when the user has no recent video watch history', async () => {
        mockGetRecentMovies.mockResolvedValue([]);
        mockGetRecentTv.mockResolvedValue([]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx(),
            makeOpts({ extra: { domain: 'video' } }),
        );

        expect(result).toEqual({ items: [], hasMore: false });
        expect(mockFetchSimilar).not.toHaveBeenCalled();
    });

    it('returns empty for age-restricted profiles without hitting AI similar (AI-features policy)', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx({ isAgeRestricted: true }),
            makeOpts({ extra: { domain: 'video' } }),
        );

        expect(result).toEqual({ items: [], hasMore: false });
        expect(mockFetchSimilar).not.toHaveBeenCalled();
    });

    it('uses the explicitly requested seed when opts.seed matches a pooled item', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]); // most-recent
        mockGetRecentTv.mockResolvedValue([TV_SEED]);
        mockFetchSimilar.mockResolvedValue([
            { externalIds: { internal: 'sim-9' }, mediaType: 'tv', title: 'X', similarity: 70 },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx(),
            makeOpts({ extra: { domain: 'video' }, seed: 'tv-uuid' }), // NOT the most-recent
        );

        // Seed is the requested tv item, not the most-recent movie.
        expect(mockFetchSimilar.mock.calls[0][2]).toBe('tv');
        expect(result.items[0].reason).toMatchObject({ seed: 'tv-uuid', label: 'Drifting Clouds' });
        // Pool match means no DB resolve was needed.
        expect(mockResolveUuid).not.toHaveBeenCalled();
    });

    it('resolves opts.seed via the DB (with its OWN title) when not in the recent pool', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([]);
        // Use a valid-shaped UUID so the UUID guard passes.
        mockResolveUuid.mockResolvedValue({
            tmdb_id: '1399',
            media_type: 'tv',
            title: 'Lanterns of Winter',
        });
        mockFetchSimilar.mockResolvedValue([
            { externalIds: { internal: 'sim-10' }, mediaType: 'tv', title: 'Y', similarity: 60 },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx(),
            makeOpts({ extra: { domain: 'video' }, seed: '11111111-1111-1111-1111-111111111111' }),
        );

        expect(mockResolveUuid).toHaveBeenCalledWith(
            expect.anything(),
            '11111111-1111-1111-1111-111111111111',
        );
        expect(mockFetchSimilar.mock.calls[0][2]).toBe('tv');
        // M1: the rail is labeled with the SEED's title, not the most-recent movie's.
        expect(result.items[0].reason).toMatchObject({
            seed: '11111111-1111-1111-1111-111111111111',
            label: 'Lanterns of Winter',
        });
    });

    it('falls back to most-recent when a DB-resolved seed is access-denied (no existence oracle)', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]); // most-recent
        mockGetRecentTv.mockResolvedValue([]);
        mockResolveUuid.mockResolvedValue({ tmdb_id: '1399', media_type: 'tv', title: 'Denied' });
        mockFilterAccessible.mockImplementation(() => []); // boundary drops the seed
        mockFetchSimilar.mockResolvedValue([
            { externalIds: { internal: 'sim-11' }, mediaType: 'movie', title: 'Z', similarity: 50 },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx({ deniedGroupIds: ['grp-1'] }),
            makeOpts({ extra: { domain: 'video' }, seed: '22222222-2222-2222-2222-222222222222' }),
        );

        // Anchored on the accessible most-recent movie, NOT the denied seed.
        expect(result.items[0].reason).toMatchObject({ seed: 'mov-uuid', label: 'The Lantern' });
    });

    it('falls back to most-recent for a non-UUID seed without touching the DB resolver', async () => {
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([]);
        mockFetchSimilar.mockResolvedValue([
            { externalIds: { internal: 'sim-12' }, mediaType: 'movie', title: 'W', similarity: 40 },
        ]);

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx(),
            makeOpts({ extra: { domain: 'video' }, seed: 'tmdb:550:movie' }), // composite, not a UUID
        );

        expect(mockResolveUuid).not.toHaveBeenCalled();
        expect(result.items[0].reason).toMatchObject({ seed: 'mov-uuid' });
    });

    it('localizes the seed title in reason.label', async () => {
        // Seed row title is the primary-language value; the overlay supplies German.
        mockGetRecentMovies.mockResolvedValue([MOVIE_SEED]);
        mockGetRecentTv.mockResolvedValue([]);
        mockFetchSimilar.mockResolvedValue([
            { externalIds: { internal: 'sim-13' }, mediaType: 'movie', title: 'V', similarity: 30 },
        ]);
        mockGetTranslationMapForItems.mockResolvedValue(
            new Map([['mov-uuid', { title: 'Der Hüter der Lichter' }]]),
        );

        const result = await becauseYouWatchedStrategy.fetch(
            makeCtx({ langs: { titleLang: 'de-DE', textLang: 'de-DE' } }),
            makeOpts({ limit: 5, extra: { domain: 'video' } }),
        );

        expect(result.items[0].reason).toMatchObject({ label: 'Der Hüter der Lichter' });
    });
});
