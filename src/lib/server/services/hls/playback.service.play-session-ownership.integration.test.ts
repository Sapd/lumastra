// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D-HLS-3 (security runtime pass 2026-09-26): `startHlsPlayback`'s reuse/stop
 * path (`startJobInternal` → `hasPlaybackConfigChanged` → `stopJob`) had no
 * PlaySessionId ownership check, so a caller holding another user's
 * PlaySessionId could stop or hijack that user's in-flight transcode — a
 * denial of service reachable from all three mounts (`/api/playback`, `/j`
 * master.m3u8, showcase).
 *
 * This exercises the fix at the real seam: `startHlsPlayback` runs against a
 * REAL Postgres connection (play_sessions / active_transcode_jobs) and the REAL `getFFmpegTranscodeService()`
 * singleton with `spawnFFmpeg` (the process runner) and a few of its other
 * heavy collaborators stubbed — file resolution / probing on the
 * `playback.service.ts` side (the same seam guard both `verifyPlaySessionOwnership`
 * and the new live-job check sit in front of), and process spawn / hardware
 * probing / the decision-engine internals on the `ffmpeg-transcode.service.ts`
 * side (mirroring the harness already proven in `ffmpeg-transcode.service.test.ts`).
 * `verifyPlaySessionOwnership` (arm 1) and `getJobByPlaySession` (arm 2) are
 * NOT mocked — those are exactly what this file proves.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// ============================================================================
// $lib/server/config.js — deterministic values for the transcode admission
// path (global/per-user caps, load-shed) so test jobs never get evicted or
// refused by an unrelated cap; STREAM_LIMITS_ENFORCED is moot since no test
// request carries a userId, but is set explicitly for clarity.
// ============================================================================
const mockCfg = vi.hoisted(() => ({
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 0, // 0 = no cap
    FFMPEG_MAX_JOBS_PER_USER: 1000,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-d-hls-3-test',
    FFMPEG_MAX_GENERATIONS_PER_SESSION: 2,
    TRANSCODE_DOWNSCALE_CPU_TO_1080P: false,
    MAX_WIDTH: 0,
    MAX_HEIGHT: 0,
    AUDIO_CODEC: 'aac',
    AUDIO_BITRATE_STEREO: '128k',
    AUDIO_BITRATE_SURROUND: '384k',
    AUDIO_VBR: false,
    AUDIO_BOOST: false,
    ENCODING_PRESET: 'medium',
    NVENC_PRESET: 'p4',
    NVENC_TUNE: '',
    NVENC_RC: 'auto',
    NVENC_CQ: 28,
    H264_CRF: 18,
    H265_CRF: 22,
    VIDEO_BITRATE_MBPS: 0,
    TONEMAPPING_ALGORITHM: 'hable',
    DEINTERLACE_METHOD: 'yadif',
    PREVIEW_TRANSCODE_MAX_SECONDS: 0,
    PREVIEW_MAX_VIDEO_BITRATE_MBPS: 0,
    GPU_ACCELERATION: false,
    VAAPI_DEVICE: '',
    HLS_BURN_IN_HDR_STRATEGY: 'tonemap',
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 300,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS: 60,
    LUMASTRA_TRANSCODE_LOAD_SHED_RATIO: 0, // 0 = load-shed disabled
    STREAM_LIMITS_ENFORCED: false,
    // Read by the real enforceStreamPolicy (play-method gate suite only).
    DEFAULT_MAX_CONCURRENT_STREAMS: 10,
    TRUST_CLIENT_LOCAL_PLAYBACK: false,
    // Pulled in transitively by importing the REAL lumastra-segment-handler.js
    // (for the segment-continuity test) — jellyfin/base-client.ts reads this
    // at module load, unrelated to anything this file actually exercises.
    APP_NAME: 'Lumastra',
}));

vi.mock('$lib/server/config.js', async () => ({
    ...(await import('../../tasks/__fixtures__/task-config-mock.js')).taskConfigMock(),
    config: new Proxy(mockCfg, {
        get(target, prop: string) {
            return target[prop as keyof typeof target];
        },
    }),
    // Read by the REAL lumastra-segment-handler.js (imported for the
    // segment-continuity test) — ffmpegAvailable gates its whole handler.
    features: { ffmpegAvailable: true },
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
// ffmpeg-transcode.service.ts's heavy collaborators — same harness proven in
// ffmpeg-transcode.service.test.ts. NOT mocked: transcode-job-persistence
// (real DB writes), database/connection (real Postgres), preview-admission /
// preview-cache.store / env-snapshot / job-item-binding (no side effects on
// our path), quality-cap (pure math).
// ============================================================================
const mockFileManager = vi.hoisted(() => ({
    clearTranscodeDirectory: vi.fn().mockResolvedValue(undefined),
    createOutputDirectory: vi.fn().mockResolvedValue(undefined),
    deleteOutputDirectory: vi.fn().mockResolvedValue(undefined),
    cleanupSessionDirectory: vi.fn().mockResolvedValue(undefined),
    getSegmentPath: vi.fn(),
    listSegments: vi.fn().mockResolvedValue([]),
    deleteSegmentsBefore: vi.fn().mockResolvedValue(undefined),
    slidingWindowCleanup: vi.fn().mockResolvedValue(undefined),
    isOutputComplete: vi.fn().mockResolvedValue(false),
}));
vi.mock('$lib/server/services/transcoding/file-manager.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TranscodeFileManager: vi.fn(function (this: any) {
        Object.assign(this, mockFileManager);
    }),
}));

