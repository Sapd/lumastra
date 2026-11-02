// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';

/**
 * Shared streamed body-size cap enforcement (C15, 2026-09-13 fix plan; fix
 * round 1 finding 3).
 *
 * Extracted from mount.ts so `middleware/validate.ts`'s legacy
 * `withValidation()` — still the auth/validation layer for routes not yet
 * migrated to `defineEndpoint()`/`mount()`, including `POST /api/oauth/
 * authorize`, a REACHABLE pre-auth surface — enforces the IDENTICAL cap on
 * BOTH request-validation paths, rather than a weaker Content-Length-only
 * check a client with no/lying header could bypass.
 *
 * IMPORTANT — read via the ORIGINAL request, never a `.clone()`: calling
 * `reader.cancel()` on a reader obtained from `Request.clone()`'s body HANGS
 * indefinitely in Node's fetch implementation (undici) once any data has
 * flowed — reproduced locally with both an already-buffered string body and a
 * genuinely streamed one; cancelling the SAME reader on the unCLONED request
 * completes immediately in both cases. `readBoundedBodyText()` therefore
 * takes the request whose body it will actually consume, and a caller that
 * needs the body to stay re-readable afterward (validate.ts's `withValidation`
 * contract) must call {@link restoreRequestBody} once reading finishes —
 * exactly the pattern mount.ts already used for this reason.
 */

/** Default cap (bytes) applied when a caller does not declare its own. */
/**
 * Anything with a WHATWG body stream: an incoming `Request`, or an outgoing
 * fetch's `Response` (LiveTV caps provider responses with the same reader).
 */
export type BodySource = Pick<Request, 'body'>;

export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** Sentinel returned when a body's accumulated byte count exceeds the cap. */
export const BODY_TOO_LARGE = Symbol('body-too-large');

/**
 * True for a "request body too large" error. adapter-node's BODY_SIZE_LIMIT
 * makes `request.formData()` / `.json()` / `.arrayBuffer()` reject with a
 * SvelteKitError carrying `status` 413 (not `statusCode`); services throw
 * errors with `statusCode`. Either is the caller's fault, never a 500.
 */
export function isPayloadTooLargeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
    return status === 413 || statusCode === 413;
}

/**
 * True when the request's declared `Content-Length` already exceeds
 * `maxBytes` — the cheap, no-stream-touch check: an honest caller reporting
 * an oversized body is rejected before a single byte is read.
 *
 * Returns `false` when there is no Content-Length header (chunked
 * transfer-encoding, or a client that omits it) — that case is still bounded
 * by the streamed cap in {@link readBoundedBodyText}.
 */
export function isDeclaredContentLengthOverCap(request: Request, maxBytes: number): boolean {
    const declared = request.headers.get('content-length');
    if (declared === null) return false;
    const declaredBytes = Number(declared);
    return Number.isFinite(declaredBytes) && declaredBytes > maxBytes;
}

/**
 * Core accumulation loop shared by {@link readBoundedBodyText} and
 * {@link readBoundedBodyBytes} — reads via `request.body`'s stream reader
 * (never `.text()`/`.arrayBuffer()`, which buffer the entire body before a
 * caller can inspect its size), ABORTING (no further bytes read here; an
 * outgoing response's reader is cancelled) once the accumulated byte count
 * passes `maxBytes`, so an oversized body is never fully materialized in
 * memory regardless of which representation the caller wants it in.
 */
async function readBoundedBodyChunks(
    request: BodySource,
    maxBytes: number,
): Promise<{ chunks: Uint8Array[]; total: number } | typeof BODY_TOO_LARGE> {
    const reader = request.body?.getReader();
    if (!reader) return { chunks: [], total: 0 };

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
                total += value.byteLength;
                if (total > maxBytes) {
                    // An incoming request is left as is: cancelling it calls
                    // `req.destroy()` in adapter-node, which drops the socket
                    // before the 413 goes out. requestBodyDrainHandle reads off
                    // or closes what is left once the response is ready. An
                    // outgoing fetch's body is cancelled so the download stops.
                    if (!(request instanceof Request)) await reader.cancel().catch(() => {});
                    return BODY_TOO_LARGE;
                }
                chunks.push(value);
            }
        }
    } finally {
        try {
            reader.releaseLock();
        } catch {
            // Already released by cancel() above — harmless.
        }
    }
    return { chunks, total };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return buf;
}

/**
 * Read a request body as text, ABORTING once the accumulated byte count
 * passes `maxBytes` — see {@link readBoundedBodyChunks}.
 *
 * Returns the decoded text, or the {@link BODY_TOO_LARGE} sentinel once the
 * cap is exceeded. Only safe for bodies that are genuinely text-representable
 * (JSON, form-urlencoded, plain text) — `TextDecoder` replaces invalid UTF-8
 * sequences with U+FFFD, which silently corrupts a binary/multipart body. Use
 * {@link readBoundedBodyBytes} for anything else.
 */
export async function readBoundedBodyText(
    request: BodySource,
    maxBytes: number,
): Promise<string | typeof BODY_TOO_LARGE> {
    const result = await readBoundedBodyChunks(request, maxBytes);
    if (result === BODY_TOO_LARGE) return BODY_TOO_LARGE;
    return new TextDecoder().decode(concatChunks(result.chunks, result.total));
}

