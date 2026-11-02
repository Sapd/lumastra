// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { throttleNodeStream, kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream.js';
import { config } from '$lib/server/config.js';
import { stat } from 'node:fs/promises';

import { translateToActualIndex, type SegmentInfo } from '../../utils/hls-segment-utils.js';
import {
    createSegmentNotFoundResponse,
    SESSION_SEGMENT_CACHE_CONTROL,
    type SegmentResponseContext,
} from './segment-action-executor.js';
import { playbackTelemetryService } from '../playback-telemetry.service.js';
import type { TranscodeJob } from '../transcoding/types.js';
import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';
import { storeEndSegment, type EndSegmentGrid } from './end-segment-cache.js';

/**
 * Emit a server-side `segment_bytes` telemetry event for a delivered HLS
 * segment (fire-and-forget). `deviceId` is reachable from the job config;
 * `userId` is not in scope on this layer, so it is omitted. An optional
 * `deliveryMs` adds a `segment_delivery_ms` event when the duration is
 * cleanly observable (buffered path only). Best-effort: any failure is
 * swallowed so telemetry never affects the playback hot path.
 */
function recordSegmentMetric(
    options: ServeHlsSegmentFileOptions,
    metric: 'segment_bytes' | 'segment_delivery_ms',
    value: number,
): void {
    try {
        const deviceId = options.job?.config?.deviceId;
        const recordOptions = deviceId ? { deviceId } : undefined;
        void playbackTelemetryService
            .record(options.playSessionId, 'server', metric, value, recordOptions)
            .catch(() => {
                /* best-effort telemetry — never affects playback */
            });
    } catch {
        /* best-effort telemetry — never affects playback */
    }
}

function emitSegmentTelemetry(
    options: ServeHlsSegmentFileOptions,
    bytes: number,
    deliveryMs?: number,
): void {
    // Guard: skip zero/negative/NaN byte counts so empty segments don't
    // skew throughput aggregates.
    if (Number.isFinite(bytes) && bytes > 0) {
        recordSegmentMetric(options, 'segment_bytes', bytes);
    }
    if (deliveryMs !== undefined) {
        recordSegmentMetric(options, 'segment_delivery_ms', deliveryMs);
    }
}

/**
 * Time a streamed whole-segment delivery with ONE listener on the source
 * stream's completion, so the per-chunk hot path stays untouched.
 *
 * Why this has to exist: `segment_delivery_ms` used to come only from
 * `serveFromBuffer` (tail segments and seek pre-reads). Those are a rounding
 * error next to sequential playback — prod 2026-09-11 measured 65
 * `segment_delivery_ms` rows against 20,660 `segment_bytes` — so
 * `playback_session_quality.server_avg_segment_time_ms` was NULL for 100% of
 * `hls_js` and `native_hls` sessions. With that NULL, none of
 * `calculateHealthScore`'s server-delivery tests can fire and every stall
 * falls through to the residual `cause:client_side_stall` label, which reads
 * as "the client's fault" when it actually means "we could not tell".
 *
 * Backpressure is what makes the source stream's `end` a meaningful proxy for
 * flush time: `throttleNodeStream` pulls from the Node stream only as the
 * response drains, so `end` lands when the last byte has been handed to the
 * consumer rather than when the file finished reading.
 *
 * Two deliberate exclusions, both to keep the fleet p95 comparable:
 * - an ABORTED transfer never fires `end` (cancelling destroys the source), so
 *   Safari's routine cancel-and-re-request does not contribute a truncated
 *   sample;
 * - a THROTTLED response measures the operator's own `TRANSCODE_THROTTLE_KBPS`
 *   cap rather than delivery, which would make the scorer blame the network
 *   for a configured limit.
 */
function observeStreamedDelivery(
    options: ServeHlsSegmentFileOptions,
    nodeStream: Readable,
    bytes: number,
    throttleBytesPerSecond: number,
): void {
    if (throttleBytesPerSecond > 0) return;
    if (!Number.isFinite(bytes) || bytes <= 0) return;

    const startedAt = Date.now();
    nodeStream.once('end', () => {
        const deliveryMs = Date.now() - startedAt;
        if (!Number.isFinite(deliveryMs) || deliveryMs < 0) return;
        recordSegmentMetric(options, 'segment_delivery_ms', deliveryMs);
    });
}

