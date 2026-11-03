// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Focused tests for the content-addressed preview cache wiring in
 * createPreview (Task 5 of the Coordinated Preview Subsystem).
 *
 * Uses a REAL PreviewCacheStore pointed at a temp dir (not a mock) so the
 * single-flight `acquire()` semantics are genuinely exercised, while every
 * other createPreview dependency (ffprobe, planner, DB query modules,
 * FFmpeg transcode service) is mocked to keep this a fast unit test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

const USER_1: UserId = toUserId('11110000-0000-4000-a000-000000000000');

// ---------------------------------------------------------------------------
// Config mocks — controllable per-test via mockConfig.*
// ---------------------------------------------------------------------------

const mockConfig = vi.hoisted(() => ({
    PREVIEW_CACHE_ENABLED: true,
    PREVIEW_FORCE_UNIVERSAL_CODEC: true,
    PREVIEW_TRANSCODE_MAX_SECONDS: 30,
    PREVIEW_VIDEO_CODEC: 'h264' as const,
    PREVIEW_CACHE_DIR: '',
    PREVIEW_CACHE_MAX_BYTES: 10 * 1024 * 1024 * 1024,
    TRAILER_MAX_SECONDS: 360,
}));

// Spread the real module so named exports consumed through the (real)
// playback-grant -> task-registry import chain (e.g. FEATURE_PER_TASK_QUEUES)
// exist; only `config` is overridden.
vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    config: new Proxy(mockConfig, {
        get(target, prop: string) {
            return target[prop as keyof typeof target];
        },
    }),
}));

const configServiceValues = vi.hoisted(
    () =>
        new Map<string, unknown>([
            ['PREVIEW_MAX_WIDTH', 1280],
            ['PREVIEW_MAX_HEIGHT', 720],
            ['PREVIEW_ENCODING_PRESET', 'veryfast'],
            ['PREVIEW_NVENC_PRESET', 'p1'],
            ['PREVIEW_MAX_LIVETV_PER_SERVER', 10],
        ]),
);

vi.mock('$lib/server/config/config.service.js', () => ({
    get: vi.fn((key: string) => configServiceValues.get(key)),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ---------------------------------------------------------------------------
// FFmpeg transcode service — the thing we're asserting is called once
// ---------------------------------------------------------------------------

// A stateful fake of the transcode service's in-memory job map: startJob
// registers a live job under its playSessionId, stopJob removes it, and getJob
// reflects that liveness. This models the real invariant createPreview /
// findReusablePreview now depend on — a cache-backed artifact is only
// serveable while its in-memory job (`preview-cache-<key>`) is resident.
const { mockStartJob, mockStopJob, mockGetJob, startedArtifactJobs } = vi.hoisted(() => ({
    mockStartJob: vi.fn(),
    mockStopJob: vi.fn(),
    mockGetJob: vi.fn(),
    startedArtifactJobs: new Map<string, { id: string; status: string; config: unknown }>(),
}));

vi.mock('./ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: vi.fn().mockReturnValue({
        startJob: mockStartJob,
        stopJob: mockStopJob,
        getJob: mockGetJob,
    }),
}));

// ---------------------------------------------------------------------------
// Valkey / cache plumbing used by addPreviewSession / getPreviewSession etc.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheSet: vi.fn().mockResolvedValue(true),
    cacheDel: vi.fn().mockResolvedValue(1),
    getKeysByPattern: vi.fn().mockResolvedValue([]),
    setIfNotExists: vi.fn().mockResolvedValue(false),
    getValkeyClient: vi.fn().mockReturnValue(null),
    getCoordinationClient: vi.fn().mockReturnValue(null),
    publishMessage: vi.fn().mockResolvedValue(true),
    subscribeToChannel: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('$lib/server/cache/unified-cache', () => ({
    UnifiedCache: function UnifiedCache() {
        return {
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
        };
    },
}));

// ---------------------------------------------------------------------------
// Media resolution / probing / planning dependencies
// ---------------------------------------------------------------------------

vi.mock('$lib/server/utils/ffprobe.js', () => ({
    probeMediaFile: vi.fn().mockResolvedValue({
        success: true,
        video: {
            codec: 'hevc',
            pixelFormat: 'yuv420p10le',
            profile: 'main10',
            level: 150,
            width: 1920,
            height: 1080,
            bitrate: 8_000_000,
            hdr: 'sdr',
        },
        audioStreams: [{ codec: 'aac', channels: 2 }],
        formatBitrate: 8_000_000,
        container: 'mkv',
    }),
    containerFromExtension: vi.fn().mockReturnValue('mkv'),
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn().mockResolvedValue({
        isAccessible: true,
        containerPath: '/data/movie.mkv',
    }),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: vi.fn().mockResolvedValue([
        {
            id: 'file-1',
            file_path: '/media/movie.mkv',
        },
    ]),
}));

vi.mock('$lib/server/database/queries/media-streams.queries.js', () => ({
    getAudioStreamsForMediaItem: vi.fn().mockResolvedValue([]),
    getStreamsForMediaItem: vi.fn().mockResolvedValue([{ stream_type: 'video' }]),
}));

vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn().mockResolvedValue('movie'),
}));

vi.mock('$lib/server/database/queries/media-extras.queries.js', () => ({
    findLocalTrailerForItem: vi.fn(),
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: vi.fn().mockResolvedValue(null) },
}));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: vi.fn().mockResolvedValue(null) },
}));

vi.mock('$lib/server/utils/media-stream-mapper.js', () => ({
    dbRowToAudioStreamInfo: vi.fn(),
    dbRowToAudioTrackInfo: vi.fn(),
}));

vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getNextUpForSeries: vi.fn(),
        getNextUpForSeason: vi.fn(),
    },
}));

vi.mock('$lib/server/services/playback-planner.service.js', () => ({
    playbackPlanner: {
        createPlan: vi.fn().mockResolvedValue({
            plan: { target_video_codec: 'h264', plan_id: 'plan-1' },
        }),
    },
}));

