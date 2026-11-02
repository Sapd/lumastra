// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for resolveTokenUserAccess — the shared DB-derived permission
 * resolver used by handleStreamToken and buildPlayTokenUserContext (security
 * review C4, fix-round-1 follow-up: L1 caching). Uses the REAL
 * `buildUserPermissions` (unmocked, matching auth.test.ts's convention) so
 * the pin/merge/MIN-age semantics under test are genuine, not a test
 * double's approximation of them. The DB row lookup, the in-app access
 * layer, and the L1 admin/max-age cache are mocked.
 *
 * The cache mock below is a real (per-username, no TTL — tests run well
 * under the 10-minute production TTL so expiry isn't exercised here) map,
 * not a stub, so the "warm cache skips the DB" / "invalidate makes the next
 * read fresh" / "DB error with a warm cache still resolves" behaviour is
 * genuinely exercised rather than asserted against a fake.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── L1 cache mock (real per-username maps, cleared in beforeEach) ───────────
const MAX_AGE_MISS_SENTINEL = Symbol('max-age-miss');
const adminCache = new Map<string, boolean>();
// Fix round 1, Important 4: resolveRow() also reads/writes admin_pinned.
const adminPinnedCache = new Map<string, boolean>();
const maxAgeCache = new Map<string, number | null>();
const disabledCache = new Map<string, boolean>();
const deletedCache = new Map<string, boolean>();
const userIdCache = new Map<string, string>();
const groupsCache = new Map<string, string[]>();

function clearAllCaches(): void {
    adminCache.clear();
    adminPinnedCache.clear();
    maxAgeCache.clear();
    disabledCache.clear();
    deletedCache.clear();
    userIdCache.clear();
    groupsCache.clear();
}

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

// Deterministic group-name config: the repo's local config/settings.json can
// override ADMIN_GROUPS (e.g. to a real deployment's IdP group name), which
// would make a hardcoded 'admin' group name in a test pass or fail depending
// on the checkout — pin the values these tests exercise instead of reading
// the real (environment-dependent) config.
vi.mock('$lib/server/config.js', () => ({
    config: {
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
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

const mockGetUserByUsername = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
}));

vi.mock('$lib/server/database/connection.js', () => {
    class MockDatabase {
        getSql(): unknown {
            return {};
        }
    }
    return { Database: MockDatabase };
});

const mockResolveEffectiveAccess = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) => mockResolveEffectiveAccess(...args),
}));

const { resolveTokenUserAccess, computeOwnerMaxAge } =
    await import('./resolve-token-user-access.js');
const { invalidateUserAdminCache } = await import('$lib/server/cache/user-admin-cache.js');

function dbRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: '00000000-0000-0000-0000-000000000001',
        username: 'alice',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        groups: [] as string[],
        disabled_at: null,
        deleted_at: null,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    clearAllCaches();
    // Default: in-app layer is a no-op passthrough.
    mockResolveEffectiveAccess.mockImplementation(
        async (_sql: unknown, _userId: string, syncedGroups: string[]) => ({
            inAppGroupNames: [],
            effectiveGroups: syncedGroups,
            capabilities: {},
        }),
    );
});

