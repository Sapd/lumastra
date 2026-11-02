// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — first-run admin setup; self-guards via adminExists (409 once setup is complete: setup lock or an admin)

/**
 * POST /api/auth/native/setup — first-run onboarding completion.
 *
 * Public surface, but guarded: usable ONLY while setup is not complete — no
 * `setup_lock` row and no counted admin. A locked install answers 409 even with
 * zero admins left (S-C5c-2); it reopens only through `SETUP_UNLOCK` at boot.
 * Becomes inert afterward — `completeNativeSetup()` checks `adminExists()` (the
 * lock-aware setup gate) up front, then `createNativeAdmin()` re-runs the SAME
 * gate (`setupGateAdminExists()`, `users.queries.ts`: the lock row first, then
 * the broad is_admin OR live `users.groups` projection OR admin-conferring
 * in-app membership predicate) under the first-admin advisory lock, on the
 * locked connection, before its INSERT — so concurrent bootstrap submissions
 * can't both create an admin.
 *
 * Body (one of):
 *   { method: 'native', username, password }   → create the first admin + log in
 *   { method: 'forward-auth' }                  → verify proxy headers + provision admin
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getClientIp, getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import {
    completeNativeSetup,
    completeForwardAuthSetup,
} from '$lib/server/services/native-auth.service.js';
import { readTrustedForwardAuthIdentity } from '$lib/server/middleware/forward-auth.js';
import { setSessionCookie, sessionMaxAgeSeconds } from '$lib/server/auth/native-session.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';

const ENDPOINT = '/api/auth/native/setup';

// A setup body is a method tag plus, at most, a username + password — never
// legitimately large (C16, same class as native/login's C15 fix).
const MAX_SETUP_BODY_BYTES = 16 * 1024;

export const POST: RequestHandler = withErrorHandler(async (event) => {
    const { request, cookies } = event;
    const ip = getClientIp(event);
    // SECURITY: the rate-limit bucket key uses the strict (non-spoofable) IP —
    // `ip` above is honored via implicit proxy trust when TRUSTED_PROXY_IPS is
    // unset (the common fresh-box default), so an attacker could rotate
    // X-Forwarded-For per request to get a fresh bucket every time and defeat
    // the cap while running unauthenticated scrypt (hashPassword) each attempt.
    // `ip` itself is kept for the session's audit field below (non-security
    // telemetry).
    const rateLimitIp = getClientIpStrict(event);

    // Modest abuse cap on the unauthenticated setup surface.
    const gate = await checkRateLimit(`setup:ip:${rateLimitIp}`, 20, 15 * 60);
    if (!gate.allowed) return ApiResponses.rateLimited(gate.resetAt * 1000, ENDPOINT);

    // Reject an oversized body before buffering it (C16): a declared
    // Content-Length over the cap is rejected without touching the body
    // stream; the streamed read below then bounds a missing/lying
    // Content-Length the same way, instead of buffering an unbounded body
    // via a bare `request.json()`. Runs only AFTER the per-IP rate-limit
    // gate above, so an unauthenticated flood is refused before ever
    // costing a streaming read.
    if (isDeclaredContentLengthOverCap(request, MAX_SETUP_BODY_BYTES)) {
        return ApiResponses.payloadTooLarge();
    }
    const bodyText = await readBoundedBodyText(request, MAX_SETUP_BODY_BYTES);
    if (bodyText === BODY_TOO_LARGE) {
        return ApiResponses.payloadTooLarge();
    }

    let body: unknown;
    try {
        body = bodyText.trim() === '' ? undefined : JSON.parse(bodyText);
    } catch {
        return ApiResponses.badRequest('Invalid request body');
    }
    if (!isRecord(body)) return ApiResponses.badRequest('Invalid request body');

    const sql = await aiDbService.getSql();
    if (!sql) return ApiResponses.aiDatabaseUnavailable(ENDPOINT);

    const method = toStringOr(body.method, '');

    if (method === 'forward-auth') {
        const identity = readTrustedForwardAuthIdentity(event);
        if (!identity) {
            return ApiResponses.badRequest(
                'No trusted forward-auth identity headers were found on this request. Forward auth needs FORWARD_AUTH_ENABLED=true, your reverse proxy forwarding the configured USERHEADER/GROUPHEADER, and its IP in TRUSTED_PROXY_IPS.',
                undefined,
                ENDPOINT,
            );
        }
        const result = await completeForwardAuthSetup(sql, identity);
        if (!result.ok) {
            return ApiResponses.error(result.message, undefined, result.status, ENDPOINT);
        }
        return json({
            redirect: '/admin/library/sources',
            oidcConfigDiscarded: result.oidcConfigDiscarded,
        });
    }

    if (method === 'native') {
        const username = toStringOr(body.username, '').trim();
        const password = toStringOr(body.password, '');
        if (!username || !password) {
            return ApiResponses.badRequest(
                'Username and password are required',
                undefined,
                ENDPOINT,
            );
        }
        const result = await completeNativeSetup(sql, {
            username,
            password,
            userAgent: request.headers.get('user-agent'),
            ip,
        });
        if (!result.ok) {
            return ApiResponses.error(result.message, undefined, result.status, ENDPOINT);
        }
        setSessionCookie(
            cookies,
            result.session.token,
            sessionMaxAgeSeconds(result.session.expiresAt),
        );
        return json({
            redirect: '/admin/library/sources',
            oidcConfigDiscarded: result.oidcConfigDiscarded,
        });
    }

    return ApiResponses.badRequest(
        "method must be 'native' or 'forward-auth'",
        undefined,
        ENDPOINT,
    );
});
