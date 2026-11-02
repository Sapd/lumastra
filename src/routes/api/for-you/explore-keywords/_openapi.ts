// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { ExploreKeywordsResponseSchema } from '$lib/schemas/api-for-you-responses';

export { ExploreKeywordsResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['For You'],
        summary: 'Explore keyword-based content',
        responses: {
            200: {
                schema: ExploreKeywordsResponseSchema,
                description: 'Explore keywords section with available keywords',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
