// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as path from 'path';

import { Logger } from '../../utils/logger.js';
import { getSegmentFilename, translateToActualIndex } from '../../utils/hls-segment-utils.js';
import {
    createSegmentNotFoundResponse,
    type SegmentResponseContext,
} from './segment-action-executor.js';
import type { TranscodeJob } from '../transcoding/types.js';

const logger = Logger.for('HlsStaleSegmentGuard');

// Layer 2 (mtime freshness) now runs unconditionally, including on canSeek/video streams
// that never reached this check before. Give it tolerance against clock skew between the
// storage layer and the Node process, and against coarse filesystem mtime granularity —
// without it, a genuinely fresh segment from a just-spawned generation could be rejected.
const MTIME_STALE_TOLERANCE_MS = 2000;

// Tolerance is only safe to grant when the previous FFmpeg generation had enough of a
// head start that its own writes can't still be landing this close to the new spawn —
// otherwise a leftover segment from a RAPID respawn's prior run (retry loop, quick
// failure) can have an mtime that falls inside a fixed tolerance window purely because
// the two spawns happened close together, not because of clock skew. Below this gap,
// Layer 2 grants zero tolerance instead.
const MIN_SAFE_RESPAWN_GAP_MS = MTIME_STALE_TOLERANCE_MS * 2;

export interface ApplyStaleSegmentGuardOptions {
    responseContext: SegmentResponseContext;
    job: TranscodeJob;
    playSessionId: string;
    fileExists: boolean;
    isSegment: boolean;
    canSeek: boolean;
    actualSegmentIndex: number;
    requestedSegmentNum: number;
    segmentOffset: number;
    actualFilePath: string;
    sourceFilePath: string;
    segExt: string;
    streamDirName: string;
    isVideoTranscoded: boolean;
    staleProgressMargin: number;
    seekWaitTimeoutMs: number;
    seekPollIntervalMs: number;
    getSegmentOffset: (playSessionId: string) => number;
    getStreamSegmentOffset: (playSessionId: string, streamDirName: string) => number;
    statFile: (filePath: string) => Promise<{ mtimeMs: number }>;
    accessFile: (filePath: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
}

export interface ApplyStaleSegmentGuardResult {
    response?: Response;
    fileExists: boolean;
    actualFilePath: string;
}

export async function applyStaleSegmentGuard(
    options: ApplyStaleSegmentGuardOptions,
): Promise<ApplyStaleSegmentGuardResult> {
    let { fileExists, actualFilePath } = options;

    if (!fileExists || !options.isSegment || options.actualSegmentIndex < 0) {
        return { fileExists, actualFilePath };
    }

    // Layer 1: Progress-based stale detection. Skipped for canSeek (authoritative/video)
    // streams — their requested index always reflects the current state directly, with
    // no catch-up lag to account for. Non-authoritative streams (audio, following video)
    // can legitimately lag behind progress right after a seek, so they need this check.
    if (
        !options.canSeek &&
        options.actualSegmentIndex > options.job.segmentsReady + options.staleProgressMargin
    ) {
        fileExists = false;
        logger.info('Stale segment guard: rejecting file far beyond progress', {
            playSessionId: options.playSessionId,
            stream: options.streamDirName,
            requestedSegment: options.requestedSegmentNum,
            actualSegmentIndex: options.actualSegmentIndex,
            segmentsReady: options.job.segmentsReady,
            segmentOffset: options.segmentOffset,
        });
    }

    // Layer 2: File mtime check against current FFmpeg spawn time.
    // Files from a previous FFmpeg run have mtime < lastFFmpegSpawnTime.
    if (fileExists) {
        try {
            const stat = await options.statFile(actualFilePath);
            const previousSpawnTime = options.job.previousFFmpegSpawnTime ?? null;
            const spawnGapMs =
                previousSpawnTime === null
                    ? Number.POSITIVE_INFINITY
                    : options.job.lastFFmpegSpawnTime - previousSpawnTime;
            const effectiveTolerance =
                spawnGapMs > MIN_SAFE_RESPAWN_GAP_MS ? MTIME_STALE_TOLERANCE_MS : 0;
            if (stat.mtimeMs < options.job.lastFFmpegSpawnTime - effectiveTolerance) {
                fileExists = false;
                logger.info('Stale segment guard: file predates current FFmpeg run', {
                    playSessionId: options.playSessionId,
                    stream: options.streamDirName,
                    requestedSegment: options.requestedSegmentNum,
                    actualSegmentIndex: options.actualSegmentIndex,
                    fileMtime: stat.mtimeMs,
                    ffmpegSpawnTime: options.job.lastFFmpegSpawnTime,
                    segmentOffset: options.segmentOffset,
                });
            }
        } catch {
            // best-effort: stat failure means the segment isn't on disk yet — treat as absent.
            fileExists = false;
        }
    }

    // Layer 3: If a seek is in progress, wait briefly before serving. Skipped for canSeek
    // streams — this wait exists so non-authoritative streams can catch up to a seek the
    // authoritative (video) stream just triggered; the authoritative stream itself has no
    // one to wait for.
    if (fileExists && !options.canSeek && options.job.isSeeking) {
        const sleep =
            options.sleep ??
            ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const seekWaitStart = Date.now();
        while (options.job.isSeeking && Date.now() - seekWaitStart < options.seekWaitTimeoutMs) {
            await sleep(options.seekPollIntervalMs);
        }
        try {
            await options.accessFile(actualFilePath);
        } catch {
            // best-effort: access failure after seek wait means file not (yet) present.
            fileExists = false;
        }
    }

    // Layer 4: Re-read offset after potential seek. Skipped for canSeek streams — same
    // reasoning as Layer 3, this reconciles a non-authoritative stream's offset against a
    // seek the authoritative stream already applied to itself directly.
    if (fileExists && !options.canSeek) {
        const currentOffset = resolveCurrentOffset(options);

        if (currentOffset !== options.segmentOffset) {
            const newActualIndex = options.isVideoTranscoded
                ? options.requestedSegmentNum
                : translateToActualIndex(options.requestedSegmentNum, currentOffset);

            if (newActualIndex < 0) {
                return {
                    response: createSegmentNotFoundResponse(
                        {
                            ...options.responseContext,
                            segmentOffset: currentOffset,
                            actualSegmentIndex: newActualIndex,
                        },
                        'stale_guard_negative',
                        null,
                    ),
                    fileExists,
                    actualFilePath,
                };
            }

            actualFilePath = path.join(
                path.dirname(options.sourceFilePath),
                getSegmentFilename(newActualIndex, options.segExt),
            );
            fileExists = false;

            logger.info('Stale segment guard: offset changed during seek, recomputed path', {
                playSessionId: options.playSessionId,
                stream: options.streamDirName,
                requestedSegment: options.requestedSegmentNum,
                oldOffset: options.segmentOffset,
                newOffset: currentOffset,
                newActualIndex,
            });
        }
    }

    return { fileExists, actualFilePath };
}

function resolveCurrentOffset(options: ApplyStaleSegmentGuardOptions): number {
    if (options.job.generationRole === 'previous') {
        return options.segmentOffset;
    }

    return options.getStreamSegmentOffset(options.playSessionId, options.streamDirName);
}
