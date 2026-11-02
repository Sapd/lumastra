// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { SearchResponseSchema } from '$lib/schemas/api-content-responses';
import { searchQuerySchema } from '$lib/schemas/browse';

export { SearchResponseSchema, searchQuerySchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Search'],
        summary: 'Search across all media',
        description:
            'Full-text search with support for type filtering, year ranges, rating minimums, genre filtering, and exclusion terms.',
        query: searchQuerySchema,
        responses: {
            200: {
                schema: SearchResponseSchema,
                description: 'Search results',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
