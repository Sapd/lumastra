// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared constants for the short-lived OIDC transaction cookie. This cookie mirrors
 * the server-side `state` so the callback can prove it belongs to the same browser
 * that started the flow (login-CSRF defense). It is HttpOnly, SameSite=Lax (so it
 * survives the top-level redirect back from the IdP), scoped to /auth/oidc, and
 * short-lived; the route deletes it on callback. Secure comes from the request's
 * cookie defaults (cookie-transport.ts); it is set on a GET, so it stays Secure
 * over plain HTTP unless ORIGIN is http.
 */

import { appPath } from '$lib/shared/api-urls.js';
import { config } from '$lib/server/config.js';

export const OIDC_TX_COOKIE = 'oidc_tx';
export const OIDC_TX_COOKIE_PATH = appPath('/auth/oidc');
/** Seconds — aligns with the server-side transaction TTL (10 min). */
export const OIDC_TX_MAX_AGE = 600;

export function oidcCallbackUrl(origin: string): string {
    return config.AUTH_OIDC_REDIRECT_URI || `${origin}${appPath('/auth/oidc/callback')}`;
}

/**
 * Build a redirect Response for the OIDC routes with hardened headers:
 *   - `Referrer-Policy: no-referrer` so the callback URL (which carries the OAuth
 *     `code`/`state`) can never leak to the destination or downstream logs via the
 *     Referer header (defense-in-depth — we already keep tokens OUT of URLs);
 *   - `Cache-Control: no-store` so a shared/proxy cache never retains the location.
 * Cookies queued via `event.cookies.set/delete` are still applied by SvelteKit.
 */
export function oidcRedirect(location: string, status = 303): Response {
    return new Response(null, {
        status,
        headers: {
            location,
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-store',
        },
    });
}
