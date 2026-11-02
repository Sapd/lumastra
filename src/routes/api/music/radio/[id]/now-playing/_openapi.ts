// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { RadioNowPlayingSchema } from '$lib/schemas/radio';

const ResponseSchema = z
    .object({
        success: z.boolean(),
        data: RadioNowPlayingSchema,
        timestamp: z.string(),
    })
    .meta({ id: 'RadioNowPlayingResponse' });

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Get radio station now-playing',
        description:
            'Returns the structured now-playing for a radio station (track, show, DJ, up-next). When a metadata-source URL is configured, values are parsed from it; otherwise the app falls back to in-stream ICY metadata.',
        responses: {
            200: { schema: ResponseSchema, description: 'Station now-playing' },
            404: 'Station not found',
        },
    },
};
