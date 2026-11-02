// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Subsonic auth SEAM (`validateCredentials` / `validateApiKey`) must carry
 * the SAME age ceiling every other surface applies.
 *
 * Before this fix both entry points derived permissions with a bare
 * `buildUserPermissions(row.groups ?? [])` — no `extraCapabilities`, and no
 * read of `users.age_rating_pinned` / `users.max_age_rating` anywhere in the
 * module. Per `access-control.service.ts`, the in-app layer drives age ONLY
 * through the MIN-merged `max_age_rating` capability (age-NAMED in-app groups
 * are deliberately stripped so a permissive cohort can never RAISE a ceiling),
 * so that call dropped an in-app-conferred restriction outright — permanently,
 * not merely during a DB fault. `toUserContext` then fed the result straight
 * into the age gate.
 *
 * `buildUserPermissions` is deliberately NOT mocked here (unlike
 * `auth-disabled-user.test.ts`, which stubs it to a constant): the behaviour
 * under test IS its `extraCapabilities` MIN-merge, and a stub returning a fixed
 * `maxAgeRating: null` could not exercise it.
 *
 * The 60s Valkey auth cache is part of the seam — `validateCredentials` skips
 * the DB entirely on a cache hit — so the last test re-authenticates against a
 * warm cache and asserts the ceiling survives that path too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.LUMASTRA_MASTER_KEY = 'd'.repeat(64);

const USER_ID = '55555555-5555-5555-5555-555555555501';
const USERNAME = 'inapp-only-kid';
const TOKEN = 'b'.repeat(40);

interface Row {
    id: number;
    user_id: string;
    token: string | null;
    token_sealed: string | null;
    token_lookup: string | null;
    created_at: Date;
    last_used_at: Date | null;
    username: string;
    is_admin: boolean;
    display_name: string | null;
    groups: string[] | null;
}

const { rows, cache } = vi.hoisted(() => ({
    rows: new Map<string, unknown>(),
    cache: new Map<string, string>(),
}));

vi.mock('$lib/server/database/queries/subsonic-client-passwords.queries', () => ({
    // Mirrors the real SQL, which JOINs users and matches
    // `LOWER(u.username) = LOWER($1)`.
    getTokenByUsername: {
        one: async (_sql: unknown, { username }: { username: string }) =>
            (Array.from(rows.values()) as Row[]).find(
                (r) => r.username.toLowerCase() === username.toLowerCase(),
            ) ?? null,
    },
    getTokenByValue: {
        one: async (_sql: unknown, { token }: { token: string }) =>
            (Array.from(rows.values()) as Row[]).find((r) => r.token === token) ?? null,
    },
    getTokenByUserId: { one: async () => null },
    getTokenWithUserByUserId: { one: async () => null },
    upsertToken: { execute: async () => [] },
    upgradeTokenToSealed: { execute: async () => [] },
    updateLastUsed: { execute: async () => [] },
    deleteToken: { execute: async () => [] },
}));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async (k: string) => cache.get(k) ?? null,
    cacheSet: async (k: string, v: string) => {
        cache.set(k, v);
        return true;
    },
    cacheDel: async (k: string) => (cache.delete(k) ? 1 : 0),
}));

vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => ({}) as unknown },
}));

// Real buildUserPermissions runs against this config.
vi.mock('$lib/server/config', () => ({
    config: {
        ADMIN_GROUPS: ['admin'],
        WATCH_PERMISSION_GROUPS: ['admin'],
        LIVETV_GROUPS: ['livetv'],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
        ARR_MANAGER_GROUPS: [],
        AGE_RATING_GROUP_PREFIX: 'age-',
    },
    features: {},
}));

// --- resolveTokenUserAccess's own dependencies ------------------------------

// No age group, no per-user pin: the ONLY age restriction is the in-app cohort.
const dbRow = {
    id: USER_ID,
    username: USERNAME,
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
    groups: [] as string[],
    disabled_at: null as Date | null,
    deleted_at: null as Date | null,
};
const mockGetUserByUsername = vi.fn(async () => ({ ...dbRow }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (_sql: unknown, _u: string) => mockGetUserByUsername(),
}));

