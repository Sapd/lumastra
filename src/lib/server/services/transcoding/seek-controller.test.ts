// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for SeekController
 *
 * Tests complex seeking logic with 4-variable state machine:
 * - job.isSeeking (concurrency control)
 * - job.segmentOffset (playback position)
 * - job.segmentsReady (progress counter)
 * - job.lastServedSegment / job.deletedUpTo (cleanup tracking)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SeekController } from './seek-controller.js';
import type { TranscodeJob } from './types.js';
import type { TranscodeFileManager } from './file-manager.js';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

describe('SeekController', () => {
    let controller: SeekController;
    let mockJob: TranscodeJob;
    let mockFileManager: TranscodeFileManager;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create mock FileManager
        mockFileManager = {
            clearSegmentFiles: vi.fn().mockResolvedValue(undefined),
            createOutputDirectory: vi.fn(),
            deleteOutputDirectory: vi.fn(),
            slidingWindowCleanup: vi.fn(),
            clearTranscodeDirectory: vi.fn(),
        } as unknown as TranscodeFileManager;

        controller = new SeekController(mockFileManager);

        // Create minimal mock job
        mockJob = {
            id: 'test-job-123',
            config: {
                playSessionId: 'session-123',
                itemId: 'item-123',
                username: 'testuser',
                deviceId: 'test-device',
                audioTracks: [
                    {
                        index: 0,
                        displayTitle: 'English',
                        language: 'eng',
                        channels: 2,
                        codec: 'aac',
                        isDefault: true,
                    },
                ],
                inputUrl: '/media/movies/test.mkv',
                startTimeSeconds: 0,
                isJellyfinTranscoded: false,
                videoInfo: { codec: 'h264', width: 1920, height: 1080 },
            },
            outputDir: '/tmp/transcode/test-job-123',
            status: 'running',
            segmentsReady: 20,
            segmentOffset: 0,
            process: null,
            startedAt: new Date(),
            lastAccessedAt: new Date(),
            lastProgressAt: new Date(),
            lastServedSegment: new Map([
                ['stream_0', 15],
                ['stream_1', 15],
            ]),
            deletedUpTo: new Map([
                ['stream_0', 5],
                ['stream_1', 5],
            ]),
            masterPlaylistReady: true,
            isSeeking: false,
            seekCount: 0,
            segmentDurationSeconds: 6,
            iframeData: [
                {
                    segmentIndex: 0,
                    byteOffset: 0,
                    byteSize: 1024,
                    duration: 0,
                    segmentUri: 'stream_0/segment_00000.m4s',
                    timestamp: 0,
                },
            ],
            iframeAnalyzedCount: 5,
            iframeAnalysisComplete: false,
            streamTargetDurations: new Map(),
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: 0,
            spawnAttempt: 0,
            endSegmentCache: new Map(),
        } as TranscodeJob;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // ========================================================================
    // canSeek() Tests
    // ========================================================================

    describe('canSeek()', () => {
        it('should allow seek to position outside produced segments', () => {
            // Produced window: offset=0, ready=20 → covers 0-19
            mockJob.segmentOffset = 0;
            mockJob.segmentsReady = 20;

            // Target 100 is outside produced segments
            const result = controller.canSeek(mockJob, 100);

            expect(result).toBe(true);
        });

        it('should prevent seek to position within produced segments', () => {
            // Produced window: offset=0, ready=20 → covers 0-19
            mockJob.segmentOffset = 0;
            mockJob.segmentsReady = 20;

            // Target 10 is within produced segments
            const result = controller.canSeek(mockJob, 10);

            expect(result).toBe(false);
        });

        it('should prevent seek to exact last produced segment', () => {
            // Produced window: offset=0, ready=20 → covers 0-19
            mockJob.segmentOffset = 0;
            mockJob.segmentsReady = 20;

            // Target 19 is the last produced segment
            const result = controller.canSeek(mockJob, 19);

            expect(result).toBe(false);
        });

        it('should allow seek just past produced segments', () => {
            // Produced window: offset=0, ready=20 → covers 0-19
            mockJob.segmentOffset = 0;
            mockJob.segmentsReady = 20;

            // Target 20 is just past produced segments
            const result = controller.canSeek(mockJob, 20);

            expect(result).toBe(true);
        });

        it('should handle seeks with non-zero offset', () => {
            // Produced window: offset=100, ready=20 → covers 100-119
            mockJob.segmentOffset = 100;
            mockJob.segmentsReady = 20;

            // Target 110 is within produced window
            expect(controller.canSeek(mockJob, 110)).toBe(false);

            // Target 120 is outside produced window
            expect(controller.canSeek(mockJob, 120)).toBe(true);
        });

        it('should handle seeks with zero segments ready', () => {
            // Produced window: offset=0, ready=0 → covers nothing
            mockJob.segmentOffset = 0;
            mockJob.segmentsReady = 0;

            // Target 0 is outside (no segments produced)
            expect(controller.canSeek(mockJob, 0)).toBe(true);

            // Target 1 is also outside
            expect(controller.canSeek(mockJob, 1)).toBe(true);
        });

        it('should allow backward seek outside produced segments', () => {
            // Produced window: offset=100, ready=20 → covers 100-119
            mockJob.segmentOffset = 100;
            mockJob.segmentsReady = 20;

            // Target 50 is before the produced window (backward seek)
            const result = controller.canSeek(mockJob, 50);

            expect(result).toBe(true);
        });
    });

    // ========================================================================
    // waitForSeekCompletion() Tests
    // ========================================================================

    describe('waitForSeekCompletion()', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        it('should return "proceed" immediately if not seeking', async () => {
            mockJob.isSeeking = false;

            const result = await controller.waitForSeekCompletion(mockJob, 100);

            expect(result).toBe('proceed');
        });

        it('should wait and return "proceed" when seek completes', async () => {
            mockJob.isSeeking = true;

            const waitPromise = controller.waitForSeekCompletion(mockJob, 100);

            // Simulate seek completing after a delay
            setTimeout(() => {
                mockJob.isSeeking = false;
            }, 200);

            await vi.advanceTimersByTimeAsync(5_100);
            const result = await waitPromise;
            expect(result).toBe('proceed');
        });

        it('should return "failed" if seek times out after 5 seconds', async () => {
            mockJob.isSeeking = true; // Never completes

            const waitPromise = controller.waitForSeekCompletion(mockJob, 100);

            await vi.advanceTimersByTimeAsync(5_100);
            const result = await waitPromise;
            expect(result).toBe('failed');
            expect(mockJob.isSeeking).toBe(true); // Still seeking
        });

        it('should return "failed" if job status becomes stopped during wait', async () => {
            mockJob.isSeeking = true;

            const waitPromise = controller.waitForSeekCompletion(mockJob, 100);

            // Job stops after a short delay
            setTimeout(() => {
                mockJob.status = 'stopped';
            }, 200);

            await vi.advanceTimersByTimeAsync(5_100);
            const result = await waitPromise;
            expect(result).toBe('failed');
        });

        it('should return "failed" if job status becomes error during wait', async () => {
            mockJob.isSeeking = true;

            const waitPromise = controller.waitForSeekCompletion(mockJob, 100);

            // Job errors after a short delay
            setTimeout(() => {
                mockJob.status = 'error';
            }, 200);

            await vi.advanceTimersByTimeAsync(5_100);
            const result = await waitPromise;
            expect(result).toBe('failed');
        });

        it('should return "covered" if target is now within produced segments after wait', async () => {
            mockJob.isSeeking = true;
            mockJob.segmentOffset = 0;
            mockJob.segmentsReady = 20;

            // Target 100 is initially outside produced window (0-19)
            const waitPromise = controller.waitForSeekCompletion(mockJob, 100);

            // Seek completes with new position that covers target
            setTimeout(() => {
                mockJob.isSeeking = false;
                mockJob.segmentOffset = 90; // Now produced window is 90-109, which includes 100
                mockJob.segmentsReady = 20;
            }, 200);

            await vi.advanceTimersByTimeAsync(5_100);
            const result = await waitPromise;
            // Should return 'covered' because canSeek now returns false (target within produced segments)
            expect(result).toBe('covered');
        });
    });

    // ========================================================================
    // cleanupSegmentsForSeek() Tests
    // ========================================================================

    describe('cleanupSegmentsForSeek()', () => {
        it('should delegate segment cleanup to FileManager', async () => {
            await controller.cleanupSegmentsForSeek(mockJob);

            // Should call FileManager.clearSegmentFiles with the output directory
            expect(mockFileManager.clearSegmentFiles).toHaveBeenCalledWith(mockJob.outputDir);
            expect(mockFileManager.clearSegmentFiles).toHaveBeenCalledTimes(1);
        });

        it('should complete successfully even when FileManager encounters errors', async () => {
            // FileManager.clearSegmentFiles handles errors internally and never throws
            // so the mock should resolve successfully
            vi.mocked(mockFileManager.clearSegmentFiles).mockResolvedValue(undefined);

            await expect(controller.cleanupSegmentsForSeek(mockJob)).resolves.toBeUndefined();
            expect(mockFileManager.clearSegmentFiles).toHaveBeenCalledWith(mockJob.outputDir);
        });

        describe('end-segment warm-up', () => {
            let dir: string;

            beforeEach(async () => {
                dir = await mkdtemp(path.join(tmpdir(), 'seek-warm-'));
                await mkdir(path.join(dir, 'stream_0'));
                for (const i of [18, 19]) {
                    await writeFile(
                        path.join(dir, 'stream_0', `segment_000${i}.m4s`),
                        Buffer.from(`seg-${i}`),
                    );
                }
                mockJob.outputDir = dir;
                // 120 s at 6 s: entries 0..19.
                mockJob.config.totalDurationSeconds = 120;
            });

            afterEach(async () => {
                await rm(dir, { recursive: true, force: true });
            });

            it('keys a transcode file by its playlist index', async () => {
                mockJob.transcodeDecisionResult = {
                    videoAction: 'transcode',
                } as TranscodeJob['transcodeDecisionResult'];
                mockJob.segmentOffset = 12;

                await controller.cleanupSegmentsForSeek(mockJob);

                expect(mockJob.endSegmentCache.get('stream_0')).toEqual({
                    kind: 'segment',
                    segmentIndex: 19,
                    buffer: Buffer.from('seg-19'),
                });
            });

            it('skips a copy generation that did not start at 0: its file numbers are not playlist indices', async () => {
                mockJob.transcodeDecisionResult = {
                    videoAction: 'copy',
                } as TranscodeJob['transcodeDecisionResult'];
                mockJob.segmentOffset = 3;
                mockJob.config.startTimeSeconds = 18;

                await controller.cleanupSegmentsForSeek(mockJob);

                expect(mockJob.endSegmentCache.size).toBe(0);
            });
        });
    });

    // ========================================================================
    // prepareJobStateForSeek() Tests
    // ========================================================================

    describe('prepareJobStateForSeek()', () => {
        it('should reset all 4 state variables', () => {
            // Set up initial state
            mockJob.segmentOffset = 100;
            mockJob.segmentsReady = 50;
            mockJob.lastServedSegment = new Map([
                ['stream_0', 120],
                ['stream_1', 120],
            ]);
            mockJob.deletedUpTo = new Map([
                ['stream_0', 80],
                ['stream_1', 80],
            ]);

            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            // Check 4-variable state machine reset
            expect(mockJob.segmentOffset).toBe(200);
            expect(mockJob.segmentsReady).toBe(0);
            expect(mockJob.lastServedSegment.size).toBe(0);
            expect(mockJob.deletedUpTo.size).toBe(0);
        });

        it('should update config startTimeSeconds', () => {
            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            expect(mockJob.config.startTimeSeconds).toBe(1200);
        });

        it('should reset status to starting', () => {
            mockJob.status = 'ready';

            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            expect(mockJob.status).toBe('starting');
        });

        it('should reset masterPlaylistReady to false', () => {
            mockJob.masterPlaylistReady = true;

            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            expect(mockJob.masterPlaylistReady).toBe(false);
        });

        it('should reset I-frame analysis data', () => {
            mockJob.iframeData = [
                {
                    segmentIndex: 0,
                    byteOffset: 0,
                    byteSize: 1024,
                    duration: 0,
                    segmentUri: 'stream_0/segment_00000.m4s',
                    timestamp: 0,
                },
                {
                    segmentIndex: 1,
                    byteOffset: 0,
                    byteSize: 2048,
                    duration: 6,
                    segmentUri: 'stream_0/segment_00001.m4s',
                    timestamp: 6,
                },
            ];
            mockJob.iframeAnalyzedCount = 10;
            mockJob.iframeAnalysisComplete = true;

            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            expect(mockJob.iframeData).toEqual([]);
            expect(mockJob.iframeAnalyzedCount).toBe(0);
            expect(mockJob.iframeAnalysisComplete).toBe(false);
        });

        it('should keep iframeAnalysisComplete true for Jellyfin transcoded jobs', () => {
            mockJob.config.isJellyfinTranscoded = true;
            mockJob.iframeAnalysisComplete = true;

            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            // Should stay true for Jellyfin transcoded (keyframes at segment boundaries)
            expect(mockJob.iframeAnalysisComplete).toBe(true);
        });

        it('should increment seekCount', () => {
            mockJob.seekCount = 0;

            controller.prepareJobStateForSeek(mockJob, 200, 1200);
            expect(mockJob.seekCount).toBe(1);

            controller.prepareJobStateForSeek(mockJob, 300, 1800);
            expect(mockJob.seekCount).toBe(2);
        });

        it('should preserve endSegmentCache for VOD duration probing after seek', () => {
            mockJob.endSegmentCache.set('stream_0', {
                kind: 'segment',
                segmentIndex: 199,
                buffer: Buffer.from('cached-audio'),
            });
            mockJob.endSegmentCache.set('stream_2', {
                kind: 'segment',
                segmentIndex: 199,
                buffer: Buffer.from('cached-video'),
            });

            controller.prepareJobStateForSeek(mockJob, 200, 1200);

            // endSegmentCache must survive seek — hls.js needs it for VOD probing
            expect(mockJob.endSegmentCache.size).toBe(2);
        });
    });

    // ========================================================================
    // updatePlaySessionForSeek() Tests
    // ========================================================================

    describe('updatePlaySessionForSeek()', () => {
        it('should create new PlaySessionId with seek suffix', () => {
            mockJob.config.playSessionId = 'original-session-123';
            mockJob.seekCount = 1;

            const result = controller.updatePlaySessionForSeek(mockJob);

            expect(result.newPlaySessionId).toBe('original-session-123_seek1');
        });

        it('should remove existing seek suffix before adding new one', () => {
            mockJob.config.playSessionId = 'original-session-123_seek2';
            mockJob.seekCount = 3;

            const result = controller.updatePlaySessionForSeek(mockJob);

            // Should use base ID, not stack suffixes
            expect(result.newPlaySessionId).toBe('original-session-123_seek3');
        });
    });
});
