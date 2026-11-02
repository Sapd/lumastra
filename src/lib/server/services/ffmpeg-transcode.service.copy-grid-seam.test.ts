// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The seam behind "every mid-play switch spawns two transcode jobs"
 * (Windows e2e 2026-09-27 follow-up, server log of play session a0000005).
 *
 * Two sides have to number segments on ONE grid:
 *   - the server-owned muxed VOD playlist hls.js reads (buildMuxedVodPlaylist),
 *     which picks the copy-mode KEYFRAME grid or the uniform grid;
 *   - the segment side (buildHlsSegmentRequestState + planHlsSegmentAction),
 *     which reads the JOB's `transcodeDecisionResult.videoAction`.
 *
 * The playlist used to decide from the REQUEST's codec. A "1080p 10 Mbps" pick
 * on a remux (video copy) plan reached startJob with a per-request quality cap;
 * the quality-cap safety net flipped the job to a transcode (uniform 6 s
 * grid, start 54 s, offset 9) while the playlist still listed keyframe
 * segments. The player's first request — keyframe segment 5 for a 55 s resume —
 * read as a backward seek below offset 9 and spawned a second generation from
 * 30 s. Every switch cost two jobs and a 15-18 s restart.
 *
 * Since then the planner is authoritative for the cap: that request no longer
 * flips at all (unknown bitrate → trust the plan), a plan evaluated against the
 * same cap is never flipped, and only a plan WITHOUT cap information can still
 * be flipped by the safety net — onto the GPU encoder. The grid tests use
 * such a safety-net flip to build a job whose decision differs from the
 * request, which is what the playlist must follow.
 *
 * This file drives the REAL startJob (decision reconcile, offsets, grid), the
 * REAL playlist builder, the REAL segment-request state and the REAL action
 * planner, and asserts that the first segment the playlist hands out for the
 * resume position is served by the running job, not re-transcoded.
 *
 * It also pins the plain resume (open a remux item at a saved position, no
 * quality cap): the job stays copy mode, the playlist keeps the keyframe grid,
 * and the two already agree — that path did not have the bug.
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

import type { TranscodeJobConfig } from './transcoding/types.js';

// The file from the incident: keyframe-derived segment durations start
// 13.56, 7.68, 17.16, 9.48, 9.48 … (10 s copy grid). Keyframes are the cut
// points, then a regular ~9.48 s GOP to the end.
const TOTAL_DURATION = 3300;
const KEYFRAMES = ((): number[] => {
    const kf = [0, 13.56, 21.24, 38.4, 47.88, 57.36];
    while (kf[kf.length - 1] + 9.48 < TOTAL_DURATION) {
        kf.push(+(kf[kf.length - 1] + 9.48).toFixed(3));
    }
    return kf;
})();
// Where the player resumed (seekSeconds in the log).
const RESUME_SECONDS = 55.03;

function videoConfig(
    playSessionId: string,
    opts: {
        qualityCap?: TranscodeJobConfig['qualityCap'];
        /** capComparableBitrate of the source; undefined = unknown (typical MKV). */
        sourceBitrate?: number;
        /** The cap the plan was evaluated against (PlaybackPlan.quality_cap). */
        planQualityCap?: { max_bitrate?: number; max_height?: number };
        /** The codec the REQUEST asked for (`?videoCodec=`); unset = the source's own (copy). */
        outputCodec?: string;
    } = {},
): TranscodeJobConfig {
    return {
        itemId: 'item-1',
        username: 'user-a',
        deviceId: 'device-1',
        inputUrl: '/media/x.mkv',
        localFilePath: '/media/x.mkv',
        startTimeSeconds: RESUME_SECONDS,
        totalDurationSeconds: TOTAL_DURATION,
        keyframeData: KEYFRAMES,
        hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
        audioTracks: [
            {
                index: 1,
                displayTitle: 'German',
                language: 'ger',
                channels: 6,
                codec: 'eac3',
                isDefault: true,
            },
        ],
        // The request resolved "copy" (the remux plan) — what playback.service
        // hands the playlist builder as the request's view.
        videoInfo: {
            codec: 'hevc',
            width: 1920,
            height: 1080,
            isTranscoded: opts.outputCodec !== undefined,
            ...(opts.outputCodec ? { outputCodec: opts.outputCodec } : {}),
        },
        mediaSourceInfo: {
            streams: [],
            bitrate: opts.sourceBitrate,
        } as unknown as TranscodeJobConfig['mediaSourceInfo'],
        playbackPlan: {
            plan_id: 'plan-1',
            video_action: 'copy',
            ...(opts.planQualityCap ? { quality_cap: opts.planQualityCap } : {}),
        } as unknown as TranscodeJobConfig['playbackPlan'],
        qualityCap: opts.qualityCap,
        playSessionId,
    } as TranscodeJobConfig;
}

