// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D-HLS-1 (security runtime pass 2026-09-26, fix (a)): `startJob` serialized
 * on the RAW `jobConfig.playSessionId` (`withSessionStartLock`) while the job
 * registry (`getCurrentJobId`, `getJobByPlaySession`, `registerCurrentJob`,
 * …) keys everything on the case-folded `sessionKey()`. Two case-variant
 * spellings of one session UUID were therefore never serialized against each
 * other: both `startJobInternal` calls ran concurrently, neither reliably
 * observed the other's in-flight job via the (correctly folded) existing-job
 * check, and preprod measured 20/20 trials landing one 200 + one 503 with a
 * row that disagreed with itself (`item_id` from one start, `config.itemId`
 * from the other — D-HLS-1, case "1b-case").
 *
 * This exercises the fix at the real seam: the REAL `FFmpegTranscodeService`
 * singleton (`getFFmpegTranscodeService()`), calling its own `startJob`
 * directly (bypassing `playback.service.ts` entirely — the lock lives inside
 * this class, not at the route layer), with `spawnFFmpeg` (the process
 * runner) and its other heavy collaborators stubbed exactly as in
 * `ffmpeg-transcode.service.test.ts`, and REAL Postgres persistence via the
 * REAL `TranscodeJobPersistenceService` singleton (neither
 * `transcode-job-persistence.service.js` nor `database/connection.js` is
 * mocked here — `vitest.integration.config.ts` mirrors `TEST_DATABASE_URL`
 * onto `DATABASE_URL` for this process, so `getDb()` resolves to this file's
 * own test database, same as `play-session-ownership.integration.test.ts`).
 */

const mockCfg = vi.hoisted(() => ({
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 0, // 0 = no cap
    FFMPEG_MAX_JOBS_PER_USER: 1000,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-d-hls-1-lock-test',
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
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 300,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS: 60,
}));

vi.mock('$lib/server/config.js', async () => ({
    ...(await import('../tasks/__fixtures__/task-config-mock.js')).taskConfigMock(),
    config: new Proxy(mockCfg, {
        get(target, prop: string) {
            return target[prop as keyof typeof target];
        },
    }),
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

// Deliberately NOT mocked: transcode-job-persistence.service.js,
// database/connection.js — see file doc comment above.

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
vi.mock('./transcoding/file-manager.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TranscodeFileManager: vi.fn(function (this: any) {
        Object.assign(this, mockFileManager);
    }),
}));

const mockProcessRunner = vi.hoisted(() => ({
    spawnFFmpeg: vi.fn().mockResolvedValue(undefined),
    killFFmpeg: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
}));
vi.mock('./transcoding/process-runner.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FFmpegProcessRunnerEvents: vi.fn(function (this: any) {
        Object.assign(this, mockProcessRunner);
    }),
}));

vi.mock('./transcoding/iframe-analyzer.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    IFrameAnalyzer: vi.fn(function (this: any) {
        this.startAnalysis = vi.fn();
        this.stopAnalysis = vi.fn();
    }),
}));

vi.mock('./transcoding/seek-controller.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SeekController: vi.fn(function (this: any) {
        this.prepareJobStateForSeek = vi.fn();
    }),
}));

vi.mock('./transcoding/hardware-detection.js', () => ({
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

const mockFailureEvents = vi.hoisted(() => ({ recordTranscodeFailureEvent: vi.fn() }));
vi.mock('../database/queries/transcode-failure-events.queries.js', () => mockFailureEvents);

const mockBuildArgs = vi.hoisted(() => vi.fn().mockReturnValue({ args: [], description: 'mock' }));
vi.mock('./transcoding/index.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./transcoding/index.js')>();
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
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        FullTranscodeStrategy: vi.fn(function (this: any) {
            this.buildArgs = mockBuildArgs;
        }),
        getHwAccelFromEncoder: vi.fn().mockReturnValue('none'),
        resolveTonemapMode: real.resolveTonemapMode,
    };
});

vi.mock('./hls/generation-router.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./hls/generation-router.js')>();
    return real;
});
vi.mock('./hls/generation-coordinator.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./hls/generation-coordinator.js')>();
    return real;
});

