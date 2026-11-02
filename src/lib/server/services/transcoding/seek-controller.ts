// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seek Controller
 *
 * Handles complex seeking logic for FFmpeg transcode jobs.
 * Manages the 4-variable state machine:
 * - job.isSeeking (concurrency control)
 * - job.segmentOffset (playback position)
 * - job.segmentsReady (progress counter)
 * - job.lastServedSegment / job.deletedUpTo (cleanup tracking)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Logger } from '../../utils/logger.js';
import type { TranscodeJob, SeekWaitResult } from './types.js';
import type { TranscodeFileManager } from './file-manager.js';
import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';
import { storeEndSegment } from '../hls/end-segment-cache.js';

const logger = Logger.for('SeekController');

export class SeekController {
    constructor(private fileManager: TranscodeFileManager) {}
    /**
     * Check if a seek can proceed for the target segment.
     *
     * @returns true if seek is allowed, false if already at target or seeking in progress
     */
    canSeek(job: TranscodeJob, targetSegmentIndex: number): boolean {
        // Check if target is already within produced output. Do not include a
        // speculative lookahead here: callers reaching seekToSegment() already
        // determined that waiting is undesirable. Treating future segments as
        // available causes long stalls while FFmpeg slowly catches up.
        if (
            job.segmentOffset <= targetSegmentIndex &&
            targetSegmentIndex < job.segmentOffset + job.segmentsReady
        ) {
            logger.debug('Target segment already available, no seek needed', {
                jobId: job.id,
                targetSegmentIndex,
                currentOffset: job.segmentOffset,
                segmentsReady: job.segmentsReady,
            });
            return false;
        }

        return true;
    }

    /**
     * Wait for any in-progress seek to complete.
     *
     * @param job The transcode job
     * @param targetSegmentIndex Target segment for logging
     * @returns 'proceed' if seek is still needed, 'covered' if target is now reachable, 'failed' if timeout or job stopped
     */
    async waitForSeekCompletion(
        job: TranscodeJob,
        targetSegmentIndex: number,
    ): Promise<SeekWaitResult> {
        if (!job.isSeeking) return 'proceed';

        logger.debug('Seek already in progress, waiting', {
            jobId: job.id,
            targetSegmentIndex,
        });

        // Wait for current seek to complete (max 5 seconds)
        const waitStart = Date.now();
        while (job.isSeeking && Date.now() - waitStart < 5000) {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }

        // Check if job was stopped during the wait
        if (job.status === 'stopped' || job.status === 'error') {
            logger.debug('Job stopped during seek wait', {
                jobId: job.id,
                status: job.status,
            });
            return 'failed';
        }

        // If still seeking after timeout, fail
        if (job.isSeeking) {
            logger.warn('Seek still in progress after wait', {
                jobId: job.id,
            });
            return 'failed';
        }

        // Check if the current offset now covers our target
        if (this.canSeek(job, targetSegmentIndex)) {
            return 'proceed';
        }

        // Target is now available after the wait
        logger.debug('Seek completed to nearby position, no need to re-seek', {
            jobId: job.id,
            targetSegmentIndex,
            currentOffset: job.segmentOffset,
        });
        return 'covered';
    }

    /**
     * Clean up existing segments and playlists before seek.
     *
     * Before deleting, pre-warms endSegmentCache with the last few segments
     * from each stream. hls.js probes the last VOD segment for BMDT timing
     * after a seek — without cached data it 404s and blocks playback.
     *
     * Delegates to FileManager to delete all segment files and playlists.
     * Preserves directory structure for FFmpeg restart.
     */
    async cleanupSegmentsForSeek(job: TranscodeJob): Promise<void> {
        // Pre-warm end-segment cache before deleting files.
        // Only needed if the cache is missing entries for any stream.
        if (job.config.totalDurationSeconds) {
            await this.warmEndSegmentCache(job);
        }

        await this.fileManager.clearSegmentFiles(job.outputDir);
    }

