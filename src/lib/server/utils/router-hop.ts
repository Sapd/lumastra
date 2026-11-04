// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Router-hop authentication (Helm chart).
 *
 * Behind the chart's nginx router, web's TCP peer is a router pod, but playback grants and
 * PAT/service-token IP allowlists need the real client address, which the router sends in
 * X-Forwarded-For. A pod network address is no proof of being the router (any pod can reach
 * web:3000 unless a NetworkPolicy says otherwise), so the router also sends a secret in
 * `X-Lumastra-Router-Hop`. The app believes the forwarded client address of a request that
 * carries the matching value, whatever its peer address.
 *
 * The secret is HMAC-SHA256(key = LUMASTRA_MASTER_KEY, message = "lumastra-router-hop-v1"), hex.
 * The router's init container computes the same value (chart: templates/router.yaml, hop.js), so
 * a default install needs no extra Secret key and the master key never reaches the nginx
 * container. Only an ENV master key reaches the router. master-key.ts back-fills
 * process.env.LUMASTRA_MASTER_KEY from a key FILE, so the app may hold a derived value even
 * when the router cannot: that still fails closed, because the router then sends no header (an
 * empty key renders an empty map value, which nginx drops), nothing matches, and the client
 * address stays the TCP peer, the strict default. (A router whose key differs from the app's
 * fails the same way.)
 *
 * WHAT THE HOP PROVES: the request came through the router. It does NOT prove the router's
 * X-Forwarded-For is honest: the router takes it from its own peer when that peer is in
 * router.realIp.fromCIDRs (default: all of RFC 1918), so a pod that can reach the router can
 * make it forward any address with a valid hop. The chart tells the app whether that range is
 * wide (LUMASTRA_ROUTER_REALIP_WIDE); the self-checks then report the client IP as caveated.
 * Narrow router.realIp.fromCIDRs to the ingress pods and/or enable networkPolicy.ingressFrom.
 *
 * The derived value is a plain HMAC of the key: with a low-entropy passphrase key, someone who
 * sniffs it (it travels in cleartext inside the cluster) can brute-force the key offline. Use
 * a 64-hex key (`openssl rand -hex 32`).
 *
 * This grants no identity trust: forward-auth identity headers are decided by TRUSTED_PROXY_IPS
 * alone (client-ip.ts isForwardAuthPeerTrusted).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ROUTER_HOP_HEADER = 'x-lumastra-router-hop';
const ROUTER_HOP_LABEL = 'lumastra-router-hop-v1';

/** The shared secret for a master key (hex). Empty for an empty key. Mirrors the chart's hop.js. */
export function deriveRouterHopSecret(masterKey: string | undefined): string {
    const key = (masterKey ?? '').trim();
    if (!key) return '';
    return createHmac('sha256', Buffer.from(key, 'utf8')).update(ROUTER_HOP_LABEL).digest('hex');
}

let cachedKey: string | undefined;
let cachedDigest: Buffer | null = null;

function expectedDigest(): Buffer | null {
    const key = process.env.LUMASTRA_MASTER_KEY;
    if (key !== cachedKey) {
        cachedKey = key;
        const secret = deriveRouterHopSecret(key);
        cachedDigest = secret ? createHash('sha256').update(secret).digest() : null;
    }
    return cachedDigest;
}

// The verdict is carried by the request's async context, NOT by the Request object: between the
// hooks handle and an endpoint the Request is rebuilt (Paraglide's middleware hands the chain a
// cloned Request, FORCE_LOCALE builds a new one), and the clone has neither the mark nor the
// (already stripped) header. A nested handle run for an internal sub-request (event.fetch) starts
// its own scope, so a sub-request never inherits the outer verdict: it resolves from its own
// headers, consistently at mint and at check time.
interface HopScope {
    authenticated: boolean;
}
const scope = new AsyncLocalStorage<HopScope>();
const authenticated = new WeakSet<object>();
let hopSeen = false;

function headerMatches(headers: Headers): boolean {
    if (typeof headers?.get !== 'function') return false;
    const expected = expectedDigest();
    const presented = headers.get(ROUTER_HOP_HEADER);
    if (!expected || !presented) return false;
    // Compare fixed-length digests in constant time.
    return timingSafeEqual(createHash('sha256').update(presented.trim()).digest(), expected);
}

/**
 * Whether this request came through the router (carries the matching hop secret). Safe to call
 * before or after `acceptAndStripRouterHop`.
 */
export function isRouterHopAuthenticated(request: Pick<Request, 'headers'> | undefined): boolean {
    const inScope = scope.getStore();
    if (inScope) return inScope.authenticated;
    if (!request) return false;
    if (authenticated.has(request)) return true;
    return headerMatches(request.headers);
}

/**
 * First thing in the handle chain: remember whether the hop secret matched, then remove the
 * header so no later code, log line or proxied request can see the secret.
 */
export function acceptAndStripRouterHop(request: Request): boolean {
    const ok = authenticated.has(request) || headerMatches(request.headers);
    if (ok) {
        authenticated.add(request);
        hopSeen = true;
    }
    try {
        request.headers.delete(ROUTER_HOP_HEADER);
    } catch {
        // Immutable headers: the result is still recorded above.
    }
    return ok;
}

/**
 * Run `fn` (the rest of the handle chain) in a scope that remembers whether the hop secret matched,
 * after stripping the header. Every client-IP reader consults the scope first, so the verdict
 * survives a rebuilt Request. Outside a scope (tests, background work) readers fall back to the
 * Request itself.
 */
export function runWithRouterHop<T>(request: Request, fn: () => T): T {
    const ok = acceptAndStripRouterHop(request);
    return scope.run({ authenticated: ok }, fn);
}

/** True once a request with a valid hop secret was served: the router really authenticates. */
export function routerHopSeen(): boolean {
    return hopSeen;
}

/**
 * What the chart says about the router's X-Forwarded-For source (LUMASTRA_ROUTER_REALIP_WIDE,
 * rendered only while the hop is on):
 * - `wide`    — the router adopts X-Forwarded-For from a range wider than /24 that any in-cluster
 *               pod may be in (and no NetworkPolicy limits who reaches the router),
 * - `narrow`  — it does not,
 * - `unknown` — not set (not the Helm chart, or an older chart).
 */
export function routerRealIpExposure(): 'wide' | 'narrow' | 'unknown' {
    const v = (process.env.LUMASTRA_ROUTER_REALIP_WIDE ?? '').trim().toLowerCase();
    if (v === 'true') return 'wide';
    if (v === 'false') return 'narrow';
    return 'unknown';
}