vi.mock('$lib/server/services/info.service.js', () => ({
    defaultBrowserCaps: vi.fn().mockReturnValue({
        videoCodecs: new Set(['h264']),
        audioCodecs: new Set(['aac']),
        containers: new Set(['mp4']),
        canSwitchAudioInDirectPlay: false,
    }),
    buildServerEncodeCaps: vi.fn().mockResolvedValue({}),
    parseBitDepth: vi.fn().mockReturnValue(10),
    parseLanguagePreferences: vi.fn(),
}));

const mintPreviewGrant = vi.hoisted(() => vi.fn());
vi.mock('./playback-grant', async (original) => ({
    ...(await original<typeof import('./playback-grant')>()),
    mintPlaybackGrant: mintPreviewGrant,
    revokeGrantsForPlaySession: vi.fn().mockResolvedValue(0),
}));

// Import after all mocks are registered.
import {
    createPreview,
    deletePreview,
    findReusablePreview,
    getPreviewSession,
    type CreatePreviewResult,
} from './preview-session.service.js';
import { __resetPreviewCacheStoreForTests } from './preview-cache.store.js';
import { findLocalTrailerForItem } from '$lib/server/database/queries/media-extras.queries.js';
import type { Sql } from 'postgres';
import {
    getStreamsForMediaItem,
    type MediaStreamRow,
} from '$lib/server/database/queries/media-streams.queries.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index.js';
import {
    dbRowToAudioStreamInfo,
    dbRowToAudioTrackInfo,
} from '$lib/server/utils/media-stream-mapper.js';

import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { parseLanguagePreferences } from '$lib/server/services/info.service.js';

const TRAILER_UUID = 'trailer-child-uuid';
const TRAILER_REUSE_UUID = 'trailer-child-reuse-uuid';

// A fake `sql` tagged-template function backing only `resolveFileVersion` —
// every other DB access in createPreview goes through the mocked query
// modules above, so this is the sole real "SQL call" this test observes.
function makeFakeSql(
    row: {
        file_hash_head: string | null;
        file_size_bytes: number | null;
        file_mtime: Date | null;
    } | null,
    statements?: string[],
): Sql {
    const fn = vi.fn(async (parts: TemplateStringsArray): Promise<unknown[]> => {
        statements?.push(parts.join('?'));
        return row ? [row] : [];
    });
    return fn as unknown as Sql;
}

function isResult(r: unknown): r is CreatePreviewResult {
    return typeof r === 'object' && r !== null && 'playSessionId' in r;
}

