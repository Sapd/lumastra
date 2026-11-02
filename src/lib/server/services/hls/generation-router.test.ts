// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    RECLAIM_MAX_GAP_SEGMENTS,
    buildSegmentGenerationCandidate,
    resolveHlsGenerationRoute,
    selectSegmentGenerationCandidate,
    type HlsGenerationRouterAdapter,
    type SegmentGenerationCandidate,
} from './generation-router.js';
import type {
    GenerationRoleValue,
    TranscodeJob,
    TranscodeJobConfig,
} from '../transcoding/types.js';

const adapter: HlsGenerationRouterAdapter = {
    getSegmentOffsetForJob: (job) => job.segmentOffset,
    getStreamSegmentOffsetForJob: (job) => job.segmentOffset,
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
        status: 'running',
        startedAt: new Date(),
        lastAccessedAt: new Date(),
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
        streamTargetDurations: new Map(),
        iframeData: [],
        iframeAnalyzedCount: 0,
        iframeAnalysisComplete: false,
        syncTraceLoggedStreams: new Set(),
        endSegmentCache: new Map(),
    } as unknown as TranscodeJob;
}

describe('HLS generation router', () => {
    it('routes to a retained generation only when the translated file exists', async () => {
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/current',
            generationIndex: 2,
            generationRole: 'current',
            segmentOffset: 420,
            segmentsReady: 5,
        });
        const previous = makeJob({
            id: 'previous',
            outputDir: '/tmp/previous',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 0,
            segmentsReady: 120,
        });

        const route = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            normalizedPath: 'stream_0/segment_00099.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            requireRetainedFile: true,
            fileExists: async (filePath) => filePath === '/tmp/previous/stream_0/segment_00099.m4s',
        });

        expect(route?.job.id).toBe('previous');
        expect(route?.reason).toBe('retained-covered');
        expect(route?.filePath).toBe('/tmp/previous/stream_0/segment_00099.m4s');
    });

    it('falls back to current when a retained generation covers by progress but the file is missing', async () => {
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/current',
            generationIndex: 2,
            generationRole: 'current',
            segmentOffset: 420,
            segmentsReady: 5,
        });
        const previous = makeJob({
            id: 'previous',
            outputDir: '/tmp/previous',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 0,
            segmentsReady: 120,
        });

        const route = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            normalizedPath: 'stream_0/segment_00099.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            requireRetainedFile: true,
            fileExists: async () => false,
        });

        expect(route?.job.id).toBe('current');
        expect(route?.reason).toBe('current-retained-file-miss');
        expect(route?.retainedFileMiss?.[0]?.job.id).toBe('previous');
        expect(route?.retainedFileMiss?.[0]?.reason).toBe('missing');
    });

    it('translates retained generation file paths through the stream offset', async () => {
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/current',
            generationIndex: 2,
            generationRole: 'current',
            segmentOffset: 200,
            segmentsReady: 5,
        });
        const previous = makeJob({
            id: 'previous',
            outputDir: '/tmp/previous',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 80,
            segmentsReady: 40,
        });

        const route = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: 'stream_0',
            requestedSegmentNum: 99,
            normalizedPath: 'stream_0/segment_00099.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            requireRetainedFile: true,
            fileExists: async (filePath) => filePath === '/tmp/previous/stream_0/segment_00019.m4s',
        });

        expect(route?.job.id).toBe('previous');
        expect(route?.offset).toBe(80);
        expect(route?.actualIndex).toBe(19);
        expect(route?.filePath).toBe('/tmp/previous/stream_0/segment_00019.m4s');
    });

    it('prefers the current generation over a retained one when both cover the segment', async () => {
        // Regression test: a quality/ABR switch (or any generation handoff) can leave an
        // old ("previous") generation retained while a new ("current") one is already
        // serving the same logical segment range. Both can "cover" the requested segment
        // number, but the old generation's coverage is a leftover, not the live truth —
        // it must never win purely because its numeric offset happens to be higher.
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/current',
            generationIndex: 3,
            generationRole: 'current',
            segmentOffset: 248,
            segmentsReady: 5,
        });
        const previous = makeJob({
            id: 'previous',
            outputDir: '/tmp/previous',
            generationIndex: 2,
            generationRole: 'previous',
            segmentOffset: 249,
            segmentsReady: 10,
        });

        const route = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: '',
            requestedSegmentNum: 249,
            normalizedPath: 'segment_00249.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            fileExists: async () => true,
        });

        expect(route?.job.id).toBe('current');
        expect(route?.reason).toBe('current');
    });

    it('falls back to a covering retained generation while a freshly-spawned current has no segments yet', async () => {
        // This is NOT a bug: it's the documented behavior of a regular seek. See
        // seekToSegment() in ffmpeg-transcode.service.ts — a normal seek promotes a new
        // "current" generation but deliberately KEEPS the old one retained ("those
        // segments are valid playback content for the old position"), specifically so
        // requests landing in this window don't stall waiting for current's first
        // segment. Segment numbers are a global, generation-independent position
        // reference (the whole point of the offset scheme), so a covering retained
        // generation's file is trusted content for that position. Only the
        // audio-track-replacement path (forceRestart) retires retained generations
        // outright, because that one DOES change what "correct" content means for a
        // given segment number.
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/current',
            generationIndex: 3,
            generationRole: 'current',
            segmentOffset: 248,
            segmentsReady: 0, // just spawned by seekToSegment(), no output yet
        });
        const previous = makeJob({
            id: 'previous',
            outputDir: '/tmp/previous',
            generationIndex: 2,
            generationRole: 'previous',
            segmentOffset: 249,
            segmentsReady: 10,
        });

        const route = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: '',
            requestedSegmentNum: 249,
            normalizedPath: 'segment_00249.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            fileExists: async () => true,
        });

        expect(route?.job.id).toBe('previous');
        expect(route?.reason).toBe('retained-covered');
    });

    it('does not treat sibling output directories as inside a retained generation', async () => {
        const current = makeJob({
            id: 'current',
            outputDir: '/tmp/hls/current',
            generationIndex: 2,
            generationRole: 'current',
            segmentOffset: 420,
            segmentsReady: 5,
        });
        const previous = makeJob({
            id: 'previous',
            outputDir: '/tmp/hls/gen-1',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 0,
            segmentsReady: 120,
        });

        const route = await resolveHlsGenerationRoute({
            current,
            retained: [previous],
            streamDir: '..',
            requestedSegmentNum: 99,
            normalizedPath: '../gen-10/stream_0/segment_00099.m4s',
            segmentExtension: 'm4s',
            fallbackSegmentExtension: 'm4s',
            adapter,
            requireRetainedFile: true,
            fileExists: async () => true,
        });

        expect(route?.job.id).toBe('current');
        expect(route?.reason).toBe('current-retained-file-miss');
        expect(route?.retainedFileMiss?.[0]).toMatchObject({
            job: previous,
            reason: 'path_escape',
        });
    });
});

