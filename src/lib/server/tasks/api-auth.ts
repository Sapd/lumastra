// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// api-auth.ts — shared auth helper for /api/v1/ endpoints.
//
// Validates Bearer tokens (PAT or service token) and checks scopes.
// Scope vocabulary maps the plan's task:* labels onto the existing
// flat scope system (read / write / admin). Full scope split is a follow-up.

import type { RequestEvent } from '@sveltejs/kit';
import { stripAdminScopes, stripsAdminScopesForToken } from '$lib/server/api/principal.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { routedPathname } from '$lib/server/auth/routed-pathname.js';
import {
    validateBearerCredential,
    resolveTokenIdentity,
    type TokenRequestCtx,
    type TokenDenial,
} from '$lib/server/auth/token-identity.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

/**
 * Scope vocabulary for the /api/v1 token surface.
 *
 * This type mirrors (and must stay compatible with) the canonical `ApiScope`
 * in `$lib/server/api/define.ts`. It is kept here for backward-compat with
 * pre-Principal callers; the authoritative definition is in define.ts.
 *
 * D7 scopes (users:admin, library:admin, etc.) are handled via the
 * `default: tokenScopes.includes(required)` branch in scopeGranted().
 */
export type ApiScope =
    | 'tasks:read'
    | 'tasks:run'
    | 'tasks:admin'
    | 'runs:read'
    | 'webhooks:write'
    | 'media:read'
    | 'media:write'
    | 'sessions:read'
    | 'sessions:write'
    | 'requests:read'
    | 'requests:admin'
    | 'users:read'
    | 'users:admin'
    | 'access:admin'
    | 'tokens:admin'
    | 'library:read'
    | 'library:admin'
    | 'media:admin'
    | 'livetv:admin'
    | 'providers:read'
    | 'providers:admin'
    | 'playback:read'
    | 'playback:admin'
    | 'metrics:read'
    | 'integrations:read'
    // Debug-report service-token grant; never in expandScopes output (only a
    // token minted with it holds it).
    | 'diagnostics:read';

