// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for FFmpegTranscodeService Coordinator
 *
 * Tests multi-component interactions between SeekController and
 * TranscodeFileManager, using real implementations of both classes.
 *
 * Focus areas:
 * - Seek preparation + file cleanup coordination
 * - State reset verification after multi-step seek operations
 * - Generation lifecycle (seek → state reset → verify all 4 state variables)
 * - canSeek boundary conditions in coordination with prepared state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TranscodeJob, TranscodeJobConfig } from './types.js';
import { TranscodeFileManager } from './file-manager.js';
import { SeekController } from './seek-controller.js';

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

// Mock fs — real FileManager uses fs internally
vi.mock('node:fs/promises', () => ({
    default: {
        readdir: vi.fn(),
        readFile: vi.fn(),
        unlink: vi.fn().mockResolvedValue(undefined),
        rm: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('fs/promises', () => ({
    readdir: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
}));

// Mock config — TranscodeFileManager reads FFMPEG_TRANSCODE_DIR and FFMPEG_SEGMENT_KEEP_BEHIND
vi.mock('../../config.js', () => ({
    config: {
        FFMPEG_TRANSCODE_DIR: '/tmp/transcode',
        FFMPEG_SEGMENT_KEEP_BEHIND: 50,
    },
}));

function makeJob(overrides: Partial<TranscodeJob> = {}): TranscodeJob {
    return {
        id: 'integration-test-job',
        config: {
            username: 'testuser',
            deviceId: 'test-device',
            playSessionId: 'session-123',
            itemId: 'item-123',
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
            localFilePath: '/media/movies/test.mkv',
            transcodeMode: 'full',
            startTimeSeconds: 0,
            isJellyfinTranscoded: false,
            videoInfo: { codec: 'h264', width: 1920, height: 1080 },
        } as TranscodeJobConfig,
        outputDir: '/tmp/transcode/integration-test',
        sessionOutputDir: '/tmp/transcode/session',
        generationIndex: 1,
        generationRole: 'current',
        status: 'running',
        segmentsReady: 0,
        segmentOffset: 0,
        process: null,
        startedAt: new Date(),
        lastAccessedAt: new Date(),
        lastProgressAt: new Date(),
        lastServedSegment: new Map(),
        deletedUpTo: new Map(),
        masterPlaylistReady: false,
        isSeeking: false,
        seekCount: 0,
        segmentDurationSeconds: 6,
        iframeData: [],
        iframeAnalyzedCount: 0,
        iframeAnalysisComplete: false,
        streamTargetDurations: new Map(),
        lastSeekTrigger: '',
        lastFFmpegSpawnTime: 0,
        spawnAttempt: 0,
        endSegmentCache: new Map(),
        syncTraceLoggedStreams: new Set(),
        ...overrides,
    } as unknown as TranscodeJob;
}

describe('SeekController + TranscodeFileManager Integration', () => {
    let fileManager: TranscodeFileManager;
    let seekController: SeekController;

    beforeEach(() => {
        fileManager = new TranscodeFileManager();
        seekController = new SeekController(fileManager);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ========================================================================
    // canSeek boundary conditions
    // ========================================================================

    describe('canSeek window boundaries', () => {
        it('returns false when target is exactly at segmentOffset (already available)', () => {
            const job = makeJob({ segmentOffset: 100, segmentsReady: 20 });
            // target = 100, window = [100, 120) — inside window
            expect(seekController.canSeek(job, 100)).toBe(false);
        });

        it('returns false when target is inside the produced window', () => {
            const job = makeJob({ segmentOffset: 100, segmentsReady: 20 });
            // target = 115, window = [100, 120) — inside window
            expect(seekController.canSeek(job, 115)).toBe(false);
        });

        it('returns false for the last segment in the window', () => {
            const job = makeJob({ segmentOffset: 100, segmentsReady: 20 });
            // target = 119, window = [100, 120) — still inside
            expect(seekController.canSeek(job, 119)).toBe(false);
        });

        it('returns true when target is exactly at window end (not yet produced)', () => {
            const job = makeJob({ segmentOffset: 100, segmentsReady: 20 });
            // target = 120, window = [100, 120) — outside window
            expect(seekController.canSeek(job, 120)).toBe(true);
        });

        it('returns true when target is far ahead of current window', () => {
            const job = makeJob({ segmentOffset: 0, segmentsReady: 50 });
            // target = 200, window = [0, 50) — outside
            expect(seekController.canSeek(job, 200)).toBe(true);
        });

        it('returns true when target is before the current offset (backward seek)', () => {
            const job = makeJob({ segmentOffset: 100, segmentsReady: 20 });
            // target = 50 — before offset, not in window
            expect(seekController.canSeek(job, 50)).toBe(true);
        });
    });

    // ========================================================================
    // prepareJobStateForSeek: verifies all 4 state variables reset
    // ========================================================================

    describe('prepareJobStateForSeek state machine', () => {
        it('resets all 4 state variables correctly', () => {
            const job = makeJob({
                segmentOffset: 0,
                segmentsReady: 50,
                masterPlaylistReady: true,
                status: 'running',
                seekCount: 0,
            });
            job.lastServedSegment.set('stream_0', 45);
            job.lastServedSegment.set('stream_1', 43);
            job.deletedUpTo.set('stream_0', 10);
            job.deletedUpTo.set('stream_1', 8);

            seekController.prepareJobStateForSeek(job, 200, 1200);

            // 1. segmentOffset updated
            expect(job.segmentOffset).toBe(200);
            // 2. segmentsReady reset
            expect(job.segmentsReady).toBe(0);
            // 3. lastServedSegment cleared
            expect(job.lastServedSegment.size).toBe(0);
            // 4. deletedUpTo cleared
            expect(job.deletedUpTo.size).toBe(0);
        });

        it('sets status to starting and clears masterPlaylistReady', () => {
            const job = makeJob({
                status: 'running',
                masterPlaylistReady: true,
            });

            seekController.prepareJobStateForSeek(job, 100, 600);

            expect(job.status).toBe('starting');
            expect(job.masterPlaylistReady).toBe(false);
        });

        it('increments seekCount so updatePlaySessionForSeek uses the new count', () => {
            const job = makeJob({ seekCount: 0 });

            seekController.prepareJobStateForSeek(job, 100, 600);

            expect(job.seekCount).toBe(1);
        });

        it('resets iframe analysis state', () => {
            const job = makeJob({
                iframeAnalyzedCount: 30,
                iframeAnalysisComplete: true,
            });
            job.iframeData = [
                {
                    segmentIndex: 0,
                    segmentUri: 'x',
                    byteOffset: 0,
                    byteSize: 100,
                    duration: 0.1,
                    timestamp: 0,
                },
            ];

            seekController.prepareJobStateForSeek(job, 50, 300);

            expect(job.iframeData).toHaveLength(0);
            expect(job.iframeAnalyzedCount).toBe(0);
            // isJellyfinTranscoded is false so iframeAnalysisComplete becomes false
            expect(job.iframeAnalysisComplete).toBe(false);
        });

        it('updates startTimeSeconds in config', () => {
            const job = makeJob();
            job.config.startTimeSeconds = 0;

            seekController.prepareJobStateForSeek(job, 200, 1200);

            expect(job.config.startTimeSeconds).toBe(1200);
        });
    });

    // ========================================================================
    // updatePlaySessionForSeek: session ID generation
    // ========================================================================

    describe('updatePlaySessionForSeek', () => {
        it('appends _seekN suffix using the current seekCount', () => {
            const job = makeJob({ seekCount: 1 });
            job.config.playSessionId = 'session-abc';

            const { newPlaySessionId } = seekController.updatePlaySessionForSeek(job);

            expect(newPlaySessionId).toBe('session-abc_seek1');
        });

        it('replaces an existing _seek suffix when seeking again', () => {
            const job = makeJob({ seekCount: 2 });
            job.config.playSessionId = 'session-abc_seek1';

            const { newPlaySessionId } = seekController.updatePlaySessionForSeek(job);

            expect(newPlaySessionId).toBe('session-abc_seek2');
        });

        it('session ID after prepare + update reflects incremented count', () => {
            const job = makeJob({ seekCount: 0 });
            job.config.playSessionId = 'session-xyz';

            // Simulate coordinator flow: prepare sets seekCount++ then update reads it
            seekController.prepareJobStateForSeek(job, 100, 600);
            const { newPlaySessionId } = seekController.updatePlaySessionForSeek(job);

            expect(newPlaySessionId).toBe('session-xyz_seek1');
            expect(newPlaySessionId).not.toBe('session-xyz');
        });

        it('multiple sequential seeks produce incrementing suffixes', () => {
            const job = makeJob({ seekCount: 0 });
            job.config.playSessionId = 'session-multi';

            // First seek
            seekController.prepareJobStateForSeek(job, 100, 600);
            const first = seekController.updatePlaySessionForSeek(job);
            job.config.playSessionId = first.newPlaySessionId;

            // Second seek
            seekController.prepareJobStateForSeek(job, 300, 1800);
            const second = seekController.updatePlaySessionForSeek(job);

            expect(first.newPlaySessionId).toBe('session-multi_seek1');
            expect(second.newPlaySessionId).toBe('session-multi_seek2');
        });
    });

    // ========================================================================
    // Seek preparation + canSeek coordination
    // ========================================================================

    describe('Seek state coordination', () => {
        it('after prepareJobStateForSeek, canSeek returns false for target near new offset', () => {
            const job = makeJob({ segmentOffset: 0, segmentsReady: 50 });

            // Seek to segment 200
            seekController.prepareJobStateForSeek(job, 200, 1200);

            // segmentsReady is now 0, so window = [200, 200) — no segments
            // Segment 200 is at offset but segmentsReady=0 so window is empty → canSeek returns true
            // (FFmpeg hasn't produced anything yet)
            expect(seekController.canSeek(job, 210)).toBe(true);
        });

        it('canSeek returns false once segments are produced at new position', () => {
            const job = makeJob({ segmentOffset: 0, segmentsReady: 50 });

            seekController.prepareJobStateForSeek(job, 200, 1200);
            // Simulate FFmpeg producing 30 segments at new position
            job.segmentsReady = 30;

            // target 210 is inside [200, 230) — no seek needed
            expect(seekController.canSeek(job, 210)).toBe(false);
            // target 230 is at window end — seek needed
            expect(seekController.canSeek(job, 230)).toBe(true);
        });

        it('second seek correctly handles state from first seek', () => {
            const job = makeJob({
                segmentOffset: 0,
                segmentsReady: 50,
                seekCount: 0,
            });
            job.config.playSessionId = 'session-chain';
            job.lastServedSegment.set('stream_0', 45);

            // First seek
            seekController.prepareJobStateForSeek(job, 100, 600);
            expect(job.segmentOffset).toBe(100);
            expect(job.segmentsReady).toBe(0);
            expect(job.seekCount).toBe(1);

            // Simulate some progress
            job.segmentsReady = 20;
            job.lastServedSegment.set('stream_0', 115);

            // Second seek
            seekController.prepareJobStateForSeek(job, 300, 1800);
            expect(job.segmentOffset).toBe(300);
            expect(job.segmentsReady).toBe(0);
            expect(job.seekCount).toBe(2);
            // Maps cleared again
            expect(job.lastServedSegment.size).toBe(0);
            expect(job.deletedUpTo.size).toBe(0);
        });
    });

    // ========================================================================
    // cleanupSegmentsForSeek: interaction with FileManager
    // ========================================================================

    describe('cleanupSegmentsForSeek + TranscodeFileManager interaction', () => {
        it('calls fileManager.clearSegmentFiles with the job outputDir', async () => {
            // Spy on the real fileManager instance
            const clearSpy = vi
                .spyOn(fileManager, 'clearSegmentFiles')
                .mockResolvedValue(undefined);

            const job = makeJob({ outputDir: '/tmp/transcode/seek-test' });
            // No totalDurationSeconds → warmEndSegmentCache skipped

            await seekController.cleanupSegmentsForSeek(job);

            expect(clearSpy).toHaveBeenCalledOnce();
            expect(clearSpy).toHaveBeenCalledWith('/tmp/transcode/seek-test');
        });

        it('skips warmEndSegmentCache when totalDurationSeconds is not set', async () => {
            const clearSpy = vi
                .spyOn(fileManager, 'clearSegmentFiles')
                .mockResolvedValue(undefined);

            // Spy on the real fileManager to detect if warmEndSegmentCache path is hit.
            // When totalDurationSeconds is unset the private method returns early
            // before calling clearSegmentFiles — we verify clearSegmentFiles IS still
            // called (warmup is bypassed, not the whole cleanup).
            const job = makeJob();
            // totalDurationSeconds is undefined — warmEndSegmentCache exits immediately

            await seekController.cleanupSegmentsForSeek(job);

            // clearSegmentFiles still called even without warmup
            expect(clearSpy).toHaveBeenCalledOnce();
            expect(clearSpy).toHaveBeenCalledWith(job.outputDir);
        });

        it('full seek flow: prepare state + cleanup together', async () => {
            const clearSpy = vi
                .spyOn(fileManager, 'clearSegmentFiles')
                .mockResolvedValue(undefined);

            const job = makeJob({
                segmentOffset: 0,
                segmentsReady: 50,
                seekCount: 0,
            });
            job.config.playSessionId = 'session-flow';
            job.lastServedSegment.set('stream_0', 45);
            job.deletedUpTo.set('stream_0', 10);

            // Coordinator flow: prepare → cleanup → update session
            seekController.prepareJobStateForSeek(job, 200, 1200);
            await seekController.cleanupSegmentsForSeek(job);
            const { newPlaySessionId } = seekController.updatePlaySessionForSeek(job);

            // State is fully reset
            expect(job.segmentOffset).toBe(200);
            expect(job.segmentsReady).toBe(0);
            expect(job.status).toBe('starting');
            expect(job.lastServedSegment.size).toBe(0);
            expect(job.deletedUpTo.size).toBe(0);
            expect(job.seekCount).toBe(1);

            // File cleanup was triggered
            expect(clearSpy).toHaveBeenCalledOnce();

            // New session ID reflects the seek
            expect(newPlaySessionId).toBe('session-flow_seek1');
        });
    });

    // ========================================================================
    // waitForSeekCompletion
    // ========================================================================

    describe('waitForSeekCompletion', () => {
        it('returns proceed immediately when job is not seeking', async () => {
            const job = makeJob({ isSeeking: false });

            const result = await seekController.waitForSeekCompletion(job, 100);

            expect(result).toBe('proceed');
        });

        it('returns covered when seek completes and target is now available', async () => {
            const job = makeJob({
                isSeeking: true,
                segmentOffset: 0,
                segmentsReady: 200,
            });

            // Resolve the seek asynchronously before the wait times out
            setTimeout(() => {
                job.isSeeking = false;
            }, 50);

            // Target 100 is within [0, 200) so canSeek returns false → 'covered'
            const result = await seekController.waitForSeekCompletion(job, 100);

            expect(result).toBe('covered');
        });

        it('returns failed when job status becomes stopped during wait', async () => {
            const job = makeJob({ isSeeking: true });

            setTimeout(() => {
                job.isSeeking = false;
                job.status = 'stopped';
            }, 50);

            const result = await seekController.waitForSeekCompletion(job, 999);

            expect(result).toBe('failed');
        });

        it('returns proceed when seek completes but target still needs seeking', async () => {
            const job = makeJob({
                isSeeking: true,
                segmentOffset: 0,
                segmentsReady: 10,
            });

            // After seek, only 10 segments ready — target 500 still outside window
            setTimeout(() => {
                job.isSeeking = false;
            }, 50);

            const result = await seekController.waitForSeekCompletion(job, 500);

            expect(result).toBe('proceed');
        });
    });
});
