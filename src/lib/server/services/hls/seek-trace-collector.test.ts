// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import {
    classifyHlsSegmentRequest,
    clearHlsSeekTraceCollectorForTests,
    recordHlsSeekTraceRequest,
    recordHlsSeekTraceServed,
} from './seek-trace-collector.js';
import type { SegmentLogger } from './segment-diagnostics.js';
import type { TranscodeJob } from '../transcoding/types.js';

function createLogger(): SegmentLogger & {
    debugCalls: Array<{ message: string; metadata: Record<string, unknown> }>;
    infoCalls: Array<{ message: string; metadata: Record<string, unknown> }>;
    warnCalls: Array<{ message: string; metadata: Record<string, unknown> }>;
} {
    const debugCalls: Array<{
        message: string;
        metadata: Record<string, unknown>;
    }> = [];
    const infoCalls: Array<{
        message: string;
        metadata: Record<string, unknown>;
    }> = [];
    const warnCalls: Array<{
        message: string;
        metadata: Record<string, unknown>;
    }> = [];
    return {
        debugCalls,
        infoCalls,
        warnCalls,
        debug: (message, metadata) => debugCalls.push({ message, metadata }),
        info: (message, metadata) => infoCalls.push({ message, metadata }),
        warn: (message, metadata) => warnCalls.push({ message, metadata }),
    };
}

function createJob(): TranscodeJob {
    return {
        id: 'job',
        config: {
            audioTracks: [{ index: 0 }],
            startTimeSeconds: 100,
        },
        generationIndex: 2,
        generationRole: 'current',
        seekCount: 1,
        lastSeekTrigger: 'forward:stream_1:seg42',
        requestedStartTimeSeconds: 100,
        segmentOffset: 42,
    } as TranscodeJob;
}

describe('HLS seek trace collector', () => {
    afterEach(() => {
        clearHlsSeekTraceCollectorForTests();
    });

    it('classifies known fragile request patterns', () => {
        expect(
            classifyHlsSegmentRequest({
                isTailProbe: true,
                isStaleGhostAudio: true,
                hasRetainedMiss: true,
                routeReason: 'current-retained-file-miss',
                willWaitForCurrent: true,
                isRepeatedSegmentPressure: true,
                isMissing404: true,
            }),
        ).toEqual([
            'tail_probe',
            'stale_ghost_audio',
            'retained_miss',
            'generation_route_fallback',
            'current_catchup_wait',
            'repeated_404_pressure',
            'missing_404',
        ]);
    });

    it('emits one compact seek trace after first audio and video segment are served', () => {
        const logger = createLogger();
        const job = createJob();

        recordHlsSeekTraceRequest({
            logger,
            job,
            playSessionId: 'play-session',
            streamDirName: 'stream_0',
            requestedSegmentNum: 44,
            actualSegmentIndex: 2,
            segmentOffset: 42,
            classifiers: ['current_catchup_wait'],
            now: 1000,
        });
        recordHlsSeekTraceServed({
            logger,
            job,
            playSessionId: 'play-session',
            streamDirName: 'stream_0',
            requestedSegmentNum: 44,
            actualSegmentIndex: 2,
            segmentOffset: 42,
            waitMs: 900,
            now: 1500,
        });
        recordHlsSeekTraceServed({
            logger,
            job,
            playSessionId: 'play-session',
            streamDirName: 'stream_1',
            requestedSegmentNum: 43,
            actualSegmentIndex: 1,
            segmentOffset: 42,
            waitMs: 1200,
            now: 1700,
        });

        expect(logger.warnCalls[0]).toMatchObject({
            message: 'hls-segment-classifier',
            metadata: {
                classifier: 'current_catchup_wait',
                trigger: 'forward:stream_1:seg42',
            },
        });
        expect(logger.infoCalls).toHaveLength(1);
        expect(logger.infoCalls[0]).toMatchObject({
            message: 'hls-seek-trace',
            metadata: {
                generationIndex: 2,
                seekCount: 1,
                triggerStream: 'stream_1',
                triggerSegment: 42,
                maxWaitMs: 1200,
                classifierCounts: {
                    current_catchup_wait: 1,
                },
            },
        });
    });
});

it('records normal tail requests at debug while retaining missing-segment warnings', () => {
    const logger = createLogger();
    recordHlsSeekTraceRequest({
        logger,
        job: createJob(),
        playSessionId: 'tail-session',
        streamDirName: 'stream_0',
        requestedSegmentNum: 99,
        actualSegmentIndex: 57,
        segmentOffset: 42,
        classifiers: ['tail_probe', 'missing_404'],
        now: 1000,
    });
    expect(logger.warnCalls.map((call) => call.metadata.classifier)).toEqual(['missing_404']);
    expect(logger.debugCalls).toContainEqual({
        message: 'hls-segment-classifier',
        metadata: expect.objectContaining({ classifier: 'tail_probe' }),
    });
});
