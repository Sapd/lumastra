// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /stats/{username}/all: another user's stats need an ADMIN PRINCIPAL.
 *
 * An admin owner's device token (or read/write PAT) has `locals.user.isAdmin === true`
 * but a non-admin principal; the handler used to read the former
 * (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import {
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminScopedPat,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

vi.mock('$lib/server/config.js', () => ({
    features: { personalStats: true },
    config: {},
    isUnavailableMediaVisible: () => true,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

const mockGetUserIdByUsername = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: (...a: unknown[]) => mockGetUserIdByUsername(...a),
}));

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personalStats: 'personalStats' },
    cacheManager: {
        for: () => ({ get: vi.fn(async () => null), set: vi.fn(async () => undefined) }),
    },
    buildVersionedCacheKey: (version: string, ...parts: (string | number)[]): string =>
        `${version}:${parts.join(':')}`,
}));

vi.mock('$lib/server/services/personal-stats.service.js', () => ({
    accessFingerprint: () => '',
    personalStatsService: {
        getAllStats: vi.fn(async () => ({
            period: 'all',
            insufficientData: true,
            sessionCount: 0,
            stats: {},
        })),
    },
}));

const { def } = await import('./username-all.js');
const ctx: ApiContext = { surface: 'v1' };

/** The caller (locals) is "alice"; OTHER is somebody else. */
const OWN = 'alice';
const OTHER = 'bob';

async function get(locals: RequestEvent['locals'], username: string): Promise<Response> {
    const event = {
        url: new URL(`http://localhost/api/stats/${username}/all`),
        params: { username },
        locals,
        request: new Request(`http://localhost/api/stats/${username}/all`),
    } as unknown as RequestEvent;
    return (await def.handlers.GET!(event, ctx)) as Response;
}

describe('GET /stats/{username}/all: admin principal required for other users', () => {
    beforeEach(() => {
        mockGetUserIdByUsername.mockReset();
        mockGetUserIdByUsername.mockResolvedValue('22222222-2222-4222-8222-222222222222');
    });

    it('an admin owner’s device token asking for ANOTHER user gets 403', async () => {
        const res = await get(adminOwnersDeviceToken(), OTHER);
        expect(res.status).toBe(403);
        expect(mockGetUserIdByUsername).not.toHaveBeenCalled();
    });

    it('an admin owner’s read/write PAT asking for ANOTHER user gets 403', async () => {
        const res = await get(adminOwnersReadWritePat(), OTHER);
        expect(res.status).toBe(403);
        expect(mockGetUserIdByUsername).not.toHaveBeenCalled();
    });

    it('a request with locals.user.isAdmin but NO principal gets 403 for another user', async () => {
        const res = await get(adminUserWithoutPrincipal(), OTHER);
        expect(res.status).toBe(403);
        expect(mockGetUserIdByUsername).not.toHaveBeenCalled();
    });

    it('control: an admin session may read ANOTHER user', async () => {
        const res = await get(adminSession(), OTHER);
        expect(res.status).toBe(200);
        expect(mockGetUserIdByUsername).toHaveBeenCalledWith(expect.anything(), OTHER);
    });

    it('control: an admin-scoped PAT may read ANOTHER user', async () => {
        const res = await get(adminScopedPat(), OTHER);
        expect(res.status).toBe(200);
    });

    it('an admin owner’s device token can still read its OWN stats', async () => {
        const res = await get(adminOwnersDeviceToken(), OWN);
        expect(res.status).toBe(200);
        expect(mockGetUserIdByUsername).toHaveBeenCalledWith(expect.anything(), OWN);
    });
});
