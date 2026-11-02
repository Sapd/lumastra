// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getKeyframeSegmentStartTime } from '../ffmpeg-transcode.service.js';
import type { TranscodeJob } from '../transcoding/types.js';
import { isGopModeJob } from './gop-mode.js';

export interface HlsSeekTranscodeService {
    getJobByPlaySession(playSessionId: string): TranscodeJob | undefined;
    seekToSegment(
        playSessionId: string,
        targetSegmentIndex: number,
        segmentDurationSeconds: number,
        seekTimeSeconds?: number,
    ): Promise<boolean>;
}

export interface DeduplicatedHlsSeekOptions {
    playSessionId: string;
    targetSegmentIndex: number;
    segmentDurationSeconds: number;
    fallbackSegmentDurationSeconds: number;
    transcodeService: HlsSeekTranscodeService;
}

const activeSeeks = new Map<string, { promise: Promise<boolean>; audioBasedTarget: number }>();

export async function deduplicatedHlsSeek(options: DeduplicatedHlsSeekOptions): Promise<boolean> {
    const job = options.transcodeService.getJobByPlaySession(options.playSessionId);
    const jobSegmentDuration =
        job?.segmentDurationSeconds ?? options.fallbackSegmentDurationSeconds;
    const seekTimeSeconds = calculateHlsSeekTimeSeconds(
        job,
        options.targetSegmentIndex,
        options.segmentDurationSeconds,
        jobSegmentDuration,
    );
    const audioBasedTarget = Math.floor(seekTimeSeconds / jobSegmentDuration);
    const serviceTarget = shouldUseKeyframeSegmentTarget(job)
        ? options.targetSegmentIndex
        : audioBasedTarget;

    // Every waiter must re-check ownership after waking. Several segment requests
    // can await the same restart; a single check lets them all spawn competing
    // generations once it resolves, and even duplicates restart independently.
    while (true) {
        const existing = activeSeeks.get(options.playSessionId);
        if (!existing) break;
        if (audioBasedTarget === existing.audioBasedTarget) {
            return existing.promise;
        }
        // A failed prior restart must not prevent a new target from proceeding.
        await existing.promise.catch(() => {});
    }

    const seekPromise = options.transcodeService
        .seekToSegment(options.playSessionId, serviceTarget, jobSegmentDuration, seekTimeSeconds)
        .finally(() => {
            if (activeSeeks.get(options.playSessionId)?.promise === seekPromise) {
                activeSeeks.delete(options.playSessionId);
            }
        });

    activeSeeks.set(options.playSessionId, {
        promise: seekPromise,
        audioBasedTarget,
    });
    return seekPromise;
}

export function clearActiveHlsSeeksForTests(): void {
    activeSeeks.clear();
}

function calculateHlsSeekTimeSeconds(
    job: TranscodeJob | undefined,
    targetSegmentIndex: number,
    segmentDurationSeconds: number,
    jobSegmentDuration: number,
): number {
    // In muxed mode, segment indices correspond to keyframe-derived segments,
    // so we must convert to the keyframe start time for accurate seeking.
    // In demux mode, segment indices use the uniform audio timeline — using
    // keyframe time here would overshoot (e.g. segment 50 at ~521s instead of
    // 500s), making audio segments before the keyframe time unreachable.
    if (shouldUseKeyframeSegmentTarget(job)) {
        if (targetSegmentIndex >= 0 && job!.keyframeData!.length > 0) {
            return getKeyframeSegmentStartTime(
                targetSegmentIndex,
                job!.keyframeData!,
                job!.config.totalDurationSeconds ?? 0,
                jobSegmentDuration,
            );
        }
    }

    return Math.max(0, targetSegmentIndex * segmentDurationSeconds);
}

function shouldUseKeyframeSegmentTarget(job: TranscodeJob | undefined): boolean {
    // GOP mode numbers every demux stream on the keyframe grid too.
    if (job && isGopModeJob(job)) return true;
    return Boolean(
        job?.config?.hlsOutput?.hlsAudioMode === 'muxed' &&
        job?.transcodeDecisionResult?.videoAction === 'copy' &&
        job?.keyframeData &&
        job.keyframeData.length > 0,
    );
}
