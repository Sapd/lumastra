// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Discovery list paging depth, asserted as TMDB list requests actually made.
 *
 * Every sweep used to page popular / top-rated / trending to their caps for
 * both media types — ~740 list requests per sweep on prod, twice a day — while
 * only the fronts of popular and trending surface new titles. A shallow sweep
 * pages just those fronts; the deep sweep (weekly) still pages everything.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type ListFn = (providerId: string, args: { mediaType: string; page: number }) => Promise<unknown[]>;

const providers = vi.hoisted(() => ({
    invokeProviderPopular: vi.fn<ListFn>(),
    invokeProviderTopRated: vi.fn<ListFn>(),
    invokeProviderTrending: vi.fn<ListFn>(),
    invokeProviderDetail: vi.fn(async () => null),
}));
vi.mock('../tasks/plugin-context.js', () => providers);

vi.mock('../database/connection', () => ({
    Database: class {
        getSql(): unknown {
            return {};
        }
    },
}));

let nextMediaId = 0;
vi.mock('../database/queries/media-upsert', () => ({
    upsertMediaMetadata: vi.fn(async () => ({ mediaId: `m-${nextMediaId++}`, inserted: true })),
}));

vi.mock('../database/queries/ai-sync.queries.js', () => ({
    updateOriginalTitleByTmdbId: vi.fn(),
    listOriginalTitleBackfillCandidates: vi.fn(async () => []),
    listFreshDiscoveryDetailKeys: vi.fn(async () => new Set()),
    DISCOVERY_DETAIL_SYNCED_AT_KEY: 'discovery_detail_synced_at',
}));

vi.mock('../database/queries/metadata-aggregation.queries.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    batchAggregateMetadata: vi.fn(async () => ({ aggregated: 0, skipped: 0, errors: 0 })),
}));

import { syncTMDBMetadata, SHALLOW_LIST_PAGES } from './tmdb-metadata-sync.js';

let nextTmdbId = 1;
/** A page of 20 distinct titles that pass the default rating/vote filters. */
function page(): unknown[] {
    return Array.from({ length: 20 }, () => ({
        id: nextTmdbId++,
        title: 'T',
        name: 'T',
        vote_average: 8,
        vote_count: 1000,
        popularity: 100,
    }));
}

function pagesRequested(fn: ReturnType<typeof vi.fn<ListFn>>, mediaType: string): number {
    return fn.mock.calls.filter(([, args]) => args.mediaType === mediaType).length;
}

describe('syncTMDBMetadata: discovery list depth', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const fn of [
            providers.invokeProviderPopular,
            providers.invokeProviderTopRated,
            providers.invokeProviderTrending,
        ]) {
            fn.mockImplementation(async () => page());
        }
    });

    it('shallow: pages only the fronts of popular and trending, never top-rated', async () => {
        await syncTMDBMetadata({ listDepth: 'shallow', fetchDetails: false });

        for (const mediaType of ['movie', 'tv']) {
            expect(pagesRequested(providers.invokeProviderPopular, mediaType)).toBe(
                SHALLOW_LIST_PAGES.popular,
            );
            expect(pagesRequested(providers.invokeProviderTrending, mediaType)).toBe(
                SHALLOW_LIST_PAGES.trending,
            );
            expect(pagesRequested(providers.invokeProviderTopRated, mediaType)).toBe(0);
        }
    }, 30_000);

    it('deep (the default): pages every source, top-rated included', async () => {
        // Each list ends after one page so the deep run stays fast; what matters
        // is that every source is visited.
        for (const fn of [
            providers.invokeProviderPopular,
            providers.invokeProviderTopRated,
            providers.invokeProviderTrending,
        ]) {
            fn.mockImplementation(async (_id, { page: n }) => (n === 1 ? page() : []));
        }

        await syncTMDBMetadata({ fetchDetails: false });

        for (const mediaType of ['movie', 'tv']) {
            expect(pagesRequested(providers.invokeProviderTopRated, mediaType)).toBe(2);
            expect(pagesRequested(providers.invokeProviderPopular, mediaType)).toBe(2);
            expect(pagesRequested(providers.invokeProviderTrending, mediaType)).toBe(2);
        }
    });

    it('stops after the first page when the TMDB provider is not registered', async () => {
        // Windows e2e 2026-09-27: 56x "Failed to fetch popular movies page N —
        // Provider not found in registry" — every page failed the same way.
        const missing = async (): Promise<unknown[]> => {
            throw new Error('Provider not found in registry: tmdb-metadata-provider');
        };
        for (const fn of [
            providers.invokeProviderPopular,
            providers.invokeProviderTopRated,
            providers.invokeProviderTrending,
        ]) {
            fn.mockImplementation(missing);
        }

        await syncTMDBMetadata({ fetchDetails: false });

        for (const mediaType of ['movie', 'tv']) {
            expect(pagesRequested(providers.invokeProviderPopular, mediaType)).toBe(1);
            expect(pagesRequested(providers.invokeProviderTopRated, mediaType)).toBe(0);
            expect(pagesRequested(providers.invokeProviderTrending, mediaType)).toBe(0);
        }
    });
});
