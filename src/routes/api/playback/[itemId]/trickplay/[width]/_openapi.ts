// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { trickplayQuerySchema } from '$lib/schemas/playback';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        auth: 'bearer',
        summary: 'Get trickplay tile image',
        description: 'Returns a composite image of video thumbnails for seek preview.',
        query: trickplayQuerySchema,
        responses: {
            200: {
                binary: ['image/jpeg', 'image/png'],
                description: 'Trickplay tile image',
            },
            304: 'Unchanged sprite sheet',
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};

export { trickplayQuerySchema };
