// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { localizeNodes } from './localize-nodes.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getSeriesEpisodesWithWatchState,
    type SeriesEpisodeRow,
} from '$lib/server/database/queries/episode-detail.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import {
    buildVirtualSeasonHandle,
    type SeasonOrdering,
} from '$lib/server/services/media-handle.js';
import { buildPlaybackProgress } from '$lib/schemas/api-playback-progress.js';
import { MediaPreviewSchema, type MediaPreview } from '$lib/schemas/api-media-preview.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { EpisodesCollectionResponseSchema } from '$lib/schemas/api-series-responses.js';
import { isEffectivelyWatched } from '$lib/server/utils/watch-constants.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { findPlaybackDurationsMs } from '$lib/server/database/queries/media-items.queries.js';
import { resolveSeriesId } from './resolve-series-id.js';

const INT32_MAX = 2147483647;

export const EpisodesQuery = z
    .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        specials: z.enum(['include', 'exclude', 'only']).default('include'),
        season: z.coerce.number().int().min(0).max(INT32_MAX).optional(),
        episode: z.coerce.number().int().min(0).max(INT32_MAX).optional(),
        physicalSeasonId: z
            .uuid()
            .optional()
            .describe('Physical grouping link supplied by /seasons/{uuid}'),
        absolute: z.coerce.number().int().min(1).max(INT32_MAX).optional(),
    })
    .merge(InheritQuerySchema)
    .meta({
        id: 'SeriesEpisodesQuery',
        description:
            'Stable episode walk with specials last; example ?limit=50&offset=0&specials=exclude',
    });

/** Virtual handle for non-standard orderings; falls back to the physical season id when it cannot be built. */
function episodeSeasonId(ep: SeriesEpisodeRow): string | undefined {
    if (ep.ordering === 'standard') return ep.season_id ?? undefined;
    try {
        return buildVirtualSeasonHandle(
            ep.series_id!,
            ep.ordering as SeasonOrdering,
            ep.season_number,
        );
    } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return ep.season_id ?? undefined;
    }
}

/**
 * `playbackDurationMs` is the episode's duration from findPlaybackDurationsMs (the
 * one source /media/{id} also uses). Without it, the older user-state runtime or
 * the metadata runtime is used.
 */
export function episodePreview(
    ep: SeriesEpisodeRow,
    images: ImageSet,
    playbackDurationMs?: number | null,
): MediaPreview {
    const ids: Record<string, string> = {};
    if (ep.primary_ext_id) ids[getPrimaryExternalIdProvider()] = ep.primary_ext_id;
    if (ep.imdb_id) ids.imdb = ep.imdb_id;
    const durationMs =
        playbackDurationMs ??
        (ep.runtime_ms
            ? Number(ep.runtime_ms)
            : ep.runtime_seconds
              ? ep.runtime_seconds * 1000
              : null);
    return {
        id: ep.id,
        catalogId: ep.id,
        type: 'episode',
        ids,
        title: ep.title || `Episode ${ep.episode_number}`,
        overview: ep.overview ?? undefined,
        durationMs: durationMs ?? undefined,
        images,
        originalLanguage: ep.original_language ?? undefined,
        audioLanguages: ep.audio_languages,
        subtitleLanguages: ep.subtitle_languages,
        segments: ep.segments ?? undefined,
        availability: { isAvailable: ep.has_file, hasFile: ep.has_file, canRequest: false },
        progress: buildPlaybackProgress({
            positionMs: Number(ep.resume_position_ms ?? 0),
            durationMs,
            finished: isEffectivelyWatched({ ...ep, is_watched: ep.is_watched ?? false }),
            updatedAt: ep.last_event_at ?? ep.last_watched_at,
        }),
        context: {
            series: { id: ep.series_id!, catalogId: ep.series_id!, title: ep.series_name ?? '' },
            seasonId: episodeSeasonId(ep),
            seasonNumber: ep.season_number,
            episodeNumber: ep.episode_number,
            endEpisodeNumber: ep.episode_number_end ?? undefined,
            absoluteNumber: ep.absolute_number ?? undefined,
            previousId: ep.previous_id ?? undefined,
            nextId: ep.next_id ?? undefined,
            airDate:
                ep.premiere_date instanceof Date
                    ? ep.premiere_date.toISOString()
                    : (ep.premiere_date ?? undefined),
        },
    };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: EpisodesQuery },
    docsByPath: (path) => ({
        GET: {
            tags: ['Series'],
            summary: path.endsWith('/episodes/{e}')
                ? 'Get one episode by season and episode number'
                : 'Walk episodes of a series',
            stability: 'stable',
            auth: 'bearer',
            query: EpisodesQuery,
            description:
                'Series UUID and tvdb/tmdb/imdb :series handles are accepted. Stable season/episode order, specials last. Logical numbering follows the active ordering; span lookups resolve every number. Examples: /series/tvdb:81189:series/seasons/2/episodes/4; /series/{id}/episodes?absolute=27. Items are MediaPreview episodes with context, images.thumb, availability and PlaybackProgress.',
            responses: {
                200: {
                    schema: path.endsWith('/episodes/{e}')
                        ? MediaPreviewSchema
                        : EpisodesCollectionResponseSchema,
                    description: path.endsWith('/episodes/{e}')
                        ? 'Exactly one episode'
                        : 'Paged episode previews',
                },
                401: 'Authentication required',
                404: 'Series or episode not found',
                422: 'Invalid coordinates or pagination',
            },
        },
    }),
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const seriesId = await resolveSeriesId(event);
            if (!seriesId || !(await checkMediaAccess(sql, seriesId, event.locals.user)))
                return ApiProblem.notFound('Series not found');
            const direct = event.params.e !== undefined;
            if (direct) {
                const bad = (['n', 'e'] as const).filter(
                    (key) => !/^\d+$/.test(event.params[key] ?? ''),
                );
                if (bad.length)
                    return ApiProblem.validationFailed(
                        bad.map((field) => ({
                            field,
                            message: 'Expected a non-negative integer',
                        })),
                    );
            }
            const parsed = EpisodesQuery.safeParse({
                ...Object.fromEntries(event.url.searchParams),
                ...(direct
                    ? {
                          absolute: undefined,
                          physicalSeasonId: undefined,
                          season: event.params.n,
                          episode: event.params.e,
                          limit: 1,
                          offset: 0,
                          specials: 'include',
                      }
                    : {}),
            });
            if (!parsed.success)
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            const q = parsed.data;
            const access = searchAccessBoundary(
                await buildSearchAccessContext(sql, event.locals.user),
            );
            const rows = await getSeriesEpisodesWithWatchState(
                sql,
                seriesId,
                event.locals.user?.userId,
                q.season,
                {
                    ...q,
                    limit: q.absolute !== undefined ? 1 : q.limit + 1,
                    access,
                    availableOnly: true,
                },
            );
            const hasMore = rows.length > q.limit;
            const pageRows = rows.slice(0, q.limit);
            const images = await resolveImageSets(
                sql,
                ctx.surface,
                pageRows.map((ep) => ({ id: ep.id, mediaType: 'episode' })),
                ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
            );
            const durations = await findPlaybackDurationsMs(
                sql,
                pageRows.map((ep) => ep.id),
            );
            const items = pageRows.map((ep) =>
                episodePreview(ep, images.get(ep.id) ?? {}, durations.get(ep.id)),
            );
            await localizeNodes(sql, event.locals.user?.userId, items);
            if (direct) return items[0] ? json(items[0]) : ApiProblem.notFound('Episode not found');
            return json(paginate(items, { limit: q.limit, offset: q.offset, hasMore }));
        },
    },
});
