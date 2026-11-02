// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { recentQuerySchema } from '$lib/schemas/browse';
import { BrowseResponseSchema } from '$lib/schemas/api-browse-responses';

// NOTE: import request/response schemas from $lib/schemas — NOT the def
// ($lib/server/api/defs/...), which would pull the server runtime under the
// OpenAPI generator (tsx) and silently drop this route from the spec.
export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['Browse'],
        summary: 'Get recently added media',
        description:
            'Filterable "Recently Added" surface for /browse. Supports media-type filter, library-group filter, newness mode (everything|seasons|titles), and title search.',
        query: recentQuerySchema,
        responses: {
            200: { schema: BrowseResponseSchema, description: 'Recently added media' },
            503: 'Database not available',
        },
    },
};
