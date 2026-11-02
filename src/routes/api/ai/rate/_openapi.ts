// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { rateContentBodySchema } from '$lib/schemas/ai';
import { RateResponseSchema } from '$lib/schemas/api-ai-responses';

export { rateContentBodySchema, RateResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['AI'],
        summary: 'Rate a media item',
        description:
            'Submit a rating (1-10), a skip flag, or a clear flag (removes an existing rating) for a media item. Requires external IDs and media type. Ratings influence AI recommendation generation.',
        body: rateContentBodySchema,
        responses: {
            200: {
                schema: RateResponseSchema,
                description: 'Content rated successfully',
            },
        },
    },
};
