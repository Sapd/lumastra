// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg Subtitle Extractor
 *
 * Direct subtitle extraction from media files using FFmpeg.
 * Based on Jellyfin's SubtitleEncoder approach but optimized for our use case.
 *
 * Every spawn first refuses an input whose CONTENT is a playlist/manifest body
 * (`assertTranscodeInputIsMedia`, transcoding/input-guard.ts): ffmpeg opens it
 * with format auto-detection and would follow its references into other
 * libraries. The input is a library container or an external sidecar, which
 * the scanner never sniffs; the refusal is thrown like any other extraction
 * failure.
 */

import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from './logger';
import { config } from '$lib/server/config.js';
import {
    spawnFFmpegSafely,
    checkFFmpegAvailability,
    FFmpegError,
    FFmpegTimeoutError,
    FFmpegSizeError,
} from './ffmpeg-spawn.js';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models';
import { assertTranscodeInputIsMedia } from '$lib/server/services/transcoding/input-guard.js';
import { ffprobeLibraryInputArgs } from '$lib/server/utils/library-input-guard.js';
import { readBoundedFile } from './bounded-file-reader.js';
import { AsyncSemaphore } from './async-semaphore.js';

const execFileAsync = promisify(execFile);

/**
 * Process-wide cap on concurrent subtitle-extraction FFmpeg processes.
 *
 * A cold extraction makes FFmpeg read the whole container (subtitle packets are
 * interleaved through the file). Windows e2e 2026-09-27 (S11): opening one
 * episode with 54 embedded SRT tracks forked 8+ concurrent `-c:s webvtt`
 * extractions of the same file, each a full read, competing with the playback
 * transcode for disk and CPU. The player now fetches only the selected track,
 * but any client (or a burst of viewers) can still ask for many tracks at once,
 * so the server bounds it itself. Extra requests queue (FIFO) instead of
 * failing; the per-process timeout starts once a request actually spawns.
 */
export const MAX_CONCURRENT_SUBTITLE_EXTRACTIONS = 3;
const extractionSlots = new AsyncSemaphore(MAX_CONCURRENT_SUBTITLE_EXTRACTIONS);

/** Run one subtitle FFmpeg spawn inside the process-wide concurrency cap. */
function withExtractionSlot<T>(fn: () => Promise<T>): Promise<T> {
    return extractionSlots.withPermit(fn);
}

/** Test hook: extractions currently queued waiting for a slot. */
export function pendingSubtitleExtractions(): number {
    return extractionSlots.waiting;
}

// Re-export for backwards compatibility
export { checkFFmpegAvailability, FFmpegError, FFmpegTimeoutError, FFmpegSizeError };

const logger = Logger.for('FFmpegSubtitleExtractor');

/** Maximum subtitle file size (10MB) */
const MAX_SUBTITLE_SIZE = 10 * 1024 * 1024;

/** FFmpeg extraction timeout for text subtitles (120 seconds — large files need more time) */
const EXTRACTION_TIMEOUT_MS = 120_000;

/**
 * FFmpeg extraction timeout for binary subtitles.
 *
 * A guard against a HUNG FFmpeg, not a performance budget: a bitmap track costs a
 * full read of the container, measured on prod at ~80s for one track of a 2h16m
 * remux and ~117s for two in one pass. 120s sat inside that range, so a normal
 * cold read of a long film was killed. Clients hold the request 300s, which
 * leaves room for the render after this.
 */
const BINARY_EXTRACTION_TIMEOUT_MS = 240_000;

/** Maximum binary subtitle file size (50MB — PGS streams can be large) */
const MAX_BINARY_SUBTITLE_SIZE = 50 * 1024 * 1024;

export interface SubtitleExtractionOptions {
    filePath: string;
    streamIndex: number;
    codec?: string;
    outputFormat?: 'webvtt' | 'srt' | 'ass';
}

export interface BatchSubtitleExtractionOptions {
    filePath: string;
    streams: Array<{
        streamIndex: number;
        codec?: string;
        outputPath: string;
    }>;
}

/**
 * Check if subtitle codec can be copied without re-encoding (fast)
 * Codec must match the output format for copying to work
 * @param codec Input subtitle codec
 * @param outputFormat Desired output format
 */
