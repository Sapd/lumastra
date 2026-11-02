// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { BrowseKeywordsResponseSchema } from '$lib/schemas/api-browse-responses';

export { BrowseKeywordsResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Browse'],
        summary: 'Browse media by keywords',
        description: 'Returns media sections grouped by keyword, with pagination support.',
        responses: {
            200: {
                schema: BrowseKeywordsResponseSchema,
                description: 'Keyword-grouped media sections',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
