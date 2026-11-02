// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { SegmentGenerationRoute } from '../ffmpeg-transcode.service.js';
import type { TranscodeJob } from '../transcoding/types.js';

export interface SegmentLogger {
    debug(message: string, metadata: Record<string, unknown>): void;
    info(message: string, metadata: Record<string, unknown>): void;
    warn(message: string, metadata: Record<string, unknown>): void;
}

export interface LogSegmentTraceOptions {
    logger: SegmentLogger;
    job: TranscodeJob;
    playSessionId: string;
    streamDirName: string;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    globalSegmentOffset: number;
    canSeek: boolean;
    streamTargetDuration: number;
    isVideoTranscoded: boolean;
    segmentGenerationRoute?: SegmentGenerationRoute;
}

export function logSegmentTrace(options: LogSegmentTraceOptions): void {
    if (options.requestedSegmentNum < 0) return;

    const deletedUpToValue = options.job.deletedUpTo.get(options.streamDirName) ?? -1;
    options.logger.debug('seg-trace', {
        ps: options.playSessionId.slice(0, 8),
        stream: options.streamDirName,
        req: options.requestedSegmentNum,
        actual: options.actualSegmentIndex,
        offset: options.segmentOffset,
        globalOffset: options.globalSegmentOffset,
        ready: options.job.segmentsReady,
        canSeek: options.canSeek,
        isSeeking: options.job.isSeeking,
        status: options.job.status,
        generation: options.job.generationIndex,
        generationRole: options.job.generationRole,
        routeReason: options.segmentGenerationRoute?.reason ?? 'unrouted',
        routeCandidates: options.segmentGenerationRoute?.candidates.map((candidate) => ({
            gen: candidate.generationIndex,
            role: candidate.generationRole,
            offset: candidate.offset,
            actual: candidate.actualIndex,
            progress: candidate.progress,
            deleted: candidate.deleted,
            covers: candidate.covers,
            current: candidate.isCurrent,
        })),
        deletedUpTo: deletedUpToValue,
        streamDur: options.streamTargetDuration,
        isTranscode: options.isVideoTranscoded,
    });
}

export interface MaybeLogSyncTraceOptions {
    logger: SegmentLogger;
    job: TranscodeJob;
    playSessionId: string;
    streamDirName: string;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    globalSegmentOffset: number;
    streamTargetDuration: number;
    canSeek: boolean;
}

export function maybeLogSyncTrace(options: MaybeLogSyncTraceOptions): void {
    if (
        options.requestedSegmentNum < 0 ||
        !options.streamDirName ||
        options.job.syncTraceLoggedStreams.has(options.streamDirName) ||
        ((options.job.requestedStartTimeSeconds ?? 0) <= 0 && options.job.seekCount <= 0) ||
        options.actualSegmentIndex < 0 ||
        options.actualSegmentIndex > 2
    ) {
        return;
    }

    const videoStreamDir = `stream_${options.job.config.audioTracks.length}`;
    const streamRole = options.streamDirName === videoStreamDir ? 'video' : 'audio';
    const requestedStartTimeSeconds =
        options.job.requestedStartTimeSeconds ?? options.job.config.startTimeSeconds ?? 0;
    const ffmpegStartTimeSeconds = options.job.config.startTimeSeconds ?? 0;
    const mappedPublicSegment = options.segmentOffset + options.actualSegmentIndex;

    options.logger.info('sync-trace', {
        playSessionId: options.playSessionId,
        generationIndex: options.job.generationIndex,
        origin: options.job.syncTraceOrigin ?? 'origin',
        stream: options.streamDirName,
        streamRole,
        requestedStartTimeSeconds,
        ffmpegStartTimeSeconds,
        startDeltaSeconds: ffmpegStartTimeSeconds - requestedStartTimeSeconds,
        requestedSegment: options.requestedSegmentNum,
        actualSegmentIndex: options.actualSegmentIndex,
        streamOffset: options.segmentOffset,
        globalOffset: options.globalSegmentOffset,
        mappedPublicSegment,
        requestedSegmentStartSeconds: options.requestedSegmentNum * options.streamTargetDuration,
        mappedSegmentStartSeconds: mappedPublicSegment * options.streamTargetDuration,
        streamTargetDuration: options.streamTargetDuration,
        canSeek: options.canSeek,
        seekCount: options.job.seekCount,
        lastSeekTrigger: options.job.lastSeekTrigger,
        videoAction: options.job.transcodeDecisionResult?.videoAction,
        audioAction: options.job.transcodeDecisionResult?.audioAction,
    });
    options.job.syncTraceLoggedStreams.add(options.streamDirName);
}

export interface MaybeLogStaleAudioRequestOptions {
    logger: SegmentLogger;
    job: TranscodeJob;
    playSessionId: string;
    streamDirName: string;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    currentProgressForDiagnostics: number;
    canSeek: boolean;
    staleAudioRequestAheadThreshold: number;
    shouldLogWarning: (
        playSessionId: string,
        streamDirName: string,
        requestedSegmentNum: number,
        segmentOffset: number,
    ) => boolean;
}

export function maybeLogStaleAudioRequest(options: MaybeLogStaleAudioRequestOptions): void {
    if (
        options.requestedSegmentNum < 0 ||
        options.canSeek ||
        options.job.generationRole !== 'current' ||
        options.job.seekCount <= 0 ||
        options.actualSegmentIndex < 0 ||
        options.requestedSegmentNum - options.segmentOffset <
            options.staleAudioRequestAheadThreshold ||
        options.requestedSegmentNum - options.currentProgressForDiagnostics <
            options.staleAudioRequestAheadThreshold ||
        !options.shouldLogWarning(
            options.playSessionId,
            options.streamDirName,
            options.requestedSegmentNum,
            options.segmentOffset,
        )
    ) {
        return;
    }

    options.logger.warn('Suspected stale hls.js audio request after seek', {
        playSessionId: options.playSessionId,
        stream: options.streamDirName,
        requestedSegment: options.requestedSegmentNum,
        actualSegmentIndex: options.actualSegmentIndex,
        segmentOffset: options.segmentOffset,
        currentProgress: options.currentProgressForDiagnostics,
        aheadOfOffset: options.requestedSegmentNum - options.segmentOffset,
        aheadOfProgress: options.requestedSegmentNum - options.currentProgressForDiagnostics,
        seekCount: options.job.seekCount,
        lastSeekTrigger: options.job.lastSeekTrigger,
        generationIndex: options.job.generationIndex,
    });
}