export interface ApiAuth {
    tokenKind: 'pat' | 'svc';
    tokenId: string;
    userId: string;
    scopes: string[];
    /**
     * Resolved caller identity, when available — the real `users.id` UUID,
     * current username, and current groups. Consumed by mount.ts's
     * `enforce()` {kind:'scope'} fallback to materialise `locals.principal`
     * for surfaces where forward-auth never built one (Bearer PAT/svc
     * callers on `/api/admin/*` — see hooks.server.ts's "Bearer exception").
     *
     * FIX (fix-plan-5 Task 3): resolved via the SAME shared
     * `$lib/server/auth/token-identity.ts` producer `forward-auth.ts`'s
     * `/api/v1` PRIMARY authority and `resolve-bearer-principal.ts`'s
     * `/api/admin` TERTIARY fallback use — NOT a separate `resolveServiceTokenIdentity()`
     * (deleted) that independently re-derived the same verdicts and drifted
     * from `forward-auth.ts`'s copy (that WAS the C1 bug: the deleted
     * function judged an impersonating token by its CREATOR).
     *
     * PAT: resolved via `resolveTokenUserAccess()` (Formula A, a genuine
     * extra DB round trip — NOT reused from `validate()`'s already-fetched
     * row, which only carries the owner's raw `users.groups` snapshot, not
     * the in-app-merged effective groups this needs).
     *
     * Service token:
     *   - Impersonating (`actAsUser` set, a `users.id` UUID since mig
     *     16.46.0): the impersonation TARGET's current `username`/`groups`,
     *     via the shared producer's id-keyed raw-SQL row fetch. A missing,
     *     disabled, or soft-deleted target does NOT yield an identity —
     *     `authenticate()` throws `ApiAuthError(403)` instead, mirroring
     *     forward-auth's `invalid_impersonation`.
     *   - Non-impersonating: the identity is the token's OWNER
     *     (`validated.ownerUserId`), attributed as `service:${validated.name}`
     *     with a SYNTHETIC group set (`['admin']` when the token is
     *     admin-scoped, not `forceNonAdmin`, AND the creator is CURRENTLY
     *     pin-aware admin, else `[]`) — never the creator's own groups.
     *     `ServiceTokenService.validate()` already denies a missing,
     *     disabled or deleted owner (`isOwnerActive`, by id) before this ever
     *     runs, but that alone does NOT cover a pin-demoted (still-enabled)
     *     owner — see the C3 fix note on `synthIsAdmin` in token-identity.ts.
     */
    identity?: {
        userId: UserId;
        username: string;
        userGroups: string[];
        /**
         * The admin verdict for this identity — `resolveOwnerAdminStatus()`'s
         * Formula A (`isAdminOverride ?? (hasGroupPermission(effectiveGroups,
         * ADMIN_GROUPS) || inAppIsAdmin)`, security review 2026-09-23, C6),
         * NEVER a raw `isUserAdmin(userGroups)` re-derivation.
         *
         * Fix round 1 (Critical), implemented in the ONE shared producer
         * (`token-identity.ts`'s `resolveTokenIdentity()` — NOT two
         * independently-fixed call sites; `forward-auth.ts` no longer has
         * its own copy since fix-plan-5 Task 3 folded it in here): for an
         * IMPERSONATING service token, `userGroups` above is a REAL user's
         * current IdP groups — a pin-demoted admin (`admin_pinned:true,
         * is_admin:false`) whose stale IdP groups still include the admin
         * group would make a naive `isUserAdmin(userGroups)` at the
         * mount.ts call site return `true` where the pin-aware formula says
         * `false`. Same defect existed for the PAT branch's
         * `validated.groups`. `mount.ts` CONSUMES this field's verdict
         * instead of re-deriving it. The producer resolves it two ways, per
         * axis, both Formula A: the PAT owner and the non-impersonating
         * service-token creator go through `resolveOwnerAdminStatus()` /
         * `resolveOwnerIsAdminFailClosed()`; the impersonation TARGET
         * (`token-identity.ts:~731-732`) goes through `resolveInAppAccess()`
         * + `buildUserPermissions()` directly, inlined rather than reusing
         * `resolveOwnerAdminStatus()` because this module already has the
         * target row open — both implement the SAME Formula A.
         *
         * For a NON-impersonating service token, `userGroups` is the
         * SYNTHETIC set (`['admin']`/`[]`) derived from the token's own
         * scope+forceNonAdmin AND the CREATOR's current admin status
         * (`synthIsAdmin` — fix round 2, C3, security review 2026-09-15: this
         * used to be scope-only, which is the "demoted-creator asymmetry" the
         * 2026-09-13 round deliberately deferred; C6 additionally folds the
         * creator's in-app `admin` capability in when unpinned).
         * `forward-auth.ts`'s non-impersonating branch is fixed identically,
         * via the same shared `resolveOwnerIsAdminFailClosed()` /
         * `resolveOwnerAdminStatus()` formula.
         */
        ownerIsAdmin: boolean;
    };

    /**
     * The credential's `forceNonAdmin` kill-switch. PATs have carried this
     * column since migration 16.255.0 (mirroring `service_tokens`), so this
     * is populated for both token kinds, not just service tokens — see the
     * PAT branch above (`validated.forceNonAdmin`) in `authenticate()`.
     * Threaded through so
     * mount.ts's `enforce()` {kind:'scope'} fallback can pass the REAL value
     * to `buildPrincipal()` instead of hardcoding `false` — otherwise a
     * sandboxed service token's synthetic `['admin']` group (see `identity`
     * above) could make `ownerIsAdmin` true while the kill-switch that is
     * supposed to veto it never reached `deriveIsAdmin()`.
     */
    forceNonAdmin?: boolean;
}

/**
 * Thrown by authenticate() or requireScope() to signal auth failures.
 * Handlers inspect `status` to return the right HTTP response.
 */
export class ApiAuthError extends Error {
    /** Matches the `knownError.statusCode` check in withErrorHandler. */
    readonly statusCode: 401 | 403;

    constructor(status: 401 | 403, message: string) {
        super(message);
        this.name = 'ApiAuthError';
        this.statusCode = status;
    }
}

/**
 * Map a `token-identity.ts` `TokenDenial` to `ApiAuthError`, preserving this
 * module's PRE-EXISTING outward mapping exactly: a 405 (method not
 * permitted) and a 500 (impersonation lookup failure) both become 403 here,
 * same as before this extraction — `ApiAuthError` only ever carries 401 or
 * 403 (`mount.ts:224-226` turns a 403 into `scopeRequired`). The shared
 * producer's `/api/v1` (`forward-auth.ts`) adapter maps the SAME denial to
 * its own, different, byte-identical-to-before Response (405 stays 405
 * there) — see `denialToResponse()` in forward-auth.ts.
 */
