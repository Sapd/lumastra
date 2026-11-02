// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /requests — admin-only paths decide on the principal, never on
 * `locals.user.isAdmin` (spec 2026-10-07-auth-route-policy-design §5.1).
 * Covers scope=all and the ?ids= ownership filter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mockGetRequests = vi.fn();
const mockGetRequestById = vi.fn();

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        isConfigured: () => true,
        getRequests: (...a: unknown[]) => mockGetRequests(...a),
        getRequestById: (...a: unknown[]) => mockGetRequestById(...a),
        resolveUserLink: vi.fn(async () => ({ state: 'not_linked' })),
        getPendingRequestsForUser: vi.fn(async () => []),
    },
}));
vi.mock('$lib/server/services/request-status/index.js', () => ({
    getDismissalsForUser: vi.fn(async () => []),
    getSimpleStatusLabel: () => 'pending',
    deleteDismissal: vi.fn(),
    upsertDismissal: vi.fn(),
}));
vi.mock('$lib/server/services/request-status/orphan-filter.js', () => ({
    filterOrphanedRequests: async (r: unknown[]) => ({ kept: r }),
}));
vi.mock('$lib/server/services/request-status/catalog-match-filter.js', () => ({
    filterRequestsWithoutCatalogMatch: async (r: unknown[]) => ({ kept: r }),
}));
vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: { resolveToTmdb: vi.fn() },
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    RateLimitPresets: { STANDARD: { limit: 100, windowSeconds: 60 } },
    checkRateLimit: vi.fn(),
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIp: () => '127.0.0.1' }));
vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: (_: unknown, username: string) => username,
}));
vi.mock('$lib/server/config.js', () => ({ config: { DEFAULT_USER: 'default-user' } }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./index.js');

const BOBS_REQUEST = {
    id: 7,
    type: 'movie',
    status: 1,
    is4k: false,
    createdAt: '2026-01-01T00:00:00Z',
    media: { tmdbId: 550, status: 3 },
    mediaInfo: { title: 'Invented Film', posterPath: null },
    requestedBy: { username: 'bob' },
};

async function get(locals: RequestEvent['locals'], query: string): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/requests?${query}`);
    const event = {
        url,
        locals,
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
    return def.handlers.GET!(event, { surface: 'v1' });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetRequests.mockResolvedValue([]);
    mockGetRequestById.mockResolvedValue(BOBS_REQUEST);
});

describe('GET /requests?scope=all', () => {
    it('an admin owner’s device token gets 403 scope_required', async () => {
        const res = await get(adminOwnersDeviceToken(), 'scope=all');
        expect(res.status).toBe(403);
        expect(mockGetRequests).not.toHaveBeenCalled();
    });

    it('a principal-less request with locals.user.isAdmin gets 403', async () => {
        const res = await get(adminUserWithoutPrincipal(), 'scope=all');
        expect(res.status).toBe(403);
        expect(mockGetRequests).not.toHaveBeenCalled();
    });

    it('control: an admin session gets 200', async () => {
        const res = await get(adminSession(), 'scope=all');
        expect(res.status).toBe(200);
        expect(mockGetRequests).toHaveBeenCalledOnce();
    });
});

describe('GET /requests?ids= — ownership filter', () => {
    it('an admin owner’s device token does not see another user’s request', async () => {
        const res = await get(adminOwnersDeviceToken(), 'ids=7');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toEqual([]);
    });

    it('a principal-less request with locals.user.isAdmin does not either', async () => {
        const res = await get(adminUserWithoutPrincipal(), 'ids=7');
        const body = (await res.json()) as { items: unknown[] };
        expect(body.items).toEqual([]);
    });

    it('control: an admin session sees it', async () => {
        const res = await get(adminSession(), 'ids=7');
        const body = (await res.json()) as { items: Array<{ id: number }> };
        expect(body.items.map((i) => i.id)).toEqual([7]);
    });

    it('a caller still sees their own request', async () => {
        mockGetRequestById.mockResolvedValue({
            ...BOBS_REQUEST,
            requestedBy: { username: 'alice' },
        });
        const res = await get(adminOwnersDeviceToken(), 'ids=7');
        const body = (await res.json()) as { items: Array<{ id: number }> };
        expect(body.items.map((i) => i.id)).toEqual([7]);
    });
});
