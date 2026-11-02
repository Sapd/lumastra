// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MoodRecommendationsResponseSchema } from '$lib/schemas/api-for-you-responses';

export { MoodRecommendationsResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Mood'],
        summary: 'Mood-based recommendations',
        description:
            'Returns personalized recommendations based on auto-detected or specified mood and time of day.',
        query: z.object({
            mood: z.string().optional().meta({ description: 'Override auto-detected mood' }),
            type: z.enum(['movie', 'tv']).optional().meta({ description: 'Filter by media type' }),
            limit: z.coerce
                .number()
                .optional()
                .meta({ description: 'Results per section (default: 12)' }),
            trending: z.string().optional().meta({
                description: 'Include trending boost (default: true)',
            }),
            mode: z.enum(['keyword', 'vector']).optional().meta({
                description: 'Recommendation mode (default: keyword)',
            }),
            moodWeight: z.coerce.number().optional().meta({
                description: 'Vector mode mood weight (default: 0.6)',
            }),
            userWeight: z.coerce.number().optional().meta({
                description: 'Vector mode user weight (default: 0.4)',
            }),
        }),
        responses: {
            200: {
                schema: MoodRecommendationsResponseSchema,
                description: 'Mood-based recommendations with sections',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