function denialToApiAuthError(denial: TokenDenial): ApiAuthError {
    const status = denial.status === 401 ? 401 : 403;
    return new ApiAuthError(status, denial.message ?? denial.error);
}

/**
 * Map a plan-defined task scope to the flat scope(s) that grant it.
 * 'admin' grants everything. 'write' and 'read' grant NO task scope: not
 * 'tasks:read' (2026-09-18 fix-plan-4, Shape C ruling — it used to be granted
 * here, which is what let findings C2/C4/C5 recur) and, since 2026-10-07, not
 * 'runs:read' either (run inputs/errors are operator data). Both now require
 * 'tasks:admin' (or the coarse 'admin' alias above). This does NOT mean
 * 'write'/'read' grant nothing else in this function — five OTHER (non-task)
 * cases below (`media:read`, `media:write`, `sessions:read`, `sessions:write`,
 * `requests:read`) carry their own bare `includes('read')`/`includes('write')` shortcut; the
 * exhaustive set a plain non-admin session can satisfy is documented once,
 * in `define.ts`'s `{kind:'scope'}` docstring (`SAFE_NON_ADMIN_SCOPES` in
 * `defs-scope-non-admin-sweep.test.ts`), not restated here to avoid a second
 * copy that can drift.
 *
 * tasks:run requires an explicit 'tasks:run' or 'tasks:admin' scope (or
 * 'admin'). It is deliberately NOT granted by the generic 'write' scope:
 * 'write' is the user-data mutation scope (rate/watchlist/playlist/etc., gated
 * at the HTTP-method layer in handlePublicApiAuth), and triggering background
 * system tasks is an admin operation, not user-data write. Since 'tasks:run'
 * is not a user-mintable PAT scope, after this only admin sessions, admin PATs,
 * and service tokens with an explicit task scope can run tasks. Mirrors the
 * existing 'webhooks:write' boundary below.
 */
