// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/integrations/upcoming — auth matrix, user resolution and the access
 * boundary handed to the shared upcoming-episodes builder (which is mocked; it is
 * the same function `/api/v1/upcoming` runs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';

const mocks = vi.hoisted(() => ({
    getAdminDb: vi.fn(),
    findWatchHistoryUser: vi.fn(),
    resolveTokenUserAccess: vi.fn(),
    getDeniedLibraryGroups: vi.fn(),
    getUpcomingEpisodesForUser: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    return { ...actual, getAdminDb: (...args: unknown[]) => mocks.getAdminDb(...args) };
});
vi.mock('$lib/server/database/queries/integration-watch-history.queries.js', () => ({
    findWatchHistoryUser: mocks.findWatchHistoryUser,
}));
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: mocks.resolveTokenUserAccess,
}));
vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: mocks.getDeniedLibraryGroups,
}));
vi.mock('$lib/server/api/defs/recommendations/upcoming.js', () => ({
    getUpcomingEpisodesForUser: mocks.getUpcomingEpisodesForUser,
}));

import { def } from './upcoming.js';

const PATH = '/api/v1/integrations/upcoming';
const USER = { id: '7a000000-0000-4000-8000-00000000a001', username: 'leon' };

function makeEvent(principal: Principal | undefined, query = '?user=leon'): RequestEvent {
    const url = new URL(`http://localhost${PATH}${query}`);
    return {
        url,
        params: {},
        route: { id: PATH },
        request: new Request(url.toString()),
        locals: {
            principal,
            user: principal
                ? {
                      userId: principal.userId,
                      username: principal.username,
                      userGroups: principal.userGroups,
                      ownerIsAdmin: principal.isAdmin,
                      maxAgeRating: null,
                  }
                : undefined,
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function serviceToken(scopes: string[], tokenOwnerIsAdmin?: boolean): Principal {
    return buildPrincipal({
        kind: 'service_token',
        userId: 'usr_owner' as never,
        username: 'svc-mediabot',
        userGroups: [],
        tokenScopes: scopes,
        ownerIsAdmin: scopes.includes('admin'),
        tokenOwnerIsAdmin,
    });
}

/** What token-identity.ts builds for an `integrations:read` token of a still-admin owner. */
function integrationsToken(): Principal {
    return serviceToken(['integrations:read'], true);
}

function session(): Principal {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: 'usr_admin' as never,
        username: 'root',
        userGroups: [],
        sessionIsAdmin: true,
    });
}

const { GET } = mount(def, { surface: 'v1' });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminDb.mockReturnValue({});
    mocks.findWatchHistoryUser.mockResolvedValue({ kind: 'found', user: USER });
    mocks.resolveTokenUserAccess.mockResolvedValue({
        userGroups: ['family'],
        permissions: { ownerIsAdmin: false, maxAgeRating: null },
        disabled: false,
        deleted: false,
    });
    mocks.getDeniedLibraryGroups.mockResolvedValue(['grp-kids-only']);
    mocks.getUpcomingEpisodesForUser.mockResolvedValue({ ok: true, items: [], truncated: false });
});

describe('GET /api/v1/integrations/upcoming', () => {
    it('refuses an admin session — only an integrations:read token qualifies', async () => {
        const res = await GET!(makeEvent(session()));
        expect(res.status).toBe(403);
        expect(mocks.getUpcomingEpisodesForUser).not.toHaveBeenCalled();
    });

    it('refuses an admin service token', async () => {
        const res = await GET!(makeEvent(serviceToken(['admin'])));
        expect(res.status).toBe(403);
    });

    it('refuses an integrations:read token whose owner is no longer an admin', async () => {
        const res = await GET!(makeEvent(serviceToken(['integrations:read'], false)));
        expect(res.status).toBe(403);
        expect(mocks.getUpcomingEpisodesForUser).not.toHaveBeenCalled();
    });

    it('serves an integrations:read token with the target user’s own boundary', async () => {
        const res = await GET!(makeEvent(integrationsToken(), '?user=leon&days=3&limit=5'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            items: [],
            truncated: false,
        });
        expect(mocks.resolveTokenUserAccess).toHaveBeenCalledWith('leon');
        expect(mocks.getDeniedLibraryGroups).toHaveBeenCalledWith(
            {},
            { isAdmin: false, userGroups: ['family'] },
        );
        expect(mocks.getUpcomingEpisodesForUser).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                userId: USER.id,
                username: 'leon',
                deniedGroupIds: ['grp-kids-only'],
                maxAgeRating: null,
            }),
            { limit: 5, refresh: false, days: 3 },
        );
    });

    it('defaults to 7 days', async () => {
        await GET!(makeEvent(integrationsToken()));
        expect(mocks.getUpcomingEpisodesForUser.mock.calls[0][2]).toEqual({
            limit: 20,
            refresh: false,
            days: 7,
        });
    });

    it('answers 409 for an ambiguous username and 404 for an unknown one', async () => {
        mocks.findWatchHistoryUser.mockResolvedValueOnce({ kind: 'ambiguous' });
        expect((await GET!(makeEvent(integrationsToken()))).status).toBe(409);
        mocks.findWatchHistoryUser.mockResolvedValueOnce({ kind: 'not_found' });
        expect((await GET!(makeEvent(integrationsToken()))).status).toBe(404);
    });

    it('treats a disabled account as unknown', async () => {
        mocks.resolveTokenUserAccess.mockResolvedValueOnce({
            userGroups: [],
            permissions: { ownerIsAdmin: false, maxAgeRating: null },
            disabled: true,
            deleted: false,
        });
        expect((await GET!(makeEvent(integrationsToken()))).status).toBe(404);
        expect(mocks.getUpcomingEpisodesForUser).not.toHaveBeenCalled();
    });

    it('refuses an age-restricted profile, like /api/v1/upcoming does', async () => {
        mocks.resolveTokenUserAccess.mockResolvedValueOnce({
            userGroups: [],
            permissions: { ownerIsAdmin: false, maxAgeRating: 12 },
            disabled: false,
            deleted: false,
        });
        expect((await GET!(makeEvent(integrationsToken()))).status).toBe(403);
        expect(mocks.getUpcomingEpisodesForUser).not.toHaveBeenCalled();
    });

    it('answers 503 when neither Sonarr nor Radarr answered', async () => {
        mocks.getUpcomingEpisodesForUser.mockResolvedValueOnce({
            ok: false,
            reason: 'upstream_unavailable',
        });
        expect((await GET!(makeEvent(integrationsToken()))).status).toBe(503);
    });

    it('rejects days outside 1-30', async () => {
        expect((await GET!(makeEvent(integrationsToken(), '?user=leon&days=31'))).status).toBe(422);
    });
});

it('returns marked 503 on target-user access dependency failure', async () => {
    const { AuthDependencyUnavailableError } =
        await import('$lib/server/auth/dependency-unavailable.js');
    mocks.resolveTokenUserAccess.mockRejectedValueOnce(new AuthDependencyUnavailableError());
    const response = await GET!(makeEvent(integrationsToken()));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Lumastra-Auth-Unavailable')).toBe('true');
    expect(mocks.getUpcomingEpisodesForUser).not.toHaveBeenCalled();
});
