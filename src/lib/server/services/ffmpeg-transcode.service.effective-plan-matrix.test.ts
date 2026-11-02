// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mockCfg = vi.hoisted(() => ({
    LUMASTRA_MAX_CONCURRENT_TRANSCODES: 1000,
    FFMPEG_MAX_JOBS_PER_USER: 1000,
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
    ENABLE_HDR10_PRESERVATION: true,
    DEINTERLACE_METHOD: 'yadif',
    PREVIEW_TRANSCODE_MAX_SECONDS: 0,
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 300,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS: 60,
    MAX_MUXING_QUEUE_SIZE: 1024,
    GPU_ACCELERATION: 'none',
    VAAPI_DEVICE: '',
    HLS_BURN_IN_HDR_STRATEGY: 'tonemap',
    PREVIEW_MAX_VIDEO_BITRATE_MBPS: 0,
    HLS_SEGMENT_TYPE: 'fmp4',
}));

vi.mock('$lib/server/config.js', async () => ({
    ...(await import('../tasks/__fixtures__/task-config-mock.js')).taskConfigMock(),
    config: new Proxy(mockCfg, {
        get(target, prop: string) {
            return target[prop as keyof typeof target];
        },
    }),
}));

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
    TranscodeFileManager: vi.fn(function (this: Record<string, unknown>) {
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
    FFmpegProcessRunnerEvents: vi.fn(function (this: Record<string, unknown>) {
        Object.assign(this, mockProcessRunner);
    }),
}));

vi.mock('./transcoding/iframe-analyzer.js', () => ({
    IFrameAnalyzer: vi.fn(function (this: Record<string, unknown>) {
        this.startAnalysis = vi.fn();
        this.stopAnalysis = vi.fn();
    }),
}));

vi.mock('./transcoding/seek-controller.js', () => ({
    SeekController: vi.fn(function (this: Record<string, unknown>) {
        this.prepareJobStateForSeek = vi.fn();
    }),
}));

vi.mock('./transcoding/hardware-detection.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./transcoding/hardware-detection.js')>()),
    hardwareDetection: {
        getBestEncoder: vi.fn(),
        getBestDecoder: vi.fn().mockResolvedValue(null),
        canSoftwareDecodeBridge: vi.fn().mockReturnValue(false),
        isSourceHardwareDecodable: vi.fn().mockReturnValue(false),
        markSourceNotHardwareDecodable: vi.fn(),
        invalidateEncoderProbe: vi.fn(),
    },
}));

vi.mock('./transcoding/index.js', async () => {
    const { FullTranscodeStrategy } = await import('./transcoding/full-transcode-strategy.js');
    const { resolveTonemapMode } = await import('./transcoding/ffmpeg-args-builder.js');
    const { transcodeDecision: realDecision } = await import('./transcoding/transcode-decision.js');
    const copyPlanDecision = {
        mode: 'full',
        reasons: 0,
        needsTonemapping: false,
        preserveHdr10: false,
        videoAction: 'copy',
        audioAction: 'transcode',
        useGpu: false,
    };
    return {
        transcodeDecision: {
            decide: vi.fn().mockResolvedValue(copyPlanDecision),
            consumePlan: vi.fn().mockResolvedValue({ ...copyPlanDecision }),
            assignHdrForFlippedTranscode: vi.fn(
                realDecision.assignHdrForFlippedTranscode.bind(realDecision),
            ),
            assignEncoderForFlippedTranscode: vi.fn(
                async (
                    d: {
                        useGpu: boolean;
                        gpuEncoder?: string;
                        gpuDecoder?: string;
                        targetCodec?: { video?: string; audio?: string };
                    },
                    _source: unknown,
                    requestedFamily?: string,
                ) => {
                    const family = requestedFamily ?? 'hevc';
                    d.gpuEncoder = `${family}_nvenc`;
                    d.gpuDecoder = 'hevc_cuvid';
                    d.useGpu = true;
                    d.targetCodec = { ...d.targetCodec, video: d.gpuEncoder };
                },
            ),
        },
        FullTranscodeStrategy,
        resolveTonemapMode,
        getHwAccelFromEncoder: vi.fn().mockReturnValue('none'),
    };
});

