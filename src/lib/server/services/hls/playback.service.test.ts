// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    startHlsPlayback,
    HlsPlaybackError,
    resolveVideoDisabled,
    buildConcatListContent,
} from './playback.service.js';
import type { HlsPlaybackRequest } from './playback.service.js';
import type { TranscodeJobConfig } from '../transcoding/types.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: vi.fn(),
}));

vi.mock('../../../../routes/api/playback/[itemId]/hls/file-selection.js', () => ({
    selectFileForPlayback: vi.fn(),
}));

vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: vi.fn(),
}));

vi.mock('../transcoding/media-probe.service.js', () => ({
    probeForTranscode: vi.fn(),
}));

vi.mock('../ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: vi.fn(),
    computeSegmentsFromKeyframes: vi.fn(() => []),
}));

vi.mock('$lib/server/utils/hls-master-playlist.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/utils/hls-master-playlist.js')>();
    return {
        generateMasterPlaylist: vi.fn(),
        generateMuxedMasterPlaylist: vi.fn(),
        // Real implementation — the wiring test asserts on the actual playlist
        // body (BANDWIDTH/RESOLUTION/CODECS), so stubbing it would make those
        // assertions vacuous.
        generateAudioOnlyMasterPlaylist: actual.generateAudioOnlyMasterPlaylist,
        AUDIO_ONLY_BANDWIDTH: actual.AUDIO_ONLY_BANDWIDTH,
        calculateEstimatedBandwidth: vi.fn(),
        // Real implementation — the client-detection policy is what these tests
        // assert on, so stubbing it would make the assertions vacuous.
        resolveSyntheticIframes: actual.resolveSyntheticIframes,
        isNativeHlsClient: actual.isNativeHlsClient,
        // Real implementation — it decides the advertised HEVC profile, and
        // getting it wrong is a playback-breaking codec mismatch. Same for the
        // job-derived wrapper: stubbing it would make the reused-job divergence
        // tests below assert against a stub rather than the real derivation.
        resolveHevcMain10: actual.resolveHevcMain10,
        resolveMasterHevcMain10: actual.resolveMasterHevcMain10,
    };
});

vi.mock('$lib/server/services/playback-planner.service.js', () => ({
    playbackPlanner: {
        getPlan: vi.fn(),
        refreshPlan: vi.fn(),
    },
}));

// D-HLS-3 seam guard's arm 1. Real `verifyPlaySessionOwnership` needs a real
// Postgres connection (see the dedicated integration test,
// playback.service.play-session-ownership.integration.test.ts, for the real
// seam) — mocked here to preserve every existing test's behavior (this file
// is not otherwise concerned with PlaySessionId ownership).
vi.mock('$lib/server/services/hls/play-session-ownership.js', () => ({
    verifyPlaySessionOwnership: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/utils/hls-request-utils.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/hls-request-utils.js')>();
    return {
        waitForHlsPlaylist: vi.fn(),
        HLS_CORS_HEADERS: { 'Access-Control-Allow-Origin': '*' },
        // Real implementation — pure URLSearchParams plumbing, and the audio-only
        // master now reaches this on every request (not just native-HLS), so it
        // needs to actually run rather than be undefined.
        addPlaybackIdentityToSearchParams: actual.addPlaybackIdentityToSearchParams,
        // Real implementation — the C1 seam guard tests below assert on the
        // actual charset regex, so stubbing it would make them vacuous.
        SAFE_PLAY_SESSION_ID_RE: actual.SAFE_PLAY_SESSION_ID_RE,
    };
});

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

vi.mock('fs/promises', () => ({
    writeFile: vi.fn(),
    unlink: vi.fn(),
    readFile: vi.fn(),
}));

vi.mock('node:os', () => ({
    tmpdir: () => '/tmp',
}));

vi.mock('node:crypto', () => ({
    randomUUID: vi.fn(() => 'generated-uuid-1234'),
}));

vi.mock('../trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getKeyframesForFile: vi.fn().mockResolvedValue(null),
    updateKeyframes: vi.fn().mockResolvedValue(undefined),
}));

const mockConfig = vi.hoisted(() => ({
    STREAM_LIMITS_ENFORCED: true,
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

// The real helper enumerates the local ffmpeg; a fixed value keeps the list
// content deterministic (FORMAT_WHITELIST_VALUE stays real).
vi.mock('$lib/server/utils/media-format-whitelist.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/media-format-whitelist.js')>()),
    getConcatPartFormatWhitelist: () => 'matroska,webm,mov,mp4',
}));

const mockEnforceStreamPolicy = vi.fn();
const mockGetEffectivePolicy = vi.fn();

vi.mock('$lib/server/services/play-sessions.service.js', () => ({
    enforceStreamPolicy: (...args: unknown[]) => mockEnforceStreamPolicy(...args),
    getEffectivePolicy: (...args: unknown[]) => mockGetEffectivePolicy(...args),
    // Same rule as the real helper (covered in play-sessions.service.test.ts).
    checkPlayMethodAllowed: (policy: { allowed_play_methods: string[] | null }, method: string) =>
        policy.allowed_play_methods === null || policy.allowed_play_methods.includes(method)
            ? null
            : {
                  kind: 'transcode_not_allowed',
                  allowed_methods: policy.allowed_play_methods,
                  suggestion: policy.allowed_play_methods[0] ?? 'direct',
              },
}));

// Real withTx just invokes the callback with the same sql handle — no actual
// transaction semantics needed since enforceStreamPolicy is mocked above.
vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: async (sql: unknown, cb: (sql: unknown) => Promise<unknown>) => cb(sql),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { playbackPlanner } from '$lib/server/services/playback-planner.service.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { selectFileForPlayback } from '../../../../routes/api/playback/[itemId]/hls/file-selection.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { probeForTranscode } from '../transcoding/media-probe.service.js';
import { getFFmpegTranscodeService } from '../ffmpeg-transcode.service.js';
import { PlaySessionOwnedByAnotherUserError } from '../transcoding/play-session-owner-error.js';
import { UserJobCapReachedError } from '../transcoding/user-job-cap-error.js';
import { TranscodeCapacityError } from '../transcoding/transcode-capacity-error.js';
import {
    generateMasterPlaylist,
    generateMuxedMasterPlaylist,
    calculateEstimatedBandwidth,
    AUDIO_ONLY_BANDWIDTH,
    type MasterPlaylistOptions,
} from '$lib/server/utils/hls-master-playlist.js';
import { waitForHlsPlaylist } from '$lib/server/utils/hls-request-utils.js';
import * as fsPromises from 'fs/promises';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

// ============================================================================
// Fixtures
// ============================================================================

const mockSql = {} as HlsPlaybackRequest['sql'];

const ITEM_ID = 'test-uuid-abcd';
const USERNAME = 'testuser';
const DEVICE_ID = 'test-device';
const SESSION_ID = 'client-session-id';

const mockMediaFile = {
    id: 'file-1',
    file_path: '/media/movie.mkv',
    edition: null,
    part_number: null,
};

const mockProbeResult = {
    audioTracks: [
        {
            index: asAbsoluteStreamIndex(1),
            codec: 'aac',
            channels: 2,
            language: 'eng',
            displayTitle: 'English',
            bitrate: 128000,
            isDefault: true,
        },
    ],
    subtitleTracks: [
        {
            index: 2,
            displayTitle: 'English',
            language: 'eng',
            codec: 'subrip',
            isDefault: false,
            isForced: false,
            isTextBased: true,
        },
    ],
    streams: [],
    videoCodec: 'h264',
    videoWidth: 1920,
    videoHeight: 1080,
    videoBitrate: 5000000,
    videoRange: 'SDR',
    durationSeconds: 3600,
    source: 'db' as const,
};

const mockJob = {
    id: 'job-123',
    outputDir: '/tmp/transcode/job-123',
    status: 'running' as const,
    segmentDurationSeconds: 6,
    transcodeDecisionResult: {
        audioAction: 'copy' as const,
        videoAction: 'copy' as const,
        useGpu: false,
        needsTonemapping: false,
        preserveHdr10: false,
        reasons: 0,
        mode: 'full' as const,
    },
    process: null,
    // username matches USERNAME: a mock "existing job" for these fixtures is
    // always this test's own authenticated user unless a case overrides it —
    // the D-HLS-3 live-job ownership check (arm 2) reads config.username.
    config: { username: USERNAME } as TranscodeJobConfig,
    startedAt: new Date(),
    lastAccessedAt: new Date(),
    lastProgressAt: new Date(),
    masterPlaylistReady: false,
    segmentsReady: 0,
    lastServedSegment: new Map<string, number>(),
    deletedUpTo: new Map<string, number>(),
    segmentOffset: 0,
    isSeeking: false,
    seekCount: 0,
    iframeData: [],
    iframeAnalyzedCount: 0,
    iframeAnalysisComplete: false,
    streamTargetDurations: new Map(),
};

function makeBaseRequest(overrides: Partial<HlsPlaybackRequest> = {}): HlsPlaybackRequest {
    return {
        sql: mockSql,
        itemId: ITEM_ID,
        username: USERNAME,
        deviceId: DEVICE_ID,
        playSessionId: SESSION_ID,
        segmentBase: `/api/playback/${ITEM_ID}/hls`,
        segmentParams: new URLSearchParams(`PlaySessionId=${SESSION_ID}`),
        ...overrides,
    };
}

