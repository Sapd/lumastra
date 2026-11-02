// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GOP mode at the service seam (services/hls/gop-grid.ts): the REAL startJob
 * and seekToSegment, the REAL FullTranscodeStrategy argv, the REAL per-stream
 * offsets and the GOP playlist the client gets. Pins the 2026-10-06 report:
 * a demux copy session resumed at ~20 min must start FFmpeg exactly on the
 * keyframe of the grid entry the playlist declares for that position — then
 * hls.js anchors its timeline correctly and bitmap subtitles stay in sync.
 * Harness copied from ffmpeg-transcode.service.copy-grid-seam.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mockCfg = vi.hoisted(() => ({
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 100,
    FFMPEG_MAX_JOBS_PER_USER: 10,
    FFMPEG_SEGMENT_DURATION: 6,
    FFMPEG_TRANSCODE_DIR: '/tmp/transcode-test',
    FFMPEG_MAX_GENERATIONS_PER_SESSION: 2,
    TRANSCODE_DOWNSCALE_CPU_TO_1080P: false,
    MAX_WIDTH: 0,
    MAX_HEIGHT: 0,
    AUDIO_CODEC: 'aac',
    AUDIO_BITRATE_STEREO: '128k',
    AUDIO_BITRATE_SURROUND: '384k',
    AUDIO_VBR: false,
    AUDIO_BOOST: 1.0,
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
    // Read by cleanupInactiveJobs. Real prod defaults — the reaper's timeouts
    // must be concrete numbers here, because the mock config Proxy returns
    // undefined for absent keys and `x > undefined * 1000` is always false,
    // which would make every reaper assertion pass vacuously.
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 300,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS: 60,
    // Needed because THIS suite runs the real FFmpegArgsBuilder (the sibling
    // suite stubs the strategy, so it never reads these). The mock config Proxy
    // returns undefined for absent keys and the builder calls .toString() on
    // them, which throws inside spawnFFmpeg and is swallowed into job.error —
    // leaving the argv empty and every assertion here silently unreachable.
    MAX_MUXING_QUEUE_SIZE: 1024,
    GPU_ACCELERATION: 'none',
    VAAPI_DEVICE: '',
    HLS_BURN_IN_HDR_STRATEGY: 'tonemap',
    PREVIEW_MAX_VIDEO_BITRATE_MBPS: 0,
    HLS_SEGMENT_TYPE: 'fmp4',
    HLS_COPY_GOP_SEGMENTS: true,
}));

// Named exports come from the shared task fixture; only `config` is local.
//
// This mock used to export `config` ALONE. Vitest module mocks are strict, so
// the moment this file's import graph reached tasks/registry.ts — which
// destructures FEATURE_PER_TASK_QUEUES at module load, via plugin-context.ts —
// the whole file failed at COLLECTION with "No FEATURE_PER_TASK_QUEUES export
// is defined on the mock". Not one failing test: zero tests, the file never
// ran. It failed that way in CI while passing locally, so it was invisible
// unless you read the CI log.
//
// Spreading the fixture makes the missing-export class impossible here rather
// than patching in one name and waiting for the next one to surface — which is
// exactly how orchestrator-hard-kill.test.ts went (FEATURE_PER_TASK_QUEUES,
// then publishMessage, then...). Same fixture, same reason.
vi.mock('$lib/server/config.js', async () => ({
    ...(await import('../tasks/__fixtures__/task-config-mock.js')).taskConfigMock(),
    config: new Proxy(mockCfg, {
        get(target, prop: string) {
            return target[prop as keyof typeof target];
        },
    }),
}));

