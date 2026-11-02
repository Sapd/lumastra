// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
const timelineGet = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet: timelineGet }));
import { getTimelineByHref } from '$lib/api/playback.js';
import { mount } from '$lib/server/api/mount.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import type { RequestEvent } from '@sveltejs/kit';

const { revokeGrantsForPlaySession } = vi.hoisted(() => ({
    revokeGrantsForPlaySession: vi.fn().mockResolvedValue(0),
}));
const mockMintPlaybackGrant = vi.hoisted(() => vi.fn());
const mockBuildPlaybackStartInfo = vi.hoisted(() => vi.fn());
const mockAuthorizePlayback = vi.hoisted(() => vi.fn().mockResolvedValue({ allow: true }));
vi.mock('$lib/server/plugins/runtime/playback-authorization.js', () => ({
    authorizePlaybackViaPlugins: mockAuthorizePlayback,
}));
const mockGetMediaItemById = vi.hoisted(() => vi.fn());
const mockOpenAudiobookSession = vi.hoisted(() => vi.fn());
vi.mock('../database/queries/radio-stream.queries.js', () => ({
    getRadioStreamUrl: vi.fn(async () => 'https://radio.example/stream'),
}));
vi.mock('../database/queries/music.queries.js', () => ({
    getTrackStreamSource: vi.fn(async () => ({ file_path: '/music/source.flac' })),
}));
vi.mock('../utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(async () => ({
        isAccessible: true,
        containerPath: '/music/source.flac',
    })),
}));
vi.mock('./music-transcode/source-metadata.js', () => ({
    probeAudioSource: vi.fn(async () => ({
        codec: 'flac',
        container: 'flac',
        bitrate: 800_000,
        sampleRate: 44100,
        channels: 2,
        bitDepth: 16,
    })),
}));
vi.mock('$lib/server/services/playback-grant.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./playback-grant.js')>()),
    revokeGrantsForPlaySession,
    mintPlaybackGrant: mockMintPlaybackGrant,
}));
vi.mock('../database/queries/catalog-operations.queries.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../database/queries/catalog-operations.queries.js')>()),
    getMediaItemById: mockGetMediaItemById,
}));
vi.mock('./info.service.js', () => ({
    buildPlaybackStartInfo: mockBuildPlaybackStartInfo,
    pathScopedFromDeviceCaps: () => ({ subtitleRendering: { burnInRequired: [] } }),
}));

// ============================================================================
// Mocks
// ============================================================================

const mockGetEffectivePolicy = vi.fn();
const mockCreatePlaySession = vi.fn();
const mockStopSession = vi.fn();
const mockClaimStaleSessions = vi.fn();
const mockClaimStaleSessionsForUser = vi.fn().mockResolvedValue([]);
const mockGetPendingStaleSessions = vi.fn();
const mockGetRetryableAudiobookSessionCloses = vi.fn();
const mockMarkStaleSessionProcessed = vi.fn();
const mockClaimBootOrphanSessions = vi.fn();
const mockAbandonAudiobookSessionClose = vi.fn();
const mockRecordStaleSessionAttempt = vi.fn();
const mockGetUsernamesByIds = vi.fn();
const mockRetryPendingAudiobookSessionClose = vi.fn();
const mockDefaultSessionDeps = vi.fn();

vi.mock('../database/queries/play-sessions.queries.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../database/queries/play-sessions.queries.js')>()),
    expireMusicPrefetchRowsForParent: vi.fn().mockResolvedValue([]),
    createPlaySession: (...args: unknown[]) => mockCreatePlaySession(...args),
    getActiveSessionsForUser: vi.fn(),
    stopSession: (...args: unknown[]) => mockStopSession(...args),
    getEffectivePolicy: (...args: unknown[]) => mockGetEffectivePolicy(...args),
    upsertStreamPolicy: vi.fn(),
    claimStaleSessions: (...args: unknown[]) => mockClaimStaleSessions(...args),
    claimStaleSessionsForUser: (...args: unknown[]) => mockClaimStaleSessionsForUser(...args),
    getPendingStaleSessions: (...args: unknown[]) => mockGetPendingStaleSessions(...args),
    getRetryableAudiobookSessionCloses: (...args: unknown[]) =>
        mockGetRetryableAudiobookSessionCloses(...args),
    markStaleSessionProcessed: (...args: unknown[]) => mockMarkStaleSessionProcessed(...args),
    recordStaleSessionAttempt: (...args: unknown[]) => mockRecordStaleSessionAttempt(...args),
    claimBootOrphanSessions: (...args: unknown[]) => mockClaimBootOrphanSessions(...args),
    // Real behaviour — enforceStreamPolicy interpolates the RESULT into the
    // count/IP SQL, and whether 'local' is in it is the whole trust gate.
    UNMETERED_SOURCES: ['jellyfin', 'subsonic'],
    unmeteredSources: (trust: boolean) =>
        trust ? ['jellyfin', 'subsonic', 'local'] : ['jellyfin', 'subsonic'],
}));

vi.mock('../database/queries/users.queries.js', () => ({
    getUsernamesByIds: (...args: unknown[]) => mockGetUsernamesByIds(...args),
}));

vi.mock('./audiobook-session.service.js', () => ({
    openAudiobookSession: mockOpenAudiobookSession,
    retryPendingAudiobookSessionClose: (...args: unknown[]) =>
        mockRetryPendingAudiobookSessionClose(...args),
    abandonAudiobookSessionClose: (...args: unknown[]) => mockAbandonAudiobookSessionClose(...args),
    defaultSessionDeps: (...args: unknown[]) => mockDefaultSessionDeps(...args),
}));

const mockLifecycleUpdate = vi.fn();
const mockReportMusicSessionStart = vi.fn().mockResolvedValue(undefined);
vi.mock('./play-session-lifecycle.service.js', () => ({
    getPlaySessionLifecycleService: () => ({
        update: mockLifecycleUpdate,
        notifySessionStarted: vi.fn(),
    }),
    isMusicSessionMediaType: (t: string | null | undefined) => t === 'track' || t === 'audio',
    reportMusicSessionStart: (...args: unknown[]) => mockReportMusicSessionStart(...args),
}));

// vi.hoisted so the mutable config object is available when the vi.mock
// factory below runs (hoisted above imports). Tests flip these fields
// per-case and must reset them in afterEach.
const mockConfig = vi.hoisted(() => ({
    STREAM_LIMITS_ENFORCED: true,
    DEFAULT_MAX_CONCURRENT_STREAMS: 2,
    TRUST_CLIENT_LOCAL_PLAYBACK: false,
    MUSIC_TRANSCODE_DEFAULT_BITRATE: 192,
    MUSIC_TRANSCODE_DEFAULT_CODEC: 'mp3',
}));

// Keep every other config export real (this service's import graph reaches
// the task registry, which reads FEATURE_PER_TASK_QUEUES etc. at load) —
// override only the `config` object with our mutable fixture.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: mockConfig,
        features: { ...actual.features, musicTranscode: true },
    };
});

vi.mock('./session-kill.service.js', () => ({
    killSessionUnified: vi.fn(),
    checkSessionKickCooldown: vi.fn(async () => ({ kicked: false })),
}));

vi.mock('./playback-planner.service.js', () => ({
    playbackPlanner: {
        getPlan: vi.fn(),
        refreshPlan: vi.fn(),
        upgradePlan: vi.fn(),
    },
}));

vi.mock('../utils/logger.js', () => ({
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
import {
    createPlaybackSessionRow as startPlaySession,
    startPlaySession as startPlaybackSession,
    playbackCapabilitiesToProfile,
    enforceStreamPolicy,
    checkPlayMethodAllowed,
    getEffectivePolicy,
    reapStaleSessions,
    reapBootOrphanSessions,
} from './play-sessions.service.js';
import { toUserId } from '$lib/shared/user-id.js';

// Fixed valid users.id UUID for the branded userId param (mig 16.46.0).
const TEST_USER_ID = toUserId('11111111-1111-4111-8111-111111111111');
import { playbackPlanner } from './playback-planner.service.js';
import type { StartSessionRequest } from '../../schemas/play-sessions.js';
import { UNLIMITED_CONCURRENT_STREAMS } from '../../schemas/play-sessions.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeBody(overrides: Partial<StartSessionRequest> = {}): StartSessionRequest {
    return {
        media_id: 'media-uuid-1',
        device_id: 'device-1',
        requested: {
            play_method: 'direct',
            container: 'mp4',
            video_codec: 'h264',
            audio_codec: 'aac',
        },
        ...overrides,
    };
}

function makePlan(fileId: string) {
    return {
        plan_id: 'plan-uuid-1',
        intent: 'play' as const,
        delivery_path: 'mse_hls' as const,
        method: 'full_transcode' as const,
        video_action: 'transcode' as const,
        audio_action: 'copy' as const,
        subtitle_method: 'none' as const,
        transcode_reasons: ['codec incompatible'],
        needs_tonemapping: false,
        file_id: fileId,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1800_000).toISOString(),
    };
}

/**
 * Build a mock SQL that supports .begin() and responds to tagged template queries.
 * fileOwnership controls the EXISTS check for media_file_items ownership.
 */
function makeMockSql(fileOwnership: boolean = true, hasCurrentSession: boolean = true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlFn = (...args: any[]) => {
        // Tagged template: first arg is the template strings array
        const template = Array.isArray(args[0]) ? args[0].join('') : '';
        if (
            template.includes("purpose = 'prefetch'") ||
            template.includes('UPDATE play_sessions')
        ) {
            return Promise.resolve([]);
        }
        if (template.includes("purpose = 'play' AND NOT is_preview AND source = 'lumastra'")) {
            return Promise.resolve(
                hasCurrentSession ? [{ id: '22222222-2222-4222-8222-222222222222' }] : [],
            );
        }
        if (template.includes('media_file_items')) {
            return Promise.resolve([{ exists: fileOwnership }]);
        }
        // Default: satisfies runtime_seconds + count queries
        return Promise.resolve([{ count: '0', runtime_seconds: 120 }]);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sqlFn as any).begin = async (fn: (tx: any) => Promise<any>) => {
        return fn(sqlFn);
    };
    return sqlFn as unknown as Sql;
}

/**
 * Build a mock SQL for `enforceStreamPolicy`'s active-session count query.
 *
 * The real query builds its exclusion clause from two nested tagged-template
 * fragments (`AND id != ...` / `AND NOT (device_id = ... AND media_id = ...)`)
 * interpolated into the outer `WITH locked AS (...) SELECT COUNT(*)...` query.
 * Nested tag calls execute synchronously before the outer one, so this mock
 * recognizes each fragment by its joined literal-strings shape, remembers the
 * bound exclusion value(s), then applies them to `activeSessions` when the
 * outer count query (identified by `FOR UPDATE`) runs.
 */
function makePolicySql(activeSessions: Array<{ id: string; device_id: string; media_id: string }>) {
    let excludeSessionId: string | undefined;
    let excludeDeviceMedia: { device_id: string; media_id: string } | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlFn = (...args: any[]) => {
        const strings = args[0];
        const joined = Array.isArray(strings) ? strings.join('') : '';

        if (joined === 'AND id != ') {
            excludeSessionId = args[1];
            return Promise.resolve(undefined);
        }
        if (joined.startsWith('AND NOT (device_id')) {
            excludeDeviceMedia = { device_id: args[1], media_id: args[2] };
            return Promise.resolve(undefined);
        }
        if (joined === '') {
            return Promise.resolve(undefined);
        }
        if (joined.includes('UPDATE play_sessions')) {
            // Any direct UPDATE left in this path — the stale reap itself now
            // goes through claimStaleSessionsForUser (mocked), not raw SQL.
            return Promise.resolve([]);
        }
        if (joined.includes('FOR UPDATE')) {
            const filtered = activeSessions.filter((row) => {
                if (excludeSessionId && row.id === excludeSessionId) return false;
                if (
                    excludeDeviceMedia &&
                    row.device_id === excludeDeviceMedia.device_id &&
                    row.media_id === excludeDeviceMedia.media_id
                ) {
                    return false;
                }
                return true;
            });
            return Promise.resolve([{ count: String(filtered.length) }]);
        }
        // IP-restriction check or anything else unmatched in these tests.
        return Promise.resolve([]);
    };
    return sqlFn as unknown as Sql;
}

// ============================================================================
// Tests
// ============================================================================

describe('startPlaySession — plan/file coherence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 10,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });
        mockCreatePlaySession.mockResolvedValue({ id: 'session-1' });
    });

    it('passes the trusted peer to the plugin gate and refuses before creating a row', async () => {
        mockAuthorizePlayback.mockResolvedValueOnce({
            allow: false,
            deniedBy: 'policy-plugin',
            reason: 'Playback blocked',
        });
        const result = await startPlaySession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '203.0.113.42',
            makeBody(),
        );
        expect(mockAuthorizePlayback).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
                ipAddress: '203.0.113.42',
            }),
        );
        expect(result).toEqual({
            kind: 'plugin_denied',
            plugin: 'policy-plugin',
            reason: 'Playback blocked',
        });
        expect(mockCreatePlaySession).not.toHaveBeenCalled();
    });

    it('nullifies plan AND plan_id when plan.file_id does not match body.file_id', async () => {
        const plan = makePlan('file-AAA');
        vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan);

        const body = makeBody({
            plan_id: 'plan-uuid-1',
            file_id: 'file-BBB', // different from plan.file_id
        });

        // file-BBB does belong to media-uuid-1 (ownership passes), but plan was for file-AAA
        await startPlaySession(makeMockSql(true), TEST_USER_ID, 'user1', '127.0.0.1', body);

        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                plan_id: undefined,
                plan_mode: undefined,
                plan_reasons: undefined,
                delivery_path: undefined,
                file_id: 'file-BBB',
            }),
        );
    });

    it('passes plan fields through when file_id matches', async () => {
        const plan = makePlan('file-AAA');
        vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan);

        const body = makeBody({
            plan_id: 'plan-uuid-1',
            file_id: 'file-AAA',
        });

        await startPlaySession(makeMockSql(true), TEST_USER_ID, 'user1', '127.0.0.1', body);

        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                plan_id: 'plan-uuid-1',
                plan_mode: 'full_transcode',
                plan_reasons: ['codec incompatible'],
                delivery_path: 'mse_hls',
                file_id: 'file-AAA',
            }),
        );
    });

    it('passes plan fields when body has no file_id (no mismatch possible)', async () => {
        const plan = makePlan('file-AAA');
        vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan);

        const body = makeBody({ plan_id: 'plan-uuid-1' });

        await startPlaySession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', body);

        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                plan_mode: 'full_transcode',
                delivery_path: 'mse_hls',
            }),
        );
    });
});

