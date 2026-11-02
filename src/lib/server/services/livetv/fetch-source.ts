// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared SSRF-validated source fetcher for LiveTV import/refresh.
 *
 * Both `livetv-import.service` (M3U + XMLTV) and `livetv-refresh.service` (M3U)
 * fetch remote provider URLs with the same protection profile:
 *
 * - SSRF-validate the URL (honouring `LIVETV_ALLOW_PRIVATE_URLS`).
 * - Follow redirects MANUALLY, re-validating every hop under the same policy,
 *   capped at `MAX_REDIRECT_HOPS`. A provider that answers
 *   `302 Location: http://127.0.0.1:6379/` gets rejected at the hop, not
 *   followed (security review 2026-09-12, C6).
 * - Pin every direct hop to the address `validateUrl` vetted (DNS-rebinding
 *   TOCTOU fix) with `pinnedFetch`: the pin sits in the undici transport, so
 *   the URL keeps its hostname and Host / TLS SNI stay correct — plain-http
 *   providers on name-based virtual hosts see their own name, not the IP.
 * - When the LiveTV upstream proxy is configured, hand the hop URL to it
 *   unpinned: the proxy resolves the hostname itself. `validateUrl` still
 *   gates every hop.
 * - 60s overall budget (shared across redirect hops), with fetch errors and
 *   non-2xx responses surfaced as thrown errors carrying the provider hostname.
 *   Failures on a REDIRECTED hop are reported generically: echoing an upstream
 *   status or connect-error cause from an attacker-chosen target turns the
 *   task error into an internal port oracle.
 *
 * This is the single source of truth for that block.
 */

