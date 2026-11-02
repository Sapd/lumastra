// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A REAL FFmpeg process must die a bounded time after its client goes away.
 *
 * In a staging cluster, a curl client fetched the master, init and four
 * segments of a full transcode and then exited — no stop call, no heartbeat.
 * Four libx264 jobs kept encoding at full speed (~12 cores) until killed by
 * hand: the reaper's still-encoding arms key off `lastProgressAt`, and the
 * process runner bumps that field on every FFmpeg progress line.
 *
 * Everything that decides the process's lifetime is real here: the service
 * singleton with its real reaper (driven by this test), the process runner
 * (spawn + stderr progress parsing), the file manager and Postgres persistence.
 * Only the argument builder is replaced, by an unbounded, rate-limited CPU
 * encode of a synthetic source, so the encoder is still busy at the deadline. Needs an
 * `ffmpeg` with libx264 (FFMPEG_PATH; CI has one).
 */

// Real wall time: only the client timeout and sweep cadence are shortened.
const CLIENT_GONE_TIMEOUT_S = 3;
const REAPER_SWEEP_S = 0.25;
// Match the process runner's 5 s graceful-kill allowance.
const KILL_SLACK_S = 5;

const mockCfg = vi.hoisted(() => ({
    FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 0,
    FFMPEG_MAX_JOBS_PER_USER: 1000,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-client-gone-test',
    FFMPEG_MAX_GENERATIONS_PER_SESSION: 2,
    TRANSCODE_DOWNSCALE_CPU_TO_1080P: false,
    MAX_WIDTH: 0,
    MAX_HEIGHT: 0,
    PREVIEW_TRANSCODE_MAX_SECONDS: 0,
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS: 3,
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/user.fixtures.js';
import { insertTestMediaItem } from '../../../../tests/integration/fixtures/media.fixtures.js';
import { getFFmpegTranscodeService } from './ffmpeg-transcode.service.js';
import {
    getTranscodeJobPersistenceService,
    JELLYFIN_COMPAT_DEVICE_ID,
} from './transcode-job-persistence.service.js';
import { reapStaleSessions, reapBootOrphanSessions } from './play-sessions.service.js';
import { def as progressDef } from '../api/defs/play-sessions/[id]/transcode-progress.js';
import type { TranscodeJob } from './transcoding/types.js';

const sql = getTestDb();

// Test-only access to the existing sweep: no production timer/config changes,
// no fake clocks (FFmpeg, Postgres NOW(), and all other timers stay real).
type ReaperControl = {
    cleanupInterval: ReturnType<typeof setInterval> | null;
    cleanupInactiveJobs(): Promise<void>;
};

function reaper(): ReaperControl {
    return getFFmpegTranscodeService() as unknown as ReaperControl;
}

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

/** Infinite source; bounded media rate prevents even a fast runner finishing the job. */
function longEncodeArgs(job: TranscodeJob): string[] {
    mkdirSync(job.outputDir, { recursive: true });
    return [
        '-hide_banner',
        '-nostdin',
        '-readrate',
        '50',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=128x72:rate=25',
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
        '6',
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        `${job.outputDir}/seg_%d.ts`,
        '-master_pl_name',
        'master.m3u8',
        `${job.outputDir}/index.m3u8`,
    ];
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 250));
    }
}

/** Seconds until `pid` exits, or `null` if it is still alive at `maxS`. */
async function secondsUntilExit(
    pid: number,
    maxS: number,
    heartbeat?: () => Promise<void>,
): Promise<number | null> {
    const start = Date.now();
    while (Date.now() - start < maxS * 1000) {
        if (!isAlive(pid)) return (Date.now() - start) / 1000;
        // Await each DB heartbeat and full sweep, including persistence and output
        // cleanup after the child exits. No overlapping sweeps or pending writes
        // can leak into restoration/the next test.
        await heartbeat?.();
        await reaper().cleanupInactiveJobs();
        await new Promise((r) => setTimeout(r, REAPER_SWEEP_S * 1000));
    }
    return isAlive(pid) ? null : (Date.now() - start) / 1000;
}

