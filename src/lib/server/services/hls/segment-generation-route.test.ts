// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resolveHlsSegmentGenerationRoute } from './segment-generation-route.js';
import type { SegmentGenerationRoute } from '../ffmpeg-transcode.service.js';
import type { TranscodeJob } from '../transcoding/types.js';

function createJob(id: string, outputDir: string): TranscodeJob {
    return {
        id,
        outputDir,
    } as TranscodeJob;
}

describe('resolveHlsSegmentGenerationRoute', () => {
    it('does nothing for non-segment requests', async () => {
        const job = createJob('current', '/tmp/current');
        let called = false;

        const result = await resolveHlsSegmentGenerationRoute({
            job,
            playSessionId: 'play',
            normalizedPath: 'master.m3u8',
            filePath: '/tmp/current/master.m3u8',
            isSegment: false,
            segmentInfo: null,
            requestedSegmentNum: -1,
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            corsHeaders: {},
            transcodeService: {
                resolveSegmentRoute: async () => {
                    called = true;
                    return undefined;
                },
            },
            accessFile: async () => undefined,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        expect(result.job).toBe(job);
        expect(result.filePath).toBe('/tmp/current/master.m3u8');
        expect(called).toBe(false);
    });

    it('reroutes to the selected generation job', async () => {
        const current = createJob('current', '/tmp/current');
        const retained = createJob('retained', '/tmp/retained');
        const route = {
            job: retained,
            reason: 'retained-covered',
            candidates: [],
        } as SegmentGenerationRoute;

        const result = await resolveHlsSegmentGenerationRoute({
            job: current,
            playSessionId: 'play',
            normalizedPath: 'stream_0/segment_00010.m4s',
            filePath: '/tmp/current/stream_0/segment_00010.m4s',
            isSegment: true,
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 10,
            },
            requestedSegmentNum: 10,
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            corsHeaders: {},
            transcodeService: {
                resolveSegmentRoute: async () => route,
            },
            accessFile: async () => undefined,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        expect(result.job).toBe(retained);
        expect(result.filePath).toBe('/tmp/retained/stream_0/segment_00010.m4s');
        expect(result.segmentGenerationRoute).toBe(route);
    });

    it('logs retained file misses', async () => {
        const current = createJob('current', '/tmp/current');
        const retained = createJob('retained', '/tmp/retained');
        const infoLogs: Record<string, unknown>[] = [];
        const warnLogs: Record<string, unknown>[] = [];

        await resolveHlsSegmentGenerationRoute({
            job: current,
            playSessionId: 'play-session',
            normalizedPath: 'stream_0/segment_00010.m4s',
            filePath: '/tmp/current/stream_0/segment_00010.m4s',
            isSegment: true,
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 10,
            },
            requestedSegmentNum: 10,
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            corsHeaders: {},
            transcodeService: {
                resolveSegmentRoute: async () =>
                    ({
                        job: current,
                        reason: 'current-retained-file-miss',
                        candidates: [],
                        retainedFileMiss: [
                            {
                                job: retained,
                                filePath: '/tmp/retained/x',
                                offset: 5,
                                actualIndex: 5,
                                reason: 'missing',
                            },
                            {
                                job: retained,
                                filePath: '/escape',
                                offset: 5,
                                actualIndex: 5,
                                reason: 'path_escape',
                            },
                        ],
                    }) as SegmentGenerationRoute,
            },
            accessFile: async () => undefined,
            logInfo: (_message, metadata) => {
                infoLogs.push(metadata);
            },
            logWarn: (_message, metadata) => {
                warnLogs.push(metadata);
            },
        });

        expect(infoLogs[0]).toMatchObject({
            ps: 'play-ses',
            stream: 'stream_0',
            req: 10,
            actual: 5,
        });
        expect(warnLogs[0]).toMatchObject({
            filePath: '/escape',
            outputDir: '/tmp/retained',
        });
    });

    it('returns invalid path responses when rerouted output escapes', async () => {
        const current = createJob('current', '/tmp/current');
        const retained = createJob('retained', '/tmp/retained-base');

        const result = await resolveHlsSegmentGenerationRoute({
            job: current,
            playSessionId: 'play',
            normalizedPath: '../segment_00010.m4s',
            filePath: '/tmp/current/segment_00010.m4s',
            isSegment: true,
            segmentInfo: {
                streamDir: 'stream_0',
                segmentIndex: 10,
            },
            requestedSegmentNum: 10,
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            corsHeaders: {
                'Access-Control-Allow-Origin': '*',
            },
            transcodeService: {
                resolveSegmentRoute: async () =>
                    ({
                        job: retained,
                        reason: 'retained-covered',
                        candidates: [],
                    }) as SegmentGenerationRoute,
            },
            accessFile: async () => undefined,
            logInfo: () => undefined,
            logWarn: () => undefined,
        });

        expect(result.response?.status).toBe(400);
        await expect(result.response?.text()).resolves.toBe('Invalid path');
    });
});
