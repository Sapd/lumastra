// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { serveMuxedRootAsset } from './muxed-root-asset.js';
import type { TranscodeJob } from '../transcoding/types.js';

/**
 * Minimal but structurally real ISO-BMFF init: `ftyp` + `moov`, exactly the
 * shape FFmpeg writes (verified against a live prod init: ftyp 28B + moov).
 * `moovBody` pads the moov so a truncated prefix can be taken from it.
 */
function makeInit(moovBodySize = 64): Buffer {
    const ftyp = Buffer.alloc(28);
    ftyp.writeUInt32BE(28, 0);
    ftyp.write('ftypiso5', 4, 'latin1');
    const moov = Buffer.alloc(8 + moovBodySize, 7);
    moov.writeUInt32BE(8 + moovBodySize, 0);
    moov.write('moov', 4, 'latin1');
    return Buffer.concat([ftyp, moov]);
}

const FULL_INIT = makeInit();

function createJob(outputDir = '/tmp/hls/gen-0'): TranscodeJob {
    return {
        id: 'job',
        outputDir,
        lastAccessedAt: new Date(0),
    } as TranscodeJob;
}

const baseOptions = {
    job: createJob(),
    playSessionId: 'play',
    normalizedPath: 'init_0.mp4',
    contentType: 'video/mp4',
    isInitSegment: true,
    corsHeaders: {
        'Access-Control-Allow-Origin': '*',
    },
    waitTimeoutMs: 20,
    pollIntervalMs: 0,
    getJobByPlaySession: () => undefined,
    readFile: async () => FULL_INIT,
    trackHlsSegment: () => undefined,
    logWarn: () => undefined,
    sleep: () => Promise.resolve(),
};

