// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Synthetic I-Frame Utilities
 *
 * Extracts individual thumbnails from Jellyfin trickplay sprite sheets
 * and encodes them as single-frame H.264 video segments for HLS I-frame playlists.
 *
 * This approach avoids byte-range issues with native I-frames and works
 * independently of transcode progress.
 *
 * Caching Strategy:
 *
 * 1. Temp file: FFmpeg requires file output for faststart/moov atom optimization
 * 2. Immediate cleanup: File deleted right after reading into memory
 * 3. Memory cache: LRU cache (2000 entries, 1h TTL) in synthetic-iframe.ts handles repeat requests
 *
 * Disk caching in transcoding directory was considered but not needed:
 * - I-frames are small (~5-20KB each)
 * - Memory cache is sufficient for repeat requests during scrubbing
 * - Disk would add I/O overhead without benefit
 */

import { Logger } from './logger.js';
import { AsyncSemaphore } from './async-semaphore.js';
import { spawnFFmpegSafely } from './ffmpeg-spawn.js';
import { DEFAULT_HLS_VERSION, PLAYLIST_TYPE, HlsPlaylistBuilder } from './hls-definitions.js';

const logger = Logger.for('SyntheticIFrame');

// Limit concurrent FFmpeg processes to prevent resource exhaustion
// AVPlayer may request many I-frames simultaneously during aggressive scrubbing
const ffmpegSemaphore = new AsyncSemaphore(4);

// Timeout for FFmpeg encoding (milliseconds)
// Single-frame encoding should complete in under 1 second, 10s is generous
const FFMPEG_TIMEOUT_MS = 10000;

/**
 * Trickplay metadata needed for I-frame generation
 */
export interface TrickplayMetadata {
    /** Width of each individual thumbnail in pixels */
    width: number;
    /** Height of each individual thumbnail in pixels */
    height: number;
    /** Number of tiles per row in sprite sheet */
    tileWidth: number;
    /** Number of tiles per column in sprite sheet */
    tileHeight: number;
    /** Interval between thumbnails in milliseconds */
    intervalMs: number;
    /** Total number of thumbnails available */
    thumbnailCount: number;
}

/**
 * Calculate which sprite sheet and position within it for a given I-frame index.
 *
 * @param iframeIndex - The I-frame index (0-based)
 * @param trickplay - Trickplay metadata
 * @returns Object with sheetIndex, row, col, and thumbnailIndex
 */
export function calculateSpritePosition(
    iframeIndex: number,
    trickplay: TrickplayMetadata,
): { sheetIndex: number; row: number; col: number; thumbnailIndex: number } {
    const tilesPerSheet = trickplay.tileWidth * trickplay.tileHeight;
    const sheetIndex = Math.floor(iframeIndex / tilesPerSheet);
    const positionInSheet = iframeIndex % tilesPerSheet;
    const row = Math.floor(positionInSheet / trickplay.tileWidth);
    const col = positionInSheet % trickplay.tileWidth;

    return {
        sheetIndex,
        row,
        col,
        thumbnailIndex: iframeIndex,
    };
}

/**
 * Extract a single thumbnail from a sprite sheet using sharp.
 *
 * @param spriteSheet - The full sprite sheet image buffer (JPEG)
 * @param col - Column position (0-based)
 * @param row - Row position (0-based)
 * @param tileWidth - Width of each tile
 * @param tileHeight - Height of each tile
 * @returns Extracted thumbnail as JPEG buffer
 */
export async function extractThumbnailFromSprite(
    spriteSheet: Buffer,
    col: number,
    row: number,
    tileWidth: number,
    tileHeight: number,
): Promise<Buffer> {
    // Dynamically import sharp to avoid SSR issues
    const sharp = (await import('sharp')).default;

    const left = col * tileWidth;
    const top = row * tileHeight;

    const extracted = await sharp(spriteSheet)
        .extract({
            left,
            top,
            width: tileWidth,
            height: tileHeight,
        })
        .jpeg({ quality: 90 })
        .toBuffer();

    return extracted;
}

