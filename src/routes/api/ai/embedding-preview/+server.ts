// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Preview embedding text for randomly selected active media items from the database
import { json } from '@sveltejs/kit';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { Logger } from '$lib/server/utils/logger';
import type postgres from 'postgres';
import { aiDbService } from '$lib/server/services/database.service';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import type { MediaEntry } from '$lib/server/ai/embedding-only-generator';
import { EmbeddingPreviewsResponseSchema } from '$lib/schemas/admin-types';

const logger = Logger.for('ai-embedding-preview');

interface PreviewRow {
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

async function queryRandomItems(sql: postgres.Sql, provider: string): Promise<PreviewRow[]> {
    // Both suppressions share one cause: this is an admin-only embedding
    // preview. The endpoint declares `auth: { kind: 'admin' }` (see the def
    // below), and an admin is by policy allowed to read every media row —
    // including file-less catalog rows, which is the whole point of sampling
    // here. `no-unscoped-media-items` had been satisfied only by the word
    // "requireAdmin" sitting in this directive's own justification text;
    // prose, not a gate (fixed 2026-07-30).
    // eslint-disable-next-line callback-safety/require-has-files-with-active-status, callback-safety/no-unscoped-media-items
    return sql<PreviewRow[]>`
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
        FROM (
            -- Pick one random item per type, then fill remaining slots
            (SELECT id FROM media_items WHERE status = 'active' AND media_type = 'movie' ORDER BY RANDOM() LIMIT 1)
            UNION ALL
            (SELECT id FROM media_items WHERE status = 'active' AND media_type = 'tv' ORDER BY RANDOM() LIMIT 1)
            UNION ALL
            (SELECT id FROM media_items WHERE status = 'active' AND media_type = 'track' ORDER BY RANDOM() LIMIT 1)
            UNION ALL
            (SELECT id FROM media_items WHERE status = 'active' AND media_type IN ('movie', 'tv', 'track') ORDER BY RANDOM() LIMIT 1)
        ) picked
        JOIN media_items mi ON mi.id = picked.id
        ${buildMetadataLateralJoinFragment(sql)}
    `;
}

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const { createEmbeddingText } = await import('$lib/server/ai/embedding-only-generator');

            const sql = await aiDbService.getSql();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            const provider = getPrimaryExternalIdProvider();
            const rows = await queryRandomItems(sql, provider);

            const previews = rows
                .map((row) => {
                    // queryRandomItems deliberately samples one 'track' row
                    // (its 4th UNION ALL branch) alongside movie/tv — the
                    // EmbeddingPreview schema only knows 'movie' | 'series',
                    // so a track (or any other non-movie/tv type) has no
                    // representation here. Drop it rather than mislabel it.
                    const canonicalType = toMovieOrSeries(row.media_type);
                    if (!canonicalType) return null;

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

                    let embeddingText = '';
                    try {
                        embeddingText = createEmbeddingText(entry);
                    } catch (err) {
                        logger.warn('Failed to generate embedding text for preview item', {
                            id: row.internal_id,
                            error: err,
                        });
                    }

                    return {
                        source: 'Database',
                        title: row.title,
                        type: canonicalType,
                        primaryExternalId:
                            row.primary_ext_id !== row.internal_id ? row.primary_ext_id : null,
                        embeddingText,
                        rawData: {
                            hasOverview: !!row.overview,
                            genresCount: row.genres?.length ?? 0,
                            keywordsCount: row.keywords?.length ?? 0,
                            actorsCount: row.actors?.length ?? 0,
                            hasMdblistData: !!(row.mdblist_keywords?.length || row.mdblist_score),
                        },
                    };
                })
                .filter((p): p is NonNullable<typeof p> => p !== null);

            return json(
                EmbeddingPreviewsResponseSchema.parse({
                    previews,
                    info: {
                        jellyfinConnected: false,
                        jellyseerrConnected: false,
                        note: 'Random sample from active media items in the database',
                        timestamp: new Date().toISOString(),
                    },
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
