// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client IP Extraction Utility
 *
 * Returns the client IP for use in rate limiting, IP allowlists, and audit
 * fields like `last_used_ip`. Defaults to the TCP peer (via SvelteKit's
 * `getClientAddress()`), which is unspoofable.
 *
 * To honor `X-Forwarded-For` (necessary when running behind a reverse proxy
 * like Authentik / nginx / Caddy), use ONE of:
 *
 *   1. SvelteKit's adapter-node env vars (preferred FOR CLIENT IP ONLY):
 *        ADDRESS_HEADER=x-forwarded-for
 *        XFF_DEPTH=1   # number of trusted proxies in the chain
 *      With these set, `event.getClientAddress()` already returns the real
 *      client IP and this util is a no-op pass-through.
 *
 *      Forward-auth identity trust separately reads the actual socket peer
 *      from adapter-node's platform.req, never this forwarded client address.
 *      ADDRESS_HEADER still requires an edge that sanitizes its address header
 *      and is the sole ingress for accurate client-IP/rate-limit reporting.
 *
 *   2. TRUSTED_PROXY_IPS env var (in-app fallback):
 *        TRUSTED_PROXY_IPS=10.0.0.5,10.0.0.6
 *      Comma-separated list of exact IPs and/or IPv4 CIDR ranges. List proxies,
 *      never a LAN: every listed address may set the client IP and, with
 *      FORWARD_AUTH_ENABLED, the identity headers (trusted-proxy-ranges.ts warns
 *      on ranges wider than /24). When the
 *      TCP peer matches any entry, the util honors the rightmost
 *      `X-Forwarded-For` entry that is not itself a listed proxy (or
 *      `X-Real-IP` when there is no XFF), so a client-supplied XFF that an
 *      appending proxy passes through is skipped. Untrusted peers always get
 *      the TCP peer back, so an attacker can't spoof `X-Forwarded-For` from
 *      outside the proxy fleet. IPv6 CIDR is not supported — list IPv6
 *      proxies as exact addresses.
 *
 *   3. CLIENT_IP_PROXY_IPS env var (client IP ONLY, UNAUTHENTICATED):
 *        CLIENT_IP_PROXY_IPS=203.0.113.7
 *      Same list format and X-Forwarded-For / X-Real-IP / protocol handling as
 *      TRUSTED_PROXY_IPS, but the listed peers are NEVER trusted for forward-auth
 *      identity headers and do not change the forward-auth trust posture. A peer
 *      address proves nothing on a pod network, so keep the list narrow: the
 *      self-check warns about ranges wider than /24.
 *
 *   4. Router hop secret (Helm chart, utils/router-hop.ts): a request that carries
 *      the matching X-Lumastra-Router-Hop value is honored for the client IP
 *      whatever its peer address. No configuration beyond LUMASTRA_MASTER_KEY.
 *
 * Default trust when TRUSTED_PROXY_IPS is unset
 * ---------------------------------------------
 * Lumastra is designed to run behind a reverse proxy (Authentik / Caddy /
 * nginx). When TRUSTED_PROXY_IPS is empty, the immediate TCP peer is assumed
 * to be that proxy, so `X-Forwarded-For` / `X-Real-IP` is honored. Without
 * this, every client collapses to the proxy's single IP and IP-bound features
 * (stream-token binding, rate limits, allowlists) become useless — see F32.
 * A startup warning (`warnIfProxyTrustImplicit`) nudges operators to pin the
 * proxy IPs explicitly in production.
 *
 * SECURITY (F1): the *implicit* trust above governs only the low-stakes client
 * IP. Identity-bearing forward-auth headers (USERHEADER / GROUPHEADER) are
 * gated separately via `isForwardAuthPeerTrusted`, which fail-closes against
 * peers outside an explicitly configured TRUSTED_PROXY_IPS allowlist.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { Logger } from './logger';
import { isRouterHopAuthenticated, routerHopSeen } from './router-hop';
import { findWideTrustedProxyRanges } from './trusted-proxy-ranges';

const clientIpLogger = Logger.for('ClientIp');

