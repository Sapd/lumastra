// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seam that 503'd every mid-playback switch to the audio-only rung.
 *
 * Two sides have to agree on ONE number:
 *   - `startJob()` spawns FFmpeg with `-start_number N`, which decides the
 *     filename of the first segment it writes (segment_0000N.m4s).
 *   - `buildHlsSegmentRequestState()` decides which file on disk a request for
 *     manifest index N resolves to.
 *
 * When they disagree the client asks for a file no generation ever contains and
 * every segment request 503s forever (readyState stays 0 — the live symptom).
 *
 * Both sides were untested for `videoDisabled`: `segment-request-state.test.ts`
 * has no `videoDisabled` coverage at all, and the existing audio-only geometry
 * tests in `ffmpeg-transcode.service.test.ts` assert against `job.segmentOffset`
 * rather than against the argv FFmpeg is actually handed — with
 * `FullTranscodeStrategy` mocked to `{ args: [] }`, so the argument builder
 * never ran there.
 *
 * This file therefore keeps the REAL `FullTranscodeStrategy` and the REAL
 * `segment-request-state`, and reads `-start_number` out of the captured spawn
 * argv.
 *
 * What it proves:
 *  - the number FFmpeg is told and the number the handler resolves are the same
 *    for a non-zero `startTimeSeconds`, at the seek boundary and far ahead of
 *    it;
 *  - that number is non-zero and equals the uniform-grid index for the seek
 *    position (so the assertion cannot pass because everything is 0, and cannot
 *    pass on a keyframe-space offset);
 *  - the offset is not subtracted twice (the actual failure shape).
 *
 * What it does NOT prove: that FFmpeg really writes those filenames (that is
 * the ffmpeg smoke test), nor anything about the copy/remux path, which
 * deliberately uses a DIFFERENT convention (-start_number 0 + index
 * translation).
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

import type { TranscodeJobConfig } from './transcoding/types.js';

// 14.796303 is the live playhead from the browser repro. On the uniform 6 s
// grid that is segment 2 (12.0–18.0 s) — a NON-ZERO offset, so an
// implementation that ignored the seek and started at 0 fails.
const SEEK_SECONDS = 14.796303;
const EXPECTED_START_NUMBER = 2;

function audioOnlyConfig(playSessionId: string): TranscodeJobConfig {
    return {
        itemId: 'item-1',
        username: 'user-a',
        deviceId: 'device-1',
        inputUrl: '/media/x.mkv',
        // Required — buildFFmpegArgs early-returns [] without it, which would
        // silently make the -start_number assertion unreachable.
        localFilePath: '/media/x.mkv',
        videoDisabled: true,
        startTimeSeconds: SEEK_SECONDS,
        totalDurationSeconds: 600,
        // Keyframes every ~4.6 s — deliberately aligned to NEITHER the 6 s
        // uniform grid nor the 10 s copy-mode grid, so a keyframe-space offset
        // is distinguishable from the uniform one.
        keyframeData: Array.from({ length: 130 }, (_, i) => +(i * 4.6).toFixed(3)),
        hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
        audioTracks: [
            {
                index: 1,
                displayTitle: 'English',
                language: 'eng',
                channels: 2,
                codec: 'aac',
                isDefault: true,
            },
        ],
        videoInfo: { codec: 'h264', width: 1920, height: 1080 },
        // consumePlan is only consulted when BOTH are present.
        mediaSourceInfo: { streams: [] } as unknown as TranscodeJobConfig['mediaSourceInfo'],
        playbackPlan: {
            plan_id: 'plan-1',
            video_action: 'copy',
        } as unknown as TranscodeJobConfig['playbackPlan'],
        playSessionId,
    } as TranscodeJobConfig;
}

/** Read the value FFmpeg was actually told, out of the captured argv.
 *
 *  Fails loudly on an EMPTY argv rather than returning undefined. An exception
 *  inside the real args builder is swallowed by startJob() into `job.error`, so
 *  a missing config key silently leaves argv `[]` — and every assertion in this
 *  file would then be testing nothing. (That is not hypothetical: it is exactly
 *  what happened while writing these, via an unset MAX_MUXING_QUEUE_SIZE.) */
function startNumberFromArgs(args: string[]): number {
    if (args.length === 0) {
        throw new Error(
            'FFmpeg was spawned with an empty argv — the args builder threw and ' +
                'startJob() swallowed it into job.error. Fix the harness; do not ' +
                'weaken the assertion.',
        );
    }
    const i = args.indexOf('-start_number');
    if (i === -1) throw new Error(`-start_number absent from argv: ${args.join(' ')}`);
    return Number(args[i + 1]);
}

