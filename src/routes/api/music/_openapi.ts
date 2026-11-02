// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MusicTrackSchema } from '$lib/schemas/music';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Music home page',
        description:
            'Returns the music home page with recently played, recently added, and genre-based carousel sections.',
        responses: {
            200: {
                schema: z
                    .object({
                        success: z.boolean(),
                        data: z.object({
                            sections: z.array(
                                z.object({
                                    title: z.string(),
                                    type: z.string(),
                                    items: z.array(MusicTrackSchema),
                                }),
                            ),
                        }),
                        timestamp: z.string(),
                    })
                    .meta({ id: 'MusicHomeResponse' }),
                description: 'Music home page sections',
            },
        },
    },
};