function normalizeIp(ip: string): string {
    // Strip the IPv6-mapped IPv4 prefix so `10.0.0.5` matches `::ffff:10.0.0.5`.
    // Case-insensitive — RFC 4291 allows mixed case for the prefix.
    if (/^::ffff:/i.test(ip)) return ip.slice(7);
    return ip;
}

// Trusted-proxy entries: each is either an exact IP or an IPv4 CIDR like 10.0.0.0/24.
// IPv6 CIDR is not supported — list IPv6 proxies as exact addresses.
interface TrustedProxyMatcher {
    exact: Set<string>;
    cidr: Array<{ networkInt: number; mask: number }>;
}

function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
        const b = Number(part);
        if (!Number.isInteger(b) || b < 0 || b > 255) return null;
        n = (n << 8) | b;
    }
    // Force unsigned 32-bit
    return n >>> 0;
}

function buildTrustedProxyMatcher(raw: string): TrustedProxyMatcher {
    const exact = new Set<string>();
    const cidr: Array<{ networkInt: number; mask: number }> = [];
    for (const entry of raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const slash = entry.indexOf('/');
        if (slash === -1) {
            exact.add(normalizeIp(entry));
            continue;
        }
        const network = entry.slice(0, slash);
        const bits = Number(entry.slice(slash + 1));
        const networkInt = ipv4ToInt(network);
        if (networkInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
            // Malformed CIDR — fall back to treating the whole entry as an
            // exact match so the operator at least sees their string echoed.
            exact.add(normalizeIp(entry));
            continue;
        }
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        cidr.push({ networkInt: (networkInt & mask) >>> 0, mask });
    }
    return { exact, cidr };
}

const TRUSTED_PROXIES: TrustedProxyMatcher = buildTrustedProxyMatcher(
    process.env.TRUSTED_PROXY_IPS ?? '',
);

// Peers trusted for the forwarded CLIENT IP / protocol only. Deliberately NOT part of
// TRUSTED_PROXIES: every identity decision (isForwardAuthPeerTrusted,
// isConfiguredTrustedProxy, forwardAuthTrustPosture) reads TRUSTED_PROXIES alone.
const CLIENT_IP_PROXIES: TrustedProxyMatcher = buildTrustedProxyMatcher(
    process.env.CLIENT_IP_PROXY_IPS ?? '',
);

// Explicit opt-in to trust forward-auth IDENTITY headers from ANY TCP peer when
// no TRUSTED_PROXY_IPS allowlist is configured. Without this, identity headers
// fail CLOSED when unpinned (see isForwardAuthPeerTrusted) — the secure default
// for OSS. Set to true ONLY when the app is not directly reachable (single host
// / private network behind a proxy whose IP you can't easily pin).
const TRUST_ANY_PROXY =
    (process.env.LUMASTRA_TRUST_ANY_PROXY ?? '').trim().toLowerCase() === 'true';

function matcherHas(matcher: TrustedProxyMatcher, peer: string): boolean {
    const normalized = normalizeIp(peer);
    if (matcher.exact.has(normalized)) return true;
    if (matcher.cidr.length === 0) return false;
    const peerInt = ipv4ToInt(normalized);
    if (peerInt === null) return false;
    for (const { networkInt, mask } of matcher.cidr) {
        if ((peerInt & mask) >>> 0 === networkInt) return true;
    }
    return false;
}

function matcherIsEmpty(matcher: TrustedProxyMatcher): boolean {
    return matcher.exact.size === 0 && matcher.cidr.length === 0;
}

/** TRUSTED_PROXY_IPS only: the identity-header (forward-auth) trust list. */
function isTrustedProxy(peer: string): boolean {
    return matcherHas(TRUSTED_PROXIES, peer);
}

function hasAnyTrustedProxies(): boolean {
    return !matcherIsEmpty(TRUSTED_PROXIES);
}

/** TRUSTED_PROXY_IPS or CLIENT_IP_PROXY_IPS: who may supply the forwarded client IP. */
function isClientIpProxy(peer: string): boolean {
    return matcherHas(TRUSTED_PROXIES, peer) || matcherHas(CLIENT_IP_PROXIES, peer);
}

