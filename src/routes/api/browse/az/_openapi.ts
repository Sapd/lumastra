// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { AzBrowseResponseSchema } from '$lib/schemas/api-browse-responses';

export { AzBrowseResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Browse'],
        summary: 'Browse media alphabetically',
        query: z.object({
            letter: z.string().optional().meta({ description: 'Letter to filter by (A-Z or #)' }),
            type: z
                .enum(['movies', 'series', 'all'])
                .optional()
                .meta({ description: 'Media type filter' }),
            offset: z.coerce.number().optional().meta({ description: 'Offset for pagination' }),
            limit: z.coerce.number().optional().meta({ description: 'Items per page' }),
            libraryGroupId: z
                .string()
                .guid()
                .optional()
                .meta({ description: 'Filter by library group ID' }),
        }),
        responses: {
            200: {
                schema: AzBrowseResponseSchema,
                description: 'Alphabetical browse results with offset-based pagination',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
