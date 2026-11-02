// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Self-Check — Edge Probes (Tier 2 + Tier 3 edge checks).
 *
 * All probes fire GET-only requests through the configured public base URL
 * (the real edge). They are time-bounded; unreachable / timeout → 'skipped',
 * never 'fail'. Feature-off surfaces → 'skipped'. No secret values appear in
 * any finding output.
 *
 * The headline probe (`edge.fwd-auth-stripped`) mints an ephemeral token via
 * `opts.mintToken()` and hits the reflection endpoint; `opts.mintToken().revoke()`
 * is always called in a finally block.
 */

import type { SecuritySelfCheckFinding } from '$lib/schemas/security-self-check';
import { config, features } from '$lib/server/config';
import { finding } from './finding';

// ── Constants ────────────────────────────────────────────────────────────────

/** Default per-request timeout for all edge probes (ms). */
const PROBE_TIMEOUT_MS = 8_000;

/** Reflection endpoint path (token-auth, returns forward-auth header names). */
const DIAG_PATH = '/api/v1/_diag/forward-auth-headers';

// ── Public types ─────────────────────────────────────────────────────────────

/** Injected dependencies for runEdgeProbes. I/O-agnostic. */
export interface EdgeProbeOpts {
    /** Public base URL of the edge (e.g. https://example.com). Null → all probes skipped. */
    baseUrl: string | null;
    /**
     * Mint a short-lived ephemeral token for authenticated probes.
     * The returned `revoke()` closure MUST be called in a finally block.
     */
    mintToken: () => Promise<{ token: string; revoke: () => Promise<void> }>;
}

// ── Pure verdict helpers ─────────────────────────────────────────────────────

/**
 * Evaluate the forward-auth header reflection result.
 *
 * PASS (edge stripped): received is empty — no forward-auth header names arrived.
 * FAIL (edge forwarded): at least one forward-auth header name is present in received.
 *
 * This is a pure function (no I/O) to allow deterministic unit tests.
 */
export function evaluateForwardAuthReflection(receivedHeaderNames: string[]): {
    status: 'pass' | 'fail';
    detail: string;
} {
    if (receivedHeaderNames.length === 0) {
        return {
            status: 'pass',
            detail: 'Edge stripped all forward-auth headers before they reached the app (received: []).',
        };
    }
    const listed = receivedHeaderNames.map((h) => `"${h}"`).join(', ');
    return {
        status: 'fail',
        detail: `Edge forwarded ${receivedHeaderNames.length} forward-auth header(s) to the app: ${listed}. A forged identity header passed through the edge unstripped.`,
    };
}

// ── Shared fetch helper ───────────────────────────────────────────────────────

interface ProbeResult {
    /** HTTP status code, or null on network failure / timeout. */
    status: number | null;
    ok: boolean;
    /** Parsed JSON body, or null on error. */
    body: unknown;
    /** Headers of the response. */
    headers: Map<string, string>;
    /** All Set-Cookie header lines (undici special-cases these; never collapsed). */
    setCookies: string[];
    /** Whether the probe timed out or the host was unreachable. */
    unreachable: boolean;
    /** Human-readable reason for unreachability. */
    unreachableReason: string;
}

async function probeGet(
    url: string,
    init?: RequestInit,
    timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // C22 fix-plan finding scope: this probes the operator's OWN public
        // edge/reverse-proxy configuration for the self-check diagnostic
        // (not a third-party admin-configured integration) and already
        // refuses to auto-follow a redirect (`redirect:'manual'` — a probe
        // that silently followed one would misreport the edge as correctly
        // configured). See docs/dev/eslint-exceptions.md.
        // eslint-disable-next-line callback-safety/no-bare-fetch-in-server
        const res = await fetch(url, {
            ...init,
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual',
        });
        let body: unknown = null;
        try {
            body = await res.json();
        } catch {
            // Non-JSON body — leave as null.
        }
        const headers = new Map<string, string>();
        res.headers.forEach((value, key) => {
            headers.set(key.toLowerCase(), value);
        });
        // getSetCookie() preserves every Set-Cookie line; Map/.get() collapses them.
        const setCookies =
            typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        return {
            status: res.status,
            ok: res.ok,
            body,
            headers,
            setCookies,
            unreachable: false,
            unreachableReason: '',
        };
    } catch (err) {
        const isAbort =
            err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
        const reason = isAbort
            ? `Request timed out after ${timeoutMs}ms`
            : `Network error: ${err instanceof Error ? err.message : String(err)}`;
        return {
            status: null,
            ok: false,
            body: null,
            headers: new Map(),
            setCookies: [],
            unreachable: true,
            unreachableReason: reason,
        };
    } finally {
        clearTimeout(timer);
    }
}

// ── Individual probe implementations ─────────────────────────────────────────

/**
 * Probe: edge.fwd-auth-stripped
 * Mints a token, sends a request to the reflection endpoint with a forged
 * x-authentik-username header, checks whether the edge stripped it.
 */