function setupHappyPath(): void {
    vi.mocked(resolvePlaybackSelection).mockResolvedValue({
        files: [mockMediaFile] as unknown as Awaited<
            ReturnType<typeof resolvePlaybackSelection>
        >['files'],
        fileId: 'file-1',
    });
    vi.mocked(selectFileForPlayback).mockReturnValue({
        type: 'single',
        path: '/media/movie.mkv',
        fileId: 'file-1',
    });
    vi.mocked(resolveMediaPath).mockResolvedValue({
        isAccessible: true,
        containerPath: '/media/movie.mkv',
        reason: undefined,
    } as unknown as Awaited<ReturnType<typeof resolveMediaPath>>);
    vi.mocked(probeForTranscode).mockResolvedValue(mockProbeResult);
    const mockTranscodeService = {
        // D-HLS-3 arm 2 reads this directly (no longer `?.`-guarded) — a
        // missing implementation must not throw for the many tests that
        // never touch ownership.
        getJobByPlaySession: vi.fn(() => undefined),
        // D-HLS-3 arm 3: no persisted transcode row.
        getPersistedJobOwner: vi.fn(async () => null),
        // Echo the config back on the job, as the real service does for a fresh
        // start (`job.config === jobConfig`). The manifest's audio codec is
        // resolved from the JOB, so a job carrying an empty config would make
        // every codec assertion below describe a session that cannot exist.
        startJob: vi.fn().mockImplementation(async (cfg: TranscodeJobConfig) => ({
            ...mockJob,
            config: cfg,
        })),
    };
    vi.mocked(getFFmpegTranscodeService).mockReturnValue(
        mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
    );
    vi.mocked(waitForHlsPlaylist).mockResolvedValue(true);
    vi.mocked(calculateEstimatedBandwidth).mockReturnValue(10_000_000);
    vi.mocked(generateMasterPlaylist).mockReturnValue(
        '#EXTM3U\n#EXT-X-STREAM-INF:...\nstream_0/index.m3u8\n',
    );
}

// ============================================================================
// Tests
// ============================================================================