// F4: records that spawnFFmpeg AWAITS the off-event-loop enumeration before
// the builder reads the list synchronously.
const formatWhitelistCalls = vi.hoisted((): string[] => []);
vi.mock('$lib/server/utils/media-format-whitelist.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/media-format-whitelist.js')>()),
    prepareMediaFormatWhitelist: vi.fn(async () => {
        await Promise.resolve();
        formatWhitelistCalls.push('prepared');
    }),
    getMediaFormatWhitelist: vi.fn(() => {
        formatWhitelistCalls.push('read');
        return 'WL-MEDIA';
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

const mockPersistence = vi.hoisted(() => ({
    saveJob: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    updateLastAccessed: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
    deleteJob: vi.fn().mockResolvedValue(undefined),
    getAllActiveJobs: vi.fn().mockResolvedValue([]),
    getAllJobPlaySessionIds: vi.fn().mockResolvedValue([]),
    getJobsForPod: vi.fn().mockResolvedValue([]),
    getJobsByPlaySessions: vi.fn().mockResolvedValue([]),
}));

vi.mock('./transcode-job-persistence.service.js', () => ({
    getTranscodeJobPersistenceService: () => mockPersistence,
    getCurrentPodName: () => process.env.HOSTNAME || 'unknown',
}));

const mockFileManager = vi.hoisted(() => ({
    clearTranscodeDirectory: vi.fn().mockResolvedValue(undefined),
    createOutputDirectory: vi.fn().mockResolvedValue(undefined),
    deleteOutputDirectory: vi.fn().mockResolvedValue(undefined),
    getSegmentPath: vi.fn(),
    listSegments: vi.fn().mockResolvedValue([]),
    deleteSegmentsBefore: vi.fn().mockResolvedValue(undefined),
    slidingWindowCleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./transcoding/file-manager.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TranscodeFileManager: vi.fn(function (this: any) {
        Object.assign(this, mockFileManager);
    }),
}));

const mockProcessRunner = vi.hoisted(() => ({
    spawnFFmpeg: vi.fn(),
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
        this.canSeek = vi.fn(() => true);
        this.waitForSeekCompletion = vi.fn(async () => 'proceed');
    }),
}));

vi.mock('./transcoding/hardware-detection.js', () => ({
    hardwareDetection: {
        canSoftwareDecodeBridge: vi.fn().mockReturnValue(false),
        isSourceHardwareDecodable: vi.fn().mockReturnValue(false),
        markSourceNotHardwareDecodable: vi.fn(),
        invalidateEncoderProbe: vi.fn(),
    },
}));

// The REAL FullTranscodeStrategy — this file exists to assert on the argv it
// produces, so stubbing buildArgs (as the sibling suite does) would make every
// assertion here vacuous. It is pulled from its own module rather than through
// the `transcoding/index.js` barrel, which drags in paraglide messages that do
// not resolve in the node test environment.
//
// Only the decision engine is stubbed, because it is the INPUT this regression
// is about: the audio-only rung reuses the plan built for direct play, so it
// arrives claiming videoAction 'copy' for a video stream `-vn` has already
// removed.
vi.mock('./transcoding/index.js', async () => {
    const { FullTranscodeStrategy } = await import('./transcoding/full-transcode-strategy.js');
    // Real implementation, like FullTranscodeStrategy above: buildFFmpegArgs
    // calls this on every job to stamp decision.hdrTonemapMode, and it is a
    // pure function over the argv with none of the paraglide imports this
    // barrel is mocked to avoid. Stubbing it would be free to drift; omitting
    // it threw inside the builder and left argv [] — which startJob swallows
    // into job.error, exactly the silent-harness failure startNumberFromArgs
    // is written to shout about.
    const { resolveTonemapMode } = await import('./transcoding/ffmpeg-args-builder.js');
    const copyPlanDecision = {
        mode: 'remux',
        videoAction: 'copy',
        audioAction: 'transcode',
        useGpu: false,
    };
    return {
        transcodeDecision: {
            decide: vi.fn().mockResolvedValue(copyPlanDecision),
            consumePlan: vi.fn().mockResolvedValue({ ...copyPlanDecision }),
            // The flip's encoder selection has its own unit test
            // (transcode-decision.test.ts); here it stands in for an NVENC host
            // so the seam can assert the flipped job encodes on the GPU.
            // HDR handling for the flip is unit-tested in transcode-decision.test.ts;
            // the source here is SDR, so it has nothing to change.
            assignHdrForFlippedTranscode: vi.fn(),
            assignEncoderForFlippedTranscode: vi.fn(
                async (d: {
                    useGpu: boolean;
                    gpuEncoder?: string;
                    gpuDecoder?: string;
                    targetCodec?: { video?: string; audio?: string };
                }) => {
                    d.gpuEncoder = 'hevc_nvenc';
                    d.gpuDecoder = 'hevc_cuvid';
                    d.useGpu = true;
                    d.targetCodec = { ...d.targetCodec, video: 'hevc_nvenc' };
                },
            ),
        },
        FullTranscodeStrategy,
        resolveTonemapMode,
        getHwAccelFromEncoder: vi.fn().mockReturnValue('none'),
    };
});

