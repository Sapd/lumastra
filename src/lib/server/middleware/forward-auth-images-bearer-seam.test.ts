// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review 2026-09-12, C10 — the entity-image exemption
 * in `handlePublicApiAuth` used to short-circuit `/api/v1/media/{id}/images/{role}`
 * UNCONDITIONALLY, before Bearer/`?api_key=`/`stream_token` parsing. A request
 * that DID present a real credential therefore never got `locals.user`
 * populated, so the route's `checkMediaAccess` library/age gate never ran on
 * this surface — a group-restricted/age-gated item's artwork was reachable
 * with any internal UUID, even from a scoped PAT.
 *
 * These are seam tests through `resolveAuth` (see forward-auth.test.ts /
 * forward-auth-rate-limit-strict-ip.test.ts for the same event-building
 * pattern), asserting only that `locals.user` DOES get populated for a Bearer
 * request reaching the images path — i.e. that `checkMediaAccess` is no
 * longer structurally dead there. The route's own access-gate behavior once
 * `locals.user` is set has separate coverage in `defs/images.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: { FEATURE_JELLYFIN_COMPAT: false },
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
    buildUserPermissions: () => ({
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    }),
}));

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: () => null,
    setCachedIsAdmin: () => {},
    getCachedAdminPinned: () => null,
    setCachedAdminPinned: () => {},
    getCachedDisabled: () => null,
    setCachedDisabled: () => {},
    getCachedDeleted: () => null,
    setCachedDeleted: () => {},
    getCachedUserId: () => '00000000-0000-0000-0000-0000000000aa',
    setCachedUserId: () => {},
    getCachedGroups: () => null,
    setCachedGroups: () => {},
    invalidateUserAdminCache: () => {},
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => null) },
}));

vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: 0, total: 1 })),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => true),
    getKeysByPattern: vi.fn(async () => []),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): () => Promise<unknown[]> {
            return vi.fn(async () => []);
        }
    }
    return { Database: MockDatabase };
});

// resolveTokenUserAccess() (now also consulted by handlePatAuth for the
// age-rating axis — security review C9/C10, 2026-09-15/16) resolves the
// owner's row via getUserByUsername, not through the Database mock above
// (whose empty-array stub would otherwise read as "no such user" and deny
// every PAT in this file with a 401 before the images route is ever reached).
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: async (username: string) => ({
        id: '11111111-1111-1111-1111-111111111111',
        username,
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: [] as string[],
        disabled_at: null,
        deleted_at: null,
    }),
}));

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
}));

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: () => MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: () => {},
}));

const mockPatValidate = vi.fn(async () => ({
    id: 1,
    userId: '11111111-1111-1111-1111-111111111111',
    username: 'alice',
    name: 'alice-pat',
    scopes: ['read'],
    groups: [] as string[],
    jellyfinUserId: null,
    tokenPrefix: 'pat_abc',
    allowedIps: null,
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: (...args: unknown[]) =>
            (mockPatValidate as unknown as (...a: unknown[]) => unknown)(...args),
        hasScope: () => true,
    }),
}));

vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn() }),
}));

vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeImagesEvent(opts: { authHeader?: string; sig?: string }): RequestEvent {
    const url = new URL(
        'http://localhost/api/v1/media/550e8400-e29b-41d4-a716-446655440000/images/poster',
    );
    if (opts.sig) url.searchParams.set('sig', opts.sig);
    const headers = new Headers();
    if (opts.authHeader) headers.set('authorization', opts.authHeader);
    const request = new Request(url, { headers });

    return {
        url,
        request,
        params: { id: '550e8400-e29b-41d4-a716-446655440000', role: 'poster' },
        route: { id: url.pathname },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const noopMigration = async (): Promise<void> => undefined;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('C10 — /api/v1/media/{id}/images/{role} populates locals.user for a real credential', () => {
    it('a Bearer PAT reaches the images route with locals.user SET (checkMediaAccess is reachable)', async () => {
        const event = makeImagesEvent({ authHeader: 'Bearer pat_abc123' });
        const result = await resolveAuth(event, noopMigration, true);

        // undefined = auth resolved, continue to the route.
        expect(result).toBeUndefined();
        expect(event.locals.user?.username).toBe('alice');
        expect(mockPatValidate).toHaveBeenCalledTimes(1);
    });

    it.each([
        '/api/v1/media/tmdb:603:movie/images/poster',
        '/api/%76%31/media/tmdb:603:movie/images/poster',
        '/de/api/v1/media/tmdb:603:movie/images/poster/',
        '/api/v1/media/alias/images/poster?externalId=tmdb:603:movie',
    ])('parses bearer plus sig for external artwork at %s', async (path) => {
        const event = makeImagesEvent({ authHeader: 'Bearer pat_abc123', sig: 'deadbeef' });
        event.params.id = 'tmdb:603:movie';
        event.url = new URL(path, event.url);
        event.url.searchParams.set('sig', 'deadbeef');
        if (event.url.searchParams.has('externalId')) event.params = { role: 'poster' };
        event.request = new Request(event.url, { headers: { authorization: 'Bearer pat_abc123' } });
        const result = await resolveAuth(event, noopMigration, true);
        expect(result).toBeUndefined();
        expect(event.locals.user?.username).toBe('alice');
        expect(mockPatValidate).toHaveBeenCalledTimes(1);
    });

    it('?sig= keeps the existing behavior: exempted before credential parsing, locals.user stays unset', async () => {
        const event = makeImagesEvent({ sig: 'deadbeef' });
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        expect(mockPatValidate).not.toHaveBeenCalled();
    });

    it('no credential at all keeps the existing anonymous behavior: exempted, locals.user stays unset', async () => {
        const event = makeImagesEvent({});
        const result = await resolveAuth(event, noopMigration, true);

        expect(result).toBeUndefined();
        expect(event.locals.user).toBeUndefined();
        expect(mockPatValidate).not.toHaveBeenCalled();
    });
});
