// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as path from 'path';

import { Logger } from '../../utils/logger.js';
import {
    getSegmentFilename,
    isPathInsideDirectory,
    isSeekOnCooldown,
    translateToActualIndex,
} from '../../utils/hls-segment-utils.js';
import type { TranscodeJob } from '../transcoding/types.js';

const logger = Logger.for('HlsSegmentActionExecutor');

/**
 * Cache-Control for a media segment of a session-scoped transcode, matching
 * its init segment and playlists. A segment URL is not content-addressed: a
 * seek or quality restart rewrites segment_00000.m4s under the same session
 * URL, so a cached copy (max-age=3600 before) could replay stale media, and
 * `private` keeps shared caches off this ACAO:* surface. Range support stays:
 * I-frame scrubbing requests segments by byte range.
 */
export const SESSION_SEGMENT_CACHE_CONTROL = 'private, no-cache';

export type SegmentDebugHeaderBuilder = (options: {
    job: TranscodeJob;
    segmentOffset: number;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    streamDirName: string;
    playSessionId: string;
    branch: string;
    canSeek: boolean;
    streamTargetDuration?: number;
}) => Record<string, string>;

export interface SegmentResponseContext {
    job: TranscodeJob;
    segmentOffset: number;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    streamDirName: string;
    playSessionId: string;
    canSeek: boolean;
    streamTargetDuration?: number;
    corsHeaders: Record<string, string>;
    buildDebugHeaders: SegmentDebugHeaderBuilder;
}

export interface WaitForCurrentSegmentFileOptions {
    job: TranscodeJob;
    playSessionId: string;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    actualFilePath: string;
    sourceFilePath: string;
    segExt: string;
    streamDirName: string;
    streamTargetDuration: number;
    jobSegmentDuration: number;
    canSeek: boolean;
    isIframeRequest: boolean | string | null;
    isRepeatedSegmentPressure: boolean;
    repeatedRequestCount: number;
    isVideoTranscoded: boolean;
    waitTimeoutMs: number;
    seekWaitTimeoutMs: number;
    iframeWaitTimeoutMs: number;
    pollIntervalMs: number;
    getJobByPlaySession: (playSessionId: string) => TranscodeJob | undefined;
    getSegmentOffset: (playSessionId: string) => number;
    getStreamSegmentOffset: (playSessionId: string, streamDirName: string) => number;
    clearSeekTimestamp: (playSessionId: string) => void;
    /** Optional override for translating actual segment index to file index.
     *  Used by demux copy-mode video to map uniform segments to keyframe files. */
    translateToFileIndex?: (actualIndex: number) => number;
    accessFile?: (filePath: string) => Promise<void>;
    /** Forced restart used only when the produced grid cannot safely be remapped. */
    restartAtRequestedSegment?: () => Promise<boolean>;
    logError?: (message: string, metadata: Record<string, unknown>) => void;
    sleep?: (ms: number) => Promise<void>;
}

export interface WaitForCurrentSegmentFileResult {
    /** Recovery spawned a generation; the caller must answer retryable 503. */
    retryAfterRecovery?: boolean;
    fileExists: boolean;
    actualFilePath: string;
    waitMs: number;
}

export type ForwardSeekBranch =
    | 'forward_seek'
    | 'far_from_origin_seek'
    | 'repeated_pressure_forward_seek'
    | 'speed_aware_forward_seek';

