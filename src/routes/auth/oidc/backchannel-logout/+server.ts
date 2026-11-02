// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /auth/oidc/backchannel-logout — OIDC Back-Channel Logout 1.0 receiver.
 *
 * The OP (Authentik) POSTs `application/x-www-form-urlencoded` with a single
 * `logout_token` field when a user logs out / their OP session is terminated. We
 * validate the signed token and revoke the matching local session(s).
 *
 * Public + CSRF-exempt (server-to-server, no cookie): see NATIVE_AUTH_PUBLIC_PATHS
 * and CSRF_EXEMPT_EXACT_PATHS. It self-authenticates by the token signature.
 *
 * Per spec: 200 on success (the body is empty; some frameworks emit 204 — that's
 * fine), 400 on any validation failure, Cache-Control: no-store on every response.
 */

import { readBoundedBodyText, BODY_TOO_LARGE } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { Logger } from '$lib/server/utils/logger.js';
import { isOidcConfigured } from '$lib/server/services/oidc.service.js';
import {
    LogoutTokenError,
    OidcBackchannelInfraError,
} from '$lib/server/services/oidc-logout-token.js';
import { processBackchannelLogout } from '$lib/server/services/oidc-backchannel-logout.js';

const logger = Logger.for('OIDC:bcl:route');
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** A logout token is a small JWT; cap the body to reject oversized junk early. */
const MAX_BODY_BYTES = 16 * 1024;

function badRequest(description: string): Response {
    return new Response(
        JSON.stringify({ error: 'invalid_request', error_description: description }),
        {
            status: 400,
            headers: { ...NO_STORE, 'Content-Type': 'application/json' },
        },
    );
}

export const POST: RequestHandler = async ({ request }) => {
    if (!isOidcConfigured()) {
        return new Response(null, { status: 404, headers: NO_STORE });
    }

    // Reject an oversized body before buffering it (unauthenticated endpoint).
    const contentLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        return new Response(null, { status: 413, headers: NO_STORE });
    }
    if (
        !(request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')
    ) {
        return badRequest('expected application/x-www-form-urlencoded body');
    }
    // The header check above is skipped by a chunked body, so cap the stream too.
    const bodyText = await readBoundedBodyText(request, MAX_BODY_BYTES);
    if (bodyText === BODY_TOO_LARGE) {
        return new Response(null, { status: 413, headers: NO_STORE });
    }

    let token: string;
    try {
        const form = new URLSearchParams(bodyText);
        // Exactly one logout_token — a duplicate field is a malformed request.
        const all = form.getAll('logout_token');
        if (all.length !== 1) {
            return badRequest('expected exactly one logout_token');
        }
        const candidate = all[0];
        if (!candidate) {
            return badRequest('missing logout_token');
        }
        token = candidate;
    } catch {
        return badRequest('expected application/x-www-form-urlencoded body');
    }

    try {
        const outcome = await processBackchannelLogout(token);
        logger.info('back-channel logout processed', outcome);
        return new Response(null, { status: 200, headers: NO_STORE });
    } catch (error) {
        if (error instanceof LogoutTokenError) {
            logger.warn('rejected logout token', { error: error.message });
            return badRequest('invalid logout token');
        }
        // Infra outage (JWKS/discovery/DB/Valkey): return 503 so the OP RETRIES
        // rather than treating a transient failure as a permanent bad-token 400.
        if (error instanceof OidcBackchannelInfraError) {
            logger.warn('back-channel logout temporarily unavailable', { error: error.message });
            return new Response(null, {
                status: 503,
                headers: { ...NO_STORE, 'Retry-After': '30' },
            });
        }
        // Unknown error: also treat as retryable infra (503) — a session that
        // failed to revoke must not be dropped by an OP that won't retry.
        logger.error(
            'back-channel logout failed',
            error instanceof Error ? error : new Error(String(error)),
        );
        return new Response(null, { status: 503, headers: { ...NO_STORE, 'Retry-After': '30' } });
    }
};
