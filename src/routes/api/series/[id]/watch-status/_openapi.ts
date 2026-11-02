// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { WatchStatusResponseSchema } from '$lib/schemas/api-series-responses';

export { WatchStatusResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Series'],
        summary: 'Get detailed watch progress for a series season',
        description:
            'Returns per-episode watch progress including playback positions, completion status, and timestamps.',
        query: z.object({
            season: z.coerce.number().optional().meta({ description: 'Season number to check' }),
        }),
        responses: {
            200: {
                schema: WatchStatusResponseSchema,
                description: 'Detailed watch status for the season',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
