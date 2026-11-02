// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The Kavita lane must never hold the whole search hostage.
 *
 * `searchKavita` makes TWO sequential calls (`search()` then
 * `getSeriesMetadataBatch()`), each bounded only by the Kavita client's own
 * `TIMEOUTS.DEFAULT` (10s) — so a slow-but-alive Kavita could stall for ~20s.
 * `fanOut` awaits every lane with `Promise.all`, which means that was not
 * "books arrive late": it was the entire search response, movies included.
 *
 * The bound therefore has to be HOST-owned and live in `fanOut`, not inside the
 * source's own client where the source gets to choose how long the host waits.
 *
 * Lives in its own file because asserting it needs `features.kavita` on and a
 * mocked Kavita module — mocks the 800-line sibling suite deliberately does not
 * install.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchServiceOptions } from './search.service.js';

const kavitaSearch = vi.fn();
const getSeriesMetadataBatch = vi.fn();
const transformSearchResults = vi.fn();
vi.mock('$lib/server/plugins/kavita/index.js', () => ({
    search: kavitaSearch,
    getSeriesMetadataBatch,
    transformSearchResults,
}));

vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: { kavita: true },
}));

vi.mock('$lib/server/database/queries/search.queries.js', () => ({
    searchMedia: vi.fn(),
    searchMediaFulltext: vi.fn(),
    searchMediaTrigram: vi.fn(),
    searchEpisode: vi.fn(),
    searchMusic: vi.fn(),
}));

vi.mock('$lib/server/database/queries/audiobooks.queries.js', () => ({
    AUDIOBOOKSHELF_PROVIDER: 'audiobookshelf',
    AUDIOBOOK_MEDIA_TYPE: 'audiobook',
    getAbsItemIdsByMediaIds: vi.fn(),
}));

vi.mock('$lib/server/utils/suggestion-utils.js', () => ({
    parseEpisodeQuery: () => null,
}));

const warn = vi.fn();
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { SearchService, OPTIONAL_SOURCE_DEADLINE_MS } = await import('./search.service.js');

/** Books-only fan-out: the Kavita lane is the ONLY lane, so what `fanOut`
 *  resolves with is exactly what the deadline decided. */
function booksOnlyOpts(): SearchServiceOptions {
    return {
        sql: {} as never,
        deniedGroupIds: null,
        ageRating: null,
        q: 'sky harbor',
        window: 21,
        offset: 0,
        limit: 20,
        useFulltext: true,
        showUnavailableMedia: true,
        liveTvAllowed: false,
        surface: 'v1',
        sources: {
            movies: false,
            series: false,
            episodes: false,
            music: false,
            books: true,
            audiobooks: false,
            requests: false,
            channels: false,
            nonEntTypes: [],
        },
    };
}

/**
 * Observe settlement WITHOUT awaiting.
 *
 * Awaiting a promise that never settles fails by test timeout — 30s of silence
 * that says nothing about which invariant broke, and that a merely-slow
 * regression would produce identically. Reading a flag after the timers have
 * advanced fails instantly, with the assertion naming the deadline.
 */
function track<T>(p: Promise<T>): { settled: boolean } {
    const state = { settled: false };
    const mark = () => {
        state.settled = true;
    };
    p.then(mark, mark);
    return state;
}