    /**
     * Cache actual tail segments (last 5 of the VOD timeline) from each stream.
     * hls.js probes the last VOD segment for BMDT/timing after seek.
     * Without this, the probe 404s and blocks playback entirely.
     *
     * Only caches segments that are genuinely near the end of the file —
     * mid-file segments have wrong BMDT and would confuse hls.js timeline.
     */
    private async warmEndSegmentCache(job: TranscodeJob): Promise<void> {
        const totalDuration = job.config.totalDurationSeconds;
        if (!totalDuration) return;
        // The cache is keyed by playlist index. Only a transcode (`-start_number`
        // = offset) or a generation from 0 names its files by that index; copy
        // generations renumber from 0 at their own start.
        const filesArePlaylistIndices =
            job.transcodeDecisionResult?.videoAction === 'transcode' ||
            (job.segmentOffset === 0 && !(job.config.startTimeSeconds ?? 0));
        if (!filesArePlaylistIndices) return;

        try {
            const entries = await fs.readdir(job.outputDir, {
                withFileTypes: true,
            });
            const streamDirs = entries.filter(
                (e) => e.isDirectory() && e.name.startsWith('stream_'),
            );

            for (const streamEntry of streamDirs) {
                const streamDir = streamEntry.name;

                // Compute per-stream total segments to validate tail position
                const streamDur =
                    job.streamTargetDurations.get(streamDir) || job.segmentDurationSeconds;
                const streamTotal = uniformSegmentCount(totalDuration, streamDur);

                const streamPath = path.join(job.outputDir, streamDir);
                try {
                    const files = await fs.readdir(streamPath);
                    const segExt = job.config.hlsOutput?.hlsContainer === 'mpegts' ? '.ts' : '.m4s';
                    const segmentFiles = files
                        .filter((f) => f.startsWith('segment_') && f.endsWith(segExt))
                        .sort();

                    if (segmentFiles.length === 0) continue;

                    // Only cache if the highest segment is actually near the end
                    const lastSegment = segmentFiles[segmentFiles.length - 1];
                    const lastIndex = parseInt(lastSegment.match(/(\d+)/)?.[1] ?? '-1');
                    if (lastIndex < streamTotal - 5) {
                        logger.debug('Skipping endSegmentCache warmup: segment not near tail', {
                            jobId: job.id,
                            stream: streamDir,
                            lastIndex,
                            streamTotal,
                        });
                        continue;
                    }

                    const lastSegmentPath = path.join(streamPath, lastSegment);
                    const buffer = await fs.readFile(lastSegmentPath);

                    storeEndSegment(
                        job.endSegmentCache,
                        streamDir,
                        { kind: 'segment', segmentIndex: lastIndex, buffer },
                        { totalSeconds: totalDuration, segmentSeconds: streamDur },
                    );
                    logger.info('Pre-warmed endSegmentCache with real tail segment', {
                        jobId: job.id,
                        stream: streamDir,
                        segment: lastSegment,
                        segmentIndex: lastIndex,
                        streamTotal,
                        size: buffer.length,
                    });
                } catch {
                    // Non-fatal — stream dir may be empty or inaccessible
                }
            }
        } catch {
            // Non-fatal — output dir may not exist yet
        }
    }

    /**
     * Update job state for seek.
     *
     * Resets all state variables to prepare for FFmpeg restart at new position.
     */
    prepareJobStateForSeek(
        job: TranscodeJob,
        targetSegmentIndex: number,
        seekTimeSeconds: number,
    ): void {
        // Update job state
        job.segmentOffset = targetSegmentIndex;
        job.config.startTimeSeconds = seekTimeSeconds;
        job.status = 'starting';
        job.masterPlaylistReady = false;
        job.segmentsReady = 0;
        job.lastServedSegment.clear();
        // The throttle's player position belongs to the old position too; the
        // player's next requests (from the new position) rebuild it.
        job.requestedMediaSeconds?.clear();

        // Clear deletedUpTo — after a seek, old tracking is invalid.
        // Do NOT pre-fill with segmentOffset: stale hls.js requests for old-position
        // segments arrive after seek and would hit isSegmentDeleted() → 410 → session
        // restart. Let them 404 naturally (file doesn't exist). The sliding window
        // cleanup starts from the first served segment (always >= segmentOffset).
        job.deletedUpTo.clear();

        // NOTE: endSegmentCache is intentionally NOT cleared on seek.
        // The cached end segments are needed for hls.js VOD duration probing — without
        // them, hls.js requests the last segment, gets 404 (FFmpeg hasn't produced it
        // from the new position yet), and blocks audio playback entirely.
        // The BMDT in cached end segments may differ from the new FFmpeg run's PTS
        // timeline, but hls.js handles this via timestampOffset adjustment.

        // NOTE: streamTargetDurations is intentionally NOT cleared here.
        // Target durations are intrinsic to the source media (e.g., video ~10s
        // in remux mode) and don't change between seeks.

        // Reset I-frame analysis data - old data is no longer valid after seek
        // The analysis worker will restart after spawnFFmpeg if needed
        job.iframeData = [];
        job.iframeAnalyzedCount = 0;
        job.iframeAnalysisComplete = job.config.isJellyfinTranscoded ?? false;

        // Increment seek counter for unique Jellyfin PlaySessionId
        // This forces Jellyfin to start a fresh transcode instead of continuing cached one
        job.seekCount++;
    }

    /**
     * Generate a new PlaySessionId for a seek operation.
     *
     * Each seek gets a unique session ID suffix to differentiate
     * FFmpeg restarts in logs and job tracking.
     */
    updatePlaySessionForSeek(job: TranscodeJob): { newPlaySessionId: string } {
        const originalPlaySessionId = job.config.playSessionId;

        // Remove any existing "_seek" suffix to get base ID
        const basePlaySessionId = originalPlaySessionId.replace(/_seek\d+$/, '');
        const newPlaySessionId = `${basePlaySessionId}_seek${job.seekCount}`;

        logger.debug('Creating new PlaySessionId for seek', {
            jobId: job.id,
            original: originalPlaySessionId,
            newSessionId: newPlaySessionId,
            seekCount: job.seekCount,
        });

        return { newPlaySessionId };
    }
}
