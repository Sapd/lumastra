// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `integrations:read` grant: the dedicated credential for the read-only
 * `/api/v1/integrations/*` endpoints (watch-history, upcoming, homepage).
 *
 * A principal qualifies when it is a SERVICE TOKEN carrying `integrations:read`
 * whose owner is CURRENTLY an administrator (`Principal.tokenOwnerIsAdmin`, the
 * same Formula-A owner verdict the `admin` grant uses, resolved by id on every
 * request in `token-identity.ts`). Admin sessions, PATs and `admin` service
 * tokens never qualify for watch-history/upcoming: the payload is other people's
 * viewing data, so only a credential minted for this purpose may read it —
 * revocable on its own and useless outside the integrations if it leaks.
 *
 * The grant carries a built-in path envelope (`integrationsGrantPathDenial()`,
 * applied by `validateBearerCredential()` on every plane): such a token
 * authenticates only on the three endpoints above — not elsewhere in the
 * `/api/v1/integrations` family (`/integrations/keys/{id}` needs another grant).
 *
 * Fail-closed note: `Principal.tokenOwnerIsAdmin` is set only by the shared token
 * producer (`token-identity.ts`). A principal built by mount()'s `authenticate()`
 * fallback carries none and is therefore refused (403), never let through.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import type { Principal } from '$lib/server/api/principal.js';
import type { TokenDenial } from '$lib/server/auth/token-identity.js';

export const INTEGRATIONS_GRANT = 'integrations:read';
export const INTEGRATIONS_PATH_PREFIX = '/api/v1/integrations';
export const WATCH_HISTORY_PATH = `${INTEGRATIONS_PATH_PREFIX}/watch-history`;
export const UPCOMING_PATH = `${INTEGRATIONS_PATH_PREFIX}/upcoming`;
export const HOMEPAGE_PATH = `${INTEGRATIONS_PATH_PREFIX}/homepage`;

/** The only paths an `integrations:read` token may reach. */
export const INTEGRATIONS_GRANT_PATHS: readonly string[] = [
    WATCH_HISTORY_PATH,
    UPCOMING_PATH,
    HOMEPAGE_PATH,
];

/**
 * True when `path` is exactly one of {@link INTEGRATIONS_GRANT_PATHS}, with at
 * most one trailing slash. Nothing below them and nothing else in the
 * `/api/v1/integrations` family (e.g. `/integrations/keys/{id}`) qualifies.
 */
export function isIntegrationsGrantPath(path: string): boolean {
    const p = path.endsWith('/') ? path.slice(0, -1) : path;
    return INTEGRATIONS_GRANT_PATHS.includes(p);
}

/**
 * Built-in envelope of the `integrations:read` grant: 403 (same shape as
 * `tokenEnvelopeDenial()`'s path miss) for any request path other than the
 * three integration endpoints, `null` for those or when the token lacks the
 * grant. `pathname` must be the ROUTED path (`routedPathname()`), so an encoded
 * or locale-prefixed spelling is judged by the route it reaches.
 */
export function integrationsGrantPathDenial(
    scopes: readonly string[],
    pathname: string,
): TokenDenial | null {
    if (!scopes.includes(INTEGRATIONS_GRANT)) return null;
    if (isIntegrationsGrantPath(pathname)) return null;
    return { status: 403, error: 'Token not permitted on this endpoint' };
}

/** True when `principal` is an `integrations:read` service token whose owner is still admin. */
export function isIntegrationsGrantPrincipal(principal: Principal | undefined): boolean {
    return (
        principal?.kind === 'service_token' &&
        principal.scopes.includes(INTEGRATIONS_GRANT) &&
        principal.tokenOwnerIsAdmin === true
    );
}

/** A 403 problem Response unless `principal` is a qualifying `integrations:read` service token. */
export function integrationTokenDenial(principal: Principal | undefined): Response | null {
    if (isIntegrationsGrantPrincipal(principal)) return null;
    return ApiProblem.forbidden(
        `Requires a service token with the ${INTEGRATIONS_GRANT} grant whose owner is an administrator`,
    );
}
