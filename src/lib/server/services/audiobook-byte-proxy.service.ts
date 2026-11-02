// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AudiobookShelf byte proxy — the transport half of the audiobook player.
 *
 * Every audio byte a Lumastra client plays is fetched from AudiobookShelf by
 * this module and piped through. Two reasons it cannot be a redirect:
 *
 *  1. The presentation spec forbids the ABS address appearing in client markup.
 *  2. The per-user ABS API key must never reach the browser.
 *
 * ## What was MEASURED against a live ABS (2026-07-29), not assumed
 *
 * | Question | Reality |
 * | --- | --- |
 * | Does `/api/items/:id/file/:ino` honour `Range`? | Yes — `206` + `content-range`, `accept-ranges: bytes` advertised on the `200`. A 1 KB range of a 7.5 MB file returned exactly 1000 bytes. |
 * | Does the transcode playlist reference segments relatively? | Yes — `output-N.ts`, 4012 of them, no absolute prefix. |
 * | Is the ABS HLS path itself authenticated? | **No.** `GET /hls/:sid/output-0.ts` with no credential returned `200`; the sibling `/api/items/:id/file/:ino` returned `401`. Upstream guards segments by session-id obscurity only, so this proxy is the ONLY access control on that path. |
 *
 * ## Why the HLS token travels in the PATH, not the query
 *
 * An HLS client resolves `output-0.ts` against the playlist URL with the
 * ordinary relative-reference algorithm, which **discards the query string**:
 *
 * ```
 * new URL('output-0.ts', '…/hls/S/output.m3u8?stream_token=t')
 *   → '…/hls/S/output-0.ts'          ← token gone
 * new URL('output-0.ts', '…/hls/stream_t/S/output.m3u8')
 *   → '…/hls/stream_t/S/output-0.ts' ← token preserved
 * ```
 *
 * So "preserve the path suffix and you need not rewrite the manifest" is only
 * true if the credential is part of the path prefix. With `?stream_token=` the
 * first segment request arrives anonymous and 401s — which is exactly why the
 * existing video path rewrites its manifests. Putting the token in the path is
 * what buys the no-rewrite property the design asked for.
 *
 * ## `X-Accel-Redirect` is a failure, not a success
 *
 * When an ABS operator sets `global.XAccel`, file endpoints answer `204` plus an
 * `X-Accel-Redirect` header naming an internal nginx location instead of
 * sending bytes. That location is meaningless to us — we are not the nginx that
 * would serve it. A `204` is not an error status, so a proxy that copies status
 * and headers through emits a valid-looking empty response and the player stalls
 * on a silent zero-byte track. We refuse it explicitly.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { Logger } from '../utils/logger.js';
import { problem } from '../api/problem.js';

const logger = Logger.for('AudiobookByteProxy');

/** Request headers forwarded upstream verbatim. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
    'range',
    'if-range',
    'if-none-match',
    'if-modified-since',
] as const;

/**
 * Response headers copied downstream.
 *
 * `content-range` and `accept-ranges` are the two that make seeking work; the
 * validators let the browser revalidate a cached segment. Hop-by-hop headers,
 * cookies and ABS's own CORS/frame headers are deliberately NOT copied.
 */
const FORWARDED_RESPONSE_HEADERS = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
] as const;

export interface AudiobookProxyTarget {
    /** ABS base URL, no trailing slash. */
    baseUrl: string;
    /** Bearer credential — the listening user's own key, never the operator's if avoidable. */
    apiKey: string;
    /** Upstream path, already absolute and encoded (e.g. `/api/items/x/file/5193`). */
    upstreamPath: string;
}

export interface AudiobookProxyOptions {
    /** Injected for tests; defaults to global fetch. */
    fetchImpl?: typeof fetch;
    /** Abort the upstream request when the client disconnects. */
    signal?: AbortSignal;
    /**
     * `GET` (default) or `HEAD`.
     *
     * Forwarded rather than hardcoded: SvelteKit answers HEAD by running the GET
     * handler, and the node adapter then pulls the whole body and throws it
     * away. A HEAD on a 1.6 GB m4b would drag the entire book out of ABS to
     * produce a response with no body at all.
     */
    method?: 'GET' | 'HEAD';
}

