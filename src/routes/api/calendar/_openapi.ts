// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';
import { CalendarResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Calendar'],
        summary: 'Get media calendar events',
        description:
            'Returns upcoming media release events (new episodes, movies) within the specified date range. Integrates with Sonarr and Radarr calendars.',
        query: z.object({
            start: z.string().optional().meta({
                description: 'Start date (ISO 8601) for calendar range',
            }),
            end: z
                .string()
                .optional()
                .meta({ description: 'End date (ISO 8601) for calendar range' }),
        }),
        responses: {
            200: {
                schema: CalendarResponseSchema,
                description: 'Calendar events retrieved',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
