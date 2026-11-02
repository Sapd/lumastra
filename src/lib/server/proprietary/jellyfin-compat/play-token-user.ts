// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
/**
 * Shared builder for the minimal {@link UserContext} the /j/* direct-play-token
 * stream routes attach to `event.locals.user`.
 *
 * The play token carries the user's USERNAME (PlayTokenData.userId is populated
 * from `locals.user.username` at issue time — the field name is historical). We
 * resolve that username to the stable `users.id` UUID (the user-data key since
 * migration 16.46.0) so downstream watch-state/access checks key correctly.
 *
 * `userGroups` / `maxAgeRating` / `isAgeRestricted` (and the other permission
 * flags) are resolved LIVE from the DB on every call via
 * {@link resolveTokenUserAccess} — the same derivation the forward-auth cookie
 * session path uses — rather than hardcoded. Before this fix the context
 * always carried `isAgeRestricted:false`/`userGroups:[]`, so a user whose age
 * cap was lowered or whose library group was revoked mid-session kept
 * streaming for as long as the (renewable) play token stayed valid: the age
 * gate in `media-access.ts` (`if (!user.isAgeRestricted) return true;`) never
 * ran, and the empty group list masked that by fail-closing the library axis
 * first (security review C4).
 *
 * `hasWatchPermission` stays forced `true` and `hasRequestPermission` forced
 * `false`: a play token is scoped to one already-mint-time-authorized item,
 * and the real re-check for that item is `checkMediaAccess` (library groups +
 * age), which now reads the live `userGroups`/`isAgeRestricted` above —
 * watch/request permission are unrelated axes, out of scope here.
 * `hasLiveTvPermission` keeps the caller-supplied `opts` override (the Live TV
 * play-token routes force it `true` and separately re-check revocation via
 * `enforceTokenLiveTvAccess`); it falls back to the live DB-derived value when
 * no override is given.
 *
 * Returns `null` when the username can't be resolved to a `users.id` (deleted
 * user / DB down), the account is disabled, or (security review 2026-09-16,
 * task 6 follow-up) soft-deleted — the caller fails closed (404/401) rather
 * than serve a stream under an identity-less or revoked context.
 */

import type { UserContext } from '$lib/server/types';
import { resolveUserIdByUsername } from '$lib/server/auth/resolve-user-id';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache';
import { buildPrincipal } from '$lib/server/api/principal';

/**
 * Value for `PlayTokenData.mintedByAdmin` at issue time. /j has no principal;
 * the compat middleware sets `mediaAccessIsAdmin` explicitly (a password
 * session: the owner's admin flag; a compat PAT: false). Fails closed: a
 * context without the explicit flag, or one that lowered `isAdmin`, mints a
 * non-admin token.
 */
export function playTokenMintedByAdmin(user: UserContext | undefined): boolean {
    return toLibraryAccessUser(user)?.isAdmin === true && user?.mediaAccessIsAdmin === true;
}

/**
 * Put a play-token identity on the request: the user plus a stream-token
 * principal. A stream-token principal is never admin, so the admin verdict
 * (localsIsAdmin) is false; the media grant stays in `mediaAccessIsAdmin`.
 */
export function applyPlayTokenIdentity(event: { locals: App.Locals }, user: UserContext): void {
    event.locals.user = user;
    event.locals.principal = buildPrincipal({
        kind: 'stream_token',
        userId: user.userId,
        username: user.username,
        userGroups: user.userGroups ?? [],
        sessionIsAdmin: false,
        ownerIsAdmin: false,
    });
}

/**
 * Build the playback-only UserContext for a play-token username, or null if the
 * username has no resolvable `users.id`, the account is disabled, or it is
 * soft-deleted (`access.deleted` — every /j/Videos, /j/Audio, and Live TV
 * play-token route funnels through this one check, so fixing it here closes
 * the deleted_at gap for all of them at once rather than patching each
 * route).
 */
export async function buildPlayTokenUserContext(
    tokenUsername: string,
    opts?: { hasLiveTvPermission?: boolean; mintedByAdmin?: boolean },
): Promise<UserContext | null> {
    const userId = await resolveUserIdByUsername(tokenUsername);
    if (!userId) return null;
    const access = await resolveTokenUserAccess(tokenUsername);
    if (!access || access.disabled || access.deleted) return null;
    // Admin media access only when the ISSUING request had real admin
    // capability (PlayTokenData.mintedByAdmin) and the owner is still an
    // admin. A token issued through a scoped credential, or before the flag
    // existed, carries no admin grant.
    const mediaAccessIsAdmin = opts?.mintedByAdmin === true && access.permissions.ownerIsAdmin;
    const maxAgeRating = mediaAccessIsAdmin
        ? access.permissions.maxAgeRating
        : (access.nonAdminMaxAgeRating ?? access.permissions.maxAgeRating);
    return {
        userId,
        username: tokenUsername,
        groups: access.userGroups.join('|'),
        userGroups: access.userGroups,
        hasWatchPermission: true,
        hasLiveTvPermission:
            (opts?.hasLiveTvPermission ?? access.permissions.hasLiveTvPermission) &&
            (await userAllowsLiveTv(tokenUsername, {
                continuation: opts?.hasLiveTvPermission === true,
            })),
        hasRequestPermission: false,
        ownerIsAdmin: access.permissions.ownerIsAdmin,
        mediaAccessIsAdmin,
        maxAgeRating,
        isAgeRestricted: maxAgeRating !== null,
        isModerator: access.permissions.isModerator,
        liveTvPriority: access.permissions.liveTvPriority,
    };
}
