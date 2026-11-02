// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/episode-search.ts — `episode` (search by series + S/E number).
 *
 * Contract (bare object — single resource or null sentinel):
 *   GET /episode?series=...&season=N&episode=N[&seriesTvdbId=...][&seriesTmdbId=...][&seriesImdbId=...]
 *     → { episodeId: string | null, seriesInternalId?: string }
 *   A miss still carries seriesInternalId when an external ID matched the series.
 *
 * Always returns the object (never 404 for "not found" — episodeId=null is the
 * not-found sentinel, preserving backward-compat for the calendar and external callers).
 *
 * Auth: user. Surface: internal.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import {
    findEpisodeBySeriesName,
    findEpisodeBySeriesExternalId,
    findSeriesIdByExternalId,
    type EpisodeByNameLookupResult,
} from '$lib/server/database/queries/episode-search.queries.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('EpisodeSearchDef');

// ---------------------------------------------------------------------------
// Schemas — fully typed, no passthrough
// ---------------------------------------------------------------------------

export const EpisodeSearchResponseSchema = z.object({
    episodeId: z.string().nullable(),
    /** The internal UUID of the matching series, if found */
    seriesInternalId: z.string().guid().optional(),
});

export type EpisodeSearchResponse = z.infer<typeof EpisodeSearchResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        GET: async (event, _ctx) => {
            const { url } = event;

            const series = url.searchParams.get('series');
            const seasonParam = url.searchParams.get('season');
            const episodeParam = url.searchParams.get('episode');
            const seriesTvdbId = url.searchParams.get('seriesTvdbId');
            const seriesTmdbId = url.searchParams.get('seriesTmdbId');
            const seriesImdbId = url.searchParams.get('seriesImdbId');

            if (!seasonParam || !episodeParam) {
                return ApiProblem.validationFailed([
                    { field: 'query', message: 'Missing season or episode query parameters' },
                ]);
            }
            if (!series && !seriesTvdbId && !seriesTmdbId && !seriesImdbId) {
                return ApiProblem.validationFailed([
                    {
                        field: 'query',
                        message:
                            'Provide series name or one of seriesTvdbId/seriesTmdbId/seriesImdbId',
                    },
                ]);
            }

            const season = parseInt(seasonParam, 10);
            const episode = parseInt(episodeParam, 10);
            if (isNaN(season) || isNaN(episode)) {
                return ApiProblem.validationFailed([
                    { field: 'query', message: 'Invalid season or episode number' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            const access = {
                deniedGroupIds: accessCtx.deniedGroupIds,
                ageRating: accessCtx.ageRating,
            };

            let result: EpisodeByNameLookupResult | null = null;

            // 1. Prefer authoritative external IDs.
            const idCandidates: Array<{ provider: 'tmdb' | 'tvdb' | 'imdb'; value: string }> = [];
            if (seriesTmdbId) idCandidates.push({ provider: 'tmdb', value: seriesTmdbId });
            if (seriesTvdbId) idCandidates.push({ provider: 'tvdb', value: seriesTvdbId });
            if (seriesImdbId) idCandidates.push({ provider: 'imdb', value: seriesImdbId });

            for (const { provider, value } of idCandidates) {
                result = await findEpisodeBySeriesExternalId(
                    sql,
                    provider,
                    value,
                    season,
                    episode,
                    access,
                );
                if (result) break;
            }

            // 2. A series found by ID that lacks this episode is still the right
            //    series. Answer with it and skip the name fallback, which would
            //    pick a same-title series that has the S/E (a revival's
            //    S2E9 → the original show's S2E9).
            let seriesByIdOnly: string | null = null;
            if (!result) {
                for (const { provider, value } of idCandidates) {
                    seriesByIdOnly = await findSeriesIdByExternalId(sql, provider, value, access);
                    if (seriesByIdOnly) break;
                }
            }

            // 3. Fall back to name-based lookup that disambiguates by S/E.
            if (!result && !seriesByIdOnly && series) {
                result = await findEpisodeBySeriesName(sql, series, season, episode, access);
            }

            if (result) {
                logger.info('Found episode in database', {
                    searchSeries: series ?? '(by external id)',
                    foundSeries: result.seriesTitle,
                    season,
                    episode,
                    episodeId: result.id,
                });
                return json({
                    episodeId: result.id,
                    seriesInternalId: result.seriesId ?? undefined,
                } satisfies EpisodeSearchResponse);
            }

            logger.info('Episode not found', {
                series,
                season,
                episode,
                seriesInternalId: seriesByIdOnly,
            });
            return json({
                episodeId: null,
                seriesInternalId: seriesByIdOnly ?? undefined,
            } satisfies EpisodeSearchResponse);
        },
    },
});