function isCodecCopyable(codec: string | undefined, outputFormat: string): boolean {
    if (!codec) return false;

    const lowerCodec = codec.toLowerCase();
    const lowerFormat = outputFormat.toLowerCase();

    // WebVTT output: can only copy if input is also WebVTT
    if (lowerFormat === 'webvtt' || lowerFormat === 'vtt') {
        return lowerCodec.includes('webvtt') || lowerCodec.includes('vtt');
    }

    // SRT output: can only copy if input is SRT/SubRip
    if (lowerFormat === 'srt') {
        return lowerCodec.includes('subrip') || lowerCodec.includes('srt');
    }

    // ASS output: can only copy if input is ASS/SSA
    if (lowerFormat === 'ass') {
        return lowerCodec.includes('ass') || lowerCodec.includes('ssa');
    }

    // Unknown format: don't copy
    return false;
}

/**
 * Extract a single subtitle stream to WebVTT format (streaming to stdout)
 *
 * @param options - Extraction options
 * @returns WebVTT content as string
 */
export async function extractSubtitleStream(options: SubtitleExtractionOptions): Promise<string> {
    const { filePath, streamIndex, codec, outputFormat = 'webvtt' } = options;

    const outputCodec = isCodecCopyable(codec, outputFormat) ? 'copy' : outputFormat;

    const args = [
        '-loglevel',
        'error', // Only show errors
        '-i',
        filePath,
        '-map',
        `0:${streamIndex}`, // Select subtitle stream
        '-an', // Disable audio
        '-vn', // Disable video
        '-c:s',
        outputCodec, // Copy or convert
        '-f',
        outputFormat, // Output format
        '-', // Output to stdout
    ];

    logger.debug('Extracting subtitle stream', {
        filePath,
        streamIndex,
        codec,
        outputCodec,
        outputFormat,
    });

    // Use spawnFFmpegSafely wrapper for comprehensive error handling
    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        const result = await withExtractionSlot(() =>
            spawnFFmpegSafely({
                args,
                libraryInput: filePath,
                timeout: EXTRACTION_TIMEOUT_MS,
                maxStdoutSize: MAX_SUBTITLE_SIZE,
                context: {
                    operation: 'subtitle-extraction',
                    filePath,
                    streamIndex,
                    codec,
                    outputFormat,
                },
            }),
        );

        logger.debug('Subtitle extraction successful', {
            streamIndex,
            outputSize: result.stdout.length,
        });

        return result.stdout;
    } catch (error) {
        // spawnFFmpegSafely already logged the error, but add clear conversion failure message
        logger.error(
            `Subtitle conversion failed: ${codec?.toUpperCase() || 'unknown'} → ${outputFormat.toUpperCase()}`,
            error as Error,
            {
                sourceCodec: codec || 'unknown',
                targetFormat: outputFormat,
                streamIndex,
                filePath,
            },
        );
        throw error;
    }
}

// ============================================================================
// PGS .sup PTS normalization
// ============================================================================

/**
 * PGS .sup segment header layout (13 bytes):
 *   0-1:  Magic "PG" (0x50 0x47)
 *   2-5:  PTS (big-endian uint32, 90kHz clock)
 *   6-9:  DTS (big-endian uint32, 90kHz clock)
 *  10:    Segment type
 *  11-12: Segment data size (big-endian uint16)
 */
const PGS_MAGIC_0 = 0x50; // 'P'
const PGS_MAGIC_1 = 0x47; // 'G'
const PGS_HEADER_SIZE = 13;
const PGS_90KHZ = 90_000;

/**
 * Get the container's start_time in seconds via ffprobe.
 * MKV files commonly have a non-zero start_time (e.g. ~5s) which offsets
 * all stream timestamps relative to the transcoded video output.
 */
async function getContainerStartTime(filePath: string): Promise<number> {
    try {
        const { stdout } = await execFileAsync(
            config.FFPROBE_PATH,
            [
                '-v',
                'quiet',
                '-print_format',
                'json',
                '-show_format',
                ...(await ffprobeLibraryInputArgs()),
                filePath,
            ],
            { timeout: 10_000 },
        );
        const parsed = JSON.parse(stdout);
        const startTime = parseFloat(parsed?.format?.start_time);
        return Number.isFinite(startTime) ? startTime : 0;
    } catch {
        return 0;
    }
}

