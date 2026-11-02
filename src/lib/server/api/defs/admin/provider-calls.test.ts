// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { mount } from '$lib/server/api/mount.js';
import { toUserId } from '$lib/shared/user-id.js';
import { ProviderCallsResponseSchema } from '$lib/schemas/provider-calls.js';
const readProviderCalls = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/provider-calls.js', () => ({ readProviderCalls }));
import { def } from './provider-calls.js';

function getHandler(surface: 'v1' | 'internal' = 'v1'): RequestHandler {
    const handler = mount(def, { surface }).GET;
    if (!handler) throw new Error('Provider calls must expose GET');
    return handler;
}

function event(admin: boolean, scopes: string[] = ['admin'], query = ''): RequestEvent {
    const url = new URL(`http://localhost/api/v1/admin/provider-calls${query}`);
    const principal = buildPrincipal({
        kind: 'pat',
        userId: toUserId('00000000-0000-0000-0000-000000000001'),
        username: 'operator',
        userGroups: [],
        tokenScopes: scopes,
        ownerIsAdmin: admin,
    });
    return {
        request: new Request(url),
        url,
        params: {},
        locals: { principal },
        cookies: { get: () => undefined },
    } as unknown as RequestEvent;
}
const response = {
    hours: 24,
    from: '2026-10-31T00:00:00.000Z',
    to: '2026-10-31T23:59:00.000Z',
    providers: [
        {
            provider: 'tmdb',
            totals: {
                requests: 2,
                success2xx: 1,
                client4xx: 1,
                rateLimited429: 1,
                server5xx: 0,
                networkErrors: 0,
                retries: 1,
            },
            series: [
                {
                    hour: '2026-10-31T23:00:00.000Z',
                    requests: 2,
                    success2xx: 1,
                    client4xx: 1,
                    rateLimited429: 1,
                    server5xx: 0,
                    networkErrors: 0,
                    retries: 1,
                },
            ],
        },
    ],
};
beforeEach(() => {
    readProviderCalls.mockReset().mockResolvedValue(response);
});

describe('GET admin/provider-calls', () => {
    it('rejects non-admin owners and admin-owned low-scope tokens on both mounts', async () => {
        for (const surface of ['v1', 'internal'] as const) {
            const GET = getHandler(surface);
            expect((await GET(event(false))).status).toBe(403);
            expect((await GET(event(true, ['media:read']))).status).toBe(403);
        }
        expect(readProviderCalls).not.toHaveBeenCalled();
    });
    it('requires authentication', async () => {
        const request = event(false);
        request.locals.principal = undefined;
        expect((await getHandler()(request)).status).toBe(403);
        expect(readProviderCalls).not.toHaveBeenCalled();
    });
    it('returns described totals and hourly series without caching; defaults to 24 hours', async () => {
        const res = await getHandler()(event(true));
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(ProviderCallsResponseSchema.parse(await res.json())).toEqual(response);
        expect(readProviderCalls).toHaveBeenCalledWith(24);
    });
    it('accepts bounded hours and rejects invalid/oversized windows before any read', async () => {
        const GET = getHandler();
        await GET(event(true, ['admin'], '?hours=48'));
        expect(readProviderCalls).toHaveBeenCalledWith(48);
        readProviderCalls.mockClear();
        for (const hours of ['0', '193', '1.5', 'bad', '']) {
            expect((await GET(event(true, ['admin'], `?hours=${hours}`))).status).toBe(422);
        }
        expect(readProviderCalls).not.toHaveBeenCalled();
    });
    it('returns 503 for an unavailable store', async () => {
        readProviderCalls.mockRejectedValueOnce(new Error('Valkey unavailable'));
        const res = await getHandler()(event(true));
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: 'dependency_unavailable' });
    });
});
