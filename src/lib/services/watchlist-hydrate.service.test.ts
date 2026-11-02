// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The watchlist membership index is now hydrated once app-wide from the root
 * layout, so the "once" is the whole contract: a second call on a later
 * navigation must NOT re-run the full unpaginated enrichment query, while the
 * /watchlist page's explicit refresh (`force`) always must.
 *
 * The failure this guards is silent in both directions — a broken memo just
 * makes every page load slower, and a memo that also swallows `force` leaves
 * the watchlist page showing stale rows after a removal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const getSavedMovies = vi.fn();

vi.mock('$lib/api/ai', () => ({
    getSavedMovies: () => getSavedMovies(),
}));

import {
    ensureWatchlistHydrated,
    scheduleWatchlistHydration,
    toWatchlistStoreItem,
    resetWatchlistHydrationForTests,
} from './watchlist-hydrate.service';
import { watchlistItems, watchlistState, setWatchlistItems } from '$lib/stores/watchlist';
import type { WatchlistListResponse } from '$lib/schemas/api-watchlist-responses';

type WireItem = WatchlistListResponse['items'][number];

/**
 * One item in the canonical `{ media, … }` envelope the endpoint returns.
 *
 * Annotated with the real response type on purpose: `toWatchlistStoreItem`
 * takes exactly this, so an envelope change (a new required field on
 * `RecommendedMediaRef`, say) has to fail HERE rather than let the tests keep
 * passing against a shape the endpoint no longer sends.
 */
function wireItem(id: string, type: 'movie' | 'series'): WireItem {
    return {
        id,
        catalogId: id,
        ids: {},
        type,
        title: `Title ${id}`,
        images: {},
        availability: { isAvailable: true, canRequest: false },
        isSaved: true,
        savedAt: '2026-08-11T00:00:00.000Z',
        watched: false,
    };
}

function okResponse(items: WireItem[]) {
    return { data: { items, page: {} }, error: null };
}

describe('watchlist-hydrate service', () => {
    beforeEach(() => {
        resetWatchlistHydrationForTests();
        setWatchlistItems([]);
        getSavedMovies.mockReset();
        getSavedMovies.mockResolvedValue(okResponse([wireItem('m1', 'movie')]));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('fetches once and fills the store', async () => {
        await ensureWatchlistHydrated();

        expect(getSavedMovies).toHaveBeenCalledTimes(1);
        expect(get(watchlistItems)).toHaveLength(1);
        expect(get(watchlistState)).toMatchObject({
            loading: false,
            error: '',
            isDatabaseAvailable: true,
        });
    });

    it('does not refetch on later calls', async () => {
        await ensureWatchlistHydrated();
        await ensureWatchlistHydrated();
        await ensureWatchlistHydrated();

        expect(getSavedMovies).toHaveBeenCalledTimes(1);
    });

    it('refetches when forced', async () => {
        await ensureWatchlistHydrated();
        getSavedMovies.mockResolvedValue(
            okResponse([wireItem('m1', 'movie'), wireItem('s1', 'series')]),
        );

        await ensureWatchlistHydrated({ force: true });

        expect(getSavedMovies).toHaveBeenCalledTimes(2);
        expect(get(watchlistItems)).toHaveLength(2);
    });

    it('shares one request between concurrent callers', async () => {
        await Promise.all([
            ensureWatchlistHydrated(),
            ensureWatchlistHydrated(),
            ensureWatchlistHydrated(),
        ]);

        expect(getSavedMovies).toHaveBeenCalledTimes(1);
    });

    it('records the error and stays retryable when the fetch fails', async () => {
        getSavedMovies.mockResolvedValue({ data: null, error: 'nope' });

        await ensureWatchlistHydrated();

        expect(get(watchlistItems)).toHaveLength(0);
        expect(get(watchlistState)).toMatchObject({
            loading: false,
            error: 'nope',
            isDatabaseAvailable: false,
        });

        // Not memoised as done — a later page load may still succeed.
        getSavedMovies.mockResolvedValue(okResponse([wireItem('m1', 'movie')]));
        await ensureWatchlistHydrated();
        expect(getSavedMovies).toHaveBeenCalledTimes(2);
        expect(get(watchlistItems)).toHaveLength(1);
    });

    it('never rejects when the request throws', async () => {
        getSavedMovies.mockRejectedValue(new Error('offline'));

        await expect(ensureWatchlistHydrated()).resolves.toBeUndefined();
        expect(get(watchlistState).isDatabaseAvailable).toBe(false);
    });

    it('maps the wire "series" discriminator to the store\'s "tv"', () => {
        expect(toWatchlistStoreItem(wireItem('s1', 'series')).mediaType).toBe('tv');
        expect(toWatchlistStoreItem(wireItem('m1', 'movie')).mediaType).toBe('movie');
    });

    it('defers the fetch to requestIdleCallback', async () => {
        const idle = vi.fn((cb: () => void) => {
            cb();
            return 1;
        });
        vi.stubGlobal('window', { requestIdleCallback: idle });

        scheduleWatchlistHydration();
        await vi.waitFor(() => expect(getSavedMovies).toHaveBeenCalledTimes(1));
        expect(idle).toHaveBeenCalledTimes(1);
    });
});
