// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { SeasonsCollectionResponseSchema } from '$lib/schemas/api-series-responses';

export { SeasonsCollectionResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Series'],
        summary: 'Get seasons for a series',
        query: z.object({
            tmdb_id: z
                .string()
                .optional()
                .meta({ description: 'TMDB ID for TMDB-based season fetch' }),
        }),
        responses: {
            200: { schema: SeasonsCollectionResponseSchema, description: 'Season list' },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
