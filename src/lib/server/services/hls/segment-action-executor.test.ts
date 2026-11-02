// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
    createDeletedSegmentResponse,
    createSegmentNotFoundResponse,
    createTailCacheSegmentResponse,
    executeBackwardSeekAction,
    executeForwardSeekAction,
    waitForCurrentSegmentFile,
    type SegmentResponseContext,
} from './segment-action-executor.js';
import type { TranscodeJob } from '../transcoding/types.js';

const context: SegmentResponseContext = {
    job: { id: 'job' } as TranscodeJob,
    segmentOffset: 10,
    requestedSegmentNum: 12,
    actualSegmentIndex: 2,
    streamDirName: 'stream_0',
    playSessionId: 'play',
    canSeek: false,
    streamTargetDuration: 6,
    corsHeaders: {
        'Access-Control-Allow-Origin': '*',
    },
    buildDebugHeaders: ({ branch }) => ({
        'X-Lumastra-Branch': branch,
        'X-Test-Debug': '1',
    }),
};

describe('HLS segment action executor responses', () => {
    it('creates deleted segment responses with JSON body and debug headers', async () => {
        const response = createDeletedSegmentResponse(context);

        expect(response.status).toBe(410);
        expect(response.headers.get('Content-Type')).toContain('application/json');
        expect(response.headers.get('X-Lumastra-Branch')).toBe('deleted');
        await expect(response.json()).resolves.toMatchObject({
            code: 'SEGMENT_EXPIRED',
        });
    });

    it('creates not-found segment responses with branch debug headers', async () => {
        const response = createSegmentNotFoundResponse(context, 'negative_non_authoritative');

        expect(response.status).toBe(404);
        expect(response.headers.get('X-Lumastra-Branch')).toBe('negative_non_authoritative');
        await expect(response.text()).resolves.toBe('Segment not found');
    });

    it('creates tail-cache responses with the cached payload length', async () => {
        const cached = Buffer.from('segment');
        const response = createTailCacheSegmentResponse({
            corsHeaders: context.corsHeaders,
            contentType: 'video/mp4',
            cached,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe('7');
        expect(response.headers.get('Content-Type')).toBe('video/mp4');
        expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
        await expect(response.text()).resolves.toBe('segment');
    });
});

describe('waitForCurrentSegmentFile', () => {
    const job = {
        id: 'job',
        status: 'running',
        isSeeking: false,
        segmentsReady: 20,
        generationRole: 'current',
    } as TranscodeJob;

    const baseOptions = {
        job,
        playSessionId: 'play',
        requestedSegmentNum: 110,
        actualSegmentIndex: 10,
        segmentOffset: 100,
        actualFilePath: '/tmp/hls/stream_0/segment_00010.m4s',
        sourceFilePath: '/tmp/hls/stream_0/segment_00110.m4s',
        segExt: 'm4s',
        streamDirName: 'stream_0',
        streamTargetDuration: 10,
        jobSegmentDuration: 10,
        canSeek: false,
        isIframeRequest: false,
        isRepeatedSegmentPressure: false,
        repeatedRequestCount: 1,
        isVideoTranscoded: false,
        waitTimeoutMs: 50,
        seekWaitTimeoutMs: 50,
        iframeWaitTimeoutMs: 50,
        pollIntervalMs: 0,
        getJobByPlaySession: () => job,
        getSegmentOffset: () => 100,
        getStreamSegmentOffset: () => 100,
        clearSeekTimestamp: () => undefined,
        sleep: () => Promise.resolve(),
    };

    it('returns the existing file without changing the path', async () => {
        const accessed: string[] = [];

        const result = await waitForCurrentSegmentFile({
            ...baseOptions,
            accessFile: async (filePath) => {
                accessed.push(filePath);
            },
        });

        expect(result).toEqual({
            fileExists: true,
            actualFilePath: '/tmp/hls/stream_0/segment_00010.m4s',
            waitMs: expect.any(Number),
        });
        expect(accessed).toEqual(['/tmp/hls/stream_0/segment_00010.m4s']);
    });

    it('recomputes remux segment paths when the stream offset changes', async () => {
        const accessed: string[] = [];

        const result = await waitForCurrentSegmentFile({
            ...baseOptions,
            getStreamSegmentOffset: () => 105,
            accessFile: async (filePath) => {
                accessed.push(filePath);
                if (!filePath.endsWith('segment_00005.m4s')) {
                    throw new Error('not ready');
                }
            },
        });

        expect(result).toEqual({
            fileExists: true,
            actualFilePath: '/tmp/hls/stream_0/segment_00005.m4s',
            waitMs: expect.any(Number),
        });
        expect(accessed).toEqual(['/tmp/hls/stream_0/segment_00005.m4s']);
    });

    it('repairs a wait below the proven FFmpeg start instead of timing out', async () => {
        const current = {
            ...job,
            outputDir: '/tmp/hls',
            segmentOffset: 9,
            ffmpegOutputStartNumber: 9,
            config: {
                playSessionId: 'play',
                effectivePlan: {
                    version: 1,
                    grid: 'uniform',
                    segmentOffset: 9,
                    startNumber: 9,
                },
            },
        } as TranscodeJob;
        const accessed: string[] = [];
        const logError = vi.fn();
        const result = await waitForCurrentSegmentFile({
            ...baseOptions,
            logError,
            canSeek: true,
            job: current,
            requestedSegmentNum: 9,
            actualSegmentIndex: 0,
            segmentOffset: 9,
            actualFilePath: '/tmp/hls/segment_00000.m4s',
            sourceFilePath: '/tmp/hls/segment_00009.m4s',
            streamDirName: '',
            isVideoTranscoded: true,
            getJobByPlaySession: () => current,
            getSegmentOffset: () => 9,
            accessFile: async (file) => {
                accessed.push(file);
                if (!file.endsWith('segment_00009.m4s')) throw new Error('not written');
            },
        });
        expect(result.fileExists).toBe(true);
        expect(result.actualFilePath).toBe('/tmp/hls/segment_00009.m4s');
        expect(accessed).toContain('/tmp/hls/segment_00009.m4s');
        expect(logError).toHaveBeenCalledWith(
            'HLS segment start/grid mismatch',
            expect.objectContaining({
                playSessionId: 'play',
                waitingForIndex: 0,
                producedStartNumber: 9,
                plan: current.config.effectivePlan,
            }),
        );
    });

    it('restarts when the produced grid cannot safely be remapped', async () => {
        const current = {
            ...job,
            ffmpegOutputStartNumber: 9,
            config: { effectivePlan: { grid: 'keyframe' } },
        } as TranscodeJob;
        const restart = vi.fn().mockResolvedValue(true);
        const result = await waitForCurrentSegmentFile({
            ...baseOptions,
            job: current,
            canSeek: true,
            segmentOffset: 2,
            getStreamSegmentOffset: () => 2,
            requestedSegmentNum: 4,
            actualSegmentIndex: 0,
            actualFilePath: '/tmp/hls/segment_00000.m4s',
            getJobByPlaySession: () => current,
            restartAtRequestedSegment: restart,
            accessFile: async (file) => {
                if (!file.endsWith('segment_00009.m4s')) throw new Error('not written');
            },
            logError: vi.fn(),
        });
        expect(restart).toHaveBeenCalledTimes(1);
        expect(result.retryAfterRecovery).toBe(true);
    });

    it.each([false, true])(
        'rejects a request below this generation without restart (canSeek=%s)',
        async (canSeek) => {
            const current = {
                ...job,
                segmentOffset: 10,
                ffmpegOutputStartNumber: 10,
                config: { effectivePlan: { grid: 'uniform', segmentOffset: 10 } },
            } as TranscodeJob;
            const restart = vi.fn().mockResolvedValue(true);
            const sleep = vi.fn().mockResolvedValue(undefined);
            const result = await waitForCurrentSegmentFile({
                ...baseOptions,
                job: current,
                canSeek,
                isVideoTranscoded: true,
                requestedSegmentNum: 5,
                segmentOffset: 10,
                actualSegmentIndex: 5,
                actualFilePath: '/tmp/hls/segment_00005.m4s',
                getJobByPlaySession: () => current,
                getSegmentOffset: () => 10,
                restartAtRequestedSegment: restart,
                sleep,
                accessFile: async (file) => {
                    if (!file.endsWith('segment_00010.m4s')) throw new Error('not written');
                },
            });
            expect(result.fileExists).toBe(false);
            expect(result.retryAfterRecovery).toBeUndefined();
            expect(restart).not.toHaveBeenCalled();
            expect(sleep).not.toHaveBeenCalled();
        },
    );

    it('never restarts non-authoritative audio for an in-window mismatch', async () => {
        const current = { ...job, segmentOffset: 2, ffmpegOutputStartNumber: 10 } as TranscodeJob;
        const restart = vi.fn().mockResolvedValue(true);
        const result = await waitForCurrentSegmentFile({
            ...baseOptions,
            job: current,
            requestedSegmentNum: 5,
            segmentOffset: 2,
            actualFilePath: '/tmp/hls/segment_00003.m4s',
            getStreamSegmentOffset: () => 2,
            getJobByPlaySession: () => current,
            restartAtRequestedSegment: restart,
            waitTimeoutMs: 2,
            accessFile: async (file) => {
                if (!file.endsWith('segment_00010.m4s')) throw new Error('not written');
            },
        });
        expect(result.fileExists).toBe(false);
        expect(restart).not.toHaveBeenCalled();
    });

    it.each(['seeking', 'previous', 'replaced', 'no-proof'])(
        'does not apply start recovery to %s output',
        async (reason) => {
            const current = {
                ...job,
                ffmpegOutputStartNumber: 9,
                isSeeking: reason === 'seeking',
                generationRole: reason === 'previous' ? 'previous' : 'current',
            } as TranscodeJob;
            const logError = vi.fn();
            const restart = vi.fn().mockResolvedValue(true);
            const result = await waitForCurrentSegmentFile({
                ...baseOptions,
                job: current,
                actualSegmentIndex: 0,
                actualFilePath: '/tmp/hls/segment_00000.m4s',
                waitTimeoutMs: 2,
                seekWaitTimeoutMs: 2,
                getJobByPlaySession: () =>
                    reason === 'replaced' ? { ...current, id: 'new' } : current,
                restartAtRequestedSegment: restart,
                logError,
                accessFile: async (file) => {
                    if (reason === 'no-proof' || !file.endsWith('segment_00009.m4s'))
                        throw new Error('not written');
                },
            });
            expect(result.fileExists).toBe(false);
            expect(restart).not.toHaveBeenCalled();
            expect(logError).not.toHaveBeenCalled();
        },
    );

    it('clears seek timestamps when the current job is stopped', async () => {
        const cleared: string[] = [];

        const result = await waitForCurrentSegmentFile({
            ...baseOptions,
            getJobByPlaySession: () =>
                ({
                    ...job,
                    status: 'stopped',
                    isSeeking: false,
                }) as TranscodeJob,
            clearSeekTimestamp: (playSessionId) => {
                cleared.push(playSessionId);
            },
            accessFile: async () => {
                throw new Error('not ready');
            },
        });

        expect(result.fileExists).toBe(false);
        expect(cleared).toEqual(['play']);
    });
});

describe('executeForwardSeekAction', () => {
    const job = {
        id: 'job',
        outputDir: '/tmp/hls/gen-1',
        status: 'running',
        isSeeking: false,
        segmentsReady: 20,
        generationRole: 'current',
        lastSeekTrigger: '',
    } as TranscodeJob;

    const baseOptions = {
        responseContext: context,
        job,
        playSessionId: 'play',
        requestedSegmentNum: 120,
        segmentOffset: 100,
        currentProgress: 110,
        fileExists: false,
        actualFilePath: '/tmp/hls/gen-0/stream_0/segment_00020.m4s',
        normalizedPath: 'stream_0/segment_00120.m4s',
        segExt: 'm4s',
        streamDirName: 'stream_0',
        streamTargetDuration: 10,
        isVideoTranscoded: false,
        branch: 'forward_seek' as const,
        seekCooldownMs: 5000,
        forwardSeekThreshold: 10,
        seekWaitTimeoutMs: 50,
        pollIntervalMs: 0,
        logIntervalMs: 5000,
        getLastSeekTimestamp: () => undefined,
        setLastSeekTimestamp: () => undefined,
        clearSeekTimestamp: () => undefined,
        pruneExpiredSeekTimestamps: () => undefined,
        deduplicatedSeek: async () => true,
        getJobByPlaySession: () => job,
        getStreamSegmentOffsetForJob: () => 115,
        readFile: async () => Buffer.from('segment-data'),
        sleep: () => Promise.resolve(),
    };

    it('returns a cooldown response for stale forward seek requests', async () => {
        const result = await executeForwardSeekAction({
            ...baseOptions,
            getLastSeekTimestamp: () => Date.now(),
        });

        expect(result.response?.status).toBe(503);
        expect(result.response?.headers.get('Retry-After')).toBe('5');
        expect(result.response?.headers.get('Cache-Control')).toBe('no-store');
        expect(result.response?.headers.get('X-Lumastra-Branch')).toBe('forward_cooldown');
        await expect(result.response?.text()).resolves.toBe('');
    });

    // The distance-gated cooldown never covers a gap under the fixed threshold,
    // which is exactly where a speed-aware seek fires: without this, a few quick
    // skips on a slow transcode each spawned a generation.
    it('applies the cooldown to a speed-aware seek at any distance', async () => {
        const seekTargets: number[] = [];
        const nearOptions = {
            ...baseOptions,
            requestedSegmentNum: 105,
            getLastSeekTimestamp: () => Date.now(),
            deduplicatedSeek: async (_: string, target: number) => {
                seekTargets.push(target);
                return true;
            },
        };

        const speedAware = await executeForwardSeekAction({
            ...nearOptions,
            branch: 'speed_aware_forward_seek',
        });
        expect(speedAware.response?.status).toBe(503);
        expect(speedAware.response?.headers.get('X-Lumastra-Branch')).toBe(
            'speed_aware_forward_cooldown',
        );
        expect(seekTargets).toEqual([]);

        const fixed = await executeForwardSeekAction(nearOptions);
        expect(fixed.response?.headers.get('X-Lumastra-Branch')).not.toBe('forward_cooldown');
        expect(seekTargets).toEqual([105]);
    });

    it('seeks, recomputes the post-seek segment path, and waits for it', async () => {
        const seekTargets: number[] = [];
        const readPaths: string[] = [];
        const nextJob = { ...job, id: 'next', outputDir: '/tmp/hls/gen-2' };

        const result = await executeForwardSeekAction({
            ...baseOptions,
            deduplicatedSeek: async (_playSessionId, targetSegmentIndex) => {
                seekTargets.push(targetSegmentIndex);
                return true;
            },
            getJobByPlaySession: () => nextJob as TranscodeJob,
            readFile: async (filePath) => {
                readPaths.push(filePath);
                return Buffer.from('segment-data');
            },
        });

        expect(result.response).toBeUndefined();
        expect(result.job).toBe(nextJob);
        expect(result.fileExists).toBe(true);
        expect(result.fileContent).toEqual(Buffer.from('segment-data'));
        expect(result.actualFilePath).toBe('/tmp/hls/gen-2/stream_0/segment_00005.m4s');
        expect(result.waitMs).toEqual(expect.any(Number));
        expect(seekTargets).toEqual([120]);
        expect(readPaths).toEqual(['/tmp/hls/gen-2/stream_0/segment_00005.m4s']);
        expect(job.lastSeekTrigger).toBe('forward:stream_0:seg120');
    });
});

describe('executeBackwardSeekAction', () => {
    const job = {
        id: 'job',
        outputDir: '/tmp/hls/gen-1',
        status: 'running',
        isSeeking: false,
        segmentsReady: 20,
        generationRole: 'current',
        lastSeekTrigger: '',
    } as TranscodeJob;

    const baseOptions = {
        responseContext: context,
        job,
        playSessionId: 'play',
        requestedSegmentNum: 80,
        segmentOffset: 100,
        normalizedPath: 'stream_0/segment_00080.m4s',
        segExt: 'm4s',
        streamDirName: 'stream_0',
        streamTargetDuration: 10,
        isVideoTranscoded: false,
        segmentInfoStreamDir: 'stream_0',
        seekCooldownMs: 5000,
        forwardSeekThreshold: 10,
        seekWaitTimeoutMs: 50,
        pollIntervalMs: 0,
        logIntervalMs: 5000,
        getLastSeekTimestamp: () => undefined,
        setLastSeekTimestamp: () => undefined,
        clearSeekTimestamp: () => undefined,
        pruneExpiredSeekTimestamps: () => undefined,
        deduplicatedSeek: async () => true,
        getJobByPlaySession: () => job,
        getStreamSegmentOffsetForJob: () => 80,
        recordSegmentAccessForJob: () => undefined,
        readFile: async () => Buffer.from('segment'),
        sleep: () => Promise.resolve(),
    };

    it('returns a cooldown response for stale backward seek requests', async () => {
        const response = await executeBackwardSeekAction({
            ...baseOptions,
            getLastSeekTimestamp: () => Date.now(),
        });

        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Lumastra-Branch')).toBe('backward_cooldown');
        await expect(response.text()).resolves.toBe('');
    });

    it('allows a three-minute rewind to retry after the forward-seek cooldown', async () => {
        const forwardSeekTime = 100_000;
        const now = vi.spyOn(Date, 'now').mockReturnValue(forwardSeekTime + 3000);
        const seek = vi.fn(async () => true);
        // The forward restart began at 30 minutes; rewind to 27 minutes.
        const options = {
            ...baseOptions,
            segmentOffset: 300,
            requestedSegmentNum: 270,
            streamTargetDuration: 6,
            forwardSeekThreshold: 15,
            isVideoTranscoded: true,
            getLastSeekTimestamp: () => forwardSeekTime,
            deduplicatedSeek: seek,
            getStreamSegmentOffsetForJob: () => 269,
        };
        try {
            const response = await executeBackwardSeekAction(options);
            expect(response.status).toBe(503);
            expect(response.headers.get('Retry-After')).toBe('2');
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expect(seek).not.toHaveBeenCalled();

            now.mockReturnValue(forwardSeekTime + 5000);
            const retry = await executeBackwardSeekAction(options);
            expect(retry.status).toBe(200);
            expect(seek).toHaveBeenCalledExactlyOnceWith('play', 270, 6);
            await expect(retry.text()).resolves.toBe('segment');
        } finally {
            now.mockRestore();
        }
    });

    it('seeks, reads the post-seek segment, and records access', async () => {
        const seekTargets: number[] = [];
        const readPaths: string[] = [];
        const recorded: number[] = [];
        const served: Array<{
            streamDir: string;
            requestedSegment: number;
            actualSegment: number;
            segmentOffset: number;
            waitMs: number;
        }> = [];

        const response = await executeBackwardSeekAction({
            ...baseOptions,
            deduplicatedSeek: async (_playSessionId, targetSegmentIndex) => {
                seekTargets.push(targetSegmentIndex);
                return true;
            },
            readFile: async (filePath) => {
                readPaths.push(filePath);
                return Buffer.from('segment');
            },
            recordSegmentAccessForJob: (_job, _streamDir, segmentIndex) => {
                recorded.push(segmentIndex);
            },
            onSegmentServed: (segment) => {
                served.push(segment);
            },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe('7');
        // The restarted generation rewrites this URL: it must not be cached.
        expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
        await expect(response.text()).resolves.toBe('segment');
        expect(seekTargets).toEqual([80]);
        expect(readPaths).toEqual(['/tmp/hls/gen-1/stream_0/segment_00000.m4s']);
        expect(recorded).toEqual([0]);
        expect(served).toEqual([
            expect.objectContaining({
                streamDir: 'stream_0',
                requestedSegment: 80,
                actualSegment: 0,
                segmentOffset: 80,
                waitMs: expect.any(Number),
            }),
        ]);
        expect(job.lastSeekTrigger).toBe('backward:stream_0:seg80');
    });

    it('returns a seek-failed response when FFmpeg seek fails', async () => {
        const response = await executeBackwardSeekAction({
            ...baseOptions,
            deduplicatedSeek: async () => false,
        });

        expect(response.status).toBe(503);
        expect(response.headers.get('X-Lumastra-Branch')).toBe('backward_seek_failed');
        await expect(response.text()).resolves.toBe('Seek failed');
    });
});
