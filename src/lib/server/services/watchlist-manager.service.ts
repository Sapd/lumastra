// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '$lib/server/utils/logger.js';
import { resolveExternalIdsToMediaId } from '$lib/server/utils/media-resolution.js';
import { cacheInvalidation } from '$lib/server/cache';
import {
    upsertWatchlistItem,
    getMediaTitle,
    deleteWatchlistItem,
    WatchlistMediaTypeNotAllowedError,
} from '$lib/server/database/queries/watchlist.queries.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import type { UserContext } from '$lib/server/types.js';
import { resolveAndGate, MediaNotResolvableError } from '$lib/server/utils/resolve-and-gate.js';

/**
 * @deprecated Use `MediaAccessDeniedError` from `$lib/server/utils/resolve-and-gate.js`.
 * Re-exported alias to keep existing route imports working during the migration window.
 * Aliasing the class on re-export carries both its value and type bindings without
 * the const+type declaration-merge that `no-redeclare` rejects.
 */
export { MediaAccessDeniedError as WatchlistAccessDeniedError } from '$lib/server/utils/resolve-and-gate.js';

const logger = Logger.for('WatchlistManager');

export interface WatchlistAddParams {
    sql: postgres.Sql;
    userId: UserId;
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv' | 'audiobook';
    title?: string;
    /**
     * Caller's user context. Required so adds cannot persist for media
     * the caller is no longer permitted to see (e.g. someone with the
     * raw provider ID for a restricted-library title).
     */
    user: UserContext;
    /**
     * Skip activity-feed tracking for this add. Used by bulk-import flows
     * (e.g. Jellyfin favorites import) so importing hundreds of items in one
     * action doesn't flood the user's own activity feed with one entry per
     * item. Cache invalidation and the upsert itself are unaffected.
     */
    skipActivityFeed?: boolean;
}

export interface WatchlistRemoveParams {
    sql: postgres.Sql;
    userId: UserId;
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv' | 'audiobook';
    /**
     * Removes do not need a media-access check — letting a user clear
     * a saved entry they can no longer view is the safer default.
     */
}

export interface WatchlistResult {
    saved?: boolean;
    removed?: boolean;
    mediaId: string | null;
    /**
     * True when `mediaId: null` was caused by `upsertWatchlistItem` rejecting
     * a real, disallowed-type media row — NOT by the external IDs failing to
     * resolve at all. Callers (`defs/watchlist/index.ts`, `defs/ai/save-movie.ts`)
     * read this to give a validation-failed response its correct message; both
     * cases still return the same status and response shape as before, only
     * the message text differs. See the comment above the call site in
     * `addItem` for why this is a live path, not defensive dead code.
     */
    mediaTypeRejected?: boolean;
    /**
     * True when the item was ALREADY on the watchlist before this call.
     * Nothing about the existing row is touched or refreshed in that case —
     * `upsertWatchlistItem` only reads it back (`SELECT … LIMIT 1`) to
     * report `inserted: false`; there is no timestamp bump.
     *
     * `saved` cannot express this: the upsert's result array is non-empty
     * for both a fresh insert and a repeat add (see
     * `WatchlistUpsertRow.inserted`), so `saved` is unconditionally true for
     * either. Callers that must tell the user what actually changed (the
     * assistant's `add_to_watchlist` tool) read this instead. `undefined`
     * means unknown — never report it as "already there".
     */
    alreadyPresent?: boolean;
}

