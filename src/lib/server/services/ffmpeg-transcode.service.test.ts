// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for FFmpegTranscodeService — exported pure functions
 *
 * Tests the keyframe-based segment computation functions that are exported
 * from the service module. These are pure functions with no external
 * dependencies, so no mocking is required.
 *
 * The service class itself is a singleton with complex setup (timers, DB,
 * file system), so it is not instantiated here. Instead, this file covers
 * the standalone exported helpers that implement core HLS math.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
    computeSegmentsFromKeyframes,
    computeSegmentsWithSeekGrid,
    alignToKeyframeSegmentStart,
    getKeyframeSegmentIndexForTime,
    getKeyframeSegmentStartTime,
    selectSegmentGenerationCandidate,
    computeMaxDimensions,
    hasPlaybackConfigChanged,
    hasAudioTrackChanged,
    resolveSeekGenerationStart,
    sessionKey,
    isPersistablePlaySessionId,
    classifyTranscodeType,
    shouldReapJob,
    selectEvictionVictim,
    filterEvictableByIdle,
    type SegmentGenerationCandidate,
    type ReapCandidate,
    type EvictionCandidate,
} from './ffmpeg-transcode.service.js';

// ---------------------------------------------------------------------------
// handleExit single-writer race (graceful-shutdown can_restore) — mock harness
// ---------------------------------------------------------------------------
//
// The service class is a singleton with heavy dependencies (DB, FS, real
// FFmpeg process events), so — mirroring the existing seam in
// ffmpeg-transcode.service.cap-abort.test.ts — every external dependency is
// mocked so the class can be instantiated and its private `handleExit`
// closure (installed as `callbacks.onExit` on the mocked process runner) can
// be captured and invoked directly to simulate an FFmpeg process exit.

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
    // Read by cleanupInactiveJobs. Real prod defaults — the reaper's timeouts
    // must be concrete numbers here, because the mock config Proxy returns
    // undefined for absent keys and `x > undefined * 1000` is always false,
    // which would make every reaper assertion pass vacuously.
    FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS: 60,
    FFMPEG_PROGRESS_TIMEOUT_SECONDS: 120,
    FFMPEG_INACTIVITY_TIMEOUT_SECONDS: 300,
    FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS: 1800,
    FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS: 180,
    FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS: 60,
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

// Cross-pod stop broadcast (TRANSCODE_STOP_CHANNEL). Only the two functions the
// service uses are replaced; the rest of the module stays real for its other
// importers (a partial factory fails as a missing export, not as a test).
const { mockPublishMessage, mockSubscribeToChannel, stopChannelListeners } = vi.hoisted(() => {
    const stopChannelListeners: Array<(msg: string) => void> = [];
    return {
        stopChannelListeners,
        mockPublishMessage: vi.fn(async () => true),
        mockSubscribeToChannel: vi.fn(
            async (
                _channel: string,
                cb: (msg: string) => void,
            ): Promise<(() => Promise<void>) | null> => {
                stopChannelListeners.push(cb);
                return async () => {};
            },
        ),
    };
});
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey.js')>()),
    publishMessage: mockPublishMessage,
    subscribeToChannel: mockSubscribeToChannel,
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
    updateLastProgress: vi.fn().mockResolvedValue(undefined),
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
    // Real implementation is a pure function of process.env.HOSTNAME — no
    // reason to fake it, and every assertion below that checks the pod-guard
    // argument compares against this same real call.
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
    isOutputComplete: vi.fn().mockResolvedValue(false),
}));

vi.mock('./transcoding/file-manager.js', () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TranscodeFileManager: vi.fn(function (this: any) {
        Object.assign(this, mockFileManager);
    }),
}));

// Captures the per-job lifecycle callbacks (including `onExit`, which is the
// private handleExit closure under test) that spawnFFmpeg() installs on the
// process runner — the real runner would attach these to a child process.
const capturedCallbacks = vi.hoisted(
    () =>
        new Map<
            string,
            { onExit: (...args: unknown[]) => void; onError: (...args: unknown[]) => void }
        >(),
);

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
        // Read by env-snapshot.ts (buildTranscodeEnvSnapshot) via the transcode
        // failure recorder — must stay non-probing, so tests only need a static
        // cold-cache stub.
        getCachedCapabilities: vi.fn().mockReturnValue(null),
        getCachedNvidiaGpuName: vi.fn().mockReturnValue(null),
        getNonHardwareDecodableCodecs: vi.fn().mockReturnValue([]),
    },
}));

const mockFailureEvents = vi.hoisted(() => ({ recordTranscodeFailureEvent: vi.fn() }));
vi.mock('../database/queries/transcode-failure-events.queries.js', () => mockFailureEvents);

const mockGetDb = vi.hoisted(() => vi.fn(() => ({}) as unknown));
vi.mock('../database/connection.js', () => ({ getDb: mockGetDb }));

const mockBuildArgs = vi.hoisted(() => vi.fn().mockReturnValue({ args: [], description: 'mock' }));

vi.mock('./transcoding/index.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./transcoding/index.js')>();
    return {
        transcodeDecision: {
            decide: vi.fn().mockResolvedValue({
                mode: 'full',
                videoAction: 'transcode',
                audioAction: 'transcode',
                useGpu: false,
            }),
            consumePlan: vi.fn().mockResolvedValue({
                mode: 'full',
                videoAction: 'transcode',
                audioAction: 'transcode',
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
    // Keep the real implementation — this file re-exports
    // `selectSegmentGenerationCandidate` from here, and the pure-function
    // tests above (`describe('selectSegmentGenerationCandidate', ...)`)
    // depend on the genuine implementation, not a stub.
    const real = await importOriginal<typeof import('./hls/generation-router.js')>();
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

vi.mock('../utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '' }),
}));

import type { TranscodeJob, TranscodeJobConfig } from './transcoding/types.js';
import type { PersistedJobMetadata } from './transcode-job-persistence.service.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeOutputMarker } from './hls/output-marker.js';

const stampedFixtureDirs: string[] = [];

/** Move a restore fixture's output dir onto a fresh temp dir and stamp it the
 *  way the spawn that wrote it would have: restoreJob only adopts output
 *  stamped for the row's item (HLS re-measure 2026-09-27 §6.3). Removed again
 *  by `removeStampedFixtures`. */
async function stampFixtureOutput(metadata: {
    output_dir: string;
    item_id: string;
    job_id: string;
}): Promise<void> {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumastra-restore-fixture-'));
    metadata.output_dir = path.join(sessionDir, 'gen-0001');
    await fs.mkdir(metadata.output_dir);
    stampedFixtureDirs.push(sessionDir);
    await writeOutputMarker(metadata.output_dir, {
        itemId: metadata.item_id,
        podName: 'fixture-pod',
        jobId: metadata.job_id,
    });
}

async function removeStampedFixtures(): Promise<void> {
    for (const dir of stampedFixtureDirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

function makeHandleExitTestConfig(
    overrides: Partial<TranscodeJobConfig> & { playSessionId: string },
): TranscodeJobConfig {
    return {
        itemId: 'item-1',
        username: 'user-a',
        deviceId: 'device-1',
        inputUrl: 'http://localhost/stream',
        audioTracks: [],
        // No localFilePath — buildFFmpegArgs returns [] early, safe with mocked spawn
        ...overrides,
    };
}

describe('sessionKey', () => {
    it('folds every spelling of one UUID to the dashed lowercase form Postgres returns', () => {
        const dashed = '5f0c3a9e-2b7d-4c1a-8e6f-0b3d9a2c7e14';
        expect(sessionKey('5f0c3a9e2b7d4c1a8e6f0b3d9a2c7e14')).toBe(dashed);
        expect(sessionKey('5F0C3A9E2B7D4C1A8E6F0B3D9A2C7E14')).toBe(dashed);
        expect(sessionKey(dashed.toUpperCase())).toBe(dashed);
        expect(sessionKey(dashed)).toBe(dashed);
    });

    it('only lowercases an id that is not a UUID', () => {
        expect(sessionKey('Preview-abc-123')).toBe('preview-abc-123');
        expect(sessionKey(undefined)).toBe('');
    });

    // Persistable = a shape sessionKey folds to the DB form. A partly-dashed id
    // would be accepted by the uuid column but keep a key that never matches
    // the dashed value Postgres hands back.
    it('persists exactly the ids sessionKey folds to the DB form', () => {
        expect(isPersistablePlaySessionId('5f0c3a9e2b7d4c1a8e6f0b3d9a2c7e14')).toBe(true);
        expect(isPersistablePlaySessionId('5F0C3A9E-2B7D-4C1A-8E6F-0B3D9A2C7E14')).toBe(true);
        expect(isPersistablePlaySessionId('5f0c3a9e-2b7d4c1a8e6f0b3d9a2c7e14')).toBe(false);
        expect(isPersistablePlaySessionId('preview-5f0c3a9e2b7d4c1a8e6f0b3d9a2c7e14-1')).toBe(
            false,
        );
    });
});

describe('computeMaxDimensions (CPU 4K→1080p downscale policy)', () => {
    const on = {
        downscaleCpuTo1080p: true,
        defaultMaxWidth: 0,
        defaultMaxHeight: 0,
    };

    it('caps a 4K CPU transcode to 1080p when the setting is on', () => {
        const r = computeMaxDimensions({ useGpu: false, videoAction: 'transcode' }, 2160, on);
        expect(r).toEqual({
            maxWidth: 1920,
            maxHeight: 1080,
            downscaled: true,
        });
    });

    it('does NOT cap when a GPU is used', () => {
        const r = computeMaxDimensions({ useGpu: true, videoAction: 'transcode' }, 2160, on);
        expect(r).toEqual({ maxWidth: 0, maxHeight: 0, downscaled: false });
    });

    it('does NOT cap a copy/remux (no re-encode to scale)', () => {
        const r = computeMaxDimensions({ useGpu: false, videoAction: 'copy' }, 2160, on);
        expect(r.downscaled).toBe(false);
    });

    it('does NOT cap a 1080p-or-smaller source', () => {
        expect(
            computeMaxDimensions({ useGpu: false, videoAction: 'transcode' }, 1080, on).downscaled,
        ).toBe(false);
        expect(
            computeMaxDimensions({ useGpu: false, videoAction: 'transcode' }, 720, on).downscaled,
        ).toBe(false);
    });

    it('does NOT cap when the setting is off', () => {
        const r = computeMaxDimensions({ useGpu: false, videoAction: 'transcode' }, 2160, {
            downscaleCpuTo1080p: false,
            defaultMaxWidth: 0,
            defaultMaxHeight: 0,
        });
        expect(r.downscaled).toBe(false);
    });

    it('only LOWERS an existing explicit cap, never raises it', () => {
        // Admin already capped to 720p — keep their stricter limit.
        const r = computeMaxDimensions({ useGpu: false, videoAction: 'transcode' }, 2160, {
            downscaleCpuTo1080p: true,
            defaultMaxWidth: 1280,
            defaultMaxHeight: 720,
        });
        expect(r).toEqual({ maxWidth: 1280, maxHeight: 720, downscaled: true });
    });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Reused in the generation-routing tests
const candidate = (overrides: Partial<SegmentGenerationCandidate>): SegmentGenerationCandidate => ({
    jobId: overrides.jobId ?? 'job',
    generationIndex: overrides.generationIndex ?? 1,
    generationRole: overrides.generationRole ?? 'current',
    offset: overrides.offset ?? 0,
    actualIndex: overrides.actualIndex ?? 0,
    progress: overrides.progress ?? 0,
    segmentsReady: overrides.segmentsReady ?? 0,
    deleted: overrides.deleted ?? false,
    covers: overrides.covers ?? false,
    isCurrent: overrides.isCurrent ?? false,
    status: overrides.status ?? 'running',
    reclaimable: overrides.reclaimable ?? false,
    requestedSegmentNum: overrides.requestedSegmentNum ?? 0,
});

// ---------------------------------------------------------------------------
// computeSegmentsFromKeyframes
// ---------------------------------------------------------------------------

describe('computeSegmentsFromKeyframes', () => {
    it('returns empty array for empty keyframes', () => {
        expect(computeSegmentsFromKeyframes([], 100, 10)).toEqual([]);
    });

    it('returns empty array when totalDuration is zero', () => {
        expect(computeSegmentsFromKeyframes([0, 10, 20], 0, 10)).toEqual([]);
    });

    it('returns empty array when desiredSegmentLength is zero', () => {
        expect(computeSegmentsFromKeyframes([0, 10, 20], 100, 0)).toEqual([]);
    });

    it('cuts at the first keyframe at or past each target boundary', () => {
        // Keyframes at 0, 10.177, 20.02, 30.2, 40.1 — desired segment = 10s
        const keyframes = [0, 10.177, 20.02, 30.2, 40.1];
        const totalDuration = 50;
        const segments = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);

        // Segment 0: cut at 10.177 (first keyframe >= 10) → duration 10.177
        expect(segments[0]).toBeCloseTo(10.177);
        // Segment 1: cut at 20.02 (first keyframe >= 20) → duration 9.843
        expect(segments[1]).toBeCloseTo(20.02 - 10.177);
        // Segment 2: cut at 30.2 (first keyframe >= 30) → duration 10.18
        expect(segments[2]).toBeCloseTo(30.2 - 20.02);
        // Segment 3: cut at 40.1 (first keyframe >= 40) → duration 9.9
        expect(segments[3]).toBeCloseTo(40.1 - 30.2);
        // Segment 4: remainder from 40.1 to 50
        expect(segments[4]).toBeCloseTo(50 - 40.1);
        expect(segments).toHaveLength(5);
    });

    it('advances cut target on absolute grid, not relative to last cut', () => {
        // Long GOP: keyframe at 18 means the first cut is delayed past 10
        // Second cut target should still be 20, not 10 + (18-10) = 18
        const keyframes = [0, 18, 20];
        const totalDuration = 30;
        const segments = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);

        // First segment: cut at 18 (first keyframe >= 10) → 18s
        expect(segments[0]).toBeCloseTo(18);
        // Second segment: cut at 20 (first keyframe >= 20 on absolute grid) → 2s
        expect(segments[1]).toBeCloseTo(2);
        // Remainder: 30-20 = 10
        expect(segments[2]).toBeCloseTo(10);
        expect(segments).toHaveLength(3);
    });

    it('produces one segment when media is shorter than desired segment length', () => {
        const keyframes = [0, 5];
        const totalDuration = 8;
        const segments = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);

        // No keyframe reaches 10, so only the remainder segment exists
        expect(segments).toHaveLength(1);
        expect(segments[0]).toBeCloseTo(8);
    });

    it('segment durations sum to approximately totalDuration', () => {
        const keyframes = [0, 10.177, 20.02, 30.2, 40.1, 50.05];
        const totalDuration = 60;
        const segments = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);

        const total = segments.reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(totalDuration, 3);
    });

    it('handles uniform keyframes at exact boundaries', () => {
        const keyframes = [0, 10, 20, 30];
        const totalDuration = 40;
        const segments = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);

        // Each segment is exactly 10s
        expect(segments).toHaveLength(4);
        segments.forEach((d) => expect(d).toBeCloseTo(10));
    });
});

// ---------------------------------------------------------------------------
// computeSegmentsWithSeekGrid
// ---------------------------------------------------------------------------

describe('computeSegmentsWithSeekGrid', () => {
    it('returns same result as computeSegmentsFromKeyframes when seekStartTime is 0', () => {
        const keyframes = [0, 10.177, 20.02, 30.2, 40.1];
        const totalDuration = 50;
        const withSeek = computeSegmentsWithSeekGrid(keyframes, totalDuration, 10, 0);
        const without = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);
        expect(withSeek).toEqual(without);
    });

    it('returns same result as computeSegmentsFromKeyframes when seekStartTime is negative', () => {
        const keyframes = [0, 10, 20, 30];
        const totalDuration = 40;
        const withSeek = computeSegmentsWithSeekGrid(keyframes, totalDuration, 10, -5);
        const without = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);
        expect(withSeek).toEqual(without);
    });

    it('preserves pre-seek segments and recomputes post-seek', () => {
        // Keyframes: 0, 4, 8, 12, 16, 20, 24, 28, 32
        // segLen=10
        // Position-0 grid: cut at first kf >= 10 → 12, then >= 20 → 20, then >= 30 → 32
        // Segment 0: [0, 12) = 12s
        // Segment 1: [12, 20) = 8s
        // Segment 2: [20, 32) = 12s
        // Remainder: [32, 36) = 4s
        const keyframes = [0, 4, 8, 12, 16, 20, 24, 28, 32];
        const totalDuration = 36;

        const fullGrid = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);
        expect(fullGrid).toEqual([12, 8, 12, 4]);

        // Seek to segment 1 (start at position 12)
        const seekGrid = computeSegmentsWithSeekGrid(keyframes, totalDuration, 10, 12.5);
        // Segment 0 kept from full grid: 12
        // Post-seek grid from position 12: keyframes [0, 4, 8, 12, 16, 20]
        // relative to 12: [0, 4, 8, 12, 16, 20]
        // Cut at first kf >= 10 → 12 (original position 24), duration = 12
        // Cut at first kf >= 20 → 20 (original position 32), duration = 8
        // Remainder: 36-32 = 4
        expect(seekGrid[0]).toBeCloseTo(12); // preserved from full grid
        expect(seekGrid[1]).toBeCloseTo(12); // post-seek first segment
        expect(seekGrid[2]).toBeCloseTo(8); // post-seek second
        expect(seekGrid[3]).toBeCloseTo(4); // remainder
    });

    it('produces different durations than full grid after seek', () => {
        // This demonstrates the exact problem: full grid and post-seek grid
        // produce different durations for the same content
        const keyframes = [0, 4, 8, 12, 16, 20, 24, 28, 32];
        const totalDuration = 36;

        const fullGrid = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);
        const seekGrid = computeSegmentsWithSeekGrid(keyframes, totalDuration, 10, 12.5);

        // Full grid segment 1: 8s
        // Seek grid segment 1: 12s (different! this is the root cause of desync)
        expect(fullGrid[1]).not.toBeCloseTo(seekGrid[1]);
    });

    it('segment durations still sum to totalDuration', () => {
        const keyframes = [0, 10.177, 20.02, 30.2, 40.1, 50.05];
        const totalDuration = 60;
        const seekGrid = computeSegmentsWithSeekGrid(keyframes, totalDuration, 10, 20.5);

        const total = seekGrid.reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(totalDuration, 3);
    });

    it('handles seek past all segments gracefully', () => {
        const keyframes = [0, 10, 20, 30];
        const totalDuration = 40;
        const seekGrid = computeSegmentsWithSeekGrid(keyframes, totalDuration, 10, 50);
        const fullGrid = computeSegmentsFromKeyframes(keyframes, totalDuration, 10);
        // Seek past end: falls back to full grid
        expect(seekGrid).toEqual(fullGrid);
    });

    it('handles empty keyframes', () => {
        expect(computeSegmentsWithSeekGrid([], 100, 10, 50)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// getKeyframeSegmentStartTime
// ---------------------------------------------------------------------------

describe('getKeyframeSegmentStartTime', () => {
    const keyframes = [0, 10.177, 20.02, 30.2, 40.1];
    const totalDuration = 50;
    const segmentDuration = 10;

    it('returns 0 for segment index 0', () => {
        expect(getKeyframeSegmentStartTime(0, keyframes, totalDuration, segmentDuration)).toBe(0);
    });

    it('returns start of segment 1 (= first cut point)', () => {
        expect(
            getKeyframeSegmentStartTime(1, keyframes, totalDuration, segmentDuration),
        ).toBeCloseTo(10.177);
    });

    it('returns start of segment 2', () => {
        expect(
            getKeyframeSegmentStartTime(2, keyframes, totalDuration, segmentDuration),
        ).toBeCloseTo(20.02);
    });

    it('clamps to totalDuration for out-of-range index', () => {
        const result = getKeyframeSegmentStartTime(999, keyframes, totalDuration, segmentDuration);
        expect(result).toBeLessThanOrEqual(totalDuration);
    });

    it('returns 0 for empty keyframes', () => {
        expect(getKeyframeSegmentStartTime(2, [], totalDuration, segmentDuration)).toBe(0);
    });

    it('is consistent with getKeyframeSegmentIndexForTime round-trip', () => {
        const index = getKeyframeSegmentIndexForTime(25, keyframes, totalDuration, segmentDuration);
        const startTime = getKeyframeSegmentStartTime(
            index,
            keyframes,
            totalDuration,
            segmentDuration,
        );
        expect(startTime).toBeCloseTo(20.02);
    });
});

// ---------------------------------------------------------------------------
// getKeyframeSegmentIndexForTime
// ---------------------------------------------------------------------------

describe('getKeyframeSegmentIndexForTime', () => {
    const keyframes = [0, 10.177, 20.02, 30.2, 40.1];
    const totalDuration = 50;
    const segmentDuration = 10;

    it('returns 0 for time <= 0', () => {
        expect(getKeyframeSegmentIndexForTime(0, keyframes, totalDuration, segmentDuration)).toBe(
            0,
        );
    });

    it('returns 0 for empty keyframes', () => {
        expect(getKeyframeSegmentIndexForTime(25, [], totalDuration, segmentDuration)).toBe(0);
    });

    it('maps time 25s to segment 2 (starts at 20.02)', () => {
        expect(getKeyframeSegmentIndexForTime(25, keyframes, totalDuration, segmentDuration)).toBe(
            2,
        );
    });

    it('maps time at the exact start of a segment boundary to that segment', () => {
        // Time slightly past 20.02 → should still be segment 2
        expect(
            getKeyframeSegmentIndexForTime(20.1, keyframes, totalDuration, segmentDuration),
        ).toBe(2);
    });

    it('maps time just before segment 2 to segment 1', () => {
        // 19.9 < 20.02 cumulative end of segment 1 → segment 1
        expect(
            getKeyframeSegmentIndexForTime(19.9, keyframes, totalDuration, segmentDuration),
        ).toBe(1);
    });

    it('returns last valid index for time at or beyond totalDuration', () => {
        const result = getKeyframeSegmentIndexForTime(
            100,
            keyframes,
            totalDuration,
            segmentDuration,
        );
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThan(10); // sanity: finite index
    });
});

// ---------------------------------------------------------------------------
// alignToKeyframeSegmentStart
// ---------------------------------------------------------------------------

describe('alignToKeyframeSegmentStart', () => {
    const keyframes = [0, 10.177, 20.02, 30.2, 40.1];
    const totalDuration = 50;
    const segmentDuration = 10;

    it('maps time into segment 2 to segment-2 start + 0.5s offset', () => {
        // 25s is in segment 2 (starts at 20.02)
        expect(
            alignToKeyframeSegmentStart(25, keyframes, totalDuration, segmentDuration),
        ).toBeCloseTo(20.02 + 0.5);
    });

    it('does not align an exact segment boundary to the previous segment', () => {
        // 20.02 is exactly the start of segment 2, not the end of segment 1
        expect(
            alignToKeyframeSegmentStart(20.02, keyframes, totalDuration, segmentDuration),
        ).toBeCloseTo(20.02 + 0.5);
    });

    it('returns 0 for time <= 0', () => {
        expect(alignToKeyframeSegmentStart(0, keyframes, totalDuration, segmentDuration)).toBe(0);
    });

    it('returns requestedTimeSeconds unchanged for empty keyframes', () => {
        // Early guard: keyframes.length === 0 → Math.max(0, requestedTimeSeconds)
        expect(alignToKeyframeSegmentStart(30, [], totalDuration, segmentDuration)).toBe(30);
    });

    it('aligns time in segment 0 to 0.5s (segment start + offset)', () => {
        // 5s is in segment 0 (starts at 0)
        expect(
            alignToKeyframeSegmentStart(5, keyframes, totalDuration, segmentDuration),
        ).toBeCloseTo(0.5);
    });

    it('produces start times that are always within the segment bounds', () => {
        const testTimes = [1, 5, 10.5, 15, 20.5, 25, 35, 45];
        for (const t of testTimes) {
            const aligned = alignToKeyframeSegmentStart(
                t,
                keyframes,
                totalDuration,
                segmentDuration,
            );
            expect(aligned).toBeGreaterThanOrEqual(0);
            expect(aligned).toBeLessThanOrEqual(totalDuration);
        }
    });

    // Reverse-proxy e2e 2026-10-06: a finished movie (resume 420.08 s of a
    // 420.021 s file) asked for a start past the end. The loop found no segment
    // containing it and fell through to `min(requested, totalDuration)`, so the
    // copy job started AT the end — past every segment — and the session wedged.
    it('maps a time at or past the end into the LAST segment, never to the end itself', () => {
        for (const t of [50, 50.06, 999]) {
            const aligned = alignToKeyframeSegmentStart(
                t,
                keyframes,
                totalDuration,
                segmentDuration,
            );
            expect(aligned).toBeCloseTo(40.1 + 0.5);
            expect(aligned).toBeLessThan(totalDuration);
        }
    });
});

// ---------------------------------------------------------------------------
// Demux keyframe offset: backward seek must not produce an unreachable offset
// ---------------------------------------------------------------------------

describe('demux keyframe offset reachability', () => {
    // Reproduces the backward seek infinite loop: keyframe segment 156 has start
    // time ~1626s, which in uniform 10s segments is offset 162. The video
    // per-stream offset (uniform 161) makes segment 156 permanently unreachable.
    // The fix: use getKeyframeSegmentIndexForTime to compute the offset in
    // keyframe space instead of uniform space.

    // Realistic keyframe set: variable-length GOPs averaging ~10.4s over ~11700s.
    // We only need enough keyframes to produce 160+ segments.
    const totalDuration = 11707.744;
    const segmentDuration = 10;
    // Generate keyframes at slightly irregular intervals (~10.4s avg)
    const keyframes: number[] = [0];
    for (let t = 10.4; t < totalDuration; t += 10.4 + Math.sin(t) * 0.3) {
        keyframes.push(t);
    }

    it('keyframe segment index is always <= uniform segment index for the same time', () => {
        // This is the fundamental property that causes the bug: keyframe segments
        // are on average longer than uniform segments, so fewer keyframe segments
        // fit in the same time span.
        for (const targetSegment of [50, 100, 156, 200, 500]) {
            const startTime = getKeyframeSegmentStartTime(
                targetSegment,
                keyframes,
                totalDuration,
                segmentDuration,
            );
            const uniformIndex = Math.floor(startTime / segmentDuration);
            expect(targetSegment).toBeLessThanOrEqual(uniformIndex + 1);
        }
    });

    it('seeking to keyframe segment N produces an offset that makes N reachable', () => {
        for (const targetSegment of [50, 100, 156, 200, 500]) {
            const startTime = getKeyframeSegmentStartTime(
                targetSegment,
                keyframes,
                totalDuration,
                segmentDuration,
            );
            const aligned = alignToKeyframeSegmentStart(
                startTime,
                keyframes,
                totalDuration,
                segmentDuration,
            );

            // The fix: use keyframe index for the offset instead of uniform
            const kfOffset = getKeyframeSegmentIndexForTime(
                aligned,
                keyframes,
                totalDuration,
                segmentDuration,
            );
            // With preroll: offset = kfOffset - 1
            const videoPerStreamOffset = Math.max(0, kfOffset - 1);

            // The target segment must be reachable (actualIndex >= 0)
            const actualIndex = targetSegment - videoPerStreamOffset;
            expect(actualIndex).toBeGreaterThanOrEqual(0);
            // And it should map to physical file 0 or 1 (preroll or first real)
            expect(actualIndex).toBeLessThanOrEqual(2);

            // The OLD bug: uniform offset makes segment unreachable
            const uniformOffset = Math.max(0, Math.floor(aligned / segmentDuration) - 1);
            const oldActualIndex = targetSegment - uniformOffset;
            // For segments where keyframe time >> uniform time, this goes negative
            if (targetSegment >= 50) {
                expect(oldActualIndex).toBeLessThan(actualIndex);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// selectSegmentGenerationCandidate
// ---------------------------------------------------------------------------

describe('selectSegmentGenerationCandidate', () => {
    it('keeps current generation when it covers the request with the highest offset', () => {
        const selection = selectSegmentGenerationCandidate([
            candidate({
                jobId: 'current',
                generationIndex: 2,
                generationRole: 'current',
                offset: 420,
                progress: 440,
                covers: true,
                isCurrent: true,
            }),
            candidate({
                jobId: 'previous',
                generationIndex: 1,
                generationRole: 'previous',
                offset: 0,
                progress: 600,
                covers: true,
            }),
        ]);

        expect(selection?.candidate.jobId).toBe('current');
        expect(selection?.reason).toBe('current');
    });

    it('uses a retained generation for stale requests it actually covers', () => {
        const selection = selectSegmentGenerationCandidate([
            candidate({
                jobId: 'current',
                generationIndex: 2,
                generationRole: 'current',
                offset: 420,
                actualIndex: -321,
                progress: 430,
                covers: false,
                isCurrent: true,
            }),
            candidate({
                jobId: 'previous',
                generationIndex: 1,
                generationRole: 'previous',
                offset: 0,
                actualIndex: 99,
                progress: 120,
                covers: true,
            }),
        ]);

        expect(selection?.candidate.jobId).toBe('previous');
        expect(selection?.reason).toBe('retained-covered');
    });

    it('falls back to current when retained generations do not cover the request', () => {
        const selection = selectSegmentGenerationCandidate([
            candidate({
                jobId: 'current',
                generationIndex: 2,
                generationRole: 'current',
                offset: 420,
                actualIndex: -321,
                progress: 430,
                covers: false,
                isCurrent: true,
            }),
            candidate({
                jobId: 'previous',
                generationIndex: 1,
                generationRole: 'previous',
                offset: 0,
                actualIndex: 99,
                progress: 40,
                covers: false,
            }),
        ]);

        expect(selection?.candidate.jobId).toBe('current');
        expect(selection?.reason).toBe('current');
    });

    it('does not treat the progress boundary as covered', () => {
        const selection = selectSegmentGenerationCandidate([
            candidate({
                jobId: 'current',
                generationIndex: 2,
                generationRole: 'current',
                offset: 200,
                actualIndex: 0,
                progress: 200,
                covers: false,
                isCurrent: true,
            }),
            candidate({
                jobId: 'previous',
                generationIndex: 1,
                generationRole: 'previous',
                offset: 0,
                actualIndex: 200,
                progress: 200,
                covers: false,
            }),
        ]);

        expect(selection?.candidate.jobId).toBe('current');
        expect(selection?.reason).toBe('current');
    });

    it('can fall back to a retained generation when no current job exists', () => {
        const selection = selectSegmentGenerationCandidate([
            candidate({
                jobId: 'previous',
                generationIndex: 1,
                generationRole: 'previous',
                offset: 0,
                actualIndex: 99,
                progress: 40,
                covers: false,
            }),
        ]);

        expect(selection?.candidate.jobId).toBe('previous');
        expect(selection?.reason).toBe('retained-fallback-no-current');
    });

    it('returns nullish for an empty candidate list', () => {
        const selection = selectSegmentGenerationCandidate([]);
        expect(selection).toBeFalsy();
    });

    it('prefers higher-generation-index retained candidate when multiple cover the request', () => {
        // Both previous candidates cover — the one with higher generationIndex should win
        const selection = selectSegmentGenerationCandidate([
            candidate({
                jobId: 'older',
                generationIndex: 1,
                generationRole: 'previous',
                offset: 0,
                actualIndex: 50,
                progress: 100,
                covers: true,
            }),
            candidate({
                jobId: 'newer',
                generationIndex: 3,
                generationRole: 'previous',
                offset: 100,
                actualIndex: 50,
                progress: 200,
                covers: true,
            }),
        ]);

        // Both cover but newer has higher offset — expect the function to pick one
        // (behavior: whichever wins, both are valid retained-covered; verify reason)
        expect(selection?.reason).toBe('retained-covered');
    });
});

// ---------------------------------------------------------------------------
// handleExit — single-writer can_restore race (graceful shutdown)
// ---------------------------------------------------------------------------
//
// retireJobGeneration()'s persistForRestart branch is the authoritative
// writer of can_restore for an INTENTIONAL stop (stopJob persistForRestart=true
// -> can_restore=true, so the session can resume). But the generic "persist
// final status" block inside handleExit (the ffmpeg onExit callback) used to
// fire an unawaited updateStatus(..., can_restore=false) unconditionally
// whenever this job was still the "current" job for the play session — which
// races the authoritative write because the real process 'exit' event (which
// invokes handleExit) fires synchronously WHILE retireJobGeneration is still
// inside its `await this.processRunner.killFFmpeg(job)` call, i.e. BEFORE the
// current-job mapping is cleared. Whichever DB write lands last wins, so a
// gracefully-stopped session could end up permanently non-restorable.
describe('handleExit — single-writer can_restore race (graceful shutdown)', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        capturedCallbacks.clear();

        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.updateStatus.mockClear();
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );

        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('does NOT persist can_restore=false for an INTENTIONAL stop (single-writer skip)', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'race-a' }));

        const callbacks = capturedCallbacks.get(job.id);
        expect(callbacks).toBeDefined();

        // Simulate stopJob()/retireJobGeneration() having flagged the job for
        // an intentional teardown (status='stopping') BEFORE the ffmpeg
        // process's real 'exit' event races in — at that point in the real
        // flow, retireJobGeneration is still awaiting killFFmpeg() and has
        // NOT yet cleared jobsByPlaySession, so the job is still "current".
        job.status = 'stopping';
        callbacks!.onExit(255, null, '', false);

        // retireJobGeneration's persistForRestart branch is the single writer
        // for an intentional stop's can_restore flag — the generic handleExit
        // persistence must stay out of its way and never write can_restore=false.
        expect(mockPersistence.updateStatus).not.toHaveBeenCalledWith(
            'race-a',
            'stopped',
            undefined,
            false,
            expect.anything(),
        );
    });

    it.each([1, 255])('treats exit %s during web drain as stopped and restorable', async (code) => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'drain-exit' }));
        const shutdown = await import('$lib/server/lifecycle/web-shutdown.js');
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        try {
            job.killRequested = true;
            Object.assign(job, { shutdownKillRequested: true });
            const handled = capturedCallbacks.get(job.id)!.onExit(code, null, 'shutdown', false);
            expect(handled).toBe(true);
            expect(job.status).toBe('stopped');
            expect(job.reachedEndOfInput).not.toBe(true);
            expect(job.error).toBeUndefined();
            expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
            expect(mockPersistence.updateStatus).not.toHaveBeenCalled();
        } finally {
            draining.mockRestore();
        }
    });

    it('finishes normally with all segments ready when exit 0 occurs during draining', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'drain-success', totalDurationSeconds: 60 }),
        );
        const shutdown = await import('$lib/server/lifecycle/web-shutdown.js');
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        try {
            capturedCallbacks.get(job.id)!.onExit(0, null, '', false);
            expect(job.status).toBe('ready');
            expect(job.reachedEndOfInput).toBe(true);
            expect(job.segmentsReady).toBeGreaterThan(0);
            expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
                'drain-success',
                'ready',
                undefined,
                true,
                process.env.HOSTNAME || 'unknown',
            );
        } finally {
            draining.mockRestore();
        }
    });

    it('keeps a genuine non-zero exit an error during draining if no kill was issued', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'drain-crash' }));
        const shutdown = await import('$lib/server/lifecycle/web-shutdown.js');
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        try {
            capturedCallbacks.get(job.id)!.onExit(1, null, 'real failure', false);
            expect(job.status).toBe('error');
            expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
                'drain-crash',
                'error',
                expect.any(String),
                false,
                process.env.HOSTNAME || 'unknown',
            );
        } finally {
            draining.mockRestore();
        }
    });

    it('still persists can_restore=false for a genuine (non-intentional) crash', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'race-b' }));

        const callbacks = capturedCallbacks.get(job.id);
        expect(callbacks).toBeDefined();

        // No stop was requested — the job is still in its normal (non-'stopping')
        // state when FFmpeg dies unexpectedly.
        callbacks!.onExit(1, null, 'boom', false);

        // D-HLS-1 follow-up: this own-job write now also passes
        // getCurrentPodName()'s value as the pod-guard argument.
        expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
            'race-b',
            'error',
            expect.any(String),
            false,
            process.env.HOSTNAME || 'unknown',
        );
    });
});

