// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MusicGenresResponseSchema } from '$lib/schemas/api-music-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'List music genres',
        description:
            'Returns all distinct genres in the music library with track/album counts. Optional substring filter.',
        query: z.object({
            q: z.string().max(200).optional().meta({
                description: 'Filter genres by substring (case-insensitive)',
            }),
        }),
        responses: {
            200: {
                schema: MusicGenresResponseSchema,
                description: 'List of music genres with counts',
            },
        },
    },
};
