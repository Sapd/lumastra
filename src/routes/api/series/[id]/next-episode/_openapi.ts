// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { NextEpisodeNodeSchema } from '$lib/schemas/api-series-responses';

export { NextEpisodeNodeSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Series'],
        summary: 'Get the next unwatched episode for a series',
        responses: {
            200: {
                // The handler (defs/catalog/series/next-episode.ts) returns a
                // NextEpisodeNode, and 404 when there is no next episode.
                schema: NextEpisodeNodeSchema,
                description: 'Next unwatched episode, or the explicitly requested one',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