function hasAnyClientIpProxies(): boolean {
    return hasAnyTrustedProxies() || !matcherIsEmpty(CLIENT_IP_PROXIES);
}

/**
 * Whether the strict resolver can read a distinct client address per request without trusting an
 * unauthenticated wide range: a router hop request was seen (authenticated), or CLIENT_IP_PROXY_IPS
 * lists only narrow entries (no range wider than /24). Not an identity statement: use
 * `forwardAuthTrustPosture` for that.
 */
export function clientIpProxiesPinned(): boolean {
    if (routerHopSeen()) return true;
    if (matcherIsEmpty(CLIENT_IP_PROXIES)) return false;
    return !findWideTrustedProxyRanges(process.env.CLIENT_IP_PROXY_IPS);
}

function readForwardedClientIp(headers: Headers): string | null {
    const xff = headers.get('x-forwarded-for');
    if (xff) {
        const entries = xff
            .split(',')
            .map((e) => e.trim())
            .filter(Boolean);
        if (entries.length > 0) {
            // Implicit trust (no allowlist) keeps the leftmost entry: it only feeds
            // the low-stakes client IP, and strict callers ignore XFF in that mode.
            if (!hasAnyClientIpProxies()) return entries[0];
            // A proxy that appends (nginx's $proxy_add_x_forwarded_for) passes a
            // client-supplied X-Forwarded-For through, so only the entries the
            // trusted proxies added are believable: the client is the rightmost
            // entry that is not itself a trusted proxy.
            // Every hop must be listed: an unlisted outer proxy or CDN is returned
            // as the client. When every entry is a listed proxy, keep the one the
            // verified peer appended, never the client-controlled leftmost one.
            for (let i = entries.length - 1; i >= 0; i--) {
                if (!isClientIpProxy(entries[i])) return entries[i];
            }
            return entries[entries.length - 1];
        }
    }
    const xRealIp = headers.get('x-real-ip')?.trim();
    if (xRealIp) return xRealIp;
    return null;
}

function safeGetPeer(getClientAddress: () => string): string {
    try {
        return getClientAddress();
    } catch {
        // best-effort: unknowable peer → sentinel that won't match TRUSTED_PROXY_IPS (no implicit trust).
        return '0.0.0.0';
    }
}

/**
 * Whether the given TCP peer should be trusted to supply forwarded client-IP
 * headers (`X-Forwarded-For` / `X-Real-IP`).
 *
 * When `TRUSTED_PROXY_IPS` is configured, only listed peers are trusted. When
 * it is empty, the immediate peer is implicitly trusted as the reverse proxy —
 * otherwise IP-bound features collapse every client to the proxy's single IP
 * (F32). This implicit trust applies ONLY to the low-stakes client IP, never
 * to identity headers (see `isForwardAuthPeerTrusted`).
 */
function shouldHonorForwardedFor(peer: string, request?: Pick<Request, 'headers'>): boolean {
    if (isRouterHopAuthenticated(request)) return true;
    if (!hasAnyClientIpProxies()) return true;
    return isClientIpProxy(peer);
}

/**
 * Whether a request arrived through a proxy that annotated it with a forwarded
 * client address (`X-Forwarded-For` / `X-Real-IP`).
 *
 * Distinct from `getClientIp`: this asks only whether the annotation EXISTS,
 * never whether it may be trusted. A present header means the TCP peer is a
 * proxy rather than the original caller, so a private peer address says nothing
 * about where the caller actually is.
 */
export function hasForwardedClientIpHeader(headers: Headers): boolean {
    return readForwardedClientIp(headers) !== null;
}

/**
 * Loopback / RFC1918 / link-local IPv4 ranges — the addresses a caller has when
 * they sit on the same host or LAN as the container.
 */
const OPERATOR_PROXIMATE_V4 = buildTrustedProxyMatcher(
    '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16',
);

