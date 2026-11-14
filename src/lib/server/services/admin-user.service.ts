// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin-facing native user management: create accounts, reset passwords, disable/
 * enable, and delete. Coordinates the password store (users.password_hash), the
 * session store (force-logout), and the admin/disabled L1 cache. AGPL-core; never
 * touches the `/j` password store.
 *
 * HTTP concerns (auth gate, status codes, request parsing) live in the route
 * handlers; this layer is pure orchestration so it can be unit/integration tested.
 *
 * Guard rails enforced here (not the route):
 *  - last-admin protection: you cannot disable / delete / the only effective admin
 *  - self protection: you cannot disable or delete your own account
 *  - disable / reset / delete all force-logout the target (revoke their sessions)
 */

import { createHash } from 'node:crypto';
import type { SetAllowLiveTvResponse } from '$lib/schemas/api-admin-responses.js';
import type postgres from 'postgres';
import { AdminUserEmailSchema } from '$lib/schemas/admin-user.js';
import * as m from '$lib/paraglide/messages.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { hashPassword } from '$lib/server/crypto/password.js';
import { validatePasswordPolicy } from '$lib/shared/password-strength.js';
import {
    revokeAllCredentialsForUser,
    applyAdminStatusTransition,
    narrowAdminScopedCredentialsForUser,
    restoreAdminScopedCredentialsForUser,
} from '$lib/server/services/credential-revocation.service.js';
import { computeOwnerIsAdmin } from '$lib/server/auth/resolve-owner-admin-status.js';
import { resolveEffectiveAccess } from '$lib/server/services/access-control.service.js';
import {
    adminCreateUser as adminCreateUserRow,
    adminSetUserEmail,
    setUserPassword,
    setUserDisabled,
    getUserByUsername,
    setIsAdmin,
    unpinAdmin,
    setMaxAgeRating,
    unpinAgeRating,
    syncAdminFromGroups,
    syncAgeRatingFromGroups,
    setUserLiveTvAllowed,
    type UserRow,
} from '$lib/server/database/queries/users.queries.js';
import {
    eraseUserData,
    type ErasureResult,
} from '$lib/server/database/queries/gdpr-erasure.queries.js';
import { ensureUserProfileExists } from '$lib/server/database/queries/user-ratings.queries.js';
import {
    countOtherEffectiveAdmins,
    isLastEffectiveAdmin,
    withLastAdminGuardLock,
} from '$lib/server/database/queries/access-groups.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import { validateUsername } from '$lib/server/services/native-auth.service.js';
import { invalidateUserAdminCache } from '$lib/server/cache/user-admin-cache.js';
import { invalidateUserMaxAgeCache } from '$lib/server/cache/user-max-age-cache.js';
import { buildUserPermissions } from '$lib/server/auth.js';
import { auditLog, type AuditActor } from '$lib/server/utils/audit-log.js';
import {
    recordIdentityBestEffort,
    PROVIDER_NATIVE,
} from '$lib/server/services/user-identity.service.js';

import { withUserCredentialLock } from './user-credential-lock.js';

const logger = Logger.for('AdminUser');

export type AdminUserResult<T = undefined> =
    | { ok: true; data: T; warnings?: Array<'native_login_disabled'> } // Success — data is the operation's return value
    | { ok: false; status: number; message: string }; // Failure — HTTP status + message for the caller

/** A target resolved for a mutation, with the acting admin's self-check applied. */
async function resolveTarget(sql: postgres.Sql, targetUsername: string): Promise<UserRow | null> {
    return getUserByUsername(sql, targetUsername.toLowerCase());
}

/**
 * Create a native user with a password. `isAdmin` controls whether the account is
 * an admin (pinned, so IdP sync can't flip it); admins get config.ADMIN_GROUPS,
 * non-admins get no groups (default permissions). 409 if the username is taken.
 */
