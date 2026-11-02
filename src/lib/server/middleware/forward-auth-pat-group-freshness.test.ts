// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FIX ROUND 2 (Important, security review 2026-09-16): handlePatAuth's
 * delegation to resolveTokenUserAccess() (fix round 1) moved the `/api/v1`
 * PAT path's group axis from per-request-fresh (`pat.service.ts` fetches
 * `users.groups` fresh on EVERY request — see its own stated contract) to a
 * 10-minute L1 cache, UNLESS the delegating call passes `{ freshGroups:
 * true }`. C9/C10 (this task) exists specifically to close "frozen IdP
 * groups" — regressing the PAT path from per-request-fresh to a 10-minute
 * freeze would reintroduce a weaker version of the very defect being fixed.
 *
 * This test drives the REAL `resolveAuth()` -> `handlePatAuth()` seam (not
 * resolveTokenUserAccess() directly — the reviewer's ask is specifically
 * about "the PAT path") with a REAL, stateful simulation of
 * user-admin-cache.js / user-max-age-cache.js (per-username Maps, not vi.fn
 * stubs — otherwise "warm the cache" has nothing to warm) to prove: warm the
 * cache with one PAT request, then change the underlying DB groups directly
 * (a stand-in for any writer that lands between two PAT requests WITHOUT
 * going through the cache-invalidating path — forward-auth.ts's own
 * syncUserGroupsIfNeeded now invalidates this cache via syncUserGroups() as
 * of security review 5's C4 + Shape C fix, so it is no longer an example of
 * this; the mutation here is a deliberately raw `dbRow.groups` write to keep
 * exercising the cache's TTL behaviour on its own), and assert the VERY NEXT
 * PAT request — still within the 10-minute TTL — sees the NEW groups, not
 * the cached old ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Real (unmocked) buildUserPermissions is exercised — pin every field it
// reads (not just ADMIN_GROUPS) or it throws on `undefined.some(...)` deep
// inside resolveRow()'s try/catch, which fails closed to `null` and makes
// every request 401 for the WRONG reason (masking what this test wants to
// prove). Matches resolve-token-user-access.test.ts's convention.
vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_JELLYFIN_COMPAT: false,
        UNRATED_CONTENT_VISIBLE: false,
        ADMIN_GROUPS: ['admin-group'],
        AGE_RATING_GROUP_PREFIX: 'age-',
        WATCH_PERMISSION_GROUPS: [],
        LIVETV_GROUPS: [],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
    },
    features: { deviceAuth: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// ── REAL, stateful cache simulation (per-username Maps) — the point of this
//    file. A vi.fn()-stub cache (always null/miss, as most sibling test
//    files use) cannot demonstrate "warm cache serves a stale value" at all,
//    since resolveRow()'s fast path requires ALL SIX entries warm together.
const adminCache = new Map<string, boolean>();
const adminPinnedCache = new Map<string, boolean>();
const disabledCache = new Map<string, boolean>();
const deletedCache = new Map<string, boolean>();
const userIdCache = new Map<string, string>();
const groupsCache = new Map<string, string[]>();

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: (u: string) => (adminCache.has(u) ? (adminCache.get(u) ?? false) : null),
    setCachedIsAdmin: (u: string, v: boolean) => {
        adminCache.set(u, v);
    },
    getCachedAdminPinned: (u: string) =>
        adminPinnedCache.has(u) ? (adminPinnedCache.get(u) ?? false) : null,
    setCachedAdminPinned: (u: string, v: boolean) => {
        adminPinnedCache.set(u, v);
    },
    getCachedDisabled: (u: string) =>
        disabledCache.has(u) ? (disabledCache.get(u) ?? false) : null,
    setCachedDisabled: (u: string, v: boolean) => {
        disabledCache.set(u, v);
    },
    getCachedDeleted: (u: string) => (deletedCache.has(u) ? (deletedCache.get(u) ?? false) : null),
    setCachedDeleted: (u: string, v: boolean) => {
        deletedCache.set(u, v);
    },
    getCachedUserId: (u: string) => userIdCache.get(u) ?? null,
    setCachedUserId: (u: string, v: string) => {
        userIdCache.set(u, v);
    },
    getCachedGroups: (u: string) => groupsCache.get(u) ?? null,
    setCachedGroups: (u: string, v: string[]) => {
        groupsCache.set(u, v);
    },
    invalidateUserAdminCache: (u: string) => {
        adminCache.delete(u);
        adminPinnedCache.delete(u);
        disabledCache.delete(u);
        deletedCache.delete(u);
        userIdCache.delete(u);
        groupsCache.delete(u);
    },
}));

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
const maxAgeCache = new Map<string, number | null>();
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: (u: string) =>
        maxAgeCache.has(u) ? maxAgeCache.get(u) : MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: (u: string, v: number | null) => {
        maxAgeCache.set(u, v);
    },
    invalidateUserMaxAgeCache: (u: string) => {
        maxAgeCache.delete(u);
    },
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): () => Promise<unknown[]> {
            return async () => [{ ...dbRow }];
        }
    }
    return { Database: MockDatabase };
});

