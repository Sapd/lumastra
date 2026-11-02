// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the P5 external-poller → play_sessions ingestion path.
 *
 * Verifies:
 *   • Two consecutive polls with the same session: ingestExternal called both
 *     times, markStop NOT called.
 *   • Session vanishes between polls: markStop called once with
 *     reason='crashed'.
 *   • Session whose internal media UUID can't be resolved is skipped (no
 *     ingest, no markStop, warn logged).
 *   • Session whose username is not a Lumastra user is skipped (no ingest, no
 *     markStop, warn logged).
 *   • If ingestExternal throws for one session, the loop continues processing
 *     the remaining sessions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamSession } from '../types.js';
import type { ExternalSessionSource, IngestExternalParams } from './session-manager.service.js';

// `features.jellyfinSync` must be true so the service module loads cleanly,
// but we never actually call startCaching() — tests invoke the private
// `processObservedSessions` method directly via a typed escape hatch.
vi.mock('../config.js', () => ({
    config: {
        JELLYFINURL: '',
        JELLYFINAPIKEY: '',
        LIVETV_REFRESH_INTERVAL_MS: 10_000,
        SESSIONS_REFRESH_INTERVAL_MS: 5_000,
    },
    features: {
        audiobooks: true,
        jellyfinSync: true,
    },
}));

vi.mock('../operation-mode.js', () => ({
    operationMode: {
        isJellyfinEnabled: true,
    },
}));

vi.mock('../jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getUserByName: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('../jellyfin/playback.service.js', () => ({
    jellyfinPlaybackService: {
        getSessions: vi.fn().mockResolvedValue([]),
    },
}));
vi.mock('../jellyfin/media.service.js', () => ({
    jellyfinMediaService: {
        getItemById: vi.fn().mockResolvedValue(null),
    },
}));
vi.mock('./livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getCurrentProgram: vi.fn().mockResolvedValue(undefined),
        getGuidePrograms: vi.fn().mockResolvedValue({}),
    }),
}));
vi.mock('../transformers.js', () => ({
    transformJellyfinSessionToStreamSession: vi.fn(),
}));
const loggerMock = vi.hoisted(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));
vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => loggerMock,
    },
}));
vi.mock('../cache/index.js', () => ({
    cacheManager: {
        for: vi.fn(() => ({
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            del: vi.fn().mockResolvedValue(undefined),
            invalidate: vi.fn().mockResolvedValue(undefined),
        })),
    },
    CACHE_NAMESPACES: {
        liveTvPrograms: 'liveTvPrograms',
        audioMetadata: 'audioMetadata',
    },
}));

const ingestExternalMock = vi.fn().mockResolvedValue({
    created: false,
    updated: true,
});
const markStopMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./session-manager.service.js', () => ({
    getSessionManager: vi.fn(() => ({
        ingestExternal: ingestExternalMock,
        markStop: markStopMock,
    })),
}));

// Map of (lower-cased) Jellyfin login name → stable users.id UUID. Mirrors what
// the shared `resolveJellyfinNamesToUserIds` resolver returns from the `users`
// table (matching LOWER(COALESCE(jellyfin_username, username))). Unmapped names
// are dropped (orphan policy) — no sentinel UUID.
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_VIEWER_ID = '22222222-2222-4222-8222-222222222222';
const knownUserIds = new Map<string, string>([
    ['testuser', TEST_USER_ID],
    ['testviewer', TEST_VIEWER_ID],
]);

// The resolver runs `sql.array(...)` on the names list before interpolation, so
// the mock provides a callable `.array` that just returns its input. The tagged-
// template mock then returns { id, jellyfin_name } rows for known names.
const sqlMock = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const candidates = values.find((v) => Array.isArray(v));
        if (Array.isArray(candidates)) {
            const seen = new Set<string>();
            const rows: { id: string; jellyfin_name: string }[] = [];
            for (const c of candidates) {
                if (typeof c !== 'string') continue;
                const lc = c.toLowerCase();
                const id = knownUserIds.get(lc);
                if (!id || seen.has(lc)) continue;
                seen.add(lc);
                rows.push({ id, jellyfin_name: lc });
            }
            return rows;
        }
        return [];
    }),
    { array: (a: unknown) => a },
);

