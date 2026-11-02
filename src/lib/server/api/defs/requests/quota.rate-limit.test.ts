// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def } from './quota.js';
import { GET as legacyGet } from '../../../../../routes/api/request/quota/+server.js';

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: { resolveUserLink: vi.fn(async () => ({ state: 'not_linked' })) },
}));
vi.mock('$lib/server/dev-user.js', () => ({ getEffectiveUser: () => 'alice' }));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', async (original) => ({
    ...(await original<typeof import('$lib/server/middleware/valkey-rate-limit.js')>()),
    checkRateLimit: vi.fn(),
}));
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';

function event(surface: string): RequestEvent {
    const request = new Request(`http://localhost/${surface}/requests/quota`);
    return {
        request,
        url: new URL(request.url),
        params: {},
        locals: { user: { username: 'alice', userId: 'alice-id' } },
        getClientAddress: () => '192.0.2.1',
    } as unknown as RequestEvent;
}

beforeEach(() => {
    let count = 0;
    vi.mocked(checkRateLimit)
        .mockReset()
        .mockImplementation(async (_key, limit) => ({
            allowed: ++count <= limit,
            total: limit,
            remaining: Math.max(0, limit - count),
            resetAt: Math.floor(Date.now() / 1000) + 60,
        }));
});

describe('request quota budget', () => {
    it.each(['internal', 'v1'] as const)(
        '%s allows 100 calls and rejects call 101',
        async (surface) => {
            const get = mount(def, { surface }).GET!;
            for (let n = 0; n < 100; n++) expect((await get(event(surface))).status).toBe(200);
            const response = await get(event(surface));
            expect(response.status).toBe(429);
            expect(response.headers.get('Retry-After')).toBeTruthy();
            expect(checkRateLimit).toHaveBeenLastCalledWith(expect.any(String), 100, 60);
        },
    );
    it('legacy BFF charges exactly once and keeps its response', async () => {
        expect(await (await legacyGet!(event('api'))).json()).toEqual({
            quota: null,
            linked: false,
        });
        expect(checkRateLimit).toHaveBeenCalledTimes(1);
    });
});