export async function createUser(
    sql: postgres.Sql,
    params: { username: string; password: string; isAdmin: boolean; email?: string },
): Promise<AdminUserResult<{ id: string; username: string; isAdmin: boolean }>> {
    const username = params.username.trim();
    const usernameError = validateUsername(username);
    if (usernameError) return { ok: false, status: 400, message: usernameError };

    const parsedEmail = AdminUserEmailSchema.safeParse(params.email ?? '');
    if (!parsedEmail.success)
        return { ok: false, status: 400, message: m.admin_users_email_invalid() };

    const passwordError = validatePasswordPolicy(params.password);
    if (passwordError) return { ok: false, status: 400, message: passwordError };

    let passwordHash: string;
    try {
        passwordHash = await hashPassword(params.password);
    } catch {
        return { ok: false, status: 400, message: 'Password could not be processed.' };
    }

    const groups = params.isAdmin ? config.ADMIN_GROUPS : [];
    let newId: string | null;
    try {
        newId = await adminCreateUserRow(sql, {
            username,
            passwordHash,
            isAdmin: params.isAdmin,
            groups,
            email: parsedEmail.data,
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'user_email_conflict') {
            return { ok: false, status: 409, message: m.admin_users_email_taken() };
        }
        throw error;
    }
    if (!newId) {
        return { ok: false, status: 409, message: 'A user with that username already exists.' };
    }

    // Best-effort: create the FK-dependent profile row so ratings/watchlist work.
    // user_profiles.user_id is the users.id UUID (mig 16.46.0).
    try {
        await ensureUserProfileExists(sql, toUserId(newId));
    } catch {
        // Non-fatal — created lazily on first use otherwise.
    }

    // Record the native identity ledger row so the Identities modal reflects the
    // provider immediately (login already works via users.password_hash; this is
    // purely an audit/display fix).
    await recordIdentityBestEffort(sql, {
        provider: PROVIDER_NATIVE,
        subject: username.toLowerCase(),
        userId: newId,
    });

    logger.info('Admin created user', {
        username: username.toLowerCase(),
        isAdmin: params.isAdmin,
    });
    return {
        ok: true,
        data: { id: newId, username: username.toLowerCase(), isAdmin: params.isAdmin },
        ...(config.AUTH_NATIVE_LOGIN_ENABLED
            ? {}
            : { warnings: ['native_login_disabled' as const] }),
    };
}

/** Validate and change only the matching email; never log submitted input. */
export async function setUserEmail(
    sql: postgres.Sql,
    params: { targetUsername: string; email: string; actor: AuditActor },
): Promise<AdminUserResult> {
    const parsed = AdminUserEmailSchema.safeParse(params.email);
    if (!parsed.success) return { ok: false, status: 400, message: m.admin_users_email_invalid() };
    const target = await resolveTarget(sql, params.targetUsername);
    if (!target) return { ok: false, status: 404, message: m.users_directory_not_found() };
    try {
        const updated = await adminSetUserEmail(sql, target.id, parsed.data);
        if (!updated) return { ok: false, status: 404, message: m.users_directory_not_found() };
    } catch (error) {
        if (error instanceof Error && error.message === 'user_email_conflict') {
            return { ok: false, status: 409, message: m.admin_users_email_taken() };
        }
        throw error;
    }
    auditLog('user.update', target.username, params.actor, {
        field: 'email',
        emailHash: parsed.data ? createHash('sha256').update(parsed.data).digest('hex') : null,
    });
    return { ok: true, data: undefined };
}

/**
 * Admin-set a user's password (no current-password check). Setting a password on a
 * forward-auth-only account additionally grants it native login. Force-logs-out the
 * target (revokes all their sessions) so the old password's sessions die.
 */
export async function resetPassword(
    sql: postgres.Sql,
    params: { targetUsername: string; newPassword: string },
): Promise<AdminUserResult> {
    const target = await resolveTarget(sql, params.targetUsername);
    if (!target) return { ok: false, status: 404, message: 'User not found.' };

    const passwordError = validatePasswordPolicy(params.newPassword);
    if (passwordError) return { ok: false, status: 400, message: passwordError };

    let passwordHash: string;
    try {
        passwordHash = await hashPassword(params.newPassword);
    } catch {
        return { ok: false, status: 400, message: 'Password could not be processed.' };
    }

    const reset = await withUserCredentialLock(sql, target.id, async (tx) => {
        if (!(await setUserPassword(tx, target.id, passwordHash))) return false;
        // Keep the same lock until revocation finishes, including the Valkey /j store.
        const { failedStores } = await revokeAllCredentialsForUser(tx, target.id, target.username);
        if (failedStores.length > 0) {
            logger.warn('Admin reset password: some credential stores failed to revoke', {
                username: target.username,
                failedStores,
            });
        }
        return true;
    });
    if (!reset) return { ok: false, status: 404, message: 'User not found.' };

    // Record / refresh the native identity ledger row so the Identities modal
    // reflects that a native password now exists (login already works via
    // users.password_hash; this is purely an audit/display fix).
    await recordIdentityBestEffort(sql, {
        provider: PROVIDER_NATIVE,
        subject: target.username.toLowerCase(),
        userId: target.id,
    });

    logger.info('Admin reset password', { username: target.username });
    return { ok: true, data: undefined };
}

/**
 * Disable or re-enable a user. Disabling is a local kill-switch: `disabled_at`
 * is honoured by every token→user resolution path (native login/sessions,
 * forward-auth, PATs, OAuth device/refresh grants, service-token
 * impersonation, /j and Subsonic compat auth — see
 * `src/lib/server/oauth/CLAUDE.md`), and on top of that it force-revokes every
 * credential the target holds via `revokeAllCredentialsForUser`: native
 * sessions, OAuth refresh tokens, PATs, Jellyfin OAuth device tokens,
 * service-token impersonation grants targeting this user, /j (Jellyfin-compat)
 * live sessions, and the Subsonic-compat client token. Refuses to disable
 * yourself or the last effective admin.
 *
 * Audits `user.disable` / `user.enable` (moved in here from the admin def —
 * security review 2026-09-23, Shape B — so the v1 def's disable is audited
 * too, not just the admin def's).
 */
export async function setDisabled(
    sql: postgres.Sql,
    params: {
        targetUsername: string;
        disabled: boolean;
        actingUsername: string;
        actor: AuditActor;
    },
): Promise<AdminUserResult<{ disabled: boolean }>> {
    const target = await resolveTarget(sql, params.targetUsername);
    if (!target) return { ok: false, status: 404, message: 'User not found.' };

    let updated: boolean;
    if (params.disabled) {
        if (target.username === params.actingUsername.toLowerCase()) {
            return { ok: false, status: 400, message: 'You cannot disable your own account.' };
        }
        // Last-admin protection: refuse to disable the only effective admin, by
        // Formula A (the pin, IdP groups, in-app groups and capability — see
        // `isLastEffectiveAdmin`). The check and the write share the guard lock,
        // so two concurrent guarded changes cannot both pass it.
        const outcome = await withLastAdminGuardLock(sql, async () => {
            if (await isLastEffectiveAdmin(sql, target.id, config.ADMIN_GROUPS)) {
                return { lastAdmin: true as const };
            }
            return {
                lastAdmin: false as const,
                updated: await setUserDisabled(sql, target.id, true),
            };
        });
        if (outcome.lastAdmin) {
            return { ok: false, status: 409, message: 'Cannot disable the last active admin.' };
        }
        updated = outcome.updated;
    } else {
        updated = await setUserDisabled(sql, target.id, false);
    }
    if (!updated) return { ok: false, status: 404, message: 'User not found.' };

    // Invalidate the forward-auth admin/disabled cache so the change applies on the
    // target's very next request rather than after the TTL.
    invalidateUserAdminCache(target.username);

    if (params.disabled) {
        const { failedStores } = await revokeAllCredentialsForUser(sql, target.id, target.username);
        if (failedStores.length > 0) {
            logger.warn('Admin disabled user: some credential stores failed to revoke', {
                username: target.username,
                failedStores,
            });
        }
        logger.info('Admin disabled user', { username: target.username });
    } else {
        logger.info('Admin re-enabled user', { username: target.username });
    }
    auditLog(params.disabled ? 'user.disable' : 'user.enable', target.username, params.actor, {
        targetUsername: target.username,
    });
    return { ok: true, data: { disabled: params.disabled } };
}

/** A `maxAgeRating` write: pin to a value (`number | null`) or clear the pin
 *  and re-derive the cap from the target's current groups ("unpin"). */
export type AgeRatingChange = { kind: 'set'; value: number | null } | { kind: 'unpin' };

/**
 * Set or unpin a user's max age rating. One function for both user-mutation
 * defs (security review 2026-09-23, C3 + R1 residual + Shape B): the v1 def
 * (`defs/users/[id].ts`) used to write `max_age_rating` via a bare
 * `setMaxAgeRating()` call with no invalidation, no audit and no real unpin
 * (`null` pinned NULL instead of clearing the pin) — this owns the write,
 * the `user-max-age-cache` invalidation (which publishes cross-replica), the
 * audit row, and a real unpin, so both defs get all three for free.
 *
 * Unpin derives the group cap with `buildUserPermissions()` (not a bare
 * `resolveMaxAgeFromGroups()` call) specifically so it honours the
 * configured `AGE_RATING_GROUP_PREFIX` — the admin def's old inline unpin
 * branch called `resolveMaxAgeFromGroups()` with no prefix argument, silently
 * defaulting to `'age-'` regardless of what the operator configured.
 */
export async function setUserAgeRating(
    sql: postgres.Sql,
    params: { targetUsername: string; change: AgeRatingChange; actor: AuditActor },
): Promise<
    AdminUserResult<{ username: string; maxAgeRating: number | null; ageRatingPinned: boolean }>
> {
    const target = await resolveTarget(sql, params.targetUsername);
    if (!target) return { ok: false, status: 404, message: 'User not found.' };

    if (params.change.kind === 'unpin') {
        const updated = await unpinAgeRating(sql, target.username);
        if (!updated) return { ok: false, status: 404, message: 'User not found.' };

        const groupsMaxAge = buildUserPermissions(updated.groups ?? []).maxAgeRating;
        if (updated.max_age_rating !== groupsMaxAge) {
            await syncAgeRatingFromGroups(sql, target.username, groupsMaxAge);
        }
        invalidateUserMaxAgeCache(target.username);
        auditLog('user.unpin_age_rating', target.username, params.actor, {
            targetUsername: target.username,
        });
        return {
            ok: true,
            data: {
                username: updated.username,
                maxAgeRating: groupsMaxAge,
                ageRatingPinned: false,
            },
        };
    }

    const updated = await setMaxAgeRating(sql, target.username, params.change.value);
    if (!updated) return { ok: false, status: 404, message: 'User not found.' };

    invalidateUserMaxAgeCache(target.username);
    auditLog('user.set_age_rating', target.username, params.actor, {
        targetUsername: target.username,
        maxAgeRating: updated.max_age_rating,
    });
    return {
        ok: true,
        data: {
            username: updated.username,
            maxAgeRating: updated.max_age_rating,
            ageRatingPinned: updated.age_rating_pinned,
        },
    };
}

/** An `isAdmin` write: pin to a value, or clear the pin and re-derive from groups. */
export type AdminStatusChange = { kind: 'set'; value: boolean } | { kind: 'unpin' };

/**
 * Set or unpin a user's admin status. One function for both user-mutation
 * defs (security review 2026-09-23, C3 residual + Shape B) — the model is
 * `setDisabled()` above, which both defs already call.
 *
 * Owns, in order: the self-demotion guard (`actingUserId` when the caller has
 * it — an id compare is robust to any username-fold edge case; falls back to
 * `actingUsername`, case-folded, mirroring `setDisabled`'s own guard), the
 * last-admin guard, the write, admin-scoped credential narrow/restore on a
 * real transition, `user-admin-cache` invalidation, and the audit row.
 *
 * The last-admin guard here is Formula A (`isLastEffectiveAdmin`, exactly
 * `setDisabled`'s predicate, run under the same guard lock) — both callers'
 * inline versions gated entry on `target.is_admin` alone, so a user who was
 * ONLY an effective admin via an in-app access group (never `is_admin`
 * pinned true) could be demoted with no last-admin check at all, even as the
 * sole remaining admin (latent outage-class bug, found alongside C3).
 *
 * The last-admin guard ALWAYS runs against the pre-write `target` row and
 * ALWAYS completes before any write for both branches (fix round 1, Important
 * 3): the admin def's original inline `unpin` branch called `unpinAdmin()`
 * (which flips `admin_pinned` to `false`) BEFORE deriving the group-verdict
 * and checking the last-admin guard, so a blocked (409) unpin still left the
 * pin cleared with no cache invalidation — the next forward-auth `upsertUser`
 * would then read the now-unpinned, group-derived (non-admin) value and
 * silently demote the "protected" last admin outside this request entirely.
 * It also read `updated.disabled_at`, which `unpinAdmin()`'s `RETURNING`
 * clause never selects (always `undefined`) — this used `target.disabled_at`
 * instead, the pre-write row that has the real column.
 *
 * `requireAdminCeiling(event, …)` (granting admin requires the caller to
 * already be an administrator) stays in the defs — it needs the `event` and
 * the pre-auth principal, neither of which this service layer has. This
 * applies to `unpin` too, on whichever def exposes it (only the admin def's
 * `PatchUserBody` has an `unpin` field today): unpinning a user whose IdP
 * groups grant admin can itself be a promotion, so it needs the same ceiling
 * check as an explicit `{isAdmin:true}` (fix round 1, new finding).
 *
 * X3 FIX (security review 2026-09-23, final fix wave): both branches used to
 * decide "was this a real demotion/promotion" from a narrower signal than
 * Formula A — the unpin branch derived the post-unpin verdict from
 * `buildUserPermissions(target.groups)` alone (dropping the in-app OR-term
 * entirely), and the `set` branch compared against the raw `target.is_admin`
 * COLUMN (which, for an unpinned user, can lag the effective verdict — see
 * `applyAdminStatusTransition()`'s doc comment for the dual-membership case
 * this under/over-fires on). Both branches now capture the Formula-A verdict
 * BEFORE the write via `formulaAIsAdminForRow()` below.
 *
 * STALE-COMMENT CORRECTION (fix round 3, MINOR): this used to say both
 * branches feed their before/after verdicts through the ONE shared
 * `applyAdminStatusTransition()`. That stopped being true for the `set`
 * branch after fix round 2's Important-2 fix: narrow-on-`{isAdmin:false}`
 * must run UNCONDITIONALLY (an idempotent operator remedy for a stale
 * un-narrowed token), which `applyAdminStatusTransition()`'s before/after
 * gating cannot express, so `set` now calls
 * `narrowAdminScopedCredentialsForUser()` / `restoreAdminScopedCredentialsForUser()`
 * directly (see the comment at that branch below). Only the `unpin` branch
 * still goes through the shared `applyAdminStatusTransition()`.
 */
/**
 * Formula-A admin verdict for an ALREADY-LOADED `users` row, without
 * `resolveOwnerAdminStatus()`'s redundant re-fetch-by-username (every caller
 * here already has the row). Short-circuits to the column when pinned — an
 * authoritative pin needs no groups/in-app round trip at all — and only pays
 * for `resolveEffectiveAccess()` (and thus `computeOwnerIsAdmin()`'s
 * `buildUserPermissions()` call) when the verdict genuinely depends on it.
 * `forcePinned` lets a caller ask "what would Formula A say if this row's pin
 * were X" without mutating the row — used by the unpin branch below to
 * compute the POST-unpin (forced `false`) verdict from the PRE-write row.
 */
async function formulaAIsAdminForRow(
    sql: postgres.Sql,
    row: UserRow,
    forcePinned?: boolean,
): Promise<boolean> {
    const pinned = forcePinned ?? row.admin_pinned === true;
    if (pinned) return row.is_admin === true;
    const { effectiveGroups, capabilities } = await resolveEffectiveAccess(
        sql,
        row.id,
        row.groups ?? [],
    );
    return computeOwnerIsAdmin(
        effectiveGroups,
        row.is_admin === true,
        false,
        capabilities.ownerIsAdmin === true,
    );
}

export async function setUserAdmin(
    sql: postgres.Sql,
    params: {
        targetUsername: string;
        actingUsername: string;
        actingUserId?: string;
        change: AdminStatusChange;
        actor: AuditActor;
    },
): Promise<AdminUserResult<{ username: string; isAdmin: boolean; adminPinned: boolean }>> {
    const target = await resolveTarget(sql, params.targetUsername);
    if (!target) return { ok: false, status: 404, message: 'User not found.' };

    const isSelf = params.actingUserId
        ? params.actingUserId === target.id
        : target.username === params.actingUsername.toLowerCase();

    if (params.change.kind === 'unpin') {
        // Formula-A verdict BEFORE this write (cheap: short-circuits to the
        // column when currently pinned, which every unpin call by
        // definition is heading away from). Folds in the in-app OR-term the
        // old `buildUserPermissions(target.groups)`-only computation dropped
        // (X3 fix — this is what let a dual in-app-admin's unpin fall
        // through the last-admin guard with a wrong `isAdmin` response).
        const wasAdminBefore = await formulaAIsAdminForRow(sql, target);
        // Post-unpin verdict: Formula A with the pin forced false over the
        // SAME pre-write groups/in-app membership (unpinning touches
        // neither) — this lets the last-admin guard run and potentially
        // reject BEFORE any write. Used for the RESPONSE and the credential
        // transition ONLY — never for the `users.is_admin` column (see
        // `groupsOnlyIsAdmin` below).
        const postUnpinIsAdmin = await formulaAIsAdminForRow(sql, target, false);
        // FIX (fix round 2, Important 1): the COLUMN gets the GROUPS-ONLY
        // verdict, never the Formula-A (in-app-inclusive) one. An in-app
        // verdict written into `users.is_admin` would outlive the membership
        // it came from: after a later `removeMember()` the column would still
        // say admin to every reader that trusts it (the setup gate's column
        // term, a later re-pin that keeps the column). The last-admin counts
        // no longer read an unpinned column at all — they evaluate Formula A
        // from the groups and in-app rows (`access-groups.queries.ts`,
        // `readEffectiveAdminIds`), so a pinned non-admin in an admin group or
        // a stale unpinned column never stands in for a real admin there.
        const groupsOnlyIsAdmin = buildUserPermissions(target.groups ?? []).ownerIsAdmin;
        const willDemote = wasAdminBefore && !postUnpinIsAdmin;

        // Self-demotion guard (fix-plan-5 Task 9, carried C1): the `set`
        // branch below refuses `isSelf` demotion unconditionally, but this
        // branch had no equivalent — an admin whose IdP groups do not grant
        // admin could unpin themselves and self-demote. Only trips when the
        // post-unpin verdict is actually non-admin (`willDemote`); unpinning
        // an admin whose groups still grant admin is not a demotion at all.
        if (willDemote && isSelf) {
            return { ok: false, status: 400, message: 'Cannot remove your own admin status' };
        }

        // The last-admin check and the unpin share the guard lock (see
        // setDisabled), so a concurrent guarded change is either seen here or
        // sees this one.
        const outcome = await withLastAdminGuardLock(sql, async () => {
            if (willDemote && target.disabled_at === null) {
                const others = await countOtherEffectiveAdmins(sql, target.id, config.ADMIN_GROUPS);
                if (others === 0) return { lastAdmin: true as const };
            }
            const unpinned = await unpinAdmin(sql, target.username);
            if (unpinned) {
                // Always sync the column to the groups-only value on unpin — an
                // unconditional write is cheap (a single UPDATE, no-op if already
                // correct) and removes any coupling between "does the column need
                // updating" and "does the CREDENTIAL transition need to run" (the
                // two are genuinely independent questions — see the comment above).
                await syncAdminFromGroups(sql, target.username, groupsOnlyIsAdmin);
            }
            return { lastAdmin: false as const, updated: unpinned };
        });
        if (outcome.lastAdmin) {
            return {
                ok: false,
                status: 409,
                message: 'Cannot remove admin from the last active admin.',
            };
        }
        const updated = outcome.updated;
        if (!updated) return { ok: false, status: 404, message: 'User not found.' };

        const { failedStores } = await applyAdminStatusTransition(
            sql,
            updated.id,
            target.username,
            wasAdminBefore,
            postUnpinIsAdmin,
        );
        if (failedStores.length > 0) {
            logger.warn('Admin unpin: some credential stores failed to sync', {
                username: target.username,
                failedStores,
            });
        }
        invalidateUserAdminCache(target.username);
        auditLog('user.unpin_admin', target.username, params.actor, {
            targetUsername: target.username,
        });
        return {
            ok: true,
            data: {
                username: updated.username,
                isAdmin: postUnpinIsAdmin,
                adminPinned: updated.admin_pinned,
            },
        };
    }

    const wantAdmin = params.change.value;

    if (!wantAdmin) {
        if (isSelf) {
            return { ok: false, status: 400, message: 'Cannot remove your own admin status' };
        }
    }

    // Formula-A verdict BEFORE this write, computed here (not up front) so a
    // self-demotion or last-admin refusal above never pays for it — from the
    // pre-write `target` snapshot, so ordering relative to the write below is
    // immaterial (this reads only `target`'s already-captured fields plus a
    // fresh in-app lookup that this write itself cannot affect). Used ONLY to
    // decide whether a `wantAdmin:true` is a REAL promotion (below) — never to
    // gate the demotion narrow, which fix round 2 (Important 2) made
    // unconditional again.
    const wasAdminBefore = await formulaAIsAdminForRow(sql, target);

    // Last-admin guard on a demotion: same predicate and lock as setDisabled —
    // see the doc comment above for why the plain `target.is_admin` gate the
    // two defs used to run this behind was a latent last-admin gap.
    const outcome = wantAdmin
        ? { lastAdmin: false as const, updated: await setIsAdmin(sql, target.username, true) }
        : await withLastAdminGuardLock(sql, async () => {
              if (await isLastEffectiveAdmin(sql, target.id, config.ADMIN_GROUPS)) {
                  return { lastAdmin: true as const };
              }
              return {
                  lastAdmin: false as const,
                  updated: await setIsAdmin(sql, target.username, false),
              };
          });
    if (outcome.lastAdmin) {
        return {
            ok: false,
            status: 409,
            message: 'Cannot remove admin from the last active admin.',
        };
    }
    const updated = outcome.updated;
    if (!updated) return { ok: false, status: 404, message: 'User not found.' };

    // FIX (fix round 2, Important 2): narrow/restore are NOT symmetric here.
    // An explicit `{isAdmin:false}` must narrow UNCONDITIONALLY, every time —
    // this endpoint is also the operator's own remedy for killing a stale,
    // never-narrowed admin-scoped token (e.g. retrying after an earlier call's
    // `failedStores` reported a partial credential-store failure) — gating it
    // on `wasAdminBefore` (as fix round 1 did, reusing `applyAdminStatusTransition`
    // unconditionally) silently turned a real operator action into a no-op
    // whenever the target's Formula-A verdict happened to already read
    // non-admin. Restoring on `{isAdmin:true}`, by contrast, MUST stay
    // Formula-A-gated: an idempotent re-pin of someone already effectively
    // admin (e.g. via in-app) must not needlessly clear an operator's own
    // forceNonAdmin sandbox on that user's tokens (fix-plan-3 fix round 3,
    // Important 2's original guard) — so the two directions now call the
    // narrow/restore primitives directly instead of going through the
    // shared before/after transition helper (which cannot express "always
    // narrow, but only restore on a real transition").
    if (!wantAdmin) {
        const { failedStores } = await narrowAdminScopedCredentialsForUser(
            sql,
            updated.id,
            target.username,
        );
        if (failedStores.length > 0) {
            logger.warn('Admin set (demote): some credential stores failed to narrow', {
                username: target.username,
                failedStores,
            });
        }
    } else if (!wasAdminBefore) {
        const { failedStores } = await restoreAdminScopedCredentialsForUser(
            sql,
            updated.id,
            target.username,
        );
        if (failedStores.length > 0) {
            logger.warn('Admin set (promote): some credential stores failed to restore', {
                username: target.username,
                failedStores,
            });
        }
    }

    invalidateUserAdminCache(target.username);
    auditLog('user.set_admin', target.username, params.actor, {
        targetUsername: target.username,
        newAdminStatus: updated.is_admin,
    });
    return {
        ok: true,
        data: {
            username: updated.username,
            isAdmin: updated.is_admin,
            adminPinned: updated.admin_pinned,
        },
    };
}

/**
 * GDPR Art. 17 erasure of a user. Refuses to erase yourself or the last effective
 * admin. Performs a single-transaction ordered erasure (explicit-delete orphans →
 * anonymize audit-attribution → DELETE FROM users firing the cascades) and returns
 * the per-table erasure report as the confirmation artifact.
 *
 * Pre-flight: if the subject is the creator/assigner of admin-owned private-module
 * content via a NOT NULL, NO ACTION/RESTRICT FK (courses.created_by /
 * training_assignments.assigned_by), the erasure is aborted (409) with guidance to
 * re-attribute that content first — nothing is changed.
 */
export async function deleteUser(
    sql: postgres.Sql,
    params: { targetUsername: string; actingUsername: string },
): Promise<AdminUserResult<ErasureResult>> {
    const target = await resolveTarget(sql, params.targetUsername);
    if (!target) return { ok: false, status: 404, message: 'User not found.' };

    if (target.username === params.actingUsername.toLowerCase()) {
        return { ok: false, status: 400, message: 'You cannot delete your own account.' };
    }
    // The erasure cascades the user's refresh-token rows away, after which
    // nothing can tell which device sessions were theirs. Collect them first so
    // their access JWTs and cached stream tokens are cut off cluster-wide once
    // the erasure committed (below).
    let deviceSessionIds: string[] = [];
    try {
        const { listDeviceSessionIdsForUser } =
            await import('$lib/server/database/queries/oauth-refresh-tokens.queries.js');
        deviceSessionIds = await listDeviceSessionIdsForUser(sql, toUserId(target.id));
    } catch (err) {
        logger.warn('Could not list device sessions before erasure', { error: String(err) });
    }

    // Last-admin protection: refuse to delete the only effective admin (Formula
    // A, as in setDisabled). The erasure runs under the guard lock too, so a
    // concurrent guarded change cannot remove the other admin in between.
    const guarded = await withLastAdminGuardLock(sql, async () => {
        if (await isLastEffectiveAdmin(sql, target.id, config.ADMIN_GROUPS)) {
            return { lastAdmin: true as const };
        }
        return {
            lastAdmin: false as const,
            result: await eraseUserData(sql, target.id, target.username),
        };
    });
    if (guarded.lastAdmin) {
        return { ok: false, status: 409, message: 'Cannot delete the last active admin.' };
    }

    // Ordered GDPR erasure in one transaction. The user_sessions rows cascade away
    // inside this transaction via the FK; the explicit session-service revoke (which
    // also clears live in-memory/cached session state) is deferred until AFTER we
    // confirm the erasure was not aborted — otherwise a `blocked` 409 pre-flight abort
    // would force-log-out a user whose account still exists and was never erased,
    // leaving a partial side effect on a path that claims nothing was changed.
    const result = guarded.result;
    if (!result) return { ok: false, status: 404, message: 'User not found.' };

    if (result.blocked && result.blocked.length > 0) {
        const detail = result.blocked.map((b) => `${b.table}.${b.column} (${b.count})`).join(', ');
        return {
            ok: false,
            status: 409,
            message: `Cannot erase: the user owns admin content that must be re-attributed first — ${detail}.`,
        };
    }

    // Erasure committed (the user row + its session rows are gone via the in-tx
    // cascade). Write the audit entry FIRST — before any post-commit side-effects
    // that could throw — so the erasure is always recorded even if revoke fails.
    invalidateUserAdminCache(target.username);
    if (deviceSessionIds.length > 0) {
        try {
            const { handleDeviceSessionsRevoked } =
                await import('$lib/server/oauth/device-session-liveness.js');
            await handleDeviceSessionsRevoked(deviceSessionIds);
        } catch (err) {
            logger.warn('Post-erasure device session cut-off failed (non-fatal)', {
                error: String(err),
            });
        }
    }
    logger.info('Admin erased user (GDPR Art. 17)', {
        username: target.username,
        totalDeleted: result.totalDeleted,
        totalAnonymized: result.totalAnonymized,
    });

    // Best-effort: revoke live credential state (sessions, tokens, /j and
    // Subsonic compat sessions) to clear caches. Safe here because the
    // account is actually erased. Most DB-backed stores are already gone via
    // the FK CASCADE inside eraseUserData's transaction (revoking them here
    // is then a harmless no-op) — the one store that does NOT cascade is the
    // /j (Jellyfin-compat) Valkey session store, which is why this call still
    // matters post-erasure. A failure here must NOT propagate to the caller —
    // the erasure already committed and the audit is already written.
    try {
        const { failedStores } = await revokeAllCredentialsForUser(sql, target.id, target.username);
        if (failedStores.length > 0) {
            logger.warn('Post-erasure credential revoke: some stores failed', {
                username: target.username,
                failedStores,
            });
        }
    } catch (revokeErr) {
        logger.warn('Post-erasure credential revoke failed (non-fatal)', {
            username: target.username,
            error: revokeErr instanceof Error ? revokeErr.message : String(revokeErr),
        });
    }

    return { ok: true, data: result };
}

/** Invalidate authorization on every replica and release revoked playback immediately. */
export async function setUserAllowLiveTv(
    sql: postgres.Sql,
    params: { targetUsername: string; allowed: boolean; actor: AuditActor },
): Promise<AdminUserResult<SetAllowLiveTvResponse>> {
    const username = params.targetUsername.toLowerCase();
    if (!(await setUserLiveTvAllowed(sql, username, params.allowed))) {
        return { ok: false, status: 404, message: 'User not found.' };
    }
    const { invalidateUserLiveTvPolicy } = await import('$lib/server/auth/livetv-user-policy.js');
    invalidateUserLiveTvPolicy(username);
    auditLog('user.set_allow_live_tv', username, params.actor, { allowLiveTv: params.allowed });
    if (!params.allowed) {
        try {
            const { revokeUserLiveTvPlayback } =
                await import('./livetv/playback-session-lifecycle.js');
            await revokeUserLiveTvPlayback(sql, username);
        } catch {
            logger.warn('Live TV permission saved; cleanup must be retried', { username });
            return { ok: false, status: 503, message: m.admin_users_live_tv_save_failed() };
        }
    }
    return { ok: true, data: { username, allowLiveTv: params.allowed, liveTvDefault: false } };
}
