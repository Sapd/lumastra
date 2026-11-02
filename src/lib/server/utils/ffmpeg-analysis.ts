// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg Media Analysis Utilities
 *
 * Higher-level media analysis operations built on spawnFFmpegSafely.
 * Used by the plugin system's `context.ffmpeg` capability.
 *
 * Every spawn here first refuses an input whose CONTENT is a playlist/manifest
 * body (`assertTranscodeInputIsMedia`, transcoding/input-guard.ts): each of
 * these functions runs on a library file (episode/movie), and ffmpeg would
 * follow such a body's references into other libraries. The refusal is
 * surfaced the same way each function already reports a spawn failure.
 *
 * Algorithms inspired by intro-skipper (https://github.com/intro-skipper/intro-skipper)
 * Licensed under GPL-3.0. Adapted for TypeScript/Node.js.
 */

import { AsyncSemaphore } from './async-semaphore.js';
import { spawnFFmpegSafely } from './ffmpeg-spawn.js';
import { config } from '$lib/server/config.js';
import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Logger } from './logger.js';
import { assertTranscodeInputIsMedia } from '$lib/server/services/transcoding/input-guard.js';

const log = Logger.for('FFmpegAnalysis');

// One visual decoder at a time, including 2160p inputs. The intro task also
// declares maxConcurrent=1: isolated runs must not each create their own pool.
const visualDecode = new AsyncSemaphore(1);

function analysisThreadArgs(threads = config.ANALYSIS_FFMPEG_THREADS): string[] {
    // Explicit zero is important: it opts out of both this cap and the global
    // spawn wrapper's thread injection. Decoder options belong BEFORE -i.
    return ['-threads', String(threads), '-filter_threads', String(threads)];
}

// ============================================================================
// Types
// ============================================================================

export interface ExtractFrameOptions {
    /** Output format (default: 'jpeg') */
    format?: 'jpeg' | 'png';
    /** Scale to this width (maintains aspect ratio) */
    width?: number;
    /** Scale to this height (maintains aspect ratio) */
    height?: number;
    /** Timeout in ms (default: 30 seconds) */
    timeout?: number;
}

export interface ExtractFrameResult {
    /** Raw image data */
    buffer: Buffer;
    /** Image format */
    format: 'jpeg' | 'png';
}

export interface SilenceRange {
    /** Start time in seconds (absolute position in file) */
    start: number;
    /** End time in seconds (absolute position in file) */
    end: number;
    /** Duration in seconds */
    duration: number;
}

export interface DetectSilenceOptions {
    /** Noise floor in dB (default: -50). Audio below this is considered silence. */
    noiseDb?: number;
    /** Minimum silence duration in seconds (default: 0.5) */
    minDuration?: number;
    /** Timeout in ms (default: 60 seconds) */
    timeout?: number;
}

export interface BlackFrame {
    /** Timestamp in seconds (absolute position in file) */
    time: number;
    /** Percentage of the frame that is black (0-100) */
    blackPercentage: number;
}

export interface FingerprintOptions {
    /** Timeout in ms (default: 5 minutes) */
    timeout?: number;
    /** FFmpeg thread count (0 = auto, overrides ANALYSIS_FFMPEG_THREADS env) */
    threads?: number;
    /** Abort signal — when fired (admin Cancel / soft-budget timeout) the ffmpeg
     *  child is killed instead of running to its full timeout while holding a
     *  cpu-class budget token. Pass `ctx.signal` from the calling task (A1). */
    abortSignal?: AbortSignal;
}

export interface BlackFrameOptions {
    /** Minimum percentage of pixels that must be black (default: 50) */
    minimumBlackPct?: number;
    /** Pixel brightness threshold for "black" (0-255, default: 32) */
    threshold?: number;
    /** Timeout in ms (default: 60 seconds) */
    timeout?: number;
    /** FFmpeg thread count (0 = auto, overrides ANALYSIS_FFMPEG_THREADS env) */
    threads?: number;
    /** Abort signal — kills the ffmpeg child on admin Cancel / soft-budget
     *  timeout instead of holding a cpu-class budget token to full timeout (A1). */
    abortSignal?: AbortSignal;
}

// ============================================================================
// Chromaprint Fingerprinting
// ============================================================================

