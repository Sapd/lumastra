// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { MediaRatingResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Media Social'],
        summary: 'Get rating for a media item',
        responses: {
            200: {
                schema: MediaRatingResponseSchema,
                description: 'Rating information',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
