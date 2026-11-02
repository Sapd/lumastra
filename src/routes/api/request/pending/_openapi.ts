// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { PendingRequestsResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Request'],
        summary: 'Get pending requests',
        description: 'Returns all pending media requests for the current user.',
        responses: {
            200: {
                schema: PendingRequestsResponseSchema,
                description: 'Pending requests retrieved',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
