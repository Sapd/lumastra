// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    createSegmentNotFoundResponse,
    createSegmentNotReadyResponse,
    createTailCacheSegmentResponse,
    type SegmentResponseContext,
} from './segment-action-executor.js';
import type { TranscodeJob } from '../transcoding/types.js';
import type { SegmentInfo } from '../../utils/hls-segment-utils.js';
import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';
import { lookupEndSegment } from './end-segment-cache.js';

export interface WaitForInitSegmentOptions {
    fileExists: boolean;
    isInitSegment: boolean;
    job: TranscodeJob;
    playSessionId: string;
    normalizedPath: string;
    filePath: string;
    timeoutMs: number;
    pollIntervalMs: number;
    accessFile: (filePath: string) => Promise<void>;
    getJobByPlaySession: (playSessionId: string) => TranscodeJob | undefined;
    clearSeekTimestamp: (playSessionId: string) => void;
    sleep?: (ms: number) => Promise<void>;
    logDebug: (message: string, metadata: Record<string, unknown>) => void;
}

export interface CreateMissingHlsFileResponseOptions {
    responseContext: SegmentResponseContext;
    job: TranscodeJob;
    playSessionId: string;
    filePath: string;
    segmentPath: string;
    isSegment: boolean;
    isInitSegment: boolean;
    segmentInfo: SegmentInfo | null;
    requestedSegmentNum: number;
    segmentOffset: number;
    /** Absolute index the encoder has produced up to; undefined when unknown. */
    currentProgress?: number;
    /** I-frame (Range) requests are best-effort thumbnails: keep their 404. */
    isIframeRequest?: boolean;
    streamDirName: string;
    streamTargetDuration: number;
    jobSegmentDuration: number;
    contentType: string;
    corsHeaders: Record<string, string>;
    logInfo: (message: string, metadata: Record<string, unknown>) => void;
    logWarn: (message: string, metadata: Record<string, unknown>) => void;
    logDebug: (message: string, metadata: Record<string, unknown>) => void;
}

/**
 * A job that will never write the file we are waiting for.
 *
 * `stopping` counts, and it did not used to: `stopJob()` sets it before the
 * awaited kill + output-directory delete, so a job genuinely tearing down sat
 * in it for the whole graceful-SIGTERM window — and indefinitely when FFmpeg
 * is wedged in uninterruptible I/O. Every waiter polled its full timeout for a
 * request that could only ever 404.
 *
 * Both terminal states are exempt while `isSeeking`, because a seek deliberately
 * stops FFmpeg and restarts it, and that restart is the exact window these waits
 * exist to cover. That is safe against the race: `seekToSegment` sets
 * `isSeeking` on the NEW generation and registers it before the first `await`,
 * so a concurrent poll never observes the seeking job without the flag, and the
 * retiring old generation is no longer reachable by play-session lookup.
 */
export function isTranscodeJobDead(job: TranscodeJob | undefined): boolean {
    if (!job) return true;
    if (job.status === 'error') return true;
    return (job.status === 'stopped' || job.status === 'stopping') && !job.isSeeking;
}

/**
 * A media segment the job WILL still write: the job is alive and the segment
 * lies at or ahead of what this generation is producing. Anything behind
 * progress, below the generation's start, or past the end of the stream will
 * never appear, so it keeps its 404 — retrying it would only delay the error.
 */
export function isSegmentStillComing(options: {
    job: TranscodeJob;
    requestedSegmentNum: number;
    segmentOffset: number;
    currentProgress?: number;
    streamTotal?: number;
}): boolean {
    if (isTranscodeJobDead(options.job)) return false;
    if (options.requestedSegmentNum < options.segmentOffset) return false;
    if (options.streamTotal !== undefined && options.requestedSegmentNum >= options.streamTotal) {
        return false;
    }
    // Mid-seek, progress still describes the retiring generation.
    if (options.job.isSeeking) return true;
    return (
        options.currentProgress !== undefined &&
        options.requestedSegmentNum >= options.currentProgress
    );
}

export async function waitForInitSegment(options: WaitForInitSegmentOptions): Promise<boolean> {
    if (options.fileExists || !options.isInitSegment || isTranscodeJobDead(options.job)) {
        return options.fileExists;
    }

    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startTime = Date.now();

    options.logDebug('Waiting for init segment', {
        playSessionId: options.playSessionId,
        path: options.normalizedPath,
    });

    while (Date.now() - startTime < options.timeoutMs) {
        try {
            await options.accessFile(options.filePath);
            options.logDebug('Init segment ready', {
                playSessionId: options.playSessionId,
                waitMs: Date.now() - startTime,
            });
            return true;
        } catch {
            // best-effort: file not ready yet — keep polling unless the job has died.
            const currentJob = options.getJobByPlaySession(options.playSessionId);
            if (isTranscodeJobDead(currentJob)) {
                options.clearSeekTimestamp(options.playSessionId);
                break;
            }
        }
        await sleep(options.pollIntervalMs);
    }

    return false;
}