/** Distinguishes a refusal we generated from an upstream status we passed on. */
export class AudiobookProxyError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly reason: 'xaccel' | 'upstream_unreachable' | 'redirect' | 'bad_request',
    ) {
        super(message);
        this.name = 'AudiobookProxyError';
    }
}

/**
 * Fetch one upstream resource and return a streaming Response.
 *
 * Errors are thrown as {@link AudiobookProxyError}; upstream 4xx/5xx are NOT
 * thrown — they are passed through so a 404 on a stale ABS session reaches the
 * player as a 404 rather than a generic 502 it cannot act on.
 */
export async function proxyAudiobookBytes(
    target: AudiobookProxyTarget,
    request: Request,
    options: AudiobookProxyOptions = {},
): Promise<Response> {
    const doFetch = options.fetchImpl ?? fetch;
    const url = joinUpstreamUrl(target.baseUrl, target.upstreamPath);

    const upstreamHeaders = new Headers({
        Authorization: `Bearer ${target.apiKey}`,
        // Ask for raw bytes. undici otherwise adds `accept-encoding: gzip,
        // deflate` on its own, decompresses transparently, and leaves the
        // COMPRESSED `content-length` on the response — measured: a 968-byte
        // playlist arrived as a 968-byte body carrying `content-length: 47`.
        // Copying that downstream truncates the manifest and desyncs keep-alive
        // framing (Node's strictContentLength is off, so it does it silently).
        // A byte proxy wants identity anyway: Range offsets are only meaningful
        // against the unencoded representation.
        'Accept-Encoding': 'identity',
    });
    for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) upstreamHeaders.set(name, value);
    }

    let upstream: Response;
    try {
        upstream = await doFetch(url, {
            method: options.method ?? 'GET',
            headers: upstreamHeaders,
            // Manual: an ABS behind a misconfigured proxy that 302s to a login
            // page would otherwise be followed and its HTML piped to the player
            // as audio bytes.
            redirect: 'manual',
            signal: options.signal,
        });
    } catch (error) {
        throw new AudiobookProxyError(
            `AudiobookShelf unreachable: ${String(error)}`,
            502,
            'upstream_unreachable',
        );
    }

    // X-Accel-Redirect: ABS handed off to its own nginx instead of sending
    // bytes. Checked BEFORE the status check because the status it arrives with
    // (204) is not an error and would otherwise sail through as success.
    const xAccel = upstream.headers.get('x-accel-redirect');
    if (xAccel) {
        // Drain so the socket is not left half-read; a 204 has no body anyway.
        await upstream.body?.cancel().catch(() => {});
        logger.error(
            'AudiobookShelf returned X-Accel-Redirect instead of bytes — the proxy cannot serve ' +
                'an internal nginx location. Unset `global.XAccel` on the AudiobookShelf server, ' +
                'or route Lumastra at an ABS instance that serves file bytes directly.',
            undefined,
            { upstreamStatus: upstream.status, xAccelRedirect: xAccel },
        );
        throw new AudiobookProxyError(
            'AudiobookShelf is configured with X-Accel and did not return audio bytes',
            502,
            'xaccel',
        );
    }

    // 304 is NOT a redirect. `if-none-match` / `if-modified-since` are forwarded
    // on purpose (a re-seek into an already-cached region revalidates rather
    // than re-downloads), so the answer to a conditional request lands in the
    // 3xx range and must pass through. Treating it as a redirect turned every
    // cache hit into a 502.
    if (upstream.status === 304) {
        await upstream.body?.cancel().catch(() => {});
        return new Response(null, { status: 304, headers: buildHeaders(upstream) });
    }

    if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel().catch(() => {});
        throw new AudiobookProxyError(
            `AudiobookShelf redirected (${upstream.status}) instead of serving bytes`,
            502,
            'redirect',
        );
    }

    // Error statuses pass through — a 404 on a stale ABS session is actionable
    // to the player in a way a blanket 502 is not — but the upstream BODY does
    // not. It is HTML or a JSON error from another system, it is never audio,
    // and forwarding it hands ABS's internal error text to whoever asked. Keep
    // the status, drop the body.
    if (upstream.status >= 400) {
        await upstream.body?.cancel().catch(() => {});
        const headers = new Headers({ 'Cache-Control': 'no-store' });
        // 416 is only interpretable with the range it rejected.
        const contentRange = upstream.headers.get('content-range');
        if (upstream.status === 416 && contentRange) headers.set('content-range', contentRange);
        // Upstream 401/403 mean OUR ABS credential was refused (revoked or
        // rotated key), not that the caller lacks rights. Passed through they
        // would read as Lumastra auth failures and send clients into grant
        // renewal / sign-out loops, so they surface as a gateway failure.
        const response = problem(
            upstream.status === 416
                ? 'validation_failed'
                : upstream.status === 404
                  ? 'not_found'
                  : 'bad_gateway',
            {
                status: upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status,
                error: 'Audiobook upstream refused the request',
            },
        );
        headers.forEach((value, name) => response.headers.set(name, value));
        return options.method === 'HEAD'
            ? new Response(null, { status: response.status, headers: response.headers })
            : response;
    }

    const contentType = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (
        !contentType ||
        // video/mp4 (.mp4), video/iso.segment (.m4s) and application/mp4 are what
        // ABS's extension map yields for m4b/mp4 files and fMP4 HLS segments.
        !/^(audio\/|video\/(mp2t|mp4|iso\.segment)$|application\/(octet-stream|mp4|vnd\.apple\.mpegurl|x-mpegurl)$)/.test(
            contentType,
        )
    ) {
        await upstream.body?.cancel().catch(() => {});
        const response = problem('bad_gateway', {
            error: 'Audiobook upstream did not return media',
            headers: { 'Cache-Control': 'no-store' },
        });
        return options.method === 'HEAD'
            ? new Response(null, { status: response.status, headers: response.headers })
            : response;
    }
    if (options.method === 'HEAD') {
        await upstream.body?.cancel().catch(() => {});
        return new Response(null, { status: upstream.status, headers: buildHeaders(upstream) });
    }
    return new Response(upstream.body, {
        status: upstream.status,
        headers: buildHeaders(upstream),
    });
}

