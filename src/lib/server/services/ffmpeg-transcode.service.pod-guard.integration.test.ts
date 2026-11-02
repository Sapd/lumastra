// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * D-HLS-1 follow-up (security runtime pass 2026-09-26, pod-guard): fix (b)
 * (`upsertJob`'s full-replace) leaves the WINNER of a cross-process /
 * case-variant start race with a self-consistent row, but the LOSER's own
 * resident job keeps running in ITS process until its own
 * stop/error/inactivity path fires — and every one of those paths calls
 * `updateStatus` keyed by `play_session_id` alone. Without a pod guard, the
 * loser's write lands on the WINNER's live row: (i) the winner's own pod
 * sees its live job as DB-`stopped` and tears it down, and (ii)
 * `claimJobForRestoration` accepts a `stopped` row regardless of `pod_name`,
 * so a later request can respawn a SECOND FFmpeg for the winner's item into
 * the winner's `output_dir`.
 *
 * This drives the fix through the REAL service path: the REAL
 * `FFmpegTranscodeService` singleton's `stopJob(sid, 'shutdown', true)` (the
 * graceful-shutdown persistForRestart branch,
 * `ffmpeg-transcode.service.ts` ~2970) against REAL Postgres persistence,
 * simulating the winner having already replaced the row (a separate
 * `upsertJob` call, exactly as a genuinely separate process would have done)
 * while this pod's `process.env.HOSTNAME` is unchanged.
 */