describe('audio-only job at a seek offset — -start_number vs resolved segment index', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let stateModule: typeof import('./hls/segment-request-state.js');
    let spawnedArgs: string[] = [];

    beforeEach(async () => {
        vi.resetModules();
        spawnedArgs = [];
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(async (_job, args: unknown) => {
            spawnedArgs = args as string[];
        });

        svcModule = await import('./ffmpeg-transcode.service.js');
        stateModule = await import('./hls/segment-request-state.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    function resolveIndex(
        svc: ReturnType<typeof svcModule.getFFmpegTranscodeService>,
        job: Parameters<typeof stateModule.buildHlsSegmentRequestState>[0]['job'],
        requestedSegmentNum: number,
    ) {
        return stateModule.buildHlsSegmentRequestState({
            job,
            // Muxed output: flat dir, no stream_%v — segmentInfo carries ''.
            segmentInfo: { streamDir: '', segmentIndex: requestedSegmentNum },
            isSegment: true,
            requestedSegmentNum,
            adapter: {
                getSegmentOffsetForJob: (j) => svc.getSegmentOffsetForJob(j),
                getStreamSegmentOffsetForJob: (j, dir) => svc.getStreamSegmentOffsetForJob(j, dir),
                getStreamTargetDurationForJob: (j, dir) =>
                    svc.getStreamTargetDurationForJob(j, dir),
                canStreamTriggerSeekForJob: (j, dir) => svc.canStreamTriggerSeekForJob(j, dir),
                isSegmentDeletedForJob: () => false,
            },
        }).actualSegmentIndex;
    }

    it('awaits the demuxer-list enumeration before building argv, and the list reaches it (F4)', async () => {
        formatWhitelistCalls.length = 0;
        const svc = svcModule.getFFmpegTranscodeService();
        await svc.startJob(audioOnlyConfig('audio-only-format-whitelist'));

        expect(formatWhitelistCalls.slice(0, 2)).toEqual(['prepared', 'read']);
        const i = spawnedArgs.indexOf('-format_whitelist');
        expect(spawnedArgs[i + 1]).toBe('WL-MEDIA');
        expect(i).toBeLessThan(spawnedArgs.indexOf('-i'));
    });

    it('tells FFmpeg a non-zero -start_number matching the uniform grid for the seek', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        await svc.startJob(audioOnlyConfig('audio-only-argv'));

        // Pinning the VALUE, not just "both sides agree": two sides that agree
        // on 0 would satisfy an equality-only assertion while playing from the
        // start of the file instead of from the seek.
        expect(startNumberFromArgs(spawnedArgs)).toBe(EXPECTED_START_NUMBER);
    });

    it('resolves request N to exactly the file index -start_number implies', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(audioOnlyConfig('audio-only-seam'));

        const startNumber = startNumberFromArgs(spawnedArgs);
        expect(startNumber).toBe(EXPECTED_START_NUMBER);
        // -vn actually reached the argv, so this really is the audio-only rung
        // and not some other job shape that happens to share the offset.
        expect(spawnedArgs).toContain('-vn');

        // With -start_number N, FFmpeg's first file is segment_0000N and file
        // index == manifest index from there on. So the handler must resolve
        // request N to N — subtracting the offset again is the bug that made
        // the client ask for segment_00000, a file no generation contains.
        expect(resolveIndex(svc, job, startNumber)).toBe(startNumber);
    });

    it('holds far ahead of the seek point too, so the offset is never subtracted twice', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(audioOnlyConfig('audio-only-seam-ahead'));

        // A constant-offset error is invisible at the boundary if the handler
        // happens to clamp; check a request well past it.
        expect(resolveIndex(svc, job, 60)).toBe(60);
        expect(resolveIndex(svc, job, 137)).toBe(137);
    });

    it('keeps the uniform grid rather than the copy-mode keyframe grid', async () => {
        // The input that broke the rung: the plan says videoAction 'copy'. If
        // that leaks through, the job switches to a 10 s keyframe grid and a
        // KEYFRAME-space offset, and both numbers above change.
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(audioOnlyConfig('audio-only-grid'));

        expect(job.segmentDurationSeconds).toBe(6);
        expect(job.config.startTimeSeconds).toBe(12);
        expect(job.transcodeDecisionResult?.videoAction).toBe('transcode');
    });
});