describe('startPlaySession — file_id ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 10,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });
        mockCreatePlaySession.mockResolvedValue({ id: 'session-1' });
    });

    it('drops file_id when it does not belong to media_id', async () => {
        const body = makeBody({ file_id: 'unrelated-file' });

        // Ownership check returns false
        await startPlaySession(makeMockSql(false), TEST_USER_ID, 'user1', '127.0.0.1', body);

        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                file_id: undefined,
            }),
        );
    });

    it('preserves file_id when ownership check passes', async () => {
        const body = makeBody({ file_id: 'valid-file' });

        await startPlaySession(makeMockSql(true), TEST_USER_ID, 'user1', '127.0.0.1', body);

        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                file_id: 'valid-file',
            }),
        );
    });

    it('drops plan_id when file_id is dropped due to ownership failure', async () => {
        const plan = makePlan('unrelated-file');
        vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan);

        const body = makeBody({
            plan_id: 'plan-uuid-1',
            file_id: 'unrelated-file',
        });

        // File doesn't belong to item → file_id dropped → plan also dropped
        // because the plan was made for the rejected file
        await startPlaySession(makeMockSql(false), TEST_USER_ID, 'user1', '127.0.0.1', body);

        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                file_id: undefined,
                plan_id: undefined,
                plan_mode: undefined,
                plan_reasons: undefined,
                delivery_path: undefined,
            }),
        );
    });
});

describe('enforceStreamPolicy', () => {
    afterEach(() => {
        mockConfig.STREAM_LIMITS_ENFORCED = true;
        mockConfig.DEFAULT_MAX_CONCURRENT_STREAMS = 2;
        mockConfig.TRUST_CLIENT_LOCAL_PLAYBACK = false;
    });

    // The pre-count reap must reuse the shared claim rather than restating the
    // predicate. The hand-copied UPDATE it replaces had drifted from
    // staleSessionCondition (PAUSED measured from last_heartbeat_at instead of
    // paused_at), which is how a paused-but-heartbeating tab kept blocking its
    // owner's streams, and it skipped the audiobook reap-claim payload.
    it('reaps this user via the shared claim before counting', async () => {
        mockClaimStaleSessionsForUser.mockResolvedValue([{ id: 'stale-grant-session' }]);
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 2,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });

        const sql = makePolicySql([{ id: 'a', device_id: 'device-1', media_id: 'media-1' }]);
        const result = await enforceStreamPolicy(sql, TEST_USER_ID, 'user1', '127.0.0.1', 'direct');

        expect(result).toBeNull();
        expect(mockClaimStaleSessionsForUser).toHaveBeenCalledWith(sql, TEST_USER_ID);
        expect(revokeGrantsForPlaySession).toHaveBeenCalledWith(
            'stale-grant-session',
            sql,
            'reaped',
        );
        mockClaimStaleSessionsForUser.mockResolvedValue([]);
    });

    it('kill-switch off: skips the concurrent-count check even when over limit', async () => {
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 1,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });
        mockConfig.STREAM_LIMITS_ENFORCED = false;

        const sql = makePolicySql([
            { id: 'a', device_id: 'device-1', media_id: 'media-1' },
            { id: 'b', device_id: 'device-2', media_id: 'media-1' },
            { id: 'c', device_id: 'device-3', media_id: 'media-1' },
        ]);

        const result = await enforceStreamPolicy(sql, TEST_USER_ID, 'user1', '127.0.0.1', 'direct');

        expect(result).toBeNull();
    });

    it('unlimited sentinel (-1): skips the concurrent-count check no matter how many sessions are active', async () => {
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: UNLIMITED_CONCURRENT_STREAMS,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });

        const sql = makePolicySql([
            { id: 'a', device_id: 'device-1', media_id: 'media-1' },
            { id: 'b', device_id: 'device-2', media_id: 'media-2' },
            { id: 'c', device_id: 'device-3', media_id: 'media-3' },
        ]);

        const result = await enforceStreamPolicy(sql, TEST_USER_ID, 'user1', '127.0.0.1', 'direct');

        expect(result).toBeNull();
    });

    it('limit 0 still blocks all streams (0 is not unlimited)', async () => {
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 0,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });

        const sql = makePolicySql([]);

        const result = await enforceStreamPolicy(sql, TEST_USER_ID, 'user1', '127.0.0.1', 'direct');

        expect(result).toEqual({ kind: 'stream_limit_exceeded', active: 0, limit: 0 });
    });

    it('combined exclusion: an ACTIVE ghost row with the same device+media but a different session_id is not counted', async () => {
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 1,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });

        const sql = makePolicySql([
            { id: 'ghost-session', device_id: 'device-A', media_id: 'media-X' },
        ]);

        // Simulates a player quality-restart: client sends a NEW session_id
        // while the old row for the same (device_id, media_id) is still ACTIVE.
        const result = await enforceStreamPolicy(
            sql,
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            'direct',
            {
                session_id: 'new-session',
                device_id: 'device-A',
                media_id: 'media-X',
            },
        );

        expect(result).toBeNull();
    });

    it('regression guard: without the device+media exclusion the same ghost row trips the limit', async () => {
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 1,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });

        const sql = makePolicySql([
            { id: 'ghost-session', device_id: 'device-A', media_id: 'media-X' },
        ]);

        // Only session_id exclusion provided — the ghost row has a different
        // id, so it is not excluded and correctly counts against the limit.
        const result = await enforceStreamPolicy(
            sql,
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            'direct',
            {
                session_id: 'new-session',
            },
        );

        expect(result).toEqual({ kind: 'stream_limit_exceeded', active: 1, limit: 1 });
    });

    // C1 (security review 3, 2026-09-15): `session_id` is client-supplied
    // PlaySessionId, validated only by charset at the startHlsPlayback seam
    // (which also accepts non-UUID `preview-<uuid>` ids) — reaching this
    // shared enforcement function from every caller. Before this fix it was
    // bound unguarded into `AND id != ${session_id}` against `play_sessions.id`,
    // a `uuid` column: a non-UUID value raises Postgres error 22P02, which
    // surfaced to the client as an accidental 500 rather than a deliberate
    // decision. `media_id` (below, in startPlaySession) already has this guard;
    // `session_id` did not.
    describe('session_id UUID guard', () => {
        it('does not bind a non-UUID session_id into the id != exclusion (would 22P02 on a real uuid column)', async () => {
            mockGetEffectivePolicy.mockResolvedValue({
                max_concurrent_streams: 5,
                require_single_ip: false,
                ip_grace_period_seconds: 0,
                max_bitrate_kbps: null,
                allowed_play_methods: null,
            });

            let exclusionFragmentCalled = false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sqlFn = (...args: any[]) => {
                const strings = args[0];
                const joined = Array.isArray(strings) ? strings.join('') : '';
                if (joined === 'AND id != ') {
                    exclusionFragmentCalled = true;
                    return Promise.resolve(undefined);
                }
                if (joined.startsWith('AND NOT (device_id')) return Promise.resolve(undefined);
                if (joined === '') return Promise.resolve(undefined);
                if (joined.includes('UPDATE play_sessions')) return Promise.resolve([]);
                if (joined.includes('FOR UPDATE')) return Promise.resolve([{ count: '0' }]);
                return Promise.resolve([]);
            };

            const result = await enforceStreamPolicy(
                sqlFn as unknown as Sql,
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                'direct',
                { session_id: '../x' },
            );

            expect(exclusionFragmentCalled).toBe(false);
            expect(result).toBeNull();
        });

        it('still binds a real UUID session_id (dashed or dashless) into the exclusion', async () => {
            mockGetEffectivePolicy.mockResolvedValue({
                max_concurrent_streams: 5,
                require_single_ip: false,
                ip_grace_period_seconds: 0,
                max_bitrate_kbps: null,
                allowed_play_methods: null,
            });

            const seenExclusions: unknown[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sqlFn = (...args: any[]) => {
                const strings = args[0];
                const joined = Array.isArray(strings) ? strings.join('') : '';
                if (joined === 'AND id != ') {
                    seenExclusions.push(args[1]);
                    return Promise.resolve(undefined);
                }
                if (joined.startsWith('AND NOT (device_id')) return Promise.resolve(undefined);
                if (joined === '') return Promise.resolve(undefined);
                if (joined.includes('UPDATE play_sessions')) return Promise.resolve([]);
                if (joined.includes('FOR UPDATE')) return Promise.resolve([{ count: '0' }]);
                return Promise.resolve([]);
            };

            const dashedId = '22222222-2222-4222-8222-222222222222';
            await enforceStreamPolicy(
                sqlFn as unknown as Sql,
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                'direct',
                {
                    session_id: dashedId,
                },
            );

            const dashlessId = '33333333333343338333333333333333';
            await enforceStreamPolicy(
                sqlFn as unknown as Sql,
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                'direct',
                {
                    session_id: dashlessId,
                },
            );

            expect(seenExclusions).toEqual([dashedId, dashlessId]);
        });
    });
});