export interface ExecuteForwardSeekOptions {
    responseContext: SegmentResponseContext;
    job: TranscodeJob;
    playSessionId: string;
    requestedSegmentNum: number;
    segmentOffset: number;
    currentProgress: number;
    fileExists: boolean;
    actualFilePath: string;
    normalizedPath: string;
    segExt: string;
    streamDirName: string;
    streamTargetDuration: number;
    isVideoTranscoded: boolean;
    branch: ForwardSeekBranch;
    seekCooldownMs: number;
    forwardSeekThreshold: number;
    seekWaitTimeoutMs: number;
    pollIntervalMs: number;
    logIntervalMs: number;
    getLastSeekTimestamp: (playSessionId: string) => number | undefined;
    setLastSeekTimestamp: (playSessionId: string, timestamp: number) => void;
    clearSeekTimestamp: (playSessionId: string) => void;
    pruneExpiredSeekTimestamps: () => void;
    deduplicatedSeek: (
        playSessionId: string,
        targetSegmentIndex: number,
        segmentDurationSeconds: number,
    ) => Promise<boolean>;
    getJobByPlaySession: (playSessionId: string) => TranscodeJob | undefined;
    getStreamSegmentOffsetForJob: (job: TranscodeJob, streamDirName: string) => number;
    /** Optional override for translating actual segment index to file index.
     *  Used by demux copy-mode video to map uniform segments to keyframe files. */
    translateToFileIndex?: (actualIndex: number) => number;
    readFile?: (filePath: string) => Promise<Buffer>;
    sleep?: (ms: number) => Promise<void>;
}

export interface ExecuteForwardSeekResult {
    response?: Response;
    job: TranscodeJob;
    fileExists: boolean;
    actualFilePath: string;
    waitMs: number;
    /** Pre-read file content from the wait loop (avoids TOCTOU with later readFile). */
    fileContent?: Buffer;
}

export interface ExecuteBackwardSeekOptions {
    responseContext: SegmentResponseContext;
    job: TranscodeJob;
    playSessionId: string;
    requestedSegmentNum: number;
    segmentOffset: number;
    normalizedPath: string;
    segExt: string;
    streamDirName: string;
    streamTargetDuration: number;
    isVideoTranscoded: boolean;
    segmentInfoStreamDir?: string;
    seekCooldownMs: number;
    forwardSeekThreshold: number;
    seekWaitTimeoutMs: number;
    pollIntervalMs: number;
    logIntervalMs: number;
    getLastSeekTimestamp: (playSessionId: string) => number | undefined;
    setLastSeekTimestamp: (playSessionId: string, timestamp: number) => void;
    clearSeekTimestamp: (playSessionId: string) => void;
    pruneExpiredSeekTimestamps: () => void;
    deduplicatedSeek: (
        playSessionId: string,
        targetSegmentIndex: number,
        segmentDurationSeconds: number,
    ) => Promise<boolean>;
    getJobByPlaySession: (playSessionId: string) => TranscodeJob | undefined;
    getStreamSegmentOffsetForJob: (job: TranscodeJob, streamDirName: string) => number;
    recordSegmentAccessForJob: (
        job: TranscodeJob,
        streamDirName: string,
        segmentIndex: number,
    ) => void;
    onSegmentServed?: (served: {
        job: TranscodeJob;
        streamDir: string;
        requestedSegment: number;
        actualSegment: number;
        segmentOffset: number;
        waitMs: number;
    }) => void;
    /** Optional override for translating actual segment index to file index.
     *  Used by demux copy-mode video to map uniform segments to keyframe files. */
    translateToFileIndex?: (actualIndex: number) => number;
    readFile?: (filePath: string) => Promise<Buffer>;
    sleep?: (ms: number) => Promise<void>;
}

function debugHeaders(context: SegmentResponseContext, branch: string): Record<string, string> {
    return context.buildDebugHeaders({
        job: context.job,
        segmentOffset: context.segmentOffset,
        requestedSegmentNum: context.requestedSegmentNum,
        actualSegmentIndex: context.actualSegmentIndex,
        streamDirName: context.streamDirName,
        playSessionId: context.playSessionId,
        branch,
        canSeek: context.canSeek,
        streamTargetDuration: context.streamTargetDuration,
    });
}

export function createDeletedSegmentResponse(context: SegmentResponseContext): Response {
    return new Response(
        JSON.stringify({
            error: 'Segment expired',
            message:
                'This segment was cleaned up. Please restart the stream from your current position.',
            code: 'SEGMENT_EXPIRED',
        }),
        {
            status: 410,
            headers: {
                ...context.corsHeaders,
                'Content-Type': 'application/json',
                ...debugHeaders(context, 'deleted'),
            },
        },
    );
}