/** hls.js' pick for a start position: the first listed segment whose span
 *  contains it. Reads the playlist the client actually gets. */
function firstRequestedSegment(playlist: string, positionSeconds: number): number {
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
    let end = 0;
    for (let i = 0; i < durations.length; i++) {
        end += durations[i];
        if (positionSeconds < end) return i;
    }
    throw new Error('position beyond the playlist');
}

describe('muxed VOD playlist grid vs segment addressing (copy plan, mid-file start)', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let stateModule: typeof import('./hls/segment-request-state.js');
    let plannerModule: typeof import('./hls/segment-action-planner.js');
    let playlistModule: typeof import('./hls/muxed-vod-playlist.js');

    beforeEach(async () => {
        vi.resetModules();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockResolvedValue(undefined);
        // A FRESH copy-plan decision per call: the effective planner
        // consumes the decision it is handed, and the shared mock's
        // mockResolvedValue object would carry one test's flip into the next.
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
        stateModule = await import('./hls/segment-request-state.js');
        plannerModule = await import('./hls/segment-action-planner.js');
        playlistModule = await import('./hls/muxed-vod-playlist.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    type Job = Awaited<
        ReturnType<ReturnType<typeof svcModule.getFFmpegTranscodeService>['startJob']>
    >;

    function playlistFor(job: Job, copyGrid: boolean): string {
        return playlistModule.buildMuxedVodPlaylist({
            runtimeSeconds: TOTAL_DURATION,
            segmentDuration: job.segmentDurationSeconds,
            segmentBase: '/hls',
            segmentParams: new URLSearchParams(),
            segmentExtension: 'm4s',
            keyframeData: copyGrid ? KEYFRAMES : undefined,
            seekStartTime: copyGrid ? (job.config.startTimeSeconds ?? 0) : undefined,
        });
    }

    /** What the segment handler decides for a request of manifest index N. */
    function actionFor(job: Job, requestedSegmentNum: number) {
        const svc = svcModule.getFFmpegTranscodeService();
        const state = stateModule.buildHlsSegmentRequestState({
            job,
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
        });
        return plannerModule.planHlsSegmentAction({
            isSegment: true,
            isIframeRequest: false,
            requestedSegmentNum,
            actualSegmentIndex: state.actualSegmentIndex,
            segmentOffset: state.segmentOffset,
            canSeek: state.canSeek,
            fileExists: false,
            isDeleted: false,
            jobStatus: job.status,
            jobIsSeeking: false,
            isVideoTranscoded: state.isVideoTranscoded,
            currentProgress: state.currentProgressForDiagnostics,
        });
    }

    const CAP = { maxBitrate: 10_000_000, maxHeight: 1080 };

    it('the incident request (copy plan, 10 Mbps cap, unknown bitrate) no longer flips: trust the plan', async () => {
        // Before: unknown bitrate counted as exceeding → software transcode,
        // start 54, offset 9 (the Windows log). Now the job keeps the plan.
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(videoConfig('cap-unknown-bitrate', { qualityCap: CAP }));
        expect(job.transcodeDecisionResult?.videoAction).toBe('copy');
        expect(job.segmentDurationSeconds).toBe(10);

        const copyGrid = playlistModule.playlistUsesCopyGrid(job, true);
        expect(copyGrid).toBe(true);
        const first = firstRequestedSegment(playlistFor(job, copyGrid), RESUME_SECONDS);
        expect(actionFor(job, first).type).not.toBe('trigger_seek');
    });

    it('a plan evaluated against the same cap is never flipped, even for a source above it', async () => {
        // The planner is authoritative: it saw this cap and chose copy.
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            videoConfig('cap-plan-evaluated', {
                qualityCap: CAP,
                sourceBitrate: 20_000_000,
                planQualityCap: { max_bitrate: 10_000_000, max_height: 1080 },
            }),
        );
        expect(job.transcodeDecisionResult?.videoAction).toBe('copy');
    });

    it('the safety net (plan without cap info, source known above it) flips — onto the GPU encoder', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const { transcodeDecision } = await import('./transcoding/index.js');
        const job = await svc.startJob(
            videoConfig('cap-safety-net', { qualityCap: CAP, sourceBitrate: 20_000_000 }),
        );
        expect(job.transcodeDecisionResult?.videoAction).toBe('transcode');
        expect(transcodeDecision.assignEncoderForFlippedTranscode).toHaveBeenCalledTimes(1);
        expect(job.transcodeDecisionResult).toMatchObject({
            useGpu: true,
            gpuEncoder: 'hevc_nvenc',
        });
        // …and the encoder FFmpeg is actually handed.
        const argv = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)?.[1] as string[] | undefined;
        expect(argv).toBeDefined();
        const cv = argv!.indexOf('-c:v');
        expect(argv![cv + 1]).toBe('hevc_nvenc');
    });

    it('the playlist follows a flipped job, so the first segment it lists is served, not re-transcoded', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            videoConfig('cap-flip-served', { qualityCap: CAP, sourceBitrate: 20_000_000 }),
        );
        // The shape of the incident's job: uniform 6 s grid, start 54, offset 9.
        expect(job.segmentDurationSeconds).toBe(6);
        expect(job.config.startTimeSeconds).toBe(54);
        expect(job.segmentOffset).toBe(9);
        const copyGrid = playlistModule.playlistUsesCopyGrid(job, true);
        expect(copyGrid).toBe(false);

        const first = firstRequestedSegment(playlistFor(job, copyGrid), RESUME_SECONDS);
        expect(first).toBe(9);
        expect(actionFor(job, first).type).not.toBe('trigger_seek');
    });

    it('guards the regression: the request-derived keyframe playlist would trigger the backward seek', async () => {
        // Proves the test above can fail: the old wiring (request says copy →
        // keyframe grid) hands out a keyframe index below the job's offset.
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            videoConfig('cap-flip-old-wiring', { qualityCap: CAP, sourceBitrate: 20_000_000 }),
        );
        const first = firstRequestedSegment(playlistFor(job, true), RESUME_SECONDS);
        expect(first).toBeLessThan(job.segmentOffset);
        expect(actionFor(job, first)).toMatchObject({
            type: 'trigger_seek',
            direction: 'backward',
        });
    });

    it('plain resume of a remux item at a saved position stays on one consistent keyframe grid', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(videoConfig('plain-resume'));
        expect(job.transcodeDecisionResult?.videoAction).toBe('copy');
        expect(job.segmentDurationSeconds).toBe(10);

        const copyGrid = playlistModule.playlistUsesCopyGrid(job, true);
        expect(copyGrid).toBe(true);
        const first = firstRequestedSegment(playlistFor(job, copyGrid), RESUME_SECONDS);
        // 55.03 s lies in the keyframe segment starting at 47.88 s.
        expect(first).toBe(4);
        expect(actionFor(job, first).type).not.toBe('trigger_seek');
    });
});

