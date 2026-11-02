// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MusicArtistsResponseSchema } from '$lib/schemas/api-music-responses';

const ArtistsResponseSchema = MusicArtistsResponseSchema;

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Browse music artists',
        description:
            'Returns a paginated list of artists. Filter by genre, sort by alpha, year, or recently added.',
        query: z.object({
            limit: z.coerce.number().int().min(1).max(200).optional().meta({
                description: 'Maximum items to return (default: 100, max: 200)',
            }),
            offset: z.coerce.number().int().min(0).optional().meta({
                description: 'Offset for pagination (default: 0)',
            }),
            genre: z.string().optional().meta({ description: 'Filter by genre name' }),
            sort: z.enum(['alpha', 'year', 'recent']).optional().meta({
                description:
                    'Sort order: alpha (A-Z), year (newest first), recent (recently added). Default: alpha',
            }),
        }),
        responses: {
            200: { schema: ArtistsResponseSchema, description: 'Artist list' },
        },
    },
};
