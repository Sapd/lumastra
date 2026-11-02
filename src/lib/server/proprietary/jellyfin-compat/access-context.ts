// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Single derivation point for a `/j` request's media access boundary.
 *
 * Before this helper, every `/j` route hand-rolled the same two derivations —
 * `getDeniedLibraryGroups(...)` plus an inline `maxAgeRating != null ? {...} :
 * null` ternary. One handler
 * (`/j/Playlists/[playlistId]/Items`) derived BOTH of them twice within the same
 * request, which is exactly the drift risk the required-by-shape boundary is
 * meant to remove: two derivations can disagree, and the second one silently
 * wins for whichever query it feeds.
 *
 * The context exposes the new {@link MediaAccessBoundary} alongside the legacy
 * `deniedGroupIds` / `ageRating` pair, because some query modules on these
 * routes (`searchMedia`, `getPlaylistItems`) have not been migrated yet. Both
 * views are computed from the same source values, so they cannot disagree.
 */

import type postgres from 'postgres';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type {
    AgeRatingFilterParams,
    MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { config } from '$lib/server/config';

/**
 * The subset of `locals.user` an access boundary is derived from. Structural so
 * both `UserContext` and the looser `AppUserInfo` shape satisfy it.
 */
export interface JellyfinAccessUser {
    ownerIsAdmin?: boolean;
    userGroups?: string[];
    maxAgeRating?: number | null;
}

export interface JellyfinAccessContext {
    /** Required-by-shape boundary. Pass this to migrated query modules. */
    boundary: MediaAccessBoundary;
    /**
     * Legacy library axis, for query modules not yet migrated.
     *
     * @deprecated Use {@link JellyfinAccessContext.boundary}.
     */
    deniedGroupIds: string[] | null;
    /**
     * Legacy age axis, for query modules not yet migrated.
     *
     * @deprecated Use {@link JellyfinAccessContext.boundary}.
     */
    ageRating: AgeRatingFilterParams | null;
}

/**
 * Build the access context for a real, authenticated `/j` user.
 *
 * The boundary is derived from that user's actual permissions — never a
 * permissive default. Admins and unrestricted users legitimately collapse to
 * `{ library: 'all', age: 'any' }` via {@link restrictedAccess}, which is the
 * same set of rows they see today.
 */
export async function buildJellyfinAccessContext(
    sql: postgres.Sql,
    user: JellyfinAccessUser | undefined,
): Promise<JellyfinAccessContext> {
    const deniedGroupIds = await getDeniedLibraryGroups(sql, toLibraryAccessUser(user));
    const maxAgeRating = user?.maxAgeRating ?? null;
    const allowUnrated = config.UNRATED_CONTENT_VISIBLE;

    const ageRating: AgeRatingFilterParams | null =
        maxAgeRating != null ? { maxAgeRating, allowUnrated } : null;

    return {
        boundary: restrictedAccess({
            deniedGroupIds: deniedGroupIds ?? [],
            maxAgeRating,
            allowUnrated,
        }),
        deniedGroupIds,
        ageRating,
    };
}
