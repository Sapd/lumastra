// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /stats/users/{id}: the admin bypass of a target's social opt-out
 * (`hide_streams`) needs an ADMIN PRINCIPAL, not an admin token owner
 * (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import {
    TEST_USER_ID,
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminScopedPat,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

vi.mock('$lib/server/config.js', () => ({
    features: { social: true, personalStats: true },
    config: { UNRATED_CONTENT_VISIBLE: false },
    isUnavailableMediaVisible: () => true,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

const mockGetUserById = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...a: unknown[]) => mockGetUserById(...a),
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
        getSessionCount: vi.fn(async () => 100),
        getOverviewStats: vi.fn(async () => ({ totalSessions: 1 })),
    },
}));

const { def } = await import('./users-id.js');
const ctx: ApiContext = { surface: 'v1' };

const BOB_ID = 'b0b00000-0000-4000-a000-000000000000';

function target(id: string, hideStreams: boolean): Record<string, unknown> {
    return {
        id,
        username: id === TEST_USER_ID ? 'alice' : 'bob',
        display_name: null,
        hide_streams: hideStreams,
        is_admin: false,
        max_age_rating: null,
    };
}

async function get(locals: RequestEvent['locals'], targetId: string): Promise<Response> {
    const event = {
        url: new URL(`http://localhost/api/v1/stats/users/${targetId}?include=overview`),
        params: { id: targetId },
        locals,
        request: new Request(`http://localhost/api/v1/stats/users/${targetId}`),
    } as unknown as RequestEvent;
    return (await def.handlers.GET!(event, ctx)) as Response;
}

describe('GET /stats/users/{id}: admin principal bypasses hide_streams', () => {
    beforeEach(() => {
        mockGetUserById.mockReset();
        mockGetUserById.mockResolvedValue(target(BOB_ID, true));
    });

    it('an admin owner’s device token cannot read an opted-out user (403)', async () => {
        const res = await get(adminOwnersDeviceToken(), BOB_ID);
        expect(res.status).toBe(403);
    });

    it('an admin owner’s read/write PAT cannot read an opted-out user (403)', async () => {
        const res = await get(adminOwnersReadWritePat(), BOB_ID);
        expect(res.status).toBe(403);
    });

    it('locals.user.isAdmin without a principal cannot read an opted-out user (403)', async () => {
        const res = await get(adminUserWithoutPrincipal(), BOB_ID);
        expect(res.status).toBe(403);
    });

    it('control: an admin session may read an opted-out user', async () => {
        const res = await get(adminSession(), BOB_ID);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { subject: { id: string } };
        expect(body.subject.id).toBe(BOB_ID);
    });

    it('control: an admin-scoped PAT may read an opted-out user', async () => {
        const res = await get(adminScopedPat(), BOB_ID);
        expect(res.status).toBe(200);
    });

    it('an admin owner’s device token can still read a visible (opted-in) user', async () => {
        mockGetUserById.mockResolvedValue(target(BOB_ID, false));
        const res = await get(adminOwnersDeviceToken(), BOB_ID);
        expect(res.status).toBe(200);
    });

    it('an admin owner’s device token can still read ITS OWN stats when opted out', async () => {
        mockGetUserById.mockResolvedValue(target(TEST_USER_ID, true));
        const res = await get(adminOwnersDeviceToken(), TEST_USER_ID);
        expect(res.status).toBe(200);
    });
});