describe('startHlsPlayback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.STREAM_LIMITS_ENFORCED = true;
        mockEnforceStreamPolicy.mockResolvedValue(null);
        mockGetEffectivePolicy.mockResolvedValue({ allowed_play_methods: null });
    });

    describe('manifest-level stream-limit enforcement', () => {
        const USER_ID = '11111111-1111-4111-8111-111111111111';
        const POLICY_DEVICE_ID = 'dashboard-real-device-uuid';

        it('exempts a genuine preview (backed by a live transcode job)', async () => {
            setupHappyPath();
            // createPreview registers the preview job before the manifest is
            // fetched, so a genuine preview always resolves an existing job.
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(mockJob),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(
                makeBaseRequest({
                    userId: USER_ID,
                    playSessionId: 'preview-test-uuid-abcd-1234567890',
                }),
            );

            expect(mockEnforceStreamPolicy).not.toHaveBeenCalled();
        });

        it('ENFORCES a spoofed preview- playSessionId with no backing job (bypass closed)', async () => {
            setupHappyPath();
            // A client-supplied `preview-` id that was never minted server-side has
            // no transcode job — it must be treated as a normal stream, not exempt.
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(undefined),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(
                makeBaseRequest({
                    userId: USER_ID,
                    playSessionId: 'preview-x',
                }),
            );

            expect(mockEnforceStreamPolicy).toHaveBeenCalled();
        });

        it('skips enforcement when userId is absent (existing callers unaffected)', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(undefined),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest());

            expect(mockEnforceStreamPolicy).not.toHaveBeenCalled();
        });

        it('skips enforcement when STREAM_LIMITS_ENFORCED is false', async () => {
            mockConfig.STREAM_LIMITS_ENFORCED = false;
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(undefined),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ userId: USER_ID }));

            expect(mockEnforceStreamPolicy).not.toHaveBeenCalled();
        });

        it('skips enforcement when a job already exists for this playSessionId (seek/audio-track re-entry)', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(mockJob),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ userId: USER_ID }));

            expect(mockEnforceStreamPolicy).not.toHaveBeenCalled();
        });

        it('passes policyDeviceId (not the fixed deviceId) as device_id when provided', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(undefined),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(
                makeBaseRequest({ userId: USER_ID, policyDeviceId: POLICY_DEVICE_ID }),
            );

            expect(mockEnforceStreamPolicy).toHaveBeenCalledWith(
                expect.anything(),
                USER_ID,
                USERNAME,
                expect.any(String),
                // The play method is checked by the gate itself, not here.
                null,
                expect.objectContaining({ device_id: POLICY_DEVICE_ID }),
            );
        });

        it('falls back to the fixed deviceId when policyDeviceId is absent', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(undefined),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ userId: USER_ID }));

            expect(mockEnforceStreamPolicy).toHaveBeenCalledWith(
                expect.anything(),
                USER_ID,
                USERNAME,
                expect.any(String),
                // The play method is checked by the gate itself, not here.
                null,
                expect.objectContaining({ device_id: DEVICE_ID }),
            );
        });

        describe('allowed_play_methods (transcode_not_allowed)', () => {
            const remuxOnly = { allowed_play_methods: ['direct', 'remux'] };
            const transcodeDecision = {
                ...mockJob.transcodeDecisionResult,
                videoAction: 'transcode' as const,
            };
            const plan = (method: 'remux' | 'full_transcode') => ({
                plan_id: 'plan-m',
                intent: 'play' as const,
                delivery_path: 'mse_hls' as const,
                playback_branch: method === 'remux' ? ('remux_api' as const) : method,
                method,
                video_action: method === 'remux' ? ('copy' as const) : ('transcode' as const),
                audio_action: 'copy' as const,
                hls_audio_mode: 'muxed' as const,
                subtitle_method: 'none' as const,
                transcode_reasons: [],
                needs_tonemapping: false,
                file_id: 'file-1',
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 1800_000).toISOString(),
            });
            const service = (job: unknown = mockJob) => {
                const svc = {
                    startJob: vi.fn().mockResolvedValue(job),
                    getJobByPlaySession: vi.fn().mockReturnValue(undefined),
                    stopJob: vi.fn().mockResolvedValue(true),
                };
                vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                    svc as unknown as ReturnType<typeof getFFmpegTranscodeService>,
                );
                return svc;
            };

            it('refuses a plan that transcodes with 403 before spawning FFmpeg', async () => {
                setupHappyPath();
                mockGetEffectivePolicy.mockResolvedValue(remuxOnly);
                vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan('full_transcode'));
                vi.mocked(playbackPlanner.refreshPlan).mockResolvedValue(false);
                const svc = service();

                const err = await startHlsPlayback(
                    makeBaseRequest({ userId: USER_ID, planId: 'plan-m' }),
                ).catch((e: unknown) => e);

                expect(err).toBeInstanceOf(HlsPlaybackError);
                expect((err as HlsPlaybackError).statusCode).toBe(403);
                expect(JSON.parse((err as HlsPlaybackError).message)).toEqual({
                    error: 'transcode_not_allowed',
                    allowed_methods: ['direct', 'remux'],
                    suggestion: 'direct',
                });
                expect(svc.startJob).not.toHaveBeenCalled();
            });

            it('refuses when the real decision transcodes although the plan said remux, and stops the job', async () => {
                setupHappyPath();
                mockGetEffectivePolicy.mockResolvedValue(remuxOnly);
                vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan('remux'));
                vi.mocked(playbackPlanner.refreshPlan).mockResolvedValue(false);
                const svc = service({ ...mockJob, transcodeDecisionResult: transcodeDecision });

                await expect(
                    startHlsPlayback(makeBaseRequest({ userId: USER_ID, planId: 'plan-m' })),
                ).rejects.toMatchObject({ statusCode: 403 });
                expect(svc.startJob).toHaveBeenCalled();
                expect(svc.stopJob).toHaveBeenCalledWith(
                    expect.any(String),
                    'play_method_not_allowed',
                );
            });

            it('refuses a plan-less request whose decision transcodes', async () => {
                setupHappyPath();
                mockGetEffectivePolicy.mockResolvedValue(remuxOnly);
                const svc = service({ ...mockJob, transcodeDecisionResult: transcodeDecision });

                await expect(
                    startHlsPlayback(makeBaseRequest({ userId: USER_ID })),
                ).rejects.toMatchObject({ statusCode: 403 });
                expect(svc.stopJob).toHaveBeenCalled();
            });

            it('lets a remux through for a remux-allowed user', async () => {
                setupHappyPath();
                mockGetEffectivePolicy.mockResolvedValue(remuxOnly);
                const svc = service(); // mockJob decision is copy/copy = remux

                await startHlsPlayback(makeBaseRequest({ userId: USER_ID }));
                expect(svc.stopJob).not.toHaveBeenCalled();
            });

            it('still enforces with STREAM_LIMITS_ENFORCED=false (only the count is switched off)', async () => {
                mockConfig.STREAM_LIMITS_ENFORCED = false;
                setupHappyPath();
                mockGetEffectivePolicy.mockResolvedValue(remuxOnly);
                service({ ...mockJob, transcodeDecisionResult: transcodeDecision });

                await expect(
                    startHlsPlayback(makeBaseRequest({ userId: USER_ID })),
                ).rejects.toMatchObject({ statusCode: 403 });
                expect(mockEnforceStreamPolicy).not.toHaveBeenCalled();
            });

            it('does not re-check a seek / audio-track re-entry (existing job)', async () => {
                setupHappyPath();
                mockGetEffectivePolicy.mockResolvedValue(remuxOnly);
                const job = { ...mockJob, transcodeDecisionResult: transcodeDecision };
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    startJob: vi.fn().mockResolvedValue(job),
                    getJobByPlaySession: vi.fn().mockReturnValue(job),
                    stopJob: vi.fn(),
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

                await startHlsPlayback(makeBaseRequest({ userId: USER_ID }));
                expect(mockGetEffectivePolicy).not.toHaveBeenCalled();
            });
        });

        it('throws a 429 HlsPlaybackError when the policy reports stream_limit_exceeded', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                startJob: vi.fn().mockResolvedValue(mockJob),
                getJobByPlaySession: vi.fn().mockReturnValue(undefined),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);
            mockEnforceStreamPolicy.mockResolvedValue({
                kind: 'stream_limit_exceeded',
                active: 2,
                limit: 2,
            });

            await expect(
                startHlsPlayback(makeBaseRequest({ userId: USER_ID })),
            ).rejects.toMatchObject({ statusCode: 429 });
        });
    });

    describe('file resolution and probing', () => {
        it('resolves files and probes streams', async () => {
            setupHappyPath();

            const result = await startHlsPlayback(makeBaseRequest());

            expect(resolvePlaybackSelection).toHaveBeenCalledWith(mockSql, ITEM_ID, {
                fileId: undefined,
            });
            expect(probeForTranscode).toHaveBeenCalledWith(
                mockSql,
                ITEM_ID,
                '/media/movie.mkv',
                undefined,
                { fileId: 'file-1', forceFileProbe: false },
            );
            expect(result.contentType).toBe('application/vnd.apple.mpegurl');
        });

        it('throws HlsPlaybackError with 404 when no files found', async () => {
            vi.mocked(resolvePlaybackSelection).mockResolvedValue({
                files: [],
                fileId: null,
            });

            await expect(startHlsPlayback(makeBaseRequest())).rejects.toThrow(HlsPlaybackError);

            await expect(startHlsPlayback(makeBaseRequest())).rejects.toMatchObject({
                statusCode: 404,
            });
        });

        it('throws HlsPlaybackError with 503 when file not accessible', async () => {
            vi.mocked(resolvePlaybackSelection).mockResolvedValue({
                files: [mockMediaFile] as unknown as Awaited<
                    ReturnType<typeof resolvePlaybackSelection>
                >['files'],
                fileId: 'file-1',
            });
            vi.mocked(selectFileForPlayback).mockReturnValue({
                type: 'single',
                path: '/media/movie.mkv',
                fileId: 'file-1',
            });
            vi.mocked(resolveMediaPath).mockResolvedValue({
                isAccessible: false,
                containerPath: '/media/movie.mkv',
                reason: 'path not mounted',
            } as unknown as Awaited<ReturnType<typeof resolveMediaPath>>);

            await expect(startHlsPlayback(makeBaseRequest())).rejects.toMatchObject({
                statusCode: 503,
                message: expect.stringContaining('not accessible'),
            });
        });

        it('throws HlsPlaybackError with 503 when probe fails', async () => {
            vi.mocked(resolvePlaybackSelection).mockResolvedValue({
                files: [mockMediaFile] as unknown as Awaited<
                    ReturnType<typeof resolvePlaybackSelection>
                >['files'],
                fileId: 'file-1',
            });
            vi.mocked(selectFileForPlayback).mockReturnValue({
                type: 'single',
                path: '/media/movie.mkv',
                fileId: 'file-1',
            });
            vi.mocked(resolveMediaPath).mockResolvedValue({
                isAccessible: true,
                containerPath: '/media/movie.mkv',
                reason: undefined,
            } as unknown as Awaited<ReturnType<typeof resolveMediaPath>>);
            vi.mocked(probeForTranscode).mockRejectedValue(new Error('ffprobe not found'));

            await expect(startHlsPlayback(makeBaseRequest())).rejects.toMatchObject({
                statusCode: 503,
                message: 'ffprobe not found',
            });
        });
    });

    describe('HLS output config', () => {
        it('passes hlsOutput config to the transcode job', async () => {
            setupHappyPath();
            const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: mockStartJobFn,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            const hlsOutput = {
                hlsContainer: 'fmp4' as const,
                hlsAudioMode: 'demux' as const,
                hlsPlaylistType: 'event' as const,
                hlsVersion: 7 as const,
            };

            await startHlsPlayback(makeBaseRequest({ hlsOutput }));

            expect(mockStartJobFn).toHaveBeenCalledWith(expect.objectContaining({ hlsOutput }), {
                requireSameOwner: true,
            });
        });
    });

    describe('play session ID', () => {
        it('honors client-provided playSessionId', async () => {
            setupHappyPath();
            const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: mockStartJobFn,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ playSessionId: 'client-abc' }));

            expect(mockStartJobFn).toHaveBeenCalledWith(
                expect.objectContaining({ playSessionId: 'client-abc' }),
                { requireSameOwner: true },
            );
        });

        // HLS fixes report §4 item 1: the arms above run before startJob's
        // per-session lock, so the owner check is repeated INSIDE it.
        it('asks startJob to re-check the owner under its session lock', async () => {
            setupHappyPath();
            const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: mockStartJobFn,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest());

            expect(mockStartJobFn).toHaveBeenCalledWith(expect.anything(), {
                requireSameOwner: true,
            });
        });

        it('maps an under-lock owner refusal to 401, not the generic 503', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi
                    .fn()
                    .mockRejectedValue(new PlaySessionOwnedByAnotherUserError(SESSION_ID)),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await expect(startHlsPlayback(makeBaseRequest())).rejects.toMatchObject({
                name: 'HlsPlaybackError',
                statusCode: 401,
            });
        });

        // hls-fixes report §10 finding A: a principal several people share (the
        // showcase's per-IP one) asks startJob to refuse at the per-user cap
        // rather than evict a sibling session — another viewer's stream.
        it('forwards refuseAtUserCap to startJob only when the caller sets it', async () => {
            setupHappyPath();
            const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: mockStartJobFn,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ refuseAtUserCap: true }));

            expect(mockStartJobFn).toHaveBeenCalledWith(expect.anything(), {
                requireSameOwner: true,
                refuseAtUserCap: true,
            });
        });

        it('maps a per-user cap refusal to 429, not the generic 503', async () => {
            setupHappyPath();
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockRejectedValue(new UserJobCapReachedError(10)),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await expect(
                startHlsPlayback(makeBaseRequest({ refuseAtUserCap: true })),
            ).rejects.toMatchObject({ name: 'HlsPlaybackError', statusCode: 429 });
        });

        it.each(['transcode_capacity', 'transcode_load_shed'] as const)(
            'maps %s to a structured, retryable 503',
            async (code) => {
                setupHappyPath();
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: vi
                        .fn()
                        .mockRejectedValue(new TranscodeCapacityError('admission refused', code)),
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

                const err = await startHlsPlayback(makeBaseRequest()).catch((e: unknown) => e);

                expect(err).toMatchObject({
                    name: 'HlsPlaybackError',
                    statusCode: 503,
                    retryAfterSeconds: 30,
                });
                const playbackErr = err as HlsPlaybackError;
                expect(JSON.parse(playbackErr.message)).toMatchObject({
                    error: code,
                    retry_after: 30,
                });
                expect(playbackErr.retryHeaders).toEqual({
                    'Retry-After': '30',
                    'Content-Type': 'application/json',
                });
            },
        );

        it('generates a playSessionId when none provided', async () => {
            setupHappyPath();
            const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: mockStartJobFn,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ playSessionId: undefined }));

            expect(mockStartJobFn).toHaveBeenCalledWith(
                expect.objectContaining({
                    playSessionId: 'generated-uuid-1234',
                }),
                { requireSameOwner: true },
            );
        });

        // C1 (security review 3, 2026-09-15): PlaySessionId becomes part of the
        // transcode output directory via resolveOutputBaseDir's `path.join` —
        // an unvalidated `..` reaches FFmpeg's mkdir and, on stop/reap, an
        // `fs.rm`. This is the ONE seam all three callers (web player,
        // showcase, /j master.m3u8) share, so validating here closes it
        // regardless of whether the calling route validated its own input.
        describe('rejects a non-conforming playSessionId (C1 seam guard)', () => {
            const invalidIds = [
                '..',
                '../../app',
                'a/b',
                '',
                'x'.repeat(129), // one over the 128-char cap
            ];

            it.each(invalidIds)('rejects %j with a 400 HlsPlaybackError', async (badId) => {
                setupHappyPath();
                const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: mockStartJobFn,
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

                await expect(
                    startHlsPlayback(makeBaseRequest({ playSessionId: badId })),
                ).rejects.toMatchObject({
                    name: 'HlsPlaybackError',
                    statusCode: 400,
                });

                // The point of validating at this seam: rejection happens before
                // the job (and therefore resolveOutputBaseDir + mkdir) ever runs,
                // for ALL THREE callers of startHlsPlayback — not just the one
                // route that historically validated its own input.
                expect(mockStartJobFn).not.toHaveBeenCalled();
            });

            // Final wave M2: a raw `preview-cache-<key>` id names the SHARED
            // preview artifact job (preview-session.service.ts mints it and
            // starts that job directly with transcodeService.startJob — never
            // through this function). Accepted here, a request for a
            // different item found the artifact as `existingJob` (skipping
            // stream-limit enforcement) and startJob's config-change branch
            // stopped it, deleting the artifact directory under its viewers.
            // Refused with the segment handler's predicate
            // (`isRawPreviewCacheSessionId`, job-item-binding.ts), before any
            // transcode-service call.
            it.each(['preview-cache-abc123', 'PREVIEW-CACHE-abc123'])(
                'rejects a raw %j before any transcode-service call (artifact untouched)',
                async (rawId) => {
                    setupHappyPath();
                    const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
                    const mockGetJobByPlaySession = vi.fn().mockReturnValue(mockJob);
                    const mockStopJob = vi.fn();
                    vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                        startJob: mockStartJobFn,
                        getJobByPlaySession: mockGetJobByPlaySession,
                        stopJob: mockStopJob,
                    } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

                    await expect(
                        startHlsPlayback(makeBaseRequest({ playSessionId: rawId })),
                    ).rejects.toMatchObject({ name: 'HlsPlaybackError', statusCode: 400 });

                    expect(mockStartJobFn).not.toHaveBeenCalled();
                    expect(mockGetJobByPlaySession).not.toHaveBeenCalled();
                    expect(mockStopJob).not.toHaveBeenCalled();
                },
            );

            // Control: a viewer's own server-minted preview id
            // (`preview-<item>-<ts>-…`) still reaches startJob — only the
            // artifact prefix is refused.
            it('still accepts a viewer preview id (preview-<item>-…)', async () => {
                setupHappyPath();
                const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: mockStartJobFn,
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

                await startHlsPlayback(
                    makeBaseRequest({ playSessionId: `preview-${ITEM_ID}-1700000000000-ab12` }),
                );

                expect(mockStartJobFn).toHaveBeenCalled();
            });

            it('accepts a 128-char id (the boundary, not one over it)', async () => {
                setupHappyPath();
                const mockStartJobFn = vi.fn().mockResolvedValue(mockJob);
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: mockStartJobFn,
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

                await startHlsPlayback(makeBaseRequest({ playSessionId: 'x'.repeat(128) }));

                expect(mockStartJobFn).toHaveBeenCalled();
            });
        });
    });

    describe('transcode timeout', () => {
        it('throws HlsPlaybackError when playlist does not appear', async () => {
            setupHappyPath();
            vi.mocked(waitForHlsPlaylist).mockResolvedValue(false);

            await expect(
                startHlsPlayback(
                    makeBaseRequest({
                        hlsOutput: {
                            hlsContainer: 'fmp4',
                            hlsAudioMode: 'muxed',
                            hlsPlaylistType: 'vod',
                            hlsVersion: 7,
                        },
                    }),
                ),
            ).rejects.toMatchObject({
                statusCode: 503,
                message: expect.stringContaining('transcode_start_timeout'),
            });
        });
    });

    describe('muxed audio index threading (the Jellyfin default-audio path)', () => {
        // D12's fix lives in full-transcode-strategy: when `hlsAudioTrackIndex` is
        // undefined it falls back to the file's default track. That fallback can
        // only fire if this layer LEAVES it undefined. Coercing it to 0 anywhere
        // between here and the strategy would restore the original bug — absolute
        // 0 is the video stream, matches nothing, and drops through to container
        // order — and every unit test would still pass, because they all build
        // FullStrategyConfig by hand.
        //
        // The existing coverage is the positive branch only, and on the audio-only
        // rung. This is the normal muxed VIDEO path, which is what Apple TV takes.
        const muxedVideoRequest = (overrides: Partial<HlsPlaybackRequest> = {}) =>
            makeBaseRequest({
                deviceProfileId: 'apple-tv',
                hlsOutput: {
                    hlsContainer: 'fmp4',
                    hlsAudioMode: 'muxed',
                    hlsPlaylistType: 'vod',
                    hlsVersion: 7,
                },
                ...overrides,
            });

        const startedConfig = (startJob: ReturnType<typeof vi.fn>) =>
            startJob.mock.calls.at(-1)![0] as TranscodeJobConfig;

        it('leaves hlsAudioTrackIndex undefined when the client requests no track', async () => {
            setupHappyPath();
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(muxedVideoRequest());

            // NOT 0 — undefined is what lets the strategy pick the file default.
            expect(startedConfig(startJob).hlsOutput?.hlsAudioTrackIndex).toBeUndefined();
        });

        it('threads an explicitly requested track through on the muxed video path', async () => {
            setupHappyPath();
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(muxedVideoRequest({ audioStreamIndex: 3 }));

            expect(startedConfig(startJob).hlsOutput?.hlsAudioTrackIndex).toBe(3);
        });

        it('leaves it undefined rather than 0 when the requested index is NaN', async () => {
            setupHappyPath();
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(muxedVideoRequest({ audioStreamIndex: NaN }));

            expect(startedConfig(startJob).hlsOutput?.hlsAudioTrackIndex).toBeUndefined();
        });
    });

    describe('muxed master audio codec', () => {
        // The muxed master advertises ONE audio codec, and the segments carry
        // whichever track the strategy actually mapped. Those are computed in two
        // different files, so they can only agree by resolving the track the same
        // way. When no index is requested, full-transcode-strategy maps the FILE'S
        // DEFAULT track (defaultAudioAbsoluteIndex) — so a manifest derived from
        // `audioTracks[0]` describes a different track whenever the default is not
        // first in the container.
        //
        // Concretely: segments ec-3, manifest mp4a.40.2, AVFoundation rejects the
        // stream at playback start. Same failure the audio-copy comment in
        // full-transcode-strategy.ts:1082-1094 records from production, reversed.
        const ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT = [
            {
                index: asAbsoluteStreamIndex(1),
                codec: 'aac',
                channels: 2,
                language: 'eng',
                displayTitle: 'English',
                bitrate: 128000,
                isDefault: false,
            },
            {
                index: asAbsoluteStreamIndex(2),
                codec: 'eac3',
                channels: 6,
                language: 'ger',
                displayTitle: 'German',
                bitrate: 640000,
                isDefault: true,
            },
        ];

        // `audioCodec` is what becomes the CODECS attribute — see
        // getAudioCodecString in hls-master-playlist.ts, covered there.
        const muxedOptions = (): MasterPlaylistOptions =>
            vi.mocked(generateMuxedMasterPlaylist).mock.calls.at(-1)![4] as MasterPlaylistOptions;

        const tvOsMuxedRequest = (overrides: Partial<HlsPlaybackRequest> = {}) =>
            makeBaseRequest({
                // Native-HLS client: this is who gets the muxed master, and the
                // same population that omits an explicit audio index.
                deviceProfileId: 'apple-tv',
                hlsOutput: {
                    hlsContainer: 'fmp4',
                    hlsAudioMode: 'muxed',
                    hlsPlaylistType: 'vod',
                    hlsVersion: 7,
                },
                ...overrides,
            });

        it('advertises the DEFAULT track codec when no audio index is requested', async () => {
            setupHappyPath();
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                audioTracks: ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT,
            });

            await startHlsPlayback(tvOsMuxedRequest());

            // German (eac3) is the file default, so that is what gets muxed.
            expect(muxedOptions().audioCodec).toBe('eac3');
        });

        it('advertises the REQUESTED track codec when an audio index is given', async () => {
            setupHappyPath();
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                audioTracks: ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT,
            });

            await startHlsPlayback(tvOsMuxedRequest({ audioStreamIndex: 1 }));

            // English (aac) was asked for by absolute index, overriding the default.
            expect(muxedOptions().audioCodec).toBe('aac');
        });

        it.each([
            { index: 1, codec: 'aac' },
            { index: 2, codec: 'eac3' },
        ])(
            'advertises the v1 hlsAudioTrack selection $index on a fresh source',
            async ({ index, codec }) => {
                setupHappyPath();
                vi.mocked(probeForTranscode).mockResolvedValue({
                    ...mockProbeResult,
                    audioTracks: ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT,
                });
                const request = tvOsMuxedRequest();
                await startHlsPlayback({
                    ...request,
                    hlsOutput: { ...request.hlsOutput, hlsAudioTrackIndex: index },
                });
                expect(muxedOptions().audioCodec).toBe(codec);
            },
        );

        it('falls back to the first track when the requested index matches nothing', async () => {
            // Mirrors resolveAudioTrackByAbsoluteIndex's own no-match fallback, so
            // the manifest keeps describing whatever the strategy maps.
            setupHappyPath();
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                audioTracks: ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT,
            });

            await startHlsPlayback(tvOsMuxedRequest({ audioStreamIndex: 99 }));

            expect(muxedOptions().audioCodec).toBe('aac');
        });

        // Same file, but the DEFAULT track is first — so "resolve from the
        // request" and "resolve from the job" disagree, which is what makes the
        // reuse path below observable.
        const ENGLISH_AAC_DEFAULT_FIRST_GERMAN_EAC3 = ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT.map(
            (t) => ({ ...t, isDefault: t.language === 'eng' }),
        );

        it("advertises the REUSED job's track codec when the re-request omits the index", async () => {
            // The reuse path: ffmpeg-transcode.service only rewrites
            // `existing.config.hlsOutput` when it detects an audio-track CHANGE,
            // and `newAudioIndex === undefined` is not a change — so a session
            // started with AudioStreamIndex=2 keeps muxing German (eac3) while a
            // re-request that omits the index resolves the file default (English,
            // aac) from the REQUEST. Manifest ec-3 vs segments mp4a.40.2 is the
            // 'fmt?' / CoreMediaErrorDomain 1718449215 rejection. Read the JOB.
            setupHappyPath();
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                audioTracks: ENGLISH_AAC_DEFAULT_FIRST_GERMAN_EAC3,
            });
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockResolvedValue({
                    ...mockJob,
                    config: {
                        hlsOutput: {
                            hlsContainer: 'fmp4',
                            hlsAudioMode: 'muxed',
                            hlsPlaylistType: 'vod',
                            hlsVersion: 7,
                            hlsAudioTrackIndex: 2,
                        },
                    } as unknown as TranscodeJobConfig,
                }),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(tvOsMuxedRequest());

            expect(muxedOptions().audioCodec).toBe('eac3');
        });
    });

    describe('muxed mode', () => {
        it('returns rewritten index.m3u8 with absolute segment URLs', async () => {
            setupHappyPath();

            const request = makeBaseRequest({
                hlsOutput: {
                    hlsContainer: 'mpegts',
                    hlsAudioMode: 'muxed',
                    hlsPlaylistType: 'vod',
                    hlsVersion: 3,
                },
                segmentBase: `/j/Videos/${ITEM_ID}/hls`,
                segmentParams: new URLSearchParams(`PlaySessionId=${SESSION_ID}`),
            });

            const result = await startHlsPlayback(request);

            expect(result.playlistBody).toContain('/j/Videos/');
            expect(result.playlistBody).toContain('segment_');
            expect(result.playlistBody).toContain(`PlaySessionId=${SESSION_ID}`);
            expect(generateMasterPlaylist).not.toHaveBeenCalled();
        });
    });

    describe('demux mode', () => {
        it('calls generateMasterPlaylist for demux mode', async () => {
            setupHappyPath();

            const result = await startHlsPlayback(makeBaseRequest());

            expect(generateMasterPlaylist).toHaveBeenCalledWith(
                mockProbeResult.audioTracks,
                mockProbeResult.subtitleTracks,
                expect.any(String),
                expect.any(URLSearchParams),
                expect.any(Number),
                expect.objectContaining({ codec: 'h264' }),
                expect.anything(),
                ITEM_ID,
                'file-1',
                undefined,
                expect.any(Object),
            );
            expect(result.contentType).toBe('application/vnd.apple.mpegurl');
        });

        it('leaves subtitle renditions out of the master for the web player', async () => {
            // iOS Safari rejects a master with its own SUBTITLES group when the
            // <video> also has a <track> child (MediaError 4); the web player
            // renders subtitles itself.
            setupHappyPath();

            await startHlsPlayback(makeBaseRequest({ omitManifestSubtitles: true }));

            expect(vi.mocked(generateMasterPlaylist).mock.calls[0]?.[1]).toBeUndefined();
        });

        // Copy-mode video on native_hls now resolves to DEMUX for tvOS (so AVPlayer
        // gets an EXT-X-MEDIA audio group and therefore a language picker). That
        // moves Apple TV off the muxed master — which is where the synthetic
        // I-frame variant was wired — and onto this one. It has to be offered the
        // scrubbing variant here too, or restoring the language picker silently
        // costs it the scrubbing thumbnails.
        // The options argument (11th) is what carries the decision. The generator
        // itself still gates on trickplayInfo, so this pins the request, not the
        // emission — the emission is covered in hls-master-playlist.test.ts.
        const masterOptions = (): MasterPlaylistOptions =>
            vi.mocked(generateMasterPlaylist).mock.calls[0][10] as MasterPlaylistOptions;

        it('requests synthetic I-frames on the demux master for a tvOS client', async () => {
            setupHappyPath();

            await startHlsPlayback(makeBaseRequest({ deviceProfileId: 'apple-tv' }));

            expect(masterOptions()).toMatchObject({ syntheticIframes: true });
        });

        it('recognises a tvOS User-Agent when no device profile is sent', async () => {
            setupHappyPath();

            await startHlsPlayback(
                makeBaseRequest({ userAgent: 'Lumastra/1.0 (Apple TV; tvOS 17.4)' }),
            );

            expect(masterOptions()).toMatchObject({ syntheticIframes: true });
        });

        it('a second request with a new hlsAudioTrack marks the new DEFAULT on the same demux job', async () => {
            // iOS switches audio by reloading with another hlsAudioTrack; a demux
            // job is never restarted for it, so job.config still holds the first
            // choice and the request must win.
            setupHappyPath();
            const tracks = [
                { ...mockProbeResult.audioTracks[0], isDefault: true },
                {
                    ...mockProbeResult.audioTracks[0],
                    index: asAbsoluteStreamIndex(2),
                    language: 'ger',
                    displayTitle: 'German',
                    isDefault: false,
                },
            ];
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                audioTracks: tracks,
            });
            const demuxOutput = (hlsAudioTrackIndex: number) => ({
                hlsContainer: 'fmp4' as const,
                hlsAudioMode: 'demux' as const,
                hlsPlaylistType: 'vod' as const,
                hlsVersion: 7 as const,
                hlsAudioTrackIndex,
            });
            // The one job both requests land on; its config keeps the first choice.
            const sharedJob = {
                ...mockJob,
                config: {
                    username: USERNAME,
                    hlsOutput: demuxOutput(1),
                } as unknown as TranscodeJobConfig,
            };
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockResolvedValue(sharedJob),
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);
            const lastOptions = (): MasterPlaylistOptions =>
                vi.mocked(generateMasterPlaylist).mock.calls.at(-1)![10] as MasterPlaylistOptions;

            await startHlsPlayback(makeBaseRequest({ hlsOutput: demuxOutput(1) }));
            expect(lastOptions().selectedAudioStreamIndex).toBe(1);

            await startHlsPlayback(makeBaseRequest({ hlsOutput: demuxOutput(2) }));
            expect(lastOptions().selectedAudioStreamIndex).toBe(2);
            // The job was not touched by the second request.
            expect(sharedJob.config.hlsOutput?.hlsAudioTrackIndex).toBe(1);
        });

        // ── the reused-job CODECS divergence ──────────────────────────────
        //
        // The master is built from BOTH this service and, on re-fetch,
        // serveMasterPlaylist in lumastra-segment-handler. The handler derives
        // every resolveHevcMain10 input from the JOB. This service derives three
        // of the four from THIS REQUEST while taking gpuEncoder from the job —
        // mixed provenance inside a single call.
        //
        // On a reused job the two disagree. ffmpeg-transcode.service only
        // rewrites persisted config on an AUDIO-track change, so a session
        // started as a video copy keeps `videoAction: 'copy'` while a re-request
        // carrying a codec override computes `transcode` here. isVideoTranscoded
        // is the FIRST gate in resolveHevcMain10, so that flips the profile byte:
        // the initial master says hvc1.1.6 and the post-seek master says
        // hvc1.2.4 for the same session, and AVFoundation rejects mid-playback
        // with 'fmt?' (CoreMediaErrorDomain 1718449215).
        //
        // This is the exact failure resolveHevcMain10 was extracted to end —
        // "the same request produced hvc1.1.6 from one and hvc1.2.4 from the
        // other". The FUNCTION was unified; its INPUTS were not. The manifest
        // describes the segments ffmpeg is actually writing, so the job wins.
        const masterVideoInfo = () =>
            vi.mocked(generateMasterPlaylist).mock.calls[0][5] as
                { outputHevcMain10?: boolean } | undefined;

        it('derives the HEVC profile from the JOB, not from a re-request override', async () => {
            setupHappyPath();

            await startHlsPlayback(makeBaseRequest({ videoCodec: 'hevc' }));

            // mockJob persists videoAction: 'copy'. Request-derived inputs would
            // say "transcoding to HEVC" and stamp Main 10; job-derived says the
            // bitstream is a copy, so Main 10 must NOT be declared.
            expect(masterVideoInfo()?.outputHevcMain10).toBe(false);
        });

        it('still declares Main 10 when the JOB itself is an HEVC transcode', async () => {
            // The mirror case, so the fix cannot degenerate into "always false".
            setupHappyPath();
            const mockTranscodeService = {
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockImplementation(async (cfg: TranscodeJobConfig) => ({
                    ...mockJob,
                    config: cfg,
                    transcodeDecisionResult: {
                        ...mockJob.transcodeDecisionResult,
                        videoAction: 'transcode' as const,
                    },
                })),
            };
            vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
            );

            await startHlsPlayback(makeBaseRequest({ videoCodec: 'hevc' }));

            expect(masterVideoInfo()?.outputHevcMain10).toBe(true);
        });

        it('does NOT request synthetic I-frames for a browser client', async () => {
            setupHappyPath();

            await startHlsPlayback(makeBaseRequest());

            expect(masterOptions()).toMatchObject({ syntheticIframes: false });
        });

        // ── per-request quality cap reflected in the manifest ──────────────
        //
        // A ?maxHeight cap that forces (or accompanies) a video transcode must
        // make the manifest describe the CAPPED output, not the source —
        // otherwise a client picking a low-bandwidth profile still gets a
        // BANDWIDTH/RESOLUTION line advertising the full source geometry.
        describe('quality cap', () => {
            function withQualityCapJob(
                qualityCap: { maxBitrate?: number; maxHeight?: number } | undefined,
            ): void {
                const mockTranscodeService = {
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: vi.fn().mockImplementation(async (cfg: TranscodeJobConfig) => ({
                        ...mockJob,
                        config: { ...cfg, qualityCap },
                        transcodeDecisionResult: {
                            ...mockJob.transcodeDecisionResult,
                            videoAction: 'transcode' as const,
                        },
                    })),
                };
                vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                    mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
                );
            }

            it('shrinks RESOLUTION/BANDWIDTH to the capped output when maxHeight forces a transcode', async () => {
                setupHappyPath();
                // mockProbeResult source is 1920x1080 / 5 Mbps — a 720p cap must
                // shrink it, aspect-preserving, to 1280x720, and the BANDWIDTH must
                // come from the IMPLIED budget for 720p (4 Mbps), not the source.
                withQualityCapJob({ maxHeight: 720 });

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxHeight: 720 } }));

                // Implied budget for 720p = 4_000_000; reservation = 20% = 800_000,
                // clamped down to the 512_000 ceiling; video = 4_000_000 - 512_000.
                expect(masterVideoInfo()).toMatchObject({
                    width: 1280,
                    height: 720,
                    bitrate: 3_488_000,
                });
                const bandwidthArg = vi.mocked(generateMasterPlaylist).mock.calls[0][4];
                // calculateEstimatedBandwidth is mocked to a fixed value at the
                // module boundary — what we can assert here is that it was
                // called with the CAPPED videoInfo (width 1280), not the source
                // (1920), so a real implementation would compute off the right
                // numbers.
                expect(vi.mocked(calculateEstimatedBandwidth)).toHaveBeenCalledWith(
                    expect.objectContaining({ width: 1280, height: 720, bitrate: 3_488_000 }),
                    expect.anything(),
                );
                expect(bandwidthArg).toBe(10_000_000); // the mocked calculateEstimatedBandwidth return
            });

            it('leaves RESOLUTION at the source when the source is already within the cap', async () => {
                setupHappyPath();
                // mockProbeResult source is 1920x1080 — well within a 4K cap, so
                // nothing should be overridden even though the job transcodes.
                withQualityCapJob({ maxHeight: 2160 });

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxHeight: 2160 } }));

                expect(masterVideoInfo()).toMatchObject({ width: 1920, height: 1080 });
                expect(masterVideoInfo()).not.toHaveProperty('bitrate');
            });

            it('leaves RESOLUTION at the source when no quality cap is set', async () => {
                setupHappyPath();
                withQualityCapJob(undefined);

                await startHlsPlayback(makeBaseRequest());

                expect(masterVideoInfo()).toMatchObject({ width: 1920, height: 1080 });
                expect(masterVideoInfo()).not.toHaveProperty('bitrate');
            });

            // Item A: dimensions and bitrate are independent — a maxBitrate-ONLY
            // cap has no height bound to shrink but must still override BANDWIDTH.
            it('advertises the capped bitrate for a maxBitrate-only cap, without touching RESOLUTION', async () => {
                setupHappyPath();
                withQualityCapJob({ maxBitrate: 4_000_000 });

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxBitrate: 4_000_000 } }));

                // reservation = 20% of 4_000_000 = 800_000, clamped to 512_000;
                // video = 4_000_000 - 512_000 = 3_488_000.
                expect(masterVideoInfo()).toMatchObject({
                    width: 1920,
                    height: 1080,
                    bitrate: 3_488_000,
                });
            });

            // Item B: both bounds set and the height cap binds — the SMALLER of
            // maxBitrate and the height's implied budget wins.
            it('uses the smaller of maxBitrate and the implied height budget when both are set', async () => {
                setupHappyPath();
                withQualityCapJob({ maxHeight: 720, maxBitrate: 2_000_000 });

                await startHlsPlayback(
                    makeBaseRequest({ qualityCap: { maxHeight: 720, maxBitrate: 2_000_000 } }),
                );

                // effective budget = min(2_000_000, implied 4_000_000) = 2_000_000;
                // reservation = 20% = 400_000 (no clamp); video = 1_600_000.
                expect(masterVideoInfo()).toMatchObject({
                    width: 1280,
                    height: 720,
                    bitrate: 1_600_000,
                });
            });

            // Item 1 of the re-review: a burn-in-style transcode (video forced
            // to transcode for a reason OTHER than the cap — burn-in leaves
            // audio copy-eligible) on a source the cap does NOT bind on its
            // own, with a 640k copied audio track and a 3M cap. The flat 20%
            // reservation (600k, clamped to 512k) is NOT enough to cover the
            // real copied bitrate — it must bump to 640k, or video+audio
            // together exceed maxBitrate.
            it('bumps the reservation to the real copied-audio bitrate on a burn-in transcode of a within-cap source', async () => {
                setupHappyPath();
                // Source bitrate (2 Mbps) is WITHIN the 3M cap — this cap does
                // not bind on its own; the video transcode is simulated as
                // being forced by something else (e.g. burn-in) via
                // withQualityCapJob's videoAction override below. Audio stays
                // 'copy' (mockJob's default), at a real 640k bitrate.
                vi.mocked(probeForTranscode).mockResolvedValueOnce({
                    ...mockProbeResult,
                    videoBitrate: 2_000_000,
                    audioTracks: [{ ...mockProbeResult.audioTracks[0], bitrate: 640_000 }],
                });
                withQualityCapJob({ maxBitrate: 3_000_000 });

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxBitrate: 3_000_000 } }));

                // effective budget = 3_000_000; base reservation = clamp(20% =
                // 600_000, 128k, 512k) = 512_000; bumped to the real copied
                // bitrate (640_000, since 640_000 > 512_000); video =
                // 3_000_000 - 640_000 = 2_360_000.
                expect(masterVideoInfo()).toMatchObject({ bitrate: 2_360_000 });
            });
        });

        // The client's declared channel cap (`?maxAudioChannels`, baked into the
        // /info play_methods URLs). Copied 5.1 reached an `mc:2` client untouched.
        describe('channel cap — forces audio transcode and caps advertised CHANNELS', () => {
            function spyStartJob(): ReturnType<typeof vi.fn> {
                const startJobSpy = vi.fn().mockImplementation(async (cfg: TranscodeJobConfig) => ({
                    ...mockJob,
                    config: cfg,
                }));
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: startJobSpy,
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);
                return startJobSpy;
            }

            function surroundProbe(): void {
                vi.mocked(probeForTranscode).mockResolvedValueOnce({
                    ...mockProbeResult,
                    audioTracks: [
                        { ...mockProbeResult.audioTracks[0], codec: 'eac3', channels: 6 },
                    ],
                });
            }

            it('forces audio transcode and passes the cap when a track exceeds it', async () => {
                setupHappyPath();
                surroundProbe();
                const startJobSpy = spyStartJob();

                await startHlsPlayback(makeBaseRequest({ maxAudioChannels: 2 }));

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: true, maxAudioChannels: 2 }),
                    { requireSameOwner: true },
                );
                const [tracks] = vi.mocked(generateMasterPlaylist).mock.calls.at(-1)!;
                expect(tracks.map((t) => t.channels)).toEqual([2]);
            });

            it('leaves audio and CHANNELS alone without a cap (comparison)', async () => {
                setupHappyPath();
                surroundProbe();
                const startJobSpy = spyStartJob();

                await startHlsPlayback(makeBaseRequest({}));

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: false }),
                    { requireSameOwner: true },
                );
                const [tracks] = vi.mocked(generateMasterPlaylist).mock.calls.at(-1)!;
                expect(tracks.map((t) => t.channels)).toEqual([6]);
            });

            // Muxed mode delivers only the SELECTED track, which this route
            // receives as `?hlsAudioTrack` (hlsOutput.hlsAudioTrackIndex) — not
            // `audioStreamIndex`. Judging the default track instead let a
            // selected 5.1 track be copied to an `mc:2` client.
            function stereoDefaultPlusSurround(): void {
                vi.mocked(probeForTranscode).mockResolvedValueOnce({
                    ...mockProbeResult,
                    audioTracks: [
                        {
                            ...mockProbeResult.audioTracks[0],
                            index: asAbsoluteStreamIndex(1),
                            isDefault: true,
                            codec: 'aac',
                            channels: 2,
                        },
                        {
                            ...mockProbeResult.audioTracks[0],
                            index: asAbsoluteStreamIndex(2),
                            isDefault: false,
                            codec: 'eac3',
                            channels: 6,
                        },
                    ],
                });
            }

            it('muxed: judges the track selected via hlsAudioTrack, not the default', async () => {
                setupHappyPath();
                stereoDefaultPlusSurround();
                const startJobSpy = spyStartJob();

                await startHlsPlayback(
                    makeBaseRequest({
                        maxAudioChannels: 2,
                        hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 2 },
                    }),
                );

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: true }),
                    { requireSameOwner: true },
                );
            });

            it('muxed: a selected stereo track fits even when another track is 5.1', async () => {
                setupHappyPath();
                stereoDefaultPlusSurround();
                const startJobSpy = spyStartJob();

                await startHlsPlayback(
                    makeBaseRequest({
                        maxAudioChannels: 2,
                        hlsOutput: { hlsAudioMode: 'muxed', hlsAudioTrackIndex: 1 },
                    }),
                );

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: false }),
                    { requireSameOwner: true },
                );
            });

            it('does not force a transcode when every track fits the cap', async () => {
                setupHappyPath();
                surroundProbe();
                const startJobSpy = spyStartJob();

                await startHlsPlayback(makeBaseRequest({ maxAudioChannels: 6 }));

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: false, maxAudioChannels: 6 }),
                    { requireSameOwner: true },
                );
            });
        });

        // Item C: a copied audio track whose bitrate would blow the cap's audio
        // reservation must switch to transcode for the whole job — the one way
        // audio can still be copied alongside a transcoding video is subtitle
        // burn-in, and its source AC-3/E-AC-3 bitrate is unconstrained otherwise.
        describe('quality cap — audio budget forces copy to transcode', () => {
            function spyStartJob(): ReturnType<typeof vi.fn> {
                const startJobSpy = vi.fn().mockImplementation(async (cfg: TranscodeJobConfig) => ({
                    ...mockJob,
                    config: cfg,
                    transcodeDecisionResult: {
                        ...mockJob.transcodeDecisionResult,
                        videoAction: 'transcode' as const,
                    },
                }));
                vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                    getJobByPlaySession: vi.fn(() => undefined),
                    startJob: startJobSpy,
                } as unknown as ReturnType<typeof getFFmpegTranscodeService>);
                return startJobSpy;
            }

            it('forces audio transcode when the copied track exceeds the reservation', async () => {
                setupHappyPath();
                // 720p cap -> implied budget 4M -> reservation clamps to 512k.
                // A 700k source track exceeds that.
                vi.mocked(probeForTranscode).mockResolvedValueOnce({
                    ...mockProbeResult,
                    audioTracks: [{ ...mockProbeResult.audioTracks[0], bitrate: 700_000 }],
                });
                const startJobSpy = spyStartJob();

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxHeight: 720 } }));

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: true }),
                    { requireSameOwner: true },
                );
            });

            it('forces audio transcode when the copied track bitrate is unknown', async () => {
                setupHappyPath();
                vi.mocked(probeForTranscode).mockResolvedValueOnce({
                    ...mockProbeResult,
                    audioTracks: [{ ...mockProbeResult.audioTracks[0], bitrate: undefined }],
                });
                const startJobSpy = spyStartJob();

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxHeight: 720 } }));

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: true }),
                    { requireSameOwner: true },
                );
            });

            it('leaves audio alone when the copied track fits within the reservation', async () => {
                setupHappyPath();
                // Default mockProbeResult audio bitrate is 128k, well within the
                // 720p cap's ~512k reservation.
                const startJobSpy = spyStartJob();

                await startHlsPlayback(makeBaseRequest({ qualityCap: { maxHeight: 720 } }));

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: false }),
                    { requireSameOwner: true },
                );
            });

            it('does not force audio transcode when the cap is set but not binding', async () => {
                setupHappyPath();
                const startJobSpy = spyStartJob();

                // Source is 1920x1080 / 5 Mbps; this cap is generous enough that
                // it never binds — "change nothing".
                await startHlsPlayback(
                    makeBaseRequest({
                        qualityCap: { maxHeight: 2160, maxBitrate: 100_000_000 },
                    }),
                );

                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: false }),
                    { requireSameOwner: true },
                );
            });

            // Item 2 of the re-review: a muxed job delivers only the SELECTED
            // track. An unselected track's bitrate must not force the whole
            // job to transcode audio it never actually sends.
            it('muxed mode: ignores an unselected track exceeding the reservation', async () => {
                setupHappyPath();
                // Source bitrate (5 Mbps) exceeds the 3M cap, so it BINDS —
                // reservation = clamp(20% of 3M, 128k, 512k) = 512k.
                vi.mocked(probeForTranscode).mockResolvedValueOnce({
                    ...mockProbeResult,
                    audioTracks: [
                        {
                            ...mockProbeResult.audioTracks[0],
                            index: asAbsoluteStreamIndex(1),
                            isDefault: true,
                            codec: 'aac',
                            bitrate: 192_000,
                        },
                        {
                            ...mockProbeResult.audioTracks[0],
                            index: asAbsoluteStreamIndex(2),
                            isDefault: false,
                            codec: 'eac3',
                            bitrate: 1_500_000,
                        },
                    ],
                });
                const startJobSpy = spyStartJob();

                await startHlsPlayback(
                    makeBaseRequest({
                        qualityCap: { maxBitrate: 3_000_000 },
                        hlsOutput: { hlsAudioMode: 'muxed' },
                    }),
                );

                // The default (isDefault:true) 192k AAC track is the one
                // muxed — it fits the 512k reservation. The 1.5M E-AC-3
                // track is never delivered by this job and must be ignored.
                expect(startJobSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ forceAudioTranscode: false }),
                    { requireSameOwner: true },
                );
            });
        });
    });

    describe('plan/file coherence', () => {
        const makePlan = (fileId: string) => ({
            plan_id: 'plan-aaa',
            intent: 'play' as const,
            delivery_path: 'mse_hls' as const,
            playback_branch: 'full_transcode' as const,
            method: 'full_transcode' as const,
            video_action: 'transcode' as const,
            audio_action: 'copy' as const,
            hls_audio_mode: 'muxed' as const,
            subtitle_method: 'none' as const,
            transcode_reasons: ['codec incompatible'],
            needs_tonemapping: false,
            file_id: fileId,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 1800_000).toISOString(),
        });

        it('ignores plan whose file_id does not match resolved file', async () => {
            setupHappyPath();
            // Plan was created for a different file
            vi.mocked(playbackPlanner.getPlan).mockResolvedValue(makePlan('wrong-file-id'));
            vi.mocked(playbackPlanner.refreshPlan).mockResolvedValue(false);

            const mockTranscodeService = {
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockResolvedValue(mockJob),
            };
            vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
            );

            await startHlsPlayback(makeBaseRequest({ planId: 'plan-aaa' }));

            // The transcode job should NOT receive the mismatched plan
            expect(mockTranscodeService.startJob).toHaveBeenCalledWith(
                expect.objectContaining({ playbackPlan: undefined }),
                { requireSameOwner: true },
            );
        });

        it('passes plan through when file_id matches', async () => {
            setupHappyPath();
            const plan = makePlan('file-1'); // matches mockMediaFile.id
            vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan);
            vi.mocked(playbackPlanner.refreshPlan).mockResolvedValue(false);

            const mockTranscodeService = {
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockResolvedValue(mockJob),
            };
            vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
            );

            await startHlsPlayback(makeBaseRequest({ planId: 'plan-aaa' }));

            expect(mockTranscodeService.startJob).toHaveBeenCalledWith(
                expect.objectContaining({ playbackPlan: plan }),
                { requireSameOwner: true },
            );
        });

        it('overrides demux HLS requests when the plan requires muxed audio', async () => {
            setupHappyPath();
            const plan = makePlan('file-1');
            vi.mocked(playbackPlanner.getPlan).mockResolvedValue(plan);
            vi.mocked(playbackPlanner.refreshPlan).mockResolvedValue(false);

            const mockTranscodeService = {
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockResolvedValue(mockJob),
            };
            vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
            );

            await startHlsPlayback(
                makeBaseRequest({
                    planId: 'plan-aaa',
                    hlsOutput: {
                        hlsAudioMode: 'demux',
                        hlsContainer: 'fmp4',
                        hlsPlaylistType: 'event',
                        hlsVersion: 7,
                    },
                }),
            );

            expect(mockTranscodeService.startJob).toHaveBeenCalledWith(
                expect.objectContaining({
                    hlsOutput: expect.objectContaining({
                        hlsAudioMode: 'muxed',
                        hlsContainer: 'fmp4',
                    }),
                }),
                { requireSameOwner: true },
            );
        });
    });

    describe('concat demuxer', () => {
        it('writes concat tmp file for multi-part media', async () => {
            vi.mocked(resolvePlaybackSelection).mockResolvedValue({
                files: [
                    {
                        id: 'f1',
                        file_path: '/media/part1.mkv',
                        edition: null,
                        part_number: 1,
                    },
                    {
                        id: 'f2',
                        file_path: '/media/part2.mkv',
                        edition: null,
                        part_number: 2,
                    },
                ] as unknown as Awaited<ReturnType<typeof resolvePlaybackSelection>>['files'],
                fileId: 'f1',
            });
            vi.mocked(selectFileForPlayback).mockReturnValue({
                type: 'concat',
                paths: ['/media/part1.mkv', '/media/part2.mkv'],
                fileIds: ['f1', 'f2'],
            });
            vi.mocked(resolveMediaPath).mockResolvedValue({
                isAccessible: true,
                containerPath: '/media/part1.mkv',
                reason: undefined,
            } as unknown as Awaited<ReturnType<typeof resolveMediaPath>>);
            vi.mocked(probeForTranscode).mockResolvedValue(mockProbeResult);
            const mockTranscodeService = {
                getJobByPlaySession: vi.fn(() => undefined),
                startJob: vi.fn().mockResolvedValue(mockJob),
            };
            vi.mocked(getFFmpegTranscodeService).mockReturnValue(
                mockTranscodeService as unknown as ReturnType<typeof getFFmpegTranscodeService>,
            );
            vi.mocked(waitForHlsPlaylist).mockResolvedValue(true);
            vi.mocked(calculateEstimatedBandwidth).mockReturnValue(10_000_000);
            vi.mocked(generateMasterPlaylist).mockReturnValue('#EXTM3U\n');

            await startHlsPlayback(makeBaseRequest());

            expect(fsPromises.writeFile).toHaveBeenCalledWith(
                expect.stringContaining('lumastra-concat-'),
                expect.stringContaining("file '/media/part1.mkv'"),
                'utf-8',
            );
            // F4: the real entry point writes each part's own format whitelist.
            expect(vi.mocked(fsPromises.writeFile).mock.calls.at(-1)?.[1]).toBe(
                "file '/media/part1.mkv'\noption format_whitelist 'matroska,webm,mov,mp4'\n" +
                    "file '/media/part2.mkv'\noption format_whitelist 'matroska,webm,mov,mp4'",
            );
            expect(mockTranscodeService.startJob).toHaveBeenCalledWith(
                expect.objectContaining({ useConcatDemuxer: true }),
                { requireSameOwner: true },
            );
        });

        // F5 (fix plan 6, Task 7 fix round 1): the earlier buildConcatListContent
        // unit tests above drive the exported pure builder directly, which never
        // proved the REAL playback entry point (writeConcatTmpFile, called from
        // startHlsPlayback) actually uses it rather than some other inlined
        // string-join. This seam test drives startHlsPlayback itself with a
        // control-char part path and asserts the whole request fails — and that
        // fs.writeFile (the only way the list could reach disk) is never called.
        it('startHlsPlayback rejects when a part path contains a control character (seam)', async () => {
            vi.mocked(resolvePlaybackSelection).mockResolvedValue({
                files: [
                    { id: 'f1', file_path: '/media/part1.mkv', edition: null, part_number: 1 },
                    {
                        id: 'f2',
                        file_path: "/media/part2\nfile '/tmp/outside.mkv'.mkv",
                        edition: null,
                        part_number: 2,
                    },
                ] as unknown as Awaited<ReturnType<typeof resolvePlaybackSelection>>['files'],
                fileId: 'f1',
            });
            vi.mocked(selectFileForPlayback).mockReturnValue({
                type: 'concat',
                paths: ['/media/part1.mkv', "/media/part2\nfile '/tmp/outside.mkv'.mkv"],
                fileIds: ['f1', 'f2'],
            });
            vi.mocked(resolveMediaPath).mockResolvedValue({
                isAccessible: true,
                containerPath: '/media/part1.mkv',
                reason: undefined,
            } as unknown as Awaited<ReturnType<typeof resolveMediaPath>>);
            vi.mocked(probeForTranscode).mockResolvedValue(mockProbeResult);

            await expect(startHlsPlayback(makeBaseRequest())).rejects.toThrow(/control character/i);
            expect(fsPromises.writeFile).not.toHaveBeenCalled();
        });
    });

    describe("audio-only (videoCodec=none): no 'none' leaks into the job config", () => {
        it('produces a job config free of the string "none"', async () => {
            setupHappyPath();
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ videoCodec: 'none' }));

            const cfg = startJob.mock.calls.at(-1)![0] as TranscodeJobConfig;
            expect(cfg.videoDisabled).toBe(true);
            expect(cfg.planHints?.targetVideoCodec).toBeUndefined();
            expect(cfg.subtitleBurnIn).toBeUndefined();
            expect(cfg.videoInfo).toBeDefined(); // source info is still valid
            expect(cfg.videoInfo?.outputCodec).not.toBe('none');
            expect(JSON.stringify(cfg)).not.toContain('"none"');
        });

        it('drops subtitle burn-in when video is disabled, even for a valid bitmap subtitle', async () => {
            setupHappyPath();
            // A bitmap subtitle stream that WOULD produce a real subtitleBurnIn if
            // video were not disabled (see the sibling non-audio-only coverage of
            // this same resolution logic) — proves the drop is videoDisabled-gated,
            // not just "there was nothing to burn in anyway".
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                streams: [{ index: 2, type: 'Subtitle', codec: 'hdmv_pgs_subtitle' }],
            } as unknown as Awaited<ReturnType<typeof probeForTranscode>>);
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(
                makeBaseRequest({
                    videoCodec: 'none',
                    subtitleBurnIn: { streamIndex: 2, method: 'Encode' },
                }),
            );

            const cfg = startJob.mock.calls.at(-1)![0] as TranscodeJobConfig;
            expect(cfg.videoDisabled).toBe(true);
            expect(cfg.subtitleBurnIn).toBeUndefined();
        });

        it('serves an audio-only master with the fixed bandwidth', async () => {
            setupHappyPath();

            const res = await startHlsPlayback(makeBaseRequest({ videoCodec: 'none' }));

            expect(res.playlistBody).toContain(`BANDWIDTH=${AUDIO_ONLY_BANDWIDTH}`);
            expect(res.playlistBody).not.toContain('RESOLUTION');
            expect(res.playlistBody).not.toContain('avc1');
        });

        it('threads the requested audio track through to the job config', async () => {
            setupHappyPath();
            // Two tracks with a non-default selection: proves the assertion isn't
            // trivially true because there was only one track, or because the
            // requested index happened to equal the default track's index.
            vi.mocked(probeForTranscode).mockResolvedValue({
                ...mockProbeResult,
                audioTracks: [
                    {
                        index: asAbsoluteStreamIndex(1),
                        codec: 'aac',
                        channels: 2,
                        language: 'eng',
                        displayTitle: 'English',
                        bitrate: 128000,
                        isDefault: true,
                    },
                    {
                        index: asAbsoluteStreamIndex(3),
                        codec: 'aac',
                        channels: 2,
                        language: 'ger',
                        displayTitle: 'German',
                        bitrate: 128000,
                        isDefault: false,
                    },
                ],
            });
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(makeBaseRequest({ videoCodec: 'none', audioStreamIndex: 3 }));

            const cfg = startJob.mock.calls.at(-1)![0] as TranscodeJobConfig;
            expect(cfg.hlsOutput?.hlsAudioTrackIndex).toBe(3);
        });

        it('pins the job config to muxed even when the plan says demux', async () => {
            // The audio-only rung reuses the plan built for the other play
            // methods, and resolveHlsAudioMode() stores 'demux' on it for every
            // native_hls client — which overrides the muxed the client asked
            // for. But audio-only's FFmpeg output is a single flat rendition
            // (buildAudioOnlyArgs forces the muxed shape), and the segment
            // handler reads hlsAudioMode back to decide whether that flat
            // stream may trigger seeks: with 'demux' it is treated as a
            // non-authoritative audio rendition and NO seek is ever triggered
            // from it.
            setupHappyPath();
            vi.mocked(playbackPlanner.getPlan).mockResolvedValue({
                plan_id: 'plan-native',
                intent: 'play' as const,
                delivery_path: 'native_hls' as const,
                playback_branch: 'native_hls_multi_audio' as const,
                method: 'remux' as const,
                video_action: 'copy' as const,
                audio_action: 'copy' as const,
                hls_audio_mode: 'demux' as const,
                subtitle_method: 'none' as const,
                transcode_reasons: [],
                needs_tonemapping: false,
                file_id: 'file-1',
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 1800_000).toISOString(),
            });
            vi.mocked(playbackPlanner.refreshPlan).mockResolvedValue(false);
            const startJob = vi.fn().mockResolvedValue(mockJob);
            vi.mocked(getFFmpegTranscodeService).mockReturnValue({
                getJobByPlaySession: vi.fn(() => undefined),
                startJob,
            } as unknown as ReturnType<typeof getFFmpegTranscodeService>);

            await startHlsPlayback(
                makeBaseRequest({
                    videoCodec: 'none',
                    planId: 'plan-native',
                    hlsOutput: { hlsAudioMode: 'muxed' },
                }),
            );

            const cfg = startJob.mock.calls.at(-1)![0] as TranscodeJobConfig;
            expect(cfg.videoDisabled).toBe(true);
            expect(cfg.hlsOutput?.hlsAudioMode).toBe('muxed');
        });
    });
});

