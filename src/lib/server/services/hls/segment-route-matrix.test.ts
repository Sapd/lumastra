// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resolveHlsGenerationRoute, type HlsGenerationRouterAdapter } from './generation-router.js';
import type {
    GenerationRoleValue,
    TranscodeJob,
    TranscodeJobConfig,
} from '../transcoding/types.js';

const adapter: HlsGenerationRouterAdapter = {
    getSegmentOffsetForJob: (job) => job.segmentOffset,
    getStreamSegmentOffsetForJob: (job, streamDir) =>
        job.streamSegmentOffsets?.get(streamDir) ?? job.segmentOffset,
    getStreamTargetDurationForJob: (job, streamDir) => job.streamTargetDurations.get(streamDir),
    isSegmentDeletedForJob: (job, streamDir, segmentIndex) =>
        segmentIndex <= (job.deletedUpTo.get(streamDir) ?? -1),
};

function makeJob(overrides: {
    id: string;
    outputDir: string;
    generationIndex: number;
    generationRole: GenerationRoleValue;
    segmentOffset: number;
    segmentsReady: number;
    status?: TranscodeJob['status'];
    streamSegmentOffsets?: Map<string, number>;
    streamTargetDurations?: Map<string, number>;
    deletedUpTo?: Map<string, number>;
}): TranscodeJob {
    const config: TranscodeJobConfig = {
        itemId: 'item',
        username: 'user',
        deviceId: 'device',
        playSessionId: 'play',
        inputUrl: 'file:///movie.mkv',
        audioTracks: [],
    };

    return {
        id: overrides.id,
        config,
        outputDir: overrides.outputDir,
        generationIndex: overrides.generationIndex,
        generationRole: overrides.generationRole,
        process: null,
        status: overrides.status ?? 'running',
        segmentsReady: overrides.segmentsReady,
        segmentOffset: overrides.segmentOffset,
        segmentDurationSeconds: 10,
        streamSegmentOffsets: overrides.streamSegmentOffsets,
        streamTargetDurations: overrides.streamTargetDurations ?? new Map(),
        deletedUpTo: overrides.deletedUpTo ?? new Map(),
    } as TranscodeJob;
}

describe('HLS segment route simulation matrix', () => {
    const current = makeJob({
        id: 'current',
        outputDir: '/tmp/session/gen-0003',
        generationIndex: 3,
        generationRole: 'current',
        segmentOffset: 420,
        segmentsReady: 8,
        streamSegmentOffsets: new Map([
            ['stream_0', 252],
            ['stream_2', 420],
        ]),
        streamTargetDurations: new Map([
            ['stream_0', 10],
            ['stream_2', 6],
        ]),
    });
    current.segmentDurationSeconds = 6;

    const previousA = makeJob({
        id: 'previous-a',
        outputDir: '/tmp/session/gen-0001',
        generationIndex: 1,
        generationRole: 'previous',
        segmentOffset: 0,
        segmentsReady: 140,
    });
    const previousB = makeJob({
        id: 'previous-b',
        outputDir: '/tmp/session/gen-0002',
        generationIndex: 2,
        generationRole: 'previous',
        segmentOffset: 90,
        segmentsReady: 35,
    });

    const cases: Array<{
        name: string;
        streamDir: string;
        requestedSegmentNum: number;
        retained: TranscodeJob[];
        existingFiles: string[];
        expectedJobId: string;
        expectedReason: string;
        expectedActualIndex?: number;
    }> = [
        {
            name: 'forward seek target uses current video generation',
            streamDir: 'stream_0',
            requestedSegmentNum: 254,
            retained: [previousA, previousB],
            existingFiles: [],
            expectedJobId: 'current',
            expectedReason: 'current',
            expectedActualIndex: 2,
        },
        {
            name: 'audio-first seek target uses current audio generation',
            streamDir: 'stream_2',
            requestedSegmentNum: 422,
            retained: [previousA, previousB],
            existingFiles: [],
            expectedJobId: 'current',
            expectedReason: 'current',
            expectedActualIndex: 2,
        },
        {
            name: 'backward A-B-A request routes to retained generation with file',
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            retained: [previousA, previousB],
            existingFiles: ['/tmp/session/gen-0002/stream_0/segment_00009.m4s'],
            expectedJobId: 'previous-b',
            expectedReason: 'retained-covered',
            expectedActualIndex: 9,
        },
        {
            name: 'retained missing file falls back to current',
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            retained: [previousA, previousB],
            existingFiles: [],
            expectedJobId: 'current',
            expectedReason: 'current-retained-file-miss',
        },
        {
            name: 'deleted retained segment is ignored',
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            retained: [
                makeJob({
                    id: 'previous-deleted',
                    outputDir: '/tmp/session/gen-0004',
                    generationIndex: 4,
                    generationRole: 'previous',
                    segmentOffset: 90,
                    segmentsReady: 35,
                    deletedUpTo: new Map([['stream_0', 12]]),
                }),
            ],
            existingFiles: ['/tmp/session/gen-0004/stream_0/segment_00009.m4s'],
            expectedJobId: 'current',
            expectedReason: 'current',
        },
    ];

    it.each(cases)(
        '$name',
        async ({
            streamDir,
            requestedSegmentNum,
            retained,
            existingFiles,
            expectedJobId,
            expectedReason,
            expectedActualIndex,
        }) => {
            const route = await resolveHlsGenerationRoute({
                current,
                retained,
                streamDir,
                requestedSegmentNum,
                normalizedPath: `${streamDir}/segment_${requestedSegmentNum
                    .toString()
                    .padStart(5, '0')}.m4s`,
                segmentExtension: 'm4s',
                fallbackSegmentExtension: 'm4s',
                adapter,
                requireRetainedFile: true,
                fileExists: async (filePath) => existingFiles.includes(filePath),
            });

            expect(route?.job.id).toBe(expectedJobId);
            expect(route?.reason).toBe(expectedReason);
            if (expectedActualIndex !== undefined) {
                expect(route?.actualIndex).toBe(expectedActualIndex);
            }
        },
    );
});