/**
 * Normalize PTS/DTS in a PGS .sup buffer by subtracting a time offset.
 *
 * When FFmpeg extracts PGS with `-c:s copy`, timestamps reflect the
 * original container timeline. If the container has a non-zero start_time,
 * PGS timestamps are offset relative to the transcoded video (which starts
 * at PTS 0). This function shifts all timestamps to align with the video.
 *
 * Mutates the buffer in-place for efficiency (large PGS streams can be 50MB+).
 */
function normalizeSupTimestamps(buf: Buffer, offsetSeconds: number): void {
    const offsetTicks = Math.round(offsetSeconds * PGS_90KHZ);
    if (offsetTicks === 0) return;

    let pos = 0;
    while (pos + PGS_HEADER_SIZE <= buf.length) {
        // Validate magic bytes
        if (buf[pos] !== PGS_MAGIC_0 || buf[pos + 1] !== PGS_MAGIC_1) {
            break; // Corrupt or unexpected format — stop processing
        }

        // Read and adjust PTS (bytes 2-5)
        const pts = buf.readUInt32BE(pos + 2);
        buf.writeUInt32BE(Math.max(0, pts - offsetTicks), pos + 2);

        // Read and adjust DTS (bytes 6-9)
        const dts = buf.readUInt32BE(pos + 6);
        buf.writeUInt32BE(Math.max(0, dts - offsetTicks), pos + 6);

        // Skip to next segment: header + data size
        const dataSize = buf.readUInt16BE(pos + 11);
        pos += PGS_HEADER_SIZE + dataSize;
    }
}

/**
 * Extract a binary subtitle stream (PGS/VobSub) via FFmpeg file output.
 *
 * Binary subtitle data cannot go through UTF-8 stdout, so this writes to
 * a temp file with `-c:s copy` and reads the result back as a Buffer.
 *
 * PGS → `.sup` container (raw PGS segments, works directly).
 * VobSub → `.mkv` container (VobSub requires `.sub`+`.idx` pair; a bare `.sub`
 *   extension causes FFmpeg to treat the output as MicroDVD text, which fails.
 *   Wrapping in MKV preserves the VobSub data intact for libbitsub parsing.)
 *
 * @param filePath - Path to the media file
 * @param streamIndex - Absolute stream index of the subtitle track
 * @param outputFormat - Logical format: 'sup' for PGS, 'sub' for VobSub
 * @returns Buffer containing the raw binary subtitle data, or null on failure
 */
export async function extractSubtitleStreamBinary(
    filePath: string,
    streamIndex: number,
    outputFormat: 'sup' | 'sub',
): Promise<Buffer | null> {
    try {
        const results = await extractSubtitleStreamsBinary(filePath, [streamIndex], outputFormat);
        return results.get(streamIndex) ?? null;
    } catch (error) {
        logger.error(
            `Binary subtitle extraction failed: stream ${streamIndex} → ${outputFormat}`,
            error as Error,
            { filePath, streamIndex, outputFormat },
        );
        return null;
    }
}

/**
 * Extract SEVERAL binary subtitle streams of one format in a single FFmpeg pass.
 *
 * The cost of a cold extraction is FFmpeg reading the whole container to reach
 * the subtitle packets, and that read is identical whether it feeds one output
 * or six. A Blu-ray rip commonly carries 4-6 bitmap tracks, so extracting them
 * one request at a time reads the same 30-60 GB file once per track.
 *
 * One format per call because `-copyts` is a GLOBAL option and the two formats
 * need opposite settings (see below). A file mixing PGS and VobSub costs two
 * passes, not one per track.
 *
 * Throws when FFmpeg itself fails, so a caller can tell a timeout (retrying is
 * pointless) from a stream that broke the multi-output mux (retrying the
 * requested stream alone may succeed). A stream that simply produced no usable
 * output maps to null.
 */