describe('resolveVideoDisabled', () => {
    it('treats none as a disabled video stream', () => {
        expect(resolveVideoDisabled('none')).toEqual({
            videoDisabled: true,
            effectiveVideoCodec: undefined,
        });
    });

    it.each(['h264', 'copy'])('leaves %s untouched', (codec) => {
        expect(resolveVideoDisabled(codec)).toEqual({
            videoDisabled: false,
            effectiveVideoCodec: codec,
        });
    });

    it('leaves an absent override untouched', () => {
        expect(resolveVideoDisabled(undefined)).toEqual({
            videoDisabled: false,
            effectiveVideoCodec: undefined,
        });
    });
});

describe('buildConcatListContent (P1 — concat list control-char guard, F3 escaping fix)', () => {
    // F3 (fix plan 6, Task 7 fix round 1): inside ffmpeg's concat-demuxer
    // single-quoted token, a backslash has NO escape meaning — it is copied
    // literally, and it cannot be used to escape a quote either. The old
    // `\'`/`\\` doubling therefore corrupted every path containing either
    // character: the escaped `\'` left a literal backslash in front of the
    // apostrophe AND ended the quoted token early (verified against a real
    // ffprobe: `Ocean's Eleven.mkv` → `Impossible to open '.../Ocean\s'`),
    // and `\\` inserted an extra backslash that doesn't exist on disk. The
    // only correct way to embed a literal `'` is the POSIX-shell trick —
    // close the quote, escape a bare quote in the (here, unquoted-context)
    // token stream, reopen the quote — and a literal `\` needs no escaping
    // at all.
    it('embeds a literal apostrophe via close-quote/escaped-quote/reopen-quote, and leaves a literal backslash untouched', () => {
        const content = buildConcatListContent(["/data/movies/Part1's\\Movie.mkv"]);
        expect(content).toBe("file '/data/movies/Part1'\\''s\\Movie.mkv'");
    });

    it('joins multiple paths with one file directive per line', () => {
        const content = buildConcatListContent(['/data/Part1.mkv', '/data/Part2.mkv']);
        expect(content).toBe("file '/data/Part1.mkv'\nfile '/data/Part2.mkv'");
    });

    it('throws (not silently escapes) a path containing an embedded newline', () => {
        expect(() =>
            buildConcatListContent([
                '/data/Movie.Part1.mkv',
                "/data/Movie.Part2\nfile '/tmp/outside.mkv'.mkv",
            ]),
        ).toThrow(/control character/i);
    });

    it('throws (not silently escapes) a path containing an embedded carriage return', () => {
        expect(() => buildConcatListContent(['/data/Movie\rPart2.mkv'])).toThrow(
            /control character/i,
        );
    });

    // F4 (fix plan 6, final wave): measured on the pinned jellyfin-ffmpeg in
    // media-format-whitelist.integration.test.ts.
    it("follows every file line with that part's own format whitelist when given one", () => {
        expect(buildConcatListContent(['/data/P1.mkv', '/data/P2.mkv'], 'matroska,webm,avi')).toBe(
            "file '/data/P1.mkv'\noption format_whitelist 'matroska,webm,avi'\n" +
                "file '/data/P2.mkv'\noption format_whitelist 'matroska,webm,avi'",
        );
    });

    it('writes no option line for a value outside the demuxer-list grammar', () => {
        for (const bad of ["mkv' \nfile '/etc/passwd", 'a b', '']) {
            expect(buildConcatListContent(['/data/P1.mkv'], bad)).toBe("file '/data/P1.mkv'");
        }
    });
});