export function createMissingHlsFileResponse(
    options: CreateMissingHlsFileResponseOptions,
): Response {
    if (options.isSegment || options.isInitSegment) {
        const streamDur404 = options.streamTargetDuration || options.jobSegmentDuration;
        const streamTotal404 = options.job.config.totalDurationSeconds
            ? uniformSegmentCount(options.job.config.totalDurationSeconds, streamDur404)
            : undefined;
        const isTailProbe =
            streamTotal404 !== undefined && options.requestedSegmentNum >= streamTotal404 - 3;
        const cachedEntry = options.segmentInfo
            ? options.job.endSegmentCache.get(options.segmentInfo.streamDir)
            : undefined;

        if (isTailProbe && options.segmentInfo) {
            // Only the entry the cache holds; another index of the tail window
            // must not get its neighbour's bytes (end-segment-cache.ts).
            const cachedEnd = lookupEndSegment(
                options.job.endSegmentCache,
                options.segmentInfo.streamDir,
                options.requestedSegmentNum,
                {
                    totalSeconds: options.job.config.totalDurationSeconds ?? 0,
                    segmentSeconds: streamDur404,
                },
            );
            if (cachedEnd) {
                options.logInfo('Tail probe satisfied from endSegmentCache (last-resort)', {
                    playSessionId: options.playSessionId,
                    stream: options.segmentInfo.streamDir,
                    segment: options.requestedSegmentNum,
                    streamTotal: streamTotal404,
                    cachedSize: cachedEnd.length,
                });
                return createTailCacheSegmentResponse({
                    corsHeaders: options.corsHeaders,
                    contentType: options.contentType,
                    cached: cachedEnd,
                });
            }
            options.logWarn('Tail probe 404 — endSegmentCache miss', {
                playSessionId: options.playSessionId,
                stream: options.streamDirName,
                requestedSegmentNum: options.requestedSegmentNum,
                streamTotal: streamTotal404,
                hasEndCache: cachedEntry !== undefined,
                endCacheKind: cachedEntry?.kind,
                endCacheIndex:
                    cachedEntry?.kind === 'segment' ? cachedEntry.segmentIndex : undefined,
                endCacheStreams: [...options.job.endSegmentCache.keys()],
                segmentOffset: options.segmentOffset,
                segmentsReady: options.job.segmentsReady,
                jobStatus: options.job.status,
            });
        } else if (!isTailProbe) {
            options.logDebug('Segment/init not found', {
                playSessionId: options.playSessionId,
                path: options.segmentPath,
                jobStatus: options.job.status,
                isInit: options.isInitSegment,
            });
        }

        if (options.isSegment) {
            if (
                !isTailProbe &&
                !options.isIframeRequest &&
                isSegmentStillComing({
                    job: options.job,
                    requestedSegmentNum: options.requestedSegmentNum,
                    segmentOffset: options.segmentOffset,
                    currentProgress: options.currentProgress,
                    streamTotal: streamTotal404,
                })
            ) {
                return createSegmentNotReadyResponse(options.responseContext, 'segment_not_ready');
            }
            return createSegmentNotFoundResponse(options.responseContext, 'segment_not_found');
        }

        // An init that is merely not written YET is not a 404. AVFoundation
        // treats 404 as terminal and penalty-boxes the variant, so answer 503 +
        // Retry-After while the job is still producing — the same guard the
        // media playlist uses. Only a dead job gets the 404.
        //
        // Must use the same predicate as the wait above, or the two disagree:
        // a `stopping` job would exit the poll loop immediately and then still
        // be told to retry, turning one held-open request into a stream of fast
        // 503s. It also gains the isSeeking exemption the wait always had — a
        // seek restart is producing, and answering 404 there is what penalty-
        // boxes the variant on the very clients this branch exists for.
        if (!isTranscodeJobDead(options.job)) {
            return new Response('Init segment not ready — transcode is starting', {
                status: 503,
                headers: {
                    ...options.corsHeaders,
                    'Retry-After': '1',
                    'Cache-Control': 'no-store',
                },
            });
        }

        return new Response('Init segment not found', {
            status: 404,
            headers: options.corsHeaders,
        });
    }

    options.logWarn('File not found', {
        playSessionId: options.playSessionId,
        filePath: options.filePath,
    });
    return new Response('File not found', {
        status: 404,
        headers: options.corsHeaders,
    });
}