async function probeForwardAuthStripped(
    baseUrl: string,
    mintToken: EdgeProbeOpts['mintToken'],
): Promise<SecuritySelfCheckFinding> {
    let tokenHandle: { token: string; revoke: () => Promise<void> };
    try {
        tokenHandle = await mintToken();
    } catch (err) {
        return finding({
            id: 'edge.fwd-auth-stripped',
            method: 'forward-auth',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Forward-auth header strip: skipped (token mint failed)',
            detail: `Could not mint ephemeral token: ${err instanceof Error ? err.message : String(err)}`,
        });
    }

    const { token, revoke } = tokenHandle;
    try {
        // Guard against a minted-but-empty token: an empty Bearer would produce
        // a 401 we'd misread as a generic "auth rejected" skip. Be explicit.
        if (!token) {
            return finding({
                id: 'edge.fwd-auth-stripped',
                method: 'forward-auth',
                type: 'edge-probe',
                status: 'skipped',
                title: 'Forward-auth header strip: skipped (empty token minted)',
                detail: 'mintToken() resolved but returned an empty token; the probe could not authenticate.',
            });
        }

        const result = await probeGet(`${baseUrl}${DIAG_PATH}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                'x-authentik-username': 'admin',
            },
        });

        if (result.unreachable) {
            return finding({
                id: 'edge.fwd-auth-stripped',
                method: 'forward-auth',
                type: 'edge-probe',
                status: 'skipped',
                title: 'Forward-auth header strip: skipped (edge unreachable)',
                detail: result.unreachableReason,
                remediation:
                    'Ensure PUBLIC_BASE_URL (or DEVICE_VERIFICATION_BASE_URL) is set correctly and reachable.',
            });
        }

        if (result.status === 401 || result.status === 403) {
            return finding({
                id: 'edge.fwd-auth-stripped',
                method: 'forward-auth',
                type: 'edge-probe',
                status: 'skipped',
                title: 'Forward-auth header strip: skipped (auth rejected)',
                detail: `Ephemeral token was rejected with HTTP ${result.status}. The token may have expired before the request arrived.`,
            });
        }

        if (result.status !== 200) {
            return finding({
                id: 'edge.fwd-auth-stripped',
                method: 'forward-auth',
                type: 'edge-probe',
                status: 'skipped',
                title: 'Forward-auth header strip: skipped (unexpected HTTP status)',
                detail: `Reflection endpoint returned HTTP ${result.status ?? 'unknown'}.`,
            });
        }

        // Guard against a malformed HTTP 200 (non-JSON body, or a missing /
        // non-array `received`). Coercing such a body to [] would yield a
        // FALSE PASS on the headline security probe — silently hiding an edge
        // that forwards forged headers. Degrade to `skipped`, never `pass`.
        const body = result.body;
        if (!isRecord(body) || !Array.isArray(body.received)) {
            return finding({
                id: 'edge.fwd-auth-stripped',
                method: 'forward-auth',
                type: 'edge-probe',
                status: 'skipped',
                title: 'Forward-auth header strip: skipped (malformed reflection response)',
                detail:
                    'The reflection endpoint returned HTTP 200 but the body was not the expected ' +
                    '{ received: string[] } shape. Cannot determine whether the edge stripped forward-auth headers.',
            });
        }

        const received = parseStringArray(body.received);
        const verdict = evaluateForwardAuthReflection(received);

        return finding({
            id: 'edge.fwd-auth-stripped',
            method: 'forward-auth',
            type: 'edge-probe',
            status: verdict.status,
            title:
                verdict.status === 'pass'
                    ? 'Edge strips forward-auth headers (forged x-authentik-* removed)'
                    : 'Edge forwarding forward-auth headers — forged identity bypass possible',
            detail: verdict.detail,
            ...(verdict.status === 'fail'
                ? {
                      remediation:
                          'Configure the edge (Cloudflare / nginx / HAProxy) to strip x-authentik-*, ' +
                          'USERHEADER, and GROUPHEADER on the /api/v1 bypass surface before they reach the app.',
                      evidence: 'docs/architecture/jellyfin-compat-security.md',
                  }
                : {}),
        });
    } finally {
        try {
            await revoke();
        } catch {
            // Best-effort revocation — never throw.
        }
    }
}

/** Probe: edge.hsts — Strict-Transport-Security header present on HTTPS response. */
async function probeHsts(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    const result = await probeGet(`${baseUrl}/api/health/ready`);
    if (result.unreachable) {
        return finding({
            id: 'edge.hsts',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'HSTS: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }
    const hsts = result.headers.get('strict-transport-security');
    if (hsts) {
        return finding({
            id: 'edge.hsts',
            method: 'edge',
            type: 'edge-probe',
            status: 'pass',
            title: 'HSTS header present through edge',
            detail: 'Strict-Transport-Security is set on the public edge response.',
        });
    }
    return finding({
        id: 'edge.hsts',
        method: 'edge',
        type: 'edge-probe',
        status: 'info',
        title: 'HSTS header not set',
        detail:
            'The public edge response does not include Strict-Transport-Security. HSTS is a deliberate ' +
            'choice, not a universal requirement: once sent, browsers refuse HTTP to this host for max-age ' +
            '(includeSubDomains/preload extend that lock-in and are hard to undo), and many setups handle ' +
            'HSTS at the CDN (e.g. Cloudflare) rather than the origin.',
        remediation:
            'If all traffic is HTTPS and you want strict enforcement, enable HSTS at your edge/CDN ' +
            '(e.g. "Strict-Transport-Security: max-age=31536000"); start without includeSubDomains/preload ' +
            'until you are sure every subdomain is HTTPS-only. Otherwise this is safe to ignore.',
    });
}

/** Probe: edge.tls-enforced — plain-HTTP request is redirected/refused, not served. */
async function probeTlsEnforced(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    // Only meaningful when baseUrl is https:// — derive the http:// equivalent.
    let httpUrl: string;
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol !== 'https:') {
            return finding({
                id: 'edge.tls-enforced',
                method: 'edge',
                type: 'edge-probe',
                status: 'skipped',
                title: 'TLS enforced: skipped (base URL is not HTTPS)',
                detail: `Base URL uses protocol "${parsed.protocol}". TLS enforcement only checked for HTTPS deployments.`,
            });
        }
        parsed.protocol = 'http:';
        httpUrl = parsed.toString();
    } catch {
        return finding({
            id: 'edge.tls-enforced',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'TLS enforced: skipped (base URL parse failed)',
            detail: `Could not parse base URL: "${baseUrl}".`,
        });
    }

    // Probe the HTTP URL — we follow no redirects (redirect: 'manual' in probeGet).
    // A 3xx (redirect to https) or a connection refusal counts as "enforced".
    const result = await probeGet(`${httpUrl}/api/health/ready`);
    if (result.unreachable) {
        // Connection refused on plain HTTP is a good sign.
        const isRefused =
            result.unreachableReason.toLowerCase().includes('refused') ||
            result.unreachableReason.toLowerCase().includes('econnrefused');
        if (isRefused) {
            return finding({
                id: 'edge.tls-enforced',
                method: 'edge',
                type: 'edge-probe',
                status: 'pass',
                title: 'TLS enforced — plain HTTP port refused',
                detail: 'Connection to the plain-HTTP equivalent was refused. The edge does not serve unencrypted traffic.',
            });
        }
        return finding({
            id: 'edge.tls-enforced',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'TLS enforced: skipped (plain-HTTP probe unreachable)',
            detail: result.unreachableReason,
        });
    }

    const status = result.status ?? 0;
    // 3xx redirect to https is fine.
    if (status >= 300 && status < 400) {
        const location = result.headers.get('location') ?? '';
        if (location.startsWith('https://')) {
            return finding({
                id: 'edge.tls-enforced',
                method: 'edge',
                type: 'edge-probe',
                status: 'pass',
                title: 'TLS enforced — HTTP redirected to HTTPS',
                detail: `Plain-HTTP request was redirected (HTTP ${status}) to the HTTPS URL.`,
            });
        }
    }

    // Any 2xx means the edge served content over plain HTTP.
    if (status >= 200 && status < 300) {
        return finding({
            id: 'edge.tls-enforced',
            method: 'edge',
            type: 'edge-probe',
            status: 'fail',
            title: 'Plain HTTP served — tokens exposed in cleartext',
            detail: `Plain-HTTP request returned HTTP ${status}. Bearer tokens and session cookies are transmitted in cleartext.`,
            remediation:
                'Configure the edge to redirect all HTTP traffic to HTTPS (301/302 to https://).',
        });
    }

    // 4xx/5xx on HTTP — ambiguous but not a clear pass.
    return finding({
        id: 'edge.tls-enforced',
        method: 'edge',
        type: 'edge-probe',
        status: 'skipped',
        title: 'TLS enforced: inconclusive',
        detail: `Plain-HTTP probe returned HTTP ${status}, which is neither a redirect nor a 2xx response. Manual verification recommended.`,
    });
}

/** Probe: edge.security-headers — standard security headers present through edge. */
async function probeSecurityHeaders(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    // Hit an HTML route ("/"): the app sets X-Frame-Options / CSP / Referrer-Policy
    // on HTML responses and DELIBERATELY strips them on JSON/API and bypass paths.
    // Probing a JSON endpoint would always (correctly) show them "missing".
    const result = await probeGet(`${baseUrl}/`);
    if (result.unreachable) {
        return finding({
            id: 'edge.security-headers',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Security headers: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    // Only assess an actual HTML page (HTTP 200 + text/html). A redirect — even a
    // forward-auth/IdP redirect (e.g. Authentik 302) — often carries a text/html
    // body, so gating on content-type alone is not enough; a non-200 response is
    // not the app's page and a "missing headers" verdict there is a false positive.
    const contentType = (result.headers.get('content-type') ?? '').toLowerCase();
    if (result.status !== 200 || !contentType.includes('text/html')) {
        return finding({
            id: 'edge.security-headers',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Security headers: skipped (no HTML page to assess)',
            detail: `Request to "/" returned HTTP ${result.status ?? 'unknown'} (content-type "${contentType || 'unknown'}") — e.g. an auth redirect to an IdP. These headers are only set on the app's own HTML pages (HTTP 200).`,
        });
    }

    const missing: string[] = [];
    if (!result.headers.has('x-frame-options')) missing.push('X-Frame-Options');
    if (!result.headers.has('x-content-type-options')) missing.push('X-Content-Type-Options');
    if (!result.headers.has('referrer-policy')) missing.push('Referrer-Policy');

    if (missing.length === 0) {
        return finding({
            id: 'edge.security-headers',
            method: 'edge',
            type: 'edge-probe',
            status: 'pass',
            title: 'Security headers present through edge',
            detail: 'X-Frame-Options, X-Content-Type-Options, and Referrer-Policy all present.',
        });
    }

    return finding({
        id: 'edge.security-headers',
        method: 'edge',
        type: 'edge-probe',
        status: 'warn',
        title: 'Security headers missing or stripped at edge',
        detail: `Missing headers: ${missing.join(', ')}. The edge may be stripping headers set by the app.`,
        remediation:
            'Verify the edge (nginx/Cloudflare) does not strip X-Frame-Options, X-Content-Type-Options, or Referrer-Policy. These are set in hooks.server.ts.',
        evidence: 'hooks.server.ts:751,788',
    });
}

