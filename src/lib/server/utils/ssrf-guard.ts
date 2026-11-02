// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { isPrivateIP } from '../../../shared/ip-classification.js';
import { createPinnedLookup } from './pinned-lookup.js';
import { OUTBOUND_ALLOW_H2, OUTBOUND_CONNECT_TIMEOUT_MS } from './outbound-agent-options.js';

export interface SafeUrl {
    /** The URL as given; `pinnedFetch` keeps its hostname for Host and SNI. */
    url: URL;
    /** Public IP address that DNS resolved to at assertion time. */
    resolvedIp: string;
}

interface CachedDns {
    addresses: LookupAddress[];
    expiresAt: number;
}

const DNS_CACHE_TTL_MS = 30_000;
const DNS_CACHE_MAX = 1_024;
const dnsCache = new Map<string, CachedDns>();

async function cachedDnsLookup(hostname: string): Promise<LookupAddress[]> {
    // WHATWG URL.hostname is already lowercased and IDN-encoded; the only
    // remaining normalization needed is the optional trailing dot so that
    // `example.com` and `example.com.` share a cache entry.
    const key = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

    const now = Date.now();
    const hit = dnsCache.get(key);
    if (hit && hit.expiresAt > now) {
        // Refresh LRU order
        dnsCache.delete(key);
        dnsCache.set(key, hit);
        return hit.addresses;
    }
    if (hit) dnsCache.delete(key);

    const addresses = await dns.lookup(hostname, { all: true });

    if (dnsCache.size >= DNS_CACHE_MAX) {
        const oldest = dnsCache.keys().next().value;
        if (oldest !== undefined) dnsCache.delete(oldest);
    }
    dnsCache.set(key, {
        addresses,
        expiresAt: now + DNS_CACHE_TTL_MS,
    });
    return addresses;
}

/** Test-only: clear the DNS cache. */
export function _resetSsrfDnsCacheForTests(): void {
    dnsCache.clear();
}

/**
 * Assert that a URL does not resolve to a private/internal IP address.
 *
 * Uses `dns.lookup` with `{ all: true }` to collect ALL DNS answers for the
 * hostname and rejects if ANY answer is a private address. This prevents
 * split-horizon DNS tricks where a multi-answer RRset hides a private address
 * behind a public one: the initial lookup might return the public address, but
 * the subsequent `fetch` could pick a different address from the same RRset.
 *
 * For TOCTOU (DNS-rebinding) protection use `resolveSafePublicUrl` +
 * `pinnedFetch` instead, which pins the connection to the resolved IP.
 */
/**
 * The URL resolved to a private/internal address: a refusal, not a transient
 * failure. DNS errors stay plain `Error`s so callers can tell the two apart.
 */
export class PrivateAddressError extends Error {
    constructor() {
        super('URL resolves to a private IP address');
        this.name = 'PrivateAddressError';
    }
}

export async function assertNotPrivateUrl(url: URL): Promise<void> {
    const hostname = url.hostname;
    const isLiteralIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');

    if (isLiteralIP) {
        if (isPrivateIP(hostname)) {
            throw new PrivateAddressError();
        }
        return;
    }

    const addresses = await cachedDnsLookup(hostname);

    if (addresses.length === 0) {
        throw new Error(`DNS resolution returned no addresses for ${hostname}`);
    }

    for (const { address } of addresses) {
        if (isPrivateIP(address)) {
            throw new PrivateAddressError();
        }
    }
}

/**
 * Like assertNotPrivateUrl, but returns the resolved IP so callers can pin the
 * connection to it with `pinnedFetch` and close the DNS-rebinding TOCTOU
 * window.
 *
 * Prefers IPv4 when the hostname resolves to multiple addresses: a broken or
 * absent IPv6 route is common in Docker and self-hosted networks.
 */
export async function resolveSafePublicUrl(
    url: URL,
    options?: {
        /**
         * Permit addresses that would otherwise be rejected as private. DNS is
         * still resolved and the caller still gets an IP to pin against, so
         * `pinnedFetch` keeps its anti-rebinding property — only the
         * private-range rejection is lifted.
         *
         * Defaults to false. Only pass true where an operator has explicitly
         * opted in (e.g. LIVETV_ALLOW_PRIVATE_URLS for a LAN IPTV provider);
         * never infer it from the URL itself.
         */
        allowPrivate?: boolean;
    },
): Promise<SafeUrl> {
    const allowPrivate = options?.allowPrivate ?? false;
    const hostname = url.hostname;

    // Strip IPv6 brackets that the URL parser adds (e.g. "[::1]" → "::1")
    const rawHostname =
        hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

    const isLiteralIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(rawHostname) || rawHostname.includes(':');

    if (isLiteralIP) {
        if (!allowPrivate && isPrivateIP(rawHostname)) {
            throw new PrivateAddressError();
        }
        return { url, resolvedIp: rawHostname };
    }

    // Resolve all addresses so we can reject if ANY is private (prevents
    // split-horizon DNS tricks), then pick an IPv4 address for pinning if
    // available, otherwise fall back to the first address.
    const addresses = await cachedDnsLookup(rawHostname);

    if (addresses.length === 0) {
        throw new Error(`DNS resolution returned no addresses for ${rawHostname}`);
    }

    if (!allowPrivate) {
        for (const { address } of addresses) {
            if (isPrivateIP(address)) {
                throw new PrivateAddressError();
            }
        }
    }

    const preferred = addresses.find((a) => a.family === 4) ?? addresses[0];

    return { url, resolvedIp: preferred.address };
}

