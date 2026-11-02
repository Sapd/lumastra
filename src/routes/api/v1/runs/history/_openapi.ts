// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { historyTrimQuerySchema, historyTrimResponseSchema } from '$lib/schemas/admin';

export const route: RouteMetadata = {
    visibility: 'internal',
    DELETE: {
        tags: ['Runs'],
        summary: 'Trim task-run history',
        stability: 'beta',
        description:
            'Deletes task-history rows older than the requested retention window. Requires `tasks:admin` scope.',
        query: historyTrimQuerySchema,
        responses: {
            200: {
                schema: historyTrimResponseSchema,
                description: 'Rows trimmed',
            },
            422: 'Validation error',
            401: 'Authentication required',
            403: 'Insufficient scope',
            500: 'Internal server error',
        },
    },
};
