// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ONE shared producer that turns a raw `pat_`/`svc_` Bearer credential
 * into a validated token plus a resolved `Principal`/`UserContext`, for every
 * plane that needs it:
 *
 *   - `forward-auth.ts`'s `handlePatAuth` / `handleServiceTokenAuth` (the
 *     `/api/v1` PRIMARY authority).
 *   - `resolve-bearer-principal.ts`'s `resolveBearerAdminPrincipal()` (the
 *     `/api/admin/*` TERTIARY fallback used by `mount.ts`, `requireAdmin()`
 *     and `callerIsAdmin()`).
 *   - `tasks/api-auth.ts`'s `authenticate()` (the `{kind:'scope'}` fallback,
 *     also re-invoked by five `/api/v1` handlers that re-authenticate).
 *
 * FIX (security review 5, 2026-09-23, fix-plan-5 Task 3 — C1, C2, the IP
 * outage). Before this module existed, `/api/v1` and `/api/admin/*` each
 * built their own Principal for the SAME credential and disagreed on THREE
 * axes:
 *
 *   - **C1** — an impersonating admin-scoped service token was judged by its
 *     TARGET on `/api/v1` (`forward-auth.ts`'s old `handleServiceTokenAuth`)
 *     but by its CREATOR on `/api/admin/*`
 *     (`resolve-bearer-principal.ts:128`'s old
 *     `resolveOwnerAdminStatus(sql, validated.createdBy)`, which never read
 *     `validated.actAsUser` at all).
 *   - **C2** — a service token's `allowedPathPrefixes`/`allowedMethods`
 *     envelope was enforced on `/api/v1` (`forward-auth.ts`) and in the
 *     `{kind:'scope'}` fallback (`tasks/api-auth.ts`) but NEVER on the
 *     `/api/admin/*` TERTIARY/`requireAdmin`/`callerIsAdmin` fallbacks
 *     (`resolve-bearer-principal.ts` called `svc.validate(token)` and read
 *     neither field) — a path/method-restricted "monitoring" token was a
 *     full unrestricted admin credential there.
 *   - **IP outage** — `resolve-bearer-principal.ts` and
 *     `tasks/api-auth.ts`'s `authenticate()` both called `validate(token)`
 *     with NO client IP, so an `allowed_ips`-restricted token was REJECTED
 *     on `/api/admin/*` even from an allowed peer (the opposite failure mode
 *     from C1/C2: always-deny instead of never-check) and silently
 *     overwrote `last_used_ip` with NULL on every such call.
 *
 * All three planes now call the SAME two steps below, so a fix to one axis
 * (target-vs-creator, envelope, IP) fixes it on every plane at once instead
 * of needing three coordinated patches that can silently re-diverge.
 *
 * Two exported steps, not one combined function, because
 * `resolveBearerAdminPrincipal()` needs to keep its cheap short-circuits
 * (`forceNonAdmin`, "no admin-class scope at all") BETWEEN credential
 * validation and the identity DB round trip — those short-circuits are
 * safe (they only ever change a `null` vs a resolved verdict for a token
 * that could never be admin-eligible anyway) and skipping the round trip
 * for every non-admin-scoped token keeps that path cheap:
 *
 *   1. {@link validateBearerCredential} — `validate()` against the owning
 *      service (which itself enforces `allowed_ips`/revocation/expiry/
 *      owner-lifecycle by `owner_user_id` and persists `last_used_ip`/
 *      `last_used_at`), PLUS the shared envelope gate
 *      ({@link tokenEnvelopeDenial}) and the `integrations:read` grant's
 *      built-in `/api/v1/integrations/` envelope, applied
 *      UNCONDITIONALLY to both token kinds' `validated` shape — but PATs
 *      carry no `allowedPathPrefixes`/`allowedMethods` columns at all, so it
 *      is structurally a no-op for them today; only service tokens can
 *      actually be denied by it. No identity DB work beyond `validate()`
 *      itself. The `/api/v1`-
 *      only read-scope-vs-method gate ({@link v1ScopeMethodDenial}) is
 *      deliberately NOT part of this step — see that function's doc comment
 *      for why.
 *   2. {@link resolveTokenIdentity} — Formula A identity resolution: a PAT
 *      owner's or an impersonation TARGET's resolved `UserContext` (via
 *      `resolveTokenUserAccess`/`resolveInAppAccess` + `buildUserPermissions`,
 *      the SAME formula every other admin surface uses since the 2026-09-23
 *      C6 fix), or the OWNER's fail-closed verdict by id
 *      (`resolveOwnerIsAdminFailClosedById`) for a non-impersonating service
 *      token. Builds the `Principal` too, since every field it needs
 *      (`kind`, `credentialId`, `userGroups`, `ownerIsAdmin`,
 *      `forceNonAdmin`) is already resolved by this point.
 *
 * Reconciling the two former copies (research doc `research-shape-a.md`
 * §Q1): kept FA's id-keyed, uncached impersonation-target query (which
 * already selected `deleted_at` and the pin columns) over
 * `tasks/api-auth.ts`'s old `getUserById` + a SECOND username-keyed
 * `resolveOwnerIsAdminFailClosed()` round trip for the same row — the two
 * were computing the same Formula-A verdict via two different, divergent
 * code paths (FA's target axis was already Formula A via
 * `resolveInAppAccess`+`buildUserPermissions`; AA's was Formula B via the
 * fail-closed wrapper). The non-impersonating owner axis is `validate()`'s
 * fail-closed, id-keyed `isOwnerActive` (API package 15 replaced the
 * username-keyed creator checks, including FA's fail-open
 * `isUsernameDisabled()`, with the owner's `users.id`). Adopted
 * `tasks/api-auth.ts`'s envelope semantics (skip empty-string prefixes,
 * case-insensitive methods) over FA's (empty prefix = allow-all, case-
 * sensitive methods) — see {@link tokenEnvelopeDenial}'s doc comment for the
 * two resulting `/api/v1` behaviour deltas.
 *
 * `getClientIpStrict(event)` is computed ONCE by each plane's own adapter
 * (it needs the `RequestEvent`) and passed in via {@link TokenRequestCtx};
 * this module never calls it itself.
 *
 * Target lifecycle (`isLifecycleActive`) is checked HERE, in the producer,
 * exactly once — NOT inside `validate()` (which only ever checks the
 * OWNER's lifecycle via `isOwnerActive`). Do not add a second copy
 * inside `validate()`: that would require bringing back the id-keyed target
 * fetch this module already does (research §Q8).
 */

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import { buildUserPermissions, type UserPermissions } from '$lib/server/auth.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import { Logger } from '$lib/server/utils/logger.js';
// getPatService()/getServiceTokenService() are imported DYNAMICALLY inside
// validateBearerCredential() below, not statically here — pat.service.ts and
// service-token.service.ts both statically import the (large — CatalogService,
// UserRatingsService, embedding services, …) `database/connection.js` for
// their `Database` class. forward-auth.ts's original handlePatAuth/
// handleServiceTokenAuth already deferred this via `await import(...)`;
// making it a static top-level import here would force every consumer of
// this module (RBP, `authenticate()`, and every existing test that mocks
// neither pat.service.js's nor service-token.service.js's OWN transitive
// `database/connection.js` chain) to eagerly load that whole graph — this
// broke several forward-auth-*.test.ts files during this fix's own testing
// (a `plugin-context.ts` module-scope `new TaskRegistry()` reads
// `FEATURE_PER_TASK_QUEUES` at import time, which those tests' `config.js`
// mocks never had reason to provide).
import type { ValidatedPat } from '$lib/server/oauth/pat.service.js';
import type { ValidatedServiceToken } from '$lib/server/oauth/service-token.service.js';
import {
    resolveTokenUserAccess,
    computeOwnerMaxAge,
    mergeMaxAge,
    MOST_RESTRICTIVE_AGE_RATING,
} from '$lib/server/auth/resolve-token-user-access.js';
import {
    computeOwnerIsAdminOverride,
    resolveOwnerIsAdminFailClosedById,
} from '$lib/server/auth/resolve-owner-admin-status.js';
import { isLifecycleActive } from '$lib/server/auth/user-lifecycle.js';
import { resolveEffectiveAccess } from '$lib/server/services/access-control.service.js';
import {
    INTEGRATIONS_GRANT,
    integrationsGrantPathDenial,
} from '$lib/server/auth/integration-token.js';
import {
    DIAGNOSTICS_GRANT,
    diagnosticsGrantPathDenial,
} from '$lib/server/auth/diagnostics-grant.js';

const logger = Logger.for('Auth');

// =============================================================================
// SHARED TYPES
// =============================================================================

export interface TokenDenial {
    status: 401 | 403 | 405 | 500;
    error: string;
    /**
     * Omitted (not just empty) for the two envelope denials — matching
     * `/api/v1`'s pre-existing response bodies, which carry only `{error}`
     * with no `message` key. Every other denial carries both.
     */
    message?: string;
}

export interface TokenRequestCtx {
    clientIp: string;
    method: string;
    pathname: string;
}

export type ValidatedBearerCredential =
    | { kind: 'pat'; validated: ValidatedPat }
    | { kind: 'service_token'; validated: ValidatedServiceToken };

export type CredentialResult =
    { ok: true; credential: ValidatedBearerCredential } | { ok: false; denial: TokenDenial };

export interface TokenIdentityOutcome {
    userContext: UserContext;
    principal: Principal;
    /** Only ever set for an impersonating service token when `resolveJellyfinId` is not `false`. */
    jellyfinUserId?: string;
}

export type TokenIdentityResult =
    { ok: true; identity: TokenIdentityOutcome } | { ok: false; denial: TokenDenial };

// =============================================================================
// SHARED ENVELOPE GATE (research §Q2)
// =============================================================================

/**
 * The ONE path/method envelope rule for a service token's
 * `allowedPathPrefixes`/`allowedMethods`, shared by every plane.
 *
 * Adopts `tasks/api-auth.ts`'s pre-existing semantics over
 * `forward-auth.ts`'s:
 *   - An empty-string prefix contributes NO match (fails closed). FA used to
 *     turn `''` into boundary `'/'`, which matched every path — a hand-
 *     minted `['']` prefix list was an allow-all on `/api/v1` before this
 *     fix. **Behaviour delta on `/api/v1`:** a token minted with
 *     `allowedPathPrefixes: ['']` now denies every path instead of allowing
 *     every path (fail closed) — see
 *     `forward-auth-token-envelope.test.ts`'s "empty prefix list" case.
 *   - Methods are compared case-insensitively (both sides upper-cased). FA
 *     used to compare case-sensitively, so a token minted with e.g.
 *     `['get']` 405'd every `GET` on `/api/v1`. **Behaviour delta on
 *     `/api/v1`:** such a token is now accepted instead of 405'd — see the
 *     same test file's "lowercase method" case.
 *   - Denials carry 403 for a path miss and 405 for a method miss; /api/v1
 *     answers both as a 403 problem+json (`forbidden`, reason
 *     `method_not_permitted` for the method miss), and `authenticate()` maps
 *     405->403 at its own call site too.
 *
 * Consequence (accepted, per the fix-plan ruling): a prefix-bound token is
 * now denied on EVERY `/api/admin/*` route, `{kind:'admin'}` and
 * `{kind:'scope'}` alike — extending the `{kind:'scope'}` fallback's
 * existing verdict to the `{kind:'admin'}` TERTIARY/`requireAdmin`/
 * `callerIsAdmin` arms, which previously enforced neither field at all
 * (C2). This matches the documented design premise
 * (`schemas/admin.ts:431-436`), which was false at HEAD before this fix.
 */
export function tokenEnvelopeDenial(
    validated: { allowedPathPrefixes?: string[] | null; allowedMethods?: string[] | null },
    pathname: string,
    method: string,
): TokenDenial | null {
    if (validated.allowedPathPrefixes && validated.allowedPathPrefixes.length > 0) {
        const matched = validated.allowedPathPrefixes.some((prefix) => {
            if (!prefix) return false;
            if (pathname === prefix) return true;
            const boundary = prefix.endsWith('/') ? prefix : prefix + '/';
            return pathname.startsWith(boundary);
        });
        if (!matched) {
            return { status: 403, error: 'Token not permitted on this endpoint' };
        }
    }

    if (validated.allowedMethods && validated.allowedMethods.length > 0) {
        const reqMethod = method.toUpperCase();
        const allowed = validated.allowedMethods.map((m) => m.toUpperCase());
        if (!allowed.includes(reqMethod)) {
            return { status: 405, error: 'Method not permitted by token' };
        }
    }

    return null;
}

/**
 * The `/api/v1`-only "read scope (no literal `'admin'`/`'write'`) is
 * GET/HEAD-only" method gate — a flat-scope-vocabulary policy specific to
 * `/api/v1`'s own token surface. Collapsed from two byte-identical private
 * copies in `forward-auth.ts` (Global Constraint 4, Task 3 review Important
 * 3): the PAT branch called `patService.hasScope(validated, 'write')` and
 * the service-token branch inlined `scopes.includes('admin') ||
 * scopes.includes('write')` — both computing the exact same predicate.
 *
 * Deliberately NOT part of {@link validateBearerCredential} (the shared step
 * 1 every plane calls): it only recognises the literal `'admin'`/`'write'`
 * scopes, not D7 hierarchical ones (`library:admin`, `users:admin`, …), so
 * running it on the internal `/api/admin/*` surface would pre-empt a
 * `{kind:'scope'}` def's own `anyOf` check for a token legitimately scoped
 * ONLY to one of those — see `validateBearerCredential`'s doc comment for
 * the regression this caused when it was folded in during this fix's own
 * testing. `forward-auth.ts`'s `handlePatAuth`/`handleServiceTokenAuth` are
 * the ONLY callers.
 */
export function v1ScopeMethodDenial(scopes: string[], method: string): TokenDenial | null {
    if (method === 'GET' || method === 'HEAD') return null;
    if (scopes.includes('admin') || scopes.includes('write')) return null;
    return {
        status: 403,
        error: 'insufficient_scope',
        message: `Token requires 'write' or 'admin' scope for ${method} requests`,
    };
}

// =============================================================================
// STEP 1: CREDENTIAL VALIDATION + ENVELOPE
// =============================================================================

/**
 * Validate a raw `pat_`/`svc_` Bearer token against its owning service (IP
 * allowlist, revocation, expiry, creator lifecycle — all inside
 * `validate()`), then apply the shared envelope ({@link tokenEnvelopeDenial}).
 * No identity DB work beyond `validate()` itself — see
 * {@link resolveTokenIdentity} for that. The `/api/v1`-only read-scope-vs-
 * method gate is NOT applied here — see {@link v1ScopeMethodDenial}'s doc
 * comment for why, and `forward-auth.ts`'s two adapters for where it runs.
 *
 * `ctx.clientIp` MUST be `getClientIpStrict(event)` — passing anything else
 * (or omitting the IP check) is exactly the IP-outage/IP-bypass class this
 * module exists to close for every plane, not just `/api/v1`.
 */
export async function validateBearerCredential(
    token: string,
    ctx: TokenRequestCtx,
): Promise<CredentialResult> {
    if (token.startsWith('pat_')) {
        const { getPatService } = await import('$lib/server/oauth/pat.service.js');
        const patService = getPatService();
        const validated = await patService.validate(token, ctx.clientIp).catch((error: unknown) => {
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            throw error;
        });
        if (!validated) {
            logger.warn('PAT REJECTED: Invalid or expired personal access token', {
                path: ctx.pathname,
                tokenPrefix: token.substring(0, 12) + '...',
                clientIp: ctx.clientIp,
                hint: 'PAT may be expired, revoked, or IP not whitelisted',
            });
            return {
                ok: false,
                denial: {
                    status: 401,
                    error: 'invalid_token',
                    message: 'Invalid or expired personal access token',
                },
            };
        }

        // NOTE: the /api/v1-only "read scope = GET/HEAD only" method gate
        // ({@link v1ScopeMethodDenial}) is DELIBERATELY NOT enforced here.
        // It is /api/v1-specific policy — PAT scopes on the internal
        // `/api/admin/*` surface are gated per-def by `{kind:'scope'}`'s own
        // `anyOf` (e.g. `library:admin`), which this step must not pre-empt:
        // a token scoped only `library:admin` (no literal `write`/`admin`)
        // legitimately POSTs to a `library:admin` def, but would fail a bare
        // `v1ScopeMethodDenial` check (that helper only recognises the
        // literal `'admin'`/`'write'` scopes, not D7 hierarchical ones).
        // Folding this into the shared step regressed exactly that case
        // during this fix's own testing. `forward-auth.ts`'s
        // `handlePatAuth` calls the shared `v1ScopeMethodDenial()` helper
        // itself, for `/api/v1` only — see that function.
        return { ok: true, credential: { kind: 'pat', validated } };
    }

    if (token.startsWith('svc_')) {
        const { getServiceTokenService } =
            await import('$lib/server/oauth/service-token.service.js');
        const serviceTokenService = getServiceTokenService();
        const validated = await serviceTokenService
            .validate(token, ctx.clientIp)
            .catch((error: unknown) => {
                if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
                throw error;
            });
        if (!validated) {
            logger.warn('SERVICE TOKEN REJECTED: Invalid or expired service token', {
                path: ctx.pathname,
                tokenPrefix: token.substring(0, 12) + '...',
                clientIp: ctx.clientIp,
                hint: 'Service token may be expired, revoked, or IP not whitelisted',
            });
            return {
                ok: false,
                denial: {
                    status: 401,
                    error: 'invalid_token',
                    message: 'Invalid or expired service token',
                },
            };
        }

        const envelopeDenial = tokenEnvelopeDenial(validated, ctx.pathname, ctx.method);
        if (envelopeDenial) {
            logger.warn(
                envelopeDenial.status === 405
                    ? 'Service token rejected: method not in allowed_methods'
                    : 'Service token rejected: path not in allowed_path_prefixes',
                {
                    tokenPrefix: validated.tokenPrefix,
                    path: ctx.pathname,
                    method: ctx.method,
                    allowedPathPrefixes: validated.allowedPathPrefixes,
                    allowedMethods: validated.allowedMethods,
                },
            );
            return { ok: false, denial: envelopeDenial };
        }

        // The `integrations:read` grant's built-in envelope: such a token
        // authenticates only on the three integration endpoints, on any plane
        // (`/api/v1`, `/api/admin`, the `{kind:'scope'}` fallback), whatever
        // its stored path prefixes say. Every caller passes the routed path.
        const grantDenial = integrationsGrantPathDenial(validated.scopes, ctx.pathname);
        if (grantDenial) {
            logger.warn('Service token rejected: integrations grant outside its endpoints', {
                tokenPrefix: validated.tokenPrefix,
                path: ctx.pathname,
                method: ctx.method,
            });
            return { ok: false, denial: grantDenial };
        }

        // The `diagnostics:read` grant's built-in envelope: GET/HEAD on the
        // debug report and its exact drill-down templates only (spec
        // 2026-10-21 §6), on any plane, whatever the stored prefixes say.
        const diagnosticsDenial = diagnosticsGrantPathDenial(
            validated.scopes,
            ctx.pathname,
            ctx.method,
        );
        if (diagnosticsDenial) {
            logger.warn('Service token rejected: diagnostics grant outside the debug report', {
                tokenPrefix: validated.tokenPrefix,
                path: ctx.pathname,
                method: ctx.method,
            });
            return { ok: false, denial: diagnosticsDenial };
        }

        // NOTE: the /api/v1-only "read scope (no literal admin/write) = GET/
        // HEAD only" method gate ({@link v1ScopeMethodDenial}) is
        // DELIBERATELY NOT enforced here, for the exact reason the PAT
        // branch above isn't gated this way either: it would pre-empt the
        // internal `/api/admin/*` surface's own per-def `{kind:'scope'}`
        // gate for D7 hierarchical scopes like `library:admin` (neither
        // literally `'admin'` nor `'write'`, but a legitimate write-capable
        // scope for its own defs). Folding this into the shared step
        // regressed exactly that case during this fix's own testing.
        // `forward-auth.ts`'s `handleServiceTokenAuth` calls the shared
        // `v1ScopeMethodDenial()` helper itself, for `/api/v1` only — see
        // that function.

        return { ok: true, credential: { kind: 'service_token', validated } };
    }

    // Defensive only: every caller of this module already dispatches on the
    // `pat_`/`svc_` prefix before calling it (JWT/device-flow handling stays
    // in each plane's own adapter — it is not a shared-producer concern).
    return {
        ok: false,
        denial: { status: 401, error: 'invalid_token', message: 'Unrecognized token format' },
    };
}

// =============================================================================
// IN-APP ACCESS / AGE-MERGE HELPERS
//
// Moved from forward-auth.ts (both were previously private to that file).
// `resolveInAppAccess` is also still used by forward-auth.ts itself, for the
// native-session and SSO paths (`populateSessionUser`, `resolveDbAuth`'s
// caller) — it re-imports it from here rather than keeping a second copy.
// =============================================================================

/**
 * Resolve the in-app access layer (standalone multi-user) for a user id.
 * Native/bearer validation passes requireAvailable and throws on dependency
 * failure. The fallback policy below applies only to forward-auth callers.
 * Merge it with the synced/header groups. Best-effort and fail-open FOR
 * EVERY AXIS EXCEPT AGE: if the DB is down or the lookup throws, returns the
 * synced groups unchanged with no extra boolean/OR capabilities (most
 * importantly `isAdmin`, folded into Formula A — see
 * `resolve-owner-admin-status.ts`'s doc comment for the formula this feeds)
 * — the in-app layer may only ADD those, so an outage degrading to "nothing
 * extra" cannot escalate access, only under-grant an in-app-only cohort's
 * bonus permissions.
 *
 * `max_age_rating` is NOT additive, though (security review 2026-09-17,
 * C12): `access-control.service.ts` MIN-merges it specifically so "a
 * permissive cohort can never raise a user's age ceiling". An account whose
 * ONLY age restriction is in-app-cohort-conferred (no direct
 * `users.age_rating_pinned`) has that restriction dropped entirely by an
 * empty `extraCapabilities` — DURING the failure window, `mergeMaxAge`/
 * `buildUserPermissions` see no restriction from this layer at all, so the
 * user browses/streams above their configured ceiling for as long as the
 * fault lasts. That is a fail-OPEN on this one axis, not the fail-closed
 * "under-grant" every other field gets. The error path therefore reports
 * the MOST restrictive age ceiling ({@link MOST_RESTRICTIVE_AGE_RATING},
 * imported from `resolve-token-user-access.ts` rather than redeclared here
 * — that module's `resolveInAppAccessSafe` has the identical fix, for the
 * identical reason, for `resolveTokenUserAccess()`'s eleven token-derived-
 * UserContext callers (recounted security review 2026-09-23 final fix wave,
 * fix round 2 — the round-1 recount incorrectly lumped `user-notifier.
 * service.ts` in with the module tree): forward-auth.ts x2,
 * subsonic-compat/auth.ts x2, this module x1, the five /j
 * jellyfin-compat/assistant-service call sites, and `services/
 * user-notifier.service.ts` x1 — AGPL core, not a module — instead of
 * omitting the field — the same "unknown
 * means deny" posture that resolver already applies to a token request with
 * a cold cache.
 *
 * BLAST RADIUS (review round 1, Important 3 — this is intentionally broad,
 * not narrowly scoped to the in-app-cohort case the bug was found in): the
 * two error paths below return BEFORE any group/pin/capability membership
 * is resolved, so `maxAgeRating: MOST_RESTRICTIVE_AGE_RATING` (0) is fed
 * into the merge for EVERY non-admin caller on all three surfaces during the
 * failure window — including a user with NO in-app groups at all, and a
 * user with a PERMISSIVE per-user pin (`age_rating_pinned: true`,
 * `max_age_rating: 18`): `mergeMaxAge(pin, 0)` is `Math.min(pin, 0)` = `0`
 * whenever `pin` is a real number, so a pin does not protect against this —
 * only `isAdmin` does (short-circuits `maxAgeRating` to `null` in
 * `buildUserPermissions` regardless of what `extraCapabilities` says). With
 * `age-rating.builder.ts`'s `age_rating <= 0` filter, this means
 * EFFECTIVELY ALL RATED CONTENT IS HIDDEN FOR EVERY NON-ADMIN for as long as
 * the DB fault lasts. This is the correct, plan-mandated direction (an
 * outage must deny excess access, not grant it — the exact posture
 * `resolve-token-user-access.ts` already takes for a full deny on the
 * identical failure class) but it is NOT a narrow fix; an operator seeing
 * "the library went empty" during a DB blip should look here first.
 *
 * Cached per-user (60s) inside `resolveEffectiveAccess`, so the hot path
 * stays off the DB.
 */
export async function resolveInAppAccess(
    userId: string,
    syncedGroups: string[],
    options?: { requireAvailable?: boolean },
): Promise<{
    inAppGroupNames: string[];
    effectiveGroups: string[];
    extraCapabilities: Partial<UserPermissions>;
}> {
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql && options?.requireAvailable) throw new AuthDependencyUnavailableError();
        if (!sql)
            return {
                inAppGroupNames: [],
                effectiveGroups: syncedGroups,
                extraCapabilities: { maxAgeRating: MOST_RESTRICTIVE_AGE_RATING },
            };
        const resolved = await resolveEffectiveAccess(sql, userId, syncedGroups);
        return {
            inAppGroupNames: resolved.inAppGroupNames,
            effectiveGroups: resolved.effectiveGroups,
            extraCapabilities: resolved.capabilities,
        };
    } catch (e) {
        logger.warn('In-app access resolution failed; using synced groups only', {
            userId,
            error: String(e),
        });
        if (options?.requireAvailable && isDependencyError(e))
            throw new AuthDependencyUnavailableError(e);
        return {
            inAppGroupNames: [],
            effectiveGroups: syncedGroups,
            extraCapabilities: { maxAgeRating: MOST_RESTRICTIVE_AGE_RATING },
        };
    }
}

