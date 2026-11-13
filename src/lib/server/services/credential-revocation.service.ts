// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fan-out credential revocation for a user across EVERY credential class the
 * app can issue — not just the native browser session. Used by disable,
 * admin password-reset, self password-change, and delete: security review
 * 2026-09-13 (C2) found each of those revoked `user_sessions` only, leaving
 * PATs, OAuth refresh tokens + device tokens, service-token impersonation
 * grants, /j (Jellyfin-compat) sessions, and Subsonic-compat credentials live
 * for a disabled or re-passworded account.
 *
 * Modeled on `oidc-backchannel-logout.ts`'s `cascadeDeviceTokens()`: each
 * store is revoked independently via a lazy `getXService()` accessor or
 * dynamic import (avoids import cycles with `session.service.ts` /
 * `pat.service.ts` / `service-token.service.ts` / the compat auth modules,
 * all of which this file's callers — `admin-user.service.ts` /
 * `native-auth.service.ts` — sit alongside) and wrapped in its own try/catch
 * so one store's failure never skips the rest. The /j store is reached
 * through the license-boundary registry (`jellyfin-compat-revocation.ts`),
 * never imported directly — `jellyfin-compat/auth.ts` is proprietary and
 * this file is AGPL core.
 *
 * `narrowAdminScopedCredentialsForUser()` (below) is a narrower sibling for
 * the admin-demotion / unpin paths (security review 2026-09-15, C4): it
 * narrows (via `force_non_admin`, not revocation) only admin-class-scoped
 * PATs and service-token impersonation grants rather than every credential
 * class, because losing admin status is not the same event as being
 * disabled.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { toUserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { userEventsHub } from '$lib/server/services/notification-events.service.js';

const logger = Logger.for('CredentialRevocation');

export interface RevokeAllCredentialsOptions {
    /**
     * Keep this native session token alive instead of revoking every native
     * session. Used by self password-change so the caller's own device stays
     * logged in (see `SessionService.revokeAllForUserExcept`).
     */
    keepSessionToken?: string;
    /**
     * `'all'` (default) revokes every credential class a user holds. `'device'`
     * narrows the fan-out to DEVICE-class stores only — native sessions,
     * OAuth refresh tokens, Jellyfin OAuth device tokens, and /j (Jellyfin-
     * compat) live sessions — and skips Personal Access Tokens, service-token
     * impersonation grants, and the Subsonic-compat token.
     *
     * `DELETE /api/admin/devices/all` (a "revoke all DEVICE sessions" action,
     * per its own name and docstring) used to call this with no `scope`,
     * which since the C2 fan-out (security review 2026-09-13) silently
     * revoked a user's PATs and Subsonic client password too — API
     * integrations and third-party Subsonic clients broke with no warning
     * from an admin action whose name and UI never mentioned them. `'device'`
     * restores the endpoint's original, narrower contract; `setDisabled` /
     * `resetPassword` / `changeOwnPassword` / `deleteUser` keep the full
     * `'all'` fan-out (an account being disabled/re-passworded/deleted must
     * lose EVERY credential, not just its devices).
     */
    scope?: 'all' | 'device';
}

export interface RevokeAllCredentialsResult {
    /** Store names whose revoke call threw and was skipped (best-effort). */
    failedStores: string[];
    /**
     * Number of credentials revoked per store, for stores that report a
     * count and were actually attempted (a store skipped by `scope:
     * 'device'` is absent, not `0`).
     */
    counts: Partial<
        Record<
            | 'native_sessions'
            | 'refresh_tokens'
            | 'pats'
            | 'jellyfin_oauth_tokens'
            | 'service_token_impersonation'
            | 'jellyfin_compat_sessions',
            number
        >
    >;
}

/**
 * Revoke every credential a user holds: native sessions, OAuth refresh
 * tokens, Personal Access Tokens, Jellyfin OAuth device tokens, service
 * tokens impersonating this user, /j (Jellyfin-compat) live sessions, and the
 * Subsonic-compat client token (plus its per-username auth cache). Every
 * store is attempted even if an earlier one throws; the returned
 * `failedStores` lists which ones did not complete so the caller can decide
 * whether to surface a partial-failure warning.
 */
export async function revokeAllCredentialsForUser(
    sql: postgres.Sql,
    userId: string,
    username: string,
    opts: RevokeAllCredentialsOptions = {},
): Promise<RevokeAllCredentialsResult> {
    const failedStores: string[] = [];
    const counts: RevokeAllCredentialsResult['counts'] = {};
    const uid = toUserId(userId);
    const deviceClassOnly = opts.scope === 'device';

    // Native browser sessions (user_sessions).
    try {
        const sessions = getSessionService();
        counts.native_sessions = await withTx(sql, (tx) =>
            opts.keepSessionToken
                ? sessions.revokeAllForUserExcept(userId, opts.keepSessionToken, tx)
                : sessions.revokeAllForUser(userId, tx),
        );
    } catch (error) {
        logger.warn('revokeAllCredentialsForUser: native sessions failed', {
            userId,
            error: String(error),
        });
        failedStores.push('native_sessions');
    }

    // OAuth device-flow refresh tokens.
    try {
        const { getRefreshTokenService } =
            await import('$lib/server/oauth/refresh-token.service.js');
        counts.refresh_tokens = await withTx(sql, (tx) =>
            getRefreshTokenService().revokeAllForUser(uid, tx),
        );
    } catch (error) {
        logger.warn('revokeAllCredentialsForUser: refresh tokens failed', {
            userId,
            error: String(error),
        });
        failedStores.push('refresh_tokens');
    }

    // Jellyfin OAuth device tokens (native-app device flow — distinct from
    // the proprietary /j compat session store below).
    try {
        const { getJellyfinTokenService } =
            await import('$lib/server/oauth/jellyfin-token.service.js');
        counts.jellyfin_oauth_tokens = await withTx(sql, (tx) =>
            getJellyfinTokenService().revokeAllForUser(uid, tx),
        );
    } catch (error) {
        logger.warn('revokeAllCredentialsForUser: Jellyfin OAuth device tokens failed', {
            userId,
            error: String(error),
        });
        failedStores.push('jellyfin_oauth_tokens');
    }

    // /j (Jellyfin-compat) live session store — reached through the registry
    // (never a direct import; see the file header). ensureCompatLoaded() makes
    // sure the boot registrations ran in this process. A null provider is a
    // no-op, not a failure.
    try {
        const { ensureCompatLoaded } = await import('$lib/server/boot/compat-init.js');
        await ensureCompatLoaded();
        const { getJellyfinCompatRevocationProvider } =
            await import('$lib/server/auth/jellyfin-compat-revocation.js');
        const provider = getJellyfinCompatRevocationProvider();
        counts.jellyfin_compat_sessions = provider
            ? await provider.revokeSessionsForUser(userId)
            : 0;
    } catch (error) {
        logger.warn('revokeAllCredentialsForUser: /j compat sessions failed', {
            userId,
            error: String(error),
        });
        failedStores.push('jellyfin_compat_sessions');
    }

    // The stores below are NOT device-class: a device token/session is
    // something a client silently re-acquires on next login, whereas a PAT,
    // a service token's impersonation grant, or a Subsonic client password
    // is a credential the account HOLDER (or an integration) explicitly
    // created and would not expect a "sign out all devices" action to
    // destroy. Skipped when `scope: 'device'` — see RevokeAllCredentialsOptions.
    if (!deviceClassOnly) {
        // Personal Access Tokens.
        try {
            const { getPatService } = await import('$lib/server/oauth/pat.service.js');
            counts.pats = await withTx(sql, (tx) => getPatService().revokeAllForUser(uid, tx));
        } catch (error) {
            logger.warn('revokeAllCredentialsForUser: PATs failed', {
                userId,
                error: String(error),
            });
            failedStores.push('pats');
        }

        // Service tokens configured to impersonate this user.
        try {
            const { getServiceTokenService } =
                await import('$lib/server/oauth/service-token.service.js');
            counts.service_token_impersonation = await withTx(sql, (tx) =>
                getServiceTokenService().revokeAllImpersonating(uid, tx),
            );
        } catch (error) {
            logger.warn('revokeAllCredentialsForUser: service-token impersonation failed', {
                userId,
                error: String(error),
            });
            failedStores.push('service_token_impersonation');
        }

        // Subsonic-compat client token + its per-username Valkey auth cache.
        // invalidateCacheForUser is called unconditionally (not just as a side
        // effect of deleteUserToken) so a cached auth entry with no backing DB
        // row — the row was already removed by a prior/concurrent path —
        // cannot keep validating credentials for up to the 60s cache TTL.
        try {
            const { deleteUserToken, invalidateCacheForUser } =
                await import('$lib/server/subsonic-compat/auth.js');
            await withTx(sql, (tx) => deleteUserToken(userId, tx));
            await invalidateCacheForUser(username);
        } catch (error) {
            logger.warn('revokeAllCredentialsForUser: Subsonic token failed', {
                userId,
                error: String(error),
            });
            failedStores.push('subsonic_token');
        }
    }

    if (failedStores.length > 0) {
        logger.warn('revokeAllCredentialsForUser: some stores failed', {
            userId,
            username,
            failedStores,
        });
    }

    // Security fix C28 (2026-09-16): an already-open per-user SSE stream
    // (GET /api/v1/events) was not torn down when its session was revoked —
    // auth was checked only at connect, so a disabled/reset/deleted account
    // kept receiving its own watch-state frames, admin broadcasts and device
    // cast hints until the socket happened to drop. Runs unconditionally
    // (even when a store above failed) and best-effort, mirroring every
    // other store in this fan-out — closing zero consumers (the common case:
    // no open stream) is a no-op, never an error.
    try {
        userEventsHub.closeConsumersForUsername(username);
    } catch (error) {
        logger.warn('revokeAllCredentialsForUser: closing SSE consumers failed', {
            userId,
            username,
            error: String(error),
        });
    }

    return { failedStores, counts };
}

/**
 * Revoke ONLY device-class credentials for a user — native sessions, OAuth
 * refresh tokens, Jellyfin OAuth device tokens, and /j (Jellyfin-compat) live
 * sessions. A thin, explicitly-named wrapper around
 * `revokeAllCredentialsForUser(sql, userId, username, { scope: 'device' })`
 * so a call site (`DELETE /api/admin/devices/all`) reads its intent without
 * needing to know the options-object shape.
 */
export async function revokeDeviceClassCredentialsForUser(
    sql: postgres.Sql,
    userId: string,
    username: string,
    opts: { keepSessionToken?: string } = {},
): Promise<RevokeAllCredentialsResult> {
    return revokeAllCredentialsForUser(sql, userId, username, { ...opts, scope: 'device' });
}

/**
 * Narrow ONLY the admin-class-scoped credentials a user holds: PATs and
 * service-token impersonation grants whose scopes include `'admin'` or any
 * `<area>:admin` scope (`isAdminClassScope()` in `principal.ts` — the same
 * predicate the token-minting ceiling and `stripAdminScopes()` use). Native
 * sessions, OAuth refresh tokens, ordinary read/write PATs, and the /j /
 * Subsonic compat credentials are left untouched — and the admin-class
 * credentials themselves are NOT revoked, they are marked `force_non_admin`
 * (`PatService.markAdminScopedForceNonAdminForUser()` /
 * `ServiceTokenService.markAdminScopedForceNonAdminImpersonating()`) so they
 * keep authenticating with every non-admin scope they always had.
 *
 * Security review 2026-09-15 (C4): `setIsAdmin(false)` (`users.queries.ts`)
 * and the unpin path (`unpinAdmin()` + `syncAdminFromGroups()`, when that
 * sync results in losing admin) wrote only `users.is_admin` /
 * `users.admin_pinned` — neither revoked nor narrowed anything. A
 * `{kind:'scope'}` def (`mount.ts`) never reads `isAdmin`; it reads
 * `Principal.scopes`, which for a PAT/service-token credential is
 * `expandScopes(<that credential's OWN stored scopes>)` regardless of the
 * owner's CURRENT admin status — `buildPrincipal()` in `principal.ts` only
 * strips admin scopes for a `forceNonAdmin` credential. So a demoted admin's
 * `admin`-scoped PAT — or a service token impersonating them with an
 * admin-class scope — kept full `{kind:'scope'}` admin-plane access forever,
 * completely independent of the identity-side (`isAdmin`) fix in a prior
 * task of this same plan.
 *
 * Revoke vs. narrow (both were on the table — see the task report for the
 * full write-up): narrowing was chosen over revoking outright because (a) it
 * produces the correct `403 insufficient_scope` on the next admin-scope
 * check rather than a `401 invalid_token` that would also kill the token's
 * non-admin scopes, and (b) it reuses a mechanism (`force_non_admin`) that
 * already existed for service tokens and needed only a symmetric column
 * (migration 16.255.0) for PATs, rather than inventing a second one. The
 * trade-off is documented on each writer: no cluster-wide broadcast, so a
 * sibling replica can serve the stale, still-admin-scoped Principal for up
 * to that replica's own token-cache TTL.
 *
 * Deliberately narrower than `revokeAllCredentialsForUser`: losing admin is
 * not the same event as being disabled. A demoted-but-still-enabled user
 * keeps their ordinary API integrations (a calendar sync PAT scoped
 * `read`, say) — only the admin-class credentials they should no longer hold
 * are narrowed. Call site (security review 2026-09-23, Shape B): both the
 * `set`-demotion and `unpin`-demotion branches of `setUserAdmin()` in
 * `admin-user.service.ts`, called by both `defs/users/[id].ts` and
 * `defs/admin/users/[username]/index.ts`. Never call this on a promotion.
 */
export async function narrowAdminScopedCredentialsForUser(
    sql: postgres.Sql,
    userId: string,
    username: string,
): Promise<RevokeAllCredentialsResult> {
    const failedStores: string[] = [];
    const counts: RevokeAllCredentialsResult['counts'] = {};
    const uid = toUserId(userId);

    // Admin-scoped Personal Access Tokens.
    try {
        const { getPatService } = await import('$lib/server/oauth/pat.service.js');
        counts.pats = await getPatService().markAdminScopedForceNonAdminForUser(uid);
    } catch (error) {
        logger.warn('narrowAdminScopedCredentialsForUser: admin-scoped PATs failed', {
            userId,
            error: String(error),
        });
        failedStores.push('pats');
    }

    // Admin-scoped service tokens: impersonating this user, OR created by
    // this user with no impersonation target (security review 2026-09-16,
    // fix round 1 review, Important 2 — the first round covered only the
    // impersonating relationship).
    try {
        const { getServiceTokenService } =
            await import('$lib/server/oauth/service-token.service.js');
        const svcTokens = getServiceTokenService();
        counts.service_token_impersonation =
            await svcTokens.markAdminScopedForceNonAdminImpersonating(uid, username);
    } catch (error) {
        logger.warn('narrowAdminScopedCredentialsForUser: admin-scoped service tokens failed', {
            userId,
            error: String(error),
        });
        failedStores.push('service_token_impersonation');
    }

    if (failedStores.length > 0) {
        logger.warn('narrowAdminScopedCredentialsForUser: some stores failed', {
            userId,
            username,
            failedStores,
        });
    }

    return { failedStores, counts };
}

/**
 * The promotion-side counterpart to `narrowAdminScopedCredentialsForUser()`
 * — clears `force_non_admin` on every PAT and service token belonging to
 * this user that currently has it set (both relationships: `user_id`/
 * `act_as_user`, and a non-impersonating token this user created).
 *
 * Security review 2026-09-16 (fix round 1 review, Important 5): nothing
 * previously reset this flag, so demote-then-re-promote permanently
 * stripped admin from a re-promoted admin's existing tokens — a token that
 * looked healthy (not revoked, unchanged `scopes`) would 403 on every
 * admin-scope check forever, with no UI signal explaining why. Call this
 * from the SAME places `narrowAdminScopedCredentialsForUser()` is NOT
 * called from — the promotion branches (`isAdmin: true` after the admin
 * ceiling check, and the IdP-group path when it re-grants admin) — never
 * from a demotion.
 */
export async function restoreAdminScopedCredentialsForUser(
    sql: postgres.Sql,
    userId: string,
    username: string,
): Promise<RevokeAllCredentialsResult> {
    const failedStores: string[] = [];
    const counts: RevokeAllCredentialsResult['counts'] = {};
    const uid = toUserId(userId);

    try {
        const { getPatService } = await import('$lib/server/oauth/pat.service.js');
        counts.pats = await getPatService().clearForceNonAdminForUser(uid);
    } catch (error) {
        logger.warn('restoreAdminScopedCredentialsForUser: admin-scoped PATs failed', {
            userId,
            error: String(error),
        });
        failedStores.push('pats');
    }

    try {
        const { getServiceTokenService } =
            await import('$lib/server/oauth/service-token.service.js');
        const svcTokens = getServiceTokenService();
        counts.service_token_impersonation = await svcTokens.clearForceNonAdminForUserAndCreator(
            uid,
            username,
        );
    } catch (error) {
        logger.warn('restoreAdminScopedCredentialsForUser: admin-scoped service tokens failed', {
            userId,
            error: String(error),
        });
        failedStores.push('service_token_impersonation');
    }

    if (failedStores.length > 0) {
        logger.warn('restoreAdminScopedCredentialsForUser: some stores failed', {
            userId,
            username,
            failedStores,
        });
    }

    return { failedStores, counts };
}

/**
 * ONE shared transition entry point (security review 2026-09-23, final fix
 * wave, X1(b)/X3): given a user's Formula-A admin verdict (the SAME
 * `resolveOwnerAdminStatus()` / `resolveOwnerAdminStatusById()` verdict every
 * other admin surface now uses) BEFORE and AFTER a write, narrow admin-scoped
 * credentials on a true→false transition, restore on false→true, and no-op
 * otherwise. Every admin-affecting write should call this instead of
 * independently deciding "did this write demote/promote the user" — the
 * final-wave review found THREE call sites each answering that question a
 * different, narrower way than Formula A:
 *
 *   - `forward-auth.ts`'s IdP-group sync compared only the raw `users.is_admin`
 *     COLUMN transition (`upsertUser()`'s `demoted`/`promoted`, itself
 *     group-only) — a dual-membership admin (IdP admin group AND in-app
 *     admin) who merely left the IdP group was narrowed even though Formula A
 *     still said admin, and nothing would ever restore them (the column-only
 *     check never sees a "promotion" for someone already admin via in-app).
 *   - `admin-user.service.ts`'s `setUserAdmin()` unpin branch computed the
 *     post-unpin verdict from `groups` alone (`buildUserPermissions(target.groups)`),
 *     dropping the in-app OR-term entirely.
 *   - `oidc.service.ts`'s `syncUserOnLogin()` discarded `upsertUser()`'s
 *     return value outright — an OIDC re-promotion never restored anything.
 *   - The in-app access-group write paths (member add/remove, capability
 *     replace, group delete) narrowed/restored NOTHING at all — the X1
 *     blocker chain.
 *
 * Idempotent and safe to call unconditionally: a no-transition (`wasAdmin ===
 * isAdminNow`) is a no-op that costs nothing beyond the two comparisons — no
 * caller needs its own "did anything change" guard first.
 */
export async function applyAdminStatusTransition(
    sql: postgres.Sql,
    userId: string,
    username: string,
    wasAdmin: boolean,
    isAdminNow: boolean,
): Promise<RevokeAllCredentialsResult> {
    if (wasAdmin === isAdminNow) return { failedStores: [], counts: {} };
    return wasAdmin
        ? narrowAdminScopedCredentialsForUser(sql, userId, username)
        : restoreAdminScopedCredentialsForUser(sql, userId, username);
}
