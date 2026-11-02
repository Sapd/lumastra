// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get media probe status',
        stability: 'beta',
        description:
            'Returns the ffprobe analysis status for a media item (whether stream metadata is ready for playback).',
        responses: {
            200: {
                schema: z
                    .object({
                        status: z.string(),
                        ready: z.boolean().optional(),
                    })
                    .loose(),
                description: 'Probe status',
            },
            401: 'Authentication required',
            404: 'Item not found',
            500: 'Internal server error',
        },
    },
};