vi.mock('../database/connection.js', () => ({
    getDb: vi.fn(() => sqlMock),
}));

import { sessionsCacheService, buildExternalIngestParams } from './sessions-cache.service.js';
import { toUserId } from '$lib/shared/user-id.js';

// Resolved users.id UUID passed to buildExternalIngestParams (mig 16.46.0).
const TEST_UID = toUserId(TEST_USER_ID);

interface SessionsCacheServiceInternals {
    processObservedSessions: (
        source: ExternalSessionSource,
        sessions: StreamSession[],
        rawById: Map<string, unknown>,
    ) => Promise<void>;
    previouslySeenSourceKeys: Map<ExternalSessionSource, Set<string>>;
}

function asInternals(): SessionsCacheServiceInternals {
    return sessionsCacheService as unknown as SessionsCacheServiceInternals;
}

function makeJellyfinSession(overrides: Partial<StreamSession> = {}): StreamSession {
    return {
        __id: 'jf-session-1',
        id: 'jf-item-1',
        jellyfinId: 'jf-item-1',
        mediaItemId: 'jf-item-1',
        title: 'Test Movie',
        mediaType: 'movie',
        username: 'testuser',
        playSessionId: 'jf-play-1',
        playCurrentTime: 100,
        playItemDuration: 600,
        streamProgress: (100 / 600) * 100,
        playIsPlaying: true,
        sessionSource: 'jellyfin',
        externalIds: { internal: 'media-uuid-1' },
        clientname: 'Jellyfin Web',
        browsername: 'Chrome',
        ...overrides,
    } as StreamSession;
}

describe('SessionsCacheService.processObservedSessions', () => {
    beforeEach(() => {
        ingestExternalMock.mockClear();
        markStopMock.mockClear();
        // Reset the seen-keys state on the singleton between tests.
        asInternals().previouslySeenSourceKeys.clear();
    });

    it('calls ingestExternal twice across two polls of the same session and never markStop', async () => {
        const internals = asInternals();
        const session = makeJellyfinSession();

        await internals.processObservedSessions(
            'jellyfin',
            [session],
            new Map([['jf-play-1', { foo: 'raw1' }]]),
        );
        await internals.processObservedSessions(
            'jellyfin',
            [session],
            new Map([['jf-play-1', { foo: 'raw2' }]]),
        );

        expect(ingestExternalMock).toHaveBeenCalledTimes(2);
        expect(markStopMock).not.toHaveBeenCalled();
    });

    it('calls markStop with reason="crashed" for a session that vanished between polls', async () => {
        const internals = asInternals();
        const session = makeJellyfinSession();

        await internals.processObservedSessions(
            'jellyfin',
            [session],
            new Map([['jf-play-1', {}]]),
        );
        await internals.processObservedSessions('jellyfin', [], new Map());

        expect(ingestExternalMock).toHaveBeenCalledTimes(1);
        expect(markStopMock).toHaveBeenCalledTimes(1);
        expect(markStopMock).toHaveBeenCalledWith(
            expect.objectContaining({
                source: 'jellyfin',
                sourceSessionId: 'jf-play-1',
                reason: 'crashed',
            }),
        );
    });

    it('skips session with no internal media UUID (no ingest, no markStop)', async () => {
        const internals = asInternals();
        const session = makeJellyfinSession({
            externalIds: { tmdb: '550' }, // no internal
        });

        await internals.processObservedSessions(
            'jellyfin',
            [session],
            new Map([['jf-play-1', {}]]),
        );

        expect(ingestExternalMock).not.toHaveBeenCalled();
        expect(markStopMock).not.toHaveBeenCalled();
    });

    it('warns once per unresolvable upstream session, not on every poll', async () => {
        const internals = asInternals();
        const session = makeJellyfinSession({
            playSessionId: 'jf-play-unresolved',
            externalIds: { tmdb: '551' },
        });
        const message = 'Skipping external session — no internal media UUID resolved';
        loggerMock.warn.mockClear();

        for (let poll = 0; poll < 3; poll++) {
            await internals.processObservedSessions('jellyfin', [session], new Map());
        }

        expect(loggerMock.warn.mock.calls.filter(([m]) => m === message)).toHaveLength(1);
    });

    it('skips session whose username is not a Lumastra user', async () => {
        const internals = asInternals();
        const session = makeJellyfinSession({ username: 'orphan-user' });

        await internals.processObservedSessions(
            'jellyfin',
            [session],
            new Map([['jf-play-1', {}]]),
        );

        expect(ingestExternalMock).not.toHaveBeenCalled();
        expect(markStopMock).not.toHaveBeenCalled();
    });

    it('continues the loop when ingestExternal throws for one session', async () => {
        const internals = asInternals();
        const sessionA = makeJellyfinSession({
            __id: 'jf-session-a',
            playSessionId: 'jf-play-a',
            externalIds: { internal: 'media-a' },
        });
        const sessionB = makeJellyfinSession({
            __id: 'jf-session-b',
            playSessionId: 'jf-play-b',
            externalIds: { internal: 'media-b' },
        });

        ingestExternalMock
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ created: false, updated: true });

        await internals.processObservedSessions(
            'jellyfin',
            [sessionA, sessionB],
            new Map([
                ['jf-play-a', {}],
                ['jf-play-b', {}],
            ]),
        );

        expect(ingestExternalMock).toHaveBeenCalledTimes(2);
        // Both sessions should still be tracked for the next-cycle diff so a
        // failed ingest doesn't cascade into a spurious markStop call later.
        expect(internals.previouslySeenSourceKeys.get('jellyfin')).toEqual(
            new Set(['jf-play-a', 'jf-play-b']),
        );
        expect(markStopMock).not.toHaveBeenCalled();
    });

    it('attributes the session to the resolved users.id UUID (case-insensitive)', async () => {
        // Jellyfin returns 'Testuser'; the shared resolver matches it
        // case-insensitively to the users row and the ingest call attributes
        // play_sessions.user_id to that stable UUID (mig 16.46.0).
        const internals = asInternals();
        const session = makeJellyfinSession({ username: 'Testuser' });

        await internals.processObservedSessions(
            'jellyfin',
            [session],
            new Map([['jf-play-1', {}]]),
        );

        expect(ingestExternalMock).toHaveBeenCalledOnce();
        const args = ingestExternalMock.mock.calls[0][0] as IngestExternalParams;
        expect(args.userId).toBe(TEST_USER_ID);
    });
});

