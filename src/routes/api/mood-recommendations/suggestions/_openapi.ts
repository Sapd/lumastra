// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { MoodSuggestionsResponseSchema } from '$lib/schemas/api-for-you-responses';

export { MoodSuggestionsResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Mood'],
        summary: 'Get available mood options',
        description:
            'Returns the available mood categories with display names and descriptions for the mood selector UI.',
        responses: {
            200: {
                schema: MoodSuggestionsResponseSchema,
                description: 'Available mood options',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
