// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { requestStatusBodySchema } from '$lib/schemas/request';
import { RequestStatusResponseSchema } from '$lib/schemas/api-content-responses';

export { requestStatusBodySchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Request'],
        summary: 'Check request status for items',
        description:
            'Checks the current request/availability status for one or more media items (max 20).',
        body: requestStatusBodySchema,
        responses: {
            200: {
                schema: RequestStatusResponseSchema,
                description: 'Request statuses for submitted items',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
