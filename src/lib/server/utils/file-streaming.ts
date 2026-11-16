// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared file streaming utilities for Range-aware HTTP responses.
 *
 * Used by direct-play routes and the Jellyfin compat stream handler.
 */

import { extname } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseRangeHeader } from '$lib/server/utils/hls-request-utils.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { throttleNodeStream } from '$lib/server/utils/throttled-stream.js';
import {
    createNoFollowReadStream,
    resolveContainedMediaFile,
} from '$lib/server/utils/contained-fs.js';

// ============================================================================
// MIME TYPE MAP
// ============================================================================

const MIME_MAP: Record<string, string> = {
    // Video
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.ts': 'video/MP2T',
    // Audio
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
    '.alac': 'audio/mp4',
};

/**
 * Resolve a file extension to a MIME type.
 * Extension must include the leading dot (e.g. `.mp4`).
 * Returns `application/octet-stream` for unknown extensions.
 */
export function getMimeType(ext: string): string {
    return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream';
}

// ============================================================================
// STAT CACHE — avoids repeated stat() calls during seek bursts (NFS/CIFS)
// ============================================================================

interface FileStat {
    size: number;
    /** Epoch ms, or `null` when the filesystem did not report one. */
    mtimeMs: number | null;
}

interface CachedStat extends FileStat {
    expires: number;
}

const statCache = new Map<string, CachedStat>();
const STAT_CACHE_TTL_MS = 5_000;
const STAT_CACHE_MAX_ENTRIES = 100;

async function getCachedStat(filePath: string): Promise<FileStat> {
    const now = Date.now();
    const cached = statCache.get(filePath);
    if (cached && cached.expires > now) {
        return { size: cached.size, mtimeMs: cached.mtimeMs };
    }

    const stats = await stat(filePath);
    const mtimeMs = Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;

    // Evict oldest entry if at capacity
    if (!statCache.has(filePath) && statCache.size >= STAT_CACHE_MAX_ENTRIES) {
        const firstKey = statCache.keys().next().value;
        if (firstKey) statCache.delete(firstKey);
    }

    statCache.set(filePath, {
        size: stats.size,
        mtimeMs,
        expires: now + STAT_CACHE_TTL_MS,
    });
    return { size: stats.size, mtimeMs };
}

// ============================================================================
// VALIDATORS (ETag / Last-Modified)
// ============================================================================

interface FileValidators {
    /** STRONG entity-tag — see `buildValidators` for why it must not be weak. */
    etag: string;
    /** RFC 9110 HTTP-date, or `null` when the fs reported no mtime. */
    lastModified: string | null;
}

/**
 * Derive `ETag` / `Last-Modified` for a library file from (size, mtime).
 *
 * The entity-tag is deliberately **strong** (no `W/` prefix). A weak validator
 * is not usable with `If-Range` (RFC 9110 §13.1.5), and `If-Range` is the whole
 * point: iOS background downloads resume through `URLSessionDownloadTask` resume
 * data, which replays the byte offset with the validator it first saw. Without a
 * validator the client cannot verify the bytes it already has still belong to the
 * same file, so every interrupted multi-GB download restarts from zero.
 *
 * (size, mtime) is a sound strong validator here because these are scanner-owned
 * files on disk, not generated content: any re-encode/replace rewrites the file
 * and moves mtime. The one theoretical miss — a same-size edit within the same
 * millisecond — cannot arise from a media library workflow.
 */
function buildValidators(size: number, mtimeMs: number | null): FileValidators {
    if (mtimeMs === null) {
        return { etag: `"${size.toString(16)}"`, lastModified: null };
    }
    return {
        etag: `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`,
        // HTTP-date has second resolution — floor so it round-trips through a
        // client's If-Range echo without an off-by-one-second mismatch.
        lastModified: new Date(Math.floor(mtimeMs / 1000) * 1000).toUTCString(),
    };
}

