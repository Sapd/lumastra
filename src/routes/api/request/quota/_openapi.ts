// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { RequestQuotaResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Request'],
        summary: 'Get user request quota',
        description:
            "Returns the current user's request quota information, including remaining requests and reset timing.",
        responses: {
            200: {
                schema: RequestQuotaResponseSchema,
                description: 'Request quota retrieved',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
