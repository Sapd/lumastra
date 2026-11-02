// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResolveImageOptions } from '$lib/server/services/image-descriptor/index.js';
import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { localizeNodes } from './localize-nodes.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveSeriesId } from './resolve-series-id.js';
import {
    getSeriesOrdering,
    getSeasonsByInternalId,
} from '$lib/server/database/queries/season-detail.queries.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import {
    buildVirtualSeasonHandle,
    parseVirtualSeasonHandle,
    type SeasonOrdering,
} from '$lib/server/services/media-handle.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { isEffectivelyWatched } from '$lib/server/utils/watch-constants.js';
import { buildPlaybackProgress } from '$lib/schemas/api-playback-progress.js';
import {
    SeasonNodeSchema,
    SeasonsCollectionResponseSchema,
    type SeasonNode,
} from '$lib/schemas/api-series-responses.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import type { UserId } from '$lib/shared/user-id.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getMediaNavContext } from '$lib/server/database/queries/media-lookup.queries.js';

const INT32_MAX = 2147483647;

function canBuildVirtualHandle(seriesId: string, ordering: SeasonOrdering): boolean {
    try {
        buildVirtualSeasonHandle(seriesId, ordering, 0);
        return true;
    } catch (err) {
        if (err instanceof RangeError) return false;
        throw err;
    }
}

