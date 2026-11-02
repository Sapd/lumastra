// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/integrations/watch-history — auth matrix + request/response contract.
 *
 * Drives the REAL auth chain (buildPrincipal → mount()'s
 * {kind:'scope', anyOf:['integrations:read']} gate → the def's integration-token check),
 * plus the envelopes (`tokenEnvelopeDenial`, `integrationsGrantPathDenial`) that the
 * shared token producer applies before mount(). The payload builder is mocked; its SQL is covered by
 * integration-watch-history.service.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { tokenEnvelopeDenial } from '$lib/server/auth/token-identity.js';
import { integrationsGrantPathDenial } from '$lib/server/auth/integration-token.js';
import {
    WatchHistoryResponseSchema,
    type WatchHistoryResponse,
} from '$lib/schemas/api-watch-history-integration-responses.js';

const mocks = vi.hoisted(() => ({
    getAdminDb: vi.fn(),
    getIntegrationWatchHistory: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    return { ...actual, getAdminDb: (...args: unknown[]) => mocks.getAdminDb(...args) };
});
vi.mock('$lib/server/services/integration-watch-history.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/services/integration-watch-history.service.js')
        >();
    return { ...actual, getIntegrationWatchHistory: mocks.getIntegrationWatchHistory };
});

import { def } from './watch-history.js';
import { InvalidWatchHistoryCursorError } from '$lib/server/services/integration-watch-history.service.js';

const PATH = '/api/v1/integrations/watch-history';

const PAYLOAD: WatchHistoryResponse = {
    generatedAt: '2026-10-02T12:00:00.000Z',
    user: { id: '7a000000-0000-4000-8000-00000000a001', username: 'leon', displayName: null },
    recentlyWatched: {
        items: [
            {
                id: '7a000000-0000-4000-8000-000000000101',
                type: 'movie',
                title: 'Awakening',
                year: 2016,
                genres: ['Drama'],
                series: null,
                seasonNumber: null,
                episodeNumber: null,
                lastWatchedAt: null,
                progressPercent: 100,
                completed: true,
            },
        ],
        page: { limit: 50, hasMore: false },
    },
    continueWatching: [],
    topGenres: { days: 180, genres: [{ name: 'Drama', titles: 1 }] },
    stats: {
        moviesWatched: 1,
        episodesWatched: 0,
        seriesWatched: 0,
        audiobooksFinished: 0,
        inProgress: 0,
        activeInWindow: 0,
        undated: 1,
        tracksPlayedInWindow: 0,
    },
};

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
                      isAdmin: principal.isAdmin,
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

function session(isAdmin: boolean): Principal {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: (isAdmin ? 'usr_admin' : 'usr_1') as never,
        username: isAdmin ? 'root' : 'alice',
        userGroups: [],
        sessionIsAdmin: isAdmin,
    });
}

function pat(scopes: string[], ownerIsAdmin: boolean): Principal {
    return buildPrincipal({
        kind: 'pat',
        userId: 'usr_owner' as never,
        username: 'leon',
        userGroups: [],
        tokenScopes: scopes,
        ownerIsAdmin,
    });
}

function serviceToken(
    scopes: string[],
    opts: { ownerIsAdmin?: boolean; tokenOwnerIsAdmin?: boolean } = {},
): Principal {
    return buildPrincipal({
        kind: 'service_token',
        userId: 'usr_owner' as never,
        username: 'svc-mediabot',
        userGroups: [],
        tokenScopes: scopes,
        ownerIsAdmin: opts.ownerIsAdmin ?? false,
        tokenOwnerIsAdmin: opts.tokenOwnerIsAdmin,
    });
}

/** What token-identity.ts builds for an `integrations:read` token of a still-admin owner. */
function integrationsToken(ownerIsAdmin = true): Principal {
    return serviceToken(['integrations:read'], { tokenOwnerIsAdmin: ownerIsAdmin });
}

const { GET } = mount(def, { surface: 'v1' });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminDb.mockReturnValue({});
    mocks.getIntegrationWatchHistory.mockResolvedValue({ ok: true, value: PAYLOAD });
});