/**
 * Whether an address belongs to this machine or its local network: IPv4
 * loopback / RFC1918 / link-local, or IPv6 loopback (`::1`), unique-local
 * (`fc00::/7`) and link-local (`fe80::/10`).
 *
 * Used to decide whether a caller is plausibly the OPERATOR — someone who just
 * started the container and is curling it from the host or the LAN — and may
 * therefore be shown verbose setup diagnostics. Everything else, including the
 * `0.0.0.0` sentinel `safeGetPeer` returns for an unknowable peer, counts as
 * public, so the gate fails closed.
 *
 * ⚠️ NOT an authorization check. Being on the LAN grants no access whatsoever;
 * this only chooses how much configuration detail an error message spells out.
 * Pair it with `hasForwardedClientIpHeader` before drawing any conclusion from
 * a private result — behind a reverse proxy the peer is always the proxy, which
 * is itself usually private.
 */
export function isPrivateClientIp(ip: string): boolean {
    const normalized = normalizeIp((ip ?? '').trim()).toLowerCase();
    if (!normalized) return false;
    if (normalized === '::1') return true;
    if (normalized.includes(':')) {
        // fc00::/7 — unique-local, first byte 0xfc or 0xfd.
        if (/^f[cd][0-9a-f]{0,2}:/.test(normalized)) return true;
        // fe80::/10 — link-local, first group fe80 through febf.
        if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
        return false;
    }
    const asInt = ipv4ToInt(normalized);
    if (asInt === null) return false;
    for (const { networkInt, mask } of OPERATOR_PROXIMATE_V4.cidr) {
        if ((asInt & mask) >>> 0 === networkInt) return true;
    }
    return false;
}

/**
 * Whether identity-bearing forward-auth headers (USERHEADER / GROUPHEADER)
 * from the given TCP peer should be trusted (F1).
 *
 * - When `TRUSTED_PROXY_IPS` is explicitly set, only listed peers are trusted;
 *   headers from any other peer (e.g. an attacker who reached the app directly)
 *   are rejected — fail-closed.
 * - When unset, fails CLOSED (returns `false`) by default: identity headers are
 *   high-stakes — a forged `X-Forwarded-Groups: admin` from a directly-reachable
 *   container would otherwise grant instant admin. Operators on a single host
 *   with no proxy IP to pin can opt back in with `LUMASTRA_TRUST_ANY_PROXY=true`.
 *   (This differs from `shouldHonorForwardedFor`, which keeps implicit trust for
 *   the LOW-stakes client IP so per-client features don't collapse to one IP.)
 *
 * Pass the raw TCP peer from `getTcpPeer(event)` — never an
 * already-forwarded client IP, which would defeat the check.
 */
export function isForwardAuthPeerTrusted(peer: string): boolean {
    if (!peer) return false;
    if (hasAnyTrustedProxies()) return isTrustedProxy(peer);
    return TRUST_ANY_PROXY;
}

/**
 * Whether the given TCP peer is an EXPLICITLY configured trusted proxy —
 * allowlist-only, unlike {@link isForwardAuthPeerTrusted}, which also returns
 * `true` for every peer when `LUMASTRA_TRUST_ANY_PROXY` is set and no
 * allowlist exists. Use this where a `true` result is meant to say "this is a
 * known reverse proxy, not the operator sitting on the LAN" — reusing
 * `isForwardAuthPeerTrusted` there would call every peer a proxy under
 * `LUMASTRA_TRUST_ANY_PROXY=true`, including a genuine `curl localhost`
 * operator, and silently withhold their setup guidance.
 */
export function isConfiguredTrustedProxy(peer: string): boolean {
    // isTrustedProxy() already normalizes internally (same as
    // isForwardAuthPeerTrusted's `isTrustedProxy(peer)` call below) — no need
    // to normalize twice.
    return hasAnyTrustedProxies() && isTrustedProxy(peer);
}

/**
 * The current forward-auth trust posture, for diagnostics (config doctor, the
 * "auth not configured" page):
 * - `allowlist`   — TRUSTED_PROXY_IPS is set; only those peers may set identity headers.
 * - `trust-any`   — no allowlist, LUMASTRA_TRUST_ANY_PROXY=true (identity headers trusted from any peer).
 * - `fail-closed` — no allowlist, no opt-in: identity headers are REJECTED, so no one can authenticate.
 */
