// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { SeriesNodeSchema } from '$lib/schemas/api-series-responses';

const SeriesIdQuerySchema = z.object({
    include: z
        .string()
        .optional()
        .meta({
            description:
                'CSV of optional expansions: `user`, `playback`, `details`. `details` adds rich ' +
                'fields (cast/genres/ratings/trailer).',
        }),
    externalId: z.string().optional().meta({
        description: 'Composite external ID form: provider:id:type (e.g. tmdb:1396:series)',
    }),
});

export const route: RouteMetadata = {
    GET: {
        tags: ['Series'],
        summary: 'Get detailed series information',
        query: SeriesIdQuerySchema,
        responses: {
            200: {
                schema: SeriesNodeSchema,
                description: 'Series traversal node',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
