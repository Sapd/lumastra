// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { NewEpisodesResponseSchema } from '$lib/schemas/api-for-you-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['For You'],
        summary: 'New episodes of watched shows',
        description:
            'Returns alerts for new episodes of series the user is watching, including season premieres and requested content.',
        responses: {
            200: {
                schema: NewEpisodesResponseSchema,
                description: 'New episode alerts',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