const mockSeekCooldownTracker = vi.hoisted(() => ({ clearSeekTimestamp: vi.fn() }));
vi.mock('./hls/seek-cooldown-tracker.js', () => mockSeekCooldownTracker);
vi.mock('./hls/segment-request-tracker.js', () => ({
    clearSessionRequestTrackers: vi.fn(),
}));
vi.mock('./hls/seek-trace-collector.js', () => ({
    clearSessionSeekTrace: vi.fn(),
}));

vi.mock('./transcoding/ffmpeg-stats-cache.js', () => ({
    publishJobStats: vi.fn().mockResolvedValue(undefined),
    readJobStats: vi.fn().mockResolvedValue(null),
    deleteJobStats: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./transcoding/resource-monitor.js', () => ({
    getProcessResourceUsage: vi.fn().mockResolvedValue({ cpu: 0, memory: 0 }),
    getIntelGpuVideoUsage: vi.fn().mockResolvedValue(0),
}));

vi.mock('./transcoding/transcode-failure-classifier.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./transcoding/transcode-failure-classifier.js')>()),
    classifyTranscodeFailure: vi.fn().mockReturnValue({ kind: 'unknown' }),
    formatTranscodeFailureMessage: vi.fn().mockReturnValue(''),
}));

vi.mock('../utils/hls-stream-duration.js', () => ({
    isDistinctStreamDuration: vi.fn().mockReturnValue(false),
}));

vi.mock('../utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '' }),
}));

// ============================================================================
// Imports after mocks
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../tests/integration/fixtures/media.fixtures.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';
import type { TranscodeJobConfig } from './transcoding/types.js';
import { PlaySessionOwnedByAnotherUserError } from './transcoding/play-session-owner-error.js';

const sql = getTestDb();

async function makeUser(): Promise<{ userId: string; username: string }> {
    const userId = randomUUID();
    await ensureTestUser(sql, userId);
    return { userId, username: derivedUsername(userId) };
}

async function makeItem(): Promise<string> {
    const id = randomUUID();
    await insertTestMediaItem(sql, {
        id,
        title: 'D-HLS-1 lock test item',
        original_title: null,
        media_type: 'movie',
        year: 2020,
        status: 'active',
        parent_id: null,
        has_files: true,
    });
    return id;
}

function buildConfig(itemId: string, username: string, playSessionId: string): TranscodeJobConfig {
    return {
        itemId,
        username,
        deviceId: 'test-device',
        playSessionId,
        inputUrl: `/fake/media-${itemId}.mkv`,
        audioTracks: [],
    };
}

