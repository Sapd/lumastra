// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/watched
 *
 * Returns all items the authenticated user has watched, keyed by
 * externalIds. Used internally by the SPA recommendation filter and
 * the "watched" overlay in the browse grid.
 *
 * Response: bare object { watchedItems, cached? }
 * DB-down: 503 dependency_unavailable (never 200-empty)
 *
 * mediaType is emitted as the canonical public discriminator: 'movie' |
 * 'series' (never 'tv').
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    getCachedWatchedIds,
    setCachedWatchedIds,
    type WatchedItem,
} from '$lib/server/services/watched-cache.service.js';
import { getWatchedItems, getUserIdByUsername } from '$lib/server/database/queries/index.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { config } from '$lib/server/config.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('WatchedIndexDef');

/**
 * Transform a cached WatchedItem to the API response shape.
 *
 * Uses provider-agnostic externalIds. `mediaType` is the canonical public
 * discriminator — `series`, never the stored `tv`.
 *
 * This function used to emit `item.media_type` raw, with a comment claiming
 * `tv` was kept deliberately "to avoid a schema validation mismatch" while the
 * file header directly above promised the opposite. Both cannot be true: the
 * header was the intent, the code was the bug, and the SPA schema was pinned to
 * the bug. `WatchedItemResponseSchema` now declares ['movie','series'] to match.
 *
 * Inline rather than toPublicMediaType(): `media_type` here is the closed
 * movie|tv pair this endpoint selects on, so the pass-through arm cannot carry
 * a token the public vocabulary lacks. See docs/dev/media-type-vocabulary.md.
 */
function toWatchedItemResponse(item: WatchedItem) {
    return {
        externalIds: {
            ...(item.internal_id ? { internal: item.internal_id } : {}),
            [getPrimaryExternalIdProvider()]: String(item.tmdb_id),
        },
        mediaType: item.media_type === 'tv' ? 'series' : item.media_type,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        GET: async (event) => {
            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            // Resolve effective username → stable userId UUID.
            // Fast-path: authenticated user IS the effective user.
            const effectiveUserId =
                effectiveUsername === event.locals.user?.username
                    ? event.locals.user?.userId
                    : await getUserIdByUsername(sql, effectiveUsername);

            if (!effectiveUserId) {
                // Unknown dev-override user / never provisioned — return empty.
                return json({ watchedItems: [] });
            }

            // Check cache first (keyed by UUID).
            const cached = await getCachedWatchedIds(effectiveUserId);
            if (cached) {
                return json({
                    watchedItems: cached.map(toWatchedItemResponse),
                    cached: true,
                });
            }

            // Fetch from DB — includes media_type to avoid TMDB ID collisions.
            try {
                // Explicitly unrestricted. getWatchedItems has no media_items row
                // in scope and cannot bind the access predicates (see the query
                // module docstring), so this endpoint returns TMDB ids for
                // everything the user marked watched, including items now in a
                // denied library group. Pre-existing and preserved deliberately.
                //
                // If that is ever closed, getWatchedCacheKey(userId) must gain a
                // boundary component first: the entry is keyed by user UUID alone,
                // so a change to the user's library-group membership or
                // max_age_rating would otherwise keep serving the old row set for
                // the rest of the TTL. Both writers of that entry (here and
                // WatchManager.getWatchedExternalIdSetCached) must change together.
                const watched = await getWatchedItems.all(sql, {
                    userId: effectiveUserId,
                    access: unrestrictedAccess(),
                });

                const watchedItems: WatchedItem[] = watched.map((w) => ({
                    internal_id: w.internal_id ?? null,
                    tmdb_id: w.tmdb_id,
                    media_type: w.media_type,
                }));

                await setCachedWatchedIds(effectiveUserId, watchedItems);

                return json({ watchedItems: watchedItems.map(toWatchedItemResponse) });
            } catch (err) {
                logger.error('Failed to load watched items', err as Error);
                return ApiProblem.internalError('Failed to load watched items');
            }
        },
    },
});
