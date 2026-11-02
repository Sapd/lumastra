// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MediaDetailSchema } from '$lib/schemas/media-detail';

export { MediaDetailSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Media'],
        summary: 'Get detailed media information by composite key',
        description:
            'Returns comprehensive media details including ratings, availability, and metadata. Uses a composite key format: provider:id:mediaType (e.g., tmdb:550:movie).',
        query: z.object({
            key: z.string().meta({
                description: 'Composite key in format provider:id:mediaType (e.g., tmdb:550:movie)',
            }),
        }),
        responses: {
            200: {
                schema: MediaDetailSchema,
                description: 'Detailed media information',
            },
            400: 'Bad request',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