const mockResolveEffectiveAccess = vi.fn(
    async (_sql: unknown, _userId: string, syncedGroups: readonly string[]) => ({
        inAppGroupNames: ['kids-cohort'],
        effectiveGroups: [...syncedGroups, 'kids-cohort'],
        capabilities: { maxAgeRating: 6 },
    }),
);
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: [unknown, string, readonly string[]]) =>
        mockResolveEffectiveAccess(...args),
}));

const { userCaches } = vi.hoisted(() => ({
    userCaches: {
        admin: new Map<string, boolean>(),
        adminPinned: new Map<string, boolean>(),
        disabled: new Map<string, boolean>(),
        deleted: new Map<string, boolean>(),
        userId: new Map<string, string>(),
        groups: new Map<string, string[]>(),
        maxAge: new Map<string, number | null>(),
    },
}));

vi.mock('$lib/server/cache/user-admin-cache.js', () => ({
    getCachedIsAdmin: (u: string) =>
        userCaches.admin.has(u) ? (userCaches.admin.get(u) ?? false) : null,
    setCachedIsAdmin: (u: string, v: boolean) => void userCaches.admin.set(u, v),
    getCachedAdminPinned: (u: string) =>
        userCaches.adminPinned.has(u) ? (userCaches.adminPinned.get(u) ?? false) : null,
    setCachedAdminPinned: (u: string, v: boolean) => void userCaches.adminPinned.set(u, v),
    getCachedDisabled: (u: string) =>
        userCaches.disabled.has(u) ? (userCaches.disabled.get(u) ?? false) : null,
    setCachedDisabled: (u: string, v: boolean) => void userCaches.disabled.set(u, v),
    getCachedDeleted: (u: string) =>
        userCaches.deleted.has(u) ? (userCaches.deleted.get(u) ?? false) : null,
    setCachedDeleted: (u: string, v: boolean) => void userCaches.deleted.set(u, v),
    getCachedUserId: (u: string) => userCaches.userId.get(u) ?? null,
    setCachedUserId: (u: string, v: string) => void userCaches.userId.set(u, v),
    getCachedGroups: (u: string) => userCaches.groups.get(u) ?? null,
    setCachedGroups: (u: string, v: string[]) => void userCaches.groups.set(u, v),
}));

const { MAX_AGE_MISS_SENTINEL } = vi.hoisted(() => ({
    MAX_AGE_MISS_SENTINEL: Symbol('max-age-miss'),
}));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS: MAX_AGE_MISS_SENTINEL,
    getCachedMaxAge: (u: string) =>
        userCaches.maxAge.has(u) ? userCaches.maxAge.get(u) : MAX_AGE_MISS_SENTINEL,
    setCachedMaxAge: (u: string, v: number | null) => void userCaches.maxAge.set(u, v),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): Record<string, never> {
            return {};
        }
    }
    return { Database: MockDatabase, getDb: () => ({}) };
});

const { validateCredentials, validateApiKey } = await import('./auth');

