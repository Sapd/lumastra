// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/server/config', () => ({
    config: {
        MAL_CLIENT_ID: 'id',
        MAL_CLIENT_SECRET: 'secret',
        PUBLIC_BASE_URL: 'https://example.com/media/',
    },
}));
vi.mock('$app/paths', () => ({ base: '/media' }));
vi.mock('$lib/server/cache/valkey', () => ({ cacheGet: vi.fn(), cacheDel: vi.fn() }));
vi.mock('$lib/server/database/connection', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/mal-credentials.queries', () => ({
    upsertMalCredential: vi.fn(),
}));
vi.mock('$lib/server/database/queries/watch-sync-preferences.queries', () => ({
    setWatermark: vi.fn(),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: vi.fn() } }));
import { GET } from './+server';
import { cacheGet } from '$lib/server/cache/valkey';
import { getDb } from '$lib/server/database/connection';
import { upsertMalCredential } from '$lib/server/database/queries/mal-credentials.queries';
const event = {
    url: new URL('https://example.com/media/api/integrations/mal/callback?code=c&state=s'),
    locals: { user: { username: 'joe', userId: '00000000-0000-0000-0000-000000000001' } },
} as never;
afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});
describe('MAL callback', () => {
    it('redirects with a safe reason for malformed stored state', async () => {
        vi.mocked(cacheGet).mockResolvedValue('{bad');
        await expect(GET(event)).rejects.toMatchObject({
            status: 302,
            location: '/media/settings/connections?mal_link=error&reason=state',
        });
    });
    it.each(['transport', 'json', 'missing-token', 'profile', 'database'])(
        'handles %s failure without storing a false link',
        async (failure) => {
            vi.mocked(cacheGet).mockResolvedValue(
                JSON.stringify({ username: 'joe', codeVerifier: 'verifier' }),
            );
            const fetchMock = vi.spyOn(globalThis, 'fetch');
            if (failure === 'transport') fetchMock.mockRejectedValue(new Error('private-key'));
            else if (failure === 'json') fetchMock.mockResolvedValue(new Response('{bad'));
            else if (failure === 'missing-token') fetchMock.mockResolvedValue(Response.json({}));
            else {
                fetchMock
                    .mockResolvedValueOnce(Response.json({ access_token: 'a' }))
                    .mockImplementation(async () =>
                        failure === 'profile'
                            ? new Response('', { status: 503 })
                            : Response.json({ name: 'joe' }),
                    );
            }
            if (failure === 'database') vi.mocked(getDb).mockReturnValueOnce(null);
            const reason =
                failure === 'profile' ? 'profile' : failure === 'database' ? 'storage' : 'token';
            await expect(GET(event)).rejects.toMatchObject({
                status: 302,
                location: `/media/settings/connections?mal_link=error&reason=${reason}`,
            });
            expect(upsertMalCredential).not.toHaveBeenCalled();
        },
    );
    it('passes the exact normalized redirect URL to token exchange', async () => {
        vi.mocked(cacheGet).mockResolvedValue(
            JSON.stringify({ username: 'joe', codeVerifier: 'verifier' }),
        );
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(Response.json({ access_token: 'a' }))
            .mockResolvedValueOnce(Response.json({ name: 'joe' }));
        await expect(GET(event)).rejects.toMatchObject({
            status: 302,
            location: '/media/settings/connections?mal_link=success',
        });
        expect(
            new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('redirect_uri'),
        ).toBe('https://example.com/media/api/integrations/mal/callback');
        expect(upsertMalCredential).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ providerUsername: 'joe' }),
        );
    });
});