// Writes a real segment file into the REAL job.outputDir it is handed, so
// the segment-continuity test below can drive the REAL `handleHlsSegment`
// against real bytes on disk — not a hand-built fake job object. `job` here
// is the real `TranscodeJob` the real service created (fs/promises is NOT
// mocked in this file, unlike playback.service.test.ts, precisely so this
// write — and the handler's own read of it — hits real disk).
//
// The bytes embed `job.id` (review follow-up M2): every job used to get the
// SAME literal bytes, which made "A's segment still has the expected bytes"
// pass even when a same-item quality-change hijack had silently replaced
// A's job with B's — the two jobs' segments were byte-identical, so the
// assertion never actually distinguished them. Embedding the id makes a
// wrong-job serve provably wrong.
const mockProcessRunner = vi.hoisted(() => ({
    spawnFFmpeg: vi.fn(async (job: { id: string; outputDir: string }): Promise<void> => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const path = await import('node:path');
        await mkdir(path.join(job.outputDir, 'stream_0'), { recursive: true });
        await writeFile(
            path.join(job.outputDir, 'stream_0', 'segment_00000.m4s'),
            Buffer.from(`fake-segment-bytes:${job.id}`),
        );
    }),
    killFFmpeg: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
}));
vi.mock('$lib/server/services/transcoding/process-runner.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FFmpegProcessRunnerEvents: vi.fn(function (this: any) {
        Object.assign(this, mockProcessRunner);
    }),
}));

vi.mock('$lib/server/services/transcoding/iframe-analyzer.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    IFrameAnalyzer: vi.fn(function (this: any) {
        this.startAnalysis = vi.fn();
        this.stopAnalysis = vi.fn();
    }),
}));

vi.mock('$lib/server/services/transcoding/seek-controller.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SeekController: vi.fn(function (this: any) {
        this.prepareJobStateForSeek = vi.fn();
    }),
}));

vi.mock('$lib/server/services/transcoding/hardware-detection.js', () => ({
    hardwareDetection: {
        canSoftwareDecodeBridge: vi.fn().mockReturnValue(false),
        isSourceHardwareDecodable: vi.fn().mockReturnValue(false),
        markSourceNotHardwareDecodable: vi.fn(),
        invalidateEncoderProbe: vi.fn(),
        getCachedCapabilities: vi.fn().mockReturnValue(null),
        getCachedNvidiaGpuName: vi.fn().mockReturnValue(null),
        getNonHardwareDecodableCodecs: vi.fn().mockReturnValue([]),
    },
}));

const mockBuildArgs = vi.hoisted(() => vi.fn().mockReturnValue({ args: [], description: 'mock' }));
vi.mock('$lib/server/services/transcoding/index.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/services/transcoding/index.js')>();
    return {
        transcodeDecision: {
            decide: vi.fn().mockResolvedValue({
                mode: 'full',
                videoAction: 'copy',
                audioAction: 'copy',
                useGpu: false,
            }),
            consumePlan: vi.fn().mockResolvedValue({
                mode: 'full',
                videoAction: 'copy',
                audioAction: 'copy',
                useGpu: false,
            }),
            // A quality change flips the copy plan to a transcode (case 5);
            // encoder/HDR selection for the flip is not what this suite tests.
            assignEncoderForFlippedTranscode: vi.fn().mockResolvedValue(undefined),
            assignHdrForFlippedTranscode: vi.fn(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        FullTranscodeStrategy: vi.fn(function (this: any) {
            this.buildArgs = mockBuildArgs;
        }),
        getHwAccelFromEncoder: vi.fn().mockReturnValue('none'),
        resolveTonemapMode: real.resolveTonemapMode,
    };
});

// Real pure-function implementations (no side effects) — keep them genuine.
vi.mock('$lib/server/services/hls/generation-router.js', async (importOriginal) => {
    const real =
        await importOriginal<typeof import('$lib/server/services/hls/generation-router.js')>();
    return real;
});
vi.mock('$lib/server/services/hls/generation-coordinator.js', async (importOriginal) => {
    const real =
        await importOriginal<typeof import('$lib/server/services/hls/generation-coordinator.js')>();
    return real;
});

const mockSeekCooldownTracker = vi.hoisted(() => ({ clearSeekTimestamp: vi.fn() }));
vi.mock('$lib/server/services/hls/seek-cooldown-tracker.js', () => mockSeekCooldownTracker);
// Real pure-function implementation (no side effects) — the segment-
// continuity test drives the REAL lumastra-segment-handler.js, which calls
// several of this module's exports the ffmpeg-transcode.service.ts harness
// never needed.
vi.mock('$lib/server/services/hls/segment-request-tracker.js', async (importOriginal) => {
    const real =
        await importOriginal<
            typeof import('$lib/server/services/hls/segment-request-tracker.js')
        >();
    return real;
});
// Real pure-function implementation — see segment-request-tracker.js above
// for why (the segment-continuity test drives the REAL segment handler).
vi.mock('$lib/server/services/hls/seek-trace-collector.js', async (importOriginal) => {
    const real =
        await importOriginal<typeof import('$lib/server/services/hls/seek-trace-collector.js')>();
    return real;
});

