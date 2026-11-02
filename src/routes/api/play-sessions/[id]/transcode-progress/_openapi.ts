// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { TranscodeProgressResponseSchema } from '$lib/schemas/api-playback-responses.js';

export const route: RouteMetadata = {
    GET: {
        tags: ['Play Sessions'],
        summary: 'Get live transcode progress',
        description:
            'Progress of the transcode serving an owned play session: percent, segments, speed, ETA and whether the transcode throttle has FFmpeg paused. `transcode` is null when no transcode is running.',
        responses: {
            200: { schema: TranscodeProgressResponseSchema, description: 'Transcode progress' },
            404: 'Not found or not owned',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
