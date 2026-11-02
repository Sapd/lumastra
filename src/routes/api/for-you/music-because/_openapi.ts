// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { SectionResponseSchema } from '$lib/schemas/api-for-you-responses';

export { SectionResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Music', 'For You'],
        summary: 'Music "Because You Listened To" recommendations',
        description:
            "Returns a PageSection of similar tracks based on the user's most recently played track. " +
            'Uses embedding similarity to find tracks related to recent listening history.',
        responses: {
            200: {
                schema: SectionResponseSchema,
                description: 'Music recommendation section based on recent listening',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
