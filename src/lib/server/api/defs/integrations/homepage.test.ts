// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/integrations/homepage — auth gate + response contract.
 *
 * Drives the REAL auth chain (buildPrincipal → real deriveIsAdmin → mount()'s
 * {kind:'scope', anyOf:['integrations:read']} gate → the handler's admin-or-integrations
 * check), like tasks-read-scope-gate.test.ts: the endpoint returns every user's session
 * titles, so it must stay unreachable for a non-admin session, a `read`/`write` token, an
 * `admin` token whose owner is no longer an admin, and an `integrations:read` token whose
 * owner is no longer an admin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import {
    HomepageSummarySchema,
    type HomepageSummary,
} from '$lib/schemas/api-homepage-responses.js';

const mocks = vi.hoisted(() => ({
    getAdminDb: vi.fn(),
    getHomepageSummary: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    return { ...actual, getAdminDb: (...args: unknown[]) => mocks.getAdminDb(...args) };
});
vi.mock('$lib/server/services/homepage-summary.service.js', () => ({
    getHomepageSummary: mocks.getHomepageSummary,
}));

import { def } from './homepage.js';

const SUMMARY: HomepageSummary = {
    generatedAt: '2026-10-02T12:00:00.000Z',
    summary: {
        streams: 1,
        transcodes: 0,
        directPlays: 1,
        users: 1,
        bandwidthMbps: 8,
        nodesUp: 1,
        nodesExpected: 1,
        tasksRunning: 0,
        tasksQueued: 0,
        tasksFailed24h: 0,
        alerts: 0,
        health: 'ok',
        version: '1.0.0',
    },
    sessions: [{ name: 'alex · Dawn', label: 'direct · 8.0 Mbps · 10%' }],
    nodes: [{ name: 'web-0', label: 'web · up 1h' }],
    tasks: [],
    alerts: [],
    library: { movies: 1, series: 0, episodes: 0, artists: 0, albums: 0, tracks: 0, audiobooks: 0 },
    recentlyAdded: [],
};

function makeEvent(principal: ReturnType<typeof buildPrincipal>): RequestEvent {
    const url = new URL('http://localhost/api/v1/integrations/homepage');
    return {
        url,
        params: {},
        route: { id: '/api/v1/integrations/homepage' as const },
        request: new Request(url.toString()),
        locals: {
            principal,
            user: {
                userId: principal.userId,
                username: principal.username,
                userGroups: principal.userGroups,
                ownerIsAdmin: principal.isAdmin,
                maxAgeRating: null,
            },
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

function session(isAdmin: boolean) {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: (isAdmin ? 'usr_admin' : 'usr_1') as never,
        username: isAdmin ? 'root' : 'alice',
        userGroups: [],
        sessionIsAdmin: isAdmin,
    });
}

/** A bearer service token as resolved by the token layer, with its RAW minted scopes. */
function serviceToken(scopes: string[], ownerIsAdmin: boolean) {
    return buildPrincipal({
        kind: 'service_token',
        userId: 'usr_owner' as never,
        username: 'svc-homepage',
        userGroups: [],
        tokenScopes: scopes,
        // token-identity.ts sets both from the same owner verdict: `ownerIsAdmin` only
        // for the admin grant, `tokenOwnerIsAdmin` only for integrations:read.
        ownerIsAdmin: scopes.includes('admin') && ownerIsAdmin,
        tokenOwnerIsAdmin: scopes.includes('integrations:read') ? ownerIsAdmin : undefined,
    });
}

const { GET } = mount(def, { surface: 'v1' });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAdminDb.mockReturnValue({});
    mocks.getHomepageSummary.mockResolvedValue(SUMMARY);
});

describe('GET /api/v1/integrations/homepage', () => {
    it('403s a plain non-admin session and never builds the summary', async () => {
        const principal = session(false);
        expect(principal.isAdmin).toBe(false);

        const res = await GET!(makeEvent(principal));
        expect(res.status).toBe(403);
        expect(mocks.getHomepageSummary).not.toHaveBeenCalled();
    });

    it('returns the summary to an admin, uncached by intermediaries', async () => {
        const res = await GET!(makeEvent(session(true)));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(HomepageSummarySchema.parse(await res.json())).toEqual(SUMMARY);
    });

    it.each([[['read']], [['write']], [['read', 'write']]])(
        '403s a service token minted with %j',
        async (scopes) => {
            const res = await GET!(makeEvent(serviceToken(scopes, true)));
            expect(res.status).toBe(403);
            expect(mocks.getHomepageSummary).not.toHaveBeenCalled();
        },
    );

    it('serves an admin service token', async () => {
        const res = await GET!(makeEvent(serviceToken(['admin'], true)));
        expect(res.status).toBe(200);
    });

    it('serves an integrations:read service token (the documented Homepage credential)', async () => {
        const res = await GET!(makeEvent(serviceToken(['integrations:read'], true)));
        expect(res.status).toBe(200);
    });

    it('403s an integrations:read service token whose owner is no longer an admin', async () => {
        const res = await GET!(makeEvent(serviceToken(['integrations:read'], false)));
        expect(res.status).toBe(403);
        expect(mocks.getHomepageSummary).not.toHaveBeenCalled();
    });

    // buildPrincipal strips the admin scopes of a demoted owner's token, and the handler
    // additionally requires principal.isAdmin (deriveIsAdmin: owner's CURRENT status).
    it('403s an admin-scoped service token whose owner is no longer an admin', async () => {
        const res = await GET!(makeEvent(serviceToken(['admin'], false)));
        expect(res.status).toBe(403);
    });

    it('503s when the database is unavailable', async () => {
        mocks.getAdminDb.mockReturnValue(null);
        const res = await GET!(makeEvent(session(true)));
        expect(res.status).toBe(503);
        expect(mocks.getHomepageSummary).not.toHaveBeenCalled();
    });
});
