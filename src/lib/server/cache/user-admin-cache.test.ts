// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for user-admin-cache
 *
 * Tests the L1 in-process cache for DB-sourced is_admin values.
 * Uses vi.useFakeTimers() to control TTL expiry without real waits.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
    getCachedIsAdmin,
    setCachedIsAdmin,
    getCachedGroups,
    setCachedGroups,
    getCachedDeleted,
    setCachedDeleted,
    invalidateUserAdminCache,
} from './user-admin-cache.js';

// ---------------------------------------------------------------------------
// Reset module cache between tests by re-importing with a fresh module state.
// Because the cache Map lives at module scope we use vi.resetModules() and
// dynamic imports in beforeEach to start each test with an empty Map.
// ---------------------------------------------------------------------------

describe('user-admin-cache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Clear by calling invalidate for any names used in prior tests —
        // simpler than resetting modules for these small-scope tests.
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ========================================================================
    // getCachedIsAdmin
    // ========================================================================

    describe('getCachedIsAdmin', () => {
        it('returns null for a username that was never cached', () => {
            const result = getCachedIsAdmin('never_cached_user');
            expect(result).toBeNull();
        });

        it('returns the cached value within the TTL', () => {
            setCachedIsAdmin('alice', true);

            expect(getCachedIsAdmin('alice')).toBe(true);
        });

        it('returns false when cached value is false', () => {
            setCachedIsAdmin('bob', false);

            expect(getCachedIsAdmin('bob')).toBe(false);
        });

        it('returns null after the 10-minute TTL has elapsed', () => {
            setCachedIsAdmin('carol', true);

            // Advance past the 10 min TTL
            vi.advanceTimersByTime(10 * 60_000 + 1);

            expect(getCachedIsAdmin('carol')).toBeNull();
        });

        it('returns the value just before TTL expires', () => {
            setCachedIsAdmin('dave', true);

            // One millisecond before expiry
            vi.advanceTimersByTime(10 * 60_000 - 1);

            expect(getCachedIsAdmin('dave')).toBe(true);
        });
    });

    // ========================================================================
    // setCachedIsAdmin
    // ========================================================================

    describe('setCachedIsAdmin', () => {
        it('overwrites an existing entry with a new value', () => {
            setCachedIsAdmin('eve', false);
            setCachedIsAdmin('eve', true);

            expect(getCachedIsAdmin('eve')).toBe(true);
        });

        it('refreshes the TTL when called again before expiry', () => {
            setCachedIsAdmin('frank', true);

            // Advance 9 min, then re-set (refreshes TTL to now + 10 min)
            vi.advanceTimersByTime(9 * 60_000);
            setCachedIsAdmin('frank', true);

            // Advance another 9 min — original entry would have expired by now,
            // but TTL was refreshed so the entry is still valid.
            vi.advanceTimersByTime(9 * 60_000);

            expect(getCachedIsAdmin('frank')).toBe(true);
        });
    });

    // ========================================================================
    // invalidateUserAdminCache
    // ========================================================================

    describe('invalidateUserAdminCache', () => {
        it('removes a cached entry so getCachedIsAdmin returns null', () => {
            setCachedIsAdmin('grace', true);
            invalidateUserAdminCache('grace');

            expect(getCachedIsAdmin('grace')).toBeNull();
        });

        it('is a no-op for a username that was never cached', () => {
            expect(() => invalidateUserAdminCache('heidi')).not.toThrow();
            expect(getCachedIsAdmin('heidi')).toBeNull();
        });

        it('only removes the specified user, leaving others intact', () => {
            setCachedIsAdmin('ivan', true);
            setCachedIsAdmin('judy', false);

            invalidateUserAdminCache('ivan');

            expect(getCachedIsAdmin('ivan')).toBeNull();
            expect(getCachedIsAdmin('judy')).toBe(false);
        });
    });

    // ========================================================================
    // getCachedGroups / setCachedGroups (added for resolveTokenUserAccess —
    // security review C4 fix-round-1: the token-derived UserContext resolver
    // has no live header to source group membership from, so this is the
    // only piece of resolveDbAuth's cached-row shape that didn't already
    // exist here.)
    // ========================================================================

    describe('getCachedGroups / setCachedGroups', () => {
        it('returns null for a username that was never cached', () => {
            expect(getCachedGroups('never_cached_groups_user')).toBeNull();
        });

        it('returns the cached groups within the TTL', () => {
            setCachedGroups('kyle', ['family', 'kids-cohort']);
            expect(getCachedGroups('kyle')).toEqual(['family', 'kids-cohort']);
        });

        it('returns an empty array when cached as empty (distinct from "never cached" null)', () => {
            setCachedGroups('laura', []);
            expect(getCachedGroups('laura')).toEqual([]);
        });

        it('returns null after the 10-minute TTL has elapsed', () => {
            setCachedGroups('mallory', ['family']);
            vi.advanceTimersByTime(10 * 60_000 + 1);
            expect(getCachedGroups('mallory')).toBeNull();
        });

        it('overwrites an existing entry and refreshes the TTL', () => {
            setCachedGroups('nathan', ['family']);
            vi.advanceTimersByTime(9 * 60_000);
            setCachedGroups('nathan', ['family', 'admin-group']);
            vi.advanceTimersByTime(9 * 60_000);
            expect(getCachedGroups('nathan')).toEqual(['family', 'admin-group']);
        });

        it('invalidateUserAdminCache clears groups alongside isAdmin/disabled/userId', () => {
            setCachedIsAdmin('olivia', true);
            setCachedGroups('olivia', ['admin-group']);

            invalidateUserAdminCache('olivia');

            expect(getCachedIsAdmin('olivia')).toBeNull();
            expect(getCachedGroups('olivia')).toBeNull();
        });

        it("only removes the specified user, leaving other users' cached groups intact", () => {
            setCachedGroups('peter', ['family']);
            setCachedGroups('quinn', ['admin-group']);

            invalidateUserAdminCache('peter');

            expect(getCachedGroups('peter')).toBeNull();
            expect(getCachedGroups('quinn')).toEqual(['admin-group']);
        });
    });

    // ========================================================================
    // getCachedDeleted / setCachedDeleted — `users.deleted_at`'s parallel
    // cache (security review 2026-09-16, task 6 follow-up). Same shape and
    // invalidation contract as getCachedDisabled/setCachedDisabled: a
    // soft-delete must take effect on the target's very next request, not
    // after the 10-min TTL, and it must be invalidated together with
    // isAdmin/disabled/userId/groups so no reader can ever observe a warm
    // isAdmin/disabled pair alongside a stale deleted flag.
    // ========================================================================

    describe('getCachedDeleted / setCachedDeleted', () => {
        it('returns null for a username that was never cached', () => {
            expect(getCachedDeleted('never_cached_deleted_user')).toBeNull();
        });

        it('returns the cached value within the TTL', () => {
            setCachedDeleted('rita', true);
            expect(getCachedDeleted('rita')).toBe(true);
        });

        it('returns false when cached value is false', () => {
            setCachedDeleted('sam', false);
            expect(getCachedDeleted('sam')).toBe(false);
        });

        it('returns null after the 10-minute TTL has elapsed', () => {
            setCachedDeleted('trudy', true);
            vi.advanceTimersByTime(10 * 60_000 + 1);
            expect(getCachedDeleted('trudy')).toBeNull();
        });

        it('invalidateUserAdminCache clears deleted alongside isAdmin/disabled/userId/groups', () => {
            setCachedIsAdmin('ursula', true);
            setCachedDeleted('ursula', true);

            invalidateUserAdminCache('ursula');

            expect(getCachedIsAdmin('ursula')).toBeNull();
            expect(getCachedDeleted('ursula')).toBeNull();
        });

        it("only removes the specified user, leaving other users' cached deleted flag intact", () => {
            setCachedDeleted('victor', true);
            setCachedDeleted('wendy', false);

            invalidateUserAdminCache('victor');

            expect(getCachedDeleted('victor')).toBeNull();
            expect(getCachedDeleted('wendy')).toBe(false);
        });
    });
});