// The playlist-body input guard (transcoding/input-guard.ts, final wave M1)
// reads the app's own concat list back to sniff each part. The writer and the
// reader are two copies of one format; this fails if they drift apart.
describe('parseConcatListContent is the inverse of buildConcatListContent', () => {
    it.each([
        [['/data/Part1.mkv', '/data/Part2.mkv']],
        [["/data/movies/Ocean's Eleven.mkv", "/data/it's 'quoted'/x.mkv"]],
        [['/data/back\\slash.mkv', '/data/with space/and-ünïcode.mkv']],
        [["/data/''double''.mkv"]],
    ])('round-trips %j', async (paths) => {
        const { parseConcatListContent } = await import('../transcoding/input-guard.js');
        expect(parseConcatListContent(buildConcatListContent(paths))).toEqual(paths);
        expect(
            parseConcatListContent(buildConcatListContent(paths, 'mov,mp4,m4a,3gp,3g2,mj2,avi')),
        ).toEqual(paths);
    });

    it('accepts one format_whitelist option line only directly after a file line', async () => {
        const { parseConcatListContent } = await import('../transcoding/input-guard.js');
        const opt = "option format_whitelist 'matroska,webm'";

        expect(parseConcatListContent(`${opt}\nfile 'a.mkv'`)).toBeNull();
        expect(parseConcatListContent(`file 'a.mkv'\n${opt}\n${opt}`)).toBeNull();
        expect(parseConcatListContent(`file 'a.mkv'\noption safe '0'`)).toBeNull();
        expect(parseConcatListContent(`file 'a.mkv'\noption format_whitelist 'a b'`)).toBeNull();
        expect(parseConcatListContent(`file 'a.mkv'\noption format_whitelist ''`)).toBeNull();
        expect(parseConcatListContent(`file 'a.mkv'\n${opt}\nfile 'b.mkv'`)).toEqual([
            'a.mkv',
            'b.mkv',
        ]);
    });

    it.each(['inpoint', 'outpoint', 'duration'])(
        'rejects unsupported %s directives',
        async (directive) => {
            const { parseConcatListContent } = await import('../transcoding/input-guard.js');
            expect(parseConcatListContent(`file 'a.mkv'\n${directive} 1.000`)).toBeNull();
        },
    );

    it("rejects a list line not in the writer's exact form", async () => {
        const { parseConcatListContent } = await import('../transcoding/input-guard.js');
        expect(parseConcatListContent('ffconcat version 1.0\nfile a.mkv\n')).toBeNull();
        expect(parseConcatListContent("file 'a.mkv' extra\n")).toBeNull();
        expect(parseConcatListContent("file 'a'b.mkv'\n")).toBeNull();
    });
});
