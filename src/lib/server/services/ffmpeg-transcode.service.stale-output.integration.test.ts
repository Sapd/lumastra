// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS re-measure 2026-09-27 §6.3: a takeover disk-served the LOSER's bytes.
 *
 * 08a037df8 stopped a pod that lost a session from deleting the session's
 * output (the peer might be writing into it on a shared transcode mount). On a
 * per-container FFMPEG_TRANSCODE_DIR nobody else can use that dir, and every
 * job of a session writes `<sid>/gen-0001`, so the loser's output sat at the
 * exact path a later row names. Measured on preprod (4/4):
 *
 *   1. user A starts X on WEB            -> WEB writes X to <sid>/gen-0001
 *   2. same sid starts Y on WRK          -> upsertJob full replace (item=Y, pod=WRK)
 *   3. WEB stop                          -> "Leaving session output in place"
 *   4. 16 s later a Y-gated segment on WEB takes the stale row over
 *   5. WEB "Serving from pre-generated segments" at <sid>/gen-0001 -> X's bytes
 *
 * Every row check held (row says Y, request says Y); the bytes on disk were
 * wrong. This drives the REAL service (start/stop/restore) and the REAL
 * restore/disk-serve seam against real Postgres and a real transcode dir;
 * only FFmpeg itself is mocked, so "X's bytes" are written by the test where
 * FFmpeg would have written them.
 */

