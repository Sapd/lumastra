// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generic transient-error retry for HTTP fetch calls.
 *
 * Re-uses the same backoff strategy and sleep primitive as
 * `jellyfin/retry.ts`; factored out here so the TMDB and Arr clients can
 * share the logic without importing from the Jellyfin module.
 *
 * Caller supplies a `classify` function that inspects the thrown value and
 * returns `{ retryable, retryAfterMs }` — this keeps provider-specific
 * knowledge (status codes, error shapes) out of the generic loop.
 */

const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Parse an HTTP `Retry-After` header value (delta-seconds or HTTP-date) into
 * a capped millisecond delay. Returns null when the header is absent or
 * cannot be parsed.
 *
 * Consolidates the duplicate implementations in jellyfin/retry.ts (private)
 * and tmdb/client.ts (private).
 */
export function parseRetryAfterHeader(
    raw: string | null | undefined,
    now = Date.now(),
): number | null {
    if (!raw || raw.trim() === '') return null;
    const trimmed = raw.trim();
    // delta-seconds is a non-negative INTEGER per RFC 9110. Match strictly so
    // exotic numeric forms ('1e3', '0x10', '  5 ') don't yield a surprise delay;
    // anything else falls through to HTTP-date parsing.
    if (/^\d+$/.test(trimmed)) {
        return Math.min(Number(trimmed) * 1000, RETRY_AFTER_CAP_MS);
    }
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, Math.min(dateMs - now, RETRY_AFTER_CAP_MS));
    }
    return null;
}

export interface HttpRetryClassification {
    retryable: boolean;
    /** Explicit wait from a 429 `Retry-After` header, capped; null → use backoff. */
    retryAfterMs: number | null;
}

export interface HttpRetryOptions<E = unknown> {
    /**
     * Classify an error as retryable or not. Return `{ retryable: false }`
     * for permanent failures (auth errors, 4xx). The loop bails immediately
     * on abort errors regardless of what this function returns.
     */
    classify: (err: E) => HttpRetryClassification;
    signal?: AbortSignal;
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Abortable sleep — resolves after `ms`, rejects if `signal` fires first. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
    return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

/**
 * Run `fn`, retrying on transient failures with capped exponential backoff.
 * Bails immediately on abort or a non-retryable error, and after `maxAttempts`.
 */
export async function withHttpRetry<T, E = unknown>(
    fn: () => Promise<T>,
    opts: HttpRetryOptions<E>,
): Promise<T> {
    const {
        classify,
        signal,
        maxAttempts = 3,
        baseMs = 500,
        capMs = 8000,
        sleep = defaultSleep,
    } = opts;

    let attempt = 0;
    for (;;) {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        try {
            return await fn();
        } catch (err) {
            attempt++;
            if (signal?.aborted) throw err;
            const { retryable, retryAfterMs } = classify(err as E);
            if (!retryable || attempt >= maxAttempts) throw err;
            await sleep(retryAfterMs ?? backoffDelay(attempt, baseMs, capMs), signal);
        }
    }
}
