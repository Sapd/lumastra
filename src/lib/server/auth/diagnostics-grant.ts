// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `diagnostics:read` grant: a read-only service token for the admin debug
 * report (`/api/v1/admin/debug-report` and its drill-downs), so an AI agent or
 * a script can debug an instance without holding an admin credential.
 * Design: docs/superpowers/specs/2026-10-21-admin-debug-report-design.md §6.
 *
 * Modelled on `integrations:read` (`integration-token.ts`):
 *   - service tokens only, the token's ONLY grant, never impersonating, no
 *     forceNonAdmin, expiry required (mint rules in defs/service-tokens);
 *   - only an administrator may mint it (`ADMIN_MINT_ONLY_SCOPES`);
 *   - at request time the owner must still be an administrator
 *     (`Principal.tokenOwnerIsAdmin`, resolved by id in `token-identity.ts`);
 *   - a built-in envelope ({@link diagnosticsGrantPathDenial}), applied by
 *     `validateBearerCredential()` on every plane: GET/HEAD on the report
 *     routes only (exact templates), whatever the token's stored prefixes say.
 *
 * Admin sessions and admin tokens reach the report too: the def gate
 * `{kind:'scope', anyOf:['diagnostics:read']}` is granted to `admin` by
 * `scopeGranted()`'s early return, and {@link diagnosticsAccessDenial} accepts
 * an admin principal. The grant itself confers no `isAdmin`.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import type { Principal } from '$lib/server/api/principal.js';
import type { TokenDenial } from '$lib/server/auth/token-identity.js';

export const DIAGNOSTICS_GRANT = 'diagnostics:read';

/** The report; every drill-down lives below it. */
export const DEBUG_REPORT_PATH = '/api/v1/admin/debug-report';

/** Longest lifetime a `diagnostics:read` token may be minted with. */
export const DIAGNOSTICS_GRANT_MAX_DAYS = 90;

const READ_METHODS: readonly string[] = ['GET', 'HEAD'];

/**
 * The exact routes the grant opens, as segment templates (`*` = one non-empty
 * segment). Nothing else below the report prefix qualifies, so a future child
 * route does not inherit the grant by accident.
 */
const DIAGNOSTICS_GRANT_TEMPLATES: readonly (readonly string[])[] = [
    [],
    ['health'],
    ['runs', '*'],
    ['client-diagnostics', '*'],
    ['cluster', 'nodes', '*'],
];

/** True when `path` is the report or one of its drill-downs, at most one trailing slash. */
export function isDiagnosticsGrantPath(path: string): boolean {
    const p = path.endsWith('/') ? path.slice(0, -1) : path;
    if (p !== DEBUG_REPORT_PATH && !p.startsWith(`${DEBUG_REPORT_PATH}/`)) return false;
    const rest = p.slice(DEBUG_REPORT_PATH.length);
    const segments = rest === '' ? [] : rest.slice(1).split('/');
    return DIAGNOSTICS_GRANT_TEMPLATES.some(
        (tpl) =>
            tpl.length === segments.length &&
            tpl.every((part, i) => {
                const seg = segments[i];
                if (!seg || seg === '.' || seg === '..') return false;
                return part === '*' || part === seg;
            }),
    );
}

/**
 * Built-in envelope of the `diagnostics:read` grant: 403 for any path outside
 * the report or any method other than GET/HEAD; `null` when the token lacks
 * the grant or the request is inside the envelope. `pathname` must be the
 * ROUTED path (`routedPathname()`), so an encoded or locale-prefixed spelling
 * is judged by the route it reaches.
 */
export function diagnosticsGrantPathDenial(
    scopes: readonly string[],
    pathname: string,
    method: string,
): TokenDenial | null {
    if (!scopes.includes(DIAGNOSTICS_GRANT)) return null;
    if (isDiagnosticsGrantPath(pathname) && READ_METHODS.includes(method.toUpperCase())) {
        return null;
    }
    return { status: 403, error: 'Token not permitted on this endpoint' };
}

/** True when `principal` is a `diagnostics:read` service token whose owner is still admin. */
export function isDiagnosticsGrantPrincipal(principal: Principal | undefined): boolean {
    return (
        principal?.kind === 'service_token' &&
        principal.scopes.includes(DIAGNOSTICS_GRANT) &&
        principal.tokenOwnerIsAdmin === true
    );
}

/**
 * A 403 problem Response unless `principal` is an administrator or a
 * qualifying `diagnostics:read` service token. Handlers of the report defs
 * call it on top of the def gate, like the integration handlers do.
 */
export function diagnosticsAccessDenial(principal: Principal | undefined): Response | null {
    if (principal?.isAdmin === true) return null;
    if (isDiagnosticsGrantPrincipal(principal)) return null;
    return ApiProblem.forbidden(
        `Requires an administrator or a service token with the ${DIAGNOSTICS_GRANT} grant whose owner is an administrator`,
    );
}