/**
 * Encode a JPEG thumbnail as a self-contained single-frame MP4.
 *
 * Uses FFmpeg to create a complete MP4 that AVPlayer can decode independently.
 * Each segment is fully self-contained with its own ftyp+moov+mdat.
 * Uses temp file to allow faststart (moov at beginning) for best compatibility.
 *
 * @param thumbnail - JPEG thumbnail buffer
 * @param width - Output video width
 * @param height - Output video height
 * @param duration - Duration of this I-frame in seconds (for the EXTINF value, used by player)
 * @returns Complete MP4 buffer (ftyp + moov + mdat) ready for HLS I-frame streaming
 */
export async function encodeThumbnailToIFrame(
    thumbnail: Buffer,
    width: number,
    height: number,
    _duration: number = 10,
    startTimeSeconds: number = 0,
): Promise<Buffer> {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');

    // Create unique temp file path
    const tempFile = path.join(
        os.tmpdir(),
        `iframe_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`,
    );

    // Use semaphore to limit concurrent FFmpeg processes
    return ffmpegSemaphore.withPermit(async () => {
        try {
            // Create single-frame MPEG-TS segment
            // TS is self-contained (includes PAT/PMT/SPS/PPS) - no EXT-X-MAP needed
            // This is the original HLS format and works reliably with AVPlayer
            //
            // CRITICAL: Set -output_ts_offset to the correct position in the video!
            // Without this, all segments have PTS=0 and AVPlayer shows the same frame.
            // Each segment needs PTS matching its position (e.g., segment 42 at 10s intervals = 420s PTS)
            const args = [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'image2pipe',
                '-framerate',
                '1',
                '-i',
                '-',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-profile:v',
                'baseline',
                '-level',
                '3.0',
                '-tune',
                'stillimage',
                '-preset',
                'ultrafast',
                '-crf',
                '23',
                '-frames:v',
                '1',
                // The mpegts muxer applies a default 1.4s initial PTS offset on top
                // of -output_ts_offset, so a segment asked for 420s was written at
                // 421.4s — every thumbnail sat 1.4s off the position the I-frame
                // playlist declares for it. Zero both so the PTS is exactly the
                // requested time. (Verified against preprod: 0/420/1230 came back
                // as 1.4/421.4/1231.4 before this.)
                '-muxdelay',
                '0',
                '-muxpreload',
                '0',
                '-output_ts_offset',
                String(startTimeSeconds), // Set PTS to correct timeline position
                '-f',
                'mpegts', // MPEG-TS format - self-contained
                '-y',
                tempFile,
            ];

            // Spawn FFmpeg with safe wrapper
            await spawnFFmpegSafely({
                args,
                stdin: thumbnail,
                timeout: FFMPEG_TIMEOUT_MS,
                context: {
                    operation: 'synthetic-iframe',
                    startTimeSeconds,
                    thumbnailSize: thumbnail.length,
                },
            });

            // Read the generated file
            const output = await fs.readFile(tempFile);

            logger.debug('Generated self-contained I-frame', {
                size: output.length,
                startTimeSeconds,
                thumbnailSize: thumbnail.length,
            });

            return output;
        } finally {
            // Clean up temp file
            try {
                await fs.unlink(tempFile);
            } catch {
                // Ignore cleanup errors
            }
        }
    });
}

/**
 * Generate a synthetic I-frame segment from trickplay data.
 *
 * @param spriteSheet - The sprite sheet buffer (already fetched)
 * @param iframeIndex - Which I-frame to generate (0-based)
 * @param trickplay - Trickplay metadata
 * @returns MP4 buffer ready for HLS I-frame streaming
 */
export async function generateSyntheticIFrame(
    spriteSheet: Buffer,
    iframeIndex: number,
    trickplay: TrickplayMetadata,
): Promise<Buffer> {
    // Calculate position in sprite sheet
    const pos = calculateSpritePosition(iframeIndex, trickplay);

    logger.debug('Generating synthetic I-frame', {
        iframeIndex,
        sheetIndex: pos.sheetIndex,
        position: `${pos.col},${pos.row}`,
        spriteSheetSize: spriteSheet.length,
        trickplay: {
            width: trickplay.width,
            height: trickplay.height,
            tileWidth: trickplay.tileWidth,
            tileHeight: trickplay.tileHeight,
            thumbnailCount: trickplay.thumbnailCount,
        },
    });

    // Extract the thumbnail
    const thumbnail = await extractThumbnailFromSprite(
        spriteSheet,
        pos.col,
        pos.row,
        trickplay.width,
        trickplay.height,
    );

    logger.debug('Extracted thumbnail', {
        iframeIndex,
        thumbnailSize: thumbnail.length,
    });

    // Calculate the start time for this I-frame based on its index
    const startTimeSeconds = (iframeIndex * trickplay.intervalMs) / 1000;

    // Encode as single-frame video with correct timestamp
    const duration = trickplay.intervalMs / 1000;
    const iframeSegment = await encodeThumbnailToIFrame(
        thumbnail,
        trickplay.width,
        trickplay.height,
        duration,
        startTimeSeconds,
    );

    logger.debug('Generated synthetic I-frame', {
        iframeIndex,
        startTimeSeconds,
        thumbnailSize: thumbnail.length,
        outputSize: iframeSegment.length,
    });

    return iframeSegment;
}

