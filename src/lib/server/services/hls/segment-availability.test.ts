// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createMissingHlsFileResponse, waitForInitSegment } from './segment-availability.js';
import type { SegmentResponseContext } from './segment-action-executor.js';
import type { TranscodeJob } from '../transcoding/types.js';

const job = {
    id: 'job',
    status: 'running',
    segmentsReady: 5,
    config: {
        totalDurationSeconds: 120,
    },
    endSegmentCache: new Map(),
} as TranscodeJob;

const context: SegmentResponseContext = {
    job,
    segmentOffset: 0,
    requestedSegmentNum: 1,
    actualSegmentIndex: 1,
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

const baseMissingOptions = {
    responseContext: context,
    job,
    playSessionId: 'play',
    filePath: '/tmp/hls/stream_0/segment_00001.m4s',
    segmentPath: 'stream_0/segment_00001.m4s',
    isSegment: true,
    isInitSegment: false,
    segmentInfo: {
        streamDir: 'stream_0',
        segmentIndex: 1,
    },
    requestedSegmentNum: 1,
    segmentOffset: 0,
    streamDirName: 'stream_0',
    streamTargetDuration: 10,
    jobSegmentDuration: 10,
    contentType: 'video/mp4',
    corsHeaders: context.corsHeaders,
    logInfo: () => undefined,
    logWarn: () => undefined,
    logDebug: () => undefined,
};

describe('waitForInitSegment', () => {
    it('waits until the init segment is accessible', async () => {
        let attempts = 0;

        const fileExists = await waitForInitSegment({
            fileExists: false,
            isInitSegment: true,
            job,
            playSessionId: 'play',
            normalizedPath: 'stream_0/init_0.mp4',
            filePath: '/tmp/hls/stream_0/init_0.mp4',
            timeoutMs: 50,
            pollIntervalMs: 0,
            getJobByPlaySession: () => job,
            clearSeekTimestamp: () => undefined,
            accessFile: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('not ready');
            },
            sleep: () => Promise.resolve(),
            logDebug: () => undefined,
        });

        expect(fileExists).toBe(true);
        expect(attempts).toBe(2);
    });

    it('clears seek timestamps when the init wait sees a stopped job', async () => {
        const cleared: string[] = [];

        const fileExists = await waitForInitSegment({
            fileExists: false,
            isInitSegment: true,
            job,
            playSessionId: 'play',
            normalizedPath: 'stream_0/init_0.mp4',
            filePath: '/tmp/hls/stream_0/init_0.mp4',
            timeoutMs: 50,
            pollIntervalMs: 0,
            getJobByPlaySession: () => ({ ...job, status: 'stopped' }) as TranscodeJob,
            clearSeekTimestamp: (playSessionId) => {
                cleared.push(playSessionId);
            },
            accessFile: async () => {
                throw new Error('not ready');
            },
            sleep: () => Promise.resolve(),
            logDebug: () => undefined,
        });

        expect(fileExists).toBe(false);
        expect(cleared).toEqual(['play']);
    });
});

describe('createMissingHlsFileResponse', () => {
    it('returns segment 404s with debug branch headers', async () => {
        const response = createMissingHlsFileResponse(baseMissingOptions);

        expect(response.status).toBe(404);
        expect(response.headers.get('X-Lumastra-Branch')).toBe('segment_not_found');
        await expect(response.text()).resolves.toBe('Segment not found');
    });

    // An init that FFmpeg has not written YET is not a 404. AVFoundation treats
    // 404 as terminal and penalty-boxes the variant, so a live job must get a
    // retryable answer — the same guard the media playlist uses.
    it('returns 503 + Retry-After for an init a live job has not written yet', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            isSegment: false,
            isInitSegment: true,
            segmentInfo: null,
        });

        expect(response.status).not.toBe(404);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('1');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('returns init 404s with CORS headers only once the job is gone', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            job: { ...job, status: 'stopped' } as TranscodeJob,
            isSegment: false,
            isInitSegment: true,
            segmentInfo: null,
        });

        expect(response.status).toBe(404);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
        expect(response.headers.get('X-Lumastra-Branch')).toBeNull();
        await expect(response.text()).resolves.toBe('Init segment not found');
    });

    it('serves cached tail probes as a last resort', async () => {
        const tailJob = {
            ...job,
            endSegmentCache: new Map([
                [
                    'stream_0',
                    { kind: 'segment' as const, segmentIndex: 11, buffer: Buffer.from('tail') },
                ],
            ]),
        } as TranscodeJob;

        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            responseContext: {
                ...context,
                job: tailJob,
                requestedSegmentNum: 11,
                actualSegmentIndex: 11,
            },
            job: tailJob,
            requestedSegmentNum: 11,
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe('4');
        await expect(response.text()).resolves.toBe('tail');
    });

    it('does not answer another tail index with the cached entry', async () => {
        const tailJob = {
            ...job,
            endSegmentCache: new Map([
                [
                    'stream_0',
                    { kind: 'segment' as const, segmentIndex: 10, buffer: Buffer.from('tail') },
                ],
            ]),
        } as TranscodeJob;

        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            responseContext: {
                ...context,
                job: tailJob,
                requestedSegmentNum: 11,
                actualSegmentIndex: 11,
            },
            job: tailJob,
            requestedSegmentNum: 11,
        });

        expect(response.status).toBe(404);
        await expect(response.text()).resolves.not.toBe('tail');
    });

    // A forward seek that outruns a slow transcode used to get a 404 here, which
    // hls.js never retries and the player triages as terminal (GPU hw test
    // 2026-10-01: 4K HDR -> 720p at ~4.5x, segment 24 requested 12 s in).
    it('returns 503 + Retry-After for a media segment a live job has not reached yet', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            requestedSegmentNum: 8,
            currentProgress: 3,
        });

        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('1');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('X-Lumastra-Branch')).toBe('segment_not_ready');
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('keeps the 404 for an I-frame request (best-effort thumbnail)', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            requestedSegmentNum: 8,
            currentProgress: 3,
            isIframeRequest: true,
        });

        expect(response.status).toBe(404);
    });

    it('keeps the 404 for a media segment once the job is gone', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            job: { ...job, status: 'stopped' } as TranscodeJob,
            requestedSegmentNum: 8,
            currentProgress: 3,
        });

        expect(response.status).toBe(404);
        expect(response.headers.get('X-Lumastra-Branch')).toBe('segment_not_found');
    });

    it('keeps the 404 for a media segment the encoder already passed', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            requestedSegmentNum: 2,
            currentProgress: 5,
        });

        expect(response.status).toBe(404);
    });

    it('keeps the 404 for a media segment below the generation start', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            requestedSegmentNum: 4,
            segmentOffset: 6,
            currentProgress: 3,
        });

        expect(response.status).toBe(404);
    });

    it('keeps the 404 for a tail probe the end cache cannot answer', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            requestedSegmentNum: 11,
            currentProgress: 3,
        });

        expect(response.status).toBe(404);
    });

    it('answers 503 mid-seek even though progress still describes the old generation', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            job: { ...job, status: 'stopped', isSeeking: true } as TranscodeJob,
            requestedSegmentNum: 2,
            currentProgress: 5,
        });

        expect(response.status).toBe(503);
    });

    it('returns generic file 404s for non-segment files', async () => {
        const response = createMissingHlsFileResponse({
            ...baseMissingOptions,
            isSegment: false,
            isInitSegment: false,
            segmentInfo: null,
        });

        expect(response.status).toBe(404);
        await expect(response.text()).resolves.toBe('File not found');
    });
});