vi.mock('$lib/server/services/transcoding/ffmpeg-stats-cache.js', () => ({
    publishJobStats: vi.fn().mockResolvedValue(undefined),
    readJobStats: vi.fn().mockResolvedValue(null),
    deleteJobStats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/services/transcoding/resource-monitor.js', () => ({
    getProcessResourceUsage: vi.fn().mockResolvedValue({ cpu: 0, memory: 0 }),
    getIntelGpuVideoUsage: vi.fn().mockResolvedValue(0),
}));

vi.mock(
    '$lib/server/services/transcoding/transcode-failure-classifier.js',
    async (importOriginal) => ({
        ...(await importOriginal<
            typeof import('$lib/server/services/transcoding/transcode-failure-classifier.js')
        >()),
        classifyTranscodeFailure: vi.fn().mockReturnValue({ kind: 'unknown' }),
        formatTranscodeFailureMessage: vi.fn().mockReturnValue(''),
    }),
);

vi.mock('$lib/server/utils/hls-stream-duration.js', () => ({
    isDistinctStreamDuration: vi.fn().mockReturnValue(false),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '' }),
}));

const mockFailureEvents = vi.hoisted(() => ({ recordTranscodeFailureEvent: vi.fn() }));
vi.mock(
    '$lib/server/database/queries/transcode-failure-events.queries.js',
    () => mockFailureEvents,
);

// Input-guard sniff: every spawn re-checks job.config.localFilePath is real
// media (transcoding/input-guard.ts, final wave M1). Our fake `inputUrl`
// never points at a real file, so the real sniff would fail every job —
// stubbed to a no-op pass, per the brief's "modest mocking of the input
// guard sniff" allowance.
vi.mock('$lib/server/services/transcoding/input-guard.js', () => ({
    assertTranscodeInputIsMedia: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// playback.service.ts's own file-resolution / probing collaborators — same
// mocks as playback.service.test.ts (same directory), so the pipeline reaches
// startJob() without touching real ffprobe/disk. NOT mocked: job-item-binding
// (isRawPreviewCacheSessionId — pure, part of the seam guard),
// play-session-ownership (verifyPlaySessionOwnership — arm 1, real DB), and
// quality-cap (pure math).
// ============================================================================
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: vi.fn().mockResolvedValue({
        files: [{ id: 'file-1', file_path: '/media/movie.mkv', edition: null, part_number: null }],
        fileId: 'file-1',
    }),
}));

vi.mock('../../../../routes/api/playback/[itemId]/hls/file-selection.js', () => ({
    selectFileForPlayback: vi.fn().mockReturnValue({
        type: 'single',
        path: '/media/movie.mkv',
        fileId: 'file-1',
    }),
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn().mockResolvedValue({
        isAccessible: true,
        containerPath: '/media/movie.mkv',
        reason: undefined,
    }),
}));

vi.mock('../transcoding/media-probe.service.js', () => ({
    probeForTranscode: vi.fn().mockResolvedValue({
        audioTracks: [
            {
                index: 1,
                codec: 'aac',
                channels: 2,
                language: 'eng',
                displayTitle: 'English',
                bitrate: 128000,
                isDefault: true,
            },
        ],
        subtitleTracks: [],
        streams: [],
        videoCodec: 'h264',
        videoWidth: 1920,
        videoHeight: 1080,
        videoBitrate: 5_000_000,
        videoRange: 'SDR',
        durationSeconds: 3600,
        source: 'db' as const,
    }),
}));

// Spread the real module so a new export (RENDITION_NAMES_PATH broke this once) reaches the
// handlers; only the playlist builders are stubbed.
vi.mock('$lib/server/utils/hls-master-playlist.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/hls-master-playlist.js')>()),
    generateMasterPlaylist: vi.fn().mockReturnValue('#EXTM3U\n#EXT-X-STREAM-INF:...\n'),
    generateMuxedMasterPlaylist: vi.fn().mockReturnValue('#EXTM3U\n'),
    generateAudioOnlyMasterPlaylist: vi.fn().mockReturnValue('#EXTM3U\n'),
    AUDIO_ONLY_BANDWIDTH: 128_000,
    calculateEstimatedBandwidth: vi.fn().mockReturnValue(10_000_000),
    resolveSyntheticIframes: vi.fn().mockReturnValue(undefined),
    isNativeHlsClient: vi.fn().mockReturnValue(false),
    resolveHevcMain10: vi.fn().mockReturnValue(false),
    resolveMasterHevcMain10: vi.fn().mockReturnValue(false),
}));

