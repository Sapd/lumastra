// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for buildPlayTokenUserContext (security review C4).
 *
 * Before the fix this always returned a hardcoded `userGroups:[]`,
 * `isAdmin:false`, `maxAgeRating:null`, `isAgeRestricted:false` context,
 * regardless of the account's real DB state — so media-access.ts's age gate
 * (`if (!user.isAgeRestricted) return true;`) could never fire for a /j
 * play-token stream, and a user whose age cap was lowered (or library group
 * revoked) mid-session kept streaming for as long as the renewable token
 * stayed valid. `resolveTokenUserAccess` (its own dedicated coverage in
 * resolve-token-user-access.test.ts) is mocked here — this file only pins
 * `buildPlayTokenUserContext`'s own wrapper behaviour: field mapping,
 * disabled/unresolvable -> null, and the `hasLiveTvPermission` opts override.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserPermissions } from '$lib/server/auth.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));

const { mockAllowsLiveTv } = vi.hoisted(() => ({
    mockAllowsLiveTv: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: mockAllowsLiveTv }));
const mockResolveUserIdByUsername = vi.fn();
vi.mock('$lib/server/auth/resolve-user-id', () => ({
    resolveUserIdByUsername: (...args: unknown[]) => mockResolveUserIdByUsername(...args),
}));

const mockResolveTokenUserAccess = vi.fn();
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: (...args: unknown[]) => mockResolveTokenUserAccess(...args),
}));

const { buildPlayTokenUserContext, playTokenMintedByAdmin } = await import('./play-token-user.js');

function permissions(overrides: Partial<UserPermissions> = {}): UserPermissions {
    return {
        hasWatchPermission: false,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        hasReviewPermission: false,
        hasMediaAnnotationPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveUserIdByUsername.mockResolvedValue('usr_00000000-0000-0000-0000-000000000001');
    mockResolveTokenUserAccess.mockResolvedValue({
        userGroups: [],
        disabled: false,
        permissions: permissions(),
    });
});

describe('buildPlayTokenUserContext', () => {
    it('cannot force Live TV back on with a play-token override after the admin disables it', async () => {
        mockAllowsLiveTv.mockResolvedValueOnce(false);
        const user = await buildPlayTokenUserContext('carol', {
            hasLiveTvPermission: true,
            mintedByAdmin: true,
        });
        expect(user?.hasLiveTvPermission).toBe(false);
    });

    it('returns null when the username has no resolvable users.id', async () => {
        mockResolveUserIdByUsername.mockResolvedValue(null);
        expect(await buildPlayTokenUserContext('ghost')).toBeNull();
    });

    it('returns null when the account is disabled, even with a resolvable users.id', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: [],
            disabled: true,
            permissions: permissions(),
        });
        expect(await buildPlayTokenUserContext('carol')).toBeNull();
    });

    it("returns null when resolveTokenUserAccess can't resolve the account (DB down)", async () => {
        mockResolveTokenUserAccess.mockResolvedValue(null);
        expect(await buildPlayTokenUserContext('carol')).toBeNull();
    });

    // task-3-brief.md TDD: "context for a user in an allowed group + age cap
    // reflects both".
    it('a user in an allowed group with an age cap reflects BOTH in the context', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: ['family'],
            disabled: false,
            permissions: permissions({
                hasWatchPermission: true,
                maxAgeRating: 13,
                isAgeRestricted: true,
            }),
        });

        const user = await buildPlayTokenUserContext('kid-account');

        expect(user).not.toBeNull();
        expect(user?.userGroups).toEqual(['family']);
        expect(user?.groups).toBe('family');
        expect(user?.maxAgeRating).toBe(13);
        expect(user?.isAgeRestricted).toBe(true);
    });

    it('hasWatchPermission stays forced true and hasRequestPermission forced false regardless of DB permissions', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: [],
            disabled: false,
            permissions: permissions({ hasWatchPermission: false, hasRequestPermission: true }),
        });

        const user = await buildPlayTokenUserContext('alice');

        expect(user?.hasWatchPermission).toBe(true);
        expect(user?.hasRequestPermission).toBe(false);
    });

    it('hasLiveTvPermission falls back to the real DB-derived value when no opts override is given', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: ['livetv-viewers'],
            disabled: false,
            permissions: permissions({ hasLiveTvPermission: true }),
        });

        const user = await buildPlayTokenUserContext('bob');

        expect(user?.hasLiveTvPermission).toBe(true);
    });

    it('an explicit opts.hasLiveTvPermission override wins over the DB-derived value (Live TV play-token routes force true + separately re-check revocation)', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: [],
            disabled: false,
            permissions: permissions({ hasLiveTvPermission: false }),
        });

        const user = await buildPlayTokenUserContext('bob', { hasLiveTvPermission: true });

        expect(user?.hasLiveTvPermission).toBe(true);
    });

    it('isAdmin/isModerator/liveTvPriority are the real DB-derived values', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: ['admin-group'],
            disabled: false,
            permissions: permissions({
                ownerIsAdmin: true,
                isModerator: true,
                liveTvPriority: 'high',
                maxAgeRating: null,
                isAgeRestricted: false,
            }),
        });

        const user = await buildPlayTokenUserContext('admin-user');

        expect(user?.ownerIsAdmin).toBe(true);
        expect(user?.isModerator).toBe(true);
        expect(user?.liveTvPriority).toBe('high');
    });
});

