// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getTVShowSeasonsResult` exists to keep ONE distinction the lenient
 * `getTVShowSeasons` destroys: whether an empty answer means "TMDB says no such
 * series" or "TMDB did not answer". Callers use it to decide retry-forever vs
 * give-up, so each branch is pinned here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createTMDBApi, TmdbApiError, type TMDBApiService } from './client';

type MakeRequestFn = (
    endpoint: string,
    params?: Record<string, string | number>,
    options?: { signal?: AbortSignal },
) => Promise<unknown>;

type MockableTMDBApi = TMDBApiService & { makeRequest: MakeRequestFn };

function spyMakeRequest(api: TMDBApiService): MockInstance<MakeRequestFn> {
    return vi.spyOn(api as MockableTMDBApi, 'makeRequest') as MockInstance<MakeRequestFn>;
}

describe('TMDBApiService.getTVShowSeasonsResult', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps a 404 to not-found — the series id is terminal, not retryable', async () => {
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockRejectedValueOnce(
            new TmdbApiError('TMDB API request failed: 404 Not Found', { status: 404 }),
        );

        const result = await api.getTVShowSeasonsResult(216416);

        expect(result.ok).toBe(false);
        // Narrow before reading `reason` — the union has no `reason` on the ok side.
        if (result.ok) throw new Error('expected failure');
        expect(result.reason).toBe('not-found');
    });

    it.each([
        ['429 rate limit', new TmdbApiError('rate limited', { status: 429 })],
        ['500 upstream', new TmdbApiError('server error', { status: 500 })],
        ['network/timeout (status null)', new TmdbApiError('fetch failed', { status: null })],
        [
            'auth-fatal key — GLOBAL, must not be charged to one item',
            new TmdbApiError('TMDB API key is invalid', { status: 401, authFatal: true }),
        ],
        [
            'non-404 4xx says the REQUEST was bad, not that the series is gone',
            new TmdbApiError('unprocessable', { status: 422 }),
        ],
    ])('maps %s to unavailable', async (_label, error) => {
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockRejectedValueOnce(error);

        const result = await api.getTVShowSeasonsResult(42);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected failure');
        expect(result.reason).toBe('unavailable');
    });

    it('reports ok with an EMPTY list when TMDB answers and lists no seasons', async () => {
        // The load-bearing case: this is a fact about the series, so it must NOT
        // look like the failures above.
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockResolvedValueOnce({ seasons: [] });

        const result = await api.getTVShowSeasonsResult(42);

        expect(result).toEqual({ ok: true, seasons: [] });
    });

    it('treats a missing seasons key as an answered-but-empty list, not a failure', async () => {
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockResolvedValueOnce({});

        const result = await api.getTVShowSeasonsResult(42);

        expect(result).toEqual({ ok: true, seasons: [] });
    });

    it('returns seasons sorted by season number', async () => {
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockResolvedValueOnce({
            seasons: [
                { season_number: 2, name: 'Season 2', episode_count: 8, poster_path: '/b.jpg' },
                { season_number: 0, name: 'Specials', episode_count: 3 },
                { season_number: 1, name: '', episode_count: 10, poster_path: '/a.jpg' },
            ],
        });

        const result = await api.getTVShowSeasonsResult(42);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('expected success');
        expect(result.seasons.map((s) => s.seasonNumber)).toEqual([0, 1, 2]);
        // Empty name falls back to a synthesized label.
        expect(result.seasons[1].name).toBe('Season 1');
        expect(result.seasons[2].posterPath).toBe('/b.jpg');
    });

    it('keeps getTVShowSeasons lenient — every failure still collapses to []', async () => {
        // The 5 other call sites depend on this; the strict variant is additive.
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockRejectedValueOnce(
            new TmdbApiError('TMDB API request failed: 404 Not Found', { status: 404 }),
        );
        await expect(api.getTVShowSeasons(216416)).resolves.toEqual([]);

        spyMakeRequest(api).mockRejectedValueOnce(new TmdbApiError('boom', { status: 500 }));
        await expect(api.getTVShowSeasons(42)).resolves.toEqual([]);
    });
});