describe('Subsonic auth seam — the in-app age ceiling must reach the UserContext', () => {
    beforeEach(() => {
        rows.clear();
        cache.clear();
        for (const c of Object.values(userCaches)) c.clear();
        mockResolveEffectiveAccess.mockClear();
        rows.set(USER_ID, {
            id: 1,
            user_id: USER_ID,
            token: TOKEN,
            token_sealed: null,
            token_lookup: null,
            created_at: new Date(),
            last_used_at: null,
            username: USERNAME,
            is_admin: false,
            display_name: null,
            groups: [],
        } satisfies Row);
    });

    it('validateCredentials applies an in-app-cohort max_age_rating no group supplies', async () => {
        const auth = await validateCredentials(USERNAME, { password: TOKEN });

        expect(auth).not.toBeNull();
        // The bug: maxAgeRating resolved to null / isAgeRestricted false, so
        // toUserContext handed the age gate an unrestricted principal.
        expect(auth?.maxAgeRating).toBe(6);
        expect(auth?.isAgeRestricted).toBe(true);
    });

    it('validateApiKey applies the same in-app-cohort ceiling', async () => {
        const auth = await validateApiKey(TOKEN, {} as never);

        expect(auth).not.toBeNull();
        expect(auth?.maxAgeRating).toBe(6);
        expect(auth?.isAgeRestricted).toBe(true);
    });

    it('keeps the ceiling on the warm-cache path, which skips the DB entirely', async () => {
        await validateCredentials(USERNAME, { password: TOKEN });
        // Second call is served from the 60s auth cache — pre-fix, that entry
        // stored the group-only (unrestricted) age it was built with.
        const auth = await validateCredentials(USERNAME, { password: TOKEN });

        expect(auth?.maxAgeRating).toBe(6);
        expect(auth?.isAgeRestricted).toBe(true);
    });

    it('rejects a SOFT-DELETED user on validateCredentials', async () => {
        // `getTokenByUsername` filters `u.disabled_at IS NULL` in SQL but says
        // nothing about `deleted_at`, and this module checked neither. Now that
        // the seam resolves through resolveTokenUserAccess it has both flags in
        // hand — `TokenUserAccess.deleted`'s contract is that every caller
        // checking `disabled` checks this alongside it.
        mockGetUserByUsername.mockResolvedValueOnce({ ...dbRow, deleted_at: new Date() });

        const auth = await validateCredentials(USERNAME, { password: TOKEN });

        expect(auth).toBeNull();
    });

    it('rejects a SOFT-DELETED user on validateApiKey', async () => {
        mockGetUserByUsername.mockResolvedValueOnce({ ...dbRow, deleted_at: new Date() });

        const auth = await validateApiKey(TOKEN, {} as never);

        expect(auth).toBeNull();
    });

    it('rejects a DISABLED user at the seam even if the SQL filter did not catch it', async () => {
        mockGetUserByUsername.mockResolvedValueOnce({ ...dbRow, disabled_at: new Date() });

        const auth = await validateCredentials(USERNAME, { password: TOKEN });

        expect(auth).toBeNull();
    });

    it('still rejects a wrong credential', async () => {
        const auth = await validateCredentials(USERNAME, { password: 'c'.repeat(40) });

        expect(auth).toBeNull();
    });

    it('returns the resolver-computed isAdmin, not the third-formula cache seed (fix-plan-5 Task 9; fix round 1 correction)', async () => {
        // fix-plan-5 Task 9 seeded auth.ts's cache-miss branch with
        // fail-closed placeholders (isAdmin:false, unconditionally) instead
        // of the old third formula (raw `is_admin` column). That means the
        // seed NO LONGER reads `row.is_admin` at all, so a fixture row with
        // `is_admin: true` can no longer discriminate seed-vs-resolver — the
        // seed always contributes `false` regardless of what this row says.
        // To prove the RETURNED value is still the resolver's and not the
        // seed's fail-closed placeholder, the resolver here must say ADMIN
        // TRUE — the one value the seed can never produce on its own.
        rows.set(USER_ID, {
            id: 1,
            user_id: USER_ID,
            token: TOKEN,
            token_sealed: null,
            token_lookup: null,
            created_at: new Date(),
            last_used_at: null,
            username: USERNAME,
            is_admin: false, // irrelevant: the seed no longer reads this column
            display_name: null,
            groups: [],
        } satisfies Row);
        mockGetUserByUsername.mockResolvedValueOnce({
            ...dbRow,
            is_admin: true,
            admin_pinned: true, // resolver: pinned admin
        });

        const auth = await validateCredentials(USERNAME, { password: TOKEN });

        expect(auth).not.toBeNull();
        expect(auth?.isAdmin).toBe(true);
    });
});
