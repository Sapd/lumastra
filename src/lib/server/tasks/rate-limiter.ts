// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Rate-limited fetch for named external dependencies (ctx.dep(name)).
//
// Each dep gets a two-stage rate limit: a local in-memory token bucket
// (cheap, prevents bursts within one replica without a round-trip)
// composed with a Valkey-backed shared bucket via `shared-rate-bucket.ts`
// (caps aggregate outbound rate across all worker replicas). When Valkey
// is unreachable the shared gate falls through and per-replica
// enforcement carries on — degraded but not broken.
//
// Circuit breaker: per-dep in-memory state tracks consecutive 5xx failures.
// After cfg.circuitBreaker.failures threshold the circuit opens for
// cfg.circuitBreaker.cooldownMs. After cooldown, the next call is allowed through
// as a probe; success closes the circuit, failure reopens with same cooldown.
//
// Retry-After: when a 429 response includes a Retry-After header and the dep
// is configured with retryAfter='header', the fetcher waits the indicated
// delay (capped at 60s) and retries once.

import type { RateLimitedFetch } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import { awaitSharedToken } from './shared-rate-bucket.js';
import { safeFetch } from './url-safety.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const log = Logger.for('RateLimiter');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DepConfig {
    rps?: number;
    retryAfter?: 'header' | number;
    circuitBreaker?: { failures: number; cooldownMs: number };
    /**
     * App-internal escape hatch from the dep path's public-only SSRF guard
     * — NOT part of the SDK's public `externalDeps` shape (a builtin task
     * sets it directly on the object it declares, which survives
     * `defineTask()` structurally since that function does not strip extra
     * fields; see `builtin/native/embedding-dep.ts`'s `EMBEDDINGS_DEP`).
     *
     * When this returns `true`, the dep's fetch allows a private/loopback/
     * link-local target (an operator-configured trusted endpoint, e.g. a
     * self-hosted `EMBEDDING_BASE_URL` on a LAN) and falls back to a
     * same-origin-only redirect policy (`fetchWithTimeout`) instead of the
     * public-only guard (`safeFetch`) — mirrors `ai/voyage.ts`'s
     * `guardedDefaultFetch`, which applies the same trade-off on the
     * interactive (non-task) embedding path.
     *
     * A function, not a plain boolean, so it is read fresh on EVERY fetch
     * rather than frozen at `forDep()` construction time — a config change
     * (e.g. `EMBEDDING_ALLOW_PRIVATE_URLS` toggled in the admin UI) takes
     * effect on the next call with no restart, matching every other
     * `config.*` getter in this codebase. Omit (default) to always use the
     * public-only `safeFetch` guard.
     */
    allowPrivateUrls?: () => boolean;
}

interface CircuitState {
    failures: number;
    openUntil: number;
}

// ── Token bucket ──────────────────────────────────────────────────────────────

class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    /**
     * Maximum tokens the bucket can hold. For rps >= 1 this matches `rps`
     * (one second's worth of capacity). For rps < 1 (slow APIs like AniDB
     * at 0.5 rps = 30 rpm) we floor the cap at 1 — otherwise the bucket
     * could never accumulate a whole token and `take()` would loop forever
     * because `tokens >= 1` is always false.
     */
    private readonly capacity: number;

    constructor(public readonly rps: number) {
        this.capacity = Math.max(1, rps);
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
    }

    async take(): Promise<void> {
        // Loop rather than a single check-sleep-decrement: a non-atomic
        // "sleep once then unconditionally decrement" lets N concurrent
        // waiters all wake after one refill period and each subtract a
        // token, overshooting the bucket into negative-then-floored-at-0
        // territory — i.e. N requests fire off the back of a single
        // refill instead of one. Re-checking `tokens >= 1` after every
        // refill serializes waiters: only as many proceed per iteration
        // as there are whole tokens actually available.
        const msPerToken = 1000 / this.rps;
        for (;;) {
            this.refill();
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            await sleep(msPerToken);
        }
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const newTokens = (elapsed / 1000) * this.rps;
        this.tokens = Math.min(this.capacity, this.tokens + newTokens);
        this.lastRefill = now;
    }
}

// ── RateLimiter ───────────────────────────────────────────────────────────────

/**
 * Factory: one instance per process, shared across all runners.
 * `forDep(name, cfg)` returns a `RateLimitedFetch` for the named dep.
 */
export class RateLimiter {
    private readonly buckets = new Map<string, TokenBucket>();
    private readonly circuitState = new Map<string, CircuitState>();

