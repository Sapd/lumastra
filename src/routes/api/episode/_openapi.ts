// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { EpisodeResponseSchema } from '$lib/schemas/api-content-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Episodes'],
        summary: 'Look up an episode ID',
        description:
            'Look up a specific episode by series name, season number, and episode number. Returns the Jellyfin episode ID.',
        query: z.object({
            series: z.string().optional().meta({
                description: 'Series name (fuzzy fallback when no external ID is provided)',
            }),
            season: z.coerce.number().meta({ description: 'Season number' }),
            episode: z.coerce.number().meta({ description: 'Episode number' }),
            seriesTmdbId: z.string().optional().meta({ description: 'Series TMDB ID (preferred)' }),
            seriesTvdbId: z.string().optional().meta({ description: 'Series TVDB ID (preferred)' }),
            seriesImdbId: z.string().optional().meta({ description: 'Series IMDB ID (preferred)' }),
        }),
        responses: {
            200: { schema: EpisodeResponseSchema, description: 'Episode ID' },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
