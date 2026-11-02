// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared pieces of the redirect-kind auth flow: the transaction cookie, the
 * hardened redirect helper, and the check applied to a plugin's redirect target.
 *
 * Mirrors `oidc-cookie.ts`, which solves the same problem for the built-in OIDC
 * flow. Kept separate rather than reused so the two flows' cookies cannot
 * collide, and so a change to one is never silently a change to the other.
 */

export const PLUGIN_AUTH_TX_COOKIE = 'plugin_auth_tx';
export const PLUGIN_AUTH_TX_COOKIE_PATH = '/api/auth/plugin';
/** Seconds — aligns with the server-side transaction TTL (10 min). */
export const PLUGIN_AUTH_TX_MAX_AGE = 600;

/**
 * A redirect with the headers this flow needs:
 *   - `Referrer-Policy: no-referrer`, so the callback URL — which carries the
 *     provider's authorization code — cannot leak downstream via Referer;
 *   - `Cache-Control: no-store`, so no shared cache retains the location.
 * Cookies queued via `event.cookies.set/delete` are still applied by SvelteKit.
 */
export function pluginAuthRedirect(location: string, status = 303): Response {
    return new Response(null, {
        status,
        headers: {
            location,
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-store',
        },
    });
}

/**
 * Is this something we are willing to send a browser to on a plugin's say-so?
 *
 * The plugin is trusted code, so this is not a trust boundary in the way the
 * install signature is — it is a blast-radius limit and a bug catcher. The
 * failure it prevents is real and cheap to hit: a plugin that builds its
 * authorize URL by string concatenation and gets it wrong hands us
 * `javascript:` or a relative path, and we would otherwise obligingly navigate
 * to it.
 *
 * https only, with ONE carve-out: http to a loopback host. A locally-run
 * identity provider is a normal self-hosting arrangement and loopback traffic
 * cannot be observed on the network, which is the same line the OAuth native-app
 * guidance draws. Every other http target is refused, because this flow carries
 * an authorization code back.
 */
export function isSafeProviderRedirect(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // Relative paths land here, and are refused deliberately: a plugin has
        // no business redirecting inside our own origin.
        return false;
    }
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
