// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    applyStaleSegmentGuard,
    type ApplyStaleSegmentGuardOptions,
} from './stale-segment-guard.js';
import type { SegmentResponseContext } from './segment-action-executor.js';
import type { TranscodeJob } from '../transcoding/types.js';

const context: SegmentResponseContext = {
    job: { id: 'job' } as TranscodeJob,
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
    buildDebugHeaders: ({ branch, segmentOffset, actualSegmentIndex }) => ({
        'X-Lumastra-Branch': branch,
        'X-Lumastra-Offset': segmentOffset.toString(),
        'X-Lumastra-Actual': actualSegmentIndex.toString(),
    }),
};

const job = {
    id: 'job',
    segmentsReady: 20,
    lastFFmpegSpawnTime: 1000,
    spawnAttempt: 1,
    isSeeking: false,
    generationRole: 'current',
} as TranscodeJob;

const baseOptions: ApplyStaleSegmentGuardOptions = {
    responseContext: context,
    job,
    playSessionId: 'play',
    fileExists: true,
    isSegment: true,
    canSeek: false,
    actualSegmentIndex: 10,
    requestedSegmentNum: 110,
    segmentOffset: 100,
    actualFilePath: '/tmp/hls/stream_0/segment_00010.m4s',
    sourceFilePath: '/tmp/hls/stream_0/segment_00110.m4s',
    segExt: 'm4s',
    streamDirName: 'stream_0',
    isVideoTranscoded: false,
    staleProgressMargin: 50,
    seekWaitTimeoutMs: 5000,
    seekPollIntervalMs: 100,
    getSegmentOffset: () => 100,
    getStreamSegmentOffset: () => 100,
    statFile: async () => ({ mtimeMs: 2000 }),
    accessFile: async () => undefined,
    sleep: () => Promise.resolve(),
};

describe('applyStaleSegmentGuard', () => {
    it('leaves normal non-stale files untouched', async () => {
        const result = await applyStaleSegmentGuard(baseOptions);

        expect(result).toEqual({
            fileExists: true,
            actualFilePath: '/tmp/hls/stream_0/segment_00010.m4s',
        });
    });

    it('rejects files far beyond current progress', async () => {
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            actualSegmentIndex: 100,
        });

        expect(result.fileExists).toBe(false);
        expect(result.actualFilePath).toBe('/tmp/hls/stream_0/segment_00010.m4s');
    });

    it('rejects files older than the current FFmpeg spawn time', async () => {
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            statFile: async () => ({ mtimeMs: -9000 }),
        });

        expect(result.fileExists).toBe(false);
    });

    it('rejects files older than the current FFmpeg spawn time even when canSeek is true', async () => {
        // Regression test: canSeek is true for the video/authoritative stream, which
        // previously bypassed the ENTIRE guard (including the mtime freshness check) —
        // meaning a leftover segment file from a prior FFmpeg generation could be served
        // as video content while the manifest/progress bar stayed on the correct position.
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            canSeek: true,
            statFile: async () => ({ mtimeMs: -9000 }),
        });

        expect(result.fileExists).toBe(false);
    });

    it('tolerates mtime slightly before spawn time (clock skew / fs mtime granularity)', async () => {
        // Layer 2 now runs unconditionally, including on canSeek streams that never hit
        // this code path before. Without a tolerance window, coarse filesystem mtime
        // granularity or clock skew between the storage layer and the Node process could
        // make a genuinely fresh segment from a just-spawned generation appear to predate
        // its own job's spawn time, causing spurious rejection. No `previousFFmpegSpawnTime`
        // is set (first spawn), so the gap is treated as infinite and full tolerance applies.
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            canSeek: true,
            statFile: async () => ({ mtimeMs: baseOptions.job.lastFFmpegSpawnTime - 1000 }),
        });

        expect(result.fileExists).toBe(true);
    });

    it('still tolerates mtime slightly before spawn time when the previous generation had a normal head start', async () => {
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            canSeek: true,
            job: { ...job, lastFFmpegSpawnTime: 10_000, previousFFmpegSpawnTime: 0 },
            statFile: async () => ({ mtimeMs: 10_000 - 1000 }),
        });

        expect(result.fileExists).toBe(true);
    });

    it('rejects a leftover segment from the previous generation on a rapid respawn, even within the normal tolerance window', async () => {
        // Regression test: a fixed 2s tolerance window doesn't know WHY a file's mtime
        // sits just before the new spawn time — it could be genuine clock skew on a fresh
        // segment, or it could be a leftover file the OLD FFmpeg process wrote moments
        // before it was killed and respawned. On a rapid respawn (gap smaller than the
        // tolerance) the two are indistinguishable by a fixed window alone, so tolerance
        // must be withheld rather than reintroducing the exact stale-segment bug this
        // guard exists to prevent.
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            canSeek: true,
            job: { ...job, lastFFmpegSpawnTime: 1000, previousFFmpegSpawnTime: 500 },
            statFile: async () => ({ mtimeMs: 900 }), // 100ms before the new spawn
        });

        expect(result.fileExists).toBe(false);
    });

    it('recomputes the file path when the stream offset changes', async () => {
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            getStreamSegmentOffset: () => 105,
        });

        expect(result.response).toBeUndefined();
        expect(result.fileExists).toBe(false);
        expect(result.actualFilePath).toBe('/tmp/hls/stream_0/segment_00005.m4s');
    });

    it('returns a negative-offset response when offset changes past the request', async () => {
        const result = await applyStaleSegmentGuard({
            ...baseOptions,
            getStreamSegmentOffset: () => 120,
        });

        expect(result.response?.status).toBe(404);
        expect(result.response?.headers.get('X-Lumastra-Branch')).toBe('stale_guard_negative');
        expect(result.response?.headers.get('X-Lumastra-Offset')).toBe('120');
        expect(result.response?.headers.get('X-Lumastra-Actual')).toBe('-10');
    });
});