describe('D-HLS-1: withSessionStartLock keys on the folded sessionKey(), not the raw PlaySessionId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('two concurrent startJob calls for case-variant spellings of one session id serialize instead of racing', async () => {
        const user = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sidLower = randomUUID().toLowerCase();
        const sidUpper = sidLower.toUpperCase();

        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');

        // Submitted in this order: X (lowercase spelling) first, Y (UPPERCASE
        // spelling of the SAME session id) second, both in flight at once.
        const [jobX, jobY] = await Promise.all([
            svc.startJob(buildConfig(itemX, user.username, sidLower)),
            svc.startJob(buildConfig(itemY, user.username, sidUpper)),
        ]);

        // Both calls resolved — no throw, no simulated 503.
        expect(jobX).toBeDefined();
        expect(jobY).toBeDefined();

        // Serialized: Y's startJobInternal ran only after X's had fully
        // registered, so it took the "existing job, config changed" branch —
        // X's job was explicitly stopped (once) before Y's was created,
        // exactly the in-process equivalent of the HTTP layer's
        // `playback_config_changed` recreate.
        expect(stopSpy).toHaveBeenCalledTimes(1);
        // stopJob is called with the SECOND (recreating) caller's own raw
        // spelling of the session id — Y's, i.e. the UPPERCASE one.
        expect(stopSpy).toHaveBeenCalledWith(sidUpper, 'playback_config_changed');

        // Exactly one live job for the folded key, and it is Y's — the
        // second (newest) start wins, mirroring upsertJob's own "newest
        // start wins" rule (fix (b)).
        const current = svc.getJobByPlaySession(sidLower);
        expect(current).toBeDefined();
        expect(current?.config.itemId).toBe(itemY);
        expect(svc.getJobByPlaySession(sidUpper)?.id).toBe(current?.id);

        // The row this produced is self-consistent — item_id and
        // config.itemId agree, and both equal Y (the second caller's item).
        // (The `uuid` column canonicalizes case on insert, so either
        // spelling looks the row up identically.)
        const rows = await sql<{ item_id: string; config: { itemId?: string } }[]>`
            SELECT item_id, config FROM active_transcode_jobs
            WHERE play_session_id = ${sidLower}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].item_id).toBe(itemY);
        expect(rows[0].config.itemId).toBe(itemY);
    });
});

// HLS fixes report §4 open item 1 (ownership -> startJob TOCTOU):
// `startHlsPlayback`'s ownership arms ran BEFORE `startJob` took the per-session
// lock, so two starts for one PlaySessionId by two DIFFERENT users could both
// pass the arms (no job resident yet) and then run back to back under the lock
// — the second one stopping (config differs) or riding (config equal) the
// first user's freshly started job. With `requireSameOwner`, the owner check
// runs INSIDE the lock, against whatever job the previous holder registered.
describe('ownership decision and job claim are atomic under withSessionStartLock', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a concurrent start by another user for a different item is refused instead of stopping the first user's job", async () => {
        const userA = await makeUser();
        const userB = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();

        const svc = getFFmpegTranscodeService();
        const stopSpy = vi.spyOn(svc, 'stopJob');

        const [resA, resB] = await Promise.allSettled([
            svc.startJob(buildConfig(itemX, userA.username, sid), { requireSameOwner: true }),
            svc.startJob(buildConfig(itemY, userB.username, sid), { requireSameOwner: true }),
        ]);

        expect(resA.status).toBe('fulfilled');
        expect(resB.status).toBe('rejected');
        expect((resB as PromiseRejectedResult).reason).toBeInstanceOf(
            PlaySessionOwnedByAnotherUserError,
        );
        expect(stopSpy).not.toHaveBeenCalled();

        const current = svc.getJobByPlaySession(sid);
        expect(current?.config.username).toBe(userA.username);
        expect(current?.config.itemId).toBe(itemX);
        const rows = await sql<{ item_id: string }[]>`
            SELECT item_id FROM active_transcode_jobs WHERE play_session_id = ${sid}
        `;
        expect(rows.map((r) => r.item_id)).toEqual([itemX]);
    });

    it("a concurrent start by another user for the SAME item is refused instead of being handed the first user's job", async () => {
        const userA = await makeUser();
        const userB = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();

        const svc = getFFmpegTranscodeService();

        const [resA, resB] = await Promise.allSettled([
            svc.startJob(buildConfig(itemX, userA.username, sid), { requireSameOwner: true }),
            svc.startJob(buildConfig(itemX, userB.username, sid), { requireSameOwner: true }),
        ]);

        expect(resA.status).toBe('fulfilled');
        expect(resB.status).toBe('rejected');
        expect(svc.getJobByPlaySession(sid)?.config.username).toBe(userA.username);
    });

    it('the owner compare is EXACT: a username differing only by case is another user', async () => {
        const userA = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();

        const svc = getFFmpegTranscodeService();
        await svc.startJob(buildConfig(itemX, userA.username, sid), { requireSameOwner: true });
        await expect(
            svc.startJob(buildConfig(itemX, userA.username.toUpperCase(), sid), {
                requireSameOwner: true,
            }),
        ).rejects.toBeInstanceOf(PlaySessionOwnedByAnotherUserError);
    });

    it('the same user re-requesting its own session still reuses/restarts under the lock', async () => {
        const userA = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();

        const svc = getFFmpegTranscodeService();
        await svc.startJob(buildConfig(itemX, userA.username, sid), { requireSameOwner: true });
        const job = await svc.startJob(buildConfig(itemY, userA.username, sid), {
            requireSameOwner: true,
        });
        expect(job.config.itemId).toBe(itemY);
    });
});
