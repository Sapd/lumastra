// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deferred security item 10: `checkRateLimit` guards Valkey access with
 * `client && isCoordinationValkeyReady()`, but `peekRateLimit`, `resetRateLimit`, and
 * `getRateLimitStats` guarded on `isCoordinationValkeyReady()` alone. If a client can
 * ever be null/undefined while `isCoordinationValkeyReady()` still reports true (a
 * torn-down or reconnecting client), the three looser call sites would call
 * into a Valkey helper with no live client instead of degrading to the
 * in-memory fallback like `checkRateLimit` does.
 *
 * This test mocks `$lib/server/cache/valkey` to force exactly that divergent
 * state — `isCoordinationValkeyReady()` true, `getCoordinationClient()` null — and asserts all
 * four functions behave the same way: none of them reach into a Valkey
 * helper (`cacheGet`/`del`/`getKeysByPattern`), and they degrade to the
 * memory-backed result instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetValkeyClient = vi.fn();
const mockIsValkeyReady = vi.fn();
const mockCacheGet = vi.fn();
const mockDel = vi.fn();
const mockGetKeysByPattern = vi.fn();

vi.mock('$lib/server/cache/valkey', () => ({
    getCoordinationClient: (...args: unknown[]) => mockGetValkeyClient(...args),
    connectValkey: vi.fn(),
    isCoordinationValkeyReady: (...args: unknown[]) => mockIsValkeyReady(...args),
    getKeysByPattern: (...args: unknown[]) => mockGetKeysByPattern(...args),
    cacheGet: (...args: unknown[]) => mockCacheGet(...args),
    del: (...args: unknown[]) => mockDel(...args),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

let testKeyCounter = 0;
const getUniqueKey = () => `readiness-guard-${testKeyCounter++}-${Date.now()}`;

describe('Valkey readiness guard — client null while isCoordinationValkeyReady() is true (item 10)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The exact torn-down/reconnecting scenario the stricter guard
        // exists for: isCoordinationValkeyReady() still reports a client OBJECT exists,
        // but getCoordinationClient() no longer returns one.
        mockIsValkeyReady.mockReturnValue(true);
        mockGetValkeyClient.mockReturnValue(null);
    });

    it('checkRateLimit never calls into a Valkey client method and degrades to memory', async () => {
        const { checkRateLimit } = await import('./valkey-rate-limit');
        const key = getUniqueKey();

        const result = await checkRateLimit(key, 10, 60);

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9); // memory-store fallback semantics
    });

    it('peekRateLimit does not call cacheGet when the client is null', async () => {
        const { peekRateLimit } = await import('./valkey-rate-limit');
        const key = getUniqueKey();

        await peekRateLimit(key, 10, 60);

        expect(mockCacheGet).not.toHaveBeenCalled();
    });

    it('resetRateLimit does not call del when the client is null', async () => {
        const { resetRateLimit } = await import('./valkey-rate-limit');
        const key = getUniqueKey();

        await resetRateLimit(key, 60);

        expect(mockDel).not.toHaveBeenCalled();
    });

    it('getRateLimitStats does not call getKeysByPattern when the client is null, and reports the memory backend', async () => {
        const { getRateLimitStats } = await import('./valkey-rate-limit');

        const stats = await getRateLimitStats();

        expect(mockGetKeysByPattern).not.toHaveBeenCalled();
        expect(stats.backend).toBe('memory');
    });
});
