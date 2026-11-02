// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { TimelineResponseSchema } from '$lib/schemas/api-playback-responses';
import { timelineQuerySchema } from '$lib/schemas/playback';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        auth: 'bearer',
        summary: 'Get the selected file playback timeline',
        query: timelineQuerySchema,
        responses: {
            200: {
                schema: TimelineResponseSchema,
                description: 'Chapter markers with media segments',
            },
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};

export { TimelineResponseSchema, timelineQuerySchema };
