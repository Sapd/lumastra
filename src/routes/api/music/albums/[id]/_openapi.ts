// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { MusicAlbumDetailResponseSchema } from '$lib/schemas/api-music-responses';
import type { RouteMetadata } from '$lib/server/openapi';

const AlbumDetailResponseSchema = MusicAlbumDetailResponseSchema;

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Get album detail with track list',
        description: 'Returns full album metadata including all tracks with audio features.',
        responses: {
            200: {
                schema: AlbumDetailResponseSchema,
                description: 'Album detail with tracks',
            },
            404: 'Album not found',
        },
    },
};