export async function extractSubtitleStreamsBinary(
    filePath: string,
    streamIndexes: number[],
    outputFormat: 'sup' | 'sub',
): Promise<Map<number, Buffer | null>> {
    const results = new Map<number, Buffer | null>();
    if (streamIndexes.length === 0) return results;

    // VobSub needs MKV container; PGS uses .sup directly
    const fileExtension = outputFormat === 'sub' ? 'mkv' : outputFormat;
    const outputs = streamIndexes.map((streamIndex) => ({
        streamIndex,
        tempFile: join(tmpdir(), `lumastra-sub-${randomBytes(8).toString('hex')}.${fileExtension}`),
    }));

    const args = [
        '-loglevel',
        'error',
        '-i',
        filePath,
        // What -copyts actually does here, MEASURED rather than assumed:
        //
        //   container start_time = 0 : with and without the flag are IDENTICAL
        //   container start_time = 5 : without -copyts a cue at 35s emits as 30s
        //                              (start_time subtracted); with it, 35s
        //
        // So omitting the flag subtracts the container's start_time, and nothing
        // else. The long-standing comment here claimed it guarded against FFmpeg
        // "rebasing to the first subtitle packet's PTS, 10+ seconds into the file
        // after logos" — that does not happen, on any input tested.
        //
        // Consequence: for VobSub, omitting the flag IS the normalisation, done at
        // mux time. That is why the .sub path drops it — normalizeSupTimestamps
        // understands only the flat .sup segment stream and cannot rewrite
        // timestamps inside Matroska.
        //
        // The .sup path keeps -copyts and then subtracts start_time itself, which
        // reaches the same result by a longer route. It is left alone because it
        // is what production has been serving; if you simplify it, remove the flag
        // AND the normalize step together. Keeping -copyts while dropping
        // normalizeSupTimestamps ships every cue offset by start_time.
        ...(outputFormat === 'sub' ? [] : ['-copyts']),
    ];
    for (const [index, { streamIndex }] of outputs.entries()) {
        // Explicit muxer: an extra pipe has no filename extension to infer from.
        args.push(
            '-map',
            `0:${streamIndex}`,
            '-an',
            '-vn',
            '-c:s',
            'copy',
            '-f',
            outputFormat === 'sub' ? 'matroska' : 'sup',
            `pipe:${index + 3}`,
        );
    }

    logger.debug('Extracting binary subtitle streams', {
        filePath,
        streamIndexes,
        outputFormat,
    });

    await assertTranscodeInputIsMedia({ localFilePath: filePath });
    return withExtractionSlot(async () => {
        try {
            try {
                await spawnFFmpegSafely({
                    args,
                    binaryOutputs: outputs.map(({ tempFile }) => ({
                        path: tempFile,
                        maxBytes: MAX_BINARY_SUBTITLE_SIZE,
                    })),
                    libraryInput: filePath,
                    timeout: BINARY_EXTRACTION_TIMEOUT_MS,
                    context: {
                        operation: 'binary-subtitle-extraction',
                        filePath,
                        streamIndexes,
                        outputFormat,
                    },
                });
            } catch (error) {
                // A size failure is a rejected track, never a partial extraction
                // to cache or a batch mux error to retry with another full scan.
                if (!(error instanceof FFmpegSizeError)) throw error;
                logger.warn('Binary subtitle extraction exceeded byte limit', {
                    streamIndexes,
                    outputFormat,
                    limitBytes: MAX_BINARY_SUBTITLE_SIZE,
                });
                return new Map(streamIndexes.map((index) => [index, null]));
            }

            // Probed once for the whole pass, and only when a PGS output needs it.
            let startTime: number | null = null;

            for (const { streamIndex, tempFile } of outputs) {
                const data = await (async (): Promise<Buffer | null> => {
                    const file = await open(tempFile, 'r').catch(() => null);
                    if (!file) return null;
                    try {
                        const bytes = await readBoundedFile(file, MAX_BINARY_SUBTITLE_SIZE);
                        if (bytes === null)
                            logger.warn('Binary subtitle exceeds size limit', {
                                streamIndex,
                                outputFormat,
                                limitBytes: MAX_BINARY_SUBTITLE_SIZE,
                            });
                        return bytes;
                    } finally {
                        await file.close();
                    }
                })();

                if (!data || data.length === 0) {
                    logger.warn('Binary subtitle extraction produced empty file', {
                        streamIndex,
                        outputFormat,
                    });
                    results.set(streamIndex, null);
                    continue;
                }

                if (data.length > MAX_BINARY_SUBTITLE_SIZE) {
                    logger.warn('Binary subtitle exceeds size limit', {
                        streamIndex,
                        outputFormat,
                        sizeBytes: data.length,
                        limitBytes: MAX_BINARY_SUBTITLE_SIZE,
                    });
                    results.set(streamIndex, null);
                    continue;
                }

                // Normalize PGS timestamps: MKV containers often have a non-zero
                // start_time which offsets PGS timestamps relative to the transcoded
                // video (which starts at PTS 0). Probe and subtract the offset.
                if (outputFormat === 'sup') {
                    startTime ??= await getContainerStartTime(filePath);
                    if (startTime > 0.1) {
                        normalizeSupTimestamps(data, startTime);
                        logger.info('Normalized PGS timestamps', {
                            streamIndex,
                            containerStartTime: startTime,
                            offsetTicks: Math.round(startTime * PGS_90KHZ),
                        });
                    }
                }

                logger.debug('Binary subtitle extraction successful', {
                    streamIndex,
                    outputFormat,
                    sizeBytes: data.length,
                });

                results.set(streamIndex, data);
            }

            return results;
        } finally {
            await Promise.all(
                outputs.map(({ tempFile }) =>
                    unlink(tempFile).catch(() => {
                        // Ignore cleanup errors — file may not have been created
                    }),
                ),
            );
        }
    });
}