vi.mock('./hls/generation-router.js', async (importOriginal) => {
    // Keep the real implementation — this file re-exports
    // `selectSegmentGenerationCandidate` from here, and the pure-function
    // tests above (`describe('selectSegmentGenerationCandidate', ...)`)
    // depend on the genuine implementation, not a stub.
    const real = await importOriginal<typeof import('./hls/generation-router.js')>();
    return real;
});

vi.mock('./hls/seek-cooldown-tracker.js', () => ({
    clearSeekTimestamp: vi.fn(),
}));

vi.mock('./hls/segment-request-tracker.js', () => ({
    clearSessionRequestTrackers: vi.fn(),
}));

vi.mock('./hls/seek-trace-collector.js', () => ({
    clearSessionSeekTrace: vi.fn(),
}));

vi.mock('./hls/generation-coordinator.js', async (importOriginal) => {
    // Keep the real pure-function implementations — they have no side-effects.
    const real = await importOriginal<typeof import('./hls/generation-coordinator.js')>();
    return real;
});

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
    // Stub the human-summary helpers, but keep the REAL learn gate so the GPU
    // decode-fallback tests exercise the actual strict/broad signature split.
    ...(await importOriginal<typeof import('./transcoding/transcode-failure-classifier.js')>()),
    classifyTranscodeFailure: vi.fn().mockReturnValue({ kind: 'unknown' }),
    formatTranscodeFailureMessage: vi.fn().mockReturnValue(''),
}));

vi.mock('../utils/hls-stream-duration.js', () => ({
    isDistinctStreamDuration: vi.fn().mockReturnValue(false),
}));

// The GOP tail-cache worker runs its own FFmpeg via spawnFFmpegSafely; the
// mock writes what that run would: init segments and fMP4 parts (real box
// structure, source-absolute times) into the dirs its argv names.
const spawnSafely = vi.hoisted(() => ({
    impl: null as null | ((args: string[]) => Promise<void>),
}));
vi.mock('../utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn(async (o: { args: string[] }) => {
        if (!spawnSafely.impl) return { exitCode: 1, stderr: 'no ffmpeg in tests', stdout: '' };
        await spawnSafely.impl(o.args);
        return { exitCode: 0, stderr: '', stdout: '' };
    }),
}));
vi.mock('./transcoding/input-guard.js', () => ({
    assertTranscodeInputIsMedia: vi.fn(async () => {}),
}));

import type { TranscodeJobConfig } from './transcoding/types.js';
import {
    keyframes as KEYFRAMES,
    runtimeSeconds as TOTAL,
} from './hls/__fixtures__/prod-hevc-episode-keyframes.js';
import { buildGopGrid } from './hls/gop-grid.js';

const GRID = buildGopGrid(KEYFRAMES, TOTAL, 10)!;
const RESUME_SECONDS = 1205.5; // inside entry 120 (1202.827 ..)