// handleExit — reachedEndOfInput (HLS tail past-end evidence)
//
// The segment handler 404s the last playlist entry only when FFmpeg's closed
// manifest ended one short AND this flag says the generation read its input to
// the end. A stop we caused also closes the manifest (SIGTERM flushes and
// writes ENDLIST), so the flag must stay false for those, or the real last
// segment of an interrupted generation would be refused instead of produced.
describe('handleExit — reachedEndOfInput', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('is unset while FFmpeg runs', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'eoi-a' }));
        expect(job.reachedEndOfInput).toBeUndefined();
    });

    it('is set by an exit 0 nobody asked for (FFmpeg hit the end of its input)', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'eoi-b' }));
        capturedCallbacks.get(job.id)!.onExit(0, null, '', false);
        expect(job.reachedEndOfInput).toBe(true);
    });

    it('stays false when the exit 0 follows a stop we requested', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'eoi-c' }));
        job.killRequested = true;
        capturedCallbacks.get(job.id)!.onExit(0, null, '', false);
        expect(job.reachedEndOfInput).not.toBe(true);
    });

    it('stays unset on a SIGTERM exit (255), which still closes the manifest', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'eoi-d' }));
        job.killRequested = true;
        capturedCallbacks
            .get(job.id)!
            .onExit(255, null, 'Exiting normally, received signal 15.', true);
        expect(job.reachedEndOfInput).not.toBe(true);
    });
});

describe('buildFFmpegArgs — hdrTonemapMode wiring', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        mockBuildArgs.mockReset();
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('records the resolved tonemap mode on the job decision after building args', async () => {
        mockBuildArgs.mockReturnValue({
            args: ['-vf', 'tonemapx=tonemap=hable:p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p'],
            description: 'software tonemap test',
        });
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'tonemap-wiring-software',
                localFilePath: '/media/test.mkv',
                // decide() (the heuristic transcodeDecision fallback used outside
                // the PlaybackPlan path) is only consulted when mediaSourceInfo is
                // present — without it, transcodeDecisionResult stays undefined and
                // buildFFmpegArgs's `if (decision)` guard never fires.
                mediaSourceInfo: {
                    streams: [],
                } as unknown as TranscodeJobConfig['mediaSourceInfo'],
            }),
        );

        expect(job.transcodeDecisionResult?.hdrTonemapMode).toBe('software');
    });

    it('reports n/a when the built args have no tonemap filter', async () => {
        mockBuildArgs.mockReturnValue({
            args: ['-c:v', 'libx264'],
            description: 'no tonemap',
        });
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'tonemap-wiring-none',
                localFilePath: '/media/test2.mkv',
                mediaSourceInfo: {
                    streams: [],
                } as unknown as TranscodeJobConfig['mediaSourceInfo'],
            }),
        );

        expect(job.transcodeDecisionResult?.hdrTonemapMode).toBe('n/a');
    });

    it('surfaces hdrTonemapMode through getPlayerTranscodeProgress (same-pod path)', async () => {
        mockBuildArgs.mockReturnValue({
            args: ['-vf', 'tonemapx=tonemap=hable:p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p'],
            description: 'software tonemap test',
        });
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'tonemap-progress-same-pod',
                localFilePath: '/media/test3.mkv',
                // Same reasoning as the tests above: mediaSourceInfo must be present
                // for decide() to run and populate transcodeDecisionResult.
                mediaSourceInfo: {
                    streams: [],
                } as unknown as TranscodeJobConfig['mediaSourceInfo'],
            }),
        );

        // getPlayerTranscodeProgress() is the same-pod, in-memory progress read the
        // player heartbeat hits on the (more common) pod that owns the job — it must
        // not silently drop hdrTonemapMode on a future refactor.
        const progress = svc.getPlayerTranscodeProgress(job.config.playSessionId);

        expect(progress?.hdrTonemapMode).toBe('software');
    });
});

describe('getActiveJobsInfo — hdrTonemapMode (in-memory rebuild path)', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        mockBuildArgs.mockReset();
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('surfaces hdrTonemapMode on the in-memory job rebuild used by getActiveJobsInfo', async () => {
        mockBuildArgs.mockReturnValue({
            args: ['-vf', 'tonemapx=tonemap=hable:p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p'],
            description: 'software tonemap test',
        });
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'tonemap-active-jobs-info',
                localFilePath: '/media/test4.mkv',
                mediaSourceInfo: {
                    streams: [],
                } as unknown as TranscodeJobConfig['mediaSourceInfo'],
            }),
        );

        // getActiveJobsInfo() reads directly from the service's in-memory job map
        // (this.jobs) rather than the DB — a started job stays there until cleaned
        // up, so this exercises the real transcodeDecision-construction mapping.
        const jobsInfo = await svc.getActiveJobsInfo();
        const found = jobsInfo.find((j) => j.playSessionId === job.config.playSessionId);

        expect(found?.transcodeDecision?.hdrTonemapMode).toBe('software');
    });
});

// ============================================================================
// persistJobProgress — DB flush so the cross-pod fallback isn't stuck at 0%
// ============================================================================
//
// Regression guard for the "TRANSCODE PROGRESS: 0% (0/460), Elapsed climbing"
// overlay-while-playback-works bug. The live segment counter lives only in
// job.segmentsReady (in-memory); the DB column active_transcode_jobs.segments_ready
// is written once at creation (0) and never advanced by the upsert. When a
// heartbeat's transcode-progress read is served by a pod that doesn't hold the
// in-memory job, getAllActiveJobsInfoMultiPod falls back to the DB row and
// reports 0 forever. The 10s stats loop must flush the in-memory counter to the
// DB so that fallback is accurate.
describe('persistJobProgress — DB flush for cross-pod fallback', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        capturedCallbacks.clear();

        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.updateProgress.mockClear();
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );

        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('flushes the live in-memory segment counter to the DB for a current job', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'flush-a' }));

        // Simulate FFmpeg having produced 20 segments (advanced in-memory by the
        // process runner) while the DB row still holds its creation-time 0.
        job.segmentsReady = 20;
        job.masterPlaylistReady = true;
        job.status = 'running';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).persistJobProgress();

        // Pod-guarded own-job write: this process's pod name rides along.
        expect(mockPersistence.updateProgress).toHaveBeenCalledWith(
            'flush-a',
            20,
            true,
            process.env.HOSTNAME || 'unknown',
        );
    });

    it('does NOT flush progress for a retired (non-current) generation', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeHandleExitTestConfig({ playSessionId: 'flush-b' }));

        job.segmentsReady = 15;
        // A superseded seek generation must not clobber the current row's counter.
        job.generationRole = 'previous';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).persistJobProgress();

        // Match on the session id alone: an arity-bound matcher would stop
        // matching (and pass vacuously) whenever the call gains an argument.
        expect(mockPersistence.updateProgress.mock.calls.some((c) => c[0] === 'flush-b')).toBe(
            false,
        );
    });
});

