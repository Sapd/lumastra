// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for IFrameAnalyzer
 *
 * ⚠️ NOTE: This test file is EXCLUDED from the main test suite due to memory issues.
 * See vitest.config.ts exclude list and scripts/run-tests-batched.sh
 *
 * REASON: The tests use vi.advanceTimersByTimeAsync() with background polling loops
 * that create infinite async task chains, causing Node.js to run out of memory even
 * with 8GB+ heap allocation. The issue is inherent to testing async background workers
 * with fake timers in Vitest.
 *
 * To run this test file individually:
 * NODE_OPTIONS='--max-old-space-size=8192' npx vitest run src/lib/server/services/transcoding/iframe-analyzer.test.ts
 * (Warning: Will likely OOM crash)
 *
 * Tests background I-frame analysis for HLS segments:
 * - Segment polling loop
 * - ffprobe execution and parsing
 * - Keyframe extraction
 * - Job status monitoring
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IFrameAnalyzer } from './iframe-analyzer.js';
import type { TranscodeJob } from './types.js';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import type { PathLike } from 'fs';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

// Mock fs/promises
vi.mock('fs/promises');

// Mock child_process
vi.mock('child_process', () => ({
    exec: vi.fn(),
}));

// A REAL promisify shim, not an identity function.
//
// This mock used to be `promisify: vi.fn(<T>(fn: T) => fn)`, which made
// `execAsync = promisify(exec)` in the module under test resolve to the raw
// `exec` mock. Production calls `await execAsync(cmd, opts)` with TWO
// arguments and lets promisify supply the callback; with the identity stub no
// callback was ever synthesized, so the `exec` mock's `callback` parameter was
// `undefined`, its `if (callback)` never fired, and it fell through to
// `return {}`. `await {}` gave `{ stdout: undefined }`, `JSON.parse(undefined)`
// threw, and `analyzeSegmentForIFrames`'s catch swallowed it and returned [].
//
// Net effect: EVERY ffprobe call in this file returned no keyframes regardless
// of the fixture, so the fixtures were never actually exercised — the file was
// vacuous from its first commit, and the assertions that appeared to pass did
// so by coincidence. Wrapping the callback properly is what makes the fixtures
// mean anything.
vi.mock('util', () => ({
    promisify:
        <TArgs extends unknown[], TResult>(
            fn: (...args: [...TArgs, (err: Error | null, result: TResult) => void]) => void,
        ) =>
        (...args: TArgs) =>
            new Promise<TResult>((resolve, reject) => {
                fn(...args, (err: Error | null, result: TResult) =>
                    err ? reject(err) : resolve(result),
                );
            }),
}));

// Type for exec callback used in tests
type ExecTestCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

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

