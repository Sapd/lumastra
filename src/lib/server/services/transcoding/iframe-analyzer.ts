// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * I-Frame Analyzer
 *
 * Handles background I-frame analysis for HLS segments.
 * Analyzes video segments using ffprobe to extract keyframe byte positions
 * for Apple TV clients that need byte-range seeking capabilities.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import type { TranscodeJob, IFrameEntry } from './types.js';
import { isRecord } from '$lib/utils/data-extraction';

const execAsync = promisify(exec);
const logger = Logger.for('IFrameAnalyzer');

/**
 * Cap on retained job.iframeData entries. Without a bound, a long unseeked play
 * (iframeData is only reset on seek) grows this array for the entire generation.
 * The sliding-window segment cleanup (file-manager.ts) already deletes on-disk
 * segments older than FFMPEG_SEGMENT_KEEP_BEHIND, so keyframe entries for those
 * already-deleted segments are stale anyway. The analyzed I-frame playlist
 * (iframe-handler.ts generateAnalyzedIFramePlaylist) iterates iframeData
 * sequentially and each entry is self-contained (segmentUri/byteOffset/byteSize/
 * duration) — nothing indexes into the array by position — so dropping the
 * oldest entries is safe and only trims scrub-back precision to entries still
 * on disk.
 */
const MAX_RETAINED_IFRAME_ENTRIES = 2000;

