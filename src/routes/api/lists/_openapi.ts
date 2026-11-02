// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { ListsIndexResponseSchema } from '$lib/schemas/api-list-responses';

export { ListsIndexResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Lists'],
        summary: 'Get all available lists',
        responses: {
            200: {
                schema: ListsIndexResponseSchema,
                description: 'Available lists',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