/**
 * Decide whether a client's `If-Range` still matches the file on disk.
 *
 * A mismatch means "the file changed since you started" — the caller must then
 * ignore the `Range` and send the whole representation (RFC 9110 §13.1.5), which
 * is what stops a resumed download from stitching new bytes onto stale ones.
 */
function ifRangeMatches(ifRange: string, validators: FileValidators): boolean {
    const value = ifRange.trim();

    // Entity-tag form. A weak tag ("W/...") is never valid for If-Range.
    if (value.startsWith('"')) return value === validators.etag;
    if (value.startsWith('W/')) return false;

    // HTTP-date form — must match Last-Modified exactly, at second resolution.
    if (!validators.lastModified) return false;
    const supplied = Date.parse(value);
    if (Number.isNaN(supplied)) return false;
    return supplied === Date.parse(validators.lastModified);
}

// ============================================================================
// PREFLIGHT: HEAD and conditional requests, decided before any lease or stream
// ============================================================================

export type PreflightResult =
    /** Answer with this response; nothing was leased, tracked or opened. */
    | { kind: 'response'; response: Response }
    /** The path was refused (outside the library, swapped link): answer 404. */
    | { kind: 'refused' }
    /** A body is needed: take the lease and serve. */
    | { kind: 'proceed' };

export interface PreflightOptions {
    /** `true` for a library media file (re-contained, no symlink following), like `serveContainedMediaFile`. */
    contained: boolean;
    method: string;
    ifNoneMatch?: string | null;
    ifModifiedSince?: string | null;
    disposition?: string;
    extraHeaders?: Record<string, string>;
    /** Path whose extension names the Content-Type, when `filePath` is a canonical target without it. */
    mimePath?: string;
}

