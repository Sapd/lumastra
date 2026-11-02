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
    throttleBytesPerSec = 0,
): Promise<Response> {
    return serveFile(filePath, extname(filePath), false, rangeHeader, {
        sessionId,
        disposition,
        ifRange,
        throttleBytesPerSec,
    });
}

export interface ServeFileOptions {
    sessionId?: string;
    disposition?: string;
    ifRange?: string | null;
    throttleBytesPerSec?: number;
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
    return serveFile(servePath, extname(filePath), true, rangeHeader, opts);
}

async function serveFile(
    filePath: string,
    ext: string,
    noFollow: boolean,
    rangeHeader: string | null,
    { sessionId, disposition = 'inline', ifRange, throttleBytesPerSec = 0 }: ServeFileOptions,
): Promise<Response> {
    const { size: fileSize, mtimeMs } = await getCachedStat(filePath);
    const validators = buildValidators(fileSize, mtimeMs);

    const contentType = getMimeType(ext.toLowerCase());

    const validatorHeaders: Record<string, string> = { ETag: validators.etag };
    if (validators.lastModified) validatorHeaders['Last-Modified'] = validators.lastModified;

    // A stale If-Range demotes the request to a full-file transfer.
    if (rangeHeader && ifRange && !ifRangeMatches(ifRange, validators)) {
        rangeHeader = null;
    }

    if (!rangeHeader) {
        bandwidthTracker.trackDirectPlay(fileSize);
        if (sessionId) bandwidthTracker.trackSession(sessionId, fileSize);
        return new Response(
            throttleNodeStream(
                noFollow ? await createNoFollowReadStream(filePath) : createReadStream(filePath),
                throttleBytesPerSec,
            ),
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
        throttleNodeStream(
            noFollow
                ? await createNoFollowReadStream(filePath, { start, end })
                : createReadStream(filePath, { start, end }),
            throttleBytesPerSec,
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
