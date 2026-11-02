// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for security review 2026-09-12, C13 — QuickConnect
 * .../authorize's rate limit must key on the authenticated username (set by
 * forward-auth before this handler runs), not the spoofable `getClientIp`.
 * Rotating `X-Forwarded-For` must not create fresh buckets for the same
 * authenticated user.
 *
 * `mount()` is stubbed to a trivial 200 handler so the test exercises only
 * the rate-limit wrapper (mount's own auth/DB logic has separate coverage).
 * Deliberately does NOT mock `$lib/server/utils/client-ip.js` or
 * `$lib/server/middleware/valkey-rate-limit.js`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';

const mockMountedPost = vi.fn(async () => new Response(null, { status: 200 }));
vi.mock('$lib/server/api/mount.js', () => ({
    mount: () => ({
        POST: (...args: unknown[]) =>
            (mockMountedPost as unknown as (...a: unknown[]) => unknown)(...args),
    }),
}));

vi.mock('$lib/server/api/defs/integrations/jellyfin-quick-connect.js', () => ({
    jellyfinQuickConnectAuthorizeDef: {},
}));

// NOTE: $lib/server/utils/client-ip.js and
// $lib/server/middleware/valkey-rate-limit.js are intentionally NOT mocked.

import { POST } from './+server.js';

function makeEvent(opts: { peer: string; xff?: string; username?: string }): RequestEvent {
    const url = new URL('http://localhost/api/jellyfin-connect/quick-connect/authorize');
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    const request = new Request(url, { method: 'POST', headers });

    return {
        url,
        request,
        params: {},
        route: { id: null },
        locals: opts.username ? { user: { username: opts.username } as UserContext } : {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => opts.peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('C13 — QuickConnect authorize rate limit keys on the authenticated username', () => {
    it('11 requests from the SAME authenticated user, each with a DIFFERENT peer + X-Forwarded-For, collapse into one bucket, and the 11th is 429', async () => {
        const LIMIT = 10;
        const statuses: number[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            const event = makeEvent({
                peer: `10.0.0.${i % 255}`,
                xff: `198.51.100.${i % 255}`,
                username: 'alice',
            });
            const response = await POST(event);
            statuses.push(response.status);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(statuses[i]).not.toBe(429);
        }
        expect(statuses[LIMIT]).toBe(429);
        // mount()'s handler was actually invoked for every allowed request.
        expect(mockMountedPost).toHaveBeenCalledTimes(LIMIT);
    });

    it('falls back to the STRICT (non-spoofable) IP when there is no authenticated user, so rotating X-Forwarded-For from the same peer still shares one bucket', async () => {
        const PEER = '203.0.113.55';
        const LIMIT = 10;
        const statuses: number[] = [];
        for (let i = 0; i <= LIMIT; i++) {
            const event = makeEvent({ peer: PEER, xff: `198.51.100.${i % 255}` });
            const response = await POST(event);
            statuses.push(response.status);
        }

        for (let i = 0; i < LIMIT; i++) {
            expect(statuses[i]).not.toBe(429);
        }
        expect(statuses[LIMIT]).toBe(429);
    });
});
