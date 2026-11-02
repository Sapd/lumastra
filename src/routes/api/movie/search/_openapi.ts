// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MediaDetailsSchema } from '$lib/schemas/api-media-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Movies'],
        summary: 'Search for a movie by name',
        description: 'Returns a single movie match. Used for looking up specific movies.',
        query: z.object({
            name: z.string().meta({ description: 'Movie name to search for' }),
            year: z.string().optional().meta({ description: 'Production year to filter by' }),
        }),
        responses: {
            200: {
                schema: MediaDetailsSchema,
                description: 'Movie search result',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
