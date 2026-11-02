// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scoped CSRF (cross-site request forgery) origin guard.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * SvelteKit ships a built-in CSRF origin check (`csrf.checkOrigin`) that rejects
 * cross-origin *form* submissions (the only request shape a malicious page can
 * forge cross-site while carrying the victim's ambient cookies). `svelte.config.js`
 * sets `csrf.trustedOrigins: ['*']`, which — per SvelteKit's option compiler
 * (`csrf_check_origin = checkOrigin && !trustedOrigins.includes('*')`) —
 * GLOBALLY DISABLES that check.
 *
 * That global disable was safe ONLY while every authenticated request used a
 * token/header credential with no ambient cookie authority (a forged cross-site
 * request carried no usable identity). Native login adds a **session cookie**, so
 * every mutating route is now CSRF-able and the origin check must come back.
 *
 * SvelteKit's config is all-or-nothing (it can't exempt individual paths), but a
 * handful of routes legitimately receive cross-origin form POSTs from native
 * clients that authenticate themselves (NOT via our cookie):
 *   - `/j/*`        Jellyfin compat (QuickConnect/Initiate sends
 *                   application/x-www-form-urlencoded; self-auth via
 *                   X-Emby-Authorization)
 *   - `/subsonic/*` OpenSubsonic compat (credentials in query params)
 *   - `/oauth/*`    OAuth 2.0 device flow (token endpoint is, per RFC 6749 §4.1.3,
 *                   application/x-www-form-urlencoded; polled cross-origin by TVs)
 *
 * So we keep SvelteKit's built-in disabled and re-implement its EXACT algorithm
 * here, exempting only those three self-authenticating surfaces. Everything else
 * — admin form actions, the new native /login + /setup forms, and any `/api/*`
 * route that a `text/plain` body could smuggle past CORS — gets the origin check.
 *
 * ── What is checked ──────────────────────────────────────────────────────────
 * Mirrors `respond.js`: a request is forbidden when ALL hold:
 *   1. method ∈ {POST, PUT, PATCH, DELETE}
 *   2. content-type is a form type (urlencoded / multipart / text-plain) — the
 *      content types a cross-site `<form>` / no-preflight `fetch` can send. JSON
 *      bodies are excluded here exactly as in SvelteKit: a cross-origin
 *      `application/json` request triggers a CORS preflight the server never
 *      approves, so it can't be forged.
 *   3. the path is not one of the exempt self-auth prefixes
 *   4. the Origin header is absent OR its host does not match our host
 *
 * Host comparison (rather than full-origin string equality) keeps this robust
 * behind a TLS-terminating reverse proxy where the Node process sees `http` but
 * the browser sent `https` — a proto mismatch must not 403 legitimate same-site
 * posts. `event.url.host` is SvelteKit's already-resolved request host (from
 * ORIGIN / HOST_HEADER / the forwarded Host), i.e. the same value the built-in
 * check would compare against; we never trust a raw attacker-suppliable header to
 * decide "our host".
 */

import type { Handle, RequestEvent } from '@sveltejs/kit';
import { text } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { routedPathname } from '$lib/server/auth/routed-pathname.js';

const csrfLogger = Logger.for('CSRF');

/**
 * Path prefixes exempt from the origin check — self-authenticating surfaces that
 * legitimately receive cross-origin form POSTs and carry NO ambient cookie
 * authority. Keep this list tight: every entry is an explicit hole in CSRF
 * protection and must self-authenticate by some non-cookie credential.
 */
export const CSRF_EXEMPT_PREFIXES = [
    '/j/',
    '/subsonic/',
    '/oauth/',
    // Plugin webhook ingress. Same criterion as the three above: the route is
    // cookie-blind and authenticates with a per-integration shared secret, so
    // an origin check defends nothing — a forged cross-site POST still needs
    // the secret. Without the exemption the form-encoded and text/plain bodies
    // that real webhook senders post would be 403'd before reaching the plugin.
    '/api/plugin-webhooks/',
] as const;

/**
 * Exact paths (not prefixes) exempt from the origin check. The OIDC back-channel
 * logout receiver is called server-to-server by the OP with a form content type
 * and no Origin header; it self-authenticates by verifying the signed logout_token,
 * so the cookie-CSRF guard does not apply. Keep this to exact paths only.
 */
export const CSRF_EXEMPT_EXACT_PATHS = new Set<string>(['/auth/oidc/backchannel-logout']);

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Content types a cross-site `<form>` (or a no-preflight `fetch`) can send.
 * Matches SvelteKit's `is_form_content_type`. The content-type may carry
 * parameters (e.g. `multipart/form-data; boundary=…`), so we compare the bare
 * type prefix.
 */
const FORM_CONTENT_TYPES = [
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
] as const;

/**
 * Is this a CORS "simple request" body — one a foreign page can send WITH the
 * victim's cookies and WITHOUT a preflight? Form content types are; so is a
 * body with NO Content-Type at all (`fetch(..., { body: new Blob([json]) })`
 * sends none). Only a genuine non-form type such as application/json forces the
 * preflight that our CORS handling denies. Treating an absent header as "not a
 * form" let cross-site pages forge every cookie-authenticated JSON mutation
 * (security review 2026-09-12, C1).
 */
