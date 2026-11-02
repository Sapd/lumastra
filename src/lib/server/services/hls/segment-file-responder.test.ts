// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveHlsSegmentFile } from './segment-file-responder.js';
import type { SegmentResponseContext } from './segment-action-executor.js';
import type { TranscodeJob } from '../transcoding/types.js';

/** Captured server-side telemetry emissions. The specifier MUST match the one
 *  the source module imports ('../playback-telemetry.service.js') — an
 *  absolute-path specifier silently no-ops under CI. */
const { telemetryRecords } = vi.hoisted(() => ({
    telemetryRecords: [] as Array<{ metric: string; value: number }>,
}));

vi.mock('../playback-telemetry.service.js', () => ({
    playbackTelemetryService: {
        record: async (_playSessionId: string, _source: string, metric: string, value: number) => {
            telemetryRecords.push({ metric, value });
        },
    },
}));

/** Let the source stream's 'end' listener and the fire-and-forget record()
 *  promise settle before asserting. */
const settleTelemetry = () => new Promise((resolve) => setTimeout(resolve, 0));

const deliveryMetrics = () => telemetryRecords.filter((r) => r.metric === 'segment_delivery_ms');

const job = {
    id: 'job',
    config: {
        totalDurationSeconds: 120,
    },
    endSegmentCache: new Map(),
} as TranscodeJob;

const context: SegmentResponseContext = {
    job,
    segmentOffset: 100,
    requestedSegmentNum: 110,
    actualSegmentIndex: 10,
    streamDirName: 'stream_0',
    playSessionId: 'play',
    canSeek: false,
    streamTargetDuration: 10,
    corsHeaders: {
        'Access-Control-Allow-Origin': '*',
    },
    buildDebugHeaders: ({ branch }) => ({
        'X-Lumastra-Branch': branch,
    }),
};

const baseOptions = {
    responseContext: context,
    job,
    playSessionId: 'play',
    segmentPath: 'stream_0/segment_00110.m4s',
    filePath: '/tmp/hls/stream_0/segment_00010.m4s',
    contentType: 'video/mp4',
    rangeHeader: null,
    segmentInfo: {
        streamDir: 'stream_0',
        segmentIndex: 110,
    },
    requestedSegmentNum: 110,
    isVideoTranscoded: false,
    streamTargetDuration: 10,
    jobSegmentDuration: 10,
    readFile: async () => Buffer.from('0123456789'),
    clearRepeatedSegmentRequest: () => undefined,
    getStreamSegmentOffsetForJob: () => 100,
    recordSegmentAccessForJob: () => undefined,
    trackHlsSegment: () => undefined,
    logDebug: () => undefined,
};

