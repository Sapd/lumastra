// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Latest Embeddings API
 * Returns the most recently created/updated embeddings for live preview
 * Uses the same createEmbeddingText function as the embedding generator
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { getDb } from '$lib/server/database';
import { createEmbeddingText, type MediaEntry } from '$lib/server/ai/embedding-only-generator';
import { Logger } from '$lib/server/utils/logger';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { getLatestEmbeddings } from '$lib/server/database/queries/latest-embeddings.queries.js';

const logger = Logger.for('AI:LatestEmbeddings');

const LatestEmbeddingItemSchema = z.object({
    externalIds: z.record(z.string(), z.string()),
    mediaType: z.string(),
    title: z.string(),
    embeddingText: z.string(),
    source: z.string(),
    // DB rows may return Date objects, ISO strings, or null depending on
    // which of library_last_updated / discovery_last_updated / updated_at /
    // created_at was non-null first. Accept all three for forward compatibility.
    updatedAt: z.union([z.date(), z.string(), z.null()]),
});

const LatestEmbeddingsResponseSchema = z.object({
    embeddings: z.array(LatestEmbeddingItemSchema),
    fetchedAt: z.string(),
});

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            limit: z.coerce.number().int().min(1).max(20).optional().default(5),
            source: z.string().optional(),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is currently unavailable');
            }

            const { limit, source } = ctx.input!.query;

            const results = await getLatestEmbeddings(sql, {
                limit,
                source: source as string | null,
            });

            const embeddings = results.map((row) => {
                // Determine source based on which embedding was updated last
                let embeddingSource = 'unknown';
                if (row.has_library && row.has_discovery) {
                    embeddingSource = 'both';
                } else if (row.has_library) {
                    embeddingSource = 'library';
                } else if (row.has_discovery) {
                    embeddingSource = 'tmdb';
                }

                // Convert DB row to MediaEntry format for createEmbeddingText
                const entry: MediaEntry = {
                    primary_ext_id: row.primary_ext_id,
                    media_type: row.media_type,
                    title: row.title,
                    overview: row.overview ?? undefined,
                    release_date: row.release_date ? new Date(row.release_date) : undefined,
                    runtime_minutes: row.runtime_minutes ?? undefined,
                    genres: row.genres ?? undefined,
                    keywords: row.keywords ?? undefined,
                    mdblist_keywords: row.mdblist_keywords ?? undefined,
                    networks: row.networks ?? undefined,
                    production_companies: row.production_companies ?? undefined,
                    actors: row.actors ?? undefined,
                    directors: row.directors ?? undefined,
                    producers: row.producers ?? undefined,
                    writers: row.writers ?? undefined,
                    imdb_rating: row.imdb_rating ?? undefined,
                    tmdb_rating: row.tmdb_rating ?? undefined,
                    mdblist_score: row.mdblist_score ?? undefined,
                    letterboxd_rating: row.letterboxd_rating ?? undefined,
                    rt_rating: row.rt_rating ?? undefined,
                    anime_genres: row.anime_genres ?? undefined,
                    streaming_services: row.streaming_services ?? undefined,
                    is_available: row.is_available ?? undefined,
                    can_request: row.can_request ?? undefined,
                };

                return {
                    externalIds: {
                        internal: String(row.internal_id),
                        [getPrimaryExternalIdProvider()]: String(row.primary_ext_id),
                    },
                    mediaType: row.media_type,
                    title: row.title,
                    embeddingText: createEmbeddingText(entry),
                    source: embeddingSource,
                    updatedAt:
                        row.library_last_updated ||
                        row.discovery_last_updated ||
                        row.updated_at ||
                        row.created_at,
                };
            });

            logger.debug('Fetched latest embeddings', { count: embeddings.length, limit, source });

            return json(
                LatestEmbeddingsResponseSchema.parse({
                    embeddings,
                    fetchedAt: new Date().toISOString(),
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