export function createSegmentNotFoundResponse(
    context: SegmentResponseContext,
    branch: string,
    body: BodyInit | null = 'Segment not found',
): Response {
    return new Response(body, {
        status: 404,
        headers: {
            ...context.corsHeaders,
            ...debugHeaders(context, branch),
        },
    });
}

/**
 * A media segment the live job has not reached YET. Retryable on purpose: hls.js
 * never retries a 4xx fragment and our player triages 404 as terminal, so a
 * forward seek that outruns a slow transcode (CPU tonemap at ~4x) turned into a
 * fatal "not available" the moment the wait timed out. A retry also counts as
 * repeated-segment pressure, which can restart FFmpeg at the target.
 */
export function createSegmentNotReadyResponse(
    context: SegmentResponseContext,
    branch: string,
): Response {
    return new Response('Segment not ready — transcode has not reached it yet', {
        status: 503,
        headers: {
            ...context.corsHeaders,
            ...debugHeaders(context, branch),
            'Retry-After': '1',
            'Cache-Control': 'no-store',
        },
    });
}

/** A cooldown can also catch a legitimate second seek; it is not a missing segment. */
function createSeekCooldownResponse(
    context: SegmentResponseContext,
    branch: string,
    remainingMs: number,
): Response {
    return new Response(null, {
        status: 503,
        headers: {
            ...context.corsHeaders,
            ...debugHeaders(context, branch),
            'Retry-After': String(Math.max(1, Math.ceil(remainingMs / 1000))),
            'Cache-Control': 'no-store',
        },
    });
}

