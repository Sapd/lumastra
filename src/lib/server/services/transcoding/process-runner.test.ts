// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for FFmpegProcessRunnerEvents
 *
 * Tests FFmpeg process lifecycle management:
 * - Process spawning with event listeners
 * - stderr monitoring and progress parsing
 * - Exit code handling
 * - Graceful termination (SIGTERM → SIGKILL)
 * - Error scenarios
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import {
    FFmpegProcessRunnerEvents,
    createStderrCapture,
    appendStderr,
    renderStderr,
    STDERR_HEAD_CHARS,
    STDERR_TAIL_CHARS,
} from './process-runner.js';
import type { TranscodeJob } from './types.js';

// Mock child_process
vi.mock('child_process', () => ({
    spawn: vi.fn(),
}));

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

// Mock config
vi.mock('../../config.js', () => ({
    config: {
        FFMPEG_PATH: '/usr/bin/ffmpeg',
        FFMPEG_SEGMENT_DURATION: 6,
    },
}));

describe('FFmpegProcessRunnerEvents', () => {
    let runner: FFmpegProcessRunnerEvents;
    let mockProcess: MockChildProcess & ChildProcess;
    let mockJob: TranscodeJob;

    // Mock ChildProcess that extends EventEmitter
    class MockChildProcess extends EventEmitter {
        pid = 12345;
        killed = false;
        exitCode: number | null = null;
        signalCode: string | null = null;
        stdin: EventEmitter | null = null;
        stdout: EventEmitter | null = null;
        stderr = new EventEmitter();

        kill(signal?: string | number): boolean {
            // Node sets `killed` true once ANY signal is delivered (not just SIGKILL),
            // so model that. Tests still control when the actual 'exit' fires — except
            // for SIGKILL, which we model as the kernel reaping the process (signalCode
            // set) so killFFmpeg's post-kill confirmation resolves.
            this.killed = true;
            if (signal === 'SIGKILL') {
                this.signalCode = 'SIGKILL';
            }
            return true;
        }

        // Simulate a real graceful exit: exitCode set + 'exit' event emitted, the way
        // killFFmpeg's waitForProcessExit now detects termination.
        exitGracefully(): void {
            this.exitCode = 0;
            this.emit('exit', 0, null);
        }
    }

    beforeEach(() => {
        vi.clearAllMocks();
        runner = new FFmpegProcessRunnerEvents();
        mockProcess = new MockChildProcess() as MockChildProcess & ChildProcess;

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
                inputUrl: 'http://example.com/stream',
                videoInfo: { codec: 'h264', width: 1920, height: 1080 },
            },
            outputDir: '/tmp/transcode/test-job-123',
            status: 'starting',
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
        vi.useRealTimers();
    });

    // ========================================================================
    // spawnFFmpeg() Tests
    // ========================================================================

    describe('spawnFFmpeg()', () => {
        it('should spawn FFmpeg process successfully', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            const args = ['-i', 'input.mp4', 'output.m3u8'];
            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            // Advance to allow spawnFFmpeg's 500ms check to complete
            await vi.advanceTimersByTimeAsync(501);

            expect(spawn).toHaveBeenCalledWith('/usr/bin/ffmpeg', args, {
                cwd: mockJob.outputDir,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            expect(mockJob.process).toBe(mockProcess);
            expect(mockJob.status).toBe('running');

            // Should not throw
            await expect(spawnPromise).resolves.toBeUndefined();

            vi.useRealTimers();
        });

        it('should throw error if FFmpeg binary not found', async () => {
            const { spawn } = await import('child_process');
            const spawnError = new Error('ENOENT: no such file or directory') as Error & {
                code?: string;
            };
            spawnError.code = 'ENOENT';
            vi.mocked(spawn).mockImplementation(() => {
                throw spawnError;
            });

            const args = ['-i', 'input.mp4'];
            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            // Should throw the original error (not wrapped)
            await expect(runner.spawnFFmpeg(mockJob, args, callbacks)).rejects.toThrow('ENOENT');
            expect(mockJob.status).toBe('error');
            // But job.error should have the wrapped message
            expect(mockJob.error).toContain('Failed to spawn FFmpeg');
            expect(mockJob.error).toContain('ENOENT');
        });

        it('should parse progress from stderr', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            const progressHandler = vi.fn();
            runner.on('progress', progressHandler);

            const args = ['-i', 'input.mp4'];
            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            // Wait a bit then emit stderr data
            await vi.advanceTimersByTimeAsync(100);

            // Emit stderr data with progress
            mockProcess.stderr.emit(
                'data',
                Buffer.from(
                    'frame=  123 fps= 30 q=28.0 size=    1024kB time=00:01:30.00 bitrate= 100kbits/s speed=1.0x',
                ),
            );

            // Progress should be parsed: 1 minute 30 seconds = 90 seconds / 6 second segments = 15 segments
            expect(mockJob.segmentsReady).toBe(15);
            expect(progressHandler).toHaveBeenCalledWith(15);

            // Advance to complete the 500ms check
            await vi.advanceTimersByTimeAsync(401);

            await expect(spawnPromise).resolves.toBeUndefined();

            vi.useRealTimers();
        });

        // GOP mode (services/hls/gop-grid.ts): segmentsReady counts ASSEMBLED grid
        // entries and belongs to the assembler; FFmpeg's clock only feeds the
        // stall watchdog.
        it('leaves segmentsReady to the assembler for a GOP-mode job', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();
            const gopJob = {
                ...mockJob,
                config: { ...mockJob.config, gopSegments: true },
                keyframeData: [0, 10, 20],
                segmentsReady: 3,
                lastProgressAt: undefined,
            } as unknown as typeof mockJob;
            const spawnPromise = runner.spawnFFmpeg(gopJob, ['-i', 'input.mp4'], {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            });
            await vi.advanceTimersByTimeAsync(100);
            mockProcess.stderr.emit(
                'data',
                Buffer.from(
                    'frame=  123 fps= 30 q=28.0 size=    1024kB time=00:01:30.00 bitrate= 100kbits/s speed=1.0x',
                ),
            );
            expect(gopJob.segmentsReady).toBe(3);
            expect(gopJob.gopLastFfmpegSeconds).toBe(90);
            expect(gopJob.lastProgressAt).toBeInstanceOf(Date);
            await vi.advanceTimersByTimeAsync(401);
            await expect(spawnPromise).resolves.toBeUndefined();
            vi.useRealTimers();
        });

        // The planner's speed-aware forward seek reads job.transcodeSpeed, so a
        // stale first-of-chunk value would decide a restart off an old reading.
        it('keeps the newest speed= of a chunk, including %g exponent form', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            const spawnPromise = runner.spawnFFmpeg(mockJob, ['-i', 'input.mp4'], {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            });
            await vi.advanceTimersByTimeAsync(100);

            mockProcess.stderr.emit(
                'data',
                Buffer.from(
                    'frame=1 time=00:00:01.00 speed=0.52x\rframe=2 time=00:00:02.00 speed=4.5x\r',
                ),
            );
            expect(mockJob.transcodeSpeed).toBe(4.5);

            mockProcess.stderr.emit('data', Buffer.from('frame=9 time=00:09:00.00 speed=1.2e+03x'));
            expect(mockJob.transcodeSpeed).toBe(1200);

            await vi.advanceTimersByTimeAsync(401);
            await expect(spawnPromise).resolves.toBeUndefined();
            vi.useRealTimers();
        });

        it('should invoke onMasterPlaylistCheck callback when receiving stderr data', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Emit stderr data
            mockProcess.stderr.emit('data', Buffer.from('FFmpeg output'));

            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(callbacks.onMasterPlaylistCheck).toHaveBeenCalled();

            await expect(spawnPromise).resolves.toBeUndefined();
        });

        it('should handle exit code 0 (success)', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Emit exit with code 0
            mockProcess.emit('exit', 0, null);

            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(callbacks.onExit).toHaveBeenCalledWith(
                0,
                null,
                expect.any(String),
                expect.any(Boolean),
            );
            expect(mockJob.process).toBeNull();

            await expect(spawnPromise).resolves.toBeUndefined();
        });

        it('should handle exit with signal SIGTERM', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Emit exit with signal
            mockProcess.emit('exit', null, 'SIGTERM');

            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(callbacks.onExit).toHaveBeenCalledWith(
                null,
                'SIGTERM',
                expect.any(String),
                expect.any(Boolean),
            );

            await expect(spawnPromise).resolves.toBeUndefined();
        });

        it('should handle non-zero exit code', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Emit exit with error code
            mockProcess.emit('exit', 1, null);

            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(callbacks.onExit).toHaveBeenCalledWith(
                1,
                null,
                expect.any(String),
                expect.any(Boolean),
            );

            await expect(spawnPromise).resolves.toBeUndefined();
        });

        it('does not treat a clean exit-0 finish before the 500ms check as a failure', async () => {
            // Regression: a short remux/copy job (e.g. a file whose real duration is
            // much shorter than the job's expected total — combined-episode file
            // parts are a real case of this) can legitimately finish, produce all its
            // segments, and exit with code 0 well before the 500ms readiness check
            // runs. The check used to fire on "already exited" alone, discarding a
            // successful job and reporting a spurious startup failure.
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            const spawnPromise = runner.spawnFFmpeg(mockJob, ['-i', 'input.mp4'], callbacks);

            // Real Node sets ChildProcess#exitCode synchronously as 'exit' fires —
            // mirror that (unlike a bare .emit(), which doesn't touch the mock's
            // exitCode property) so this actually exercises the post-wait check.
            await vi.advanceTimersByTimeAsync(50);
            mockProcess.exitCode = 0;
            mockProcess.emit('exit', 0, null);

            await vi.advanceTimersByTimeAsync(451);

            await expect(spawnPromise).resolves.toBeUndefined();
            expect(callbacks.onExit).toHaveBeenCalledWith(0, null, expect.any(String), false);

            vi.useRealTimers();
        });

        it('still treats a non-zero exit before the 500ms check as a failed start', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            const spawnPromise = runner.spawnFFmpeg(mockJob, ['-i', 'input.mp4'], callbacks);
            // Attach the rejection expectation before advancing timers, so the
            // eventual rejection is never briefly unhandled.
            const assertion = expect(spawnPromise).rejects.toThrow(
                'died immediately with exit code 1',
            );

            await vi.advanceTimersByTimeAsync(50);
            mockProcess.exitCode = 1;
            mockProcess.emit('exit', 1, null);

            await vi.advanceTimersByTimeAsync(451);

            await assertion;
            expect(mockJob.status).toBe('error');

            vi.useRealTimers();
        });

        it('an early non-zero exit the exit callback recovered from is not a failed start', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            // The service's exit handler respawned the job (e.g. software
            // fallback after an NVENC session failure) and says so.
            const callbacks = {
                onExit: vi.fn(() => {
                    mockJob.status = 'running';
                    return true;
                }),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            const spawnPromise = runner.spawnFFmpeg(mockJob, ['-i', 'input.mp4'], callbacks);

            await vi.advanceTimersByTimeAsync(50);
            mockProcess.exitCode = 1;
            mockProcess.emit('exit', 1, null);
            await vi.advanceTimersByTimeAsync(451);

            await expect(spawnPromise).resolves.toBeUndefined();
            expect(mockJob.status).toBe('running');
            vi.useRealTimers();
        });

        it('waits for a replacement the exit callback started before the spawn returns', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            vi.useFakeTimers();

            let replaced = false;
            const callbacks = {
                onExit: vi.fn(
                    () =>
                        new Promise<void>((resolve) =>
                            setTimeout(() => {
                                replaced = true;
                                resolve();
                            }, 700),
                        ),
                ),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            let settled = false;
            const spawnPromise = runner
                .spawnFFmpeg(mockJob, ['-i', 'input.mp4'], callbacks)
                .then(() => (settled = true));

            await vi.advanceTimersByTimeAsync(50);
            mockProcess.exitCode = 1;
            mockProcess.emit('exit', 1, null);
            await vi.advanceTimersByTimeAsync(500);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(300);
            await spawnPromise;
            expect(replaced).toBe(true);
            vi.useRealTimers();
        });

        it('feeds speed readings past the startup grace into the slow-transcode tracker', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);
            const { startSlowTracking } = await import('./slow-transcode.js');
            mockJob.slowTranscode = startSlowTracking(Date.now() - 60_000);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            void runner.spawnFFmpeg(mockJob, ['-i', 'input.mp4'], callbacks);
            mockProcess.stderr.emit(
                'data',
                Buffer.from(
                    'frame=   24 fps=1.0 q=28.0 size=N/A time=00:00:01.00 bitrate=N/A speed=0.04x\n',
                ),
            );
            expect(mockJob.slowTranscode?.belowSince).toBeDefined();
        });

        it('should reject and invoke onError callback when process errors', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Emit an async spawn error (e.g. ENOENT/EMFILE). This sets neither
            // exitCode nor killed, so spawnFFmpeg must rethrow it explicitly rather
            // than resolve — otherwise the caller treats a never-started process as
            // a successful spawn.
            const error = new Error('Process error');
            mockProcess.emit('error', error);

            await expect(spawnPromise).rejects.toThrow('Process error');
            expect(callbacks.onError).toHaveBeenCalledWith(error);
            expect(mockJob.status).toBe('error');
        });

        it('should not invoke new process callbacks when old process exits', async () => {
            const { spawn } = await import('child_process');
            const oldProcess = new MockChildProcess();
            const newProcess = new MockChildProcess();

            // Each spawn gets its own callbacks — old process exit only calls old callbacks
            const oldCallbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };
            const newCallbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            vi.mocked(spawn).mockReturnValueOnce(oldProcess as MockChildProcess & ChildProcess);

            const args = ['-i', 'input.mp4'];
            const spawnPromise1 = runner.spawnFFmpeg(mockJob, args, oldCallbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Spawn new process (seek scenario)
            vi.mocked(spawn).mockReturnValueOnce(newProcess as MockChildProcess & ChildProcess);

            const spawnPromise2 = runner.spawnFFmpeg(mockJob, args, newCallbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            expect(mockJob.process).toBe(newProcess);

            // Old process exits — only oldCallbacks.onExit should be called
            oldProcess.emit('exit', 0, null);

            await new Promise((resolve) => setTimeout(resolve, 50));

            // Old callbacks invoked for old process exit
            expect(oldCallbacks.onExit).toHaveBeenCalledWith(
                0,
                null,
                expect.any(String),
                expect.any(Boolean),
            );
            // New callbacks must NOT be invoked by old process exit
            expect(newCallbacks.onExit).not.toHaveBeenCalled();
            // New process reference must still be intact
            expect(mockJob.process).toBe(newProcess);

            await expect(spawnPromise1).resolves.toBeUndefined();
            await expect(spawnPromise2).resolves.toBeUndefined();
        });

        it('should not invoke onError callback if error event fires after exit', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Exit first
            mockProcess.emit('exit', 1, null);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const exitCallCount = callbacks.onExit.mock.calls.length;

            // Error after exit (shouldn't invoke onError)
            mockProcess.emit('error', new Error('Late error'));
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(callbacks.onError).not.toHaveBeenCalled();
            expect(callbacks.onExit.mock.calls.length).toBe(exitCallCount);

            await expect(spawnPromise).resolves.toBeUndefined();
        });

        it('should keep stderr buffer manageable', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const args = ['-i', 'input.mp4'];
            const spawnPromise = runner.spawnFFmpeg(mockJob, args, callbacks);

            await new Promise((resolve) => setTimeout(resolve, 100));

            // Emit large stderr output, with a distinct marker at each end so the
            // assertion can prove WHICH parts survived, not just the total size.
            mockProcess.stderr.emit('data', Buffer.from('INIT_ERROR_LINE\n'));
            mockProcess.stderr.emit('data', Buffer.from('x'.repeat(40000)));
            mockProcess.stderr.emit('data', Buffer.from('\nTERMINAL_ERROR_LINE'));

            await new Promise((resolve) => setTimeout(resolve, 50));

            // Exit and check stderr buffer is truncated
            mockProcess.emit('exit', 0, null);
            await new Promise((resolve) => setTimeout(resolve, 50));

            interface FFmpegExitCall {
                2: string;
            }
            const stderrArg = (callbacks.onExit.mock.calls[0] as unknown as FFmpegExitCall)[2];
            // Bounded, but head-AND-tail: FFmpeg explains a doomed run at the start
            // (hwaccel init, filter-graph negotiation) and only dies at the end, so a
            // tail-only cap threw away the half the classifier and the GPU
            // learn-on-failure gate actually read.
            expect(stderrArg).toContain('INIT_ERROR_LINE');
            expect(stderrArg).toContain('TERMINAL_ERROR_LINE');
            expect(stderrArg).toContain('trimmed');
            expect(stderrArg.length).toBeLessThan(STDERR_HEAD_CHARS + STDERR_TAIL_CHARS + 200);

            await expect(spawnPromise).resolves.toBeUndefined();
        });

        it('hands a mid-size stderr tail to onExit untruncated (no 500-char slice)', async () => {
            const { spawn } = await import('child_process');
            vi.mocked(spawn).mockReturnValue(mockProcess);

            const callbacks = {
                onExit: vi.fn(),
                onError: vi.fn(),
                onMasterPlaylistCheck: vi.fn(),
            };

            const spawnPromise = runner.spawnFFmpeg(mockJob, ['-i', 'input.mp4'], callbacks);
            await new Promise((resolve) => setTimeout(resolve, 100));

            // 1500 chars — under the 5000 cap. The specific decode-fallback line
            // would live well before the last 500 chars of a real cascade.
            const marker = 'Impossible to convert between the formats';
            mockProcess.stderr.emit('data', Buffer.from(marker + '\n' + 'y'.repeat(1500)));
            await new Promise((resolve) => setTimeout(resolve, 50));

            mockProcess.emit('exit', 1, null);
            await new Promise((resolve) => setTimeout(resolve, 50));

            interface FFmpegExitCall {
                2: string;
            }
            const stderrArg = (callbacks.onExit.mock.calls[0] as unknown as FFmpegExitCall)[2];
            expect(stderrArg.length).toBeGreaterThan(500);
            expect(stderrArg).toContain(marker); // survives — was dropped by the old -500 slice

            await expect(spawnPromise).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // killFFmpeg() Tests
    // ========================================================================

    describe('killFFmpeg()', () => {
        it('should do nothing if process is null', async () => {
            await expect(runner.killFFmpeg(null)).resolves.toBeUndefined();
        });

        it('should do nothing if process already killed', async () => {
            mockProcess.exitGracefully();
            await expect(runner.killFFmpeg(mockProcess)).resolves.toBeUndefined();
        });

        // Regression: FFmpeg answers SIGTERM by flushing the current segment and
        // exiting 255 with NO signal, so handleExit cannot tell our own stop from a
        // crash unless killFFmpeg leaves this mark. Ten of fifteen rows on the prod
        // transcode-failures page were normal stops recorded as FFmpeg failures.
        it('stamps killRequested on the job BEFORE signalling', async () => {
            vi.useFakeTimers();
            mockJob.process = mockProcess as unknown as TranscodeJob['process'];
            expect(mockJob.killRequested).toBeUndefined();

            const killSpy = vi.spyOn(mockProcess, 'kill').mockImplementation(() => {
                // Asserted INSIDE kill(): the exit can land synchronously from here,
                // so a stamp written after the call would be too late.
                expect(mockJob.killRequested).toBe(true);
                return true;
            });

            void runner.killFFmpeg(mockJob, 5000, false);
            expect(killSpy).toHaveBeenCalledWith('SIGTERM');
            expect(mockJob.killRequested).toBe(true);

            mockProcess.exitGracefully();
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        });

        // A SIGSTOPped process leaves SIGTERM pending until it is continued, so a
        // stop of a throttled job would always wait out the grace and SIGKILL.
        it('continues a throttle-paused process before SIGTERM', async () => {
            vi.useFakeTimers();
            mockJob.process = mockProcess as unknown as TranscodeJob['process'];
            mockJob.throttledAt = new Date();
            const killSpy = vi.spyOn(mockProcess, 'kill');

            void runner.killFFmpeg(mockJob, 5000, false);
            expect(killSpy.mock.calls.slice(0, 2)).toEqual([['SIGCONT'], ['SIGTERM']]);
            expect(mockJob.throttledAt).toBeUndefined();

            mockProcess.exitGracefully();
            await vi.runAllTimersAsync();
            vi.useRealTimers();
        });

        it('leaves killRequested unset when there is no process to kill', async () => {
            mockJob.process = null;
            await runner.killFFmpeg(mockJob, 5000, false);
            // A job whose process already went away was not stopped by us — marking
            // it would mask a genuine crash on the next exit.
            expect(mockJob.killRequested).toBeUndefined();
        });

        it('should send SIGTERM and schedule SIGKILL', async () => {
            vi.useFakeTimers();

            const killSpy = vi.spyOn(mockProcess, 'kill');

            void runner.killFFmpeg(mockProcess, 5000, false);

            // Should send SIGTERM immediately
            expect(killSpy).toHaveBeenCalledWith('SIGTERM');

            // Advance to force kill timeout
            await vi.advanceTimersByTimeAsync(5001);
            await vi.runAllTimersAsync();

            // Should send SIGKILL after delay
            expect(killSpy).toHaveBeenCalledWith('SIGKILL');
            expect(killSpy).toHaveBeenCalledTimes(2);

            vi.useRealTimers();
        });

        it('should not send SIGKILL if process exits gracefully', async () => {
            vi.useFakeTimers();

            const killSpy = vi.spyOn(mockProcess, 'kill');

            void runner.killFFmpeg(mockProcess, 5000, false);

            // Should send SIGTERM
            expect(killSpy).toHaveBeenCalledWith('SIGTERM');

            // Process exits gracefully before SIGKILL timeout
            await vi.advanceTimersByTimeAsync(1000);
            mockProcess.exitGracefully();

            // Advance to where SIGKILL would fire
            await vi.advanceTimersByTimeAsync(4001);
            await vi.runAllTimersAsync();

            // Should not call SIGKILL (process already killed)
            expect(killSpy).toHaveBeenCalledTimes(1);

            vi.useRealTimers();
        });

        it('should force kill immediately in waitForExit mode', async () => {
            vi.useFakeTimers();

            const killSpy = vi.spyOn(mockProcess, 'kill');

            // Start the kill operation
            const killPromise = runner.killFFmpeg(mockProcess, 5000, true);

            // Should send SIGTERM immediately (before await)
            expect(killSpy).toHaveBeenCalledWith('SIGTERM');

            // Advance timers to trigger the await setTimeout (500ms)
            // Use advanceTimersToNextTimerAsync to ensure promise resolves
            await vi.advanceTimersToNextTimerAsync();

            // Now the await has completed and SIGKILL should be sent
            await killPromise;

            // Should send SIGKILL after short wait
            expect(killSpy).toHaveBeenCalledWith('SIGKILL');
            expect(killSpy).toHaveBeenCalledTimes(2);

            vi.useRealTimers();
        });

        it('should not send SIGKILL in waitForExit mode if process exits quickly', async () => {
            vi.useFakeTimers();

            const killSpy = vi.spyOn(mockProcess, 'kill');

            const killPromise = runner.killFFmpeg(mockProcess, 5000, true);

            expect(killSpy).toHaveBeenCalledWith('SIGTERM');

            // Process exits quickly before wait timeout
            await vi.advanceTimersByTimeAsync(100);
            mockProcess.exitGracefully();

            // Advance to where SIGKILL would fire (500ms total)
            await vi.advanceTimersByTimeAsync(401);
            await vi.runAllTimersAsync();

            // Should not call SIGKILL (process already killed)
            expect(killSpy).toHaveBeenCalledTimes(1);

            vi.useRealTimers();
            await killPromise;
        });
    });
});

