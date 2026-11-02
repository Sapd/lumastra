// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin thumbs up / down (`/UserItems/{itemId}/Rating?likes=`) on top of
 * Lumastra's 1–10 user ratings.
 *
 * Mapping (written down because both directions are lossy):
 * - likes=true  → rating 8, the web app's "Liked" quick rating.
 * - likes=false → rating 2, the web app's "Not for me" quick rating.
 * - DELETE      → the rating is removed.
 * Both writes are stored as `rating_style = 'quick'`, as a quick-rating tap
 * in the web app is. Reading back, a rating maps to Jellyfin's `Rating`
 * (0–10) as is, and to `Likes` with Jellyfin's own threshold: 6.5 and above
 * is a like, below it a dislike, no rating is null. So a "Liked" (8) or
 * "Loved" (10) from the web app shows as thumbs up, "Meh" (5) as thumbs down.
 *
 * Unlike `UserData`'s `Likes`/`Rating` fields (ignored there: a client sync
 * must not train the taste profile silently), this endpoint is the explicit
 * thumbs button, the same signal as a quick rating in the web app.
 *
 * Only movies, series and episodes can be rated, as in the web app; for any
 * other type the write is skipped and the answer shows the unchanged state.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { JellyfinUserItemData } from './types';
import {
    deleteUserRating,
    ensureUserProfileExists,
    getUserRating,
    upsertUserRating,
} from '$lib/server/database/queries/user-ratings.queries';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries';
import { cacheInvalidation } from '$lib/server/cache';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:UserRating');

export const LIKE_RATING = 8;
export const DISLIKE_RATING = 2;
/** Jellyfin's `UserItemData.MinLikeValue`. */
const MIN_LIKE_RATING = 6.5;

const RATEABLE_TYPES = new Set(['movie', 'tv', 'episode']);

export function likesFromRating(rating: number | null): boolean | null {
    return rating === null ? null : rating >= MIN_LIKE_RATING;
}

/** Parse `likes=`: true/false in any case, else null (missing or invalid). */
export function parseLikes(raw: string | null): boolean | null {
    const v = raw?.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
}

/**
 * Set (`likes` boolean) or clear (`likes` null) the user's rating for an item.
 * Returns false when the item's type cannot be rated (nothing written).
 */
export async function setJellyfinLikes(
    sql: postgres.Sql,
    userId: UserId,
    itemId: string,
    likes: boolean | null,
): Promise<boolean> {
    const mediaType = await getMediaType(sql, itemId);
    if (!mediaType || !RATEABLE_TYPES.has(mediaType)) {
        logger.debug('Rating skipped: type cannot be rated', { itemId, mediaType });
        return false;
    }
    if (likes === null) {
        await deleteUserRating.execute(sql, { userId, mediaId: itemId });
    } else {
        await ensureUserProfileExists(sql, userId);
        await upsertUserRating.execute(sql, {
            userId,
            mediaId: itemId,
            rating: likes ? LIKE_RATING : DISLIKE_RATING,
            ratingStyle: 'quick',
        });
    }
    try {
        await cacheInvalidation.onRatingCacheChanged(userId);
    } catch (err) {
        logger.warn('Rating cache invalidation failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    return true;
}

/** The dto with the user's current rating applied as `Rating` / `Likes`. */
export async function withUserRating(
    sql: postgres.Sql,
    userId: UserId,
    itemId: string,
    data: JellyfinUserItemData,
): Promise<JellyfinUserItemData> {
    const row = await getUserRating.one(sql, { userId, mediaId: itemId });
    const rating = row ? Number(row.rating) : null;
    return { ...data, Rating: rating, Likes: likesFromRating(rating) };
}