describe('TMDBApiService.getSeasonsEpisodes (append_to_response batching)', () => {
    const ep = (season: number, n: number) => ({
        id: season * 100 + n,
        name: `E${n}`,
        episode_number: n,
        season_number: season,
    });

    it('fetches several seasons with ONE /tv/{id} request', async () => {
        const api = createTMDBApi('en-US');
        const spy = spyMakeRequest(api).mockResolvedValueOnce({
            'season/1': { episodes: [ep(1, 1)] },
            'season/2': { episodes: [ep(2, 1), ep(2, 2)] },
        });

        const result = await api.getSeasonsEpisodes(42, [1, 2]);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(
            '/tv/42',
            { append_to_response: 'season/1,season/2' },
            { signal: undefined },
        );
        expect(result.get(1)).toHaveLength(1);
        expect(result.get(2)?.map((e) => e.name)).toEqual(['E1', 'E2']);
    });

    it('uses the plain season endpoint for a single season', async () => {
        const api = createTMDBApi('en-US');
        const spy = spyMakeRequest(api).mockResolvedValueOnce({ episodes: [ep(3, 1)] });

        await api.getSeasonsEpisodes(42, [3]);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe('/tv/42/season/3');
    });

    it('splits more than 20 seasons into chunks of 20', async () => {
        const api = createTMDBApi('en-US');
        const spy = spyMakeRequest(api).mockImplementation(async (_e, params) => {
            const keys = String(params?.append_to_response ?? '').split(',');
            return Object.fromEntries(keys.map((k) => [k, { episodes: [] }]));
        });

        await api.getSeasonsEpisodes(
            42,
            Array.from({ length: 25 }, (_, i) => i + 1),
        );

        expect(spy).toHaveBeenCalledTimes(2);
        expect(String(spy.mock.calls[0][1]?.append_to_response).split(',')).toHaveLength(20);
    });

    it('does NOT fan out per season when the batch fails with 429 (1 request, then rethrow)', async () => {
        const api = createTMDBApi('en-US');
        const spy = spyMakeRequest(api).mockRejectedValue(
            new TmdbApiError('rate limited', { status: 429 }),
        );

        await expect(api.getSeasonsEpisodes(42, [1, 2, 3, 4])).rejects.toThrow('rate limited');
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['auth-fatal', new TmdbApiError('bad key', { status: 401, authFatal: true })],
        ['5xx', new TmdbApiError('server error', { status: 500 })],
    ])('rethrows a failed batch (%s) without per-season fallback', async (_l, error) => {
        const api = createTMDBApi('en-US');
        const spy = spyMakeRequest(api).mockRejectedValue(error);
        await expect(api.getSeasonsEpisodes(42, [1, 2])).rejects.toThrow();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('fetches only a season missing from an otherwise OK batch on its own', async () => {
        const api = createTMDBApi('en-US');
        const spy = spyMakeRequest(api)
            .mockResolvedValueOnce({ 'season/1': { episodes: [ep(1, 1)] }, 'season/2': null })
            .mockResolvedValueOnce({ episodes: [ep(2, 1)] });

        const result = await api.getSeasonsEpisodes(42, [1, 2]);

        expect(spy.mock.calls.map((c) => c[0])).toEqual(['/tv/42', '/tv/42/season/2']);
        expect(result.get(2)).toHaveLength(1);
    });

    it('checks the abort signal before each fallback call', async () => {
        const api = createTMDBApi('en-US');
        const ac = new AbortController();
        const spy = spyMakeRequest(api).mockImplementation(async (endpoint) => {
            if (endpoint === '/tv/42') return {}; // every season missing
            ac.abort();
            return { episodes: [] };
        });

        await expect(api.getSeasonsEpisodes(42, [1, 2, 3], ac.signal)).rejects.toThrow(/abort/i);
        // batch + the first fallback only; the abort stops the rest
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('returns null (incomplete) for a season whose own fetch fails non-fatally; rethrows 429', async () => {
        const api = createTMDBApi('en-US');
        spyMakeRequest(api)
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new TmdbApiError('gone', { status: 404 }))
            .mockResolvedValueOnce({ episodes: [ep(2, 1)] });
        const result = await api.getSeasonsEpisodes(42, [1, 2]);
        expect(result.get(1)).toBeNull();
        expect(result.get(2)).toHaveLength(1);

        spyMakeRequest(api).mockReset();
        spyMakeRequest(api)
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new TmdbApiError('rate limited', { status: 429 }));
        await expect(api.getSeasonsEpisodes(42, [1, 2])).rejects.toThrow('rate limited');
    });
});
