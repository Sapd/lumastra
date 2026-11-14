// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs a progressive transcode (see `progressive-transcode.ts`) and streams
 * ffmpeg's stdout as the HTTP response body.
 *
 * - Concurrency: a per-replica cap (`JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT`).
 *   A full cap queues for a while before answering 503 + Retry-After, because a
 *   client downloading a season starts several at once and a queue turns that
 *   into "slower" rather than "failed". These jobs are not HLS sessions, so the
 *   HLS cap and its LRU eviction do not apply; the shared load-shed gate does.
 * - GPU fallback: the response is only committed once ffmpeg has written its
 *   first bytes. A GPU encoder that dies before that (driver, unsupported
 *   profile) is retried once in software — the same stateless retry the
 *   download renditions use, nothing learned or remembered.
 * - Lifetime: the client hanging up (request abort or body cancel) kills ffmpeg;
 *   ffmpeg exiting releases the slot. Exactly once, whichever happens first.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { config } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { guardLibraryInput } from '$lib/server/utils/library-input-guard';
import { prepareMediaFormatWhitelist } from '$lib/server/utils/media-format-whitelist';
import { hardwareDetection } from '$lib/server/services/transcoding/hardware-detection';
import { checkRealTranscodeLoadShed } from '$lib/server/services/preview-admission.service';
import { acquireWithWait } from '$lib/server/services/music-transcode/slot-wait';
import { assertTranscodeSourceIsMedia } from '$lib/server/services/music-transcode/source-guard';
import {
    buildProgressiveArgs,
    PROGRESSIVE_CONTENT_TYPES,
    type EncodableVideoCodec,
    type ProgressivePlan,
    type VideoEncoderChoice,
} from './progressive-transcode';

const logger = Logger.for('JellyfinCompat:ProgressiveTranscode');

/** How long a request waits for a free slot before the 503. */
const SLOT_WAIT_MS = 60_000;
const RETRY_AFTER_SECONDS = 10;

let active = 0;
const activeByUser = new Map<string, number>();

/** Test hook: the number of transcodes currently holding a slot. */
export function activeProgressiveTranscodes(): number {
    return active;
}

/**
 * How many of the global slots one user may hold: `FFMPEG_MAX_JOBS_PER_USER`,
 * the cap the HLS and music paths already apply. Without it the pool was one
 * counter for everybody and the per-user setting did not reach /j at all.
 */
function perUserSlotLimit(): number {
    const configured = config.FFMPEG_MAX_JOBS_PER_USER;
    return Number.isFinite(configured) && configured > 0 ? configured : Number.POSITIVE_INFINITY;
}

/**
 * Take a slot for the user with id `userId`; with no identity only the global cap applies. Throws the 503 cap rejection (which
 * `acquireWithWait` retries) when the pool is full or the user is at its limit.
 * Exported for the slot-accounting test.
 */
export async function acquireSlot(userId: string | undefined): Promise<() => void> {
    const cap = config.JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT;
    if (active >= cap) {
        throw Object.assign(new Error(`Progressive transcode cap of ${cap} reached`), {
            status: 503,
        });
    }
    const held = userId ? (activeByUser.get(userId) ?? 0) : 0;
    const userLimit = perUserSlotLimit();
    if (userId && held >= userLimit) {
        throw Object.assign(
            new Error(`Progressive transcode cap of ${userLimit} per user reached`),
            { status: 503 },
        );
    }
    active++;
    if (userId) activeByUser.set(userId, held + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        active--;
        if (!userId) return;
        const left = (activeByUser.get(userId) ?? 1) - 1;
        if (left <= 0) activeByUser.delete(userId);
        else activeByUser.set(userId, left);
    };
}

const SOFTWARE_ENCODERS: Record<EncodableVideoCodec, string> = {
    h264: 'libx264',
    hevc: 'libx265',
};

export function softwareEncoder(codec: EncodableVideoCodec): VideoEncoderChoice {
    return {
        name: SOFTWARE_ENCODERS[codec],
        codec,
        initArgs: [],
        needsHwUpload: false,
        preset: 'veryfast',
        pixFmt: 'yuv420p',
    };
}

/**
 * Describe a hardware encoder by its ffmpeg name. Mirrors the per-backend
 * quirks `download-rendition/hw-plan.ts` documents (QSV wants nv12, VA-API an
 * uploaded surface, NVENC's presets are versioned so none is passed).
 */
