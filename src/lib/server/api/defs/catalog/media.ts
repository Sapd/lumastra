// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { loadMediaListing } from '$lib/server/services/browse-index.service.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { paginatedEnvelope } from '$lib/schemas/pagination.js';

export const MediaListingQuerySchema = z
    .object({
        type: z.enum(['movie', 'series']).optional(),
        libraryGroupId: z.uuid().optional(),
        genre: z.string().min(1).max(100).optional(),
        letter: z
            .string()
            .regex(/^[A-Za-z#]$/)
            .optional(),
        tag: z.string().min(1).max(100).optional(),
        keyword: z.string().min(1).max(100).optional(),
        year: z.coerce.number().int().min(1).max(9999).optional(),
        sort: z.enum(['title', 'added', 'year', 'rating', 'runtime']).default('title'),
        order: z.enum(['asc', 'desc']).default('asc'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
        include: z.literal('facets').optional(),
    })
    .strict();
export const MediaListingResponseSchema = paginatedEnvelope(MediaPreviewSchema)
    .extend({
        facets: z
            .object({
                letterCounts: z.array(z.object({ letter: z.string(), count: z.number().int() })),
                genreCounts: z.array(z.object({ name: z.string(), count: z.number().int() })),
            })
            .optional(),
    })
    .meta({ id: 'MediaListingResponse' });

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { query: MediaListingQuerySchema },
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'List accessible library movies and series',
            description:
                'One library listing with composable type, libraryGroupId, genre, letter, tag, keyword and year filters. Stable title, added, year, rating or runtime ordering. Items carry opaque handles, poster ImageSet, metadata, availability and PlaybackProgress in milliseconds. Request include=facets for letterCounts and genreCounts. Example: /media?type=movie&sort=title&limit=50&offset=0.',
            stability: 'stable',
            auth: 'bearer',
            query: MediaListingQuerySchema,
            responses: {
                200: {
                    schema: MediaListingResponseSchema,
                    description: 'MediaPreview page; facets only when requested',
                },
                401: 'Authentication required',
                422: 'Invalid filters',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            return json(
                await loadMediaListing(sql, event.locals.user!, ctx.surface, ctx.input!.query),
            );
        },
    },
});
