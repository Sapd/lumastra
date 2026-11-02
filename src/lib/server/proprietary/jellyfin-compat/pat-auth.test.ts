// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for validateJellyfinCompatPat.
 *
 * Security review C9/C10 (2026-09-15/16): this function now delegates the
 * groups/admin-pin/age-rating-pin/in-app-merge computation to the canonical
 * `resolveTokenUserAccess()` resolver instead of a bare
 * `buildUserPermissions(validated.groups)` call — so a /j PAT's permissions
 * come from a LIVE `users` row lookup (`mockGetUserByUsername` below), not
 * from `validated.groups` (the PAT payload) directly. Most pre-existing
 * tests below were updated to also configure `mockGetUserByUsername` so
 * their `userGroups`/`isAdmin` assertions still exercise the path their
 * names claim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateJellyfinCompatPat } from './pat-auth';

const mockValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service', () => ({
    getPatService: () => ({
        validate: mockValidate,
    }),
}));

// Deterministic buildUserPermissions stand-in (consumed internally by the
// REAL resolveTokenUserAccess()), independent of the repo's real
// config/settings.json.
vi.mock('$lib/server/auth.js', () => ({
    buildUserPermissions: (
        groups: string[],
        opts?: {
            isAdminOverride?: boolean;
            extraCapabilities?: { isAdmin?: boolean; maxAgeRating?: number | null };
        },
    ) => {
        const isAdmin =
            opts?.isAdminOverride ??
            (groups.includes('admin') || opts?.extraCapabilities?.isAdmin === true);
        const extraAge = opts?.extraCapabilities?.maxAgeRating ?? null;
        return {
            hasWatchPermission: groups.includes('Users') || isAdmin,
            hasLiveTvPermission: isAdmin,
            hasRequestPermission: true,
            isAdmin,
            maxAgeRating: isAdmin ? null : extraAge,
            isAgeRestricted: isAdmin ? false : extraAge !== null,
            isModerator: false,
            liveTvPriority: 'low' as const,
        };
    },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
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
    getCachedUserId: () => null,
    setCachedUserId: () => {},
    getCachedGroups: () => null,
    setCachedGroups: () => {},
}));

const { MAX_AGE_MISS } = vi.hoisted(() => ({ MAX_AGE_MISS: Symbol('max-age-miss') }));
vi.mock('$lib/server/cache/user-max-age-cache.js', () => ({
    MAX_AGE_MISS,
    getCachedMaxAge: () => MAX_AGE_MISS,
    setCachedMaxAge: () => {},
}));

vi.mock('$lib/server/database/connection.js', () => ({
    Database: class {
        getSql(): Record<string, never> {
            return {};
        }
    },
}));

const mockGetUserByUsername = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...args: unknown[]) => mockGetUserByUsername(...args),
}));

const mockResolveEffectiveAccess = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: (...args: unknown[]) => mockResolveEffectiveAccess(...args),
}));

function dbRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: '00000000-0000-0000-0000-000000000001',
        username: 'denis',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null as number | null,
        age_rating_pinned: false,
        groups: [] as string[],
        disabled_at: null as Date | null,
        deleted_at: null as Date | null,
        ...overrides,
    };
}

beforeEach(() => {
    mockValidate.mockReset();
    mockGetUserByUsername.mockReset();
    mockResolveEffectiveAccess.mockReset();
    mockResolveEffectiveAccess.mockImplementation(
        async (_sql: unknown, _userId: string, syncedGroups: string[]) => ({
            inAppGroupNames: [],
            effectiveGroups: syncedGroups,
            capabilities: {},
        }),
    );
    // Default row — most tests override username/groups to match their PAT
    // payload via mockGetUserByUsername.mockResolvedValue(dbRow({...})).
    mockGetUserByUsername.mockResolvedValue(dbRow());
});