export function scopeGranted(tokenScopes: string[], required: ApiScope): boolean {
    if (tokenScopes.includes('admin')) return true;

    switch (required) {
        // SPLIT (2026-09-18 fix-plan-4, Shape C ruling — ledger.md "Design
        // rulings"). These two cases used to share one arm, both granted by
        // the bare 'read'/'write' scopes. That is the SECOND independent
        // producer of the same auto-grant `principal.ts`'s `expandScopes`
        // implements (mount.ts's `{kind:'scope'}` branch calls THIS function
        // directly with the already-expanded scope set, and this function's
        // own 'read'/'write' checks re-granted `tasks:read` regardless of
        // what expandScopes did — fixing only principal.ts was a no-op).
        case 'tasks:read':
            // 'read'/'write' no longer imply this. `tasks:read` is not a
            // mintable PAT/service-token scope (patScopeSchema /
            // serviceTokenScopeSchema in schemas/admin.ts), so in practice
            // this now requires 'tasks:admin' (or the 'admin' early return
            // above) — matching the five endpoints the ruling moved to
            // `tasks:admin` as belt-and-braces.
            return tokenScopes.includes('tasks:read') || tokenScopes.includes('tasks:admin');
        case 'runs:read':
            // 'read'/'write' no longer imply this (2026-10-07, reverses the
            // 2026-09-13 P4 ruling — see principal.ts expandScopes): run
            // inputs, scopes and errors are operator data.
            return (
                tokenScopes.includes('runs:read') ||
                tokenScopes.includes('tasks:run') || // a runner can read its runs
                tokenScopes.includes('tasks:admin')
            );
        case 'tasks:run':
            // NOTE: 'write' intentionally omitted — see the function docstring.
            return tokenScopes.includes('tasks:run') || tokenScopes.includes('tasks:admin');
        case 'webhooks:write':
            // `write` does NOT grant webhooks:write — requires explicit grant.
            // A generic write scope must not bootstrap privileged webhook access.
            return tokenScopes.includes('webhooks:write') || tokenScopes.includes('tasks:admin');
        case 'tasks:admin':
            return tokenScopes.includes('tasks:admin');
        // D7 hierarchical expansions (api-v1-admin-design.md §1):
        case 'users:read':
            return tokenScopes.includes('users:read') || tokenScopes.includes('users:admin');
        case 'users:admin':
            return tokenScopes.includes('users:admin');
        case 'access:admin':
            return tokenScopes.includes('access:admin');
        case 'tokens:admin':
            return tokenScopes.includes('tokens:admin');
        case 'library:read':
            return tokenScopes.includes('library:read') || tokenScopes.includes('library:admin');
        case 'library:admin':
            return tokenScopes.includes('library:admin');
        case 'media:read':
            return (
                tokenScopes.includes('read') ||
                tokenScopes.includes('write') ||
                tokenScopes.includes('media:read') ||
                tokenScopes.includes('media:write') ||
                tokenScopes.includes('media:admin')
            );
        case 'media:write':
            return (
                tokenScopes.includes('write') ||
                tokenScopes.includes('media:write') ||
                tokenScopes.includes('media:admin')
            );
        case 'media:admin':
            return tokenScopes.includes('media:admin');
        case 'livetv:admin':
            return tokenScopes.includes('livetv:admin');
        case 'providers:read':
            return (
                tokenScopes.includes('providers:read') || tokenScopes.includes('providers:admin')
            );
        case 'providers:admin':
            return tokenScopes.includes('providers:admin');
        case 'playback:read':
            return tokenScopes.includes('playback:read') || tokenScopes.includes('playback:admin');
        case 'playback:admin':
            return tokenScopes.includes('playback:admin');
        case 'metrics:read':
            // tasks:admin and tasks:read also grant metrics:read. Before the
            // 2026-09-18 fix-plan-4 Shape C ruling, `tasks:read` was
            // auto-granted to every non-admin session (see the `case
            // 'tasks:read'` split above), so this transitively handed
            // /metrics, /api/health/components and /api/tasks/{metrics,trends}
            // to every logged-in user — a NEW finding folded into that task,
            // never in security review 4. `tokenScopes.includes('tasks:read')`
            // is now reachable only via `tasks:admin` (already checked above)
            // or the literal, non-mintable string 'tasks:read', so the
            // transitive grant closes as a side effect of that split.
            return (
                tokenScopes.includes('metrics:read') ||
                tokenScopes.includes('tasks:admin') ||
                tokenScopes.includes('tasks:read')
            );
        case 'sessions:read':
            return (
                tokenScopes.includes('read') ||
                tokenScopes.includes('write') ||
                tokenScopes.includes('sessions:read') ||
                tokenScopes.includes('sessions:write')
            );
        case 'sessions:write':
            return tokenScopes.includes('write') || tokenScopes.includes('sessions:write');
        case 'requests:read':
            return (
                tokenScopes.includes('read') ||
                tokenScopes.includes('write') ||
                tokenScopes.includes('requests:read') ||
                tokenScopes.includes('requests:admin')
            );
        case 'requests:admin':
            return tokenScopes.includes('requests:admin');
        default:
            // For any scope not explicitly listed, check direct inclusion only.
            // This handles future scopes without requiring api-auth.ts updates.
            return tokenScopes.includes(required);
    }
}

/**
 * Extract and validate a Bearer token from the Authorization header.
 *
 * `/api/v1/*` is a BEARER-ONLY token surface: identity comes solely from a
 * PAT (`pat_`) or service token (`svc_`). A session cookie does NOT authorize
 * on `/api/v1` (the old cookie bridge is gone) — the browser admin/ops UI uses
 * the cookie/forward-auth `/api/*` mirror instead.
 *
 * On the internal `/api/*` surface (NOT `/api/v1`), the shared admin handlers
 * (e.g. secrets-rotate, system-health/invariants) are reached by the logged-in
 * admin's cookie/forward-auth session, which the middleware materializes onto
 * `event.locals`. When no Bearer is present there we fall back to that admin
 * identity (see `internalAdminAuth`). Throws ApiAuthError(401) if no valid
 * credential can be resolved.
 */
export type ApiAuthRequest = Pick<RequestEvent, 'request' | 'url' | 'getClientAddress'> & {
    locals: Partial<RequestEvent['locals']>;
};

