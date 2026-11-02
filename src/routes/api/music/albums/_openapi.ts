// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MusicAlbumsResponseSchema } from '$lib/schemas/api-music-responses';

const AlbumsResponseSchema = MusicAlbumsResponseSchema;

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Browse music albums',
        description:
            'Returns a paginated list of albums. Filter by genre or artist, sort by alpha, year, or recently added.',
        query: z.object({
            limit: z.coerce.number().int().min(1).max(200).optional().meta({
                description: 'Maximum items to return (default: 50, max: 200)',
            }),
            offset: z.coerce.number().int().min(0).optional().meta({
                description: 'Offset for pagination (default: 0)',
            }),
            genre: z.string().optional().meta({ description: 'Filter by genre name' }),
            artist: z.string().optional().meta({ description: 'Filter by artist name' }),
            sort: z.enum(['alpha', 'year', 'recent']).optional().meta({
                description:
                    'Sort order: alpha (A-Z), year (newest first), recent (recently added). Default: recent',
            }),
        }),
        responses: {
            200: { schema: AlbumsResponseSchema, description: 'Album list' },
        },
    },
};
