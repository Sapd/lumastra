// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { LibrariesResponseSchema } from '$lib/schemas/api-browse-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Browse'],
        summary: 'List available media libraries',
        responses: {
            200: {
                schema: LibrariesResponseSchema,
                description: 'Library list',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
