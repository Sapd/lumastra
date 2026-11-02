// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg Stats Cache
 *
 * Stores transient CPU/RAM resource usage for running FFmpeg jobs in Valkey
 * with a short TTL so stats auto-expire when the job stops.
 *
 * Key pattern: ffmpeg:stats:{jobId}
 * Value: JSON { cpuPercent, memoryMB, gpuVideoPercent, transcodeFps,
 *   transcodeSpeed, throttled, bufferAheadSeconds, slowReason,
 *   softwareFallbackFrom, timestamp }
 * TTL: 30 seconds (auto-expires when job stops publishing)
 *
 * This allows the web container to display resource usage for jobs running
 * on a separate worker container without requiring a database write per tick.
 */

import { cacheGet, cacheSet, cacheDel } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { SlowTranscodeReason } from './slow-transcode.js';

const logger = Logger.for('FFmpegStatsCache');

const STATS_TTL_SECONDS = 30;
const KEY_PREFIX = 'ffmpeg:stats:';

export interface JobResourceStats {
    cpuPercent?: number;
    memoryMB?: number;
    gpuVideoPercent?: number;
    /** FFmpeg's own progress readings — lets a pod that does not own the job
     *  show the player the same transcode progress as the owner would. */
    transcodeFps?: number;
    transcodeSpeed?: number;
    /** The transcode throttle has FFmpeg paused. */
    throttled?: boolean;
    /** Seconds FFmpeg is ahead of the newest segment the player requested. */
    bufferAheadSeconds?: number;
    /** The encode cannot keep up with real time (slow-transcode.ts). */
    slowReason?: SlowTranscodeReason;
    /** GPU encoder the job fell back from to software (no free encode session). */
    softwareFallbackFrom?: string;
    timestamp: number;
}

function statsKey(jobId: string): string {
    return `${KEY_PREFIX}${jobId}`;
}

/**
 * Write resource stats for a job to Valkey.
 * Called periodically by the worker container while the job is running.
 */
export async function publishJobStats(
    jobId: string,
    stats: Omit<JobResourceStats, 'timestamp'>,
): Promise<void> {
    try {
        const value: JobResourceStats = { ...stats, timestamp: Date.now() };
        await cacheSet(statsKey(jobId), JSON.stringify(value), STATS_TTL_SECONDS);
    } catch (error) {
        logger.debug('Failed to publish FFmpeg job stats to Valkey', {
            jobId,
            error: String(error),
        });
    }
}

/**
 * Read resource stats for a job from Valkey.
 * Called by the web container when building the admin job list.
 * Returns null if stats are unavailable or expired.
 */
export async function readJobStats(jobId: string): Promise<JobResourceStats | null> {
    try {
        const raw = await cacheGet(statsKey(jobId));
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>).timestamp !== 'number'
        ) {
            return null;
        }
        return parsed as JobResourceStats;
    } catch (error) {
        logger.debug('Failed to read FFmpeg job stats from Valkey', {
            jobId,
            error: String(error),
        });
        return null;
    }
}

/**
 * Delete resource stats for a job from Valkey.
 * Called when a job stops so stale stats do not linger until TTL.
 */
export async function deleteJobStats(jobId: string): Promise<void> {
    try {
        await cacheDel(statsKey(jobId));
    } catch (error) {
        logger.debug('Failed to delete FFmpeg job stats from Valkey', {
            jobId,
            error: String(error),
        });
    }
}
