// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

async function fixture(
    provider: string,
    refresh: () => Promise<Response>,
    publicUrl = 'https://example.com',
) {
    vi.resetModules();
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_ID`, 'id');
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_SECRET`, 'secret');
    vi.stubEnv('PUBLIC_BASE_URL', publicUrl);
    const plugin =
        provider === 'mal'
            ? (await import('../mal-watch-sync/index.js')).default
            : (await import('./index.js')).default;
    const stored = new Map([
        ['access_token', 'expired'],
        ['refresh_token', 'refresh'],
        ['provider_username', 'joe'],
    ]);
    const set = vi.fn(
        async (_user: string, key: string, value: string, opts?: { ifKeyExists?: string }) => {
            if (!opts?.ifKeyExists || stored.has(opts.ifKeyExists)) stored.set(key, value);
        },
    );
    const ctx = {
        sql: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
        secrets: {},
        catalog: { upsertExternalId: vi.fn() },
        userCredentials: {
            get: async (_user: string, key: string) => stored.get(key) ?? null,
            delete: async (_user: string, key: string) => {
                stored.delete(key);
            },
            set,
            listUsersWithKey: async () => ['u1'],
        },
        http: {
            get: vi.fn(async () => new Response('', { status: 401 })),
            post: vi.fn(refresh),
        },
    };
    return { ctx, stored, pull: () => plugin.pullWatchState(ctx as never) };
}

for (const provider of ['trakt', 'mal']) {
    it.each([
        [
            'outage',
            () => Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 503 })),
        ],
        ['network', () => Promise.reject(new Error('offline'))],
        [
            'client secret',
            () => Promise.resolve(Response.json({ error: 'invalid_client' }, { status: 401 })),
        ],
        [
            'bad client request',
            () => Promise.resolve(Response.json({ error: 'invalid_request' }, { status: 400 })),
        ],
        [
            'unparseable rejection',
            () => Promise.resolve(new Response('unavailable', { status: 400 })),
        ],
        ['missing token', () => Promise.resolve(Response.json({}))],
    ])(`${provider}: %s keeps the link retryable`, async (_kind, refresh) => {
        const { ctx, stored, pull } = await fixture(provider, refresh);
        await pull();
        expect(stored.has('auth_failed')).toBe(false);
        expect(ctx.userCredentials.set).not.toHaveBeenCalledWith('u1', 'auth_failed', 'true');
    });

    it.each([400, 401])(
        `${provider}: marks only a rejected refresh token (%s) with an atomic existence guard`,
        async (status) => {
            const { ctx, pull } = await fixture(provider, async () =>
                Response.json({ error: 'invalid_grant' }, { status }),
            );
            await pull();
            expect(ctx.userCredentials.set).toHaveBeenCalledWith('u1', 'auth_failed', 'true', {
                ifKeyExists: 'access_token',
            });
        },
    );

    it(`${provider}: a refresh rejection after unlink cannot recreate credentials`, async () => {
        const f = await fixture(provider, async () => {
            f.stored.clear();
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
        });
        await f.pull();
        expect(f.stored.size).toBe(0);
    });
}

it.each(['', 'https://user:do-not-log@example.com'])(
    'Trakt: invalid PUBLIC_BASE_URL is logged once as configuration, without a refresh request',
    async (publicUrl) => {
        const { ctx, stored, pull } = await fixture(
            'trakt',
            async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
            publicUrl,
        );
        await pull();
        await pull();
        expect(stored.has('auth_failed')).toBe(false);
        expect(ctx.http.post).not.toHaveBeenCalled();
        expect(ctx.logger.warn).toHaveBeenCalledTimes(1);
        expect(ctx.logger.warn.mock.calls[0][0]).toContain('PUBLIC_BASE_URL');
        expect(JSON.stringify(ctx.logger.warn.mock.calls)).not.toContain('do-not-log');
        expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain('token refresh error');
    },
);