export async function executeForwardSeekAction(
    options: ExecuteForwardSeekOptions,
): Promise<ExecuteForwardSeekResult> {
    const readFileForWait = options.readFile ?? fs.readFile;
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const forwardDistance = Math.abs(options.requestedSegmentNum - options.segmentOffset);
    const lastSeekTime = options.getLastSeekTimestamp(options.playSessionId);
    const now = Date.now();
    if (
        isSeekOnCooldown(
            lastSeekTime,
            now,
            options.seekCooldownMs,
            forwardDistance,
            // A speed-aware seek fires at gaps under the fixed threshold, where
            // the distance-gated cooldown would never apply — a few quick skips
            // on a slow transcode would each spawn a generation.
            options.branch === 'speed_aware_forward_seek' ? 0 : options.forwardSeekThreshold,
        )
    ) {
        const cooldownBranch = getForwardCooldownBranch(options.branch);
        logger.debug('Suppressing forward seek during cooldown', {
            playSessionId: options.playSessionId,
            requestedSegment: options.requestedSegmentNum,
            currentProgress: options.currentProgress,
            segmentOffset: options.segmentOffset,
            distance: forwardDistance,
            branch: options.branch,
        });
        return {
            response: createSeekCooldownResponse(
                options.responseContext,
                cooldownBranch,
                options.seekCooldownMs - (now - (lastSeekTime ?? now)),
            ),
            job: options.job,
            fileExists: options.fileExists,
            actualFilePath: options.actualFilePath,
            waitMs: 0,
        };
    }

    logger.info('Forward seek action detected, triggering re-transcode', {
        playSessionId: options.playSessionId,
        requestedSegment: options.requestedSegmentNum,
        currentProgress: options.currentProgress,
        segmentsAhead: options.requestedSegmentNum - options.currentProgress,
        segmentsFromOrigin: options.requestedSegmentNum - options.segmentOffset,
        fileExisted: options.fileExists,
        streamDir: options.streamDirName,
        branch: options.branch,
    });

    options.job.lastSeekTrigger = `forward:${options.streamDirName}:seg${options.requestedSegmentNum}`;
    options.setLastSeekTimestamp(options.playSessionId, Date.now());
    options.pruneExpiredSeekTimestamps();

    const seekSuccess = await options.deduplicatedSeek(
        options.playSessionId,
        options.requestedSegmentNum,
        options.streamTargetDuration,
    );

    if (!seekSuccess) {
        return {
            job: options.job,
            fileExists: options.fileExists,
            actualFilePath: options.actualFilePath,
            waitMs: 0,
        };
    }

    const currentJobAfterSeek = options.getJobByPlaySession(options.playSessionId) ?? options.job;
    const newStreamOffset = options.getStreamSegmentOffsetForJob(
        currentJobAfterSeek,
        options.streamDirName,
    );
    // Transcode mode: file = requested index (via -start_number)
    // Remux mode: file = requested - perStreamOffset (0-based FFmpeg output)
    const newActualIndex = options.isVideoTranscoded
        ? options.requestedSegmentNum
        : translateToActualIndex(options.requestedSegmentNum, newStreamOffset);

    // Offset race: seek hasn't been reflected in the stream offset yet,
    // producing a negative file index. Bail immediately rather than
    // polling for an impossible filename until the timeout expires.
    if (newActualIndex < 0) {
        return {
            job: currentJobAfterSeek,
            fileExists: false,
            actualFilePath: options.actualFilePath,
            waitMs: 0,
        };
    }

    const newFileIndex = options.translateToFileIndex
        ? options.translateToFileIndex(newActualIndex)
        : newActualIndex;
    const actualSegmentName = getSegmentFilename(newFileIndex, options.segExt);
    const actualFilePath = path.join(
        currentJobAfterSeek.outputDir,
        path.dirname(options.normalizedPath),
        actualSegmentName,
    );

    if (!isPathInsideDirectory(actualFilePath, currentJobAfterSeek.outputDir)) {
        return {
            response: createSegmentNotFoundResponse(options.responseContext, 'forward_path_escape'),
            job: currentJobAfterSeek,
            fileExists: false,
            actualFilePath,
            waitMs: 0,
        };
    }

    let fileExists = false;
    let fileContent: Buffer | undefined;

    const seekWaitStart = Date.now();
    let lastLogTime = seekWaitStart;

    while (Date.now() - seekWaitStart < options.seekWaitTimeoutMs) {
        try {
            // Single readFile avoids TOCTOU race (file deleted between access and later read).
            fileContent = await readFileForWait(actualFilePath);
            fileExists = true;
            logger.info('Segment ready after forward seek action', {
                playSessionId: options.playSessionId,
                segment: options.requestedSegmentNum,
                branch: options.branch,
                waitMs: Date.now() - seekWaitStart,
            });
            break;
        } catch {
            const currentJob = options.getJobByPlaySession(options.playSessionId);
            if (currentJob?.status === 'error') {
                options.clearSeekTimestamp(options.playSessionId);
                break;
            }
            const now = Date.now();
            if (now - lastLogTime >= options.logIntervalMs) {
                lastLogTime = now;
                logger.debug('Still waiting for segment after forward seek action', {
                    playSessionId: options.playSessionId,
                    requestedSegment: options.requestedSegmentNum,
                    branch: options.branch,
                    waitMs: now - seekWaitStart,
                    jobStatus: currentJob?.status,
                    segmentsReady: currentJob?.segmentsReady,
                });
            }
        }
        await sleep(options.pollIntervalMs);
    }

    return {
        job: currentJobAfterSeek,
        fileExists,
        actualFilePath,
        waitMs: Date.now() - seekWaitStart,
        fileContent,
    };
}

