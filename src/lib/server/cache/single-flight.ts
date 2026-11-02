// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single-flight (a.k.a. dogpile / stampede protection) for short-TTL Valkey caches.
 *
 * A plain `cacheGet` → miss → `compute` → `cacheSet` cache has a thundering-herd
 * hole: the instant a hot key's TTL lapses, EVERY concurrent caller misses and
 * EVERY one runs the expensive `compute` before the first write lands. For the
 * admin dashboard polls (status/cluster/attention) that meant a fan-out of heavy
 * stats queries hitting the DB once per TTL per open tab per replica.
 *
 * This helper collapses that herd to a single recompute per TTL: the first caller
 * to miss grabs a short Valkey lock and computes; everyone else briefly waits for
 * its value to land instead of stampeding the DB. It is intentionally degrade-safe
 * — if Valkey is unavailable, lock/cache calls no-op and callers simply compute
 * directly (the pre-existing behaviour), never hanging.
 *
 * Payloads are opaque strings (typically a JSON response body), matching the
 * existing attention-cache shape — callers serialise/deserialise themselves.
 */

import {
    cacheGet,
    cacheSet,
    cacheExists,
    acquireLock,
    releaseLock,
    isValkeyReady,
} from './valkey.js';
import { sleepOrResolve } from '../utils/abortable-sleep.js';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('SingleFlight');

export interface SingleFlightOptions {
    /**
     * Versioned cache key holding the computed string (e.g. `v1:admin:status`).
     * The single-flight lock key derives from this (`<cacheKey>:sf-lock`).
     */
    cacheKey: string;
    /** TTL for the freshly computed value, in seconds. */
    ttlSeconds: number;
    /** Produce the value to cache. Should return the serialized payload (e.g. a JSON body). */
    compute: () => Promise<string>;
    /**
     * Lock TTL in seconds — a deadlock backstop so a crashed/slow leader cannot
     * wedge followers forever. Must comfortably exceed a normal `compute`.
     * Default 10s.
     */
    lockTtlSeconds?: number;
    /**
     * Absolute cap on how long a follower waits for the leader's value before
     * computing itself — a safety backstop so a caller never hangs. Followers
     * already bail early the moment the leader's lock disappears, so this only
     * bites if a lock somehow outlives its TTL. Defaults to `lockTtlSeconds`
     * (in ms) so a slow-but-live leader's whole compute window is covered.
     */
    maxWaitMs?: number;
    /** Poll interval while waiting for the leader's value. Default 100ms. */
    pollIntervalMs?: number;
    /**
     * Decide the TTL once the value is known, overriding `ttlSeconds`.
     *
     * Exists because a compute can succeed and still return something you only
     * half trust — a search page an optional source timed out of, say. The
     * alternatives are both worse: caching it for the full TTL serves a known-
     * incomplete answer to everyone in the scope, and deleting it after the
     * write leaves a window where readers get it anyway AND drops the
     * herd protection exactly when a dependency is sick and the herd is
     * largest. A short TTL bounds the staleness while keeping the lock useful.
     *
     * Only consulted on the leader path, which is the only path that caches.
     *
     * Must return a positive whole number of seconds. Anything else — 0, NaN,
     * a negative — falls back to `ttlSeconds` with a warning rather than being
     * passed through: `cacheSet` treats a falsy TTL as "no expiry", so a
     * plausible-looking `() => 0` for "don't cache this one" would write a
     * PERMANENT key under a versioned namespace, recoverable only by a version
     * bump or a manual DEL. There is deliberately no way to say "skip the
     * cache" here; a caller that needs that should not be using single-flight.
     *
     * A throwing resolver is caught and treated the same way — a successful
     * `compute()` must not be discarded because the TTL calculation failed.
     */
    resolveTtlSeconds?: (value: string) => number;
}

/**
 * The TTL to actually write with, guarding every way the caller's resolver can
 * hand back something `cacheSet` would turn into a key that never expires.
 */
function resolveTtl(opts: SingleFlightOptions, value: string, fallbackSeconds: number): number {
    if (!opts.resolveTtlSeconds) return fallbackSeconds;
    let resolved: number;
    try {
        resolved = opts.resolveTtlSeconds(value);
    } catch (error) {
        logger.warn('resolveTtlSeconds threw; using the declared TTL', {
            cacheKey: opts.cacheKey,
            error: error instanceof Error ? error.message : String(error),
        });
        return fallbackSeconds;
    }
    if (!Number.isFinite(resolved) || resolved < 1) {
        logger.warn('resolveTtlSeconds returned a non-positive TTL; using the declared TTL', {
            cacheKey: opts.cacheKey,
            resolved,
        });
        return fallbackSeconds;
    }
    return Math.floor(resolved);
}

/**
 * Return the cached value for `cacheKey`, or compute-and-cache it under a
 * single-flight lock so concurrent misses don't all recompute.
 */
export async function getOrComputeSingleFlight(opts: SingleFlightOptions): Promise<string> {
    const { cacheKey, ttlSeconds, compute } = opts;
    const lockTtlSeconds = opts.lockTtlSeconds ?? 10;
    // Wait up to the leader's full lock lifetime by default — covers a slow
    // compute — but the loop below bails early as soon as the lock is released.
    const maxWaitMs = opts.maxWaitMs ?? lockTtlSeconds * 1000;
    const pollIntervalMs = opts.pollIntervalMs ?? 100;
    const lockKey = `${cacheKey}:sf-lock`;

    // 1. Fast path — serve a cached value.
    const cached = await cacheGet(cacheKey);
    if (cached !== null) return cached;

    // 2. Try to become the single computing leader for this key.
    const token = await acquireLock(lockKey, lockTtlSeconds);
    if (token) {
        try {
            // Another leader may have filled the cache between our miss and our
            // lock acquisition — re-check before doing the expensive work.
            const filled = await cacheGet(cacheKey);
            if (filled !== null) return filled;

            const value = await compute();
            await cacheSet(cacheKey, value, resolveTtl(opts, value, ttlSeconds));
            return value;
        } finally {
            await releaseLock(lockKey, token);
        }
    }

    // 3. Follower path — a peer holds the lock and is computing. Wait for its
    //    value to land (as long as it genuinely holds the lock) rather than
    //    stampeding the DB ourselves. Skip the wait entirely when Valkey is
    //    unavailable: the cache can never fill (acquireLock fell back to an
    //    in-memory lock, cacheSet is a no-op), so waiting only adds latency
    //    before the inevitable direct compute below.
    if (isValkeyReady()) {
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            await sleepOrResolve(pollIntervalMs);
            const filled = await cacheGet(cacheKey);
            if (filled !== null) return filled;
            // Leader released (or its lock TTL expired) without a value landing —
            // stop waiting and compute directly rather than idle to the deadline.
            // This keeps followers waiting through a slow-but-live compute (no
            // premature stampede) while still bailing the instant the leader dies.
            if (!(await cacheExists(lockKey))) break;
        }
    }

    // 4. Leader is slow/dead, or Valkey is unavailable so the cache never fills.
    //    Degrade to a direct compute — correctness over dedup; never hang.
    logger.debug('single-flight wait timed out; computing directly', {
        cacheKey,
    });
    return compute();
}
