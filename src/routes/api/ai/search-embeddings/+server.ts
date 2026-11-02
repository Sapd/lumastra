// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Search embeddings by title (admin only)
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import { searchMediaByTitle } from '$lib/server/database/queries/ai-admin.queries.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { type EmbeddingSample, EmbeddingSampleSchema } from '$lib/schemas/admin-types';

const logger = Logger.for('SearchEmbeddings');

const SearchEmbeddingsResponseSchema = z.object({
    query: z.string(),
    mediaType: z.string().nullable(),
    results: z.array(EmbeddingSampleSchema),
    count: z.number(),
});

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            q: z.string().min(2, 'Query must be at least 2 characters').max(200),
            type: z.string().optional(),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { q: query, type: mediaType } = ctx.input!.query;

            const sql = await aiDbService.getSql();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            // Search by title with optional media type filter
            const searchPattern = `%${query}%`;
            const results = await searchMediaByTitle(
                sql,
                searchPattern,
                query,
                mediaType || undefined,
                50,
            );

            logger.debug('Embedding search completed', {
                query,
                mediaType,
                resultCount: results.length,
            });

            const samples: EmbeddingSample[] = results.map((e) => ({
                id: e.id,
                externalIds: {
                    internal: String(e.id),
                    [getPrimaryExternalIdProvider()]: e.primary_ext_id,
                },
                title: e.title,
                mediaType: e.media_type,
                genres: e.genres ?? null,
            }));

            return json(
                SearchEmbeddingsResponseSchema.parse({
                    query,
                    mediaType: mediaType ?? null,
                    results: samples,
                    count: samples.length,
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
