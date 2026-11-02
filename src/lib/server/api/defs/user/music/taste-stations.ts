// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/me/music/taste-stations — also published at
 * GET /api/v1/me/music/taste-stations (beta).
 *
 * Returns the list of taste stations — the user's k-means taste clusters
 * surfaced as chips for the /music page. Empty `items` when the user has
 * insufficient play history to cluster meaningfully.
 *
 * Response: `{ items: TasteStation[] }`. Each station carries a version-bound
 * `id` and `images.primary`, a cover collage of its visible sample tracks'
 * albums. DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getUserStations } from '$lib/server/services/music/stations.service.js';
import { MusicTasteStationsResponseSchema } from '$lib/schemas/api-music-responses.js';
import { musicCollageImages } from '$lib/server/services/music/collage-images.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List the listener’s taste stations',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns the caller’s k-means taste clusters as playable stations. Distinct from GET /api/v1/music/radio/stations, which lists internet radio. A station `id` is bound to the clustering it was listed from and may be stored: its tracks stay available for 7 days, also after the clustering changes. When the clustering has expired, fetching the tracks answers 410 and the stations must be listed again.',
            responses: {
                200: {
                    schema: MusicTasteStationsResponseSchema,
                    description: 'Taste stations of the current clustering',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('AI database not available');

            const stations = await getUserStations(sql, user.userId, user);

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                [...new Set((stations ?? []).flatMap((station) => station.coverTrackIds))].map(
                    (id) => ({ id }),
                ),
            );
            return json({
                items: (stations ?? []).map(({ coverTrackIds, ...station }) => {
                    const images = musicCollageImages(coverTrackIds, ctx.surface, imageSets);
                    return images.primary ? { ...station, images } : station;
                }),
            });
        },
    },
});