describe('request asks for a codec the source is not (copy plan + videoCodec=h264)', () => {
    // Prod 2026-10-21, Firefox, GoT S03E07 (HEVC, resume at 564 s): the web player
    // started with requestedMethod full_transcode, so the HLS URL said
    // videoCodec=h264 while the plan (audio_transcode) said video COPY. FFmpeg's
    // strategy re-encoded on the CPU (a requested codec change beats the
    // decision) and numbered its files from -start_number <offset>, but the
    // job's decision still said 'copy', so the segment side looked for file
    // `requested - offset`. Segment 56 was never found: 10 s wait, then 404,
    // while FFmpeg had 14-21 segments on disk, and the player restarted forever.
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let stateModule: typeof import('./hls/segment-request-state.js');
    let playlistModule: typeof import('./hls/muxed-vod-playlist.js');

    beforeEach(async () => {
        vi.resetModules();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
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
        stateModule = await import('./hls/segment-request-state.js');
        playlistModule = await import('./hls/muxed-vod-playlist.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    function lastArgv(): string[] {
        const argv = mockProcessRunner.spawnFFmpeg.mock.calls.at(-1)?.[1] as string[] | undefined;
        expect(argv).toBeDefined();
        return argv!;
    }

    it('the job decision says transcode, like the encoder FFmpeg is handed', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const { transcodeDecision } = await import('./transcoding/index.js');
        const job = await svc.startJob(videoConfig('codec-change', { outputCodec: 'h264' }));

        expect(job.transcodeDecisionResult?.videoAction).toBe('transcode');
        // The encoder is picked for the REQUESTED family, not the source's.
        expect(transcodeDecision.assignEncoderForFlippedTranscode).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ codec: 'hevc' }),
            'h264',
        );
        const argv = lastArgv();
        expect(argv[argv.indexOf('-c:v') + 1]).not.toBe('copy');
    });

    it('the first segment the playlist lists is the first file FFmpeg writes', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(videoConfig('codec-change-files', { outputCodec: 'h264' }));
        const argv = lastArgv();
        const firstFileWritten = Number(argv[argv.indexOf('-start_number') + 1]);

        const copyGrid = playlistModule.playlistUsesCopyGrid(job, false);
        expect(copyGrid).toBe(false);
        const playlist = playlistModule.buildMuxedVodPlaylist({
            runtimeSeconds: TOTAL_DURATION,
            segmentDuration: job.segmentDurationSeconds,
            segmentBase: '/hls',
            segmentParams: new URLSearchParams(),
            segmentExtension: 'm4s',
        });
        const first = firstRequestedSegment(playlist, RESUME_SECONDS);

        const state = stateModule.buildHlsSegmentRequestState({
            job,
            segmentInfo: { streamDir: '', segmentIndex: first },
            isSegment: true,
            requestedSegmentNum: first,
            adapter: {
                getSegmentOffsetForJob: (j) => svc.getSegmentOffsetForJob(j),
                getStreamSegmentOffsetForJob: (j, dir) => svc.getStreamSegmentOffsetForJob(j, dir),
                getStreamTargetDurationForJob: (j, dir) =>
                    svc.getStreamTargetDurationForJob(j, dir),
                canStreamTriggerSeekForJob: (j, dir) => svc.canStreamTriggerSeekForJob(j, dir),
                isSegmentDeletedForJob: () => false,
            },
        });
        // The handler waits for segment_<actualSegmentIndex>; FFmpeg's first file
        // is segment_<start_number>. They must be the same file.
        expect(state.actualSegmentIndex).toBe(firstFileWritten);
    });

    it('a request for the source codec (or none) stays a copy', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const same = await svc.startJob(videoConfig('codec-same', { outputCodec: 'hevc' }));
        expect(same.transcodeDecisionResult?.videoAction).toBe('copy');
        const none = await svc.startJob(videoConfig('codec-none'));
        expect(none.transcodeDecisionResult?.videoAction).toBe('copy');
    });
});