export class IFrameAnalyzer {
    /**
     * Start background I-frame analysis worker for a transcode job.
     * This runs asynchronously and updates job.iframeData as segments are analyzed.
     *
     * @param job The transcode job to analyze
     */
    startAnalysis(job: TranscodeJob): void {
        // Previews never build an analyzed I-frame (trickplay) playlist — they're
        // short, looped snippets with no scrubbing. Running the analyzer on them
        // just spawns a doomed `ffprobe -show_packets` per fMP4 segment (which
        // can't be parsed standalone → every call fails), wasting a subprocess
        // per segment on the hot preview path. Skip it entirely.
        if (job.config.isPreview) {
            return;
        }

        const videoStreamIndex = job.config.audioTracks.length;
        const streamDir = `stream_${videoStreamIndex}`;

        this.runAnalysis(job, streamDir).catch((error) => {
            logger.warn('I-frame analysis worker failed', {
                jobId: job.id,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    /**
     * Main analysis loop - watches for new segments and analyzes each one.
     * Runs until the job is stopped or all segments are analyzed.
     *
     * @param job The transcode job
     * @param streamDir The stream directory name (e.g., "stream_0")
     */
    private async runAnalysis(job: TranscodeJob, streamDir: string): Promise<void> {
        const streamPath = path.join(job.outputDir, streamDir);
        // Abort after N consecutive ffprobe failures — fMP4 segments are not
        // self-contained and ffprobe cannot read them without the init segment.
        const MAX_CONSECUTIVE_FAILURES = 5;
        let consecutiveFailures = 0;

        // Continue analyzing while job is active
        const shouldContinue = () =>
            job.status === 'running' || job.status === 'ready' || job.status === 'stopped';

        while (shouldContinue()) {
            const actualSegmentIndex = job.iframeAnalyzedCount;
            const segmentFile = `segment_${String(actualSegmentIndex).padStart(5, '0')}.m4s`;
            const segmentPath = path.join(streamPath, segmentFile);

            let segmentExists = false;
            try {
                // Check if segment exists
                await fs.access(segmentPath);
                segmentExists = true;

                // Analyze segment for keyframes
                const iframes = await this.analyzeSegmentForIFrames(
                    segmentPath,
                    job.segmentOffset + actualSegmentIndex,
                    `${streamDir}/${segmentFile}`,
                );

                // Update job state
                job.iframeData.push(...iframes);
                if (job.iframeData.length > MAX_RETAINED_IFRAME_ENTRIES) {
                    // Drop the oldest entries to bound memory on long unseeked plays.
                    job.iframeData.splice(0, job.iframeData.length - MAX_RETAINED_IFRAME_ENTRIES);
                }
                job.iframeAnalyzedCount++;

                if (iframes.length > 0) {
                    consecutiveFailures = 0;
                } else {
                    consecutiveFailures++;
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        logger.info(
                            'I-frame analysis stopped — ffprobe cannot read segments (likely fMP4 without init segment)',
                            {
                                jobId: job.id,
                                analyzedSegments: job.iframeAnalyzedCount,
                                consecutiveFailures,
                            },
                        );
                        break;
                    }
                }

                logger.debug('Analyzed segment for I-frames', {
                    jobId: job.id,
                    segment: actualSegmentIndex,
                    keyframeCount: iframes.length,
                });
            } catch {
                if (job.status === 'stopped' || job.status === 'error') {
                    break;
                }

                if (segmentExists) {
                    // The segment exists but ffprobe failed to analyze it — a corrupt
                    // segment, or (with the 15s exec timeout) a stalled/hung read.
                    // Retrying the SAME index would spin forever, churning a killed
                    // ffprobe every ~15s for the life of the job, so count it toward
                    // the bail-out and skip past the unreadable segment.
                    consecutiveFailures++;
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        logger.info('I-frame analysis stopped — segments failing to analyze', {
                            jobId: job.id,
                            analyzedSegments: job.iframeAnalyzedCount,
                            consecutiveFailures,
                        });
                        break;
                    }
                    job.iframeAnalyzedCount++;
                }

                // Wait 500ms and retry (segment may just not be ready yet)
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }

        job.iframeAnalysisComplete = true;

        logger.info('I-frame analysis completed', {
            jobId: job.id,
            totalSegments: job.iframeAnalyzedCount,
            totalKeyframes: job.iframeData.length,
        });
    }

    /**
     * Analyze a single segment file for I-frame (keyframe) positions.
     * Uses ffprobe to extract packet information and identify keyframes.
     *
     * @param segmentPath Absolute path to the segment file
     * @param timelineSegmentIndex Segment index in the overall timeline (includes offset)
     * @param segmentUri URI of the segment (e.g., "stream_0/segment_00042.m4s")
     * @returns Array of keyframe entries with byte positions
     */
    private async analyzeSegmentForIFrames(
        segmentPath: string,
        timelineSegmentIndex: number,
        segmentUri: string,
    ): Promise<IFrameEntry[]> {
        try {
            // Run ffprobe to get packet information for video stream
            const ffprobePath = config.FFPROBE_PATH || 'ffprobe';
            const { stdout } = await execAsync(
                `"${ffprobePath}" -select_streams v:0 -show_packets -show_entries packet=pos,size,flags,pts_time -print_format json "${segmentPath}" 2>/dev/null`,
                {
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large segments
                    timeout: 15000, // Bound stuck ffprobe (mid-write segment / stalled NFS mount)
                    killSignal: 'SIGKILL',
                },
            );

            const data: unknown = JSON.parse(stdout);
            const packets = isRecord(data) && Array.isArray(data.packets) ? data.packets : [];

            // Filter for keyframe packets (flags contains 'K')
            const keyframePackets = packets.filter((packet) => {
                if (!isRecord(packet)) return false;
                const flags = packet.flags;
                return typeof flags === 'string' && flags.includes('K');
            });

            // Map to IFrameEntry format
            const iframes: IFrameEntry[] = keyframePackets
                .map((packet) => {
                    if (!isRecord(packet)) return null;
                    const pos = packet.pos;
                    const size = packet.size;
                    const ptsTime = packet.pts_time;
                    if (
                        typeof pos !== 'string' ||
                        typeof size !== 'string' ||
                        typeof ptsTime !== 'string'
                    ) {
                        return null;
                    }
                    return {
                        segmentIndex: timelineSegmentIndex,
                        byteOffset: parseInt(pos, 10),
                        byteSize: parseInt(size, 10),
                        duration: parseFloat(ptsTime),
                        segmentUri,
                    };
                })
                .filter((entry): entry is IFrameEntry => entry !== null);

            return iframes;
        } catch (err) {
            logger.debug('Failed to analyze segment for I-frames', {
                segmentPath,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    /**
     * Stop I-frame analysis for a job.
     * This is a no-op since analysis runs in the background and checks job.status.
     *
     * @param job The transcode job
     */
    stopAnalysis(job: TranscodeJob): void {
        // Analysis loop checks job.status, so it will stop automatically
        // when job.status changes to 'stopped' or 'error'
        logger.debug('Stopping I-frame analysis', { jobId: job.id });
    }
}