vi.mock('$lib/server/services/playback-planner.service.js', () => ({
    playbackPlanner: {
        getPlan: vi.fn().mockResolvedValue(null),
        refreshPlan: vi.fn().mockResolvedValue(undefined),
        updateSubtitleMethod: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/utils/hls-request-utils.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/hls-request-utils.js')>();
    return {
        waitForHlsPlaylist: vi.fn().mockResolvedValue(true),
        HLS_CORS_HEADERS: { 'Access-Control-Allow-Origin': '*' },
        addPlaybackIdentityToSearchParams: actual.addPlaybackIdentityToSearchParams,
        SAFE_PLAY_SESSION_ID_RE: actual.SAFE_PLAY_SESSION_ID_RE,
    };
});

// fs/promises is deliberately NOT mocked in this file (unlike
// playback.service.test.ts): the segment-continuity case drives the REAL
// `handleHlsSegment`, which reads real bytes the spawnFFmpeg stub above
// wrote to a real `job.outputDir`. playback.service.ts's own fs.writeFile/
// fs.unlink calls (concat-demuxer temp file) are never reached here — every
// test uses `fileSelection.type: 'single'` — so leaving fs/promises real is
// harmless for that side.

vi.mock('../trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getKeyframesForFile: vi.fn().mockResolvedValue(null),
    updateKeyframes: vi.fn().mockResolvedValue(undefined),
    updateHealthIssues: vi.fn().mockResolvedValue(undefined),
}));

// play-sessions.service.js is NOT mocked: the play-method gate suite at the
// bottom reads a REAL user_stream_policies row through the real
// getEffectivePolicy / enforceStreamPolicy. The ownership suite never passes a
// userId, so neither runs for it.

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: async (sql: unknown, cb: (sql: unknown) => Promise<unknown>) => cb(sql),
}));

vi.mock('$lib/server/utils/media-format-whitelist.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/media-format-whitelist.js')>()),
    getConcatPartFormatWhitelist: () => 'matroska,webm,mov,mp4',
}));

// ============================================================================
// Imports after mocks
// ============================================================================
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../../tests/integration/fixtures/media.fixtures.js';
import { createPlaySession } from '$lib/server/database/queries/play-sessions.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { startHlsPlayback } from './playback.service.js';
import type { HlsPlaybackRequest } from './playback.service.js';
import { getFFmpegTranscodeService } from '../ffmpeg-transcode.service.js';
import { JELLYFIN_COMPAT_DEVICE_ID } from '../transcoding/session-key.js';
import { handleHlsSegment } from '$lib/server/handlers/hls/lumastra-segment-handler.js';
import { transcodeDecision } from '$lib/server/services/transcoding/index.js';
import { getPublicHlsDiagnosticCode } from './stream-diagnostics.js';

const sql = getTestDb();

/** The exact segment path/body shape the spawnFFmpeg stub above writes —
 *  reused by every test that reads a job's real segment bytes back. */
function segmentUrlFor(itemId: string, sid: string): URL {
    return new URL(
        `https://example.test/api/playback/${itemId}/hls/stream_0/segment_00000.m4s?PlaySessionId=${sid}`,
    );
}

async function makeUser(): Promise<{ userId: string; username: string }> {
    const userId = randomUUID();
    await ensureTestUser(sql, userId);
    return { userId, username: derivedUsername(userId) };
}

/** A real, distinct `users` row with an EXPLICIT username spelling — used to
 *  build "differs only by case" accounts, which `derivedUsername` (always
 *  lowercase hex) cannot produce. `users.username` is unique
 *  case-SENSITIVELY (`users_username_key`), so this is a genuinely different
 *  account, not a collision. */
async function makeUserWithUsername(
    username: string,
): Promise<{ userId: string; username: string }> {
    const userId = randomUUID();
    await sql`
        INSERT INTO users (id, username) VALUES (${userId}::uuid, ${username})
        ON CONFLICT (id) DO NOTHING
    `;
    await sql`
        INSERT INTO user_profiles (user_id) VALUES (${userId}::uuid)
        ON CONFLICT (user_id) DO NOTHING
    `;
    return { userId, username };
}

async function makeItem(): Promise<string> {
    const id = randomUUID();
    await insertTestMediaItem(sql, {
        id,
        title: 'D-HLS-3 test item',
        original_title: null,
        media_type: 'movie',
        year: 2020,
        status: 'active',
        parent_id: null,
        has_files: true,
    });
    return id;
}

/** Real `createPlaySession` — the same insert path production uses on the
 *  client's session 'start' report — so `verifyPlaySessionOwnership` reads a
 *  genuinely production-shaped row. */
async function makePersistedSession(id: string, userId: string, mediaId: string): Promise<void> {
    await createPlaySession(sql, {
        surface: 'web',
        id,
        media_id: mediaId,
        user_id: toUserId(userId),
        device_id: 'test-device',
        ip_address: '127.0.0.1',
        play_method: 'full_transcode',
        position_ms: 0,
    });
}

function baseRequest(
    itemId: string,
    username: string,
    playSessionId: string | undefined,
    overrides: Partial<HlsPlaybackRequest> = {},
): HlsPlaybackRequest {
    return {
        sql,
        itemId,
        username,
        deviceId: 'test-device',
        playSessionId,
        segmentBase: `/api/playback/${itemId}/hls`,
        segmentParams: new URLSearchParams(playSessionId ? `PlaySessionId=${playSessionId}` : ''),
        ...overrides,
    };
}

