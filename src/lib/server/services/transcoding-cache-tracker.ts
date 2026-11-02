// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcoding Cache Tracker
 *
 * Tracks the size of the FFmpeg transcoding cache directory over time.
 * Provides current size and max size in the last 24 hours.
 *
 * The transcoding directory contains HLS segments from active transcode jobs.
 * Each job creates a subdirectory with segments that are cleaned up when the job ends.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config, features } from '../config';
import { Logger } from '../utils/logger';

const logger = Logger.for('TranscodingCacheTracker');

// Sample interval: 5 minutes
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

// Keep 24 hours of samples (288 samples at 5-minute intervals)
const MAX_SAMPLES = 288;

interface SizeSample {
    timestamp: number;
    sizeBytes: number;
}

export interface TranscodingCacheStats {
    enabled: boolean;
    path: string;
    exists: boolean;
    currentSizeBytes: number;
    currentSizeFormatted: string;
    activeJobs: number;
    maxSize24hBytes: number;
    maxSize24hFormatted: string;
    maxSize24hTimestamp: string | null;
    sampleCount: number;
}

/**
 * Recursively calculate directory size
 */
async function getDirectorySizeRecursive(
    dirPath: string,
): Promise<{ size: number; fileCount: number; dirCount: number }> {
    let size = 0;
    let fileCount = 0;
    let dirCount = 0;

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                dirCount++;
                const subStats = await getDirectorySizeRecursive(fullPath);
                size += subStats.size;
                fileCount += subStats.fileCount;
                dirCount += subStats.dirCount;
            } else if (entry.isFile()) {
                try {
                    const stat = await fs.stat(fullPath);
                    size += stat.size;
                    fileCount++;
                } catch {
                    // Skip files we can't stat
                }
            }
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return { size, fileCount, dirCount };
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

class TranscodingCacheTracker {
    private samples: SizeSample[] = [];
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private isRunning = false;

    /**
     * Start periodic sampling
     */
    start(): void {
        if (this.isRunning) return;

        // Only start if feature is enabled
        if (!features.ffmpegAvailable) {
            logger.debug('Transcoding cache tracker not started - feature disabled');
            return;
        }

        this.isRunning = true;

        // Take initial sample
        void this.takeSample();

        // Start periodic sampling
        this.intervalId = setInterval(() => {
            void this.takeSample();
        }, SAMPLE_INTERVAL_MS);

        logger.info('Transcoding cache tracker started', {
            sampleIntervalMinutes: SAMPLE_INTERVAL_MS / 60000,
            maxSamples: MAX_SAMPLES,
        });
    }

    /**
     * Stop periodic sampling
     */
    stop(): void {
        if (!this.isRunning) {
            return; // Never started, nothing to stop
        }

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
        logger.info('Transcoding cache tracker stopped');
    }

    /**
     * Take a size sample
     */
    private async takeSample(): Promise<void> {
        try {
            const transcodeDir = config.FFMPEG_TRANSCODE_DIR;
            const { size } = await getDirectorySizeRecursive(transcodeDir);

            const sample: SizeSample = {
                timestamp: Date.now(),
                sizeBytes: size,
            };

            this.samples.push(sample);

            // Trim oldest samples if over limit
            while (this.samples.length > MAX_SAMPLES) {
                this.samples.shift();
            }

            logger.debug('Transcoding cache sample taken', {
                sizeFormatted: formatBytes(size),
                sampleCount: this.samples.length,
            });
        } catch (error) {
            logger.error('Failed to take transcoding cache sample', error as Error);
        }
    }

    /**
     * Get current stats
     */
    async getStats(): Promise<TranscodingCacheStats> {
        const transcodeDir = config.FFMPEG_TRANSCODE_DIR;
        const enabled = features.ffmpegAvailable;

        if (!enabled) {
            return {
                enabled: false,
                path: transcodeDir,
                exists: false,
                currentSizeBytes: 0,
                currentSizeFormatted: '0 B',
                activeJobs: 0,
                maxSize24hBytes: 0,
                maxSize24hFormatted: '0 B',
                maxSize24hTimestamp: null,
                sampleCount: 0,
            };
        }

        // Get current size
        let exists = false;
        let currentSize = 0;
        let activeJobs = 0;

        try {
            const stat = await fs.stat(transcodeDir);
            exists = stat.isDirectory();

            if (exists) {
                const result = await getDirectorySizeRecursive(transcodeDir);
                currentSize = result.size;

                // Count top-level directories as active jobs
                const entries = await fs.readdir(transcodeDir, {
                    withFileTypes: true,
                });
                activeJobs = entries.filter((e) => e.isDirectory()).length;
            }
        } catch {
            // Directory doesn't exist
        }

        // Find max in last 24h from samples
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000;

        let maxSize24h = currentSize; // Current size is always considered
        let maxTimestamp = now;

        for (const sample of this.samples) {
            if (sample.timestamp >= cutoff && sample.sizeBytes > maxSize24h) {
                maxSize24h = sample.sizeBytes;
                maxTimestamp = sample.timestamp;
            }
        }

        return {
            enabled,
            path: transcodeDir,
            exists,
            currentSizeBytes: currentSize,
            currentSizeFormatted: formatBytes(currentSize),
            activeJobs,
            maxSize24hBytes: maxSize24h,
            maxSize24hFormatted: formatBytes(maxSize24h),
            maxSize24hTimestamp: new Date(maxTimestamp).toISOString(),
            sampleCount: this.samples.length,
        };
    }

    /**
     * Get sample history for charting (optional)
     */
    getSampleHistory(): SizeSample[] {
        return [...this.samples];
    }

    /**
     * Clear all samples (for testing)
     */
    clearSamples(): void {
        this.samples = [];
    }
}

// Singleton instance
export const transcodingCacheTracker = new TranscodingCacheTracker();