/**
 * Both id shapes a transcode is keyed by. `/j` (Jellyfin-compat) mints dashless
 * 32-hex PlaySessionIds and has its OWN play_sessions row under a different id,
 * so its transcode row must be written without a play_sessions stub; Postgres
 * hands its play_session_id back dashed.
 */
const SESSION_KINDS = [
    { kind: 'web (dashed id)', deviceId: 'lifetime-device', mint: () => randomUUID() },
    {
        kind: '/j (dashless id)',
        deviceId: JELLYFIN_COMPAT_DEVICE_ID,
        mint: () => randomUUID().replace(/-/g, ''),
    },
] as const;

describe.skipIf(!hasLibx264())('a real FFmpeg transcode after its client goes away', () => {
    let username: string;
    let itemId: string;

    beforeAll(async () => {
        // Other files/shards also call shutdown(), whose DB update stops ALL
        // rows for its HOSTNAME. Never share their synthetic pod identity or
        // another invocation's output directory.
        const runId = randomUUID();
        vi.stubEnv('HOSTNAME', `client-gone-${runId}`);
        mockCfg.FFMPEG_TRANSCODE_DIR = `/tmp/transcode-client-gone-test-${runId}`;
        rmSync(mockCfg.FFMPEG_TRANSCODE_DIR, { recursive: true, force: true });
        mkdirSync(mockCfg.FFMPEG_TRANSCODE_DIR, { recursive: true });
        const userId = randomUUID();
        await ensureTestUser(sql, userId);
        username = derivedUsername(userId);
        itemId = randomUUID();
        await insertTestMediaItem(sql, {
            id: itemId,
            title: 'client-gone lifetime item',
            original_title: null,
            media_type: 'movie',
            year: 2020,
            status: 'active',
            parent_id: null,
            has_files: true,
        });
        expect(mockCfg.FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS).toBe(CLIENT_GONE_TIMEOUT_S);
        const svc = getFFmpegTranscodeService();
        const control = reaper();
        if (control.cleanupInterval === null) throw new Error('no reaper interval');
        clearInterval(control.cleanupInterval);
        control.cleanupInterval = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vi.spyOn(svc as any, 'buildFFmpegArgs').mockImplementation((job) =>
            longEncodeArgs(job as TranscodeJob),
        );
    });

    afterAll(async () => {
        const svc = getFFmpegTranscodeService();
        await svc.shutdown();
        vi.unstubAllEnvs();
        rmSync(mockCfg.FFMPEG_TRANSCODE_DIR, { recursive: true, force: true });
    });

    describe.each(SESSION_KINDS)('$kind', ({ kind, deviceId, mint }) => {
        /** Start a job, let a "client" pull four segments, return its FFmpeg pid. */
        async function startWatchedJob(): Promise<{ sid: string; job: TranscodeJob; pid: number }> {
            const svc = getFFmpegTranscodeService();
            const sid = mint();
            const job = await svc.startJob({
                itemId,
                username,
                deviceId,
                playSessionId: sid,
                inputUrl: '/dev/null',
                localFilePath: '/dev/null',
                audioTracks: [],
                transcodeMode: 'full',
                totalDurationSeconds: 7200,
            });
            await waitFor(() => job.status === 'ready' && job.segmentsReady >= 4, 60_000);
            const pid = job.process?.pid;
            if (!pid || !isAlive(pid)) throw new Error(`no live ffmpeg pid: ${job.error}`);
            // What the segment route does per request.
            for (let i = 0; i < 4; i++) svc.recordSegmentAccessForJob(job, '', i);
            job.lastAccessedAt = new Date();
            svc.recordProgressHeartbeat(sid, 'ACTIVE');
            return { sid, job, pid };
        }

        if (kind === 'web (dashed id)') {
            it('progress polls never refresh access, and a CRASHED session returns 404', async () => {
                const { sid, job } = await startWatchedJob();
                const svc = getFFmpegTranscodeService();
                try {
                    const [session] =
                        await sql`SELECT user_id FROM play_sessions WHERE id = ${sid}`;
                    const accessed = new Date(Date.now() - 60_000);
                    job.lastAccessedAt = accessed;
                    await sql`UPDATE active_transcode_jobs SET last_accessed_at = ${accessed} WHERE play_session_id = ${sid}`;
                    const poll = () =>
                        progressDef.handlers.GET!(
                            { locals: { user: { userId: session.user_id } } } as never,
                            { input: { params: { id: sid } } } as never,
                        );
                    expect((await poll()).status).toBe(200);
                    expect(job.lastAccessedAt).toEqual(accessed);
                    await sql`UPDATE play_sessions SET status = 'CRASHED', stop_reason = 'heartbeat_timeout' WHERE id = ${sid}`;
                    expect((await poll()).status).toBe(404);
                    expect(job.lastAccessedAt).toEqual(accessed);
                    const [row] =
                        await sql`SELECT last_accessed_at FROM active_transcode_jobs WHERE play_session_id = ${sid}`;
                    expect(row.last_accessed_at).toEqual(accessed);
                } finally {
                    await svc.stopJob(sid, 'test_cleanup');
                }
            }, 120_000);

            it.each([
                ['heartbeat timeout', reapStaleSessions, 'heartbeat_timeout'],
                ['boot orphan', reapBootOrphanSessions, 'server_restart'],
            ] as const)(
                '%s reaper stops a live FFmpeg job',
                async (_name, reap, reason) => {
                    const { sid, pid } = await startWatchedJob();
                    const svc = getFFmpegTranscodeService();
                    const stop = vi.spyOn(svc, 'stopJob');
                    try {
                        await sql`UPDATE play_sessions SET status = 'PAUSED', paused_at = NOW() - INTERVAL '31 minutes',
                        last_heartbeat_at = NOW() - INTERVAL '31 minutes', started_at = NOW() - INTERVAL '32 minutes'
                        WHERE id = ${sid}`;
                        await reap(sql);
                        const [row] =
                            await sql`SELECT status, stop_reason FROM play_sessions WHERE id = ${sid}`;
                        expect(row).toMatchObject({ status: 'CRASHED', stop_reason: reason });
                        expect(stop).toHaveBeenCalledWith(sid, reason);
                        await waitFor(() => !isAlive(pid), 10_000);
                        expect(svc.getJobByPlaySession(sid)).toBeUndefined();
                    } finally {
                        stop.mockRestore();
                        await svc.stopJob(sid, 'test_cleanup');
                    }
                },
                120_000,
            );

            it.each(['CRASHED', 'COMPLETED', 'KILLED', 'missing'])(
                'sweep stops a %s session despite fresh client access',
                async (status) => {
                    const { sid, pid } = await startWatchedJob();
                    const svc = getFFmpegTranscodeService();
                    try {
                        if (status === 'missing')
                            await sql`DELETE FROM play_sessions WHERE id = ${sid}`;
                        else
                            await sql`UPDATE play_sessions SET status = ${status}, stop_reason = 'test_ended' WHERE id = ${sid}`;
                        const stopped = vi.spyOn(svc, 'stopJob');
                        try {
                            await reaper().cleanupInactiveJobs();
                            expect(stopped).toHaveBeenCalledWith(
                                sid,
                                status === 'missing' ? 'session_missing' : 'test_ended',
                                false,
                            );
                            await waitFor(() => !isAlive(pid), 10_000);
                            expect(svc.getJobByPlaySession(sid)).toBeUndefined();
                            expect(
                                await getTranscodeJobPersistenceService().getJob(sid),
                            ).toBeNull();
                        } finally {
                            stopped.mockRestore();
                        }
                    } finally {
                        await svc.stopJob(sid, 'test_cleanup');
                    }
                },
                120_000,
            );
        }

        it('has a restorable row (and a play_sessions stub only for the web id)', async () => {
            const { sid, pid } = await startWatchedJob();
            try {
                const rows = await sql<{ status: string; can_restore: boolean }[]>`
                    SELECT status, can_restore FROM active_transcode_jobs
                    WHERE play_session_id = ${sid}
                `;
                expect(rows).toHaveLength(1);
                expect(rows[0].can_restore).toBe(true);
                const stubs = await sql`SELECT 1 FROM play_sessions WHERE id = ${sid}`;
                // A stub under the /j id would be a second ACTIVE session next to
                // the one findOrCreateJellyfinSession keeps: a phantom stream that
                // counts against the user's limit.
                expect(stubs).toHaveLength(kind === '/j (dashless id)' ? 0 : 1);
            } finally {
                await getFFmpegTranscodeService().stopJob(sid, 'test_cleanup');
            }
            await waitFor(() => !isAlive(pid), 15_000);
        }, 120_000);

        it('is killed within timeout + one sweep after the client vanishes (no stop, no heartbeat), and stays restorable', async () => {
            const { sid, pid } = await startWatchedJob();

            const bound = CLIENT_GONE_TIMEOUT_S + REAPER_SWEEP_S + KILL_SLACK_S;
            const lived = await secondsUntilExit(pid, bound);

            console.info(
                `[client-gone] ffmpeg pid ${pid} lived ${lived ?? `>${bound}`}s after the client left`,
            );
            expect(lived).not.toBeNull();
            expect(lived!).toBeLessThanOrEqual(bound);
            expect(lived!).toBeGreaterThanOrEqual(CLIENT_GONE_TIMEOUT_S - REAPER_SWEEP_S);

            // Dormant, not deleted: the client's next segment request restores it.
            const persistence = getTranscodeJobPersistenceService();
            const row = await persistence.getJob(sid);
            expect(row?.status).toBe('stopped');
            expect(row?.can_restore).toBe(true);
            const svc = getFFmpegTranscodeService();
            const restored = await svc.restoreJob(row!);
            try {
                expect(svc.getJobByPlaySession(sid)?.id).toBe(restored.id);
            } finally {
                await svc.stopJob(sid, 'test_cleanup');
            }
        }, 150_000);

        it('keeps running while the client heartbeats through ANOTHER pod (DB row only)', async () => {
            const { sid, job, pid } = await startWatchedJob();
            const child = job.process!;
            const persistence = getTranscodeJobPersistenceService();

            // The router hashed this client's heartbeats to the peer pod; all the
            // owner can see is the row's last_progress_at.
            const heartbeat = async (): Promise<void> => {
                await persistence.updateLastProgress(sid);
            };
            await heartbeat();
            try {
                const window = CLIENT_GONE_TIMEOUT_S + REAPER_SWEEP_S + KILL_SLACK_S;
                const lived = await secondsUntilExit(pid, window, heartbeat);
                const row = lived === null ? null : await persistence.getJob(sid);
                expect(
                    lived,
                    `dbStatus=${row?.status}, dbError=${row?.error_message}, ` +
                        `exitCode=${child.exitCode}, signal=${child.signalCode}, ` +
                        `killRequested=${job.killRequested}, status=${job.status}, error=${job.error}`,
                ).toBeNull();
            } finally {
                await getFFmpegTranscodeService().stopJob(sid, 'test_cleanup');
            }
            await waitFor(() => !isAlive(pid), 15_000);
        }, 120_000);

        it('a stop that lands on a NON-owner pod kills it within one sweep', async () => {
            const { sid, pid } = await startWatchedJob();
            // Keep the client "alive" so only the stop can end it.
            const svc = getFFmpegTranscodeService();
            const heartbeat = async (): Promise<void> => {
                svc.recordProgressHeartbeat(sid, 'ACTIVE');
            };
            try {
                // Exactly what stopJob() writes on a pod that does not hold the job.
                await getTranscodeJobPersistenceService().updateStatus(
                    sid,
                    'stopped',
                    'Stopped by session_stop from pod pod-web-1',
                    false,
                );
                const lived = await secondsUntilExit(pid, REAPER_SWEEP_S + KILL_SLACK_S, heartbeat);
                console.info(
                    `[client-gone] cross-pod stop: ffmpeg pid ${pid} lived ${lived ?? 'past the bound'}s`,
                );
                expect(lived).not.toBeNull();
                expect(lived!).toBeLessThanOrEqual(REAPER_SWEEP_S + KILL_SLACK_S);
            } finally {
                await svc.stopJob(sid, 'test_cleanup');
            }
        }, 120_000);
    });
});