export function describeHardwareEncoder(name: string): VideoEncoderChoice | null {
    const codec: EncodableVideoCodec | null = name.startsWith('h264_')
        ? 'h264'
        : name.startsWith('hevc_')
          ? 'hevc'
          : null;
    if (!codec) return null;
    const backend = name.slice(name.indexOf('_') + 1);
    switch (backend) {
        case 'qsv':
            return {
                name,
                codec,
                initArgs: config.QSV_DEVICE ? ['-qsv_device', config.QSV_DEVICE] : [],
                needsHwUpload: false,
                preset: 'veryfast',
                pixFmt: 'nv12',
            };
        case 'vaapi':
            return {
                name,
                codec,
                initArgs: config.VAAPI_DEVICE ? ['-vaapi_device', config.VAAPI_DEVICE] : [],
                needsHwUpload: true,
                preset: null,
                pixFmt: null,
            };
        case 'nvenc':
        case 'amf':
        case 'videotoolbox':
            return {
                name,
                codec,
                initArgs: [],
                needsHwUpload: false,
                preset: null,
                pixFmt: 'yuv420p',
            };
        default:
            return null;
    }
}

/**
 * The configured GPU's encoder for `codec` when it passes the runtime probe,
 * else software. `getBestEncoder` already honours ALLOW_HEVC_ENCODING (it hands
 * back an H.264 encoder then), so the returned codec is the one to trust.
 */
async function chooseEncoder(codec: EncodableVideoCodec): Promise<VideoEncoderChoice> {
    try {
        const best = await hardwareDetection.getBestEncoder(codec);
        if (best) {
            const hw = describeHardwareEncoder(best);
            if (hw) return hw;
            if (best === 'libx264') return softwareEncoder('h264');
            if (best === 'libx265') return softwareEncoder('hevc');
        }
    } catch (err) {
        logger.warn('Encoder selection failed — using software', { codec, error: String(err) });
    }
    return softwareEncoder(codec);
}

type FfmpegChild = ChildProcessByStdio<null, Readable, Readable>;

interface StartedFfmpeg {
    child: FfmpegChild;
    firstChunk: Buffer;
    stderrTail: () => string;
}

/**
 * Spawn ffmpeg and wait for its first stdout bytes. Rejects (with the stderr
 * tail) if it exits before producing any — that is the window in which a
 * failed GPU attempt can still be retried without the client noticing.
 */
function startFfmpeg(args: string[], signal: AbortSignal): Promise<StartedFfmpeg> {
    return new Promise((resolve, reject) => {
        const child = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        const stderrTail = (): string => stderr.trim().slice(-800);
        child.stderr.on('data', (buf: Buffer) => {
            stderr = `${stderr}${buf.toString()}`.slice(-4000);
        });

        const onAbort = (): void => {
            child.kill('SIGKILL');
        };
        signal.addEventListener('abort', onAbort, { once: true });

        let settled = false;
        const onData = (chunk: Buffer): void => {
            if (settled) return;
            settled = true;
            child.stdout.pause();
            child.stdout.off('data', onData);
            child.off('close', onEarlyClose);
            resolve({ child, firstChunk: chunk, stderrTail });
        };
        const onEarlyClose = (code: number | null, sig: string | null): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(new Error(`ffmpeg exited ${code ?? sig} before output: ${stderrTail()}`));
        };
        child.stdout.on('data', onData);
        child.on('close', onEarlyClose);
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            reject(err);
        });
    });
}

/** The argv with `-format_whitelist` on the library input (see library-input-guard.ts). */
async function guardedArgs(
    plan: Extract<ProgressivePlan, { kind: 'transcode' }>,
    inputPath: string,
    encoder: VideoEncoderChoice | null,
): Promise<string[]> {
    const warm = prepareMediaFormatWhitelist();
    if (warm) await warm;
    return guardLibraryInput(buildProgressiveArgs(plan, inputPath, encoder), inputPath);
}

export interface ProgressiveTranscodeParams {
    plan: Extract<ProgressivePlan, { kind: 'transcode' }>;
    inputPath: string;
    request: Request;
    itemId: string;
    /** Logged. */
    username: string | undefined;
    /** Keys the per-user slot limit. Absent: only the global cap applies. */
    userId?: string | undefined;
}

function unavailable(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
        status: 503,
        headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(RETRY_AFTER_SECONDS),
        },
    });
}