function demuxCopyConfig(playSessionId: string, startTimeSeconds?: number): TranscodeJobConfig {
    return {
        itemId: 'item-1',
        username: 'user-a',
        deviceId: 'device-1',
        inputUrl: '/media/x.mkv',
        localFilePath: '/media/x.mkv',
        startTimeSeconds,
        totalDurationSeconds: TOTAL,
        keyframeData: KEYFRAMES,
        hlsOutput: { hlsAudioMode: 'demux' },
        audioTracks: [
            {
                index: 1,
                displayTitle: 'German',
                language: 'ger',
                channels: 6,
                codec: 'eac3',
                isDefault: true,
            },
            {
                index: 2,
                displayTitle: 'English',
                language: 'eng',
                channels: 6,
                codec: 'eac3',
                isDefault: false,
            },
        ],
        videoInfo: { codec: 'hevc', width: 1920, height: 1080, isTranscoded: false },
        mediaSourceInfo: {
            streams: [{ type: 'Video' }, { type: 'Audio' }, { type: 'Audio' }],
        } as unknown as TranscodeJobConfig['mediaSourceInfo'],
        playbackPlan: {
            plan_id: 'plan-1',
            video_action: 'copy',
        } as unknown as TranscodeJobConfig['playbackPlan'],
        playSessionId,
    } as TranscodeJobConfig;
}

const argOf = (argv: string[], flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
};

describe('GOP mode at the service seam', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let vodModule: typeof import('./hls/vod-playlist.js');

    beforeEach(async () => {
        vi.resetModules();
        mockCfg.HLS_COPY_GOP_SEGMENTS = true;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockResolvedValue(undefined);
        const { transcodeDecision } = await import('./transcoding/index.js');
        vi.mocked(transcodeDecision.consumePlan).mockImplementation(
            async () =>
                ({
                    mode: 'remux',
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    useGpu: false,
                }) as unknown as Awaited<ReturnType<typeof transcodeDecision.consumePlan>>,
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
        vodModule = await import('./hls/vod-playlist.js');
    });

    afterEach(async () => {
        vi.clearAllMocks();
    });

    function lastArgv(): string[] {
        const call = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1);
        expect(call, 'spawnFFmpeg was not reached').toBeDefined();
        return call![1] as string[];
    }

    it('starts a resume on exactly the keyframe of the declared grid entry', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(demuxCopyConfig('gop-resume', RESUME_SECONDS));
        try {
            expect(job.config.gopSegments).toBe(true);
            expect(job.segmentOffset).toBe(120);
            expect(GRID.starts[120]).toBe(1202.827);

            // The playlist the client gets declares entry 120 at 1202.827 and
            // hls.js picks that entry for the resume position...
            const playlist = vodModule.buildGopGridManifest(
                GRID,
                'init_2.mp4',
                new URLSearchParams(),
            );
            const durations = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
            const declaredStart120 = durations.slice(0, 120).reduce((a, b) => a + b, 0);
            expect(declaredStart120).toBeCloseTo(1202.827, 3);

            // ...and FFmpeg starts on that keyframe and names it by its index.
            const argv = lastArgv();
            const ss = Number(argOf(argv, '-ss'));
            expect(ss).toBeGreaterThan(1202.827);
            expect(ss).toBeLessThan(KEYFRAMES[GRID.firstKeyframe[120] + 1]);
            expect(argv).toContain('-noaccurate_seek');
            expect(argOf(argv, '-start_number')).toBe(String(GRID.firstKeyframe[120]));
            expect(argOf(argv, '-hls_time')).toBe('0.5'); // audio output first
            expect(argv.filter((a) => a.endsWith('index.m3u8'))).toHaveLength(2);

            // The handler reaches the grid through this method (optional call):
            // it must exist on the real service.
            expect(typeof svc.getGopGrid).toBe('function');
            expect(svc.getGopGrid(job)?.count).toBe(GRID.count);

            // Every stream answers in grid entries: entry N is file N - 120.
            for (const dir of ['stream_0', 'stream_1', 'stream_2']) {
                expect(svc.getStreamSegmentOffsetForJob(job, dir)).toBe(120);
                expect(svc.getStreamTargetDurationForJob(job, dir)).toBeUndefined();
            }
        } finally {
            await job.gopAssembler?.stop();
        }
    });

    it("a seek starts one entry early, on that entry's keyframe", async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(demuxCopyConfig('gop-seek'));
        try {
            expect(job.segmentOffset).toBe(0);
            expect(argOf(lastArgv(), '-ss')).toBeUndefined();
            expect(argOf(lastArgv(), '-start_number')).toBe('0');

            const ok = await svc.seekToSegment('gop-seek', 200, 10, GRID.starts[200]);
            expect(ok).toBe(true);
            const next = svc.getJobByPlaySession('gop-seek')!;
            expect(next.id).not.toBe(job.id);
            expect(next.segmentOffset).toBe(199);
            const argv = lastArgv();
            expect(argOf(argv, '-start_number')).toBe(String(GRID.firstKeyframe[199]));
            const ss = Number(argOf(argv, '-ss'));
            expect(ss).toBeGreaterThan(GRID.starts[199]);
            expect(ss).toBeLessThan(KEYFRAMES[GRID.firstKeyframe[199] + 1]);
            await next.gopAssembler?.stop();
        } finally {
            await job.gopAssembler?.stop();
        }
    });

    it('stays on the legacy path when the kill switch is off', async () => {
        mockCfg.HLS_COPY_GOP_SEGMENTS = false;
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(demuxCopyConfig('gop-off', RESUME_SECONDS));
        expect(job.config.gopSegments).toBe(false);
        expect(job.gopAssembler).toBeUndefined();
        expect(lastArgv().filter((a) => a.endsWith('index.m3u8'))).toHaveLength(1);
        expect(argOf(lastArgv(), '-var_stream_map')).toMatch(/v:0/);
    });

    it('does not enter GOP mode when the probe contradicts the audio tracks', async () => {
        // The strategy drops phantom tracks; GOP mode needs an audio output to
        // carry master.m3u8, so the gate must count the same way.
        const svc = svcModule.getFFmpegTranscodeService();
        const cfg = demuxCopyConfig('gop-no-audio', RESUME_SECONDS);
        cfg.mediaSourceInfo = {
            streams: [{ type: 'Video' }],
        } as unknown as TranscodeJobConfig['mediaSourceInfo'];
        const job = await svc.startJob(cfg);
        expect(job.config.gopSegments).toBe(false);
        expect(job.gopBroken).toBeUndefined();
    });

    it('keeps muxed copy on its own path', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const cfg = demuxCopyConfig('gop-muxed', RESUME_SECONDS);
        cfg.hlsOutput = { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 };
        const job = await svc.startJob(cfg);
        expect(job.config.gopSegments).toBe(false);
    });
});

