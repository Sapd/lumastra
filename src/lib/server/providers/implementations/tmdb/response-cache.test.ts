// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The TMDB detail response cache, at the seam that matters: how many requests
 * the client actually makes. Matching an item starts series-sync, translations,
 * the per-season poster stage and metadata-update within seconds of each other,
 * and each used to fetch the same /tv/{id} again.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createTMDBApi, TmdbApiError, type TMDBApiService } from './client';
import {
    cachedTmdbResponse,
    clearTmdbResponseCache,
    setTmdbResponseCacheEnabled,
    tmdbResponseCacheKey,
    tmdbResponseCacheSize,
} from './response-cache';

type MakeRequestFn = (
    endpoint: string,
    params?: Record<string, string | number>,
    options?: { signal?: AbortSignal },
) => Promise<unknown>;

function spyMakeRequest(api: TMDBApiService): MockInstance<MakeRequestFn> {
    // The cache is only consulted while the client is available (key set and not
    // known bad); the test env has no TMDB key.
    vi.spyOn(api, 'isAvailable').mockReturnValue(true);
    return vi.spyOn(
        api as TMDBApiService & { makeRequest: MakeRequestFn },
        'makeRequest',
    ) as MockInstance<MakeRequestFn>;
}

const SERIES = {
    id: 387,
    name: 'Harborfolk Adventures',
    seasons: [
        { season_number: 1, name: 'Season 1', episode_count: 20, poster_path: '/s1.jpg' },
        { season_number: 2, name: 'Season 2', episode_count: 20, poster_path: '/s2.jpg' },
    ],
};

