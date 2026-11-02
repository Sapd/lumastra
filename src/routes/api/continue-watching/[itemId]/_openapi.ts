// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { ContinueWatchingDeleteResponseSchema } from '$lib/schemas/api-for-you-responses';

export const route: RouteMetadata = {
    DELETE: {
        tags: ['Continue Watching'],
        summary: 'Remove item from continue watching',
        responses: {
            200: {
                schema: ContinueWatchingDeleteResponseSchema,
                description: 'Item removed from continue watching',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
