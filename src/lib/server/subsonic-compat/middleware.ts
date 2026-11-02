// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Auth parsing
//
// The Subsonic spec allows credentials in the URL query string (GET) OR in the
// form body (POST). The dispatcher calls `parseSubsonicAuth(event)` once per
// request; it merges both sources so web clients (SubFire, Airsonic Web) that
// POST form-encoded params work the same as CLI/native clients that use GET.
//
// This is intentionally NOT a higher-order function like `withJellyfinAuth`
// because the Subsonic dispatcher needs the format ('json' vs 'xml') even on
// auth failure to render the error response in the client's expected shape.

import type { RequestEvent } from '@sveltejs/kit';
import { validateCredentials } from './auth';
import type { SubsonicAuthContext, SubsonicFormat } from './types';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger.js';
import { subsonicError } from './serializers/response';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';

const logger = Logger.for('SubsonicCompat:RateLimit');

// Brute-force protection for the Subsonic compat surface. Mirrors the Jellyfin
// compat layer (jfcompat:auth_fail:<ip>): 60 failed auth attempts per IP per 60s
// window trip a 429 lockout. Closes the gap the admin security self-check flagged
// as `compat.subsonic-no-ratelimit`.
const SUBSONIC_FAILED_AUTH_LIMIT_PER_MINUTE = 60;
const SUBSONIC_FAILED_AUTH_WINDOW_SECONDS = 60;

/**
 * Read the requested response format from a Subsonic request URL.
 * Defaults to XML; only 'json' overrides. Used by error paths that need a
 * format before authentication succeeds (URL params only — body not yet read).
 */
export function getSubsonicFormat(url: URL): SubsonicFormat {
    const f = url.searchParams.get('f');
    return f === 'json' ? 'json' : 'xml';
}

/**
 * Parse Subsonic auth params from a request and validate credentials.
 * Merges URL query params and POST form body; body values take precedence.
 *
 * Recognized params:
 *   u — username (required)
 *   p — password mode token (`<token>` or `enc:<hex>`)
 *   t — token mode digest (MD5(token + salt))
 *   s — token mode salt (paired with `t`)
 *   c — client name (defaults to 'unknown')
 *   f — response format ('json' or 'xml', defaults to 'xml')
 *
 * Returns a SubsonicAuthContext on success, or null on any auth failure
 * (missing username, missing credentials, invalid token). The caller is
 * responsible for translating null into a Subsonic error response (code 40).
 */
export async function parseSubsonicAuth(event: RequestEvent): Promise<SubsonicAuthContext | null> {
    const { url } = event;

    // Body params are parsed once by the dispatcher and stored in locals so the
    // stream isn't consumed twice. Fall back to URL query params for GET clients.
    const get = (key: string): string | null =>
        event.locals.subsonicBodyParams?.get(key) ?? url.searchParams.get(key);

    const u = get('u')?.toLowerCase();
    const p = get('p');
    const t = get('t');
    const s = get('s');
    // Client-chosen label; ends up in play_sessions.client_name and is
    // rendered to ADMINS in the playback dashboard.
    const c = sanitizeDisplayName(get('c') ?? '', 64) || 'unknown';
    const f = get('f');
    const format: SubsonicFormat = f === 'json' ? 'json' : 'xml';

    if (!u) return null;

    let auth: Awaited<ReturnType<typeof validateCredentials>>;

    if (p) {
        auth = await validateCredentials(u, { password: p });
    } else if (t && s) {
        auth = await validateCredentials(u, { token: t, salt: s });
    } else {
        return null;
    }

    if (!auth) return null;

    return {
        userId: auth.userId,
        username: u,
        ownerIsAdmin: auth.isAdmin,
        displayName: auth.displayName,
        clientName: c,
        format,
        userGroups: auth.groups ?? [],
        maxAgeRating: auth.maxAgeRating,
        isAgeRestricted: auth.isAgeRestricted,
    };
}

/**
 * Record a failed Subsonic authentication attempt against a per-IP counter and
 * return the response to send. Over the threshold (60 failures / 60s per IP) →
 * HTTP 429 lockout; otherwise the standard Subsonic "wrong username or password"
 * (code 40) error in the client's requested format.
 *
 * Call this at EVERY auth-failure return in the dispatcher so brute-force attempts
 * (legacy u/p/t/s and apiKey paths) are throttled uniformly. Fails open on a
 * Valkey outage (checkRateLimit allows), matching the rest of the rate limiter.
 */
export async function recordSubsonicAuthFailure(
    event: RequestEvent,
    format: SubsonicFormat,
): Promise<Response> {
    // SECURITY: strict, not lenient — mirrors forward-auth.ts's apiv1:auth_fail
    // bucket. With the spoofable IP an attacker rotates X-Forwarded-For per
    // request for a fresh bucket each time, and the throttle protects nothing.
    // The Subsonic surface bypasses the central auth gate, so this is the whole
    // brute-force defence for it.
    const clientIp = getClientIpStrict(event);
    const rate = await checkRateLimit(
        `subsonic:auth_fail:${clientIp}`,
        SUBSONIC_FAILED_AUTH_LIMIT_PER_MINUTE,
        SUBSONIC_FAILED_AUTH_WINDOW_SECONDS,
    );
    if (!rate.allowed) {
        logger.warn('Subsonic compat: auth failure rate limit exceeded', {
            clientIp,
            resetAt: rate.resetAt,
        });
        return ApiResponses.rateLimited(rate.resetAt * 1000, '/subsonic/rest');
    }
    return subsonicError(40, 'Wrong username or password.', format);
}