export function forwardAuthTrustPosture(): 'allowlist' | 'trust-any' | 'fail-closed' {
    if (hasAnyTrustedProxies()) return 'allowlist';
    return TRUST_ANY_PROXY ? 'trust-any' : 'fail-closed';
}

let implicitTrustWarned = false;

/**
 * Emit a one-shot production warning when the app is honoring `X-Forwarded-For`
 * by implicit trust (TRUSTED_PROXY_IPS unset) rather than an explicit allowlist.
 * Pin the proxy IPs to make IP-bound security decisions enforceable (F1/F32).
 */
export function warnIfProxyTrustImplicit(): void {
    if (implicitTrustWarned) return;
    implicitTrustWarned = true;
    if (process.env.NODE_ENV !== 'production') return;
    // adapter-node's address override affects client-IP consumers. Identity
    // trust separately uses getTcpPeer(), but accurate client IPs still require
    // a sanitizing proxy as the sole ingress.
    const addressHeader = (process.env.ADDRESS_HEADER ?? '').trim().toLowerCase();
    if (addressHeader) {
        clientIpLogger.warn(
            `ADDRESS_HEADER=${addressHeader}: getClientAddress() resolves from a request header. ` +
                'For accurate client-IP rate limits and IP-bound checks, ensure your edge ' +
                'strips inbound address headers and is the sole ingress. Forward-auth ' +
                'identity trust uses the actual TCP socket peer.',
        );
    }
    if (hasAnyTrustedProxies()) return;
    if (TRUST_ANY_PROXY) {
        clientIpLogger.warn(
            'LUMASTRA_TRUST_ANY_PROXY=true: forward-auth identity headers ' +
                '(USERHEADER/GROUPHEADER) are trusted from ANY TCP peer. This is ' +
                'safe ONLY when the app is not directly reachable (single host / ' +
                'private network behind a proxy). For production, pin your ' +
                'reverse-proxy IP(s) via TRUSTED_PROXY_IPS instead.',
        );
        return;
    }
    // Fail-closed: reverse-proxy identity headers are rejected until trust is
    // configured. This ONLY affects forward-auth (proxy-header) login — OIDC
    // and built-in login are unaffected, so this is NOT necessarily a lockout.
    // Log at WARN and phrase it as forward-auth-specific; the authoritative
    // "no auth method is configured at all" hard error lives in the startup
    // config preflight (config-doctor), which already accounts for OIDC /
    // native login. (Avoids the old false "NO ONE can authenticate" alarm on
    // OIDC/native deployments — see F1/F32.)
    clientIpLogger.warn(
        'Forward-auth (reverse-proxy identity headers) is disabled: TRUSTED_PROXY_IPS ' +
            'is unset and LUMASTRA_TRUST_ANY_PROXY is off, so USERHEADER/GROUPHEADER are ' +
            'rejected as potential forgeries. If you sign in via OIDC or built-in login, ' +
            'no action is needed. If you rely on a forward-auth proxy, set TRUSTED_PROXY_IPS ' +
            'to your proxy IP(s) (or LUMASTRA_TRUST_ANY_PROXY=true for a single-host/private ' +
            'deployment). See https://lumastra.org/guides/authentication/.',
    );
}

/**
 * Whether forwarded request annotations from this TCP peer (the client IP, and
 * the protocol in `X-Forwarded-Proto` / `Forwarded`) may be believed. Same rule
 * as the client IP: only listed peers when `TRUSTED_PROXY_IPS` is set,
 * otherwise the immediate peer is assumed to be the reverse proxy. Never use
 * this for identity headers; that is `isForwardAuthPeerTrusted`.
 */
export function isForwardedHeaderPeerTrusted(
    getClientAddress: () => string,
    request?: Pick<Request, 'headers'>,
): boolean {
    return shouldHonorForwardedFor(safeGetPeer(getClientAddress), request);
}