function isFormContentType(request: Request): boolean {
    const raw = request.headers.get('content-type');
    if (!raw) return true;
    // Strip parameters and normalize, mirroring SvelteKit's parser.
    const type = raw.split(';', 1)[0].trim().toLowerCase();
    return (FORM_CONTENT_TYPES as readonly string[]).includes(type);
}

function isExemptPath(pathname: string): boolean {
    if (CSRF_EXEMPT_EXACT_PATHS.has(pathname)) return true;
    return CSRF_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Native-login POST surface. These are cookie-authoritative, browser-only
 * endpoints called same-origin by our own UI — including `logout`, which carries
 * NO request body (and thus no form content type), so the form-content-type gate
 * alone would let a forged cross-site logout through. We therefore enforce the
 * same-origin check on this whole prefix regardless of content type.
 */
const NATIVE_AUTH_POST_PREFIX = '/api/auth/native/';

/**
 * Parse an Origin header into a lowercased host (host:port). Returns null for a
 * missing/opaque origin (`null`, `""`) — both of which must be treated as a
 * failed same-origin match, exactly like SvelteKit's `!request_origin` branch.
 */
function originHost(origin: string | null): string | null {
    if (!origin || origin === 'null') return null;
    try {
        return new URL(origin).host.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Additional trusted origins, by host. Reuses CORS_ALLOWED_ORIGINS so an operator
 * who already allowlisted a companion front-end origin for `/api/for-you` doesn't
 * also have to re-list it here. Empty by default.
 */
function trustedOriginHosts(): Set<string> {
    const hosts = new Set<string>();
    for (const o of config.CORS_ALLOWED_ORIGINS) {
        const h = originHost(o);
        if (h) hosts.add(h);
    }
    return hosts;
}

/**
 * The request's same-origin source host: the Origin header host, falling back to
 * the Referer host (some browsers omit Origin on certain same-origin requests but
 * still send Referer). Null when neither is present/parseable — treated as a
 * failed same-origin match.
 */
function requestSourceHost(request: Request): string | null {
    const origin = originHost(request.headers.get('origin'));
    if (origin) return origin;
    const referer = request.headers.get('referer');
    if (referer) {
        try {
            return new URL(referer).host.toLowerCase();
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Core decision, exported for unit testing. Returns true when the request is a
 * cross-site (or unverifiable-origin) state-changing submission that must be
 * rejected.
 */
export function isCrossSiteFormSubmission(event: RequestEvent): boolean {
    const { request, url } = event;

    if (!UNSAFE_METHODS.has(request.method)) return false;
    // Classify by the route the request reaches (`/de/api/auth/native/logout`,
    // `/api/auth/%6Eative/…` reach the native-auth routes too).
    const path = routedPathname(url);
    if (isExemptPath(path)) return false;

    // The native-auth POST surface is always origin-checked (covers the no-body
    // logout); everything else is checked for simple-request content types —
    // forms AND a missing Content-Type. A real JSON Content-Type can't be sent
    // cross-site without a CORS preflight the server denies, so it may skip.
    const forceOriginCheck = path.startsWith(NATIVE_AUTH_POST_PREFIX);

    // A request that carries its own Authorization header is not a CSRF
    // candidate. CSRF works because the browser attaches ambient credentials
    // (cookies) by itself; Authorization is not a CORS-safelisted request
    // header, so a cross-site page cannot set it without a preflight this
    // server answers. This does NOT reopen C1 above: a forged cookie-only
    // mutation still has no Authorization header and is still blocked.
    //
    // Without it, native clients were refused. iOS/tvOS POST
    // /api/v1/livetv/channels/{id}/keepalive with a Bearer token and NO body,
    // so no Content-Type — which `isFormContentType` deliberately treats as a
    // form. Every keepalive 403'd, the viewer was reaped from the channel
    // group, and Live TV showed a spinner that never produced a frame, with
    // nothing logged client-side.
    //
    // The native-login surface keeps its unconditional origin check: it is
    // cookie-authoritative and browser-only, and a login request has no bearer
    // token to present anyway.
    if (!forceOriginCheck && request.headers.get('authorization')) return false;

    if (!forceOriginCheck && !isFormContentType(request)) return false;

    const reqHost = requestSourceHost(request);
    const ourHost = url.host.toLowerCase();

    if (reqHost === ourHost) return false;
    if (reqHost && trustedOriginHosts().has(reqHost)) return false;

    return true;
}

/**
 * CSRF guard handle. Place FIRST in the hook sequence so a forged cross-site
 * mutation is rejected before any auth resolution, body parsing, or side effect.
 */
export const csrfHandle: Handle = ({ event, resolve }) => {
    if (isCrossSiteFormSubmission(event)) {
        const origin = event.request.headers.get('origin');
        csrfLogger.warn('Blocked cross-site form submission (CSRF guard)', {
            method: event.request.method,
            path: event.url.pathname,
            origin: origin ?? '(none)',
            host: event.url.host,
        });
        // Mirror SvelteKit's own response shape for this condition.
        return text(`Cross-site ${event.request.method} form submissions are forbidden`, {
            status: 403,
        });
    }
    return resolve(event);
};
