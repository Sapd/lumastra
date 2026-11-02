// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as path from 'path';
import type { GenerationRoleValue, TranscodeJob } from '../transcoding/types.js';
import { isDistinctStreamDuration } from '../../utils/hls-stream-duration.js';
import {
    getSegmentFilename,
    translateToActualIndex,
    isPathInsideDirectory,
} from '../../utils/hls-segment-utils.js';

export interface SegmentGenerationCandidate {
    jobId: string;
    generationIndex: number;
    generationRole: GenerationRoleValue;
    offset: number;
    actualIndex: number;
    progress: number;
    segmentsReady: number;
    deleted: boolean;
    covers: boolean;
    isCurrent: boolean;
    status: TranscodeJob['status'];
    /** A parked-unwatched retained generation (see TranscodeJob.parked). */
    reclaimable: boolean;
    requestedSegmentNum: number;
}

export type SegmentGenerationRouteReason =
    | 'current'
    | 'retained-covered'
    | 'current-retained-file-miss'
    | 'retained-fallback-no-current'
    | 'retained-reclaim';

/**
 * How far past a parked-unwatched generation's progress a request may land and
 * still reclaim it. Well under the forward-seek threshold (15), so the reclaimed
 * generation waits for the segment instead of seeking again.
 */
export const RECLAIM_MAX_GAP_SEGMENTS = 5;

export interface SegmentGenerationRoute {
    job: TranscodeJob;
    reason: SegmentGenerationRouteReason;
    candidates: SegmentGenerationCandidate[];
    filePath?: string;
    actualIndex?: number;
    offset?: number;
    retainedFileMiss?: SegmentGenerationFileMiss[];
}

export interface SegmentGenerationCandidateSelection {
    candidate: SegmentGenerationCandidate;
    reason: SegmentGenerationRouteReason;
}

export interface SegmentGenerationFileMiss {
    job: TranscodeJob;
    filePath: string;
    offset: number;
    actualIndex: number;
    reason: 'missing' | 'path_escape';
}

export interface HlsGenerationRouterAdapter {
    getSegmentOffsetForJob(job: TranscodeJob): number;
    getStreamSegmentOffsetForJob(job: TranscodeJob, streamDir: string): number;
    getStreamTargetDurationForJob(job: TranscodeJob, streamDir: string): number | undefined;
    isSegmentDeletedForJob(job: TranscodeJob, streamDir: string, segmentIndex: number): boolean;
}

export interface HlsGenerationRouteRequest {
    current?: TranscodeJob;
    retained: TranscodeJob[];
    streamDir: string;
    requestedSegmentNum: number;
    normalizedPath: string;
    segmentExtension: string;
    fallbackSegmentExtension: string;
    adapter: HlsGenerationRouterAdapter;
    excludeJobIds?: Iterable<string>;
    requireRetainedFile?: boolean;
    fileExists?: (filePath: string) => Promise<boolean>;
}

export function selectSegmentGenerationCandidate(
    candidates: SegmentGenerationCandidate[],
): SegmentGenerationCandidateSelection | undefined {
    if (candidates.length === 0) return undefined;

    const covered = candidates
        .filter((candidate) => candidate.covers)
        .sort((a, b) => {
            // The live/current generation reflects the up-to-date FFmpeg state; a
            // retained (previous) generation covering the same segment is a leftover
            // from a handoff (seek, ABR switch, restart) and must never win purely
            // because its numeric offset is higher.
            if (a.isCurrent !== b.isCurrent) return Number(b.isCurrent) - Number(a.isCurrent);
            if (a.offset !== b.offset) return b.offset - a.offset;
            return b.generationIndex - a.generationIndex;
        });

    if (covered[0]) {
        return {
            candidate: covered[0],
            reason: covered[0].isCurrent ? 'current' : 'retained-covered',
        };
    }

    const current = candidates.find((candidate) => candidate.isCurrent);

    // Reclaim a generation a probe abandoned (TranscodeJob.parked 'unwatched'):
    // the request lands at or just past its production while the current
    // generation could only reach it by seeking. A real seek to the probe's
    // position keeps requesting near the current generation and never gets here.
    const reclaim = candidates
        .filter(
            (candidate) =>
                candidate.reclaimable &&
                !candidate.isCurrent &&
                candidate.actualIndex >= 0 &&
                !candidate.deleted &&
                (candidate.status === 'running' || candidate.status === 'ready') &&
                candidate.offset <= candidate.requestedSegmentNum &&
                candidate.requestedSegmentNum - candidate.progress <= RECLAIM_MAX_GAP_SEGMENTS,
        )
        .sort((a, b) => b.offset - a.offset)[0];
    if (
        reclaim &&
        (!current ||
            reclaim.requestedSegmentNum < current.offset ||
            reclaim.requestedSegmentNum - current.progress > RECLAIM_MAX_GAP_SEGMENTS)
    ) {
        return { candidate: reclaim, reason: 'retained-reclaim' };
    }

    if (current) {
        return {
            candidate: current,
            reason: 'current',
        };
    }

    return {
        candidate: candidates[0],
        reason: 'retained-fallback-no-current',
    };
}

export function getStreamSegmentsReadyForJob(
    job: TranscodeJob,
    streamDir: string,
    adapter: HlsGenerationRouterAdapter,
): number {
    const streamTargetDuration = adapter.getStreamTargetDurationForJob(job, streamDir);
    if (!isDistinctStreamDuration(streamTargetDuration, job.segmentDurationSeconds)) {
        return job.segmentsReady;
    }

    return Math.floor((job.segmentsReady * job.segmentDurationSeconds) / streamTargetDuration!);
}