/** RFC 9110 weak comparison of an If-None-Match list against our strong ETag. */
function ifNoneMatchHits(header: string, etag: string): boolean {
    const bare = (t: string): string => t.trim().replace(/^W\//, '');
    return header
        .split(',')
        .map(bare)
        .some((t) => t === '*' || t === etag);
}

/**
 * Answer a HEAD, or a conditional GET that matches (304), from the file's metadata alone.
 *
 * It runs before a download takes its lease: a HEAD or a 304 must hold no slot, write no
 * log row and open no file stream. `If-None-Match` wins over `If-Modified-Since` when both
 * are sent (RFC 9110 §13.2.2). A HEAD ignores `Range`.
 */
export async function preflightFile(
    filePath: string,
    opts: PreflightOptions,
): Promise<PreflightResult> {
    let statPath = filePath;
    if (opts.contained) {
        const servePath = await resolveContainedMediaFile(filePath, [], { parents: true });
        if (!servePath) return { kind: 'refused' };
        statPath = servePath;
    }
    const { size, mtimeMs } = await getCachedStat(statPath);
    const validators = buildValidators(size, mtimeMs);
    const headers: Record<string, string> = { ...opts.extraHeaders, ETag: validators.etag };
    if (validators.lastModified) headers['Last-Modified'] = validators.lastModified;

    let notModified = false;
    if (opts.ifNoneMatch) {
        notModified = ifNoneMatchHits(opts.ifNoneMatch, validators.etag);
    } else if (opts.ifModifiedSince && validators.lastModified) {
        const since = Date.parse(opts.ifModifiedSince);
        notModified = !Number.isNaN(since) && Date.parse(validators.lastModified) <= since;
    }
    if (notModified) {
        return { kind: 'response', response: new Response(null, { status: 304, headers }) };
    }
    if (opts.method === 'HEAD') {
        return {
            kind: 'response',
            response: new Response(null, {
                status: 200,
                headers: {
                    'Content-Type': getMimeType(extname(opts.mimePath ?? filePath).toLowerCase()),
                    'Content-Length': String(size),
                    'Accept-Ranges': 'bytes',
                    'Content-Disposition': opts.disposition ?? 'inline',
                    ...headers,
                },
            }),
        };
    }
    return { kind: 'proceed' };
}

// ============================================================================
// FILE STREAMING
// ============================================================================

/**
 * Serve a local file with full Range-request support.
 *
 * - No Range header → 200 with full file stream
 * - Valid Range header → 206 with partial stream
 * - Invalid Range header → 416 Range Not Satisfiable
 *
 * Always sets `Accept-Ranges: bytes`, plus `ETag`/`Last-Modified` so clients can
 * validate a resumed transfer. `Content-Disposition` defaults to `inline`
 * (playback) — pass a full header value (e.g. from `attachmentDisposition()`) to
 * serve as a download instead.
 *
 * Pass the request's `If-Range` to get conditional-range semantics: when it no
 * longer matches the file, the `Range` is ignored and the full file is sent
 * rather than a partial response the client would splice onto stale bytes.
 */
export async function serveFileByPath(
    filePath: string,
    rangeHeader: string | null,
    sessionId?: string,
    disposition = 'inline',
    ifRange?: string | null,
    /**
     * Per-response bandwidth cap in bytes/sec. 0 or omitted = unlimited.
     * Applied here rather than at each call site so the `/j` compat surface, the
     * public API and rendition downloads cannot drift apart on it — they all
     * reach the wire through this one function.
     */
    throttleBytesPerSec: number | (() => number) = 0,
    observer?: StreamObserver,
): Promise<Response> {
    return serveFile(filePath, extname(filePath), false, rangeHeader, {
        sessionId,
        disposition,
        ifRange,
        throttleBytesPerSec,
        observer,
    });
}

/**
 * Observer for a response body: lets a caller count the bytes that left the
 * server and learn how the transfer ended.
 */
export interface StreamObserver {
    /** Called with the size of each chunk handed to the client. */
    onBytes?(n: number): void;
    /**
     * Called exactly once when the body is finished: `completed` = source fully read,
     * `aborted` = the client cancelled, `error` = the source failed.
     */
    onEnd?(outcome: 'completed' | 'aborted' | 'error'): void;
    /**
     * Called once with a function that tears the body down from the server side
     * (stops reading the file and errors the response), for a watchdog or a revoked lease.
     */
    setCancel?(cancel: () => void): void;
}

export interface ServeFileOptions {
    sessionId?: string;
    disposition?: string;
    ifRange?: string | null;
    /** Bytes/sec cap; a function is re-read while streaming (see `throttleNodeStream`). */
    throttleBytesPerSec?: number | (() => number);
    observer?: StreamObserver;
    /** Extra response headers (e.g. CORS for a compat surface). */
    extraHeaders?: Record<string, string>;
    /** Path whose extension names the Content-Type, when the served path is a canonical target without it. */
    mimePath?: string;
    /**
     * A file the caller already opened and verified (see `openDownloadableFile`): validators
     * come from its descriptor and the bytes are streamed FROM it, so the path is never
     * resolved a second time. The handle is closed when the body ends, or here when no body is sent.
     */
    opened?: OpenedFile;
}

export interface OpenedFile {
    handle: import('node:fs/promises').FileHandle;
    size: number;
    mtimeMs: number | null;
}

/**
 * {@link serveFileByPath} for a download whose file was opened and verified once by
 * `openDownloadableFile`: no second path resolution, so a swap after the check cannot redirect it.
 */
export async function serveOpenedDownload(
    opened: OpenedFile,
    ext: string,
    rangeHeader: string | null,
    opts: ServeFileOptions = {},
): Promise<Response> {
    return serveFile('', ext, true, rangeHeader, { ...opts, opened });
}

/** Wrap a body so `observer` sees every chunk and the end. Identity when there is no observer. */
function observeStream(
    body: ReadableStream<Uint8Array>,
    observer: StreamObserver | undefined,
): ReadableStream<Uint8Array> {
    if (!observer || (!observer.onBytes && !observer.onEnd && !observer.setCancel)) return body;
    const reader = body.getReader();
    let ended = false;
    const end = (outcome: 'completed' | 'aborted' | 'error'): void => {
        if (ended) return;
        ended = true;
        try {
            observer.onEnd?.(outcome);
        } catch {
            // an observer must never break the transfer
        }
    };
    return new ReadableStream<Uint8Array>({
        start(controller) {
            observer.setCancel?.(() => {
                end('aborted');
                reader.cancel().catch(() => {});
                try {
                    controller.error(new Error('download cancelled by the server'));
                } catch {
                    // already closed or errored
                }
            });
        },
        async pull(controller) {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    end('completed');
                    controller.close();
                    return;
                }
                try {
                    observer.onBytes?.(value.byteLength);
                } catch {
                    // see above
                }
                controller.enqueue(value);
            } catch (err) {
                end('error');
                controller.error(err);
            }
        },
        async cancel(reason) {
            end('aborted');
            await reader.cancel(reason);
        },
    });
}