describe('checkPlayMethodAllowed', () => {
    it('null allows every method', () => {
        expect(checkPlayMethodAllowed({ allowed_play_methods: null }, 'full_transcode')).toBeNull();
    });

    it('refuses a method outside the list and suggests the first allowed one', () => {
        const policy = { allowed_play_methods: ['remux', 'direct'] };
        expect(checkPlayMethodAllowed(policy, 'remux')).toBeNull();
        expect(checkPlayMethodAllowed(policy, 'full_transcode')).toEqual({
            kind: 'transcode_not_allowed',
            allowed_methods: ['remux', 'direct'],
            suggestion: 'remux',
        });
    });
});

describe('getEffectivePolicy (service wrapper)', () => {
    afterEach(() => {
        mockConfig.DEFAULT_MAX_CONCURRENT_STREAMS = 2;
    });

    it('passes config.DEFAULT_MAX_CONCURRENT_STREAMS to the query-module fallback', async () => {
        mockConfig.DEFAULT_MAX_CONCURRENT_STREAMS = 7;
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 7,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });

        const fakeSql = {} as Sql;
        await getEffectivePolicy(fakeSql, 'someuser');

        expect(mockGetEffectivePolicy).toHaveBeenCalledWith(fakeSql, 'someuser', {
            max_concurrent_streams: 7,
        });
    });
});

// ============================================================================
// reapStaleSessions / reapBootOrphanSessions — completion backstop
//
// A session the reaper is about to CRASH may have actually been watched to
// completion (client-side recovery only re-establishes the stream, it never
// backfills the terminal COMPLETED report for the session that died). These
// verify the reap-time backstop promotes claimed rows crossing the completion
// threshold through the lifecycle service and leaves everything else CRASHED.
// ============================================================================

function makeCandidate(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sess-1',
        media_id: 'media-1',
        user_id: 'user-1',
        media_type: 'episode',
        position_ms: 0,
        runtime_ms: 1_440_000,
        last_event_seq: 3,
        ...overrides,
    };
}

describe('reapStaleSessions', () => {
    const fakeSql = {} as Sql;

    beforeEach(() => {
        mockClaimStaleSessions.mockReset();
        mockLifecycleUpdate.mockReset();
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockReset();
        mockGetPendingStaleSessions.mockImplementation(() => mockClaimStaleSessions(fakeSql));
        mockGetRetryableAudiobookSessionCloses.mockReset();
        mockGetRetryableAudiobookSessionCloses.mockResolvedValue([]);
        mockRecordStaleSessionAttempt.mockReset();
        mockRecordStaleSessionAttempt.mockResolvedValue(false);
        mockAbandonAudiobookSessionClose.mockReset();
        mockAbandonAudiobookSessionClose.mockResolvedValue(undefined);
        mockMarkStaleSessionProcessed.mockReset();
        mockMarkStaleSessionProcessed.mockResolvedValue(undefined);
        mockGetUsernamesByIds.mockReset();
        mockRetryPendingAudiobookSessionClose.mockReset();
        mockDefaultSessionDeps.mockReset();
        mockGetUsernamesByIds.mockResolvedValue(new Map());
        mockDefaultSessionDeps.mockResolvedValue({ client: {} });
        mockRetryPendingAudiobookSessionClose.mockResolvedValue({
            processed: true,
            sessionLost: false,
        });
    });

    it('finalizes a candidate past the completion threshold as COMPLETED instead of leaving it to crash', async () => {
        mockClaimStaleSessions.mockResolvedValue([
            makeCandidate({ id: 'finished-sess', position_ms: 1_300_000, last_event_seq: 4 }),
        ]);
        mockLifecycleUpdate.mockResolvedValue(undefined);

        const result = await reapStaleSessions(fakeSql);
        expect(revokeGrantsForPlaySession).toHaveBeenCalledWith('finished-sess', fakeSql, 'reaped');

        expect(mockLifecycleUpdate).toHaveBeenCalledTimes(1);
        expect(mockLifecycleUpdate).toHaveBeenCalledWith('finished-sess', {
            position_ms: 1_300_000,
            status: 'COMPLETED',
            event_seq: 5,
            end_reason: 'completion',
            // The reaper holds no play-time accumulator, so it reports 0.
            // That is not a lost value: `highest_session_elapsed_ms` is
            // ratcheted with GREATEST, so a 0 can never lower what a live
            // session already recorded.
            session_elapsed_ms: 0,
        });
        expect(result).toEqual({ crashed: 0, completed: 1 });
    });

    it('keeps a claimed candidate below the completion threshold crashed', async () => {
        mockClaimStaleSessions.mockResolvedValue([
            makeCandidate({ id: 'scrubbed-sess', position_ms: 100_000 }),
        ]);

        const result = await reapStaleSessions(fakeSql);

        expect(mockLifecycleUpdate).not.toHaveBeenCalled();
        expect(result).toEqual({ crashed: 1, completed: 0 });
    });

    it('skips candidates with no known runtime rather than dividing by zero', async () => {
        mockClaimStaleSessions.mockResolvedValue([
            makeCandidate({ id: 'no-runtime-sess', runtime_ms: null }),
        ]);

        const result = await reapStaleSessions(fakeSql);

        expect(mockLifecycleUpdate).not.toHaveBeenCalled();
        expect(result.completed).toBe(0);
    });

    it('does not let one failed finalize block the other claimed rows', async () => {
        mockClaimStaleSessions.mockResolvedValue([
            makeCandidate({ id: 'fails-sess', position_ms: 1_400_000, last_event_seq: 1 }),
            makeCandidate({ id: 'succeeds-sess', position_ms: 1_400_000, last_event_seq: 1 }),
        ]);
        mockLifecycleUpdate.mockRejectedValueOnce(new Error('db hiccup'));
        mockLifecycleUpdate.mockResolvedValueOnce(undefined);

        const result = await reapStaleSessions(fakeSql);

        expect(mockLifecycleUpdate).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ crashed: 1, completed: 1 });
    });

    it('closes an AudiobookShelf session only after the atomic local claim returns it', async () => {
        const userId = '11111111-1111-4111-8111-111111111111';
        const deps = { client: {} };
        mockClaimStaleSessions.mockResolvedValue([
            makeCandidate({
                user_id: userId,
                source: 'audiobookshelf',
                source_session_id: 'abs-stale-1',
                media_type: 'audiobook',
                position_ms: 1_234,
                runtime_ms: 5_678,
            }),
        ]);
        mockGetUsernamesByIds.mockResolvedValue(new Map([[userId, 'denis']]));
        mockDefaultSessionDeps.mockResolvedValue(deps);

        await reapStaleSessions(fakeSql);

        expect(mockRetryPendingAudiobookSessionClose).toHaveBeenCalledWith({
            sql: fakeSql,
            userId: TEST_USER_ID,
            username: 'denis',
            absSessionId: 'abs-stale-1',
            deps,
        });
        expect(mockMarkStaleSessionProcessed).toHaveBeenCalledWith(fakeSql, 'sess-1');
    });

    it('does not close an AudiobookShelf session revived before the atomic claim', async () => {
        mockClaimStaleSessions.mockResolvedValue([]);

        const result = await reapStaleSessions(fakeSql);

        expect(mockRetryPendingAudiobookSessionClose).not.toHaveBeenCalled();
        expect(result).toEqual({ crashed: 0, completed: 0 });
    });

    it('retries a durable stale claim on the next reaper after upstream cleanup fails', async () => {
        const userId = '11111111-1111-4111-8111-111111111111';
        const pending = makeCandidate({
            id: 'pending-stale',
            user_id: userId,
            source: 'audiobookshelf',
            source_session_id: 'abs-pending',
            media_type: 'audiobook',
            status: 'CRASHED',
        });
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockResolvedValue([pending]);
        mockGetUsernamesByIds.mockResolvedValue(new Map([[userId, 'denis']]));
        mockRetryPendingAudiobookSessionClose
            .mockResolvedValueOnce({ processed: false, sessionLost: false })
            .mockResolvedValueOnce({ processed: true, sessionLost: false });

        await reapStaleSessions(fakeSql);
        expect(mockMarkStaleSessionProcessed).not.toHaveBeenCalled();

        await reapStaleSessions(fakeSql);
        expect(mockRetryPendingAudiobookSessionClose).toHaveBeenCalledTimes(2);
        expect(mockMarkStaleSessionProcessed).toHaveBeenCalledOnce();
        expect(mockMarkStaleSessionProcessed).toHaveBeenCalledWith(fakeSql, 'pending-stale');
    });

    /**
     * Without this, a claim whose listener no longer exists is re-fetched and
     * re-attempted on every reap forever, and the pending set only ever grows.
     */
    it('burns an attempt when a claimed audiobook row has no resolvable listener', async () => {
        const pending = makeCandidate({
            id: 'orphan-listener',
            user_id: '11111111-1111-4111-8111-111111111111',
            source: 'audiobookshelf',
            source_session_id: 'abs-orphaned',
            media_type: 'audiobook',
            status: 'CRASHED',
        });
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockResolvedValue([pending]);
        // Deleted user — the id resolves to nothing.
        mockGetUsernamesByIds.mockResolvedValue(new Map());

        await reapStaleSessions(fakeSql);

        expect(mockRetryPendingAudiobookSessionClose).not.toHaveBeenCalled();
        expect(mockMarkStaleSessionProcessed).not.toHaveBeenCalled();
        expect(mockRecordStaleSessionAttempt).toHaveBeenCalledWith(fakeSql, 'orphan-listener');
    });

    it('burns an attempt when the upstream close could not be applied', async () => {
        const userId = '11111111-1111-4111-8111-111111111111';
        const pending = makeCandidate({
            id: 'stuck-close',
            user_id: userId,
            source: 'audiobookshelf',
            source_session_id: 'abs-stuck',
            media_type: 'audiobook',
            status: 'CRASHED',
        });
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockResolvedValue([pending]);
        mockGetUsernamesByIds.mockResolvedValue(new Map([[userId, 'denis']]));
        mockRetryPendingAudiobookSessionClose.mockResolvedValue({
            processed: false,
            sessionLost: false,
        });

        await reapStaleSessions(fakeSql);

        expect(mockMarkStaleSessionProcessed).not.toHaveBeenCalled();
        expect(mockRecordStaleSessionAttempt).toHaveBeenCalledWith(fakeSql, 'stuck-close');
    });

    it('retires an unusable close from the audiobook drain instead of retrying forever', async () => {
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockResolvedValue([]);
        const stuck = makeCandidate({
            id: 'no-listener-close',
            user_id: '11111111-1111-4111-8111-111111111111',
            source: 'audiobookshelf',
            source_session_id: 'abs-no-listener',
            media_type: 'audiobook',
            status: 'COMPLETED',
        });
        mockGetRetryableAudiobookSessionCloses.mockResolvedValue([stuck]);
        mockGetUsernamesByIds.mockResolvedValue(new Map());

        await reapStaleSessions(fakeSql);

        expect(mockRetryPendingAudiobookSessionClose).not.toHaveBeenCalled();
        expect(mockAbandonAudiobookSessionClose).toHaveBeenCalledWith(fakeSql, stuck);
    });

    it('resumes a previously claimed row after a process-like interruption', async () => {
        const pending = makeCandidate({ id: 'interrupted', status: 'CRASHED' });
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockResolvedValue([pending]);

        await reapStaleSessions(fakeSql);

        expect(mockLifecycleUpdate).not.toHaveBeenCalled();
        expect(mockMarkStaleSessionProcessed).toHaveBeenCalledWith(fakeSql, 'interrupted');
    });

    it('sweeps a failed normal audiobook close without another client request', async () => {
        const userId = '11111111-1111-4111-8111-111111111111';
        mockClaimStaleSessions.mockResolvedValue([]);
        mockGetPendingStaleSessions.mockResolvedValue([]);
        mockGetRetryableAudiobookSessionCloses.mockResolvedValue([
            makeCandidate({
                id: 'normal-close',
                user_id: userId,
                source: 'audiobookshelf',
                source_session_id: 'abs-normal-pending',
                media_type: 'audiobook',
                status: 'COMPLETED',
            }),
        ]);
        mockGetUsernamesByIds.mockResolvedValue(new Map([[userId, 'denis']]));

        await reapStaleSessions(fakeSql);

        expect(mockRetryPendingAudiobookSessionClose).toHaveBeenCalledWith({
            sql: fakeSql,
            userId: TEST_USER_ID,
            username: 'denis',
            absSessionId: 'abs-normal-pending',
            deps: { client: {} },
        });
        expect(mockMarkStaleSessionProcessed).not.toHaveBeenCalled();
    });
});

