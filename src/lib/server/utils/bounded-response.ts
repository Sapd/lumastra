// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bounded reads of an OUTGOING fetch's response body.
 *
 * `await res.arrayBuffer()` / `.text()` / `.json()` buffer whatever the remote
 * sends, and undici decompresses `Content-Encoding` first, so a few hundred KB
 * of gzip can inflate to gigabytes. Every fetch of a body whose size the remote
 * (or the content it points at) controls reads through here instead: the stream
 * is cancelled the moment the cap is passed, and a compressed payload is
 * inflated with `maxOutputLength`. `bounded-response.source-scan.test.ts`
 * fails when a new unbounded read shows up in the audited service trees.
 *
 * The request-side counterpart is `bounded-body-reader.ts`.
 */

import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gunzipAsync = promisify(gunzip);

/** The body, or the inflated payload, is larger than the caller's cap. */
export class ResponseTooLargeError extends Error {
    readonly maxBytes: number;
    constructor(maxBytes: number) {
        super(`Response body exceeds ${maxBytes} bytes`);
        this.name = 'ResponseTooLargeError';
        this.maxBytes = maxBytes;
    }
}

/** What a body read needs from a `Response`. */
export type BoundedResponse = Pick<Response, 'body' | 'headers'>;

/**
 * Read the body as bytes, throwing {@link ResponseTooLargeError} (and cancelling
 * the download) once more than `maxBytes` decoded bytes have arrived.
 */
export async function readBoundedResponseBytes(
    response: BoundedResponse,
    maxBytes: number,
): Promise<Buffer> {
    // The declared length is the ENCODED size, so it only proves "too big" when
    // the body is not compressed; a compressed body is counted as it streams.
    if (!response.headers.get('content-encoding')) {
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel().catch(() => {});
            throw new ResponseTooLargeError(maxBytes);
        }
    }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new ResponseTooLargeError(maxBytes);
            }
            chunks.push(value);
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Already released by cancel().
        }
    }
    return Buffer.concat(chunks, total);
}

/** {@link readBoundedResponseBytes} decoded as UTF-8. */
export async function readBoundedResponseText(
    response: BoundedResponse,
    maxBytes: number,
): Promise<string> {
    return (await readBoundedResponseBytes(response, maxBytes)).toString('utf8');
}

/** {@link readBoundedResponseText} parsed as JSON; a malformed body throws like `.json()`. */
export async function readBoundedResponseJson(
    response: BoundedResponse,
    maxBytes: number,
): Promise<unknown> {
    return JSON.parse(await readBoundedResponseText(response, maxBytes));
}

/** Stop an unwanted body (a redirect hop, an error page) without downloading it. */
export function discardResponseBody(response: Pick<Response, 'body'>): void {
    void response.body?.cancel().catch(() => {});
}

/**
 * Gunzip with an output ceiling: a 1 MiB gzip bomb costs at most `maxBytes` of
 * inflation, not gigabytes. Throws {@link ResponseTooLargeError} past the cap.
 */
export async function gunzipBounded(data: Uint8Array, maxBytes: number): Promise<Buffer> {
    try {
        return await gunzipAsync(data, { maxOutputLength: maxBytes });
    } catch (err) {
        if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ResponseTooLargeError(maxBytes);
        }
        throw err;
    }
}