// ============================================================================
// handleExit — GPU decode learn-on-failure gating
//
// The core bug this guards: a busy small-VRAM GPU (Arc A380) emits the same
// terminal "Could not open encoder" as a real decode gap, and the old code
// learned it permanently after two failures — mislabelling a decodable codec
// (av1 10-bit, h264) as software-only. The learn gate is now split: a BROAD
// retry signature still triggers the transparent retry, but only a STRICT
// decode-capability signature (isLearnableGpuDecodeFailure) writes the deny-map;
// anything else bridges the single job without learning.
// ============================================================================
describe('handleExit — GPU decode learn-on-failure gating', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let hw: typeof import('./transcoding/hardware-detection.js');
    let idx: typeof import('./transcoding/index.js');

    // Genuine per-codec decode gap: the definitive surface-mismatch line, no
    // transient resource/session token.
    const GENUINE_DECODE_GAP = [
        "Impossible to convert between the formats supported by the filter 'graph 0 input' and the filter 'auto_scale_0'",
        'Error reinitializing filters!',
        '[hevc_qsv @ 0x1] Could not open encoder before EOF',
    ].join('\n');

    // Busy GPU: terminal "Could not open encoder" (matches the broad retry
    // signature) but a resource token and NO surface-mismatch line → not learnable.
    const TRANSIENT_BUSY_GPU = [
        '[hevc_qsv @ 0x1] Cannot allocate memory',
        '[hevc_qsv @ 0x1] Could not open encoder before EOF',
    ].join('\n');

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        capturedCallbacks.clear();

        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );

        hw = await import('./transcoding/hardware-detection.js');
        idx = await import('./transcoding/index.js');
        // A bridgeable QSV backend that currently believes it CAN decode the codec.
        vi.mocked(idx.getHwAccelFromEncoder).mockReturnValue('qsv');
        vi.mocked(hw.hardwareDetection.canSoftwareDecodeBridge).mockReturnValue(true);
        vi.mocked(hw.hardwareDetection.isSourceHardwareDecodable).mockReturnValue(true);
        vi.mocked(hw.hardwareDetection.markSourceNotHardwareDecodable).mockClear();

        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        // Restore the module-level defaults so later suites are unaffected.
        vi.mocked(idx.getHwAccelFromEncoder).mockReturnValue('none');
        vi.mocked(hw.hardwareDetection.canSoftwareDecodeBridge).mockReturnValue(false);
        vi.mocked(hw.hardwareDetection.isSourceHardwareDecodable).mockReturnValue(false);
        vi.clearAllMocks();
    });

    async function startGpuJob(
        playSessionId: string,
        overrides: Partial<TranscodeJobConfig> = {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> {
        const svc = svcModule.getFFmpegTranscodeService();
        // Give the mocked strategy a non-empty argv — the default `{ args: [] }`
        // return is fine for tests that only inspect call args, but the failure
        // recorder tests assert the actual argv reaches the stored event (an
        // empty array can't distinguish "recorded" from "recorded nothing").
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const strategyInstance = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
        strategyInstance.buildArgs.mockReturnValue({
            args: ['-i', overrides.localFilePath ?? 'input.mkv', 'output.m3u8'],
        });
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId,
                videoInfo: { codec: 'av1', bitDepth: 10, width: 1920, height: 1080 },
                ...overrides,
            }),
        );
        // The mocked decision engine doesn't pick a GPU encoder; wire one so the
        // learn branch's backend derivation runs.
        job.transcodeDecisionResult = {
            mode: 'full',
            reasons: 0, // TranscodeReason.None
            videoAction: 'transcode',
            audioAction: 'copy',
            useGpu: true,
            gpuEncoder: 'hevc_qsv',
            needsTonemapping: false,
            preserveHdr10: false,
        };
        job.process = null;
        return job;
    }

    it('does not enter GPU crash recovery for an exit during shutdown', async () => {
        const job = await startGpuJob('gpu-drain');
        job.killRequested = true;
        Object.assign(job, { shutdownKillRequested: true });
        const shutdown = await import('$lib/server/lifecycle/web-shutdown.js');
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        try {
            capturedCallbacks.get(job.id)!.onExit(255, null, GENUINE_DECODE_GAP, false);
            await vi.advanceTimersByTimeAsync(2000);
            expect(job.status).toBe('stopped');
            expect(job.hwDecodeRetried).not.toBe(true);
            expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
            expect(hw.hardwareDetection.markSourceNotHardwareDecodable).not.toHaveBeenCalled();
        } finally {
            draining.mockRestore();
        }
    });

    it('does not spawn a pending GPU retry after shutdown begins', async () => {
        const job = await startGpuJob('gpu-pending-drain');
        capturedCallbacks.get(job.id)!.onExit(1, null, GENUINE_DECODE_GAP, false);
        expect(job.hwDecodeRetried).toBe(true);
        const shutdown = await import('$lib/server/lifecycle/web-shutdown.js');
        const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(true);
        try {
            await vi.advanceTimersByTimeAsync(2000);
            expect(job.status).toBe('stopped');
            expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
        } finally {
            draining.mockRestore();
        }
    });

    it('first failure delays the identical-args retry (backoff) and does not learn', async () => {
        const job = await startGpuJob('gpu-a');
        const callbacks = capturedCallbacks.get(job.id)!;
        const spawnsAfterStart = mockProcessRunner.spawnFFmpeg.mock.calls.length;

        callbacks.onExit(1, null, GENUINE_DECODE_GAP, false);

        // No learn yet, and the retry has NOT fired synchronously (it's scheduled).
        expect(hw.hardwareDetection.markSourceNotHardwareDecodable).not.toHaveBeenCalled();
        expect(mockProcessRunner.spawnFFmpeg.mock.calls.length).toBe(spawnsAfterStart);
        expect(job.hwDecodeRetried).toBe(true);

        // After the backoff window the retry re-spawns with unchanged args.
        vi.advanceTimersByTime(2000);
        expect(mockProcessRunner.spawnFFmpeg.mock.calls.length).toBe(spawnsAfterStart + 1);
        expect(job.config.forceSoftwareDecodeBridge).toBeUndefined();
    });

    it('second failure with a genuine decode-capability signature LEARNS the codec', async () => {
        const job = await startGpuJob('gpu-b');
        const callbacks = capturedCallbacks.get(job.id)!;

        callbacks.onExit(1, null, GENUINE_DECODE_GAP, false); // first → retry scheduled
        vi.advanceTimersByTime(2000);
        callbacks.onExit(1, null, GENUINE_DECODE_GAP, false); // second → learn

        expect(hw.hardwareDetection.markSourceNotHardwareDecodable).toHaveBeenCalledWith(
            'qsv',
            'av1',
            { bitDepth: 10, sample: undefined },
        );
        expect(job.gpuBridgeRetried).toBe(true);
    });

    it('second failure WITHOUT a decode signature (busy GPU) bridges the job but does NOT learn', async () => {
        const job = await startGpuJob('gpu-c');
        const callbacks = capturedCallbacks.get(job.id)!;

        callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false); // first → retry scheduled
        vi.advanceTimersByTime(2000);
        callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false); // second → bridge, no learn

        expect(hw.hardwareDetection.markSourceNotHardwareDecodable).not.toHaveBeenCalled();
        // The single job is rescued via the per-job bridge flag, deny-map untouched.
        expect(job.config.forceSoftwareDecodeBridge).toBe(true);
        expect(job.gpuBridgeRetried).toBe(true);
    });

    // Setting the flag on job.config is only half the rescue — buildFFmpegArgs
    // assembles its FullStrategyConfig field-by-field, so a flag it doesn't copy never
    // reaches the builder and the respawn re-runs the IDENTICAL failing args. That made
    // the whole "bridge this session only" branch a silent no-op: three attempts, same
    // command, same error, and the user got the failure banner the branch exists to
    // prevent. Asserting job.config alone (as the sibling tests do) cannot catch that —
    // this one follows the flag through to the config the builder is actually called with.
    it('propagates the bridge flag into the strategy config the builder is called with', async () => {
        // Needs args to actually be built; the shared fixture omits localFilePath.
        const job = await startGpuJob('gpu-d', { localFilePath: '/media/movie.mkv' });
        const callbacks = capturedCallbacks.get(job.id)!;

        callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false);
        vi.advanceTimersByTime(2000);
        callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false); // → bridge this job
        await vi.advanceTimersByTimeAsync(0);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const strategy = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
        const buildCalls = strategy.buildArgs.mock.calls;
        expect(buildCalls.length).toBeGreaterThan(0);
        expect(buildCalls[buildCalls.length - 1][0].forceSoftwareDecodeBridge).toBe(true);
    });

    it('increments spawnAttempt and clears stale speed and throttle state on respawn', async () => {
        const job = await startGpuJob('gpu-attempt', { localFilePath: '/media/movie.mkv' });
        const callbacks = capturedCallbacks.get(job.id)!;

        expect(job.spawnAttempt).toBe(1);

        // A speed reading from attempt 1 must not survive into attempt 2: an attempt
        // that dies before encoding a frame would otherwise report "1.2x — keeping up".
        job.transcodeSpeed = 1.2;
        // Teardown can clear the old SIGSTOP timestamp before respawn.
        job.throttlePaused = true;
        job.throttledAt = undefined;

        callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false);
        vi.advanceTimersByTime(2000);
        await vi.advanceTimersByTimeAsync(0);

        expect(job.spawnAttempt).toBe(2);
        expect(job.transcodeSpeed).toBeUndefined();
        expect(job.throttlePaused).toBe(false);
    });

    describe('NVENC encoder session failure → software encode for this job', () => {
        // Sunshine/OBS/instant replay hold the encoder, or the driver's
        // session cap is reached (measured on an RTX 3090, 2026-10-14).
        const NVENC_NO_SESSION = [
            '[hevc_nvenc @ 0x55d] OpenEncodeSessionEx failed: out of memory (10): (no details)',
            '[hevc_nvenc @ 0x55d] No capable devices found',
            '[vost#0:0/hevc_nvenc @ 0x55e] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
        ].join('\n');

        async function startNvencJob(playSessionId: string): Promise<TranscodeJob> {
            const job = await startGpuJob(playSessionId, { localFilePath: '/media/movie.mkv' });
            job.transcodeDecisionResult = {
                ...job.transcodeDecisionResult,
                gpuEncoder: 'hevc_nvenc',
                gpuDecoder: 'hevc_cuvid',
                // As the decision engine fills it: the GPU encoder's name.
                targetCodec: { video: 'hevc_nvenc', audio: 'aac' },
            };
            return job;
        }

        it('respawns at once with a software decision and no hardware acceleration', async () => {
            const job = await startNvencJob('nvenc-a');
            const callbacks = capturedCallbacks.get(job.id)!;
            expect(job.spawnAttempt).toBe(1);

            // The replacement's spawn promise tells the runner it owns the job.
            expect(callbacks.onExit(1, null, NVENC_NO_SESSION, false)).toBeInstanceOf(Promise);
            await vi.advanceTimersByTimeAsync(0);

            // Respawned at once — no backoff timer like the decode-bridge retry.
            expect(job.spawnAttempt).toBe(2);
            expect(job.status).not.toBe('error');
            expect(job.config.softwareEncodeFallback).toBe('hevc_nvenc');
            expect(job.transcodeDecisionResult).toMatchObject({
                useGpu: false,
                gpuEncoder: undefined,
                gpuDecoder: undefined,
                videoAction: 'transcode',
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const strategy = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
            const lastBuild = strategy.buildArgs.mock.calls.at(-1)[0];
            expect(lastBuild.gpuAcceleration).toBe('none');
            expect(lastBuild.decision.useGpu).toBe(false);
            expect(lastBuild.decision.targetCodec.video).toBe('libx265');
            // No GPU-ladder state touched: this is not a decode problem.
            expect(job.hwDecodeRetried).toBeUndefined();
            expect(hw.hardwareDetection.markSourceNotHardwareDecodable).not.toHaveBeenCalled();
        });

        it('publishes the software plan at fallback before any replacement argv build', async () => {
            const job = await startNvencJob('nvenc-plan-before-build');
            const { resolveEffectiveVideo } =
                await import('./transcoding/effective-transcode-plan.js');
            Object.assign(
                job.config.effectivePlan!,
                resolveEffectiveVideo({
                    decision: job.transcodeDecisionResult,
                    videoInfo: job.config.videoInfo,
                    gpuAcceleration: 'nvenc',
                    tonemappingAlgorithm: 'hable',
                }),
            );
            expect(job.config.effectivePlan?.video).toMatchObject({
                encoder: 'hevc_nvenc',
                isGpu: true,
            });
            const svc = svcModule.getFFmpegTranscodeService() as unknown as {
                respawnFFmpeg(job: TranscodeJob): Promise<void>;
            };
            const respawn = vi.spyOn(svc, 'respawnFFmpeg').mockImplementation(async () => {
                expect(job.config.effectivePlan?.video).toMatchObject({
                    action: 'transcode',
                    encoder: 'libx265',
                    isGpu: false,
                });
                expect(job.config.effectivePlan?.decision?.useGpu).toBe(false);
            });
            try {
                const saved = structuredClone(job.config.effectivePlan!);
                await capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
                expect(respawn).toHaveBeenCalledTimes(1);
                expect(job.config.effectivePlan?.caps).toEqual(saved.caps);
                expect(job.config.effectivePlan?.startNumber).toBe(saved.startNumber);
            } finally {
                respawn.mockRestore();
            }
        });

        it('tells the player the job switched to software', async () => {
            const job = await startNvencJob('nvenc-b');
            capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
            await vi.advanceTimersByTimeAsync(0);

            const progress = svcModule
                .getFFmpegTranscodeService()
                .getPlayerTranscodeProgress('nvenc-b');
            expect(progress?.softwareFallbackFrom).toBe('hevc_nvenc');
            expect(progress?.isHardwareAccelerated).toBe(false);
            expect(progress?.slowReason).toBeUndefined();
        });

        it('answers the startup encoder-notice poll for the owner only', async () => {
            const job = await startNvencJob('nvenc-owner');
            capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
            await vi.advanceTimersByTimeAsync(0);
            const svc = svcModule.getFFmpegTranscodeService();

            await expect(svc.getEncoderNotice('nvenc-owner', 'user-a')).resolves.toEqual({
                slowReason: undefined,
                softwareFallbackFrom: 'hevc_nvenc',
            });
            // Another user, even one holding the id, learns nothing.
            await expect(svc.getEncoderNotice('nvenc-owner', 'user-b')).resolves.toBeUndefined();
            // Exact compare, like the HLS master route.
            await expect(svc.getEncoderNotice('nvenc-owner', 'USER-A')).resolves.toBeUndefined();
        });

        it('persists the switch so another pod or a restart does not retry NVENC', async () => {
            const job = await startNvencJob('nvenc-persist');
            mockPersistence.saveJob.mockClear();
            capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
            await vi.advanceTimersByTimeAsync(0);
            expect(mockPersistence.saveJob).toHaveBeenCalledWith(job);
            expect(job.config.softwareEncodeFallback).toBe('hevc_nvenc');
        });

        it('keeps the output size of the GPU run (no CPU 1080p downscale mid-session)', async () => {
            mockCfg.TRANSCODE_DOWNSCALE_CPU_TO_1080P = true;
            try {
                const job = await startGpuJob('nvenc-size', {
                    localFilePath: '/media/movie.mkv',
                    videoInfo: { codec: 'hevc', bitDepth: 10, width: 3840, height: 2160 },
                });
                job.transcodeDecisionResult = {
                    ...job.transcodeDecisionResult,
                    gpuEncoder: 'hevc_nvenc',
                };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const strategy = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (svcModule.getFFmpegTranscodeService() as any).buildFFmpegArgs(job);
                const gpuBuild = strategy.buildArgs.mock.calls.at(-1)[0];

                capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
                await vi.advanceTimersByTimeAsync(0);
                const softwareBuild = strategy.buildArgs.mock.calls.at(-1)[0];
                expect(softwareBuild.decision.useGpu).toBe(false);
                expect(softwareBuild.maxHeight).toBe(gpuBuild.maxHeight);
                expect(softwareBuild.maxWidth).toBe(gpuBuild.maxWidth);
                expect(softwareBuild.vaapiDevice).toBeUndefined();
                // 4K source: the fastest preset (veryfast cannot reach real time).
                expect(softwareBuild.encodingPreset).toBe('ultrafast');
            } finally {
                mockCfg.TRANSCODE_DOWNSCALE_CPU_TO_1080P = false;
            }
        });

        it.each([
            ['an in-place seek', 1],
            ['a second seek generation', 2],
        ])(
            'does not switch encoders after %s (one EXT-X-MAP, GPU init segment)',
            async (_, seeks) => {
                const job = await startNvencJob(`nvenc-seek-${seeks}`);
                job.seekCount = seeks;
                capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
                expect(job.config.softwareEncodeFallback).toBeUndefined();
            },
        );

        it('a restored job that had fallen back rebuilds in software (row keeps the GPU decision)', async () => {
            const job = await startNvencJob('nvenc-restore');
            // As restoreJob builds it: config from the row (with the flag), the
            // row's transcode_decision still the GPU one.
            job.config.softwareEncodeFallback = 'hevc_nvenc';
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (svcModule.getFFmpegTranscodeService() as any).buildFFmpegArgs(job);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const strategy = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
            const build = strategy.buildArgs.mock.calls.at(-1)[0];
            expect(build.decision.useGpu).toBe(false);
            expect(build.decision.gpuEncoder).toBeUndefined();
            expect(build.decision.targetCodec.video).toBe('libx265');
            expect(build.gpuAcceleration).toBe('none');
            expect(job.transcodeDecisionResult?.useGpu).toBe(false);
        });

        it("a notice poll does not count as access, least of all a non-owner's", async () => {
            const job = await startNvencJob('nvenc-access');
            const before = new Date(0);
            job.lastAccessedAt = before;
            mockPersistence.updateLastAccessed.mockClear();
            const svc = svcModule.getFFmpegTranscodeService();
            await svc.getEncoderNotice('nvenc-access', 'user-b');
            await svc.getEncoderNotice('nvenc-access', 'user-a');
            expect(job.lastAccessedAt).toBe(before);
            expect(mockPersistence.updateLastAccessed).not.toHaveBeenCalled();
        });

        it('does not switch encoders for a restored job (its earlier run may have served NVENC output)', async () => {
            const job = await startNvencJob('nvenc-restored');
            job.restoredFromPersistence = true;
            capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
            expect(job.config.softwareEncodeFallback).toBeUndefined();
            expect(job.transcodeDecisionResult?.gpuEncoder).toBe('hevc_nvenc');
        });

        it('hands the fallback to the strategy so the software encoder keeps the advertised profile', async () => {
            const job = await startNvencJob('nvenc-profile');
            capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
            await vi.advanceTimersByTimeAsync(0);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const strategy = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
            expect(strategy.buildArgs.mock.calls.at(-1)[0].softwareEncodeFallback).toBe(
                'hevc_nvenc',
            );
        });

        it('does not switch encoders behind output this process already produced', async () => {
            const job = await startNvencJob('nvenc-midstream');
            job.segmentsReady = 3;
            capturedCallbacks.get(job.id)!.onExit(1, null, NVENC_NO_SESSION, false);
            expect(job.config.softwareEncodeFallback).toBeUndefined();
        });

        it('answers the notice poll for a job on another pod via its row owner', async () => {
            const { readJobStats } = await import('./transcoding/ffmpeg-stats-cache.js');
            const row = {
                job_id: 'remote-job',
                status: 'running',
                segment_offset: 0,
                segments_ready: 4,
                created_at: new Date(),
                config: {
                    username: 'user-a',
                    totalDurationSeconds: 600,
                    segmentDurationSeconds: 6,
                },
                transcode_decision: {
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: true,
                    gpuEncoder: 'hevc_nvenc',
                    needsTonemapping: false,
                },
            };
            // Without the owner's stats, the row's config alone says it fell back.
            mockPersistence.getJob.mockResolvedValue({
                ...row,
                config: { ...row.config, softwareEncodeFallback: 'hevc_nvenc' },
            });
            const viaConfig = await svcModule
                .getFFmpegTranscodeService()
                .getPlayerTranscodeProgressMultiPod('5b1f0c1e-0000-4000-8000-00000000abcd');
            expect(viaConfig?.isHardwareAccelerated).toBe(false);
            expect(viaConfig?.softwareFallbackFrom).toBe('hevc_nvenc');

            mockPersistence.getJob.mockResolvedValue(row);
            vi.mocked(readJobStats).mockResolvedValue({
                slowReason: 'cpu_slow',
                softwareFallbackFrom: 'hevc_nvenc',
                timestamp: Date.now(),
            });
            try {
                const svc = svcModule.getFFmpegTranscodeService();
                const remote = '5b1f0c1e-0000-4000-8000-00000000abcd';
                await expect(svc.getEncoderNotice(remote, 'user-a')).resolves.toEqual({
                    slowReason: 'cpu_slow',
                    softwareFallbackFrom: 'hevc_nvenc',
                });
                await expect(svc.getEncoderNotice(remote, 'user-b')).resolves.toBeUndefined();
                await expect(svc.getEncoderNotice(remote, 'USER-A')).resolves.toBeUndefined();
                // The row still says NVENC; the owner's stats correct it.
                const progress = await svc.getPlayerTranscodeProgressMultiPod(remote);
                expect(progress?.isHardwareAccelerated).toBe(false);
                expect(progress?.gpuEncoder).toBeUndefined();
                expect(progress?.softwareFallbackFrom).toBe('hevc_nvenc');
            } finally {
                mockPersistence.getJob.mockResolvedValue(null);
                vi.mocked(readJobStats).mockResolvedValue(null);
            }
        });

        it('falls back only once: a software run that fails again is a real failure', async () => {
            const job = await startNvencJob('nvenc-c');
            const callbacks = capturedCallbacks.get(job.id)!;
            callbacks.onExit(1, null, NVENC_NO_SESSION, false);
            await vi.advanceTimersByTimeAsync(0);

            const attemptsBefore = job.spawnAttempt;
            const recovered = callbacks.onExit(1, null, NVENC_NO_SESSION, false);
            await vi.advanceTimersByTimeAsync(2000);
            expect(recovered).toBeUndefined();
            expect(job.spawnAttempt).toBe(attemptsBefore);
            expect(job.status).toBe('error');
        });

        it('leaves a QSV session failure to the decode-bridge ladder', async () => {
            const job = await startGpuJob('nvenc-d');
            capturedCallbacks
                .get(job.id)!
                .onExit(1, null, 'OpenEncodeSessionEx failed: out of memory (10)', false);
            expect(job.config.softwareEncodeFallback).toBeUndefined();
        });
    });

    describe('transcode failure capture', () => {
        beforeEach(() => mockFailureEvents.recordTranscodeFailureEvent.mockClear());

        it('records the ladder outcome AND the actual argv, not just the call', async () => {
            const job = await startGpuJob('cap-1', { localFilePath: '/media/movie.mkv' });
            const callbacks = capturedCallbacks.get(job.id)!;

            callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false);
            await vi.advanceTimersByTimeAsync(0);

            const [, event] = mockFailureEvents.recordTranscodeFailureEvent.mock.calls[0];
            expect(event.outcome).toBe('retried');
            expect(event.attempt).toBe(1);
            // Asserting the ROW CONTENT, not merely that the recorder ran. The
            // forceSoftwareDecodeBridge rescue was dead for months because its tests
            // asserted a flag was SET and never that it REACHED ffmpeg.
            expect(Array.isArray(event.argv)).toBe(true);
            expect(event.argv.length).toBeGreaterThan(0);
        });

        // spawnFFmpeg's synchronous prefix (before its first await) increments
        // job.spawnAttempt and clears job.transcodeSpeed the INSTANT it's called —
        // `void this.spawnFFmpeg(job)` still runs that prefix immediately. The
        // 'learned' and 'bridged' branches respawn before recording, so a recorder
        // that reads job.spawnAttempt/job.transcodeSpeed AFTER that call captures
        // the NEXT attempt's number and a nulled speed, not the FAILING attempt's —
        // the retried branch (covered above) can't catch this because its respawn
        // is deferred via setTimeout, not fired synchronously before recording.
        it('records the FAILING attempt number and speed for a learned recovery, not the respawned attempt', async () => {
            const job = await startGpuJob('cap-learned-attempt', {
                localFilePath: '/media/movie.mkv',
            });
            const callbacks = capturedCallbacks.get(job.id)!;

            callbacks.onExit(1, null, GENUINE_DECODE_GAP, false); // first → retry scheduled
            vi.advanceTimersByTime(2000); // retry respawns → spawnAttempt becomes 2
            await vi.advanceTimersByTimeAsync(0);
            expect(job.spawnAttempt).toBe(2);
            // Simulate attempt 2 having made progress before it died.
            job.transcodeSpeed = 0.8;

            callbacks.onExit(1, null, GENUINE_DECODE_GAP, false); // second → learn
            await vi.advanceTimersByTimeAsync(0);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const calls = mockFailureEvents.recordTranscodeFailureEvent.mock.calls as any[];
            const learnedCall = calls.find((call) => call[1]?.outcome === 'learned');
            expect(learnedCall).toBeDefined();
            const event = learnedCall[1];
            expect(event.attempt).toBe(2);
            expect(event.transcodeSpeed).toBe(0.8);
        });

        it('records the FAILING attempt number and speed for a bridged (non-learned) recovery', async () => {
            const job = await startGpuJob('cap-bridged-attempt', {
                localFilePath: '/media/movie.mkv',
            });
            const callbacks = capturedCallbacks.get(job.id)!;

            callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false); // first → retry scheduled
            vi.advanceTimersByTime(2000); // retry respawns → spawnAttempt becomes 2
            await vi.advanceTimersByTimeAsync(0);
            expect(job.spawnAttempt).toBe(2);
            job.transcodeSpeed = 0.5;

            callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false); // second → bridge, no learn
            await vi.advanceTimersByTimeAsync(0);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const calls = mockFailureEvents.recordTranscodeFailureEvent.mock.calls as any[];
            const bridgedCall = calls.find((call) => call[1]?.outcome === 'bridged');
            expect(bridgedCall).toBeDefined();
            const event = bridgedCall[1];
            expect(event.attempt).toBe(2);
            expect(event.transcodeSpeed).toBe(0.5);
        });

        it.each([
            [
                'seek',
                (job: { isSeeking: boolean }) => {
                    job.isSeeking = true;
                },
            ],
            [
                'intentional stop',
                (job: { status: string }) => {
                    job.status = 'stopping';
                },
            ],
        ])('does NOT record %s teardown', async (_label, mutate) => {
            const job = await startGpuJob(`cap-${_label}`, { localFilePath: '/media/movie.mkv' });
            const callbacks = capturedCallbacks.get(job.id)!;
            mutate(job);

            callbacks.onExit(255, null, 'whatever', false);
            await vi.advanceTimersByTimeAsync(0);

            // Non-zero exit is the NORMAL outcome of seek and stop. Recording those
            // buries the signal the table exists for.
            expect(mockFailureEvents.recordTranscodeFailureEvent).not.toHaveBeenCalled();
        });

        it('records a spawn failure, which produces no exit event at all', async () => {
            const job = await startGpuJob('cap-spawn', { localFilePath: '/media/movie.mkv' });
            const callbacks = capturedCallbacks.get(job.id)!;

            callbacks.onError(new Error('spawn /usr/bin/ffmpeg ENOENT'));
            await vi.advanceTimersByTimeAsync(0);

            const [, event] = mockFailureEvents.recordTranscodeFailureEvent.mock.calls[0];
            expect(event.outcome).toBe('spawn_failed');
        });

        it('a throwing recorder does not break the transcode', async () => {
            mockFailureEvents.recordTranscodeFailureEvent.mockRejectedValueOnce(
                new Error('db down'),
            );
            const job = await startGpuJob('cap-throw', { localFilePath: '/media/movie.mkv' });
            const callbacks = capturedCallbacks.get(job.id)!;

            expect(() => callbacks.onExit(1, null, TRANSIENT_BUSY_GPU, false)).not.toThrow();
            await vi.advanceTimersByTimeAsync(0);
            expect(job.status).not.toBe('error');
        });

        // A `.catch()` on the eventual recorder promise cannot see a throw that
        // happens while BUILDING that promise's arguments — classifyTranscodeFailure
        // and buildTranscodeEnvSnapshot both run synchronously, outside any promise.
        // Uses the SIGKILL branch specifically: it's the one path (besides the
        // terminal 'failed' branch) that calls classifyTranscodeFailure only from
        // inside recordFailureEvent, not earlier in handleExit's own body — so a
        // throw-once here exercises exactly the gap the recorder's own try/catch is
        // meant to close, not some earlier unrelated call.
        it('a synchronous throw building the failure event does not break handleExit or skip its shared tail', async () => {
            const classifier = await import('./transcoding/transcode-failure-classifier.js');
            vi.mocked(classifier.classifyTranscodeFailure).mockImplementationOnce(() => {
                throw new Error('classify boom');
            });
            mockPersistence.updateStatus.mockClear();

            const job = await startGpuJob('cap-sync-throw', { localFilePath: '/media/movie.mkv' });
            const callbacks = capturedCallbacks.get(job.id)!;

            // External SIGKILL (job.killEscalated is falsy on a fresh job) — falls
            // through to the shared tail rather than an early `return`.
            expect(() => callbacks.onExit(null, 'SIGKILL', 'oom killed', false)).not.toThrow();
            await vi.advanceTimersByTimeAsync(0);

            expect(job.status).toBe('error');
            // The assertion that actually matters: the shared tail (which persists
            // the final status "so the web container can see it") must still run.
            // Without the full-body try/catch, the sync throw unwinds handleExit
            // before reaching this call, and the test would pass even with the
            // regression this guards against if only `job.status` were checked.
            expect(mockPersistence.updateStatus).toHaveBeenCalled();
        });
    });
});

describe('hasPlaybackConfigChanged — subtitle burn-in', () => {
    // Burn-in is composited into the video frames, so changing which subtitle is
    // burned needs a fresh encode. Nothing else in the comparison moves when only
    // the subtitle index changes (isTranscoded is already true on both sides), so
    // without an explicit check the running job is reused and the ORIGINAL
    // subtitle stays welded into the stream for the rest of the session.
    // Reproduced on prod: requesting index 4 over a job burning index 3 logged
    // "Subtitle burn-in requested {absoluteIndex:4}" and then "Returning existing
    // job" — the viewer kept seeing subtitle 3.
    type Cfg = Parameters<typeof hasPlaybackConfigChanged>[0];

    function burnInConfig(absoluteIndex: number | undefined): Cfg {
        return {
            fileId: 'file-1',
            inputUrl: '/data/movies/The Handmaiden.mkv',
            forceAudioTranscode: true,
            videoInfo: { outputCodec: 'h264', isTranscoded: true },
            hlsOutput: { hlsAudioMode: 'demux' },
            subtitleBurnIn:
                absoluteIndex === undefined
                    ? undefined
                    : { absoluteIndex, codec: 'hdmv_pgs_subtitle' },
        } as unknown as Cfg;
    }

    it('detects a switch between two burned-in subtitle tracks', () => {
        expect(hasPlaybackConfigChanged(burnInConfig(3), burnInConfig(4))).toBe(true);
    });

    it('detects burn-in being switched OFF on an already-transcoding stream', () => {
        // The video is transcoded either way, so isTranscoded does not move here —
        // this case is invisible without the subtitle check, and the subtitle
        // could never be removed.
        expect(hasPlaybackConfigChanged(burnInConfig(3), burnInConfig(undefined))).toBe(true);
    });

    it('detects burn-in being switched ON', () => {
        expect(hasPlaybackConfigChanged(burnInConfig(undefined), burnInConfig(3))).toBe(true);
    });

    it('reuses the job when the same subtitle is requested again', () => {
        expect(hasPlaybackConfigChanged(burnInConfig(3), burnInConfig(3))).toBe(false);
    });

    it('still detects the non-subtitle changes it always did', () => {
        const a = burnInConfig(3);
        const b = { ...burnInConfig(3), forceAudioTranscode: false } as Cfg;
        expect(hasPlaybackConfigChanged(a, b)).toBe(true);
    });
});

describe('hasPlaybackConfigChanged — qualityCap', () => {
    // A cap change (a client re-requesting the manifest with a different
    // ?maxBitrate/?maxHeight — e.g. the quality picker) must NOT reuse a
    // running job made with different caps, or the viewer keeps getting the
    // OLD encode geometry under the new request.
    type Cfg = Parameters<typeof hasPlaybackConfigChanged>[0];

    function qualityCapConfig(
        qualityCap: { maxBitrate?: number; maxHeight?: number } | undefined,
    ): Cfg {
        return {
            fileId: 'file-1',
            inputUrl: '/data/movies/The Handmaiden.mkv',
            videoInfo: { outputCodec: 'h264', isTranscoded: true },
            hlsOutput: { hlsAudioMode: 'demux' },
            qualityCap,
        } as unknown as Cfg;
    }

    it('detects a maxHeight change', () => {
        expect(
            hasPlaybackConfigChanged(
                qualityCapConfig({ maxHeight: 1080 }),
                qualityCapConfig({ maxHeight: 720 }),
            ),
        ).toBe(true);
    });

    it('detects a maxBitrate change', () => {
        expect(
            hasPlaybackConfigChanged(
                qualityCapConfig({ maxBitrate: 8_000_000 }),
                qualityCapConfig({ maxBitrate: 4_000_000 }),
            ),
        ).toBe(true);
    });

    it('detects a cap being removed', () => {
        expect(
            hasPlaybackConfigChanged(
                qualityCapConfig({ maxHeight: 1080 }),
                qualityCapConfig(undefined),
            ),
        ).toBe(true);
    });

    it('detects a cap being added', () => {
        expect(
            hasPlaybackConfigChanged(
                qualityCapConfig(undefined),
                qualityCapConfig({ maxHeight: 1080 }),
            ),
        ).toBe(true);
    });

    it('reuses the job when the same cap is requested again', () => {
        expect(
            hasPlaybackConfigChanged(
                qualityCapConfig({ maxHeight: 1080, maxBitrate: 8_000_000 }),
                qualityCapConfig({ maxHeight: 1080, maxBitrate: 8_000_000 }),
            ),
        ).toBe(false);
    });
});

describe('hasPlaybackConfigChanged — videoDisabled (audio-only rung)', () => {
    // Toggling the audio-only rung on a session with an already-running job
    // must NOT be invisible to this comparison. Nothing else here moves when
    // only videoDisabled flips (fileId/inputUrl/codecs are identical), so
    // without an explicit check the existing job is reused and the switch
    // silently does nothing — the viewer keeps getting (or not getting) video.
    type Cfg = Parameters<typeof hasPlaybackConfigChanged>[0];

    function audioOnlyConfig(videoDisabled: boolean | undefined): Cfg {
        return {
            fileId: 'file-1',
            inputUrl: '/data/movies/The Handmaiden.mkv',
            videoInfo: { outputCodec: 'h264', isTranscoded: true },
            hlsOutput: { hlsAudioMode: 'demux' },
            videoDisabled,
        } as unknown as Cfg;
    }

    it('detects the audio-only rung being switched ON', () => {
        expect(hasPlaybackConfigChanged(audioOnlyConfig(false), audioOnlyConfig(true))).toBe(true);
    });

    it('detects the audio-only rung being switched OFF', () => {
        expect(hasPlaybackConfigChanged(audioOnlyConfig(true), audioOnlyConfig(false))).toBe(true);
    });

    it('reuses the job when videoDisabled is unchanged', () => {
        expect(hasPlaybackConfigChanged(audioOnlyConfig(true), audioOnlyConfig(true))).toBe(false);
    });
});

