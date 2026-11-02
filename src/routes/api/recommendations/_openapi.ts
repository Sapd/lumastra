// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { recommendationsQuerySchema } from '$lib/schemas/ai';
import { UniversalMediaItemSchema } from '$lib/schemas/api-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Recommendations'],
        summary: 'Personalized recommendations (nextup / continue / watching / movies / series)',
        description:
            'Response shape varies by `type` query param:\n' +
            '- **nextup**: `{ items, cachedAt, cached }` or `{ isStale, reason? }` (validate mode)\n' +
            '- **continue**, **series**, **movies**, **audiobooks**: direct `MediaItem[]` array\n' +
            '- **watching**: `{ nextUp, continueWatching }`',
        query: recommendationsQuerySchema,
        responses: {
            200: {
                schema: z
                    .object({
                        items: z.array(UniversalMediaItemSchema).optional(),
                        cached: z.boolean().optional(),
                        cachedAt: z.number().optional(),
                        message: z.string().optional(),
                        fallback: z.boolean().optional(),
                        isStale: z.boolean().optional().meta({
                            description: 'Present in nextup validate mode',
                        }),
                        reason: z.string().optional().meta({
                            description: 'Staleness reason in nextup validate mode',
                        }),
                        nextUp: UniversalMediaItemSchema.optional().meta({
                            description: 'Present when type=watching; single item or null',
                        }),
                        continueWatching: UniversalMediaItemSchema.optional().meta({
                            description: 'Present when type=watching; single item or null',
                        }),
                    })
                    .meta({
                        description:
                            'Response shape varies by type. For continue/series/movies/audiobooks, response is a direct MediaItem[] array.',
                    }),
                description: 'Personalized recommendations',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