const mockCfg = vi.hoisted(() => ({
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 0, // 0 = no cap
    FFMPEG_MAX_JOBS_PER_USER: 1000,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-d-hls-1-pod-guard-test',
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

const logInfo = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: logInfo,
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
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../tests/integration/fixtures/media.fixtures.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';
import {
    upsertJob,
    getJob as getJobRow,
    claimJobForRestoration,
} from '../database/queries/transcode-jobs.queries.js';
import {
    getCurrentPodName,
    getTranscodeJobPersistenceService,
} from './transcode-job-persistence.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { TranscodeJobConfig } from './transcoding/types.js';

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
        title: 'D-HLS-1 pod-guard test item',
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

describe('D-HLS-1 follow-up: updateStatus pod-guard through the real stopJob(persistForRestart) path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // vi.stubEnv (not a raw assignment) so an originally-UNSET HOSTNAME is
        // truly restored on unstub — `process.env.X = undefined` coerces to
        // the string `"undefined"` on Node's `process.env`, not back to unset.
        vi.stubEnv('HOSTNAME', 'pod-web');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("does not stamp the winner's live row when this (losing) pod graceful-shutdowns its own orphaned job", async () => {
        const user = await makeUser();
        const itemX = await makeItem();
        const itemY = await makeItem();
        const sid = randomUUID();

        const svc = getFFmpegTranscodeService();

        // This (losing) pod starts X — persisted with pod_name='pod-web'
        // (this process's own HOSTNAME) via the real startJob -> saveJob path.
        await svc.startJob(buildConfig(itemX, user.username, sid));
        const rowAfterStart = await getJobRow(sql, sid);
        expect(rowAfterStart?.item_id).toBe(itemX);
        expect(rowAfterStart?.pod_name).toBe('pod-web');

        // Simulate a SEPARATE process ("pod-wrk") winning the D-HLS-1 race for
        // the SAME session id with a DIFFERENT item — exactly what upsertJob's
        // fix (b) full-replace produces from a genuinely different process.
        // Driven directly through the real upsertJob query (not through this
        // service instance), matching how an actually separate process would
        // have written it.
        await upsertJob(sql, {
            play_session_id: sid,
            job_id: 'job-y-winner',
            item_id: itemY,
            user_id: toUserId(user.userId),
            device_id: 'test-device',
            config: { itemId: itemY },
            output_dir: '/tmp/out-y-winner',
            status: 'running',
            mode: 'full',
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: 'pod-wrk',
            ffmpeg_pid: null,
            created_at: new Date(),
            last_accessed_at: new Date(),
            last_progress_at: new Date(),
            transcode_decision: null,
            can_restore: false,
        });
        const rowAfterWin = await getJobRow(sql, sid);
        expect(rowAfterWin?.item_id).toBe(itemY);
        expect(rowAfterWin?.pod_name).toBe('pod-wrk');

        // This pod's OWN job for X is still resident in memory (it never
        // learned about the race) — a graceful shutdown now retires it via
        // the real stopJob(persistForRestart=true) path, which used to call
        // updateStatus(sid, 'stopped', undefined, true) unconditionally.
        // process.env.HOSTNAME is still 'pod-web' here.
        const stopped = await svc.stopJob(sid, 'shutdown', true);
        expect(stopped).toBe(true);

        // The winner's row must be untouched: still Y, still pod-wrk,
        // still 'running', can_restore still false (NOT flipped to true).
        const rowAfterStop = await getJobRow(sql, sid);
        expect(rowAfterStop?.item_id).toBe(itemY);
        expect(rowAfterStop?.pod_name).toBe('pod-wrk');
        expect(rowAfterStop?.status).toBe('running');
        expect(rowAfterStop?.can_restore).toBe(false);
    });

    // M5 (final review, PASS_WITH_CONCERNS): getCurrentPodName()'s fallback
    // must match what a HOSTNAME-less install's claim/takeover path writes
    // (`'unknown'`, not `null`), or this pod's own status write on a row it
    // just claimed would be refused by its own guard.
    it('HOSTNAME unset: claiming a row and then writing its own status both resolve to the SAME pod name, so the write applies', async () => {
        vi.stubEnv('HOSTNAME', ''); // falsy — same effective fallback as unset
        const user = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();

        // Seed a dormant, unowned, restorable row — the shape
        // claimJobForRestoration is meant to pick up (pod_name IS NULL).
        await upsertJob(sql, {
            play_session_id: sid,
            job_id: 'job-dormant',
            item_id: itemX,
            user_id: toUserId(user.userId),
            device_id: 'test-device',
            config: { itemId: itemX },
            output_dir: '/tmp/out-dormant',
            status: 'stopped',
            mode: 'full',
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: null,
            ffmpeg_pid: null,
            created_at: new Date(),
            last_accessed_at: new Date(),
            last_progress_at: new Date(),
            transcode_decision: null,
            can_restore: true,
        });

        // Hardcoded to the literal 'unknown' — NOT via getCurrentPodName() —
        // because this line stands in for lumastra-segment-handler.ts's
        // currentPodName computation on the claim/takeover path (also
        // `process.env.HOSTNAME || 'unknown'`, out of this fix's scope,
        // frozen while another implementer edits that file). Hardcoding it
        // pins the real invariant: getCurrentPodName()'s fallback must equal
        // THIS literal, not just be self-consistent with itself.
        const claimed = await claimJobForRestoration(sql, {
            playSessionId: sid,
            podName: 'unknown',
        });
        expect(claimed).toBe(true);
        const rowAfterClaim = await getJobRow(sql, sid);
        expect(rowAfterClaim?.pod_name).toBe('unknown');

        // This pod's OWN subsequent status write, guarded on the SAME helper.
        const persistence = getTranscodeJobPersistenceService();
        await persistence.updateStatus(sid, 'stopped', undefined, true, getCurrentPodName());

        const rowAfterStatus = await getJobRow(sql, sid);
        expect(rowAfterStatus?.status).toBe('stopped');
        expect(rowAfterStatus?.can_restore).toBe(true);
        expect(rowAfterStatus?.pod_name).toBe('unknown');
    });
});

// HLS fixes report §4 open item 2 (shared transcode mount): stopJob's
// output deletes — the current generation dir, retained generations and the
// session dir — and the dormant reaper's session-dir delete ran on this pod's
// in-memory job alone. After a peer took the session over (the row's
// pod_name flipped to the peer, output_dir unchanged), this pod's stop or
// reaper removed the directory the peer's restored FFmpeg is writing into on a
// shared FFMPEG_TRANSCODE_DIR. The deletes now follow the row's owner.
describe('stopJob / reaper output deletes are pod-guarded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HOSTNAME', 'pod-web');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    async function startThenTakeOver(): Promise<string> {
        const user = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        const svc = getFFmpegTranscodeService();
        await svc.startJob(buildConfig(itemX, user.username, sid));
        expect((await getJobRow(sql, sid))?.pod_name).toBe('pod-web');
        // A peer's takeover flips only pod_name (takeOverStaleJob /
        // claimJobForRestoration keep item_id and output_dir).
        await sql`
            UPDATE active_transcode_jobs SET pod_name = 'pod-wrk'
            WHERE play_session_id = ${sid}
        `;
        mockFileManager.deleteOutputDirectory.mockClear();
        return sid;
    }

    it("an explicit stop on the losing pod deletes none of the peer's output", async () => {
        const sid = await startThenTakeOver();
        const svc = getFFmpegTranscodeService();

        expect(await svc.stopJob(sid, 'client_request')).toBe(true);

        expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalled();
        // The in-memory job is still released, and the peer's row survives.
        expect(svc.getJobByPlaySession(sid)).toBeUndefined();
        expect((await getJobRow(sql, sid))?.pod_name).toBe('pod-wrk');
    });

    it("the inactivity reaper on the losing pod deletes none of the peer's output", async () => {
        const sid = await startThenTakeOver();
        const svc = getFFmpegTranscodeService();
        const job = svc.getJobByPlaySession(sid);
        expect(job).toBeDefined();
        // Idle on this pod: the client now talks to the peer. (The mocked
        // spawn never advances the status; the reaper only looks at
        // ready/running jobs.)
        job!.status = 'running';
        job!.lastAccessedAt = new Date(0);
        job!.lastProgressAt = new Date(0);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();

        expect(svc.getJobByPlaySession(sid)).toBeUndefined();
        expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalled();
    });

    it('control: a stop on the owning pod still deletes the generation and session dirs', async () => {
        const user = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        const svc = getFFmpegTranscodeService();
        await svc.startJob(buildConfig(itemX, user.username, sid));
        mockFileManager.deleteOutputDirectory.mockClear();

        expect(await svc.stopJob(sid, 'client_request')).toBe(true);

        const deleted = mockFileManager.deleteOutputDirectory.mock.calls.map((c) => String(c[0]));
        expect(deleted.some((d) => d.endsWith(sid))).toBe(true);
        expect(deleted.some((d) => d.includes(`${sid}/`))).toBe(true);
        expect(await getJobRow(sql, sid)).toBeNull();
    });
});