describe('hasPlaybackConfigChanged — itemId (fix plan 6, C1)', () => {
    // A same-session request for a DIFFERENT item must recreate the job
    // rather than silently keep serving the old job under the new item's
    // segment URLs (the job->item binding check in job-item-binding.ts keys
    // its access decision on config.itemId staying accurate).
    type Cfg = Parameters<typeof hasPlaybackConfigChanged>[0];

    function itemConfig(itemId: string): Cfg {
        return {
            itemId,
            fileId: 'file-1',
            inputUrl: '/data/movies/The Handmaiden.mkv',
            videoInfo: { outputCodec: 'h264', isTranscoded: true },
            hlsOutput: { hlsAudioMode: 'demux' },
        } as unknown as Cfg;
    }

    it('detects a genuine item change under one PlaySessionId', () => {
        expect(hasPlaybackConfigChanged(itemConfig('item-x'), itemConfig('item-y'))).toBe(true);
    });

    it('reuses the job when the item is unchanged', () => {
        expect(hasPlaybackConfigChanged(itemConfig('item-x'), itemConfig('item-x'))).toBe(false);
    });

    it('reuses the job for a dashed/dashless respelling of the SAME UUID item', () => {
        const dashed = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const dashless = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        expect(hasPlaybackConfigChanged(itemConfig(dashed), itemConfig(dashless))).toBe(false);
    });

    it('reuses the job for a case-only change on a UUID item', () => {
        const lower = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const upper = lower.toUpperCase();
        expect(hasPlaybackConfigChanged(itemConfig(lower), itemConfig(upper))).toBe(false);
    });

    // Fix round 1, Important #1: a cache-backed preview artifact's config.itemId
    // is whichever viewer warmed it, never a per-session identity — comparing it
    // would tear down (stopJob -> non-zero exit -> markFailed -> directory
    // delete) an artifact two DIFFERENT items' viewers are legitimately sharing
    // (media_file_items M:N). The itemId clause must not fire when either side
    // is an artifact job (config.cacheKey set).
    it('does NOT treat a differing itemId as a change for a cache-backed artifact job (config.cacheKey set)', () => {
        const artifactExisting = { ...itemConfig('item-e1'), cacheKey: 'sharedfile' } as Cfg;
        const artifactNext = { ...itemConfig('item-e2'), cacheKey: 'sharedfile' } as Cfg;
        expect(hasPlaybackConfigChanged(artifactExisting, artifactNext)).toBe(false);
    });

    it('control: the SAME differing itemId IS still a change for a non-artifact (real playback) job', () => {
        expect(hasPlaybackConfigChanged(itemConfig('item-e1'), itemConfig('item-e2'))).toBe(true);
    });
});

describe('resolveSeekGenerationStart', () => {
    // Forward-seek hang, reproduced on prod (with AND without subtitle burn-in):
    // seeking to segment 85 promoted a generation with segmentOffset 85, but
    // AVPlayer primes its AAC decoder by fetching audio segment 84. The outgoing
    // generation had only reached ~segment 25, so 84 existed in NO generation and
    // 404'd forever — video played, audio never arrived, spinner never cleared.
    // Logged as classifier "missing_404" on stream_0 with requestedSegment one
    // below segmentOffset.
    const uniform = { isCopyModeVideo: false, alignedSeekTimeSeconds: 510 };

    it('starts far enough before the target to cover audio lagging video', () => {
        // Measured on prod: a seek triggered at video segment 83 while audio was
        // still pulling 81. A one-segment preroll started at 82 and audio 81
        // existed in no generation, so playback stalled after ~two segments.
        const start = resolveSeekGenerationStart(85, 6, uniform);

        expect(start.startSegment).toBe(83);
        expect(85 - start.startSegment).toBeGreaterThanOrEqual(2);
    });

    it('keeps start time on the grid so the derived offset matches the start segment', () => {
        // Per-stream offsets are floor(startTimeSeconds / segmentDuration); if the
        // time and the segment disagree, audio and video offsets diverge and
        // AVPlayer — which matches demuxed streams by segment NUMBER — desyncs.
        const start = resolveSeekGenerationStart(85, 6, uniform);

        expect(start.startTimeSeconds).toBe(498);
        expect(Math.floor(start.startTimeSeconds / 6)).toBe(start.startSegment);
    });

    it('leaves copy-mode video untouched', () => {
        // There segment<->time is a keyframe mapping, not a multiply, so shifting
        // the start time would break the correspondence.
        const start = resolveSeekGenerationStart(85, 6, {
            isCopyModeVideo: true,
            alignedSeekTimeSeconds: 509.184,
        });

        expect(start.startSegment).toBe(85);
        expect(start.startTimeSeconds).toBe(509.184);
    });

    it('does not go negative when seeking to the very start', () => {
        const start = resolveSeekGenerationStart(0, 6, {
            isCopyModeVideo: false,
            alignedSeekTimeSeconds: 0,
        });

        expect(start.startSegment).toBe(0);
        expect(start.startTimeSeconds).toBe(0);
    });

    it('handles a seek to segment 1 without underflowing', () => {
        const start = resolveSeekGenerationStart(1, 6, {
            isCopyModeVideo: false,
            alignedSeekTimeSeconds: 6,
        });

        expect(start.startSegment).toBe(0);
        expect(start.startTimeSeconds).toBe(0);
    });

    it('falls back to the target when the segment duration is unusable', () => {
        const start = resolveSeekGenerationStart(85, 0, uniform);

        expect(start.startSegment).toBe(85);
        expect(start.startTimeSeconds).toBe(510);
    });

    // NaN passes every `<=` comparison, so a range check alone lets it through.
    // It would land in job.segmentOffset and reach FFmpeg as -start_number NaN.
    it('never emits NaN for a NaN target', () => {
        const start = resolveSeekGenerationStart(Number.NaN, 6, uniform);

        expect(Number.isNaN(start.startSegment)).toBe(false);
        expect(Number.isNaN(start.startTimeSeconds)).toBe(false);
        expect(start.startSegment).toBe(0);
    });

    it('never emits NaN for a NaN segment duration', () => {
        const start = resolveSeekGenerationStart(85, Number.NaN, uniform);

        expect(Number.isNaN(start.startSegment)).toBe(false);
        expect(start.startSegment).toBe(85);
    });

    it('clamps a negative target instead of passing it through to -start_number', () => {
        const start = resolveSeekGenerationStart(-3, 6, {
            isCopyModeVideo: false,
            alignedSeekTimeSeconds: 0,
        });

        expect(start.startSegment).toBe(0);
    });

    it('skips the preroll when a fractional duration breaks the grid round-trip', () => {
        // floor(45 * 6.006 / 6.006) === 44 in floating point. Shipping that pair
        // would put audio and video on different offsets — the desync the code
        // warns about — so the preroll is skipped rather than risked.
        const start = resolveSeekGenerationStart(46, 6.006, {
            isCopyModeVideo: false,
            alignedSeekTimeSeconds: 46 * 6.006,
        });

        expect(Math.floor(start.startTimeSeconds / 6.006)).toBe(start.startSegment);
    });

    it('keeps the offset invariant across a wide range of targets', () => {
        // The invariant the whole fix rests on: whatever pair is returned, the
        // re-derived offset must equal the start segment.
        for (let target = 1; target <= 500; target++) {
            const start = resolveSeekGenerationStart(target, 6, {
                isCopyModeVideo: false,
                alignedSeekTimeSeconds: target * 6,
            });
            expect(Math.floor(start.startTimeSeconds / 6)).toBe(start.startSegment);
        }
    });
});

// ============================================================================
// cleanupInactiveJobs — the never-watched reaper vs a job restored across a
// rolling deploy
// ============================================================================
//
// Production incident 2026-07-29 (rolling deploy): a
// mid-playback container recreate correctly restored the transcode job on the
// peer pod — and the reaper then deleted it 16 seconds later.
//
// The unwatched heuristic exists to reap a job whose client fetched the
// manifest but never pulled a single segment. It keys off two fields that are
// BOTH per-process:
//   - job.lastServedSegment — a fresh empty Map on the restoring pod, because
//     no segment has been served *by this pod* yet, and
//   - job.startedAt — which restoreJob seeds from the persisted
//     metadata.created_at, i.e. the ORIGINAL session start, minutes earlier.
//
// So `sinceStart > unwatchedTimeout` is already true the instant a restore
// finishes, and the very next sweep reaps a job that is being actively watched.
// It stops with persistForRestart=false, which DELETES the DB row — so no
// second restore is possible and every later segment request 410s for good,
// turning a survivable re-buffer into a stream the user can only fix with F5.
//
// A restored job is by definition one a client just requested a segment from,
// so its unwatched grace period must run from the restore, not from the
// original start.
describe('cleanupInactiveJobs — never-watched reaper vs restored jobs', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    // Must be a real UUID: cleanupInactiveJobs filters play session ids through
    // a UUID pattern before the cross-pod DB status check.
    const RESTORED_SESSION = '95d6c7e6-0279-408a-b719-54f882b8f8df';

    function makeRestoredMetadata(createdAt: Date) {
        return {
            play_session_id: RESTORED_SESSION,
            job_id: 'acc1845e-a3f2-4790-8f21-d520b0cfd0a0',
            item_id: 'item-1',
            user_id: 'user-1',
            device_id: 'device-1',
            config: {
                itemId: 'item-1',
                username: 'user-a',
                deviceId: 'device-1',
                inputUrl: 'http://localhost/stream',
                audioTracks: [],
                totalDurationSeconds: 2880,
            },
            output_dir: '/tmp/transcode-test/' + RESTORED_SESSION + '/gen-0001',
            status: 'stopped',
            mode: 'full' as const,
            error_message: null,
            segment_offset: 131,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: 'ad2d7ff54fb9',
            ffmpeg_pid: null,
            created_at: createdAt,
            last_accessed_at: createdAt,
            last_progress_at: createdAt,
            stopped_at: null,
            transcode_decision: null,
            can_restore: true,
            cpu_percent: null,
            memory_mb: null,
        };
    }

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        capturedCallbacks.clear();

        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.deleteJob.mockClear();
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([]);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );

        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('does NOT reap a just-restored job whose ORIGINAL start predates the unwatched timeout', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        // The session began ~8 minutes ago (the prod case was 486s) and is
        // being restored right now because a segment request arrived.
        const originalStart = new Date(Date.now() - 8 * 60 * 1000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(makeRestoredMetadata(originalStart) as any);

        // FFmpeg has produced output again, but the awaiting segment request has
        // not been *served* yet — exactly the state the prod reaper fired in.
        job.segmentsReady = 288;
        job.masterPlaylistReady = true;
        job.status = 'ready';
        expect(job.lastServedSegment.size).toBe(0);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();

        // Teardown is observed on the job lifecycle rather than on
        // persistence.deleteJob: stopJob drops the job from the in-memory map
        // and flips it to 'stopping', and in prod that same path deletes the DB
        // row (persistForRestart=false), which is what makes the session
        // permanently unrestorable — 410 on every subsequent segment.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(true);
        expect(job.status).toBe('ready');
    });

    it('a restored job keeps the coverage persisted in its config', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeRestoredMetadata(new Date());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (metadata.config as any).coveredRanges = [[0, 288]];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(metadata as any);
        job.segmentsReady = 0;

        const progress = svc.getPlayerTranscodeProgress(RESTORED_SESSION);
        expect(progress?.coveredRanges?.[0]).toEqual({ start: 0, end: 10 });
        expect(progress?.progressPercent).toBe(10);
    });

    it('two concurrent restores of one session spawn ONE FFmpeg and share the job', async () => {
        // A demux client asks for audio and video together; both found no job
        // here and both claimed the row (it already names this pod).
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeRestoredMetadata(new Date());
        type RestoreArg = Parameters<typeof svc.restoreJob>[0];
        const [first, second] = await Promise.all([
            svc.restoreJob(metadata as unknown as RestoreArg),
            svc.restoreJob(metadata as unknown as RestoreArg),
        ]);
        expect(second).toBe(first);
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);

        // A job that has ended may be restored again.
        first.status = 'stopped';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const third = await svc.restoreJob(metadata as any);
        expect(third).not.toBe(first);
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(2);
    });

    it('still reaps a genuinely never-watched job once its own grace period elapses', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'c0ffee00-0000-4000-8000-000000000001' }),
        );

        // Client fetched the manifest, FFmpeg produced segments, nobody ever
        // pulled one — and the grace period has now genuinely expired. The
        // reaper only considers 'ready'/'running' jobs. For a fresh (never
        // restored) job the anchor tracks startedAt, so both move together.
        job.segmentsReady = 20;
        job.status = 'ready';
        job.startedAt = new Date(Date.now() - 5 * 60 * 1000);
        job.unwatchedGraceAnchor = new Date(Date.now() - 5 * 60 * 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(false);
    });

    it('preserves live sessions during the startup wipe of the shared transcode dir', async () => {
        mockFileManager.clearTranscodeDirectory.mockClear();
        mockPersistence.getAllJobPlaySessionIds.mockResolvedValueOnce([
            'peer-session-1',
            'peer-session-2',
        ]);

        vi.resetModules();
        const mod = await import('./ffmpeg-transcode.service.js');
        const svc = mod.getFFmpegTranscodeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).startupCleanupPromise;

        expect(mockFileManager.clearTranscodeDirectory).toHaveBeenCalledWith(
            new Set(['peer-session-1', 'peer-session-2']),
        );
    });

    it('wipes NOTHING when liveness cannot be determined (DB unreachable)', async () => {
        mockFileManager.clearTranscodeDirectory.mockClear();
        mockPersistence.getAllJobPlaySessionIds.mockRejectedValueOnce(new Error('db down'));

        vi.resetModules();
        const mod = await import('./ffmpeg-transcode.service.js');
        const svc = mod.getFFmpegTranscodeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).startupCleanupPromise;

        // Guessing wrong here deletes peers' live segments — leaking stale
        // directories is the cheaper failure.
        expect(mockFileManager.clearTranscodeDirectory).not.toHaveBeenCalled();
    });

    it('DOES reap a restored job that stays unwatched past its own grace period', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        const originalStart = new Date(Date.now() - 8 * 60 * 1000);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(makeRestoredMetadata(originalStart) as any);

        job.segmentsReady = 288;
        job.status = 'ready';
        // The restore happened, the grace period was granted — and the client
        // still never pulled a segment. The job must not leak just because it
        // came back from persistence.
        job.unwatchedGraceAnchor = new Date(Date.now() - 5 * 60 * 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(false);
    });

    it('audio-drop job survives the segment-fallback arm inside its retention window', async () => {
        // Exercises the REAL cleanupInactiveJobs path end-to-end, not the
        // extracted shouldReapJob() in isolation: the completed-job arm and
        // progress-heartbeat arm both call shouldReapJob, but the segment-access
        // fallback arm (reached when progress is recent enough not to trip the
        // arm above it) used to keep its OWN hardcoded 120s/300s thresholds
        // regardless of job mode. An audio-drop job with progress and segment
        // ages both past the normal thresholds but still well inside
        // FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS (1800s, mocked above)
        // must survive ALL THREE arms, not just the two shouldReapJob() covers.
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'c0ffee00-0000-4000-8000-000000000002',
                videoDisabled: true,
                // No totalDurationSeconds — totalSegments stays 0, so isCompleted
                // is always false here. This deliberately keeps the job OFF the
                // completed-job arm and forces it through the progress-heartbeat
                // arm and into the segment-access fallback arm.
            }),
        );
        job.status = 'ready';
        job.segmentsReady = 20;
        // A previously-served segment keeps this off the never-watched arm,
        // which is a different reaper path with its own (60s) timeout.
        job.lastServedSegment.set('stream_0', 5);

        // progressAge(200s) > FFMPEG_PROGRESS_TIMEOUT_SECONDS(120s) but far under
        // the audio-drop window; segmentAge(310s) > FFMPEG_INACTIVITY_TIMEOUT_SECONDS(300s)
        // but likewise far under it. At shipped defaults, an ordinary job in
        // this exact state is reaped by the segment-fallback arm.
        job.lastProgressAt = new Date(Date.now() - 200 * 1000);
        job.lastAccessedAt = new Date(Date.now() - 310 * 1000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(true);
        expect(job.status).toBe('ready');
    });
});

// Prod 2026-09-25 (session a0000004): a client went quiet for ~17 minutes
// (laptop asleep) mid-remux. cleanupExpiredJobs' dormant branch did what it is
// for: it marked the can_restore=true row 'stopped' so the session could be
// restored inside STOPPED_JOB_TTL. But the owning pod read that row as an
// admin/client cross-pod stop, stopped the job with persistForRestart=false,
// and DELETED the row — so when the client woke up every segment request found
// nothing in memory or the DB and got 410 (373 of them in two minutes).
//
// The two marks are distinguishable: an explicit cross-pod stop sets
// can_restore=false; the dormant sweep leaves it true.
describe('cleanupInactiveJobs — dormant DB mark vs explicit cross-pod stop', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    const SESSION = 'a0000004-2f73-4e64-b6b6-fb3e85ecbddc';

    function makeMetadata() {
        const now = new Date();
        return {
            play_session_id: SESSION,
            job_id: 'd6ccf7d1-19ca-40a8-b1a9-3a4372875176',
            item_id: 'item-1',
            user_id: 'user-1',
            device_id: 'device-1',
            config: {
                itemId: 'item-1',
                username: 'user-a',
                deviceId: 'device-1',
                inputUrl: 'http://localhost/stream',
                audioTracks: [],
                totalDurationSeconds: 3802,
            },
            output_dir: '/tmp/transcode-test/' + SESSION + '/gen-0001',
            status: 'stopped',
            mode: 'full' as const,
            error_message: null,
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: 'b744f3b0bac1',
            ffmpeg_pid: null,
            created_at: now,
            last_accessed_at: now,
            last_progress_at: now,
            stopped_at: null,
            transcode_decision: null,
            can_restore: true,
            cpu_percent: null,
            memory_mb: null,
        };
    }

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.deleteJob.mockClear();
        mockPersistence.updateStatus.mockClear();
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([]);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    async function runWithDbRow(canRestore: boolean, errorMessage: string | null) {
        const svc = svcModule.getFFmpegTranscodeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(makeMetadata() as any);
        job.status = 'ready';
        job.segmentsReady = 381;
        job.masterPlaylistReady = true;
        // A segment was served, so the never-watched reaper stays out of it.
        job.lastServedSegment.set('', 7);
        mockPersistence.deleteJob.mockClear();
        mockPersistence.updateStatus.mockClear();
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            {
                ...makeMetadata(),
                job_id: job.id,
                status: 'stopped',
                can_restore: canRestore,
                error_message: errorMessage,
            },
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { svc: svc as any, job };
    }

    it('keeps the DB row restorable when the sweep only marked it dormant (can_restore=true)', async () => {
        const { svc, job } = await runWithDbRow(true, null);

        // Released locally (the sweep's decision to free FFmpeg stands) ...
        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
        // ... but the row survives, still restorable, for the dormant window.
        expect(mockPersistence.deleteJob).not.toHaveBeenCalled();
        // D-HLS-1 follow-up: this own-job write now also passes
        // getCurrentPodName()'s value as the pod-guard argument.
        expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
            SESSION,
            'stopped',
            undefined,
            true,
            process.env.HOSTNAME || 'unknown',
        );
    });

    it('still tears down and deletes the row for an explicit cross-pod stop (can_restore=false)', async () => {
        const { svc, job } = await runWithDbRow(false, 'Stopped by admin from pod x');

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
        // D-HLS-1 follow-up: deleteJob's selfPod now also comes from
        // getCurrentPodName() (fallback `'unknown'`, not `null`).
        expect(mockPersistence.deleteJob).toHaveBeenCalledWith(
            SESSION,
            process.env.HOSTNAME || 'unknown',
        );
    });
});