    /**
     * Get (or create) a rate-limited fetch wrapper for a named external dep.
     *
     * NOTE: Process-local only. Cross-replica coordination deferred — each
     * replica maintains its own bucket and circuit state independently.
     * At typical single-process concurrency this is sufficient; add
     * Valkey-backed counters if multi-replica rate adherence is required.
     */
    forDep(name: string, cfg: DepConfig): RateLimitedFetch {
        // Validate at config time: rps=0 was previously interpreted as
        // "no bucket" (== unlimited), which is the opposite of what an
        // operator setting rps=0 expects. Negative rps would crash the
        // bucket math. Treat both as misconfiguration.
        if (cfg.rps !== undefined && (!Number.isFinite(cfg.rps) || cfg.rps <= 0)) {
            throw new Error(
                `RateLimiter.forDep(${name}): rps must be > 0 (got ${cfg.rps}). ` +
                    `Omit rps entirely to disable the token bucket.`,
            );
        }
        if (!this.buckets.has(name) && (cfg.rps ?? 0) > 0) {
            this.buckets.set(name, new TokenBucket(cfg.rps!));
        }

        const bucket = this.buckets.get(name);
        const recordFailure = this.recordFailure.bind(this);
        const recordSuccess = this.recordSuccess.bind(this);
        const circuitState = this.circuitState;

        // The SDK type is { fetch: typeof fetch }. We attach `name` as a
        // non-enumerable extra for diagnostics (runner.test.ts can read it).
        const fetchFn: typeof fetch = async (input, init?): Promise<Response> => {
            // SSRF guard — same DNS-pinning defense ctx.http applies via safeFetch.
            // Without this the dep path could reach loopback/private/link-local
            // hosts (Postgres, Valkey, internal admin UIs) that ctx.http rejects,
            // a non-uniform boundary exploitable by any installed plugin. safeFetch
            // resolves DNS and pins the connection to the validated address, so
            // an attacker-controlled hostname can't rebind to a private IP between
            // the syntactic check and the TCP connect.
            // Extract the URL string from the string | URL | Request input.
            const urlStr =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input instanceof Request
                        ? input.url
                        : String(input);

            // Normalize a Request input into (url, init) so safeFetch — which
            // takes a string URL + RequestInit — preserves method/headers/body.
            // A caller-supplied `init` wins over the Request's own fields. The
            // body is buffered to text up front so it can be replayed on the
            // Retry-After retry without a consumed-stream error (and so undici
            // doesn't need duplex streaming). Plugins funnel JSON/string bodies
            // through ctx.dep, so text buffering is lossless here.
            let effectiveInit: RequestInit;
            if (input instanceof Request) {
                const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
                const bufferedBody = hasBody ? await input.clone().text() : undefined;
                effectiveInit = {
                    method: input.method,
                    headers: input.headers,
                    ...(bufferedBody !== undefined ? { body: bufferedBody } : {}),
                    ...init,
                    signal: init?.signal === undefined ? input.signal : init.signal,
                };
            } else {
                effectiveInit = init ?? {};
            }

            // allowPrivateUrls (final fix wave, 2026-09-13): see the DepConfig
            // doc comment. Read live on every call, not cached.
            const pinnedFetch = (): Promise<Response> =>
                cfg.allowPrivateUrls?.()
                    ? trackExternalCall(
                          urlStr,
                          () => fetchWithTimeout(urlStr, effectiveInit),
                          effectiveInit.signal ?? null,
                      )
                    : safeFetch(urlStr, effectiveInit);

            // Circuit check.
            const cb = circuitState.get(name);
            if (cb && cb.openUntil > Date.now()) {
                throw new Error(`Dep ${name}: circuit open`);
            }

            // Token bucket gate — local first (cheap, prevents intra-replica
            // bursts), then shared Valkey gate (cross-replica aggregate cap).
            // Falls back to local-only when Valkey is unreachable. Same
            // two-stage shape as `acquireHttpToken` in http-rate-limit.ts.
            // Propagate the request's AbortSignal so a task cancel aborts
            // the bucket wait rather than ignoring the cancel until the
            // grant arrives.
            if (bucket) {
                await bucket.take();
                if (cfg.rps && Number.isFinite(cfg.rps) && cfg.rps > 0) {
                    await awaitSharedToken(
                        `dep:${name}`,
                        cfg.rps,
                        effectiveInit.signal ?? undefined,
                    );
                }
            }

            try {
                const res = await pinnedFetch();

                // 429 + Retry-After header handling.
                if (res.status === 429 && cfg.retryAfter === 'header') {
                    const ra = parseRetryAfter(res.headers.get('Retry-After'));
                    if (ra > 0) {
                        await sleep(Math.min(ra, 60_000));
                        return await pinnedFetch();
                    }
                }

                // Circuit failure / success accounting.
                if (res.status >= 500 && cfg.circuitBreaker) {
                    recordFailure(name, cfg.circuitBreaker);
                } else if (res.status < 400 && cfg.circuitBreaker) {
                    recordSuccess(name);
                }

                return res;
            } catch (err) {
                if (cfg.circuitBreaker) {
                    recordFailure(name, cfg.circuitBreaker);
                }
                throw err;
            }
        };

        const rateLimitedFetch: RateLimitedFetch = { fetch: fetchFn };
        // Attach name for diagnostics without widening the SDK type.
        Object.defineProperty(rateLimitedFetch, 'name', {
            value: name,
            enumerable: false,
        });

        return rateLimitedFetch;
    }

    // -- Circuit helpers -----------------------------------------------------

    private recordFailure(name: string, cfg: { failures: number; cooldownMs: number }): void {
        const current = this.circuitState.get(name) ?? {
            failures: 0,
            openUntil: 0,
        };
        const failures = current.failures + 1;
        if (failures >= cfg.failures) {
            const openUntil = Date.now() + cfg.cooldownMs;
            this.circuitState.set(name, { failures, openUntil });
            log.warn('circuit opened', {
                dep: name,
                failures,
                cooldownMs: cfg.cooldownMs,
            });
        } else {
            this.circuitState.set(name, { failures, openUntil: 0 });
        }
    }

    private recordSuccess(name: string): void {
        const current = this.circuitState.get(name);
        if (current && (current.failures > 0 || current.openUntil > 0)) {
            this.circuitState.set(name, { failures: 0, openUntil: 0 });
            log.info('circuit closed', { dep: name });
        }
    }

    /**
     * Inspect circuit state for a dep — exposed for tests and admin UI.
     */
    getCircuitState(name: string): CircuitState | undefined {
        return this.circuitState.get(name);
    }

    /**
     * Reset all state — for tests.
     */
    reset(): void {
        this.buckets.clear();
        this.circuitState.clear();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse Retry-After header value → milliseconds.
 * Accepts seconds (integer) or HTTP-date.
 */
function parseRetryAfter(value: string | null): number {
    if (!value) return 0;
    const secs = Number.parseInt(value, 10);
    if (!Number.isNaN(secs)) return secs * 1000;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
    return 0;
}
