// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { translateToActualIndex, type SegmentInfo } from '../../utils/hls-segment-utils.js';
import type { TranscodeJob } from '../transcoding/types.js';

export interface HlsSegmentRequestStateAdapter {
    getSegmentOffsetForJob(job: TranscodeJob): number;
    getStreamSegmentOffsetForJob(job: TranscodeJob, streamDirName: string): number;
    getStreamTargetDurationForJob(job: TranscodeJob, streamDirName: string): number | undefined;
    canStreamTriggerSeekForJob(job: TranscodeJob, streamDirName: string): boolean;
    isSegmentDeletedForJob(
        job: TranscodeJob,
        streamDirName: string,
        actualSegmentIndex: number,
    ): boolean;
}

export interface BuildHlsSegmentRequestStateOptions {
    job: TranscodeJob;
    segmentInfo: SegmentInfo | null;
    isSegment: boolean;
    requestedSegmentNum: number;
    adapter: HlsSegmentRequestStateAdapter;
}

export interface HlsSegmentRequestState {
    globalSegmentOffset: number;
    streamDirName: string;
    isVideoTranscoded: boolean;
    segmentOffset: number;
    actualSegmentIndex: number;
    segmentWasDeleted: boolean;
    jobSegmentDuration: number;
    streamTargetDuration: number;
    canSeek: boolean;
    streamReadyForDiagnostics: number;
    currentProgressForDiagnostics: number;
}

export function buildHlsSegmentRequestState(
    options: BuildHlsSegmentRequestStateOptions,
): HlsSegmentRequestState {
    const { job, segmentInfo, isSegment, requestedSegmentNum, adapter } = options;
    const globalSegmentOffset = adapter.getSegmentOffsetForJob(job);
    const streamDirName = segmentInfo?.streamDir ?? '';
    const plan = job.config?.effectivePlan;
    // A legacy audio-only job without a decision uses relative filenames,
    // despite its uniform public timeline. Explicit decisions keep the normal
    // audio-only reconciliation to absolute transcode numbering.
    const isVideoTranscoded = plan
        ? plan.video.action === 'drop'
            ? plan.decision?.videoAction === 'transcode'
            : plan.grid === 'uniform'
        : job.transcodeDecisionResult?.videoAction === 'transcode';

    // In transcode mode, segmentOffset is used for seek detection only,
    // not for file path translation because files match manifest indices.
    // In remux/copy mode, per-stream offset handles dual-duration mapping.
    // Always use getStreamSegmentOffsetForJob for copy-mode video — even in
    // muxed mode where streamDirName is '' (falsy). The stream-specific offset
    // accounts for keyframe alignment, while job.segmentOffset is the raw
    // audio-based target that diverges after alignToKeyframeSegmentStart.
    const segmentOffset = isVideoTranscoded
        ? globalSegmentOffset
        : adapter.getStreamSegmentOffsetForJob(job, streamDirName);

    const actualSegmentIndex = isVideoTranscoded
        ? requestedSegmentNum
        : translateToActualIndex(requestedSegmentNum, segmentOffset);

    const segmentWasDeleted =
        segmentInfo && isSegment && actualSegmentIndex >= 0
            ? adapter.isSegmentDeletedForJob(job, segmentInfo.streamDir, actualSegmentIndex)
            : false;

    const jobSegmentDuration = job.segmentDurationSeconds;
    const streamTargetDuration = streamDirName
        ? (adapter.getStreamTargetDurationForJob(job, streamDirName) ?? jobSegmentDuration)
        : jobSegmentDuration;
    const canSeek = adapter.canStreamTriggerSeekForJob(job, streamDirName);
    const streamReadyForDiagnostics =
        streamTargetDuration !== jobSegmentDuration
            ? Math.floor((job.segmentsReady * jobSegmentDuration) / streamTargetDuration)
            : job.segmentsReady;
    const currentProgressForDiagnostics = streamReadyForDiagnostics + segmentOffset;

    return {
        globalSegmentOffset,
        streamDirName,
        isVideoTranscoded,
        segmentOffset,
        actualSegmentIndex,
        segmentWasDeleted,
        jobSegmentDuration,
        streamTargetDuration,
        canSeek,
        streamReadyForDiagnostics,
        currentProgressForDiagnostics,
    };
}