// HLS fixes report §4 "loser progress writes": the own-job progress flush
// (segments_ready / master_playlist_ready), the client progress heartbeat
// (last_progress_at) and getJob's access stamp (last_accessed_at +
// last_progress_at) were keyed by play_session_id alone, so a pod that lost
// the session kept rewriting the new owner's row: wrong readiness for the
// cross-pod fallback, and freshness that kept a dead owner's row from ever
// looking stale enough to take over.
describe('own-job progress and freshness writes are pod-guarded', () => {
    const OLD = new Date('2026-01-01T00:00:00Z');

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HOSTNAME', 'pod-web');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    async function startAndAge(ownerPod: string): Promise<string> {
        const user = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        await getFFmpegTranscodeService().startJob(buildConfig(itemX, user.username, sid));
        await sql`
            UPDATE active_transcode_jobs
            SET pod_name = ${ownerPod}, segments_ready = 0, master_playlist_ready = false,
                last_accessed_at = ${OLD}, last_progress_at = ${OLD}
            WHERE play_session_id = ${sid}
        `;
        return sid;
    }

    async function flushProgress(sid: string): Promise<void> {
        const svc = getFFmpegTranscodeService();
        const job = svc.getJobByPlaySession(sid)!;
        job.status = 'running';
        job.segmentsReady = 42;
        job.masterPlaylistReady = true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).persistJobProgress();
    }

    it("the losing pod's progress flush leaves the owner's readiness alone", async () => {
        const sid = await startAndAge('pod-wrk');
        await flushProgress(sid);
        const row = await getJobRow(sql, sid);
        expect(row?.segments_ready).toBe(0);
        expect(row?.master_playlist_ready).toBe(false);
    });

    it('control: the owning pod still flushes its progress', async () => {
        const sid = await startAndAge('pod-web');
        await flushProgress(sid);
        const row = await getJobRow(sql, sid);
        expect(row?.segments_ready).toBe(42);
        expect(row?.master_playlist_ready).toBe(true);
    });

    it("the losing pod's heartbeat and access stamp leave the owner's freshness alone", async () => {
        const sid = await startAndAge('pod-wrk');
        const svc = getFFmpegTranscodeService();
        const persistence = getTranscodeJobPersistenceService();
        const progressSpy = vi.spyOn(persistence, 'updateLastProgress');
        const accessSpy = vi.spyOn(persistence, 'updateLastAccessed');

        svc.recordProgressHeartbeat(sid, 'ACTIVE');
        svc.getJob(sid);
        // Both writes are fire-and-forget; wait on the calls themselves.
        await Promise.all([
            ...progressSpy.mock.results.map((r) => r.value),
            ...accessSpy.mock.results.map((r) => r.value),
        ]);
        expect(progressSpy).toHaveBeenCalledTimes(1);
        expect(accessSpy).toHaveBeenCalledTimes(1);

        const row = await getJobRow(sql, sid);
        expect(row?.last_progress_at.getTime()).toBe(OLD.getTime());
        expect(row?.last_accessed_at.getTime()).toBe(OLD.getTime());
    });

    it('control: the owning pod still refreshes its own freshness', async () => {
        const sid = await startAndAge('pod-web');
        const svc = getFFmpegTranscodeService();
        const persistence = getTranscodeJobPersistenceService();
        const accessSpy = vi.spyOn(persistence, 'updateLastAccessed');

        svc.getJob(sid);
        await Promise.all(accessSpy.mock.results.map((r) => r.value));

        const row = await getJobRow(sql, sid);
        expect(row?.last_accessed_at.getTime()).toBeGreaterThan(OLD.getTime());
    });
});

