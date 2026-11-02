// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { PersonDetailResponseSchema } from '$lib/schemas/api-person-responses';

export { PersonDetailResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['People'],
        summary: 'Get person details with credits',
        responses: {
            200: {
                schema: PersonDetailResponseSchema,
                description: 'Person details with filmography',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