describe('resolveTokenUserAccess', () => {
    it('returns null when the username has no users row', async () => {
        mockGetUserByUsername.mockResolvedValue(null);
        expect(await resolveTokenUserAccess('ghost')).toBeNull();
    });

    it('keeps unrelated row errors fail-closed without labelling them a dependency outage', async () => {
        mockGetUserByUsername.mockRejectedValueOnce(new TypeError('malformed row'));
        expect(await resolveTokenUserAccess('alice')).toBeNull();
    });

    it('keeps the conservative in-app fallback for unrelated errors', async () => {
        mockGetUserByUsername.mockResolvedValueOnce(dbRow());
        mockResolveEffectiveAccess.mockRejectedValueOnce(new TypeError('malformed group'));
        const access = await resolveTokenUserAccess('alice');
        expect(access?.permissions.maxAgeRating).toBe(0);
    });

    it('distinguishes an unavailable DB from a missing user', async () => {
        mockGetUserByUsername.mockRejectedValue(
            Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );
        await expect(resolveTokenUserAccess('alice')).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
    });

    it('surfaces disabled_at as disabled:true so callers can deny', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ disabled_at: new Date() }));
        const result = await resolveTokenUserAccess('alice');
        expect(result?.disabled).toBe(true);
    });

    // Security review 2026-09-16, task 6 follow-up: `deleted_at` is
    // `disabled_at`'s sibling lifecycle column. Before this fix
    // resolveTokenUserAccess only read `disabled_at` — a soft-deleted row
    // resolved to `disabled: false` with no way for a caller to tell.
    it('surfaces deleted_at as deleted:true so callers can deny', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ deleted_at: new Date() }));
        const result = await resolveTokenUserAccess('alice');
        expect(result?.deleted).toBe(true);
    });

    it('an active, non-deleted user gets deleted:false', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow());
        const result = await resolveTokenUserAccess('alice');
        expect(result?.deleted).toBe(false);
    });

    it('an unrestricted, ungrouped user gets unrestricted real permissions', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow());
        const result = await resolveTokenUserAccess('alice');
        expect(result).toMatchObject({
            userGroups: [],
            disabled: false,
            permissions: { ownerIsAdmin: false, maxAgeRating: null, isAgeRestricted: false },
        });
    });

    // C4: a pinned age ceiling must come through as the real, non-null
    // maxAgeRating/isAgeRestricted — this is exactly the field the old
    // hardcoded stream-token/play-token contexts always set to
    // null/false regardless of the account.
    it('a pinned age_rating_pinned=true, max_age_rating=13 user yields isAgeRestricted:true, maxAgeRating:13', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ age_rating_pinned: true, max_age_rating: 13 }),
        );
        const result = await resolveTokenUserAccess('kid-account');
        expect(result?.permissions.isAgeRestricted).toBe(true);
        expect(result?.permissions.maxAgeRating).toBe(13);
    });

    it('an admin_pinned=true, is_admin=true user is unrestricted (isAdmin short-circuits age)', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({
                admin_pinned: true,
                is_admin: true,
                // Even a pinned age cap must not survive the admin short-circuit.
                age_rating_pinned: true,
                max_age_rating: 5,
            }),
        );
        const result = await resolveTokenUserAccess('admin-user');
        expect(result?.permissions.ownerIsAdmin).toBe(true);
        expect(result?.permissions.maxAgeRating).toBeNull();
        expect(result?.permissions.isAgeRestricted).toBe(false);
    });

    // "context for a user in an allowed group + age cap reflects both"
    // (task-3-brief.md TDD list) — the in-app access layer can ADD a group
    // membership AND tighten the age ceiling; both must show up together in
    // the resolved permissions, not just one or the other.
    it('an in-app allowed group + a tighter in-app age cap both show up in the result', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ age_rating_pinned: true, max_age_rating: 13, groups: ['family'] }),
        );
        mockResolveEffectiveAccess.mockResolvedValue({
            inAppGroupNames: ['kids-cohort'],
            effectiveGroups: ['family', 'kids-cohort'],
            // In-app cap is MORE restrictive (10) than the DB pin (13) — the
            // MIN merge must pick the tighter value, never the looser one.
            capabilities: { maxAgeRating: 10 },
        });

        const result = await resolveTokenUserAccess('kid-account');

        expect(result?.userGroups).toEqual(['family', 'kids-cohort']);
        expect(result?.permissions.isAgeRestricted).toBe(true);
        expect(result?.permissions.maxAgeRating).toBe(10);
    });

    it('a group-name-derived admin (config.ADMIN_GROUPS match, unpinned) is real admin', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ groups: ['admin-group'] }));
        const result = await resolveTokenUserAccess('group-admin');
        expect(result?.permissions.ownerIsAdmin).toBe(true);
    });

    it('an admin_pinned=true, is_admin=false user is demoted even with an admin-name group', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ admin_pinned: true, is_admin: false, groups: ['admin'] }),
        );
        const result = await resolveTokenUserAccess('demoted-admin');
        expect(result?.permissions.ownerIsAdmin).toBe(false);
    });

    it('passes the DB userId (not the username) to resolveEffectiveAccess', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ id: 'row-uuid-123', groups: ['family'] }));
        await resolveTokenUserAccess('alice');
        expect(mockResolveEffectiveAccess).toHaveBeenCalledWith(expect.anything(), 'row-uuid-123', [
            'family',
        ]);
    });
});