describe('reapBootOrphanSessions', () => {
    const fakeSql = {} as Sql;

    beforeEach(() => {
        mockClaimBootOrphanSessions.mockReset();
        mockLifecycleUpdate.mockReset();
        mockGetPendingStaleSessions.mockReset();
        mockMarkStaleSessionProcessed.mockReset();
        mockGetRetryableAudiobookSessionCloses.mockReset();
        mockGetRetryableAudiobookSessionCloses.mockResolvedValue([]);
        mockRetryPendingAudiobookSessionClose.mockReset();
        mockRecordStaleSessionAttempt.mockReset();
        mockRecordStaleSessionAttempt.mockResolvedValue(false);
        mockAbandonAudiobookSessionClose.mockReset();
        mockAbandonAudiobookSessionClose.mockResolvedValue(undefined);
        mockClaimBootOrphanSessions.mockResolvedValue([]);
        // The pending backlog is what the reaper actually processes; by default
        // it mirrors whatever this call claimed.
        mockGetPendingStaleSessions.mockImplementation(() => mockClaimBootOrphanSessions(fakeSql));
    });

    it('forwards graceSeconds to the atomic claim', async () => {
        await reapBootOrphanSessions(fakeSql, 90);

        expect(mockClaimBootOrphanSessions).toHaveBeenCalledWith(fakeSql, 90);
    });

    it('finalizes a boot-orphaned candidate that already crossed completion', async () => {
        mockClaimBootOrphanSessions.mockResolvedValue([
            makeCandidate({ id: 'finished-sess', position_ms: 1_400_000, last_event_seq: 2 }),
        ]);
        mockLifecycleUpdate.mockResolvedValue(undefined);

        const result = await reapBootOrphanSessions(fakeSql, 0);

        expect(mockLifecycleUpdate).toHaveBeenCalledWith('finished-sess', {
            position_ms: 1_400_000,
            status: 'COMPLETED',
            event_seq: 3,
            end_reason: 'completion',
            // The reaper holds no play-time accumulator, so it reports 0.
            // That is not a lost value: `highest_session_elapsed_ms` is
            // ratcheted with GREATEST, so a 0 can never lower what a live
            // session already recorded.
            session_elapsed_ms: 0,
        });
        expect(result).toEqual({ crashed: 0, completed: 1 });
    });

    /**
     * The regression this whole path exists for: a deploy kills an in-flight
     * audiobook session, and unless the boot reaper stamps the same reap payload
     * as the stale reaper, nothing can ever find the row to close the upstream
     * AudiobookShelf session.
     */
    it('routes claimed boot orphans through the same pending-close drain', async () => {
        const orphan = makeCandidate({
            id: 'abs-orphan',
            // A real UUID: the service brands this through toUserId, which
            // rejects the default placeholder id.
            user_id: '11111111-1111-4111-8111-111111111111',
            position_ms: 10_000,
            source: 'audiobookshelf',
            source_session_id: 'abs-1',
            media_type: 'audiobook',
        });
        mockClaimBootOrphanSessions.mockResolvedValue([orphan]);
        mockGetUsernamesByIds.mockResolvedValue(new Map([[orphan.user_id.toLowerCase(), 'anna']]));
        mockDefaultSessionDeps.mockResolvedValue({});
        mockRetryPendingAudiobookSessionClose.mockResolvedValue({
            processed: true,
            sessionLost: false,
        });

        await reapBootOrphanSessions(fakeSql, 0);

        expect(mockRetryPendingAudiobookSessionClose).toHaveBeenCalledWith(
            expect.objectContaining({ absSessionId: 'abs-1', username: 'anna' }),
        );
        expect(mockMarkStaleSessionProcessed).toHaveBeenCalledWith(fakeSql, 'abs-orphan');
    });
});

/**
 * The exemption array that reaches the SQL.
 *
 * `unmeteredSources()` being correct (covered in play-sessions.queries.test.ts)
 * proves nothing on its own — the question here is whether enforceStreamPolicy
 * actually asks it, and asks it with the operator's setting. A wiring mistake
 * that read the constant instead of the function would leave every unit test
 * on both sides green while quietly making the config flag inert.
 *
 * Asserted on the bound VALUE rather than a rendered string: the array is
 * interpolated as a parameter, so it is observable directly and the assertion
 * cannot drift with SQL whitespace.
 */
describe('enforceStreamPolicy — the exemption array bound into the count query', () => {
    afterEach(() => {
        mockConfig.TRUST_CLIENT_LOCAL_PLAYBACK = false;
    });

    /** Captures every array argument bound into the FOR UPDATE count query. */
    function makeCapturingSql(captured: string[][]): Sql {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlFn = (...args: any[]) => {
            const strings = args[0];
            const joined = Array.isArray(strings) ? strings.join('') : '';
            if (joined.includes('FOR UPDATE')) {
                for (const arg of args.slice(1)) {
                    if (Array.isArray(arg) && arg.every((v) => typeof v === 'string')) {
                        captured.push(arg as string[]);
                    }
                }
                return Promise.resolve([{ count: '0' }]);
            }
            return Promise.resolve([]);
        };
        return sqlFn as unknown as Sql;
    }

    async function exemptionArrayWithTrust(trust: boolean): Promise<string[]> {
        mockConfig.TRUST_CLIENT_LOCAL_PLAYBACK = trust;
        mockClaimStaleSessionsForUser.mockResolvedValue([]);
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: 2,
            require_single_ip: false,
            ip_grace_period_seconds: 0,
            max_bitrate_kbps: null,
            allowed_play_methods: null,
        });
        const captured: string[][] = [];
        await enforceStreamPolicy(
            makeCapturingSql(captured),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            'direct',
        );
        expect(captured).toHaveLength(1);
        return captured[0];
    }

    it('omits local when the operator has not opted in — the default', async () => {
        // The security-relevant direction. If this regresses, any client that
        // sends is_local_playback opts itself out of the stream limit.
        expect(await exemptionArrayWithTrust(false)).toEqual(['jellyfin', 'subsonic']);
    });

    it('includes local once the operator opts in', async () => {
        expect(await exemptionArrayWithTrust(true)).toEqual(['jellyfin', 'subsonic', 'local']);
    });
});

// Public start coverage complements the row/policy invariants above.
import { PlaybackStartResponseSchema } from '$lib/schemas/playback-start.js';

