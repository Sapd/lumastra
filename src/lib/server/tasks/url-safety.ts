// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// url-safety.ts — SSRF guard for outbound HTTP requests originating from
// user-controlled URLs (webhook outbox + admin test endpoint).
//
// safeFetch pins each hop to the pre-validated DNS address via an undici Agent
// to close the DNS-rebinding window between the safety check and the actual
// TCP connection.

// Import both Agent and fetch from the same undici version (npm undici@7).
// Using the global fetch with a npm-installed Agent causes a v6/v7 dispatcher
// contract mismatch (Node.js 22 bundles undici@6 internally) that throws at
// connection time. Importing from the same package guarantees compatibility.
import * as m from '$lib/paraglide/messages';
import { isPrivateIP } from '../../../shared/ip-classification.js';
import { Agent, fetch as undiciFetch } from 'undici';
import {
    countExternalCall,
    delegateExternalCallCounting,
} from '../utils/external-request-counter.js';
import { createPinnedLookup } from '../utils/pinned-lookup.js';
//
// Rejects:
//   - non-http(s) schemes (file://, gopher://, ftp:// …)
//   - private RFC1918 IPs (10/8, 172.16/12, 192.168/16)
//   - loopback / link-local (127/8, ::1, 169.254/16, fe80::/10)
//   - 0.0.0.0 + host names that resolve to those (DNS-resolved by safeFetch)
//   - IPv6 ULA (fc00::/7), IPv4-mapped IPv6 in both decimal (::ffff:10.0.0.1)
//     and hex-compressed (::ffff:0a00:1) forms, and the deprecated IPv4-
//     compatible form (::10.0.0.1 / hex-compressed ::7f00:1)
//   - CGNAT / Tailscale (100.64/10)
//   - benchmarking range (198.18/15)
//   - reserved (240/4)
//   - IETF protocol assignments (192.0.0/24)
//   - TEST-NET-1/2/3 (192.0.2/24, 198.51.100/24, 203.0.113/24)
//   - multicast (224/4)
//
// `assertPublicHttpUrl` is a syntactic gate kept on the hot path. The full
// DNS-resolving + redirect-manual delivery wrapper lives in `safeFetch`,
// which webhook-outbox and the webhook-test endpoint use to defeat
// DNS-rebinding and redirect-pivot attacks.

const PRIVATE_HOST_TOKENS = ['localhost', 'localhost.localdomain'];

// Webhooks also reject documentation-only destinations; the shared transport
// classifier intentionally permits those ranges for synthetic/public fixtures.
function isPrivateIPv4(host: string): boolean {
    return isPrivateIP(host) || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(host);
}

export class UrlSafetyError extends Error {
    readonly statusCode = 400;
    constructor(message: string) {
        super(message);
        this.name = 'UrlSafetyError';
    }
}

/**
 * Validate that `urlStr` is a syntactically safe outbound HTTP(S) URL.
 * Throws UrlSafetyError on rejection. Returns the parsed URL on success.
 */
export function assertPublicHttpUrl(urlStr: string): URL {
    let url: URL;
    try {
        url = new URL(urlStr);
    } catch {
        throw new UrlSafetyError(m.webhook_url_invalid());
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new UrlSafetyError(`only http(s) URLs allowed, got ${url.protocol}`);
    }

    // userinfo (https://user:pass@host) is a credential-leak vector — the
    // caller would send Authorization-like material to a downstream target
    // that may not be the intended one. Reject before host parsing.
    if (url.username || url.password) {
        throw new UrlSafetyError('URLs with embedded user info are not allowed');
    }

    const host = url.hostname.toLowerCase();
    if (!host) {
        throw new UrlSafetyError('URL must include a hostname');
    }

    if (PRIVATE_HOST_TOKENS.includes(host)) {
        throw new UrlSafetyError(`hostname ${host} is private`);
    }

    // .local mDNS scope is private by spec.
    if (host.endsWith('.local')) {
        throw new UrlSafetyError(`hostname ${host} is private (mDNS .local scope)`);
    }

    // IPv6 literals come wrapped in [..]; URL.hostname includes brackets in
    // some runtimes and not others. Normalise.
    const ipv6 = host.startsWith('[') ? host.slice(1, -1) : host;
    if (ipv6.includes(':')) {
        if (isPrivateIP(ipv6)) {
            throw new UrlSafetyError(`IPv6 host ${ipv6} is private/loopback`);
        }
        return url;
    }

    // IPv4 literal?
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        if (isPrivateIPv4(host)) {
            throw new UrlSafetyError(`IPv4 host ${host} is private/loopback`);
        }
        return url;
    }

    return url;
}

