// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/available-genres.ts — GET /api/ai/available-genres
 *
 * Fetches TMDB genres that have sufficient content in the DB for AI recommendations.
 * Filters by media type and applies library/age-rating access restrictions.
 *
 * Returns a bare object: { media_type, genres }.
 * Internal surface only.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';
import { buildViewBasedMetadataJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';

interface GenreRow {
    genre_id: number | string;
    total_count: string;
    library_count: string;
    tmdb_count: string;
}

// Typed genre item — no passthrough
const GenreItemSchema = z.object({
    id: z.string(),
    count: z.number(),
    library_count: z.number(),
    tmdb_count: z.number(),
});

// Bare object response — no success wrapper
const AvailableGenresResponseSchema = z.object({
    media_type: z.string(),
    genres: z.array(GenreItemSchema),
});

const GenresQuerySchema = z.object({
    mediaType: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: GenresQuerySchema,
    },

    handlers: {
        GET: async (event) => {
            if (!event.locals.user) {
                return ApiProblem.unauthorized();
            }

            const mediaType = event.url.searchParams.get('mediaType') || 'tv';

            const { getDb } = await import('$lib/server/database');
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database not initialized');
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

            const genreQuery = await sql<GenreRow[]>`
      WITH media_with_genres AS (
        SELECT
          mi.id,
          unnest(
            CASE WHEN vm.metadata->'genres' IS NOT NULL AND jsonb_typeof(vm.metadata->'genres') = 'array'
              THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(vm.metadata->'genres') AS elem)
              ELSE ARRAY[]::integer[]
            END
          ) as genre_id
        FROM media_items mi
        ${buildViewBasedMetadataJoinFragment(sql)}
        WHERE mi.status = 'active'
          AND mi.media_type = ${mediaType}
          AND vm.metadata->'genres' IS NOT NULL
          AND jsonb_typeof(vm.metadata->'genres') = 'array'
          AND jsonb_array_length(vm.metadata->'genres') > 0
          ${buildLibraryAccessFilter(sql, accessCtx.deniedGroupIds)}
          ${buildAgeRatingFilter(sql, accessCtx.ageRating)}
      )
      SELECT
        mwg.genre_id,
        COUNT(DISTINCT mwg.id)::text as total_count,
        COUNT(DISTINCT CASE WHEN lib_emb.media_id IS NOT NULL THEN mwg.id END)::text as library_count,
        COUNT(DISTINCT CASE WHEN disc_emb.media_id IS NOT NULL THEN mwg.id END)::text as tmdb_count
      FROM media_with_genres mwg
      LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mwg.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
      LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mwg.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
      GROUP BY mwg.genre_id
      HAVING COUNT(DISTINCT CASE WHEN lib_emb.media_id IS NOT NULL THEN mwg.id END) >= 2
         AND COUNT(DISTINCT CASE WHEN disc_emb.media_id IS NOT NULL THEN mwg.id END) >= 2
         AND COUNT(DISTINCT mwg.id) >= 5
      ORDER BY COUNT(DISTINCT mwg.id) DESC
    `;

            const genres = genreQuery.map((row) => ({
                id: String(row.genre_id),
                count: parseInt(row.total_count, 10),
                library_count: parseInt(row.library_count, 10),
                tmdb_count: parseInt(row.tmdb_count, 10),
            }));

            const body = AvailableGenresResponseSchema.parse({ media_type: mediaType, genres });
            return json(body);
        },
    },
});
