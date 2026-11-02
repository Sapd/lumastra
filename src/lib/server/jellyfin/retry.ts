// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { recordProviderRetry } from '../utils/provider-calls.js';

/**
 * Transient-error retry for Jellyfin watch-sync HTTP calls.
 *
 * Without this, a single Jellyfin 429 (rate limit) or a 10s request timeout on a
 * heavy episode page fails that user's whole pull — and on a single-user install
 * that means the entire run reports `failed` with `itemsProcessed: 0`. Retrying
 * transient errors with capped backoff (honoring `Retry-After` for 429) lets a
 * brief blip recover within the cycle instead of zeroing the run.
 *
 * Bounded by design: at most `maxAttempts` tries with exponential backoff capped
 * at `capMs`, so worst-case added latency per call is small and well within the
 * task's 2h cap. Aborts and non-transient errors (auth/not-found, an open
 * circuit breaker) bail immediately — retrying those is futile.
 */

const RETRY_AFTER_CAP_MS = 60_000;

export interface RetryClassification {
    retryable: boolean;
    /** Explicit wait from a 429 `Retry-After` header, capped; null → use backoff. */
    retryAfterMs: number | null;
}

interface AxiosLikeError {
    isAxiosError?: boolean;
    code?: string;
    name?: string;
    response?: { status?: number; headers?: Record<string, unknown> };
}

function asError(err: unknown): AxiosLikeError {
    return (typeof err === 'object' && err !== null ? err : {}) as AxiosLikeError;
}

/** Parse an HTTP `Retry-After` (delta-seconds or HTTP-date) into capped ms. */
function parseRetryAfter(raw: unknown, now: number): number | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const seconds = Number(raw);
    let ms: number;
    if (Number.isFinite(seconds)) {
        ms = Math.max(0, seconds * 1000);
    } else {
        const at = Date.parse(raw);
        if (Number.isNaN(at)) return null;
        ms = Math.max(0, at - now);
    }
    return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/**
 * Decide whether a failed Jellyfin call should be retried, and how long to wait
 * if the server told us (429 `Retry-After`).
 *
 * Retryable: 429, any 5xx, request timeouts (`ECONNABORTED`/`ETIMEDOUT`), and
 * network errors with no response. NOT retryable: other 4xx, an open circuit
 * breaker, or an abort.
 */
export function classifyJellyfinError(err: unknown, now: number = Date.now()): RetryClassification {
    const e = asError(err);

    // Abort + open-circuit-breaker → never retry (caller is cancelling / breaker
    // is fast-failing; retrying inside the cycle just wastes time).
    if (e.name === 'AbortError' || e.name === 'CircuitBreakerOpen') {
        return { retryable: false, retryAfterMs: null };
    }

    const status = e.response?.status;
    if (status === 429) {
        return {
            retryable: true,
            retryAfterMs: parseRetryAfter(e.response?.headers?.['retry-after'], now),
        };
    }
    if (typeof status === 'number') {
        // 5xx transient; any other status (4xx) is a permanent client error.
        return { retryable: status >= 500, retryAfterMs: null };
    }

    // No HTTP response: timeout or network error → transient.
    if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || e.isAxiosError) {
        return { retryable: true, retryAfterMs: null };
    }
    return { retryable: false, retryAfterMs: null };
}

/** Exponential backoff for `attempt` (1-based), `base * 2^(attempt-1)`, capped. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
    return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}

/** Abortable sleep — resolves after `ms`, or rejects if `signal` aborts first. */
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

export interface RetryOptions {
    signal?: AbortSignal;
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
    /** Injectable for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `fn`, retrying transient Jellyfin failures with capped backoff. Bails
 * immediately on abort or a non-transient error, and after `maxAttempts`.
 */
export async function withJellyfinRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {},
): Promise<T> {
    const { signal, maxAttempts = 3, baseMs = 500, capMs = 8000, sleep = defaultSleep } = opts;

    let attempt = 0;
    for (;;) {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        try {
            if (attempt > 0) recordProviderRetry('jellyfin');
            return await fn();
        } catch (err) {
            attempt++;
            // Don't retry if the caller aborted during the attempt.
            if (signal?.aborted) throw err;
            const { retryable, retryAfterMs } = classifyJellyfinError(err);
            if (!retryable || attempt >= maxAttempts) throw err;
            await sleep(retryAfterMs ?? backoffMs(attempt, baseMs, capMs), signal);
        }
    }
}