export function buildSegmentGenerationCandidate(
    job: TranscodeJob,
    streamDir: string,
    requestedSegmentNum: number,
    currentJobId: string | undefined,
    adapter: HlsGenerationRouterAdapter,
): SegmentGenerationCandidate {
    const offset = adapter.getStreamSegmentOffsetForJob(job, streamDir);
    const isVideoTranscoded = job.transcodeDecisionResult?.videoAction === 'transcode';
    const actualIndex = isVideoTranscoded ? requestedSegmentNum : requestedSegmentNum - offset;
    const segmentsReady = getStreamSegmentsReadyForJob(job, streamDir, adapter);
    const progress = offset + segmentsReady;
    const deleted = actualIndex >= 0 && adapter.isSegmentDeletedForJob(job, streamDir, actualIndex);
    const isActiveEnough = job.status !== 'error' && job.status !== 'stopping';

    return {
        jobId: job.id,
        generationIndex: job.generationIndex,
        generationRole: job.generationRole,
        offset,
        actualIndex,
        progress,
        segmentsReady,
        deleted,
        covers:
            isActiveEnough &&
            requestedSegmentNum >= offset &&
            requestedSegmentNum < progress &&
            actualIndex >= 0 &&
            !deleted,
        isCurrent: job.id === currentJobId,
        status: job.status,
        reclaimable: job.parked === 'unwatched',
        requestedSegmentNum,
    };
}

export function resolveSegmentFilePathForJob(
    job: TranscodeJob,
    request: Pick<
        HlsGenerationRouteRequest,
        | 'streamDir'
        | 'requestedSegmentNum'
        | 'normalizedPath'
        | 'segmentExtension'
        | 'fallbackSegmentExtension'
        | 'adapter'
    >,
): { filePath: string; offset: number; actualIndex: number } {
    const isVideoTranscoded = job.transcodeDecisionResult?.videoAction === 'transcode';
    const offset = isVideoTranscoded
        ? request.adapter.getSegmentOffsetForJob(job)
        : request.adapter.getStreamSegmentOffsetForJob(job, request.streamDir);
    const actualIndex = isVideoTranscoded
        ? request.requestedSegmentNum
        : translateToActualIndex(request.requestedSegmentNum, offset);

    if (actualIndex >= 0 && offset > 0) {
        return {
            filePath: path.join(
                job.outputDir,
                path.dirname(request.normalizedPath),
                getSegmentFilename(
                    actualIndex,
                    request.segmentExtension || request.fallbackSegmentExtension,
                ),
            ),
            offset,
            actualIndex,
        };
    }

    return {
        filePath: path.join(job.outputDir, request.normalizedPath),
        offset,
        actualIndex,
    };
}

export async function resolveHlsGenerationRoute(
    request: HlsGenerationRouteRequest,
): Promise<SegmentGenerationRoute | undefined> {
    const excluded = new Set(request.excludeJobIds ?? []);
    const retainedFileMiss: SegmentGenerationFileMiss[] = [];

    while (true) {
        const candidates = [
            ...(request.current ? [request.current] : []),
            ...request.retained,
        ].filter((job) => !excluded.has(job.id));
        if (candidates.length === 0) return undefined;

        const currentJobId = request.current?.id;
        const routeCandidates = candidates.map((job) =>
            buildSegmentGenerationCandidate(
                job,
                request.streamDir,
                request.requestedSegmentNum,
                currentJobId,
                request.adapter,
            ),
        );

        const selection = selectSegmentGenerationCandidate(routeCandidates);
        if (!selection) return undefined;

        const selectedJob = candidates.find((job) => job.id === selection.candidate.jobId);
        if (!selectedJob) return undefined;

        const file = resolveSegmentFilePathForJob(selectedJob, request);
        let reason = selection.reason;

        if (request.requireRetainedFile && reason === 'retained-covered' && request.fileExists) {
            if (!isPathInsideDirectory(file.filePath, selectedJob.outputDir)) {
                retainedFileMiss.push({
                    job: selectedJob,
                    filePath: file.filePath,
                    offset: file.offset,
                    actualIndex: file.actualIndex,
                    reason: 'path_escape',
                });
                excluded.add(selectedJob.id);
                continue;
            }

            if (!(await request.fileExists(file.filePath))) {
                retainedFileMiss.push({
                    job: selectedJob,
                    filePath: file.filePath,
                    offset: file.offset,
                    actualIndex: file.actualIndex,
                    reason: 'missing',
                });
                excluded.add(selectedJob.id);
                continue;
            }

            // Touch lastAccessedAt on the retained job to prevent the cleanup
            // timer from retiring it between this fileExists check and the
            // subsequent readFile in the segment handler (TOCTOU mitigation).
            selectedJob.lastAccessedAt = new Date();
        }

        if (retainedFileMiss.length > 0 && reason === 'current') {
            reason = 'current-retained-file-miss';
        }

        return {
            job: selectedJob,
            reason,
            candidates: routeCandidates,
            filePath: file.filePath,
            actualIndex: file.actualIndex,
            offset: file.offset,
            retainedFileMiss: retainedFileMiss.length > 0 ? retainedFileMiss : undefined,
        };
    }
}