export async function executeBackwardSeekAction(
    options: ExecuteBackwardSeekOptions,
): Promise<Response> {
    const readFile = options.readFile ?? fs.readFile;
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const backwardDistance = Math.abs(options.requestedSegmentNum - options.segmentOffset);
    const lastSeekTime = options.getLastSeekTimestamp(options.playSessionId);
    const now = Date.now();
    if (
        isSeekOnCooldown(
            lastSeekTime,
            now,
            options.seekCooldownMs,
            backwardDistance,
            options.forwardSeekThreshold,
        )
    ) {
        logger.debug('Suppressing backward seek during cooldown', {
            playSessionId: options.playSessionId,
            requestedSegment: options.requestedSegmentNum,
            segmentOffset: options.segmentOffset,
            distance: backwardDistance,
        });
        return createSeekCooldownResponse(
            options.responseContext,
            'backward_cooldown',
            options.seekCooldownMs - (now - (lastSeekTime ?? now)),
        );
    }

    logger.info('Backward seek detected, triggering re-transcode', {
        playSessionId: options.playSessionId,
        requestedSegment: options.requestedSegmentNum,
        segmentOffset: options.segmentOffset,
        streamDir: options.streamDirName,
        streamTargetDuration: options.streamTargetDuration,
    });

    options.job.lastSeekTrigger = `backward:${options.streamDirName}:seg${options.requestedSegmentNum}`;
    options.setLastSeekTimestamp(options.playSessionId, Date.now());
    options.pruneExpiredSeekTimestamps();

    const seekSuccess = await options.deduplicatedSeek(
        options.playSessionId,
        options.requestedSegmentNum,
        options.streamTargetDuration,
    );

    if (!seekSuccess) {
        return createSegmentErrorResponse(options.responseContext, {
            branch: 'backward_seek_failed',
            body: 'Seek failed',
            status: 503,
        });
    }

    const currentJobAfterSeek = options.getJobByPlaySession(options.playSessionId) ?? options.job;
    // Wait for the segment after seek.
    // Transcode mode: file = requested index (via -start_number)
    // Remux mode: file = requested - perStreamOffset (0-based FFmpeg output)
    const seekActualIndex = options.isVideoTranscoded
        ? options.requestedSegmentNum
        : translateToActualIndex(
              options.requestedSegmentNum,
              options.getStreamSegmentOffsetForJob(currentJobAfterSeek, options.streamDirName),
          );
    const seekFileIndex = options.translateToFileIndex
        ? options.translateToFileIndex(seekActualIndex)
        : seekActualIndex;
    const seekFilePath = path.join(
        currentJobAfterSeek.outputDir,
        path.dirname(options.normalizedPath),
        getSegmentFilename(seekFileIndex, options.segExt),
    );

    if (!isPathInsideDirectory(seekFilePath, currentJobAfterSeek.outputDir)) {
        return createSegmentNotFoundResponse(options.responseContext, 'backward_path_escape');
    }

    const seekWaitStart = Date.now();
    let lastLogTime = seekWaitStart;

    while (Date.now() - seekWaitStart < options.seekWaitTimeoutMs) {
        try {
            // Single readFile call avoids TOCTOU race (file deleted between access/stat/read).
            const content = await readFile(seekFilePath);

            if (options.segmentInfoStreamDir) {
                options.recordSegmentAccessForJob(
                    currentJobAfterSeek,
                    options.segmentInfoStreamDir,
                    seekFileIndex,
                );
                options.onSegmentServed?.({
                    job: currentJobAfterSeek,
                    streamDir: options.segmentInfoStreamDir,
                    requestedSegment: options.requestedSegmentNum,
                    actualSegment: seekFileIndex,
                    segmentOffset: options.getStreamSegmentOffsetForJob(
                        currentJobAfterSeek,
                        options.segmentInfoStreamDir,
                    ),
                    waitMs: Date.now() - seekWaitStart,
                });
            }

            return new Response(content as unknown as ArrayBuffer, {
                status: 200,
                headers: {
                    ...options.responseContext.corsHeaders,
                    'Content-Type': options.segExt === 'ts' ? 'video/mp2t' : 'video/mp4',
                    'Content-Length': content.length.toString(),
                    'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
                },
            });
        } catch {
            const currentJob = options.getJobByPlaySession(options.playSessionId);
            if (currentJob?.status === 'error') {
                options.clearSeekTimestamp(options.playSessionId);
                break;
            }
            const now = Date.now();
            if (now - lastLogTime >= options.logIntervalMs) {
                lastLogTime = now;
                logger.debug('Still waiting for segment after backward seek', {
                    playSessionId: options.playSessionId,
                    requestedSegment: options.requestedSegmentNum,
                    waitMs: now - seekWaitStart,
                    jobStatus: currentJob?.status,
                });
            }
        }
        await sleep(options.pollIntervalMs);
    }

    logger.warn('Segment not ready after backward seek timeout', {
        playSessionId: options.playSessionId,
        requestedSegment: options.requestedSegmentNum,
        timeoutMs: options.seekWaitTimeoutMs,
    });

    return createSegmentErrorResponse(options.responseContext, {
        branch: 'backward_seek_timeout',
        body: 'Segment not ready after seek',
        status: 503,
    });
}