// =============================================================================
// STEP 2: IDENTITY RESOLUTION
// =============================================================================

async function resolvePatIdentity(validated: ValidatedPat): Promise<TokenIdentityResult> {
    // Formula A via resolveTokenUserAccess — the SAME canonical resolver the
    // /j and play-token paths use. `{ freshGroups: true }` is REQUIRED: PAT's
    // contract is per-request-fresh groups (pat.service.ts re-reads
    // users.groups on every validate() call); the resolver's own group cache
    // has a 10-minute TTL and would silently regress that guarantee without
    // this flag (fix-plan-5 research §Q1's mock-factory trap note; the
    // regression class itself is security review 5's C4).
    const tokenAccess = await resolveTokenUserAccess(validated.username, { freshGroups: true });
    if (!tokenAccess || tokenAccess.disabled || tokenAccess.deleted) {
        logger.warn('PAT REJECTED: token user access unresolvable, disabled, or deleted', {
            username: validated.username,
            tokenPrefix: validated.tokenPrefix,
        });
        return {
            ok: false,
            denial: {
                status: 401,
                error: 'invalid_token',
                message: 'Invalid or expired personal access token',
            },
        };
    }

    const userContext: UserContext = {
        userId: toUserId(validated.userId),
        username: validated.username,
        groups: tokenAccess.userGroups.join('|'),
        userGroups: tokenAccess.userGroups,
        ...tokenAccess.permissions,
    };

    const principal = buildPrincipal({
        kind: 'pat',
        userId: userContext.userId,
        username: userContext.username,
        userGroups: userContext.userGroups,
        tokenScopes: validated.scopes,
        sessionIsAdmin: false,
        ownerIsAdmin: userContext.ownerIsAdmin,
        forceNonAdmin: validated.forceNonAdmin ?? false,
        credentialId: String(validated.id),
    });

    userContext.mediaAccessIsAdmin = principal.isAdmin;
    if (!principal.isAdmin) {
        // An admin owner's narrowed credential (force_non_admin, scopes) must not keep the
        // priority admin-ness gave it: it could evict other viewers.
        if (userContext.ownerIsAdmin) userContext.liveTvPriority = 'low';
        userContext.maxAgeRating =
            tokenAccess.nonAdminMaxAgeRating ?? tokenAccess.permissions.maxAgeRating;
        userContext.isAgeRestricted = userContext.maxAgeRating !== null;
    }

    return { ok: true, identity: { userContext, principal } };
}