/**
 * Is `host` on an operator's private-target allowlist?
 *
 * Entries are exact hostnames / IP literals, or a leading-dot suffix
 * (`.svc.cluster.local` matches `x.arr.svc.cluster.local`, not the bare
 * `svc.cluster.local`). Matching is case-insensitive and ignores IPv6 brackets.
 * An empty list matches nothing, which is the default posture.
 *
 * Only ever pass the OPERATOR webhook allowlist here. The list is the operator
 * saying "this private host is mine"; a per-user webhook URL is chosen by the
 * user, and letting it ride the same exception would hand every user a probe
 * into the cluster network.
 */
export function isAllowlistedPrivateHost(host: string, allowlist: readonly string[]): boolean {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    for (const raw of allowlist) {
        const entry = raw
            .trim()
            .toLowerCase()
            .replace(/^\[|\]$/g, '');
        if (!entry) continue;
        if (entry.startsWith('.')) {
            if (entry.length > 1 && h.endsWith(entry)) return true;
        } else if (h === entry) {
            return true;
        }
    }
    return false;
}

/**
 * {@link assertPublicHttpUrl}, except a host on `allowlist` may be private.
 *
 * Scheme and userinfo rules still apply to an allowlisted host — the exception
 * is about WHERE the request goes, never about what kind of URL it is.
 */
export function assertWebhookTargetUrl(urlStr: string, allowlist: readonly string[]): URL {
    let url: URL;
    try {
        url = new URL(urlStr);
    } catch {
        throw new UrlSafetyError(m.webhook_url_invalid());
    }
    if (isAllowlistedPrivateHost(url.hostname, allowlist)) {
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new UrlSafetyError(`only http(s) URLs allowed, got ${url.protocol}`);
        }
        if (url.username || url.password) {
            throw new UrlSafetyError('URLs with embedded user info are not allowed');
        }
        return url;
    }
    try {
        return assertPublicHttpUrl(urlStr);
    } catch (error) {
        if (error instanceof UrlSafetyError && /private|loopback/.test(error.message)) {
            throw new UrlSafetyError(m.webhook_private_host_help());
        }
        throw error;
    }
}

/**
 * Resolve a hostname and reject if any answer is a private address. Closes
 * the DNS-rebinding hole left by the syntactic-only assertPublicHttpUrl.
 * The lookup is `all: true` so we examine every record, not just the first.
 *
 * Returns the resolved addresses so the caller can pin the connection to one
 * of them (preventing DNS rebinding between the check and the actual fetch).
 * Returns an empty array for IP-literal hosts (no DNS involved, already safe).
 */
