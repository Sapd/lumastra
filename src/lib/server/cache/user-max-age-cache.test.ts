// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for user-max-age-cache.
 *
 * FIX ROUND 1 (Important 2, security review 2026-09-16): before this fix,
 * invalidateUserMaxAgeCache() only cleared the LOCAL replica's Map — no
 * dedicated test existed at all for this module, so the missing
 * cross-replica publish went unnoticed even though the sibling
 * user-admin-cache.ts (and its own coverage) already established the
 * pattern. `auth-cache-bus.js` is mocked here (not the real Valkey-backed
 * module) so these assertions are genuinely unit-level and deterministic.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const mockPublish = vi.fn();
let remoteHandler: ((username: string) => void) | undefined;
vi.mock('./auth-cache-bus.js', () => ({
    isAuthCacheBusDown: () => false,
    publishAuthCacheInvalidation: (...args: unknown[]) => mockPublish(...args),
    onRemoteUserMaxAgeInvalidate: (fn: (username: string) => void) => {
        remoteHandler = fn;
    },
    onAuthCacheBusResync: () => {},
}));

const { getCachedMaxAge, setCachedMaxAge, invalidateUserMaxAgeCache, MAX_AGE_MISS } =
    await import('./user-max-age-cache.js');

describe('user-max-age-cache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mockPublish.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('getCachedMaxAge / setCachedMaxAge', () => {
        it('returns MAX_AGE_MISS for a username that was never cached', () => {
            expect(getCachedMaxAge('never_cached_user')).toBe(MAX_AGE_MISS);
        });

        it('returns the cached value within the TTL, including a legitimate null', () => {
            setCachedMaxAge('alice', 13);
            expect(getCachedMaxAge('alice')).toBe(13);

            setCachedMaxAge('bob', null);
            // A cached null (unrestricted) must be distinguishable from a
            // miss — both are falsy-ish but only one means "ask the DB again".
            expect(getCachedMaxAge('bob')).toBeNull();
            expect(getCachedMaxAge('bob')).not.toBe(MAX_AGE_MISS);
        });

        it('returns MAX_AGE_MISS after the 10-minute TTL has elapsed', () => {
            setCachedMaxAge('carol', 6);
            vi.advanceTimersByTime(10 * 60_000 + 1);
            expect(getCachedMaxAge('carol')).toBe(MAX_AGE_MISS);
        });
    });

    describe('invalidateUserMaxAgeCache', () => {
        it('removes the local entry so getCachedMaxAge misses', () => {
            setCachedMaxAge('dave', 13);
            invalidateUserMaxAgeCache('dave');
            expect(getCachedMaxAge('dave')).toBe(MAX_AGE_MISS);
        });

        // FIX ROUND 1 (Important 2): the actual regression this task's
        // review round caught. Before the fix, this assertion fails because
        // invalidateUserMaxAgeCache() never called publishAuthCacheInvalidation
        // at all — a sibling replica had no way to learn its cached
        // max_age_rating just went stale.
        it('publishes a cross-replica invalidation event so sibling replicas drop their stale entry too', () => {
            invalidateUserMaxAgeCache('eve');
            expect(mockPublish).toHaveBeenCalledWith({ kind: 'user-max-age', username: 'eve' });
        });

        it('a remote invalidation event (from a sibling replica) clears the local entry', () => {
            setCachedMaxAge('frank', 6);
            expect(getCachedMaxAge('frank')).toBe(6);

            // Simulate the auth-cache-bus delivering a message published by
            // ANOTHER replica's invalidateUserMaxAgeCache('frank') call.
            remoteHandler?.('frank');

            expect(getCachedMaxAge('frank')).toBe(MAX_AGE_MISS);
        });

        it('only removes the specified user, leaving others intact', () => {
            setCachedMaxAge('grace', 13);
            setCachedMaxAge('heidi', null);

            invalidateUserMaxAgeCache('grace');

            expect(getCachedMaxAge('grace')).toBe(MAX_AGE_MISS);
            expect(getCachedMaxAge('heidi')).toBeNull();
        });
    });
});
