// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/series/next-episode.ts — `series/{id}/next-episode`.
 *
 * Redesign contract: returns a SINGLE Episode node (not a collection — there is
 * exactly one "next" episode per user/series), matching the `episodes/{id}`
 * detail node: canonical `id` + `ids{}` + self-describing `images{}` (thumb
 * role, size presets) + a `series.href` deep-link. `404 not_found` when there
 * is no unwatched episode.
 *
 *   GET /series/{id}/next-episode                       → next unwatched episode
 *   GET /series/{id}/next-episode?season=N&episode=M    → that specific episode
 *   GET /series/{id}/next-episode?afterPlayback=<uuid>  → episode after that episode's file
 *
 * Replaces the legacy `{ id, name, runtimeTicks, imageTag, source }` shape.
 *
 * Auth: user. ID forms: UUID or tvdb/tmdb/imdb :series handle in the path.
 */

import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveSeriesId } from './resolve-series-id.js';
import { effectiveNextUpForSeries } from '$lib/server/services/effective-next-up.service.js';
import {
    findEffectiveRuntimeSeconds,
    findEpisodeDataByPosition,
    findPlaybackDurationMs,
} from '$lib/server/database/queries/media-items.queries.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';
import { NextEpisodeNodeSchema } from '$lib/schemas/api-series-responses';
import { findNextSequentialEpisode } from '$lib/server/database/queries/episode-search.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { apiUrl } from '$lib/shared/api-urls.js';

const NextEpisodeQuery = z
    .object({
        season: z.coerce.number().int().optional(),
        episode: z.coerce.number().int().optional(),
        afterPlayback: z.string().uuid().optional(),
    })
    .merge(InheritQuerySchema)
    .meta({
        id: 'NextEpisodeQuery',
        description:
            'Series path accepts UUID or tvdb/tmdb/imdb :series handles; example /series/tvdb:81189:series/next-episode',
    });

