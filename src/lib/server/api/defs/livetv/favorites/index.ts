// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/favorites/index.ts — GET/PUT /livetv/favorites
 *
 * GET /livetv/favorites
 *   Returns the caller's favorited channel IDs in the user's chosen display
 *   order (pin order for the For You row).
 *   Response: { channelIds }
 *
 * PUT /livetv/favorites
 *   Body: { channelId, favorite } — idempotent add/remove.
 *   Response: { channelIds } (the updated list).
 *
 * Auth: feature:FEATURE_LIVETV → user; the LIVETV_GROUPS membership gate is
 * validated inline (user trait, not a bearer scope) — same as /livetv/channels.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    lockSimpleModeRow,
    simpleModeLocksFavorites,
} from '$lib/server/database/queries/livetv-simple-mode.queries.js';
import {
    getFavoriteChannelIds,
    healNullFavoriteOrder,
    setChannelFavorite,
    resolveStation,
    stationIdsOfFeeds,
    feedStationMap,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    LiveTvFavoriteUpdateSchema,
    LiveTvFavoritesResponseSchema,
    type LiveTvFavoriteUpdate,
} from '$lib/schemas/livetv.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'List your favourite Live TV stations',
            responses: {
                200: {
                    schema: LiveTvFavoritesResponseSchema,
                    description: 'Favorite channel ids in display order',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Add or remove a favourite Live TV station',
            responses: {
                200: {
                    schema: LiveTvFavoritesResponseSchema,
                    description: 'Updated favorite channel ids in display order',
                },
                401: 'Authentication required',
                404: 'Unknown channel',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'FEATURE_LIVETV',
        then: { kind: 'user' },
    },
    request: {
        body: LiveTvFavoriteUpdateSchema,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const { locals } = event;
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const stationIds = await stationIdsOfFeeds(
                sql,
                await getFavoriteChannelIds(sql, locals.user.userId),
            );
            return json(
                { stationIds },
                { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
            );
        },

        PUT: async (event, ctx) => {
            const { locals } = event;
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const body = ctx.input?.body as LiveTvFavoriteUpdate | undefined;
            if (!body) return ApiProblem.validationFailed('Missing body');

            const userId = locals.user.userId;
            // Locked Live TV simple mode: its channels are these favorites. The
            // check runs under the simple-mode row lock inside the write, so a
            // lock set while this request was in flight cannot be slipped past.
            try {
                const locked = await sql.begin(async (txRaw) => {
                    const tx = txRaw as unknown as typeof sql;
                    await lockSimpleModeRow(tx, userId);
                    if (await simpleModeLocksFavorites(tx, userId)) return true;
                    // Heal first: an append ranked against unhealed NULL rows
                    // sorts AHEAD of them (see healNullFavoriteOrder).
                    if (body.favorite) {
                        await healNullFavoriteOrder(tx, userId);
                    }
                    const saved = await getFavoriteChannelIds(tx, userId);
                    const mapping = await feedStationMap(tx, saved);
                    const wanted = body.stationId.toLowerCase();
                    const representatives = saved.filter((id) => mapping.get(id) === wanted);
                    if (body.favorite) {
                        const station = await resolveStation(tx, wanted);
                        if (!station) return 'unknown';
                        if (!representatives.length)
                            await setChannelFavorite(tx, userId, station.shownFeedId, true);
                    } else {
                        // Removing never needs the station to be resolvable: a favourite on a
                        // station whose feeds were all hidden must still be removable.
                        for (const id of representatives)
                            await setChannelFavorite(tx, userId, id, false);
                    }
                    return false;
                });
                if (locked === 'unknown') return ApiProblem.notFound('Unknown station');
                if (locked) {
                    return ApiProblem.forbidden('Live TV simple mode is locked; ask your helper', {
                        details: 'simple_mode_locked',
                    });
                }
            } catch (err) {
                // FK violation → the channel does not exist (or was deleted)
                if ((err as { code?: string }).code === '23503') {
                    return ApiProblem.notFound('Unknown channel');
                }
                throw err;
            }

            const stationIds = await stationIdsOfFeeds(
                sql,
                await getFavoriteChannelIds(sql, userId),
            );
            return json(
                { stationIds },
                { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
            );
        },
    },
});
