// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { MusicArtistDetailResponseSchema } from '$lib/schemas/api-music-responses';
import type { RouteMetadata } from '$lib/server/openapi';

const ArtistDetailResponseSchema = MusicArtistDetailResponseSchema;

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Get artist detail with discography',
        description: 'Returns artist metadata plus full album list.',
        responses: {
            200: {
                schema: ArtistDetailResponseSchema,
                description: 'Artist detail with albums and tracks',
            },
            404: 'Artist not found',
        },
    },
};