// ── L1 cache behaviour (security review C4 fix-round-1) ─────────────────────

describe('resolveTokenUserAccess — L1 cache', () => {
    it('a warm cache performs zero getUserByUsername calls', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ age_rating_pinned: true, max_age_rating: 13, groups: ['family'] }),
        );
        // First call: cold cache, hits the DB once and warms the cache.
        await resolveTokenUserAccess('kid-account');
        expect(mockGetUserByUsername).toHaveBeenCalledTimes(1);

        mockGetUserByUsername.mockClear();

        // Second call: cache is now warm — must not touch the DB at all.
        const result = await resolveTokenUserAccess('kid-account');
        expect(mockGetUserByUsername).not.toHaveBeenCalled();
        expect(result?.permissions.isAgeRestricted).toBe(true);
        expect(result?.permissions.maxAgeRating).toBe(13);
    });

    it('invalidateUserAdminCache makes the next read fresh again (a disable takes effect immediately)', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ disabled_at: null }));
        await resolveTokenUserAccess('carol');
        expect(mockGetUserByUsername).toHaveBeenCalledTimes(1);

        // Simulate an admin disabling the account mid-session: the DB row
        // changes AND the cache is invalidated (as admin-user.service.ts does).
        mockGetUserByUsername.mockResolvedValue(dbRow({ disabled_at: new Date() }));
        invalidateUserAdminCache('carol');

        const result = await resolveTokenUserAccess('carol');
        expect(mockGetUserByUsername).toHaveBeenCalledTimes(2);
        expect(result?.disabled).toBe(true);
    });

    it('invalidateUserAdminCache makes a soft-delete take effect immediately (deleted mirrors disabled)', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ deleted_at: null }));
        await resolveTokenUserAccess('dana');
        expect(mockGetUserByUsername).toHaveBeenCalledTimes(1);

        mockGetUserByUsername.mockResolvedValue(dbRow({ deleted_at: new Date() }));
        invalidateUserAdminCache('dana');

        const result = await resolveTokenUserAccess('dana');
        expect(mockGetUserByUsername).toHaveBeenCalledTimes(2);
        expect(result?.deleted).toBe(true);
    });

    it('a DB error with a warm cache still resolves (the DB is never touched)', async () => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ age_rating_pinned: true, max_age_rating: 13, groups: ['family'] }),
        );
        await resolveTokenUserAccess('kid-account'); // warms the cache
        mockGetUserByUsername.mockClear();

        // A subsequent DB outage must not matter — the warm cache path never
        // calls getUserByUsername, so this rejection is never reached.
        mockGetUserByUsername.mockRejectedValue(
            Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );

        const result = await resolveTokenUserAccess('kid-account');
        expect(mockGetUserByUsername).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result?.permissions.maxAgeRating).toBe(13);
    });

    it('a cold cache with a DB error fails closed (no cached value to fall back to)', async () => {
        mockGetUserByUsername.mockRejectedValue(
            Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
        );
        await expect(resolveTokenUserAccess('never-cached-user')).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
    });

    it('treats an in-app access lookup failure as temporary unavailability', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ groups: ['family'] }));
        mockResolveEffectiveAccess.mockRejectedValue(
            Object.assign(new Error('access-control DB down'), { code: 'ECONNREFUSED' }),
        );
        await expect(resolveTokenUserAccess('alice')).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
    });
});

