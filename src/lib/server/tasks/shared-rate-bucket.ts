// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-replica shared rate-limit bucket.
//
// Replaces the process-local token-bucket pattern in `http-rate-limit.ts`
// and `rate-limiter.ts` so multiple workers / web replicas share one
// budget per `bucketKey` instead of each handing out a full rps locally.
// Important for low-rps providers (AniDB at 0.5 rps) where N replicas
// would multiply outbound rate by N and trip the provider's server-side
// throttle.
//
// Algorithm: fixed-window counter via atomic Valkey EVAL. The window is
// 1 second by default (configurable via `windowMs`). Within a window we
// allow up to `limit = max(1, round(rps * windowMs / 1000))` calls. The
// last call in a window pulls the PTTL and reports "wait until reset"
// to the caller. This is a coarser shape than a smooth token bucket but
// fits how external providers actually rate-limit ("N requests per
// second, bursty"). For rps < 1 (AniDB 0.5) the window scales up
// automatically so `limit` stays ≥ 1.
//
// Fallback: when Valkey is unavailable we don't block — we return
// `granted: true` immediately. The local TokenBucket in the call sites
// is still kept as a fast-path / fallback so a Valkey outage degrades
// to "each replica enforces locally" rather than "no rate limiting at
// all". Documented at each call site.

import crypto from 'node:crypto';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike } from './valkey-types.js';
import { isNoScriptError } from './lua/loader.js';

const log = Logger.for('SharedRateBucket');

// Lua script: atomic INCR + PEXPIRE-on-first + PTTL-on-overage.
//
// Returns:
//   0           — granted (under limit for this window)
//   <positive>  — denied; milliseconds until the window resets
//
// KEYS[1] = bucket key
// ARGV[1] = limit (max calls per window)
// ARGV[2] = window TTL (ms) — set on the FIRST call of the window
const LUA_TRY_ACQUIRE = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
    redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
local limit = tonumber(ARGV[1])
if count <= limit then
    return 0
