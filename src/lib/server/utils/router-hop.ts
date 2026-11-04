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
 * container. Only the ENV master key counts: a key generated into /config/master.key cannot be
 * read by the router, so the hop stays off (client address = TCP peer, the strict default).
 *
 * This grants no identity trust: forward-auth identity headers are decided by TRUSTED_PROXY_IPS
 * alone (client-ip.ts isForwardAuthPeerTrusted).
 */

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

/** True once a request with a valid hop secret was served: the router really authenticates. */
export function routerHopSeen(): boolean {
    return hopSeen;
}