// A staging client fetched the master, the init segment and
// four media segments, then simply went away (no stop call, no heartbeat). The
// four libx264 jobs kept encoding at full speed for minutes (~12 cores) and had
// to be killed by hand. Every reaper arm for a still-encoding job keys off
// `lastProgressAt`, and the process runner bumps that SAME field on every
// FFmpeg stderr progress line — so an abandoned job looked heartbeat-fresh
// until FFmpeg had transcoded the entire file.
//
// The client-gone arm keys off CLIENT activity only: the in-memory client
// heartbeat, a segment/playlist fetch, or the DB row's last_progress_at (where
// a heartbeat that the router hashed to another pod lands).
describe('cleanupInactiveJobs — abandoned job that is still encoding', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    const SESSION = 'a8a1d0c2-5c1e-4f5b-9a57-6f0b8f3c2e11';
    const CLIENT_GONE_S = 180;

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.deleteJob.mockClear();
        mockPersistence.updateStatus.mockClear();
        mockPersistence.updateLastProgress.mockClear();
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([]);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    /**
     * A 2-hour full transcode that served a few segments and is still encoding:
     * FFmpeg's own progress keeps `lastProgressAt` fresh, exactly as
     * process-runner does on every stderr progress line.
     */
    async function startWatchedEncodingJob(opts: {
        clientIdleSeconds: number;
        videoDisabled?: boolean;
        playSessionId?: string;
    }) {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: opts.playSessionId ?? SESSION,
                totalDurationSeconds: 7200,
                videoDisabled: opts.videoDisabled,
            }),
        );
        job.status = 'ready';
        job.masterPlaylistReady = true;
        job.segmentsReady = 400;
        job.lastServedSegment.set('stream_0', 4);
        const idleSince = new Date(Date.now() - opts.clientIdleSeconds * 1000);
        job.lastAccessedAt = idleSince;
        job.lastClientHeartbeatAt = idleSince;
        job.lastProgressAt = new Date(); // encoder progress, not the client
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { svc: svc as any, job };
    }

    function dbRow(job: { id: string }, lastProgressAt: Date) {
        return {
            play_session_id: SESSION,
            job_id: job.id,
            status: 'running',
            error_message: null,
            pod_name: process.env.HOSTNAME || 'unknown',
            can_restore: true,
            last_progress_at: lastProgressAt,
        };
    }

    it('reaps it once the client has been gone past the timeout, even though FFmpeg is still progressing', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: CLIENT_GONE_S + 30,
        });
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            dbRow(job, new Date(Date.now() - (CLIENT_GONE_S + 30) * 1000)),
        ]);

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
        // Dormant, not deleted: a client that was only backgrounded gets its
        // session restored on the next segment request.
        expect(mockPersistence.deleteJob).not.toHaveBeenCalled();
        expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
            SESSION,
            'stopped',
            undefined,
            true,
            process.env.HOSTNAME || 'unknown',
        );
    });

    it('keeps it while the client is inside the timeout', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: CLIENT_GONE_S - 30,
        });
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            dbRow(job, new Date(Date.now() - (CLIENT_GONE_S - 30) * 1000)),
        ]);

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it('keeps a paused client alive through its heartbeat to THIS pod (deep buffer, no segment fetches)', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: CLIENT_GONE_S + 600,
        });
        svc.recordProgressHeartbeat(SESSION, 'PAUSED');
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            dbRow(job, new Date(Date.now() - (CLIENT_GONE_S + 600) * 1000)),
        ]);

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it('keeps a client alive whose heartbeat the router sent to ANOTHER pod (DB last_progress_at)', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: CLIENT_GONE_S + 600,
        });
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            dbRow(job, new Date(Date.now() - 20 * 1000)),
        ]);

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it.each([
        { lease: 'fresh cross-pod heartbeat', ageSeconds: 20, survives: true },
        { lease: 'expired cross-pod heartbeat', ageSeconds: 600, survives: false },
    ])(
        'completed VOD with $lease retains the correct owner lifetime',
        async ({ ageSeconds, survives }) => {
            const { svc, job } = await startWatchedEncodingJob({ clientIdleSeconds: 600 });
            // The entire 2-hour file is already on disk. No FFmpeg progress or
            // media requests can hide the completed-job arm's lease decision.
            job.segmentsReady = 1200;
            job.lastProgressAt = new Date(Date.now() - 600_000);
            mockPersistence.getJobsByPlaySessions.mockResolvedValue([
                { ...dbRow(job, new Date(Date.now() - ageSeconds * 1000)), status: 'ready' },
            ]);

            await svc.cleanupInactiveJobs();

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(survives);
            if (survives) expect(mockPersistence.updateStatus).not.toHaveBeenCalled();
            else
                expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
                    SESSION,
                    'stopped',
                    undefined,
                    true,
                    process.env.HOSTNAME || 'unknown',
                );
        },
    );

    it.each([
        { kind: 'persisted UUID', playSessionId: SESSION, survives: true },
        {
            kind: 'local-only non-UUID',
            playSessionId: 'preview-completed-local-only',
            survives: false,
        },
    ])(
        'completed $kind keeps its correct cleanup policy when lease lookup is unavailable',
        async ({ playSessionId, survives }) => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: 600,
                playSessionId,
            });
            job.segmentsReady = 1200;
            job.lastProgressAt = new Date(Date.now() - 600_000);
            mockPersistence.getJobsByPlaySessions.mockRejectedValue(
                new Error('lease lookup unavailable'),
            );

            await svc.cleanupInactiveJobs();

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(survives);
            if (survives) {
                expect(mockPersistence.getJobsByPlaySessions).toHaveBeenCalledWith([SESSION]);
                expect(mockPersistence.updateStatus).not.toHaveBeenCalled();
            } else {
                expect(mockPersistence.getJobsByPlaySessions).not.toHaveBeenCalled();
                expect(mockPersistence.updateStatus).toHaveBeenCalled();
            }
        },
    );

    it('reaps a completed UUID job idle past the ceiling across several failed lookups, keeps one with a live local process', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: 600,
        });
        job.segmentsReady = 1200;
        const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
        job.lastProgressAt = staleAt;
        job.lastAccessedAt = staleAt;
        job.lastClientHeartbeatAt = staleAt;
        // A live local ffmpeg process protects the directory.
        (job as { process: unknown }).process = { pid: 4242 };
        mockPersistence.getJobsByPlaySessions.mockRejectedValue(new Error('db down'));

        for (let i = 0; i < 4; i++) {
            await svc.cleanupInactiveJobs();
        }
        expect(mockPersistence.getJobsByPlaySessions).toHaveBeenCalledTimes(4);
        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);

        // Process gone: the next failed sweep reaps the old completed job.
        (job as { process: unknown }).process = null;
        await svc.cleanupInactiveJobs();
        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
    });

    it('does not reap on the client-gone arm when the DB check failed (cannot see cross-pod heartbeats)', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: CLIENT_GONE_S + 30,
        });
        mockPersistence.getJobsByPlaySessions.mockRejectedValue(new Error('db down'));

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it('gives an audio-drop job its extended retention window', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: CLIENT_GONE_S + 30,
            videoDisabled: true,
        });
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            dbRow(job, new Date(Date.now() - (CLIENT_GONE_S + 30) * 1000)),
        ]);

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it('still reaps an abandoned audio-drop job once its own window has passed', async () => {
        const { svc, job } = await startWatchedEncodingJob({
            clientIdleSeconds: 1800 + 30,
            videoDisabled: true,
        });
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([
            dbRow(job, new Date(Date.now() - (1800 + 30) * 1000)),
        ]);

        await svc.cleanupInactiveJobs();

        expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
    });

    it('leaves a non-UUID session (no DB row, no heartbeats) to the other arms', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'preview-synthetic-1',
                totalDurationSeconds: 7200,
            }),
        );
        job.status = 'ready';
        job.segmentsReady = 400;
        job.lastServedSegment.set('stream_0', 4);
        const idleSince = new Date(Date.now() - (CLIENT_GONE_S + 30) * 1000);
        job.lastAccessedAt = idleSince;
        job.lastClientHeartbeatAt = idleSince;
        job.lastProgressAt = new Date();
        // A live UUID session alongside it, so the DB lookup does run this sweep
        // and only the UUID guard keeps the preview job off the arm.
        const { job: live } = await startWatchedEncodingJob({ clientIdleSeconds: 5 });
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([dbRow(live, new Date())]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it('a /j "playback stopped" that lands on a non-owner pod flags the owner\'s row as stopped', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const ownRow = {
            play_session_id: SESSION,
            job_id: 'job-on-peer',
            item_id: 'item-1',
            pod_name: 'web-1',
            status: 'running',
            config: { itemId: 'item-1', username: 'user-a' },
        };
        const otherUsersRow = {
            ...ownRow,
            play_session_id: 'b2b2b2b2-0000-4000-8000-000000000002',
            config: { itemId: 'item-1', username: 'user-b' },
        };
        mockPersistence.getAllActiveJobs.mockResolvedValueOnce([ownRow, otherUsersRow]);
        mockPersistence.getJob.mockResolvedValueOnce(ownRow);

        const stopped = await svc.stopJobByItemAndUser('item-1', 'user-a', 'client_stopped');

        expect(stopped).toBe(true);
        expect(mockPersistence.updateStatus).toHaveBeenCalledTimes(1);
        expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
            SESSION,
            'stopped',
            expect.stringContaining('client_stopped'),
            false,
        );
    });

    it('ignores stopping peers when finding the single cross-pod stop target', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const running = {
            play_session_id: SESSION,
            job_id: 'peer',
            item_id: 'item-1',
            pod_name: 'web-1',
            status: 'running',
            config: { username: 'user-a' },
        };
        mockPersistence.getAllActiveJobs.mockResolvedValueOnce([
            running,
            {
                ...running,
                play_session_id: 'b2b2b2b2-0000-4000-8000-000000000002',
                status: 'stopping',
            },
        ]);
        mockPersistence.getJob.mockResolvedValueOnce(running);
        expect(await svc.stopJobByItemAndUser('item-1', 'user-a', 'client_stopped')).toBe(true);
        expect(mockPersistence.updateStatus).toHaveBeenCalledTimes(1);
    });

    it('a /j "playback stopped" stops nothing cross-pod when the same item plays on two devices', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const row = (sid: string, deviceId: string) => ({
            play_session_id: sid,
            job_id: `job-${deviceId}`,
            item_id: 'item-1',
            pod_name: 'web-1',
            status: 'running',
            config: { itemId: 'item-1', username: 'user-a', deviceId },
        });
        mockPersistence.getAllActiveJobs.mockResolvedValueOnce([
            row(SESSION, 'tv'),
            row('c3c3c3c3-0000-4000-8000-000000000003', 'phone'),
        ]);

        const stopped = await svc.stopJobByItemAndUser('item-1', 'user-a', 'client_stopped');

        // The report names no device: guessing could hard-stop the live one.
        expect(stopped).toBe(false);
        expect(mockPersistence.updateStatus).not.toHaveBeenCalled();
    });

    // DELETE /j/Videos/ActiveEncodings?PlaySessionId=… — a Jellyfin client
    // cancelling its transcode. Keyed by a client-supplied id, so it must only
    // ever stop the caller's own job, on whichever pod the request lands.
    describe('stopJobForUser', () => {
        beforeEach(() => {
            mockPersistence.getJob.mockReset();
        });

        it("stops the caller's own job on this pod", async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            const { job } = await startWatchedEncodingJob({ clientIdleSeconds: 5 });

            expect(await svc.stopJobForUser(SESSION, 'user-a', 'client_stopped')).toBe(true);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(false);
        });

        it("refuses another user's job on this pod", async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            const { job } = await startWatchedEncodingJob({ clientIdleSeconds: 5 });

            expect(await svc.stopJobForUser(SESSION, 'user-b', 'client_stopped')).toBe(false);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(true);
        });

        it("flags the owner's row when the caller's job lives on another pod", async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            const row = {
                play_session_id: SESSION,
                job_id: 'job-on-peer',
                item_id: 'item-1',
                pod_name: 'web-1',
                status: 'running',
                config: { itemId: 'item-1', username: 'user-a' },
            };
            mockPersistence.getJob.mockResolvedValue(row);

            expect(await svc.stopJobForUser(SESSION, 'user-a', 'client_stopped')).toBe(true);
            expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
                SESSION,
                'stopped',
                expect.stringContaining('client_stopped'),
                false,
            );
        });

        it('leaves a finished row on another pod alone', async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            mockPersistence.getJob.mockResolvedValue({
                play_session_id: SESSION,
                job_id: 'job-on-peer',
                item_id: 'item-1',
                pod_name: 'web-1',
                status: 'error',
                config: { itemId: 'item-1', username: 'user-a' },
            });

            expect(await svc.stopJobForUser(SESSION, 'user-a', 'client_stopped')).toBe(false);
            expect(mockPersistence.updateStatus).not.toHaveBeenCalled();
        });

        // An Android TV audio switch reports the old session Stopped to the pod
        // its IP hashes to, while the job runs on the pod its session hashes to.
        // The DB mark alone took 30-60 s; with a second 4K HDR burn-in starting
        // meanwhile the 4 GiB web pod was OOM-killed (prod 2026-10-02).
        it('a cross-pod stop is broadcast to the owner at once', async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            mockPersistence.getJob.mockResolvedValue({
                play_session_id: SESSION,
                job_id: 'job-on-peer',
                item_id: 'item-1',
                pod_name: 'web-1',
                status: 'running',
                config: { itemId: 'item-1', username: 'user-a' },
            });
            mockPublishMessage.mockClear();

            expect(await svc.stopJobForUser(SESSION, 'user-a', 'client_stopped')).toBe(true);
            expect(mockPublishMessage).toHaveBeenCalledWith(
                'transcode:stop:v1',
                JSON.stringify({ playSessionId: SESSION, reason: 'client_stopped' }),
            );
        });

        it('the owning pod stops its job when the broadcast arrives', async () => {
            const { svc, job } = await startWatchedEncodingJob({ clientIdleSeconds: 5 });
            // Subscribed by the first job this pod started.
            expect(mockSubscribeToChannel).toHaveBeenCalledWith(
                'transcode:stop:v1',
                expect.any(Function),
            );
            const listener = stopChannelListeners.at(-1)!;

            listener(JSON.stringify({ playSessionId: SESSION, reason: 'client_stopped' }));
            await vi.waitFor(() =>
                expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false),
            );
        });

        it('subscribes again on the next job when Valkey was unavailable', async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const internals = svc as any;
            await internals.stopSubscription; // settle whatever an earlier test started
            internals.stopSubscription = null;
            internals.stopUnsubscribe = null;
            mockSubscribeToChannel.mockClear();
            mockSubscribeToChannel.mockResolvedValueOnce(null);

            internals.ensureStopSubscription();
            await internals.stopSubscription;
            expect(internals.stopSubscription).toBeNull();

            internals.ensureStopSubscription();
            await internals.stopSubscription;
            expect(mockSubscribeToChannel).toHaveBeenCalledTimes(2);
            expect(internals.stopUnsubscribe).toEqual(expect.any(Function));
        });

        it('a pod without the job ignores the broadcast (no re-publish loop)', async () => {
            const { svc, job } = await startWatchedEncodingJob({ clientIdleSeconds: 5 });
            const listener = stopChannelListeners.at(-1)!;
            mockPublishMessage.mockClear();
            mockPersistence.getJob.mockClear();

            listener(
                JSON.stringify({
                    playSessionId: 'eeeeeeee-0000-4000-8000-00000000000e',
                    reason: 'client_stopped',
                }),
            );
            listener('not json');
            await new Promise((r) => setTimeout(r, 10));

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
            expect(mockPersistence.getJob).not.toHaveBeenCalled();
            expect(mockPublishMessage).not.toHaveBeenCalled();
        });

        it("refuses another user's job on another pod", async () => {
            const svc = svcModule.getFFmpegTranscodeService();
            mockPersistence.getJob.mockResolvedValue({
                play_session_id: SESSION,
                job_id: 'job-on-peer',
                item_id: 'item-1',
                pod_name: 'web-1',
                status: 'running',
                config: { itemId: 'item-1', username: 'user-b' },
            });

            expect(await svc.stopJobForUser(SESSION, 'user-a', 'client_stopped')).toBe(false);
            expect(mockPersistence.updateStatus).not.toHaveBeenCalled();
        });
    });

    it('a heartbeat for a job owned by another pod is written to the DB row the owner reads', () => {
        const svc = svcModule.getFFmpegTranscodeService();

        svc.recordProgressHeartbeat(SESSION, 'ACTIVE');

        expect(mockPersistence.updateLastProgress).toHaveBeenCalledWith(
            SESSION,
            undefined,
            undefined,
        );
    });

    // /j (Jellyfin-compat) PlaySessionIds are dashless 32-hex. The row's
    // play_session_id is a uuid column, so Postgres hands every one of them back
    // DASHED: each DB-to-memory comparison in the sweep has to fold both spellings
    // to one key, or the /j job is invisible to the arms that read the row.
    describe('a /j session (dashless PlaySessionId)', () => {
        const J_SESSION = '5f0c3a9e2b7d4c1a8e6f0b3d9a2c7e14';
        const J_SESSION_DASHED = '5f0c3a9e-2b7d-4c1a-8e6f-0b3d9a2c7e14';

        function jRow(job: { id: string }, lastProgressAt: Date, extra = {}) {
            return { ...dbRow(job, lastProgressAt), play_session_id: J_SESSION_DASHED, ...extra };
        }

        it('is reaped (dormant, restorable) once its client is gone', async () => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: CLIENT_GONE_S + 30,
                playSessionId: J_SESSION,
            });
            mockPersistence.getJobsByPlaySessions.mockResolvedValue([
                jRow(job, new Date(Date.now() - (CLIENT_GONE_S + 30) * 1000)),
            ]);

            await svc.cleanupInactiveJobs();

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
            expect(mockPersistence.deleteJob).not.toHaveBeenCalled();
            expect(mockPersistence.updateStatus).toHaveBeenCalledWith(
                J_SESSION,
                'stopped',
                undefined,
                true,
                process.env.HOSTNAME || 'unknown',
            );
        });

        it('is kept while its client heartbeats through ANOTHER pod (row read back dashed)', async () => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: CLIENT_GONE_S + 600,
                playSessionId: J_SESSION,
            });
            mockPersistence.getJobsByPlaySessions.mockResolvedValue([
                jRow(job, new Date(Date.now() - 20 * 1000)),
            ]);

            await svc.cleanupInactiveJobs();

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
        });

        it('is torn down by a cross-pod stop flagged on its row', async () => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: 5,
                playSessionId: J_SESSION,
            });
            mockPersistence.getJobsByPlaySessions.mockResolvedValue([
                jRow(job, new Date(), {
                    status: 'stopped',
                    can_restore: false,
                    error_message: 'Stopped by client_stopped from pod web-1',
                }),
            ]);

            await svc.cleanupInactiveJobs();

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
            expect(mockPersistence.deleteJob).toHaveBeenCalled();
        });

        it('is NOT reaped on the client-gone arm when it has no row (it could not be restored)', async () => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: CLIENT_GONE_S + 30,
                playSessionId: J_SESSION,
            });
            // A live session alongside it, so the DB lookup itself succeeds.
            const { job: live } = await startWatchedEncodingJob({ clientIdleSeconds: 5 });
            mockPersistence.getJobsByPlaySessions.mockResolvedValue([dbRow(live, new Date())]);

            await svc.cleanupInactiveJobs();

            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(true);
        });

        // /j progress reports carry only a PlaySessionId in the body; the route
        // passes the caller, so another user cannot keep this job alive.
        it("ignores another user's heartbeat on this pod", async () => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: CLIENT_GONE_S + 30,
                playSessionId: J_SESSION,
            });
            const before = job.lastClientHeartbeatAt.getTime();

            svc.recordProgressHeartbeat(J_SESSION, 'ACTIVE', 'user-b');

            expect(job.lastClientHeartbeatAt.getTime()).toBe(before);
        });

        it("passes the caller to the owner's row for a heartbeat on a non-owner pod", () => {
            const svc = svcModule.getFFmpegTranscodeService();

            svc.recordProgressHeartbeat(J_SESSION, 'ACTIVE', 'user-a');

            expect(mockPersistence.updateLastProgress).toHaveBeenCalledWith(
                J_SESSION,
                undefined,
                'user-a',
            );
        });

        it('is looked up under either spelling (the stop paths hand back the dashed DB id)', async () => {
            const { svc, job } = await startWatchedEncodingJob({
                clientIdleSeconds: 5,
                playSessionId: J_SESSION,
            });

            expect(svc.getJobByPlaySession(J_SESSION_DASHED.toUpperCase())?.id).toBe(job.id);
            expect(await svc.stopJob(J_SESSION_DASHED, 'client_stopped')).toBe(true);
            expect((svc.jobs as Map<string, unknown>).has(job.id)).toBe(false);
        });
    });
});

// ---------------------------------------------------------------------------
// Shared-table labelling: an audiobook remux must not look like a video job
// ---------------------------------------------------------------------------
//
// `active_transcode_jobs` is written by the video pipeline, the music transcode
// path and (now) the audiobook remux. Only the video pipeline has a
// `transcode_decision`, and `classifyTranscodeType` returns 'unknown' without
// one — which the caller's fallback turns into 'full', i.e. a FULL VIDEO
// TRANSCODE badge on a book. That is a correctly-typed, entirely wrong label, and
// it is the class of bug this whole integration keeps producing.
describe('getAllActiveJobsInfoMultiPod — non-video rows', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        const now = new Date('2026-07-30T01:00:00Z');
        return {
            play_session_id: '11111111-1111-4111-8111-111111111111',
            job_id: 'audiobook-remux-9001-t0',
            item_id: '22222222-2222-4222-8222-222222222222',
            user_id: '33333333-3333-4333-8333-333333333333',
            device_id: 'lumastra-web',
            config: {
                type: 'audiobook',
                transcode_mode: 'remux_live',
                source_codec: 'eac3',
                target_codec: 'aac',
                ino: '9001',
                start_seconds: 0,
            },
            output_dir: '(pipe)',
            status: 'running',
            mode: 'full',
            error_message: null,
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: null,
            ffmpeg_pid: 4242,
            created_at: now,
            last_accessed_at: now,
            last_progress_at: now,
            stopped_at: null,
            transcode_decision: null,
            can_restore: false,
            cpu_percent: null,
            memory_mb: null,
            ...overrides,
        };
    }

    beforeEach(async () => {
        vi.resetModules();
        mockPersistence.getAllActiveJobs.mockReset();
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('labels an audiobook remux as audiobook-remux, not as a full video transcode', async () => {
        mockPersistence.getAllActiveJobs.mockResolvedValue([dbRow()]);
        const jobs = await svcModule.getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();

        expect(jobs).toHaveLength(1);
        expect(jobs[0].transcodeType).toBe('audiobook-remux');
        expect(jobs[0].mode).toBe('audiobook-remux');
    });

    it('shows the remux with no video fields invented for it', async () => {
        mockPersistence.getAllActiveJobs.mockResolvedValue([dbRow()]);
        const [job] = await svcModule.getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();

        expect(job.videoCodec).toBeUndefined();
        expect(job.resolution).toBeUndefined();
        // No segments exist, so a progress percentage would be a fiction.
        expect(job.totalSegments).toBe(0);
        expect(job.progressPercent).toBe(0);
        expect(job.transcodeDecision).toBeUndefined();
        expect(job.outputDir).toBe('(pipe)');
        expect(job.processPid).toBe(4242);
    });

    it('still labels a real video job from its decision', async () => {
        // The control. Without it, a change that labelled EVERY row
        // 'audiobook-remux' would pass both cases above.
        mockPersistence.getAllActiveJobs.mockResolvedValue([
            dbRow({
                config: { playSessionId: 'x', totalDurationSeconds: 600 },
                transcode_decision: {
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                },
            }),
        ]);
        const [job] = await svcModule.getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();
        expect(job.transcodeType).toBe('full');
        expect(job.mode).toBe('full');
    });

    it('survives the response schema instead of being stripped at the boundary', async () => {
        // FFmpegJobInfoSchema is what /api/admin/ffmpeg-jobs parses through, so a
        // value missing from the enum is silently dropped and the admin surface
        // shows nothing at all for these rows.
        const { FFmpegJobInfoSchema } = await import('$lib/schemas/admin-types.js');
        mockPersistence.getAllActiveJobs.mockResolvedValue([dbRow()]);
        const [job] = await svcModule.getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();

        const parsed = FFmpegJobInfoSchema.parse(job);
        expect(parsed.mode).toBe('audiobook-remux');
        expect(parsed.transcodeType).toBe('audiobook-remux');
    });

    it('surfaces hdrTonemapMode on a cross-pod (DB-only) job', async () => {
        mockPersistence.getAllActiveJobs.mockResolvedValue([
            dbRow({
                config: { playSessionId: 'cross-pod-tonemap', totalDurationSeconds: 600 },
                transcode_decision: {
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: true,
                    hdrTonemapMode: 'software',
                },
            }),
        ]);
        const [job] = await svcModule.getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();

        expect(job.transcodeDecision?.hdrTonemapMode).toBe('software');
    });

    it('survives the response schema with hdrTonemapMode set', async () => {
        const { FFmpegJobInfoSchema } = await import('$lib/schemas/admin-types.js');
        mockPersistence.getAllActiveJobs.mockResolvedValue([
            dbRow({
                config: { playSessionId: 'cross-pod-tonemap-2', totalDurationSeconds: 600 },
                transcode_decision: {
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: true,
                    hdrTonemapMode: 'software',
                },
            }),
        ]);
        const [job] = await svcModule.getFFmpegTranscodeService().getAllActiveJobsInfoMultiPod();

        const parsed = FFmpegJobInfoSchema.parse(job);
        expect(parsed.transcodeDecision?.hdrTonemapMode).toBe('software');
    });
});

describe('getPlayerTranscodeProgressMultiPod — hdrTonemapMode', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    function dbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        const now = new Date('2026-08-11T01:00:00Z');
        return {
            play_session_id: 'multipod-tonemap-session',
            job_id: 'job-multipod-tonemap',
            item_id: '22222222-2222-4222-8222-222222222222',
            user_id: '33333333-3333-4333-8333-333333333333',
            device_id: 'lumastra-web',
            config: { playSessionId: 'multipod-tonemap-session', totalDurationSeconds: 600 },
            output_dir: '/tmp/out',
            status: 'running',
            mode: 'full',
            error_message: null,
            segment_offset: 0,
            segments_ready: 5,
            master_playlist_ready: true,
            pod_name: 'other-pod',
            ffmpeg_pid: null,
            created_at: now,
            last_accessed_at: now,
            last_progress_at: now,
            stopped_at: null,
            transcode_decision: null,
            can_restore: false,
            cpu_percent: null,
            memory_mb: null,
            ...overrides,
        };
    }

    beforeEach(async () => {
        vi.resetModules();
        mockPersistence.getJob.mockReset();
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        mockPersistence.getJob.mockResolvedValue(null);
        vi.clearAllMocks();
    });

    it('surfaces hdrTonemapMode for a cross-pod job via the multi-pod progress read', async () => {
        mockPersistence.getJob.mockResolvedValue(
            dbRow({
                transcode_decision: {
                    videoAction: 'transcode',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: true,
                    hdrTonemapMode: 'software',
                },
            }),
        );
        const progress = await svcModule
            .getFFmpegTranscodeService()
            .getPlayerTranscodeProgressMultiPod('multipod-tonemap-session');

        expect(progress?.hdrTonemapMode).toBe('software');
    });

    it('reads one row plus the owner pod stats — speed, throttle state, absolute segments', async () => {
        const { readJobStats } = await import('./transcoding/ffmpeg-stats-cache.js');
        vi.mocked(readJobStats).mockResolvedValueOnce({
            transcodeFps: 48,
            transcodeSpeed: 2,
            throttled: true,
            bufferAheadSeconds: 130.4,
            timestamp: Date.now(),
        });
        mockPersistence.getJob.mockResolvedValue(
            dbRow({
                // Seeked to 300 s: FFmpeg started at segment 50 and made 10 since.
                segment_offset: 50,
                segments_ready: 10,
                config: {
                    playSessionId: 'multipod-tonemap-session',
                    totalDurationSeconds: 600,
                    segmentDurationSeconds: 6,
                },
            }),
        );

        const progress = await svcModule
            .getFFmpegTranscodeService()
            .getPlayerTranscodeProgressMultiPod('multipod-tonemap-session');

        expect(mockPersistence.getJob).toHaveBeenCalledWith('multipod-tonemap-session');
        expect(vi.mocked(readJobStats)).toHaveBeenCalledWith('job-multipod-tonemap');
        expect(progress).toMatchObject({
            // Coverage, not position: only 300–360 s was encoded.
            progressPercent: 10,
            segmentsReady: 10,
            totalSegments: 100,
            coveredRanges: [{ start: 50, end: 60 }],
            encoderPercent: 60,
            fps: 48,
            speed: 2,
            throttled: true,
            bufferAheadSeconds: 130,
            // (600 - 360) media seconds left at 2x
            etaSeconds: 120,
        });
    });

    it("adds earlier generations' ranges from the row's persisted config", async () => {
        mockPersistence.getJob.mockResolvedValue(
            dbRow({
                segment_offset: 50,
                segments_ready: 10,
                config: {
                    playSessionId: 'multipod-tonemap-session',
                    totalDurationSeconds: 600,
                    segmentDurationSeconds: 6,
                    coveredRanges: [[0, 120]],
                },
            }),
        );
        const progress = await svcModule
            .getFFmpegTranscodeService()
            .getPlayerTranscodeProgressMultiPod('multipod-tonemap-session');
        expect(progress).toMatchObject({
            progressPercent: 30,
            coveredRanges: [
                { start: 0, end: 20 },
                { start: 50, end: 60 },
            ],
        });
    });

    it('the encoder reads 100 % only at the real end — never rounded up', async () => {
        mockPersistence.getJob.mockResolvedValue(
            dbRow({
                segment_offset: 0,
                // 7199 of 7200 s: 99.986 % would round to 100.0 and stop the poll
                segments_ready: 7199,
                config: {
                    playSessionId: 'multipod-tonemap-session',
                    totalDurationSeconds: 7200,
                    segmentDurationSeconds: 1,
                },
            }),
        );
        const progress = await svcModule
            .getFFmpegTranscodeService()
            .getPlayerTranscodeProgressMultiPod('multipod-tonemap-session');
        expect(progress?.encoderPercent).toBe(99.9);
        expect(progress?.progressPercent).toBe(99);
    });

    it('reports nothing for a row that is no longer running', async () => {
        mockPersistence.getJob.mockResolvedValue(dbRow({ status: 'stopped' }));
        const progress = await svcModule
            .getFFmpegTranscodeService()
            .getPlayerTranscodeProgressMultiPod('multipod-tonemap-session');
        expect(progress).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Transcode throttle — SIGSTOP/SIGCONT driven by the lead over the player
// ---------------------------------------------------------------------------
describe('transcode throttle', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    const SESSION = 'c0ffee00-0000-4000-8000-0000000000a1';

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        (mockCfg as Record<string, unknown>).TRANSCODE_THROTTLE = true;
        (mockCfg as Record<string, unknown>).THROTTLE_AFTER_SECONDS = 120;
        mockPersistence.getJobsByPlaySessions.mockResolvedValue([]);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockResolvedValue(undefined);
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        delete (mockCfg as Record<string, unknown>).TRANSCODE_THROTTLE;
        delete (mockCfg as Record<string, unknown>).THROTTLE_AFTER_SECONDS;
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    /** A running job whose FFmpeg has produced 300 s (50 × 6 s segments). */
    async function startRunningJob() {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: SESSION, totalDurationSeconds: 3000 }),
        );
        const kill = vi.fn().mockReturnValue(true);
        job.process = {
            pid: 4242,
            exitCode: null,
            signalCode: null,
            killed: false,
            kill,
        } as unknown as TranscodeJob['process'];
        job.status = 'running';
        job.segmentOffset = 0;
        job.segmentDurationSeconds = 6;
        job.segmentsReady = 50;
        return { svc, job, kill };
    }

    it('pauses FFmpeg once it is more than THROTTLE_AFTER_SECONDS ahead of the player', async () => {
        const { svc, job, kill } = await startRunningJob();

        // Player requested segment 9 → media up to 60 s; FFmpeg is 240 s ahead.
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);

        expect(kill).toHaveBeenCalledWith('SIGSTOP');
        expect(job.throttledAt).toBeInstanceOf(Date);
        expect(job.throttlePaused).toBe(true);
        expect(svc.getPlayerTranscodeProgress(SESSION)).toMatchObject({
            throttled: true,
            bufferAheadSeconds: 240,
        });
    });

    it('stays running while the lead is within the threshold', async () => {
        const { svc, job, kill } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 29, 6, true); // 180 s → 120 s ahead
        expect(kill).not.toHaveBeenCalled();
        expect(job.throttledAt).toBeUndefined();
        expect(job.throttlePaused).toBe(false);
    });

    it('resumes only below half the threshold (hysteresis), refreshing lastProgressAt', async () => {
        const { svc, job, kill } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        kill.mockClear();
        job.lastProgressAt = new Date(Date.now() - 10 * 60 * 1000);

        svc.recordSegmentRequestForJob(job, 'stream_0', 39, 6, true); // 60 s ahead
        expect(kill).not.toHaveBeenCalled();

        svc.recordSegmentRequestForJob(job, 'stream_0', 40, 6, true); // 54 s ahead
        expect(kill).toHaveBeenCalledWith('SIGCONT');
        expect(job.throttledAt).toBeUndefined();
        expect(job.throttlePaused).toBe(false);
        expect(Date.now() - job.lastProgressAt.getTime()).toBeLessThan(1000);
    });

    it('resumes at once when the player asks for a segment that is not on disk yet', async () => {
        const { svc, job, kill } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        kill.mockClear();

        // A lead the throttle would still pause at — but the player is waiting.
        svc.recordSegmentRequestForJob(job, 'stream_1', 10, 6, false);

        expect(kill).toHaveBeenCalledWith('SIGCONT');
        expect(job.throttledAt).toBeUndefined();
    });

    it('does not re-pause for 30 s after a request had to wait for FFmpeg', async () => {
        const { svc, job, kill } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        svc.recordSegmentRequestForJob(job, 'stream_1', 10, 6, false);
        expect(kill).toHaveBeenLastCalledWith('SIGCONT');

        // The lead still reads 240 s — a mis-measurement the request disproved.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(kill).toHaveBeenLastCalledWith('SIGCONT');

        await vi.advanceTimersByTimeAsync(22_000);
        expect(kill).toHaveBeenLastCalledWith('SIGSTOP');
    });

    it('a resume restarts the speed window so the pause is not measured', async () => {
        const { svc, job } = await startRunningJob();
        job.rateSample = { measured: true, anchor: { at: Date.now(), mediaSeconds: 300 } };
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        svc.recordSegmentRequestForJob(job, 'stream_0', 45, 6, true);
        expect(job.rateSample).toEqual({ measured: true });
    });

    it('measures the player by the stream furthest along', async () => {
        const { svc, job, kill } = await startRunningJob();
        // Video near the encoder, then a lagging audio request: the video stream
        // still decides, so the 20 s lead does not turn into a 294 s one.
        svc.recordSegmentRequestForJob(job, 'stream_0', 27, 10, true); // 280 s
        svc.recordSegmentRequestForJob(job, 'stream_1', 0, 6, true); // 6 s
        expect(kill).not.toHaveBeenCalled();
    });

    it('does nothing with the throttle disabled, and releases a paused job when it is', async () => {
        const { svc, job, kill } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        expect(kill).toHaveBeenCalledWith('SIGSTOP');

        (mockCfg as Record<string, unknown>).TRANSCODE_THROTTLE = false;
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        expect(kill).toHaveBeenLastCalledWith('SIGCONT');
        expect(job.throttledAt).toBeUndefined();
    });

    it('the 2 s tick pauses a job whose player stopped requesting segments', async () => {
        const { job, kill } = await startRunningJob();
        (job.requestedMediaSeconds ??= new Map()).set('stream_0', 60);
        await vi.advanceTimersByTimeAsync(2000);
        expect(kill).toHaveBeenCalledWith('SIGSTOP');
    });

    it('never throttles before the player requested anything', async () => {
        const { job, kill } = await startRunningJob();
        await vi.advanceTimersByTimeAsync(2000);
        expect(kill).not.toHaveBeenCalled();
        expect(job.throttledAt).toBeUndefined();
    });

    it.each([
        ['a seek in flight', { isSeeking: true }],
        ['a stop already requested', { killRequested: true }],
        ['a retired generation', { generationRole: 'previous' }],
        ['a cache-backed preview', { config: { cacheKey: 'preview-cache-x' } }],
        ['a preview job', { config: { isPreview: true } }],
        ['a job still starting', { status: 'starting' }],
    ])('never pauses %s, and releases one that was paused', async (_label, patch) => {
        const { svc, job, kill } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        expect(kill).toHaveBeenLastCalledWith('SIGSTOP');

        const { config: configPatch, ...jobPatch } = patch as Record<string, unknown>;
        Object.assign(job, jobPatch);
        if (configPatch) Object.assign(job.config, configPatch);
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);

        expect(kill).toHaveBeenLastCalledWith('SIGCONT');
        expect(job.throttledAt).toBeUndefined();
        expect(kill.mock.calls.filter(([sig]) => sig === 'SIGSTOP')).toHaveLength(1);
    });

    it('a respawned process starts unthrottled', async () => {
        const { job } = await startRunningJob();
        job.throttledAt = new Date();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svcModule.getFFmpegTranscodeService() as any).spawnFFmpeg(job);
        expect(job.throttledAt).toBeUndefined();
    });

    it('publishes the live readings the other pod shows the player', async () => {
        const { svc, job } = await startRunningJob();
        job.transcodeFps = 48;
        job.transcodeSpeed = 2;
        job.config.softwareEncodeFallback = 'hevc_nvenc';
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        const { publishJobStats } = await import('./transcoding/ffmpeg-stats-cache.js');
        vi.mocked(publishJobStats).mockClear();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).publishResourceStats();

        expect(vi.mocked(publishJobStats)).toHaveBeenCalledWith(
            job.id,
            expect.objectContaining({
                transcodeFps: 48,
                transcodeSpeed: 2,
                throttled: true,
                bufferAheadSeconds: 240,
                // Paused by the throttle, so not slow; the fallback travels.
                slowReason: undefined,
                softwareFallbackFrom: 'hevc_nvenc',
            }),
        );
    });

    it('the reaper keeps a paused job alive while its client is', async () => {
        const { svc, job } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);
        expect(job.throttledAt).toBeDefined();

        // FFmpeg has been stopped for 10 minutes, so its own progress is stale —
        // but the client heartbeated just now.
        job.lastProgressAt = new Date(Date.now() - 10 * 60 * 1000);
        job.lastClientHeartbeatAt = new Date();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(true);
    });

    it('the reaper still stops a paused job whose client is gone', async () => {
        const { svc, job } = await startRunningJob();
        svc.recordSegmentRequestForJob(job, 'stream_0', 9, 6, true);

        const longAgo = new Date(Date.now() - 10 * 60 * 1000);
        job.lastProgressAt = longAgo;
        job.lastClientHeartbeatAt = longAgo;
        job.lastAccessedAt = longAgo;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).cleanupInactiveJobs();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(((svc as any).jobs as Map<string, unknown>).has(job.id)).toBe(false);
    });
});