export interface ServeHlsSegmentFileOptions {
    responseContext: SegmentResponseContext;
    job: TranscodeJob;
    playSessionId: string;
    segmentPath: string;
    filePath: string;
    contentType: string;
    rangeHeader: string | null;
    segmentInfo: SegmentInfo | null;
    requestedSegmentNum: number;
    isVideoTranscoded: boolean;
    streamTargetDuration: number;
    jobSegmentDuration: number;
    readFile: (filePath: string) => Promise<Buffer>;
    clearRepeatedSegmentRequest: (
        playSessionId: string,
        streamDir: string,
        requestedSegmentNum: number,
    ) => void;
    getStreamSegmentOffsetForJob: (job: TranscodeJob, streamDirName: string) => number;
    recordSegmentAccessForJob: (
        job: TranscodeJob,
        streamDirName: string,
        segmentIndex: number,
    ) => void;
    trackHlsSegment: (bytes: number) => void;
    onSegmentServed?: (served: {
        streamDir: string;
        requestedSegment: number;
        actualSegment: number;
        segmentOffset: number;
    }) => void;
    logDebug: (message: string, metadata: Record<string, unknown>) => void;
    /** Pre-read buffer from a seek wait loop (avoids re-reading a file that may be deleted). */
    preReadBuffer?: Buffer;
    /** Override stat for testing. Returns { size: number }. */
    statFile?: (filePath: string) => Promise<{ size: number }>;
}

/**
 * Check whether this segment is near the tail of the VOD timeline and
 * needs to be cached in endSegmentCache for hls.js duration probes.
 *
 * Only applies to demuxed HLS — in muxed mode there's no separate audio
 * stream that probes the last segment, so the tail cache is never consulted.
 */
function isTailSegment(options: ServeHlsSegmentFileOptions): boolean {
    return tailSegmentGrid(options) !== null;
}

/** The stream's grid when this request is in its tail window, else null. */
function tailSegmentGrid(options: ServeHlsSegmentFileOptions): EndSegmentGrid | null {
    if (!options.segmentInfo || !options.job.config.totalDurationSeconds) {
        return null;
    }
    // Muxed HLS doesn't use tail caching — audio and video are in the same stream
    if (options.job.config.hlsOutput?.hlsAudioMode === 'muxed') {
        return null;
    }
    const grid = {
        totalSeconds: options.job.config.totalDurationSeconds,
        segmentSeconds: options.streamTargetDuration || options.jobSegmentDuration,
    };
    const streamTotal = uniformSegmentCount(grid.totalSeconds, grid.segmentSeconds);
    return options.requestedSegmentNum >= streamTotal - 3 ? grid : null;
}

export async function serveHlsSegmentFile(options: ServeHlsSegmentFileOptions): Promise<Response> {
    // Pre-read buffer (from seek wait loop) or tail segments that need caching
    // are served from a Buffer. All other segments are streamed from disk.
    const needsBuffer = options.preReadBuffer || isTailSegment(options);

    if (needsBuffer) {
        return serveFromBuffer(options);
    }
    return serveFromStream(options);
}

/**
 * Buffer-based serving path. Used for:
 * - Pre-read buffers from seek wait loops (TOCTOU protection)
 * - Tail segments that must be cached in endSegmentCache
 */
async function serveFromBuffer(options: ServeHlsSegmentFileOptions): Promise<Response> {
    // Buffered path: file read → Response build is fully observable, so we can
    // report a meaningful segment_delivery_ms (read + range/cache work).
    const startedAt = Date.now();
    let fileBuffer: Buffer;
    try {
        fileBuffer = options.preReadBuffer ?? (await options.readFile(options.filePath));
        clearRepeated(options);
    } catch {
        // best-effort: TOCTOU race — segment deleted between check and read; reported via 404-style response.
        return createSegmentNotFoundResponse(
            options.responseContext,
            'read_race_deleted',
            'Segment no longer available',
        );
    }

    const fileSize = fileBuffer.length;
    emitAccess(options);

    const rangeResponse = serveBufferRange(options, fileBuffer, fileSize);
    if (rangeResponse) return rangeResponse;

    cacheEndSegmentIfNeeded(options, fileBuffer);

    options.logDebug('Serving segment (buffered)', {
        playSessionId: options.playSessionId,
        path: options.segmentPath,
        size: fileSize,
        contentType: options.contentType,
        requestedSegment: options.segmentInfo?.segmentIndex,
    });

    options.trackHlsSegment(fileSize);
    // Emit segment_delivery_ms only when an actual file read occurred.
    // When preReadBuffer was already supplied (seek wait loop), no read
    // happened and the elapsed time is near-zero — emitting it would bias
    // fleet p95 delivery-time metrics low.
    const didRead = options.preReadBuffer === undefined;
    emitSegmentTelemetry(options, fileSize, didRead ? Date.now() - startedAt : undefined);

    return new Response(fileBuffer as unknown as ArrayBuffer, {
        status: 200,
        headers: {
            'Content-Type': options.contentType,
            'Content-Length': fileSize.toString(),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
            ...debugHeaders(options.responseContext, 'serve'),
        },
    });
}