const mockInAppCapabilities: { maxAgeRating?: number | null } = {};
const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, syncedGroups: readonly string[]) => ({
        inAppGroupNames: [],
        effectiveGroups: [...syncedGroups],
        capabilities: { ...mockInAppCapabilities },
    }),
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: [unknown, string, readonly string[]]) =>
        mockResolveEffectiveAccess(...args),
}));

const PAT_OWNER_ID = '11111111-1111-1111-1111-111111111199';

// The "database row" — mutated mid-test to simulate a `users.groups` write
// that skips cache invalidation (a raw DB write, or any writer not routed
// through syncUserGroups()/invalidateGroupDerivedCaches() — forward-auth.ts's
// own syncUserGroupsIfNeeded no longer qualifies, since it invalidates this
// cache as of security review 5's C4 + Shape C fix) landing between two PAT
// requests. Deliberately NOT reset in beforeEach for the groups field until
// each test sets it explicitly, so the mutation is visible in the test body.
const dbRow = {
    id: PAT_OWNER_ID,
    username: 'group-freshness-owner',
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
    groups: ['old-group'] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
};
const mockGetUserByUsername = vi.fn(async () => ({ ...dbRow }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: () => mockGetUserByUsername(),
}));

const mockPatValidate = vi.fn(async () => ({
    id: 1,
    userId: PAT_OWNER_ID,
    username: 'group-freshness-owner',
    name: 'group-freshness-pat',
    scopes: ['read'],
    groups: ['old-group'], // pat.service.ts's OWN fresh-groups read; irrelevant once handlePatAuth delegates
    jellyfinUserId: null,
    tokenPrefix: 'pat_freshness',
    allowedIps: null,
}));
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        validate: () => mockPatValidate(),
        hasScope: () => true,
    }),
}));

const mockServiceValidate = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        validate: (...args: unknown[]) => mockServiceValidate(...args),
    }),
}));
vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    STREAM_TOKEN_PREFIX: 'stream_',
    getStreamingSessionService: () => ({ validate: vi.fn(), getStatus: vi.fn() }),
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
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
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => async () => [{ ...dbRow }]) },
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { resolveAuth } from './forward-auth.js';
import { checkMediaAccess, userNeedsMediaAccessCheck } from './media-access.js';
import {
    toLibraryAccessUser,
    invalidateLibraryGroupPermissionsCache,
} from '$lib/server/cache/library-group-permissions-cache.js';
import type { Sql } from 'postgres';

vi.mock('$lib/server/database/index.js', () => ({ getDb: vi.fn() }));
vi.mock('$lib/server/database/queries/library-group-permissions.queries.js', () => ({
    getAllLibraryGroupPermissions: async () => [
        { library_group_id: 'restricted-library', allowed_groups: ['private-library'] },
    ],
}));
vi.mock('$lib/server/oauth/jwt.js', () => ({
    verifyAccessToken: async () => ({ username: 'group-freshness-owner', scope: 'media:read' }),
}));

