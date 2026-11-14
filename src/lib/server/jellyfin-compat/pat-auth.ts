// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// PAT authentication for /j/* Jellyfin compatibility routes.
// Requires EXACTLY scopes=['jellyfin_compat'] (read+write) OR
// scopes=['jellyfin_compat_read'] (read-only) — no more, no less.
//
// SECURITY: DO NOT use patService.hasScope() here. hasScope() treats 'admin' as
// universal, which would let admin-scoped PATs authenticate at /j/* endpoints,
// defeating the exclusive-scope guarantee. Use exact array equality only.

import { getPatService } from '$lib/server/oauth/pat.service';
import type { UserPermissions } from '$lib/server/auth';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access';
import { Logger } from '$lib/server/utils/logger';
import type { UserId } from '$lib/shared/user-id';

const logger = Logger.for('JellyfinCompat:PatAuth');

export interface JellyfinCompatPatAuth extends UserPermissions {
    /** PAT row id, used for per-token notification throttling. */
    tokenId: number;
    /** Stable users.id UUID — the user-data key (from the PAT row's user_id). */
    userId: UserId;
    username: string;
    /** Pipe-joined group string — matches the forward-auth locals.user.groups shape */
    groups: string;
    /** Raw group array — matches locals.user.userGroups shape */
    userGroups: string[];
    /** Always false for PAT-authenticated /j/* requests */
    ownerIsAdmin: false;
    /**
     * True when the PAT is scoped 'jellyfin_compat_read' — caller must reject
     * any non-GET/HEAD method even if the route is annotated mode: 'write'.
     * False for the full-access 'jellyfin_compat' scope.
     */
    isReadOnly: boolean;
}

/**
 * Validates a PAT for /j/* access. Requires EXACTLY one of:
 *   - scopes=['jellyfin_compat']      → read+write (isReadOnly: false)
 *   - scopes=['jellyfin_compat_read'] → read-only  (isReadOnly: true)
 *
 * Returns null on:
 * - Invalid or expired token (delegated to patService.validate)
 * - User missing or soft-deleted (delegated to patService.validate)
 * - Scope mismatch (any scopes other than exactly one of the two above)
 *
 * On success, the returned object has `isAdmin: false` regardless of the
 * underlying user's actual admin status, and mirrors the locals.user shape
 * set by withJellyfinAuth so downstream permission gates work identically.
 */
export async function validateJellyfinCompatPat(
    token: string,
    clientIp: string,
): Promise<JellyfinCompatPatAuth | null> {
    const patService = getPatService();
    const validated = await patService.validate(token, clientIp);
    if (!validated) return null;

    // Exact-array-equality check — NOT hasScope().
    // This ensures only tokens created with exactly one of the two
    // jellyfin-compat scopes can authenticate here; admin-scoped or multi-scope
    // PATs are rejected.
    if (validated.scopes.length !== 1) {
        logger.debug('PAT scope mismatch for /j/* (multi-scope)', {
            tokenPrefix: validated.tokenPrefix,
            scopes: validated.scopes,
        });
        return null;
    }
    const onlyScope = validated.scopes[0];
    const isReadOnly = onlyScope === 'jellyfin_compat_read';
    if (onlyScope !== 'jellyfin_compat' && !isReadOnly) {
        logger.debug('PAT scope mismatch for /j/* (wrong scope)', {
            tokenPrefix: validated.tokenPrefix,
            scopes: validated.scopes,
        });
        return null;
    }

    // Live-resolve groups, the admin pin, the age-rating pin
    // (`age_rating_pinned`/`max_age_rating`) and the in-app merge via the
    // SAME canonical resolver the /j session path and the play-token path
    // use. Before this fix (security review C9/C10, 2026-09-15/16) a /j PAT
    // never applied the admin's per-user age cap or the in-app ceiling at
    // all.
    //
    // `{ freshGroups: true }` is REQUIRED (security review 5, C4,
    // 2026-09-23), mirroring `token-identity.ts`'s `resolvePatIdentity`:
    // `pat.service.ts` re-reads `users.groups` fresh on EVERY `validate()`
    // call, so a /j PAT's contract — like its `/api/v1` sibling's — is
    // per-request-fresh groups. The resolver's own group cache has a
    // 10-minute TTL and would silently regress that guarantee without this
    // flag. The flag forces the WHOLE resolver row fresh, not just groups
    // (see `resolve-token-user-access.ts`'s own "Freshness override" doc
    // comment for why a fresh-groups/cached-isAdmin split would be unsafe)
    // — the identical class of regression the `/api/v1` PAT sibling was
    // already fixed for. See this module's own
    // `pat-auth-group-freshness.test.ts`.
    //
    // Fail closed: an unresolvable row or a DB error on a cold cache must
    // deny rather than fall back to a hand-derived, potentially-unrestricted
    // context — mirrors resolveTokenUserAccess's own contract and
    // buildPlayTokenUserContext's identical `!access || access.disabled`
    // check.
    const tokenAccess = await resolveTokenUserAccess(validated.username, { freshGroups: true });
    if (!tokenAccess || tokenAccess.disabled || tokenAccess.deleted) {
        logger.warn('PAT auth denied: token user access unresolvable, disabled, or deleted', {
            username: validated.username,
            tokenPrefix: validated.tokenPrefix,
        });
        return null;
    }

    return {
        tokenId: validated.id,
        userId: validated.userId,
        username: validated.username,
        groups: tokenAccess.userGroups.join('|'),
        userGroups: tokenAccess.userGroups,
        ...tokenAccess.permissions,
        // Force isAdmin: false — PATs are never admin on /j/*, regardless of
        // the underlying user's group membership. This must come last in the
        // spread so it overrides any isAdmin: true from permissions.
        ownerIsAdmin: false,
        maxAgeRating: tokenAccess.nonAdminMaxAgeRating ?? tokenAccess.permissions.maxAgeRating,
        isAgeRestricted:
            (tokenAccess.nonAdminMaxAgeRating ?? tokenAccess.permissions.maxAgeRating) !== null,
        isReadOnly,
    };
}