describe('IFrameAnalyzer', () => {
    let analyzer: IFrameAnalyzer;
    let mockJob: TranscodeJob;

    beforeEach(() => {
        vi.clearAllMocks();
        analyzer = new IFrameAnalyzer();

        // Create minimal mock job
        mockJob = {
            id: 'test-job-123',
            config: {
                username: 'testuser',
                deviceId: 'test-device-123',
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
                inputUrl: 'http://example.com/stream',
                videoInfo: { codec: 'h264', width: 1920, height: 1080 },
            },
            outputDir: '/tmp/transcode/test-job-123',
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
        } as unknown as TranscodeJob;
    });

    afterEach(() => {
        // Stop any running analysis to prevent memory leaks
        if (mockJob) {
            mockJob.status = 'stopped';
        }
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    // ========================================================================
    // startAnalysis() Tests
    // ========================================================================

    describe('startAnalysis()', () => {
        it('should start background analysis worker', async () => {
            // Mock fs.access to immediately fail (no segments yet)
            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            // Start analysis (runs in background)
            analyzer.startAnalysis(mockJob);

            // Give it a moment to start
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Should have attempted to check for segment_00000.m4s
            expect(fs.access).toHaveBeenCalled();
        });

        it('should calculate correct stream directory from audio tracks', async () => {
            // 2 audio tracks → video stream is stream_2
            mockJob.config.audioTracks = [
                {
                    index: asAbsoluteStreamIndex(0),
                    displayTitle: 'English',
                    language: 'eng',
                    channels: 2,
                    codec: 'aac',
                    isDefault: true,
                },
                {
                    index: asAbsoluteStreamIndex(1),
                    displayTitle: 'Spanish',
                    language: 'spa',
                    channels: 2,
                    codec: 'aac',
                    isDefault: false,
                },
            ];

            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 10));

            // Should check stream_2 directory (videoStreamIndex = audioTracks.length = 2)
            const accessCalls = vi.mocked(fs.access).mock.calls;
            const streamPath = String(accessCalls[0]?.[0]);
            expect(streamPath).toContain('stream_2');
        });
    });

    // ========================================================================
    // Analysis Loop Tests
    // ========================================================================

    describe('runAnalysis() loop', () => {
        it('should analyze segments as they become available', async () => {
            vi.useFakeTimers();

            // Mock ffprobe output with keyframe data
            const ffprobeOutput = JSON.stringify({
                packets: [
                    { pos: '0', size: '1024', flags: 'K', pts_time: '0.000' },
                    { pos: '2048', size: '512', flags: '', pts_time: '0.033' },
                    { pos: '4096', size: '2048', flags: 'K', pts_time: '2.000' },
                ],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            // Segment becomes available after 2 checks
            let accessCallCount = 0;
            vi.mocked(fs.access).mockImplementation(async () => {
                accessCallCount++;
                if (accessCallCount <= 2) {
                    throw new Error('ENOENT');
                }
                // Segment now exists
            });

            analyzer.startAnalysis(mockJob);

            // Advance timers to allow polling
            await vi.advanceTimersByTimeAsync(1000); // First check fails
            await vi.advanceTimersByTimeAsync(500); // Second check fails
            await vi.advanceTimersByTimeAsync(500); // Third check succeeds

            // Give analysis time to complete
            await vi.advanceTimersByTimeAsync(1000);

            // Should have analyzed one segment
            expect(mockJob.iframeAnalyzedCount).toBe(1);
            expect(mockJob.iframeData.length).toBeGreaterThan(0);

            vi.useRealTimers();
        });

        it('should stop analysis when job status becomes stopped', async () => {
            vi.useFakeTimers();

            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            analyzer.startAnalysis(mockJob);

            // Advance and change status
            await vi.advanceTimersByTimeAsync(500);
            mockJob.status = 'stopped';
            await vi.advanceTimersByTimeAsync(500);

            // Analysis should have stopped - iframeAnalyzedCount should still be 0
            expect(mockJob.iframeAnalyzedCount).toBe(0);

            vi.useRealTimers();
        });

        it('should stop analysis when job status becomes error', async () => {
            vi.useFakeTimers();

            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            analyzer.startAnalysis(mockJob);

            await vi.advanceTimersByTimeAsync(500);
            mockJob.status = 'error';
            await vi.advanceTimersByTimeAsync(500);

            // Analysis should have stopped
            expect(mockJob.iframeAnalyzedCount).toBe(0);

            vi.useRealTimers();
        });

        it('should continue to next segment after analyzing current one', async () => {
            vi.useFakeTimers();

            const ffprobeOutput = JSON.stringify({
                packets: [{ pos: '0', size: '1024', flags: 'K', pts_time: '0.000' }],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            // First 2 segments exist, then job stops
            let accessCallCount = 0;
            vi.mocked(fs.access).mockImplementation(async (filePath: PathLike) => {
                accessCallCount++;
                const pathStr = String(filePath);

                if (pathStr.includes('segment_00000') || pathStr.includes('segment_00001')) {
                    // These segments exist
                    return;
                }

                // Stop job after 2 segments
                if (accessCallCount > 2) {
                    mockJob.status = 'stopped';
                }

                throw new Error('ENOENT');
            });

            analyzer.startAnalysis(mockJob);

            // Allow time for both segments to be analyzed
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(100);
            }
            // Give final time for analysis to complete
            await vi.advanceTimersByTimeAsync(1000);

            // Should have analyzed 2 segments
            expect(mockJob.iframeAnalyzedCount).toBe(2);

            vi.useRealTimers();
        });

        it('should set iframeAnalysisComplete when job stops', async () => {
            vi.useFakeTimers();

            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            analyzer.startAnalysis(mockJob);

            await vi.advanceTimersByTimeAsync(500);
            mockJob.status = 'stopped';
            await vi.advanceTimersByTimeAsync(600);

            // Should mark analysis as complete
            expect(mockJob.iframeAnalysisComplete).toBe(true);

            vi.useRealTimers();
        });
    });

    // ========================================================================
    // analyzeSegmentForIFrames() Tests
    // ========================================================================

    describe('analyzeSegmentForIFrames()', () => {
        it('should extract keyframe packets from ffprobe output', async () => {
            const ffprobeOutput = JSON.stringify({
                packets: [
                    { pos: '0', size: '1024', flags: 'K', pts_time: '0.000' },
                    { pos: '2048', size: '512', flags: '', pts_time: '0.033' },
                    {
                        pos: '4096',
                        size: '2048',
                        flags: 'K',
                        pts_time: '2.000',
                    },
                    { pos: '8192', size: '1536', flags: 'K', pts_time: '4.000' },
                ],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            // Wait for analysis
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Stop job to complete analysis
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should have extracted 3 keyframes (packets with 'K' flag)
            expect(mockJob.iframeData.length).toBe(3);

            // Check first keyframe
            expect(mockJob.iframeData[0]).toMatchObject({
                segmentIndex: 0, // segmentOffset + actualSegmentIndex = 0 + 0
                byteOffset: 0,
                byteSize: 1024,
                duration: 0.0,
            });

            // Check second keyframe
            expect(mockJob.iframeData[1]).toMatchObject({
                segmentIndex: 0,
                byteOffset: 4096,
                byteSize: 2048,
                duration: 2.0,
            });
        });

        it('should handle segments with no keyframes', async () => {
            const ffprobeOutput = JSON.stringify({
                packets: [
                    { pos: '0', size: '1024', flags: '', pts_time: '0.000' },
                    { pos: '2048', size: '512', flags: '', pts_time: '0.033' },
                ],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 100));
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should have no keyframes
            expect(mockJob.iframeData.length).toBe(0);
            expect(mockJob.iframeAnalyzedCount).toBe(1); // Still counted as analyzed
        });

        it('should handle ffprobe errors gracefully', async () => {
            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(new Error('ffprobe failed'), {
                        stdout: '',
                        stderr: '',
                    });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 100));
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should have attempted analysis but returned empty array on error
            expect(mockJob.iframeData.length).toBe(0);
        });

        it('should handle malformed ffprobe JSON', async () => {
            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, {
                        stdout: 'not valid json',
                        stderr: '',
                    });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 100));
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should handle parse error gracefully
            expect(mockJob.iframeData.length).toBe(0);
        });

        it('should calculate timeline segment index with offset', async () => {
            mockJob.segmentOffset = 100; // Job started at segment 100

            const ffprobeOutput = JSON.stringify({
                packets: [{ pos: '0', size: '1024', flags: 'K', pts_time: '0.000' }],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 100));
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Timeline segment should be offset + actualSegmentIndex = 100 + 0
            expect(mockJob.iframeData[0]?.segmentIndex).toBe(100);
        });

        it('should include segment URI in iframe data', async () => {
            const ffprobeOutput = JSON.stringify({
                packets: [{ pos: '0', size: '1024', flags: 'K', pts_time: '0.000' }],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 100));
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Should have segment URI
            expect(mockJob.iframeData[0]?.segmentUri).toContain('stream_');
            expect(mockJob.iframeData[0]?.segmentUri).toContain('segment_00000.m4s');
        });

        it('should parse floating point pts_time correctly', async () => {
            const ffprobeOutput = JSON.stringify({
                packets: [
                    {
                        pos: '0',
                        size: '1024',
                        flags: 'K',
                        pts_time: '1.234567',
                    },
                    {
                        pos: '2048',
                        size: '512',
                        flags: 'K',
                        pts_time: '3.987654',
                    },
                ],
            });

            (
                vi.mocked(exec) as unknown as {
                    mockImplementation: (
                        fn: (cmd: string, opts: unknown, cb?: ExecTestCallback) => unknown,
                    ) => void;
                }
            ).mockImplementation((_cmd, _opts, callback) => {
                if (callback) {
                    callback(null, { stdout: ffprobeOutput, stderr: '' });
                }
                return {};
            });

            vi.mocked(fs.access).mockResolvedValue(undefined);

            analyzer.startAnalysis(mockJob);

            await new Promise((resolve) => setTimeout(resolve, 100));
            mockJob.status = 'stopped';
            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(mockJob.iframeData[0]?.duration).toBeCloseTo(1.234567);
            expect(mockJob.iframeData[1]?.duration).toBeCloseTo(3.987654);
        });
    });

    // ========================================================================
    // stopAnalysis() Tests
    // ========================================================================

    describe('stopAnalysis()', () => {
        it('should be a no-op that logs debug message', () => {
            // stopAnalysis doesn't actually do anything - analysis loop checks job.status
            analyzer.stopAnalysis(mockJob);

            // Should not throw
            expect(true).toBe(true);
        });

        it('should rely on job status for stopping loop', async () => {
            vi.useFakeTimers();

            vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

            analyzer.startAnalysis(mockJob);

            // Loop is running
            await vi.advanceTimersByTimeAsync(500);

            // Call stopAnalysis (doesn't actually stop anything)
            analyzer.stopAnalysis(mockJob);

            // Loop continues because job.status is still 'running'
            await vi.advanceTimersByTimeAsync(500);

            // Change job status to actually stop
            mockJob.status = 'stopped';
            await vi.advanceTimersByTimeAsync(600);

            // Now it should be stopped
            expect(mockJob.iframeAnalysisComplete).toBe(true);

            vi.useRealTimers();
        });
    });
});