describe('serveMuxedRootAsset', () => {
    it('serves the current muxed root asset and tracks bandwidth', async () => {
        const tracked: number[] = [];
        const job = createJob();

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job,
            trackHlsSegment: (bytes) => {
                tracked.push(bytes);
            },
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe(String(FULL_INIT.length));
        expect(response.headers.get('Cache-Control')).toBe('no-cache');
        expect(Buffer.from(await response.arrayBuffer()).equals(FULL_INIT)).toBe(true);
        expect(tracked).toEqual([FULL_INIT.length]);
        expect(job.lastAccessedAt.getTime()).toBeGreaterThan(0);
    });

    it('uses a newer current job when the session was rerouted', async () => {
        const originalJob = createJob('/tmp/hls/gen-0');
        const currentJob = createJob('/tmp/hls/gen-1');
        const readPaths: string[] = [];

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job: originalJob,
            getJobByPlaySession: () => currentJob,
            readFile: async (filePath) => {
                readPaths.push(filePath);
                return FULL_INIT;
            },
        });

        expect(response.status).toBe(200);
        expect(readPaths).toEqual(['/tmp/hls/gen-1/init_0.mp4']);
        expect(response.headers.get('Content-Length')).toBe(String(FULL_INIT.length));
        expect(originalJob.lastAccessedAt.getTime()).toBe(0);
        expect(currentJob.lastAccessedAt.getTime()).toBeGreaterThan(0);
    });

    it('returns 400 when the rerouted path escapes the output directory', async () => {
        const response = await serveMuxedRootAsset({
            ...baseOptions,
            normalizedPath: '../init_0.mp4',
        });

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toBe('Invalid path');
    });

    it('returns 400 when the rerouted path escapes to a sibling with a shared prefix', async () => {
        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job: createJob('/tmp/hls/gen-1'),
            normalizedPath: '../gen-10/init_0.mp4',
        });

        expect(response.status).toBe(400);
        await expect(response.text()).resolves.toBe('Invalid path');
    });

    it('returns a not-ready response after waiting for missing init files', async () => {
        const response = await serveMuxedRootAsset({
            ...baseOptions,
            readFile: async () => {
                const error = new Error('missing') as Error & { code: string };
                error.code = 'ENOENT';
                throw error;
            },
        });

        expect(response.status).toBe(404);
        await expect(response.text()).resolves.toBe('Init segment not ready');
    });

    it('rethrows non-ENOENT read errors', async () => {
        await expect(
            serveMuxedRootAsset({
                ...baseOptions,
                readFile: async () => {
                    const error = new Error('permission') as Error & {
                        code: string;
                    };
                    error.code = 'EACCES';
                    throw error;
                },
            }),
        ).rejects.toThrow('permission');
    });
    // Regression: prod 2026-08-20. A 5s rewind restarts FFmpeg, which creates
    // init_0.mp4 before writing ftyp+moov into it. The poll loop only retried on
    // ENOENT, so a read landing in that create->write window returned 200 with an
    // empty body and hls.js died with `fragParsingError`.
    it('keeps waiting when the init file exists but is still empty', async () => {
        const reads_: Buffer[] = [Buffer.alloc(0), Buffer.alloc(0), FULL_INIT];
        let reads = 0;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            waitTimeoutMs: 1_000,
            readFile: async () => {
                const buf = reads_[Math.min(reads, reads_.length - 1)];
                reads += 1;
                return buf;
            },
        });

        expect(reads).toBe(3);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe(String(FULL_INIT.length));
    });

    it('returns a not-ready response when the init file never stops being empty', async () => {
        const response = await serveMuxedRootAsset({
            ...baseOptions,
            readFile: async () => Buffer.alloc(0),
        });

        expect(response.status).toBe(404);
        await expect(response.text()).resolves.toBe('Init segment not ready');
    });
    // Edge-case review, finding 2: the empty-check alone still let a *partially*
    // written init through — non-zero but truncated, so still no complete moov.
    it('keeps waiting on a truncated init and serves it once the moov lands', async () => {
        const truncated = FULL_INIT.subarray(0, 40); // ftyp + a moov header claiming 72B
        const reads: Buffer[] = [truncated, truncated, FULL_INIT];
        let n = 0;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            waitTimeoutMs: 1_000,
            readFile: async () => reads[Math.min(n++, reads.length - 1)],
        });

        expect(n).toBe(3);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Length')).toBe(String(FULL_INIT.length));
    });

    it('does not apply the moov check to non-init assets', async () => {
        const response = await serveMuxedRootAsset({
            ...baseOptions,
            isInitSegment: false,
            readFile: async () => Buffer.from('not-an-mp4'),
        });

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('not-an-mp4');
    });

    // Edge-case review, finding 1: without a liveness check, a job that died
    // mid-write made every request block for the whole timeout before 404ing.
    it('gives up immediately when the job has died', async () => {
        const sleeps: number[] = [];
        const deadJob = {
            ...createJob(),
            status: 'error' as const,
            isSeeking: false,
        } as TranscodeJob;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job: deadJob,
            waitTimeoutMs: 60_000,
            readFile: async () => Buffer.alloc(0),
            sleep: async (ms: number) => {
                sleeps.push(ms);
            },
        });

        expect(response.status).toBe(404);
        expect(sleeps).toEqual([]);
    });

    // `stopJob()` sets 'stopping' before an awaited kill + directory delete, so
    // a genuine teardown sat in it for the whole graceful-SIGTERM window — and
    // forever when FFmpeg wedges in uninterruptible I/O. Waiters polled the
    // full timeout for a request that could only 404.
    it('gives up immediately when the job is tearing down', async () => {
        const sleeps: number[] = [];
        const stoppingJob = {
            ...createJob(),
            status: 'stopping' as const,
            isSeeking: false,
        } as TranscodeJob;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job: stoppingJob,
            waitTimeoutMs: 60_000,
            readFile: async () => Buffer.alloc(0),
            sleep: async (ms: number) => {
                sleeps.push(ms);
            },
        });

        expect(response.status).toBe(404);
        expect(sleeps).toEqual([]);
    });

    // ...but a seek passes through 'stopping' too, and that restart is the
    // whole reason this wait exists.
    it('keeps waiting through the stopping phase of a seek', async () => {
        const seekingJob = {
            ...createJob(),
            status: 'stopping' as const,
            isSeeking: true,
        } as TranscodeJob;
        const reads: Buffer[] = [Buffer.alloc(0), FULL_INIT];
        let n = 0;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job: seekingJob,
            waitTimeoutMs: 1_000,
            readFile: async () => reads[Math.min(n++, reads.length - 1)],
        });

        expect(response.status).toBe(200);
        expect(n).toBe(2);
    });

    it('keeps waiting through the stop that a seek performs', async () => {
        const seekingJob = {
            ...createJob(),
            status: 'stopped' as const,
            isSeeking: true,
        } as TranscodeJob;
        const reads: Buffer[] = [Buffer.alloc(0), FULL_INIT];
        let n = 0;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            job: seekingJob,
            waitTimeoutMs: 1_000,
            readFile: async () => reads[Math.min(n++, reads.length - 1)],
        });

        expect(response.status).toBe(200);
        expect(n).toBe(2);
    });

    // Edge-case review, finding 3: a timeout under one poll interval expired on
    // the first iteration, so the create->write window got no retry at all.
    it('still retries once when the configured timeout is zero', async () => {
        const reads: Buffer[] = [Buffer.alloc(0), FULL_INIT];
        let n = 0;

        const response = await serveMuxedRootAsset({
            ...baseOptions,
            waitTimeoutMs: 0,
            pollIntervalMs: 5,
            readFile: async () => reads[Math.min(n++, reads.length - 1)],
        });

        expect(response.status).toBe(200);
        expect(n).toBe(2);
    });
});