export async function serveProgressiveTranscode(
    params: ProgressiveTranscodeParams,
): Promise<Response> {
    const { plan, inputPath, request, itemId, username, userId } = params;

    const shed = checkRealTranscodeLoadShed();
    if (shed.shed) {
        logger.warn('Progressive transcode refused by load-shed', {
            itemId,
            loadRatio: shed.loadRatio,
            threshold: shed.threshold,
        });
        return unavailable('Server is under heavy load');
    }

    // Runs before the slot: a playlist/manifest body must never reach ffmpeg.
    await assertTranscodeSourceIsMedia(inputPath, request.signal);

    let release: () => void;
    try {
        const slot = await acquireWithWait(() => acquireSlot(userId), {
            timeoutMs: SLOT_WAIT_MS,
            signal: request.signal,
        });
        release = slot.value;
        if (slot.waitedMs > 0) {
            logger.info('Progressive transcode queued for a slot', {
                itemId,
                waitedMs: slot.waitedMs,
            });
        }
    } catch (err) {
        if ((err as { status?: number }).status === 503) {
            return unavailable('Too many transcodes in progress');
        }
        throw err;
    }

    // Our own controller: request abort OR body cancel both stop ffmpeg.
    const kill = new AbortController();
    const onRequestAbort = (): void => kill.abort();
    if (request.signal.aborted) kill.abort();
    else request.signal.addEventListener('abort', onRequestAbort, { once: true });

    const encode = plan.video?.mode === 'encode' ? plan.video : null;
    let encoder = encode ? await chooseEncoder(encode.codec) : null;
    const startedAt = Date.now();

    let started: StartedFfmpeg;
    try {
        try {
            started = await startFfmpeg(await guardedArgs(plan, inputPath, encoder), kill.signal);
        } catch (err) {
            if (
                !encoder ||
                SOFTWARE_ENCODERS[encoder.codec] === encoder.name ||
                kill.signal.aborted
            ) {
                throw err;
            }
            logger.warn('GPU progressive transcode failed before output — retrying in software', {
                itemId,
                encoder: encoder.name,
                error: err instanceof Error ? err.message : String(err),
            });
            encoder = softwareEncoder(encoder.codec);
            started = await startFfmpeg(await guardedArgs(plan, inputPath, encoder), kill.signal);
        }
    } catch (err) {
        release();
        request.signal.removeEventListener('abort', onRequestAbort);
        if (kill.signal.aborted) {
            return new Response(null, { status: 499 });
        }
        logger.error('Progressive transcode failed to start', undefined, {
            itemId,
            error: err instanceof Error ? err.message : String(err),
        });
        return new Response(JSON.stringify({ error: 'Transcode failed' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    logger.info('Progressive transcode started', {
        itemId,
        username,
        container: plan.container,
        video:
            plan.video?.mode === 'encode'
                ? `${encoder?.name} ${plan.video.bitrate}bps max ${plan.video.maxWidth ?? '-'}x${plan.video.maxHeight ?? '-'}${plan.video.tonemap ? ' tonemap' : ''}`
                : (plan.video?.mode ?? 'none'),
        audio:
            plan.audio?.mode === 'encode'
                ? `${plan.audio.codec} ${plan.audio.channels}ch`
                : (plan.audio?.mode ?? 'none'),
        startSeconds: plan.startSeconds,
    });

    const { child, firstChunk, stderrTail } = started;
    let bytes = firstChunk.length;
    // Set by cancel(). Chunks already buffered on ffmpeg's stdout still emit
    // 'data' after the client has gone; enqueueing into the closed controller
    // throws ERR_INVALID_STATE from inside the event emitter.
    let cancelled = false;

    const body = new ReadableStream<Uint8Array>(
        {
            start(controller) {
                controller.enqueue(new Uint8Array(firstChunk));
                child.stdout.on('data', (chunk: Buffer) => {
                    if (cancelled || kill.signal.aborted) return;
                    bytes += chunk.length;
                    try {
                        controller.enqueue(new Uint8Array(chunk));
                    } catch {
                        // Stream closed by another route (defence in depth next to
                        // `cancelled`): stop ffmpeg and stop reading its pipe.
                        cancelled = true;
                        kill.abort();
                        child.stdout.destroy();
                        return;
                    }
                    // Backpressure: stop reading ffmpeg (which then blocks on its
                    // pipe and stops encoding) while the client is not keeping up.
                    if ((controller.desiredSize ?? 1) <= 0) child.stdout.pause();
                });
                child.on('close', (code, signal) => {
                    release();
                    request.signal.removeEventListener('abort', onRequestAbort);
                    const fields = {
                        itemId,
                        exitCode: code,
                        signal,
                        bytes,
                        durationMs: Date.now() - startedAt,
                    };
                    if (code === 0) {
                        logger.info('Progressive transcode finished', fields);
                        try {
                            controller.close();
                        } catch {
                            // Already cancelled by the client.
                        }
                        return;
                    }
                    if (kill.signal.aborted) {
                        logger.info('Progressive transcode stopped: client disconnected', fields);
                        return;
                    }
                    logger.warn('Progressive transcode failed mid-stream', {
                        ...fields,
                        stderr: stderrTail(),
                    });
                    try {
                        // Erroring the stream truncates the response, so the client
                        // sees a failed download rather than a short "complete" file.
                        controller.error(new Error(`ffmpeg exited ${code ?? signal}`));
                    } catch {
                        // Already cancelled by the client.
                    }
                });
                child.stdout.resume();
            },
            pull() {
                child.stdout.resume();
            },
            cancel() {
                cancelled = true;
                kill.abort();
                // ffmpeg is being killed; drop whatever is still buffered on its pipe.
                child.stdout.destroy();
            },
        },
        { highWaterMark: 16 },
    );

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': PROGRESSIVE_CONTENT_TYPES[plan.container],
            'Cache-Control': 'no-store',
            // A live encode has no byte offsets to seek to.
            'Accept-Ranges': 'none',
        },
    });
}