// ---------------------------------------------------------------------------
// stderr diagnostic buffer
// ---------------------------------------------------------------------------
//
// The buffer used to keep only the LAST 5000 chars once it passed 10000. Because
// `-stats` streams a progress line to stderr every few hundred ms, any transcode
// running more than a few seconds blows past that — so for a failure that happens
// LATE the head was already gone, and the head is where FFmpeg announces what went
// wrong (input dump, hwaccel init, filter-graph errors).
//
// That silently degraded two things that read this buffer:
//   • classifyTranscodeFailure() → category 'unknown' instead of 'gpu-init'
//   • isLearnableGpuDecodeFailure() gates on /impossible to convert between the
//     formats/i — a line printed at filter-graph init. Trimmed away, the deny-map
//     learn branch can never fire and the ladder silently drops to the weaker
//     "bridge this session only" rescue.
describe('stderr capture (head + tail)', () => {
    const INIT_ERROR =
        "Impossible to convert between the formats supported by the filter 'Parsed_scale_qsv_0'";
    const TERMINAL_ERROR =
        '[vost#0:0/hevc_qsv] Task finished with error code: -22 (Invalid argument)';
    const progressSpam = (n: number): string =>
        Array.from(
            { length: n },
            (_, i) => `frame= ${i} fps=24 q=28.0 size= ${i}kB time=00:00:0${i % 10}.00 speed=1.0x`,
        ).join('\n');

    it('returns short output verbatim, with no trim marker', () => {
        const cap = createStderrCapture();
        appendStderr(cap, 'line one\n');
        appendStderr(cap, 'line two\n');
        expect(renderStderr(cap)).toBe('line one\nline two\n');
        expect(renderStderr(cap)).not.toContain('trimmed');
    });

    it('keeps BOTH the init error and the terminal error across a long noisy run', () => {
        const cap = createStderrCapture();
        appendStderr(cap, `${INIT_ERROR}\n`);
        appendStderr(cap, progressSpam(4000)); // ~200 KB of -stats noise
        appendStderr(cap, `${TERMINAL_ERROR}\n`);

        const rendered = renderStderr(cap);
        expect(rendered).toContain(INIT_ERROR);
        expect(rendered).toContain(TERMINAL_ERROR);
        expect(rendered).toContain('trimmed');
    });

    it('keeps the retained buffer bounded regardless of input volume', () => {
        const cap = createStderrCapture();
        for (let i = 0; i < 50; i++) appendStderr(cap, progressSpam(1000));
        expect(renderStderr(cap).length).toBeLessThan(STDERR_HEAD_CHARS + STDERR_TAIL_CHARS + 200);
    });

    it('still exposes a late "signal 15" for SIGTERM detection', () => {
        const cap = createStderrCapture();
        appendStderr(cap, progressSpam(4000));
        appendStderr(cap, 'Exiting normally, received signal 15.\n');
        expect(renderStderr(cap)).toContain('signal 15');
    });
});
