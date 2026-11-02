// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resolveHlsGenerationRoute, type HlsGenerationRouterAdapter } from './generation-router.js';
import { selectRetainedGenerationsToKeep } from './generation-coordinator.js';
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
    lastAccessedAt?: Date;
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
        sessionOutputDir: '/tmp/session',
        generationIndex: overrides.generationIndex,
        generationRole: overrides.generationRole,
        process: null,
        status: overrides.status ?? 'running',
        startedAt: new Date(),
        lastAccessedAt: overrides.lastAccessedAt ?? new Date(0),
        lastProgressAt: new Date(),
        masterPlaylistReady: true,
        segmentsReady: overrides.segmentsReady,
        lastServedSegment: new Map(),
        deletedUpTo: overrides.deletedUpTo ?? new Map(),
        segmentOffset: overrides.segmentOffset,
        segmentDurationSeconds: 10,
        isSeeking: false,
        seekCount: 0,
        lastSeekTrigger: '',
        lastFFmpegSpawnTime: Date.now(),
        spawnAttempt: 0,
        streamSegmentOffsets: overrides.streamSegmentOffsets,
        streamTargetDurations: overrides.streamTargetDurations ?? new Map(),
        iframeData: [],
        iframeAnalyzedCount: 0,
        iframeAnalysisComplete: false,
        syncTraceLoggedStreams: new Set(),
        endSegmentCache: new Map(),
    } as unknown as TranscodeJob;
}

describe('HLS generation integration behavior', () => {
    it('routes old-position audio requests to retained generations while current covers the seek target', async () => {
        const previous = makeJob({
            id: 'gen-1',
            outputDir: '/tmp/session/gen-0001',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 0,
            segmentsReady: 180,
        });
        const current = makeJob({
            id: 'gen-2',
            outputDir: '/tmp/session/gen-0002',
            generationIndex: 2,
            generationRole: 'current',
            segmentOffset: 420,
            segmentsReady: 12,
        });

        const staleOldPosition = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            normalizedPath: 'stream_0/segment_00099.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            requireRetainedFile: true,
            fileExists: async (filePath) =>
                filePath === '/tmp/session/gen-0001/stream_0/segment_00099.m4s',
        });

        const seekTarget = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: 'stream_0',
            requestedSegmentNum: 421,
            normalizedPath: 'stream_0/segment_00421.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            requireRetainedFile: true,
            fileExists: async () => false,
        });

        expect(staleOldPosition?.job.id).toBe('gen-1');
        expect(staleOldPosition?.reason).toBe('retained-covered');
        expect(staleOldPosition?.actualIndex).toBe(99);
        expect(seekTarget?.job.id).toBe('gen-2');
        expect(seekTarget?.reason).toBe('current');
        expect(seekTarget?.actualIndex).toBe(1);
    });

    it('keeps the retained generations nearest rapid A-B-A seek anchors and retires the rest deterministically', () => {
        const genAOld = makeJob({
            id: 'gen-a-old',
            outputDir: '/tmp/session/gen-0001',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 80,
            segmentsReady: 40,
            lastAccessedAt: new Date(1000),
        });
        const genB = makeJob({
            id: 'gen-b',
            outputDir: '/tmp/session/gen-0002',
            generationIndex: 2,
            generationRole: 'previous',
            segmentOffset: 520,
            segmentsReady: 20,
            lastAccessedAt: new Date(2000),
        });
        const genARecent = makeJob({
            id: 'gen-a-recent',
            outputDir: '/tmp/session/gen-0003',
            generationIndex: 3,
            generationRole: 'previous',
            segmentOffset: 92,
            segmentsReady: 25,
            lastAccessedAt: new Date(3000),
        });

        const selection = selectRetainedGenerationsToKeep(
            [genAOld, genB, genARecent],
            ['gen-a-old', 'gen-b', 'gen-a-recent'],
            {
                maxRetained: 2,
                anchorSegmentOffset: 90,
                preserveJobIds: ['gen-b'],
            },
        );

        expect([...selection.keepIds]).toEqual(['gen-b', 'gen-a-recent']);
        expect(selection.retireIds).toEqual(['gen-a-old']);
    });

    it('scales stream-specific readiness for demuxed streams with different target durations', async () => {
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/session/gen-0002',
            generationIndex: 2,
            generationRole: 'current',
            segmentOffset: 420,
            segmentsReady: 20,
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

        const videoRoute = await resolveHlsGenerationRoute({
            current,
            retained: [],
            streamDir: 'stream_0',
            requestedSegmentNum: 263,
            normalizedPath: 'stream_0/segment_00263.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
        });
        const audioRoute = await resolveHlsGenerationRoute({
            current,
            retained: [],
            streamDir: 'stream_2',
            requestedSegmentNum: 431,
            normalizedPath: 'stream_2/segment_00431.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
        });

        expect(videoRoute?.candidates[0]).toMatchObject({
            covers: true,
            actualIndex: 11,
            progress: 264,
        });
        expect(audioRoute?.candidates[0]).toMatchObject({
            covers: true,
            actualIndex: 11,
            progress: 440,
        });
    });
});
