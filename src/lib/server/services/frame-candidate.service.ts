// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generate one episode thumbnail by sampling several candidate frames and
 * keeping the best.
 *
 * This exists for episodes that have NO artwork file on disk at all — the
 * population a re-scan can never repair (about 1,900 episodes on the reference
 * library as of 2026-07-20). It is not a re-scan and not a repair: it makes an
 * image where none exists.
 *
 * Design notes that are load-bearing:
 *
 *  - ONE ffmpeg spawn per episode, N inputs, N outputs.
 *  - `-ss` BEFORE `-i` (input seek). Output seek decodes from zero and discards,
 *    which is a full linear read of the file over the same mount that serves
 *    playback.
 *  - Accurate input seeks decode from the preceding keyframe to the target.
 *    Keyframe-only seeking can jump into a sibling in a combined video.
 *  - Every output stops at the episode end, even when its next source frame
 *    lies outside the episode (sparse video frames or a very short segment).
 *  - `-map i:V:0` with a CAPITAL V selects only true video streams, excluding
 *    attached cover-art mjpeg which on some MKVs is stream 0.
 *  - Candidates are written to the OS temp dir, never onto the media mount.
 */

import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'node:fs/promises';
import sharp from 'sharp';
import { classifyMediaInfraError } from '$lib/server/tasks/infra-retry.js';
import { Logger } from '$lib/server/utils/logger.js';
import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { safeReadFile, safeRm, safeUnlink } from '$lib/server/utils/safe-fs.js';
import { writeFileNoFollow } from '$lib/server/utils/contained-fs.js';
import { config } from '$lib/server/config.js';
import {
    computeFrameWindow,
    candidateOffsets,
    snapToKeyframe,
} from '$lib/server/utils/frame-window.js';
import { scoreFrame, type FrameScore } from '$lib/server/utils/frame-metrics.js';

const logger = Logger.for('FrameCandidateService');

/** Candidates sampled per episode. */
export const DEFAULT_CANDIDATES = 4;

/** Analysis resolution — small enough to be cheap, large enough to be meaningful. */
const ANALYSIS_W = 320;
const ANALYSIS_H = 180;

export interface GenerateThumbnailParams {
    episodeId: string;
    videoPath: string;
    /** Output path for the chosen frame. */
    outputPath: string;
    /** Effective duration of THIS episode in seconds. */
    durationSeconds: number;
    /** Absolute start of this episode inside a combined file; 0 normally. */
    baseOffsetSeconds?: number;
    /** Intro end in seconds, when known. Never required. */
    evidenceSeconds?: number;
    /** Absolute keyframe positions, ascending. Optimisation only. */
    keyframes?: readonly number[];
    candidates?: number;
    /** Relax the darkness floor for dark-graded content. */
    darkTolerant?: boolean;
    signal?: AbortSignal;
}

export interface GenerateThumbnailResult {
    success: boolean;
    outputPath?: string;
    /** Offset actually used, seconds relative to the episode start. */
    chosenOffsetSeconds?: number;
    score?: number;
    /** True when every candidate was rejected and the least-bad was kept. */
    bestEffort?: boolean;
    candidatesConsidered?: number;
    error?: string;
    /** Classified from the original error, never from the rendered stderr/path. */
    transientError?: string;
}

/** Build the ffmpeg argv for one spawn with N seeks. */
export function buildCandidateArgs(
    videoPath: string,
    absoluteTimes: readonly number[],
    outDir: string,
    quality: number,
    maxWidth: number,
    maxHeight: number,
    endOffsetSeconds: number,
): string[] {
    const q = String(Math.round((100 - quality) / 3.33));
    const scale = `scale='min(${maxWidth},iw)':'min(${maxHeight},ih)':force_original_aspect_ratio=decrease`;

    // Keep the file's timeline through filtering. Output -t alone is applied
    // after frame-rate synchronization, which can round an out-of-span frame
    // back into the output interval. Normalize each chosen output only AFTER trim.
    const args: string[] = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-copyts',
        '-start_at_zero',
    ];

    for (const t of absoluteTimes) {
        args.push(
            // Per-input. injectThreadsFlag() prepends a GLOBAL -threads that
            // binds to input 0 only, so with N inputs the rest would spawn
            // auto-threaded decoders; supplying our own also makes that
            // injector skip itself.
            '-threads',
            '1',
            '-probesize',
            '5M',
            '-analyzeduration',
            '5M',
            '-accurate_seek',
            '-ss',
            t.toFixed(3),
            '-i',
            videoPath,
        );
    }

    absoluteTimes.forEach((time, i) => {
        args.push(
            '-map',
            `${i}:V:0`,
            '-frames:v',
            '1',
            '-an',
            '-sn',
            '-dn',
            // Declare JPEG's full-range format even if trim emits no frames;
            // otherwise encoder initialization can fail before reporting EOF.
            '-pix_fmt',
            'yuvj420p',
            '-vf',
            `trim=start=${time.toFixed(3)}:end=${endOffsetSeconds.toFixed(6)},setpts=PTS-STARTPTS,${scale}`,
            '-q:v',
            q,
            '-f',
            'image2',
            '-y',
            join(outDir, `cand${i}.jpg`),
        );
    });

    return args;
}

async function analyse(buf: Buffer, darkTolerant: boolean): Promise<FrameScore> {
    const grey = await sharp(buf)
        .removeAlpha()
        .greyscale()
        .resize(ANALYSIS_W, ANALYSIS_H, { fit: 'fill' })
        .raw()
        .toBuffer();
    const rgb = await sharp(buf).removeAlpha().resize(32, 18, { fit: 'fill' }).raw().toBuffer();
    return scoreFrame({ grey, width: ANALYSIS_W, height: ANALYSIS_H, rgb, darkTolerant });
}