/**
 * Streaming path — reads segment data from disk through a ReadableStream
 * without buffering the entire file in Node.js memory. This is the hot path
 * for normal sequential playback, handling the vast majority of requests.
 *
 * Uses stat() for file size, then createReadStream(filePath) for streaming.
 * Path-based createReadStream manages its own fd lifecycle internally,
 * avoiding the Node.js v25 DEP0137 crash where orphaned FileHandle objects
 * cause a fatal ERR_INVALID_STATE on garbage collection.
 */
async function serveFromStream(options: ServeHlsSegmentFileOptions): Promise<Response> {
    const statFn = options.statFile ?? stat;
    let fileSize: number;
    // Delivery timing comes from observeStreamedDelivery() below: a single
    // 'end' listener on the source stream, never a per-chunk hook.
    try {
        const fileStat = await statFn(options.filePath);
        fileSize = fileStat.size;
    } catch {
        // best-effort: TOCTOU race — segment deleted before stat; reported via 404-style response.
        return createSegmentNotFoundResponse(
            options.responseContext,
            'read_race_deleted',
            'Segment no longer available',
        );
    }

    clearRepeated(options);
    emitAccess(options);

    // Range request — stream only the requested byte range
    const rangeResponse = serveStreamRange(options, fileSize);
    if (rangeResponse) return rangeResponse;

    options.logDebug('Serving segment (streamed)', {
        playSessionId: options.playSessionId,
        path: options.segmentPath,
        size: fileSize,
        contentType: options.contentType,
        requestedSegment: options.segmentInfo?.segmentIndex,
    });

    options.trackHlsSegment(fileSize);
    emitSegmentTelemetry(options, fileSize);

    const nodeStream = createReadStream(options.filePath);
    // TRANSCODE_THROTTLE_KBPS, not the download cap: a stream held below its own
    // bitrate rebuffers forever, so the two limits are deliberately separate.
    const throttleBytesPerSecond = kbpsToBytesPerSecond(config.TRANSCODE_THROTTLE_KBPS);
    observeStreamedDelivery(options, nodeStream, fileSize, throttleBytesPerSecond);
    const body = throttleNodeStream(nodeStream, throttleBytesPerSecond) as ReadableStream;

    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': options.contentType,
            'Content-Length': fileSize.toString(),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
            ...debugHeaders(options.responseContext, 'serve'),
        },
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function clearRepeated(options: ServeHlsSegmentFileOptions): void {
    if (options.segmentInfo && options.requestedSegmentNum >= 0) {
        options.clearRepeatedSegmentRequest(
            options.playSessionId,
            options.segmentInfo.streamDir,
            options.requestedSegmentNum,
        );
    }
}

function emitAccess(options: ServeHlsSegmentFileOptions): void {
    const access = recordSegmentAccess(options);
    if (access) {
        options.onSegmentServed?.(access);
    }
}

function recordSegmentAccess(options: ServeHlsSegmentFileOptions):
    | {
          streamDir: string;
          requestedSegment: number;
          actualSegment: number;
          segmentOffset: number;
      }
    | undefined {
    if (!options.segmentInfo) return undefined;

    const segmentOffset = options.getStreamSegmentOffsetForJob(
        options.job,
        options.segmentInfo.streamDir,
    );
    const actualIndexForRecording = options.isVideoTranscoded
        ? options.segmentInfo.segmentIndex
        : translateToActualIndex(options.segmentInfo.segmentIndex, segmentOffset);
    options.recordSegmentAccessForJob(
        options.job,
        options.segmentInfo.streamDir,
        actualIndexForRecording,
    );

    return {
        streamDir: options.segmentInfo.streamDir,
        requestedSegment: options.segmentInfo.segmentIndex,
        actualSegment: actualIndexForRecording,
        segmentOffset,
    };
}

// ---------------------------------------------------------------------------
// Buffer-based range serving (for pre-read and tail-cached segments)
// ---------------------------------------------------------------------------

