// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Text Preview API - Admin-only endpoint
 *
 * Returns the exact embedding text that would be generated for a media item,
 * using the same code path as the actual embedding generator.
 *
 * GET /api/ai/embedding-text/:id
 *   :id — internal UUID of the media item
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import type { MediaEntry } from '$lib/server/ai/embedding-only-generator';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import { EmbeddingTextResponseSchema } from '$lib/schemas/admin-types';

const logger = Logger.for('EmbeddingTextPreview');

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MediaEntryRow {
    internal_id: string;
    primary_ext_id: string;
    media_type: 'movie' | 'tv' | 'artist' | 'album' | 'track';
    title: string;
    custom_metadata: Record<string, unknown> | null;
    release_date: Date | null;
    overview: string | null;
    runtime_minutes: number | null;
    genres: number[] | null;
    keywords: string[] | null;
    mdblist_keywords: string[] | null;
    networks: string[] | null;
    production_companies: string[] | null;
    actors: string[] | null;
    directors: string[] | null;
    producers: string[] | null;
    writers: string[] | null;
    imdb_rating: number | null;
    tmdb_rating: number | null;
    mdblist_score: number | null;
    letterboxd_rating: number | null;
    rt_rating: number | null;
    anime_genres: string[] | null;
    streaming_services: string[] | null;
}

async function queryMediaEntry(
    sql: postgres.Sql,
    id: string,
    provider: string,
): Promise<MediaEntryRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only endpoint (auth: { kind: 'admin' }); embedding-text preview by UUID is not subject to per-user library/age gating
    return sql<MediaEntryRow[]>`
        SELECT
            mi.id::text AS internal_id,
            COALESCE(
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${provider} LIMIT 1),
                mi.id::text
            ) AS primary_ext_id,
            mi.media_type,
            mi.title,
            mi.custom_metadata,
            CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                THEN make_date(mi.year, 1, 1)
                ELSE NULL
            END AS release_date,
            (pm.metadata->>'overview')::text AS overview,
            (pm.metadata->>'runtime_minutes')::integer AS runtime_minutes,
            CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                ELSE NULL
            END AS genres,
            CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'keywords') AS elem)
                ELSE NULL
            END AS keywords,
            CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'mdblist_keywords') AS elem)
                ELSE NULL
            END AS mdblist_keywords,
            CASE WHEN pm.metadata->'networks' IS NOT NULL AND jsonb_typeof(pm.metadata->'networks') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'networks') AS elem)
                ELSE NULL
            END AS networks,
            CASE WHEN pm.metadata->'production_companies' IS NOT NULL AND jsonb_typeof(pm.metadata->'production_companies') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'production_companies') AS elem)
                ELSE NULL
            END AS production_companies,
            CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                ELSE NULL
            END AS actors,
            CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                ELSE NULL
            END AS directors,
            CASE WHEN pm.metadata->'producers' IS NOT NULL AND jsonb_typeof(pm.metadata->'producers') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'producers') AS elem)
                ELSE NULL
            END AS producers,
            CASE WHEN pm.metadata->'writers' IS NOT NULL AND jsonb_typeof(pm.metadata->'writers') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'writers') AS elem)
                ELSE NULL
            END AS writers,
            (pm.metadata->>'imdb_rating')::float AS imdb_rating,
            (pm.metadata->>'tmdb_rating')::float AS tmdb_rating,
            (pm.metadata->>'mdblist_score')::float AS mdblist_score,
            (pm.metadata->>'letterboxd_rating')::float AS letterboxd_rating,
            (pm.metadata->>'rt_rating')::integer AS rt_rating,
            CASE WHEN pm.metadata->'anime_genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'anime_genres') AS elem)
                ELSE NULL
            END AS anime_genres,
            CASE WHEN pm.metadata->'streaming_services' IS NOT NULL AND jsonb_typeof(pm.metadata->'streaming_services') = 'array'
                THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'streaming_services') AS elem)
                ELSE NULL
            END AS streaming_services
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.id = ${id}::uuid
          AND mi.status = 'active'
    `;
}

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: z.object({ id: z.string() }),
    },
    handlers: {
        GET: async (event) => {
            const { id } = event.params;

            if (!id || !uuidRegex.test(id)) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid ID format. Must be a UUID.' },
                ]);
            }

            const sql = await aiDbService.getSql();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            const provider = getPrimaryExternalIdProvider();
            const results = await queryMediaEntry(sql, id, provider);

            if (results.length === 0) {
                return ApiProblem.notFound('Media item not found');
            }

            const row = results[0];
            const entry: MediaEntry = {
                primary_ext_id: row.primary_ext_id,
                media_type: row.media_type,
                title: row.title,
                custom_metadata: row.custom_metadata,
                release_date: row.release_date ?? undefined,
                overview: row.overview ?? undefined,
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
            };

            // Dynamic import avoids module-level side effects from embedding-only-generator
            // (dotenv.config() and Database class initialization) poisoning the ESLint type graph.
            const { createEmbeddingText } = await import('$lib/server/ai/embedding-only-generator');
            const embeddingText = createEmbeddingText(entry);

            logger.debug('Generated embedding text preview', {
                id,
                mediaType: row.media_type,
                textLength: embeddingText.length,
            });

            return json(
                EmbeddingTextResponseSchema.parse({
                    id: row.internal_id,
                    title: row.title,
                    mediaType: row.media_type,
                    embeddingText,
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