/**
 * Read a request body as raw bytes, ABORTING once the accumulated byte count
 * passes `maxBytes` — see {@link readBoundedBodyChunks}. Unlike
 * {@link readBoundedBodyText}, this never decodes through `TextDecoder`, so a
 * binary or `multipart/form-data` body reaches the caller byte-for-byte
 * (fix-round-2, 2026-09-16 fix plan, C26: the streamed-byte-count cap the
 * brief asked for, for content types where a text round trip would corrupt
 * the body — see `feature-dispatch.ts`'s `isTextSafeContentType`).
 *
 * Returns the raw bytes, or the {@link BODY_TOO_LARGE} sentinel once the cap
 * is exceeded.
 */
export async function readBoundedBodyBytes(
    request: Request,
    maxBytes: number,
): Promise<Uint8Array | typeof BODY_TOO_LARGE> {
    const result = await readBoundedBodyChunks(request, maxBytes);
    if (result === BODY_TOO_LARGE) return BODY_TOO_LARGE;
    return concatChunks(result.chunks, result.total);
}

/**
 * Thrown by {@link readBoundedJson} when the body passes the cap. Carries
 * `status`/`statusCode` 413 so {@link isPayloadTooLargeError} and the shared
 * error handler answer 413, and a caller's existing "invalid body" catch
 * still rejects it.
 */
export class BodyTooLargeError extends Error {
    readonly status = 413;
    readonly statusCode = 413;
    constructor(maxBytes: number) {
        super(`Request body exceeds ${maxBytes} bytes`);
        this.name = 'BodyTooLargeError';
    }
}

/**
 * Drop-in replacement for a bare `request.json()` in a handler that is not
 * wrapped by `mount()`/`withValidation()`: reads at most `maxBytes` off the
 * stream (a plain `.json()` buffers up to adapter-node's BODY_SIZE_LIMIT, 50M
 * by default), then parses. Throws {@link BodyTooLargeError} past the cap and
 * a `SyntaxError` for malformed JSON, like `.json()` does.
 */
export async function readBoundedJson(
    request: Request,
    maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
    if (isDeclaredContentLengthOverCap(request, maxBytes)) throw new BodyTooLargeError(maxBytes);
    const text = await readBoundedBodyText(request, maxBytes);
    if (text === BODY_TOO_LARGE) throw new BodyTooLargeError(maxBytes);
    return JSON.parse(text);
}

/**
 * Reconstruct `event.request` from a buffered body string so anything
 * downstream that calls `event.request.json()/.text()/.formData()` gets the
 * ORIGINAL body instead of throwing "Body already read" — `readBoundedBodyText`
 * must consume the REQUEST'S OWN stream (see the module docstring on why a
 * `.clone()` can't be cancelled safely), so a caller whose contract promises
 * the body stays re-readable (mount.ts's handlers; validate.ts's wrapped
 * handler, which still receives the full `RequestEvent`) must call this once
 * reading finishes.
 *
 * Implementation: SvelteKit's RequestEvent.request is a real Request whose
 * value the framework itself reassigns (see hooks.server.ts). We replace it
 * with a new Request carrying the buffered text, preserving method + headers
 * (including Content-Type, so `.formData()` still parses form bodies). If the
 * reassignment is rejected (frozen/readonly in some runtime), we fall back to
 * overriding the body-reading methods on the existing request object so reads
 * still resolve to the buffered value.
 */
export function restoreRequestBody(event: RequestEvent, text: string): void {
    const original = event.request;
    try {
        const rebuilt = new Request(original.url, {
            method: original.method,
            headers: original.headers,
            body: text,
        });
        // RequestEvent.request is typed readonly but is reassigned by SvelteKit
        // itself; assign through a mutable view.
        (event as { request: Request }).request = rebuilt;
        // Reassignment succeeded and the new request is independently readable.
        return;
    } catch {
        // Fall through to method-override fallback.
    }

    // Fallback: override the body-reading methods so a handler still sees the
    // buffered body even if request reassignment was not possible.
    const overrides = {
        text: async () => text,
        json: async () => JSON.parse(text),
        formData: async () => {
            const params = new URLSearchParams(text);
            const fd = new FormData();
            for (const [key, value] of params.entries()) fd.append(key, value);
            return fd;
        },
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
    Object.assign(original, overrides);
}

/**
 * Byte-preserving counterpart to {@link restoreRequestBody} — reconstructs
 * `event.request` from bytes read via {@link readBoundedBodyBytes} rather
 * than text, so a binary/`multipart/form-data` body's downstream
 * `.formData()`/`.arrayBuffer()`/`.blob()` reads see the ORIGINAL bytes,
 * never a `TextDecoder` round trip (fix-round-2, 2026-09-16 fix plan, C26).
 */
export function restoreRequestBodyBytes(event: RequestEvent, bytes: Uint8Array): void {
    const original = event.request;
    try {
        // Node's Uint8Array<ArrayBufferLike> doesn't structurally satisfy
        // lib.dom's BodyInit in this TS config — the runtime accepts any
        // ArrayBufferView; only the type needs the cast.
        const rebuilt = new Request(original.url, {
            method: original.method,
            headers: original.headers,
            body: bytes as BodyInit,
        });
        (event as { request: Request }).request = rebuilt;
        return;
    } catch {
        // Fall through to method-override fallback.
    }

    // Fallback: a `Response` sharing the original Content-Type knows how to
    // parse multipart boundaries from raw bytes, so route .formData()/.blob()
    // through it rather than reimplementing multipart parsing here.
    const contentType = original.headers.get('content-type') ?? '';
    const overrides = {
        arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        blob: async () =>
            new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).blob(),
        formData: async () =>
            new Response(bytes as BodyInit, {
                headers: { 'content-type': contentType },
            }).formData(),
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
    Object.assign(original, overrides);
}