export function createSegmentErrorResponse(
    context: SegmentResponseContext,
    options: {
        branch: string;
        body: string;
        status: number;
    },
): Response {
    return new Response(options.body, {
        status: options.status,
        headers: {
            ...context.corsHeaders,
            ...debugHeaders(context, options.branch),
        },
    });
}

export function createTailCacheSegmentResponse(options: {
    corsHeaders: Record<string, string>;
    contentType: string;
    cached: Buffer;
}): Response {
    return new Response(options.cached as unknown as ArrayBuffer, {
        status: 200,
        headers: {
            ...options.corsHeaders,
            'Content-Type': options.contentType,
            'Content-Length': options.cached.length.toString(),
            'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
        },
    });
}

export async function waitForCurrentSegmentFile(
    options: WaitForCurrentSegmentFileOptions,
): Promise<WaitForCurrentSegmentFileResult> {
    const accessFile = options.accessFile ?? fs.access;
    const sleep =
        options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startTime = Date.now();
    let actualFilePath = options.actualFilePath;
    let fileExists = false;

    // Convert segmentsReady to per-stream units for comparison.
    // segmentsReady tracks progress in job.segmentDurationSeconds units.
    // Video segments may be larger, so fewer video segments are ready.
    const streamSegmentsReady =
        options.streamTargetDuration > 0 &&
        options.streamTargetDuration !== options.jobSegmentDuration
            ? Math.floor(
                  (options.job.segmentsReady * options.jobSegmentDuration) /
                      options.streamTargetDuration,
              )
            : options.job.segmentsReady;
    const currentProgress = streamSegmentsReady + options.segmentOffset;

    logger.debug('Waiting for segment', {
        playSessionId: options.playSessionId,
        requestedSegment: options.requestedSegmentNum,
        actualSegment: options.actualSegmentIndex,
        currentProgress,
        segmentsAhead: options.requestedSegmentNum - currentProgress,
        segmentOffset: options.segmentOffset,
        streamDir: options.streamDirName,
        streamTargetDuration: options.streamTargetDuration,
    });

    // Normal wait for segment (small seek or sequential playback).
    //
    // For non-authoritative streams (audio in demuxed mode), use a longer
    // timeout when a seek might be in progress. The seek takes 5-8s
    // (killing FFmpeg + cleanup + restart), and the normal 10s timeout
    // can expire before the offset updates. With the longer timeout,
    // audio survives the seek and picks up the new offset in the re-read
    // loop below.
    const isSeekLikely =
        !options.canSeek && (options.job.isSeeking || options.job.segmentsReady < 5);
    // Cold start of a transcoded video job: FFmpeg needs to fill its decode
    // + encode pipeline before emitting the first segment. For 4K H264/HEVC
    // transcodes this easily exceeds the normal 10s wait (15-20s observed).
    // Use the longer seek-wait budget for the first few segments so hls.js
    // gets the file on the first request instead of 404'ing and retrying.
    const isTranscodedColdStart = options.isVideoTranscoded && options.job.segmentsReady < 3;
    const waitTimeout = options.isIframeRequest
        ? options.iframeWaitTimeoutMs
        : isSeekLikely || options.isRepeatedSegmentPressure || isTranscodedColdStart
          ? options.seekWaitTimeoutMs
          : options.waitTimeoutMs;

    // Track the last-seen offset so every change (not just the first)
    // triggers a file path recomputation (remux) or bail check (transcode).
    let lastSeenOffset = options.segmentOffset;
    let checkedStartMismatch = false;

    while (Date.now() - startTime < waitTimeout) {
        // Re-read offset on each iteration: a concurrent seek (from the
        // video stream) may change the offset while we're waiting.
        const currentOffset = resolveCurrentOffset(options);
        // This generation cannot produce a back-buffer request from before its
        // declared window. In particular, demux audio must never move the job.
        if (options.requestedSegmentNum < currentOffset) break;
        if (currentOffset !== lastSeenOffset) {
            lastSeenOffset = currentOffset;
            if (options.isVideoTranscoded) {
                // Transcode: file name matches requested index, no recomputation.
                // But if requested segment is before new offset, bail.
                if (options.requestedSegmentNum < currentOffset) break;
            } else {
                // Remux: recompute file path with new offset.
                const newActualIndex = translateToActualIndex(
                    options.requestedSegmentNum,
                    currentOffset,
                );
                if (newActualIndex < 0) break;
                const newFileIndex = options.translateToFileIndex
                    ? options.translateToFileIndex(newActualIndex)
                    : newActualIndex;
                actualFilePath = path.join(
                    path.dirname(options.sourceFilePath),
                    getSegmentFilename(newFileIndex, options.segExt),
                );
            }
        }

        try {
            await accessFile(actualFilePath);
            fileExists = true;
            const waitTime = Date.now() - startTime;
            if (waitTime > 1000) {
                logger.info('Segment ready after wait', {
                    playSessionId: options.playSessionId,
                    segment: options.requestedSegmentNum,
                    waitMs: waitTime,
                    isIframe: options.isIframeRequest,
                });
            }
            break;
        } catch {
            // Not ready yet - check if job is still running.
            const currentJob = options.getJobByPlaySession(options.playSessionId);
            if (
                !currentJob ||
                currentJob.status === 'error' ||
                (currentJob.status === 'stopped' && !currentJob.isSeeking)
            ) {
                options.clearSeekTimestamp(options.playSessionId);
                break;
            }

            // An argv start number plus its first file proves that FFmpeg will
            // never write M < N in this generation. Do not spend the timeout on
            // that impossible path. Sliding-window deletion alone is not proof.
            const producedStart = currentJob.ffmpegOutputStartNumber;
            const waitingIndex = Number(
                path.basename(actualFilePath).match(/^segment_(\d+)\./)?.[1],
            );
            if (
                options.canSeek &&
                options.requestedSegmentNum >= currentOffset &&
                !checkedStartMismatch &&
                currentJob.id === options.job.id &&
                currentJob.generationRole === 'current' &&
                currentJob.status !== 'stopping' &&
                !currentJob.isSeeking &&
                !options.isIframeRequest &&
                currentOffset === options.segmentOffset &&
                producedStart !== undefined &&
                producedStart > 0 &&
                waitingIndex < producedStart &&
                currentJob.config?.effectivePlan?.grid !== 'gop'
            ) {
                const firstProduced = path.join(
                    path.dirname(actualFilePath),
                    getSegmentFilename(producedStart, options.segExt),
                );
                let proven = false;
                try {
                    await accessFile(firstProduced);
                    proven = true;
                } catch {
                    /* Not produced yet. */
                }
                // The probe awaited I/O: a concurrent seek must win over recovery.
                if (
                    proven &&
                    options.getJobByPlaySession(options.playSessionId)?.id === currentJob.id &&
                    !currentJob.isSeeking
                ) {
                    checkedStartMismatch = true;
                    const metadata = {
                        playSessionId: options.playSessionId,
                        jobId: currentJob.id,
                        waitingForIndex: waitingIndex,
                        producedStartNumber: producedStart,
                        requestedSegmentNum: options.requestedSegmentNum,
                        plan:
                            currentJob.config?.effectivePlan ?? currentJob.transcodeDecisionResult,
                    };
                    if (options.logError)
                        options.logError('HLS segment start/grid mismatch', metadata);
                    else logger.error('HLS segment start/grid mismatch', undefined, metadata);
                    const plan = currentJob.config?.effectivePlan;
                    if (
                        plan?.grid === 'uniform' &&
                        plan.segmentOffset === currentOffset &&
                        options.requestedSegmentNum >= producedStart
                    ) {
                        // Uniform output has absolute file names. The public
                        // request is already on that grid, so remove the stale
                        // copy-mode subtraction; never return a neighbour's bytes.
                        actualFilePath = path.join(
                            path.dirname(actualFilePath),
                            getSegmentFilename(options.requestedSegmentNum, options.segExt),
                        );
                        continue;
                    }
                    if (options.restartAtRequestedSegment) {
                        currentJob.outputStartRecoveryPromise ??=
                            options.restartAtRequestedSegment();
                        await currentJob.outputStartRecoveryPromise;
                        return {
                            fileExists: false,
                            actualFilePath,
                            waitMs: Date.now() - startTime,
                            retryAfterRecovery: true,
                        };
                    }
                }
            }

            // Bail immediately if the segment is unreachably far beyond
            // current progress (e.g., hls.js VOD duration probe for the
            // last segment while FFmpeg just restarted near a mid-file
            // seek position). Waiting 45s for FFmpeg to transcode hundreds
            // of segments is futile — 404 lets hls.js retry later.
            //
            // Compare using global progress (offset + segmentsReady) since
            // file names use global segment numbers after a seek. Without
            // this, segment 400 with offset=399 and segmentsReady=1 would
            // wrongly bail (400 > 1+100) even though it's only 1 ahead.
            if (currentJob && !options.canSeek) {
                const waitingIndex = parseInt(
                    path.basename(actualFilePath).match(/(\d+)/)?.[1] ?? '-1',
                );
                const globalProgress = currentJob.segmentOffset + currentJob.segmentsReady;
                if (waitingIndex > globalProgress + 100 && !options.isRepeatedSegmentPressure) {
                    logger.debug('Bailing wait: segment unreachably far beyond progress', {
                        playSessionId: options.playSessionId,
                        stream: options.streamDirName,
                        requestedSegment: options.requestedSegmentNum,
                        waitingForIndex: waitingIndex,
                        segmentsReady: currentJob.segmentsReady,
                        segmentOffset: currentJob.segmentOffset,
                        globalProgress,
                    });
                    break;
                }
                if (waitingIndex > globalProgress + 100 && options.isRepeatedSegmentPressure) {
                    logger.debug('Keeping sticky wait for repeated far-ahead segment', {
                        playSessionId: options.playSessionId,
                        stream: options.streamDirName,
                        requestedSegment: options.requestedSegmentNum,
                        waitingForIndex: waitingIndex,
                        segmentsReady: currentJob.segmentsReady,
                        segmentOffset: currentJob.segmentOffset,
                        globalProgress,
                        repeatedRequestCount: options.repeatedRequestCount,
                    });
                }
            }
        }
        await sleep(options.pollIntervalMs);
    }

    return { fileExists, actualFilePath, waitMs: Date.now() - startTime };
}

function resolveCurrentOffset(options: WaitForCurrentSegmentFileOptions): number {
    if (options.isVideoTranscoded) {
        return options.job.generationRole === 'previous'
            ? options.segmentOffset
            : options.getSegmentOffset(options.playSessionId);
    }

    return options.job.generationRole === 'previous'
        ? options.segmentOffset
        : options.getStreamSegmentOffset(options.playSessionId, options.streamDirName);
}

function getForwardCooldownBranch(branch: ForwardSeekBranch): string {
    if (branch === 'far_from_origin_seek') return 'far_from_origin_cooldown';
    if (branch === 'repeated_pressure_forward_seek') {
        return 'repeated_pressure_forward_cooldown';
    }
    if (branch === 'speed_aware_forward_seek') return 'speed_aware_forward_cooldown';
    return 'forward_cooldown';
}
