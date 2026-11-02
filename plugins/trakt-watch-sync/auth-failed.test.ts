// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});
it.each(['trakt', 'mal'])('%s persists failed refresh state', async (provider) => {
    vi.resetModules();
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_ID`, 'id');
    vi.stubEnv(`${provider.toUpperCase()}_CLIENT_SECRET`, 'secret');
    vi.stubEnv('PUBLIC_BASE_URL', 'https://PUBLIC.example:443/media/');
    const plugin =
        provider === 'mal'
            ? (await import('../mal-watch-sync/index.js')).default
            : (await import('./index.js')).default;
    const stored = new Map([
        ['access_token', 'expired'],
        ['refresh_token', 'revoked'],
        ['provider_username', 'joe'],
    ]);
    let recover = false;
    const set = vi.fn(async (_user: string, key: string, value: string) => {
        stored.set(key, value);
    });
    const remove = vi.fn(async (_user: string, key: string) => {
        stored.delete(key);
    });
    const ctx = {
        sql: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
        secrets: {},
        catalog: { upsertExternalId: vi.fn() },
        userCredentials: {
            get: async (_user: string, key: string) => stored.get(key) ?? null,
            delete: remove,
            set,
            listUsersWithKey: async () => ['u1'],
        },
        http: {
            get: async (_url: string, options?: RequestInit) =>
                recover &&
                (options?.headers as Record<string, string>)?.Authorization === 'Bearer fresh'
                    ? Response.json(provider === 'mal' ? { data: [] } : [])
                    : new Response('', { status: 401 }),
            post: vi.fn(async (_url: string, _body: unknown) =>
                recover
                    ? Response.json({ access_token: 'fresh', refresh_token: 'new' })
                    : Response.json({ error: 'invalid_grant' }, { status: 400 }),
            ),
        },
    };
    await plugin.pullWatchState(ctx as never);
    expect(set).toHaveBeenCalledWith('u1', 'auth_failed', 'true', { ifKeyExists: 'access_token' });
    if (provider === 'trakt') {
        expect(ctx.http.post.mock.calls[0][1]).toMatchObject({
            redirect_uri: 'https://public.example/media/api/integrations/trakt/callback',
        });
    }
    recover = true;
    await plugin.pullWatchState(ctx as never);
    expect(remove).toHaveBeenCalledWith('u1', 'auth_failed');
    expect(stored.has('auth_failed')).toBe(false);
});
