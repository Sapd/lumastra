// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { UpcomingResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Upcoming'],
        summary: 'Upcoming episodes for watched series',
        description: 'Returns upcoming episodes for series the user is actively watching.',
        query: z.object({
            limit: z.coerce.number().optional().meta({
                description: 'Number of episodes to return (default: 10)',
            }),
        }),
        responses: {
            200: {
                schema: UpcomingResponseSchema,
                description: 'Upcoming episodes for watched series',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