describe('classifyTranscodeType', () => {
    it("returns 'audio-drop' when video is disabled", () => {
        expect(classifyTranscodeType(undefined, 'transcode', false, true)).toBe('audio-drop');
    });

    it("still returns 'audio-only' for copied video with transcoded audio", () => {
        expect(classifyTranscodeType('copy', 'transcode', false, false)).toBe('audio-only');
    });
});

// ---------------------------------------------------------------------------
// shouldReapJob — audio-drop retention across a tunnel / a satisfied buffer
// ---------------------------------------------------------------------------
//
// A pure function (no timers, no job map, no service singleton) so these
// fixtures pin exact ages against the mocked config values above:
// FFMPEG_PROGRESS_TIMEOUT_SECONDS=120, FFMPEG_INACTIVITY_TIMEOUT_SECONDS=300,
// FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS=1800. Every fixture here is
// chosen to fall on a DIFFERENT side of the normal (120/300) timeouts than of
// the audio-drop (1800) timeout, so a fixture that coincided with defaults
// could not accidentally make a broken branch look green.
function makeReapCandidate(overrides: Partial<ReapCandidate> = {}): ReapCandidate {
    return {
        mode: 'full',
        completed: false,
        progressAgeSeconds: 0,
        segmentAgeSeconds: 0,
        ...overrides,
    };
}

describe('audio-drop job retention', () => {
    it('survives the normal progress timeout', () => {
        expect(
            shouldReapJob(
                makeReapCandidate({
                    mode: 'audio-drop',
                    progressAgeSeconds: 200,
                    segmentAgeSeconds: 200,
                }),
            ),
        ).toBe(false);
    });

    it('reaps an ordinary job at the normal progress timeout', () => {
        expect(
            shouldReapJob(
                makeReapCandidate({
                    mode: 'full',
                    progressAgeSeconds: 200,
                    segmentAgeSeconds: 200,
                }),
            ),
        ).toBe(true);
    });

    it('survives a satisfied deep buffer (no segment fetches)', () => {
        // Asymmetric on purpose: a satisfied deep buffer means segment fetches
        // stop while progress heartbeats keep arriving — fresh progress, stale
        // segments. Equal ages (as in the tunnel test above) would pass this
        // assertion even if the audio-drop branch's `&&` were weakened to `||`,
        // since three of the four cases in this suite keep the two ages equal.
        // Only an asymmetric fixture proves segment staleness ALONE can't reap.
        expect(
            shouldReapJob(
                makeReapCandidate({
                    mode: 'audio-drop',
                    progressAgeSeconds: 30,
                    segmentAgeSeconds: 2000,
                }),
            ),
        ).toBe(false);
    });

    it('is eventually reaped', () => {
        expect(
            shouldReapJob(
                makeReapCandidate({
                    mode: 'audio-drop',
                    progressAgeSeconds: 2000,
                    segmentAgeSeconds: 2000,
                }),
            ),
        ).toBe(true);
    });
});

// ===========================================================================
// Audio-only (video-dropped) job started at a SEEK offset
// ===========================================================================
//
// Regression guard for "switching to the Audio only rung mid-playback never
// starts playing" (readyState 0, every segment 503s forever).
//
// The audio-only rung reuses the SAME PlaybackPlan as every other play method,
// so on a direct-play-capable source the job is handed `videoAction: 'copy'` —
// describing a video stream `-vn` has already removed from the output.
// buildAudioOnlyArgs ignores that and emits the transcode output shape
// (`-start_number <segmentOffset>`, uniform grid), but startJob's copy-mode
// branches used the stale 'copy' to switch the job to a 10s keyframe grid and a
// KEYFRAME-space offset, and the segment handler then subtracted that offset
// again. FFmpeg wrote segment_00001… while the handler looked for
// segment_00000 — a file no generation ever contains.
//
// The invariant these tests pin: for a video-dropped job the segment geometry
// must stay UNIFORM, and the file index the segment handler resolves must equal
// the manifest index the client asked for (because `-start_number` already
// carries the offset).
describe('audio-only job with a seek offset — segment geometry', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let stateModule: typeof import('./hls/segment-request-state.js');

    // 14.796303 is the live playhead from the browser repro; the uniform 6s
    // grid puts it in segment 2 (12.0s–18.0s).
    const SEEK_SECONDS = 14.796303;

    const makeAudioOnlyConfig = (playSessionId: string): TranscodeJobConfig =>
        makeHandleExitTestConfig({
            playSessionId,
            videoDisabled: true,
            startTimeSeconds: SEEK_SECONDS,
            totalDurationSeconds: 600,
            // Keyframes every ~4.6s — deliberately NOT aligned to either the 6s
            // or the 10s grid, so a keyframe-space offset is distinguishable
            // from the uniform one.
            keyframeData: Array.from({ length: 130 }, (_, i) => +(i * 4.6).toFixed(3)),
            hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
            audioTracks: [
                {
                    index: asAbsoluteStreamIndex(1),
                    displayTitle: 'English',
                    language: 'eng',
                    channels: 2,
                    codec: 'aac',
                    isDefault: true,
                },
            ],
            // consumePlan is only consulted when BOTH are present.
            mediaSourceInfo: { streams: [] } as unknown as TranscodeJobConfig['mediaSourceInfo'],
            playbackPlan: {
                plan_id: 'plan-1',
                video_action: 'copy',
            } as unknown as TranscodeJobConfig['playbackPlan'],
        });

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();

        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );

        // The plan the audio-only rung reuses was built for direct play, so it
        // says the video is copied — the exact input that broke the rung.
        const transcoding = await import('./transcoding/index.js');
        vi.mocked(transcoding.transcodeDecision.consumePlan).mockResolvedValue({
            mode: 'remux',
            videoAction: 'copy',
            audioAction: 'transcode',
            useGpu: false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        svcModule = await import('./ffmpeg-transcode.service.js');
        stateModule = await import('./hls/segment-request-state.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('keeps the uniform segment grid instead of the copy-mode 10s keyframe grid', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeAudioOnlyConfig('audio-only-grid'));

        expect(job.segmentDurationSeconds).toBe(6);
        // Snapped to the uniform grid, NOT to a 4.6s keyframe boundary.
        expect(job.config.startTimeSeconds).toBe(12);
        expect(job.segmentOffset).toBe(2);
    });

    it('reconciles the decision so nothing downstream reads it as copy-mode video', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeAudioOnlyConfig('audio-only-decision'));

        expect(job.transcodeDecisionResult?.videoAction).toBe('transcode');
    });

    it('resolves the requested manifest index to the file FFmpeg actually writes', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(makeAudioOnlyConfig('audio-only-mapping'));

        // FFmpeg is spawned with `-start_number <job.segmentOffset>` (audio-only
        // always takes the transcode output tail), so its first file is
        // segment_0000<offset> and file index == manifest index from there on.
        const requestedSegmentNum = job.segmentOffset;
        const state = stateModule.buildHlsSegmentRequestState({
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
        });

        expect(state.actualSegmentIndex).toBe(requestedSegmentNum);
        // A seek far ahead resolves the same way: the offset is never
        // subtracted twice.
        const ahead = stateModule.buildHlsSegmentRequestState({
            job,
            segmentInfo: { streamDir: '', segmentIndex: 60 },
            isSegment: true,
            requestedSegmentNum: 60,
            adapter: {
                getSegmentOffsetForJob: (j) => svc.getSegmentOffsetForJob(j),
                getStreamSegmentOffsetForJob: (j, dir) => svc.getStreamSegmentOffsetForJob(j, dir),
                getStreamTargetDurationForJob: (j, dir) =>
                    svc.getStreamTargetDurationForJob(j, dir),
                canStreamTriggerSeekForJob: (j, dir) => svc.canStreamTriggerSeekForJob(j, dir),
                isSegmentDeletedForJob: () => false,
            },
        });
        expect(ahead.actualSegmentIndex).toBe(60);
        // The muxed audio-only stream is authoritative for seeking — otherwise a
        // backward seek would fast-bail as a non-authoritative negative index.
        expect(ahead.canSeek).toBe(true);
    });
});

describe('canStreamTriggerSeekForJob — video-dropped flat stream', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.resetModules();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockResolvedValue(undefined);
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('is authoritative even when the config still carries the plan’s demux', async () => {
        // An audio-only job restored from a row written by an older build (or
        // any path that skipped the muxed pin) keeps hlsAudioMode: 'demux'. Its
        // output is still a single flat rendition, so the flat stream must stay
        // authoritative — otherwise no seek can ever be triggered from it and a
        // backward seek hangs on segments no generation holds.
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'audio-only-demux-config',
                videoDisabled: true,
                hlsOutput: { hlsAudioMode: 'demux' },
            }),
        );

        expect(svc.canStreamTriggerSeekForJob(job, '')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// selectEvictionVictim — global/per-user cap eviction picks the candidate
// idlest on BOTH signals (active-heartbeat recency AND segment-fetch
// recency), not either signal alone
// ---------------------------------------------------------------------------
//
// Prod 2026-08-22 (Stromberg S2E6): a session that had buffered several
// minutes of HLS segments ahead went quiet on segment requests for a couple
// of minutes while still very much playing (heartbeat every ~10s, never
// stale) — and was picked as "least recently used" and evicted anyway,
// because the old sort used only `lastAccessedAt` (segment-fetch time).
//
// A pure heartbeat-recency sort has its own failure mode two ways:
//   - a heartbeat fires every ~10s even while PAUSED (by design, so a pause
//     doesn't get the job reaped) — `lastActiveProgressAt` must NOT advance
//     on those, or a long-paused session becomes permanently un-evictable.
//   - a client whose play session never sends our heartbeat at all (e.g. a
//     Jellyfin-compat client with its own reporting) has a `lastActiveProgressAt`
//     frozen at job creation forever — it must not become the perpetual
//     first victim just because segment fetches are the only signal moving.
//
// selectEvictionVictim takes max(lastActiveProgressAt, lastAccessedAt) per
// candidate and evicts the smallest — either signal alone can protect a
// candidate that's genuinely alive.
function makeEvictionCandidate(overrides: Partial<EvictionCandidate> = {}): EvictionCandidate {
    return {
        lastActiveProgressAt: new Date(0),
        lastAccessedAt: new Date(0),
        ...overrides,
    };
}

describe('selectEvictionVictim', () => {
    it('protects a buffered-ahead session (stale segments, fresh heartbeat) over one stale on both', () => {
        // The exact prod shape: this session's segment fetches went quiet
        // (buffered ahead) but its heartbeat never stopped — it must survive
        // eviction pressure over a session that is stale on EVERY signal.
        const bufferedAheadButAlive = makeEvictionCandidate({
            lastActiveProgressAt: new Date(1_000_000), // heartbeat just now
            lastAccessedAt: new Date(0), // segments fetched a while ago
        });
        const genuinelyIdle = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0), // heartbeat stale
            lastAccessedAt: new Date(0), // segments stale too — no signal says "alive"
        });

        const victim = selectEvictionVictim([bufferedAheadButAlive, genuinelyIdle]);

        expect(victim).toBe(genuinelyIdle);
    });

    it('protects a candidate via EITHER signal, and picks the one stale on both', () => {
        const staleOnBoth = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0),
            lastAccessedAt: new Date(0),
        });
        const freshSegments = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0),
            lastAccessedAt: new Date(1000),
        });

        expect(selectEvictionVictim([freshSegments, staleOnBoth])).toBe(staleOnBoth);
    });

    it('a long-paused session (frozen active-heartbeat, no segment fetches) ages into eviction normally', () => {
        // Mirrors what recordProgressHeartbeat actually does across a pause:
        // it keeps calling with status 'PAUSED', which leaves
        // lastActiveProgressAt untouched — so it must NOT look freshest just
        // because SOME heartbeat (tracked elsewhere, not by this function)
        // kept arriving.
        const longPaused = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0), // last ACTIVE heartbeat, long ago
            lastAccessedAt: new Date(0), // no segment fetches while paused
        });
        const activelyWatching = makeEvictionCandidate({
            lastActiveProgressAt: new Date(500),
            lastAccessedAt: new Date(0),
        });

        expect(selectEvictionVictim([activelyWatching, longPaused])).toBe(longPaused);
    });

    it('a session whose client never sends our heartbeat is protected by segment fetches alone', () => {
        // e.g. a Jellyfin-compat client using Jellyfin's own session
        // reporting instead of ours — lastActiveProgressAt stays frozen at
        // job creation (0) forever, but it is still very much streaming.
        const neverHeartbeatsButStreaming = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0),
            lastAccessedAt: new Date(1_000_000),
        });
        const genuinelyIdle = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0),
            lastAccessedAt: new Date(0),
        });

        expect(selectEvictionVictim([neverHeartbeatsButStreaming, genuinelyIdle])).toBe(
            genuinelyIdle,
        );
    });

    it('returns undefined for an empty candidate list', () => {
        expect(selectEvictionVictim([])).toBeUndefined();
    });

    it('does not mutate the input array order', () => {
        const a = makeEvictionCandidate({ lastActiveProgressAt: new Date(100) });
        const b = makeEvictionCandidate({ lastActiveProgressAt: new Date(0) });
        const candidates = [a, b];

        selectEvictionVictim(candidates);

        expect(candidates).toEqual([a, b]);
    });
});

// ---------------------------------------------------------------------------
// filterEvictableByIdle — the global cap may only sacrifice an idle job
// ---------------------------------------------------------------------------
//
// selectEvictionVictim answers "which job dies", never "should ANY job die".
// Without the floor a viewer mid-episode lost their stream the moment someone
// else pressed play, and their client's rebuild evicted the next viewer.
describe('filterEvictableByIdle', () => {
    const now = 1_000_000;

    it('excludes a job still fetching segments, however stale its heartbeat', () => {
        const streaming = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0),
            lastAccessedAt: new Date(now - 5_000),
        });
        expect(filterEvictableByIdle([streaming], 120, now)).toEqual([]);
    });

    it('excludes a job still heartbeating, however long since its last segment fetch', () => {
        const heartbeating = makeEvictionCandidate({
            lastActiveProgressAt: new Date(now - 5_000),
            lastAccessedAt: new Date(0),
        });
        expect(filterEvictableByIdle([heartbeating], 120, now)).toEqual([]);
    });

    it('includes a job past the floor on both signals, and one exactly at it', () => {
        const idle = makeEvictionCandidate({
            lastActiveProgressAt: new Date(now - 300_000),
            lastAccessedAt: new Date(now - 300_000),
        });
        const atFloor = makeEvictionCandidate({
            lastActiveProgressAt: new Date(now - 120_000),
            lastAccessedAt: new Date(now - 120_000),
        });
        expect(filterEvictableByIdle([idle, atFloor], 120, now)).toEqual([idle, atFloor]);
    });

    it('excludes a job whose client is active through another pod (DB row activity)', () => {
        const watchingViaOtherPod = makeEvictionCandidate({
            lastActiveProgressAt: new Date(0),
            lastAccessedAt: new Date(0),
            lastPersistedClientActivityAt: new Date(now - 10_000),
        });
        expect(filterEvictableByIdle([watchingViaOtherPod], 120, now)).toEqual([]);
    });

    it('disables the floor at 0 or below (legacy always-evict)', () => {
        const active = makeEvictionCandidate({
            lastActiveProgressAt: new Date(now),
            lastAccessedAt: new Date(now),
        });
        expect(filterEvictableByIdle([active], 0, now)).toEqual([active]);
        expect(filterEvictableByIdle([active], -1, now)).toEqual([active]);
    });

    it('does not mutate the input array', () => {
        const a = makeEvictionCandidate({ lastAccessedAt: new Date(now) });
        const b = makeEvictionCandidate({ lastAccessedAt: new Date(0) });
        const candidates = [a, b];
        filterEvictableByIdle(candidates, 120, now);
        expect(candidates).toEqual([a, b]);
    });
});