/**
 * {@link serveFileByPath} for a library MEDIA file whose path comes from the
 * database. The scan checked the path, but a link swapped in since then (for
 * the file or a directory above it) would be followed, so it is re-contained
 * here ({@link resolveContainedMediaFile} with `parents`) and the resolved real
 * path is opened with O_NOFOLLOW. The Content-Type still follows `filePath`'s
 * extension (a debrid link target often has none). Returns null when refused;
 * callers answer 404.
 */
export async function serveContainedMediaFile(
    filePath: string,
    rangeHeader: string | null,
    opts: ServeFileOptions = {},
): Promise<Response | null> {
    const servePath = await resolveContainedMediaFile(filePath, [], { parents: true });
    if (!servePath) return null;
    return serveFile(servePath, extname(opts.mimePath ?? filePath), true, rangeHeader, opts);
}

async function serveFile(
    filePath: string,
    ext: string,
    noFollow: boolean,
    rangeHeader: string | null,
    {
        sessionId,
        disposition = 'inline',
        ifRange,
        throttleBytesPerSec = 0,
        observer,
        extraHeaders,
        opened,
    }: ServeFileOptions,
): Promise<Response> {
    const { size: fileSize, mtimeMs } = opened ?? (await getCachedStat(filePath));
    const source = (range?: { start: number; end: number }) =>
        opened
            ? opened.handle.createReadStream(range ? { start: range.start, end: range.end } : {})
            : noFollow
              ? createNoFollowReadStream(filePath, range)
              : createReadStream(filePath, range);
    const validators = buildValidators(fileSize, mtimeMs);

    const contentType = getMimeType(ext.toLowerCase());

    const validatorHeaders: Record<string, string> = { ...extraHeaders, ETag: validators.etag };
    if (validators.lastModified) validatorHeaders['Last-Modified'] = validators.lastModified;

    // A stale If-Range demotes the request to a full-file transfer.
    if (rangeHeader && ifRange && !ifRangeMatches(ifRange, validators)) {
        rangeHeader = null;
    }

    if (!rangeHeader) {
        bandwidthTracker.trackDirectPlay(fileSize);
        if (sessionId) bandwidthTracker.trackSession(sessionId, fileSize);
        return new Response(
            observeStream(throttleNodeStream(await source(), throttleBytesPerSec), observer),
            {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': String(fileSize),
                    'Accept-Ranges': 'bytes',
                    'Content-Disposition': disposition,
                    ...validatorHeaders,
                },
            },
        );
    }

    const range = parseRangeHeader(rangeHeader, fileSize);
    if (!range) {
        await opened?.handle.close().catch(() => {});
        return new Response(null, {
            status: 416,
            headers: {
                'Content-Range': `bytes */${fileSize}`,
            },
        });
    }

    const { start, end } = range;
    const chunkSize = end - start + 1;

    bandwidthTracker.trackDirectPlay(chunkSize);
    if (sessionId) bandwidthTracker.trackSession(sessionId, chunkSize);
    return new Response(
        observeStream(
            throttleNodeStream(await source({ start, end }), throttleBytesPerSec),
            observer,
        ),
        {
            status: 206,
            headers: {
                'Content-Type': contentType,
                'Content-Length': String(chunkSize),
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Disposition': disposition,
                ...validatorHeaders,
            },
        },
    );
}