// Output-delete pod guard regression coverage:
// - the retained-generation TTL sweep in cleanupInactiveJobs deleted the
//   generation dir and swept the session dir with no ownership check;
// - no test put a RETAINED generation through the guarded stopJob loop;
// - the ownership read ran BEFORE retireJobGeneration's killFFmpeg, which
//   waits up to forceKillTimeout (5 s) — a takeover landing in that window
//   was answered by a stale "ours".
describe('output-delete pod guard: retained generations, TTL sweep, takeover during the kill', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HOSTNAME', 'pod-web');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    /** Registers a retained ('previous') generation beside the session's current job. */
    function addRetainedGeneration(sid: string, ageMs = 0): string {
        const svc = getFFmpegTranscodeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const internals = svc as any;
        const current = svc.getJobByPlaySession(sid)!;
        const id = `retained-${randomUUID()}`;
        const outputDir = `${current.outputDir}-retained`;
        internals.jobs.set(id, {
            ...current,
            id,
            generationRole: 'previous',
            outputDir,
            endSegmentCache: new Map(),
            lastAccessedAt: new Date(Date.now() - ageMs),
        });
        internals.sessions.get(sid.toLowerCase()).retainedJobIds.push(id);
        return outputDir;
    }

    async function startJobHere(): Promise<string> {
        const user = await makeUser();
        const itemX = await makeItem();
        const sid = randomUUID();
        await getFFmpegTranscodeService().startJob(buildConfig(itemX, user.username, sid));
        return sid;
    }

    async function takeOver(sid: string): Promise<void> {
        await sql`
            UPDATE active_transcode_jobs SET pod_name = 'pod-wrk'
            WHERE play_session_id = ${sid}
        `;
    }

    it("the retained-generation TTL sweep on the losing pod deletes none of the peer's output", async () => {
        const sid = await startJobHere();
        addRetainedGeneration(sid, 10 * 60_000);
        await takeOver(sid);
        mockFileManager.deleteOutputDirectory.mockClear();
        mockFileManager.cleanupSessionDirectory.mockClear();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (getFFmpegTranscodeService() as any).cleanupInactiveJobs();

        expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalled();
        expect(mockFileManager.cleanupSessionDirectory).not.toHaveBeenCalled();
    });

    it('control: the TTL sweep on the owning pod still removes the retained generation', async () => {
        const sid = await startJobHere();
        const retainedDir = addRetainedGeneration(sid, 10 * 60_000);
        mockFileManager.deleteOutputDirectory.mockClear();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (getFFmpegTranscodeService() as any).cleanupInactiveJobs();

        expect(mockFileManager.deleteOutputDirectory).toHaveBeenCalledWith(retainedDir);
        expect(mockFileManager.cleanupSessionDirectory).toHaveBeenCalled();
    });

    it("stopJob on the losing pod leaves a retained generation's output alone", async () => {
        const sid = await startJobHere();
        addRetainedGeneration(sid);
        await takeOver(sid);
        mockFileManager.deleteOutputDirectory.mockClear();

        expect(await getFFmpegTranscodeService().stopJob(sid, 'client_request')).toBe(true);

        expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalled();
    });

    it('control: stopJob on the owning pod deletes the retained generation too', async () => {
        const sid = await startJobHere();
        const retainedDir = addRetainedGeneration(sid);
        mockFileManager.deleteOutputDirectory.mockClear();

        expect(await getFFmpegTranscodeService().stopJob(sid, 'client_request')).toBe(true);

        expect(mockFileManager.deleteOutputDirectory).toHaveBeenCalledWith(retainedDir);
    });

    it('a takeover that lands while FFmpeg is being killed is honoured: nothing is deleted', async () => {
        const sid = await startJobHere();
        mockFileManager.deleteOutputDirectory.mockClear();
        // The kill waits for the process (up to forceKillTimeout); the peer's
        // takeover commits inside that wait.
        mockProcessRunner.killFFmpeg.mockImplementationOnce(async () => {
            await takeOver(sid);
        });

        expect(await getFFmpegTranscodeService().stopJob(sid, 'client_request')).toBe(true);

        expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalled();
        expect((await getJobRow(sql, sid))?.pod_name).toBe('pod-wrk');
    });

    it("HOSTNAME unset: this pod's own progress/freshness writes land on the row it owns as 'unknown'", async () => {
        vi.stubEnv('HOSTNAME', '');
        const sid = await startJobHere();
        const old = new Date('2026-01-01T00:00:00Z');
        await sql`
            UPDATE active_transcode_jobs
            SET segments_ready = 0, last_accessed_at = ${old}, last_progress_at = ${old}
            WHERE play_session_id = ${sid}
        `;
        expect((await getJobRow(sql, sid))?.pod_name).toBe('unknown');

        const svc = getFFmpegTranscodeService();
        const persistence = getTranscodeJobPersistenceService();
        const accessSpy = vi.spyOn(persistence, 'updateLastAccessed');
        const job = svc.getJobByPlaySession(sid)!;
        job.status = 'running';
        job.segmentsReady = 7;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).persistJobProgress();
        svc.getJob(sid);
        await Promise.all(accessSpy.mock.results.map((r) => r.value));
        accessSpy.mockRestore();

        const row = await getJobRow(sql, sid);
        expect(row?.segments_ready).toBe(7);
        expect(row?.last_accessed_at.getTime()).toBeGreaterThan(old.getTime());
    });
});

