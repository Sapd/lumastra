// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keeps a keep-alive connection usable after a response that left the request
 * body unread (an early 413, 401, 403, …).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * adapter-node builds `event.request.body` with `getRequest()` from
 * `@sveltejs/kit/node`, which attaches its `data` listener to the Node request
 * at once and pauses the socket after the first chunk until someone reads the
 * stream. A route that answers without reading the body (a Content-Length cap,
 * an auth or CSRF rejection) therefore leaves the rest of the body sitting on
 * the socket, and because a listener exists, Node's own drain (`req._dump()`
 * in `resOnFinish`) never runs. The response still goes out as keep-alive.
 *
 * nginx opens a fresh upstream connection per request, so nobody noticed until
 * the 2026-10-06 reverse-proxy e2e: Caddy and Traefik (Go) pool upstream
 * connections, reuse that one, and the next request on it, from any user, got
 * a 502. Cancelling the body stream is no better: `cancel()` calls
 * `req.destroy()`, which drops the socket before the 413 is written, so the
 * uploader itself got a 502 or a connection reset.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * After the response is built:
 *   - body never read, or read partway and released (`readBoundedBody*` stops
 *     reading over its cap without cancelling): read the rest and discard it in
 *     the background, so the next request on the socket parses cleanly. If the
 *     declared length is over {@link MAX_DRAIN_BYTES}, or the body is chunked
 *     with no length, also send `Connection: close` so Node closes the socket
 *     after the response instead of waiting for an unbounded body.
 *   - body still locked by a reader and the response is a 413 (adapter-node's
 *     BODY_SIZE_LIMIT tripped mid-stream): `Connection: close`, because what is
 *     left on the socket cannot be reached any more.
 *   - declared length over BODY_SIZE_LIMIT: adapter-node refuses it before
 *     attaching a listener, so Node's own drain runs (bounded by its
 *     requestTimeout) and the connection stays open; nothing to do.
 * The response itself (status, problem+json body) is unchanged, and the drain
 * runs alongside writing it, so the client sees the 413 as soon as it would
 * have before.
 *
 * Runs outermost in `hooks.server.ts` so it sees every handle's response,
 * csrfHandle's 403 included.
 */

import type { Handle } from '@sveltejs/kit';

/**
 * Largest unread body we read off the wire to keep the connection alive.
 * Above BODY_SIZE_LIMIT's 50M default (bodies over the limit are drained by
 * Node itself, see above). A live body declared larger than this, which only
 * happens with a raised BODY_SIZE_LIMIT, gets `Connection: close` instead.
 */
export const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

function declaredLength(request: Request): number | undefined {
    const raw = request.headers.get('content-length');
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * adapter-node's body cap, parsed the way its handler parses BODY_SIZE_LIMIT
 * (`512K` default, K/M/G suffixes in powers of 1024).
 */
export function adapterBodySizeLimit(raw = process.env.BODY_SIZE_LIMIT ?? '512K'): number {
    const multiplier: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
    const unit = raw.at(-1)?.toUpperCase() ?? '';
    const value = unit in multiplier ? Number(raw.slice(0, -1)) * multiplier[unit] : Number(raw);
    return Number.isNaN(value) ? Infinity : value;
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>> | 'errored';

const PENDING = Symbol('pending');

function settledRead(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadResult> {
    return reader.read().then(
        (result) => result,
        () => 'errored' as const,
    );
}

/** Keep reading until the stream ends, discarding every chunk. Never throws. */
async function discardRest(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    inFlight: Promise<ReadResult>,
): Promise<void> {
    let next = await inFlight;
    while (next !== 'errored' && !next.done) next = await settledRead(reader);
}

/**
 * Decide what to do with `request`'s body once `response` is ready: drain it
 * in the background when unread bytes may be left, and resolve to true when
 * the connection must close after the response.
 *
 * Exported for tests.
 */
export async function settleUnreadBody(
    request: Request,
    response: Response | undefined,
): Promise<boolean> {
    const body = request.body;
    if (!body) return false;
    const length = declaredLength(request);

    if (body.locked) {
        if (response?.status !== 413) return false;
        // A declared length over BODY_SIZE_LIMIT is refused before a listener is
        // attached, so Node drains the socket itself (bounded by its
        // requestTimeout). Any other 413 on a locked body is the limit tripping
        // mid-stream (chunked), with the rest of the body out of reach.
        return length === undefined || length <= adapterBodySizeLimit();
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
        reader = body.getReader();
    } catch {
        return false;
    }

    // A body the route already read to the end reads as done at once; only a
    // stream that still has (or may still get) bytes needs draining.
    const inFlight = settledRead(reader);
    const first = await Promise.race([
        inFlight,
        new Promise<typeof PENDING>((resolve) => setImmediate(resolve, PENDING)),
    ]);
    if (first === 'errored') {
        // BODY_SIZE_LIMIT rejected the declared length before a byte was read.
        // No listener is attached then, so Node drains the socket itself,
        // bounded by its requestTimeout. Closing instead would race the 413
        // against a reset on a large upload.
        return false;
    }
    if (first !== PENDING && first.done) return false;

    void discardRest(reader, inFlight);
    return length === undefined || length > MAX_DRAIN_BYTES;
}

function withConnectionClose(response: Response): Response {
    try {
        response.headers.set('connection', 'close');
        return response;
    } catch {
        // Immutable headers (a Response passed through from fetch): copy it.
        const copy = new Response(response.body, response);
        copy.headers.set('connection', 'close');
        return copy;
    }
}

export const requestBodyDrainHandle: Handle = async ({ event, resolve }) => {
    // Routes may swap `event.request` for a rebuilt copy (restoreRequestBody);
    // the socket is tied to the original.
    const request = event.request;
    let response: Response | undefined;
    try {
        response = await resolve(event);
    } finally {
        // On a throw SvelteKit renders the error page after this handle; the
        // drain still keeps that connection usable.
        const close = await settleUnreadBody(request, response);
        if (close && response) response = withConnectionClose(response);
    }
    return response;
};
