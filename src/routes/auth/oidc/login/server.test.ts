// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /auth/oidc/login: the per-IP gate (`oidc:login:ip:${ip}`) that keeps the
 * server-side transaction store from being flooded must key on the STRICT
 * client IP (`getClientIpStrict`), like native login and setup (H8). With
 * `TRUSTED_PROXY_IPS` unset, `getClientIp` believes a client-supplied
 * `X-Forwarded-For`, so a fresh value per request was a fresh bucket.
 *
 * `$lib/server/utils/client-ip.js` is deliberately NOT mocked, and the trust
 * env is pinned before the route is imported (client-ip reads it at load), so
 * a local `.env` that trusts any proxy cannot change the outcome.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$app/paths', () => ({ base: '/media' }));

vi.mock('$lib/server/services/oidc.service.js', () => ({
    OidcNotConfiguredError: class extends Error {},
    isOidcConfigured: () => true,
    startLogin: vi.fn(async () => ({
        state: 'state-1',
        authorizationUrl: 'https://idp.example/authorize?state=state-1',
    })),
}));

const rateLimitCounts = new Map<string, number>();
const mockCheckRateLimit = vi.fn(async (key: string, limit: number) => {
    const count = (rateLimitCounts.get(key) ?? 0) + 1;
    rateLimitCounts.set(key, count);
    return { allowed: count <= limit, resetAt: 9999999999 };
});
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (key: string, limit: number) => mockCheckRateLimit(key, limit),
}));

let GET: (event: RequestEvent) => Promise<Response>;

beforeAll(async () => {
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
    vi.resetModules();
    GET = (await import('./+server.js')).GET as unknown as typeof GET;
});

function makeEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL('https://media.example/auth/oidc/login');
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    return {
        url,
        request: new Request(url, { headers }),
        params: {},
        route: { id: '/auth/oidc/login' },
        locals: {},
        cookies: { get: () => undefined, set: vi.fn(), delete: vi.fn() },
        getClientAddress: () => opts.peer,
    } as unknown as RequestEvent;
}

beforeEach(() => {
    rateLimitCounts.clear();
    mockCheckRateLimit.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe('GET /auth/oidc/login per-IP gate', () => {
    it('does not log the localized discovery message from a configuration error', async () => {
        const { startLogin, OidcNotConfiguredError } =
            await import('$lib/server/services/oidc.service.js');
        const { LoggerInstance } = await import('$lib/server/utils/logger.js');
        const warn = vi.spyOn(LoggerInstance.prototype, 'warn').mockImplementation(() => undefined);
        vi.mocked(startLogin).mockRejectedValueOnce(
            new OidcNotConfiguredError('Lokalisierte Fehlermeldung'),
        );
        const response = await GET(makeEvent({ peer: '203.0.113.9' }));
        expect(response.headers.get('location')).toContain('/login?error=');
        expect(warn).toHaveBeenCalledWith('Failed to start OIDC login');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('Lokalisierte');
    });
    it('uses the subpath callback and cookie path for an SSO login', async () => {
        const { startLogin } = await import('$lib/server/services/oidc.service.js');
        const event = makeEvent({ peer: '203.0.113.9' });
        await GET(event);
        expect(startLogin).toHaveBeenLastCalledWith(
            expect.objectContaining({
                redirectUri: 'https://media.example/media/auth/oidc/callback',
            }),
        );
        expect(event.cookies.set).toHaveBeenCalledWith(
            'oidc_tx',
            'state-1',
            expect.objectContaining({ path: '/media/auth/oidc' }),
        );
    });
    it('a rotating X-Forwarded-For from one peer shares one bucket and is limited after 30', async () => {
        const LIMIT = 30;
        const statuses: string[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            const res = await GET(makeEvent({ peer: '203.0.113.9', xff: `198.51.100.${i}` }));
            statuses.push(res.headers.get('location') ?? '');
        }

        expect(new Set(mockCheckRateLimit.mock.calls.map(([key]) => key))).toEqual(
            new Set(['oidc:login:ip:203.0.113.9']),
        );
        expect(statuses[LIMIT - 1]).toContain('idp.example');
        expect(statuses[LIMIT]).toContain('/login?error=');
    });
});
