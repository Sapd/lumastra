// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    logSegmentTrace,
    maybeLogStaleAudioRequest,
    maybeLogSyncTrace,
    type SegmentLogger,
} from './segment-diagnostics.js';
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
        segmentsReady: 10,
        isSeeking: false,
        status: 'running',
        generationIndex: 2,
        generationRole: 'current',
        deletedUpTo: new Map([['stream_0', 3]]),
        syncTraceLoggedStreams: new Set(),
        requestedStartTimeSeconds: 90,
        seekCount: 1,
        lastSeekTrigger: 'forward:stream_1:seg10',
        transcodeDecisionResult: {
            videoAction: 'copy',
            audioAction: 'transcode',
        },
    } as TranscodeJob;
}

describe('hls segment diagnostics', () => {
    it('logs segment trace metadata', () => {
        const logger = createLogger();

        logSegmentTrace({
            logger,
            job: createJob(),
            playSessionId: 'play-session',
            streamDirName: 'stream_0',
            requestedSegmentNum: 10,
            actualSegmentIndex: 2,
            segmentOffset: 8,
            globalSegmentOffset: 8,
            canSeek: false,
            streamTargetDuration: 6,
            isVideoTranscoded: false,
        });

        expect(logger.debugCalls).toHaveLength(1);
        expect(logger.debugCalls[0]?.message).toBe('seg-trace');
        expect(logger.debugCalls[0]?.metadata).toMatchObject({
            ps: 'play-ses',
            stream: 'stream_0',
            req: 10,
            deletedUpTo: 3,
        });
    });

    it('logs sync trace once per stream', () => {
        const logger = createLogger();
        const job = createJob();
        const options = {
            logger,
            job,
            playSessionId: 'play',
            streamDirName: 'stream_1',
            requestedSegmentNum: 10,
            actualSegmentIndex: 1,
            segmentOffset: 9,
            globalSegmentOffset: 9,
            streamTargetDuration: 10,
            canSeek: true,
        };

        maybeLogSyncTrace(options);
        maybeLogSyncTrace(options);

        expect(logger.infoCalls).toHaveLength(1);
        expect(logger.infoCalls[0]?.message).toBe('sync-trace');
        expect(logger.infoCalls[0]?.metadata).toMatchObject({
            streamRole: 'video',
            mappedPublicSegment: 10,
            startDeltaSeconds: 10,
        });
    });

    it('logs stale audio warnings when threshold and cooldown allow it', () => {
        const logger = createLogger();

        maybeLogStaleAudioRequest({
            logger,
            job: createJob(),
            playSessionId: 'play',
            streamDirName: 'stream_0',
            requestedSegmentNum: 300,
            actualSegmentIndex: 200,
            segmentOffset: 100,
            currentProgressForDiagnostics: 120,
            canSeek: false,
            staleAudioRequestAheadThreshold: 150,
            shouldLogWarning: () => true,
        });

        expect(logger.warnCalls).toHaveLength(1);
        expect(logger.warnCalls[0]?.message).toBe(
            'Suspected stale hls.js audio request after seek',
        );
        expect(logger.warnCalls[0]?.metadata).toMatchObject({
            aheadOfOffset: 200,
            aheadOfProgress: 180,
        });
    });
});
