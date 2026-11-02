// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { TrendingResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Trending'],
        summary: 'Trending content across platforms',
        description:
            'Returns trending media items from TMDB, Jellyfin, MDBList, or a hybrid of sources.',
        query: z.object({
            limit: z.coerce
                .number()
                .optional()
                .meta({ description: 'Number of items (default: 20)' }),
            type: z
                .enum(['movies', 'tv', 'all'])
                .optional()
                .meta({ description: 'Media type filter (default: all)' }),
            source: z.enum(['tmdb', 'jellyfin', 'hybrid', 'mdblist']).optional().meta({
                description: 'Trending data source (default: hybrid)',
            }),
            list: z.enum(['watched', 'popular']).optional().meta({
                description: 'MDBList list type (default: watched, only used with mdblist source)',
            }),
        }),
        responses: {
            200: {
                schema: TrendingResponseSchema,
                description: 'Trending content items',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