// ---------------------------------------------------------------------------
// restoreJob — session keying + already-complete output
// ---------------------------------------------------------------------------
//
// Prod 2026-08-28 (South Harbor S11E8, Lumastra iOS): the picture froze 5-10s
// while audio and the progress bar ran on. Root cause chain:
//
//   Swift's `UUID().uuidString` is UPPERCASE and that is the id every segment
//   request carries. `active_transcode_jobs.play_session_id` is a `uuid`
//   COLUMN, so Postgres hands it back lowercased. restoreJob registered the
//   in-memory job under the lowercase DB value, so every later lookup —
//   keyed on the uppercase request id — missed FOREVER ("Job not in memory,
//   checking database" on every single segment). That forced every request
//   down the DB path, where one failed `fileExists` escalates straight into
//   restoreJob -> spawnFFmpeg, rewriting all 133 segments from index 0 on a
//   job that was already complete. Measured: segmentsReady 133 -> 0 -> 133 and
//   `Segment ready after FFmpeg restart {"waitMs":8018}`.
describe('restoreJob — session keying and already-complete output', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    const CLIENT_SESSION = 'D2F5FA02-B977-493E-B054-7DC08CD42144';
    const DB_SESSION = CLIENT_SESSION.toLowerCase();

    function makeMetadata(overrides: Record<string, unknown> = {}) {
        return {
            play_session_id: DB_SESSION,
            job_id: '167d1a1d-64f3-4488-a628-ba4613ead4ee',
            item_id: 'item-1',
            user_id: 'user-1',
            device_id: 'device-1',
            config: {
                playSessionId: CLIENT_SESSION,
                itemId: 'item-1',
                username: 'user-a',
                deviceId: 'device-1',
                inputUrl: 'http://localhost/stream',
                audioTracks: [],
                totalDurationSeconds: 1326.848,
                segmentDurationSeconds: 10,
            },
            output_dir: `/tmp/transcode-test/${CLIENT_SESSION}/gen-0001`,
            status: 'running',
            mode: 'full' as const,
            error_message: null,
            segment_offset: 0,
            segments_ready: 133,
            master_playlist_ready: true,
            pod_name: 'a78b6ab6fcda',
            ffmpeg_pid: null,
            created_at: new Date(),
            last_accessed_at: new Date(),
            last_progress_at: new Date(),
            stopped_at: null,
            transcode_decision: null,
            can_restore: true,
            cpu_percent: null,
            memory_mb: null,
            ...overrides,
        };
    }

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockFileManager.isOutputComplete.mockReset();
        mockFileManager.isOutputComplete.mockResolvedValue(false);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(async () => {
        vi.clearAllMocks();
        await removeStampedFixtures();
    });

    it('makes a restored job findable by the id the client actually requests with', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(makeMetadata() as any);

        expect(svc.getJobByPlaySession(CLIENT_SESSION)).toBeDefined();
    });

    it('does not respawn FFmpeg when the output is complete and the segment is on disk', async () => {
        // Reached when the segment EXISTS but reading it threw (transient IO).
        // Respawning would rewrite all 133 segments from index 0 underneath a
        // client mid-playback, for a file that is already sitting right there.
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata();
        await stampFixtureOutput(metadata);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(metadata as any, { segmentPresentOnDisk: true });

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
    });

    it('DOES restart FFmpeg when the segment is missing even though the manifest is complete', async () => {
        // `slidingWindowCleanup` prunes segments behind the playhead for jobs in
        // status 'ready', so a COMPLETE manifest (ENDLIST on every stream) can
        // legitimately be missing early segments. Seeking back into that gap is
        // the one case where respawning is genuinely required — adopting here
        // would strand the request until `waitForRestoredSegment` times out and
        // turn a recoverable seek into a 503.
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(makeMetadata() as any, { segmentPresentOnDisk: false });

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalled();
    });

    it('rebuilds the absolute GOP grid and preserves the offset when adopting completed output', async () => {
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata({ segment_offset: 2 });
        const keyframes = [0, 3.5, 13.25, 14, 27.875, 31, 52, 63.75];
        const gopMetadata = {
            ...metadata,
            config: {
                ...metadata.config,
                gopSegments: true,
                keyframeData: keyframes,
                totalDurationSeconds: 70,
                startTimeSeconds: 28.375,
            },
        };
        await stampFixtureOutput(gopMetadata);

        const job = await svc.restoreJob(gopMetadata as PersistedJobMetadata, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 2,
        });

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
        expect(job.status).toBe('ready');
        expect(job.segmentOffset).toBe(2);
        expect(job.config.startTimeSeconds).toBe(28.375);
        expect(svc.getGopGrid(job)?.starts).toEqual([0, 13.25, 27.875, 31, 52, 63.75]);
        expect(job.segmentsReady).toBe(4);
        expect(svc.getStreamSegmentOffsetForJob(job, 'stream_0')).toBe(2);
    });

    // Prod 2026-10-15 (The Middle S05E20, GOP demux copy job): a rolling restart
    // moved the client to web-1 while web-0's FFmpeg was still writing into the
    // shared gen-0001. web-1 respawned into that same directory, web-0 dropped a
    // part ~80 keyframes in, and web-1's assembler saw content past entry 0 with
    // no part on entry 0's keyframe: "refusing to build a shifted segment",
    // GOP mode tripped for the title.
    it('respawns a takeover from a live peer into a fresh generation directory', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata({ pod_name: 'lumastra-web-0' });
        await stampFixtureOutput(metadata);
        const sessionDir = path.dirname(metadata.output_dir);
        // A later generation the peer may have started without persisting it.
        await fs.mkdir(path.join(sessionDir, 'gen-0003'));

        const job = await svc.restoreJob(metadata as PersistedJobMetadata, {
            segmentPresentOnDisk: false,
            requiredSegmentIndex: 71,
            previousOwnerMayStillWrite: true,
        });

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalled();
        expect(job.outputDir).toBe(path.join(sessionDir, 'gen-0004'));
        expect(job.generationIndex).toBe(4);
        expect(job.outputDir).not.toBe(metadata.output_dir);
    });

    it('keeps the persisted directory for a restore with no live previous owner', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata();
        await stampFixtureOutput(metadata);

        const job = await svc.restoreJob(metadata as PersistedJobMetadata, {
            segmentPresentOnDisk: false,
        });

        expect(job.outputDir).toBe(metadata.output_dir);
        expect(job.generationIndex).toBe(1);
    });

    it('still adopts complete output in place after a takeover (nothing is respawned)', async () => {
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata();
        await stampFixtureOutput(metadata);

        const job = await svc.restoreJob(metadata as PersistedJobMetadata, {
            segmentPresentOnDisk: true,
            previousOwnerMayStillWrite: true,
        });

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
        expect(job.outputDir).toBe(metadata.output_dir);
    });

    it('marks a restored-from-complete-output job ready with every segment counted', async () => {
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata();
        await stampFixtureOutput(metadata);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(metadata as any, { segmentPresentOnDisk: true });

        expect(job.status).toBe('ready');
        // ceil(1326.848 / 10) — the same total handleExit stamps on completion,
        // so a served-from-disk restore reports 100% instead of a stale 0.
        expect(job.segmentsReady).toBe(133);
    });

    it('does not treat the files of an adopted complete output as older than a spawn that never happened', async () => {
        // The stale-segment guard rejects files whose mtime predates the job's
        // lastFFmpegSpawnTime. An adopted job spawns nothing, so its spawn time must
        // not be "now" — that would refuse every file it adopted.
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata();
        await stampFixtureOutput(metadata);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(metadata as any, { segmentPresentOnDisk: true });

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
        expect(job.lastFFmpegSpawnTime).toBe(0);
        expect(job.previousFFmpegSpawnTime).toBeNull();
    });

    it('backfills the session id onto a restored config that predates the field', async () => {
        // Older rows persisted a `config` JSONB without `playSessionId`. The
        // teardown path (`retireJobGeneration`) and handleExit's
        // `persistence.updateProgress` both read it straight off the config, so
        // leaving it undefined sends an undefined id to the database.
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata();
        delete (metadata.config as Record<string, unknown>).playSessionId;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(metadata as any);

        expect(job.config.playSessionId).toBe(DB_SESSION);
    });

    it('clears per-session state under the original-case id when reached with a folded key', async () => {
        // The reaper iterates its OWN map keys, which are case-folded, and hands
        // them to stopJob. The per-session trackers were populated by the HTTP
        // layer from the id in the request URL — original case. Freeing them
        // with the folded id silently misses, which is a slow memory leak in the
        // exact lines that exist to prevent one.
        const svc = svcModule.getFFmpegTranscodeService();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(makeMetadata() as any);

        await svc.stopJob(DB_SESSION, 'inactivity');

        // The tracker's own map is keyed by the original-case id the HTTP layer
        // wrote, so freeing it with anything else silently misses.
        expect(mockSeekCooldownTracker.clearSeekTimestamp).toHaveBeenCalledWith(CLIENT_SESSION);
    });

    it('still restarts FFmpeg when the on-disk output is incomplete', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(makeMetadata({ segments_ready: 40 }) as any);

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// restoreJob — resuming at the playhead
// ---------------------------------------------------------------------------
//
// A restore used to rerun FFmpeg from segment 0 regardless of where the viewer
// actually was. Prod 2026-08-28 measured the cost directly: the restored remux
// produced 133 segments in 17s (~0.13s/segment), so reaching the requested
// segment 65 took `waitMs: 8018` — the whole visible freeze, spent regenerating
// content the client had already played.
//
// Safe ONLY when video is transcoded. FullTranscodeStrategy passes
// `startNumber: !isVideoCopy ? config.startNumber : undefined`, so a transcode
// restart writes segment_000NN.m4s matching the manifest index and is purely
// additive to what is already on disk. Copy mode gets no -start_number and
// renumbers from 0, which would clobber segment 0 of the existing output.
describe('restoreJob — resuming at the playhead', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    const CLIENT_SESSION = 'D2F5FA02-B977-493E-B054-7DC08CD42144';

    function makeMetadata(videoAction: 'transcode' | 'copy', overrides = {}) {
        return {
            play_session_id: CLIENT_SESSION.toLowerCase(),
            job_id: '167d1a1d-64f3-4488-a628-ba4613ead4ee',
            item_id: 'item-1',
            user_id: 'user-1',
            device_id: 'device-1',
            config: {
                playSessionId: CLIENT_SESSION,
                itemId: 'item-1',
                username: 'user-a',
                deviceId: 'device-1',
                inputUrl: 'http://localhost/stream',
                // buildFFmpegArgs early-returns [] without this, so the strategy
                // (and therefore -start_number) would never be reached.
                localFilePath: '/media/episode.mkv',
                audioTracks: [],
                totalDurationSeconds: 1326.848,
                segmentDurationSeconds: 10,
            },
            output_dir: `/tmp/transcode-test/${CLIENT_SESSION}/gen-0001`,
            status: 'running',
            mode: 'full' as const,
            error_message: null,
            segment_offset: 0,
            segments_ready: 40,
            master_playlist_ready: true,
            pod_name: 'a78b6ab6fcda',
            ffmpeg_pid: null,
            created_at: new Date(),
            last_accessed_at: new Date(),
            last_progress_at: new Date(),
            stopped_at: null,
            transcode_decision: { mode: 'full', videoAction, audioAction: 'transcode' },
            can_restore: true,
            cpu_percent: null,
            memory_mb: null,
            ...overrides,
        };
    }

    afterEach(removeStampedFixtures);

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockFileManager.isOutputComplete.mockReset();
        mockFileManager.isOutputComplete.mockResolvedValue(false);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('resumes near the requested segment instead of re-running from the start', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.restoreJob(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            makeMetadata('transcode') as any,
            { segmentPresentOnDisk: false, requiredSegmentIndex: 65 },
        );

        // Resumed near the viewer instead of regenerating everything before it.
        expect(job.segmentOffset).toBeGreaterThan(0);
        expect(job.segmentOffset).toBeLessThan(65);
    });

    it('declines to resume when the persisted decision is absent', async () => {
        // transcode_decision is nullable, and legacy effective planning
        // falls through to `{action:'copy'}` when the decision
        // is undefined and no codec change is needed. Treating "not copy" as
        // "transcode" would hand that job a resume offset while FFmpeg renumbers
        // from 0 — overwriting segment_00000.m4s of the output being served.
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.restoreJob(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            makeMetadata('transcode', { transcode_decision: null }) as any,
            { segmentPresentOnDisk: false, requiredSegmentIndex: 65 },
        );

        expect(job.segmentOffset).toBe(0);
    });

    it('resumes far enough back to cover audio running behind video', async () => {
        // A restore interrupts LINEAR playback, where audio trails video — prod
        // measured video at 83 while audio was still pulling 78..81. The restore
        // is triggered by whichever stream misses first (normally video, which
        // fetches ahead), so a seek-sized 2-segment preroll can start AHEAD of
        // what audio still needs, and audio cannot rescue itself: a segment below
        // the offset never gets produced and audio streams cannot trigger a seek.
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.restoreJob(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            makeMetadata('transcode') as any,
            { segmentPresentOnDisk: false, requiredSegmentIndex: 65 },
        );

        expect(job.segmentOffset).toBe(59);
        expect(job.config.startTimeSeconds).toBe(590);
    });

    it('hands the resumed start number to the FFmpeg args builder', async () => {
        // Without this the whole resume is inert if the args builder ever stops
        // reading job.segmentOffset — every other assertion here would still pass.
        const svc = svcModule.getFFmpegTranscodeService();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(makeMetadata('transcode') as any, {
            segmentPresentOnDisk: false,
            requiredSegmentIndex: 65,
        });

        expect(mockBuildArgs).toHaveBeenCalled();
        expect(mockBuildArgs.mock.calls[0][0]).toMatchObject({ startNumber: 59 });
    });

    it('does not stamp a resume offset onto an adopted complete output', async () => {
        // Adoption spawns no FFmpeg at all, so an offset describing a start that
        // never happened would be pure fiction — and saveJob persists it, making
        // the skew permanent for every later restore of this session.
        mockFileManager.isOutputComplete.mockResolvedValue(true);
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('transcode');
        await stampFixtureOutput(metadata);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await svc.restoreJob(metadata as any, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 65,
        });

        expect(job.segmentOffset).toBe(0);
        expect(job.config.startTimeSeconds).toBeUndefined();
    });

    it('resumes a copied-video restore at the requested segment, in a directory of its own', async () => {
        // Copy mode gets no -start_number, so FFmpeg renumbers from 0: resuming in
        // the persisted directory would overwrite segment_00000.m4s of the output
        // being served. The resume therefore goes to a fresh generation (as a seek
        // does) and starts where a seek to that segment would — never at the
        // persisted position, which the client's next request turns into a forward
        // seek and a second FFmpeg start (prod 2026-11-01).
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.restoreJob(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            makeMetadata('copy') as any,
            { segmentPresentOnDisk: false, requiredSegmentIndex: 65 },
        );

        expect(job.segmentOffset).toBe(65);
        expect(job.config.startTimeSeconds).toBe(650);
        expect(job.outputDir).toMatch(/gen-0002$/);
    });

    it('rewinds a copied-video restore whose persisted start is past a missing requested segment', async () => {
        // Prod 2026-11-01 20:54: a row left at offset 98 by an earlier restore was
        // restarted at 98 for a request of segment 73 (no files on disk); FFmpeg can
        // never produce 73 from 98 and the request timed out after 30 s.
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.restoreJob(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            makeMetadata('copy', { segment_offset: 98 }) as any,
            { segmentPresentOnDisk: false, requiredSegmentIndex: 73 },
        );

        expect(job.segmentOffset).toBe(73);
        expect(job.outputDir).toMatch(/gen-0002$/);
    });

    it('does not rewind a copied-video restore when the requested segment is on disk', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy', { segment_offset: 98 });
        await stampFixtureOutput(metadata);
        await fs.writeFile(path.join(metadata.output_dir, 'segment_00000.m4s'), 'x');

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
        });

        expect(job.segmentOffset).toBe(98);
    });

    it('does not rewind a restore that is already past the requested segment', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.restoreJob(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            makeMetadata('transcode', { segment_offset: 120 }) as any,
            { segmentPresentOnDisk: false, requiredSegmentIndex: 65 },
        );

        expect(job.segmentOffset).toBe(120);
    });
});

// ---------------------------------------------------------------------------
// restoreJob — prewarm on claim
// ---------------------------------------------------------------------------
//
// Prod 2026-11-01: a pod that claimed an orphaned session served 8-12 pre-generated
// segments from disk and started FFmpeg only when the next one was missing, at the
// persisted position (0). The client then asked for segment 86, the handler saw a
// forward seek and restarted FFmpeg a second time; the picture froze for 12-15 s.
// A prewarmed restore starts at the first segment the client will need.
describe('restoreJob — prewarm resumes after the last pre-generated segment', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    const CLIENT_SESSION = 'D2F5FA02-B977-493E-B054-7DC08CD42144';

    function makeMetadata(videoAction: 'transcode' | 'copy', overrides = {}) {
        return {
            play_session_id: CLIENT_SESSION.toLowerCase(),
            job_id: '167d1a1d-64f3-4488-a628-ba4613ead4ee',
            item_id: 'item-1',
            user_id: 'user-1',
            device_id: 'device-1',
            config: {
                playSessionId: CLIENT_SESSION,
                itemId: 'item-1',
                username: 'user-a',
                deviceId: 'device-1',
                inputUrl: 'http://localhost/stream',
                localFilePath: '/media/episode.mkv',
                audioTracks: [],
                totalDurationSeconds: 1326.848,
                segmentDurationSeconds: 10,
            },
            output_dir: '',
            status: 'running',
            mode: 'full' as const,
            error_message: null,
            segment_offset: 0,
            segments_ready: 86,
            master_playlist_ready: true,
            pod_name: 'a78b6ab6fcda',
            ffmpeg_pid: null,
            created_at: new Date(),
            last_accessed_at: new Date(),
            last_progress_at: new Date(),
            stopped_at: null,
            transcode_decision: { mode: 'full', videoAction, audioAction: 'transcode' },
            can_restore: true,
            cpu_percent: null,
            memory_mb: null,
            ...overrides,
        };
    }

    /** A stamped output dir holding segment_00000 .. segment_<last> in `subdir`. */
    async function withSegments(
        metadata: ReturnType<typeof makeMetadata>,
        last: number,
        subdir = '',
    ): Promise<void> {
        if (!metadata.output_dir) await stampFixtureOutput(metadata);
        const dir = path.join(metadata.output_dir, subdir);
        await fs.mkdir(dir, { recursive: true });
        for (let i = 0; i <= last; i++) {
            await fs.writeFile(path.join(dir, `segment_${String(i).padStart(5, '0')}.m4s`), 'x');
        }
    }

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockFileManager.isOutputComplete.mockReset();
        mockFileManager.isOutputComplete.mockResolvedValue(false);
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(async () => {
        vi.clearAllMocks();
        await removeStampedFixtures();
    });

    it('starts FFmpeg at the first segment the disk cannot vouch for, once, so the client never needs a forward seek', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85); // 0..85 pre-generated; the client asks for 73
        const diskDir = metadata.output_dir;

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        // 0..84 are known complete; 85 may be a truncated last write and is
        // produced again. That is where FFmpeg starts.
        expect(job.segmentOffset).toBe(85);
        expect(job.config.startTimeSeconds).toBe(850);
        expect(job.outputDir).not.toBe(diskDir);
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);

        // Segments the client still reads (74..84) stay routable from the old
        // output, instead of reading as backward seeks on the new job.
        const route = await svc.resolveSegmentRoute(CLIENT_SESSION, '', 80, {
            normalizedPath: 'segment_00080.m4s',
            fallbackSegmentExtension: 'm4s',
        });
        expect(route?.reason).toBe('retained-covered');
        expect(route?.job.outputDir).toBe(diskDir);
        // Its files predate this pod's spawn by definition: the stale-segment guard
        // must not reject them (prod 2026-11-01: every retained segment was refused).
        expect(route?.job.lastFFmpegSpawnTime).toBe(0);
        expect(route?.job.previousFFmpegSpawnTime).toBeNull();
        // The possibly truncated last file is never served from the old output.
        const last = await svc.resolveSegmentRoute(CLIENT_SESSION, '', 85, {
            normalizedPath: 'segment_00085.m4s',
            fallbackSegmentExtension: 'm4s',
        });
        expect(last?.job.id).toBe(job.id);
    });

    it('refreshes the retained generation when it serves a request (TTL keeps it alive)', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85);
        await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });
        const first = await svc.resolveSegmentRoute(CLIENT_SESSION, '', 80, {
            normalizedPath: 'segment_00080.m4s',
            fallbackSegmentExtension: 'm4s',
        });
        first!.job.lastAccessedAt = new Date(0);

        const route = await svc.resolveSegmentRoute(CLIENT_SESSION, '', 80, {
            normalizedPath: 'segment_00080.m4s',
            fallbackSegmentExtension: 'm4s',
            requireRetainedFile: true,
            fileExists: async () => true,
        });

        expect(route?.reason).toBe('retained-covered');
        expect(route!.job.lastAccessedAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
    });

    it('starts at the requested segment when it is later than the end of the disk output', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85);

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 95,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        expect(job.segmentOffset).toBe(95);
    });

    it('resumes after the slowest stream when audio and video are separate', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85, 'stream_0'); // audio ahead
        await withSegments(metadata, 83, 'stream_1'); // video behind

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        expect(job.segmentOffset).toBe(83);
    });

    it('counts an empty or missing stream directory as 0 when another stream has files', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 39, 'stream_1'); // video: 40 segments
        await fs.mkdir(path.join(metadata.output_dir, 'stream_0')); // audio: nothing

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 0,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        // Audio has nothing to resume from: the restore stays at the start.
        expect(job.segmentOffset).toBe(0);
    });

    it('treats a stream directory FFmpeg never created as empty too', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        // Only stream_1 exists; stream_0 (audio) is absent entirely.
        await withSegments(metadata, 39, 'stream_1');

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 0,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        expect(job.segmentOffset).toBe(0);
    });

    it('steps back to a start at or below the end of the disk output instead of leaving a gap', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85);
        const real = (svc as unknown as { resolveSeekStart: (...a: unknown[]) => unknown })
            .resolveSeekStart;
        // The keyframe grid cannot start at 85: the nearest start is 87, above the
        // end of the disk output, and 84 is the keyframe at or below it.
        vi.spyOn(
            svc as unknown as { resolveSeekStart: typeof real },
            'resolveSeekStart',
        ).mockImplementation(((job: unknown, id: unknown, target: number) =>
            target >= 85
                ? {
                      alignedSeekTime: 870,
                      generationStart: { startSegment: 87, startTimeSeconds: 870 },
                  }
                : real.call(svc, job, id, target, target * 10)) as typeof real);

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        expect(job.segmentOffset).toBeLessThanOrEqual(85);
        expect(job.segmentOffset).toBe(84);
    });

    it('resumes a transcoded-video prewarm with the usual decoder preroll before the first unsafe segment', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('transcode');
        await withSegments(metadata, 85);

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });

        expect(job.segmentOffset).toBe(79); // 85 - RESTORE_PREROLL_SEGMENTS (6)
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
    });

    it('does not prewarm past a session that is already running here (idempotent)', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85);
        const opts = {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        };

        const [a, b] = await Promise.all([
            svc.restoreJob(metadata as never, opts),
            svc.restoreJob(metadata as never, opts),
        ]);

        expect(b.id).toBe(a.id);
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
    });

    it('a seek that arrives while the prewarm is still spawning waits for it (no orphaned second process)', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85);
        let releaseSpawn!: () => void;
        const spawned: string[] = [];
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (job: { id: string }, _args: unknown, callbacks: never) => {
                spawned.push(job.id);
                capturedCallbacks.set(job.id, callbacks);
                if (spawned.length === 1) {
                    await new Promise<void>((resolve) => {
                        releaseSpawn = resolve;
                    });
                }
            },
        );

        const restore = svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });
        await vi.waitFor(() => expect(spawned).toHaveLength(1));

        // The file-wide SeekController mock has no canSeek (see the F6 test).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc as any).seekController.canSeek = () => true;
        const seek = svc.seekToSegment(CLIENT_SESSION, 20, 10);
        await new Promise((r) => setTimeout(r, 50));
        // The seek must not have touched the half-started job.
        expect(spawned).toHaveLength(1);
        expect(svc.getJobByPlaySession(CLIENT_SESSION)?.id).toBe(spawned[0]);

        releaseSpawn();
        const job = await restore;
        expect(await seek).toBe(true);

        // Every process that was started belongs to a job the service still owns.
        expect(spawned).toHaveLength(2);
        expect(spawned[0]).toBe(job.id);
        expect(svc.getJobByPlaySession(CLIENT_SESSION)?.id).toBe(spawned[1]);
    });

    it('a failed prewarm spawn leaves the row restorable and nothing registered', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        await withSegments(metadata, 85);
        mockProcessRunner.spawnFFmpeg.mockRejectedValue(new Error('spawn exploded'));
        mockPersistence.saveJob.mockClear();

        await expect(
            svc.restoreJob(metadata as never, {
                segmentPresentOnDisk: true,
                requiredSegmentIndex: 73,
                previousOwnerMayStillWrite: true,
                prewarm: true,
            }),
        ).rejects.toThrow('spawn exploded');

        // No 'error' row was persisted and no job (current or retained) remains.
        expect(mockPersistence.saveJob).not.toHaveBeenCalled();
        expect(svc.getJobByPlaySession(CLIENT_SESSION)).toBeUndefined();
        expect(await svc.resolveSegmentRoute(CLIENT_SESSION, '', 80)).toBeUndefined();
    });

    it('a failed on-demand (non-prewarm) spawn still persists the error as before', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        mockProcessRunner.spawnFFmpeg.mockRejectedValue(new Error('spawn exploded'));
        mockPersistence.saveJob.mockClear();

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: false,
            requiredSegmentIndex: 65,
        });

        expect(job.status).toBe('error');
        expect(mockPersistence.saveJob).toHaveBeenCalled();
    });

    it('never deletes a live generation nested in a retired legacy session directory', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const metadata = makeMetadata('copy');
        // Legacy layout: the first generation IS the session directory.
        await stampFixtureOutput(metadata);
        const sessionDir = path.dirname(metadata.output_dir);
        metadata.output_dir = sessionDir;
        await writeOutputMarker(sessionDir, {
            itemId: metadata.item_id,
            podName: 'fixture-pod',
            jobId: metadata.job_id,
        });
        await withSegments(metadata, 85);
        mockFileManager.deleteOutputDirectory.mockClear();

        const job = await svc.restoreJob(metadata as never, {
            segmentPresentOnDisk: true,
            requiredSegmentIndex: 73,
            previousOwnerMayStillWrite: true,
            prewarm: true,
        });
        // Retire the retained legacy generation (what the previous-generation TTL does).
        const retained = (
            svc as never as { getRetainedJobsByPlaySession: (id: string) => TranscodeJob[] }
        ).getRetainedJobsByPlaySession(CLIENT_SESSION);
        expect(retained).toHaveLength(1);
        expect(job.outputDir.startsWith(retained[0].outputDir)).toBe(true);
        await (
            svc as never as {
                retireJobGeneration: (j: TranscodeJob, r: string) => Promise<void>;
            }
        ).retireJobGeneration(retained[0], 'previous_generation_ttl');

        expect(mockFileManager.deleteOutputDirectory).not.toHaveBeenCalledWith(sessionDir);
    });
});