class WatchlistManager {
    async addItem(params: WatchlistAddParams): Promise<WatchlistResult> {
        const { sql, userId, externalIds, mediaType, title, user } = params;

        // resolveAndGate throws on either no-resolve or access-denied.
        // We catch MediaNotResolvableError to preserve the legacy
        // `{ saved: false, mediaId: null }` shape that the route maps
        // to 400; MediaAccessDeniedError propagates and becomes a 404.
        let mediaId: string;
        try {
            ({ mediaId } = await resolveAndGate(sql, externalIds, mediaType, user, title));
        } catch (err) {
            if (err instanceof MediaNotResolvableError) {
                return { saved: false, mediaId: null };
            }
            throw err;
        }

        // NOT unreachable: `mediaType` is typed 'movie' | 'tv' | 'audiobook'
        // on this method's params, but `resolveAndGate` → `resolveExternalIdsToMediaId`
        // has an `internal`-UUID fast path (media-resolution.ts) that returns
        // the caller-supplied UUID VERBATIM, with no check that the row it
        // names actually has the claimed `mediaType`. The body schemas for
        // both callers of this method (`defs/watchlist/index.ts`,
        // `defs/ai/save-movie.ts`) accept a free-form `externalIds` map, so an
        // authenticated caller can send
        // `{"externalIds":{"internal":"<episode uuid>"},"mediaType":"movie",...}`
        // and reach this catch — `checkMediaAccess` only checks existence and
        // visibility, not type. This is the same enforcement point the
        // unguarded `/j` Jellyfin favorites path relies on, but it is a live
        // path here too, not just future-proofing.
        let resultRows;
        try {
            resultRows = await upsertWatchlistItem(sql, userId, mediaId);
        } catch (err) {
            if (err instanceof WatchlistMediaTypeNotAllowedError) {
                return { saved: false, mediaId: null, mediaTypeRejected: true };
            }
            throw err;
        }

        // Track in activity feed (fire-and-forget). Guarded on resultRows
        // being non-empty — the sole way it comes back empty is the race
        // documented on WatchlistUpsertRow.inserted: the media row vanished
        // between resolve and insert, so nothing was actually added. Without
        // this guard the feed recorded an "add" event for a save that never
        // happened, same class of bug removeItem already avoids.
        if (!params.skipActivityFeed && resultRows.length > 0) {
            try {
                const { activityFeedService } =
                    await import('$lib/server/services/activity-feed.service');
                await activityFeedService.trackWatchlistEvent(userId, 'add', {
                    // `mediaId` is the INTERNAL UUID. Passing it as
                    // `primary_ext_id` sent a UUID into watchlist_activities.tmdb_id
                    // (an integer column); Postgres rejected every insert and the
                    // catch below swallowed it, so watchlist add/remove events have
                    // been silently absent from the activity feed since 2026-02-10.
                    media_id: mediaId,
                    media_type: mediaType,
                    title: title ?? 'Unknown',
                });
            } catch (feedError) {
                logger.warn(
                    'Failed to track watchlist add in activity feed',
                    { mediaId },
                    feedError as Error,
                );
            }
        }

        // Invalidate suggestion caches
        try {
            await cacheInvalidation.onWatchlistChange(userId, mediaId);
        } catch (error) {
            logger.warn('Failed to invalidate cache after watchlist add', {
                userId,
                error: String(error),
            });
        }

        logger.info('Item added to watchlist', { userId, mediaId });

        return {
            saved: resultRows.length > 0,
            alreadyPresent: resultRows[0]?.inserted === false,
            mediaId,
        };
    }

    async removeItem(params: WatchlistRemoveParams): Promise<WatchlistResult> {
        const { sql, userId, externalIds, mediaType } = params;

        const mediaId = await resolveExternalIdsToMediaId(sql, externalIds, mediaType);
        if (!mediaId) {
            return { removed: false, mediaId: null };
        }

        // Get title before deleting (for activity feed)
        let title = 'Unknown';
        try {
            title = (await getMediaTitle(sql, mediaId)) ?? 'Unknown';
        } catch (err) {
            logger.warn('Failed to get title before deletion', { userId, mediaId }, err as Error);
        }

        const deleteResultRows = await deleteWatchlistItem(sql, userId, mediaId);

        // Track in activity feed
        if (deleteResultRows.length > 0) {
            try {
                const { activityFeedService } =
                    await import('$lib/server/services/activity-feed.service');
                await activityFeedService.trackWatchlistEvent(userId, 'remove', {
                    // Internal UUID — see the `add` branch above.
                    media_id: mediaId,
                    media_type: mediaType,
                    title,
                });
            } catch (feedError) {
                logger.warn(
                    'Failed to track watchlist remove in activity feed',
                    { userId, mediaId },
                    feedError as Error,
                );
            }
        }

        // Invalidate suggestion caches
        try {
            await cacheInvalidation.onWatchlistChange(userId, mediaId);
        } catch (error) {
            logger.warn('Failed to invalidate cache after watchlist remove', {
                userId,
                error: String(error),
            });
        }

        logger.info('Item removed from watchlist', { userId, mediaId });

        return { removed: deleteResultRows.length > 0, mediaId };
    }
}

export const watchlistManager = new WatchlistManager();
