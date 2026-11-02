// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

// vi.hoisted so the mutable config object is available when the vi.mock
// factory below runs (hoisted above imports) — mirrors play-sessions.service.test.ts.
const mockConfig = vi.hoisted(() => ({
    STREAM_LIMITS_ENFORCED: true,
}));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: mockConfig };
});

const mockGetUserById = vi.fn();
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

const mockSetIfNotExists = vi.fn();
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockCacheDel = vi.fn();
vi.mock('$lib/server/cache/valkey.js', () => ({
    setIfNotExists: (...args: unknown[]) => mockSetIfNotExists(...args),
    cacheGet: (...args: unknown[]) => mockCacheGet(...args),
    cacheSet: (...args: unknown[]) => mockCacheSet(...args),
    cacheDel: (...args: unknown[]) => mockCacheDel(...args),
}));

const mockGetEffectivePolicy = vi.fn();
const mockGetActiveSessionsForUser = vi.fn();
vi.mock('./play-sessions.service.js', () => ({
    getEffectivePolicy: (...args: unknown[]) => mockGetEffectivePolicy(...args),
    getActiveSessionsForUser: (...args: unknown[]) => mockGetActiveSessionsForUser(...args),
}));

const mockKillSessionUnified = vi.fn();
vi.mock('./session-kill.service.js', () => ({
    killSessionUnified: (...args: unknown[]) => mockKillSessionUnified(...args),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import type { Sql } from 'postgres';
import { reconcileStreamLimit } from './stream-limit-reconciler.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { UNLIMITED_CONCURRENT_STREAMS } from '$lib/schemas/play-sessions.js';

const TEST_USER_ID = toUserId('11111111-1111-4111-8111-111111111111');
const fakeSql = {} as Sql;

function makeSession(id: string, source: string = 'lumastra') {
    return { id, source };
}

// ============================================================================
// Tests
// ============================================================================

describe('reconcileStreamLimit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.STREAM_LIMITS_ENFORCED = true;
        mockGetUserById.mockResolvedValue({ username: 'alice' });
        mockGetEffectivePolicy.mockResolvedValue({ max_concurrent_streams: 2 });
        mockSetIfNotExists.mockResolvedValue(true);
        mockCacheGet.mockResolvedValue(null);
        mockCacheSet.mockResolvedValue(true);
        mockCacheDel.mockResolvedValue(1);
        mockKillSessionUnified.mockResolvedValue({ killed: true, source: 'database' });
    });

    it('does nothing when the kill-switch is disabled', async () => {
        mockConfig.STREAM_LIMITS_ENFORCED = false;

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockSetIfNotExists).not.toHaveBeenCalled();
        expect(mockGetActiveSessionsForUser).not.toHaveBeenCalled();
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('does nothing when Valkey is unavailable (throttle acquisition fails)', async () => {
        mockSetIfNotExists.mockResolvedValue(false);

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockGetActiveSessionsForUser).not.toHaveBeenCalled();
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('clears the over-limit marker when the user is under the limit', async () => {
        mockGetActiveSessionsForUser.mockResolvedValue([makeSession('s1'), makeSession('s2')]);

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockCacheDel).toHaveBeenCalledWith(
            'v1:stream-limit:over:11111111-1111-4111-8111-111111111111',
        );
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('never kicks when the policy is unlimited (-1), however many sessions are active', async () => {
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: UNLIMITED_CONCURRENT_STREAMS,
        });
        mockGetActiveSessionsForUser.mockResolvedValue([
            makeSession('s1'),
            makeSession('s2'),
            makeSession('s3'),
        ]);
        // A marker old enough that the grace period has elapsed — without an
        // unlimited guard this would kick every session down to -1.
        mockCacheGet.mockResolvedValue(String(Date.now() - 60 * 60 * 1000));

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockKillSessionUnified).not.toHaveBeenCalled();
        expect(mockCacheDel).toHaveBeenCalledWith(
            'v1:stream-limit:over:11111111-1111-4111-8111-111111111111',
        );
    });

    it('sets the over-limit marker on first detection but does not kick yet', async () => {
        mockGetActiveSessionsForUser.mockResolvedValue([
            makeSession('s1'),
            makeSession('s2'),
            makeSession('s3'),
        ]);
        mockCacheGet.mockResolvedValue(null); // no existing marker

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockCacheSet).toHaveBeenCalledWith(
            'v1:stream-limit:over:11111111-1111-4111-8111-111111111111',
            expect.any(String),
            120,
        );
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('does not kick while still within the grace window', async () => {
        mockGetActiveSessionsForUser.mockResolvedValue([
            makeSession('s1'),
            makeSession('s2'),
            makeSession('s3'),
        ]);
        // Marker set 10s ago — well within the 45s grace window.
        mockCacheGet.mockResolvedValue(String(Date.now() - 10_000));

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('kicks the newest excess sessions down to the limit once grace has elapsed, with no cooldown', async () => {
        // getActiveSessionsForUser orders newest-first (started_at DESC).
        mockGetActiveSessionsForUser.mockResolvedValue([
            makeSession('newest'),
            makeSession('middle'),
            makeSession('oldest'),
        ]);
        // Marker set 50s ago — past the 45s grace window.
        mockCacheGet.mockResolvedValue(String(Date.now() - 50_000));

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        // limit is 2, active is 3 → exactly 1 excess session (the newest) is kicked.
        expect(mockKillSessionUnified).toHaveBeenCalledTimes(1);
        expect(mockKillSessionUnified).toHaveBeenCalledWith(
            fakeSql,
            'newest',
            'system:stream-limit-reconciler',
            { setCooldown: false, reason: 'stream_limit' },
        );
        expect(mockCacheDel).toHaveBeenCalledWith(
            'v1:stream-limit:over:11111111-1111-4111-8111-111111111111',
        );
    });

    it('excludes external-mirror sessions from the count (a Jellyfin mirror does not push a user over)', async () => {
        // 2 first-party + 2 native-Jellyfin mirror sessions, limit 2. Without
        // the source filter this is 4 → over limit → kick. With it, only the 2
        // lumastra sessions count → at limit → no kick, marker cleared.
        mockGetActiveSessionsForUser.mockResolvedValue([
            makeSession('lumastra-1', 'lumastra'),
            makeSession('lumastra-2', 'lumastra'),
            makeSession('jellyfin-1', 'jellyfin'),
            makeSession('subsonic-1', 'subsonic'),
        ]);
        mockCacheGet.mockResolvedValue(String(Date.now() - 50_000)); // grace elapsed

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockKillSessionUnified).not.toHaveBeenCalled();
        expect(mockCacheDel).toHaveBeenCalledWith(
            'v1:stream-limit:over:11111111-1111-4111-8111-111111111111',
        );
    });

    it('never selects an external-mirror session to kick (killing the mirror is pointless — it re-ingests)', async () => {
        // 3 first-party (newest-first) + 1 Jellyfin mirror, limit 2. Only the
        // newest first-party session is excess; the Jellyfin row is filtered
        // out of both the count (3 → 1 excess, not 4 → 2) and the kick set.
        mockGetActiveSessionsForUser.mockResolvedValue([
            makeSession('newest', 'lumastra'),
            makeSession('jellyfin-mirror', 'jellyfin'),
            makeSession('middle', 'lumastra'),
            makeSession('oldest', 'lumastra'),
        ]);
        mockCacheGet.mockResolvedValue(String(Date.now() - 50_000)); // grace elapsed

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockKillSessionUnified).toHaveBeenCalledTimes(1);
        expect(mockKillSessionUnified).toHaveBeenCalledWith(
            fakeSql,
            'newest',
            'system:stream-limit-reconciler',
            { setCooldown: false, reason: 'stream_limit' },
        );
    });

    it('falls back to the UUID as the policy key when the user cannot be resolved', async () => {
        mockGetUserById.mockResolvedValue(null);
        mockGetActiveSessionsForUser.mockResolvedValue([makeSession('s1')]);

        await reconcileStreamLimit(fakeSql, TEST_USER_ID);

        expect(mockGetEffectivePolicy).toHaveBeenCalledWith(fakeSql, TEST_USER_ID);
    });
});
