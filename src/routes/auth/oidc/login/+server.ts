// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /auth/oidc/login — begin the OIDC Authorization Code + PKCE flow.
 *
 * Public surface (in NATIVE_AUTH_PUBLIC_PATHS): reachable without forward-auth
 * headers. Generates state/nonce/PKCE, stores the transaction server-side, mirrors
 * `state` into a short-lived HttpOnly cookie that binds the flow to this browser
 * (login-CSRF defense), and redirects to the provider. The provider/discovery URLs
 * come ONLY from admin config (AUTH_OIDC_ISSUER) — no request input reaches a
 * server-side fetch, so there is no SSRF surface here. On any config/start failure
 * it bounces to /login with a generic message rather than erroring.
 */

import type { RequestHandler } from './$types';
import type { AuthFailureMessage } from '$lib/shared/auth-failure-ref.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';
import {
    startLogin,
    isOidcConfigured,
    OidcNotConfiguredError,
} from '$lib/server/services/oidc.service.js';
import {
    OIDC_TX_COOKIE,
    OIDC_TX_COOKIE_PATH,
    OIDC_TX_MAX_AGE,
    oidcRedirect,
    oidcCallbackUrl,
} from '$lib/server/auth/oidc-cookie.js';
import { describeFetchFailure } from '$lib/server/utils/fetch-error-cause.js';

const logger = Logger.for('OIDC:login');

// Light per-IP gate so the server-side transaction store can't be flooded.
const LOGIN_IP_LIMIT = 30;
const LOGIN_IP_WINDOW = 15 * 60;

// Typed to the allowlist: /login and /setup render `?error=` only if the value
// is one the shared formatter knows, so an un-allowlisted sentence here would
// silently degrade to the generic "please try again" at runtime. The type makes
// that a compile error instead.
const toLogin = (msg?: AuthFailureMessage): Response =>
    oidcRedirect(msg ? '/login?error=' + encodeURIComponent(msg) : '/login');

export const GET: RequestHandler = async (event) => {
    if (!isOidcConfigured()) {
        return toLogin();
    }

    // Strict IP, as on native login and setup (H8): with TRUSTED_PROXY_IPS unset,
    // getClientIp believes a client-supplied X-Forwarded-For, so rotating it would
    // give every request a fresh bucket.
    const ip = getClientIpStrict(event);
    const gate = await checkRateLimit(`oidc:login:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_IP_WINDOW);
    if (!gate.allowed) {
        return toLogin('Too many attempts. Try again later.');
    }

    const returnTo = sanitizeRedirect(event.url.searchParams.get('returnTo'), '/');
    const redirectUri = oidcCallbackUrl(event.url.origin);

    let start;
    try {
        start = await startLogin({ redirectUri, returnTo });
    } catch (error) {
        if (error instanceof OidcNotConfiguredError) {
            logger.warn('Failed to start OIDC login');
        } else {
            logger.warn('Failed to start OIDC login', { error: describeFetchFailure(error) });
        }
        return toLogin('Single sign-on is unavailable.');
    }

    // Bind the flow to this browser: the callback must present this same state.
    event.cookies.set(OIDC_TX_COOKIE, start.state, {
        path: OIDC_TX_COOKIE_PATH,
        httpOnly: true,
        sameSite: 'lax', // must survive the top-level redirect back from the IdP
        maxAge: OIDC_TX_MAX_AGE,
    });

    return oidcRedirect(start.authorizationUrl, 302);
};
