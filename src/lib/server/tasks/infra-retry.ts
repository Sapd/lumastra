// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Infrastructure error classifier for task-level `retry.retryOn`.
 *
 * Returns `true` for transient failures that are safe to retry:
 *   - Network-layer errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, etc.)
 *   - HTTP 5xx server errors
 *   - Postgres transient errors (connection loss, serialization failure,
 *     deadlock, resource exhaustion, admin-shutdown) via `isTransientPgError`
 *
 * Returns `false` for permanent failures (constraint violations, auth
 * errors, bad input) that should not be retried.
 *
 * Usage in a task definition:
 *
 * ```ts
 * import { classifyInfraError } from '../../infra-retry.js';
 *
 * retry: {
 *     attempts: 3,
 *     backoff: 'exponential',
 *     retryOn: classifyInfraError,
 * }
 * ```
 */

import { isTransientPgError } from '$lib/server/utils/transient-pg.js';

const TRANSIENT_MSG_RE =
    /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|EPIPE|ENOTCONN|ENETUNREACH|EAI_AGAIN/i;
const STORAGE_MSG_RE = /\bENOSPC\b|No space left on device/i;

/**
 * HTTP 5xx detector, anchored to HTTP/status context so an unrelated 3-digit
 * number in a message (item counts, durations, row numbers, etc. that happen
 * to fall in the 500-599 range) isn't misclassified as a retryable server
 * error. Matches either:
 *   1. A `5xx` preceded closely by "http", "status" / "status code", or
 *      "code" (e.g. "HTTP 503", "status code: 500", "with status 504").
 *   2. The classic "5xx <Reason Phrase>" form (e.g. "502 Bad Gateway"),
 *      independent of any preceding context word.
 */
const HTTP_5XX_RE =
    /(?:\bhttps?(?:\/\d(?:\.\d)?)?\b|\bstatus(?:\s+code)?\b|\bcode\b)\s*:?\s*\b5\d{2}\b|\b5\d{2}\b\s+(?:internal server error|not implemented|bad gateway|service unavailable|gateway timeout|http version not supported)/i;

/**
 * Classify an arbitrary thrown value as an infrastructure transient error.
 *
 * Safe to pass directly as `retry.retryOn` in any task definition.
 */
export function classifyInfraError(err: unknown): boolean {
    return classifyInfrastructureError(err, false);
}

/** Opt-in for idempotent media scanning/rendering, including temporary disk-full. */
export function classifyMediaInfraError(err: unknown): boolean {
    return classifyInfrastructureError(err, true);
}

function classifyInfrastructureError(err: unknown, storage: boolean): boolean {
    if (err && typeof err === 'object') {
        const e = err as { code?: unknown; stderr?: unknown; signal?: unknown };
        // FFmpeg messages often ARE its entire stderr (including input paths
        // and title tags). Only fixed diagnostics and exit signals are evidence.
        if (typeof e.stderr === 'string') {
            return (
                storage &&
                (typeof e.signal === 'string' ||
                    e.stderr
                        .split(/\r?\n/)
                        .some((line) =>
                            /^(?:(?:av_interleaved_write_frame\(\)|av_write_frame\(\)): |Error (?:writing trailer|closing file) of [^\r\n]*: )?(?:No space left on device|Input\/output error|Connection (?:reset by peer|refused)|Broken pipe)\s*$/i.test(
                                line.trim(),
                            ),
                        ))
            );
        }
        // Node fs errors include a path in their message. A known code wins
        // over text: ENOENT on a file named "Connection Lost" is permanent.
        if (typeof e.code === 'string')
            return (
                isTransientPgError({ code: e.code, message: '' }) ||
                TRANSIENT_MSG_RE.test(e.code) ||
                (storage && STORAGE_MSG_RE.test(e.code))
            );
    }
    if (isTransientPgError(err)) return true;

    const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);

    // HTTP 5xx — upstream service unavailable / overloaded
    if (HTTP_5XX_RE.test(msg)) return true;

    // Node.js network errors
    if (TRANSIENT_MSG_RE.test(msg) || (storage && STORAGE_MSG_RE.test(msg))) return true;

    return false;
}