/**
 * Sample candidates across the safe window and write the best one.
 *
 * Never leaves the episode without an image when at least one frame decoded: a
 * blank card is a worse user-visible regression than a mediocre thumbnail, so
 * an all-rejected set still ships its least-bad member flagged `bestEffort`.
 */
export async function generateEpisodeThumbnail(
    params: GenerateThumbnailParams,
): Promise<GenerateThumbnailResult> {
    const {
        episodeId,
        videoPath,
        outputPath,
        durationSeconds,
        baseOffsetSeconds = 0,
        evidenceSeconds,
        keyframes,
        candidates = DEFAULT_CANDIDATES,
        darkTolerant = false,
        signal,
    } = params;

    if (!(durationSeconds > 0)) {
        return { success: false, error: 'no duration' };
    }

    const window = computeFrameWindow(durationSeconds, evidenceSeconds);
    const offsets = candidateOffsets(window, episodeId, candidates).map((t) =>
        snapToKeyframe(t, baseOffsetSeconds, window.floor, keyframes),
    );
    if (offsets.length === 0) {
        return { success: false, error: 'empty window' };
    }

    const stem = basename(videoPath, extname(videoPath))
        .replace(/[^\w.-]+/g, '_')
        .slice(0, 60);
    // Private per-run directory: a predictable name in a shared tmpdir can be pre-planted.
    const outDir = await mkdtemp(join(tmpdir(), `etr-${episodeId.slice(0, 8)}-${stem}-`));

    const absolute = offsets.map((t) => baseOffsetSeconds + t);
    const args = buildCandidateArgs(
        videoPath,
        absolute,
        outDir,
        config.IMAGE_SYNC_VIDEO_QUALITY,
        config.IMAGE_SYNC_VIDEO_MAX_WIDTH,
        config.IMAGE_SYNC_VIDEO_MAX_HEIGHT,
        baseOffsetSeconds + durationSeconds,
    );

    const cleanup = async (): Promise<void> => {
        await Promise.all(
            offsets.map((_, i) => safeUnlink(join(outDir, `cand${i}.jpg`)).catch(() => {})),
        );
        await safeRm(outDir, { recursive: true, force: true }).catch(() => {});
    };

    try {
        const spawned = await spawnFFmpegSafely({
            args,
            libraryInput: videoPath,
            // NOTE: the option is `timeout`, not `timeoutMs`. Passing the wrong
            // key silently falls back to a 30s default, which is not enough for
            // a multi-input spawn against NFS.
            timeout: 30_000 + 15_000 * absolute.length,
            killSignal: 'SIGKILL',
            abortSignal: signal,
            context: { videoPath, episodeId },
        });

        if (spawned.exitCode !== 0) {
            if (classifyMediaInfraError(spawned)) {
                return {
                    success: false,
                    error: `FFmpeg exited with code ${spawned.exitCode}: ${spawned.stderr.slice(-500)}`,
                    transientError: 'FFmpeg I/O interruption',
                };
            }
            logger.warn('Candidate extraction failed', {
                episodeId,
                exitCode: spawned.exitCode,
                stderr: spawned.stderr.slice(-400),
            });
        }

        let best: { score: FrameScore; buf: Buffer; offset: number } | null = null;
        let bestRejected: { score: FrameScore; buf: Buffer; offset: number } | null = null;
        let considered = 0;

        for (let i = 0; i < offsets.length; i++) {
            if (signal?.aborted) break;
            let buf: Buffer;
            try {
                buf = await safeReadFile(join(outDir, `cand${i}.jpg`));
            } catch {
                continue; // this seek produced nothing; others may still have
            }
            if (buf.length === 0) continue;
            considered++;

            const score = await analyse(buf, darkTolerant);
            const entry = { score, buf, offset: offsets[i] };
            if (score.rejected) {
                if (!bestRejected || score.score > bestRejected.score.score) bestRejected = entry;
            } else if (!best || score.score > best.score.score) {
                best = entry;
            }
        }

        // Distinguish "no output at all" from "everything was rejected" — only
        // the former means the extraction itself failed.
        if (considered === 0) {
            await cleanup();
            return {
                success: false,
                error: 'no candidate frames decoded',
                candidatesConsidered: 0,
            };
        }

        // An aborted run must not ship a frame: the caller cancelled or the
        // watchdog fired, and writing anyway leaves a half-finished cycle that
        // looks successful.
        if (signal?.aborted) {
            await cleanup();
            return { success: false, error: 'aborted', candidatesConsidered: considered };
        }

        const chosen = best ?? bestRejected;
        if (!chosen) {
            await cleanup();
            return {
                success: false,
                error: 'no usable candidate',
                candidatesConsidered: considered,
            };
        }

        await writeFileNoFollow(outputPath, chosen.buf);
        await cleanup();

        logger.info('Episode thumbnail generated', {
            episodeId,
            offset: Math.round(chosen.offset),
            score: Number(chosen.score.score.toFixed(3)),
            bestEffort: !best,
            considered,
        });

        return {
            success: true,
            outputPath,
            chosenOffsetSeconds: chosen.offset,
            score: chosen.score.score,
            bestEffort: !best,
            candidatesConsidered: considered,
        };
    } catch (err) {
        await cleanup();
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('Thumbnail generation failed', { episodeId, error: message });
        return {
            success: false,
            error: message,
            ...(classifyMediaInfraError(err) ? { transientError: message } : {}),
        };
    }
}