/** Probe: edge.health-config-gated — unauthenticated /api/health/config returns 401. */
async function probeHealthConfigGated(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    const result = await probeGet(`${baseUrl}/api/health/config`);
    if (result.unreachable) {
        return finding({
            id: 'edge.health-config-gated',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Health config gating: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    if (result.status === 401 || result.status === 403) {
        return finding({
            id: 'edge.health-config-gated',
            method: 'edge',
            type: 'edge-probe',
            status: 'pass',
            title: '/api/health/config requires authentication',
            detail: `Unauthenticated request returned HTTP ${result.status}. Configuration topology is not publicly exposed.`,
        });
    }

    return finding({
        id: 'edge.health-config-gated',
        method: 'edge',
        type: 'edge-probe',
        status: 'warn',
        title: '/api/health/config is publicly accessible',
        detail: `Unauthenticated request returned HTTP ${result.status ?? 'unknown'}. Deployment topology details may be exposed.`,
        remediation:
            'Ensure the requireAdmin middleware is applied to /api/health/config. Verify the edge does not bypass authentication for this path.',
    });
}

/** Probe: edge.health-ready-no-leak — unauthenticated /api/health/ready doesn't leak checks{}. */
async function probeHealthReadyNoLeak(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    const result = await probeGet(`${baseUrl}/api/health/ready`);
    if (result.unreachable) {
        return finding({
            id: 'edge.health-ready-no-leak',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Health ready topology leak: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    // Check if `checks` key is present in the body — that would leak topology.
    const body = result.body;
    const hasChecks =
        isRecord(body) && 'checks' in body && body.checks !== null && body.checks !== undefined;

    if (hasChecks) {
        return finding({
            id: 'edge.health-ready-no-leak',
            method: 'edge',
            type: 'edge-probe',
            status: 'warn',
            title: '/api/health/ready leaks checks{} topology',
            detail: 'The unauthenticated /api/health/ready response includes a "checks" key exposing internal service topology.',
            remediation:
                'Ensure /api/health/ready returns only {ready: boolean}, never the checks detail. Review ready/+server.ts:65.',
            evidence: 'ready/+server.ts:65',
        });
    }

    return finding({
        id: 'edge.health-ready-no-leak',
        method: 'edge',
        type: 'edge-probe',
        status: 'pass',
        title: '/api/health/ready does not expose topology',
        detail: 'The unauthenticated /api/health/ready response does not include checks{} detail.',
    });
}

/** Probe: edge.cors-not-wildcard — CORS on credentialed /api/for-you is not wildcard. */
async function probeCorsNotWildcard(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    // Send a preflight-like OPTIONS request to check the CORS policy.
    // We do a GET to a credentialed endpoint and check the response headers.
    const result = await probeGet(`${baseUrl}/api/for-you`, {
        headers: {
            Origin: 'https://attacker.example.com',
        },
    });

    if (result.unreachable) {
        return finding({
            id: 'edge.cors-not-wildcard',
            method: 'edge',
            type: 'edge-probe',
            status: 'skipped',
            title: 'CORS wildcard: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    const acao = result.headers.get('access-control-allow-origin') ?? '';
    const acac = result.headers.get('access-control-allow-credentials') ?? '';

    // Wildcard is only a problem when combined with credentials: true.
    if (acao === '*' && acac.toLowerCase() === 'true') {
        return finding({
            id: 'edge.cors-not-wildcard',
            method: 'edge',
            type: 'edge-probe',
            status: 'warn',
            title: 'CORS: wildcard origin with credentials — CSRF exposure',
            detail: 'Access-Control-Allow-Origin: * combined with Access-Control-Allow-Credentials: true. Any origin can make credentialed cross-site requests.',
            remediation:
                'Never combine wildcard ACAO with credentials. Reflect the origin or use an allowlist. See config.ts:221 and hooks.server.ts:804.',
            evidence: 'config.ts:221; hooks.server.ts:804',
        });
    }

    // Attacker-origin reflection: if the response reflects "https://attacker.example.com".
    if (acao === 'https://attacker.example.com' && acac.toLowerCase() === 'true') {
        return finding({
            id: 'edge.cors-not-wildcard',
            method: 'edge',
            type: 'edge-probe',
            status: 'warn',
            title: 'CORS: reflects arbitrary origin with credentials',
            detail: 'The edge/app reflects the attacker-supplied Origin header with Access-Control-Allow-Credentials: true. Any origin can make credentialed requests.',
            remediation:
                'Use an explicit origin allowlist rather than reflecting the incoming Origin header. See config.ts:221 and hooks.server.ts:804.',
            evidence: 'config.ts:221; hooks.server.ts:804',
        });
    }

    return finding({
        id: 'edge.cors-not-wildcard',
        method: 'edge',
        type: 'edge-probe',
        status: 'pass',
        title: 'CORS is not wildcard with credentials',
        detail: `Access-Control-Allow-Origin: "${acao || '(not set)'}". No unsafe wildcard + credentials combination detected.`,
    });
}

/** Probe: native.cookie-flags — session Set-Cookie has Secure+HttpOnly+SameSite through edge. */
async function probeCookieFlags(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    // We hit the native login endpoint to trigger a Set-Cookie, but we don't
    // actually authenticate — we probe the response headers of a known page.
    // Using /api/health/ready as a safe read-only endpoint that may set a cookie.
    // A better heuristic: probe the login page which always sets cookies.
    const result = await probeGet(`${baseUrl}/login`);
    if (result.unreachable) {
        return finding({
            id: 'native.cookie-flags',
            method: 'native',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Cookie flags: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    // Inspect EVERY Set-Cookie line (getSetCookie avoids the .get() collapse),
    // and target the session cookie specifically so a non-Secure session cookie
    // cannot hide behind an unrelated cookie.
    const setCookies = result.setCookies;
    if (setCookies.length === 0) {
        // No cookie set — can't verify flags, but not necessarily an error.
        return finding({
            id: 'native.cookie-flags',
            method: 'native',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Cookie flags: skipped (no Set-Cookie on probe response)',
            detail: 'The probe endpoint did not set a cookie. Cookie flag verification requires a session-cookie response.',
        });
    }

    const sessionCookie = setCookies.find((c) => /^\s*[^=]*session[^=]*=/i.test(c)) ?? null;
    if (!sessionCookie) {
        return finding({
            id: 'native.cookie-flags',
            method: 'native',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Cookie flags: skipped (no session cookie on probe response)',
            detail: `The probe response set ${setCookies.length} cookie(s) but none looked like a session cookie. Cookie-flag verification requires a session-cookie response.`,
        });
    }

    const cookieLower = sessionCookie.toLowerCase();
    const hasSecure = cookieLower.includes('secure');
    const hasHttpOnly = cookieLower.includes('httponly');
    const hasSameSite = cookieLower.includes('samesite=');

    const missing: string[] = [];
    if (!hasSecure) missing.push('Secure');
    if (!hasHttpOnly) missing.push('HttpOnly');
    if (!hasSameSite) missing.push('SameSite');

    if (missing.length === 0) {
        return finding({
            id: 'native.cookie-flags',
            method: 'native',
            type: 'edge-probe',
            status: 'pass',
            title: 'Session cookie has Secure+HttpOnly+SameSite through edge',
            detail: 'All required cookie flags are present on the Set-Cookie header through the public edge.',
        });
    }

    return finding({
        id: 'native.cookie-flags',
        method: 'native',
        type: 'edge-probe',
        status: 'warn',
        title: 'Session cookie missing security flags',
        detail: `Missing cookie flags: ${missing.join(', ')}. This may indicate TLS is being terminated incorrectly or the app is not setting Secure on cookies.`,
        remediation:
            'Ensure the app is aware it sits behind TLS termination (check ORIGIN / PROTOCOL env vars). Session cookies must have Secure, HttpOnly, and SameSite.',
    });
}

/** Probe: oidc.issuer-reachable — OIDC .well-known/openid-configuration reachable from the instance. */
async function probeOidcIssuerReachable(): Promise<SecuritySelfCheckFinding> {
    // Note: this probe hits the OIDC issuer directly from the *running instance*,
    // not through the public edge — because what matters is whether this process
    // can reach the IdP for token verification. We do NOT pass baseUrl here.
    if (!config.AUTH_OIDC_ENABLED) {
        return finding({
            id: 'oidc.issuer-reachable',
            method: 'oidc',
            type: 'edge-probe',
            status: 'skipped',
            title: 'OIDC issuer reachable: skipped (OIDC disabled)',
            detail: 'AUTH_OIDC_ENABLED is false.',
        });
    }

    const issuer = config.AUTH_OIDC_ISSUER;
    if (!issuer) {
        return finding({
            id: 'oidc.issuer-reachable',
            method: 'oidc',
            type: 'edge-probe',
            status: 'skipped',
            title: 'OIDC issuer reachable: skipped (issuer not configured)',
            detail: 'AUTH_OIDC_ISSUER is not set.',
        });
    }

    let wellKnownUrl: string;
    try {
        const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
        wellKnownUrl = `${base}.well-known/openid-configuration`;
        new URL(wellKnownUrl); // validate URL
    } catch {
        return finding({
            id: 'oidc.issuer-reachable',
            method: 'oidc',
            type: 'edge-probe',
            status: 'skipped',
            title: 'OIDC issuer reachable: skipped (invalid issuer URL)',
            detail: 'AUTH_OIDC_ISSUER could not be parsed as a URL.',
        });
    }

    const result = await probeGet(wellKnownUrl);
    if (result.unreachable) {
        return finding({
            id: 'oidc.issuer-reachable',
            method: 'oidc',
            type: 'edge-probe',
            status: 'warn',
            title: 'OIDC issuer unreachable from this instance',
            detail: `The OIDC discovery endpoint is not reachable from the running instance: ${result.unreachableReason}`,
            remediation:
                'Ensure this instance can reach the AUTH_OIDC_ISSUER. Check firewall rules, DNS, and network config.',
            evidence: 'config.ts:343; oidc.service.ts:220',
        });
    }

    if (result.status !== 200) {
        return finding({
            id: 'oidc.issuer-reachable',
            method: 'oidc',
            type: 'edge-probe',
            status: 'warn',
            title: 'OIDC issuer discovery returned non-200',
            detail: `The OIDC .well-known/openid-configuration endpoint returned HTTP ${result.status ?? 'unknown'}.`,
            remediation: 'Check the OIDC issuer URL and server status.',
        });
    }

    return finding({
        id: 'oidc.issuer-reachable',
        method: 'oidc',
        type: 'edge-probe',
        status: 'pass',
        title: 'OIDC issuer is reachable',
        detail: 'The OIDC .well-known/openid-configuration endpoint returned HTTP 200.',
    });
}

/** Probe: token.bad-bearer — garbage Bearer on /api/v1 returns 401 end-to-end through edge. */
async function probeTokenBadBearer(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    const result = await probeGet(`${baseUrl}/api/v1/feed`, {
        headers: {
            Authorization: 'Bearer invalid_garbage_token_security_check',
        },
    });

    if (result.unreachable) {
        return finding({
            id: 'token.bad-bearer',
            method: 'token',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Bad bearer sanity: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    if (result.status === 401) {
        return finding({
            id: 'token.bad-bearer',
            method: 'token',
            type: 'edge-probe',
            status: 'pass',
            title: 'Invalid bearer token correctly rejected (401)',
            detail: 'A garbage Bearer token on /api/v1 returned HTTP 401 end-to-end through the edge.',
        });
    }

    return finding({
        id: 'token.bad-bearer',
        method: 'token',
        type: 'edge-probe',
        status: 'warn',
        title: 'Invalid bearer token did not return 401',
        detail: `A garbage Bearer token on /api/v1 returned HTTP ${result.status ?? 'unknown'} instead of 401. The edge or app may not be correctly rejecting invalid tokens.`,
        remediation:
            'Verify the token validation middleware is active on /api/v1 and the edge is not short-circuiting auth.',
    });
}

/** Probe: compat.jellyfin-unauth — unauthenticated /j returns 401. Skipped if jellyfinCompat off. */
async function probeJellyfinUnauth(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    if (!features.jellyfinCompat) {
        return finding({
            id: 'compat.jellyfin-unauth',
            method: 'jellyfin-compat',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Jellyfin compat unauth probe: skipped (feature off)',
            detail: 'jellyfinCompat is disabled (FEATURE_JELLYFIN_COMPAT=false).',
        });
    }

    const result = await probeGet(`${baseUrl}/j/System/Info`);
    if (result.unreachable) {
        return finding({
            id: 'compat.jellyfin-unauth',
            method: 'jellyfin-compat',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Jellyfin compat unauth probe: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    if (result.status === 401 || result.status === 403) {
        return finding({
            id: 'compat.jellyfin-unauth',
            method: 'jellyfin-compat',
            type: 'edge-probe',
            status: 'pass',
            title: 'Jellyfin compat /j requires authentication',
            detail: `Unauthenticated request to /j returned HTTP ${result.status}.`,
        });
    }

    return finding({
        id: 'compat.jellyfin-unauth',
        method: 'jellyfin-compat',
        type: 'edge-probe',
        status: 'warn',
        title: 'Jellyfin compat /j may be publicly accessible',
        detail: `Unauthenticated request to /j/System/Info returned HTTP ${result.status ?? 'unknown'} instead of 401.`,
        remediation:
            'Ensure /j routes require Jellyfin-protocol authentication (PAT or svc_ token with jellyfin scope). Review jellyfin-compat-security.md.',
        evidence: 'docs/architecture/jellyfin-compat-security.md',
    });
}

/** Probe: compat.subsonic-unauth — unauthenticated /subsonic/rest/ping returns failed-auth. Skipped if subsonicCompat off. */
async function probeSubsonicUnauth(baseUrl: string): Promise<SecuritySelfCheckFinding> {
    if (!features.subsonicCompat) {
        return finding({
            id: 'compat.subsonic-unauth',
            method: 'subsonic-compat',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Subsonic compat unauth probe: skipped (feature off)',
            detail: 'FEATURE_SUBSONIC_COMPAT is disabled.',
        });
    }

    // Subsonic returns a 200 with an XML/JSON body containing a status field.
    // An unauthenticated ping should return status="failed" with error code 40 (wrong credentials).
    const result = await probeGet(
        `${baseUrl}/subsonic/rest/ping.view?v=1.16.1&c=security-check&f=json`,
    );
    if (result.unreachable) {
        return finding({
            id: 'compat.subsonic-unauth',
            method: 'subsonic-compat',
            type: 'edge-probe',
            status: 'skipped',
            title: 'Subsonic compat unauth probe: skipped (edge unreachable)',
            detail: result.unreachableReason,
        });
    }

    // Subsonic responses are 200 OK even for auth failures, with status in body.
    // body: { "subsonic-response": { "status": "failed", "error": { "code": 40, ... } } }
    const body = result.body;
    const subsonicResponse = isRecord(body) ? body['subsonic-response'] : undefined;
    const status = isRecord(subsonicResponse) ? subsonicResponse['status'] : undefined;

    if (status === 'failed') {
        return finding({
            id: 'compat.subsonic-unauth',
            method: 'subsonic-compat',
            type: 'edge-probe',
            status: 'pass',
            title: 'Subsonic compat /subsonic/rest/ping correctly rejects unauthenticated requests',
            detail: 'Unauthenticated Subsonic ping returned status="failed" in the response body.',
        });
    }

    if (result.status === 401 || result.status === 403) {
        return finding({
            id: 'compat.subsonic-unauth',
            method: 'subsonic-compat',
            type: 'edge-probe',
            status: 'pass',
            title: 'Subsonic compat /subsonic requires authentication',
            detail: `Unauthenticated request returned HTTP ${result.status}.`,
        });
    }

    return finding({
        id: 'compat.subsonic-unauth',
        method: 'subsonic-compat',
        type: 'edge-probe',
        status: 'warn',
        title: 'Subsonic compat /subsonic may not be rejecting unauthenticated requests',
        detail: `Unauthenticated Subsonic ping returned HTTP ${result.status ?? 'unknown'} with status="${String(status ?? 'unknown')}".`,
        remediation:
            'Ensure Subsonic auth validation correctly rejects missing or invalid credentials. See the Subsonic API reference (subsonic.org/pages/api.jsp), section "Required Parameters".',
        evidence: 'https://www.subsonic.org/pages/api.jsp',
    });
}

// ── Skipped-all helper ────────────────────────────────────────────────────────

/** Return a 'skipped' finding for every probe id when baseUrl is missing. */
function allSkipped(reason: string): SecuritySelfCheckFinding[] {
    const probeIds: Array<{
        id: string;
        method: SecuritySelfCheckFinding['method'];
        title: string;
    }> = [
        {
            id: 'edge.fwd-auth-stripped',
            method: 'forward-auth',
            title: 'Forward-auth header strip',
        },
        { id: 'edge.hsts', method: 'edge', title: 'HSTS' },
        { id: 'edge.tls-enforced', method: 'edge', title: 'TLS enforced' },
        { id: 'edge.security-headers', method: 'edge', title: 'Security headers' },
        { id: 'edge.health-config-gated', method: 'edge', title: 'Health config gating' },
        { id: 'edge.health-ready-no-leak', method: 'edge', title: 'Health ready topology leak' },
        { id: 'edge.cors-not-wildcard', method: 'edge', title: 'CORS wildcard' },
        { id: 'native.cookie-flags', method: 'native', title: 'Cookie flags' },
        { id: 'oidc.issuer-reachable', method: 'oidc', title: 'OIDC issuer reachable' },
        { id: 'token.bad-bearer', method: 'token', title: 'Bad bearer sanity' },
        {
            id: 'compat.jellyfin-unauth',
            method: 'jellyfin-compat',
            title: 'Jellyfin compat unauth',
        },
        {
            id: 'compat.subsonic-unauth',
            method: 'subsonic-compat',
            title: 'Subsonic compat unauth',
        },
    ];
    return probeIds.map(({ id, method, title }) =>
        finding({
            id,
            method,
            type: 'edge-probe',
            status: 'skipped',
            title: `${title}: skipped (no base URL)`,
            detail: reason,
            remediation:
                'Set PUBLIC_BASE_URL (preferred) or DEVICE_VERIFICATION_BASE_URL to the public HTTPS origin of this instance so edge probes can run.',
        }),
    );
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run all edge probes. Never throws — each family is wrapped in try/catch;
 * failures become 'error'-status findings.
 *
 * Finding ids emitted:
 *   edge.fwd-auth-stripped, edge.hsts, edge.tls-enforced, edge.security-headers,
 *   edge.health-config-gated, edge.health-ready-no-leak, edge.cors-not-wildcard,
 *   native.cookie-flags, oidc.issuer-reachable, token.bad-bearer,
 *   compat.jellyfin-unauth, compat.subsonic-unauth
 */
export async function runEdgeProbes(opts: EdgeProbeOpts): Promise<SecuritySelfCheckFinding[]> {
    const { baseUrl, mintToken } = opts;

    // If baseUrl is null/empty, return skipped findings for all probes.
    if (!baseUrl) {
        return allSkipped(
            'No public base URL configured. Set PUBLIC_BASE_URL (or DEVICE_VERIFICATION_BASE_URL) to enable edge probes.',
        );
    }

    // Normalize baseUrl — remove trailing slash.
    const base = baseUrl.replace(/\/$/, '');

    // Validate the base URL once. A malformed value (e.g. a bare host with no
    // scheme) would otherwise make every probe fail with a network error and
    // skip — masking a config mistake as "edge unreachable". Skip-all loudly.
    try {
        const parsed = new URL(base);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return allSkipped(
                `Base URL "${base}" is not an http(s) URL. Set DEVICE_VERIFICATION_BASE_URL to a full https:// origin.`,
            );
        }
    } catch {
        return allSkipped(
            `Base URL "${base}" could not be parsed. Set DEVICE_VERIFICATION_BASE_URL to a full https:// origin (e.g. https://example.com).`,
        );
    }

    // Run all probes concurrently, wrapping each in try/catch so one failure
    // cannot abort the others. Failures produce an 'error'-status finding.
    const results = await Promise.allSettled([
        safeProbe('edge.fwd-auth-stripped', 'forward-auth', () =>
            probeForwardAuthStripped(base, mintToken),
        ),
        safeProbe('edge.hsts', 'edge', () => probeHsts(base)),
        safeProbe('edge.tls-enforced', 'edge', () => probeTlsEnforced(base)),
        safeProbe('edge.security-headers', 'edge', () => probeSecurityHeaders(base)),
        safeProbe('edge.health-config-gated', 'edge', () => probeHealthConfigGated(base)),
        safeProbe('edge.health-ready-no-leak', 'edge', () => probeHealthReadyNoLeak(base)),
        safeProbe('edge.cors-not-wildcard', 'edge', () => probeCorsNotWildcard(base)),
        safeProbe('native.cookie-flags', 'native', () => probeCookieFlags(base)),
        safeProbe('oidc.issuer-reachable', 'oidc', () => probeOidcIssuerReachable()),
        safeProbe('token.bad-bearer', 'token', () => probeTokenBadBearer(base)),
        safeProbe('compat.jellyfin-unauth', 'jellyfin-compat', () => probeJellyfinUnauth(base)),
        safeProbe('compat.subsonic-unauth', 'subsonic-compat', () => probeSubsonicUnauth(base)),
    ]);

    return results.map((r) => {
        if (r.status === 'fulfilled') return r.value;
        // This should never happen because safeProbe itself never rejects,
        // but guard defensively.
        return finding({
            id: 'edge.unknown-error',
            method: 'edge',
            type: 'edge-probe',
            status: 'error',
            title: 'Unexpected edge probe error',
            detail: String(r.reason),
        });
    });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Run a single probe fn, catching any thrown errors and converting them to an
 * 'error'-status finding. This ensures the caller never rejects.
 */
async function safeProbe(
    id: string,
    method: SecuritySelfCheckFinding['method'],
    fn: () => Promise<SecuritySelfCheckFinding>,
): Promise<SecuritySelfCheckFinding> {
    try {
        return await fn();
    } catch (err) {
        return finding({
            id,
            method,
            type: 'edge-probe',
            status: 'error',
            title: `${id}: probe threw an unexpected error`,
            detail: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Type guard: is the value a plain object record? */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Safely extract a string[] from an unknown value. */
function parseStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}
