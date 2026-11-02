// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /requests/{id} — reading another user's request needs an admin
 * principal or requests:admin; `locals.user.isAdmin` is never consulted
 * (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mockGetRequestById = vi.fn();

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        isConfigured: () => true,
        getRequestById: (...a: unknown[]) => mockGetRequestById(...a),
    },
}));
vi.mock('$lib/server/services/request-status/index.js', () => ({
    getSimpleStatusLabel: () => 'pending',
}));
vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: (_: unknown, username: string) => username,
}));
vi.mock('$lib/server/config.js', () => ({ config: { DEFAULT_USER: 'default-user' } }));

const { def } = await import('./index.js');

const request = (requester: string) => ({
    id: 7,
    type: 'movie',
    status: 1,
    is4k: false,
    createdAt: '2026-01-01T00:00:00Z',
    media: { tmdbId: 550, status: 3 },
    mediaInfo: { title: 'Invented Film', posterPath: null },
    requestedBy: { username: requester },
});

async function get(locals: RequestEvent['locals']): Promise<Response> {
    const event = {
        url: new URL('http://localhost/api/v1/requests/7'),
        locals,
        params: { id: '7' },
        request: new Request('http://localhost/api/v1/requests/7'),
    } as unknown as RequestEvent;
    return def.handlers.GET!(event, { surface: 'v1' });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequestById.mockResolvedValue(request('bob'));
});

describe('GET /requests/{id} — another user’s request', () => {
    it('an admin owner’s device token gets 403', async () => {
        expect((await get(adminOwnersDeviceToken())).status).toBe(403);
    });

    it('a principal-less request with locals.user.isAdmin gets 403', async () => {
        expect((await get(adminUserWithoutPrincipal())).status).toBe(403);
    });

    it('control: an admin session gets 200', async () => {
        const res = await get(adminSession());
        expect(res.status).toBe(200);
        expect(((await res.json()) as { id: number }).id).toBe(7);
    });

    it('a caller can still read their own request', async () => {
        mockGetRequestById.mockResolvedValue(request('alice'));
        expect((await get(adminOwnersDeviceToken())).status).toBe(200);
    });
});
