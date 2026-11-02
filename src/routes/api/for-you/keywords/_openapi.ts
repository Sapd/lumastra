// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { KeywordsResponseSchema } from '$lib/schemas/api-for-you-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['For You'],
        summary: 'Content grouped by keywords',
        query: z.object({
            rows: z.coerce
                .number()
                .optional()
                .meta({ description: 'Number of keyword rows (default: 2)' }),
            items: z.coerce.number().optional().meta({ description: 'Items per row (default: 8)' }),
            watched: z.string().optional().meta({
                description: 'Comma-separated composite keys to exclude',
            }),
            available: z.string().optional().meta({ description: 'Availability filter' }),
        }),
        responses: {
            200: {
                schema: KeywordsResponseSchema,
                description: 'Keyword-grouped sections',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