describe('validateJellyfinCompatPat', () => {
    it('returns null when token is invalid (patService returns null)', async () => {
        mockValidate.mockResolvedValue(null);
        const result = await validateJellyfinCompatPat('bad-token', '1.2.3.4');
        expect(result).toBeNull();
    });

    it('returns null when scopes do not match exactly [jellyfin_compat]', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'u',
            name: 'test',
            scopes: ['admin'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        const result = await validateJellyfinCompatPat('admin-token', '1.2.3.4');
        expect(result).toBeNull();
    });

    it('returns null when scopes is [jellyfin_compat, write]', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'u',
            name: 'test',
            scopes: ['jellyfin_compat', 'write'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        const result = await validateJellyfinCompatPat('mixed-token', '1.2.3.4');
        expect(result).toBeNull();
    });

    it('returns null when scopes is [read]', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'u',
            name: 'test',
            scopes: ['read'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        const result = await validateJellyfinCompatPat('read-token', '1.2.3.4');
        expect(result).toBeNull();
    });

    it('returns auth shape with isAdmin: false for valid jellyfin_compat scope', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'denis',
            name: 'test',
            scopes: ['jellyfin_compat'],
            groups: ['Librarians'],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'denis', groups: ['Librarians'] }),
        );
        const result = await validateJellyfinCompatPat('valid', '1.2.3.4');
        expect(result).not.toBeNull();
        expect(result!.username).toBe('denis');
        expect(result!.ownerIsAdmin).toBe(false);
        expect(result!.userGroups).toEqual(['Librarians']);
        expect(result!.tokenId).toBe(1);
        expect(result!.isReadOnly).toBe(false);
    });

    it('returns auth shape with isReadOnly: true for valid jellyfin_compat_read scope', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'denis',
            name: 'rpc',
            scopes: ['jellyfin_compat_read'],
            groups: ['Librarians'],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'denis', groups: ['Librarians'] }),
        );
        const result = await validateJellyfinCompatPat('valid', '1.2.3.4');
        expect(result).not.toBeNull();
        expect(result!.username).toBe('denis');
        expect(result!.ownerIsAdmin).toBe(false);
        expect(result!.isReadOnly).toBe(true);
    });

    it('returns null for [jellyfin_compat_read, write] (mixed scope)', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'u',
            name: 't',
            scopes: ['jellyfin_compat_read', 'write'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        const result = await validateJellyfinCompatPat('mixed', '1.2.3.4');
        expect(result).toBeNull();
    });

    it('forces isAdmin: false even if user is in admin group', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'admin-user',
            name: 'test',
            scopes: ['jellyfin_compat'],
            groups: ['admin'],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'admin-user', groups: ['admin'] }),
        );
        const result = await validateJellyfinCompatPat('admin-via-jf-pat', '1.2.3.4');
        expect(result).not.toBeNull();
        expect(result!.ownerIsAdmin).toBe(false);
    });

    it('passes clientIp to patService.validate', async () => {
        mockValidate.mockResolvedValue(null);
        await validateJellyfinCompatPat('t', '203.0.113.99');
        expect(mockValidate).toHaveBeenCalledWith('t', '203.0.113.99');
    });

    it('sets groups as pipe-joined string matching forward-auth shape', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'denis',
            name: 'test',
            scopes: ['jellyfin_compat'],
            groups: ['Users', 'Librarians'],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        mockGetUserByUsername.mockResolvedValue(
            dbRow({ username: 'denis', groups: ['Users', 'Librarians'] }),
        );
        const result = await validateJellyfinCompatPat('valid', '10.0.0.1');
        expect(result).not.toBeNull();
        expect(result!.groups).toBe('Users|Librarians');
        expect(result!.userGroups).toEqual(['Users', 'Librarians']);
    });

    // ── C9/C10 (security review 2026-09-15/16): the age-rating pin ─────────

    it('applies the admin per-user age-rating pin (age_rating_pinned, no age group) — isAgeRestricted:true, maxAgeRating:6', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'kid-account',
            name: 'test',
            scopes: ['jellyfin_compat'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        mockGetUserByUsername.mockResolvedValue(
            dbRow({
                username: 'kid-account',
                groups: [],
                age_rating_pinned: true,
                max_age_rating: 6,
            }),
        );
        const result = await validateJellyfinCompatPat('kid-pat', '1.2.3.4');
        expect(result).not.toBeNull();
        expect(result!.isAgeRestricted).toBe(true);
        expect(result!.maxAgeRating).toBe(6);
    });

    it('denies (returns null) when the token user access is unresolvable — fails closed, never falls back to unrestricted', async () => {
        mockValidate.mockResolvedValue({
            id: 1,
            username: 'ghost',
            name: 'test',
            scopes: ['jellyfin_compat'],
            groups: [],
            jellyfinUserId: null,
            tokenPrefix: 'abc1234',
        });
        mockGetUserByUsername.mockResolvedValue(null);
        const result = await validateJellyfinCompatPat('ghost-pat', '1.2.3.4');
        expect(result).toBeNull();
    });
});

describe('compat PAT admin-owner age capability', () => {
    it.each(['jellyfin_compat', 'jellyfin_compat_read'])(
        'restores the admin owner age pin for scoped %s',
        async (scope) => {
            mockValidate.mockResolvedValue({
                id: 1,
                userId: '00000000-0000-0000-0000-000000000001',
                username: 'denis',
                tokenPrefix: 'pat_compat',
                scopes: [scope],
            });
            mockGetUserByUsername.mockResolvedValue(
                dbRow({
                    groups: ['admin'],
                    age_rating_pinned: true,
                    max_age_rating: 8,
                }),
            );
            const user = await validateJellyfinCompatPat('pat_compat', '127.0.0.1');
            expect(user?.ownerIsAdmin).toBe(false);
            expect(user?.isReadOnly).toBe(scope === 'jellyfin_compat_read');
            expect(user?.maxAgeRating).toBe(8);
            expect(user?.isAgeRestricted).toBe(true);
        },
    );
});
