// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/watch-together/parties?includePrivate=true: private sessions are
 * listed only for an ADMIN PRINCIPAL, not for an admin token owner
 * (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '$lib/server/config.js';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminScopedPat,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mockGetAllSessions = vi.fn();
vi.mock('$lib/server/services/watch-together.service', () => ({
    getAllSessions: (...a: unknown[]) => mockGetAllSessions(...a),
}));

vi.mock('$lib/server/utils/widget-guard.js', () => ({
    isWidgetDisabled: () => false,
    createDisabledWidgetResponse: () => new Response(null, { status: 404 }),
}));

vi.mock('$lib/server/database', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

vi.mock('$lib/server/utils/watch-together-access', () => ({
    resolveWatchTogetherBoundary: vi.fn(async () => ({})),
    filterSessionsByAccess: vi.fn(async (_sql: unknown, sessions: unknown[]) => sessions),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds: vi.fn(async () => [
        { id: '11111111-1111-4111-8111-111111111111', display_name: 'Alice Display' },
    ]),
}));

const { GET } = await import('./+server.js');

async function list(locals: RequestEvent['locals'], includePrivate: boolean): Promise<Response> {
    const url = new URL(
        `http://localhost/api/v1/watch-together/parties${includePrivate ? '?includePrivate=true' : ''}`,
    );
    return GET({ url, locals } as unknown as Parameters<typeof GET>[0]);
}

describe('GET /watch-together/parties: includePrivate needs an admin principal', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(config, 'FEATURE_WATCH_TOGETHER', 'get').mockReturnValue(true);
        mockGetAllSessions.mockReset();
        mockGetAllSessions.mockResolvedValue([]);
    });

    it('an admin owner’s device token gets public sessions only', async () => {
        const res = await list(adminOwnersDeviceToken(), true);
        expect(res.status).toBe(200);
        expect(mockGetAllSessions).toHaveBeenCalledWith(true);
    });

    it('an admin owner’s read/write PAT gets public sessions only', async () => {
        await list(adminOwnersReadWritePat(), true);
        expect(mockGetAllSessions).toHaveBeenCalledWith(true);
    });

    it('locals.user.isAdmin without a principal gets public sessions only', async () => {
        const res = await list(adminUserWithoutPrincipal(), true);
        expect(res.status).toBe(200);
        expect(mockGetAllSessions).toHaveBeenCalledWith(true);
    });

    it('control: an admin session with includePrivate=true gets private sessions too', async () => {
        const res = await list(adminSession(), true);
        expect(res.status).toBe(200);
        expect(mockGetAllSessions).toHaveBeenCalledWith(false);
    });

    it('control: an admin-scoped PAT with includePrivate=true gets private sessions too', async () => {
        await list(adminScopedPat(), true);
        expect(mockGetAllSessions).toHaveBeenCalledWith(false);
    });

    it('returns unlisted rows to an admin with UUID host identity and display name', async () => {
        const hostUserId = '11111111-1111-4111-8111-111111111111';
        mockGetAllSessions.mockResolvedValue([
            {
                code: 'ABC123',
                hostUserId,
                hostDisplayName: 'Alice',
                visibility: 'unlisted',
                title: 'Movie',
                mediaType: 'movie',
                itemId: 'item',
                isPlaying: false,
                createdAt: 1,
                participants: [
                    { userId: hostUserId, displayName: 'Alice', clientId: 'c', joinedAt: 1 },
                ],
            },
        ]);
        const response = await list(adminSession(), true);
        expect(await response.json()).toMatchObject({
            items: [
                {
                    host: { userId: hostUserId, displayName: 'Alice Display' },
                    visibility: 'unlisted',
                },
            ],
        });
        expect(mockGetAllSessions).toHaveBeenCalledWith(false);
    });

    it('an admin session WITHOUT includePrivate still gets public sessions only', async () => {
        await list(adminSession(), false);
        expect(mockGetAllSessions).toHaveBeenCalledWith(true);
    });
});

it('feature off returns 404 before looking up sessions', async () => {
    vi.spyOn(config, 'FEATURE_WATCH_TOGETHER', 'get').mockReturnValue(false);
    mockGetAllSessions.mockClear();
    const response = await list(adminSession(), true);
    expect(response.status).toBe(404);
    expect(mockGetAllSessions).not.toHaveBeenCalled();
});
