// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/series/watch-status.ts — `series/{id}/watch-status`.
 *
 * Redesign contract: per-episode watch status as a `{ items, page }` collection
 * (fast DB-only lookup, no upstream calls). Each item is a self-describing
 * Episode watch-state handle: canonical `id` + `ids{}` + self-describing
 * `images{}` (thumb role, size presets) + a `series.href` deep-link. The
 * roll-up counts ride alongside in a `summary` block.
 *
 * Replaces the legacy `{ success, seriesId, summary, episodes:[…jellyfinId…] }`
 * shape (which carried `episodeJellyfinId` and no images map).
 *
 *   GET /series/{id}/watch-status            → all episodes
 *   GET /series/{id}/watch-status?season=N   → one season
 *
 * Auth: user. ID forms: UUID or tvdb/tmdb/imdb :series handle in the path.
 */

import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveSeriesId } from './resolve-series-id.js';
import {
    getSeriesEpisodesWithWatchStatus,
    getSeasonEpisodesWithWatchStatus,
    type EpisodeWatchStatusRow,
} from '$lib/server/database/queries';
import { isEffectivelyWatched } from '$lib/server/utils/watch-constants.js';
import { WatchStatusCollectionResponseSchema } from '$lib/schemas/api-series-responses';
import { apiUrl } from '$lib/shared/api-urls.js';

const WatchStatusQuery = z
    .object({
        season: z.coerce.number().int().optional(),
    })
    .merge(InheritQuerySchema)
    .meta({
        id: 'SeriesWatchStatusQuery',
        description:
            'Series path accepts UUID or tvdb/tmdb/imdb :series handles; example /series/tvdb:81189:series/watch-status',
    });

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Series'],
            summary: 'Get per-episode watch status for a series',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Accepts UUID and tvdb/tmdb/imdb :series path handles. Returns a `{ items, page, summary }` collection of per-episode watch state ' +
                'for the authenticated user. Fast DB-only lookup. ' +
                'Filter to a single season with `?season=N`.',
            query: z
                .object({
                    season: z.coerce
                        .number()
                        .int()
                        .optional()
                        .meta({ description: 'Season number to filter to' }),
                })
                .merge(InheritQuerySchema),
            responses: {
                200: {
                    schema: WatchStatusCollectionResponseSchema,
                    description: 'Episode watch-status collection with summary',
                },
                401: 'Authentication required',
                404: 'Series not found',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        query: WatchStatusQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) {
                return ApiProblem.unauthorized();
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const seriesInternalId = await resolveSeriesId(event);
            if (!seriesInternalId) {
                return ApiProblem.notFound('Series not found');
            }

            // Access gate — library + age
            if (!(await checkMediaAccess(sql, seriesInternalId, event.locals.user))) {
                return ApiProblem.notFound('Series not found');
            }

            const seasonRaw = event.url.searchParams.get('season');
            const seasonNumber = seasonRaw ? Number.parseInt(seasonRaw, 10) : undefined;

            let episodes: EpisodeWatchStatusRow[];
            if (seasonNumber !== undefined && !Number.isNaN(seasonNumber)) {
                episodes = await getSeasonEpisodesWithWatchStatus.all(sql, {
                    userId,
                    seriesId: seriesInternalId,
                    seasonNumber,
                });
            } else {
                episodes = await getSeriesEpisodesWithWatchStatus.all(sql, {
                    userId,
                    seriesId: seriesInternalId,
                });
            }

            const surface = ctx.surface;

            const total = episodes.length;
            const watched = episodes.filter((e) => isEffectivelyWatched(e)).length;
            const inProgress = episodes.filter(
                (e) => !isEffectivelyWatched(e) && Number(e.resume_position_ms) > 0,
            ).length;

            const imageSets = await resolveImageSets(
                sql,
                surface,
                episodes.map((ep) => ({ id: ep.episode_id, mediaType: 'episode' })),
                ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
            );

            const items = episodes.map((e) => {
                const rawPositionMs = Number(e.resume_position_ms);
                const runtimeMs = e.runtime_ms ? Number(e.runtime_ms) : undefined;
                const playbackPositionMs =
                    runtimeMs && runtimeMs > 0 ? Math.min(rawPositionMs, runtimeMs) : rawPositionMs;
                const progressPercent =
                    runtimeMs && runtimeMs > 0 && playbackPositionMs > 0
                        ? Math.round((playbackPositionMs / runtimeMs) * 100)
                        : 0;
                const playbackPositionTicks = playbackPositionMs * 10000;

                return {
                    id: e.episode_id,
                    type: 'episode' as const,
                    catalogId: e.episode_id,
                    ids: {},
                    seasonNumber: e.season_number ?? undefined,
                    episodeNumber: e.episode_number ?? undefined,
                    images: imageSets.get(e.episode_id) ?? {},
                    series: { href: apiUrl(surface, `/series/${seriesInternalId}`) },
                    user: {
                        isWatched: isEffectivelyWatched(e),
                        playbackPositionTicks,
                        durationMs: runtimeMs,
                        progressPercent,
                        watchedAt: e.last_watched_at ?? undefined,
                        lastProgressAt: e.last_event_at ?? e.last_watched_at ?? undefined,
                    },
                };
            });

            return json({
                ...paginate(items, {
                    limit: items.length,
                    offset: 0,
                    hasMore: false,
                    total,
                }),
                summary: {
                    total,
                    watched,
                    inProgress,
                    unwatched: Math.max(0, total - watched - inProgress),
                },
            });
        },
    },
});