describe('GOP mode lifecycle at the service seam', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.resetModules();
        mockCfg.HLS_COPY_GOP_SEGMENTS = true;
        spawnSafely.impl = null;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockResolvedValue(undefined);
        const { transcodeDecision } = await import('./transcoding/index.js');
        vi.mocked(transcodeDecision.consumePlan).mockImplementation(
            async () =>
                ({
                    mode: 'remux',
                    videoAction: 'copy',
                    audioAction: 'transcode',
                    useGpu: false,
                }) as unknown as Awaited<ReturnType<typeof transcodeDecision.consumePlan>>,
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        spawnSafely.impl = null;
        vi.clearAllMocks();
    });

    it('caches the last grid entry of every stream from the GOP tail run', async () => {
        const { buildFragment, buildInit } = await import('./hls/__fixtures__/fmp4-boxes.js');
        const fsp = await import('node:fs/promises');
        const nodePath = await import('node:path');
        const svc = svcModule.getFFmpegTranscodeService();
        const TS = 1000;
        spawnSafely.impl = async (args: string[]) => {
            const ss = Number(args[args.indexOf('-ss') + 1] ?? 0);
            const startKf = Number(args[args.indexOf('-start_number') + 1]);
            const segIdx = args.reduce<number[]>(
                (a, t, i) => (t === '-hls_segment_filename' ? [...a, i] : a),
                [],
            );
            const audioDir = nodePath.dirname(args[segIdx[0] + 1]);
            const videoDir = nodePath.dirname(args[segIdx[1] + 1]);
            await fsp.mkdir(videoDir, { recursive: true });
            await fsp.writeFile(nodePath.join(videoDir, 'init_2.mp4'), buildInit(TS));
            for (let k = startKf; k < KEYFRAMES.length; k++) {
                const name = `gop_${String(k).padStart(6, '0')}.m4s`;
                await fsp.writeFile(
                    nodePath.join(videoDir, name),
                    buildFragment({
                        decodeTime: Math.round((KEYFRAMES[k] - 0.042) * TS),
                        firstCto: 42,
                        payload: Buffer.from(`v${k}`),
                    }),
                );
            }
            for (const i of [0, 1]) {
                const dir = audioDir.replace('%v', String(i));
                await fsp.mkdir(dir, { recursive: true });
                await fsp.writeFile(nodePath.join(dir, `init_${i}.mp4`), buildInit(TS));
                let n = 0;
                for (let t = KEYFRAMES[startKf] - 0.2; t < TOTAL; t += 0.5) {
                    await fsp.writeFile(
                        nodePath.join(dir, `part_${String(n++).padStart(6, '0')}.m4s`),
                        buildFragment({
                            decodeTime: Math.round(t * TS),
                            payload: Buffer.from(`a${i}-${t}`),
                        }),
                    );
                }
            }
            expect(ss).toBeGreaterThan(GRID.starts[GRID.count - 3]);
        };
        // startJob dispatches the tail worker itself (fire-and-forget).
        const job = await svc.startJob(demuxCopyConfig('gop-tail'));
        try {
            const last = GRID.count - 1;
            await vi.waitFor(() => expect(job.endSegmentCache.get('stream_2')).toBeDefined(), {
                timeout: 10_000,
            });
            for (const dir of ['stream_0', 'stream_1', 'stream_2']) {
                const entry = job.endSegmentCache.get(dir);
                expect(entry, dir).toMatchObject({ kind: 'segment', segmentIndex: last });
            }
            const video = job.endSegmentCache.get('stream_2') as { buffer: Buffer };
            expect(video.buffer.includes(Buffer.from(`v${GRID.firstKeyframe[last]}`))).toBe(true);
            // Cache publication precedes the asynchronous tail-directory cleanup.
            await vi.waitFor(
                async () =>
                    await expect(
                        fsp.stat(nodePath.join(job.outputDir, '.tail-cache')),
                    ).rejects.toMatchObject({ code: 'ENOENT' }),
                { timeout: 5000 },
            );
        } finally {
            await svc.stopJob('gop-tail').catch(() => {});
        }
    });

    it('fails closed and trips the title when the args fall back to one output', async () => {
        // The class the service really uses: it comes through the mocked barrel.
        const { FullTranscodeStrategy } = await import('./transcoding/index.js');
        const original = FullTranscodeStrategy.prototype.buildArgs;
        const spy = vi
            .spyOn(FullTranscodeStrategy.prototype, 'buildArgs')
            .mockImplementation(function (this: InstanceType<typeof FullTranscodeStrategy>, cfg) {
                return { ...original.call(this, cfg), gopSplit: false };
            });
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(demuxCopyConfig('gop-fallback', RESUME_SECONDS));
        spy.mockRestore();
        expect(job.gopBroken).toMatch(/single-output/);
        // The next job for the same title takes the legacy cut instead of
        // restarting into the same break.
        const next = await svc.startJob(demuxCopyConfig('gop-fallback-2', RESUME_SECONDS));
        expect(next.config.gopSegments).toBe(false);
        await svc.stopJob('gop-fallback').catch(() => {});
        await svc.stopJob('gop-fallback-2').catch(() => {});
    });

    it('keeps a stored "no" decision instead of re-deciding', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const cfg = demuxCopyConfig('gop-stored-no', RESUME_SECONDS);
        cfg.gopSegments = false;
        const job = await svc.startJob(cfg);
        expect(job.config.gopSegments).toBe(false);
        expect(job.gopAssembler).toBeUndefined();
        await svc.stopJob('gop-stored-no').catch(() => {});
    });

    it('stops the assembler when the generation is retired', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(demuxCopyConfig('gop-retire', RESUME_SECONDS));
        const assembler = job.gopAssembler!;
        expect(assembler.isStopped).toBe(false);
        await svc.stopJob('gop-retire');
        expect(assembler.isStopped).toBe(true);
    });
});