describe('buildExternalIngestParams', () => {
    it('returns null when externalIds.internal is missing', () => {
        const params = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ externalIds: { tmdb: '1' } }),
            { foo: 'bar' },
            TEST_UID,
        );
        expect(params).toBeNull();
    });

    it('returns null when username is missing', () => {
        const params = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ username: '' }),
            { foo: 'bar' },
            TEST_UID,
        );
        expect(params).toBeNull();
    });

    it('maps PAUSED status when playIsPlaying is false', () => {
        const params = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ playIsPlaying: false }),
            { foo: 'bar' },
            TEST_UID,
        );
        expect(params?.status).toBe('PAUSED');
    });

    it('maps ACTIVE status when playIsPlaying is true', () => {
        const params = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ playIsPlaying: true }),
            { foo: 'bar' },
            TEST_UID,
        );
        expect(params?.status).toBe('ACTIVE');
    });

    it('uses playSessionId for Jellyfin sourceSessionId, falling back to __id', () => {
        const withPlaySession = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ playSessionId: 'play-1' }),
            {},
            TEST_UID,
        );
        expect(withPlaySession?.sourceSessionId).toBe('play-1');

        const withoutPlaySession = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({
                playSessionId: undefined,
                __id: 'session-id-only',
            }),
            {},
            TEST_UID,
        );
        expect(withoutPlaySession?.sourceSessionId).toBe('session-id-only');
    });

    it('converts position seconds to ms and clamps to >= 0', () => {
        const params = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ playCurrentTime: -5 }),
            {},
            TEST_UID,
        );
        expect(params?.positionMs).toBe(0);

        const params2 = buildExternalIngestParams(
            'jellyfin',
            makeJellyfinSession({ playCurrentTime: 12.5 }),
            {},
            TEST_UID,
        );
        expect(params2?.positionMs).toBe(12_500);
    });
});