const KAVITA_ROW = {
    id: 'kavita-series-42',
    mediaType: 'manga',
    title: 'Sky Harbor',
    overview: null,
    author: 'Eijiro Vale',
    year: 1997,
    libraryId: '3',
    imageUrl: '/api/image/kavita/42',
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    getSeriesMetadataBatch.mockResolvedValue(new Map());
    transformSearchResults.mockReturnValue([KAVITA_ROW]);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('fanOut — Kavita lane deadline', () => {
    it('resolves at the host deadline when Kavita never answers', async () => {
        // Never settles: the shape of a Kavita that accepted the connection and
        // then went quiet, which its own 10s client timeout would eventually
        // catch — far too late to matter to someone typing in a search box.
        kavitaSearch.mockReturnValue(new Promise(() => {}));

        const fanOut = SearchService.fanOut(booksOnlyOpts());
        const state = track(fanOut);

        await vi.advanceTimersByTimeAsync(OPTIONAL_SOURCE_DEADLINE_MS - 1);
        expect(state.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(state.settled).toBe(true);
        await expect(fanOut).resolves.toEqual({ items: [], degraded: true });
    });

    it('still returns rows when Kavita answers inside the deadline', async () => {
        kavitaSearch.mockReturnValue(
            new Promise((resolve) => setTimeout(() => resolve({ series: [] }), 500)),
        );

        const fanOut = SearchService.fanOut(booksOnlyOpts());
        await vi.advanceTimersByTimeAsync(500);
        const { items, degraded } = await fanOut;

        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe('kavita-series-42');
        expect(items[0]?.matchSource).toBe('kavita');
        expect(degraded).toBe(false);
    });

    it('bounds the pair of sequential calls, not each one separately', async () => {
        // The stall this fixes is cumulative: search() answering just inside the
        // budget must not then buy getSeriesMetadataBatch() a fresh budget.
        kavitaSearch.mockReturnValue(
            new Promise((resolve) =>
                setTimeout(
                    () => resolve({ series: [{ seriesId: 42 }] }),
                    OPTIONAL_SOURCE_DEADLINE_MS - 100,
                ),
            ),
        );
        getSeriesMetadataBatch.mockReturnValue(new Promise(() => {}));

        const fanOut = SearchService.fanOut(booksOnlyOpts());
        const state = track(fanOut);
        await vi.advanceTimersByTimeAsync(OPTIONAL_SOURCE_DEADLINE_MS);

        expect(state.settled).toBe(true);
        await expect(fanOut).resolves.toEqual({ items: [], degraded: true });
    });

    it('does not issue the second call once the deadline has passed', async () => {
        // Cancelling the in-flight first call needs the signal threaded into the
        // Kavita client; declining to START the second one does not, and it is
        // the one that would hold a socket for another 10s per abandoned search.
        kavitaSearch.mockReturnValue(
            new Promise((resolve) =>
                setTimeout(
                    () => resolve({ series: [{ seriesId: 42 }] }),
                    OPTIONAL_SOURCE_DEADLINE_MS + 100,
                ),
            ),
        );

        const fanOut = SearchService.fanOut(booksOnlyOpts());
        await vi.advanceTimersByTimeAsync(OPTIONAL_SOURCE_DEADLINE_MS + 100);

        await expect(fanOut).resolves.toEqual({ items: [], degraded: true });
        expect(getSeriesMetadataBatch).not.toHaveBeenCalled();
    });

    it('a lane that FAILS yields no rows but does not mark the page degraded', async () => {
        // The distinction is what the def caches on. A down Kavita has no books
        // to give and will still have none in a second, so that empty page is
        // the honest answer and caching it normally is correct. A lane that ran
        // out of time might have had books — that page is a guess, and the def
        // gives it a short TTL instead of serving it to the whole access scope
        // for 45s.
        kavitaSearch.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(SearchService.fanOut(booksOnlyOpts())).resolves.toEqual({
            items: [],
            degraded: false,
        });
        expect(warn).toHaveBeenCalledWith('Kavita search failed', expect.any(Error));
    });

    it('swallows a Kavita rejection that lands after the deadline', async () => {
        // Two hazards, one scenario. The losing promise keeps running after the
        // race is decided: an unabsorbed rejection becomes a process-level
        // unhandled rejection (vitest fails the file on one, so the clean run is
        // half the assertion), and a second log would contradict the first about
        // a response that shipped 1.5s earlier.
        kavitaSearch.mockReturnValue(
            new Promise((_, reject) => setTimeout(() => reject(new Error('ECONNRESET')), 3000)),
        );

        const fanOut = SearchService.fanOut(booksOnlyOpts());
        await vi.advanceTimersByTimeAsync(OPTIONAL_SOURCE_DEADLINE_MS);
        await expect(fanOut).resolves.toEqual({ items: [], degraded: true });
        expect(warn).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalledWith('Kavita search failed', expect.any(Error));
    });
});
