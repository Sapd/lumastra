// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for preview-session.service.ts
 *
 * Tests the Redis-related paths: serialization round-trips,
 * deserialization validation, getPreviewSession Redis rehydration,
 * and getUserPreviewSessions stale-ID cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

// Stable UserId constants for test users (mig 16.46.0 — userId is UserId, not string).
const USER_ALICE: UserId = toUserId('a1ce0000-0000-4000-a000-000000000000');
const USER_BOB: UserId = toUserId('b0b00000-0000-4000-a000-000000000000');
const USER_CAROL: UserId = toUserId('ca201000-0000-4000-a000-000000000000');
const USER_STALE: UserId = toUserId('57a1e000-0000-4000-a000-000000000000');
const USER_WRONG: UserId = toUserId('fffff000-0000-4000-a000-000000000000');
const USER_SCAN: UserId = toUserId('5ca00000-0000-4000-a000-000000000000');
const USER_UNKNOWN: UserId = toUserId('eeee0000-0000-4000-a000-000000000000');
const USER_REDIS_ERR: UserId = toUserId('ededed00-0000-4000-a000-000000000000');

// vi.hoisted ensures mock refs are available when vi.mock factories execute
const { mockCacheGet, mockCacheGetOrThrow, mockCacheSet, mockCacheDel, mockGetKeysByPattern } =
    vi.hoisted(() => ({
        mockCacheGet: vi.fn<(_key: string) => Promise<string | null>>(),
        mockCacheGetOrThrow: vi.fn<(_key: string) => Promise<string | null>>(),
        mockCacheSet: vi.fn<(_key: string, _value: string) => Promise<boolean>>(),
        mockCacheDel: vi.fn<(_key: string) => Promise<number>>(),
        mockGetKeysByPattern: vi.fn<(_pattern: string) => Promise<string[]>>(),
    }));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: mockCacheGet,
    cacheGetOrThrow: mockCacheGetOrThrow,
    cacheSet: mockCacheSet,
    cacheDel: mockCacheDel,
    getKeysByPattern: mockGetKeysByPattern,
    setIfNotExists: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    getValkeyClient: vi.fn().mockReturnValue(null),
    getCoordinationClient: vi.fn().mockReturnValue(null),
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => () => {}),
}));