const mockCfg = vi.hoisted(() => ({
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 0, // 0 = no cap
    FFMPEG_MAX_JOBS_PER_USER: 1000,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-stale-output-test',
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
// database/connection.js, transcoding/file-manager.js (real disk).

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

vi.mock('./transcoding/input-guard.js', () => ({
    assertTranscodeInputIsMedia: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Imports after mocks
// ============================================================================
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../tests/integration/fixtures/media.fixtures.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';
import { upsertJob, getJob as getJobRow } from '../database/queries/transcode-jobs.queries.js';
import { getTranscodeJobPersistenceService } from './transcode-job-persistence.service.js';
import { restoreHlsJobIfMissing } from './hls/job-restoration.js';
import { writeOutputMarker } from './hls/output-marker.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { TranscodeJobConfig } from './transcoding/types.js';

const sql = getTestDb();

const SEGMENT = 'stream_0/segment_00000.m4s';
const X_BYTES = 'X-SEGMENT-BYTES';
const STALE_MS = 20_000; // > OWNER_SERVING_STALE_MS (15 s): the peer's row reads as abandoned

async function makeUser(): Promise<{ userId: string; username: string }> {
    const userId = randomUUID();
    await ensureTestUser(sql, userId);
    return { userId, username: derivedUsername(userId) };
}

async function makeItem(): Promise<string> {
    const id = randomUUID();
    await insertTestMediaItem(sql, {
        id,
        title: 'stale-output test item',
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

async function exists(p: string): Promise<boolean> {
    return fs.access(p).then(
        () => true,
        () => false,
    );
}

interface Scenario {
    sid: string;
    user: { userId: string; username: string };
    itemX: string;
    itemY: string;
    /** WEB's generation dir, where X's bytes sit. */
    webOutputDir: string;
}

/** Step 1: user A starts X on WEB; "FFmpeg" writes X's first segment. */
async function startXOnWeb(): Promise<Scenario> {
    const user = await makeUser();
    const itemX = await makeItem();
    const itemY = await makeItem();
    const sid = randomUUID();
    const svc = getFFmpegTranscodeService();
    await svc.startJob(buildConfig(itemX, user.username, sid));
    const job = svc.getJobByPlaySession(sid);
    expect(job).toBeDefined();
    const segmentFile = path.join(job!.outputDir, SEGMENT);
    await fs.mkdir(path.dirname(segmentFile), { recursive: true });
    await fs.writeFile(segmentFile, X_BYTES);
    return { sid, user, itemX, itemY, webOutputDir: job!.outputDir };
}

/** Step 2: the same session starts Y on WRK — upsertJob's full replace. WRK's
 *  per-session output path is the same `<sid>/gen-0001`. Its last access is
 *  already past the staleness window (step 4's "16 s later"). */
async function wrkReplacesRowWithY(s: Scenario): Promise<void> {
    const stale = new Date(Date.now() - STALE_MS);
    const written = await upsertJob(sql, {
        play_session_id: s.sid,
        job_id: randomUUID(),
        item_id: s.itemY,
        user_id: toUserId(s.user.userId),
        device_id: 'test-device',
        config: { ...buildConfig(s.itemY, s.user.username, s.sid) },
        output_dir: s.webOutputDir,
        status: 'running',
        mode: 'full',
        segment_offset: 0,
        segments_ready: 1,
        master_playlist_ready: true,
        pod_name: 'pod-wrk',
        ffmpeg_pid: null,
        created_at: stale,
        last_accessed_at: stale,
        last_progress_at: stale,
        transcode_decision: null,
        can_restore: true,
    });
    expect(written).toBe('written');
    const row = await getJobRow(sql, s.sid);
    expect(row?.item_id).toBe(s.itemY);
    expect(row?.pod_name).toBe('pod-wrk');
}

/** Step 4/5: a segment request on WEB, gated on `itemId`, with no resident
 *  job — the handler's restore/disk-serve path, with real fs and the real
 *  service as the restorer. Returns the bytes the client would receive. */
async function segmentRequestOnWeb(s: Scenario, itemId: string): Promise<string | null> {
    const svc = getFFmpegTranscodeService();
    expect(svc.getJobByPlaySession(s.sid)).toBeUndefined();
    const result = await restoreHlsJobIfMissing({
        job: undefined,
        itemId,
        internalId: itemId,
        mount: 'api',
        playSessionId: s.sid,
        segmentPath: SEGMENT,
        corsHeaders: {},
        contentTypes: { '.m4s': 'video/mp4' },
        currentPodName: 'pod-web',
        restoreWaitTimeoutMs: 200,
        restorePollIntervalMs: 20,
        jobPersistence: getTranscodeJobPersistenceService(),
        transcodeService: svc,
        accessFile: (p) => fs.access(p),
        readFile: (p) => fs.readFile(p),
        trackHlsSegment: () => undefined,
        logInfo: () => undefined,
        logWarn: () => undefined,
        logError: () => undefined,
    });
    if (result.response) {
        return result.response.status === 200 ? await result.response.text() : null;
    }
    // A resolved job: the segment handler serves `<job.outputDir>/<segment>`.
    const served = path.join(result.job!.outputDir, SEGMENT);
    return (await exists(served)) ? await fs.readFile(served, 'utf8') : null;
}

/** Steps 1–3 without a resident job: X's output (stamped for `stampItem`,
 *  or unstamped) at WEB's `<sid>/gen-0001`, and WRK's replaced Y row. */
async function leftoverOnWeb(opts: { stampItem: 'x' | null }): Promise<Scenario> {
    const user = await makeUser();
    const itemX = await makeItem();
    const itemY = await makeItem();
    const sid = randomUUID();
    const webOutputDir = path.join('/tmp/transcode-stale-output-test', sid, 'gen-0001');
    await fs.mkdir(path.join(webOutputDir, 'stream_0'), { recursive: true });
    await fs.writeFile(path.join(webOutputDir, SEGMENT), X_BYTES);
    if (opts.stampItem === 'x') {
        await writeOutputMarker(webOutputDir, {
            itemId: itemX,
            podName: 'pod-web',
            jobId: randomUUID(),
        });
    }
    const s = { sid, user, itemX, itemY, webOutputDir };
    await wrkReplacesRowWithY(s);
    return s;
}

describe('§6.3: a takeover never disk-serves another item job’s leftover output', () => {
    const started: string[] = [];

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HOSTNAME', 'pod-web');
    });

    afterEach(async () => {
        const svc = getFFmpegTranscodeService();
        for (const sid of started.splice(0)) {
            await svc.stopJob(sid, 'test_cleanup').catch(() => undefined);
        }
        vi.unstubAllEnvs();
    });

    it("cross-pod item switch, the loser stops, a takeover on the loser's pod: not the loser's bytes", async () => {
        const s = await startXOnWeb();
        started.push(s.sid);
        await wrkReplacesRowWithY(s);

        expect(await getFFmpegTranscodeService().stopJob(s.sid, 'client_request')).toBe(true);

        expect(await segmentRequestOnWeb(s, s.itemY)).not.toBe(X_BYTES);
    });

    it("the disk-serve refuses output stamped for another item at the row's output_dir", async () => {
        // No job on WEB at all: whatever left it there (a stop, a crash, a
        // restart that kept a live session's dir), X's stamped output sits at
        // the path the Y row names. Only the seam itself can refuse it.
        const s = await leftoverOnWeb({ stampItem: 'x' });
        started.push(s.sid);

        expect(await segmentRequestOnWeb(s, s.itemY)).not.toBe(X_BYTES);
    });

    it('the disk-serve refuses unstamped output (legacy dir, or a failed stamp): fail closed', async () => {
        const s = await leftoverOnWeb({ stampItem: null });
        started.push(s.sid);

        expect(await segmentRequestOnWeb(s, s.itemY)).not.toBe(X_BYTES);
    });

    it('the loser reclaims its own output when the row was replaced for another item (per-container dir)', async () => {
        const s = await startXOnWeb();
        started.push(s.sid);
        await wrkReplacesRowWithY(s);

        await getFFmpegTranscodeService().stopJob(s.sid, 'client_request');

        expect(await exists(s.webOutputDir)).toBe(false);
    });

    it("shared mount: the loser leaves the dir alone once the new item's job has spawned into it", async () => {
        const s = await startXOnWeb();
        started.push(s.sid);
        await wrkReplacesRowWithY(s);
        // On a shared FFMPEG_TRANSCODE_DIR, WRK's Y spawn stamps the same
        // <sid>/gen-0001 — it is Y's live output now, not WEB's to delete.
        await writeOutputMarker(s.webOutputDir, {
            itemId: s.itemY,
            podName: 'pod-wrk',
            jobId: randomUUID(),
        });

        await getFFmpegTranscodeService().stopJob(s.sid, 'client_request');

        expect(await exists(s.webOutputDir)).toBe(true);
    });

    it('control: a same-item takeover still disk-serves the output (08a037df8 keeps it for the new owner)', async () => {
        const s = await startXOnWeb();
        started.push(s.sid);
        // A peer's takeover of the SAME job: only pod_name flips (and the peer
        // then goes quiet, so the row is stale again when WEB is asked).
        await sql`
            UPDATE active_transcode_jobs
            SET pod_name = 'pod-wrk', status = 'running',
                last_accessed_at = ${new Date(Date.now() - STALE_MS)}
            WHERE play_session_id = ${s.sid}
        `;

        await getFFmpegTranscodeService().stopJob(s.sid, 'client_request');
        expect(await exists(path.join(s.webOutputDir, SEGMENT))).toBe(true);

        expect(await segmentRequestOnWeb(s, s.itemX)).toBe(X_BYTES);
    });
});
