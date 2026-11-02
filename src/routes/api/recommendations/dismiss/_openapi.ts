// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { dismissBodySchema } from '$lib/schemas/ai';
import { DismissRecommendationResponseSchema } from '$lib/schemas/api-for-you-responses';

export { dismissBodySchema, DismissRecommendationResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Recommendations'],
        summary: 'Dismiss a recommendation',
        body: dismissBodySchema,
        responses: {
            200: {
                schema: DismissRecommendationResponseSchema,
                description: 'Recommendation dismissed',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