describe('serveHlsSegmentFile', () => {
    beforeEach(() => {
        telemetryRecords.length = 0;
    });

    describe('buffer path (preReadBuffer and tail segments)', () => {
        it('serves full segment responses and records access', async () => {
            const tracked: number[] = [];
            const recorded: number[] = [];
            const cleared: number[] = [];

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                clearRepeatedSegmentRequest: (_playSessionId, _streamDir, requestedSegmentNum) => {
                    cleared.push(requestedSegmentNum);
                },
                recordSegmentAccessForJob: (_job, _streamDir, segmentIndex) => {
                    recorded.push(segmentIndex);
                },
                trackHlsSegment: (bytes) => {
                    tracked.push(bytes);
                },
            });

            expect(response.status).toBe(200);
            // Session-scoped segment: revalidate, never cache; Range stays (I-frame scrubbing).
            expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
            expect(response.headers.get('Content-Length')).toBe('10');
            expect(response.headers.get('X-Lumastra-Branch')).toBe('serve');
            await expect(response.text()).resolves.toBe('0123456789');
            expect(cleared).toEqual([110]);
            expect(recorded).toEqual([10]);
            expect(tracked).toEqual([10]);
        });

        it('serves byte ranges and tracks partial bandwidth', async () => {
            const tracked: number[] = [];

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                rangeHeader: 'bytes=2-5',
                trackHlsSegment: (bytes) => {
                    tracked.push(bytes);
                },
            });

            expect(response.status).toBe(206);
            // Session-scoped segment: revalidate, never cache; Range stays (I-frame scrubbing).
            expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
            expect(response.headers.get('Content-Length')).toBe('4');
            expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
            expect(response.headers.get('X-Lumastra-Branch')).toBe('serve_range');
            await expect(response.text()).resolves.toBe('2345');
            expect(tracked).toEqual([4]);
        });

        it('returns 416 for unsatisfiable ranges', async () => {
            const response = await serveHlsSegmentFile({
                ...baseOptions,
                rangeHeader: 'bytes=99-',
            });

            expect(response.status).toBe(416);
            expect(response.headers.get('Content-Range')).toBe('bytes */10');
            await expect(response.text()).resolves.toBe('Range Not Satisfiable');
        });

        it('returns read-race 404 when the file disappears', async () => {
            const response = await serveHlsSegmentFile({
                ...baseOptions,
                readFile: async () => {
                    throw new Error('deleted');
                },
            });

            expect(response.status).toBe(404);
            expect(response.headers.get('X-Lumastra-Branch')).toBe('read_race_deleted');
            await expect(response.text()).resolves.toBe('Segment no longer available');
        });

        it('caches tail segments for later hls.js tail probes', async () => {
            const cacheJob = {
                ...job,
                endSegmentCache: new Map(),
            } as TranscodeJob;

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: {
                    ...context,
                    job: cacheJob,
                },
                job: cacheJob,
                requestedSegmentNum: 11,
            });

            expect(response.status).toBe(200);
            // Session-scoped segment: revalidate, never cache; Range stays (I-frame scrubbing).
            expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
            expect(cacheJob.endSegmentCache.get('stream_0')).toEqual({
                kind: 'segment',
                segmentIndex: 11,
                buffer: Buffer.from('0123456789'),
            });
        });

        it('keeps the later tail entry when an earlier one is served after it', async () => {
            const held = {
                kind: 'segment' as const,
                segmentIndex: 11,
                buffer: Buffer.from('LAST'),
            };
            const cacheJob = {
                ...job,
                endSegmentCache: new Map([['stream_0', held]]),
            } as TranscodeJob;

            await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: { ...context, job: cacheJob },
                job: cacheJob,
                requestedSegmentNum: 10,
            });

            expect(cacheJob.endSegmentCache.get('stream_0')).toBe(held);
        });

        it('serves pre-read buffer from seek without hitting disk', async () => {
            const preReadBuffer = Buffer.from('SEEKDATA');
            let readFileCalled = false;

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                preReadBuffer,
                readFile: async () => {
                    readFileCalled = true;
                    return Buffer.alloc(0);
                },
                // Non-tail segment to verify preReadBuffer forces buffer path
                requestedSegmentNum: 1,
            });

            expect(response.status).toBe(200);
            // Session-scoped segment: revalidate, never cache; Range stays (I-frame scrubbing).
            expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
            expect(readFileCalled).toBe(false);
            await expect(response.text()).resolves.toBe('SEEKDATA');
        });
    });

    describe('streaming path (non-tail disk segments)', () => {
        const tmpBase = join(tmpdir(), 'segment-responder-test');

        function setupTmpFile(content: string): string {
            mkdirSync(tmpBase, { recursive: true });
            const filePath = join(tmpBase, `seg_${Date.now()}.m4s`);
            writeFileSync(filePath, content);
            return filePath;
        }

        // Clean up once after all streaming tests
        afterAll(() => {
            try {
                rmSync(tmpBase, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
        });

        // Use a long-duration job so most segments are NOT tail segments
        const longJob = {
            id: 'job-long',
            config: {
                totalDurationSeconds: 36000, // 10 hours
            },
            endSegmentCache: new Map(),
        } as TranscodeJob;

        const longContext: SegmentResponseContext = {
            ...context,
            job: longJob,
            requestedSegmentNum: 5,
        };

        it('streams segment from disk without buffering', async () => {
            const content = 'STREAMED_SEGMENT_DATA';
            const filePath = setupTmpFile(content);
            const tracked: number[] = [];

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: longContext,
                job: longJob,
                filePath,
                requestedSegmentNum: 5,
                trackHlsSegment: (bytes) => tracked.push(bytes),
            });

            expect(response.status).toBe(200);
            // Session-scoped segment: revalidate, never cache; Range stays (I-frame scrubbing).
            expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
            expect(response.headers.get('Content-Length')).toBe(content.length.toString());
            expect(response.headers.get('X-Lumastra-Branch')).toBe('serve');
            await expect(response.text()).resolves.toBe(content);
            expect(tracked).toEqual([content.length]);
        });

        it('streams range requests from disk', async () => {
            const content = 'ABCDEFGHIJ';
            const filePath = setupTmpFile(content);
            const tracked: number[] = [];

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: longContext,
                job: longJob,
                filePath,
                requestedSegmentNum: 5,
                rangeHeader: 'bytes=3-6',
                trackHlsSegment: (bytes) => tracked.push(bytes),
            });

            expect(response.status).toBe(206);
            // Session-scoped segment: revalidate, never cache; Range stays (I-frame scrubbing).
            expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
            expect(response.headers.get('Accept-Ranges')).toBe('bytes');
            expect(response.headers.get('Content-Length')).toBe('4');
            expect(response.headers.get('Content-Range')).toBe(`bytes 3-6/${content.length}`);
            await expect(response.text()).resolves.toBe('DEFG');
            expect(tracked).toEqual([4]);
        });

        it('returns 404 when file does not exist on disk', async () => {
            const response = await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: longContext,
                job: longJob,
                filePath: '/tmp/nonexistent_segment.m4s',
                requestedSegmentNum: 5,
            });

            expect(response.status).toBe(404);
            expect(response.headers.get('X-Lumastra-Branch')).toBe('read_race_deleted');
        });

        it('returns 416 for unsatisfiable ranges on streaming path', async () => {
            const content = 'tiny';
            const filePath = setupTmpFile(content);

            const response = await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: longContext,
                job: longJob,
                filePath,
                requestedSegmentNum: 5,
                rangeHeader: 'bytes=999-',
            });

            expect(response.status).toBe(416);
            expect(response.headers.get('Content-Range')).toBe(`bytes */${content.length}`);
        });

        it('does not cache non-tail segments in endSegmentCache', async () => {
            const cacheJob = {
                ...longJob,
                endSegmentCache: new Map(),
            } as TranscodeJob;
            const content = 'NOT_CACHED';
            const filePath = setupTmpFile(content);

            await serveHlsSegmentFile({
                ...baseOptions,
                responseContext: { ...longContext, job: cacheJob },
                job: cacheJob,
                filePath,
                requestedSegmentNum: 5,
            });

            expect(cacheJob.endSegmentCache.size).toBe(0);
        });

        describe('delivery-time telemetry', () => {
            it('emits segment_delivery_ms once the streamed body is fully consumed', async () => {
                const content = 'STREAMED_DELIVERY_TIMING_PAYLOAD';
                const filePath = setupTmpFile(content);

                const response = await serveHlsSegmentFile({
                    ...baseOptions,
                    responseContext: longContext,
                    job: longJob,
                    filePath,
                    requestedSegmentNum: 5,
                });

                await expect(response.text()).resolves.toBe(content);
                await settleTelemetry();

                // The streamed path is the hot path for sequential playback: without
                // a delivery-time sample here, server_avg_segment_time_ms stays NULL
                // for every web session and the health scorer cannot tell a slow
                // server from a stalled client.
                expect(deliveryMetrics()).toHaveLength(1);
                expect(deliveryMetrics()[0].value).toBeGreaterThanOrEqual(0);
                expect(telemetryRecords.filter((r) => r.metric === 'segment_bytes')).toEqual([
                    { metric: 'segment_bytes', value: content.length },
                ]);
            });

            it('does not emit segment_delivery_ms when the client aborts mid-transfer', async () => {
                const content = 'ABORTED_TRANSFER_PAYLOAD';
                const filePath = setupTmpFile(content);

                const response = await serveHlsSegmentFile({
                    ...baseOptions,
                    responseContext: longContext,
                    job: longJob,
                    filePath,
                    requestedSegmentNum: 5,
                });

                // Safari routinely cancels and re-requests a segment; timing a
                // transfer the client threw away would bias the fleet p95.
                await response.body?.cancel();
                await settleTelemetry();

                expect(deliveryMetrics()).toEqual([]);
            });

            it('does not emit segment_delivery_ms for range requests', async () => {
                const content = 'ABCDEFGHIJ';
                const filePath = setupTmpFile(content);

                const response = await serveHlsSegmentFile({
                    ...baseOptions,
                    responseContext: longContext,
                    job: longJob,
                    filePath,
                    requestedSegmentNum: 5,
                    rangeHeader: 'bytes=2-5',
                });

                await response.text();
                await settleTelemetry();

                // A partial transfer is not comparable to a whole-segment delivery,
                // so only the byte count is reported for ranges.
                expect(deliveryMetrics()).toEqual([]);
                expect(telemetryRecords.filter((r) => r.metric === 'segment_bytes')).toEqual([
                    { metric: 'segment_bytes', value: 4 },
                ]);
            });
        });
    });
});
