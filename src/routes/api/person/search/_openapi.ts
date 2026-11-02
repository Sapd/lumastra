// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { PersonSearchResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['People'],
        summary: 'Search for a person by name',
        description: 'Returns a single person match with basic profile information.',
        query: z.object({
            name: z.string().meta({ description: 'Person name to search for' }),
        }),
        responses: {
            200: {
                schema: PersonSearchResponseSchema,
                description: 'Person search result',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
