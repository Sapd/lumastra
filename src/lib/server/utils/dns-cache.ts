// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Process-wide DNS lookup cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * `net.connect` (and therefore postgres.js + ioredis/BullMQ) resolves its host
 * through `dns.lookup`, which runs `getaddrinfo` on the libuv THREADPOOL. Our
 * backing stores are reached by stable Docker service names (`ai-postgres`,
 * `ai-valkey`, `ai-valkey-tasks`) that resolve in ~1ms — but every new/reconnected
 * connection re-resolves them, and under heavy task load the threadpool fills with
 * filesystem work (see safe-fs.ts) so these lookups QUEUE. A delayed lookup makes
 * the connection exceed its connect timeout → `CONNECT_TIMEOUT`/`connect ETIMEDOUT`
 * → reconnect → MORE lookups → a spiral that strands heartbeats and orphans runs.
 *
 * A stable hostname should never hit the threadpool repeatedly. This caches the
 * resolved address for a short TTL so the hot path (reconnects) returns instantly
 * without a threadpool slot, breaking that spiral.
 *
 * SAFETY: it wraps the ORIGINAL `dns.lookup` (delegating on cache miss), so all
 * native resolution semantics — including `/etc/hosts` / Docker `extra_hosts`,
 * which a c-ares-based resolver (`dns.resolve`) would silently ignore — are
 * preserved. Only the simple single-result case is cached; `{all:true}`, custom
 * `hints`, or exotic families delegate straight through. Short TTL (default 30s)
 * bounds staleness if a service's container is recreated with a new IP.
 */

import dns, { type LookupAddress } from 'node:dns';
import { promisify } from 'node:util';

type LookupCallback = (
    err: Error | null,
    address: string | LookupAddress[],
    family?: number,
) => void;

interface CacheEntry {
    address: string;
    family: number;
    expires: number;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return fallback;
    return n;
}

const TTL_MS = envInt('LUMASTRA_DNS_CACHE_TTL_MS', 30_000, 1_000, 3_600_000);
const ENABLED = process.env.LUMASTRA_DNS_CACHE !== 'false';

const cache = new Map<string, CacheEntry>();

// Capture the genuine native implementation exactly once.
const originalLookup = dns.lookup;

/** Observability: cached host count (for a future admin/health surface). */
export function dnsCacheStats(): { entries: number; ttlMs: number; enabled: boolean } {
    return { entries: cache.size, ttlMs: TTL_MS, enabled: ENABLED };
}

// Exported for unit tests; production callers reach it via installDnsCache().
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors dns.lookup's overloaded signature
export function cachedLookup(hostname: string, options: any, callback?: any): void {
    // Normalise the (hostname, [options], callback) overloads.
    let cb: LookupCallback;
    let opts: dns.LookupOptions;
    if (typeof options === 'function') {
        cb = options as LookupCallback;
        opts = {};
    } else {
        cb = callback as LookupCallback;
        opts =
            typeof options === 'number'
                ? { family: options }
                : ((options as dns.LookupOptions) ?? {});
    }

    const family = opts.family ?? 0;
    // Cache only the plain single-result case. Anything with `all`, custom `hints`,
    // an exotic family, or a missing hostname goes straight to the native lookup
    // with the caller's ORIGINAL args (preserves every semantic).
    const cacheable =
        !!hostname &&
        typeof cb === 'function' &&
        !opts.all &&
        opts.hints === undefined &&
        (family === 0 || family === 4 || family === 6);

    if (!cacheable) {
        if (typeof options === 'function') originalLookup(hostname, options as never);
        else originalLookup(hostname, options as never, callback as never);
        return;
    }

    const key = `${hostname}|${family}`;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expires > now) {
        // Preserve the async contract — never call back synchronously.
        process.nextTick(cb, null, hit.address, hit.family);
        return;
    }

    originalLookup(hostname, { family }, (err: Error | null, address: string, fam: number) => {
        if (!err && typeof address === 'string' && address.length > 0) {
            cache.set(key, { address, family: fam, expires: now + TTL_MS });
        }
        cb(err, address, fam);
    });
}

// Preserve `util.promisify(dns.lookup)` support so callers that promisify the
// global still work AND get the cache (default promisify would lose the symbol).
Object.defineProperty(cachedLookup, promisify.custom, {
    value: (hostname: string, options?: dns.LookupOptions) =>
        new Promise((resolve, reject) => {
            cachedLookup(
                hostname,
                options ?? {},
                (err: Error | null, address: string | LookupAddress[], family?: number) => {
                    if (err) reject(err);
                    else if (options && (options as dns.LookupOptions).all) resolve(address);
                    else resolve({ address, family });
                },
            );
        }),
});

let installed = false;

/**
 * Install the cache by replacing `dns.lookup`. Idempotent; no-op when disabled
 * via `LUMASTRA_DNS_CACHE=false`. Must run before connection pools are created
 * (called from applyRuntimeOptimizations at server startup).
 */
export function installDnsCache(): boolean {
    if (!ENABLED || installed || dns.lookup !== originalLookup) return false;
    // @ts-expect-error -- intentional global override of the native lookup
    dns.lookup = cachedLookup;
    installed = true;
    return true;
}