/**
 * Extract the client IP address from a request event.
 */
export function getClientIp(event: RequestEvent): string {
    const peer = safeGetPeer(() => event.getClientAddress());
    if (!shouldHonorForwardedFor(peer, event.request)) return peer;
    return readForwardedClientIp(event.request.headers) ?? peer;
}

/**
 * Extract the client IP address from a raw Request + getClientAddress function.
 *
 * Used in contexts where a full RequestEvent is not available (e.g., inside
 * withValidation callbacks that destructure individual event properties).
 */
export function getClientIpFromRequest(request: Request, getClientAddress: () => string): string {
    const peer = safeGetPeer(getClientAddress);
    if (!shouldHonorForwardedFor(peer, request)) return peer;
    return readForwardedClientIp(request.headers) ?? peer;
}

/**
 * Strict client IP for security-sensitive rate-limit buckets (e.g. showcase HLS).
 *
 * Behaviour differs from `getClientIp` in the default (no TRUSTED_PROXY_IPS)
 * case:
 *
 *   - When `TRUSTED_PROXY_IPS` IS configured: same as `getClientIp` — the XFF
 *     header is honored only from explicitly listed proxy peers, so the bucket
 *     is non-spoofable regardless.
 *
 *   - When `TRUSTED_PROXY_IPS` is NOT configured: falls back to the raw TCP peer
 *     instead of trusting XFF.  This is *stricter* than `getClientIp`, which
 *     honors XFF by implicit proxy trust in the unconfigured case.  Using the
 *     TCP peer when no allowlist is configured means a client-supplied XFF
 *     header cannot forge a different bucket; all traffic from the same proxy
 *     lands in the same bucket (coarse, but unforgeable).
 *
 * DEPLOY NOTE (showcase): for accurate per-client rate limiting in production,
 * set `TRUSTED_PROXY_IPS` to your reverse-proxy IP(s) (or CIDR range).  Without
 * it, all requests through the same proxy share one bucket — this prevents
 * spoofing but may throttle legitimate users behind NAT.  The adapter-node env
 * vars `ADDRESS_HEADER=x-forwarded-for` + `XFF_DEPTH=1` also resolve the IP
 * before this util runs (preferred approach).
 */
export function getClientIpStrict(
    event: Pick<RequestEvent, 'request' | 'getClientAddress'>,
): string {
    const peer = safeGetPeer(() => event.getClientAddress());
    // Only honor forwarded headers from the router hop (secret) or when a proxy list
    // (TRUSTED_PROXY_IPS or CLIENT_IP_PROXY_IPS) is explicitly configured.
    if (!isRouterHopAuthenticated(event.request)) {
        if (!hasAnyClientIpProxies()) return peer;
        if (!isClientIpProxy(peer)) return peer;
    }
    return readForwardedClientIp(event.request.headers) ?? peer;
}

/**
 * Strict client IP from a raw Request + getClientAddress function — the
 * `getClientIpStrict` counterpart to `getClientIpFromRequest`, for contexts
 * where a full `RequestEvent` is not available (e.g. `withValidation`
 * callbacks that destructure individual event properties, or a stream-token
 * mint/refresh def that only has `request` + `getClientAddress` in scope).
 *
 * Used anywhere a value is stored and later compared against a future
 * `getClientIpStrict(event)` read (stream-token mint/refresh binding — see
 * `getClientIpStrict`'s doc comment for why the strict/implicit-trust
 * distinction matters there): mint, refresh and validate must all resolve the
 * IP the same way, or a legitimate client can mint under one value and fail
 * validation under another, and an attacker can pin a spoofed
 * `X-Forwarded-For` at mint time that validation would never reproduce.
 */
export function getClientIpStrictFromRequest(
    request: Request,
    getClientAddress: () => string,
): string {
    const peer = safeGetPeer(getClientAddress);
    if (!isRouterHopAuthenticated(request)) {
        if (!hasAnyClientIpProxies()) return peer;
        if (!isClientIpProxy(peer)) return peer;
    }
    return readForwardedClientIp(request.headers) ?? peer;
}