import { validateUrl } from '$lib/server/utils/url-validator.js';
import { config } from '$lib/server/config.js';
import { redactLiveTvUrl, redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import type { LoggerInstance } from '$lib/server/utils/logger.js';
import { getLiveTvUpstreamDispatcher } from './upstream-proxy.js';
import { pinnedFetch } from '$lib/server/utils/ssrf-guard.js';
import { BODY_TOO_LARGE, readBoundedBodyText } from '$lib/server/utils/bounded-body-reader.js';

/** Redirect hops followed before giving up. A 6th redirect is rejected. */
const MAX_REDIRECT_HOPS = 5;

/**
 * Default cap on a source body, in DECODED bytes: undici inflates
 * `Content-Encoding` before the reader counts, so a 500 KiB gzip body reaches
 * this cap. The old 500 MiB cap meant chunks + concatenation + string, about
 * 1.5 GiB of heap per fetch from a provider the operator does not control.
 * Callers pass a tighter cap that matches what their parser accepts.
 */
export const DEFAULT_MAX_SOURCE_BYTES = 100 * 1024 * 1024;

/** Xtream `m3u_plus` playlists run to 80-300 MB; this is the ceiling, not the norm. */
export const M3U_MAX_FETCH_BYTES = 256 * 1024 * 1024;

/** Equal to `MAX_INPUT_SIZE` in xmltv-parser.ts: the parser rejects anything larger. */
export const XMLTV_MAX_FETCH_BYTES = 100 * 1024 * 1024;

export interface FetchSourceOptions {
    /** Source id, for log context. */
    sourceId: string;
    /** Service logger to report fetch failures through. */
    logger: LoggerInstance;
    /** Human label for thrown error messages, e.g. 'M3U' or 'XMLTV'. */
    contentLabel: string;
    /** Message passed to `logger.error` on fetch failure. */
    fetchFailLogMessage: string;
    /** Request timeout in milliseconds (default 60s). */
    timeoutMs?: number;
    /** Largest body accepted, in decoded bytes (default 100 MiB). */
    maxBytes?: number;
    /** Setup format probe: cancel after this many bytes. Imports leave this unset. */
    probeBytes?: number;
}

/**
 * SSRF-validate and fetch a LiveTV source URL, returning the response body text.
 * Throws on SSRF rejection, network failure, or a non-2xx response.
 */
export async function fetchSsrfValidatedText(
    url: string,
    opts: FetchSourceOptions,
): Promise<string> {
    const { sourceId, logger, contentLabel, fetchFailLogMessage } = opts;
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;

    const originalUrl = new URL(url);
    const dispatcher = getLiveTvUpstreamDispatcher();
    // One deadline for the whole chain, so a redirect chain can't multiply the
    // caller's timeout budget by the hop count.
    const signal = AbortSignal.timeout(timeoutMs);

    let currentUrl = url;

    for (let hop = 0; ; hop++) {
        const redirected = hop > 0;

        // Every hop is re-validated under the same policy the first URL had —
        // including the LIVETV_ALLOW_PRIVATE_URLS opt-out, so a LAN provider
        // that redirects within the LAN keeps working.
        const ssrfResult = await validateUrl(currentUrl, {
            allowPrivateIps: config.LIVETV_ALLOW_PRIVATE_URLS,
        });
        if (!ssrfResult.valid) {
            throw new Error(`SSRF blocked: ${redactLiveTvUrlsInText(ssrfResult.reason)}`);
        }

        let response: Response;
        try {
            // pinnedFetch pins a direct connection to the vetted address and
            // routes a proxied one through the dispatcher unpinned (the proxy
            // re-resolves the hostname).
            response = await pinnedFetch(
                { url: new URL(currentUrl), resolvedIp: ssrfResult.resolvedIp },
                {
                    // Never let fetch follow a redirect itself — it would skip the
                    // per-hop validateUrl above (security review 2026-09-12, C6).
                    redirect: 'manual',
                    signal,
                    dispatcher,
                },
            );
        } catch (rawError) {
            // Xtream URLs carry credentials in the path or query, and an
            // upstream error can echo the URL; only the redacted copy is logged
            // or chained.
            const fetchError = redactFetchError(rawError);
            logger.error(fetchFailLogMessage, fetchError, {
                sourceId,
                url: redactLiveTvUrl(currentUrl),
                resolvedIp: ssrfResult.resolvedIp,
            });
            throw fetchFailure(fetchError, contentLabel, originalUrl.hostname, redirected);
        }

        const isRedirect = response.status >= 300 && response.status < 400;
        if (isRedirect) {
            const location = response.headers.get('location');
            if (location) {
                void response.body?.cancel().catch(() => {});
                if (hop >= MAX_REDIRECT_HOPS) {
                    throw new Error(
                        `Failed to fetch ${contentLabel} from ${originalUrl.hostname}: too many redirects (>${MAX_REDIRECT_HOPS})`,
                    );
                }
                currentUrl = new URL(location, currentUrl).toString();
                continue;
            }
        }

        if (!response.ok) {
            // Free the pinned connection now rather than when the signal fires.
            void response.body?.cancel().catch(() => {});
            if (redirected) {
                throw new Error(
                    `Failed to fetch ${contentLabel} from ${originalUrl.hostname}: the redirect target returned an error`,
                );
            }
            throw new Error(`Failed to fetch ${contentLabel}: HTTP ${response.status}`);
        }
        if (opts.probeBytes !== undefined) {
            return readSourcePrefix(
                response,
                Math.max(0, Math.floor(Math.min(opts.probeBytes, maxBytes))),
            );
        }
        const text = await readBoundedBodyText(response, maxBytes);
        if (text === BODY_TOO_LARGE) {
            throw new Error(
                `Failed to fetch ${contentLabel} from ${originalUrl.hostname}: the response is larger than ${formatBytes(maxBytes)}`,
            );
        }
        return text;
    }
}

/** Read a bounded format sample without buffering a full provider playlist/guide. */
async function readSourcePrefix(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const prefix = new Uint8Array(maxBytes);
    let length = 0;
    try {
        while (length < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            const part = value.subarray(0, maxBytes - length);
            prefix.set(part, length);
            length += part.byteLength;
        }
        return new TextDecoder().decode(prefix.subarray(0, length));
    } finally {
        await reader.cancel().catch(() => {});
        try {
            reader.releaseLock();
        } catch {
            /* Already released by the transport. */
        }
    }
}

/**
 * The error a failed hop surfaces. Its `cause` is the redacted copy, not the raw
 * error: the task-isolation protocol forwards `cause.message` to the host.
 */
function fetchFailure(
    fetchError: Error,
    contentLabel: string,
    hostname: string,
    redirected: boolean,
): Error {
    if (redirected) {
        // The target was chosen by the provider, not by the operator —
        // reporting why the connect failed would leak whether an
        // internal host/port is open. Only the message reaches task errors.
        return new Error(
            `Failed to fetch ${contentLabel} from ${hostname}: the redirect target could not be reached`,
            { cause: fetchError },
        );
    }
    const cause = fetchError.cause ?? fetchError.message;
    return new Error(
        `Failed to fetch ${contentLabel} from ${hostname}: ${redactLiveTvUrlsInText(cause instanceof Error ? cause.message : String(cause))}`,
        { cause: fetchError },
    );
}

function formatBytes(bytes: number): string {
    const mib = 1024 * 1024;
    return bytes >= mib ? `${Math.round(bytes / mib)} MiB` : `${bytes} bytes`;
}

/**
 * A copy of a fetch error that is safe to log or chain: URLs and credentials in
 * its message, stack and cause message are masked.
 */
function redactFetchError(err: unknown): Error {
    const source = err instanceof Error ? err : new Error(String(err));
    const causeMessage =
        source.cause === undefined
            ? undefined
            : source.cause instanceof Error
              ? source.cause.message
              : String(source.cause);
    const copy = new Error(
        redactLiveTvUrlsInText(source.message),
        causeMessage === undefined
            ? undefined
            : { cause: new Error(redactLiveTvUrlsInText(causeMessage)) },
    );
    copy.name = source.name;
    if (source.stack) copy.stack = redactLiveTvUrlsInText(source.stack);
    return copy;
}
