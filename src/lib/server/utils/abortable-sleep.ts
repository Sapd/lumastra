// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Abortable sleep helpers — two flavours, one shared implementation.
 *
 * Async code that pauses (rate limits, inter-request spacing, cooldowns) must
 * stay responsive to `AbortSignal.abort()` or an admin-initiated stop will be
 * swallowed by the setTimeout and the caller blocks for the full duration.
 *
 * There are two legitimate abort-handling contracts, each with a well-defined
 * use-case. Don't roll your own — pick one of these:
 *
 * ## `sleepOrReject(ms, signal)`
 * Rejects with an `AbortError` when the signal fires mid-sleep. Use this in
 * HTTP client code (rate-limiting wait before fetch, cooldown between
 * requests) where a call to `fetch()` immediately after the sleep would
 * itself throw on the aborted signal — rejecting keeps the failure mode
 * uniform and surfaces at the caller's catch block.
 *
 * Example: `services/lastfm-api.ts`, `services/discogs-api.ts`.
 *
 * ## `sleepOrResolve(ms, signal)`
 * Resolves early on abort. Use this in plugin processing loops where the
 * caller's next iteration already checks `signal.aborted` and exits cleanly.
 * Early-resolving skips the pause; rejecting here would only force the
 * caller to `try/catch` around a normal control-flow path.
 *
 * Example: `plugins/tmdb-metadata.plugin.ts`, `curated-lists-sync.plugin.ts`.
 *
 * The early-resolve variant makes no guarantee that the caller will observe
 * an aborted state — it's the caller's responsibility to re-check
 * `signal.aborted` after the sleep if that matters.
 */

/**
 * Sleep for `ms` milliseconds or reject with `AbortError` if `signal` fires.
 *
 * Treats an already-aborted signal as an immediate rejection (no timer
 * scheduled). When the abort fires during the wait, the timer is cleared
 * synchronously so the event loop doesn't keep a dead reference.
 */
export function sleepOrReject(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const abortError = (): unknown =>
            signal?.reason ?? new DOMException('Aborted', 'AbortError');

        if (signal?.aborted) {
            reject(abortError());
            return;
        }

        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        const onAbort = (): void => {
            clearTimeout(timeout);
            reject(abortError());
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Sleep for `ms` milliseconds or resolve early if `signal` fires.
 *
 * Treats an already-aborted signal as an immediate resolve (no timer
 * scheduled). When the abort fires during the wait, the timer is cleared
 * and the promise resolves — callers that care about the aborted state
 * should re-check `signal.aborted` after `await`.
 */
export function sleepOrResolve(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