function makeEvent(token = 'pat_freshness_token'): RequestEvent {
    const url = new URL('http://localhost/api/v1/media');
    const headers = new Headers({ authorization: `Bearer ${token}` });
    return {
        url,
        request: new Request(url, { headers }),
        params: {},
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

describe('resolveAuth /api/v1 — PAT group axis must not be served stale from a warm cache (fix round 2)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete mockInAppCapabilities.maxAgeRating;
        adminCache.clear();
        adminPinnedCache.clear();
        disabledCache.clear();
        userIdCache.clear();
        groupsCache.clear();
        maxAgeCache.clear();
        dbRow.groups = ['old-group'];
        dbRow.age_rating_pinned = false;
        dbRow.max_age_rating = null;
        invalidateLibraryGroupPermissionsCache();
        mockGetUserByUsername.mockImplementation(async () => ({ ...dbRow }));
        mockPatValidate.mockImplementation(async () => ({
            id: 1,
            userId: PAT_OWNER_ID,
            username: 'group-freshness-owner',
            name: 'group-freshness-pat',
            scopes: ['read'],
            groups: [...dbRow.groups],
            jellyfinUserId: null,
            tokenPrefix: 'pat_freshness',
            allowedIps: null,
        }));
    });

    it('warms the group cache on the first request, then serves the NEW group on the very next request after an IdP sync', async () => {
        // First request: warms every user-admin-cache entry (isAdmin,
        // adminPinned, maxAge, disabled, userId, groups) for this username —
        // this is the SAME cache resolveTokenUserAccess's fast path checks.
        const firstResult = await resolveAuth(makeEvent(), noopMigration, true);
        expect(firstResult).toBeUndefined();

        // Sanity: the cache is now actually warm (this is what makes the
        // second assertion meaningful — if this fails, the test isn't
        // exercising the cached path at all).
        expect(groupsCache.get('group-freshness-owner')).toEqual(['old-group']);

        // Simulate a `users.groups` write that lands between the two requests
        // without going through the cache-invalidating path (a raw DB write —
        // NOT forward-auth.ts's own syncUserGroupsIfNeeded, which invalidates
        // user-admin-cache.js's group entry itself as of security review 5's
        // C4 + Shape C fix): mutate the row directly, leaving the cache stale.
        dbRow.groups = ['new-group'];

        // Second request, SAME token, cache still warm (well within the
        // 10-minute TTL): must see the NEW group, not the cached OLD one.
        const secondEvent = makeEvent();
        const secondResult = await resolveAuth(secondEvent, noopMigration, true);
        expect(secondResult).toBeUndefined();
        expect(secondEvent.locals.user?.userGroups).toEqual(['new-group']);
        expect(secondEvent.locals.user?.userGroups).not.toEqual(['old-group']);
    });

    it.each(['pat_freshness_token', 'device.jwt.token'])(
        'denies an admin owner scoped credential (%s) access to a restricted library',
        async (token) => {
            dbRow.groups = ['admin-group'];
            userIdCache.set('group-freshness-owner', PAT_OWNER_ID);
            const event = makeEvent(token);
            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(event.locals.user?.ownerIsAdmin).toBe(true); // owner's identity remains available
            expect(toLibraryAccessUser(event.locals.user)?.isAdmin).toBe(false);
            const sql = vi.fn(async () => [{ accessible: false }]) as unknown as Sql;
            expect(await userNeedsMediaAccessCheck(sql, event.locals.user)).toBe(true);
            expect(await checkMediaAccess(sql, `restricted-${token}`, event.locals.user)).toBe(
                false,
            );
        },
    );

    it.each(['pat_freshness_token', 'device.jwt.token'])(
        'enforces an admin owner age pin for a scoped credential (%s)',
        async (token) => {
            dbRow.groups = ['admin-group', 'private-library'];
            dbRow.age_rating_pinned = true;
            dbRow.max_age_rating = 8;
            userIdCache.set('group-freshness-owner', PAT_OWNER_ID);
            const event = makeEvent(token);
            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(false);
            const sql = vi.fn(async () => [{ age_rating: 18 }]) as unknown as Sql;
            expect(await checkMediaAccess(sql, `age-${token}`, event.locals.user)).toBe(false);
        },
    );

    it('keeps an explicit admin PAT library and age bypass', async () => {
        dbRow.groups = ['admin-group'];
        dbRow.age_rating_pinned = true;
        dbRow.max_age_rating = 8;
        const validated = await mockPatValidate();
        mockPatValidate.mockResolvedValue({ ...validated, scopes: ['admin'] });
        const event = makeEvent();
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.principal?.isAdmin).toBe(true);
        expect(toLibraryAccessUser(event.locals.user)?.isAdmin).toBe(true);
        const sql = vi.fn(async () => [{ age_rating: 18 }]) as unknown as Sql;
        expect(await checkMediaAccess(sql, 'admin-pat-item', event.locals.user)).toBe(true);
        expect(sql).not.toHaveBeenCalled();
    });

    it('keeps an age-limited nonadmin profile restricted', async () => {
        dbRow.groups = ['private-library', 'age-8'];
        const event = makeEvent();
        expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
        expect(event.locals.user?.ownerIsAdmin).toBe(false);
        expect(event.locals.user?.maxAgeRating).toBe(8);
        const sql = vi.fn(async () => [{ age_rating: 18 }]) as unknown as Sql;
        expect(await checkMediaAccess(sql, 'age-profile-item', event.locals.user)).toBe(false);
    });

    it.each([true, false])(
        'restores an admin impersonation target age pin when the service token is nonadmin (forceNonAdmin=%s)',
        async (forceNonAdmin) => {
            dbRow.groups = ['admin-group', 'private-library'];
            dbRow.age_rating_pinned = true;
            dbRow.max_age_rating = 8;
            mockServiceValidate.mockResolvedValue({
                id: 7,
                name: 'limited-service',
                tokenPrefix: 'svc_limited',
                createdBy: 'creator',
                scopes: forceNonAdmin ? ['admin', 'read'] : ['read'],
                forceNonAdmin,
                actAsUser: PAT_OWNER_ID,
                allowedIps: null,
            });
            const event = makeEvent('svc_limited_token');
            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(event.locals.user?.ownerIsAdmin).toBe(false);
            expect(event.locals.user?.maxAgeRating).toBe(8);
            const sql = vi.fn(async () => [{ age_rating: 18 }]) as unknown as Sql;
            expect(await checkMediaAccess(sql, 'service-age-item', event.locals.user)).toBe(false);
        },
    );

    it.each([
        { source: 'group', forceNonAdmin: true },
        { source: 'group', forceNonAdmin: false },
        { source: 'cohort', forceNonAdmin: true },
        { source: 'cohort', forceNonAdmin: false },
    ])(
        'enforces the tighter $source age limit after service downgrade (forceNonAdmin=$forceNonAdmin)',
        async ({ source, forceNonAdmin }) => {
            dbRow.groups = ['admin-group', 'private-library'];
            dbRow.age_rating_pinned = true;
            dbRow.max_age_rating = 12;
            if (source === 'group') {
                dbRow.groups.push('age-6');
            } else {
                mockInAppCapabilities.maxAgeRating = 6;
            }
            mockServiceValidate.mockResolvedValue({
                id: 7,
                name: 'limited-service',
                tokenPrefix: 'svc_limited',
                createdBy: 'creator',
                scopes: forceNonAdmin ? ['admin', 'read'] : ['read'],
                forceNonAdmin,
                actAsUser: PAT_OWNER_ID,
                allowedIps: null,
            });
            const event = makeEvent('svc_limited_token');
            expect(await resolveAuth(event, noopMigration, true)).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(event.locals.user?.ownerIsAdmin).toBe(false);
            expect(event.locals.user?.maxAgeRating).toBe(6);
            expect(event.locals.user?.isAgeRestricted).toBe(true);
            const sql = vi.fn(async () => [{ age_rating: 8 }]) as unknown as Sql;
            expect(
                await checkMediaAccess(
                    sql,
                    `service-${source}-${forceNonAdmin}`,
                    event.locals.user,
                ),
            ).toBe(false);
        },
    );
});