interface NextEpisodeNode {
    id: string;
    catalogId: string;
    type: 'episode';
    ids: Record<string, string>;
    title: string;
    seasonNumber: number;
    episodeNumber: number;
    overview?: string;
    premiereDate?: string;
    durationMs: number | null;
    playable?: boolean;
    images: ImageSet;
    series: { href: string };
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Series'],
            summary: 'Get next unwatched episode for a series',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Accepts UUID and tvdb/tmdb/imdb :series path handles. Returns the next unwatched canonical Episode node for the authenticated user. ' +
                'Use `?season=N&episode=M` to fetch a specific episode by position. ' +
                'Use `?afterPlayback=<episode UUID>` to advance past a consumed default file in active ordering, independent of watch history. ' +
                '`404 not_found` when there is no next episode.',
            query: z
                .object({
                    season: z.coerce
                        .number()
                        .int()
                        .optional()
                        .meta({ description: 'Season number for explicit lookup' }),
                    episode: z.coerce
                        .number()
                        .int()
                        .optional()
                        .meta({ description: 'Episode number for explicit lookup' }),
                    afterPlayback: z.string().uuid().optional().meta({
                        description:
                            'Return the episode after this episode’s whole default file, in active ordering, independent of watch history',
                    }),
                })
                .merge(InheritQuerySchema),
            responses: {
                200: {
                    schema: NextEpisodeNodeSchema,
                    description: 'Next unwatched episode node',
                },
                401: 'Authentication required',
                404: 'No next episode available',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        query: NextEpisodeQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            const userId = user?.userId;
            if (!user || !userId) {
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

            const surface = ctx.surface;
            const seriesHref = apiUrl(surface, `/series/${seriesInternalId}`);

            // Per-user metadata-language overlay (multilingual-media-metadata
            // spec §5), resolved ONCE per request and shared by both branches
            // below. Neither branch is cached in this handler, so each `node`
            // is mutated in place once built — no clone needed.
            let langs = { titleLang: null as string | null, textLang: null as string | null };
            if (config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                langs = resolveMetadataLanguage(await getPlaybackPreferences.one(sql, { userId }));
            }

            const afterPlayback = ctx.input?.query?.afterPlayback;
            if (afterPlayback && !(await checkMediaAccess(sql, afterPlayback, event.locals.user))) {
                return ApiProblem.notFound('Episode not found');
            }

            // ── Explicit episode lookup (?season=X&episode=Y) ──
            const seasonParam = event.url.searchParams.get('season');
            const episodeParam = event.url.searchParams.get('episode');
            if (!afterPlayback && seasonParam && episodeParam) {
                const season = Number.parseInt(seasonParam, 10);
                const episode = Number.parseInt(episodeParam, 10);
                if (!Number.isNaN(season) && !Number.isNaN(episode)) {
                    const ep = await findEpisodeDataByPosition(
                        sql,
                        seriesInternalId,
                        season,
                        episode,
                    );
                    // The series gate above does not cover an episode whose
                    // files sit in a library group the caller is denied.
                    if (!ep || !(await checkMediaAccess(sql, ep.id, event.locals.user)))
                        return ApiProblem.notFound('Episode not found');
                    const runtimeSeconds =
                        ep.runtimeSeconds || (await findEffectiveRuntimeSeconds(sql, ep.id));
                    // The one playback duration /media/{id} and the episode lists
                    // report (window, probed file, runtime); the effective runtime
                    // only when that has none.
                    const durationMs =
                        (await findPlaybackDurationMs(sql, ep.id)) ??
                        (runtimeSeconds ? Math.round(runtimeSeconds * 1000) : null);
                    const node: NextEpisodeNode = {
                        id: ep.id,
                        type: 'episode',
                        catalogId: ep.id,
                        ids: {},
                        title: ep.title,
                        seasonNumber: ep.seasonNumber,
                        episodeNumber: ep.episodeNumber,
                        durationMs,
                        // The client greys out "Watch SxEy" for an episode
                        // without a file instead of playing another one.
                        playable: ep.hasFiles,
                        images: await resolveImageSet(
                            sql,
                            surface,
                            ep.id,
                            'episode',
                            ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
                        ),
                        series: { href: seriesHref },
                    };
                    if (langs.titleLang || langs.textLang) {
                        // This branch's node has no `overview` field to overlay
                        // (findEpisodeDataByPosition never populates one) — title
                        // only, pre-existing gap, out of scope here.
                        await applyTranslationOverlay(sql, [node], langs, {
                            id: (it) => it.id,
                            setTitle: (it, v) => {
                                it.title = v;
                            },
                        });
                    }
                    return json(node);
                }
            }

            // ── Automatic next-episode resolution ──
            // The boundary goes into the SQL so a hidden next episode is
            // skipped (the chain continues at the next VISIBLE one) instead
            // of being picked and then 404ing below.
            const nextRow = afterPlayback
                ? await findNextSequentialEpisode(sql, seriesInternalId, afterPlayback, {
                      afterCurrentFile: true,
                      playableOnly: true,
                      specialsStayInSeason: true,
                      access: searchAccessBoundary(await buildSearchAccessContext(sql, user)),
                  })
                : null;
            const episode = afterPlayback
                ? nextRow && { ...nextRow, media_id: nextRow.id, premiere_date: null }
                : (await effectiveNextUpForSeries({ userId, seriesId: seriesInternalId })).episode;

            if (!episode) {
                return ApiProblem.notFound('No next episode available');
            }

            if (
                afterPlayback &&
                !(await checkMediaAccess(sql, episode.media_id, event.locals.user))
            ) {
                return ApiProblem.notFound('No next episode available');
            }

            const id = episode.media_id;
            if (!id) {
                return ApiProblem.notFound('No next episode available');
            }

            const runtimeSeconds =
                episode.runtime_seconds ||
                (episode.media_id
                    ? await findEffectiveRuntimeSeconds(sql, episode.media_id)
                    : null);
            const durationMs =
                (await findPlaybackDurationMs(sql, id)) ??
                (runtimeSeconds ? Math.round(runtimeSeconds * 1000) : null);
            // `premiere_date` is typed `string | null`, but postgres.js hands
            // back a `Date` for timestamp columns at runtime — narrow through
            // `unknown` + an `instanceof` type guard (a primitive-only union is
            // an invalid `instanceof` LHS, TS2358) so both shapes are handled.
            const rawPremiere: unknown = episode.premiere_date;
            const premiereDate = rawPremiere
                ? rawPremiere instanceof Date
                    ? rawPremiere.toISOString()
                    : String(rawPremiere)
                : undefined;

            const node: NextEpisodeNode = {
                id,
                type: 'episode',
                catalogId: id,
                ids: {},
                title: episode.title,
                seasonNumber: episode.season_number,
                episodeNumber: episode.episode_number,
                overview: episode.overview || undefined,
                premiereDate,
                durationMs,
                images: await resolveImageSet(
                    sql,
                    surface,
                    id,
                    'episode',
                    ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
                ),
                series: { href: seriesHref },
            };

            if (langs.titleLang || langs.textLang) {
                await applyTranslationOverlay(sql, [node], langs, {
                    id: () => id,
                    setTitle: (it, v) => {
                        it.title = v;
                    },
                    setOverview: (it, v) => {
                        it.overview = v;
                    },
                });
            }

            return json(node);
        },
    },
});
