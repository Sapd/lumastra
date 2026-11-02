// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { EpisodesCollectionResponseSchema } from '$lib/schemas/api-series-responses';

export { EpisodesCollectionResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Series'],
        summary: 'Get episodes for a series season',
        query: z.object({
            season: z.coerce
                .number()
                .optional()
                .meta({ description: 'Season number to fetch episodes for' }),
        }),
        responses: {
            200: {
                schema: EpisodesCollectionResponseSchema,
                description: 'Episode list for the specified season',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