async function assertResolvedAddrsArePublic(
    host: string,
): Promise<Array<{ address: string; family: number }>> {
    // IPv4/IPv6 literals have already been syntactically gated; skip lookup.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return [];
    const { promises: dns } = await import('node:dns');
    let answers: Array<{ address: string; family: number }>;
    try {
        answers = await dns.lookup(host, { all: true });
    } catch (err) {
        throw new UrlSafetyError(
            `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    for (const { address } of answers) {
        if (address.includes(':')) {
            if (isPrivateIP(address)) {
                throw new UrlSafetyError(`hostname ${host} resolves to private IPv6 ${address}`);
            }
        } else if (isPrivateIPv4(address)) {
            throw new UrlSafetyError(`hostname ${host} resolves to private IPv4 ${address}`);
        }
    }
    return answers;
}

/**
 * Order resolved addresses IPv4-first (stable within each family). safeFetch
 * tries them in this order so a host with a broken or absent IPv6 route — the
 * common case in Docker and self-hosted networks — connects over IPv4 instead
 * of failing on an unreachable AAAA record. IPv6-only hosts still work: with no
 * IPv4 answer the IPv6 addresses lead. Both families were already private-IP
 * validated by the caller, so reordering never weakens SSRF pinning.
 *
 * Exported for unit testing.
 */
export function orderAddressesIPv4First(
    addrs: Array<{ address: string; family: number }>,
): Array<{ address: string; family: number }> {
    // family 4 sorts before family 6; Array.sort is stable in V8, so the
    // resolver's round-robin order within each family is preserved.
    return [...addrs].sort((a, b) => a.family - b.family);
}

/**
 * Outbound fetch wrapper that defends against SSRF via DNS-rebinding and
 * redirect-pivot. Each hop is validated by assertPublicHttpUrl + DNS lookup
 * before issuing the network request. Redirects (3xx) are followed manually
 * up to `maxRedirects` hops, with re-validation at every hop. Other
 * fetch semantics — timeouts, AbortSignal, body, headers — are unchanged.
 *
 * `opts.validateHop`, when supplied, runs an additional caller-defined check
 * against EVERY hop (including the first) right after the SSRF guard. This is
 * the extension point for policy narrower than "any public host" — e.g. a
 * per-plugin domain allowlist (`context-primitives.ts`) or "redirects must
 * stay same-origin" (`webhook-outbox.ts`). Without it, only the generic SSRF
 * guard applies to redirect targets: a request that starts on an allowlisted
 * or registered host can otherwise be 3xx'd to ANY other public host and
 * safeFetch will follow it, defeating that narrower boundary. Throw to reject
 * the hop; the thrown error propagates out of safeFetch uncaught.
 */
/** Options for {@link safeFetch}. */
export interface SafeFetchOptions {
    maxRedirects?: number;
    validateHop?: (url: URL) => void;
    /**
     * Hosts the caller's operator explicitly allowed to be private (see
     * {@link isAllowlistedPrivateHost}). A hop to such a host skips the
     * private-address checks and DNS pinning; every other hop is guarded as
     * usual. Pair it with `validateHop` so a redirect cannot leave the
     * allowlisted host for another private one.
     */
    allowPrivateHosts?: readonly string[];
}

/**
 * Fetch with SSRF validation and one count per connection attempt / redirect
 * hop. A redirect whose next hop fails validation is an error on its sender;
 * rejecting the initial URL before any connection is not a sent request.
 */
export async function safeFetch(
    url: string,
    init: RequestInit = {},
    opts: SafeFetchOptions = {},
): Promise<Response> {
    delegateExternalCallCounting();
    const maxRedirects = opts.maxRedirects ?? 3;
    let currentUrl = url;
    let body = init.body;
    let method = init.method ?? 'GET';
    let redirectFrom: { url: string; status: number } | undefined;

    for (let hop = 0; hop <= maxRedirects; hop++) {
        let resolvedAddrs: Array<{ address: string; family: number }>;
        try {
            const allowlistedHop =
                !!opts.allowPrivateHosts &&
                URL.canParse(currentUrl) &&
                isAllowlistedPrivateHost(new URL(currentUrl).hostname, opts.allowPrivateHosts);
            const parsed = allowlistedHop
                ? assertWebhookTargetUrl(currentUrl, opts.allowPrivateHosts ?? [])
                : assertPublicHttpUrl(currentUrl);
            opts.validateHop?.(parsed);
            // An allowlisted host is private by definition, so there is nothing to
            // pin it AGAINST — resolving it would only re-reject it. The plain
            // fetch branch below (the IP-literal path) handles it.
            resolvedAddrs = allowlistedHop
                ? []
                : await assertResolvedAddrsArePublic(parsed.hostname);
        } catch (error) {
            if (redirectFrom !== undefined && !init.signal?.aborted)
                countExternalCall(redirectFrom.url, null, redirectFrom.status);
            throw error;
        }
        if (redirectFrom !== undefined) {
            countExternalCall(redirectFrom.url, redirectFrom.status);
        }

        // Pin the connection to the pre-validated address to close the
        // DNS-rebinding window between the safety check and the TCP connect.
        // Without pinning, an attacker's DNS server can resolve public during
        // assertResolvedAddrsArePublic and rebind to a private IP by the time
        // fetch() issues its own lookup milliseconds later.
        // resolvedAddrs is empty for IP-literal URLs — no rebinding risk there.
        let res: Response;
        if (resolvedAddrs.length > 0) {
            // Don't trust a SINGLE pinned address: a broken/absent IPv6 route
            // (very common in Docker and self-hosted networks) or one degraded
            // CDN edge node would otherwise fail the whole fetch even though
            // sibling addresses are healthy. Try each validated address in turn
            // — IPv4 first, since broken IPv6 egress is the common case — and
            // fall back to the next on a connection-level failure. Every address
            // was private-IP validated above, so SSRF pinning is preserved.
            const ordered = orderAddressesIPv4First(resolvedAddrs);
            // A non-replayable stream body can only be sent once, so we must not
            // retry it on a second address; strings / Buffers / undefined replay
            // fine. (`getReader` is the ReadableStream tell.)
            const bodyReplayable =
                body == null || typeof (body as { getReader?: unknown }).getReader !== 'function';
            let pinnedRes: Response | undefined;
            let lastErr: unknown;
            for (const { address, family } of ordered) {
                const agent = new Agent({
                    connect: {
                        // Pinned to the validated address; see pinned-lookup.ts for the
                        // undici@7+ all-semantics (scalar form broke every pinned fetch,
                        // first seen as the fribb-anime-sync circuit storm) and why the
                        // answer must be async.
                        lookup: createPinnedLookup({ address, family }),
                    },
                });
                try {
                    pinnedRes = (await undiciFetch(currentUrl, {
                        ...init,
                        method,
                        // null → undefined: undici BodyInit excludes null
                        body: (body ?? undefined) as Parameters<typeof undiciFetch>[1] extends {
                            body?: infer B;
                        }
                            ? B
                            : never,
                        redirect: 'manual',
                        dispatcher: agent,
                    })) as unknown as Response;
                    break; // got a response (any status) — stop trying addresses
                } catch (err) {
                    if (!init.signal?.aborted) countExternalCall(currentUrl, null);
                    lastErr = err;
                    // This attempt's agent failed and its pool is unused — close it
                    // so a multi-address retry can't leak undici connection pools.
                    // (The SUCCESS path deliberately leaves its agent open: the
                    // returned Response still streams its body through it.)
                    void agent.close().catch(() => {});
                    // Caller cancelled / deadline elapsed, or the body can't be
                    // replayed → don't burn the remaining addresses.
                    if (init.signal?.aborted || !bodyReplayable) break;
                    // otherwise fall through to the next validated address
                }
            }
            if (!pinnedRes) {
                // Surface an abort as-is (callers special-case AbortError);
                // otherwise wrap, noting how many addresses we exhausted.
                if (init.signal?.aborted && lastErr instanceof Error) throw lastErr;
                throw new UrlSafetyError(
                    `fetch failed for ${currentUrl} (tried ${ordered.length} address(es)): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
                );
            }
            res = pinnedRes;
        } else {
            try {
                res = await fetch(currentUrl, {
                    ...init,
                    method,
                    body,
                    redirect: 'manual',
                });
            } catch (error) {
                if (!init.signal?.aborted) countExternalCall(currentUrl, null);
                throw error;
            }
        }
        if (res.status < 300 || res.status >= 400) {
            countExternalCall(currentUrl, res.status);
            return res;
        }

        const location = res.headers.get('location');
        if (!location) {
            countExternalCall(currentUrl, res.status);
            return res;
        }
        await res.body?.cancel().catch(() => {});
        if (hop === maxRedirects) {
            countExternalCall(currentUrl, null, res.status);
            throw new UrlSafetyError(`redirect limit (${maxRedirects}) exceeded`);
        }
        // RFC 7231 §6.4: 301/302/303 may downgrade method to GET (and drop body).
        // 307/308 preserve method+body.
        redirectFrom = { url: currentUrl, status: res.status };
        try {
            currentUrl = new URL(location, currentUrl).toString();
        } catch (error) {
            countExternalCall(redirectFrom.url, null, redirectFrom.status);
            throw error;
        }
        if (res.status === 301 || res.status === 302 || res.status === 303) {
            if (method !== 'GET' && method !== 'HEAD') method = 'GET';
            body = undefined;
        }
    }
    // Unreachable — loop returns or throws.
    throw new UrlSafetyError('safeFetch: exhausted redirect chain');
}