function buildHeaders(upstream: Response): Headers {
    const headers = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }
    // Belt-and-braces against the framing bug the `Accept-Encoding: identity`
    // request header is meant to prevent: if something upstream compresses
    // anyway, the fetch layer decodes the body but leaves the COMPRESSED
    // content-length, so forwarding it would truncate the response. Better to
    // send no length (chunked) than a wrong one.
    if (upstream.headers.get('content-encoding')) headers.delete('content-length');
    // Advertise range support even when upstream only says so on the unranged
    // response — Safari checks this before it will scrub a long file.
    if (!headers.has('accept-ranges') && upstream.ok) headers.set('accept-ranges', 'bytes');
    // Private, revalidate-always. NOT `no-store`: the conditional headers above
    // are forwarded precisely so a re-seek into a region the browser already
    // holds revalidates into a 304 instead of re-downloading, and `no-store`
    // would forbid the cached copy that makes that possible. `private` still
    // keeps per-user-authorised audio out of every shared cache, and
    // `max-age=0` means nothing is ever served without asking us first.
    headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
    return headers;
}

// ---------------------------------------------------------------------------
// Upstream path construction
// ---------------------------------------------------------------------------

/**
 * Direct-play file path.
 *
 * ABS addresses files by inode, and the play session hands back exactly this
 * shape as `audioTracks[].contentUrl`.
 */
export function absFilePath(absItemId: string, ino: string): string {
    return `/api/items/${encodeURIComponent(absItemId)}/file/${encodeURIComponent(ino)}`;
}

/**
 * Transcode playlist / segment path.
 *
 * `file` is the relative name straight off the manifest (`output.m3u8`,
 * `output-417.ts`). Constrained rather than passed through: this segment of the
 * URL is attacker-controlled and interpolated into an upstream path, so anything
 * other than the shape ABS actually emits is rejected instead of escaped.
 */
export function absHlsPath(absSessionId: string, file: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(absSessionId)) {
        throw new AudiobookProxyError('Invalid AudiobookShelf session id', 400, 'bad_request');
    }
    if (!/^output(-\d{1,6})?\.(m3u8|ts|aac|mp4|m4s)$/.test(file)) {
        throw new AudiobookProxyError('Invalid HLS resource name', 400, 'bad_request');
    }
    return `/hls/${absSessionId}/${file}`;
}