describe('boot orphan sweep preserves resumable jobs', () => {
    it.each(['running', 'stopping'])(
        'retires a stale restorable peer in %s state and counts it',
        async (status) => {
            logInfo.mockClear();
            const user = await makeUser();
            const itemId = await makeItem();
            const sid = randomUUID();
            const old = new Date(Date.now() - 20 * 60 * 1000);
            await upsertJob(sql, {
                play_session_id: sid,
                job_id: 'boot-restorable',
                item_id: itemId,
                user_id: toUserId(user.userId),
                device_id: 'test-device',
                config: { itemId },
                output_dir: '/tmp/boot-restorable',
                status,
                mode: 'full',
                segment_offset: 0,
                segments_ready: 3,
                master_playlist_ready: true,
                pod_name: 'dead-peer',
                ffmpeg_pid: null,
                created_at: old,
                last_accessed_at: old,
                last_progress_at: old,
                transcode_decision: null,
                can_restore: true,
            });
            const svc = getFFmpegTranscodeService();
            await (
                svc as unknown as { cleanupOrphanedJobs(): Promise<void> }
            ).cleanupOrphanedJobs();
            expect(logInfo).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ orphanedCount: 1 }),
            );
            if (status === 'stopping') {
                expect(await getJobRow(sql, sid)).toBeNull();
                return;
            }
            const dormant = await getJobRow(sql, sid);
            expect(dormant).toMatchObject({
                status: 'stopped',
                can_restore: true,
                output_dir: '/tmp/boot-restorable',
            });
            expect(dormant!.last_accessed_at.getTime()).toBeGreaterThan(Date.now() - 60000);
            expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalledWith(
                '/tmp/boot-restorable',
            );
            expect(
                await claimJobForRestoration(sql, { playSessionId: sid, podName: 'new-peer' }),
            ).toBe(true);
        },
    );
});
