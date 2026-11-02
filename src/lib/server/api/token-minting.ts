// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minting ceiling for PATs and service tokens, plus a general admin ceiling
 * for privilege-granting mutations.
 *
 * A token endpoint is an authorization-of-authorization: whoever can call it
 * decides what a NEW credential may do. Before this helper existed the only
 * gate was the `tokens:admin` scope, so a `tokens:admin`-only token could mint
 * an `admin` PAT for an administrator (which deriveIsAdmin() then honoured
 * everywhere) or a service token with `admin` scope. Security review
 * 2026-09-12, C3.
 *
 * Rule — an administrator may mint anything; anyone else may only mint
 *   1. no admin-class scope (`admin`, `<area>:admin`) and no
 *      `integrations:read` or `diagnostics:read` grant,
 *   2. for a target who is not an administrator,
 *   3. scopes the caller's own expanded scope set already holds.
 *
 * `requireAdminCeiling()` is the sibling for `users:admin`: that scope is a
 * fine-grained, NON-admin-equivalent delegation scope (deriveIsAdmin() never
 * treats it as admin — see principal.ts), so it must not be able to pin admin
 * status, create an admin account, or reset an admin's password. Security
 * review 2026-09-13, C1.
 *
 * "The caller" is the principal that passed the OUTER gate. `delegateToAdmin()`
 * elevates `locals.principal` for the internal handoff to an admin-mounted
 * handler; `principalBeforeDelegation()` gives the unelevated one back.
 */

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { ApiProblem } from '$lib/server/api/problem.js';
import { principalBeforeDelegation } from '$lib/server/api/delegate.js';
import { scopeGranted, type ApiScope } from '$lib/server/tasks/api-auth.js';
import { isAdminClassScope } from '$lib/server/api/principal.js';

/**
 * Grants that are not admin-class at request time (they confer no `isAdmin`
 * and no admin scope) but that only an administrator may mint: the
 * `integrations:read` service-token grant reads every user's watch history,
 * and `diagnostics:read` reads the admin debug report (logs, config shape,
 * node and run state).
 */
const ADMIN_MINT_ONLY_SCOPES: readonly string[] = ['integrations:read', 'diagnostics:read'];

/** Whether only an administrator may mint `scope` (admin-class or admin-mint-only). */
export function isAdminMintOnlyScope(scope: string): boolean {
    return isAdminClassScope(scope) || ADMIN_MINT_ONLY_SCOPES.includes(scope);
}

/**
 * Longest lifetime a minted token may ask for (10 years). Without a cap,
 * `Date.now() + days * 86_400_000` overflows the Date range for absurd values
 * and the insert fails with a 500 or stores a garbage expiry.
 */
export { MAX_TOKEN_LIFETIME_DAYS } from '$lib/schemas/user.js';

export interface MintRequest {
    /** Scopes requested for the new token, as sent by the caller. */
    scopes: readonly string[];
    /** Whether the user the token is minted for (or impersonates) is an admin. */
    targetIsAdmin: boolean;
}

/**
 * Re-exported from `principal.ts`, which now owns the single canonical
 * definition (it also backs `stripAdminScopes()` there and the credential
 * stores' own admin-class revocation — see that file's doc comment). Kept as
 * a re-export here so existing importers (`resolve-bearer-principal.ts`)
 * don't need to change their import path.
 */
export { isAdminClassScope };

/**
 * The PAT compat scopes are `/j`-only aliases for read (`jellyfin_compat_read`)
 * and read+write (`jellyfin_compat`); the ceiling judges them as such.
 */
function ceilingEquivalent(scope: string): string {
    if (scope === 'jellyfin_compat') return 'write';
    if (scope === 'jellyfin_compat_read') return 'read';
    return scope;
}

export function callerHolds(callerScopes: readonly string[], scope: string): boolean {
    const wanted = ceilingEquivalent(scope);
    if (callerScopes.includes(wanted)) return true;
    // Hierarchical grants (users:admin → users:read, write → media:write, …).
    return scopeGranted([...callerScopes], wanted as ApiScope);
}

/**
 * Whether the caller is an administrator, judged from the credential that
 * passed the outer gate — never from a delegation-elevated principal.
 *
 * Exported for the admin-ceiling checks in the `users:admin` endpoints
 * (security review 2026-09-13, C1) — `requireAdminCeiling()` below is the
 * usual entry point; this is exposed for callers that need the raw boolean.
 */
export async function callerIsAdmin(event: RequestEvent): Promise<boolean> {
    // Every ceiling caller has passed a mount gate that resolved its principal.
    // Delegation must retain the original credential's admin capability; neither
    // an owner projection nor a fresh Bearer lookup can replace that authority.
    const principal = principalBeforeDelegation(event) ?? event.locals.principal;
    return principal?.isAdmin === true;
}