vi.mock('./hls/generation-router.js', async (importOriginal) => {
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
    ...(await importOriginal<typeof import('./transcoding/transcode-failure-classifier.js')>()),
    classifyTranscodeFailure: vi.fn().mockReturnValue({ kind: 'unknown' }),
    formatTranscodeFailureMessage: vi.fn().mockReturnValue(''),
}));

vi.mock('../utils/hls-stream-duration.js', () => ({
    isDistinctStreamDuration: vi.fn().mockReturnValue(false),
}));

import type { TranscodeJobConfig } from './transcoding/types.js';

import type { TranscodeDecision } from './transcoding/types.js';
import { planHlsSegmentAction } from './hls/segment-action-planner.js';

const DURATION = 120;
const KEYFRAMES = [0, 13.56, 21.24, 38.4, 47.88, 57.36, 66.84, 76.32, 85.8, 95.28, 104.76, 114.24];
const cases = ['direct', 'remux', 'audio_transcode', 'full_transcode'].flatMap((mode) =>
    ['absent', 'same', 'different'].flatMap((codec) =>
        [false, true].flatMap((burnIn) =>
            [false, true].flatMap((cap) =>
                [false, true].flatMap((audioOnly) =>
                    [false, true].flatMap((tonemap) =>
                        [0, 55.03].flatMap((start) =>
                            [false, true].map((noMediaSourceInfo) => ({
                                mode,
                                codec,
                                burnIn,
                                cap,
                                audioOnly,
                                tonemap,
                                start,
                                noMediaSourceInfo,
                                name: `${mode}/codec=${codec}/pgs=${burnIn}/cap=${cap}/audioOnly=${audioOnly}/tonemap=${tonemap}/start=${start}/noMediaSourceInfo=${noMediaSourceInfo}`,
                            })),
                        ),
                    ),
                ),
            ),
        ),
    ),
);

/** The client chooses the entry containing its saved position in the real manifest. */
function firstRequest(playlist: string, position: number): number {
    let end = 0;
    for (const [index, match] of [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].entries()) {
        end += Number(match[1]);
        if (position < end) return index;
    }
    throw new Error('Position outside playlist');
}

