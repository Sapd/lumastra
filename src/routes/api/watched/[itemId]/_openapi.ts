// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { watchedBodySchema } from '$lib/schemas/common';
import { WatchedStatusResponseSchema } from '$lib/schemas/api-user-responses';

export { watchedBodySchema, WatchedStatusResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Content'],
        summary: 'Get watched status for an item',
        responses: {
            200: {
                schema: WatchedStatusResponseSchema,
                description: 'Watched status',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
    POST: {
        tags: ['Content'],
        summary: 'Mark item as watched',
        body: watchedBodySchema,
        responses: {
            200: {
                schema: WatchedStatusResponseSchema,
                description: 'Item marked as watched',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
    DELETE: {
        tags: ['Content'],
        summary: 'Mark item as unwatched',
        query: z.object({
            mediaType: z.string().optional().meta({ description: 'Media type' }),
            key: z.string().optional().meta({ description: 'Composite media key' }),
        }),
        responses: {
            200: {
                schema: WatchedStatusResponseSchema,
                description: 'Item marked as unwatched',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