/**
 * Credential mutations (mint or revoke a PAT, link or unlink an external
 * account, set or clear the notification webhook) need an INTERACTIVE session:
 * a browser session, native login or forward-auth identity. Every bearer
 * credential (device JWT, PAT, service token, stream token) is refused with
 * 403 `forbidden` / `reason: session_required`.
 *
 * Why: `denyUnlessMayMint()` only proves the caller HOLDS the scopes it asks
 * for. A device JWT for `scope=media` holds `write`, so an app the user
 * approved could mint a long-lived `write` PAT that survives revoking the app
 * (pre-release review 2026-10-21). A bearer must not be able to create, replace
 * or remove other credentials, whatever scopes it holds.
 *
 * Judged on the principal that passed the outer gate (never a delegation
 * elevation). Returns `null` when the caller is interactive.
 */
export function denyUnlessInteractiveSession(event: RequestEvent): Response | null {
    const caller = principalBeforeDelegation(event) ?? event.locals.principal;
    if (!caller) return ApiProblem.unauthorized();
    if (caller.kind === 'session' || caller.kind === 'forward_auth') return null;
    return ApiProblem.forbidden(
        'This action requires an interactive sign-in; API tokens and device tokens cannot change credentials or linked accounts',
        { reason: 'session_required' },
    );
}

/**
 * Returns a 403 problem when the caller may not mint the requested token,
 * `null` when they may. Call it BEFORE the service `create()`.
 */
export async function denyUnlessMayMint(
    event: RequestEvent,
    request: MintRequest,
): Promise<Response | null> {
    if (await callerIsAdmin(event)) return null;

    const adminScopes = request.scopes.filter(isAdminMintOnlyScope);
    if (adminScopes.length > 0) {
        return ApiProblem.forbidden(
            `Only administrators can mint tokens with admin scope (${adminScopes.join(', ')})`,
        );
    }
    if (request.targetIsAdmin) {
        return ApiProblem.forbidden('Only administrators can mint tokens for an administrator');
    }

    const caller = principalBeforeDelegation(event) ?? event.locals.principal;
    const callerScopes = caller?.scopes ?? [];
    const lacking = request.scopes.filter((s) => !callerHolds(callerScopes, s));
    if (lacking.length > 0) {
        return ApiProblem.forbidden(
            `Cannot mint a token with scopes the caller does not hold (${lacking.join(', ')})`,
        );
    }
    return null;
}

/**
 * Admin ceiling for the `users:admin` endpoints (security review 2026-09-13,
 * C1): `users:admin` is a non-admin delegation scope — it must not be able to
 * pin admin status, create an admin account, or reset an admin's password.
 *
 * Returns a 403 problem when the caller is not an administrator, `null` when
 * they may proceed. Judges the caller the same way `denyUnlessMayMint()`
 * does — via `callerIsAdmin()`, which consults `principalBeforeDelegation()`
 * first so a `delegateToAdmin()` handoff (v1 password facade → internal admin
 * handler) cannot launder a non-admin caller into an admin one.
 */
export async function requireAdminCeiling(
    event: RequestEvent,
    reason: string,
): Promise<Response | null> {
    if (await callerIsAdmin(event)) return null;
    return ApiProblem.forbidden(reason);
}

/**
 * Target-aware admin ceiling for the `users:admin` endpoints that act on ONE
 * user: a non-admin caller may not touch an administrator's credentials,
 * secrets, personal-data export or account state.
 *
 * The target is judged with Formula A (`resolveOwnerAdminStatus()`: the pin,
 * IdP groups, in-app groups and the in-app `admin` capability), never the raw
 * `users.is_admin` column, which lags for an unpinned in-app or IdP-group
 * admin. An administrator caller short-circuits before any lookup. A lookup
 * failure for a non-admin caller fails closed. A target with no `users` row
 * passes, so the handler can answer its own 404.
 */
export async function requireAdminCeilingForTarget(
    event: RequestEvent,
    sql: postgres.Sql,
    targetUsername: string,
    reason: string,
): Promise<Response | null> {
    if (await callerIsAdmin(event)) return null;
    try {
        const { resolveOwnerAdminStatus } =
            await import('$lib/server/auth/resolve-owner-admin-status.js');
        const target = await resolveOwnerAdminStatus(sql, targetUsername);
        if (!target?.isAdmin) return null;
    } catch {
        // fall through: deny
    }
    return ApiProblem.forbidden(reason);
}

/**
 * Id-keyed sibling of {@link requireAdminCeilingForTarget}, for the PAT list
 * and revoke endpoints that hold a `users.id` (release review 2026-10-21,
 * finding 3). Same rules: an administrator caller short-circuits, a failed
 * lookup denies, a target without a `users` row passes.
 */
export async function requireAdminCeilingForTargetId(
    event: RequestEvent,
    sql: postgres.Sql,
    targetUserId: string,
    reason: string,
): Promise<Response | null> {
    if (await callerIsAdmin(event)) return null;
    try {
        const { resolveOwnerAdminStatusById } =
            await import('$lib/server/auth/resolve-owner-admin-status.js');
        const target = await resolveOwnerAdminStatusById(sql, targetUserId);
        if (!target?.isAdmin) return null;
    } catch {
        // fall through: deny
    }
    return ApiProblem.forbidden(reason);
}
