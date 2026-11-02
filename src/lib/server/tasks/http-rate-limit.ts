// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-provider HTTP rate-limit enforcement for `ctx.http`.
 *
 * The SDK lets providers declare `rateLimit: { rps: number }` in their
 * manifest. Historically this was a metadata hint only — the runtime
 * `HttpClient` ignored it and providers (notably AniDB) rolled their own
 * module-level throttling. This module makes the host enforce what the
 * provider declared.
 *
 * Two design points worth calling out:
 *
 *   1. Buckets are PROCESS-SINGLETONS keyed by providerId — every
 *      `buildHttpClient` call for the same provider shares state. A
 *      per-instance bucket would be useless: each `invokeProviderSearch`
 *      builds a fresh `PluginContext`, so a fresh bucket would always
 *      hand out a full second's worth of tokens. Singleton state is the
 *      whole point.
 *
 *   2. Buckets are PER-PROVIDER (keyed by id), so TMDB at 4 rps and
 *      AniDB at 0.5 rps don't share a starvation surface — one slow
 *      provider can't block another.
 *
 * Cross-replica coordination layered on TOP of the local bucket via
 * `shared-rate-bucket.ts` — `acquireHttpToken` first takes a local
 * token, then awaits a shared Valkey token. The local bucket prevents
 * bursts within one replica without a round-trip; the shared bucket
 * prevents aggregate overshoot across all replicas. Falls back to
 * per-replica enforcement when Valkey is unreachable. The hostile case
 * the shared bucket fixes: AniDB at 0.5 rps × N replicas would multiply
 * to N×0.5 rps aggregate and trip AniDB's server-side throttle without
 * the shared gate.
 *
 * This module is separate from `rate-limiter.ts`. That file backs
 * `ctx.dep(name).fetch()` — a per-task, per-named-dep surface with its
 * own circuit-breaker semantics. Different surface, different lifetime
 * (`RateLimiter` is owned by `TaskRunner` and reset on runner reset).
 * Reusing it would conflate the two concerns. Token-bucket logic is
 * cheap to duplicate; the abort-aware bucket below is ~30 lines.
 */

import { awaitSharedToken } from './shared-rate-bucket.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HttpRateLimitCfg {
    /** Requests per second budget. Fractional values are honoured (e.g. 0.5 = 1 req / 2s). */
    rps: number;
}

// ── Token bucket ──────────────────────────────────────────────────────────────

/**
 * Abort-aware token bucket.
 *
 * `capacity` is floored at 1 — for rps < 1 (AniDB at 0.5) the bucket
 * could never accumulate a whole token and `take()` would spin forever.
 * Same invariant as `RateLimiter`'s internal bucket.
 *
 * The waiting strategy is dead simple: if no token is available, sleep
 * one msPerToken interval, refill, and consume. No queue, no fairness
 * guarantees beyond what the JS task queue provides — that's enough at
 * the rps budgets in play (TMDB 4, MusicBrainz/mdblist 1, AniDB 0.5).
 */
class TokenBucket {
    private tokens: number;
    private lastRefill: number;
    private readonly capacity: number;

    constructor(
        public readonly rps: number,
        startEmpty = false,
    ) {
        this.capacity = Math.max(1, rps);
        this.tokens = startEmpty ? 0 : this.capacity;
        this.lastRefill = Date.now();
    }