describe('GET /api/v1/integrations/watch-history — auth', () => {
    // The 401 itself comes from the /api/v1 gate in front of mount()
    // (hooks.server.test.ts, `isApiV1RequestAuthorized`); mount() still refuses.
    it('never serves a request without a credential', async () => {
        const res = await GET!(makeEvent(undefined));
        expect(res.status).toBe(401);
        expect(mocks.getIntegrationWatchHistory).not.toHaveBeenCalled();
    });

    it('serves an integrations:read service token', async () => {
        const res = await GET!(makeEvent(integrationsToken()));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(WatchHistoryResponseSchema.parse(await res.json())).toEqual(PAYLOAD);
        expect(mocks.getIntegrationWatchHistory).toHaveBeenCalledWith({}, 'leon', {
            limit: 50,
            cursor: undefined,
            days: 180,
        });
    });

    // Reached via the shared token producer, before mount().
    it('the token envelopes keep an integrations token inside its family', () => {
        expect(
            tokenEnvelopeDenial(
                { allowedPathPrefixes: ['/api/v1/integrations/homepage'] },
                PATH,
                'GET',
            ),
        ).toEqual({
            status: 403,
            error: 'Token not permitted on this endpoint',
        });
        expect(tokenEnvelopeDenial({ allowedPathPrefixes: [PATH] }, PATH, 'GET')).toBeNull();
        expect(integrationsGrantPathDenial(['integrations:read'], PATH)).toBeNull();
        expect(integrationsGrantPathDenial(['integrations:read'], '/api/v1/me/stats')).toEqual({
            status: 403,
            error: 'Token not permitted on this endpoint',
        });
    });

    const forbidden: Array<[string, () => Principal]> = [
        ['a plain user session', () => session(false)],
        ['an admin session', () => session(true)],
        ['a user PAT', () => pat(['read'], false)],
        ['an admin PAT (even the owner reading their own history)', () => pat(['admin'], true)],
        ['an admin service token', () => serviceToken(['admin'], { ownerIsAdmin: true })],
        ['a read service token', () => serviceToken(['read'])],
        [
            'an integrations:read token whose owner is no longer an admin',
            () => integrationsToken(false),
        ],
        [
            'an integrations:read token without an established owner verdict',
            () => serviceToken(['integrations:read']),
        ],
        ['a PAT that somehow carries integrations:read', () => pat(['integrations:read'], true)],
    ];
    it.each(forbidden)('403s %s', async (_label, make) => {
        const res = await GET!(makeEvent(make()));
        expect(res.status).toBe(403);
        expect(mocks.getIntegrationWatchHistory).not.toHaveBeenCalled();
    });
});

describe('GET /api/v1/integrations/watch-history — request contract', () => {
    const ok = (): Principal => integrationsToken();

    it('404s an unknown user with a problem envelope', async () => {
        mocks.getIntegrationWatchHistory.mockResolvedValue({ ok: false, reason: 'user_not_found' });
        const res = await GET!(makeEvent(ok(), '?user=ghost'));
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect(await res.json()).toMatchObject({
            code: 'not_found',
            status: 404,
            error: 'Unknown user',
        });
    });

    it('409s a username that matches two accounts case-insensitively', async () => {
        mocks.getIntegrationWatchHistory.mockResolvedValue({ ok: false, reason: 'user_ambiguous' });
        const res = await GET!(makeEvent(ok(), '?user=Leon'));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'conflict' });
    });

    it.each([
        ['', 'user'],
        ['?user=', 'user'],
        ['?user=leon&limit=0', 'limit'],
        ['?user=leon&limit=201', 'limit'],
        ['?user=leon&days=0', 'days'],
        ['?user=le%00on', 'user'],
    ])('422s %s', async (query, field) => {
        const res = await GET!(makeEvent(ok(), query));
        expect(res.status).toBe(422);
        const body = (await res.json()) as { details?: Array<{ field: string }> };
        expect(body.details?.some((d) => d.field.includes(field))).toBe(true);
        expect(mocks.getIntegrationWatchHistory).not.toHaveBeenCalled();
    });

    it('passes limit, cursor and days through', async () => {
        const res = await GET!(makeEvent(ok(), '?user=leon&limit=200&cursor=abc&days=30'));
        expect(res.status).toBe(200);
        expect(mocks.getIntegrationWatchHistory).toHaveBeenCalledWith({}, 'leon', {
            limit: 200,
            cursor: 'abc',
            days: 30,
        });
    });

    it('422s a malformed cursor', async () => {
        mocks.getIntegrationWatchHistory.mockRejectedValue(
            new InvalidWatchHistoryCursorError('Malformed cursor'),
        );
        const res = await GET!(makeEvent(ok(), '?user=leon&cursor=zzz'));
        expect(res.status).toBe(422);
    });

    it('checks auth before validating the query', async () => {
        const res = await GET!(makeEvent(session(false), ''));
        expect(res.status).toBe(403);
    });

    it('503s when the database is unavailable', async () => {
        mocks.getAdminDb.mockReturnValue(null);
        const res = await GET!(makeEvent(ok()));
        expect(res.status).toBe(503);
    });
});
