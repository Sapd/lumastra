// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';
import { PlaybackSessionDebugResponseSchema } from '$lib/schemas/api-playback-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get active playback session debug info',
        description:
            'Returns debugging information about the current playback session for a specific item, including transcoding details.',
        query: z.object({
            itemId: z.string().meta({ description: 'Jellyfin item ID to look up' }),
        }),
        responses: {
            200: {
                schema: PlaybackSessionDebugResponseSchema,
                description: 'Active session or null',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};

export { PlaybackSessionDebugResponseSchema };
