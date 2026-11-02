// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/series/progress.ts — `series/{id}/progress`.
 *
 * Contract (bare object — single resource):
 *   GET /series/{id}/progress → {
 *     seriesId, seriesName, totalSeasons, totalEpisodes,
 *     watchedEpisodes, progressPercentage, completionStatus,
 *     currentEpisode, lastWatchedAt
 *   }
 *
 * Returns a zero-state object (not 404) when the series has no watch history.
 * Auth: user. Surface: internal (SPA-only, no external automation value).
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveSeriesId } from './resolve-series-id.js';
import { computeSeriesProgress } from '$lib/server/database/queries/watch-state.queries.js';
import { buildOverrideAwareMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';

// ---------------------------------------------------------------------------
// Response schema — fully typed, no z.any / passthrough
// ---------------------------------------------------------------------------

export const SeriesProgressResponseSchema = z.object({
    seriesId: z.string(),
    seriesName: z.string().nullable(),
    totalSeasons: z.number().int().nullable(),
    totalEpisodes: z.number().int(),
    watchedEpisodes: z.number().int(),
    progressPercentage: z.number(),
    completionStatus: z.string(),
    currentEpisode: z
        .object({
            episodeId: z.string().nullable(),
            seasonNumber: z.number().int().nullable(),
            episodeNumber: z.number().int().nullable(),
            title: z.string().nullable(),
        })
        .nullable(),
    lastWatchedAt: z.string().nullable(),
});

export type SeriesProgressResponse = z.infer<typeof SeriesProgressResponseSchema>;

type SeriesInfoRow = {
    series_uuid: string;
    title: string;
    total_seasons: number | null;
    total_episodes: number | null;
};

type EpisodeRow = {
    id: string;
    season_number: number | null;
    episode_number: number | null;
    title: string | null;
};

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        GET: async (event, _ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const seriesInternalId = await resolveSeriesId(event);
            if (!seriesInternalId) return ApiProblem.notFound('Series not found');

            // Library + age gate
            if (!(await checkMediaAccess(sql, seriesInternalId, event.locals.user))) {
                return ApiProblem.notFound('Series not found');
            }

            const zero = (
                name: string | null,
                totalSeasons: number | null,
            ): SeriesProgressResponse => ({
                seriesId: seriesInternalId,
                seriesName: name,
                totalSeasons,
                totalEpisodes: 0,
                watchedEpisodes: 0,
                progressPercentage: 0,
                completionStatus: 'not_started',
                currentEpisode: null,
                lastWatchedAt: null,
            });

            const seriesResults = await sql<SeriesInfoRow[]>`
                SELECT
                    mi.id as series_uuid,
                    mi.title,
                    (pm.metadata->>'total_seasons')::integer as total_seasons,
                    (pm.metadata->>'total_episodes')::integer as total_episodes
                FROM media_items mi
                ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
                WHERE mi.id = ${seriesInternalId}::uuid
                  AND mi.media_type IN ('tv', 'series')
                  AND mi.status = 'active'
                LIMIT 1
            `;
            const seriesInfo = seriesResults[0];

            if (!seriesInfo) {
                return json(zero(null, null) satisfies SeriesProgressResponse);
            }

            const progress = await computeSeriesProgress(sql, userId, seriesInternalId);

            if (!progress) {
                return json(
                    zero(
                        seriesInfo.title,
                        seriesInfo.total_seasons,
                    ) satisfies SeriesProgressResponse,
                );
            }

            let currentEpisode: SeriesProgressResponse['currentEpisode'] = null;
            if (progress.current_episode_media_id) {
                const episodeResults = await sql<EpisodeRow[]>`
                    SELECT
                        ep.id,
                        ep.season_number,
                        ep.episode_number,
                        ep.title
                    FROM media_items ep
                    WHERE ep.id = ${progress.current_episode_media_id}::uuid
                      AND ep.media_type = 'episode'
                    LIMIT 1
                `;
                const episode = episodeResults[0];
                if (episode) {
                    currentEpisode = {
                        episodeId: episode.id,
                        seasonNumber: episode.season_number,
                        episodeNumber: episode.episode_number,
                        title: episode.title,
                    };
                }
            }

            const totalEpisodes = progress.total_episodes || seriesInfo.total_episodes || 0;
            const progressPercentage =
                totalEpisodes > 0
                    ? Math.round((progress.watched_episodes / totalEpisodes) * 1000) / 10
                    : 0;

            return json({
                seriesId: seriesInternalId,
                seriesName: seriesInfo.title,
                totalSeasons: seriesInfo.total_seasons,
                totalEpisodes,
                watchedEpisodes: progress.watched_episodes,
                progressPercentage,
                completionStatus: progress.completion_status,
                currentEpisode,
                lastWatchedAt: progress.last_watched_at,
            } satisfies SeriesProgressResponse);
        },
    },
});
