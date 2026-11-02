// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Jellyfin client resuming at T must not run two encodes at once — with REAL
 * FFmpeg processes, checked by their kernel state.
 *
 * Prod 2026-10-02, Android TV, 4K HDR + PGS burn-in on one GPU: PlaybackInfo
 * carries StartTimeTicks, so generation 1 starts at T. ExoPlayer first requests
 * segment 0 (backward seek → generation 2 at 0, generation 1 kept running),
 * then jumps back to T. Generation 1 had not reached T yet with the GPU shared,
 * so the jump forward-seeked a THIRD generation and retired generation 1: ~23 s
 * to resume, two heavy encodes in parallel the whole time.
 *
 * Now generation 1 — demoted before it served anything — is parked (SIGSTOP);
 * the jump back reclaims it (SIGCONT, roles swap, no new spawn) and parks the
 * probe generation. A REAL seek to 0 never comes back: generation 1 stays
 * parked and the retained-generation TTL kills it (a stopped process must
 * still die).
 *
 * Real here: the service singleton, process runner (spawn, progress parsing,
 * kill), file manager, Postgres persistence and generation router. Only the
 * argument builder is replaced by a long CPU encode of a synthetic source. Needs
 * ffmpeg with libx264 and Linux /proc (CI has both).
 */

const mockCfg = vi.hoisted(() => ({
    FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 0,
    FFMPEG_MAX_JOBS_PER_USER: 1000,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-probe-reclaim-test',
    FFMPEG_MAX_GENERATIONS_PER_SESSION: 2,
    TRANSCODE_DOWNSCALE_CPU_TO_1080P: false,
    MAX_WIDTH: 0,
    MAX_HEIGHT: 0,
    PREVIEW_TRANSCODE_MAX_SECONDS: 0,
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS: 20,
    FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS: 20,
    TRANSCODE_THROTTLE: true,
    THROTTLE_AFTER_SECONDS: 120,
}));

vi.mock('$lib/server/config.js', async () => ({
    ...(await import('../tasks/__fixtures__/task-config-mock.js')).taskConfigMock(),
    config: new Proxy(mockCfg, {
        get(target, prop: string) {
            return target[prop as keyof typeof target];
        },
    }),
}));

vi.mock('./transcoding/iframe-analyzer.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    IFrameAnalyzer: vi.fn(function (this: any) {
        this.startAnalysis = vi.fn();
        this.stopAnalysis = vi.fn();
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

vi.mock('./transcoding/index.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./transcoding/index.js')>();
    const decision = { mode: 'full', videoAction: 'transcode', audioAction: 'copy', useGpu: false };
    return {
        ...real,
        transcodeDecision: {
            decide: vi.fn().mockResolvedValue(decision),
            consumePlan: vi.fn().mockResolvedValue(decision),
        },
    };
});

vi.mock('./transcoding/ffmpeg-stats-cache.js', () => ({
    publishJobStats: vi.fn().mockResolvedValue(undefined),
    readJobStats: vi.fn().mockResolvedValue(null),
    deleteJobStats: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Imports after mocks
// ============================================================================
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../tests/integration/fixtures/media.fixtures.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';
import { JELLYFIN_COMPAT_DEVICE_ID } from './transcode-job-persistence.service.js';
import type { TranscodeJob } from './transcoding/types.js';

const sql = getTestDb();
const SEGMENT_SECONDS = 6;
/** Where the client resumes: segment 600 = 3600 s. */
const RESUME_SEGMENT = 600;

function hasLibx264(): boolean {
    try {
        const out = execFileSync(mockCfg.FFMPEG_PATH, ['-hide_banner', '-encoders'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.includes('libx264');
    } catch {
        return false;
    }
}

function longEncodeArgs(job: TranscodeJob): string[] {
    mkdirSync(job.outputDir, { recursive: true });
    return [
        '-hide_banner',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=25',
        '-t',
        '7200',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-threads',
        '1',
        '-g',
        '150',
        '-f',
        'hls',
        '-hls_time',
        String(SEGMENT_SECONDS),
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        `${job.outputDir}/seg_%d.ts`,
        '-master_pl_name',
        'master.m3u8',
        `${job.outputDir}/index.m3u8`,
    ];
}

/** Kernel state of a process: 'T' = stopped, 'R'/'S' = running/sleeping, null = gone. */
function procState(pid: number | undefined): string | null {
    if (!pid) return null;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    } catch {
        return null;
    }
}

async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 200));
    }
}

const canRun = hasLibx264() && existsSync('/proc/self/stat');