describe('createPreview — content-addressed preview cache wiring', () => {
    let tempDir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.PREVIEW_CACHE_ENABLED = true;
        mockConfig.PREVIEW_FORCE_UNIVERSAL_CODEC = true;
        mockConfig.PREVIEW_TRANSCODE_MAX_SECONDS = 30;
        mockConfig.PREVIEW_VIDEO_CODEC = 'h264';
        tempDir = mkdtempSync(join(tmpdir(), 'preview-cache-test-'));
        mockConfig.PREVIEW_CACHE_DIR = tempDir;
        mockConfig.PREVIEW_CACHE_MAX_BYTES = 10 * 1024 * 1024 * 1024;
        __resetPreviewCacheStoreForTests();

        startedArtifactJobs.clear();
        mockStartJob.mockImplementation(
            async (cfg: { playSessionId: string; outputDir?: string; cacheKey?: string }) => {
                const job = { id: cfg.playSessionId, status: 'running', config: cfg };
                startedArtifactJobs.set(cfg.playSessionId, job);
                return job;
            },
        );
        mockStopJob.mockImplementation(async (playSessionId: string) => {
            startedArtifactJobs.delete(playSessionId);
        });
        mockGetJob.mockImplementation((playSessionId: string) =>
            startedArtifactJobs.get(playSessionId),
        );
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('mints bound grants for Bearer preview creation and reuse', async () => {
        mintPreviewGrant.mockImplementation(async (params: { playbackSessionId: string }) => ({
            token: 'stream_preview',
            playbackSessionId: params.playbackSessionId,
        }));
        const created = await createPreview({
            sql: makeFakeSql({
                file_hash_head: 'hash-bearer',
                file_size_bytes: 1000,
                file_mtime: new Date(),
            }),
            itemId: 'item-1',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-1',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
            authMethod: 'bearer',
            clientIp: '192.0.2.1',
        });
        expect(isResult(created)).toBe(true);
        if (!isResult(created)) throw new Error('Expected preview');
        expect(mintPreviewGrant).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'preview',
                mediaId: created.sessionItemId,
                playbackSessionId: created.playSessionId,
            }),
        );
        const initial = new URL(created.streamUrl, 'https://app.test');
        expect(initial.searchParams.get('grant')).toBe('stream_preview');
        expect(initial.searchParams.get('PlaySessionId')).toBe(created.playSessionId);
        const reused = await findReusablePreview({
            userId: USER_1,
            requestedItemId: created.sessionItemId,
            startPositionSeconds: 100,
            isLiveTv: false,
            authMethod: 'bearer',
            clientIp: '192.0.2.1',
        });
        expect(reused).not.toBeNull();
        expect(mintPreviewGrant).toHaveBeenLastCalledWith(
            expect.objectContaining({
                playbackSessionId: reused!.playSessionId,
                kind: 'preview',
            }),
        );
        const next = new URL(reused!.streamUrl, 'https://app.test');
        expect(next.searchParams.get('grant')).toBe('stream_preview');
        expect(next.searchParams.get('PlaySessionId')).toBe(reused!.playSessionId);
    });

    it('allocates and cleans a VOD preview without playback policy or watch-state writes', async () => {
        const statements: string[] = [];
        const sql = makeFakeSql(
            {
                file_hash_head: 'isolated',
                file_size_bytes: 1000,
                file_mtime: new Date(),
            },
            statements,
        );
        const preview = await createPreview({
            sql,
            itemId: 'item-1',
            internalId: 'movie-1',
            username: 'alice',
            userId: USER_1,
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        });
        expect(isResult(preview)).toBe(true);
        if (!isResult(preview)) throw new Error('Expected preview allocation');
        await deletePreview({ playSessionId: preview.playSessionId, username: USER_1 });
        expect(
            statements.some((query) =>
                /(?:INSERT INTO|UPDATE)\s+(?:play_sessions|user_watch_state|watch_history)/i.test(
                    query,
                ),
            ),
        ).toBe(false);
        expect(
            statements.some((query) =>
                /access_policies|playback_policies|count.*play_sessions/i.test(query),
            ),
        ).toBe(false);
        expect(mockStartJob).toHaveBeenCalledTimes(1);
    });

    it('coalesces two createPreview calls for the same (file, seek-bucket) onto ONE shared artifact', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-abc',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const paramsA = {
            sql,
            itemId: 'item-1',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-1',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };
        // Same seek bucket (100 vs 105 with a 15s bucket both round to 105).
        const paramsB = { ...paramsA, startPositionSeconds: 105 };

        const resultA = await createPreview(paramsA);
        const resultB = await createPreview(paramsB);

        expect(isResult(resultA)).toBe(true);
        expect(isResult(resultB)).toBe(true);
        if (!isResult(resultA) || !isResult(resultB)) return;

        // Exactly one FFmpeg job was spawned for the shared artifact.
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        const jobConfig = mockStartJob.mock.calls[0][0] as {
            playSessionId: string;
            outputDir?: string;
            cacheKey?: string;
        };
        // The job runs under a stable artifact id, not either viewer's
        // playSessionId, and writes into the cache-managed outputDir.
        expect(jobConfig.playSessionId).toMatch(/^preview-cache-/);
        expect(jobConfig.playSessionId).not.toBe(resultA.playSessionId);
        expect(jobConfig.playSessionId).not.toBe(resultB.playSessionId);
        expect(jobConfig.outputDir).toBeTruthy();
        expect(jobConfig.cacheKey).toBeTruthy();

        // Each viewer still gets its own distinct playSessionId / streamUrl...
        expect(resultA.playSessionId).not.toBe(resultB.playSessionId);
        // ...but both sessions point at the SAME shared cache artifact.
        const sessionA = await import('./preview-session.service.js').then((m) =>
            m.getPreviewSession(resultA.playSessionId),
        );
        const sessionB = await import('./preview-session.service.js').then((m) =>
            m.getPreviewSession(resultB.playSessionId),
        );
        expect(sessionA?.cacheKey).toBeDefined();
        expect(sessionA?.cacheKey).toBe(sessionB?.cacheKey);
        expect(sessionA?.cacheKey).toBe(jobConfig.cacheKey);
    });

    it('shares artifacts only when viewers resolve to the same absolute audio track', async () => {
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            { file_id: 'file-1', stream_type: 'audio', stream_index: 2, language: 'ger' },
            { file_id: 'file-1', stream_type: 'audio', stream_index: 4, language: 'eng' },
        ] as never);
        vi.mocked(dbRowToAudioStreamInfo).mockImplementation((r: MediaStreamRow, i: number) => ({
            index: i,
            absoluteIndex: r.stream_index,
            codec: 'aac',
            channels: 2,
            language: r.language ?? undefined,
            displayTitle: r.language ?? '',
            isDefault: i === 0,
            isForced: false,
        }));
        vi.mocked(dbRowToAudioTrackInfo).mockImplementation((r: MediaStreamRow) => ({
            index: asAbsoluteStreamIndex(r.stream_index),
            codec: 'aac',
            channels: 2,
            language: r.language ?? '',
            displayTitle: r.language ?? '',
            isDefault: false,
        }));
        vi.mocked(getPlaybackPreferences.one).mockResolvedValue({} as never);
        const prefs = {
            preferOriginalAudio: false,
            audioLanguage: 'ger',
            lastAudioLanguage: null,
            subtitleLanguage: null,
            subtitlesEnabled: false,
            forcedSubtitlesEnabled: false,
            subtitleTrackHint: null,
        };
        vi.mocked(parseLanguagePreferences).mockReturnValue(prefs);
        const params = {
            sql: makeFakeSql({
                file_hash_head: 'hash-audio',
                file_size_bytes: 1000,
                file_mtime: null,
            }),
            itemId: 'item-audio',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-audio',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };
        try {
            await createPreview(params);
            vi.mocked(parseLanguagePreferences).mockReturnValue({ ...prefs, audioLanguage: 'eng' });
            await createPreview({
                ...params,
                username: 'bob',
                userId: toUserId('22220000-0000-4000-a000-000000000000'),
            });
            await createPreview({
                ...params,
                username: 'carol',
                userId: toUserId('33330000-0000-4000-a000-000000000000'),
            });
            expect(mockStartJob).toHaveBeenCalledTimes(2);
            const jobs = mockStartJob.mock.calls.map(
                ([cfg]) =>
                    cfg as {
                        cacheKey: string;
                        hlsOutput: { hlsAudioTrackIndex: number };
                    },
            );
            expect(jobs.map((job) => job.hlsOutput.hlsAudioTrackIndex)).toEqual([2, 4]);
            expect(jobs[0].cacheKey).not.toBe(jobs[1].cacheKey);
        } finally {
            vi.mocked(getPlaybackPreferences.one).mockResolvedValue(null);
            vi.mocked(getStreamsForMediaItem).mockResolvedValue([
                { stream_type: 'video' },
            ] as never);
        }
    });

    it('findReusablePreview reuses a cache-backed session via the store (no second job)', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-reuse',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const created = await createPreview({
            sql,
            itemId: 'item-reuse',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-reuse',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        });
        expect(isResult(created)).toBe(true);
        if (!isResult(created)) return;
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        const createdSession = await getPreviewSession(created.playSessionId);
        expect(createdSession?.cacheKey).toBeDefined();

        // A repeat request for the same item + (bucketed) seek must be
        // coalesced onto the existing session WITHOUT spawning a new job.
        // Before the store-lookup fix, getJob(playSessionId) was always
        // undefined for a cache-backed session, so this returned null and a
        // fresh session/job was created — the exact regression under test.
        // (requestedItemId is the RESOLVED item id the session carries, which
        // findReusablePreview matches against — same value createPreview
        // returned as sessionItemId.)
        const reused = await findReusablePreview({
            userId: USER_1,
            requestedItemId: created.sessionItemId,
            startPositionSeconds: 105, // same 15s bucket as 100
            isLiveTv: false,
        });

        expect(reused).not.toBeNull();
        // Cache-backed reuse mints the new viewer their OWN session record over
        // the SAME shared artifact — it does not hand back the first viewer's
        // playSessionId. Sharing one id meant whichever popup closed first
        // DELETEd the session out from under the others, so the survivors'
        // heartbeats 404'd and the hover preview reverted to its backdrop
        // mid-play (prod 2026-07-17). This assertion previously encoded the
        // pre-fix contract.
        expect(reused?.playSessionId).not.toBe(created.playSessionId);
        // What must be shared is the expensive part: no second transcode...
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        // The reused session is the same cache-backed record.
        const reusedSession = reused ? await getPreviewSession(reused.playSessionId) : undefined;
        expect(reusedSession?.cacheKey).toBe(createdSession?.cacheKey);
    });

    it('does NOT reuse a cache-backed session whose store entry is gone (evicted/failed)', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-evicted',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const created = await createPreview({
            sql,
            itemId: 'item-evicted',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-evicted',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        });
        expect(isResult(created)).toBe(true);
        if (!isResult(created)) return;

        const createdSession = await getPreviewSession(created.playSessionId);
        const cacheKey = createdSession?.cacheKey;
        expect(cacheKey).toBeDefined();
        if (!cacheKey) return;

        // Simulate the artifact being reaped from the store (budget eviction /
        // markFailed) while the Valkey session record still lingers.
        const store = (await import('./preview-cache.store.js')).getPreviewCacheStore();
        store.markFailed(cacheKey);
        expect(store.lookup(cacheKey)).toBeUndefined();

        const reused = await findReusablePreview({
            userId: USER_1,
            requestedItemId: created.sessionItemId,
            startPositionSeconds: 100,
            isLiveTv: false,
        });

        // Store entry gone → must fall through to a fresh create, not reuse.
        expect(reused).toBeNull();
    });

    it('does NOT reuse a cache-backed session whose in-memory job was reaped (store entry alive)', async () => {
        // Regression: the store entry (and on-disk artifact) OUTLIVES the
        // in-memory FFmpeg job — scanOnStartup indexes on-disk artifacts with
        // no job, and cleanupInactiveJobs reaps a completed artifact's job
        // after ~5 min idle. Serving master.m3u8 reads getJob(`preview-cache-
        // <key>`).config, so reusing on a store-only hit hands back a session
        // whose preview 410s. findReusablePreview must require the job too.
        const sql = makeFakeSql({
            file_hash_head: 'hash-reaped',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const created = await createPreview({
            sql,
            itemId: 'item-reaped',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-reaped',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        });
        expect(isResult(created)).toBe(true);
        if (!isResult(created)) return;
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        const createdSession = await getPreviewSession(created.playSessionId);
        const cacheKey = createdSession?.cacheKey;
        expect(cacheKey).toBeDefined();
        if (!cacheKey) return;

        // The store entry stays alive, but the artifact's in-memory job is
        // reaped (inactivity cleanup) — remove it from the fake job map.
        startedArtifactJobs.delete(`preview-cache-${cacheKey}`);
        const store = (await import('./preview-cache.store.js')).getPreviewCacheStore();
        expect(store.lookup(cacheKey)).toBeDefined();

        const reused = await findReusablePreview({
            userId: USER_1,
            requestedItemId: created.sessionItemId,
            startPositionSeconds: 105, // same bucket
            isLiveTv: false,
        });

        // Job gone → must NOT reuse (would 410); falls through to createPreview.
        expect(reused).toBeNull();
    });

    it('createPreview re-warms a cache-backed artifact whose in-memory job was reaped', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-rewarm',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const params = {
            sql,
            itemId: 'item-rewarm',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-rewarm',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };

        const first = await createPreview(params);
        expect(isResult(first)).toBe(true);
        if (!isResult(first)) return;
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        const cacheKey = (await getPreviewSession(first.playSessionId))?.cacheKey;
        expect(cacheKey).toBeDefined();
        if (!cacheKey) return;

        // Simulate FFmpeg completing the artifact (state → 'ready'), THEN the
        // inactivity cleaner reaping the in-memory job while the store entry
        // (on-disk artifact) survives — the exact reaped/startup-scanned state.
        // Only a `ready` entry is re-warm-eligible; a still-`warming` entry has
        // a start already pending and must NOT be double-started.
        const store = (await import('./preview-cache.store.js')).getPreviewCacheStore();
        store.markReady(cacheKey, 1234);
        startedArtifactJobs.delete(`preview-cache-${cacheKey}`);

        // A fresh createPreview for the SAME (file, bucket) is a store HIT (no
        // factory), but must re-warm the reaped job so the artifact is
        // serveable again — startJob runs a SECOND time.
        const second = await createPreview({ ...params, startPositionSeconds: 105 });
        expect(isResult(second)).toBe(true);
        if (!isResult(second)) return;

        expect(mockStartJob).toHaveBeenCalledTimes(2);
        // Both startJob calls target the SAME shared artifact id.
        const firstArtifactId = (mockStartJob.mock.calls[0][0] as { playSessionId: string })
            .playSessionId;
        const secondArtifactId = (mockStartJob.mock.calls[1][0] as { playSessionId: string })
            .playSessionId;
        expect(secondArtifactId).toBe(firstArtifactId);
        expect(secondArtifactId).toBe(`preview-cache-${cacheKey}`);
        // The job is resident again after the re-warm.
        expect(startedArtifactJobs.has(`preview-cache-${cacheKey}`)).toBe(true);
    });

    // Prod 2026-09-26 08:09: a complete preview artifact was re-warmed — a
    // second FFmpeg rewrote segments in a `.ready` dir under active viewers.
    // Previews have been MUXED since 2026-08-26, and a muxed artifact is flat
    // (index.m3u8 + init_0.mp4, no master.m3u8). The "is it disk-servable?"
    // check only looked for master.m3u8, so EVERY complete muxed artifact
    // looked legacy and got the in-place re-warm the check exists to prevent.
    it('does NOT re-warm a complete FLAT (muxed) artifact — the handler serves it from disk', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-flat',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });
        const params = {
            sql,
            itemId: 'item-flat',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-flat',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };

        const first = await createPreview(params);
        if (!isResult(first)) throw new Error('expected a preview result');
        const cacheKey = (await getPreviewSession(first.playSessionId))?.cacheKey;
        if (!cacheKey) throw new Error('expected a cache key');

        const store = (await import('./preview-cache.store.js')).getPreviewCacheStore();
        store.markReady(cacheKey, 1234);
        const dir = store.dirFor(cacheKey);
        writeFileSync(join(dir, 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n');
        writeFileSync(join(dir, 'init_0.mp4'), '');
        writeFileSync(join(dir, '.ready'), '');
        startedArtifactJobs.delete(`preview-cache-${cacheKey}`);

        const second = await createPreview({ ...params, startPositionSeconds: 105 });
        expect(isResult(second)).toBe(true);
        expect(mockStartJob).toHaveBeenCalledTimes(1);
    });

    // The disk handler (tryServePreviewArtifactFromDisk) treats a dir with no
    // `.ready` marker as still warming; with no job writing it, it never completes, so
    // skipping the re-warm for it would strand the viewer on a partial clip.
    it('still re-warms a flat artifact that has index.m3u8 but no .ready marker', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-flat-unmarked',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });
        const params = {
            sql,
            itemId: 'item-flat-unmarked',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-flat-unmarked',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };

        const first = await createPreview(params);
        if (!isResult(first)) throw new Error('expected a preview result');
        const cacheKey = (await getPreviewSession(first.playSessionId))?.cacheKey;
        if (!cacheKey) throw new Error('expected a cache key');

        const store = (await import('./preview-cache.store.js')).getPreviewCacheStore();
        store.markReady(cacheKey, 1234);
        writeFileSync(join(store.dirFor(cacheKey), 'index.m3u8'), '#EXTM3U\n');
        startedArtifactJobs.delete(`preview-cache-${cacheKey}`);

        await createPreview({ ...params, startPositionSeconds: 105 });
        expect(mockStartJob).toHaveBeenCalledTimes(2);
    });

    it('coalesces CONCURRENT createPreview calls (Promise.all) for the same key onto ONE job', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-concurrent',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const paramsA = {
            sql,
            itemId: 'item-concurrent',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-concurrent',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };
        const paramsB = { ...paramsA, startPositionSeconds: 105 }; // same bucket

        const [a, b] = await Promise.all([createPreview(paramsA), createPreview(paramsB)]);

        expect(isResult(a)).toBe(true);
        expect(isResult(b)).toBe(true);
        if (!isResult(a) || !isResult(b)) return;

        // The store's single-flight (proven at the store layer in Task 3) plus
        // createPreview threading an identical key means exactly one FFmpeg job
        // is spawned even under a concurrent burst.
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        const sessionA = await getPreviewSession(a.playSessionId);
        const sessionB = await getPreviewSession(b.playSessionId);
        expect(sessionA?.cacheKey).toBeDefined();
        expect(sessionA?.cacheKey).toBe(sessionB?.cacheKey);
    });

    it('cleanupPreviewSession detaches the cache entry but does NOT stop the shared job', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-xyz',
            file_size_bytes: 2000,
            file_mtime: new Date('2026-02-01T00:00:00Z'),
        });

        const { cleanupPreviewSession, getPreviewSession } =
            await import('./preview-session.service.js');

        const result = await createPreview({
            sql,
            itemId: 'item-2',
            username: 'bob',
            userId: USER_1,
            internalId: 'movie-2',
            fileId: 'file-1',
            startPositionSeconds: 50,
            isLiveTv: false,
        });
        expect(isResult(result)).toBe(true);
        if (!isResult(result)) return;

        const session = await getPreviewSession(result.playSessionId);
        expect(session).toBeDefined();
        if (!session) return;
        expect(session.cacheKey).toBeDefined();
        // Cache-backed sessions never own a per-session transcodeJobId — the
        // shared artifact's job must not be stoppable via this session.
        expect(session.transcodeJobId).toBeUndefined();

        // createPreview's startWarm calls stopJob(artifactSessionId) once as a
        // best-effort clear of any stale job under that id (see the "clears a
        // stale artifact job before re-warming" test below) — clear that call
        // so this assertion is only about cleanupPreviewSession's own behavior.
        mockStopJob.mockClear();

        await cleanupPreviewSession(result.playSessionId, session, USER_1);

        // stopJob was never called for the shared artifact's job id.
        expect(mockStopJob).not.toHaveBeenCalled();
    });

    it('clears a stale artifact job before re-warming (stopJob before startJob)', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-stale-job',
            file_size_bytes: 500,
            file_mtime: new Date('2026-02-05T00:00:00Z'),
        });

        const result = await createPreview({
            sql,
            itemId: 'item-stale',
            username: 'frank',
            userId: USER_1,
            internalId: 'movie-stale',
            fileId: 'file-1',
            startPositionSeconds: 10,
            isLiveTv: false,
        });
        expect(isResult(result)).toBe(true);
        if (!isResult(result)) return;

        // A single miss best-effort clears any stale job under the artifact id
        // BEFORE spawning the fresh transcode.
        expect(mockStopJob).toHaveBeenCalledTimes(1);
        expect(mockStartJob).toHaveBeenCalledTimes(1);

        const artifactId = (mockStartJob.mock.calls[0][0] as { playSessionId: string })
            .playSessionId;
        expect(mockStopJob).toHaveBeenCalledWith(artifactId);

        const stopOrder = mockStopJob.mock.invocationCallOrder[0];
        const startOrder = mockStartJob.mock.invocationCallOrder[0];
        expect(stopOrder).toBeLessThan(startOrder);
    });

    it('cleanupPreviewSession detach is idempotent (a second cleanup is a no-op)', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-idempotent',
            file_size_bytes: 1234,
            file_mtime: new Date('2026-02-02T00:00:00Z'),
        });

        const { cleanupPreviewSession, getPreviewSession } =
            await import('./preview-session.service.js');
        const { getPreviewCacheStore } = await import('./preview-cache.store.js');

        const result = await createPreview({
            sql,
            itemId: 'item-idempotent',
            username: 'dave',
            userId: USER_1,
            internalId: 'movie-idempotent',
            fileId: 'file-1',
            startPositionSeconds: 10,
            isLiveTv: false,
        });
        expect(isResult(result)).toBe(true);
        if (!isResult(result)) return;

        const session = await getPreviewSession(result.playSessionId);
        if (!session?.cacheKey) {
            throw new Error('expected a cache-backed session');
        }

        const store = getPreviewCacheStore();
        expect(store.lookup(session.cacheKey)?.refcount).toBe(1);

        await cleanupPreviewSession(result.playSessionId, session, USER_1);
        expect(store.lookup(session.cacheKey)?.refcount).toBe(0);

        // A second cleanup call for the SAME session (duplicate DELETE, or the
        // periodic expiry sweep racing a client DELETE) must not decrement the
        // refcount again — it should be a safe no-op.
        await cleanupPreviewSession(result.playSessionId, session, USER_1);
        expect(store.lookup(session.cacheKey)?.refcount).toBe(0);
    });

    it('cleanupPreviewSession never detaches for a session THIS replica never attached (foreign-pod rehydration)', async () => {
        const sql = makeFakeSql({
            file_hash_head: 'hash-foreign',
            file_size_bytes: 999,
            file_mtime: new Date('2026-02-03T00:00:00Z'),
        });

        const { cleanupPreviewSession, getPreviewSession } =
            await import('./preview-session.service.js');
        const { getPreviewCacheStore } = await import('./preview-cache.store.js');

        // This replica's own genuine viewer, attached via createPreview.
        const owned = await createPreview({
            sql,
            itemId: 'item-foreign',
            username: 'erin',
            userId: USER_1,
            internalId: 'movie-foreign',
            fileId: 'file-1',
            startPositionSeconds: 10,
            isLiveTv: false,
        });
        expect(isResult(owned)).toBe(true);
        if (!isResult(owned)) return;

        const ownedSession = await getPreviewSession(owned.playSessionId);
        if (!ownedSession?.cacheKey) {
            throw new Error('expected a cache-backed session');
        }

        const store = getPreviewCacheStore();
        expect(store.lookup(ownedSession.cacheKey)?.refcount).toBe(1);

        // Simulate a session record for the SAME cache key rehydrated from
        // Redis but created on a DIFFERENT pod — this replica never called
        // store.attach() for it (its playSessionId was never added to
        // cacheAttachedSessions). cleanupUserPreviewSessions would call
        // cleanupPreviewSession for a session that looks exactly like this.
        const foreignSession = {
            ...ownedSession,
            playSessionId: 'preview-foreign-pod-session-id',
        };

        await cleanupPreviewSession(foreignSession.playSessionId, foreignSession, USER_1);

        // This replica's real viewer's refcount must be untouched — a
        // foreign-pod cleanup must never detach an entry it didn't attach.
        expect(store.lookup(ownedSession.cacheKey)?.refcount).toBe(1);
    });

    it('kill switch: PREVIEW_CACHE_ENABLED=false restores per-call, per-session-id transcode jobs', async () => {
        mockConfig.PREVIEW_CACHE_ENABLED = false;

        const sql = makeFakeSql({
            file_hash_head: 'hash-abc',
            file_size_bytes: 1000,
            file_mtime: new Date('2026-01-01T00:00:00Z'),
        });

        const paramsA = {
            sql,
            itemId: 'item-3',
            username: 'carol',
            userId: USER_1,
            internalId: 'movie-3',
            fileId: 'file-1',
            startPositionSeconds: 100,
            isLiveTv: false,
        };
        const paramsB = { ...paramsA, startPositionSeconds: 105 };

        const resultA = await createPreview(paramsA);
        const resultB = await createPreview(paramsB);
        expect(isResult(resultA)).toBe(true);
        expect(isResult(resultB)).toBe(true);
        if (!isResult(resultA) || !isResult(resultB)) return;

        // Disabled cache: a fresh FFmpeg job is spawned for EVERY call, under
        // that call's own viewer playSessionId — no sharing, no cache dir.
        expect(mockStartJob).toHaveBeenCalledTimes(2);
        const [configA, configB] = mockStartJob.mock.calls.map(
            (c) => c[0] as { playSessionId: string; outputDir?: string; cacheKey?: string },
        );
        expect(configA.playSessionId).toBe(resultA.playSessionId);
        expect(configB.playSessionId).toBe(resultB.playSessionId);
        expect(configA.outputDir).toBeUndefined();
        expect(configA.cacheKey).toBeUndefined();
        expect(configB.outputDir).toBeUndefined();
        expect(configB.cacheKey).toBeUndefined();

        const { getPreviewSession } = await import('./preview-session.service.js');
        const sessionA = await getPreviewSession(resultA.playSessionId);
        const sessionB = await getPreviewSession(resultB.playSessionId);
        expect(sessionA?.cacheKey).toBeUndefined();
        expect(sessionB?.cacheKey).toBeUndefined();
        expect(sessionA?.transcodeJobId).toBe(resultA.playSessionId);
        expect(sessionB?.transcodeJobId).toBe(resultB.playSessionId);
    });

    it('resolveFileVersion falls back to size:mtime when file_hash_head is null', async () => {
        const { resolveFileVersion } = await import('./preview-session.service.js');
        const mtime = new Date('2026-03-01T12:00:00Z');
        const sql = makeFakeSql({
            file_hash_head: null,
            file_size_bytes: 4096,
            file_mtime: mtime,
        });

        const version = await resolveFileVersion(sql, 'file-1');
        expect(version).toBe(`4096:${mtime.getTime()}`);
    });

    it('resolveFileVersion prefers file_hash_head when present', async () => {
        const { resolveFileVersion } = await import('./preview-session.service.js');
        const sql = makeFakeSql({
            file_hash_head: 'the-hash',
            file_size_bytes: 4096,
            file_mtime: new Date('2026-03-01T12:00:00Z'),
        });

        const version = await resolveFileVersion(sql, 'file-1');
        expect(version).toBe('the-hash');
    });

    it('resolveFileVersion returns null (indeterminate) when hash, size, AND mtime are all null', async () => {
        const { resolveFileVersion } = await import('./preview-session.service.js');
        const sql = makeFakeSql({
            file_hash_head: null,
            file_size_bytes: null,
            file_mtime: null,
        });

        const version = await resolveFileVersion(sql, 'file-1');
        expect(version).toBeNull();
    });

    it('bypasses the cache (falls through to a per-session job) when fileVersion is indeterminate', async () => {
        const sql = makeFakeSql({
            file_hash_head: null,
            file_size_bytes: null,
            file_mtime: null,
        });

        const result = await createPreview({
            sql,
            itemId: 'item-indeterminate',
            username: 'grace',
            userId: USER_1,
            internalId: 'movie-indeterminate',
            fileId: 'file-1',
            startPositionSeconds: 10,
            isLiveTv: false,
        });
        expect(isResult(result)).toBe(true);
        if (!isResult(result)) return;

        // A fresh, per-session job was started directly — no cache dir/key.
        expect(mockStartJob).toHaveBeenCalledTimes(1);
        const jobConfig = mockStartJob.mock.calls[0][0] as {
            playSessionId: string;
            outputDir?: string;
            cacheKey?: string;
        };
        expect(jobConfig.playSessionId).toBe(result.playSessionId);
        expect(jobConfig.outputDir).toBeUndefined();
        expect(jobConfig.cacheKey).toBeUndefined();

        const session = await getPreviewSession(result.playSessionId);
        expect(session?.cacheKey).toBeUndefined();
        expect(session?.transcodeJobId).toBe(result.playSessionId);
    });
});

