// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared task helper: run a task body while counting the external HTTP
 * requests it makes to providers, then record that count on the run via
 * `ctx.spend('api_calls', n)`. The count surfaces on the admin Usage & Cost
 * page (`/admin/system/cost`) as per-task request volume.
 *
 * The runner opens this scope for every task, including worker-isolated tasks.
 * Existing nested helpers reuse it. Provider transports report each request
 * attempt; tasks must not also self-report api_calls.
 */

import {
    REQUEST_PATH_PROVIDER_HOSTS,
    withExternalRequestCountSettled,
} from '../utils/external-request-counter.js';

/** Minimal structural view of the bits of TaskContext this helper touches. */
interface ApiCallSpender {
    spend(
        kind: 'api_calls' | `api_calls:${string}` | `api_errors:${string}` | `api_429:${string}`,
        units: number,
    ): void;
}

/**
 * Execute `body` with an external-request counting scope and record the result.
 * Spends the bare `api_calls` total (kept for Prometheus + backward compat) and
 * a per-host `api_calls:<host>` kind for each domain the run hit, plus
 * `api_errors:<host>` (failed calls, incl. 429) and `api_429:<host>` (rate
 * limited) where they occurred. No-op when no external requests were made.
 * Returns the body's own result unchanged.
 *
 * Records even when `body` throws partway through (via the settled counter's
 * `finally`), so a drain that burned real quota before failing still reports it.
 */
export async function withApiCallSpend<T>(ctx: ApiCallSpender, body: () => Promise<T>): Promise<T> {
    return withExternalRequestCountSettled(
        body,
        ({ byHost, errorsByHost, rateLimitedByHost, total }) => {
            ctx.spend('api_calls', total);
            for (const [host, n] of byHost) {
                ctx.spend(`api_calls:${host}`, n);
            }
            // Failed calls (4xx except 404, 5xx, no response) and the 429 subset, per host.
            // Only allowlisted provider hosts may appear in these new keys.
            // Healthy runs add no extra keys.
            for (const [host, n] of errorsByHost) {
                if (REQUEST_PATH_PROVIDER_HOSTS.has(host)) ctx.spend(`api_errors:${host}`, n);
            }
            for (const [host, n] of rateLimitedByHost) {
                if (REQUEST_PATH_PROVIDER_HOSTS.has(host)) ctx.spend(`api_429:${host}`, n);
            }
        },
    );
}
