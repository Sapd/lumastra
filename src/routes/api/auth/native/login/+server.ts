// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — native login; must be reachable pre-auth

/**
 * POST /api/auth/native/login — native (built-in) username/password login.
 *
 * Public surface (reachable without forward-auth headers; see
 * NATIVE_AUTH_PUBLIC_PATHS). On success sets the HttpOnly session cookie and
 * returns a sanitized redirect target. Generic failure message (no user
 * enumeration). Rate-limited per IP and per username.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getClientIp, getClientIpStrict } from '$lib/server/utils/client-ip.js';
import {
    checkRateLimit,
    peekRateLimit,
    resetRateLimit,
} from '$lib/server/middleware/valkey-rate-limit.js';
import { attemptLogin } from '$lib/server/services/native-auth.service.js';
import { setSessionCookie, sessionMaxAgeSeconds } from '$lib/server/auth/native-session.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';

// Total attempts per IP (every attempt counts) — cheap pre-hash gate.
const IP_ATTEMPT_LIMIT = 30;
const IP_ATTEMPT_WINDOW = 15 * 60;
// Failures per username — targeted-account lockout (incremented on failure only).
const USER_FAIL_LIMIT = 10;
const USER_FAIL_WINDOW = 15 * 60;
// A login body is a username + password; never legitimately large (C15).
const MAX_LOGIN_BODY_BYTES = 16 * 1024;

export const POST: RequestHandler = withErrorHandler(async (event) => {
    const { request, cookies } = event;
    const ip = getClientIp(event);
    // SECURITY (H8): the rate-limit bucket key uses the strict (non-spoofable)
    // IP — `ip` above is honored via implicit proxy trust when TRUSTED_PROXY_IPS
    // is unset, so an attacker could rotate X-Forwarded-For per request to get a
    // fresh bucket each time. `ip` itself is kept for audit fields (last_used_ip)
    // below, which are non-security telemetry.
    const rateLimitIp = getClientIpStrict(event);

    // Pre-hash IP gate: count every attempt, reject when over the window cap.
    const ipGate = await checkRateLimit(
        `login:ip:${rateLimitIp}`,
        IP_ATTEMPT_LIMIT,
        IP_ATTEMPT_WINDOW,
    );
    if (!ipGate.allowed) {
        return ApiResponses.rateLimited(ipGate.resetAt * 1000, '/api/auth/native/login');
    }

    // Reject an oversized body before buffering it (C15): a declared
    // Content-Length over the cap is rejected without touching the body
    // stream (cheap); the streamed read below then bounds a missing/lying
    // Content-Length the same way, instead of buffering an unbounded body
    // via a bare `request.json()`. Shares the exact mechanism mount.ts and
    // middleware/validate.ts use (bounded-body-reader.ts) rather than the
    // previous Content-Length-only check. Runs only AFTER the per-IP
    // rate-limit gate above, so an unauthenticated flood is refused before
    // ever costing a streaming read.
    if (isDeclaredContentLengthOverCap(request, MAX_LOGIN_BODY_BYTES)) {
        return ApiProblem.payloadTooLarge();
    }

    const bodyText = await readBoundedBodyText(request, MAX_LOGIN_BODY_BYTES);
    if (bodyText === BODY_TOO_LARGE) {
        return ApiProblem.payloadTooLarge();
    }

    let body: unknown;
    try {
        body = bodyText.trim() === '' ? undefined : JSON.parse(bodyText);
    } catch {
        return ApiResponses.badRequest('Invalid request body');
    }
    if (!isRecord(body)) return ApiResponses.badRequest('Invalid request body');

    const username = toStringOr(body.username, '').trim();
    const password = toStringOr(body.password, '');
    if (!username || !password) {
        return ApiResponses.badRequest('Username and password are required');
    }
    // Bound inputs before they reach rate-limit keys / hashing (avoid unbounded
    // Valkey key cardinality + cheap memory-DoS via huge inputs).
    if (username.length > 128 || password.length > 1024) {
        return ApiResponses.badRequest('Invalid username or password');
    }

    // Per-username lockout: read the failure counter WITHOUT incrementing it (a
    // successful login must not erode a legitimate user's own budget) and refuse
    // before the expensive password hash if it's already exhausted.
    const userKey = `login:user:${username.toLowerCase()}`;
    const userGate = await peekRateLimit(userKey, USER_FAIL_LIMIT, USER_FAIL_WINDOW);
    if (!userGate.allowed) {
        return ApiResponses.rateLimited(userGate.resetAt * 1000, '/api/auth/native/login');
    }

    const sql = await aiDbService.getSql();
    if (!sql) return ApiResponses.aiDatabaseUnavailable('/api/auth/native/login');

    const result = await attemptLogin(sql, {
        username,
        password,
        userAgent: request.headers.get('user-agent'),
        ip,
    });

    if (!result) {
        // Count the failure against the per-username lockout (only failures count).
        await checkRateLimit(userKey, USER_FAIL_LIMIT, USER_FAIL_WINDOW);
        return ApiResponses.unauthorized('Invalid username or password');
    }

    // Success — clear the failure counter so prior typos don't linger.
    await resetRateLimit(userKey, USER_FAIL_WINDOW);

    setSessionCookie(cookies, result.token, sessionMaxAgeSeconds(result.expiresAt));

    const redirect = sanitizeRedirect(toStringOr(body.redirect, ''), '/');
    return json({ redirect });
});
