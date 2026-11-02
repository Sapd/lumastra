// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/server/config.js', () => ({
    config: {
        PUBLIC_BASE_URL: '',
        TRAKT_CLIENT_ID: 'id',
        TRAKT_CLIENT_SECRET: 'secret',
        MAL_CLIENT_ID: 'id',
        MAL_CLIENT_SECRET: 'secret',
    },
}));
vi.mock('$lib/server/cache/valkey.js', () => ({ cacheSet: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/trakt-credentials.queries.js', () => ({
    getTraktLinkStatus: vi.fn(),
}));
vi.mock('$lib/server/database/queries/mal-credentials.queries.js', () => ({
    getMalLinkStatus: vi.fn(),
}));
vi.mock('$lib/server/database/queries/watch-sync-preferences.queries.js', () => ({
    getPreference: async () => ({ direction: 'both' }),
}));
import { config } from '$lib/server/config.js';
import { cacheSet } from '$lib/server/cache/valkey.js';
import { getTraktLinkStatus } from '$lib/server/database/queries/trakt-credentials.queries.js';
import { getMalLinkStatus } from '$lib/server/database/queries/mal-credentials.queries.js';
import { traktAuthorizeDef } from './trakt/authorize.js';
import { malAuthorizeDef } from './mal/authorize.js';
import { traktStatusDef } from './trakt/status.js';
import { malStatusDef } from './mal/status.js';
const event = { locals: { user: { username: 'joe', userId: 'user-1' } } } as never;
afterEach(() => {
    Object.assign(config, { PUBLIC_BASE_URL: '' });
    vi.clearAllMocks();
});
describe.each([
    ['trakt', traktAuthorizeDef, traktStatusDef, getTraktLinkStatus],
    ['mal', malAuthorizeDef, malStatusDef, getMalLinkStatus],
] as const)('%s setup', (provider, authorize, status, linkStatus) => {
    it('refuses authorization before a public URL is set, without creating state', async () => {
        const res = await authorize.handlers.POST!(event, {} as never);
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('Set Public Base URL in Settings first');
        expect(cacheSet).not.toHaveBeenCalled();
    });
    it('uses a normalized subpath redirect in authorization', async () => {
        Object.assign(config, { PUBLIC_BASE_URL: 'https://public.example/media/' });
        const res = await authorize.handlers.POST!(event, {} as never);
        const body = await res.json();
        expect(new URL(body.authUrl).searchParams.get('redirect_uri')).toBe(
            `https://public.example/media/api/integrations/${provider}/callback`,
        );
    });
    it('reports failed authentication instead of a healthy link and exposes the registration URL', async () => {
        Object.assign(config, { PUBLIC_BASE_URL: 'https://public.example/media/' });
        vi.mocked(linkStatus).mockResolvedValue({
            providerUsername: 'joe',
            createdAt: new Date(),
            authFailed: true,
        } as never);
        const res = await status.handlers.GET!(event, {} as never);
        expect(await res.json()).toMatchObject({
            linked: false,
            auth_failed: true,
            redirectUri: `https://public.example/media/api/integrations/${provider}/callback`,
        });
    });
});