export async function authenticate(event: ApiAuthRequest): Promise<ApiAuth> {
    // RFC 7235 §2.1 — the auth scheme name is case-insensitive ("Bearer" /
    // "bearer" / "BEARER" all valid). Allow any whitespace between scheme
    // and token. Some clients (Swift's URLSession, older curl) emit lowercase.
    const raw = (event.request.headers.get('authorization') ?? '').trim();
    const match = /^bearer[ \t]+(\S.*)$/i.exec(raw);
    if (!match) {
        const adminAuth = internalAdminAuth(event);
        if (adminAuth) return adminAuth;
        throw new ApiAuthError(401, 'Bearer token required');
    }
    const token = match[1].trim();
    if (!token) {
        const adminAuth = internalAdminAuth(event);
        if (adminAuth) return adminAuth;
        throw new ApiAuthError(401, 'Bearer token required');
    }

    if (token.startsWith('pat_') || token.startsWith('svc_')) {
        // FIX (security review 5, fix-plan-5 Task 3): this used to be two
        // independent branches, each with its own credential validation and
        // identity resolution. Both now go through the SAME shared producer
        // (`$lib/server/auth/token-identity.ts`) that `forward-auth.ts` and
        // `resolve-bearer-principal.ts` use — see that module's doc comment
        // for why (C1: an impersonating svc token used to be judged by its
        // CREATOR here via `resolveServiceTokenIdentity()`, deleted below,
        // instead of its TARGET; C2/IP outage: `validate(token)` used to be
        // called with no client IP at all, so an IP-allowlisted token was
        // rejected here even from an allowed peer, AND the envelope gate
        // below — which THIS branch already enforced correctly — now also
        // reaches `resolve-bearer-principal.ts`'s /api/admin TERTIARY arm,
        // which enforced neither field before this fix).
        const ctx: TokenRequestCtx = {
            clientIp: getClientIpStrict(event),
            method: event.request.method,
            // The routed path, as forward-auth passes it: an encoded or
            // locale-prefixed spelling is judged by the route it reaches.
            pathname: routedPathname(event.url),
        };

        const step1 = await validateBearerCredential(token, ctx);
        if (!step1.ok) throw denialToApiAuthError(step1.denial);
        const { credential } = step1;

        const step2 = await resolveTokenIdentity(credential, { resolveJellyfinId: false });
        if (!step2.ok) throw denialToApiAuthError(step2.denial);
        const { userContext } = step2.identity;

        if (credential.kind === 'pat') {
            const { validated } = credential;
            // forceNonAdmin: strip EVERY admin-class scope, symmetrically
            // with the service-token branch below — a forceNonAdmin PAT
            // reaching this {kind:'scope'} fallback previously kept its raw
            // admin-class scope here (this branch never stripped it), so
            // `requireScope()`/mount.ts's Principal build relied solely on
            // `forceNonAdmin` being threaded through to veto it — which this
            // branch also never did (no `forceNonAdmin` field on the
            // returned `ApiAuth` for PAT at all). Both gaps close together:
            // a single kill-switch check, applied the same way for both
            // token kinds, rather than two independently-maintained copies.
            //
            // Demoted owner (2026-10-02): the SAME predicate buildPrincipal()
            // uses also strips when the owner is not currently admin
            // (userContext.isAdmin = the producer's Formula-A verdict), so an
            // `['admin']` PAT of a demoted admin cannot pass requireScope()
            // here either.
            const effectiveScopes = stripsAdminScopesForToken(credential.kind, {
                ownerIsAdmin: userContext.ownerIsAdmin,
                forceNonAdmin: validated.forceNonAdmin ?? false,
            })
                ? stripAdminScopes(validated.scopes)
                : validated.scopes;
            return {
                tokenKind: 'pat',
                tokenId: String(validated.id),
                userId: validated.username,
                scopes: effectiveScopes,
                identity: {
                    userId: userContext.userId,
                    username: userContext.username,
                    userGroups: userContext.userGroups,
                    // Fix round 1 (Critical), unchanged by this extraction:
                    // Formula A via the shared producer, not a raw
                    // isUserAdmin(groups) re-derivation.
                    ownerIsAdmin: userContext.ownerIsAdmin,
                },
                forceNonAdmin: validated.forceNonAdmin,
            };
        }

        // Service token.
        const { validated } = credential;
        // forceNonAdmin: strip EVERY admin-class scope ('admin' and each
        // '<area>:admin'), with the same helper buildPrincipal() uses, so this
        // legacy path and the Principal path cannot disagree on what a
        // sandboxed token may do. Filtering only 'admin'/'tasks:admin' left
        // users:admin, livetv:admin, … intact (security review 2026-09-12, C2).
        // Also strips when the creator (or impersonation target) is not
        // currently admin — same shared predicate as buildPrincipal().
        const effectiveScopes = stripsAdminScopesForToken(credential.kind, {
            ownerIsAdmin: userContext.ownerIsAdmin,
            forceNonAdmin: validated.forceNonAdmin ?? false,
        })
            ? stripAdminScopes(validated.scopes)
            : validated.scopes;

        const userId = validated.actAsUser ?? `service:${validated.id}`;
        return {
            tokenKind: 'svc',
            tokenId: String(validated.id),
            userId,
            scopes: effectiveScopes,
            identity: {
                userId: userContext.userId,
                username: userContext.username,
                userGroups: userContext.userGroups,
                // C1 fix: for an impersonating token this is now the
                // TARGET's post-downgrade Formula-A verdict (the shared
                // producer's impersonation branch), not the creator's —
                // mount.ts's buildPrincipal() call still ALSO gates on
                // `auth.scopes`/`auth.forceNonAdmin`, so this can double-gate
                // harmlessly but never under- or over-grant on its own.
                ownerIsAdmin: userContext.ownerIsAdmin,
            },
            forceNonAdmin: validated.forceNonAdmin,
        };
    }

    // A device-flow JWT reaching here is a VALID credential that this surface
    // simply does not accept — not a bad token. On /api/v1 forward-auth has
    // already verified the JWT and populated locals.principal (kind 'bearer')
    // before the handler runs, so its presence proves the token is good; an
    // invalid or expired one would have been rejected with 401 upstream and
    // never reached this line.
    //
    // The distinction matters to clients, not just to pedantry. A 401 whose
    // body carries `error: "invalid_token"` is the conventional "your session
    // is dead — log out and re-authenticate" signal, and well-behaved clients
    // act on it. Returning that for a PERMANENT capability failure makes them
    // bounce the user to a login screen for something re-authenticating can
    // never fix. 403 says "you are who you say you are, and still may not do
    // this", which is both true and actionable.
    if (event.locals.principal?.kind === 'bearer') {
        throw new ApiAuthError(
            403,
            'This endpoint requires an admin PAT or service token. A device-flow ' +
                'token cannot be used here — re-authenticating will not grant access.',
        );
    }

    throw new ApiAuthError(401, 'Bearer token must start with pat_ or svc_');
}