end
local pttl = redis.call('PTTL', KEYS[1])
-- PTTL returns -1 when no TTL (shouldn't happen given the branch above) and
-- -2 when the key is missing (vanished between INCR and PTTL). Treat both
-- as "retry immediately on the next window" instead of returning a negative
-- wait value to the caller.
if pttl < 0 then
    return 1
end
return pttl
`;

// SHA-1 of the Lua script — used for EVALSHA fast-path so we don't re-send
// the full source on every call (high-rps providers like TMDB at 50 rps
// would push ~25 KB/s of script source per replica without this).
const LUA_TRY_ACQUIRE_SHA = crypto.createHash('sha1').update(LUA_TRY_ACQUIRE).digest('hex');

// Tracks whether the script has been loaded on the connected Valkey
// instance. Reset on any NOSCRIPT response so a server flush / failover
// re-loads transparently.
let scriptLoaded = false;

// Choose a window size that scales with rps so `limit` is always ≥ 1.
// For rps >= 1 we use a 1-second window. For rps in (0, 1) we stretch
// the window so `floor(rps * window) >= 1`.
function chooseWindow(rps: number): { limit: number; windowMs: number } {
    if (rps >= 1) {
        return { limit: Math.max(1, Math.round(rps)), windowMs: 1_000 };
    }
    // e.g. rps = 0.5 → window = 2000ms, limit = 1
    const windowMs = Math.ceil(1_000 / rps);
    return { limit: 1, windowMs };
}

/**
 * Try to consume one token for `bucketKey`.
 *
 * Returns `{ granted: true, waitMs: 0 }` if under-limit for the current
 * window, otherwise `{ granted: false, waitMs: <ms until window resets> }`.
 *
 * When Valkey is unreachable or the EVAL throws, returns
 * `{ granted: true, waitMs: 0, fellBack: true }` — the caller's local
 * bucket is the safety net (the call sites enforce both this AND a local
 * bucket, so a Valkey outage degrades to per-replica enforcement).
 */
export async function tryAcquireSharedToken(
    bucketKey: string,
    rps: number,
): Promise<{ granted: boolean; waitMs: number; fellBack?: boolean }> {
    if (!Number.isFinite(rps) || rps <= 0) {
        return { granted: true, waitMs: 0 };
    }
    const client = getCoordinationClient();
    if (!client) {
        // Valkey not connected — fall through, local bucket handles it.
        return { granted: true, waitMs: 0, fellBack: true };
    }
    const { limit, windowMs } = chooseWindow(rps);
    const key = `rate-bucket:${bucketKey}`;
    try {
        const raw = await invokeScript(client, [key, String(limit), String(windowMs)]);
        // Explicit nullish guard — Number(null) = 0 = "granted", a silent
        // bypass. Treat null/undefined as a fallback grant + warn so the
        // operator can see something went wrong instead of an invisible
        // rate-limit hole.
        if (raw == null) {
            log.warn('shared-rate-bucket: EVAL returned null, falling back', {
                bucketKey,
            });
            return { granted: true, waitMs: 0, fellBack: true };
        }
        const waitMs = Number(raw);
        if (!Number.isFinite(waitMs) || waitMs < 0) {
            // Defensive — Lua should always return a non-negative integer.
            log.warn('shared-rate-bucket: unexpected EVAL result, allowing call', {
                bucketKey,
                raw: String(raw),
            });
            return { granted: true, waitMs: 0, fellBack: true };
        }
        if (waitMs === 0) return { granted: true, waitMs: 0 };
        return { granted: false, waitMs };
    } catch (err) {
        log.warn('shared-rate-bucket: EVAL failed, falling back to local-only', {
            bucketKey,
            err: err instanceof Error ? err.message : String(err),
        });
        return { granted: true, waitMs: 0, fellBack: true };
    }
}

/**
 * EVALSHA fast-path with EVAL fallback on NOSCRIPT. Mirrors the
 * SCRIPT LOAD + EVALSHA pattern used by tasks/lua/loader.ts so we don't
 * burn Valkey bandwidth re-sending the script on every call.
 *
 * The fallback path runs a plain EVAL (which Valkey caches by hash, so
 * subsequent EVALSHA on the same connection succeed) and flips
 * `scriptLoaded` so the next call skips the NOSCRIPT recovery.
 */
async function invokeScript(client: ValkeyLike, args: string[]): Promise<unknown> {
    if (scriptLoaded) {
        try {
            return await client.customCommand(['EVALSHA', LUA_TRY_ACQUIRE_SHA, '1', ...args]);
        } catch (err) {
            // NOSCRIPT — server flushed scripts (restart / failover / SCRIPT
            // FLUSH). Clear the loaded flag and fall through to plain EVAL.
            // isNoScriptError tolerates every client phrasing (raw "NOSCRIPT"
            // and glide's "No matching script"); a bare includes('NOSCRIPT')
            // would miss the glide form and surface the error to callers.
            if (isNoScriptError(err)) {
                scriptLoaded = false;
            } else {
                throw err;
            }
        }
    }
    const result = await client.customCommand(['EVAL', LUA_TRY_ACQUIRE, '1', ...args]);
    // Successful EVAL caches the script on the server by SHA — next call
    // can use the EVALSHA fast-path.
    scriptLoaded = true;
    return result;
}

/**
 * Wait until a token is available for `bucketKey`, then return. Honours
 * `signal` — if aborted mid-wait, throws the signal's reason. Combines
 * `tryAcquireSharedToken` with sleep-and-retry.
 *
 * If the shared bucket falls back (Valkey unreachable / EVAL error) on
 * the very first try, returns immediately with `fellBack: true` so the
 * caller's local bucket can enforce the limit locally instead.
 */
export async function awaitSharedToken(
    bucketKey: string,
    rps: number,
    signal?: AbortSignal,
): Promise<{ fellBack: boolean }> {
    while (true) {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        const result = await tryAcquireSharedToken(bucketKey, rps);
        if (result.granted) {
            return { fellBack: result.fellBack === true };
        }
        // Add a small jitter so multiple waiters don't synchronise their
        // retries to the millisecond and pile up at the window reset.
        const waitMs = Math.max(1, result.waitMs + Math.floor(Math.random() * 50));
        await sleepAbortable(waitMs, signal);
    }
}

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return;
    }
    if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
