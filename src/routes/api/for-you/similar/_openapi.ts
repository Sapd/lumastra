// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { SimilarResponseSchema } from '$lib/schemas/api-for-you-responses';

export { SimilarResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['For You'],
        summary: 'Similar content to a given item',
        query: z.object({
            key: z.string().meta({
                description: 'Composite key (e.g. tmdb:550:movie, imdb:tt0137523:movie)',
            }),
            limit: z.coerce
                .number()
                .optional()
                .meta({ description: 'Number of results (default: 8)' }),
            title: z.string().optional().meta({ description: 'Source item title for display' }),
            posterUrl: z.string().optional().meta({ description: 'Source item poster URL' }),
            available: z.string().optional().meta({ description: 'Availability filter' }),
            steering: z.string().optional().meta({
                description: 'Enable recommendation steering (true/false)',
            }),
            beta: z.coerce.number().optional().meta({
                description: 'Steering beta parameter (default: 0.3)',
            }),
            watched: z
                .string()
                .optional()
                .meta({ description: 'Comma-separated TMDB IDs to exclude' }),
        }),
        responses: {
            200: {
                schema: SimilarResponseSchema,
                description: 'Similar content items',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