describe('hasAudioTrackChanged — omitted index means the DEFAULT track, not "unknown"', () => {
    // HlsOutputConfig documents hlsAudioTrackIndex as "default: first/default
    // track", and full-transcode-strategy resolves an absent index with
    // `?? defaultAudioAbsoluteIndex(audioTracks)`. So a job started without the
    // param is muxing the file's default track — it is NOT in an indeterminate
    // state. The old comparison was `newAudioIndex !== undefined &&
    // oldAudioIndex !== newAudioIndex`, which read undefined as "different from
    // everything" and tore down a perfectly good job to restart it on the track
    // it was already muxing (keyframe-aligning BACKWARD and making the client
    // refetch from the new generation's first segment).
    //
    // Reachable in prod via the Jellyfin-compat route: /j master.m3u8 parses
    // AudioStreamIndex as OPTIONAL, defaults hlsAudioMode to 'muxed' and reuses
    // the client's PlaySessionId — so a client that first requests without the
    // param and then re-requests with AudioStreamIndex=<the default> hits
    // exactly this. tvOS never sends the param at all, so its jobs always hold
    // undefined here.
    type Cfg = Parameters<typeof hasAudioTrackChanged>[0];

    // Absolute ffmpeg stream indices: 0 is video, so audio starts at 1.
    const tracks = [
        { index: 1, language: 'ger', isDefault: true },
        { index: 2, language: 'eng', isDefault: false },
    ];

    function cfg(hlsAudioTrackIndex: number | undefined, audioTracks = tracks): Cfg {
        return {
            audioTracks,
            hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex },
        } as unknown as Cfg;
    }

    it('does NOT restart when the requested index IS the default the job already mux', () => {
        // The bug: undefined -> 1 where 1 is the default track.
        expect(hasAudioTrackChanged(cfg(undefined), cfg(1))).toBe(false);
    });

    it('still restarts when an unspecified job is asked for a NON-default track', () => {
        // Must keep working: this is a real switch away from the default.
        expect(hasAudioTrackChanged(cfg(undefined), cfg(2))).toBe(true);
    });

    it('restarts on a genuine switch between two explicit tracks', () => {
        expect(hasAudioTrackChanged(cfg(1), cfg(2))).toBe(true);
        expect(hasAudioTrackChanged(cfg(2), cfg(1))).toBe(true);
    });

    it('reuses the job when the same explicit track is requested again', () => {
        expect(hasAudioTrackChanged(cfg(2), cfg(2))).toBe(false);
    });

    it('never restarts on a request that omits the index', () => {
        // Unchanged from the old behaviour on purpose: an omitted index must not
        // newly START provoking restarts, or a tvOS client re-requesting its
        // playlist would tear down its own job.
        expect(hasAudioTrackChanged(cfg(2), cfg(undefined))).toBe(false);
        expect(hasAudioTrackChanged(cfg(undefined), cfg(undefined))).toBe(false);
    });

    it('honours isDefault rather than assuming the first track', () => {
        const engDefault = [
            { index: 1, language: 'ger', isDefault: false },
            { index: 2, language: 'eng', isDefault: true },
        ];
        expect(hasAudioTrackChanged(cfg(undefined, engDefault), cfg(2, engDefault))).toBe(false);
        expect(hasAudioTrackChanged(cfg(undefined, engDefault), cfg(1, engDefault))).toBe(true);
    });

    it('never restarts a demux job for a different index (all tracks are delivered)', () => {
        const demux = (i: number | undefined): Cfg =>
            ({
                audioTracks: tracks,
                hlsOutput: { hlsAudioMode: 'demux', hlsAudioTrackIndex: i },
            }) as unknown as Cfg;
        expect(hasAudioTrackChanged(demux(1), demux(2))).toBe(false);
        expect(hasAudioTrackChanged(demux(undefined), demux(2))).toBe(false);
        // A muxed -> demux change is not this rule's business.
        expect(hasAudioTrackChanged(cfg(1), demux(2))).toBe(true);
    });

    it('stays conservative when the existing job has no audio tracks to resolve', () => {
        // Nothing to compare against — keep the old answer rather than silently
        // reusing a job whose audio we cannot reason about.
        expect(hasAudioTrackChanged(cfg(undefined, []), cfg(1, []))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Playlist-body input guard before every spawn (fix plan 6, final wave M1)
// ---------------------------------------------------------------------------
//
// restoreJob respawns FFmpeg from the persisted config's input path with no
// re-scan in between, so a job created while a file held media survives the
// scanner's tombstone if the file later became a playlist/manifest body (and
// d3a39503d keeps dormant rows restorable, which widens that window). The
// sniff is the REAL one (transcoding/input-guard.ts → playlist-sniff.ts) over
// real files; only the process runner (the spawn itself) is mocked.
describe('playlist-body input guard (final wave M1)', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let jobRestoration: typeof import('./hls/job-restoration.js');
    let dir: string;
    const REAL_MEDIA = `${process.cwd()}/tests/fixtures/test-video.mp4`;
    const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';
    const SESSION = '5a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';

    async function write(name: string, body: string): Promise<string> {
        const { writeFile } = await import('node:fs/promises');
        const p = `${dir}/${name}`;
        await writeFile(p, body);
        return p;
    }

    /** `buildConcatListContent`'s exact output shape (hls/playback.service.ts), incl. F4's per-part option line. */
    function concatList(paths: string[]): string {
        return paths
            .map(
                (p) =>
                    `file '${p.replace(/'/g, "'\\''")}'\noption format_whitelist 'matroska,webm,mov,mp4'`,
            )
            .join('\n');
    }

    function makeMetadata(configOverrides: Record<string, unknown>) {
        return {
            play_session_id: SESSION,
            job_id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
            item_id: 'item-1',
            user_id: 'user-1',
            device_id: 'device-1',
            config: {
                playSessionId: SESSION,
                itemId: 'item-1',
                username: 'user-a',
                deviceId: 'device-1',
                audioTracks: [],
                totalDurationSeconds: 60,
                segmentDurationSeconds: 6,
                ...configOverrides,
            },
            output_dir: `/tmp/transcode-test/${SESSION}/gen-0001`,
            status: 'stopped',
            mode: 'full' as const,
            error_message: null,
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: null,
            ffmpeg_pid: null,
            created_at: new Date(),
            last_accessed_at: new Date(),
            last_progress_at: new Date(),
            stopped_at: null,
            transcode_decision: null,
            can_restore: true,
            cpu_percent: null,
            memory_mb: null,
        };
    }

    beforeEach(async () => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        dir = await mkdtemp(`${tmpdir()}/lumastra-input-guard-`);
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockFileManager.isOutputComplete.mockReset();
        mockFileManager.isOutputComplete.mockResolvedValue(false);
        mockPersistence.updateStatus.mockClear();
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(async () => {});
        svcModule = await import('./ffmpeg-transcode.service.js');
        jobRestoration = await import('./hls/job-restoration.js');
    });

    afterEach(async () => {
        const { rm } = await import('node:fs/promises');
        await rm(dir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('refuses to restore a job whose input became a playlist body — no spawn, not registered', async () => {
        const input = await write('movie.mkv', HLS_BODY);
        const svc = svcModule.getFFmpegTranscodeService();

        await expect(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            svc.restoreJob(makeMetadata({ localFilePath: input }) as any),
        ).rejects.toMatchObject({ name: 'PlaylistSourceRefusedError', magic: 'hls' });

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
        expect(svc.getJobByPlaySession(SESSION)).toBeUndefined();
    });

    it('control: a job whose input is real media restores and spawns', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.restoreJob(makeMetadata({ localFilePath: REAL_MEDIA }) as any);

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
        expect(svc.getJobByPlaySession(SESSION)).toBeDefined();
    });

    it('through job-restoration: the refused restore fails the request and marks the row error (never restorable)', async () => {
        const input = await write('movie.mkv', HLS_BODY);
        const svc = svcModule.getFFmpegTranscodeService();
        const updateStatus = vi.fn().mockResolvedValue(undefined);

        const result = await jobRestoration.restoreHlsJobIfMissing({
            job: undefined,
            itemId: 'item-1',
            internalId: 'item-1',
            playSessionId: SESSION,
            segmentPath: 'stream_0/segment_00000.m4s',
            corsHeaders: {},
            contentTypes: {},
            currentPodName: 'pod-a',
            restoreWaitTimeoutMs: 20,
            restorePollIntervalMs: 0,
            jobPersistence: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                getJob: async () => makeMetadata({ localFilePath: input }) as any,
                updateStatus,
                updateLastAccessed: async () => undefined,
                claimJobForRestoration: async () => true,
                takeOverStaleJob: async () => true,
            },
            transcodeService: svc,
            accessFile: async () => {
                throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            },
            readFile: async () => Buffer.alloc(0),
            trackHlsSegment: () => undefined,
            logInfo: () => undefined,
            logWarn: () => undefined,
            logError: () => undefined,
        });

        expect(result.response?.status).toBe(500);
        // D-HLS-1 follow-up: markRestorationError now also passes
        // `undefined` (canRestore) and the pod-guard `currentPodName`.
        expect(updateStatus).toHaveBeenCalledWith(
            SESSION,
            'error',
            expect.stringContaining('hls'),
            undefined,
            'pod-a',
        );
        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
    });

    it('concat: a part that is a playlist body is refused', async () => {
        const bad = await write("part2 it's.mkv", HLS_BODY);
        const list = await write('lumastra-concat-x.txt', concatList([REAL_MEDIA, bad]));
        const svc = svcModule.getFFmpegTranscodeService();

        await expect(
            svc.restoreJob(
                makeMetadata({
                    localFilePath: list,
                    useConcatDemuxer: true,
                    concatTmpFile: list,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }) as any,
            ),
        ).rejects.toMatchObject({ name: 'PlaylistSourceRefusedError', sourcePath: bad });
        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
    });

    it("control: the app's own concat list over real parts is not refused", async () => {
        const list = await write('lumastra-concat-y.txt', concatList([REAL_MEDIA, REAL_MEDIA]));
        const svc = svcModule.getFFmpegTranscodeService();

        await svc.restoreJob(
            makeMetadata({
                localFilePath: list,
                useConcatDemuxer: true,
                concatTmpFile: list,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            }) as any,
        );

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
    });

    it("a concat input that is not the job's own recorded list is judged as-is (refused)", async () => {
        const list = await write('foreign-list.txt', concatList([REAL_MEDIA]));
        const svc = svcModule.getFFmpegTranscodeService();

        await expect(
            svc.restoreJob(
                makeMetadata({
                    localFilePath: list,
                    useConcatDemuxer: true,
                    concatTmpFile: `${dir}/some-other-list.txt`,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                }) as any,
            ),
        ).rejects.toMatchObject({ name: 'PlaylistSourceRefusedError', magic: 'concat' });
        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
    });

    it('startJob: a playlist-body input fails the job before any spawn', async () => {
        const input = await write('start.mkv', HLS_BODY);
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'm1-start', localFilePath: input }),
        );

        expect(job.status).toBe('error');
        expect(job.error).toContain('hls');
        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
    });

    it('control: startJob with real media spawns', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'm1-start-ok', localFilePath: REAL_MEDIA }),
        );

        expect(job.status).not.toBe('error');
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Input sniff vs a concurrent stop/retire (fix plan 6, final wave F2)
// ---------------------------------------------------------------------------
//
// The playlist-body sniff is an `await` between "the job exists" and "FFmpeg
// is spawned". A stop or retire that lands inside it finds no process to kill;
// the spawn must then not happen, and nothing may overwrite 'stopping'. The
// sniff is replaced by a deferred promise so the interleaving is exact.
describe('input sniff vs concurrent stop/retire (final wave F2)', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let spawnSafely: ReturnType<typeof vi.fn>;
    const guard = vi.fn<(config: unknown) => Promise<void>>();

    function deferred(): {
        promise: Promise<void>;
        resolve: () => void;
        reject: (e: Error) => void;
    } {
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const promise = new Promise<void>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    beforeEach(async () => {
        vi.resetModules();
        guard.mockReset();
        guard.mockResolvedValue(undefined);
        vi.doMock('./transcoding/input-guard.js', () => ({
            assertTranscodeInputIsMedia: guard,
        }));
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.updateStatus.mockClear();
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(async () => {});
        svcModule = await import('./ffmpeg-transcode.service.js');
        spawnSafely = vi.mocked((await import('../utils/ffmpeg-spawn.js')).spawnFFmpegSafely);
        spawnSafely.mockClear();
    });

    afterEach(() => {
        vi.doUnmock('./transcoding/input-guard.js');
        vi.clearAllMocks();
    });

    it('(b) a stop during the start sniff leaves no spawned FFmpeg and keeps the stop state', async () => {
        const sniff = deferred();
        guard.mockReturnValueOnce(sniff.promise);
        const svc = svcModule.getFFmpegTranscodeService();

        const started = svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'f2-start', localFilePath: '/media/a.mkv' }),
        );
        await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
        const job = svc.getJobByPlaySession('f2-start')!;
        expect(job).toBeDefined();

        await svc.stopJob('f2-start', 'user_stop');
        sniff.resolve();
        await started;

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
        expect(['stopping', 'stopped']).toContain(job.status);
    });

    it('(b) a stop during the start sniff also starts no tail-cache remux', async () => {
        const sniff = deferred();
        guard.mockReturnValueOnce(sniff.promise);
        const svc = svcModule.getFFmpegTranscodeService();

        const started = svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f2-start-tail',
                localFilePath: '/media/a.mkv',
                totalDurationSeconds: 3600,
            }),
        );
        await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
        await svc.stopJob('f2-start-tail', 'user_stop');
        sniff.resolve();
        await started;
        await new Promise((r) => setTimeout(r, 20));

        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
        expect(spawnSafely).not.toHaveBeenCalled();
    });

    it('control: without a stop, the start sniff is followed by the spawn', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f2-start-ok',
                localFilePath: '/media/a.mkv',
            }),
        );

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
    });

    it("(c) a respawn whose sniff fails after a stop does not overwrite 'stopping' with 'error'", async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f2-respawn',
                localFilePath: '/media/a.mkv',
            }),
        );
        mockProcessRunner.spawnFFmpeg.mockClear();
        const sniff = deferred();
        guard.mockReturnValueOnce(sniff.promise);

        // The GPU-ladder respawn entry point (private; reached from handleExit).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc as any).respawnFFmpeg(job);
        await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(2));
        await svc.stopJob('f2-respawn', 'user_stop');
        mockPersistence.updateStatus.mockClear();
        sniff.reject(new Error('sniff failed'));
        await new Promise((r) => setTimeout(r, 0));

        expect(['stopping', 'stopped']).toContain(job.status);
        expect(mockPersistence.updateStatus).not.toHaveBeenCalledWith(
            'f2-respawn',
            'error',
            expect.anything(),
            expect.anything(),
            expect.anything(),
        );
        expect(mockProcessRunner.spawnFFmpeg).not.toHaveBeenCalled();
    });

    it('(a) a generation retired during the tail-cache sniff spawns no tail remux', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const tailSniff = deferred();
        // First sniff: the main spawn (immediate). Second: the tail worker.
        guard.mockResolvedValueOnce(undefined).mockReturnValueOnce(tailSniff.promise);

        await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f2-tail',
                localFilePath: '/media/a.mkv',
                totalDurationSeconds: 3600,
            }),
        );
        await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(2));

        await svc.stopJob('f2-tail', 'user_stop');
        tailSniff.resolve();
        await new Promise((r) => setTimeout(r, 20));

        expect(spawnSafely).not.toHaveBeenCalled();
    });

    it('control: without a retire, the tail-cache worker spawns after its sniff', async () => {
        const svc = svcModule.getFFmpegTranscodeService();

        await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f2-tail-ok',
                localFilePath: '/media/a.mkv',
                totalDurationSeconds: 3600,
            }),
        );

        await vi.waitFor(() => expect(spawnSafely).toHaveBeenCalled());
    });

    it('the CPU tail worker is skipped when the main run encodes video on a GPU (init mismatch)', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'tail-gpu',
                localFilePath: '/media/a.mkv',
                totalDurationSeconds: 3600,
            }),
        );
        await new Promise((r) => setTimeout(r, 20));
        spawnSafely.mockClear();
        const decision = {
            mode: 'full' as const,
            reasons: 0,
            videoAction: 'transcode' as const,
            audioAction: 'copy' as const,
            useGpu: true,
            gpuEncoder: 'hevc_nvenc',
            needsTonemapping: false,
            preserveHdr10: false,
        };

        job.transcodeDecisionResult = decision;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).spawnTailCacheWorkerTranscode(job);
        expect(spawnSafely).not.toHaveBeenCalled();

        // Control: the same job encoding on the CPU still gets its tail.
        job.transcodeDecisionResult = { ...decision, useGpu: false, gpuEncoder: undefined };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (svc as any).spawnTailCacheWorkerTranscode(job);
        expect(spawnSafely).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Playlist-body refusal on the seek, GPU-ladder and tail-cache spawns (fix
// plan 6, final wave F6)
// ---------------------------------------------------------------------------
//
// M1 put the input sniff in front of every spawn but pinned only start and
// restore. Here the job starts on real media and the file's bytes become a
// playlist body afterwards; each later spawn path must then refuse it. The
// sniff is the REAL one over real files; only the process runner is mocked.
describe('playlist-body refusal on seek, GPU-ladder and tail-cache spawns (final wave F6)', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');
    let spawnSafely: ReturnType<typeof vi.fn>;
    let dir: string;
    const REAL_MEDIA = `${process.cwd()}/tests/fixtures/test-video.mp4`;
    const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';

    /** A private copy of the real media the test can later overwrite. */
    async function mediaCopy(name: string): Promise<string> {
        const { copyFile } = await import('node:fs/promises');
        const p = `${dir}/${name}`;
        await copyFile(REAL_MEDIA, p);
        return p;
    }

    async function becomePlaylist(p: string): Promise<void> {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(p, HLS_BODY);
    }

    beforeEach(async () => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        dir = await mkdtemp(`${tmpdir()}/lumastra-input-guard-f6-`);
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockPersistence.updateStatus.mockClear();
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(async () => {});
        svcModule = await import('./ffmpeg-transcode.service.js');
        spawnSafely = vi.mocked((await import('../utils/ffmpeg-spawn.js')).spawnFFmpegSafely);
        spawnSafely.mockClear();
    });

    afterEach(async () => {
        const { rm } = await import('node:fs/promises');
        await rm(dir, { recursive: true, force: true });
        vi.clearAllMocks();
    });

    it('seek: a new generation over an input that became a playlist body is refused — no spawn, seek fails', async () => {
        const input = await mediaCopy('seek.mkv');
        const svc = svcModule.getFFmpegTranscodeService();
        await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'f6-seek', localFilePath: input }),
        );
        const spawnsAfterStart = mockProcessRunner.spawnFFmpeg.mock.calls.length;

        await becomePlaylist(input);
        const seeked = await svc.seekToSegment('f6-seek', 10, 6, undefined, true);

        expect(seeked).toBe(false);
        expect(mockProcessRunner.spawnFFmpeg.mock.calls.length).toBe(spawnsAfterStart);
    });

    it('control: a seek over real media spawns the new generation', async () => {
        const input = await mediaCopy('seek-ok.mkv');
        const svc = svcModule.getFFmpegTranscodeService();
        await svc.startJob(
            makeHandleExitTestConfig({ playSessionId: 'f6-seek-ok', localFilePath: input }),
        );
        const spawnsAfterStart = mockProcessRunner.spawnFFmpeg.mock.calls.length;

        const seeked = await svc.seekToSegment('f6-seek-ok', 10, 6, undefined, true);

        expect(seeked).toBe(true);
        expect(mockProcessRunner.spawnFFmpeg.mock.calls.length).toBe(spawnsAfterStart + 1);
    });

    it('coverage: a seek hands the encoded range to the next generation', async () => {
        const input = await mediaCopy('seek-coverage.mkv');
        const svc = svcModule.getFFmpegTranscodeService();
        const first = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f6-seek-coverage',
                localFilePath: input,
                totalDurationSeconds: 600,
                segmentDurationSeconds: 6,
            }),
        );
        first.segmentsReady = 5; // 0–30 s encoded
        // The file-wide SeekController mock has no canSeek; a regular
        // (non-forced) seek asks it whether the target needs a new generation.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc as any).seekController.canSeek = () => true;

        expect(await svc.seekToSegment('f6-seek-coverage', 40, 6)).toBe(true);
        const second = svc.getJob('f6-seek-coverage')!;
        expect(second.id).not.toBe(first.id);
        expect(second.config.coveredRanges).toEqual([[0, 30]]);

        // The seek may start its generation a little before the target
        // (alignment); the range follows wherever it really started.
        const startPct = second.segmentOffset; // 6 s segments of a 600 s file = 1 % each
        second.segmentsReady = 5;
        expect(svc.getPlayerTranscodeProgress('f6-seek-coverage')).toMatchObject({
            progressPercent: 10,
            segmentsReady: 10,
            totalSegments: 100,
            coveredRanges: [
                { start: 0, end: 5 },
                { start: startPct, end: startPct + 5 },
            ],
            encoderPercent: startPct + 5,
        });
    });

    it('coverage: an audio-track replacement starts coverage over', async () => {
        const input = await mediaCopy('seek-coverage-audio.mkv');
        const svc = svcModule.getFFmpegTranscodeService();
        const first = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f6-seek-coverage-audio',
                localFilePath: input,
                totalDurationSeconds: 600,
                segmentDurationSeconds: 6,
            }),
        );
        first.segmentsReady = 5;
        expect(await svc.seekToSegment('f6-seek-coverage-audio', 40, 6, undefined, true)).toBe(
            true,
        );
        expect(svc.getJob('f6-seek-coverage-audio')!.config.coveredRanges).toEqual([]);
    });

    it('tail cache: the tail remux over an input that became a playlist body is refused — no spawn', async () => {
        const input = await mediaCopy('tail.mkv');
        // The bytes change right after the main FFmpeg starts, before the
        // fire-and-forget tail worker sniffs.
        mockProcessRunner.spawnFFmpeg.mockImplementationOnce(async () => {
            await becomePlaylist(input);
        });
        const svc = svcModule.getFFmpegTranscodeService();

        await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f6-tail',
                localFilePath: input,
                totalDurationSeconds: 3600,
            }),
        );
        await new Promise((r) => setTimeout(r, 100));

        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
        expect(spawnSafely).not.toHaveBeenCalled();
    });

    it('tail cache (remux decision): the copy-mode tail remux over an input that became a playlist body is refused — no spawn', async () => {
        const idx = await import('./transcoding/index.js');
        const remux = { mode: 'full', videoAction: 'copy', audioAction: 'copy', useGpu: false };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vi.mocked(idx.transcodeDecision.decide).mockResolvedValueOnce(remux as any);
        const input = await mediaCopy('tail-remux.mkv');
        mockProcessRunner.spawnFFmpeg.mockImplementationOnce(async () => {
            await becomePlaylist(input);
        });
        const svc = svcModule.getFFmpegTranscodeService();

        const job = await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f6-tail-remux',
                localFilePath: input,
                totalDurationSeconds: 3600,
                // decide() runs only with source info; its mock returns `remux`.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                mediaSourceInfo: {} as any,
            }),
        );
        await new Promise((r) => setTimeout(r, 100));

        expect(job.transcodeDecisionResult?.videoAction).toBe('copy');
        expect(mockProcessRunner.spawnFFmpeg).toHaveBeenCalledTimes(1);
        expect(spawnSafely).not.toHaveBeenCalled();
    });

    it('control: the tail remux over real media spawns', async () => {
        const input = await mediaCopy('tail-ok.mkv');
        const svc = svcModule.getFFmpegTranscodeService();

        await svc.startJob(
            makeHandleExitTestConfig({
                playSessionId: 'f6-tail-ok',
                localFilePath: input,
                totalDurationSeconds: 3600,
            }),
        );

        await vi.waitFor(() => expect(spawnSafely).toHaveBeenCalled());
    });

    describe('GPU ladder', () => {
        let hw: typeof import('./transcoding/hardware-detection.js');
        let idx: typeof import('./transcoding/index.js');
        const GENUINE_DECODE_GAP = [
            "Impossible to convert between the formats supported by the filter 'graph 0 input' and the filter 'auto_scale_0'",
            'Error reinitializing filters!',
            '[hevc_qsv @ 0x1] Could not open encoder before EOF',
        ].join('\n');

        beforeEach(async () => {
            mockProcessRunner.spawnFFmpeg.mockImplementation(
                async (
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    job: any,
                    _args: unknown,
                    callbacks: {
                        onExit: (...a: unknown[]) => void;
                        onError: (...a: unknown[]) => void;
                    },
                ) => {
                    capturedCallbacks.set(job.id as string, callbacks);
                },
            );
            hw = await import('./transcoding/hardware-detection.js');
            idx = await import('./transcoding/index.js');
            vi.mocked(idx.getHwAccelFromEncoder).mockReturnValue('qsv');
            vi.mocked(hw.hardwareDetection.canSoftwareDecodeBridge).mockReturnValue(true);
            vi.mocked(hw.hardwareDetection.isSourceHardwareDecodable).mockReturnValue(true);
        });

        afterEach(() => {
            vi.mocked(idx.getHwAccelFromEncoder).mockReturnValue('none');
            vi.mocked(hw.hardwareDetection.canSoftwareDecodeBridge).mockReturnValue(false);
            vi.mocked(hw.hardwareDetection.isSourceHardwareDecodable).mockReturnValue(false);
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async function startGpuJob(playSessionId: string, input: string): Promise<any> {
            const svc = svcModule.getFFmpegTranscodeService();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const strategy = vi.mocked(idx.FullTranscodeStrategy).mock.instances[0] as any;
            strategy.buildArgs.mockReturnValue({ args: ['-i', input, 'output.m3u8'] });
            const job = await svc.startJob(
                makeHandleExitTestConfig({
                    playSessionId,
                    localFilePath: input,
                    videoInfo: { codec: 'av1', bitDepth: 10, width: 1920, height: 1080 },
                }),
            );
            job.transcodeDecisionResult = {
                mode: 'full',
                reasons: 0,
                videoAction: 'transcode',
                audioAction: 'copy',
                useGpu: true,
                gpuEncoder: 'hevc_qsv',
                needsTonemapping: false,
                preserveHdr10: false,
            };
            job.process = null;
            return job;
        }

        it('the retry after a GPU failure over an input that became a playlist body is refused — no respawn, job error', async () => {
            const input = await mediaCopy('gpu.mkv');
            const job = await startGpuJob('f6-gpu', input);
            const spawnsAfterStart = mockProcessRunner.spawnFFmpeg.mock.calls.length;

            await becomePlaylist(input);
            capturedCallbacks.get(job.id)!.onExit(1, null, GENUINE_DECODE_GAP, false);

            await vi.waitFor(() => expect(job.status).toBe('error'), { timeout: 5000 });
            expect(job.error).toContain('hls');
            expect(mockProcessRunner.spawnFFmpeg.mock.calls.length).toBe(spawnsAfterStart);
        });

        it('control: the retry after a GPU failure over real media respawns', async () => {
            const input = await mediaCopy('gpu-ok.mkv');
            const job = await startGpuJob('f6-gpu-ok', input);
            const spawnsAfterStart = mockProcessRunner.spawnFFmpeg.mock.calls.length;

            capturedCallbacks.get(job.id)!.onExit(1, null, GENUINE_DECODE_GAP, false);

            await vi.waitFor(
                () =>
                    expect(mockProcessRunner.spawnFFmpeg.mock.calls.length).toBe(
                        spawnsAfterStart + 1,
                    ),
                { timeout: 5000 },
            );
            expect(job.status).not.toBe('error');
        });
    });
});

// ---------------------------------------------------------------------------
// D-HLS-1 follow-up (security runtime pass 2026-09-26): session stop
// callbacks were keyed on the RAW playSessionId at register/unregister, while
// stopJob() looks them up via originalSessionId() — resolved through the
// case-folded sessionKey() map to whichever spelling is currently "current"
// for that session. A case-variant re-request (e.g. the showcase route
// registering a slot-release callback under a second spelling of one session
// id) registered under a key stopJob() never looks up, so the callback never
// fired and the resource leaked until its own TTL fallback.
// ---------------------------------------------------------------------------
describe('registerSessionStopCallback / unregisterSessionStopCallback — case-folded keying', () => {
    let svcModule: typeof import('./ffmpeg-transcode.service.js');

    beforeEach(async () => {
        vi.resetModules();
        capturedCallbacks.clear();
        mockCfg.LUMASTRA_MAX_CONCURRENT_TRANSCODES = 100;
        mockProcessRunner.spawnFFmpeg.mockReset();
        mockProcessRunner.spawnFFmpeg.mockImplementation(
            async (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                job: any,
                _args: unknown,
                callbacks: {
                    onExit: (...a: unknown[]) => void;
                    onError: (...a: unknown[]) => void;
                },
            ) => {
                capturedCallbacks.set(job.id as string, callbacks);
            },
        );
        svcModule = await import('./ffmpeg-transcode.service.js');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('registered UPPERCASE, stopped via the lowercase original spelling: the callback fires exactly once', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const sidLower = 'stopcb-session-a';
        await svc.startJob(makeHandleExitTestConfig({ playSessionId: sidLower }));

        const cb = vi.fn();
        svc.registerSessionStopCallback(sidLower.toUpperCase(), cb);

        const stopped = await svc.stopJob(sidLower, 'user_stop');

        expect(stopped).toBe(true);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('registered lowercase, stopped via an UPPERCASE spelling: the callback fires exactly once', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const sidLower = 'stopcb-session-b';
        await svc.startJob(makeHandleExitTestConfig({ playSessionId: sidLower }));

        const cb = vi.fn();
        svc.registerSessionStopCallback(sidLower, cb);

        const stopped = await svc.stopJob(sidLower.toUpperCase(), 'user_stop');

        expect(stopped).toBe(true);
        expect(cb).toHaveBeenCalledTimes(1);
    });

    it('unregisterSessionStopCallback under a case-variant spelling removes the SAME entry', async () => {
        const svc = svcModule.getFFmpegTranscodeService();
        const sidLower = 'stopcb-session-c';
        await svc.startJob(makeHandleExitTestConfig({ playSessionId: sidLower }));

        const cb = vi.fn();
        svc.registerSessionStopCallback(sidLower, cb);
        svc.unregisterSessionStopCallback(sidLower.toUpperCase());

        const stopped = await svc.stopJob(sidLower, 'user_stop');

        expect(stopped).toBe(true);
        expect(cb).not.toHaveBeenCalled();
    });
});

describe('hasPlaybackConfigChanged — maxAudioChannels', () => {
    // A different channel cap means a different downmix, so the running job
    // must not be reused; the same cap (e.g. a client re-appending it) must.
    type Cfg = Parameters<typeof hasPlaybackConfigChanged>[0];

    function channelCapConfig(maxAudioChannels: number | undefined): Cfg {
        return {
            fileId: 'file-1',
            inputUrl: '/data/movies/The Handmaiden.mkv',
            forceAudioTranscode: true,
            videoInfo: { outputCodec: 'h264', isTranscoded: true },
            hlsOutput: { hlsAudioMode: 'demux' },
            maxAudioChannels,
        } as unknown as Cfg;
    }

    it('detects a channel cap change', () => {
        expect(hasPlaybackConfigChanged(channelCapConfig(6), channelCapConfig(2))).toBe(true);
    });

    it('detects a channel cap being added', () => {
        expect(hasPlaybackConfigChanged(channelCapConfig(undefined), channelCapConfig(2))).toBe(
            true,
        );
    });

    it('reuses the job when the same channel cap is requested again', () => {
        expect(hasPlaybackConfigChanged(channelCapConfig(2), channelCapConfig(2))).toBe(false);
    });
});