/**
 * Generate HLS I-frame playlist for synthetic I-frames.
 *
 * Creates a #EXT-X-I-FRAMES-ONLY playlist that references iframe_XXXXX.m4s segments.
 * Each segment is a complete file (no byte-range needed).
 *
 * The playlist can skip trickplay thumbnails to achieve a target interval (e.g., 30s)
 * for better performance. The segment filename encodes the ACTUAL thumbnail index,
 * so the segment handler doesn't need any special logic.
 *
 * @param trickplay - Trickplay metadata
 * @param totalDurationSeconds - Total video duration
 * @param segmentBase - Base URL for segment references
 * @param queryParams - Query parameters to append to segment URLs
 * @param targetIntervalSeconds - Target interval between I-frames (default: use trickplay interval)
 * @returns HLS I-frame playlist content
 */
export function generateSyntheticIFramePlaylist(
    trickplay: TrickplayMetadata,
    totalDurationSeconds: number,
    segmentBase: string,
    queryParams?: string,
    targetIntervalSeconds?: number,
): string {
    const querySuffix = queryParams ? `?${queryParams}` : '';
    const trickplayIntervalSec = trickplay.intervalMs / 1000;

    // Calculate skip factor to achieve target interval
    // E.g., trickplay at 10s, target 30s → skip every 3rd thumbnail (skip factor = 3)
    const skipFactor = targetIntervalSeconds
        ? Math.max(1, Math.round(targetIntervalSeconds / trickplayIntervalSec))
        : 1;

    // Actual interval after applying skip factor
    const actualIntervalSec = trickplayIntervalSec * skipFactor;

    // Calculate how many I-frames we'll have after skipping
    const availableThumbnails = Math.ceil(trickplay.thumbnailCount / skipFactor);
    const iframesFromDuration = Math.ceil(totalDurationSeconds / actualIntervalSec);
    const iframeCount = Math.min(iframesFromDuration, availableThumbnails);

    // Build playlist using HlsPlaylistBuilder
    // No EXT-X-MAP needed - each segment is a self-contained MP4 (ftyp+moov+mdat)
    // This avoids init/media mismatch issues from separate FFmpeg invocations
    const builder = new HlsPlaylistBuilder()
        .header()
        .version(DEFAULT_HLS_VERSION)
        .targetDuration(actualIntervalSec)
        .playlistType(PLAYLIST_TYPE.VOD)
        .iFramesOnly();

    // Generate entries for each I-frame, using actual thumbnail indices
    for (let logicalIndex = 0; logicalIndex < iframeCount; logicalIndex++) {
        // Map logical index to actual thumbnail index
        const thumbnailIndex = logicalIndex * skipFactor;

        // Calculate time position and duration
        const startTime = thumbnailIndex * trickplayIntervalSec;
        const isLast = logicalIndex === iframeCount - 1;
        const duration = isLast
            ? Math.min(actualIntervalSec, totalDurationSeconds - startTime)
            : actualIntervalSec;

        // Use ACTUAL thumbnail index in filename - .ts extension for MPEG-TS segments
        const segmentUri = `${segmentBase}/iframe_${String(thumbnailIndex).padStart(5, '0')}.ts${querySuffix}`;
        builder.segment(duration, segmentUri);
    }

    builder.endlist();

    logger.debug('Generated synthetic I-frame playlist', {
        trickplayIntervalSec,
        targetIntervalSeconds,
        skipFactor,
        actualIntervalSec,
        iframeCount,
        totalThumbnails: trickplay.thumbnailCount,
    });

    return builder.build();
}