async function resolveServiceTokenIdentityInner(
    validated: ValidatedServiceToken,
    opts: { resolveJellyfinId?: boolean },
): Promise<TokenIdentityResult> {
    // NOTE: the `X-Act-As-User` header-ignored warning stays in
    // forward-auth.ts's adapter (the only plane that ever logged it) — it is
    // a diagnostic over a REQUEST HEADER the impersonation decision never
    // reads (the target always comes from the DB-stored `act_as_user`
    // column, looked up below), not a fact this identity-resolution step
    // needs to know to reach the same verdict RBP/`authenticate()` would.

    const actAsUser = validated.actAsUser;
    let userContext: UserContext;
    let jellyfinUserId: string | undefined;
    // Set only for a non-impersonating token holding `integrations:read` or
    // `diagnostics:read`.
    let tokenOwnerIsAdmin: boolean | undefined;

    if (actAsUser) {
        // Impersonation mode. SECURITY: a lookup failure or an
        // inactive/missing target must reject the request — never fall back
        // to admin access.
        try {
            const actAsUserId = toUserId(actAsUser);

            const { connectValkey, isValkeyReady, cacheGet, setEx, del } =
                await import('$lib/server/cache/valkey.js');
            const valkeyKey = `user:groups:${actAsUserId}`;
            if (!isValkeyReady()) {
                await connectValkey();
            }

            let userGroups: string[] = [];
            let userFoundInDb = false;
            let actAsUsername = '';
            // Pin-aware isAdminOverride tri-state for the impersonation
            // TARGET (Formula A — computed directly from the fresh row this
            // branch already fetches, then fed through buildUserPermissions
            // below alongside the in-app OR-term rather than collapsed to a
            // boolean here).
            let targetOwnerIsAdminOverride: boolean | undefined;
            // SECURITY (C10, security review 2026-09-15/16): pin-aware
            // age-rating ceiling for the impersonation TARGET, computed below
            // from the SAME row this branch already fetches, via
            // computeOwnerMaxAge() — the pure formula resolveTokenUserAccess's
            // cached path also uses (see that function's doc comment).
            //
            // This branch stays keyed by `act_as_user`'s users.id UUID
            // (id-keyed, no cache) rather than delegating fully to
            // resolveTokenUserAccess (username-keyed): that would need a
            // PRELIMINARY id->username lookup (turning one DB round trip into
            // two), and this branch's "row.groups === null -> treat as
            // not-found" edge case has no equivalent in resolveRow() (which
            // treats a null groups column as an empty array, not
            // "not found"). The age (C10) and admin (C2) axes ARE genuinely
            // shared formulas (computeOwnerMaxAge / computeOwnerIsAdminOverride)
            // applied directly on this branch's own fresh row — only the
            // DB-access shape (id-keyed, no cache) stays separate.
            let targetPinnedMaxAge: number | null = null;

            // SECURITY: ALWAYS fetch fresh groups from database (not cache).
            // Valkey is used only to quickly check if the user was seen
            // before; the cache write below is an existence hint, never the
            // source of truth for groups/admin/age.
            const cachedExists = isValkeyReady() ? await cacheGet(valkeyKey) : null;

            const { Database } = await import('$lib/server/database/connection.js');
            const db = new Database();
            const sql: postgres.Sql = db.getSql();
            const result = await sql<
                {
                    username: string;
                    groups: string[] | null;
                    disabled_at: Date | null;
                    /**
                     * SECURITY (C17, security review 2026-09-17): added
                     * alongside `disabled_at`. This is one of the id-keyed
                     * producers that stays on its own query instead of
                     * `resolveTokenUserAccess()` (see `targetPinnedMaxAge`'s
                     * doc comment above for why) — the 2026-09-16 round
                     * folded `deleted_at` into every `resolveTokenUserAccess`
                     * caller but could not reach an id-keyed producer that
                     * never calls it. This producer selects and checks this
                     * column directly instead.
                     */
                    deleted_at: Date | null;
                    is_admin: boolean;
                    admin_pinned: boolean;
                    max_age_rating: number | null;
                    age_rating_pinned: boolean;
                }[]
            >`
                SELECT username, groups, disabled_at, deleted_at, is_admin, admin_pinned, max_age_rating, age_rating_pinned FROM users
                WHERE id = ${actAsUserId}::uuid
            `;

            // A disabled OR soft-deleted impersonation target is treated the
            // same as "not found" — the target account was cut off (security
            // review 2026-09-13, C2 for disabled_at; 2026-09-17, C17 for
            // deleted_at), so a service token configured to impersonate it
            // must stop working too, not just the target's own credentials.
            // isLifecycleActive() is the SAME predicate
            // service-token.service.ts's isCreatorActive() applies to the
            // CREATOR axis; checking it HERE (in the producer, once) is what
            // closes the "third divergence" review §3 C1 warned a naive fix
            // could introduce (research §Q8).
            if (result.length > 0 && result[0].groups && isLifecycleActive(result[0])) {
                actAsUsername = result[0].username;
                userGroups = result[0].groups;
                userFoundInDb = true;
                // This row already carries is_admin/admin_pinned — apply
                // computeOwnerIsAdminOverride()'s shared tri-state formula
                // directly on it, no second DB round trip.
                targetOwnerIsAdminOverride = computeOwnerIsAdminOverride(
                    result[0].is_admin === true,
                    result[0].admin_pinned === true,
                );
                // Same row also carries max_age_rating/age_rating_pinned —
                // apply computeOwnerMaxAge()'s pure formula directly (C10).
                targetPinnedMaxAge = computeOwnerMaxAge(
                    userGroups,
                    result[0].max_age_rating,
                    result[0].age_rating_pinned === true,
                );
                if (isValkeyReady()) {
                    await setEx(valkeyKey, 3600, JSON.stringify(userGroups));
                }
            } else if (cachedExists) {
                if (isValkeyReady()) {
                    await del(valkeyKey);
                }
            }

            if (!userFoundInDb) {
                logger.warn('Service token impersonation failed: user not found', {
                    tokenName: validated.name,
                    actAsUser,
                });
                return {
                    ok: false,
                    denial: {
                        status: 403,
                        error: 'invalid_impersonation',
                        message: 'Impersonation target not found or not authorized',
                    },
                };
            }

            // Only resolved when the caller needs it (forward-auth's
            // locals.jellyfinUserId) — RBP and authenticate() pass
            // resolveJellyfinId:false to skip the extra lookup entirely,
            // since neither surface ever reads it.
            if (opts.resolveJellyfinId !== false) {
                // Dynamic import (not a static top-level one): this pulls in
                // the Jellyfin client chain, which touches `config.APP_NAME`
                // at module-evaluation time — a heavy, eager side effect that
                // must stay opt-in for the two callers (RBP, `authenticate()`)
                // that pass `resolveJellyfinId: false` and never need it.
                const { resolveJellyfinUserId } =
                    await import('$lib/server/services/jellyfin-user-id-resolver.js');
                jellyfinUserId = await resolveJellyfinUserId(actAsUsername);
            }

            // Merge the in-app access layer for the impersonated user BEFORE
            // the scope/forceNonAdmin downgrade below, so the least-
            // privilege kill switch can also strip in-app-conferred
            // elevation.
            const svcAccess = await resolveInAppAccess(actAsUserId, userGroups, {
                requireAvailable: true,
            });
            const svcPermissions = buildUserPermissions(svcAccess.effectiveGroups, {
                extraCapabilities: svcAccess.extraCapabilities,
                isAdminOverride: targetOwnerIsAdminOverride,
            });
            // SECURITY (C10): layer the impersonation TARGET's age-rating pin
            // (targetPinnedMaxAge, computed above from the same row) on top
            // of the group/in-app-merged ceiling, via the same most-
            // restrictive (MIN) merge resolveTokenUserAccess() uses.
            const svcEffectiveMaxAge = svcPermissions.ownerIsAdmin
                ? null
                : mergeMaxAge(targetPinnedMaxAge, svcPermissions.maxAgeRating);
            userContext = {
                userId: actAsUserId,
                username: actAsUsername,
                groups: svcAccess.effectiveGroups.join('|'),
                userGroups: svcAccess.effectiveGroups,
                ...svcPermissions,
                maxAgeRating: svcEffectiveMaxAge,
                isAgeRestricted: svcEffectiveMaxAge !== null,
            };

            // The token must satisfy BOTH: the target is actually admin, AND
            // the token carries 'admin' scope and is not forceNonAdmin.
            // Literal `'admin'`, not `isAdminClassScope` (which also treats
            // `'tasks:admin'` as admin-equivalent) — a `tasks:admin`-only
            // service token can never synthesize admin here, matching
            // `/api/v1`'s pre-existing behaviour, which always used this
            // literal-`'admin'`-only formula and never the wider one.
            // `2026-09-13-deferred-artifacts/ledger.md:37` accepted a
            // DIFFERENT widening — `tasks:admin` treated as admin-equivalent
            // by `principal.ts`'s `deriveIsAdmin()` on the requireAdmin/
            // `{kind:'admin'}` plane (unreachable there too, for the same
            // reason: no mintable scope schema admits `tasks:admin`).
            // RULING (Task 3 review, accepted; fix-plan-5 Task 9 review
            // round 1 correction, IMPORTANT 2 — this comment previously
            // misattributed :37 as covering `/api/v1`): the shared producer
            // now applies `/api/v1`'s literal-`'admin'` synthesis to
            // `/api/admin/*` too, which NARROWS :37 on that plane — a
            // `tasks:admin`-scoped token stops being admin-equivalent there,
            // closing the wider `deriveIsAdmin()` formula `/api/admin` used
            // before Shape A. Still unreachable today (same reason), but the
            // fact that changed is a tightening on `/api/admin`, not the
            // `/api/v1` status quo continuing unchanged.
            const tokenAllowsAdmin = validated.scopes.includes('admin') && !validated.forceNonAdmin;
            const effectiveIsAdmin = userContext.ownerIsAdmin && tokenAllowsAdmin;

            // Least-privilege kill switch: strip ALL elevated traits
            // regardless of whether the impersonated user is currently
            // admin, when forceNonAdmin is set; otherwise only downgrade the
            // admin-specific traits when scope doesn't carry admin through.
            if (validated.forceNonAdmin || (userContext.ownerIsAdmin && !effectiveIsAdmin)) {
                logger.debug(
                    'Service token: downgrading impersonated context (scope/forceNonAdmin)',
                    {
                        tokenPrefix: validated.tokenPrefix,
                        actAsUser,
                        scopes: validated.scopes,
                        forceNonAdmin: validated.forceNonAdmin,
                        wasAdmin: userContext.ownerIsAdmin,
                    },
                );
                userContext = {
                    ...userContext,
                    ownerIsAdmin: false,
                    maxAgeRating: mergeMaxAge(
                        targetPinnedMaxAge,
                        buildUserPermissions(svcAccess.effectiveGroups, {
                            isAdminOverride: false,
                            extraCapabilities: svcAccess.extraCapabilities,
                        }).maxAgeRating,
                    ),
                    isModerator: false,
                    hasRequestPermission: false,
                    hasReviewPermission: false,
                    hasMediaAnnotationPermission: false,
                    liveTvPriority: 'low',
                };
                userContext.isAgeRestricted = userContext.maxAgeRating !== null;
            }
        } catch (error) {
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            logger.error(
                'Service token impersonation failed',
                error instanceof Error ? error : new Error(String(error)),
            );
            return {
                ok: false,
                denial: {
                    status: 500,
                    error: 'impersonation_failed',
                    message: 'Failed to look up user for impersonation',
                },
            };
        }
    } else {
        // Non-impersonation: synthesize an identity from the service
        // token's own scope AND the owning admin's CURRENT pin-aware
        // admin status (Formula A). The token confers admin authority ONLY
        // when ALL of: it carries 'admin' scope, forceNonAdmin is not set,
        // AND the creator is CURRENTLY admin. Literal `'admin'` here too —
        // see the impersonation branch's identical note above (fix-plan-5
        // Task 9 review round 1, IMPORTANT 2): `2026-09-13-deferred-
        // artifacts/ledger.md:37` accepted the `tasks:admin` widening via
        // `principal.ts`'s `deriveIsAdmin()` on the requireAdmin/
        // `{kind:'admin'}` plane — `/api/v1` always used this literal-
        // `'admin'` synthesis. Now that `/api/admin/*` shares the SAME
        // literal-`'admin'` producer (RULING, Task 3 review, accepted),
        // that NARROWS :37 on `/api/admin`: a `tasks:admin`-scoped token is
        // non-admin there, for the same reason it was always non-admin on
        // `/api/v1`.
        const tokenScopeAllowsAdmin =
            validated.scopes.includes('admin') && !validated.forceNonAdmin;
        // The owner is `service_tokens.owner_user_id`, never the `created_by`
        // username label: a rename keeps the token, and a user who later
        // takes the old name gains no say over it. validate() has already
        // rejected a null, missing, disabled or deleted owner (fail closed,
        // by id, on every call); a null id here is defensive only.
        const ownerUserId = validated.ownerUserId;
        if (!ownerUserId) {
            logger.warn('Service token rejected: no owner_user_id', {
                tokenName: validated.name,
                tokenPrefix: validated.tokenPrefix,
                createdBy: validated.createdBy,
            });
            return {
                ok: false,
                denial: {
                    status: 403,
                    error: 'invalid_token',
                    message: 'Token owner not provisioned',
                },
            };
        }
        // The owner verdict is needed by the `admin` grant (unless forceNonAdmin
        // already rules admin out) and by the `integrations:read` grant, which
        // confers no admin but still requires an owner who is an administrator
        // (`integrationTokenDenial()`). Short-circuits without the extra DB
        // round trip otherwise.
        const holdsIntegrationsGrant = validated.scopes.includes(INTEGRATIONS_GRANT);
        // `diagnostics:read` gets the same owner verdict (spec 2026-10-21 §6).
        const holdsDiagnosticsGrant = validated.scopes.includes(DIAGNOSTICS_GRANT);
        const ownerIsAdmin =
            tokenScopeAllowsAdmin || holdsIntegrationsGrant || holdsDiagnosticsGrant
                ? await resolveOwnerIsAdminFailClosedById(ownerUserId)
                : false;
        // forceNonAdmin is refused with these grants at mint time; a row that
        // carries it anyway (hand edit) gets no access either.
        if (holdsIntegrationsGrant || holdsDiagnosticsGrant) {
            tokenOwnerIsAdmin = ownerIsAdmin && !validated.forceNonAdmin;
        }
        const synthIsAdmin = tokenScopeAllowsAdmin && ownerIsAdmin;
        if (!synthIsAdmin) {
            logger.debug(
                'Service token: synthetic identity is non-admin (scope/forceNonAdmin/creator pin)',
                {
                    tokenPrefix: validated.tokenPrefix,
                    tokenName: validated.name,
                    scopes: validated.scopes,
                    forceNonAdmin: validated.forceNonAdmin,
                    tokenScopeAllowsAdmin,
                },
            );
        }
        const synthUserGroups = synthIsAdmin ? ['admin'] : [];
        userContext = {
            userId: toUserId(ownerUserId),
            username: `service:${validated.name}`,
            groups: synthUserGroups.join('|'),
            userGroups: synthUserGroups,
            hasWatchPermission: true,
            hasLiveTvPermission: true,
            hasRequestPermission: synthIsAdmin,
            hasReviewPermission: synthIsAdmin,
            hasMediaAnnotationPermission: synthIsAdmin,
            ownerIsAdmin: synthIsAdmin,
            maxAgeRating: null,
            isAgeRestricted: false,
            isModerator: synthIsAdmin,
            liveTvPriority: synthIsAdmin ? 'high' : 'low',
        };
    }

    const principal = buildPrincipal({
        kind: 'service_token',
        userId: userContext.userId,
        username: userContext.username,
        userGroups: userContext.userGroups,
        tokenScopes: validated.scopes,
        sessionIsAdmin: false,
        ownerIsAdmin: userContext.ownerIsAdmin,
        forceNonAdmin: validated.forceNonAdmin ?? false,
        credentialId: String(validated.id),
        tokenPathPrefixes: validated.allowedPathPrefixes ?? undefined,
        tokenOwnerIsAdmin,
    });

    if (!validated.actAsUser) principal.syntheticServiceIdentity = true;
    userContext.mediaAccessIsAdmin = principal.isAdmin;
    return { ok: true, identity: { userContext, principal, jellyfinUserId } };
}

/**
 * Resolve a validated credential (step 1's output) into a full identity —
 * `UserContext` plus `Principal` — via Formula A. See the module doc comment
 * for what each token kind resolves to.
 *
 * `opts.resolveJellyfinId` (default `true`): forward-auth needs
 * `jellyfinUserId` for `locals.jellyfinUserId`; RBP and `authenticate()`
 * pass `false` to skip the extra lookup, since neither ever reads it.
 */
export async function resolveTokenIdentity(
    credential: ValidatedBearerCredential,
    opts: { resolveJellyfinId?: boolean } = {},
): Promise<TokenIdentityResult> {
    if (credential.kind === 'pat') {
        return resolvePatIdentity(credential.validated);
    }
    return resolveServiceTokenIdentityInner(credential.validated, opts);
}
