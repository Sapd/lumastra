// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { TvDetailSchema } from '$lib/schemas/media-detail';

export const route: RouteMetadata = {
    GET: {
        tags: ['Series'],
        summary: 'Search for a series by name',
        description: 'Returns a single series match. Used for looking up specific series.',
        query: z.object({
            name: z.string().meta({ description: 'Series name to search for' }),
        }),
        responses: {
            200: {
                schema: TvDetailSchema,
                description: 'Series search result',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
