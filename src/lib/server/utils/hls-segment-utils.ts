// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Segment Utilities
 *
 * Pure functions for segment path parsing, offset translation, and seek detection.
 * These are extracted from the multi-audio HLS endpoint for testability.
 */

import path from 'node:path';

/**
 * Parsed segment info from a path
 */
export interface SegmentInfo {
    streamDir: string;
    segmentIndex: number;
}

/**
 * Parse segment path to extract stream directory and segment index.
 * Matches .m4s and .ts segment files (not init segments or playlists).
 * Also matches muxed mode segments without a stream directory.
 *
 * @example
 * parseSegmentPath('stream_0/segment_00000.m4s') // { streamDir: 'stream_0', segmentIndex: 0 }
 * parseSegmentPath('stream_video/segment_00123.m4s') // { streamDir: 'stream_video', segmentIndex: 123 }
 * parseSegmentPath('stream_0/segment_00005.ts') // { streamDir: 'stream_0', segmentIndex: 5 }
 * parseSegmentPath('segment_00000.ts') // { streamDir: '', segmentIndex: 0 } (muxed mode)
 * parseSegmentPath('stream_0/init_0.mp4') // null (init segment)
 * parseSegmentPath('stream_0/index.m3u8') // null (playlist)
 */
export function parseSegmentPath(segmentPath: string): SegmentInfo | null {
    // Match stream directories like: stream_0, stream_video, stream_Ger_-_Dolby_Digital_-_51
    const demuxMatch = segmentPath.match(/^(stream_[^/]+)\/segment_(\d+)\.(?:m4s|ts)$/);
    if (demuxMatch) {
        const segmentIndex = parseInt(demuxMatch[2], 10);
        if (segmentIndex > 999999) return null;
        return {
            streamDir: demuxMatch[1],
            segmentIndex,
        };
    }

    // Muxed mode: segments directly in output dir (no stream_ prefix)
    const muxedMatch = segmentPath.match(/^segment_(\d+)\.(?:m4s|ts)$/);
    if (muxedMatch) {
        const segmentIndex = parseInt(muxedMatch[1], 10);
        if (segmentIndex > 999999) return null;
        return {
            streamDir: '',
            segmentIndex,
        };
    }

    return null;
}

/**
 * Extract segment number from any segment path (including .ts files).
 * More permissive than parseSegmentPath - just extracts the number.
 *
 * @returns The segment number or -1 if not found
 */
export function extractSegmentNumber(path: string): number {
    const match = path.match(/segment_(\d+)/);
    return match ? parseInt(match[1], 10) : -1;
}

/**
 * Translate a requested segment index to the actual file index on disk.
 * After a seek, FFmpeg creates segments starting from 0, but they represent
 * a later position in the video.
 *
 * @example
 * translateToActualIndex(500, 500) // 0 (first segment after seek to 500)
 * translateToActualIndex(510, 500) // 10
 * translateToActualIndex(100, 500) // -400 (backward seek needed)
 * translateToActualIndex(50, 0) // 50 (no offset)
 */
export function translateToActualIndex(requestedIndex: number, segmentOffset: number): number {
    return requestedIndex - segmentOffset;
}

/**
 * Check if a backward seek should be triggered.
 * A backward seek is needed when the requested segment is before the current offset.
 *
 * @returns true if FFmpeg should restart from the requested position
 */
export function shouldTriggerBackwardSeek(requestedIndex: number, segmentOffset: number): boolean {
    return requestedIndex >= 0 && requestedIndex < segmentOffset;
}

/**
 * Check if a forward seek (far-ahead) should be triggered.
 * A forward seek restarts FFmpeg from the new position instead of waiting.
 *
 * @param requestedIndex - The segment number requested by the player
 * @param currentProgress - Current transcoding progress (segmentsReady + segmentOffset)
 * @param farSeekThreshold - How many segments ahead triggers a re-transcode (default 50)
 * @returns true if FFmpeg should restart from the requested position
 */