/** `fetch` options for {@link pinnedFetch}: the WHATWG init plus an optional dispatcher. */
export type PinnedFetchInit = RequestInit & {
    /**
     * Route the request through this dispatcher (e.g. the LiveTV upstream
     * `ProxyAgent`) instead of a pinned direct connection. The proxy then makes
     * the target connection and resolves the hostname itself, so no local
     * pinning applies; the caller's `resolveSafePublicUrl` check still ran.
     */
    dispatcher?: Dispatcher;
};

/**
 * Fetch `safe.url`, connecting to `safe.resolvedIp` (DNS-rebinding TOCTOU fix).
 *
 * The pin sits in the transport: a per-request undici `Agent` whose
 * `connect.lookup` hands back the vetted address. The URL keeps its hostname,
 * so `Host` and TLS SNI/certificate checks see the real name and name-based
 * virtual hosts route correctly, for http and https alike. (Swapping the
 * hostname for the IP and sending `Host` as a header does not work: fetch()
 * drops a caller-set `Host`, and a vhost then answers for the bare IP.)
 *
 * Redirects are NOT followed for the caller: pass `redirect: 'manual'` and
 * re-check every hop with `resolveSafePublicUrl` before the next call.
 *
 * Credentials in the URL (`http://user:pass@host/`) are sent as a Basic
 * `Authorization` header, unless the caller set one; fetch() itself rejects a
 * URL that carries them. A redirect target only gets credentials if its own
 * URL carries them (a relative `Location` inherits them, an absolute one to
 * another host does not), since the caller issues every hop.
 *
 * The Agent uses the global dispatcher's connect timeout and h1-only setting,
 * and is closed once the response arrives. undici's close is graceful, so the
 * body still streams to the end, until it is cancelled or aborted, or until
 * undici cancels a body that was never read once its Response is collected.
 * Callers should still read or cancel every body.
 */
export async function pinnedFetch(safe: SafeUrl, init: PinnedFetchInit = {}): Promise<Response> {
    type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;
    const { url, init: effectiveInit } = moveUrlCredentialsToHeader(safe.url, init);
    if (effectiveInit.dispatcher) {
        return (await undiciFetch(url, effectiveInit as UndiciInit)) as unknown as Response;
    }
    const address = safe.resolvedIp;
    const family = address.includes(':') ? 6 : 4;
    const agent = new Agent({
        allowH2: OUTBOUND_ALLOW_H2,
        connect: {
            timeout: OUTBOUND_CONNECT_TIMEOUT_MS,
            // Pinned to the validated address; see pinned-lookup.ts for the undici@7+
            // all-semantics and why the answer must be async.
            lookup: createPinnedLookup({ address, family }),
        },
    });
    try {
        const res = await undiciFetch(url, { ...effectiveInit, dispatcher: agent } as UndiciInit);
        void agent.close().catch(() => {});
        return res as unknown as Response;
    } catch (err) {
        void agent.destroy().catch(() => {});
        throw err;
    }
}

/**
 * Strip `user:pass@` from the URL and send it as Basic auth instead. fetch()
 * throws on a URL with credentials, so without this an IPTV or radio URL of
 * that shape could never be fetched. A caller-set Authorization header wins.
 */
function moveUrlCredentialsToHeader(
    url: URL,
    init: PinnedFetchInit,
): { url: URL; init: PinnedFetchInit } {
    if (!url.username && !url.password) return { url, init };
    const bare = new URL(url);
    bare.username = '';
    bare.password = '';
    const headers = new Headers(init.headers);
    if (!headers.has('authorization')) {
        const userinfo = `${decodeUserinfo(url.username)}:${decodeUserinfo(url.password)}`;
        headers.set('authorization', `Basic ${Buffer.from(userinfo, 'utf8').toString('base64')}`);
    }
    return { url: bare, init: { ...init, headers } };
}

/** Percent-decode a URL username/password; a malformed escape stays as written. */
function decodeUserinfo(part: string): string {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}