describe('createPreview — trailer mode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.PREVIEW_CACHE_ENABLED = true;
        mockConfig.PREVIEW_FORCE_UNIVERSAL_CODEC = true;
        mockConfig.PREVIEW_TRANSCODE_MAX_SECONDS = 30;
        mockConfig.PREVIEW_VIDEO_CODEC = 'h264';
        mockConfig.TRAILER_MAX_SECONDS = 360;
        mockStartJob.mockImplementation(async (cfg: { playSessionId: string }) => ({
            id: cfg.playSessionId,
            status: 'running',
            config: cfg,
        }));
    });

    // Every test here passes a sql fixture with an indeterminate file version
    // (hash/size/mtime all null) so createPreview takes the plain per-session
    // job path (see the "bypasses the cache" test above) — trailer mode is
    // orthogonal to the content-addressed cache path, and this keeps each
    // test's only real assertion (the startJob config) unambiguous.
    function indeterminateSql(): Sql {
        return makeFakeSql({ file_hash_head: null, file_size_bytes: null, file_mtime: null });
    }

    it('trailerRequired with no trailer child returns mode none without starting a job', async () => {
        vi.mocked(findLocalTrailerForItem).mockResolvedValue(null);

        const result = await createPreview({
            sql: indeterminateSql(),
            itemId: 'item-trailer-none',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-trailer-none',
            fileId: 'file-1',
            startPositionSeconds: 30,
            isLiveTv: false,
            trailerPreferred: true,
            trailerRequired: true,
        });

        expect(result).toEqual({ mode: 'none' });
        expect(mockStartJob).not.toHaveBeenCalled();
    });

    it('trailerPreferred resolves the child, seeks 0, and lifts the clamp to TRAILER_MAX_SECONDS', async () => {
        mockConfig.TRAILER_MAX_SECONDS = 360;
        vi.mocked(findLocalTrailerForItem).mockResolvedValue(TRAILER_UUID);

        const result = await createPreview({
            sql: indeterminateSql(),
            itemId: 'item-trailer-yes',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-trailer-yes',
            fileId: 'file-1',
            startPositionSeconds: 30, // must be ignored — trailers always seek 0
            isLiveTv: false,
            trailerPreferred: true,
        });

        expect(result).toMatchObject({ mode: 'trailer', sessionItemId: TRAILER_UUID });
        expect(mockStartJob).toHaveBeenCalledTimes(1);
        const jobCfg = mockStartJob.mock.calls[0][0] as {
            maxDurationSeconds?: number;
            startTimeSeconds?: number;
        };
        expect(jobCfg.maxDurationSeconds).toBe(360);
        expect(jobCfg.startTimeSeconds).toBe(0);
    });

    it('non-trailer previews still get mode preview and no override', async () => {
        const result = await createPreview({
            sql: indeterminateSql(),
            itemId: 'item-trailer-off',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-trailer-off',
            fileId: 'file-1',
            startPositionSeconds: 10,
            isLiveTv: false,
        });

        expect(result).toMatchObject({ mode: 'preview' });
        expect(mockStartJob).toHaveBeenCalledTimes(1);
        const jobCfg = mockStartJob.mock.calls[0][0] as { maxDurationSeconds?: number };
        expect(jobCfg.maxDurationSeconds).toBeUndefined();
    });

    // Fix 4 (2026-07-18): a trailer session's `itemId` is the resolved
    // trailer CHILD's uuid, not the PARENT id the client re-requests with —
    // findReusablePreview must match on the stamped `requestedItemId`
    // instead, and must never cross-reuse between trailer and snippet
    // requests for the same parent.
    it('reuses a trailer session for a repeat request with the SAME parent id', async () => {
        vi.mocked(findLocalTrailerForItem).mockResolvedValue(TRAILER_REUSE_UUID);
        // Non-cache-backed session path (job keyed by the viewer's own
        // playSessionId) — make getJob report it as alive/reusable.
        mockGetJob.mockImplementation((id: string) => ({ id, status: 'running' }));

        const parentId = 'item-trailer-reuse-parent';
        const created = await createPreview({
            sql: indeterminateSql(),
            itemId: parentId,
            username: 'alice',
            userId: USER_1,
            internalId: parentId,
            fileId: 'file-1',
            startPositionSeconds: 0,
            isLiveTv: false,
            trailerPreferred: true,
        });
        expect(isResult(created)).toBe(true);
        if (!isResult(created)) return;
        expect(created.sessionItemId).toBe(TRAILER_REUSE_UUID);

        // The client re-opens with the PARENT id (it never learns the
        // trailer child's uuid) — must coalesce onto the same session.
        const reused = await findReusablePreview({
            userId: USER_1,
            requestedItemId: parentId,
            startPositionSeconds: 0,
            isLiveTv: false,
            trailerPreferred: true,
        });

        expect(reused).not.toBeNull();
        expect(reused?.playSessionId).toBe(created.playSessionId);
        expect(reused?.mode).toBe('trailer');
    });

    it('does NOT reuse a trailer session for a non-trailer (snippet) request with the same parent id', async () => {
        vi.mocked(findLocalTrailerForItem).mockResolvedValue(TRAILER_REUSE_UUID);
        mockGetJob.mockImplementation((id: string) => ({ id, status: 'running' }));

        const parentId = 'item-trailer-no-cross-reuse';
        const created = await createPreview({
            sql: indeterminateSql(),
            itemId: parentId,
            username: 'alice',
            userId: USER_1,
            internalId: parentId,
            fileId: 'file-1',
            startPositionSeconds: 0,
            isLiveTv: false,
            trailerPreferred: true,
        });
        expect(isResult(created)).toBe(true);
        if (!isResult(created)) return;

        // A plain (non-trailer) snippet request for the same parent must
        // NOT reuse the trailer session — wrong content, wrong seek
        // semantics.
        const reused = await findReusablePreview({
            userId: USER_1,
            requestedItemId: parentId,
            startPositionSeconds: 30,
            isLiveTv: false,
            trailerPreferred: false,
        });

        expect(reused).toBeNull();
    });
});

