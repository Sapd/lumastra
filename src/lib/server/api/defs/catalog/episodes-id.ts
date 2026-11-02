// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { localizeNodes } from './series/localize-nodes.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    getMediaNavContext,
    getMediaDetailsById,
} from '$lib/server/database/queries/media-lookup.queries.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import { findPlaybackDurationMs } from '$lib/server/database/queries/media-items.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { EpisodeNodeSchema } from '$lib/schemas/api-series-responses.js';
import { episodePreview } from './series/episodes.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: InheritQuerySchema },
    docs: {
        GET: {
            query: InheritQuerySchema,
            tags: ['Series'],
            summary: 'Get an episode preview',
            auth: 'bearer',
            stability: 'stable',
            description:
                'Returns a MediaPreview episode with context, neighbouring episode handles, availability, PlaybackProgress and images.thumb. Example: /episodes/{episodeUuid}.',
            responses: {
                200: { schema: EpisodeNodeSchema, description: 'Episode preview' },
                404: 'Episode not found or inaccessible',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');
            let id: string | null = null;
            try {
                id =
                    event.locals.resolvedIds?.internalId ??
                    (await mediaIdResolver.resolveAnyMediaId(event.params.id ?? '')).internalId;
            } catch {
                /* unresolvable */
            }
            if (!id || !(await checkMediaAccess(sql, id, event.locals.user)))
                return ApiProblem.notFound('Episode not found');
            const row = await getMediaDetailsById(sql, id);
            if (row?.media_type !== 'episode') return ApiProblem.notFound('Episode not found');
            const nav = await getMediaNavContext(sql, id);
            if (!nav?.series_id || !(await checkMediaAccess(sql, nav.series_id, event.locals.user)))
                return ApiProblem.notFound('Episode not found');
            const access = searchAccessBoundary(
                await buildSearchAccessContext(sql, event.locals.user),
            );
            const rows = await getSeriesEpisodesWithWatchState(
                sql,
                nav.series_id,
                event.locals.user?.userId,
                undefined,
                { access },
            );
            let ep = rows.find((e) => e.id === id);
            if (!ep) {
                const physical = await getSeriesEpisodesWithWatchState(
                    sql,
                    nav.series_id,
                    event.locals.user?.userId,
                    undefined,
                    { access, physical: true },
                );
                ep = physical.find((e) => e.id === id);
            }
            if (!ep) return ApiProblem.notFound('Episode not found');
            const images = await resolveImageSets(
                sql,
                ctx.surface,
                [{ id, mediaType: 'episode' }],
                ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
            );
            const item = episodePreview(
                ep,
                images.get(id) ?? {},
                await findPlaybackDurationMs(sql, id),
            );
            await localizeNodes(sql, event.locals.user?.userId, [item]);
            return json(item);
        },
    },
});
