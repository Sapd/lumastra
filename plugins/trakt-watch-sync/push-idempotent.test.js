// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Task 5: Trakt push idempotency. Trakt's /sync/history is append-only (this
// plugin never calls /sync/history/remove — see the "Add-only" comment in
// pushWatchState), so re-POSTing an item Trakt already has creates a
// permanent duplicate play on the user's real account. Before POSTing,
// pushWatchState bulk-fetches the user's already-watched set (via
// /sync/watched/movies and /sync/watched/episodes, `extended=min`) and
// filters those items out of the add batch — counting them as
// drained/skipped, not re-added.
//
// The lookup must FAIL-CLOSED: if the watched-set GET fails (429 exhausted,
// 5xx, network error, shape drift) we must NOT push that media kind — pushing
// blind would create the exact duplicates this task prevents, under the
// failure conditions most likely in prod. Deferred items are recorded as
// non-terminal (retryable) failures so the engine retries them next cycle.
//
// NB: the plugin caches ctx.sql / ctx.userCredentials at module scope on the
// first call (initFromCtx: `if (!sql) sql = ctx.sql`). We therefore
// vi.resetModules() + re-import per test so each test's sql/creds mocks
// actually take effect (mirrors index.test.ts).
describe('trakt pushWatchState idempotency', () => {
    /** @type {typeof import('./index.js').default} */
    let plugin;
    let prevClientId;
    let prevClientSecret;

    beforeEach(async () => {
        prevClientId = process.env.TRAKT_CLIENT_ID;
        prevClientSecret = process.env.TRAKT_CLIENT_SECRET;
        process.env.TRAKT_CLIENT_ID = 'test-client-id';
        process.env.TRAKT_CLIENT_SECRET = 'test-client-secret';
        vi.resetModules();
        plugin = (await import('./index.js')).default;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        if (prevClientId === undefined) delete process.env.TRAKT_CLIENT_ID;
        else process.env.TRAKT_CLIENT_ID = prevClientId;
        if (prevClientSecret === undefined) delete process.env.TRAKT_CLIENT_SECRET;
        else process.env.TRAKT_CLIENT_SECRET = prevClientSecret;
    });

    const creds = {
        get: vi.fn(async (_userId, key) => {
            if (key === 'access_token') return 'a';
            if (key === 'refresh_token') return 'r';
            return 'trakt_joe';
        }),
    };

    // Minimal ctx.http test double: forwards to the (stubbed) global `fetch`
    // so every existing fetch-mock assertion in this file (URL matching,
    // JSON.parse(historyCall[1].body), call counts) keeps working unchanged
    // — see index.test.ts's httpMock doc comment for the full rationale
    // (C22 fix round 1: traktApiForUser now routes through ctx.http).
    const httpMock = {
        get: (url, opts) => fetch(url, { ...opts, method: 'GET' }),
        post: (url, body, opts) =>
            fetch(url, {
                ...opts,
                method: 'POST',
                body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
                headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
            }),
    };

    // ctx whose media_type lookup rejects → everything defaults to 'movies'.
    function movieCtx() {
        return {
            sql: vi.fn(() => Promise.reject(new Error('no db in test'))),
            logger: { info() {}, warn() {}, debug() {}, error() {} },
            userCredentials: creds,
            http: httpMock,
        };
    }

    // ctx whose media_type lookup resolves the given rows so items classify
    // into movie vs episode.
    function typedCtx(rows) {
        return {
            sql: vi.fn(async () => rows),
            logger: { info() {}, warn() {}, debug() {}, error() {} },
            userCredentials: creds,
            http: httpMock,
        };
    }

    it('skips an item already on the user Trakt account (X) and pushes only the new one (Y)', async () => {
        // X (providerId 501) is already watched on Trakt. Y (providerId 502)
        // is not. `extended=min` shape: { "<traktId>": ["<watchedAt>", ...] }.
        const fetchMock = vi.fn(async (url) => {
            const u = String(url);
            if (u.includes('/sync/watched/movies')) {
                return new Response(JSON.stringify({ 501: ['2026-01-01T00:00:00.000Z'] }), {
                    status: 200,
                });
            }
            if (u.includes('/sync/history')) {
                return new Response(JSON.stringify({ added: { movies: 1, episodes: 0 } }), {
                    status: 201,
                });
            }
            throw new Error(`unexpected fetch to ${u}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await plugin.pushWatchState(movieCtx(), [
            {
                providerId: '501',
                mediaId: 'media-x',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
            {
                providerId: '502',
                mediaId: 'media-y',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);

        // X was skipped (drained), not re-added.
        expect(res.drainedAsSkipped).toContainEqual({ username: 'user-1', mediaId: 'media-x' });
        expect(res.successful).not.toContainEqual(expect.objectContaining({ mediaId: 'media-x' }));
        expect(res.skipped).toBeGreaterThanOrEqual(1);

        // Y was pushed and recorded as successful.
        expect(res.successful).toContainEqual({ username: 'user-1', mediaId: 'media-y' });

        // The /sync/history POST body must contain ONLY Y.
        const historyCall = fetchMock.mock.calls.find(
            (c) => String(c[0]).includes('/sync/history') && !String(c[0]).includes('watched'),
        );
        expect(historyCall).toBeTruthy();
        const body = JSON.parse(historyCall[1].body);
        expect(body.movies).toEqual([{ ids: { trakt: 502 }, watched_at: 'released' }]);
        expect(body.movies.some((m) => m.ids.trakt === 501)).toBe(false);

        // Exactly one bulk GET of the watched set was made (not paged/per-item).
        const watchedCalls = fetchMock.mock.calls.filter((c) =>
            String(c[0]).includes('/sync/watched/movies'),
        );
        expect(watchedCalls.length).toBe(1);
    });

    it('fails CLOSED: defers (does NOT push) items whose watched-set lookup failed, as retryable failures', async () => {
        // The watched-set GET for movies fails (e.g. 429/5xx after retries).
        // Fail-closed: we must NOT POST those movies (could dup on Trakt) —
        // instead defer them as non-terminal failures so the engine retries.
        const fetchMock = vi.fn(async (url) => {
            const u = String(url);
            if (u.includes('/sync/watched/movies')) {
                return new Response('upstream error', { status: 503 });
            }
            if (u.includes('/sync/history')) {
                return new Response(JSON.stringify({ added: { movies: 2, episodes: 0 } }), {
                    status: 201,
                });
            }
            throw new Error(`unexpected fetch to ${u}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await plugin.pushWatchState(movieCtx(), [
            {
                providerId: '601',
                mediaId: 'media-a',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
            {
                providerId: '602',
                mediaId: 'media-b',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);

        // No /sync/history POST at all — the whole (movie) batch was deferred.
        const historyCall = fetchMock.mock.calls.find(
            (c) => String(c[0]).includes('/sync/history') && !String(c[0]).includes('watched'),
        );
        expect(historyCall).toBeUndefined();

        // Both items recorded as NON-terminal (retryable) failures.
        expect(res.failed).toBe(2);
        expect(res.failedItems).toContainEqual(
            expect.objectContaining({ mediaId: 'media-a', terminal: false }),
        );
        expect(res.failedItems).toContainEqual(
            expect.objectContaining({ mediaId: 'media-b', terminal: false }),
        );

        // NOT drained, NOT succeeded — they must remain retryable.
        expect(res.drainedAsSkipped).not.toContainEqual(
            expect.objectContaining({ mediaId: 'media-a' }),
        );
        expect(res.drainedAsSkipped).not.toContainEqual(
            expect.objectContaining({ mediaId: 'media-b' }),
        );
        expect(res.successful).toEqual([]);
        expect(res.skipped).toBe(0);
        expect(res.succeeded).toBe(0);
    });

    it('fails CLOSED per media kind independently: episode lookup failure defers episodes but still pushes movies', async () => {
        const fetchMock = vi.fn(async (url) => {
            const u = String(url);
            if (u.includes('/sync/watched/movies')) {
                return new Response(JSON.stringify({}), { status: 200 }); // confirmed empty
            }
            if (u.includes('/sync/watched/episodes')) {
                return new Response('boom', { status: 500 }); // lookup failed
            }
            if (u.includes('/sync/history')) {
                return new Response(JSON.stringify({ added: { movies: 1, episodes: 0 } }), {
                    status: 201,
                });
            }
            throw new Error(`unexpected fetch to ${u}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const ctx = typedCtx([
            { id: 'media-mov', media_type: 'movie' },
            { id: 'media-ep', media_type: 'episode' },
        ]);
        const res = await plugin.pushWatchState(ctx, [
            {
                providerId: '701',
                mediaId: 'media-mov',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
            {
                providerId: '702',
                mediaId: 'media-ep',
                username: 'user-1',
                isWatched: true,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 1,
            },
        ]);

        // Movie was pushed (its lookup succeeded/confirmed-empty).
        expect(res.successful).toContainEqual({ username: 'user-1', mediaId: 'media-mov' });
        const historyCall = fetchMock.mock.calls.find(
            (c) => String(c[0]).includes('/sync/history') && !String(c[0]).includes('watched'),
        );
        expect(historyCall).toBeTruthy();
        const body = JSON.parse(historyCall[1].body);
        expect(body.movies).toEqual([{ ids: { trakt: 701 }, watched_at: 'released' }]);
        expect(body.episodes).toEqual([]); // episodes deferred, not in the POST

        // Episode was deferred as a non-terminal failure.
        expect(res.failedItems).toContainEqual(
            expect.objectContaining({ mediaId: 'media-ep', terminal: false }),
        );
        expect(res.successful).not.toContainEqual(expect.objectContaining({ mediaId: 'media-ep' }));
        expect(res.drainedAsSkipped).not.toContainEqual(
            expect.objectContaining({ mediaId: 'media-ep' }),
        );
    });

    it('does not call the watched-set lookup when the batch is empty after filtering unwatched items', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const res = await plugin.pushWatchState(movieCtx(), [
            {
                providerId: '501',
                mediaId: 'media-x',
                username: 'user-1',
                isWatched: false,
                resumePositionMs: 0,
                runtimeMs: 0,
                watchCount: 0,
            },
        ]);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(res.skipped).toBe(1);
    });
});
