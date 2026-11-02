// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Stream the original media file',
        stability: 'protocol',
        description:
            'Serves the original media file (direct-play / remux passthrough) with range support.',
        auth: 'none',
        query: z.object({
            grant: z
                .string()
                .optional()
                .meta({ description: 'Streaming session token (URL auth)' }),
        }),
        responses: {
            200: {
                binary: ['video/mp4', 'video/x-matroska', 'application/octet-stream'],
                description: 'Media file stream',
            },
            206: {
                binary: ['video/mp4', 'video/x-matroska', 'application/octet-stream'],
                description: 'Partial content (range request)',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
