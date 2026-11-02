// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { BrowseResponseSchema } from '$lib/schemas/api-browse-responses';
import { browseQuerySchema } from '$lib/schemas/browse';

export { BrowseResponseSchema, browseQuerySchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Browse'],
        summary: 'Browse media by category',
        description:
            'Returns media organized by sections: continue watching, next up, recently added, and genre rows.',
        query: browseQuerySchema,
        responses: {
            200: {
                schema: BrowseResponseSchema,
                description: 'Browse response with media sections',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