export function shouldTriggerForwardSeek(
    requestedIndex: number,
    currentProgress: number,
    farSeekThreshold: number = 50,
): boolean {
    const segmentsAhead = requestedIndex - currentProgress;
    return segmentsAhead > farSeekThreshold;
}

/**
 * Generate the actual segment filename on disk given a segment number.
 *
 * @example
 * getSegmentFilename(0) // 'segment_00000.m4s'
 * getSegmentFilename(123) // 'segment_00123.m4s'
 * getSegmentFilename(0, 'ts') // 'segment_00000.ts'
 */
export function getSegmentFilename(segmentIndex: number, extension: string = 'm4s'): string {
    return `segment_${segmentIndex.toString().padStart(5, '0')}.${extension}`;
}

/**
 * Calculate seek time in seconds from a segment index.
 *
 * @param segmentIndex - The segment number to seek to
 * @param segmentDuration - Duration of each segment in seconds (default 6)
 */
export function calculateSeekTime(segmentIndex: number, segmentDuration: number = 6): number {
    return segmentIndex * segmentDuration;
}

/**
 * Check if a segment should be considered deleted.
 * This checks against the actual file index (after offset translation).
 *
 * @param actualIndex - The actual segment index on disk (after offset translation)
 * @param deletedUpTo - The highest segment index that has been deleted (-1 if none)
 * @returns true if the segment was deleted by sliding window cleanup
 */
export function isSegmentDeleted(actualIndex: number, deletedUpTo: number): boolean {
    // Segments with negative actual index are before the offset,
    // they should trigger backward seek, not be considered deleted
    if (actualIndex < 0) return false;

    return actualIndex <= deletedUpTo;
}

/**
 * Calculate the deletion threshold for sliding window cleanup.
 *
 * @param lastServedIndex - The highest segment index that was served
 * @param keepBehind - Number of segments to keep behind playback position
 * @returns The threshold - segments below this should be deleted
 */
export function calculateDeletionThreshold(lastServedIndex: number, keepBehind: number): number {
    return lastServedIndex - keepBehind;
}

/**
 * Validate a segment request path for security.
 * Checks for path traversal attempts.
 *
 * @returns true if the path is safe
 */
export function isPathSafe(normalizedPath: string): boolean {
    return !normalizedPath.includes('..');
}

/**
 * Check if a file path is contained within a directory.
 * Resolves both paths to prevent path traversal attacks.
 *
 * @returns true if filePath is inside (or equal to) directory
 */
export function isPathInsideDirectory(filePath: string, directory: string): boolean {
    const relativePath = path.relative(path.resolve(directory), path.resolve(filePath));
    return (
        relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
    );
}

/**
 * Check if a seek should be suppressed due to cooldown.
 *
 * After a seek, HLS.js may still fire segment requests for the old playback
 * position. These stale requests would trigger conflicting seeks (forward ↔ backward
 * ping-pong), killing FFmpeg repeatedly. This function suppresses seeks that are
 * both recent (within cooldown) AND far from the current offset (stale old-position).
 *
 * Short seeks (distance ≤ threshold) are always allowed — they represent
 * legitimate user intent (small rewind/skip).
 *
 * @param lastSeekTime - Timestamp of the last seek (undefined if no seek yet)
 * @param now - Current timestamp (Date.now())
 * @param cooldownMs - Cooldown window in milliseconds
 * @param distance - Absolute distance from current segment offset to requested segment
 * @param threshold - Distance threshold — seeks within this are always allowed
 * @returns true if the seek should be suppressed (return 404 to client)
 */
export function isSeekOnCooldown(
    lastSeekTime: number | undefined,
    now: number,
    cooldownMs: number,
    distance: number,
    threshold: number,
): boolean {
    if (lastSeekTime === undefined) return false;
    const elapsed = now - lastSeekTime;
    if (elapsed >= cooldownMs) return false;
    return distance > threshold;
}
