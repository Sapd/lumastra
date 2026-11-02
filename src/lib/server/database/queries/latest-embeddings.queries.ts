// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { buildViewBasedMetadataJoin } from './builders/provider-metadata.builder.js';
import { AVAILABILITY_EXISTS, CAN_REQUEST_EXISTS } from './availability.queries.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

export interface LatestEmbeddingRow {
    internal_id: string;
    primary_ext_id: string;
    media_type: 'movie' | 'tv';
    title: string;
    overview?: string | null;
    genres?: number[] | null;
    anime_genres?: string[] | null;
    keywords?: string[] | null;
    mdblist_keywords?: string[] | null;
    actors?: string[] | null;
    directors?: string[] | null;
    producers?: string[] | null;
    writers?: string[] | null;
    networks?: string[] | null;
    production_companies?: string[] | null;
    imdb_rating?: number | null;
    tmdb_rating?: number | null;
    rt_rating?: number | null;
    letterboxd_rating?: number | null;
    mdblist_score?: number | null;
    release_date?: Date | string | null;
    runtime_minutes?: number | null;
    streaming_services?: string[] | null;
    is_available?: boolean | null;
    can_request?: boolean | null;
    has_library: boolean;
    has_discovery: boolean;
    updated_at?: Date | null;
    created_at?: Date | null;
    library_last_updated?: Date | null;
    discovery_last_updated?: Date | null;
}

export async function getLatestEmbeddings(
    sql: postgres.Sql,
    params: { limit: number; source: string | null },
): Promise<LatestEmbeddingRow[]> {
    const viewJoin = buildViewBasedMetadataJoin();
    const provider = getPrimaryExternalIdProvider();
    const { limit, source } = params;

    // Defense-in-depth: `limit` is interpolated raw into the `sql.unsafe` query
    // below (it's a LIMIT, not a bindable position in this query builder). The
    // sole caller already validates it via Zod, but this function's `number`
    // signature must not rely on that — guard here so a future caller can't
    // smuggle a non-integer/out-of-range value into the raw SQL.
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error(`getLatestEmbeddings: invalid limit ${limit}`);
    }

    const baseQuery = (whereClause: string, orderClause: string) =>
        sql.unsafe<LatestEmbeddingRow[]>(`
            SELECT
                mi.id::text as internal_id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = '${provider}' LIMIT 1), '') as primary_ext_id,
                mi.media_type,
                mi.title,
                vm.metadata->>'overview' as overview,
                CASE WHEN vm.metadata->'genres' IS NOT NULL AND jsonb_typeof(vm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT (elem::text)::integer FROM jsonb_array_elements(vm.metadata->'genres') AS elem)
                    ELSE NULL
                END as genres,
                CASE WHEN vm.metadata->'anime_genres' IS NOT NULL AND jsonb_typeof(vm.metadata->'anime_genres') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'anime_genres') AS elem)
                    ELSE NULL
                END as anime_genres,
                CASE WHEN vm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(vm.metadata->'keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'keywords') AS elem)
                    ELSE NULL
                END as keywords,
                CASE WHEN vm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(vm.metadata->'mdblist_keywords') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'mdblist_keywords') AS elem)
                    ELSE NULL
                END as mdblist_keywords,
                CASE WHEN vm.metadata->'actors' IS NOT NULL AND jsonb_typeof(vm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'actors') AS elem)
                    ELSE NULL
                END as actors,
                CASE WHEN vm.metadata->'directors' IS NOT NULL AND jsonb_typeof(vm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'directors') AS elem)
                    ELSE NULL
                END as directors,
                CASE WHEN vm.metadata->'producers' IS NOT NULL AND jsonb_typeof(vm.metadata->'producers') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'producers') AS elem)
                    ELSE NULL
                END as producers,
                CASE WHEN vm.metadata->'writers' IS NOT NULL AND jsonb_typeof(vm.metadata->'writers') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'writers') AS elem)
                    ELSE NULL
                END as writers,
                CASE WHEN vm.metadata->'networks' IS NOT NULL AND jsonb_typeof(vm.metadata->'networks') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'networks') AS elem)
                    ELSE NULL
                END as networks,
                CASE WHEN vm.metadata->'production_companies' IS NOT NULL AND jsonb_typeof(vm.metadata->'production_companies') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'production_companies') AS elem)
                    ELSE NULL
                END as production_companies,
                (vm.metadata->>'imdb_rating')::float as imdb_rating,
                (vm.metadata->>'tmdb_rating')::float as tmdb_rating,
                (vm.metadata->>'rt_rating')::integer as rt_rating,
                (vm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (vm.metadata->>'mdblist_score')::float as mdblist_score,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999 THEN make_date(mi.year, 1, 1) ELSE NULL END as release_date,
                (vm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                CASE WHEN vm.metadata->'streaming_services' IS NOT NULL AND jsonb_typeof(vm.metadata->'streaming_services') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(vm.metadata->'streaming_services') AS elem)
                    ELSE NULL
                END as streaming_services,
                ${AVAILABILITY_EXISTS} AS is_available,
                ${CAN_REQUEST_EXISTS} AS can_request,
                lib_emb.id IS NOT NULL as has_library,
                disc_emb.id IS NOT NULL as has_discovery,
                mi.updated_at,
                mi.created_at,
                lib_emb.updated_at as library_last_updated,
                disc_emb.updated_at as discovery_last_updated
            FROM media_items mi
            ${viewJoin}
            LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = '${EMBEDDING_SOURCE.LIBRARY}'
            LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = '${EMBEDDING_SOURCE.DISCOVERY}'
            WHERE mi.status = 'active' ${whereClause}
            ORDER BY ${orderClause}
            LIMIT ${limit}
        `);

    if (source === 'library') {
        return baseQuery(
            'AND lib_emb.id IS NOT NULL',
            'COALESCE(lib_emb.updated_at, mi.updated_at, mi.created_at) DESC',
        );
    } else if (source === 'tmdb') {
        return baseQuery(
            'AND disc_emb.id IS NOT NULL',
            'COALESCE(disc_emb.updated_at, mi.updated_at, mi.created_at) DESC',
        );
    } else {
        return baseQuery(
            '',
            'COALESCE(lib_emb.updated_at, disc_emb.updated_at, mi.updated_at, mi.created_at) DESC',
        );
    }
}
