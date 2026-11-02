// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTraktCallback } from './trakt-callback.js';
import type { UserId } from '$lib/shared/user-id';

vi.mock('$lib/server/config', () => ({
    config: {
        TRAKT_CLIENT_ID: 'cid',
        TRAKT_CLIENT_SECRET: 'secret',
        PUBLIC_BASE_URL: 'https://example.com',
    },
}));

vi.mock('$app/paths', () => ({ base: '/media' }));

const stateStore = new Map<string, string>();
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: (k: string) => Promise.resolve(stateStore.get(k) ?? null),
    cacheDel: (k: string) => Promise.resolve(void stateStore.delete(k)),
}));

const upsert = vi.fn();
vi.mock('$lib/server/database/queries/trakt-credentials.queries', () => ({
    upsertTraktCredential: (...args: unknown[]) => upsert(...args),
}));

const setWatermark = vi.fn();
vi.mock('$lib/server/database/queries/watch-sync-preferences.queries', () => ({
    setWatermark: (...args: unknown[]) => setWatermark(...args),
}));

const startRun = vi.fn().mockResolvedValue({ runId: 'run-1' });
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...args: unknown[]) => startRun(...args) },
}));

const USER = { username: 'joe', userId: '00000000-0000-0000-0000-0000000000aa' as UserId };
const sqlStub = {} as never;

function url(params: Record<string, string>): URL {
    const u = new URL('https://example.com/api/integrations/trakt/callback');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
}

afterEach(() => {
    stateStore.clear();
    upsert.mockReset();
    setWatermark.mockReset();
    startRun.mockReset();
    startRun.mockResolvedValue({ runId: 'run-1' });
});

describe('handleTraktCallback', () => {
    it('errors when no user session', async () => {
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: null,
            sql: sqlStub,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
    });

    it('errors on provider error param', async () => {
        const r = await handleTraktCallback({
            url: url({ error: 'access_denied' }),
            user: USER,
            sql: sqlStub,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
    });

    it('errors when state is unknown/expired', async () => {
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 'missing' }),
            user: USER,
            sql: sqlStub,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
        expect(upsert).not.toHaveBeenCalled();
    });

    it('errors when state username mismatches session', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'someone_else' }));
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
        expect(upsert).not.toHaveBeenCalled();
    });

    it('errors (never false-success) when sql is null', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
                    { status: 200 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ user: { username: 'trakt_joe' } }), { status: 200 }),
            );
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: null,
            fetchImpl,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
    });

    it('errors when token exchange returns non-200', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi.fn().mockResolvedValue(new Response('bad', { status: 401 }));
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
            fetchImpl,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
        expect(upsert).not.toHaveBeenCalled();
    });

    it('errors when token exchange returns 200 but no access_token', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ refresh_token: 'r' }), { status: 200 }),
            );
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
            fetchImpl,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
        expect(upsert).not.toHaveBeenCalled();
    });

    it('errors (no throw) when stored OAuth state is corrupt JSON', async () => {
        stateStore.set('trakt:oauth:s', 'not-json{');
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
        });
        expect(r.redirectTo).toContain('trakt_link=error');
        expect(upsert).not.toHaveBeenCalled();
    });

    it('succeeds: exchanges code, fetches username, upserts, redirects success', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
                    { status: 200 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ user: { username: 'trakt_joe' } }), { status: 200 }),
            );
        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
            fetchImpl,
        });
        expect(r.redirectTo).toContain('trakt_link=success');
        expect(upsert).toHaveBeenCalledWith(
            sqlStub,
            expect.objectContaining({
                userId: USER.userId,
                providerUsername: 'trakt_joe',
                accessToken: 'a',
                refreshToken: 'r',
            }),
        );
        // token-exchange request sent redirect_uri as JSON body
        const sentBody = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
        expect(sentBody.redirect_uri).toBe('https://example.com/api/integrations/trakt/callback');
        expect(sentBody.grant_type).toBe('authorization_code');
        expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({
            'Content-Type': 'application/json',
            // Cloudflare fronting api.trakt.tv 403s User-Agent-less requests.
            'User-Agent': expect.any(String) as unknown as string,
        });
        // trakt headers present on the /users/settings call
        const settingsHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<
            string,
            string
        >;
        expect(settingsHeaders['trakt-api-version']).toBe('2');
        expect(settingsHeaders['trakt-api-key']).toBe('cid');
        expect(settingsHeaders['User-Agent']).toBeTruthy();

        // Auto-pull on link: watermark set + a fire-and-forget import run.
        expect(setWatermark).toHaveBeenCalledWith(sqlStub, USER.userId, 'trakt', expect.any(Date));
        expect(startRun).toHaveBeenCalledWith(
            'watch-sync-manual',
            { userId: USER.userId, provider: 'trakt', direction: 'pull' },
            expect.objectContaining({
                userId: USER.userId,
                trigger: expect.objectContaining({ kind: 'in-process', by: 'link' }),
            }),
        );
    });

    it('does not propagate an orchestrator.startRun failure — link still succeeds', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
                    { status: 200 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ user: { username: 'trakt_joe' } }), { status: 200 }),
            );
        startRun.mockRejectedValueOnce(new Error('queue unavailable'));

        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
            fetchImpl,
        });

        expect(r.redirectTo).toContain('trakt_link=success');
        expect(startRun).toHaveBeenCalled();
        expect(setWatermark).toHaveBeenCalledWith(sqlStub, USER.userId, 'trakt', expect.any(Date));
    });

    it('does not propagate a setWatermark failure — link still succeeds', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
                    { status: 200 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ user: { username: 'trakt_joe' } }), { status: 200 }),
            );
        setWatermark.mockRejectedValueOnce(new Error('db unavailable'));

        const r = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
            fetchImpl,
        });

        expect(r.redirectTo).toContain('trakt_link=success');
        expect(startRun).toHaveBeenCalled();
    });
});

describe('callback setup failures', () => {
    it('returns a subpath-aware reason for expired state', async () => {
        const result = await handleTraktCallback({
            url: url({ code: 'c', state: 'missing' }),
            user: USER,
            sql: sqlStub,
        });
        expect(result.redirectTo).toBe('/media/settings/connections?trakt_link=error&reason=state');
    });
    it('does not persist credentials when the profile cannot be loaded', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ access_token: 'a' }))
            .mockImplementation(async () => new Response('', { status: 503 }));
        const result = await handleTraktCallback({
            url: url({ code: 'c', state: 's' }),
            user: USER,
            sql: sqlStub,
            fetchImpl,
        });
        expect(result.redirectTo).toContain('reason=profile');
        expect(upsert).not.toHaveBeenCalled();
    });
    it('turns token transport failures into a safe reason', async () => {
        stateStore.set('trakt:oauth:s', JSON.stringify({ username: 'joe' }));
        const fetchImpl = vi.fn().mockRejectedValue(new Error('secret response'));
        await expect(
            handleTraktCallback({
                url: url({ code: 'c', state: 's' }),
                user: USER,
                sql: sqlStub,
                fetchImpl,
            }),
        ).resolves.toMatchObject({
            redirectTo: '/media/settings/connections?trakt_link=error&reason=token',
        });
    });
});