// A Jellyfin client resuming at T (Android TV) requests segment 0 first and then
// jumps to T. The generation already running at T was demoted by that probe and
// parked 'unwatched'; a request back near T must reclaim it instead of seeking a
// third time (prod 2026-10-02: 4K HDR burn-in, ~23 s to resume). A real seek to 0
// keeps requesting near the current generation and must never reclaim.
describe('selectSegmentGenerationCandidate — reclaiming a probe-abandoned generation', () => {
    const base: SegmentGenerationCandidate = {
        jobId: 'x',
        generationIndex: 1,
        generationRole: 'current',
        offset: 0,
        actualIndex: 0,
        progress: 0,
        segmentsReady: 0,
        deleted: false,
        covers: false,
        isCurrent: false,
        status: 'running',
        reclaimable: false,
        requestedSegmentNum: 0,
    };
    const probe = (req: number, over: Partial<SegmentGenerationCandidate> = {}) => ({
        ...base,
        jobId: 'probe',
        generationIndex: 2,
        isCurrent: true,
        offset: 0,
        progress: 2,
        segmentsReady: 2,
        actualIndex: req,
        requestedSegmentNum: req,
        covers: req < 2,
        ...over,
    });
    const parked = (req: number, over: Partial<SegmentGenerationCandidate> = {}) => ({
        ...base,
        jobId: 'resume',
        generationIndex: 1,
        generationRole: 'previous' as const,
        offset: 600,
        progress: 601,
        segmentsReady: 1,
        actualIndex: req,
        requestedSegmentNum: req,
        covers: req >= 600 && req < 601,
        reclaimable: true,
        ...over,
    });

    it('reclaims the parked generation when the client jumps back to its position', () => {
        const pick = selectSegmentGenerationCandidate([probe(602), parked(602)]);
        expect(pick?.reason).toBe('retained-reclaim');
        expect(pick?.candidate.jobId).toBe('resume');
    });

    it('a request it already covers is served from it as before (retained-covered)', () => {
        const pick = selectSegmentGenerationCandidate([probe(600), parked(600)]);
        expect(pick?.reason).toBe('retained-covered');
    });

    it('a real seek to 0 keeps playing the current generation', () => {
        for (const req of [0, 1, 2, 3]) {
            const pick = selectSegmentGenerationCandidate([probe(req), parked(req)]);
            expect(pick?.candidate.jobId).toBe('probe');
        }
    });

    it('never reclaims for a request before its offset or too far past its progress', () => {
        expect(selectSegmentGenerationCandidate([probe(599), parked(599)])?.reason).toBe('current');
        expect(
            selectSegmentGenerationCandidate([
                probe(601 + RECLAIM_MAX_GAP_SEGMENTS + 1),
                parked(607),
            ])?.reason,
        ).toBe('current');
    });

    it('never reclaims a generation that was watched, superseded, or is not running', () => {
        expect(
            selectSegmentGenerationCandidate([probe(602), parked(602, { reclaimable: false })])
                ?.reason,
        ).toBe('current');
        expect(
            selectSegmentGenerationCandidate([probe(602), parked(602, { status: 'stopping' })])
                ?.reason,
        ).toBe('current');
        expect(
            selectSegmentGenerationCandidate([probe(602), parked(602, { deleted: true })])?.reason,
        ).toBe('current');
    });

    it('leaves the request with the current generation when it will reach it on its own', () => {
        // Current produced up to 599: 602 is three segments away — no swap.
        const pick = selectSegmentGenerationCandidate([
            probe(602, { offset: 590, progress: 599, segmentsReady: 9 }),
            parked(602),
        ]);
        expect(pick?.reason).toBe('current');
    });

    it('with no current generation a reclaimable one is still chosen', () => {
        const pick = selectSegmentGenerationCandidate([parked(602)]);
        expect(pick?.reason).toBe('retained-reclaim');
    });
});

describe('buildSegmentGenerationCandidate — only a parked-unwatched job is reclaimable', () => {
    const jobWith = (parked: TranscodeJob['parked']) =>
        ({
            id: 'j',
            generationIndex: 1,
            generationRole: 'previous',
            segmentOffset: 600,
            segmentsReady: 1,
            segmentDurationSeconds: 6,
            status: 'running',
            streamTargetDurations: new Map(),
            deletedUpTo: new Map(),
            transcodeDecisionResult: { videoAction: 'transcode' },
            parked,
        }) as unknown as TranscodeJob;

    it.each([
        ['unwatched', true],
        ['superseded', false],
        [undefined, false],
    ] as const)('parked=%s → reclaimable=%s', (parked, reclaimable) => {
        const candidate = buildSegmentGenerationCandidate(
            jobWith(parked),
            '',
            602,
            'other',
            adapter,
        );
        expect(candidate.reclaimable).toBe(reclaimable);
        expect(candidate.requestedSegmentNum).toBe(602);
    });
});
