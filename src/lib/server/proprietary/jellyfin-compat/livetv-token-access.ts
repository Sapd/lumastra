// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
/**
 * Serve-time Live TV permission re-check for the play-token streaming paths.
 *
 * The `/j/Videos/[id]/live.m3u8` + `/live/[segment]` routes bypass
 * `withJellyfinAuth` (ExoPlayer/AVPlayer can't send auth headers, so the token
 * rides in the URL) and build a synthetic UserContext that FORCES
 * `hasLiveTvPermission: true`. A play token is issued at PlaybackInfo time
 * (permission-checked then) and is renewable on every progress heartbeat, so
 * without re-checking here a user whose Live TV permission was revoked AFTER
 * issuance would keep streaming indefinitely.
 *
 * This resolves the user's CURRENT effective Live TV permission the same way
 * `buildUserContextFromSession` does (synced `users.groups` + in-app group
 * capabilities, honoring an admin pin), and denies with the unconfigured 404 when it's been
 * revoked. Reads go through the shared user-access L1 cache, so the cost is a
 * cache hit on the warm path.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';
import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';

/**
 * Re-check the token user's current Live TV permission at serve time.
 * Returns a 404 {@link Response} when revoked, or `null` when still permitted.
 *
 * `tokenUsername` is `PlayTokenData.userId`, which carries the user's USERNAME
 * (historical field name — see {@link buildPlayTokenUserContext}).
 *
 * The per-user switch uses a five-second cache with cross-replica invalidation.
 * It fails open only for this already-authorized stream on a DB outage; a
 * definitive revocation always returns the unconfigured 404. New starts fail closed.
 * The remaining group-resolution check fails OPEN on a DB outage to match the middleware's
 * is_admin fallback stance — a transient DB blip must not blanket-cut every
 * live stream. Fails CLOSED (404) only on a definitive "no such user" or an
 * authoritative "permission revoked" verdict.
 */
export async function enforceTokenLiveTvAccess(tokenUsername: string): Promise<Response | null> {
    if (!(await userAllowsLiveTv(tokenUsername, { continuation: true })))
        return ApiProblem.notFound();
    let access;
    try {
        access = await resolveTokenUserAccess(tokenUsername);
    } catch (error) {
        // An outage is not a definitive revocation for this stream; anything else is a bug.
        if (error instanceof AuthDependencyUnavailableError || isDependencyError(error)) return null;
        throw error;
    }
    if (!access) return ApiProblem.notFound(); // No such user.
    if (access.disabled || access.deleted || !access.permissions.hasLiveTvPermission)
        return ApiProblem.notFound();
    return null;
}