// Mock UnifiedCache used by liveTvSessionCache (must be a proper constructor)
vi.mock('$lib/server/cache/unified-cache', () => ({
    UnifiedCache: function UnifiedCache() {
        return {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
        };
    },
    CacheManager: {
        getInstance: vi.fn().mockReturnValue({
            register: vi.fn(),
            get: vi.fn().mockReturnValue(null),
            getCache: vi.fn().mockReturnValue({
                get: vi.fn().mockResolvedValue(null),
                set: vi.fn().mockResolvedValue(undefined),
                delete: vi.fn().mockResolvedValue(undefined),
                deleteUserCache: vi.fn().mockResolvedValue(undefined),
            }),
            for: vi.fn().mockReturnValue({
                get: vi.fn().mockResolvedValue(null),
                set: vi.fn().mockResolvedValue(undefined),
                delete: vi.fn().mockResolvedValue(undefined),
                deleteUserCache: vi.fn().mockResolvedValue(undefined),
            }),
            shutdown: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

vi.mock('./ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: vi.fn().mockReturnValue({
        stopJob: vi.fn().mockResolvedValue(undefined),
    }),
}));

const grantMint = vi.hoisted(() => vi.fn());
vi.mock('./playback-grant', async (original) => ({
    ...(await original<typeof import('./playback-grant')>()),
    mintPlaybackGrant: grantMint,
    revokeGrantsForPlaySession: vi.fn().mockResolvedValue(0),
}));

// Import after mocks are registered
import {
    buildPreviewStreamHref,
    addPreviewSession,
    getPreviewSession,
    getUserPreviewSessions,
    cleanupPreviewSession,
    deletePreview,
    type PreviewSession,
} from './preview-session.service.js';

// =========================================================================
// Helpers
// =========================================================================

function makeSession(overrides: Partial<PreviewSession> = {}): PreviewSession {
    return {
        playSessionId: 'session-abc-123',
        itemId: 'item-xyz-456',
        transcodeMode: 'local',
        startPositionSeconds: 42,
        createdAt: new Date('2026-03-01T10:00:00.000Z'),
        lastHeartbeatAt: new Date('2026-03-01T10:01:00.000Z'),
        isPreview: true,
        ...overrides,
    };
}

// =========================================================================
// Test setup
// =========================================================================

beforeEach(async () => {
    vi.clearAllMocks();

    // Default: cacheSet / cacheDel succeed silently
    mockCacheSet.mockResolvedValue(true);
    mockCacheDel.mockResolvedValue(1);
    mockCacheGet.mockResolvedValue(null);
    mockGetKeysByPattern.mockResolvedValue([]);
});

// =========================================================================
// 1. Serialization round-trip (tested via addPreviewSession + cacheSet spy)
// =========================================================================

describe('serializeSession / deserializeSession round-trip (via addPreviewSession + getPreviewSession)', () => {
    it('round-trips a minimal session through JSON', async () => {
        const session = makeSession();

        // Capture what was written to Redis
        let capturedJson = '';
        mockCacheSet.mockImplementation((_key, value) => {
            capturedJson = value as string;
            return Promise.resolve(true);
        });

        await addPreviewSession(session);

        // Now simulate a Redis hit on a different "pod" (clear in-memory state)
        await cleanupPreviewSession(session.playSessionId, session, session.userId);

        // Provide the captured JSON back via cacheGet
        mockCacheGet.mockResolvedValueOnce(capturedJson);

        const result = await getPreviewSession(session.playSessionId);

        expect(result).not.toBeUndefined();
        expect(result?.playSessionId).toBe(session.playSessionId);
        expect(result?.itemId).toBe(session.itemId);
        expect(result?.transcodeMode).toBe(session.transcodeMode);
        expect(result?.startPositionSeconds).toBe(session.startPositionSeconds);
        expect(result?.isPreview).toBe(true);
        expect(result?.createdAt).toEqual(session.createdAt);
        expect(result?.lastHeartbeatAt).toEqual(session.lastHeartbeatAt);
    });

    it('preserves optional fields (transcodeJobId, isLiveTv, userId) when set', async () => {
        const session = makeSession({
            playSessionId: 'sess-optional-fields',
            transcodeJobId: 'job-999',
            isLiveTv: true,
            userId: USER_ALICE,
        });

        // Capture only the session-prefix key (not the live-TV user key)
        const SESSION_PREFIX = 'preview:session:v1:';
        let capturedJson = '';
        mockCacheSet.mockImplementation((key, value) => {
            if ((key as string).startsWith(SESSION_PREFIX)) {
                capturedJson = value as string;
            }
            return Promise.resolve(true);
        });

        await addPreviewSession(session);
        await cleanupPreviewSession(session.playSessionId, session, session.userId);

        mockCacheGet.mockResolvedValueOnce(capturedJson);

        const result = await getPreviewSession(session.playSessionId);

        expect(result?.transcodeJobId).toBe('job-999');
        expect(result?.isLiveTv).toBe(true);
        expect(result?.userId).toBe(USER_ALICE);
    });

    it('optional fields are absent (not null) when not set', async () => {
        const session = makeSession();
        // transcodeJobId, isLiveTv, userId intentionally omitted

        let capturedJson = '';
        mockCacheSet.mockImplementation((_key, value) => {
            capturedJson = value as string;
            return Promise.resolve(true);
        });

        await addPreviewSession(session);
        await cleanupPreviewSession(session.playSessionId, session, session.userId);

        mockCacheGet.mockResolvedValueOnce(capturedJson);

        const result = await getPreviewSession(session.playSessionId);

        expect(result?.transcodeJobId).toBeUndefined();
        expect(result?.isLiveTv).toBeUndefined();
        expect(result?.userId).toBeUndefined();
    });

    it('reconstructs Date objects (not strings) from serialized form', async () => {
        const session = makeSession();

        let capturedJson = '';
        mockCacheSet.mockImplementation((_key, value) => {
            capturedJson = value as string;
            return Promise.resolve(true);
        });

        await addPreviewSession(session);
        await cleanupPreviewSession(session.playSessionId, session, session.userId);

        mockCacheGet.mockResolvedValueOnce(capturedJson);

        const result = await getPreviewSession(session.playSessionId);

        expect(result?.createdAt).toBeInstanceOf(Date);
        expect(result?.lastHeartbeatAt).toBeInstanceOf(Date);
    });
});

// =========================================================================
// 2. deserializeSession validation (tested via getPreviewSession + mocked cacheGet)
// =========================================================================

describe('deserializeSession validation — via getPreviewSession with mocked cacheGet', () => {
    const validPayload = {
        playSessionId: 'sess-1',
        itemId: 'item-1',
        transcodeMode: 'direct',
        startPositionSeconds: 0,
        createdAt: '2026-03-01T10:00:00.000Z',
        lastHeartbeatAt: '2026-03-01T10:01:00.000Z',
        isPreview: true,
    };

    it('returns undefined for null raw value from Redis', async () => {
        mockCacheGet.mockResolvedValueOnce(null);

        const result = await getPreviewSession('nonexistent');
        expect(result).toBeUndefined();
    });

    it('returns undefined for non-object JSON (string primitive)', async () => {
        mockCacheGet.mockResolvedValueOnce(JSON.stringify('just a string'));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined for non-object JSON (number primitive)', async () => {
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(42));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when playSessionId is not a string', async () => {
        const payload = { ...validPayload, playSessionId: 123 };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when itemId is not a string', async () => {
        const payload = { ...validPayload, itemId: null };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when isPreview is not true', async () => {
        const payload = { ...validPayload, isPreview: false };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when transcodeMode is an invalid value', async () => {
        const payload = { ...validPayload, transcodeMode: 'hls' };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when startPositionSeconds is not a number', async () => {
        const payload = { ...validPayload, startPositionSeconds: '0' };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when createdAt is an unparseable date string', async () => {
        const payload = { ...validPayload, createdAt: 'not-a-date' };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined when lastHeartbeatAt is an unparseable date string', async () => {
        const payload = { ...validPayload, lastHeartbeatAt: 'invalid-date' };
        mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('returns undefined for malformed JSON string', async () => {
        mockCacheGet.mockResolvedValueOnce('{not valid json}');

        const result = await getPreviewSession('sess-bad');
        expect(result).toBeUndefined();
    });

    it('accepts all valid transcodeMode values', async () => {
        for (const mode of ['local', 'direct'] as const) {
            const payload = {
                ...validPayload,
                playSessionId: `sess-${mode}`,
                transcodeMode: mode,
            };
            mockCacheGet.mockResolvedValueOnce(JSON.stringify(payload));

            const result = await getPreviewSession(`sess-${mode}`);
            expect(result?.transcodeMode).toBe(mode);

            // Cleanup in-memory state before next iteration
            if (result) {
                await cleanupPreviewSession(result.playSessionId, result, result.userId);
            }
        }
    });
});

// =========================================================================
// 3. getPreviewSession — Redis rehydration behaviour
// =========================================================================

describe('getPreviewSession — Redis rehydration', () => {
    const validJson = JSON.stringify({
        playSessionId: 'sess-redis-1',
        itemId: 'item-redis-1',
        transcodeMode: 'local',
        startPositionSeconds: 10,
        createdAt: '2026-03-01T09:00:00.000Z',
        lastHeartbeatAt: '2026-03-01T09:05:00.000Z',
        isPreview: true,
        userId: USER_BOB,
    });

    it('returns undefined on both in-memory and Redis miss', async () => {
        mockCacheGet.mockResolvedValueOnce(null);

        const result = await getPreviewSession('unknown-session');

        expect(result).toBeUndefined();
        expect(mockCacheGet).toHaveBeenCalledOnce();
    });

    it('returns in-memory session without calling cacheGet', async () => {
        const session = makeSession({ playSessionId: 'sess-in-memory' });
        await addPreviewSession(session);

        // Reset call count after addPreviewSession's own cacheSet
        mockCacheGet.mockClear();

        const result = await getPreviewSession('sess-in-memory');

        expect(result).toBe(session);
        expect(mockCacheGet).not.toHaveBeenCalled();

        // Cleanup
        await cleanupPreviewSession(session.playSessionId, session, session.userId);
    });

    it('calls cacheGet on miss and returns deserialized session on Redis hit', async () => {
        mockCacheGet.mockResolvedValueOnce(validJson);

        const result = await getPreviewSession('sess-redis-1');

        expect(mockCacheGet).toHaveBeenCalledWith('preview:session:v1:sess-redis-1');
        expect(result).not.toBeUndefined();
        expect(result?.playSessionId).toBe('sess-redis-1');
        expect(result?.userId).toBe(USER_BOB);

        // Cleanup
        if (result) {
            await cleanupPreviewSession(result.playSessionId, result, result.userId);
        }
    });

    it('rehydrates session into in-memory map after Redis hit', async () => {
        mockCacheGet.mockResolvedValueOnce(validJson);

        await getPreviewSession('sess-redis-1');
        mockCacheGet.mockClear();

        // Second call: should be served from in-memory
        const result = await getPreviewSession('sess-redis-1');

        expect(result?.playSessionId).toBe('sess-redis-1');
        expect(mockCacheGet).not.toHaveBeenCalled();

        // Cleanup
        if (result) {
            await cleanupPreviewSession(result.playSessionId, result, result.userId);
        }
    });

    it('returns undefined (not throws) when cacheGet throws', async () => {
        mockCacheGet.mockRejectedValueOnce(new Error('Redis connection refused'));

        const result = await getPreviewSession('sess-redis-err');

        expect(result).toBeUndefined();
    });

    it('returns undefined when Redis returns invalid JSON (deserialize fails)', async () => {
        mockCacheGet.mockResolvedValueOnce('{broken json}');

        const result = await getPreviewSession('sess-bad-json');

        expect(result).toBeUndefined();
    });

    it('returns undefined when Redis returns valid JSON but missing required fields', async () => {
        const incomplete = JSON.stringify({ playSessionId: 'sess-incomplete' });
        mockCacheGet.mockResolvedValueOnce(incomplete);

        const result = await getPreviewSession('sess-incomplete');

        expect(result).toBeUndefined();
    });
});

// =========================================================================
// 4. getUserPreviewSessions — stale ID cleanup
// =========================================================================

describe('getUserPreviewSessions — stale ID cleanup', () => {
    it('returns in-memory sessions for user without Redis scan', async () => {
        const session = makeSession({
            playSessionId: 'sess-user-1',
            userId: USER_CAROL,
        });
        await addPreviewSession(session);
        mockGetKeysByPattern.mockClear();
        mockCacheGet.mockClear();

        const results = await getUserPreviewSessions(USER_CAROL);

        expect(results).toHaveLength(1);
        expect(results[0].playSessionId).toBe('sess-user-1');
        expect(mockGetKeysByPattern).not.toHaveBeenCalled();

        // Cleanup
        await cleanupPreviewSession(session.playSessionId, session, USER_CAROL);
    });

    it('clears stale Set entries when IDs exist in userSessions but not activePreviews', async () => {
        const session = makeSession({
            playSessionId: 'sess-stale',
            userId: USER_STALE,
        });
        // Add the session so userSessions is populated
        await addPreviewSession(session);

        // Remove from activePreviews by calling cleanupPreviewSession,
        // but then manually simulate the stale-IDs scenario by adding
        // the session back to userSessions without activePreviews entry.
        // We do this via: add → cleanup (removes from both) → re-add to userSessions
        // The simplest approach: add session, then directly remove from activePreviews
        // but that requires internal access. Instead: add, cleanup (clears both),
        // then call getUserPreviewSessions without any in-memory session → Redis fallback.

        // Actually, the stale cleanup happens when userSessions has IDs but activePreviews is empty.
        // We can trigger this by:
        // 1. Add session (populates both Maps)
        // 2. Remove only from activePreviews via cleanupPreviewSession (which removes from both)
        // The cleanupPreviewSession removes from both — so after it, userSessions is also cleared.
        // Therefore the stale path requires adding to userSessions without activePreviews.
        //
        // Use the public API: add session → "simulate pod restart" by
        // having Redis return nothing (sessions are gone from Redis too).
        // getUserPreviewSessions will see userSessions has IDs, activePreviews is empty,
        // returns empty → clears userSessions → falls through to Redis scan → empty.

        await cleanupPreviewSession(session.playSessionId, session, USER_STALE);

        // Now simulate a state where userSessions has the ID but activePreviews does not.
        // We can achieve this by adding another session for the user, then evicting it
        // from activePreviews only (partial state). Since we don't have direct Map access,
        // we use the integration approach:
        //
        // Add a fresh session, then call cleanupPreviewSession with a *different* userId
        // so userSessions[user-stale] still has the entry but activePreviews loses it.
        // However, cleanupPreviewSession only deletes from userSessions[userId] arg.
        const session2 = makeSession({
            playSessionId: 'sess-stale-2',
            userId: USER_STALE,
        });
        await addPreviewSession(session2);
        // Remove from activePreviews via cleanup with wrong userId so userSessions['user-stale']
        // is NOT cleaned:
        await cleanupPreviewSession(session2.playSessionId, session2, USER_WRONG);

        // Now userSessions['user-stale'] has 'sess-stale-2', activePreviews does NOT.
        // Redis also returns nothing (mockGetKeysByPattern returns []).
        mockGetKeysByPattern.mockResolvedValueOnce([]);

        const results = await getUserPreviewSessions(USER_STALE);

        // The service detects all IDs are stale, clears the Set, falls through to Redis scan
        expect(results).toHaveLength(0);
        // Should have called Redis scan as fallback
        expect(mockGetKeysByPattern).toHaveBeenCalledWith('preview:session:v1:*', 200);
    });

    it('returns empty array and triggers Redis scan when no in-memory sessions exist for user', async () => {
        mockGetKeysByPattern.mockResolvedValueOnce([]);

        const results = await getUserPreviewSessions(USER_UNKNOWN);

        expect(results).toHaveLength(0);
        expect(mockGetKeysByPattern).toHaveBeenCalledWith('preview:session:v1:*', 200);
    });

    it('rehydrates sessions from Redis scan for user', async () => {
        const redisKey = 'preview:session:v1:sess-scan-1';
        const redisPayload = JSON.stringify({
            playSessionId: 'sess-scan-1',
            itemId: 'item-scan-1',
            transcodeMode: 'local',
            startPositionSeconds: 0,
            createdAt: '2026-03-01T08:00:00.000Z',
            lastHeartbeatAt: '2026-03-01T08:05:00.000Z',
            isPreview: true,
            userId: USER_SCAN,
        });

        mockGetKeysByPattern.mockResolvedValueOnce([redisKey]);
        mockCacheGet.mockImplementation((key) => {
            if (key === redisKey) return Promise.resolve(redisPayload);
            return Promise.resolve(null);
        });

        const results = await getUserPreviewSessions(USER_SCAN);

        expect(results).toHaveLength(1);
        expect(results[0].playSessionId).toBe('sess-scan-1');
        expect(results[0].userId).toBe(USER_SCAN);

        // Cleanup
        await cleanupPreviewSession('sess-scan-1', results[0], USER_SCAN);
    });

    it('returns empty array (not throws) when getKeysByPattern throws', async () => {
        mockGetKeysByPattern.mockRejectedValueOnce(new Error('Redis scan failed'));

        const results = await getUserPreviewSessions(USER_REDIS_ERR);

        expect(results).toEqual([]);
    });
});

// =========================================================================
// 5. deletePreview — teardown must not depend on a caller-supplied item id
// =========================================================================

describe('deletePreview — ownership is the only gate', () => {
    const OWNER = toUserId('11111111-1111-1111-1111-111111111111');
    const OTHER = toUserId('22222222-2222-2222-2222-222222222222');

    /**
     * REGRESSION: deletePreview used to reject when a caller-supplied `itemId`
     * differed from `session.itemId`. It could not work — the session stores the
     * RESOLVED id (a series preview resolves to the episode actually played)
     * while callers only have the id they requested. `/playback/previews/{id}`
     * has no item in its route at all and passed `''`, so DELETE 422'd on every
     * call and never once tore a session down; the ambient home hero swallows
     * the failure, so each idling viewer leaked FFmpeg preview jobs to the reaper.
     *
     * The signature no longer accepts an itemId. If one is reintroduced as a
     * rejection condition, these fail.
     */
    it('tears down the owner’s session without being told which item it is', async () => {
        const session = makeSession({
            playSessionId: 'session-teardown-1',
            // A RESOLVED id the caller never saw — the whole point.
            itemId: 'resolved-episode-id',
            userId: OWNER,
        });
        await addPreviewSession(session);
        mockCacheGet.mockResolvedValue(JSON.parse(JSON.stringify(session)));

        const result = await deletePreview({
            playSessionId: 'session-teardown-1',
            username: OWNER,
        });

        expect(result.found).toBe(true);
        // No `error` channel any more — a legitimate teardown cannot be refused.
        expect(result).not.toHaveProperty('error');
    });

    it('reports not-found for a non-owner without revealing the session exists', async () => {
        const session = makeSession({
            playSessionId: 'session-teardown-2',
            itemId: 'resolved-episode-id',
            userId: OWNER,
        });
        await addPreviewSession(session);
        mockCacheGet.mockResolvedValue(JSON.parse(JSON.stringify(session)));

        const result = await deletePreview({
            playSessionId: 'session-teardown-2',
            username: OTHER,
        });

        // Same shape as a missing session — an id that exists but belongs to
        // someone else must be indistinguishable from one that does not.
        expect(result).toEqual({ found: false });
    });

    it('is idempotent for a session that is already gone', async () => {
        mockCacheGet.mockResolvedValue(null);

        const result = await deletePreview({
            playSessionId: 'session-never-existed',
            username: OWNER,
        });

        expect(result).toEqual({ found: false });
    });
});

it('gives Bearer preview callers a preview grant bound to the preview session', async () => {
    grantMint.mockResolvedValue({ token: 'stream_preview', playbackSessionId: 'preview-bound' });
    await addPreviewSession(
        makeSession({ playSessionId: 'preview-bound', itemId: 'media-item', userId: USER_ALICE }),
    );
    const href = await buildPreviewStreamHref(
        { userId: USER_ALICE, authMethod: 'bearer', clientIp: '192.0.2.1' },
        'media-item',
        'preview-bound',
        'file-id',
    );
    expect(grantMint).toHaveBeenCalledWith(
        expect.objectContaining({
            userId: USER_ALICE,
            kind: 'preview',
            mediaId: 'media-item',
            playbackSessionId: 'preview-bound',
            clientIp: '192.0.2.1',
        }),
    );
    const url = new URL(href, 'https://app.test');
    expect(url.pathname).toBe('/api/v1/playback/media-item/hls/master.m3u8');
    expect(url.searchParams.get('grant')).toBe('stream_preview');
    expect(url.searchParams.get('PlaySessionId')).toBe('preview-bound');
});

it('revokes persisted preview grants when the preview ends', async () => {
    const { revokeGrantsForPlaySession } = await import('./playback-grant');
    const session = makeSession({
        playSessionId: 'preview-granted',
        userId: USER_ALICE,
        hasPlaybackGrant: true,
    });
    await addPreviewSession(session);
    await cleanupPreviewSession(session.playSessionId, session, USER_ALICE);
    expect(revokeGrantsForPlaySession).toHaveBeenCalledWith(
        'preview-granted',
        undefined,
        'stopped',
    );
});

describe('grant preview liveness reads', () => {
    it('uses authoritative keepalive and teardown state instead of a stale local snapshot', async () => {
        const session = makeSession({
            playSessionId: 'preview-grant-authoritative',
            userId: USER_ALICE,
            createdAt: new Date(),
            lastHeartbeatAt: new Date(Date.now() - 31_000),
        });
        await addPreviewSession(session);
        try {
            mockCacheGetOrThrow.mockResolvedValue(
                JSON.stringify({
                    ...session,
                    lastHeartbeatAt: new Date(),
                }),
            );
            expect(
                await getPreviewSession(session.playSessionId, { requireLive: true }),
            ).toMatchObject({ playSessionId: session.playSessionId });
            mockCacheGetOrThrow.mockResolvedValue(null);
            expect(
                await getPreviewSession(session.playSessionId, { requireLive: true }),
            ).toBeUndefined();
            mockCacheGetOrThrow.mockResolvedValue(JSON.stringify(session));
            expect(
                await getPreviewSession(session.playSessionId, { requireLive: true }),
            ).toBeUndefined();
            mockCacheGetOrThrow.mockRejectedValue(new Error('store unavailable'));
            session.lastHeartbeatAt = new Date();
            expect(await getPreviewSession(session.playSessionId, { requireLive: true })).toBe(
                session,
            );
        } finally {
            await cleanupPreviewSession(session.playSessionId, session, USER_ALICE);
        }
    });
});
