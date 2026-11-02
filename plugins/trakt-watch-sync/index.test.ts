// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let traktWatchSync: typeof import('./index.js').default;

const sqlStub = ((..._args: unknown[]) => Promise.resolve([])) as unknown as never;

/**
 * Minimal ctx.http test double: forwards to the (spied-on) global `fetch`,
 * so every existing `vi.spyOn(globalThis, 'fetch')` assertion in this file
 * keeps working unchanged. The plugin no longer calls fetch() directly
 * (C22 fix round 1 — traktApiForUser/traktSearch/refreshUserToken now route
 * through ctx.http.get/post); the REAL ctx.http (buildHttpClient,
 * tasks/context-primitives.ts) is what supplies the redirect guard in
 * production, exhaustively covered by url-safety.test.ts. This double only
 * proves the plugin's request-building logic (URLs, headers, bodies,
 * retries), not redirect safety.
 */
const httpMock = {
    get: (url: string, opts?: RequestInit) => fetch(url, { ...opts, method: 'GET' }),
    post: (url: string, body: unknown, opts?: RequestInit) =>
        fetch(url, {
            ...opts,
            method: 'POST',
            body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
            headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
        }),
};

const ctx = {
    sql: sqlStub,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    userCredentials: {
        get: async () => null,
        set: async () => {},
        listUsersWithKey: async () => [],
    },
    http: httpMock,
} as never;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

beforeEach(async () => {
    vi.resetModules();
    traktWatchSync = (await import('./index.js')).default;
});

afterEach(() => vi.restoreAllMocks());

describe('trakt resolveIds', () => {
    it('resolves a movie tmdbId to its Trakt id (never returns the tmdb id)', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            jsonResponse([{ type: 'movie', movie: { ids: { trakt: 999, tmdb: 550 } } }]),
        );
        const out = await traktWatchSync.resolveIds(ctx, [
            { mediaId: 'uuid-1', mediaType: 'movie', tmdbId: '550', imdbId: null },
        ]);
        expect(out).toEqual([{ mediaId: 'uuid-1', providerId: '999' }]);
        expect(out[0].providerId).not.toBe('550');
    });

    it('resolves an episode via show tmdb then episode lookup', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        vi.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(
                jsonResponse([{ type: 'show', show: { ids: { trakt: 42, tmdb: 1399 } } }]),
            )
            .mockResolvedValueOnce(jsonResponse({ ids: { trakt: 7777 } }));
        const out = await traktWatchSync.resolveIds(ctx, [
            {
                mediaId: 'uuid-ep',
                mediaType: 'episode',
                tmdbId: null,
                imdbId: null,
                seriesTmdbId: '1399',
                seasonNumber: 1,
                episodeNumber: 3,
            },
        ]);
        expect(vi.mocked(fetch).mock.calls[0][0]).toContain('/search/tmdb/1399?type=show');
        expect(vi.mocked(fetch).mock.calls[1][0]).toContain('/shows/42/seasons/1/episodes/3');
        expect(out).toEqual([{ mediaId: 'uuid-ep', providerId: '7777' }]);
    });

    it('omits items that do not resolve', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));
        const out = await traktWatchSync.resolveIds(ctx, [
            { mediaId: 'uuid-x', mediaType: 'movie', tmdbId: '111', imdbId: null },
        ]);
        expect(out).toEqual([]);
    });
});

describe('trakt pullWatchState', () => {
    it('emits WatchStatePullItems keyed by Trakt id; providerUsername is the credential-store user key', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const pullCtx = {
            ...ctx,
            userCredentials: {
                get: async (_u: string, k: string) =>
                    k === 'access_token' ? 'a' : k === 'refresh_token' ? 'r' : 'trakt_joe',
                set: async () => {},
                listUsersWithKey: async () => ['user-1'],
            },
        } as never;
        vi.spyOn(globalThis, 'fetch')
            // movies history page 1 (X-Pagination-Page-Count: 1)
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify([
                        {
                            watched_at: '2026-01-01T00:00:00Z',
                            movie: { title: 'M', ids: { trakt: 501, tmdb: 550, imdb: 'tt0' } },
                        },
                    ]),
                    {
                        status: 200,
                        headers: { 'X-Pagination-Page': '1', 'X-Pagination-Page-Count': '1' },
                    },
                ),
            )
            // episodes history page 1
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify([
                        {
                            watched_at: '2026-01-02T00:00:00Z',
                            show: { ids: { tmdb: 1399 } },
                            episode: { season: 1, number: 2, ids: { trakt: 8888 } },
                        },
                    ]),
                    {
                        status: 200,
                        headers: { 'X-Pagination-Page': '1', 'X-Pagination-Page-Count': '1' },
                    },
                ),
            );

        const res = await traktWatchSync.pullWatchState!(pullCtx, {});
        const movie = res.items.find((i) => i.mediaType === 'movie');
        const ep = res.items.find((i) => i.mediaType === 'episode');
        expect(movie?.providerId).toBe('501');
        expect(movie?.tmdbId).toBe('550');
        expect(movie?.providerUsername).toBe('user-1'); // the credential-store key, mirror MAL
        expect(ep?.providerId).toBe('8888');
        expect(ep?.seriesTmdbId).toBe('1399');
        expect(ep?.seasonNumber).toBe(1);
        expect(ep?.episodeNumber).toBe(2);
        expect(ep?.isWatched).toBe(true);
    });

    it('records an error (does not silently drop) when a history endpoint returns a non-array body', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const pullCtx = {
            ...ctx,
            userCredentials: {
                get: async (_u: string, k: string) =>
                    k === 'access_token' ? 'a' : k === 'refresh_token' ? 'r' : 'trakt_joe',
                set: async () => {},
                listUsersWithKey: async () => ['user-1'],
            },
        } as never;
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'X-Pagination-Page-Count': '1' },
            }),
        );
        const res = await traktWatchSync.pullWatchState!(pullCtx, {});
        expect(res.items).toEqual([]);
        expect(res.errors.length).toBeGreaterThan(0);
    });
});