/**
 * Extract a Chromaprint audio fingerprint from a media file.
 *
 * Requires FFmpeg built with chromaprint support (--enable-chromaprint).
 * Outputs raw uint32 fingerprint points via the chromaprint muxer.
 *
 * Each point represents ~0.1238 seconds of audio.
 *
 * The input is sniffed for a playlist/manifest body before the spawn; see the
 * file header.
 *
 * @param filePath - Path to the media file
 * @param startSec - Start time in seconds
 * @param endSec - End time in seconds
 * @param tmpDir - Directory for temporary fingerprint file
 * @param options - Optional configuration
 * @returns Array of uint32 fingerprint points
 */
export async function chromaprintFingerprint(
    filePath: string,
    startSec: number,
    endSec: number,
    tmpDir: string,
    options: FingerprintOptions = {},
): Promise<Uint32Array> {
    const { timeout = 5 * 60 * 1000, threads, abortSignal } = options;
    const duration = endSec - startSec;

    if (duration <= 0) {
        return new Uint32Array(0);
    }

    const tmpPath = join(tmpDir, `fp-${randomUUID()}.raw`);

    const threadArgs = analysisThreadArgs(threads);
    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        await spawnFFmpegSafely({
            libraryInput: filePath,
            args: [
                '-ss',
                String(startSec),
                ...threadArgs,
                '-i',
                filePath,
                '-t',
                String(duration),
                '-vn',
                '-sn',
                '-dn',
                '-ac',
                '2',
                '-acodec',
                'pcm_s16le',
                '-ar',
                '16000',
                '-f',
                'chromaprint',
                '-fp_format',
                'raw',
                tmpPath,
            ],
            timeout,
            abortSignal,
            context: { operation: 'chromaprint', file: filePath },
        });

        const buffer = await readFile(tmpPath);

        // Raw chromaprint output is a sequence of uint32 LE values
        const aligned = buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
        );
        return new Uint32Array(aligned);
    } catch (err) {
        log.warn('Chromaprint fingerprint failed', {
            file: filePath,
            startSec,
            endSec,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    } finally {
        await unlink(tmpPath).catch(() => {});
    }
}

// ============================================================================
// Black Frame Detection
// ============================================================================

/**
 * Regex to parse FFmpeg blackframe filter output.
 *
 * Sample line:
 * [blackframe @ 0x...] frame:42 pblack:98 pts:175000 t:1.750000 type:I last_keyframe:30
 *
 * Some FFmpeg versions use `pblack` and others use `pct` — we match both.
 */
const BLACK_FRAME_REGEX = /(?:pblack|pct):(\d+).*?t:([\d.]+)/g;

/**
 * Black-frame detection is INTENTIONALLY software-only — GPU hwaccel is NOT used,
 * for ANY vendor, on purpose. This is the opposite of transcoding (where the GPU
 * wins big): the analysis filters a deliberately tiny stream (downscaled to 320px,
 * decimated to 5 fps), so the GPU decode + per-frame GPU→CPU transfer (`hwdownload`)
 * overhead DWARFS any decode speedup.
 *
 * Measured on prod (Intel Arc A380, 720p H.264, 120 s segment):
 *   - software (`scale,fps=5,blackframe`)                       → ~16x realtime
 *   - vaapi, hwdownload-full-res-then-scale (the old buggy order) → ~0.46x
 *   - vaapi, scale_vaapi-then-hwdownload (corrected order)       → ~0.9x
 * i.e. software is ~17–35x FASTER than GPU here. The same hwdownload overhead
 * applies to cuda (NVIDIA) and qsv — the GPU path is a loss for this workload on
 * every vendor, so it is removed rather than gated behind a footgun config knob.
 *
 * Practical consequences:
 *   - A host with NO GPU is on the FAST path, not a degraded one — intro/outro
 *     detection is perfectly viable software-only.
 *   - There is no vendor-specific hwaccel filter bug to hit (nvidia/amd/intel),
 *     because there is no hwaccel filter.
 * (If a future need arises for GPU-accelerated analysis on very-high-resolution
 * content where even downscaled software decode is the bottleneck, reintroduce it
 * deliberately with the corrected `scale_<vendor>` → `hwdownload` order, NOT the
 * old download-then-scale order.)
 */
const softwareScale = (width: number): string => `scale=${width}:-2:flags=fast_bilinear`;

/**
 * Detect black frames in a time range of a media file.
 *
 * Uses FFmpeg's blackframe filter with scale + fps decimation for speed:
 * - Downscales to 320px wide (blackframe only needs luma, not full resolution)
 * - Decimates to 5fps — black sections span seconds, so 200 ms sampling is
 *   plenty. Crucially, fps=5 also acts as a noise floor: brief flashes,
 *   sub-second tail fades and single-frame artefacts that pass the
 *   blackframe pixel threshold at native fps end up not being sampled, so
 *   they don't form spurious black buckets in the analyzer's bucket scan.
 *   (Removing fps=5 caused massive false positives on Secret Level — tail
 *   fades formed 23–39 s "runs" that the analyzer returned as credits.)
 * - Software decode only (no GPU hwaccel) — measured faster than GPU for this
 *   downscaled/decimated workload on every vendor; see the `softwareScale` note
 *
 * All source frames are decoded: keyframe-only decoding would miss the
 * sub-second transitions used by the credits detector. Scale precedes sampling
 * and blackframe; +fast avoids unnecessary decoder work without dropping frames.
 *
 * The input is sniffed for a playlist/manifest body before the spawn; see the
 * file header.
 *
 * @param filePath - Path to the media file
 * @param startSec - Start time in seconds
 * @param endSec - End time in seconds
 * @param options - Optional configuration
 * @returns Array of detected black frames
 */
export async function detectBlackFrames(
    filePath: string,
    startSec: number,
    endSec: number,
    options: BlackFrameOptions = {},
): Promise<BlackFrame[]> {
    const {
        minimumBlackPct = 50,
        threshold = 32,
        timeout = 60_000,
        threads,
        abortSignal,
    } = options;

    const duration = endSec - startSec;
    if (
        !Number.isFinite(startSec) ||
        !Number.isFinite(endSec) ||
        !Number.isFinite(duration) ||
        startSec < 0 ||
        duration <= 0
    ) {
        return [];
    }

    const threadArgs = analysisThreadArgs(threads);

    // Software-only by design — see the `softwareScale` doc above for the measured
    // GPU-vs-software numbers. No hwaccel input args, no GPU filter, no fallback
    // branch (there is nothing to fall back FROM).
    const args = [
        '-ss',
        String(startSec),
        ...threadArgs,
        '-flags2',
        '+fast',
        '-i',
        filePath,
        '-t',
        String(duration),
        '-an',
        '-dn',
        '-sn',
        '-vf',
        `${softwareScale(320)},fps=5,blackframe=amount=${minimumBlackPct}:threshold=${threshold}`,
        '-f',
        'null',
        '-',
    ];

    let result;
    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        result = await visualDecode.withPermit(
            () =>
                spawnFFmpegSafely({
                    args,
                    libraryInput: filePath,
                    timeout,
                    abortSignal,
                    context: { operation: 'blackframe', file: filePath },
                }),
            abortSignal,
        );
    } catch (err) {
        log.warn('Black frame detection failed', {
            file: filePath,
            startSec,
            endSec,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }

    // blackframe filter writes to stderr
    const frames: BlackFrame[] = [];
    let match: RegExpExecArray | null;

    // Reset regex state (it's global)
    BLACK_FRAME_REGEX.lastIndex = 0;

    while ((match = BLACK_FRAME_REGEX.exec(result.stderr)) !== null) {
        const blackPercentage = parseInt(match[1], 10);
        const relativeTime = parseFloat(match[2]);

        frames.push({
            time: startSec + relativeTime,
            blackPercentage,
        });
    }

    return frames.sort((a, b) => a.time - b.time);
}

// ============================================================================
// Frame Extraction
// ============================================================================

/**
 * Extract a single video frame from a media file as a JPEG or PNG buffer.
 *
 * Uses FFmpeg to seek to the given timestamp and output one frame.
 * Optionally scales the output to the given width/height (maintaining aspect ratio).
 *
 * The input is sniffed for a playlist/manifest body before the spawn; see the
 * file header.
 *
 * @param filePath - Path to the media file
 * @param timeSec - Timestamp in seconds to extract the frame from
 * @param options - Optional configuration
 * @returns Buffer containing the image data and its format
 */
export async function extractFrame(
    filePath: string,
    timeSec: number,
    tmpDir: string,
    options: ExtractFrameOptions = {},
): Promise<ExtractFrameResult> {
    const { format = 'jpeg', width, height, timeout = 30_000 } = options;

    const ext = format === 'png' ? 'png' : 'jpg';
    const tmpPath = join(tmpDir, `frame-${randomUUID()}.${ext}`);

    const args = [
        '-ss',
        String(timeSec),
        ...analysisThreadArgs(),
        '-flags2',
        '+fast',
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-an',
        '-dn',
        '-sn',
    ];

    if (width || height) {
        args.push('-vf', `scale=${width ?? -1}:${height ?? -1}`);
    }

    if (format === 'png') {
        args.push('-f', 'image2', '-update', '1', '-c:v', 'png');
    } else {
        args.push('-f', 'image2', '-update', '1', '-c:v', 'mjpeg', '-q:v', '2');
    }

    args.push(tmpPath);

    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        await visualDecode.withPermit(() =>
            spawnFFmpegSafely({
                args,
                libraryInput: filePath,
                timeout,
                context: { operation: 'extractFrame', file: filePath },
            }),
        );

        const buffer = await readFile(tmpPath);
        return { buffer, format };
    } catch (err) {
        log.warn('Frame extraction failed', {
            file: filePath,
            timeSec,
            format,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    } finally {
        await unlink(tmpPath).catch(() => {});
    }
}

// ============================================================================
// Silence Detection
// ============================================================================

/**
 * Regex to parse FFmpeg silencedetect filter output.
 *
 * Sample lines:
 * [silencedetect @ 0x...] silence_start: 1.234
 * [silencedetect @ 0x...] silence_end: 5.678 | silence_duration: 4.444
 */
const SILENCE_START_REGEX = /silence_start:\s*([\d.]+)/g;
const SILENCE_END_REGEX = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g;

/**
 * Detect silent audio sections in a time range of a media file.
 *
 * Uses FFmpeg's silencedetect filter. Returns ranges sorted by start time.
 *
 * The input is sniffed for a playlist/manifest body before the spawn; see the
 * file header.
 *
 * @param filePath - Path to the media file
 * @param startSec - Start time in seconds
 * @param endSec - End time in seconds
 * @param options - Optional configuration
 * @returns Array of detected silence ranges (absolute timestamps)
 */
export async function detectSilence(
    filePath: string,
    startSec: number,
    endSec: number,
    options: DetectSilenceOptions = {},
): Promise<SilenceRange[]> {
    const { noiseDb = -50, minDuration = 0.5, timeout = 60_000 } = options;

    const duration = endSec - startSec;
    if (duration <= 0) {
        return [];
    }

    const threadArgs = analysisThreadArgs();
    let result;
    try {
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        result = await spawnFFmpegSafely({
            libraryInput: filePath,
            args: [
                '-ss',
                String(startSec),
                ...threadArgs,
                '-i',
                filePath,
                '-t',
                String(duration),
                '-vn',
                '-dn',
                '-sn',
                '-af',
                `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
                '-f',
                'null',
                '-',
            ],
            timeout,
            context: { operation: 'silencedetect', file: filePath },
        });
    } catch (err) {
        log.warn('Silence detection failed', {
            file: filePath,
            startSec,
            endSec,
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }

    // Parse silence_start and silence_end from stderr
    const starts: number[] = [];
    SILENCE_START_REGEX.lastIndex = 0;
    let startMatch: RegExpExecArray | null;
    while ((startMatch = SILENCE_START_REGEX.exec(result.stderr)) !== null) {
        starts.push(parseFloat(startMatch[1]));
    }

    const ranges: SilenceRange[] = [];
    SILENCE_END_REGEX.lastIndex = 0;
    let endMatch: RegExpExecArray | null;
    let i = 0;
    while ((endMatch = SILENCE_END_REGEX.exec(result.stderr)) !== null) {
        const relEnd = parseFloat(endMatch[1]);
        const dur = parseFloat(endMatch[2]);
        const relStart = i < starts.length ? starts[i] : relEnd - dur;
        ranges.push({
            start: startSec + relStart,
            end: startSec + relEnd,
            duration: dur,
        });
        i++;
    }

    // Handle case where silence starts but doesn't end (file ends in silence)
    if (starts.length > ranges.length) {
        const lastStart = starts[starts.length - 1];
        ranges.push({
            start: startSec + lastStart,
            end: endSec,
            duration: endSec - (startSec + lastStart),
        });
    }

    return ranges.sort((a, b) => a.start - b.start);
}
