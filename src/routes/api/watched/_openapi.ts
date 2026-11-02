// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { WatchedItemsDataSchema } from '$lib/schemas/watched-types';

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['User'],
        summary: 'Get watched items',
        description:
            "Returns all items the authenticated user has watched, keyed by externalIds. Used by the SPA recommendation filter and the browse grid's watched overlay.",
        responses: {
            200: { schema: WatchedItemsDataSchema, description: 'Watched items response' },
            503: 'Database not available',
        },
    },
};
