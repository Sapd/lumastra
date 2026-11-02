// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fetch wrapper with timeout support.
 *
 * Adds AbortSignal.timeout() to all external HTTP requests to prevent
 * indefinite hangs when upstream services (Jellyfin, TMDB) are unresponsive.
 */

import { FetchRedirectError, followRedirectsWithGuard } from './fetch-utils.js';

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Thrown by {@link fetchWithTimeout} when a redirect fails the same-host
 * policy: a different hostname, OR the same hostname with a scheme
 * *downgrade* (`https:` → `http:`). Port is never compared — a same-host
 * scheme *upgrade* (`http:` → `https:`), on any port, is allowed and does
 * NOT throw this. See `fetch-utils.ts`'s `isAllowedRedirectTarget` for the
 * authoritative rule (this module only re-exports the error class; the
 * policy itself is enforced by the shared `followRedirectsWithGuard` loop).
 *
 * This client (Audiobookshelf) is admin-configured and sends a bearer
 * token/API key on every request. Following an arbitrary redirect — the
 * default `fetch` behaviour — lets a compromised or misbehaving upstream 3xx
 * the request anywhere, including an internal address the app can reach but
 * the caller cannot (blind SSRF), or downgrade a request to plaintext on the
 * same host. Both are refused; only a same-host redirect that holds or
 * upgrades scheme is followed (C29 fix-plan finding; scheme/port policy
 * corrected under the C22 fix-plan review).
 *
 * This class is defined once in `fetch-utils.ts` (the SSRF-guarded public
 * helper — it is imported by more call sites than this module) and
 * re-exported here so existing imports from `fetch-timeout.js` keep working
 * and `instanceof` checks succeed regardless of which module a caller
 * imports the class from (previously each module defined its own class with
 * the same name, so `instanceof` failed across the boundary).
 */
export { FetchRedirectError };

/**
 * Fetch with an automatic timeout. If the caller already provides a signal,
 * the request aborts on whichever fires first (caller signal or timeout).
 *
 * Follows redirects manually, only when the Location stays on the SAME
 * host as the requested URL AND does not downgrade scheme (an upgrade,
 * `http:` → `https:`, is allowed; port is never compared) — see
 * {@link FetchRedirectError}. The redirect loop itself lives ONLY in
 * `fetch-utils.ts` (`followRedirectsWithGuard`, not exported) — this module
 * used to carry a second, independently maintained copy of the exact same
 * loop (C22 fix-plan finding: two copies of a security-relevant loop is how
 * one of them silently falls out of sync). This wrapper now differs from
 * `fetch-utils.ts`'s own `fetchWithTimeout` only in how the timeout `signal`
 * is built (`AbortSignal.timeout()` here vs an `AbortController` +
 * FetchTimeoutError translation there) and in accepting a `URL` as well as a
 * `string`.
 */
export async function fetchWithTimeout(
    url: string | URL,
    init?: RequestInit,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    // If caller provided a signal, combine both
    const existingSignal = init?.signal;
    const signal = existingSignal
        ? AbortSignal.any([existingSignal, timeoutSignal])
        : timeoutSignal;

    const currentUrl = typeof url === 'string' ? url : url.toString();
    return followRedirectsWithGuard(currentUrl, init ?? {}, signal);
}