/** Physical UUID detail always describes physical membership, even under DVD ordering. */
export async function buildSeasonNodes(
    sql: NonNullable<ReturnType<typeof getDb>>,
    seriesId: string,
    userId: UserId | undefined,
    surface: ApiSurface,
    access: MediaAccessBoundary,
    physical = false,
    imageOptions?: ResolveImageOptions,
): Promise<{ ordering: SeasonOrdering; items: SeasonNode[] }> {
    const storedOrdering = physical ? 'standard' : await getSeriesOrdering(sql, seriesId);
    const ordering = canBuildVirtualHandle(seriesId, storedOrdering) ? storedOrdering : 'standard';
    const rows = await getSeasonsByInternalId(sql, seriesId, userId, access);
    const episodes = await getSeriesEpisodesWithWatchState(sql, seriesId, userId, undefined, {
        access,
        availableOnly: true,
        ...(physical ? { physical: true } : {}),
    });
    const raw =
        ordering === 'standard'
            ? rows.map((r) => ({
                  id: r.id,
                  seasonNumber: r.season_number,
                  title:
                      r.name || (r.season_number === 0 ? 'Specials' : `Season ${r.season_number}`),
                  overview: r.overview ?? undefined,
                  premiereDate:
                      r.premiere_date instanceof Date
                          ? r.premiere_date.toISOString()
                          : (r.premiere_date ?? undefined),
              }))
            : [...new Set(episodes.map((ep) => ep.season_number))]
                  .filter((n): n is number => Number.isSafeInteger(n) && n >= 0)
                  .map((n) => ({
                      id: buildVirtualSeasonHandle(seriesId, ordering, n),
                      seasonNumber: n,
                      title: n === 0 ? 'Specials' : `Season ${n}`,
                      overview: undefined,
                      premiereDate: undefined,
                  }));
    raw.sort(
        (a, b) =>
            Number(a.seasonNumber === 0) - Number(b.seasonNumber === 0) ||
            a.seasonNumber - b.seasonNumber,
    );
    const images = await resolveImageSets(
        sql,
        surface,
        ordering === 'standard'
            ? raw.map(({ id }) => ({ id, mediaType: 'season' }))
            : [{ id: seriesId, mediaType: 'series' }],
        imageOptions,
    );
    const items = raw.map((r): SeasonNode => {
        const children = episodes.filter((ep) =>
            ordering === 'standard' ? ep.season_id === r.id : ep.season_number === r.seasonNumber,
        );
        const watchedCount = children.filter((ep) =>
            isEffectivelyWatched({ ...ep, is_watched: ep.is_watched ?? false }),
        ).length;
        const art = images.get(ordering === 'standard' ? r.id : seriesId) ?? {};
        const poster = art.poster ? { ...art.poster, source: 'series' as const } : undefined;
        return {
            ...r,
            catalogId: ordering === 'standard' ? r.id : null,
            type: 'season',
            ids: {},
            ordering,
            virtual: ordering !== 'standard',
            episodeCount: children.length,
            watchedCount,
            images:
                ordering === 'standard'
                    ? art
                    : imageOptions?.inherit === 'none'
                      ? {}
                      : poster
                        ? { poster }
                        : {},
            progress: buildPlaybackProgress({
                fraction: children.length ? watchedCount / children.length : 0,
                finished: children.length > 0 && watchedCount === children.length,
            }),
            series: {
                id: seriesId,
                catalogId: seriesId,
                href: apiUrl(surface, `/series/${seriesId}`),
            },
            href: apiUrl(surface, `/seasons/${r.id}`),
            episodes: {
                href: apiUrl(
                    surface,
                    `/series/${seriesId}/episodes?season=${r.seasonNumber}${physical ? `&physicalSeasonId=${r.id}` : ''}`,
                ),
            },
        };
    });
    await localizeNodes(sql, userId, items);
    return { ordering, items };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: InheritQuerySchema },
    docsByPath: (path) => ({
        GET: {
            query: InheritQuerySchema,
            tags: ['Series'],
            summary: path.endsWith('/seasons')
                ? 'List seasons in the active ordering'
                : path.includes('/series/')
                  ? 'Get a season by season number'
                  : 'Get a season by id',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Series IDs accept UUID, tvdb:N:series, tmdb:N:series or imdb:ttN:series. Non-standard seasons use opaque vseason handles and series artwork. Follow episodes.href to walk the season.',
            responses: {
                200: {
                    schema: path.endsWith('/seasons')
                        ? SeasonsCollectionResponseSchema
                        : SeasonNodeSchema,
                    description: 'Season node or complete {ordering, items, page} collection',
                },
                404: 'Series or season not found',
            },
        },
    }),
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            const flat = !event.url.pathname.includes('/series/');
            const virtual = flat ? parseVirtualSeasonHandle(event.params.id ?? '') : null;
            let physicalId: string | undefined;
            let seriesId: string | null;
            if (flat && !virtual) {
                physicalId = event.params.id;
                if (!z.uuid().safeParse(physicalId).success)
                    return ApiProblem.notFound('Season not found');
                const nav = await getMediaNavContext(sql, physicalId!);
                seriesId = nav?.series_id ?? null;
            } else {
                seriesId = virtual?.seriesUuid ?? (await resolveSeriesId(event));
            }
            if (!seriesId || !(await checkMediaAccess(sql, seriesId, event.locals.user)))
                return ApiProblem.notFound('Series not found');
            const rawN = event.params.n;
            const n =
                virtual?.seasonNumber ??
                (rawN === undefined ? undefined : /^\d+$/.test(rawN) ? Number(rawN) : Number.NaN);
            if (n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > INT32_MAX))
                return ApiProblem.validationFailed([
                    { field: 'n', message: 'Expected a non-negative season number' },
                ]);
            const access = searchAccessBoundary(
                await buildSearchAccessContext(sql, event.locals.user),
            );
            const result = await buildSeasonNodes(
                sql,
                seriesId,
                event.locals.user?.userId,
                ctx.surface,
                access,
                !!physicalId,
                ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
            );
            if (
                virtual &&
                (virtual.ordering === 'standard' || result.ordering !== virtual.ordering)
            )
                return ApiProblem.notFound('Season not found');
            if (flat || n !== undefined) {
                const node = result.items.find((s) =>
                    physicalId ? s.id === physicalId : s.seasonNumber === n,
                );
                return node ? json(node) : ApiProblem.notFound('Season not found');
            }
            // The list offers only seasons with at least one playable episode; catalog
            // seasons without files stay reachable by id or number.
            const items = result.items.filter((s) => s.episodeCount > 0);
            return json({
                ...result,
                items,
                page: {
                    limit: items.length,
                    offset: 0,
                    hasMore: false,
                    total: items.length,
                },
            });
        },
    },
});
