// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lookup Embedding API - Admin-only endpoint to inspect media embeddings
 *
 * Query format:
 *   ?key=<uuid>                (lookup by internal UUID)
 *   ?key=tmdb:550:movie        (composite key: provider:id:mediaType)
 *
 * Note: External IDs are not unique across media types (same ID can be movie AND tv).
 * Always provide mediaType in composite keys to avoid ambiguity.
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import { EmbeddingLookupResultSchema } from '$lib/schemas/admin-types';
import { parseMediaKey } from '$lib/types/api-common';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';

const logger = Logger.for('LookupEmbedding');

const LookupEmbeddingResponseSchema = z.object({
    key: z.string(),
    result: EmbeddingLookupResultSchema.nullable(),
    count: z.number(),
});

interface EmbeddingLookupRow {
    internal_id: string;
    primary_ext_id: string | null;
    title: string;
    media_type: 'movie' | 'tv';
    overview?: string | null;
    genres?: number[] | null;
    actors?: string[] | null;
    directors?: string[] | null;
    has_library_embedding: boolean;
    has_discovery_embedding: boolean;
    mdblist_score?: number | null;
    mdblist_keywords?: string[] | null;
    streaming_services?: string[] | null;
    imdb_id?: string | null;
    tmdb_rating?: number | null;
    popularity?: number | null;
    vote_count?: number | null;
    created_at?: Date | null;
    updated_at?: Date | null;
}

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            key: z.string().min(1),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { key: keyParam } = ctx.input!.query;

            const sql = await aiDbService.getSql();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            // UUID regex: 8-4-4-4-12 hex chars
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                keyParam,
            );

            // Build the FROM/WHERE clauses based on lookup type
            let fromClause;
            let whereClause;

            if (isUuid) {
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only endpoint (auth: { kind: 'admin' }); embedding inspection by key is not subject to per-user library/age gating
                fromClause = sql`
                    FROM media_items mi
                    LEFT JOIN v_media_metadata vm ON vm.media_id = mi.id`;
                whereClause = sql`
                    WHERE mi.status = 'active'
                      AND mi.id = ${keyParam}::uuid`;
            } else {
                // Composite key lookup (provider:id:mediaType)
                const parsed = parseMediaKey(keyParam);
                if (!parsed) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'key',
                            message:
                                'Invalid key format. Use: <uuid> or provider:id:mediaType (e.g., tmdb:550:movie)',
                        },
                    ]);
                }

                if (parsed.provider !== getPrimaryExternalIdProvider()) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'key',
                            message: `Provider '${parsed.provider}' not supported. Use '${getPrimaryExternalIdProvider()}' provider.`,
                        },
                    ]);
                }

                const externalId = parseInt(parsed.id, 10);
                if (isNaN(externalId)) {
                    return ApiProblem.validationFailed([
                        { field: 'key', message: 'Invalid external ID in key' },
                    ]);
                }

                const mediaType: 'movie' | 'tv' | null = isMovie(parsed.mediaType)
                    ? 'movie'
                    : isSeries(parsed.mediaType)
                      ? 'tv'
                      : null;

                const mediaTypeCondition = mediaType
                    ? sql`AND mi.media_type = ${mediaType}`
                    : sql``;

                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only endpoint (auth: { kind: 'admin' }); embedding inspection by key is not subject to per-user library/age gating
                fromClause = sql`
                    FROM media_items mi
                    JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                    LEFT JOIN v_media_metadata vm ON vm.media_id = mi.id`;
                whereClause = sql`
                    WHERE mi.status = 'active'
                      AND primary_ext.external_id = ${externalId}::text
                      ${mediaTypeCondition}`;
            }

            // Single query for both lookup types
            const results = await sql<EmbeddingLookupRow[]>`
                SELECT
                  mi.id::text as internal_id,
                  (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
                  mi.title,
                  mi.media_type,
                  (vm.metadata->>'overview')::text as overview,
                  CASE WHEN vm.metadata->'genres' IS NOT NULL AND jsonb_typeof(vm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(vm.metadata->'genres') AS elem)
                    ELSE NULL
                  END as genres,
                  CASE WHEN vm.metadata->'actors' IS NOT NULL AND jsonb_typeof(vm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'actors') AS elem)
                    ELSE NULL
                  END as actors,
                  CASE WHEN vm.metadata->'directors' IS NOT NULL AND jsonb_typeof(vm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'directors') AS elem)
                    ELSE NULL
                  END as directors,
                  EXISTS(SELECT 1 FROM media_embeddings WHERE media_id = mi.id AND source = ${EMBEDDING_SOURCE.LIBRARY}) as has_library_embedding,
                  EXISTS(SELECT 1 FROM media_embeddings WHERE media_id = mi.id AND source = ${EMBEDDING_SOURCE.DISCOVERY}) as has_discovery_embedding,
                  (vm.metadata->>'mdblist_score')::float as mdblist_score,
                  CASE WHEN vm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(vm.metadata->'mdblist_keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'mdblist_keywords') AS elem)
                    ELSE NULL
                  END as mdblist_keywords,
                  CASE WHEN vm.metadata->'streaming_services' IS NOT NULL AND jsonb_typeof(vm.metadata->'streaming_services') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'streaming_services') AS elem)
                    ELSE NULL
                  END as streaming_services,
                  (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                  (vm.metadata->>'tmdb_rating')::float as tmdb_rating,
                  (vm.metadata->>'popularity')::float as popularity,
                  (vm.metadata->>'vote_count')::integer as vote_count,
                  mi.created_at,
                  mi.updated_at
                ${fromClause}
                ${whereClause}
            `;

            if (results.length === 0) {
                return ApiProblem.notFound('No embedding found for this key');
            }

            logger.debug('Embedding lookup completed', {
                key: keyParam,
                found: results.length,
            });

            const items = results.map((r) => ({
                externalIds: {
                    internal: String(r.internal_id),
                    ...(r.primary_ext_id
                        ? { [getPrimaryExternalIdProvider()]: String(r.primary_ext_id) }
                        : {}),
                },
                title: r.title,
                mediaType: r.media_type,
                overview: r.overview ?? null,
                genres: r.genres ? r.genres.map(String) : null,
                actors: r.actors ?? null,
                directors: r.directors ?? null,
                hasLibraryEmbedding: r.has_library_embedding,
                hasDiscoveryEmbedding: r.has_discovery_embedding,
                mdblistScore: r.mdblist_score ?? null,
                createdAt: r.created_at ? r.created_at.toISOString() : '',
                updatedAt: r.updated_at ? r.updated_at.toISOString() : '',
            }));

            return json(
                LookupEmbeddingResponseSchema.parse({
                    key: keyParam,
                    result: items[0] ?? null,
                    count: items.length,
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