function serveBufferRange(
    options: ServeHlsSegmentFileOptions,
    fileBuffer: Buffer,
    fileSize: number,
): Response | undefined {
    if (!options.rangeHeader) return undefined;

    const rangeMatch = options.rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!rangeMatch) return undefined;

    const start = parseInt(rangeMatch[1], 10);
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;

    if (start >= fileSize) {
        return new Response('Range Not Satisfiable', {
            status: 416,
            headers: {
                ...options.responseContext.corsHeaders,
                'Content-Range': `bytes */${fileSize}`,
            },
        });
    }

    const actualEnd = Math.min(end, fileSize - 1);
    const contentLength = actualEnd - start + 1;

    options.logDebug('Serving partial segment (Range request)', {
        playSessionId: options.playSessionId,
        path: options.segmentPath,
        range: `${start}-${actualEnd}/${fileSize}`,
        contentLength,
        requestedSegment: options.segmentInfo?.segmentIndex,
    });

    options.trackHlsSegment(contentLength);
    emitSegmentTelemetry(options, contentLength);

    return new Response(fileBuffer.subarray(start, actualEnd + 1) as unknown as ArrayBuffer, {
        status: 206,
        headers: {
            'Content-Type': options.contentType,
            'Content-Length': contentLength.toString(),
            'Content-Range': `bytes ${start}-${actualEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
            ...debugHeaders(options.responseContext, 'serve_range'),
        },
    });
}

// ---------------------------------------------------------------------------
// Stream-based range serving (for normal disk segments)
// ---------------------------------------------------------------------------

function serveStreamRange(
    options: ServeHlsSegmentFileOptions,
    fileSize: number,
): Response | undefined {
    if (!options.rangeHeader) return undefined;

    const rangeMatch = options.rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!rangeMatch) return undefined;

    const start = parseInt(rangeMatch[1], 10);
    const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : fileSize - 1;

    if (start >= fileSize) {
        return new Response('Range Not Satisfiable', {
            status: 416,
            headers: {
                ...options.responseContext.corsHeaders,
                'Content-Range': `bytes */${fileSize}`,
            },
        });
    }

    const actualEnd = Math.min(end, fileSize - 1);
    const contentLength = actualEnd - start + 1;

    options.logDebug('Serving partial segment (Range request, streamed)', {
        playSessionId: options.playSessionId,
        path: options.segmentPath,
        range: `${start}-${actualEnd}/${fileSize}`,
        contentLength,
        requestedSegment: options.segmentInfo?.segmentIndex,
    });

    options.trackHlsSegment(contentLength);
    emitSegmentTelemetry(options, contentLength);

    const nodeStream = createReadStream(options.filePath, {
        start,
        end: actualEnd,
    });
    const body = throttleNodeStream(
        nodeStream,
        kbpsToBytesPerSecond(config.TRANSCODE_THROTTLE_KBPS),
    ) as ReadableStream;

    return new Response(body, {
        status: 206,
        headers: {
            'Content-Type': options.contentType,
            'Content-Length': contentLength.toString(),
            'Content-Range': `bytes ${start}-${actualEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': SESSION_SEGMENT_CACHE_CONTROL,
            ...debugHeaders(options.responseContext, 'serve_range'),
        },
    });
}

// ---------------------------------------------------------------------------
// Tail cache
// ---------------------------------------------------------------------------

function cacheEndSegmentIfNeeded(options: ServeHlsSegmentFileOptions, fileBuffer: Buffer): void {
    const grid = tailSegmentGrid(options);
    if (grid && options.segmentInfo) {
        // Keyed by the playlist entry the client asked for: the cache answers
        // that index only (end-segment-cache.ts).
        storeEndSegment(
            options.job.endSegmentCache,
            options.segmentInfo.streamDir,
            { kind: 'segment', segmentIndex: options.requestedSegmentNum, buffer: fileBuffer },
            grid,
        );
    }
}

function debugHeaders(context: SegmentResponseContext, branch: string): Record<string, string> {
    return context.buildDebugHeaders({
        job: context.job,
        segmentOffset: context.segmentOffset,
        requestedSegmentNum: context.requestedSegmentNum,
        actualSegmentIndex: context.actualSegmentIndex,
        streamDirName: context.streamDirName,
        playSessionId: context.playSessionId,
        branch,
        canSeek: context.canSeek,
        streamTargetDuration: context.streamTargetDuration,
    });
}
