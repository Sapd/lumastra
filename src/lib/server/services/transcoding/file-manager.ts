// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Transcode File Manager
 *
 * Handles all filesystem operations for FFmpeg transcode jobs:
 * - Output directory creation and cleanup
 * - Sliding window segment cleanup
 * - Startup cleanup of stale directories
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import type { TranscodeJob } from './types.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { sessionKey } from './session-key.js';

const logger = Logger.for('TranscodeFileManager');

/**
 * How long a non-persistable session's output directory (preview sessions, whose
 * ids are not UUIDs and so never reach active_transcode_jobs) is assumed to
 * possibly still be in use. Preview clips are short; anything older than this
 * was abandoned by a pod that died without cleaning up.
 */
const UNPERSISTED_SESSION_GRACE_MS = 60 * 60 * 1000;

export class TranscodeFileManager {
    /**
     * Age of a directory from its mtime, or null if it cannot be stat'ed
     * (treated by callers as "unknown", which must not preserve it forever).
     */
    private async directoryAgeMs(dirPath: string): Promise<number | null> {
        try {
            const stats = await fs.stat(dirPath);
            return Date.now() - stats.mtimeMs;
        } catch {
            return null;
        }
    }

    private async removeDirectoryWithRetries(
        dirPath: string,
        context: 'generation' | 'session',
    ): Promise<void> {
        const retryableCodes = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
        let lastError: unknown;

        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await fs.rm(dirPath, { recursive: true, force: true });
                return;
            } catch (err) {
                lastError = err;
                const code =
                    typeof err === 'object' &&
                    err !== null &&
                    'code' in err &&
                    typeof (err as { code?: unknown }).code === 'string'
                        ? (err as { code: string }).code
                        : undefined;

                if (!code || !retryableCodes.has(code) || attempt === 5) {
                    logger.warn('Failed to cleanup transcode output', {
                        outputDir: dirPath,
                        context,
                        attempt,
                        error: String(err),
                    });
                    return;
                }

                await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
            }
        }

        if (lastError) {
            logger.warn('Failed to cleanup transcode output', {
                outputDir: dirPath,
                context,
                error: String(lastError),
            });
        }
    }

    /**
     * Clear stale transcode directories on startup.
     *
     * Each session's output lives in a subdirectory named after its
     * playSessionId, so a directory can be matched back to a DB job row.
     *
     * `preserveSessionIds` MUST carry every play session that still has a live
     * transcode row. FFMPEG_TRANSCODE_DIR is shared across the web replicas and
     * the worker in a multi-instance deployment (that sharing is what lets a
     * peer restore a job after a rolling recreate), so an unconditional wipe
     * here does not just drop this pod's leftovers — it deletes the segments of
     * sessions another pod is actively streaming, killing every live playback
     * on the host each time any container boots.
     *
     * @param preserveSessionIds - play session ids whose directories must be kept
     */
    async clearTranscodeDirectory(
        preserveSessionIds: ReadonlySet<string> = new Set(),
    ): Promise<void> {
        try {
            const transcodeDir = config.FFMPEG_TRANSCODE_DIR;

            // Check if directory exists
            try {
                await fs.access(transcodeDir);
            } catch {
                // Directory doesn't exist, nothing to clean
                logger.debug('Transcode directory does not exist, skipping cleanup', {
                    transcodeDir,
                });
                return;
            }

            // Read directory contents
            const entries = await fs.readdir(transcodeDir, {
                withFileTypes: true,
            });
            let removedCount = 0;
            let preservedCount = 0;
            // The live ids come from a uuid column (dashed, lowercase); a
            // directory keeps the client's spelling (iOS uppercase, /j dashless).
            const preserveKeys = new Set(Array.from(preserveSessionIds, sessionKey));

            for (const entry of entries) {
                // Only remove directories (each transcode job creates a subdirectory)
                if (entry.isDirectory()) {
                    if (preserveKeys.has(sessionKey(entry.name))) {
                        preservedCount++;
                        continue;
                    }
                    const dirPath = path.join(transcodeDir, entry.name);

                    // Not every session under this directory is persistable.
                    // Non-cache preview sessions use a `preview-<id>-<ts>-<hex>`
                    // play session id, and the persistence layer only writes
                    // UUID-keyed rows — so such a directory can NEVER appear in
                    // the liveness set, and its absence there says nothing about
                    // whether a viewer is streaming it right now. Fall back to
                    // age for those: recent means possibly live (keep), old
                    // enough means certainly abandoned (remove), which still
                    // bounds the disk they can occupy.
                    // A dashless (/j) directory is persistable now, but a pod
                    // still running the previous build writes no row for one,
                    // and the transcode dir is shared — so it keeps the same
                    // age fallback rather than being wiped mid-rollout.
                    if (!UUID_RE.test(entry.name)) {
                        const ageMs = await this.directoryAgeMs(dirPath);
                        if (ageMs !== null && ageMs < UNPERSISTED_SESSION_GRACE_MS) {
                            preservedCount++;
                            continue;
                        }
                    }

                    try {
                        await fs.rm(dirPath, { recursive: true, force: true });
                        removedCount++;
                    } catch (err) {
                        logger.warn('Failed to remove stale transcode directory', {
                            path: dirPath,
                            error: String(err),
                        });
                    }
                }
            }

            if (removedCount > 0 || preservedCount > 0) {
                logger.info('Cleared stale transcode directories on startup', {
                    transcodeDir,
                    removedCount,
                    // Non-zero here on a rolling deploy is the healthy case: a
                    // peer's live sessions were left alone.
                    preservedCount,
                });
            } else {
                logger.debug('No stale transcode directories to remove');
            }
        } catch (err) {
            logger.error('Error cleaning transcode directory', err as Error);
        }
    }

    /**
     * Create output directory for a transcode job.
     * Creates parent directories if needed.
     */
    async createOutputDirectory(outputDir: string): Promise<void> {
        try {
            await fs.mkdir(outputDir, { recursive: true });
        } catch (err) {
            logger.error('Failed to create output directory', err as Error, {
                outputDir,
            });
            throw err;
        }
    }

    /**
     * Delete output directory for a transcode job.
     * Used during cleanup and job termination.
     */
    async deleteOutputDirectory(outputDir: string): Promise<void> {
        await this.removeDirectoryWithRetries(outputDir, 'generation');
    }

    /**
     * Is the output already a finished clip that needs no FFmpeg at all?
     *
     * FFmpeg terminates a media playlist it has finished writing with
     * `#EXT-X-ENDLIST`, so that tag — on EVERY stream, not just the first — is
     * the authoritative "there is nothing left to produce" signal.
     *
     * Prod 2026-08-28 (South Harbor S11E8): a restore respawned FFmpeg over a job
     * whose 133 segments were already on disk, rewriting them from index 0
     * underneath a client that was mid-playback. `segmentsReady` went
     * 133 -> 0 -> 133, segment requests blocked ~8s, and the picture froze while
     * audio — buffered a segment or two further ahead — played straight through
     * it, so the freeze looked like a client bug rather than a server restart.
     *
     * Deliberately conservative: unreadable directory, no stream manifests, or
     * any stream still growing all answer `false`, because a needless restart is
     * merely wasteful whereas skipping a NEEDED one would strand the session
     * with segments that never arrive.
     */
    async isOutputComplete(outputDir: string): Promise<boolean> {
        let entries;
        try {
            entries = await fs.readdir(outputDir, { withFileTypes: true });
        } catch {
            return false;
        }

        // The master is what the player asks for first, and its presence is
        // reported as `masterPlaylistReady`; adopting an output without one
        // would publish a readiness that is not true.
        if (!entries.some((entry) => !entry.isDirectory() && entry.name === 'master.m3u8')) {
            return false;
        }

        const streamDirs = entries
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('stream_'))
            .map((entry) => entry.name);

        if (streamDirs.length === 0) return false;

        for (const streamDir of streamDirs) {
            let manifest: string;
            try {
                manifest = String(
                    await fs.readFile(path.join(outputDir, streamDir, 'index.m3u8'), 'utf8'),
                );
            } catch {
                return false;
            }
            if (!manifest.includes('#EXT-X-ENDLIST')) return false;
        }

        return true;
    }

    /**
     * Remove a session directory if it no longer contains any generation output.
     */
    async cleanupSessionDirectory(sessionDir: string): Promise<void> {
        try {
            const entries = await fs.readdir(sessionDir, {
                withFileTypes: true,
            });
            const hasGenerationDirs = entries.some(
                (entry) => entry.isDirectory() && entry.name.startsWith('gen-'),
            );
            if (!hasGenerationDirs) {
                await this.removeDirectoryWithRetries(sessionDir, 'session');
            }
        } catch {
            // Session dir may already be gone
        }
    }

    /**
     * Clear all segment files and playlists from output directory.
     * Used during seek operations to prepare for FFmpeg restart.
     *
     * Preserves the directory structure (outputDir and stream_* subdirectories)
     * but removes all segment files and playlists.
     */
    async clearSegmentFiles(outputDir: string): Promise<void> {
        try {
            const entries = await fs.readdir(outputDir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                if (entry.isDirectory() && entry.name.startsWith('stream_')) {
                    // Delete all segment files in stream directory
                    const streamDir = path.join(outputDir, entry.name);
                    const files = await fs.readdir(streamDir);
                    for (const file of files) {
                        if (file.startsWith('segment_') || file.startsWith('init_')) {
                            await fs.unlink(path.join(streamDir, file)).catch(() => {
                                /* Cleanup errors are non-fatal */
                            });
                        }
                    }
                } else if (
                    entry.isFile() &&
                    (entry.name.startsWith('segment_') || entry.name.startsWith('init_'))
                ) {
                    // Muxed mode: segments directly in outputDir
                    await fs.unlink(path.join(outputDir, entry.name)).catch(() => {
                        /* Cleanup errors are non-fatal */
                    });
                }
            }

            // Also delete playlists
            await fs.unlink(path.join(outputDir, 'master.m3u8')).catch(() => {
                /* Cleanup errors are non-fatal */
            });
            await fs.unlink(path.join(outputDir, 'index.m3u8')).catch(() => {
                /* Cleanup errors are non-fatal */
            });

            logger.debug('Cleared segment files from output directory', {
                outputDir,
            });
        } catch (err) {
            logger.warn('Error clearing segment files', {
                outputDir,
                error: String(err),
            });
        }
    }

    /**
     * Sliding window segment cleanup - delete old segments to maintain constant disk usage.
     *
     * Strategy:
     * - Keep N segments (FFMPEG_SEGMENT_KEEP_BEHIND) behind the playback position
     * - Delete older segments to free disk space
     *
     * This keeps disk usage roughly constant regardless of video length.
     */
    async slidingWindowCleanup(job: TranscodeJob): Promise<void> {
        const keepBehind = config.FFMPEG_SEGMENT_KEEP_BEHIND;

        // If no segments have been served yet, nothing to clean
        if (job.lastServedSegment.size === 0) return;

        const segExt = job.config.hlsOutput?.hlsContainer === 'mpegts' ? 'ts' : 'm4s';
        const isMuxed = job.config.hlsOutput?.hlsAudioMode === 'muxed';
        let totalDeleted = 0;

        try {
            // Collect stream directories to clean
            // In muxed mode, segments are directly in outputDir (streamDir = '')
            // In demux mode, segments are in stream_N/ subdirectories
            const streamEntries: Array<{
                streamDir: string;
                streamPath: string;
            }> = [];

            if (isMuxed) {
                // Muxed mode: segments in outputDir root, tracked under streamDir ''
                streamEntries.push({
                    streamDir: '',
                    streamPath: job.outputDir,
                });
            } else {
                const entries = await fs.readdir(job.outputDir, {
                    withFileTypes: true,
                });
                for (const e of entries) {
                    if (e.isDirectory() && e.name.startsWith('stream_')) {
                        streamEntries.push({
                            streamDir: e.name,
                            streamPath: path.join(job.outputDir, e.name),
                        });
                    }
                }
            }

            // Use the MINIMUM lastServedSegment across all streams as cleanup reference.
            // Safari aggressively pre-fetches audio far ahead of video (audio at segment ~900
            // while video is at ~500). Using per-stream thresholds causes audio segments near
            // the actual playback position to be deleted, breaking rendition switching.
            let minLastServed: number | undefined;
            for (const { streamDir } of streamEntries) {
                const lastServed = job.lastServedSegment.get(streamDir);
                if (lastServed === undefined) {
                    // If ANY stream hasn't been served yet, don't clean anything
                    minLastServed = undefined;
                    break;
                }
                if (minLastServed === undefined || lastServed < minLastServed) {
                    minLastServed = lastServed;
                }
            }

            for (const { streamDir, streamPath } of streamEntries) {
                if (minLastServed === undefined || minLastServed < keepBehind) {
                    // Not enough segments served across all streams to start cleaning
                    continue;
                }

                // Calculate threshold using the minimum position across all renditions
                const deleteThreshold = minLastServed - keepBehind;

                // Get current deletedUpTo for this stream
                const currentDeletedUpTo = job.deletedUpTo.get(streamDir) ?? -1;

                // Only delete segments we haven't already deleted
                if (deleteThreshold <= currentDeletedUpTo) continue;

                // Delete segments from (currentDeletedUpTo + 1) to (deleteThreshold - 1)
                for (let i = currentDeletedUpTo + 1; i < deleteThreshold; i++) {
                    const segmentFile = `segment_${i.toString().padStart(5, '0')}.${segExt}`;
                    const segmentPath = path.join(streamPath, segmentFile);

                    try {
                        await fs.unlink(segmentPath);
                        totalDeleted++;
                    } catch {
                        // File might not exist or already deleted - that's fine
                    }
                }

                // Update deletedUpTo marker
                job.deletedUpTo.set(streamDir, deleteThreshold - 1);
            }

            if (totalDeleted > 0) {
                logger.debug('Cleaned up old segments', {
                    jobId: job.id,
                    deletedCount: totalDeleted,
                    playbackPositions: Object.fromEntries(job.lastServedSegment),
                    deletedUpTo: Object.fromEntries(job.deletedUpTo),
                });
            }
        } catch (error) {
            // Don't fail if cleanup has issues - it's just optimization
            logger.debug('Segment cleanup error (non-fatal)', {
                jobId: job.id,
                error: String(error),
            });
        }
    }
}