const START_MEDIA_ID = '22222222-2222-4222-8222-222222222222';
const START_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const START_FILE_ID = '44444444-4444-4444-8444-444444444444';
const START_GRANT = {
    ipPinned: true,
    playbackSessionId: START_SESSION_ID,
    id: '55555555-5555-4555-8555-555555555555',
    token: 'stream_start_test',
    param: 'grant' as const,
    expiresAt: new Date('2026-10-18T00:00:00.000Z'),
    renewAfter: new Date('2026-10-17T23:55:00.000Z'),
    renewHref: '/api/v1/playback/grants/55555555-5555-4555-8555-555555555555/renew',
};
// The grant an audiobook session returns: same credential, the book's identity.
const AUDIOBOOK_GRANT = { ...START_GRANT, mediaId: START_MEDIA_ID, kind: 'audiobook' as const };
const START_CAPS = {
    containers: ['mp4'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    subtitleFormats: ['vtt'],
    hdr: [],
    maxVideoBitrateBps: 5_000_000,
    maxHeight: 1080,
    maxAudioChannels: 2,
};
function startInfo(recommended: 'direct' | 'remux' = 'remux') {
    return {
        ok: true,
        deliveryPaths: {
            direct: `/api/playback/${START_MEDIA_ID}/file?fileId=${START_FILE_ID}`,
            remux: `/api/playback/${START_MEDIA_ID}/hls?videoCodec=copy&audioCodec=copy&fileId=${START_FILE_ID}&api_key=account-secret&stream_token=retired-jwt`,
            audio_transcode: `/api/playback/${START_MEDIA_ID}/hls?audioCodec=aac`,
            full_transcode: `/api/playback/${START_MEDIA_ID}/hls?videoCodec=h264`,
            audio_only: `/api/playback/${START_MEDIA_ID}/hls?videoCodec=none`,
        },
        data: {
            playable: true,
            recommended,
            active_file_id: START_FILE_ID,
            transcode_reasons: recommended === 'remux' ? ['container'] : [],
            resume_position_ms: 12000,
            duration_ms: 120000,
            stream_start_position_ms: 0,
            client_should_seek: true,
            tracks: {
                video: { codec: 'h264', width: 1920, height: 1080, hdr: 'sdr', container: 'mp4' },
                audio: [],
                subtitles: [
                    {
                        index: 2,
                        codec: 'srt',
                        language: 'en',
                        title: null,
                        default: false,
                        forced: false,
                        method: 'external_vtt',
                    },
                ],
            },
            externalSubtitles: [
                {
                    language: 'en',
                    format: 'srt',
                    id: 'sub-1',
                },
            ],
            // Package 9's descriptor list: built on the caller's surface, hrefs ungranted.
            subtitles: [
                {
                    id: `${START_FILE_ID}:2`,
                    index: 2,
                    kind: 'embedded',
                    codec: 'srt',
                    language: 'en',
                    default: false,
                    forced: false,
                    format: 'text',
                    hrefs: {
                        text: `/api/playback/${START_MEDIA_ID}/subtitles/2.vtt?fileId=${START_FILE_ID}`,
                    },
                },
            ],
            trickplay: { width: 320, interval: 10000 },
            play_methods: {
                direct: {
                    available: recommended === 'direct',
                },
                remux: {
                    available: true,
                },
                audio_transcode: {
                    available: true,
                },
                full_transcode: {
                    available: true,
                },
                audio_only: {
                    available: true,
                },
            },
        },
    };
}
function assertStartEnvelope(value: unknown) {
    const result = PlaybackStartResponseSchema.parse(value);
    expect(result.reporting.playbackSessionId).toBe(result.playbackSessionId);
    expect(result.reporting).toMatchObject({ kind: 'progress', method: 'PUT', unit: 'ms' });
    expect(result.grant.param).toBe('grant');
    expect(JSON.stringify(result)).not.toMatch(/api_key|stream_token|account-secret|retired-jwt/);
    const walk = (node: unknown): void => {
        if (
            typeof node === 'string' &&
            node.startsWith('/api/') &&
            !node.includes('/play-sessions/') &&
            !node.includes('/grants/')
        ) {
            const url = new URL(node, 'https://test.invalid');
            expect(url.searchParams.get('grant')).toBe(START_GRANT.token);
            expect(url.searchParams.get('PlaySessionId')).toBe(result.playbackSessionId);
        } else if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(result.delivery);
    return result;
}

describe('startPlaybackSession — public delivery envelopes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMediaItemById.mockResolvedValue({ media_type: 'movie', runtime_seconds: 120 });
        mockBuildPlaybackStartInfo.mockResolvedValue(startInfo());
        // The minter stamps the grant with the media and kind it was minted for.
        mockMintPlaybackGrant.mockImplementation(
            async (input: { mediaId: string; kind: string }) => ({
                ...START_GRANT,
                mediaId: input.mediaId,
                kind: input.kind,
            }),
        );
        mockCreatePlaySession.mockResolvedValue({ id: START_SESSION_ID });
        mockGetEffectivePolicy.mockResolvedValue({
            max_concurrent_streams: -1,
            require_single_ip: false,
            allowed_play_methods: null,
        });
        mockClaimStaleSessionsForUser.mockResolvedValue([]);
        vi.mocked(playbackPlanner.getPlan).mockResolvedValue(null);
    });

    it.each(['internal', 'v1'] as const)(
        'starts radio on %s with a scoped live proxy URL',
        async (surface) => {
            mockGetMediaItemById.mockResolvedValue({ media_type: 'radio', runtime_seconds: 120 });
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'radio-device',
                },
                'web',
                { surface },
            );
            expect(result).toMatchObject({
                kind: 'music',
                mediaId: START_MEDIA_ID,
                playbackSessionId: START_SESSION_ID,
                delivery: {
                    kind: 'file',
                    live: true,
                    container: 'unknown',
                    playMethod: 'direct',
                    startPositionMs: 0,
                    durationMs: null,
                },
                reporting: { kind: 'progress', method: 'PUT', unit: 'ms', intervalMs: 10_000 },
            });
            if (!('delivery' in result) || !('url' in result.delivery))
                throw new Error('Missing delivery');
            const url = new URL(result.delivery.url, 'https://server.example');
            expect(url.pathname).toBe(
                surface === 'v1'
                    ? `/api/v1/music/radio/stations/${START_MEDIA_ID}/stream`
                    : `/api/music/radio/${START_MEDIA_ID}/stream`,
            );
            expect(url.searchParams.get('grant')).toBe(START_GRANT.token);
            expect(url.searchParams.get('PlaySessionId')).toBe(START_SESSION_ID);
            expect(mockBuildPlaybackStartInfo).not.toHaveBeenCalled();
            expect(mockMintPlaybackGrant).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'music',
                    mediaId: START_MEDIA_ID,
                    playbackSessionId: START_SESSION_ID,
                }),
            );
        },
    );

    it.each([
        { purpose: 'prefetch' as const },
        { startPositionMs: 1 },
        { audio: { format: 'mp3' } },
        { audio: { download: true } },
        { requestedMethod: 'audio_transcode' as const },
        { fileId: '22222222-2222-4222-8222-222222222222' },
    ])('refuses unsupported radio controls before allocating: %j', async (controls) => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'radio' });
        expect(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                ...controls,
            }),
        ).toMatchObject({ status: 422 });
        expect(mockCreatePlaySession).not.toHaveBeenCalled();
        expect(mockMintPlaybackGrant).not.toHaveBeenCalled();
    });

    it.each([undefined, 180_000])(
        'bounds a complete alternate resume beyond its duration (%s)',
        async (startPositionMs) => {
            const info = startInfo();
            info.data.resume_position_ms = 180_000;
            mockBuildPlaybackStartInfo.mockResolvedValue(info);
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    capabilities: START_CAPS,
                    startPositionMs,
                },
            );
            expect(result).toMatchObject({
                delivery: { startPositionMs: 119_000, durationMs: 120_000 },
            });
            expect(mockCreatePlaySession).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ position_ms: 119_000 }),
            );
        },
    );

    it.each(['movie'])('stores trimmed client metadata for %s starts', async (media_type) => {
        mockGetMediaItemById.mockResolvedValue({ media_type });
        await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                clientInfo: {
                    client: ' Apple ',
                    version: ' 1.0.1 (2610140823) ',
                    userAgent: ` ${'a'.repeat(250)} `,
                },
            },
            'web',
            {
                clientName: 'Header client',
                clientVersion: 'Header version',
                userAgent: 'header agent',
            },
        );
        expect(mockCreatePlaySession).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({
                client_name: 'Apple',
                client_version: '1.0.1 (2610140823)',
                user_agent: 'a'.repeat(200),
            }),
        );
    });

    it('caps client name/version and falls back to the request User-Agent', async () => {
        await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                clientInfo: {
                    client: ` ${'c'.repeat(250)} `,
                    version: ` ${'v'.repeat(250)} `,
                    userAgent: ' ',
                },
            },
            'unknown',
            { userAgent: ` ${'h'.repeat(250)} ` },
        );
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                client_name: 'c'.repeat(200),
                client_version: 'v'.repeat(200),
                user_agent: 'h'.repeat(200),
            }),
        );
    });

    it('does not substitute the server build when client metadata is absent', async () => {
        await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
            },
            'unknown',
            { userAgent: ' Header Agent ' },
        );
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                client_name: undefined,
                client_version: undefined,
                user_agent: 'Header Agent',
            }),
        );
    });

    it.each(['internal', 'v1'] as const)(
        'normalizes ids and emits %s surface URLs',
        async (surface) => {
            const mediaId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
            mockGetMediaItemById.mockResolvedValue({ media_type: 'track' });
            const result = assertStartEnvelope(
                await startPlaybackSession(
                    makeMockSql(),
                    TEST_USER_ID,
                    'user1',
                    '127.0.0.1',
                    {
                        mediaId: mediaId.toUpperCase(),
                        deviceId: 'device',
                        capabilities: { containers: ['mp3'], audioCodecs: ['mp3'] },
                    },
                    'web',
                    { surface, mintedByAdmin: true },
                ),
            );
            const prefix = surface === 'v1' ? '/api/v1' : '/api';
            expect(mockGetMediaItemById).toHaveBeenCalledWith(expect.anything(), mediaId);
            expect(mockMintPlaybackGrant).toHaveBeenCalledWith(
                expect.objectContaining({ mediaId, mintedByAdmin: true, surface }),
            );
            expect(result.mediaId).toBe(mediaId);
            expect(mockReportMusicSessionStart).not.toHaveBeenCalled();
            expect(result.delivery).toMatchObject({
                url: expect.stringContaining(`${prefix}/music/tracks/${mediaId}/stream`),
            });
            expect(result.reporting.href).toBe(`${prefix}/play-sessions/${START_SESSION_ID}`);
            expect(result.grant.renewHref).toBe(
                `${prefix}/playback/grants/${START_GRANT.id}/renew`,
            );
        },
    );

    it.each(['internal', 'v1'] as const)(
        '%s video start timeline is mounted and followed verbatim by the web client',
        async (surface) => {
            const start = assertStartEnvelope(
                await startPlaybackSession(
                    makeMockSql(),
                    TEST_USER_ID,
                    'user1',
                    '127.0.0.1',
                    { mediaId: START_MEDIA_ID, deviceId: 'device', capabilities: START_CAPS },
                    'web',
                    { surface },
                ),
            );
            if (!('timeline' in start.delivery) || !start.delivery.timeline)
                throw new Error('video start has no timeline');
            const issued = start.delivery.timeline.href;
            const url = new URL(issued, 'http://localhost');
            const prefix = surface === 'v1' ? '/api/v1' : '/api';
            expect(url.pathname).toBe(`${prefix}/playback/${START_MEDIA_ID}/timeline`);
            expect(url.searchParams.get('fileId')).toBe(START_FILE_ID);
            expect(url.searchParams.get('grant')).toBe(START_GRANT.token);
            expect(url.searchParams.get('PlaySessionId')).toBe(START_SESSION_ID);
            const pathParam = surface === 'v1' ? '[id]' : '[itemId]';
            const mountSource = readFileSync(
                `src/routes${prefix}/playback/${pathParam}/timeline/+server.ts`,
                'utf8',
            );
            expect(mountSource).toContain('GET');
            expect(mountSource).toContain(`surface: '${surface}'`);
            // Drive the issued URL through the actual mounted timeline handler,
            // keeping its file selector and response schema in the contract.
            const connection = await import('$lib/server/database/connection.js');
            const access = await import('$lib/server/middleware/media-access.js');
            const selection =
                await import('$lib/server/database/queries/media-file-resolution.queries.js');
            const chapters = await import('$lib/server/services/playback-chapters.service.js');
            const segments = await import('$lib/server/services/media-segments.service.js');
            const trickplay =
                await import('$lib/server/database/queries/trickplay-params.queries.js');
            const analysis = await import('$lib/server/database/queries/media-segments.queries.js');
            const spies = [
                vi.spyOn(connection, 'getDb').mockReturnValue(makeMockSql()),
                vi.spyOn(access, 'checkMediaAccess').mockResolvedValue(true),
                vi.spyOn(selection, 'resolvePlaybackSelection').mockResolvedValue({
                    fileId: START_FILE_ID,
                    files: [{ id: START_FILE_ID, duration_seconds: 120 }],
                } as never),
                vi.spyOn(chapters, 'resolveEffectiveChapters').mockResolvedValue([]),
                vi.spyOn(segments, 'createMediaSegmentsService').mockReturnValue({
                    getSegments: async () => [],
                } as never),
                vi.spyOn(trickplay, 'getTrickplayParams').mockResolvedValue([]),
                vi
                    .spyOn(trickplay, 'getTrickplayAvailability')
                    .mockResolvedValue({ state: 'pending', widths: [] }),
                vi.spyOn(analysis, 'getSegmentAnalysisStatus').mockResolvedValue('analyzed'),
            ];
            try {
                const { def: timelineDef } =
                    await import('$lib/server/api/defs/playback/timeline.js');
                timelineGet.mockImplementationOnce(async (href, schema) => {
                    const response = await mount(timelineDef, { surface }).GET!({
                        url: new URL(href, 'http://localhost'),
                        request: new Request(new URL(href, 'http://localhost')),
                        params: { [pathParam.slice(1, -1)]: START_MEDIA_ID },
                        locals: {
                            ...principalLocals({
                                kind: 'session',
                                ownerIsAdmin: false,
                                userId: TEST_USER_ID,
                            }),
                            resolvedIds: { internalId: START_MEDIA_ID },
                        },
                    } as unknown as RequestEvent);
                    expect(response.status).toBe(200);
                    return { status: response.status, data: schema.parse(await response.json()) };
                });
                const result = await getTimelineByHref(issued);
                expect(result.data).toMatchObject({ fileId: START_FILE_ID, durationMs: 120000 });
                expect(selection.resolvePlaybackSelection).toHaveBeenCalledWith(
                    expect.anything(),
                    START_MEDIA_ID,
                    { fileId: START_FILE_ID },
                );
                expect(timelineGet).toHaveBeenLastCalledWith(issued, expect.anything());
            } finally {
                spies.forEach((spy) => spy.mockRestore());
            }
        },
    );

    it.each(['mint', 'delivery', 'audiobook'] as const)(
        'ends the committed session after %s fails',
        async (failure) => {
            const error = new Error('start failed');
            mockStopSession.mockResolvedValue({ id: START_SESSION_ID });
            if (failure === 'mint') mockMintPlaybackGrant.mockRejectedValueOnce(error);
            if (failure === 'delivery') {
                const info = startInfo('direct');
                Object.assign(info.data.tracks.video, { container: undefined });
                mockBuildPlaybackStartInfo.mockResolvedValue(info);
            }
            if (failure === 'audiobook') {
                mockGetMediaItemById.mockResolvedValue({ media_type: 'audiobook' });
                mockOpenAudiobookSession.mockResolvedValue({
                    ok: true,
                    playbackSessionId: START_SESSION_ID,
                    grant: AUDIOBOOK_GRANT,
                    sourceTracks: [],
                    sourceChapters: [],
                    payload: { tracks: [], chapters: [] },
                });
            }
            await expect(
                startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    capabilities: { containers: ['mp4', 'mp3'] },
                }),
            ).rejects.toThrow();
            expect(mockStopSession).toHaveBeenCalledWith(
                expect.anything(),
                START_SESSION_ID,
                0,
                'error',
            );
            expect(revokeGrantsForPlaySession).toHaveBeenCalledWith(
                START_SESSION_ID,
                expect.anything(),
                'stopped',
            );
        },
    );

    it('adapts typed capabilities into the planner profile, including quality and HDR limits', () => {
        const profile = playbackCapabilitiesToProfile({ ...START_CAPS, hdr: ['hdr10'] });
        expect(profile.videoCodecs).toEqual(new Set(['h264']));
        expect(profile.hdrFormats).toEqual(new Set(['hdr10']));
        expect(profile.maxBitrate).toBe(5000000);
        expect(profile.maxHeight).toBe(1080);
        expect(profile.maxAudioChannels).toBe(2);
    });

    it('returns HLS with one session id and granted subtitle/preview URLs', async () => {
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
            }),
        );
        expect(mockMintPlaybackGrant.mock.calls[0][0]).not.toHaveProperty('ttl');
        expect(mockMintPlaybackGrant.mock.calls[0][0].castTarget).toBeUndefined();
        expect(result.kind).toBe('video');
        expect(result.delivery.kind).toBe('hls');
        expect(result.delivery).toMatchObject({ startPositionMs: 12000 });
        if (result.delivery.kind !== 'hls') throw new Error('Expected HLS delivery');
        expect(result.delivery.subtitles).toHaveLength(1);
        const subtitleHref = new URL(
            result.delivery.subtitles[0].hrefs.text ?? '',
            'https://test.invalid',
        );
        expect(subtitleHref.searchParams.get('grant')).toBe(START_GRANT.token);
        expect(subtitleHref.searchParams.get('PlaySessionId')).toBe(START_SESSION_ID);
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ position_ms: 12000, device_capabilities: START_CAPS }),
        );
        expect(mockMintPlaybackGrant).toHaveBeenCalledWith(
            expect.objectContaining({
                playbackSessionId: START_SESSION_ID,
                mediaId: START_MEDIA_ID,
                kind: 'video',
            }),
        );
    });

    it('passes an explicit cast request to the grant minter', async () => {
        await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
            mediaId: START_MEDIA_ID,
            deviceId: 'cast',
            capabilities: START_CAPS,
            castTarget: true,
        });
        expect(mockMintPlaybackGrant).toHaveBeenCalledWith(
            expect.objectContaining({ castTarget: true, clientIp: '127.0.0.1' }),
        );
    });

    it('returns a direct video file and honors an explicit millisecond start position', async () => {
        mockBuildPlaybackStartInfo.mockResolvedValue(startInfo('direct'));
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                startPositionMs: 45000,
            }),
        );
        expect(result.delivery.kind).toBe('file');
        expect(result.delivery).toMatchObject({ startPositionMs: 45000 });
    });

    it('keeps the required remux when a client requests direct', async () => {
        const result = await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                requestedMethod: 'direct',
            },
        );
        expect(result).toMatchObject({ delivery: { playMethod: 'remux' } });
        expect(mockCreatePlaySession).toHaveBeenCalled();
        expect(mockMintPlaybackGrant).toHaveBeenCalled();
    });

    it('passes the selected absolute audio index into start planning', async () => {
        await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
            mediaId: START_MEDIA_ID,
            deviceId: 'device',
            capabilities: START_CAPS,
            audioStreamIndex: 4,
        });
        expect(mockBuildPlaybackStartInfo.mock.calls[0][0]).toMatchObject({ audioStreamIndex: 4 });
    });

    it('normalises an upper-case fileId like the mediaId before it reaches the decision', async () => {
        await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
            mediaId: START_MEDIA_ID.toUpperCase(),
            fileId: '9C2E0000-0000-4000-8000-00000000ABCD',
            deviceId: 'device',
            capabilities: START_CAPS,
        });
        expect(mockBuildPlaybackStartInfo.mock.calls[0][0]).toMatchObject({
            internalId: START_MEDIA_ID.toLowerCase(),
            fileId: '9c2e0000-0000-4000-8000-00000000abcd',
        });
    });

    it('starts a video without capabilities on the documented H.264 and AAC/MP3 default', async () => {
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
            }),
        );
        expect(result.kind).toBe('video');
        const { clientCaps } = mockBuildPlaybackStartInfo.mock.calls[0][0];
        expect(clientCaps.videoCodecs).toEqual(new Set(['h264']));
        expect(clientCaps.audioCodecs).toEqual(new Set(['aac', 'mp3']));
        expect(clientCaps.containers).toEqual(new Set(['mp4', 'ts', 'mp3', 'm4a']));
        expect(clientCaps.subtitleFormats).toEqual(new Set(['vtt']));
    });

    it.each([0, 99])(
        'ignores audio index %s on a silent video and persists no audio selection',
        async (audioStreamIndex) => {
            const result = assertStartEnvelope(
                await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    capabilities: START_CAPS,
                    audioStreamIndex,
                }),
            );
            expect(result.kind).toBe('video');
            expect(mockCreatePlaySession).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ audio_stream_index: undefined }),
            );
            expect(JSON.stringify(result.delivery)).not.toContain('audioStreamIndex');
            expect(JSON.stringify(result.delivery)).not.toContain('hlsAudioTrack');
        },
    );

    it('falls back to default absolute audio for a stale index and reports the applied selection', async () => {
        const info = startInfo();
        mockBuildPlaybackStartInfo.mockResolvedValue({
            ...info,
            data: {
                ...info.data,
                tracks: {
                    ...info.data.tracks,
                    audio: [
                        {
                            index: 0,
                            absoluteIndex: 1,
                            codec: 'aac',
                            channels: 2,
                            language: 'en',
                            title: null,
                            default: false,
                        },
                        {
                            index: 1,
                            absoluteIndex: 4,
                            codec: 'aac',
                            channels: 2,
                            language: 'en',
                            title: null,
                            default: true,
                        },
                    ],
                },
            },
        });
        const result = await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                audioStreamIndex: 99,
            },
        );
        const start = assertStartEnvelope(result);
        expect(start.delivery).toMatchObject({
            applied: {
                audioStreamIndex: 4,
                subtitleId: 'none',
            },
        });
        expect(
            'url' in start.delivery &&
                new URL(start.delivery.url, 'https://test.invalid').searchParams.get(
                    'hlsAudioTrack',
                ),
        ).toBe('4');
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ audio_stream_index: 4 }),
        );
    });

    it('reports the upgraded plan audio layout and keeps an explicit second audio track', async () => {
        // Firefly S01E11 (2026-11-01): German + English DTS, tvOS asked for audio_transcode on a
        // remux-recommended file. The HLS job muxes ONE track, so the start response must say
        // `muxed` (the player cannot switch language itself) and carry the picked track.
        const info = startInfo();
        mockBuildPlaybackStartInfo.mockResolvedValue({
            ...info,
            data: {
                ...info.data,
                plan_id: 'plan-1',
                subtitles: [],
                tracks: {
                    ...info.data.tracks,
                    subtitles: [],
                    audio: [
                        {
                            index: 0,
                            absoluteIndex: 1,
                            codec: 'dts',
                            channels: 6,
                            language: 'ger',
                            title: 'DTS',
                            default: true,
                        },
                        {
                            index: 1,
                            absoluteIndex: 2,
                            codec: 'dts',
                            channels: 6,
                            language: 'eng',
                            title: 'DTS',
                            default: false,
                        },
                    ],
                },
            },
        });
        vi.mocked(playbackPlanner.upgradePlan).mockResolvedValue('muxed');
        const start = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                requestedMethod: 'audio_transcode',
                audioStreamIndex: 2,
                subtitleId: 'none',
            }),
        );
        expect(playbackPlanner.upgradePlan).toHaveBeenCalledWith(
            'plan-1',
            'audio_transcode',
            false,
        );
        expect(start.delivery).toMatchObject({
            playMethod: 'audio_transcode',
            hlsAudioMode: 'muxed',
            applied: { audioStreamIndex: 2, subtitleId: 'none' },
        });
        expect(
            'url' in start.delivery &&
                new URL(start.delivery.url, 'https://test.invalid').searchParams.get(
                    'hlsAudioTrack',
                ),
        ).toBe('2');
    });

    it.each([undefined, 'full_transcode'] as const)(
        'upgrades compatible request %s for burn-in subtitles',
        async (requestedMethod) => {
            const info = startInfo();
            info.data.tracks.subtitles[0].method = 'burn_in';
            mockBuildPlaybackStartInfo.mockResolvedValue(info);
            const start = assertStartEnvelope(
                await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    capabilities: START_CAPS,
                    requestedMethod,
                    subtitleId: `${START_FILE_ID}:2`,
                }),
            );
            expect(start.delivery).toMatchObject({ playMethod: 'full_transcode' });
            expect(
                'url' in start.delivery &&
                    new URL(start.delivery.url, 'https://test.invalid').searchParams.get(
                        'SubtitleMethod',
                    ),
            ).toBe('Encode');
        },
    );

    it('reports the encoder and output HDR of a requested full transcode after a remux probe', async () => {
        const info = startInfo();
        info.data.tracks.video.codec = 'hevc';
        info.data.tracks.video.hdr = 'hdr10';
        Object.assign(info.data, { output_hdr: 'hdr10', transcode_codec: null });
        mockBuildPlaybackStartInfo.mockResolvedValue(info);
        const start = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
                requestedMethod: 'full_transcode',
            }),
        );
        expect(start.delivery).toMatchObject({ transcodeCodec: 'h264', outputHdr: 'sdr' });
    });

    it('maps the recommended audio track to its absolute stream index and keeps the subtitle index', async () => {
        const info = startInfo('remux');
        mockBuildPlaybackStartInfo.mockResolvedValue({
            ...info,
            data: {
                ...info.data,
                tracks: {
                    ...info.data.tracks,
                    audio: [
                        {
                            index: 0,
                            absoluteIndex: 3,
                            codec: 'aac',
                            channels: 2,
                            language: 'en',
                            title: null,
                            default: true,
                            forced: false,
                        },
                        {
                            index: 1,
                            absoluteIndex: 4,
                            codec: 'ac3',
                            channels: 6,
                            language: 'ja',
                            title: null,
                            default: false,
                            forced: false,
                        },
                    ],
                },
                recommended_tracks: { audio_track_index: 1, subtitle_track_index: 2 },
            },
        });
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
            }),
        );
        expect('recommended' in result.delivery && result.delivery.recommended).toEqual({
            audioStreamIndex: 4,
            subtitleId: `${START_FILE_ID}:2`,
        });
        expect(result.delivery).toMatchObject({ applied: { audioStreamIndex: 4 } });
        expect(
            'url' in result.delivery &&
                new URL(result.delivery.url, 'https://test.invalid').searchParams.get(
                    'hlsAudioTrack',
                ),
        ).toBe('4');
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ audio_stream_index: 4 }),
        );
    });

    it.each([
        { audioStreamIndex: undefined, subtitleId: undefined },
        { audioStreamIndex: 3, subtitleId: undefined },
        { audioStreamIndex: 4, subtitleId: undefined },
        { audioStreamIndex: undefined, subtitleId: 'none' },
    ])(
        'applies safe defaults without advisory recommendations and preserves explicit choices %j',
        async ({ audioStreamIndex, subtitleId }) => {
            const info = startInfo('remux');
            const audio = [
                {
                    index: 0,
                    absoluteIndex: 3,
                    codec: 'aac',
                    channels: 2,
                    language: 'en',
                    title: 'Audio Description',
                    default: true,
                    forced: false,
                },
                {
                    index: 1,
                    absoluteIndex: 4,
                    codec: 'aac',
                    channels: 2,
                    language: 'de',
                    title: 'Main',
                    default: false,
                    forced: false,
                },
            ];
            mockBuildPlaybackStartInfo.mockResolvedValue({
                ...info,
                data: {
                    ...info.data,
                    tracks: {
                        ...info.data.tracks,
                        audio,
                        subtitles: [
                            { ...info.data.tracks.subtitles[0], language: 'de', forced: true },
                        ],
                    },
                    subtitles: [{ ...info.data.subtitles[0], language: 'de', forced: true }],
                },
            });
            const result = assertStartEnvelope(
                await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    capabilities: START_CAPS,
                    audioStreamIndex,
                    subtitleId,
                }),
            );
            const applied = audioStreamIndex ?? 4;
            expect(result.delivery).toMatchObject({
                applied: {
                    audioStreamIndex: applied,
                    subtitleId: subtitleId ?? (applied === 4 ? `${START_FILE_ID}:2` : 'none'),
                },
            });
            expect('recommended' in result.delivery && result.delivery.recommended).toBeUndefined();
            expect(
                'url' in result.delivery &&
                    new URL(result.delivery.url, 'https://test.invalid').searchParams.get(
                        'hlsAudioTrack',
                    ),
            ).toBe(String(applied));
            expect(mockCreatePlaySession).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ audio_stream_index: applied }),
            );
        },
    );

    it('adopts a stable sidecar recommendation when subtitleId is omitted', async () => {
        const info = startInfo('remux');
        mockBuildPlaybackStartInfo.mockResolvedValue({
            ...info,
            data: {
                ...info.data,
                recommended_tracks: { audio_track_index: 0, subtitle_id: 'sidecar-fr' },
                subtitles: [
                    {
                        ...info.data.subtitles[0],
                        id: 'sidecar-fr',
                        index: 1001,
                        language: 'fr',
                        kind: 'external',
                        hrefs: {
                            text: `/api/playback/${START_MEDIA_ID}/subtitles/external/sidecar-fr?fileId=${START_FILE_ID}`,
                        },
                    },
                ],
            },
        });
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
            }),
        );
        expect(result.delivery).toMatchObject({
            applied: { subtitleId: 'sidecar-fr' },
            recommended: { subtitleId: 'sidecar-fr' },
            subtitles: [expect.objectContaining({ id: 'sidecar-fr', method: 'external_vtt' })],
        });
        expect(
            'url' in result.delivery &&
                new URL(result.delivery.url, 'https://test.invalid').searchParams.get(
                    'SubtitleStreamIndex',
                ),
        ).toBeNull();
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ subtitle_stream_index: undefined }),
        );
    });

    it.each([undefined, 'none', `${START_FILE_ID}:2`, 'sub-1', 'foreign'])(
        'applies omitted/explicit subtitleId %s before creating delivery',
        async (subtitleId) => {
            const info = startInfo('remux');
            Object.assign(info.data, { recommended_tracks: { subtitle_track_index: 2 } });
            info.data.subtitles.push({
                ...info.data.subtitles[0],
                id: 'sub-1',
                index: 1000,
                kind: 'external',
            });
            mockBuildPlaybackStartInfo.mockResolvedValue(info);
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                { mediaId: START_MEDIA_ID, deviceId: 'device', subtitleId },
            );
            if (subtitleId === 'foreign') {
                expect(result).toMatchObject({ status: 422 });
                expect(mockCreatePlaySession).not.toHaveBeenCalled();
                return;
            }
            expect(result).toMatchObject({
                delivery: { applied: { subtitleId: subtitleId ?? `${START_FILE_ID}:2` } },
            });
            if (
                'delivery' in result &&
                (result.delivery.kind === 'hls' || result.delivery.kind === 'file')
            ) {
                const url = new URL(result.delivery.url, 'https://test.invalid');
                expect(url.searchParams.get('SubtitleStreamIndex')).toBe(
                    subtitleId === 'none' || subtitleId === 'sub-1' ? null : '2',
                );
            }
        },
    );

    it.each([undefined, 'none', `${START_FILE_ID}:2`, 'foreign'])(
        'audio_only ignores preferred subtitles but rejects explicit subtitle %s',
        async (subtitleId) => {
            const info = startInfo('remux');
            Object.assign(info.data, { recommended_tracks: { subtitle_track_index: 2 } });
            mockBuildPlaybackStartInfo.mockResolvedValue(info);
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    requestedMethod: 'audio_only',
                    subtitleId,
                },
            );
            if (subtitleId !== undefined && subtitleId !== 'none') {
                expect(result).toMatchObject({ status: 422 });
                expect(mockCreatePlaySession).not.toHaveBeenCalled();
            } else {
                expect(result).toMatchObject({
                    delivery: { playMethod: 'audio_only', applied: { subtitleId: 'none' } },
                });
                expect(mockBuildPlaybackStartInfo.mock.calls[0][0].subtitleId).toBe('none');
            }
        },
    );

    it('upgrades a client request with a closed client_requested reason', async () => {
        const result = await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            { mediaId: START_MEDIA_ID, deviceId: 'device', requestedMethod: 'full_transcode' },
        );
        expect(result).toMatchObject({
            delivery: { playMethod: 'full_transcode', reasonCodes: [{ code: 'client_requested' }] },
        });
    });

    it.each(['remux', 'audio_transcode', 'audio_only'] as const)(
        'rejects burn-in with incompatible explicit %s',
        async (requestedMethod) => {
            const info = startInfo('remux');
            info.data.tracks.subtitles[0].method = 'burn_in';
            mockBuildPlaybackStartInfo.mockResolvedValue(info);
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    subtitleId: `${START_FILE_ID}:2`,
                    requestedMethod,
                },
            );
            expect(result).toMatchObject({ status: 422 });
            expect(mockCreatePlaySession).not.toHaveBeenCalled();
        },
    );

    it.each(['movie', 'episode', 'audiobook'])(
        'rejects prefetch for %s before allocation',
        async (media_type) => {
            mockGetMediaItemById.mockResolvedValue({ media_type });
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    purpose: 'prefetch',
                },
            );
            expect(result).toMatchObject({
                status: 422,
                message: 'purpose=prefetch is supported only for music tracks',
            });
            expect(mockCreatePlaySession).not.toHaveBeenCalled();
            expect(mockMintPlaybackGrant).not.toHaveBeenCalled();
        },
    );

    it('refuses prefetch without a current deck before minting any delivery grant', async () => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'track', runtime_seconds: 120 });
        const result = await startPlaybackSession(
            makeMockSql(true, false),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            { mediaId: START_MEDIA_ID, deviceId: 'device', purpose: 'prefetch' },
        );
        expect(result).toEqual({ kind: 'prefetch_requires_current_session' });
        expect(mockCreatePlaySession).not.toHaveBeenCalled();
        expect(mockMintPlaybackGrant).not.toHaveBeenCalled();
    });

    it('music prefetch persists its purpose and returns ordinary delivery', async () => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'track', runtime_seconds: 120 });
        const result = await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                purpose: 'prefetch',
            },
        );
        expect(result).toMatchObject({ kind: 'music', playbackSessionId: START_SESSION_ID });
        expect(mockCreatePlaySession).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ purpose: 'prefetch' }),
        );
    });

    it('video rejects audio-only options', async () => {
        const result = await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            { mediaId: START_MEDIA_ID, deviceId: 'device', audio: { format: 'opus' } },
        );
        expect(result).toMatchObject({ status: 422 });
        expect(mockCreatePlaySession).not.toHaveBeenCalled();
    });

    it('omits delivery.recommended when the planner recommends no tracks', async () => {
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
            }),
        );
        expect(
            'recommended' in result.delivery ? result.delivery.recommended : undefined,
        ).toBeUndefined();
    });

    it('refuses a tvchannel start with 422, names the Live TV endpoint, and creates nothing', async () => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'tvchannel' });
        const result = await startPlaybackSession(
            makeMockSql(),
            TEST_USER_ID,
            'user1',
            '127.0.0.1',
            {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: START_CAPS,
            },
        );
        expect(result).toMatchObject({
            status: 422,
            message: expect.stringContaining('/livetv/playback-sessions'),
        });
        expect(mockCreatePlaySession).not.toHaveBeenCalled();
        expect(mockMintPlaybackGrant).not.toHaveBeenCalled();
    });

    it('passes the declared audiobook containers as MIME types, drops unknown ones, and passes nothing when omitted', async () => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'audiobook' });
        mockOpenAudiobookSession.mockResolvedValue({
            ok: true,
            playbackSessionId: START_SESSION_ID,
            grant: AUDIOBOOK_GRANT,
            sourceTracks: [
                {
                    index: 1,
                    ino: 'private-inode-a',
                    startOffset: 0,
                    duration: 20,
                    mimeType: 'audio/mpeg',
                },
            ],
            sourceChapters: [{ start: 0, end: 20, title: 'Chapter' }],
            payload: {
                playMethod: 'direct',
                startPositionMs: 0,
                durationMs: 20000,
            },
        });
        const sql = Object.assign(makeMockSql(), { json: (value: unknown) => value });
        const declared = await startPlaybackSession(sql, TEST_USER_ID, 'user1', '127.0.0.1', {
            mediaId: START_MEDIA_ID,
            deviceId: 'device',
            capabilities: { containers: ['mp3', 'm4b', 'mkv'] },
        });
        expect(declared).toMatchObject({ kind: 'audiobook' });
        expect(mockOpenAudiobookSession.mock.calls[0][0].supportedMimeTypes).toEqual([
            'audio/mpeg',
            'audio/mp4',
        ]);
        await startPlaybackSession(sql, TEST_USER_ID, 'user1', '127.0.0.1', {
            mediaId: START_MEDIA_ID,
            deviceId: 'device',
        });
        expect(mockOpenAudiobookSession.mock.calls[1][0].supportedMimeTypes).toBeUndefined();
    });

    it.each(['internal', 'v1'] as const)(
        'music downloads use Bearer byte delivery, never a %s listening start',
        async (surface) => {
            mockGetMediaItemById.mockResolvedValue({ media_type: 'track', runtime_seconds: 120 });
            const result = await startPlaybackSession(
                makeMockSql(),
                TEST_USER_ID,
                'user1',
                '127.0.0.1',
                {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'download',
                    audio: { download: true },
                },
                'web',
                { surface },
            );
            expect(result).toMatchObject({
                status: 422,
                message: expect.stringContaining('download=1'),
            });
            expect(mockCreatePlaySession).not.toHaveBeenCalled();
            expect(mockMintPlaybackGrant).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['opus', 'audio/ogg; codecs=opus'],
        ['aac', 'audio/aac'],
    ])('POST starts FLAC as %s without capabilities', async (format, contentType) => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'track', runtime_seconds: 120 });
        const { def } = await import('$lib/server/api/defs/play-sessions/index.js');
        const sql = makeMockSql();
        const { aiDbService } = await import('./database.service.js');
        vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        const access = await import('../middleware/media-access.js');
        vi.spyOn(access, 'checkMediaAccess').mockResolvedValue(true);
        const event = {
            request: new Request('https://test.invalid/api/v1/play-sessions', { method: 'POST' }),
            getClientAddress: () => '127.0.0.1',
            locals: { user: { userId: TEST_USER_ID, username: 'user1' } },
        } as unknown as RequestEvent;
        const response = await def.handlers.POST!(event, {
            surface: 'v1',
            input: {
                body: {
                    mediaId: START_MEDIA_ID,
                    deviceId: 'device',
                    audio: { format, bitrateKbps: 160 },
                },
            },
        } as never);
        expect(response.status).toBe(201);
        const result = await response.json();
        const envelope = PlaybackStartResponseSchema.parse(result);
        expect(envelope).toMatchObject({
            kind: 'music',
            delivery: { kind: 'file', playMethod: 'audio_transcode', codec: format },
        });
        if (envelope.delivery.kind !== 'file') throw new Error('Expected file delivery');
        const source = await import('./music-transcode/stream-source.js');
        vi.spyOn(source, 'resolveStreamSource').mockResolvedValue({
            kind: 'ok',
            trackId: START_MEDIA_ID,
            containerPath: '/music/source.flac',
            fileSize: 1000,
            mtimeMs: 1,
        });
        vi.spyOn(source, 'probeAudioSourceCached').mockResolvedValue({
            codec: 'flac',
            container: 'flac',
            bitrate: 800000,
            channels: 2,
            sampleRate: 44100,
            bitDepth: 16,
        });
        const { createMusicStreamHandlers } = await import('./music-transcode/route-handler.js');
        const head = await createMusicStreamHandlers({
            source: 'public-api',
            deviceId: () => 'device',
            loggerName: 'test',
        }).HEAD({
            ...event,
            params: { id: START_MEDIA_ID },
            url: new URL(envelope.delivery.url, 'https://test.invalid'),
            request: new Request(new URL(envelope.delivery.url, 'https://test.invalid'), {
                method: 'HEAD',
            }),
        } as RequestEvent);
        expect(head.status).toBe(200);
        expect(head.headers.get('content-type')).toBe(contentType);
    });

    it('returns music file delivery with requested format and bitrate without counting allocation', async () => {
        mockGetMediaItemById.mockResolvedValue({ media_type: 'track', runtime_seconds: 120 });
        const result = assertStartEnvelope(
            await startPlaybackSession(makeMockSql(), TEST_USER_ID, 'user1', '127.0.0.1', {
                mediaId: START_MEDIA_ID,
                deviceId: 'device',
                capabilities: { containers: ['mp3'], audioCodecs: ['mp3'] },
                audio: { format: 'mp3', bitrateKbps: 192 },
            }),
        );
        expect(result.kind).toBe('music');
        expect(result.delivery.kind).toBe('file');
        if (result.delivery.kind !== 'file') throw new Error('Expected music file');
        const url = new URL(result.delivery.url, 'https://test.invalid');
        expect(url.pathname).toBe(`/api/v1/music/tracks/${START_MEDIA_ID}/stream`);
        expect(url.searchParams.get('format')).toBe('mp3');
        expect(url.searchParams.get('bitrateKbps')).toBe('192');
        expect(mockReportMusicSessionStart).not.toHaveBeenCalled();
    });

    it.each(['direct', 'transcode'] as const)(
        'returns audiobook %s delivery with no upstream identifiers and millisecond spans',
        async (playMethod) => {
            mockGetMediaItemById.mockResolvedValue({ media_type: 'audiobook' });
            mockOpenAudiobookSession.mockResolvedValue({
                ok: true,
                playbackSessionId: START_SESSION_ID,
                grant: AUDIOBOOK_GRANT,
                sourceTracks:
                    playMethod === 'direct'
                        ? [
                              {
                                  index: 1,
                                  ino: 'private-inode-a',
                                  startOffset: 0,
                                  duration: 10.5,
                                  mimeType: 'audio/mpeg',
                              },
                              {
                                  index: 2,
                                  ino: 'private-inode-b',
                                  startOffset: 10.5,
                                  duration: 9.5,
                                  mimeType: 'audio/mp4',
                                  needsRemux: true,
                              },
                          ]
                        : [{ index: 1, startOffset: 0, duration: 20 }],
                sourceChapters: [{ start: 0, end: 20, title: 'Chapter' }],
                payload: {
                    absSessionId: 'private-upstream-session',
                    streamToken: START_GRANT.token,
                    playMethod,
                    startPositionMs: 5500,
                    durationMs: 20000,
                },
            });
            const sql = Object.assign(makeMockSql(), { json: (value: unknown) => value });
            const result = assertStartEnvelope(
                await startPlaybackSession(
                    sql,
                    TEST_USER_ID,
                    'user1',
                    '127.0.0.1',
                    {
                        mediaId: START_MEDIA_ID,
                        deviceId: 'device',
                        capabilities: { containers: ['mp3', 'm4b'] },
                        castTarget: true,
                        clientInfo: {
                            client: ' Apple ',
                            version: ' 1.0.1 (2610140823) ',
                            userAgent: ' Apple agent ',
                        },
                    },
                    'unknown',
                    { userAgent: 'Header agent' },
                ),
            );
            expect(mockOpenAudiobookSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    castTarget: true,
                    clientName: 'Apple',
                    clientVersion: '1.0.1 (2610140823)',
                    userAgent: 'Apple agent',
                }),
            );
            expect(result.kind).toBe('audiobook');
            expect(result.playbackSessionId).toBe(START_SESSION_ID);
            expect(JSON.stringify(result)).not.toMatch(
                /private-upstream|private-inode|absSessionId|streamToken/,
            );
            if (result.delivery.kind !== 'multipart-audio')
                throw new Error('Expected multipart audiobook');
            expect(result.delivery.chapters[0]).toEqual({
                index: 0,
                name: 'Chapter',
                startMs: 0,
                endMs: 20000,
            });
            expect(result.delivery.tracks[0].durationMs).toBe(
                playMethod === 'direct' ? 10500 : 20000,
            );
            expect(JSON.stringify(result.delivery)).not.toContain('trackIndex=');
            if (playMethod === 'direct')
                expect(result.delivery.tracks[1].remuxUrl).toContain(
                    '/audiobooks/' + START_MEDIA_ID + '/remux/2?',
                );
            else {
                // A transcoded book is one HLS playlist for the whole book.
                expect(result.delivery.tracks).toHaveLength(1);
                expect(result.delivery.tracks[0].mime).toBe('application/vnd.apple.mpegurl');
                expect(result.delivery.tracks[0].url).toContain(
                    `/hls/playback/${START_SESSION_ID}/`,
                );
            }
        },
    );

    // The byte-proxy routes exist only under /api/v1. The web player starts through the
    // internal mount (`POST /api/play-sessions`), whose surface is 'internal': deriving the
    // delivery URLs from it produced /api/audiobook/... (404, no server log) and the toast
    // "Playback failed - couldn't play this audiobook" on every click in "Jump back in".
    it.each(['direct', 'transcode'] as const)(
        'emits /api/v1 audiobook %s delivery URLs when started through the internal mount',
        async (playMethod) => {
            mockGetMediaItemById.mockResolvedValue({ media_type: 'audiobook' });
            mockOpenAudiobookSession.mockResolvedValue({
                ok: true,
                playbackSessionId: START_SESSION_ID,
                grant: AUDIOBOOK_GRANT,
                sourceTracks:
                    playMethod === 'direct'
                        ? [
                              {
                                  index: 1,
                                  ino: 'private-inode-a',
                                  startOffset: 0,
                                  duration: 10,
                                  mimeType: 'audio/mp4',
                                  needsRemux: true,
                              },
                          ]
                        : [{ index: 1, startOffset: 0, duration: 10 }],
                sourceChapters: [{ start: 0, end: 10, title: 'Chapter' }],
                payload: { playMethod, startPositionMs: 0, durationMs: 10000 },
            });
            const sql = Object.assign(makeMockSql(), { json: (value: unknown) => value });
            const result = assertStartEnvelope(
                await startPlaybackSession(
                    sql,
                    TEST_USER_ID,
                    'user1',
                    '127.0.0.1',
                    {
                        mediaId: START_MEDIA_ID,
                        deviceId: 'device',
                        capabilities: { containers: ['mp3', 'm4b'] },
                    },
                    'web',
                    { surface: 'internal' },
                ),
            );
            if (result.delivery.kind !== 'multipart-audio')
                throw new Error('Expected multipart audiobook');
            const urls = result.delivery.tracks.flatMap((track) =>
                [track.url, track.remuxUrl].filter((u): u is string => typeof u === 'string'),
            );
            expect(urls.length).toBeGreaterThan(0);
            for (const url of urls) {
                expect(new URL(url, 'https://test.invalid').pathname).toMatch(
                    new RegExp(
                        `^/api/v1/(audiobooks/${START_MEDIA_ID}/(files|remux)|audiobook/${START_MEDIA_ID}/hls)/`,
                    ),
                );
            }
            // Reporting and grant renewal do have an internal-surface route: unchanged.
            expect(result.reporting.href).toBe(`/api/play-sessions/${START_SESSION_ID}`);
        },
    );
});