    /**
     * Wait for and consume one token. Honours `signal` — if it aborts
     * while we're sleeping, throws the signal's `reason` (an AbortError
     * by default). Already-aborted signals throw immediately.
     */
    async take(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        // Loop rather than a single check-sleep-decrement: a non-atomic
        // "sleep once then unconditionally decrement" lets N concurrent
        // waiters all wake after one refill period and each subtract a
        // token, overshooting the bucket instead of gating to the actual
        // number of tokens available. Re-checking `tokens >= 1` after
        // every refill serializes waiters instead of letting a burst
        // through on a single refill tick.
        const msPerToken = 1000 / this.rps;
        for (;;) {
            this.refill();
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            await sleepAbortable(msPerToken, signal);
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

// ── Singleton bucket registry ─────────────────────────────────────────────────

/**
 * Module-level bucket store. Keyed by providerId (or any opaque string).
 * MUST be a module singleton — see file-header note on why per-instance
 * state would defeat the rate limit.
 */
const buckets = new Map<string, TokenBucket>();

/**
 * Get or create the bucket for `providerId`. If a different rps is
 * supplied for the same id (e.g., operator updated config and the next
 * call passes a different value) we keep the original bucket — switching
 * mid-flight would reset accumulated state. The first rps wins for the
 * process lifetime. To update the rate without a restart, call
 * `updateBucketRate(providerId, newRps)` after persisting the change.
 */
function getBucket(providerId: string, rps: number): TokenBucket {
    const existing = buckets.get(providerId);
    if (existing) return existing;
    const bucket = new TokenBucket(rps);
    buckets.set(providerId, bucket);
    return bucket;
}

/**
 * Acquire a token for `providerId` before issuing an HTTP request. No-op
 * when `cfg` is undefined (non-provider tasks, providers without a
 * declared limit). Honours `signal` for abort during the wait.
 *
 * Two-stage rate limit:
 *   1. Local bucket (this module) — cheap, per-process, prevents bursts
 *      WITHIN one replica without a Valkey round-trip.
 *   2. Shared Valkey bucket (`shared-rate-bucket.ts`) — cross-replica,
 *      caps aggregate outbound rate across all worker / web replicas.
 *
 * Stage 2 only runs after stage 1 has handed out the local token. The
 * shared bucket may then make the caller wait further if other replicas
 * have already saturated the window. When Valkey is unreachable, stage
 * 2 falls back transparently and per-replica enforcement carries on.
 */
export async function acquireHttpToken(
    providerId: string | undefined,
    cfg: HttpRateLimitCfg | undefined,
    signal?: AbortSignal,
): Promise<void> {
    if (!providerId || !cfg || !Number.isFinite(cfg.rps) || cfg.rps <= 0) return;
    const bucket = getBucket(providerId, cfg.rps);
    await bucket.take(signal);
    // Stage 2: cross-replica gate. Skip the round-trip when Valkey isn't
    // configured (dev/test path), let local enforcement stand.
    await awaitSharedToken(`http:${providerId}`, cfg.rps, signal);
}

/**
 * Update the rps for an existing bucket (or create one at the new rate).
 *
 * Called by the admin settings PUT when a plugin's `rps` changes, so an
 * operator lowering a provider's rate to stop hammering an upstream API takes
 * effect immediately rather than at the next restart — which is what happened
 * for as long as this had no caller.
 *
 * Implementation: replaces the bucket. Any in-flight `take()` callers
 * complete against the OLD bucket — fine, since their wait was already
 * sized by the old msPerToken. New calls go through the new bucket.
 */
export function updateBucketRate(providerId: string, rps: number): void {
    if (!Number.isFinite(rps) || rps <= 0) {
        // Treat as "remove the bucket" — corresponds to rps cleared in
        // settings (provider reverts to manifest default on next call).
        buckets.delete(providerId);
        return;
    }
    // Start the replacement bucket empty so new callers must wait for the
    // first token to accumulate. Without this, both the old bucket (held by
    // in-flight take() callers) and the new full bucket hand out tokens
    // simultaneously — a brief double-spend against the operator's intent.
    buckets.set(providerId, new TokenBucket(rps, true));
}

/**
 * Drop the bucket for `providerId`. Called when a provider is unregistered
 * (e.g., external plugin hot-unload). No-op if no bucket exists.
 *
 * @public — exported for external plugins; do not remove.
 */
export function removeBucket(providerId: string): void {
    buckets.delete(providerId);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Reset all bucket state. Tests only — production code should never
 * call this (it would let a single replica burst past its budget).
 */
export function __resetHttpRateLimitBucketsForTests(): void {
    buckets.clear();
}

/**
 * Peek the bucket count. Tests only.
 */
export function __getHttpRateLimitBucketCountForTests(): number {
    return buckets.size;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Promise-based sleep that rejects if `signal` aborts.
 *
 * Listener is removed on resolution to avoid leaking memory when a
 * long-lived signal is reused across many short waits.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Re-apply operator rps overrides at boot.
 *
 * Buckets are created from the plugin's MANIFEST rate (see
 * `plugin-context.ts`), which is built synchronously and cannot read the
 * database. So without this pass an operator's stored rps applied only until
 * the next restart and then silently reverted to the manifest — a worse failure
 * than never applying at all, because the admin page kept showing the stored
 * value while the process used a different one.
 *
 * Best-effort by design: a failure here must not stop the server booting, and
 * the consequence of skipping it is the pre-existing behaviour rather than
 * anything new.
 */
export async function applyStoredRateLimits(sql: {
    <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}): Promise<number> {
    try {
        const rows = (await sql`
            SELECT plugin_id, value FROM plugin_settings WHERE key = 'rps'
        `) as unknown as Array<{ plugin_id: string; value: unknown }>;
        let applied = 0;
        for (const row of rows) {
            const rps = Number(row.value);
            // A non-positive or unparseable stored value means "no override",
            // which is exactly what updateBucketRate's remove path expresses.
            if (!Number.isFinite(rps) || rps <= 0) continue;
            updateBucketRate(row.plugin_id, rps);
            applied++;
        }
        return applied;
    } catch {
        return 0;
    }
}
