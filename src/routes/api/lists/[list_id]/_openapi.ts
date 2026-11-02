// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { ListItemsResponseSchema } from '$lib/schemas/api-list-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Lists'],
        summary: 'Get a specific list with its items',
        query: z.object({
            limit: z.coerce
                .number()
                .optional()
                .meta({ description: 'Max items to return (default: 20)' }),
            debug: z.string().optional().meta({ description: 'Include debug info (true/false)' }),
        }),
        responses: {
            200: {
                schema: ListItemsResponseSchema,
                description: 'List details with items',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
