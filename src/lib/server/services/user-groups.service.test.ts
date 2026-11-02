// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Writer-seam test for `syncUserGroups` (security review 5, C4 + Shape C,
 * 2026-09-23). Uses the REAL `user-admin-cache.ts` / `user-max-age-cache.ts`
 * modules (not stubs) so a passing test actually proves the write
 * invalidates the caches every reader trusts — a mock that always returns
 * whatever the assertion wants would not close this finding (global
 * constraint 2: test at the seam). Only the Valkey publish underneath
 * `auth-cache-bus.ts` is mocked, since no Valkey instance is available here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/cache/valkey.js', () => ({
    isValkeyReady: vi.fn(() => false),
    getValkeyClient: vi.fn(() => null),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
    cacheGet: vi.fn(async () => null),
    setEx: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
    connectValkey: vi.fn(async () => true),
    getKeysByPattern: vi.fn(async () => []),
}));

const mockUpsertUserGroups = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('$lib/server/database/queries/oauth-admin.queries.js', () => ({
    upsertUserGroups: (...args: unknown[]) => mockUpsertUserGroups(...args),
}));

import { syncUserGroups, invalidateGroupDerivedCaches } from './user-groups.service.js';
import {
    setCachedGroups,
    getCachedGroups,
    setCachedIsAdmin,
    getCachedIsAdmin,
} from '$lib/server/cache/user-admin-cache.js';
import {
    setCachedMaxAge,
    getCachedMaxAge,
    MAX_AGE_MISS,
} from '$lib/server/cache/user-max-age-cache.js';

describe('syncUserGroups', () => {
    beforeEach(() => {
        mockUpsertUserGroups.mockClear();
    });

    it('writes the row via upsertUserGroups then invalidates the admin cache for the CASE-FOLDED username', async () => {
        setCachedGroups('u', ['a']);
        expect(getCachedGroups('u')).toEqual(['a']);

        await syncUserGroups({} as never, 'U', ['b']);

        expect(mockUpsertUserGroups).toHaveBeenCalledWith({}, 'U', ['b']);
        // Seeded under the LOWERCASE key ('u'); the call passed 'U' — this
        // only passes if syncUserGroups folds the case before invalidating.
        expect(getCachedGroups('u')).toBeNull();
    });

    it('also invalidates the max-age cache — age is group-derived for an unpinned owner', async () => {
        setCachedMaxAge('u2', 12);
        expect(getCachedMaxAge('u2')).toBe(12);

        await syncUserGroups({} as never, 'U2', ['x']);

        expect(getCachedMaxAge('u2')).toBe(MAX_AGE_MISS);
    });

    it('invalidateGroupDerivedCaches (the exported half for a transactional caller) folds case and clears both caches', () => {
        setCachedIsAdmin('u3', true);
        setCachedMaxAge('u3', 5);

        invalidateGroupDerivedCaches('U3');

        expect(getCachedIsAdmin('u3')).toBeNull();
        expect(getCachedMaxAge('u3')).toBe(MAX_AGE_MISS);
    });
});
