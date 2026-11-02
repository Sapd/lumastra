// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { createRequestBodySchema } from '$lib/schemas/request';
import { SubmitRequestResponseSchema } from '$lib/schemas/api-content-responses';

export { createRequestBodySchema, SubmitRequestResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Request'],
        summary: 'Create media request',
        description:
            'Creates a new media request via Jellyseerr. Supports movie requests and TV requests with optional season selection.',
        body: createRequestBodySchema,
        responses: {
            200: {
                schema: SubmitRequestResponseSchema,
                description: 'Request created successfully',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