describe('play token admin-owner access capability', () => {
    it('does not inherit the owner library bypass and restores the underlying age limit', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            userGroups: ['admin-group'],
            disabled: false,
            deleted: false,
            nonAdminMaxAgeRating: 8,
            permissions: permissions({ ownerIsAdmin: true }),
        });
        const user = await buildPlayTokenUserContext('admin-user');
        expect(user?.mediaAccessIsAdmin).toBe(false);
        expect(toLibraryAccessUser(user ?? undefined)?.isAdmin).toBe(false);
        expect(user?.maxAgeRating).toBe(8);
        expect(user?.isAgeRestricted).toBe(true);
    });
});

describe('play token minted by an admin request', () => {
    const adminOwner = {
        userGroups: ['admin-group'],
        disabled: false,
        deleted: false,
        nonAdminMaxAgeRating: 8,
        permissions: permissions({ ownerIsAdmin: true }),
    };

    it('honours the mint-time admin capability while the owner is still an admin', async () => {
        mockResolveTokenUserAccess.mockResolvedValue(adminOwner);
        const user = await buildPlayTokenUserContext('admin-user', { mintedByAdmin: true });
        expect(user?.mediaAccessIsAdmin).toBe(true);
        expect(toLibraryAccessUser(user ?? undefined)?.isAdmin).toBe(true);
        expect(user?.maxAgeRating).toBeNull();
        expect(user?.isAgeRestricted).toBe(false);
    });

    it('drops the grant once the owner is no longer an admin', async () => {
        mockResolveTokenUserAccess.mockResolvedValue({
            ...adminOwner,
            permissions: permissions({ ownerIsAdmin: false, maxAgeRating: 8 }),
        });
        const user = await buildPlayTokenUserContext('demoted-user', { mintedByAdmin: true });
        expect(user?.mediaAccessIsAdmin).toBe(false);
        expect(toLibraryAccessUser(user ?? undefined)?.isAdmin).toBe(false);
        expect(user?.maxAgeRating).toBe(8);
    });

    it('a token issued through a non-admin credential of an admin owner stays non-admin', async () => {
        mockResolveTokenUserAccess.mockResolvedValue(adminOwner);
        const user = await buildPlayTokenUserContext('admin-user', { mintedByAdmin: false });
        expect(toLibraryAccessUser(user ?? undefined)?.isAdmin).toBe(false);
        expect(user?.maxAgeRating).toBe(8);
    });
});

describe('playTokenMintedByAdmin', () => {
    it('a /j password session of an admin mints an admin token', () => {
        expect(
            playTokenMintedByAdmin({
                ownerIsAdmin: true,
                mediaAccessIsAdmin: true,
                userGroups: [],
            } as never),
        ).toBe(true);
    });
    it('fails closed when the capability is not set explicitly', () => {
        expect(playTokenMintedByAdmin({ ownerIsAdmin: true, userGroups: [] } as never)).toBe(false);
    });
    it('a /j compat PAT (forced isAdmin:false) mints a non-admin token', () => {
        expect(playTokenMintedByAdmin({ ownerIsAdmin: false, userGroups: [] } as never)).toBe(
            false,
        );
    });
    it('an admin owner whose credential carries no admin capability mints a non-admin token', () => {
        expect(
            playTokenMintedByAdmin({
                ownerIsAdmin: true,
                mediaAccessIsAdmin: false,
                userGroups: [],
            } as never),
        ).toBe(false);
    });
    it('no user mints a non-admin token', () => {
        expect(playTokenMintedByAdmin(undefined)).toBe(false);
    });
});
