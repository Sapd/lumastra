// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolve a token-carried username (music wildcard/per-item stream tokens,
 * `/j` play tokens) to the same permission surface the forward-auth session
 * path computes, for building a token-derived {@link UserContext}.
 *
 * A token request never carries a live Authentik header — `users.groups`
 * (the last-synced group membership, written by the forward-auth cookie
 * path) stands in for it here, exactly as it does for the service-token
 * impersonation path in forward-auth.ts (`act_as_user` reads the same
 * column). The DB admin/age-rating pins and the in-app access layer
 * (`resolveEffectiveAccess`) are then layered on top, mirroring the
 * `resolveDbAuth` + `resolveInAppAccess` + `buildUserPermissions` +
 * `mergeMaxAge` derivation forward-auth.ts uses for the cookie session path
 * (see the `UserContext` construction after `resolveInAppAccess` there).
 *
 * ## Caching (security review C4 fix-round-1 follow-up)
 *
 * The row read (`getUserByUsername` → isAdmin/maxAge/disabled/userId/groups)
 * reads through the SAME L1 caches `resolveDbAuth` uses — `user-admin-cache.ts`
 * (isAdmin/disabled/deleted/userId, invalidated by `invalidateUserAdminCache`) and
 * `user-max-age-cache.ts` (maxAge, invalidated by `invalidateUserMaxAgeCache`,
 * called alongside the former at every existing admin/disable/rating-pin call
 * site) — both TTL 10 min, both cross-replica via the auth-cache-bus. A
 * `groups` getter/setter was added to `user-admin-cache.ts` for this
 * resolver specifically, since unlike the forward-auth session path (which
 * gets its "current groups" for free from the request header on every call)
 * a token request's ONLY source for group membership is this DB column. A
 * fully warm cache therefore serves a request with ZERO DB round-trips,
 * which matters here: this resolver runs on every HLS segment / music track
 * / Live TV segment request, not once per session.
 *
 * On a cold cache, the row read fails CLOSED with AuthDependencyUnavailableError on a DB error
 * — deliberately NOT the `resolveDbAuth` fail-OPEN-to-oidc-fallback shape,
 * because a token request has no oidc/header fallback to fail open TO; an
 * "open" fallback here would mean fabricating an unrestricted context,
 * which is exactly the C4 bug this resolver exists to prevent. This only
 * bites a request that hits a cold cache during a DB outage — a warm cache
 * (the overwhelming majority of requests on an actively-streaming token,
 * since the TTL is 10 minutes and a stream's segment cadence is seconds)
 * is entirely unaffected by a transient DB blip.
 *
 * The in-app access layer (`resolveEffectiveAccess`) keeps its own
 * establishing pattern instead: it already has a private 60s per-user cache,
 * and on an error is wrapped here to fail OPEN to "no extra in-app groups/
 * capabilities" (mirroring forward-auth.ts's `resolveInAppAccess`) — that
 * layer can only ADD capabilities on top of the DB-pin-derived base, so
 * failing open to "nothing extra" cannot escalate access, only under-grant
 * an in-app-only cohort's bonus permissions during an outage.
 *
 * ## Freshness override (fix round 2, security review 2026-09-16)
 *
 * `resolveTokenUserAccess(username, { freshGroups: true })` bypasses the
 * cache-first fast path entirely for that one call, forcing a live DB row
 * read every time — needed by callers whose contract requires per-request-
 * fresh group membership and cannot tolerate the cache's up-to-10-minute
 * lag. `pat.service.ts` fetches `users.groups` fresh on EVERY `/api/v1` PAT
 * request with an explicit stated contract ("because group membership is
 * security-critical and must reflect current permissions") — before this
 * flag existed, `handlePatAuth` delegating to this resolver silently
 * downgraded that contract from per-request-fresh to a 10-minute cache,
 * which matters specifically because C9/C10 (the findings this resolver was
 * built to fix) is exactly "frozen IdP groups": reintroducing even a
 * 10-minute freeze on the PAT path would be regressing the very defect this
 * resolver exists to repair, not a neutral trade-off.
 *
 * The flag is implemented as narrowly as its name says: it forces `groups`
 * to read as a cache MISS, which (since the cache-first fast path requires
 * ALL SEVEN cached fields warm) forces the whole row through the DB branch —
 * refreshing isAdmin/adminPinned/maxAge/disabled/deleted/userId/groups together,
 * consistently, from the same row read, and still populating the caches
 * afterward so a NON-freshness caller for the same username benefits from
 * the now-warm entry. There is no such thing as "fresh groups, cached
 * isAdmin" here — that would let a stale isAdmin (itself group-derived when
 * unpinned) disagree with the fresh groups it should have been computed
 * from.
 */

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import { buildUserPermissions, type UserPermissions } from '$lib/server/auth.js';
import { computeOwnerIsAdminOverride } from '$lib/server/auth/resolve-owner-admin-status.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { resolveEffectiveAccess } from '$lib/server/services/access-control.service.js';
import {
    getCachedIsAdmin,
    setCachedIsAdmin,
    getCachedAdminPinned,
    setCachedAdminPinned,
    getCachedDisabled,
    setCachedDisabled,
    getCachedDeleted,
    setCachedDeleted,
    getCachedUserId,
    setCachedUserId,
    getCachedGroups,
    setCachedGroups,
} from '$lib/server/cache/user-admin-cache.js';
import {
    getCachedMaxAge,
    setCachedMaxAge,
    MAX_AGE_MISS,
} from '$lib/server/cache/user-max-age-cache.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('TokenUserAccess');

/** Conservative age ceiling for the legacy forward-auth permission fallback.
 * Native and bearer validation throw on unavailable permission lookups instead.
 */
export const MOST_RESTRICTIVE_AGE_RATING = 0;

export interface TokenUserAccess {
    userGroups: string[];
    permissions: UserPermissions;
    /** Underlying age ceiling before the owner's admin bypass; scoped tokens use this. */
    nonAdminMaxAgeRating: number | null;
    disabled: boolean;
    /**
     * `users.deleted_at IS NOT NULL` (security review 2026-09-16, task 6
     * follow-up — `deleted_at` is `disabled`'s sibling lifecycle column).
     * `deleteUser` in this codebase is a hard DELETE, so a genuinely deleted
     * account resolves to `null` above (no row at all) rather than this
     * flag — this exists as defence in depth for a soft-delete column that
     * is already read/enforced elsewhere (`pat.service.ts`, the pre-fix
     * `jellyfin-compat/middleware.ts` live re-check). Every caller that
     * checks `disabled` must check this alongside it.
     */
    deleted: boolean;
}

interface RowState {
    isAdmin: boolean;
    /**
     * The raw `users.admin_pinned` column (fix round 1, Important 4, security
     * review 2026-09-16). Lets {@link resolveTokenUserAccess} decide WHETHER
     * to apply `isAdmin` above as an override on the in-app-merged
     * `buildUserPermissions` call, rather than passing it unconditionally —
     * see that function's own comment for why the unconditional shape was a
     * bug.
     */
    adminPinned: boolean;
    maxAge: number | null;
    disabled: boolean;
    /** `users.deleted_at IS NOT NULL` — see {@link TokenUserAccess.deleted}. */
    deleted: boolean;
    userId: string;
    groups: string[];
}

/**
 * Most-restrictive (MIN) merge of two age ceilings. `null` = unrestricted
 * (most permissive), so a `null` on either side never lowers the other
 * side's restriction. Mirrors `mergeMaxAge` in forward-auth.ts.
 *
 * Exported so a caller that reproduces this module's age composition without
 * going through {@link resolveTokenUserAccess} itself — `admin/fix/
 * visibility-check.ts`, the operator diagnostic whose entire job is to report
 * what production decides — applies the SAME merge rather than keeping a
 * fourth private copy. It is paired with {@link computeOwnerMaxAge}: the
 * composition is always `mergeMaxAge(computeOwnerMaxAge(...), <in-app-merged
 * ceiling>)`, never one without the other. `forward-auth.ts` and
 * `native-session.ts` still hold their own private copies.
 */
export function mergeMaxAge(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
}

/**
 * Pure pin-aware age-rating-ceiling formula — `age_rating_pinned ?
 * max_age_rating : buildUserPermissions(groups).maxAgeRating` — mirroring
 * `computeOwnerIsAdmin()`'s split in `resolve-owner-admin-status.ts` (the
 * SAME "pinned column wins, else derive from groups" shape for the admin
 * axis). Factored out so a caller that already holds the raw `users` row —
 * `forward-auth.ts`'s service-token impersonation branch, which fetches by
 * id and deliberately never reads through this module's cache (its
 * always-fresh, no-cache contract predates and is independent of this
 * resolver — see that branch's own comment) — can apply the SAME formula
 * without a second, username-keyed, CACHED round trip through
 * {@link resolveTokenUserAccess}. `resolveRow()` below is a thin wrapper
 * around this for the cached path. There is still exactly one place the
 * number itself is computed.
 */
export function computeOwnerMaxAge(
    groups: string[],
    dbMaxAge: number | null,
    ageRatingPinned: boolean,
): number | null {
    if (ageRatingPinned) return dbMaxAge;
    return buildUserPermissions(groups).maxAgeRating;
}

/**
 * Cache-first row resolution. Returns `undefined` when the username has no
 * `users` row. A dependency error throws AuthDependencyUnavailableError so
 * callers deny temporarily without declaring the credential invalid.
 *
 * `opts.freshGroups: true` (fix round 2) treats the groups cache entry as
 * always-miss, forcing this call through the DB branch — see the module doc
 * comment's "Freshness override" section for why this must force the WHOLE
 * row fresh rather than mixing a fresh `groups` with a cached `isAdmin`.
 */
async function resolveRow(
    username: string,
    opts?: { freshGroups?: boolean },
): Promise<RowState | undefined> {
    const cachedIsAdmin = getCachedIsAdmin(username);
    const cachedAdminPinned = getCachedAdminPinned(username);
    const cachedMaxAge = getCachedMaxAge(username);
    const cachedDisabled = getCachedDisabled(username);
    const cachedDeleted = getCachedDeleted(username);
    const cachedUserId = getCachedUserId(username);
    const cachedGroups = opts?.freshGroups ? null : getCachedGroups(username);

    if (
        cachedIsAdmin !== null &&
        cachedAdminPinned !== null &&
        cachedMaxAge !== MAX_AGE_MISS &&
        cachedDisabled !== null &&
        cachedDeleted !== null &&
        cachedUserId !== null &&
        cachedGroups !== null
    ) {
        return {
            isAdmin: cachedIsAdmin,
            adminPinned: cachedAdminPinned,
            maxAge: cachedMaxAge,
            disabled: cachedDisabled,
            deleted: cachedDeleted,
            userId: cachedUserId,
            groups: cachedGroups,
        };
    }

    try {
        const { Database } = await import('$lib/server/database/connection.js');
        const sql = new Database().getSql();
        const dbUser = await getUserByUsername(sql, username);
        if (!dbUser) return undefined;

        const groups = dbUser.groups ?? [];
        const syncedPermissions = buildUserPermissions(groups);
        const adminPinned = dbUser.admin_pinned === true;
        const isAdmin = adminPinned ? dbUser.is_admin : syncedPermissions.ownerIsAdmin;
        const maxAge = computeOwnerMaxAge(groups, dbUser.max_age_rating, dbUser.age_rating_pinned);
        const disabled = dbUser.disabled_at !== null;
        const deleted = dbUser.deleted_at !== null;

        setCachedIsAdmin(username, isAdmin);
        setCachedAdminPinned(username, adminPinned);
        setCachedMaxAge(username, maxAge);
        setCachedDisabled(username, disabled);
        setCachedDeleted(username, deleted);
        setCachedUserId(username, dbUser.id);
        setCachedGroups(username, groups);

        return { isAdmin, adminPinned, maxAge, disabled, deleted, userId: dbUser.id, groups };
    } catch (e) {
        // Fail CLOSED (not resolveDbAuth's fail-open-to-oidc shape): a token
        // request has no header fallback to fall open to, and an "open"
        // fallback here would mean serving an unrestricted context — the C4
        // bug this resolver exists to prevent. Only reachable when the cache
        // was cold, so there is no cached value to fall back to either.
        logger.warn('Failed to resolve token user row from DB (cold cache)', {
            username,
            error: String(e),
        });
        if (isDependencyError(e)) throw new AuthDependencyUnavailableError(e);
        return undefined;
    }
}

/** Resolve token permissions only when their current access boundary is available. */
async function resolveInAppAccessSafe(
    username: string,
    userId: string,
    syncedGroups: string[],
): Promise<{ effectiveGroups: string[]; capabilities: Partial<UserPermissions> }> {
    try {
        const { Database } = await import('$lib/server/database/connection.js');
        const sql = new Database().getSql();
        const { effectiveGroups, capabilities } = await resolveEffectiveAccess(
            sql,
            userId,
            syncedGroups,
        );
        return { effectiveGroups, capabilities };
    } catch (e) {
        logger.warn('In-app access resolution temporarily unavailable', {
            username,
            error: String(e),
        });
        if (isDependencyError(e)) throw new AuthDependencyUnavailableError(e);
        return {
            effectiveGroups: syncedGroups,
            capabilities: { maxAgeRating: MOST_RESTRICTIVE_AGE_RATING },
        };
    }
}

/**
 * Resolve `username`'s current effective permissions for a token-derived
 * UserContext. Returns `null` when the username has no resolvable `users`
 * row, while dependency errors throw AuthDependencyUnavailableError —
 * callers must fail closed (deny/404) rather than fall back to an
 * unrestricted context, since the DB is the only source of truth for a token
 * request (there is no header to fall back to).
 *
 * @param opts.freshGroups - pass `true` for a caller whose contract requires
 * per-request-fresh group membership (e.g. `/api/v1` PAT auth, which
 * `pat.service.ts` itself fetches fresh on every request) — see the module
 * doc comment's "Freshness override" section.
 */
export async function resolveTokenUserAccess(
    username: string,
    opts?: { freshGroups?: boolean },
): Promise<TokenUserAccess | null> {
    const row = await resolveRow(username, opts);
    if (!row) return null;

    const { effectiveGroups, capabilities } = await resolveInAppAccessSafe(
        username,
        row.userId,
        row.groups,
    );

    const mergedPermissions = buildUserPermissions(effectiveGroups, {
        // FIX ROUND 1 (Important 4, security review 2026-09-16): supply the
        // override ONLY when the row is pinned. Passing `row.isAdmin`
        // unconditionally (the pre-fix shape) is a DEFINED value even when
        // unpinned, which — per buildUserPermissions'
        // `isAdminOverride ?? (groups-OR-extra.isAdmin)` semantics — silently
        // discarded `capabilities.isAdmin` (the in-app-only admin grant) for
        // every unpinned owner. `undefined` when unpinned lets that
        // groups-OR-in-app check run as intended.
        //
        // FIX ROUND 3 (security review 2026-09-16): this is now
        // computeOwnerIsAdminOverride() (resolve-owner-admin-status.ts) —
        // the SAME shared tri-state formula the service-token impersonation
        // branch in forward-auth.ts calls, instead of each keeping its own
        // inline copy of `adminPinned ? isAdmin : undefined` with no test
        // that would fail if the two ever diverged.
        isAdminOverride: computeOwnerIsAdminOverride(row.isAdmin, row.adminPinned),
        extraCapabilities: capabilities,
    });
    const nonAdminPermissions = buildUserPermissions(effectiveGroups, {
        isAdminOverride: false,
        extraCapabilities: capabilities,
    });
    const nonAdminMaxAgeRating = mergeMaxAge(row.maxAge, nonAdminPermissions.maxAgeRating);
    const effectiveMaxAge = mergedPermissions.ownerIsAdmin
        ? null
        : mergeMaxAge(row.maxAge, mergedPermissions.maxAgeRating);

    return {
        userGroups: effectiveGroups,
        nonAdminMaxAgeRating,
        disabled: row.disabled,
        deleted: row.deleted,
        permissions: {
            ...mergedPermissions,
            maxAgeRating: effectiveMaxAge,
            isAgeRestricted: effectiveMaxAge !== null,
        },
    };
}
