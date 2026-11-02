// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C22 fix round 1 (review of the original C22 fix-plan finding): this file
 * used to assert a bespoke `guardedFetch`'s same-origin redirect refusal
 * directly, using a fully-mocked `global.fetch` — which the reviewer
 * correctly pointed out cannot discriminate a guarded call from an
 * unguarded one (a full mock replacement can't simulate undici's real
 * automatic-redirect-follow behaviour either way; the only thing such a
 * test can prove is the call's SHAPE, e.g. `redirect:'manual'`).
 *
 * On review, that bespoke guard turned out not to be architecturally
 * necessary for this plugin at all: `ctx.http.get`/`ctx.http.post`
 * (tasks/context-primitives.ts's `buildHttpClient`, backed by
 * `tasks/url-safety.ts`'s `safeFetch`) accept a full `RequestInit` for
 * headers, and every Trakt call in index.js is a GET or a POST — so the
 * plugin now routes through `ctx.http` instead of a local `guardedFetch`,
 * and the redirect guard is the SDK's shared, already-exhaustively-tested
 * `safeFetch` (see `tasks/url-safety.test.ts`'s "safeFetch — redirect
 * re-validation" suite, which uses DNS/undici mocking — the correct
 * technique for that guard's actual mechanism, DNS-pinning, which a plain
 * two-origin `http.createServer` pair cannot exercise).
 *
 * What THIS file verifies instead — the residual claim that is actually
 * this plugin's responsibility, not `safeFetch`'s — is that the
 * credentialed calls are genuinely ROUTED through `ctx.http` and never
 * reach a bare `fetch()`. A `ctx.http` MOCK (not a fetch passthrough, unlike
 * the other trakt-watch-sync test files) makes that an unambiguous,
 * non-discriminable-only-by-shape assertion: if a future edit reintroduces
 * a bare `fetch()` call anywhere on these paths, `ctx.http.get`/`.post`
 * simply never fires and these tests fail.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const sqlStub = ((..._args: unknown[]) => Promise.resolve([])) as unknown as never;

function makeCtx(
    tokensByUser: Record<string, { accessToken: string; refreshToken?: string | null }>,
    http: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> },
) {
    return {
        sql: sqlStub,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        userCredentials: {
            listUsersWithKey: async () => Object.keys(tokensByUser),
            get: async (userId: string, key: string) => {
                const tokens = tokensByUser[userId];
                if (key === 'access_token') return tokens.accessToken;
                if (key === 'refresh_token') return tokens.refreshToken ?? null;
                return null;
            },
            set: async () => {},
        },
        http,
    } as never;
}

describe('trakt-watch-sync — routes through ctx.http, never a bare fetch (C22 fix round 1)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('isAvailable() calls ctx.http.get (not the global fetch) with the credential attached', async () => {
        const globalFetchSpy = vi.fn();
        vi.stubGlobal('fetch', globalFetchSpy);

        process.env.TRAKT_CLIENT_ID = 'test-client-id';
        process.env.TRAKT_CLIENT_SECRET = 'test-client-secret';

        const httpGet = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
        const httpPost = vi.fn();

        vi.resetModules();
        const traktWatchSync = (await import('./index.js')).default;

        const ctx = makeCtx(
            { u1: { accessToken: 'super-secret-trakt-token' } },
            {
                get: httpGet,
                post: httpPost,
            },
        );

        const available = await traktWatchSync.isAvailable(ctx);

        expect(available).toBe(true);
        expect(httpGet).toHaveBeenCalledTimes(1);
        const [calledUrl, calledOpts] = httpGet.mock.calls[0] as [string, RequestInit];
        expect(calledUrl).toContain('/users/settings');
        expect((calledOpts.headers as Record<string, string>).Authorization).toBe(
            'Bearer super-secret-trakt-token',
        );
        // The global fetch is NEVER reached directly — the SDK's guarded
        // ctx.http is the only transport this plugin uses.
        expect(globalFetchSpy).not.toHaveBeenCalled();
    });

    it("pushWatchState()'s /sync/history call goes through ctx.http.post (not the global fetch)", async () => {
        const globalFetchSpy = vi.fn();
        vi.stubGlobal('fetch', globalFetchSpy);

        process.env.TRAKT_CLIENT_ID = 'test-client-id';
        process.env.TRAKT_CLIENT_SECRET = 'test-client-secret';

        const httpGet = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
        const httpPost = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ added: { movies: 1 } }), { status: 201 }),
            );

        vi.resetModules();
        const traktWatchSync = (await import('./index.js')).default;

        const ctx = makeCtx(
            { 'user-1': { accessToken: 'push-secret-token' } },
            {
                get: httpGet,
                post: httpPost,
            },
        );

        const res = await traktWatchSync.pushWatchState(ctx, [
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
        expect(httpPost).toHaveBeenCalledTimes(1);
        const [calledUrl, , calledOpts] = httpPost.mock.calls[0] as [string, unknown, RequestInit];
        expect(calledUrl).toContain('/sync/history');
        expect((calledOpts.headers as Record<string, string>).Authorization).toBe(
            'Bearer push-secret-token',
        );
        expect(globalFetchSpy).not.toHaveBeenCalled();
    });
});