// Prod 2026-09-19..23: every `invalid-argument` transcode failure was a preview
// dying on `-map 0:a:2 ... matches no streams`. getStreamsForMediaItem returns
// the streams of EVERY file linked to the item, so for a movie with a 1080p and
// a 2160p file the preview saw audio rows `1,1,2,2,3` — the English track
// (absolute 2) then resolved to array POSITION 2 on a file with two audio
// streams. The audio list handed to startJob must be the PREVIEWED file's own.
describe('createPreview — audio tracks come from the previewed file only', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.PREVIEW_CACHE_ENABLED = true;
        mockConfig.PREVIEW_FORCE_UNIVERSAL_CODEC = true;
        mockConfig.PREVIEW_TRANSCODE_MAX_SECONDS = 30;
        mockConfig.PREVIEW_VIDEO_CODEC = 'h264';
        mockStartJob.mockImplementation(async (cfg: { playSessionId: string }) => ({
            id: cfg.playSessionId,
            status: 'running',
            config: cfg,
        }));
    });

    it('ignores stream rows that belong to a sibling file of the same item', async () => {
        const row = (
            file_id: string,
            stream_type: string,
            stream_index: number,
            language: string,
        ) => ({
            file_id,
            stream_type,
            stream_index,
            language,
        });
        // ORDER BY stream_type, stream_index across BOTH files — the shape the
        // real query returns.
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            row('file-1', 'audio', 1, 'ger'),
            row('file-2', 'audio', 1, 'ger'),
            row('file-1', 'audio', 2, 'eng'),
            row('file-2', 'audio', 2, 'ger'),
            row('file-2', 'audio', 3, 'eng'),
            row('file-1', 'video', 0, 'und'),
            row('file-2', 'video', 0, 'und'),
        ] as never);
        vi.mocked(dbRowToAudioStreamInfo).mockImplementation((r: MediaStreamRow, i: number) => ({
            index: i,
            absoluteIndex: r.stream_index,
            codec: 'eac3',
            channels: 6,
            language: r.language ?? undefined,
            displayTitle: r.language ?? '',
            isDefault: false,
            isForced: false,
        }));
        vi.mocked(dbRowToAudioTrackInfo).mockImplementation((r: MediaStreamRow) => ({
            index: asAbsoluteStreamIndex(r.stream_index),
            displayTitle: r.language ?? '',
            language: r.language ?? '',
            channels: 6,
            codec: 'eac3',
            isDefault: false,
        }));

        const result = await createPreview({
            sql: makeFakeSql({ file_hash_head: null, file_size_bytes: null, file_mtime: null }),
            itemId: 'item-two-files',
            username: 'alice',
            userId: USER_1,
            internalId: 'movie-two-files',
            fileId: 'file-1',
            startPositionSeconds: 10,
            isLiveTv: false,
        });

        expect(isResult(result)).toBe(true);
        expect(mockStartJob).toHaveBeenCalledTimes(1);
        const jobCfg = mockStartJob.mock.calls[0][0] as {
            audioTracks: Array<{ index: number; language: string }>;
        };
        expect(jobCfg.audioTracks.map((t) => [t.index, t.language])).toEqual([
            [1, 'ger'],
            [2, 'eng'],
        ]);
    });
});
