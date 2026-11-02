// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { MovieDetailResponseSchema } from '$lib/schemas/api-media-responses';

export { MovieDetailResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Movies'],
        summary: 'Get detailed movie information',
        responses: {
            200: {
                schema: MovieDetailResponseSchema,
                description: 'Movie details',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
