// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { WatchingResponseSchema } from '$lib/schemas/api-for-you-responses';

export { WatchingResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['For You'],
        summary: 'Currently watching and continue watching',
        query: z.object({
            mergeSort: z.string().optional(),
            includeNewEpisodes: z.string().optional(),
        }),
        responses: {
            200: {
                schema: WatchingResponseSchema,
                description: 'Currently watching sections',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