describe('D-HLS-3: startHlsPlayback refuses a non-owner reuse/stop of a PlaySessionId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Re-apply the default resolved values vi.clearAllMocks() wiped —
        // clearAllMocks clears implementations set via the mock factories'
        // OWN `.mockResolvedValue`/`.mockReturnValue` calls above too, since
        // those are the same vi.fn() instances.
    });

    // ------------------------------------------------------------------
    // Arm 1 — persisted `play_sessions` row
    // ------------------------------------------------------------------

    it("case 1: B holding A's persisted PlaySessionId with a differing config is refused 401; A's job is untouched", async () => {
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();
        await makePersistedSession(sid, a.userId, itemX);

        const jobA = await startHlsPlayback(baseRequest(itemX, a.username, sid));
        expect(jobA.playlistBody).toBeTruthy();

        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBefore = svc.getJobByPlaySession(sid);
        expect(jobBefore?.config.itemId).toBe(itemX);
        expect(jobBefore?.config.username).toBe(a.username);

        await expect(
            startHlsPlayback(
                baseRequest(itemY, b.username, sid, { qualityCap: { maxHeight: 480 } }),
            ),
        ).rejects.toMatchObject({ statusCode: 401 });

        expect(stopSpy).not.toHaveBeenCalled();
        const jobAfter = svc.getJobByPlaySession(sid);
        expect(jobAfter?.id).toBe(jobBefore?.id);
        expect(jobAfter?.config.itemId).toBe(itemX);
        expect(jobAfter?.status).not.toBe('stopped');
        expect(jobAfter?.status).not.toBe('error');

        const rows = await sql<{ item_id: string; user_id: string; status: string }[]>`
            SELECT item_id, user_id, status FROM active_transcode_jobs
            WHERE play_session_id = ${sid}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].item_id).toBe(itemX);
        expect(rows[0].status).not.toBe('stopped');
    });

    it("case 2: a case-variant (UPPERCASE) spelling of A's persisted id is also refused; A's job untouched", async () => {
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();
        await makePersistedSession(sid, a.userId, itemX);

        await startHlsPlayback(baseRequest(itemX, a.username, sid));
        const svc = getFFmpegTranscodeService();
        const jobBefore = svc.getJobByPlaySession(sid);

        await expect(
            startHlsPlayback(baseRequest(itemY, b.username, sid.toUpperCase())),
        ).rejects.toMatchObject({ statusCode: 401 });

        const jobAfter = svc.getJobByPlaySession(sid);
        expect(jobAfter?.id).toBe(jobBefore?.id);
        expect(jobAfter?.status).not.toBe('stopped');
    });

    it('case 8: a brand-new client-supplied UUID with no play_sessions row and no job succeeds (row-absent allowance)', async () => {
        const a = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID(); // never persisted

        const result = await startHlsPlayback(baseRequest(itemX, a.username, sid));
        expect(result.playlistBody).toBeTruthy();

        const svc = getFFmpegTranscodeService();
        expect(svc.getJobByPlaySession(sid)?.config.username).toBe(a.username);
    });

    // ------------------------------------------------------------------
    // Arm 2 — live in-process job, no persisted row (the /j and showcase
    // shapes: dashless / non-UUID ids never get a play_sessions row)
    // ------------------------------------------------------------------

    it('case 3 (/j shape): a dashless PlaySessionId with no DB row is still refused for a non-owner via the live job', async () => {
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const dashless = randomUUID().replace(/-/g, '');

        const jReq = { deviceId: JELLYFIN_COMPAT_DEVICE_ID };
        await startHlsPlayback(baseRequest(itemX, a.username, dashless, jReq));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBefore = svc.getJobByPlaySession(dashless);
        expect(jobBefore?.config.username).toBe(a.username);

        // A /j PlaySessionId never gets a play_sessions row: /j keeps its own
        // session row under another id, so the transcode row has no stub.
        const rows = await sql<{ id: string }[]>`
            SELECT id FROM play_sessions WHERE id = ${dashless}
        `;
        expect(rows).toHaveLength(0);

        await expect(
            startHlsPlayback(baseRequest(itemY, b.username, dashless, jReq)),
        ).rejects.toMatchObject({ statusCode: 401 });

        expect(stopSpy).not.toHaveBeenCalled();
        const jobAfter = svc.getJobByPlaySession(dashless);
        expect(jobAfter?.id).toBe(jobBefore?.id);
        expect(jobAfter?.status).not.toBe('stopped');
    });

    // Arm 3 — a /j session's job lives on ANOTHER pod. Arm 1 passes (no
    // play_sessions row, ever) and arm 2 passes (nothing resident here), but
    // the transcode row is persisted now, so it names the owner.
    it('case 3b (/j shape, cross-pod): a non-owner is refused by the persisted transcode row; the owner is not', async () => {
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const dashless = randomUUID().replace(/-/g, '');
        const jReq = { deviceId: JELLYFIN_COMPAT_DEVICE_ID };

        await startHlsPlayback(baseRequest(itemX, a.username, dashless, jReq));
        const svc = getFFmpegTranscodeService();
        // What a graceful shutdown leaves for a peer: the row, no resident job.
        await svc.stopJob(dashless, 'shutdown', true);
        expect(svc.getJobByPlaySession(dashless)).toBeUndefined();
        const [row] = await sql<{ username: string }[]>`
            SELECT config->>'username' AS username FROM active_transcode_jobs
            WHERE play_session_id = ${dashless}
        `;
        expect(row?.username).toBe(a.username);

        await expect(
            startHlsPlayback(baseRequest(itemX, b.username, dashless, jReq)),
        ).rejects.toMatchObject({ statusCode: 401 });
        expect(svc.getJobByPlaySession(dashless)).toBeUndefined();

        const own = await startHlsPlayback(baseRequest(itemX, a.username, dashless, jReq));
        expect(own.playlistBody).toBeTruthy();
        expect(svc.getJobByPlaySession(dashless)?.config.username).toBe(a.username);
    });

    it("case 4 (showcase shape): a signed-in user cannot stop a showcase principal's job under the same id", async () => {
        const showcasePrincipal = `showcase:198.51.100.${Math.floor(Math.random() * 250) + 1}`;
        const b = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();

        await startHlsPlayback(baseRequest(itemX, showcasePrincipal, sid));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBefore = svc.getJobByPlaySession(sid);
        expect(jobBefore?.config.username).toBe(showcasePrincipal);

        await expect(startHlsPlayback(baseRequest(itemY, b.username, sid))).rejects.toMatchObject({
            statusCode: 401,
        });

        expect(stopSpy).not.toHaveBeenCalled();
        expect(svc.getJobByPlaySession(sid)?.id).toBe(jobBefore?.id);
    });

    it("review follow-up M1: B cannot take over a dashless session while A's job is in 'error' status; A's own recovery still succeeds", async () => {
        // The old arm 2 excluded 'error'/'stopped' jobs from the ownership
        // check — meaning the instant A's job died (crash, eviction,
        // transient FFmpeg failure), the row-absent-forever dashless id
        // became takeable by ANYONE, and A's own next request would have
        // been refused as though SHE were the non-owner (there is no
        // "was I the one who died" distinction once the job is gone). The
        // fix applies the ownership check to a resident job of ANY status.
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const dashless = randomUUID().replace(/-/g, '');

        await startHlsPlayback(baseRequest(itemX, a.username, dashless));
        const svc = getFFmpegTranscodeService();
        const jobBefore = svc.getJobByPlaySession(dashless);
        expect(jobBefore).toBeDefined();
        jobBefore!.status = 'error'; // simulate a crashed/failed transcode

        await expect(
            startHlsPlayback(baseRequest(itemY, b.username, dashless)),
        ).rejects.toMatchObject({ statusCode: 401 });
        // B never got in: the errored job is still there, still A's.
        expect(svc.getJobByPlaySession(dashless)?.id).toBe(jobBefore!.id);
        expect(svc.getJobByPlaySession(dashless)?.status).toBe('error');

        // A's own recovery: her job is gone/errored, but she is still the
        // owner of the session id, so she must be able to restart it.
        const result = await startHlsPlayback(baseRequest(itemX, a.username, dashless));
        expect(result.playlistBody).toBeTruthy();
        expect(svc.getJobByPlaySession(dashless)?.config.username).toBe(a.username);
    });

    // ------------------------------------------------------------------
    // Positives — outage direction: a legitimate reuse/restart of one's OWN
    // session must keep working exactly as before this fix.
    // ------------------------------------------------------------------

    it('case 5: A changing quality on her OWN session restarts the job cleanly (stopJob IS called, for the OWNER)', async () => {
        const a = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        await makePersistedSession(sid, a.userId, itemX);

        await startHlsPlayback(baseRequest(itemX, a.username, sid));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBefore = svc.getJobByPlaySession(sid);

        const result = await startHlsPlayback(
            baseRequest(itemX, a.username, sid, { qualityCap: { maxHeight: 480 } }),
        );
        expect(result.playlistBody).toBeTruthy();

        expect(stopSpy).toHaveBeenCalledWith(sid, 'playback_config_changed');
        const jobAfter = svc.getJobByPlaySession(sid);
        expect(jobAfter).toBeDefined();
        expect(jobAfter?.id).not.toBe(jobBefore?.id);
        expect(jobAfter?.status).not.toBe('error');
    });

    it('case 6: A resuming on a second device (a NEW session id) leaves both of her jobs live, nothing stopped', async () => {
        const a = await makeUser();
        const itemX = await makeItem();
        const sidOne = randomUUID();
        const sidTwo = randomUUID();
        await makePersistedSession(sidOne, a.userId, itemX);
        await makePersistedSession(sidTwo, a.userId, itemX);

        await startHlsPlayback(baseRequest(itemX, a.username, sidOne));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');

        await startHlsPlayback(baseRequest(itemX, a.username, sidTwo));

        expect(stopSpy).not.toHaveBeenCalled();
        const jobOne = svc.getJobByPlaySession(sidOne);
        const jobTwo = svc.getJobByPlaySession(sidTwo);
        expect(jobOne).toBeDefined();
        expect(jobTwo).toBeDefined();
        expect(jobOne?.id).not.toBe(jobTwo?.id);
        expect(jobOne?.status).not.toBe('stopped');
        expect(jobTwo?.status).not.toBe('stopped');
    });

    it('case 7 (/j shape): a Jellyfin client re-requesting master with its OWN dashless id and identical config reuses the job (no stop)', async () => {
        const a = await makeUser();
        const itemX = await makeItem();
        const dashless = randomUUID().replace(/-/g, '');

        const first = await startHlsPlayback(baseRequest(itemX, a.username, dashless));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBefore = svc.getJobByPlaySession(dashless);

        const second = await startHlsPlayback(baseRequest(itemX, a.username, dashless));

        expect(stopSpy).not.toHaveBeenCalled();
        expect(first.playlistBody).toBeTruthy();
        expect(second.playlistBody).toBeTruthy();
        const jobAfter = svc.getJobByPlaySession(dashless);
        expect(jobAfter?.id).toBe(jobBefore?.id);
    });

    // ------------------------------------------------------------------
    // Segment continuity for A: after B's refused master call, A's playback
    // must be provably unaffected — driven through the REAL segment handler
    // (`handleHlsSegment`), reading the REAL bytes the spawnFFmpeg stub wrote
    // into A's job's real output directory. This is the requirement itself
    // (a direct `verifyPlaySessionOwnership` call would only prove arm 1's
    // primitive works, not that A's stream is actually still servable).
    // ------------------------------------------------------------------

    it("A's next segment is still served (200, A's ORIGINAL job's bytes) after B's refused master call; B gets 404 on it", async () => {
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();
        await makePersistedSession(sid, a.userId, itemX);

        await startHlsPlayback(baseRequest(itemX, a.username, sid));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBeforeId = svc.getJobByPlaySession(sid)!.id;

        await expect(startHlsPlayback(baseRequest(itemY, b.username, sid))).rejects.toMatchObject({
            statusCode: 401,
        });
        expect(stopSpy).not.toHaveBeenCalled();
        expect(svc.getJobByPlaySession(sid)?.id).toBe(jobBeforeId);

        const segmentUrl = segmentUrlFor(itemX, sid);
        const segmentCtx = {
            itemId: itemX,
            segmentPath: 'stream_0/segment_00000.m4s',
            url: segmentUrl,
            request: new Request(segmentUrl),
            basePath: '',
            internalId: itemX,
            mount: 'api' as const,
        };

        const responseA = await handleHlsSegment({ ...segmentCtx, username: a.username });
        expect(responseA.status).toBe(200);
        const bodyA = Buffer.from(await responseA.arrayBuffer());
        // Discriminating assertion (review follow-up M2): the bytes must
        // name A's ORIGINAL job id specifically, not just "some" bytes — a
        // hijack that replaced A's job with a new one would still produce
        // 200 + non-empty bytes, just for the WRONG job.
        expect(bodyA.toString()).toContain(jobBeforeId);

        const responseB = await handleHlsSegment({ ...segmentCtx, username: b.username });
        expect(responseB.status).toBe(404);
    });

    it("a same-item quality-change 'hijack' attempt by B is refused; A's original job and bytes are unaffected", async () => {
        // Review follow-up M2: B targeting the SAME item (not a different
        // one) with a differing qualityCap is the case the old
        // identical-bytes stub could not have caught even if this test had
        // asserted on bytes — B's job would have written the SAME literal
        // bytes A's did. Embedding job.id in the stub (above) makes this
        // discriminating.
        const a = await makeUser();
        const b = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        await makePersistedSession(sid, a.userId, itemX);

        await startHlsPlayback(baseRequest(itemX, a.username, sid));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBeforeId = svc.getJobByPlaySession(sid)!.id;

        await expect(
            startHlsPlayback(
                baseRequest(itemX, b.username, sid, { qualityCap: { maxHeight: 480 } }),
            ),
        ).rejects.toMatchObject({ statusCode: 401 });
        expect(stopSpy).not.toHaveBeenCalled();
        expect(svc.getJobByPlaySession(sid)?.id).toBe(jobBeforeId);

        const segmentUrl = segmentUrlFor(itemX, sid);
        const responseA = await handleHlsSegment({
            itemId: itemX,
            segmentPath: 'stream_0/segment_00000.m4s',
            url: segmentUrl,
            request: new Request(segmentUrl),
            basePath: '',
            internalId: itemX,
            mount: 'api' as const,
            username: a.username,
        });
        expect(responseA.status).toBe(200);
        const bodyA = Buffer.from(await responseA.arrayBuffer());
        expect(bodyA.toString()).toContain(jobBeforeId);
    });

    it("a different account whose username differs from A's only by case cannot stop A's session (arm 2 is an EXACT comparison)", async () => {
        const a = await makeUser();
        const caseVariant = await makeUserWithUsername(a.username.toUpperCase());
        const itemX = await makeItem();
        const itemY = await makeItem();
        // Dashless (/j shape): no play_sessions row is ever written for it,
        // so arm 1 (row-absent) allows through and this is a pure arm-2 test.
        const dashless = randomUUID().replace(/-/g, '');

        await startHlsPlayback(baseRequest(itemX, a.username, dashless));
        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');
        const jobBefore = svc.getJobByPlaySession(dashless);
        expect(jobBefore?.config.username).toBe(a.username);

        await expect(
            startHlsPlayback(baseRequest(itemY, caseVariant.username, dashless)),
        ).rejects.toMatchObject({ statusCode: 401 });

        expect(stopSpy).not.toHaveBeenCalled();
        expect(svc.getJobByPlaySession(dashless)?.id).toBe(jobBefore?.id);
    });
});

// ============================================================================
// Play-method gate (allowed_play_methods) at the HLS manifest
// ============================================================================
// Session start only sees the method the client CLAIMS. These cases prove the
// manifest refuses what the server would actually RUN: a real
// user_stream_policies row, the real getEffectivePolicy / enforceStreamPolicy,
// and the real transcode service — only the decision engine's output is
// steered (copy vs transcode), exactly what a quality cap or burn-in flips.
describe('HLS manifest enforces allowed_play_methods against the real decision', () => {
    const transcodeDecisionResult = {
        mode: 'full',
        videoAction: 'transcode',
        audioAction: 'copy',
        useGpu: false,
    };

    async function makeRemuxOnlyUser(): Promise<{ userId: string; username: string }> {
        const user = await makeUser();
        await sql`
            INSERT INTO user_stream_policies (user_id, max_concurrent_streams, allowed_play_methods, updated_at)
            VALUES (${user.username}, 10, ${['direct', 'remux']}::text[], now())
            ON CONFLICT (user_id) DO UPDATE SET allowed_play_methods = EXCLUDED.allowed_play_methods
        `;
        return user;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockCfg.STREAM_LIMITS_ENFORCED = true;
    });

    it('refuses a transcode with 403 + transcode_not_allowed body, stops the job, maps to the diagnostic code', async () => {
        const user = await makeRemuxOnlyUser();
        const item = await makeItem();
        const sid = randomUUID();
        vi.mocked(transcodeDecision.decide).mockResolvedValueOnce(
            transcodeDecisionResult as Awaited<ReturnType<typeof transcodeDecision.decide>>,
        );

        const err = await startHlsPlayback(
            baseRequest(item, user.username, sid, { userId: user.userId }),
        ).catch((e: unknown) => e);

        expect(err).toMatchObject({ statusCode: 403 });
        const body = JSON.parse((err as Error).message) as Record<string, unknown>;
        expect(body).toEqual({
            error: 'transcode_not_allowed',
            allowed_methods: ['direct', 'remux'],
            suggestion: 'direct',
        });
        // What the route turns into X-Lumastra-Diagnostic-Code.
        expect(
            getPublicHlsDiagnosticCode({ statusCode: 403, errorCode: body.error as string }),
        ).toBe('playback-method-not-allowed');
        // The refused FFmpeg job does not keep running.
        const job = getFFmpegTranscodeService().getJobByPlaySession(sid);
        expect(job === undefined || job.status === 'stopped' || job.status === 'stopping').toBe(
            true,
        );
    });

    it('still refuses with STREAM_LIMITS_ENFORCED=false (the kill-switch only covers the count)', async () => {
        mockCfg.STREAM_LIMITS_ENFORCED = false;
        const user = await makeRemuxOnlyUser();
        const item = await makeItem();
        vi.mocked(transcodeDecision.decide).mockResolvedValueOnce(
            transcodeDecisionResult as Awaited<ReturnType<typeof transcodeDecision.decide>>,
        );

        await expect(
            startHlsPlayback(
                baseRequest(item, user.username, randomUUID(), { userId: user.userId }),
            ),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('lets a remux through for the same user', async () => {
        const user = await makeRemuxOnlyUser();
        const item = await makeItem();
        const sid = randomUUID();

        // Explicit: vi.clearAllMocks() can leave the factory's default
        // unset, and no decision at all means FFmpeg runs a full transcode.
        vi.mocked(transcodeDecision.decide).mockResolvedValueOnce({
            ...transcodeDecisionResult,
            videoAction: 'copy',
        } as Awaited<ReturnType<typeof transcodeDecision.decide>>);
        const result = await startHlsPlayback(
            baseRequest(item, user.username, sid, { userId: user.userId }),
        );
        expect(result.playlistBody).toBeTruthy();
        expect(getFFmpegTranscodeService().getJobByPlaySession(sid)?.status).not.toBe('stopped');
    });

    it('lets a transcode through for a user without a method restriction', async () => {
        const user = await makeUser();
        const item = await makeItem();
        vi.mocked(transcodeDecision.decide).mockResolvedValueOnce(
            transcodeDecisionResult as Awaited<ReturnType<typeof transcodeDecision.decide>>,
        );

        const result = await startHlsPlayback(
            baseRequest(item, user.username, randomUUID(), { userId: user.userId }),
        );
        expect(result.playlistBody).toBeTruthy();
    });
});