/**
 * Extract multiple subtitle streams in a single FFmpeg call (batch extraction)
 * Much faster than extracting one-by-one.
 *
 * @param options - Batch extraction options
 * @returns Promise that resolves when all streams are extracted
 */
export async function batchExtractSubtitles(
    options: BatchSubtitleExtractionOptions,
): Promise<void> {
    const { filePath, streams } = options;

    if (streams.length === 0) {
        return;
    }

    const args = [
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-copyts', // Preserve original timestamps
    ];

    // Add output for each stream
    for (const stream of streams) {
        const outputCodec = isCodecCopyable(stream.codec, 'webvtt') ? 'copy' : 'webvtt';

        args.push(
            '-map',
            `0:${stream.streamIndex}`,
            '-an',
            '-vn',
            '-c:s',
            outputCodec,
            stream.outputPath,
        );
    }

    logger.info('Batch extracting subtitle streams', {
        filePath,
        streamCount: streams.length,
        streams: streams.map((s) => ({
            index: s.streamIndex,
            output: s.outputPath,
        })),
    });

    // Use spawnFFmpegSafely wrapper for comprehensive error handling
    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        await withExtractionSlot(() =>
            spawnFFmpegSafely({
                args,
                libraryInput: filePath,
                timeout: EXTRACTION_TIMEOUT_MS * 2, // 2x timeout for batch
                context: {
                    operation: 'batch-subtitle-extraction',
                    filePath,
                    streamCount: streams.length,
                },
            }),
        );

        logger.info('Batch subtitle extraction successful', {
            streamCount: streams.length,
        });
    } catch (error) {
        // spawnFFmpegSafely already logged the error, but add clear conversion failure message
        logger.error('Batch subtitle conversion failed', error as Error, {
            filePath,
            streamCount: streams.length,
            conversions: streams.map((s) => ({
                sourceCodec: s.codec || 'unknown',
                targetFormat: 'webvtt',
                streamIndex: s.streamIndex,
                outputPath: s.outputPath,
            })),
        });
        throw error;
    }
}

/**
 * Get the absolute stream index from MediaStream array
 * Jellyfin uses relative indexes per type, FFmpeg uses absolute indexes
 */
export function getAbsoluteStreamIndex(
    allStreams: MediaStream[],
    subtitleStream: MediaStream,
): number | null {
    const absoluteIndex = allStreams.indexOf(subtitleStream);
    return absoluteIndex >= 0 ? absoluteIndex : null;
}
