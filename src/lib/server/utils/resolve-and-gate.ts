// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical resolve-then-gate helper for mutation routes.
 *
 * Every user-state mutation route follows the same shape:
 *   1. Caller supplies provider-side IDs (tmdb/imdb/jellyfin/etc.)
 *   2. Service resolves them to an internal media_items UUID.
 *   3. Service checks the caller can access that UUID (library + age).
 *   4. Service writes user_ratings / user_watchlist / user_music_flags / etc.
 *
 * Three managers each implemented this pattern with their own error class
 * (RatingAccessDeniedError, WatchlistAccessDeniedError,
 * MusicInteractionAccessDeniedError). They were structurally identical:
 * the route catches the error and returns 404 — `notFound` rather than
 * `forbidden` so the response doesn't reveal whether the item exists.
 *
 * This helper folds them into a single primitive. New mutation routes
 * should call `resolveAndGate(...)` rather than reimplementing the
 * resolve+check pair.
 */

import type postgres from 'postgres';
import type { ExternalIds } from '$lib/types/api-common.js';
import type { UserContext } from '$lib/server/types.js';
import { resolveExternalIdsToMediaId } from '$lib/server/utils/media-resolution.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

/**
 * Thrown when the caller supplied a media-resolvable ID but is not
 * allowed to access the resolved row (library group or age policy).
 * Routes map this to 404 so existence is not revealed.
 */
export class MediaAccessDeniedError extends Error {
    constructor() {
        super('Media not accessible');
        this.name = 'MediaAccessDeniedError';
    }
}

/**
 * Thrown when the caller's external IDs do not resolve to any known
 * media item. Routes typically map this to 400 (bad request).
 */
export class MediaNotResolvableError extends Error {
    constructor() {
        super('No valid external IDs provided');
        this.name = 'MediaNotResolvableError';
    }
}

/**
 * Resolve external IDs to an internal UUID and verify the caller can
 * access that media item. Throws `MediaNotResolvableError` if the IDs
 * don't resolve, `MediaAccessDeniedError` if they resolve to media the
 * caller can't see.
 *
 * Use this in any route that takes a caller-supplied media ID and
 * writes user state. Do not call `resolveExternalIdsToMediaId` directly
 * from a mutation route — the access check is mandatory.
 *
 * @example
 *   const { mediaId } = await resolveAndGate(sql, externalIds, mediaType, locals.user);
 *   await userRatings.insert({ userId, mediaId, rating });
 */
export async function resolveAndGate(
    sql: postgres.Sql,
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv' | 'audiobook',
    user: UserContext,
    title?: string,
): Promise<{ mediaId: string }> {
    // Defense-in-depth: `user` is required by the type system, but dynamic
    // callers (non-TS code paths, JSDoc-typed services) could pass
    // undefined. checkMediaAccess returns true for undefined user (its
    // documented permissive-default for unauthenticated paths), which
    // would silently bypass the gate. Reject explicitly here so a
    // mutation route can never write user state for an unverified caller.
    if (!user) {
        throw new MediaAccessDeniedError();
    }
    const mediaId = await resolveExternalIdsToMediaId(sql, externalIds, mediaType, title);
    if (!mediaId) {
        throw new MediaNotResolvableError();
    }
    // Fail closed on checkMediaAccess errors. The default postgres failure
    // path would surface a 500 to the route, which is correct for transient
    // DB errors — but a route's catch that ONLY handles MediaAccessDeniedError
    // would let the original error escape unwrapped. Re-throw the typed
    // error so route catches behave uniformly.
    let allowed: boolean;
    try {
        allowed = await checkMediaAccess(sql, mediaId, user);
    } catch {
        throw new MediaAccessDeniedError();
    }
    if (!allowed) {
        throw new MediaAccessDeniedError();
    }
    return { mediaId };
}
