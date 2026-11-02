// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTTP Range support for serving a static file from disk.
 *
 * No existing static-file range helper lived in `server/utils/` — HLS segment
 * serving and the image proxy have their own byte-serving paths that don't
 * need this. Introduced for the tvOS Top Shelf preview/cinemagraph MP4 route,
 * which serves a single progressive MP4 file and must support `Range` requests
 * (AVPlayer probes with a byte range before committing to playback).
 *
 * Single-range requests only (`bytes=a-b`) — multipart/byteranges is not
 * implemented (no known Top Shelf client sends a multi-range request).
 */

import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';

export type RangeParseResult = { status: 200 | 206; start: number; end: number } | { status: 416 };

/**
 * Parse a `Range: bytes=...` header against a known file size.
 *
 * - No header → full body (200).
 * - Malformed header (doesn't match `bytes=.. -..`) → full body (200) — a
 *   malformed Range header is not fatal, the client just gets everything.
 * - `bytes=a-b` → 206 with that inclusive range.
 * - `bytes=a-` (open-ended) → 206 through EOF.
 * - `bytes=-N` (suffix) → last N bytes.
 * - Any range that cannot be satisfied against `fileSize` → 416.
 */
export function parseRange(
    rangeHeader: string | null | undefined,
    fileSize: number,
): RangeParseResult {
    // A 0-byte file has no valid byte offsets at all — `Math.max(0, -1)` would
    // otherwise yield `end=0`, producing a bogus `Content-Length: 1` on an
    // empty stream.
    if (fileSize === 0) return { status: 200, start: 0, end: -1 };

    if (!rangeHeader) return { status: 200, start: 0, end: Math.max(0, fileSize - 1) };

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) return { status: 200, start: 0, end: Math.max(0, fileSize - 1) };

    const [, startStr, endStr] = match;

    if (startStr === '' && endStr === '') {
        return { status: 200, start: 0, end: Math.max(0, fileSize - 1) };
    }

    let start: number;
    let end: number;

    if (startStr === '') {
        // Suffix range: last N bytes.
        const suffixLength = Number.parseInt(endStr, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { status: 416 };
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
    } else {
        start = Number.parseInt(startStr, 10);
        end = endStr === '' ? fileSize - 1 : Number.parseInt(endStr, 10);
    }

    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        start > end ||
        start >= fileSize
    ) {
        return { status: 416 };
    }

    end = Math.min(end, fileSize - 1);
    return { status: 206, start, end };
}

export interface ServeFileWithRangeOptions {
    /** `Content-Type` header value. Defaults to `application/octet-stream`. */
    contentType?: string;
    /** Extra headers merged onto the response (e.g. Cache-Control, ETag, CORS). */
    headers?: Record<string, string>;
}

/**
 * Serve a file from disk with Range support, streaming (never buffering the
 * whole file into memory).
 *
 * - No `Range` header → 200, full body, `Content-Length`, `Accept-Ranges: bytes`.
 * - Satisfiable `Range` → 206 + `Content-Range`.
 * - Unsatisfiable `Range` → 416 + a `Content-Range` naming the full size, empty body.
 * - `HEAD` → headers only, no body.
 */
export async function serveFileWithRange(
    filePath: string,
    request: Request,
    options: ServeFileWithRangeOptions = {},
): Promise<Response> {
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;

    const range = parseRange(request.headers.get('range'), fileSize);

    const headers = new Headers({
        'Content-Type': options.contentType ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        ...options.headers,
    });

    if (range.status === 416) {
        headers.set('Content-Range', `bytes */${fileSize}`);
        return new Response(null, { status: 416, headers });
    }

    const { start, end, status } = range;
    const length = end - start + 1;
    headers.set('Content-Length', String(length));
    if (status === 206) {
        headers.set('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    }

    // `length <= 0` only happens for a 0-byte file (see the fileSize===0
    // guard in parseRange, which yields end=-1) — createReadStream rejects
    // a negative `end` outright, and there are no bytes to stream anyway.
    if (request.method === 'HEAD' || length <= 0) {
        return new Response(null, { status, headers });
    }

    const nodeStream = createReadStream(filePath, { start, end });
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return new Response(webStream, { status, headers });
}