/**
 * Internal-surface admin fallback for shared handlers reached WITHOUT a Bearer.
 *
 * The cookie/forward-auth `/api/*` mirror routes (e.g. /api/admin/secrets/rotate)
 * share a handler with their `/api/v1` token-surface twin. On `/api/*` the
 * logged-in admin is identified by the session/forward-auth middleware, which
 * sets `event.locals.principal` / `event.locals.user`. When such a request
 * carries no Bearer token, authorize it here from that established admin identity
 * and synthesize scopes=['admin'] (scopeGranted() treats it as granting every
 * ApiScope). Returns null for non-admins.
 *
 * SECURITY: this is strictly the INTERNAL surface. `/api/v1/*` is a bearer-only
 * edge bypass where forward-auth headers are untrusted and no session cookie is
 * materialized — so this fallback NEVER fires there (the path guard makes that
 * explicit even though `locals` would be empty on `/api/v1` anyway).
 */
function internalAdminAuth(event: ApiAuthRequest): ApiAuth | null {
    if (event.url.pathname.startsWith('/api/v1/')) return null;
    const user = event.locals.user;
    // No delegateToAdmin() mark here: this fallback mints a synthetic ['admin']
    // scope set, wider than any outer scope gate. A delegated Bearer caller is
    // re-validated on its own token above; a cookie caller that passed an
    // admin-scope gate is an admin session already.
    const isAdmin = localsIsAdmin(event.locals);
    if (!isAdmin) return null;
    const username = event.locals.principal?.username ?? user?.username;
    if (!username) return null;
    return {
        tokenKind: 'pat',
        tokenId: `session:${username}`,
        userId: username,
        scopes: ['admin'],
    };
}

/**
 * Throw ApiAuthError(403) if none of the required scopes are granted.
 */
export function requireScope(auth: ApiAuth, ...scopes: ApiScope[]): void {
    const granted = scopes.some((s) => scopeGranted(auth.scopes, s));
    if (!granted) {
        throw new ApiAuthError(403, `Insufficient scope. Required one of: ${scopes.join(', ')}`);
    }
}