describe('playlistUsesCopyGrid', () => {
    it('follows the job decision over the request', async () => {
        const { playlistUsesCopyGrid } = await import('./hls/muxed-vod-playlist.js');
        expect(
            playlistUsesCopyGrid({ transcodeDecisionResult: { videoAction: 'transcode' } }, true),
        ).toBe(false);
        expect(
            playlistUsesCopyGrid({ transcodeDecisionResult: { videoAction: 'copy' } }, false),
        ).toBe(true);
    });

    it('falls back to the request only when the job has no decision', async () => {
        const { playlistUsesCopyGrid } = await import('./hls/muxed-vod-playlist.js');
        expect(playlistUsesCopyGrid({}, true)).toBe(true);
        expect(playlistUsesCopyGrid({ transcodeDecisionResult: null }, false)).toBe(false);
    });
});

describe('jobManifestVideoOverrides (master playlist codec/range follow the job)', () => {
    it('a copy job advertises the source codec, not transcoded', async () => {
        const { jobManifestVideoOverrides } = await import('./hls/muxed-vod-playlist.js');
        expect(jobManifestVideoOverrides({ videoAction: 'copy' }, 'hevc')).toEqual({
            outputCodec: 'hevc',
            isTranscoded: false,
        });
    });

    it('a flipped job advertises the encoder family it really produces', async () => {
        const { jobManifestVideoOverrides } = await import('./hls/muxed-vod-playlist.js');
        // HEVC source, HEVC encoding disabled → h264_nvenc: CODECS must say avc1.
        expect(
            jobManifestVideoOverrides(
                { videoAction: 'transcode', gpuEncoder: 'h264_nvenc' },
                'hevc',
            ),
        ).toEqual({ outputCodec: 'h264', isTranscoded: true });
        expect(
            jobManifestVideoOverrides(
                { videoAction: 'transcode', targetCodec: { video: 'libx265' } },
                'h264',
            ),
        ).toEqual({ outputCodec: 'hevc', isTranscoded: true });
    });

    it('a tone-mapped transcode stops advertising the source HDR range', async () => {
        const { jobManifestVideoOverrides } = await import('./hls/muxed-vod-playlist.js');
        expect(
            jobManifestVideoOverrides(
                { videoAction: 'transcode', gpuEncoder: 'hevc_nvenc', needsTonemapping: true },
                'hevc',
            ),
        ).toEqual({
            outputCodec: 'hevc',
            isTranscoded: true,
            videoRange: 'SDR',
            videoRangeType: 'SDR',
        });
    });

    it('advertises SDR when the burn-in chain owns the tonemap', async () => {
        const { jobManifestVideoOverrides } = await import('./hls/muxed-vod-playlist.js');
        expect(
            jobManifestVideoOverrides(
                {
                    videoAction: 'transcode',
                    gpuEncoder: 'hevc_qsv',
                    needsTonemapping: false,
                    outputVideoRange: 'SDR',
                },
                'hevc',
            ),
        ).toMatchObject({ videoRange: 'SDR', videoRangeType: 'SDR' });
    });

    it('advertises a resolved fallback encoder without rewriting the legacy codec intent', async () => {
        const { jobManifestVideoOverrides } = await import('./hls/muxed-vod-playlist.js');
        expect(
            jobManifestVideoOverrides({ videoAction: 'transcode' }, 'hevc', {
                video: { action: 'transcode', encoder: 'libx264' },
                codecRequestHdr: { kind: 'tonemap' },
            }),
        ).toEqual({
            outputCodec: 'h264',
            isTranscoded: true,
            videoRange: 'SDR',
            videoRangeType: 'SDR',
        });
    });

    it('adds nothing for a job without a decision', async () => {
        const { jobManifestVideoOverrides } = await import('./hls/muxed-vod-playlist.js');
        expect(jobManifestVideoOverrides(undefined, 'hevc')).toEqual({});
    });
});