describe('TMDB response cache', () => {
    beforeEach(() => {
        setTmdbResponseCacheEnabled(true);
    });
    afterEach(() => {
        setTmdbResponseCacheEnabled(false);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('series-sync then one season-poster run per season: ONE request', async () => {
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api).mockResolvedValue(structuredClone(SERIES));

        await api.getTVShowDetails(387); // series-sync
        await api.getTVShowDetails(387); // series-children, same run
        const s1 = await api.getTVShowSeasonsResult(387); // season 1 poster
        const s2 = await api.getTVShowSeasonsResult(387); // season 2 poster

        expect(req).toHaveBeenCalledTimes(1);
        expect(s1.ok && s1.seasons.map((s) => s.posterPath)).toEqual(['/s1.jpg', '/s2.jpg']);
        expect(s2).toEqual(s1);
    });

    it('keys on language and endpoint: a different language or id is its own request', async () => {
        const en = createTMDBApi('en-US');
        const de = createTMDBApi('de-DE');
        const enReq = spyMakeRequest(en).mockResolvedValue(structuredClone(SERIES));
        const deReq = spyMakeRequest(de).mockResolvedValue(structuredClone(SERIES));

        await en.getTVShowDetails(387);
        await de.getTVShowDetails(387);
        await en.getTVShowDetails(388);
        await en.getMovieDetails(387);

        expect(enReq).toHaveBeenCalledTimes(3);
        expect(deReq).toHaveBeenCalledTimes(1);
    });

    it('never caches a failure — the next caller asks TMDB again', async () => {
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api)
            .mockRejectedValueOnce(new TmdbApiError('rate limited', { status: 429 }))
            .mockResolvedValueOnce(structuredClone(SERIES));

        const first = await api.getTVShowSeasonsResult(387);
        const second = await api.getTVShowSeasonsResult(387);

        expect(first.ok).toBe(false);
        expect(second.ok).toBe(true);
        expect(req).toHaveBeenCalledTimes(2);
    });

    it('expires after ten minutes', async () => {
        vi.useFakeTimers();
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api).mockResolvedValue(structuredClone(SERIES));

        await api.getTVShowDetails(387);
        vi.advanceTimersByTime(9 * 60 * 1000);
        await api.getTVShowDetails(387);
        vi.advanceTimersByTime(2 * 60 * 1000);
        await api.getTVShowDetails(387);

        expect(req).toHaveBeenCalledTimes(2);
    });

    it('a caller mutating its copy does not change what the next caller gets', async () => {
        const api = createTMDBApi('en-US');
        spyMakeRequest(api).mockResolvedValue(structuredClone(SERIES));

        const a = (await api.getTVShowDetails(387)) as unknown as typeof SERIES;
        a.name = 'mutated';
        const b = (await api.getTVShowDetails(387)) as unknown as typeof SERIES;

        expect(b.name).toBe('Harborfolk Adventures');
    });

    it('concurrent identical requests share one fetch; a caller with a signal does not', async () => {
        let calls = 0;
        const load = async (): Promise<{ n: number }> => {
            calls++;
            await new Promise((r) => setTimeout(r, 5));
            return { n: calls };
        };
        const key = tmdbResponseCacheKey('en-US', '/tv/1');

        const [x, y] = await Promise.all([
            cachedTmdbResponse(key, load),
            cachedTmdbResponse(key, load),
        ]);
        expect(calls).toBe(1);
        expect(x).toEqual(y);

        setTmdbResponseCacheEnabled(true); // clear
        const ac = new AbortController();
        await Promise.all([
            cachedTmdbResponse(key, load, { signal: ac.signal }),
            cachedTmdbResponse(key, load),
        ]);
        expect(calls).toBe(3);
    });

    it('stays bounded', async () => {
        for (let i = 0; i < 100; i++) {
            await cachedTmdbResponse(tmdbResponseCacheKey('en-US', `/tv/${i}`), async () => ({
                i,
            }));
        }
        expect(tmdbResponseCacheSize()).toBeLessThanOrEqual(64);
    });

    it('is off by default under vitest, so other suites keep seeing every call', async () => {
        setTmdbResponseCacheEnabled(false);
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api).mockResolvedValue(structuredClone(SERIES));

        await api.getTVShowDetails(387);
        await api.getTVShowDetails(387);

        expect(req).toHaveBeenCalledTimes(2);
    });

    it('fresh: true (forced admin refresh) asks TMDB again, and stores the new answer', async () => {
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api)
            .mockResolvedValueOnce({ ...structuredClone(SERIES), name: 'old' })
            .mockResolvedValueOnce({ ...structuredClone(SERIES), name: 'new' });

        await api.getTVShowDetails(387);
        const forced = (await api.getTVShowDetails(387, {
            fresh: true,
        })) as unknown as typeof SERIES;
        const after = (await api.getTVShowDetails(387)) as unknown as typeof SERIES;

        expect(req).toHaveBeenCalledTimes(2);
        expect(forced.name).toBe('new');
        expect(after.name).toBe('new');
    });

    it('is bypassed while the client is unavailable, so an auth failure still surfaces', async () => {
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api).mockResolvedValue(structuredClone(SERIES));
        await api.getTVShowDetails(387); // cached while available

        vi.spyOn(api, 'isAvailable').mockReturnValue(false);
        req.mockRejectedValueOnce(
            new TmdbApiError('TMDB API key is invalid', { status: 401, authFatal: true }),
        );

        await expect(api.getTVShowDetails(387)).rejects.toThrow('TMDB API key is invalid');
    });

    it('a season-list miss uses the LIGHT /tv/{id}, not the heavy detail payload', async () => {
        const api = createTMDBApi('en-US');
        const req = spyMakeRequest(api).mockResolvedValue(structuredClone(SERIES));

        await api.getTVShowSeasonsResult(387);

        expect(req).toHaveBeenCalledWith('/tv/387');
    });

    it('a joiner never sees the originator mutating its result', async () => {
        let release: (v: unknown) => void = () => {};
        const load = (): Promise<{ name: string }> =>
            new Promise((r) => {
                release = r as (v: unknown) => void;
            });
        const key = tmdbResponseCacheKey('en-US', '/tv/9');

        const originator = cachedTmdbResponse(key, load).then((v) => {
            v.name = 'mutated by originator';
            return v;
        });
        const joiner = cachedTmdbResponse(key, load);
        release({ name: 'pristine' });

        await originator;
        expect((await joiner).name).toBe('pristine');
    });

    it('a joiner whose shared fetch failed retries on its own', async () => {
        const key = tmdbResponseCacheKey('en-US', '/tv/10');
        let attempt = 0;
        const load = async (): Promise<{ ok: boolean }> => {
            attempt++;
            await new Promise((r) => setTimeout(r, 2));
            if (attempt === 1) throw new TmdbApiError('rate limited', { status: 429 });
            return { ok: true };
        };

        const [a, b] = await Promise.allSettled([
            cachedTmdbResponse(key, load),
            cachedTmdbResponse(key, load),
        ]);

        expect(a.status).toBe('rejected');
        expect(b).toEqual({ status: 'fulfilled', value: { ok: true } });
    });

    it('a fetch in flight during a clear does not repopulate the cache', async () => {
        let release: (v: unknown) => void = () => {};
        const key = tmdbResponseCacheKey('en-US', '/tv/11');
        const p = cachedTmdbResponse(
            key,
            () =>
                new Promise((r) => {
                    release = r as (v: unknown) => void;
                }),
        );
        clearTmdbResponseCache();
        release({ x: 1 });
        await p;

        expect(tmdbResponseCacheSize()).toBe(0);
    });

    it('evicts the least recently USED entry', async () => {
        for (let i = 0; i < 64; i++) {
            await cachedTmdbResponse(tmdbResponseCacheKey('en-US', `/tv/${i}`), async () => ({
                i,
            }));
        }
        // Touch entry 0, then add one more: entry 1 (now the coldest) goes.
        let reloads = 0;
        await cachedTmdbResponse(tmdbResponseCacheKey('en-US', '/tv/0'), async () => {
            reloads++;
            return { i: 0 };
        });
        await cachedTmdbResponse(tmdbResponseCacheKey('en-US', '/tv/64'), async () => ({ i: 64 }));
        await cachedTmdbResponse(tmdbResponseCacheKey('en-US', '/tv/0'), async () => {
            reloads++;
            return { i: 0 };
        });
        await cachedTmdbResponse(tmdbResponseCacheKey('en-US', '/tv/1'), async () => {
            reloads++;
            return { i: 1 };
        });

        expect(reloads).toBe(1); // only /tv/1 had to be fetched again
    });

    it('is bounded by bytes, and keeps no single oversized response', async () => {
        const big = 'x'.repeat(5 * 1024 * 1024);
        await cachedTmdbResponse(tmdbResponseCacheKey('en-US', '/tv/big'), async () => ({ big }));
        expect(tmdbResponseCacheSize()).toBe(0);

        const mb = 'y'.repeat(1024 * 1024);
        for (let i = 0; i < 40; i++) {
            await cachedTmdbResponse(tmdbResponseCacheKey('en-US', `/tv/m${i}`), async () => ({
                mb,
            }));
        }
        expect(tmdbResponseCacheSize()).toBeLessThanOrEqual(24);
    });

    it('an already-aborted caller gets an abort, not a cache hit', async () => {
        const key = tmdbResponseCacheKey('en-US', '/tv/12');
        await cachedTmdbResponse(key, async () => ({ a: 1 }));
        const ac = new AbortController();
        ac.abort();

        await expect(
            cachedTmdbResponse(key, async () => ({ a: 2 }), { signal: ac.signal }),
        ).rejects.toThrow();
    });
});