// ── computeOwnerMaxAge — the shared pure formula, and its agreement with
// resolveTokenUserAccess (C10, security review 2026-09-15/16) ──────────────
//
// computeOwnerMaxAge() is exported so a caller that already holds a `users`
// row (forward-auth.ts's service-token impersonation branch, which fetches
// by id and deliberately never reads through this module's cache) can apply
// the SAME pin-aware age-ceiling formula without a second, cached,
// username-keyed round trip through resolveTokenUserAccess(). This describe
// block is the divergence guard: if computeOwnerMaxAge() and
// resolveTokenUserAccess() ever disagree for the same inputs, one of them
// stopped being a thin wrapper around the other — mirroring
// resolve-owner-admin-status.test.ts's computeOwnerIsAdmin() guard for the
// admin axis.
describe('computeOwnerMaxAge — the shared pure formula, and its agreement with resolveTokenUserAccess', () => {
    it.each([
        { groups: [] as string[], dbMaxAge: 6, ageRatingPinned: true, expected: 6 },
        { groups: ['family'], dbMaxAge: null, ageRatingPinned: true, expected: null },
        { groups: [], dbMaxAge: 13, ageRatingPinned: false, expected: null },
    ])(
        'agrees with resolveTokenUserAccess for groups=$groups dbMaxAge=$dbMaxAge age_rating_pinned=$ageRatingPinned',
        async ({ groups, dbMaxAge, ageRatingPinned, expected }) => {
            expect(computeOwnerMaxAge(groups, dbMaxAge, ageRatingPinned)).toBe(expected);

            mockGetUserByUsername.mockResolvedValue(
                dbRow({ groups, max_age_rating: dbMaxAge, age_rating_pinned: ageRatingPinned }),
            );
            const viaResolve = await resolveTokenUserAccess('someone');
            // resolveTokenUserAccess merges this value with the in-app layer's
            // (no-op here) via mergeMaxAge — for a no-op in-app layer and a
            // non-admin user, that merge is the identity, so the two must
            // agree exactly.
            expect(viaResolve?.permissions.maxAgeRating).toBe(expected);
        },
    );
});

describe('underlying age cap for scoped credentials', () => {
    it('preserves an unpinned admin owner age group on cold and warm cache reads', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ groups: ['admin-group', 'age-8'] }));

        const cold = await resolveTokenUserAccess('group-admin');
        expect(cold?.permissions.ownerIsAdmin).toBe(true);
        expect(cold?.permissions.maxAgeRating).toBeNull();
        expect(cold?.nonAdminMaxAgeRating).toBe(8);

        mockGetUserByUsername.mockClear();
        const warm = await resolveTokenUserAccess('group-admin');
        expect(mockGetUserByUsername).not.toHaveBeenCalled();
        expect(warm?.permissions.ownerIsAdmin).toBe(true);
        expect(warm?.permissions.maxAgeRating).toBeNull();
        expect(warm?.nonAdminMaxAgeRating).toBe(8);
    });

    it('denies temporarily when a scoped admin owner access lookup fails', async () => {
        mockGetUserByUsername.mockResolvedValue(dbRow({ admin_pinned: true, is_admin: true }));
        mockResolveEffectiveAccess.mockRejectedValue(
            Object.assign(new Error('access-control DB down'), { code: 'ECONNREFUSED' }),
        );
        await expect(resolveTokenUserAccess('admin-subject')).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
    });

    it.each([0, null])('preserves an explicit scoped age ceiling of %s', async (maxAge) => {
        mockGetUserByUsername.mockResolvedValue(
            dbRow({
                admin_pinned: true,
                is_admin: true,
                age_rating_pinned: true,
                max_age_rating: maxAge,
            }),
        );

        const result = await resolveTokenUserAccess('admin-subject');
        expect(result?.permissions.ownerIsAdmin).toBe(true);
        expect(result?.permissions.maxAgeRating).toBeNull();
        expect(result?.nonAdminMaxAgeRating).toBe(maxAge);
    });

    it.each([
        [5, 10],
        [12, 10],
        [12, 6],
    ])(
        'preserves the minimum pin/group/cohort limit for an admin owner (pin=%s, cohort=%s)',
        async (pin, cohort) => {
            mockGetUserByUsername.mockResolvedValue(
                dbRow({
                    groups: ['admin-group', 'age-8'],
                    age_rating_pinned: true,
                    max_age_rating: pin,
                }),
            );
            mockResolveEffectiveAccess.mockResolvedValue({
                inAppGroupNames: [],
                effectiveGroups: ['admin-group', 'age-8'],
                capabilities: { maxAgeRating: cohort },
            });
            const result = await resolveTokenUserAccess('admin-subject');
            expect(result?.permissions.ownerIsAdmin).toBe(true);
            expect(result?.permissions.maxAgeRating).toBeNull();
            expect(result?.nonAdminMaxAgeRating).toBe(Math.min(pin, 8, cohort));
        },
    );
});