describe.skipIf(!canRun)('a Jellyfin resume probe with real FFmpeg', () => {
    let username: string;
    let itemId: string;
    const sessions: string[] = [];

    beforeAll(async () => {
        vi.stubEnv('HOSTNAME', 'pod-web-0');
        rmSync(mockCfg.FFMPEG_TRANSCODE_DIR, { recursive: true, force: true });
        mkdirSync(mockCfg.FFMPEG_TRANSCODE_DIR, { recursive: true });
        const userId = randomUUID();
        await ensureTestUser(sql, userId);
        username = derivedUsername(userId);
        itemId = randomUUID();
        await insertTestMediaItem(sql, {
            id: itemId,
            title: 'probe-reclaim item',
            original_title: null,
            media_type: 'movie',
            year: 2020,
            status: 'active',
            parent_id: null,
            has_files: true,
        });
        const svc = getFFmpegTranscodeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vi.spyOn(svc as any, 'buildFFmpegArgs').mockImplementation((job) =>
            longEncodeArgs(job as TranscodeJob),
        );
    });

    afterEach(async () => {
        const svc = getFFmpegTranscodeService();
        for (const sid of sessions.splice(0)) await svc.stopJob(sid, 'test_cleanup');
    });

    afterAll(async () => {
        await getFFmpegTranscodeService().shutdown();
        vi.unstubAllEnvs();
        rmSync(mockCfg.FFMPEG_TRANSCODE_DIR, { recursive: true, force: true });
    });

    /** PlaybackInfo with StartTimeTicks → master.m3u8: generation 1 at the resume point. */
    async function startResumedJob(): Promise<{ sid: string; gen1: TranscodeJob }> {
        const svc = getFFmpegTranscodeService();
        const sid = randomUUID().replace(/-/g, '');
        sessions.push(sid);
        const gen1 = await svc.startJob({
            itemId,
            username,
            deviceId: JELLYFIN_COMPAT_DEVICE_ID,
            playSessionId: sid,
            inputUrl: '/dev/null',
            localFilePath: '/dev/null',
            audioTracks: [],
            transcodeMode: 'full',
            totalDurationSeconds: 7200,
            startTimeSeconds: RESUME_SEGMENT * SEGMENT_SECONDS,
        });
        await waitFor(() => gen1.status === 'ready' || gen1.status === 'running', 60_000, 'gen 1');
        expect(gen1.segmentOffset).toBe(RESUME_SEGMENT);
        return { sid, gen1 };
    }

    /** What the segment route does for a request: route it, then record the access. */
    async function request(
        sid: string,
        segment: number,
        opts: { streamDir?: string; allowReclaim?: boolean } = {},
    ): Promise<{ job: TranscodeJob; reason?: string }> {
        const svc = getFFmpegTranscodeService();
        const route = await svc.resolveSegmentRoute(sid, opts.streamDir ?? '', segment, {
            fallbackSegmentExtension: 'ts',
            allowReclaim: opts.allowReclaim,
        });
        const job = route?.job ?? svc.getJobByPlaySession(sid)!;
        job.lastAccessedAt = new Date();
        return { job, reason: route?.reason };
    }

    it('the probe parks the resume generation, the jump back reclaims it — never three encodes', async () => {
        const svc = getFFmpegTranscodeService();
        const { sid, gen1 } = await startResumedJob();
        const pid1 = gen1.process?.pid;

        // ExoPlayer's first request: segment 0, before T. It routes to generation 1
        // (offset 600), which the planner answers with a backward seek.
        expect((await request(sid, 0)).job.id).toBe(gen1.id);
        expect(await svc.seekToSegment(sid, 0, SEGMENT_SECONDS)).toBe(true);
        const gen2 = svc.getJobByPlaySession(sid)!;
        expect(gen2.id).not.toBe(gen1.id);
        const pid2 = gen2.process?.pid;

        // Generation 1 never served a segment: parked, really stopped.
        expect(gen1.generationRole).toBe('previous');
        expect(gen1.parked).toBe('unwatched');
        await waitFor(() => procState(pid1) === 'T', 5_000, 'gen 1 stopped');
        expect(procState(pid2)).not.toBe('T');

        // The probe reads segments 0 and 1 from generation 2.
        await waitFor(() => gen2.segmentsReady >= 2, 60_000, 'gen 2 segments');
        for (const seg of [0, 1]) {
            const { job } = await request(sid, seg);
            expect(job.id).toBe(gen2.id);
            svc.recordSegmentAccessForJob(job, '', seg);
        }

        // A slow start: generation 1 was created long ago and has served nothing.
        gen1.unwatchedGraceAnchor = new Date(Date.now() - 10 * 60_000);

        // The jump back to T: generation 1 is reclaimed — resumed and current
        // again — instead of a third generation being spawned.
        const jump = await request(sid, RESUME_SEGMENT + 2);
        expect(jump.reason).toBe('retained-reclaim');
        expect(jump.job.id).toBe(gen1.id);
        expect(svc.getJobByPlaySession(sid)?.id).toBe(gen1.id);
        expect(gen1.generationRole).toBe('current');
        expect(gen1.parked).toBeUndefined();
        expect(procState(pid1)).not.toBe('T');
        expect(gen1.process?.pid).toBe(pid1); // the same process, not a respawn

        // The probe generation is parked in its place: one encode running.
        expect(gen2.parked).toBe('superseded');
        await waitFor(() => procState(pid2) === 'T', 5_000, 'gen 2 stopped');

        // The reaper's never-watched arm must not take the job it was just
        // handed back before it serves its first segment.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();
        expect(svc.getJobByPlaySession(sid)?.id).toBe(gen1.id);
        expect(procState(pid1)).not.toBeNull();

        // Generation 1 keeps encoding and produces T+2.
        const before = gen1.segmentsReady;
        await waitFor(() => gen1.segmentsReady > before, 60_000, 'gen 1 progresses after reclaim');
    }, 180_000);

    it('a real seek to 0 is not mistaken for a probe: it keeps playing, and the parked generation is killed by the TTL', async () => {
        const svc = getFFmpegTranscodeService();
        const { sid, gen1 } = await startResumedJob();
        const pid1 = gen1.process?.pid;

        expect(await svc.seekToSegment(sid, 0, SEGMENT_SECONDS)).toBe(true);
        const gen2 = svc.getJobByPlaySession(sid)!;
        await waitFor(() => procState(pid1) === 'T', 5_000, 'gen 1 stopped');

        // The client stays at the start: 0, 1, 2, 3 …
        await waitFor(() => gen2.segmentsReady >= 4, 90_000, 'gen 2 segments');
        for (const seg of [0, 1, 2, 3]) {
            const { job, reason } = await request(sid, seg);
            expect(job.id).toBe(gen2.id);
            expect(reason).not.toBe('retained-reclaim');
            svc.recordSegmentAccessForJob(job, '', seg);
        }
        expect(svc.getJobByPlaySession(sid)?.id).toBe(gen2.id);
        expect(procState(gen2.process?.pid)).not.toBe('T');

        // The throttle tick must not wake the parked generation.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc as any).applyThrottle(gen1);
        expect(procState(pid1)).toBe('T');

        // Nor may any other wake-up path: a segment wait on it, or a request
        // recorded against it. Only a reclaim or a kill ends parking.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc as any).resumeThrottledJob(gen1, 'segment_not_ready');
        svc.recordSegmentRequestForJob(gen1, '', RESUME_SEGMENT, SEGMENT_SECONDS, false);
        expect(gen1.parked).toBe('unwatched');
        expect(procState(pid1)).toBe('T');

        // The plain retained TTL (20 s idle) does not apply while parked: a 4K
        // burn-in probe alone takes ~17 s and a parked job is never accessed.
        gen1.lastAccessedAt = new Date(Date.now() - 60_000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();
        expect(procState(pid1)).toBe('T');

        // Its own bound (60 s since parked) does — and a STOPPED process must
        // really exit (it only acts on SIGTERM once continued).
        gen1.parkedAt = new Date(Date.now() - 61_000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();
        await waitFor(() => procState(pid1) === null, 15_000, 'parked gen 1 to exit');
        expect(procState(gen2.process?.pid)).not.toBe('T');
    }, 180_000);

    it('a backward seek away from a WATCHED generation does not park it (unchanged behaviour)', async () => {
        const svc = getFFmpegTranscodeService();
        const { sid, gen1 } = await startResumedJob();
        await waitFor(() => gen1.segmentsReady >= 1, 60_000, 'gen 1 segment');
        svc.recordSegmentAccessForJob(gen1, '', RESUME_SEGMENT);

        expect(await svc.seekToSegment(sid, 0, SEGMENT_SECONDS)).toBe(true);
        expect(gen1.generationRole).toBe('previous');
        expect(gen1.parked).toBeUndefined();
        await new Promise((r) => setTimeout(r, 500));
        expect(procState(gen1.process?.pid)).not.toBe('T');
    }, 120_000);

    it('an audio rendition or a thumbnail range request never reclaims (no role swap, still stopped)', async () => {
        const svc = getFFmpegTranscodeService();
        const { sid, gen1 } = await startResumedJob();
        const pid1 = gen1.process?.pid;
        expect(await svc.seekToSegment(sid, 0, SEGMENT_SECONDS)).toBe(true);
        const gen2 = svc.getJobByPlaySession(sid)!;
        await waitFor(() => procState(pid1) === 'T', 5_000, 'gen 1 stopped');

        // This harness has no transcode decision on the job, so every stream
        // counts as video; declare one audio rendition the way a demuxed job has.
        const audioDir = 'stream_0';
        const seekGate = vi
            .spyOn(svc, 'canStreamTriggerSeekForJob')
            .mockImplementation((_job, streamDir) => streamDir !== audioDir);
        const audio = await request(sid, RESUME_SEGMENT + 2, { streamDir: audioDir });
        seekGate.mockRestore();
        expect(audio.reason).not.toBe('retained-reclaim');
        expect(audio.job.id).toBe(gen2.id);

        const thumbnail = await request(sid, RESUME_SEGMENT + 2, { allowReclaim: false });
        expect(thumbnail.reason).not.toBe('retained-reclaim');
        expect(thumbnail.job.id).toBe(gen2.id);

        expect(svc.getJobByPlaySession(sid)?.id).toBe(gen2.id);
        expect(gen1.parked).toBe('unwatched');
        expect(procState(pid1)).toBe('T');

        // The video request still reclaims afterwards.
        expect((await request(sid, RESUME_SEGMENT + 2)).reason).toBe('retained-reclaim');
        expect(svc.getJobByPlaySession(sid)?.id).toBe(gen1.id);
    }, 120_000);
});