describe('trakt resolveIds abort handling', () => {
    it('does not issue any requests when ctx.signal is already aborted', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const abortedCtx = { ...ctx, signal: { aborted: true } } as never;
        const out = await traktWatchSync.resolveIds(abortedCtx, [
            { mediaId: 'uuid-1', mediaType: 'movie', tmdbId: '550', imdbId: null },
            { mediaId: 'uuid-2', mediaType: 'movie', tmdbId: '551', imdbId: null },
        ]);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(out).toEqual([]);
    });
});

describe('trakt pushWatchState', () => {
    it('POSTs add-only history keyed by Trakt id and records success', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const pushCtx = {
            ...ctx,
            userCredentials: {
                get: async (_u: string, k: string) =>
                    k === 'access_token' ? 'a' : k === 'refresh_token' ? 'r' : 'trakt_joe',
                set: async () => {},
                listUsersWithKey: async () => ['user-1'],
            },
        } as never;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ added: { movies: 1, episodes: 0 } }), {
                status: 201,
            }),
        );
        const res = await traktWatchSync.pushWatchState(pushCtx, [
            {
                providerId: '501',
                mediaId: 'uuid-1',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);
        expect(res.succeeded).toBe(1);
        expect(res.successful).toEqual([{ username: 'user-1', mediaId: 'uuid-1' }]);
        const body = JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body));
        expect(body.movies[0].ids.trakt).toBe(501);
    });

    it('skips unwatched items (add-only: never removes from Trakt)', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const pushCtx = {
            ...ctx,
            userCredentials: {
                get: async (_u: string, k: string) =>
                    k === 'access_token' ? 'a' : k === 'refresh_token' ? 'r' : 'trakt_joe',
                set: async () => {},
                listUsersWithKey: async () => ['user-1'],
            },
        } as never;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('{}', { status: 201 }));
        const res = await traktWatchSync.pushWatchState(pushCtx, [
            {
                providerId: '501',
                mediaId: 'uuid-1',
                username: 'user-1',
                isWatched: false,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 0,
            },
        ]);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(res.skipped).toBe(1);
        expect(res.drainedAsSkipped).toEqual([{ username: 'user-1', mediaId: 'uuid-1' }]);
    });

    it('drains a non-numeric providerId as a terminal failure and excludes it from the POST body and successful list', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const pushCtx = {
            ...ctx,
            userCredentials: {
                get: async (_u: string, k: string) =>
                    k === 'access_token' ? 'a' : k === 'refresh_token' ? 'r' : 'trakt_joe',
                set: async () => {},
                listUsersWithKey: async () => ['user-1'],
            },
        } as never;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ added: { movies: 1, episodes: 0 } }), {
                status: 201,
            }),
        );
        const res = await traktWatchSync.pushWatchState(pushCtx, [
            {
                providerId: 'abc',
                mediaId: 'uuid-bad',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
            {
                providerId: '501',
                mediaId: 'uuid-good',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);
        // Invalid Trakt id is TERMINAL: recorded in failedItems (terminal) and
        // drained (the engine marks its backing events pushed so it never
        // retries), NOT counted in the retryable `failed` tally.
        expect(res.failedItems).toContainEqual(
            expect.objectContaining({ mediaId: 'uuid-bad', terminal: true }),
        );
        expect(res.drainedAsSkipped).toContainEqual(
            expect.objectContaining({ username: 'user-1', mediaId: 'uuid-bad' }),
        );
        expect(res.failed).toBe(0);
        expect(res.succeeded).toBe(1);
        expect(res.successful).toEqual([{ username: 'user-1', mediaId: 'uuid-good' }]);
        expect(res.successful).not.toContainEqual(expect.objectContaining({ mediaId: 'uuid-bad' }));
        const body = JSON.parse(String((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body));
        expect(body.movies).toEqual([{ ids: { trakt: 501 }, watched_at: 'released' }]);
        expect(
            body.movies.some(
                (m: { ids: { trakt: number } }) => Number.isNaN(m.ids.trakt) || m.ids.trakt == null,
            ),
        ).toBe(false);
    });

    it('drains (not fails) items Trakt reports as not_found in a 200 response — terminal, not retried', async () => {
        process.env.TRAKT_CLIENT_ID = 'cid';
        process.env.TRAKT_CLIENT_SECRET = 'sec';
        const pushCtx = {
            ...ctx,
            userCredentials: {
                get: async (_u: string, k: string) =>
                    k === 'access_token' ? 'a' : k === 'refresh_token' ? 'r' : 'trakt_joe',
                set: async () => {},
                listUsersWithKey: async () => ['user-1'],
            },
        } as never;
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    added: { movies: 0 },
                    not_found: { movies: [{ ids: { trakt: 501 } }] },
                }),
                { status: 200 },
            ),
        );
        const res = await traktWatchSync.pushWatchState(pushCtx, [
            {
                providerId: '501',
                mediaId: 'uuid-1',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);
        expect(res.succeeded).toBe(0);
        expect(res.skipped).toBe(1);
        expect(res.failed).toBe(0);
        expect(res.drainedAsSkipped).toContainEqual({ username: 'user-1', mediaId: 'uuid-1' });
        expect(res.staleIds).toContain('501');
        expect(res.successful).not.toContainEqual(expect.objectContaining({ mediaId: 'uuid-1' }));
    });
});
