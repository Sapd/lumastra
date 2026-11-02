// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { WatchingSourcesResponseSchema } from '$lib/schemas/api-for-you-responses';

export { WatchingSourcesResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['For You'],
        summary: 'Sources for currently watching items',
        responses: {
            200: {
                schema: WatchingSourcesResponseSchema,
                description: 'Watching sources',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
