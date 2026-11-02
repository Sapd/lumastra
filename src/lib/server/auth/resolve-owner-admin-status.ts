// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolve a username's admin verdict for the Bearer-token admin fallbacks
 * (the PAT / service-token tertiary paths that materialise a `Principal`
 * outside `resolveAuth`), for the non-impersonating service-token creator
 * axis, and for the mint-time ceiling on a service token's impersonation
 * target.
 *
 * FIX (security review 2026-09-23, C6): this module used to implement
 * "Formula B" — `admin_pinned ? is_admin : isUserAdmin(groups)`, a pin-aware
 * verdict over synced IdP groups ONLY. It disagreed with "Formula A", the
 * ONE formula `buildUserPermissions()` (`auth.ts`) actually implements:
 * `isAdminOverride ?? (hasGroupPermission(groups, ADMIN_GROUPS) ||
 * extra?.isAdmin === true)`. Formula B silently dropped the in-app `admin`
 * capability (the standalone-multiuser group->capability layer,
 * `access-control.service.ts`) for every UNPINNED owner judged here — an
 * in-app admin whose token happened to be judged by this module (a PAT
 * owner, an impersonation target, a non-impersonating service-token
 * creator) was denied admin on that path while every other admin surface
 * (the SSO session as of this same fix, `/api/v1` PAT via
 * `resolve-token-user-access.ts`, `/j`, play tokens, Live TV) already
 * granted it. This module now computes Formula A instead, so every caller
 * agrees (fix-plan-3 ledger `:119`'s "only native installs have the in-app
 * layer" premise was already false at HEAD before this fix; ledger `:170`
 * flagged the group-NAME sub-case specifically).
 *
 * `computeOwnerIsAdmin()` below composes `buildUserPermissions()` directly
 * rather than re-deriving the OR — there is exactly ONE expression that
 * decides "is this the admin case" (`auth.ts`'s), and every Bearer-admin
 * call site defers to it through this module instead of re-deriving its own
 * (this pattern goes back to the final fix wave, security review
 * 2026-09-13).
 *
 * Returns `null` when the username has no resolvable `users` row (deleted /
 * never provisioned) — callers must treat that as "not admin, deny", not
 * throw.
 */

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

import type postgres from 'postgres';
import {
    getUserByUsername,
    getUserById,
    type UserRow,
} from '$lib/server/database/queries/users.queries.js';
import { buildUserPermissions } from '$lib/server/auth.js';
import { resolveEffectiveAccess } from '$lib/server/services/access-control.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('Auth');

export interface OwnerAdminStatus {
    userId: UserId;
    /**
     * The owner's current username (added final fix wave, security review
     * 2026-09-23, X1/X3): callers that resolve by id (`resolveOwnerAdminStatusById`)
     * need this to call `narrowAdminScopedCredentialsForUser()` /
     * `restoreAdminScopedCredentialsForUser()` / `applyAdminStatusTransition()`,
     * all of which are keyed by username for logging/attribution.
     */
    username: string;
    /** The owner's CURRENT `users.groups` (live IdP-synced membership, unchanged meaning). */
    groups: string[];
    /**
     * `groups` unioned with the owner's in-app group NAMES (fix, security
     * review 2026-09-23) — what `buildUserPermissions()` actually sees when
     * deciding the OR-term. Equal to `groups` when the owner is pinned (the
     * in-app round trip is skipped entirely — the pin decides regardless)
     * or has no in-app group membership.
     */
    effectiveGroups: string[];
    /** Formula A: `isAdminOverride ?? (hasGroupPermission(effectiveGroups, ADMIN_GROUPS) || inAppIsAdmin)`. */
    isAdmin: boolean;
    /**
     * The raw `users.admin_pinned` column. Exposed (fix round 1, security
     * review 2026-09-16) so a caller that needs to decide WHETHER to apply
     * `isAdmin` above as an override on top of a SEPARATE group/in-app-
     * capability computation (rather than consume it as the final verdict
     * outright) can do so without re-deriving the pin from a fresh query —
     * see {@link computeOwnerIsAdminOverride}, which mirrors
     * `native-session.ts`'s `row.admin_pinned ? { isAdminOverride: row.is_admin }
     * : {}` shape exactly.
     */
    adminPinned: boolean;
}

/**
 * The pin-aware `isAdminOverride` TRI-STATE — `admin_pinned ? isAdminColumn :
 * undefined` — for a caller that has a SEPARATE group/in-app-capability
 * check to defer to when unpinned (i.e. a `buildUserPermissions({
 * isAdminOverride })` call site), rather than wanting the final collapsed
 * boolean outright.
 *
 * FIX ROUND 3 (security review 2026-09-16): extracted out of
 * `computeOwnerIsAdmin()` below (which needs the COLLAPSED boolean, not the
 * tri-state) so `forward-auth.ts`'s service-token impersonation branch and
 * `resolve-token-user-access.ts`'s `resolveTokenUserAccess()` — both of
 * which independently need EXACTLY this tri-state shape to avoid silently
 * discarding an unpinned owner's in-app-only admin capability (the class of
 * bug fix round 1's Important #4 fixed in the latter) — can share ONE
 * implementation instead of each keeping its own inline
 * `adminPinned ? isAdmin : undefined` ternary. Before this fix, the
 * impersonation branch's copy had ZERO test coverage that would fail if it
 * ever diverged from `resolveTokenUserAccess`'s copy — collapsing to one
 * function removes that risk entirely rather than adding a guard for it.
 */
export function computeOwnerIsAdminOverride(
    isAdminColumn: boolean,
    adminPinned: boolean,
): boolean | undefined {
    return adminPinned ? isAdminColumn : undefined;
}

/**
 * The pure Formula-A admin-verdict formula for a caller that already holds
 * the resolved inputs (no DB round trip needed): an authoritative pin
 * override when pinned, otherwise config-group membership OR the in-app
 * `admin` capability. Composes {@link computeOwnerIsAdminOverride} for the
 * pin tri-state and `buildUserPermissions()` (`auth.ts`) for the OR itself —
 * there is exactly ONE place `isAdminOverride ?? (groups || inApp)` is
 * written for the admin axis; this function only supplies the inputs, so
 * there is never a third, independently-maintained copy of that OR.
 *
 * `inAppIsAdmin` is a REQUIRED parameter (no default): every caller must
 * explicitly decide whether it has an in-app verdict to feed in, rather than
 * silently defaulting to "no in-app admin" the way the pre-fix formula did
 * for every caller by omission (security review 2026-09-23, C6).
 *
 * The pin still wins UNCONDITIONALLY when set — `inAppIsAdmin` only feeds
 * the OR that `isAdminOverride ?? (...)` falls through to when unpinned.
 * This is the exact ordering security review 2026-09-15's C2 (HIGH) demands:
 * a pin that explicitly DEMOTES an admin (`admin_pinned:true, is_admin:false`)
 * must not be re-elevated by a stale admin group NOR by an in-app `admin`
 * capability. See `resolve-owner-admin-status.test.ts`'s guard test.
 */
export function computeOwnerIsAdmin(
    effectiveGroups: string[],
    isAdminColumn: boolean,
    adminPinned: boolean,
    inAppIsAdmin: boolean,
): boolean {
    return buildUserPermissions(effectiveGroups, {
        isAdminOverride: computeOwnerIsAdminOverride(isAdminColumn, adminPinned),
        extraCapabilities: inAppIsAdmin ? { ownerIsAdmin: true } : undefined,
    }).ownerIsAdmin;
}

/**
 * Shared body of {@link resolveOwnerAdminStatus} and
 * {@link resolveOwnerAdminStatusById} — both resolve a `users` row by a
 * different key, then compute the SAME Formula-A verdict over it. Extracted
 * (security review 2026-09-23 final fix wave, X1/X3) so the id-keyed lookup
 * needed by the in-app access-group write paths (which have a `users.id`,
 * not a username, on hand) can't independently drift from the username-keyed
 * one every other caller uses.
 */
async function computeStatusForRow(
    sql: postgres.Sql,
    owner: UserRow,
    requireAvailable = false,
): Promise<OwnerAdminStatus> {
    const groups = owner.groups ?? [];
    const adminPinned = owner.admin_pinned === true;

    // Pinned: the override decides on its own — skip the in-app round trip
    // entirely (mirrors resolveTokenUserAccess's resolveRow and
    // resolveDbAuth's SSO path, both of which do the same for the same
    // reason: an explicit pin is authoritative regardless of what the
    // in-app layer would separately say).
    let effectiveGroups = groups;
    let inAppIsAdmin = false;
    if (!adminPinned) {
        try {
            const resolved = await resolveEffectiveAccess(sql, owner.id, groups);
            effectiveGroups = resolved.effectiveGroups;
            inAppIsAdmin = resolved.capabilities.ownerIsAdmin === true;
        } catch (e) {
            // Fail closed on the admin axis specifically (mirrors
            // resolveInAppAccessSafe / resolveInAppAccess's identical
            // catch-shape): an in-app lookup failure must never be treated
            // as "in-app admin", only ever as "no in-app admin to add".
            // effectiveGroups stays the synced groups and inAppIsAdmin
            // stays false, so this OR-term simply drops the (unavailable)
            // in-app contribution rather than guessing.
            logger.warn('Failed to resolve in-app access for owner admin status; fail closed', {
                username: owner.username,
                error: String(e),
            });
            if (requireAvailable && isDependencyError(e))
                throw new AuthDependencyUnavailableError(e);
        }
    }

    return {
        userId: toUserId(owner.id),
        username: owner.username,
        groups,
        effectiveGroups,
        adminPinned,
        isAdmin: computeOwnerIsAdmin(
            effectiveGroups,
            owner.is_admin === true,
            adminPinned,
            inAppIsAdmin,
        ),
    };
}

export async function resolveOwnerAdminStatus(
    sql: postgres.Sql,
    username: string,
): Promise<OwnerAdminStatus | null> {
    const owner = await getUserByUsername(sql, username.toLowerCase());
    if (!owner) return null;
    return computeStatusForRow(sql, owner);
}

/**
 * Id-keyed sibling of {@link resolveOwnerAdminStatus}, for callers that hold
 * a `users.id` (a `user_access_groups` membership row, an access-group
 * member list) rather than a username. Same Formula-A verdict, same
 * fail-closed-on-in-app-lookup-failure posture — see
 * {@link computeStatusForRow}.
 */
export async function resolveOwnerAdminStatusById(
    sql: postgres.Sql,
    userId: string,
): Promise<OwnerAdminStatus | null> {
    const owner = await getUserById(sql, userId);
    if (!owner) return null;
    return computeStatusForRow(sql, owner, true);
}

/**
 * Fail-closed, always-`boolean` admin verdict for a username with NO
 * independent groups/in-app-capability fallback of its own to defer to.
 *
 * CALLER (fix-plan-5 Task 3 consolidated `forward-auth.ts`'s
 * `handleServiceTokenAuth` and `tasks/api-auth.ts`'s old `authenticate()`
 * into the shared producer below — neither calls this directly any more):
 * `token-identity.ts`'s `resolveServiceTokenIdentityInner()` (`:574`, the
 * call site at `:867` — NOT `validateBearerCredential()`, which only
 * validates the raw credential and never resolves an identity), for the
 * non-impersonating service-token creator axis only
 * (`resolveOwnerIsAdminFailClosed(validated.createdBy)`, gated behind a
 * `tokenScopeAllowsAdmin` short-circuit) — it builds a SYNTHETIC identity
 * with no real user's groups at all, so there is nothing for an `undefined`
 * tri-state override to fall through to.
 *
 * Unlike the tri-state shape `resolveTokenUserAccess()` and the
 * `forward-auth.ts` service-token impersonation branch use
 * (`adminPinned ? isAdmin : undefined`, so a SEPARATE `buildUserPermissions`
 * call can defer to groups/in-app capability when unpinned), this returns
 * the collapsed `resolveOwnerAdminStatus()` verdict directly and fails
 * closed to `false` on any DB/lookup problem — including a missing `sql`
 * handle or a missing `users` row, both logged (fix-plan-3 ledger `:121`:
 * "no row or no DB -> explicit false" plus a log line saying so, the same
 * posture `resolveOwnerAdminStatus`'s own in-app fallback takes).
 *
 * COLLAPSED (security review 2026-09-23, C6 cleanup): `forward-auth.ts` and
 * `tasks/api-auth.ts` used to each keep a byte-identical private copy of
 * this function (fix-plan-3 ledger `:134`, the name-collision note; ledger
 * `:132` separately accepted the creator-branch redirect to this collapsed
 * boolean WITHOUT considering whether the in-app admin capability should
 * count — the gap this C6 fix closes), including a bare
 * `catch { return false; }` with no log line (fix-plan-3 ledger `:133`,
 * deferred at the time). Both callers now import this ONE export instead.
 */
export async function resolveOwnerIsAdminFailClosed(username: string): Promise<boolean> {
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) {
            logger.warn('No DB handle while resolving owner admin status; fail closed', {
                username,
            });
            return false;
        }
        const owner = await resolveOwnerAdminStatus(sql, username);
        if (!owner) {
            logger.warn('No resolvable users row for owner admin status; fail closed', {
                username,
            });
            return false;
        }
        return owner.isAdmin === true;
    } catch (e) {
        logger.warn('Failed to resolve pin-aware owner admin status; fail closed', {
            username,
            error: String(e),
        });
        return false;
    }
}

/**
 * Id-keyed sibling of {@link resolveOwnerIsAdminFailClosed}: the same
 * collapsed, fail-closed Formula-A verdict for a `users.id`. Used for a
 * non-impersonating service token's owner (`service_tokens.owner_user_id`),
 * so the verdict never follows a username that was renamed or reused. Dependency
 * errors throw rather than masquerading as a demoted owner.
 */
export async function resolveOwnerIsAdminFailClosedById(userId: string): Promise<boolean> {
    try {
        const { aiDbService } = await import('$lib/server/services/database.service.js');
        const sql = await aiDbService.getSql();
        if (!sql) {
            logger.warn('No DB handle while resolving owner admin status; fail closed', {
                userId,
            });
            throw new AuthDependencyUnavailableError();
        }
        const owner = await resolveOwnerAdminStatusById(sql, userId);
        if (!owner) {
            logger.warn('No resolvable users row for owner admin status; fail closed', {
                userId,
            });
            return false;
        }
        return owner.isAdmin === true;
    } catch (e) {
        logger.warn('Failed to resolve pin-aware owner admin status; fail closed', {
            userId,
            error: String(e),
        });
        if (isDependencyError(e)) throw new AuthDependencyUnavailableError(e);
        return false;
    }
}
