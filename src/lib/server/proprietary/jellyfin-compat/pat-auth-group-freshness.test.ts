// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Security review 5, C4 (2026-09-23): `validateJellyfinCompatPat` delegates
 * to `resolveTokenUserAccess()` (security review 2026-09-15/16, C9/C10) but
 * — unlike its `/api/v1` sibling in `token-identity.ts`'s
 * `resolvePatIdentity` — never passed `{ freshGroups: true }`. That silently
 * regressed the `/j` PAT path's group axis from per-request-fresh (a `/j`
 * PAT had NO group cache at all before `ab97ee0c8` introduced
 * `resolveTokenUserAccess`'s shared cache) to the resolver's 10-minute L1
 * cache — the identical class of regression the `/api/v1` sibling was
 * explicitly fixed for one task earlier (fix-plan-3 task 3 round 2).
 *
 * This test drives the REAL `validateJellyfinCompatPat` → `resolveTokenUserAccess`
 * seam (the resolver is NOT mocked — only its leaf dependencies are, mirroring
 * `pat-auth.test.ts`) with a REAL, stateful simulation of
 * `user-admin-cache.js` / `user-max-age-cache.js` (per-username Maps, not
 * `vi.fn()` stubs that always report a miss — `pat-auth.test.ts`'s own cache
 * mocks are unconditional `() => null`, which can never observe a warm-cache
 * hit at all, exactly the blind spot security review 5 §7 names). Warm the
 * cache with one `/j` PAT request (groups `['lib-a']`), change the
 * underlying DB row to `[]` (simulating a write that skips invalidation —
 * e.g. an IdP group revocation landing via `forward-auth.ts`'s
 * `syncUserGroupsIfNeeded` before this task's fix, or any future writer that
 * forgets `syncUserGroups()`), and assert the very next `/j` PAT request —
 * still within the 10-minute TTL — sees the NEW (empty) groups, not the
 * cached stale ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real (unmocked) buildUserPermissions is exercised via resolveTokenUserAccess
// — pin every field it reads, matching resolve-token-user-access.test.ts's
// and forward-auth-pat-group-freshness.test.ts's convention.
vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_JELLYFIN_COMPAT: false,
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

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// ── REAL, stateful cache simulation (per-username Maps) — the point of this
//    file. An always-null cache stub cannot demonstrate "warm cache serves a
//    stale value" at all, since resolveRow()'s fast path requires ALL SEVEN
//    entries warm together.
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
        getSql(): Record<string, never> {
            return {};
        }
    }
    return { Database: MockDatabase };
});

vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: async (
        _sql: unknown,
        _userId: string,
        syncedGroups: readonly string[],
    ) => ({ inAppGroupNames: [], effectiveGroups: [...syncedGroups], capabilities: {} }),
}));

const PAT_OWNER_ID = '22222222-2222-2222-2222-222222222299';

// The "database row" — mutated mid-test to simulate an IdP group sync
// landing between two `/j` PAT requests.
const dbRow = {
    id: PAT_OWNER_ID,
    username: 'jf-group-freshness-owner',
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
    groups: ['lib-a'] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
};
const mockGetUserByUsername = vi.fn(async () => ({ ...dbRow }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: () => mockGetUserByUsername(),
}));

const mockValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service', () => ({
    getPatService: () => ({
        validate: mockValidate,
    }),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { validateJellyfinCompatPat } from './pat-auth';

describe('validateJellyfinCompatPat — /j PAT group axis must not be served stale from a warm cache (C4)', () => {
    beforeEach(() => {
        adminCache.clear();
        adminPinnedCache.clear();
        disabledCache.clear();
        deletedCache.clear();
        userIdCache.clear();
        groupsCache.clear();
        maxAgeCache.clear();
        dbRow.groups = ['lib-a'];
        mockGetUserByUsername.mockImplementation(async () => ({ ...dbRow }));
        mockValidate.mockReset();
        mockValidate.mockResolvedValue({
            id: 1,
            userId: PAT_OWNER_ID,
            username: 'jf-group-freshness-owner',
            name: 'jf-group-freshness-pat',
            scopes: ['jellyfin_compat'],
            groups: ['lib-a'], // pat.service.ts's own fresh read of users.groups; irrelevant
            // here since validateJellyfinCompatPat sources userGroups from the resolver
            jellyfinUserId: null,
            tokenPrefix: 'pat_jf_freshness',
        });
    });

    it('warms the group cache on the first request, then serves the NEW (empty) group set after an IdP sync — within the same TTL window', async () => {
        // First request: warms every user-admin-cache entry for this
        // username, same as the fast path resolveTokenUserAccess checks.
        const first = await validateJellyfinCompatPat('jf_freshness_token', '127.0.0.1');
        expect(first).not.toBeNull();
        expect(first!.userGroups).toEqual(['lib-a']);

        // Sanity: the cache is now actually warm.
        expect(groupsCache.get('jf-group-freshness-owner')).toEqual(['lib-a']);

        // Simulates a write that skips invalidation (e.g. an IdP group
        // revocation) landing between the two requests, revoking the user's
        // only group — mutates `users.groups` directly without touching this
        // cache, the way forward-auth.ts's syncUserGroupsIfNeeded did before
        // this task's fix (and the way any future writer that forgets
        // syncUserGroups() would).
        dbRow.groups = [];

        // Second request, same token, cache still warm (well within the
        // 10-minute TTL): must see the NEW (empty) group set, not the
        // cached stale one.
        const second = await validateJellyfinCompatPat('jf_freshness_token', '127.0.0.1');
        expect(second).not.toBeNull();
        expect(second!.userGroups).toEqual([]);
    });
});