describe('effective plan × request invariant matrix', () => {
    let service: ReturnType<
        typeof import('./ffmpeg-transcode.service.js').getFFmpegTranscodeService
    >;
    let playlist: typeof import('./hls/muxed-vod-playlist.js');
    let state: typeof import('./hls/segment-request-state.js');
    let engine: typeof import('./transcoding/index.js').transcodeDecision;

    beforeEach(async () => {
        // Module singleton is deliberately shared: each row has its own session/job.
        mockCfg.MAX_WIDTH = 0;
        mockCfg.MAX_HEIGHT = 0;
        mockCfg.VIDEO_BITRATE_MBPS = 0;
        engine = (await import('./transcoding/index.js')).transcodeDecision;
        vi.mocked(engine.decide).mockResolvedValue({
            mode: 'full',
            reasons: 0,
            needsTonemapping: false,
            preserveHdr10: false,
            videoAction: 'copy',
            audioAction: 'transcode',
            useGpu: false,
        } as TranscodeDecision);
        vi.mocked(engine.assignEncoderForFlippedTranscode).mockImplementation(
            async (d, source, requested) => {
                const family = requested ?? source.codec ?? 'h264';
                d.gpuEncoder = `${family}_nvenc`;
                d.gpuDecoder = 'hevc_cuvid';
                d.useGpu = true;
                d.targetCodec = { ...d.targetCodec, video: d.gpuEncoder };
            },
        );
        service = (await import('./ffmpeg-transcode.service.js')).getFFmpegTranscodeService();
        playlist = await import('./hls/muxed-vod-playlist.js');
        state = await import('./hls/segment-request-state.js');
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockResolvedValue(undefined);
    });
    afterEach(() => {
        vi.clearAllMocks();
    });

    it.each(
        [false, true].flatMap((burnIn) =>
            ['h264', 'hevc', 'av1'].flatMap((codec) =>
                ['cpu', 'nvenc', 'qsv'].map((availability) => ({ burnIn, codec, availability })),
            ),
        ),
    )(
        'burn-in=$burnIn output=$codec encoders=$availability',
        async ({ burnIn, codec, availability }) => {
            vi.mocked(engine.consumePlan).mockResolvedValue({
                mode: 'full',
                reasons: 0,
                videoAction: 'copy',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            } as TranscodeDecision);
            const { transcodeDecision: realDecision } =
                await import('./transcoding/transcode-decision.js');
            const { hardwareDetection } = await import('./transcoding/hardware-detection.js');
            const encoder =
                availability === 'cpu'
                    ? { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' }[codec]
                    : `${codec}_${availability}`;
            vi.mocked(hardwareDetection.getBestEncoder).mockResolvedValue(encoder!);
            vi.mocked(engine.assignEncoderForFlippedTranscode).mockImplementation(
                realDecision.assignEncoderForFlippedTranscode.bind(realDecision),
            );
            const job = await service.startJob({
                itemId: 'burn-matrix',
                username: 'matrix-user',
                deviceId: 'matrix-device',
                playSessionId: `burn-${burnIn}-${codec}-${availability}`,
                localFilePath: '/media/matrix.mkv',
                inputUrl: '/media/matrix.mkv',
                totalDurationSeconds: DURATION,
                audioTracks: [],
                videoInfo: { codec, outputCodec: codec, width: 320, height: 180, bitDepth: 8 },
                mediaSourceInfo: { streams: [{ type: 'Video', codec, videoRange: 'SDR' }] },
                playbackPlan: { plan_id: 'burn-plan', method: 'remux', video_action: 'copy' },
                ...(burnIn
                    ? { subtitleBurnIn: { absoluteIndex: 1, codec: 'hdmv_pgs_subtitle' } }
                    : {}),
            } as unknown as TranscodeJobConfig);
            expect(job.error).toBeUndefined();
            const args = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)![1] as string[];
            if (burnIn) {
                expect(engine.assignEncoderForFlippedTranscode).toHaveBeenCalledTimes(1);
                expect(job.config.effectivePlan?.video).toMatchObject({
                    action: 'transcode',
                    encoder,
                });
                expect(args[args.indexOf('-c:v') + 1]).toBe(encoder);
                expect(args[args.indexOf('-filter_complex') + 1]).toMatch(
                    /overlay=.*?,format=(yuv420p(?:10le)?|nv12|p010le)/,
                );
            } else {
                expect(engine.assignEncoderForFlippedTranscode).not.toHaveBeenCalled();
                expect(job.config.effectivePlan?.video).toEqual({ action: 'copy' });
            }
        },
    );

    it.each(cases)('$name', async (row) => {
        const plannedCopy = row.mode !== 'full_transcode';
        const decision = {
            mode: row.mode === 'direct' ? 'direct' : 'full',
            videoAction: plannedCopy ? 'copy' : 'transcode',
            audioAction: row.mode === 'audio_transcode' || !plannedCopy ? 'transcode' : 'copy',
            useGpu: false,
            needsTonemapping: row.tonemap,
            preserveHdr10: false,
            ...(plannedCopy ? {} : { targetCodec: { video: 'libx265' } }),
        } as TranscodeDecision;
        vi.mocked(engine.consumePlan).mockImplementation(async () => structuredClone(decision));
        const cfg = {
            itemId: 'matrix-item',
            username: 'matrix-user',
            deviceId: 'matrix-device',
            playSessionId: row.name,
            localFilePath: '/media/matrix.mkv',
            inputUrl: '/media/matrix.mkv',
            startTimeSeconds: row.start,
            totalDurationSeconds: DURATION,
            keyframeData: KEYFRAMES,
            hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
            audioTracks: [
                { index: 1, codec: 'aac', channels: 2, displayTitle: 'Audio', isDefault: true },
            ],
            videoInfo: {
                codec: 'hevc',
                width: 1920,
                height: 1080,
                ...(row.codec === 'absent'
                    ? {}
                    : { outputCodec: row.codec === 'same' ? 'hevc' : 'h264' }),
                videoRange: row.tonemap ? 'HDR' : 'SDR',
                bitDepth: row.tonemap ? 10 : 8,
            },
            mediaSourceInfo: {
                bitrate: 20_000_000,
                streams: [
                    { type: 'Video', codec: 'hevc', videoRange: row.tonemap ? 'HDR' : 'SDR' },
                    { type: 'Audio', codec: 'aac' },
                ],
            },
            playbackPlan: {
                plan_id: 'matrix-plan',
                method: row.mode,
                video_action: plannedCopy ? 'copy' : 'transcode',
                client_hdr_formats: [],
            },
            ...(row.cap ? { qualityCap: { maxHeight: 720, maxBitrate: 4_000_000 } } : {}),
            ...(row.burnIn
                ? { subtitleBurnIn: { absoluteIndex: 2, codec: 'hdmv_pgs_subtitle' } }
                : {}),
            videoDisabled: row.audioOnly,
        } as unknown as TranscodeJobConfig;
        // The legacy no-probe path has neither stream metadata nor probe-derived keyframes.
        if (row.noMediaSourceInfo) {
            cfg.mediaSourceInfo = undefined;
            cfg.keyframeData = undefined;
        }
        const job = await service.startJob(cfg);
        expect(job.error, 'real argv construction must succeed').toBeUndefined();
        const args = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)?.[1] as string[] | undefined;
        expect(args, 'real process runner must receive argv').toBeDefined();
        const cv = args!.indexOf('-c:v');
        const argvAction = args!.includes('-vn')
            ? 'drop'
            : args![cv + 1] === 'copy'
              ? 'copy'
              : 'transcode';
        const usesCopy = playlist.playlistUsesCopyGrid(job, plannedCopy);
        const manifest = playlist.buildMuxedVodPlaylist({
            runtimeSeconds: DURATION,
            segmentDuration: job.segmentDurationSeconds,
            segmentBase: '/hls',
            segmentParams: new URLSearchParams(),
            segmentExtension: 'm4s',
            keyframeData: usesCopy && !row.noMediaSourceInfo ? KEYFRAMES : undefined,
            seekStartTime: usesCopy ? job.config.startTimeSeconds : undefined,
        });
        const first = firstRequest(manifest, row.start);
        const requestState = state.buildHlsSegmentRequestState({
            job,
            segmentInfo: { streamDir: '', segmentIndex: first },
            isSegment: true,
            requestedSegmentNum: first,
            adapter: {
                getSegmentOffsetForJob: (j) => service.getSegmentOffsetForJob(j),
                getStreamSegmentOffsetForJob: (j, dir) =>
                    service.getStreamSegmentOffsetForJob(j, dir),
                getStreamTargetDurationForJob: (j, dir) =>
                    service.getStreamTargetDurationForJob(j, dir),
                canStreamTriggerSeekForJob: (j, dir) => service.canStreamTriggerSeekForJob(j, dir),
                isSegmentDeletedForJob: () => false,
            },
        });
        const startNumberFlag = args!.indexOf('-start_number');
        const firstFile = startNumberFlag < 0 ? 0 : Number(args![startNumberFlag + 1]);
        expect
            .soft(requestState.isVideoTranscoded)
            .toBe(argvAction !== 'copy' && !(row.audioOnly && row.noMediaSourceInfo));
        expect.soft(job.config.effectivePlan?.video.action).toBe(argvAction);
        const action = planHlsSegmentAction({
            isSegment: true,
            isIframeRequest: false,
            requestedSegmentNum: first,
            actualSegmentIndex: requestState.actualSegmentIndex,
            segmentOffset: requestState.segmentOffset,
            canSeek: requestState.canSeek,
            fileExists: false,
            isDeleted: false,
            jobStatus: job.status,
            jobIsSeeking: false,
            isVideoTranscoded: requestState.isVideoTranscoded,
            currentProgress: requestState.currentProgressForDiagnostics,
        });
        expect
            .soft(action.type, 'the first playlist request must use the running generation')
            .not.toBe('trigger_seek');
        expect
            .soft(job.config.effectivePlan?.grid)
            .toBe(argvAction === 'copy' ? 'keyframe' : 'uniform');
        expect.soft(job.config.effectivePlan?.videoDisabled).toBe(argvAction === 'drop');
        if (job.config.effectivePlan?.video.action === 'transcode') {
            expect.soft(job.config.effectivePlan.video.encoder).toBe(args![cv + 1]);
        }
        expect
            .soft(requestState.actualSegmentIndex, 'first requested file vs first produced file')
            .toBe(firstFile);
        expect.soft(usesCopy).toBe(argvAction === 'copy');
        expect
            .soft(Number(manifest.match(/#EXTINF:([\d.]+),/)?.[1]))
            .toBe(usesCopy && !row.noMediaSourceInfo ? 13.56 : job.segmentDurationSeconds);
        // A copy decision cannot honour a required HDR→SDR filter. This catches
        // invalid argv too: merely comparing -c:v with the handler would miss it.
        if (
            row.tonemap &&
            !row.audioOnly &&
            (!row.noMediaSourceInfo || row.codec === 'different' || row.burnIn || row.cap)
        ) {
            expect.soft(argvAction, 'tonemapping requires encoding').toBe('transcode');
            expect
                .soft(args!.join(' '), 'HDR output must be tonemapped for an SDR client')
                .toContain('tonemap');
        }
        if (row.audioOnly) expect.soft(args).toContain('-vn');
        if (row.burnIn && !row.audioOnly) expect.soft(argvAction).toBe('transcode');
        const persistedConfig = JSON.parse(JSON.stringify(job.config)) as TranscodeJobConfig;
        persistedConfig.playSessionId = `${row.name}/restored`;
        persistedConfig.startTimeSeconds = 999;
        persistedConfig.segmentDurationSeconds = 99;
        persistedConfig.videoInfo = { ...persistedConfig.videoInfo!, outputCodec: 'av1' };
        const savedPlan = JSON.parse(JSON.stringify(job.config.effectivePlan));
        vi.mocked(engine.consumePlan).mockClear();
        mockCfg.MAX_HEIGHT = 144;
        mockCfg.VIDEO_BITRATE_MBPS = 99;
        const restored = await service.restoreJob({
            job_id: `${job.id}-restored`,
            play_session_id: persistedConfig.playSessionId,
            item_id: job.config.itemId,
            config: persistedConfig,
            output_dir: `${job.outputDir}-restored`,
            segment_offset: job.segmentOffset + 100,
            transcode_decision: { ...decision, videoAction: plannedCopy ? 'transcode' : 'copy' },
            created_at: job.startedAt,
            status: 'running',
            mode: 'full',
        } as unknown as import('./transcode-job-persistence.service.js').PersistedJobMetadata);
        expect(restored.error, 'restored argv must succeed').toBeUndefined();
        expect(engine.consumePlan).not.toHaveBeenCalled();
        expect(JSON.parse(JSON.stringify(restored.config.effectivePlan))).toEqual(savedPlan);
        const restoredArgs = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)?.[1] as string[];
        expect(restoredArgs[restoredArgs.indexOf('-c:v') + 1]).toBe(args![cv + 1]);
        expect(restored.ffmpegOutputStartNumber).toBe(firstFile);
        expect(restoredArgs.map((arg) => arg.replaceAll(restored.outputDir, '<output>'))).toEqual(
            args!.map((arg) => arg.replaceAll(job.outputDir, '<output>')),
        );
    });
    function regressionConfig(name: string): TranscodeJobConfig {
        return {
            itemId: 'regression-item',
            username: 'matrix-user',
            deviceId: 'matrix-device',
            playSessionId: name,
            inputUrl: '/media/regression.mkv',
            localFilePath: '/media/regression.mkv',
            totalDurationSeconds: 120,
            audioTracks: [
                {
                    index: 1,
                    codec: 'aac',
                    channels: 2,
                    bitrate: 192_000,
                    displayTitle: 'A',
                    isDefault: true,
                },
                { index: 2, codec: 'aac', channels: 2, bitrate: 4_000_000, displayTitle: 'B' },
            ],
            hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
            videoInfo: {
                codec: 'av1',
                outputCodec: 'h264',
                width: 1920,
                height: 1080,
                videoRange: 'HDR',
                videoRangeType: 'HDR10',
                bitDepth: 10,
            },
        } as TranscodeJobConfig;
    }

    it.each(
        ['h264', 'hevc'].flatMap((codec) =>
            [false, true].map((emptyProbe) => ({ codec, emptyProbe })),
        ),
    )(
        'keeps HDR handling without a video stream or decision ($codec, emptyProbe=$emptyProbe)',
        async ({ codec, emptyProbe }) => {
            const cfg = regressionConfig(`no-probe-hdr-${codec}-${emptyProbe}`);
            if (emptyProbe) {
                cfg.mediaSourceInfo = {
                    streams: [],
                } as unknown as TranscodeJobConfig['mediaSourceInfo'];
                vi.mocked(engine.decide).mockRejectedValue(new Error('No video stream decision'));
            }
            cfg.videoInfo!.outputCodec = codec;
            const job = await service.startJob(cfg);
            expect(job.error).toBeUndefined();
            const args = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)![1] as string[];
            expect(args.length).toBeGreaterThan(0);
            if (codec === 'h264') {
                expect(args.join(' ')).toContain('tonemap');
                expect(job.config.effectivePlan?.decision?.needsTonemapping).toBe(true);
            } else {
                expect(args.join(' ')).not.toContain('tonemap');
                expect(job.config.effectivePlan?.decision?.preserveHdr10).toBe(true);
                expect(args).toContain('smpte2084');
            }
        },
    );

    it('tonemaps a legacy HDR restore with no effective plan and a null decision', async () => {
        const cfg = regressionConfig('legacy-hdr-restore');
        const restored = await service.restoreJob({
            job_id: 'legacy-hdr-job',
            play_session_id: cfg.playSessionId,
            item_id: cfg.itemId,
            config: cfg,
            output_dir: '/tmp/transcode-test/legacy-hdr',
            segment_offset: 0,
            transcode_decision: null,
            created_at: new Date(),
            status: 'running',
            mode: 'full',
        } as unknown as import('./transcode-job-persistence.service.js').PersistedJobMetadata);
        expect(restored.error).toBeUndefined();
        expect(
            (mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)![1] as string[]).join(' '),
        ).toContain('tonemap');
    });

    it('reserves the new copied muxed track within the saved total budget, freezing other caps', async () => {
        vi.mocked(engine.consumePlan).mockResolvedValue({
            mode: 'full',
            reasons: 0,
            needsTonemapping: false,
            preserveHdr10: false,
            videoAction: 'copy',
            audioAction: 'copy',
            useGpu: false,
        } as TranscodeDecision);
        const cfg = regressionConfig('track-cap-switch');
        cfg.videoInfo = { codec: 'h264', width: 1920, height: 1080, videoRange: 'SDR' };
        cfg.qualityCap = { maxBitrate: 8_000_000 };
        cfg.subtitleBurnIn = { absoluteIndex: 3, codec: 'hdmv_pgs_subtitle' };
        cfg.mediaSourceInfo = {
            streams: [
                { type: 'Video', codec: 'h264' },
                { type: 'Audio', codec: 'aac', index: 1 },
                { type: 'Audio', codec: 'aac', index: 2 },
            ],
        } as unknown as TranscodeJobConfig['mediaSourceInfo'];
        cfg.playbackPlan = { plan_id: 'track-cap-plan' } as TranscodeJobConfig['playbackPlan'];
        const first = await service.startJob(cfg);
        expect(first.error).toBeUndefined();
        const savedPlan = structuredClone(first.config.effectivePlan!);
        const oldCaps = savedPlan.caps;
        mockCfg.MAX_HEIGHT = 144;
        mockCfg.MAX_WIDTH = 256;
        mockCfg.VIDEO_BITRATE_MBPS = 1;
        const next = await service.startJob({
            ...cfg,
            startTimeSeconds: 30,
            hlsOutput: { ...cfg.hlsOutput, hlsAudioTrackIndex: 2 },
        });
        expect(next.error).toBeUndefined();
        expect(next.id).not.toBe(first.id);
        const args = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)![1] as string[];
        const { parseBitrateString } = await import('./transcoding/quality-cap.js');
        expect(args).toContain('-maxrate');
        expect(args).toContain('copy');
        expect(
            parseBitrateString(args[args.indexOf('-maxrate') + 1]) + 4_000_000,
        ).toBeLessThanOrEqual(8_000_000);
        const newCaps = next.config.effectivePlan!.caps;
        expect(newCaps.qualityCapAudioReservationBps).toBe(4_000_000);
        expect(newCaps.maxVideoBitrateMbps).toBe(4);
        expect({
            ...newCaps,
            qualityCapAudioReservationBps: oldCaps.qualityCapAudioReservationBps,
            maxVideoBitrateMbps: oldCaps.maxVideoBitrateMbps,
        }).toEqual(oldCaps);
        expect(first.config.effectivePlan).toEqual(savedPlan);
    });

    it('keeps legacy audio-only copy semantics without probe/decision data', async () => {
        const cfg = regressionConfig('audio-only-no-decision');
        cfg.videoDisabled = true;
        cfg.startTimeSeconds = 30;
        cfg.videoInfo = { codec: 'h264', width: 1920, height: 1080 };
        const job = await service.startJob(cfg);
        expect(job.error).toBeUndefined();
        const args = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)![1] as string[];
        expect(args).toContain('-vn');
        const startFlag = args.indexOf('-start_number');
        expect(startFlag < 0 ? 0 : Number(args[startFlag + 1])).toBe(0);
        const request = state.buildHlsSegmentRequestState({
            job,
            segmentInfo: { streamDir: '', segmentIndex: 5 },
            isSegment: true,
            requestedSegmentNum: 5,
            adapter: {
                getSegmentOffsetForJob: (j) => service.getSegmentOffsetForJob(j),
                getStreamSegmentOffsetForJob: (j, dir) =>
                    service.getStreamSegmentOffsetForJob(j, dir),
                getStreamTargetDurationForJob: (j, dir) =>
                    service.getStreamTargetDurationForJob(j, dir),
                canStreamTriggerSeekForJob: (j, dir) => service.canStreamTriggerSeekForJob(j, dir),
                isSegmentDeletedForJob: () => false,
            },
        });
        expect(request.isVideoTranscoded).toBe(false);
        expect(request.actualSegmentIndex).toBe(0);
        expect(request.canSeek).toBe(true);
        expect(
            planHlsSegmentAction({
                isSegment: true,
                isIframeRequest: false,
                requestedSegmentNum: 4,
                actualSegmentIndex: -1,
                segmentOffset: request.segmentOffset,
                canSeek: request.canSeek,
                fileExists: false,
                isDeleted: false,
                jobStatus: job.status,
                jobIsSeeking: false,
                isVideoTranscoded: request.isVideoTranscoded,
                currentProgress: request.currentProgressForDiagnostics,
            }),
        ).toMatchObject({ type: 'trigger_seek', direction: 'backward' });
    });
});
