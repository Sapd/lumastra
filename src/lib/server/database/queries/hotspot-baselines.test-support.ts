// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Pre-optimization query strategy for differential tests and repeatable EXPLAINs.
// Collaboration value projection follows the current credit-only fingerprint contract.
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type { DamperContext } from '$lib/server/services/taste-damper.service.js';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildDamperPenalty, DAMPER_LAMBDA } from './builders/damper-penalty.builder.js';
import { KIDS_GENRE_IDS, ANIME_GENRE_ID } from './content-affinity.queries.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { isAvailableExpr } from './availability.queries.js';
import { currentTrickplayFileMarker } from './trickplay-params.queries.js';
function collaborationTrackReferencePredicate(
    sql: postgres.Sql,
    trackAlias: string,
    artistExpr: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const t = sql(trackAlias);
    return sql`(
        ${t}.custom_metadata->'additional_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'file_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'album_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'remixer_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'title_remixer_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'independent_remixer_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'track_artist_credits' @> jsonb_build_array(jsonb_build_object('id', ${artistExpr}::text))
        OR ${t}.custom_metadata->'track_remixer_credits' @> jsonb_build_array(jsonb_build_object('id', ${artistExpr}::text))
    )`;
}

export function baselineFingerprintSql(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const a = sql(alias);
    const trackReference = collaborationTrackReferencePredicate(sql, 't', sql`${a}.id`);
    return sql`md5(
        COALESCE(${a}.title,'') || ':' ||
        COALESCE(${a}.custom_metadata->>'no_split','') || ':' ||
        COALESCE(${a}.custom_metadata->>'musicbrainz_artist_id','') || ':' ||
        COALESCE((SELECT string_agg(ei.provider || ':' || ei.external_id, '|' ORDER BY ei.provider,ei.external_id)
            FROM external_ids ei WHERE ei.media_id=${a}.id), '') || ':' ||
        COALESCE((SELECT string_agg(album.id::text, '|' ORDER BY album.id)
            FROM media_items album WHERE album.media_type='album' AND album.parent_id=${a}.id), '') || ':' ||
        COALESCE((SELECT string_agg(
            t.id::text || ':' || jsonb_build_array(t.parent_id,t.metadata_locked,t.is_dismissed,
                (SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(t.custom_metadata)='object'
                    THEN t.custom_metadata ELSE '{}'::jsonb END)
                 WHERE key IN ('artist','artists','album_artist','album_artists','raw_artist_tags','remixer',
                    'musicbrainz_artist_ids','artist_credit_source','track_artist_credits','track_remixer_credits',
                    'additional_artist_ids','file_artist_ids','album_artist_ids','remixer_artist_ids',
                    'title_remixer_artist_ids','independent_remixer_artist_ids')))::text || ':' || COALESCE(owner.id::text,'') || ':' ||
            COALESCE((SELECT string_agg(jsonb_build_array(mfi.file_id,mf.file_mtime,mf.file_size_bytes,mf.file_hash_head)::text,
                ',' ORDER BY mfi.file_id)
                FROM media_file_items mfi JOIN media_files mf ON mf.id=mfi.file_id
                WHERE mfi.media_item_id=t.id), ''),
            '|' ORDER BY t.id)
            FROM media_items t
            LEFT JOIN media_items album ON album.id=t.parent_id AND album.media_type='album'
            LEFT JOIN media_items owner ON owner.id=album.parent_id AND owner.media_type='artist'
            WHERE t.media_type='track' AND t.status='active' AND t.canonical_id IS NULL
              AND (album.parent_id=${a}.id OR ${trackReference})), '')
    )`;
}

/** Skip the correlated catalog fingerprint until an operator has reviewed this row. */
export function baselineNeedsReviewSql(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const a = sql(alias);
    return sql`CASE
        WHEN COALESCE(${a}.custom_metadata->>'collaboration_reviewed', '') = '' THEN TRUE
        ELSE ${a}.custom_metadata->>'collaboration_reviewed' <> ${baselineFingerprintSql(sql, alias)}
    END`;
}

export function baselinePerfectMatchSql(
    sql: postgres.Sql,
    userId: UserId,
    excludeMediaIds: string[],
    limit: number,
    access: MediaAccessBoundary,
    minVoteCount = 50,
    suppressKidsContent = false,
    suppressAnimeContent = false,
    damper: DamperContext | null = null,
): postgres.PendingQuery<postgres.Row[]> {
    const excludeFilter = excludeMediaIds.length
        ? sql`mi.id != ALL(${excludeMediaIds}::uuid[])`
        : sql`TRUE`;
    // eslint-disable-next-line callback-safety/require-has-files-with-active-status -- Frozen discovery SQL must retain requestable candidates for differential tests.
    return sql`
        WITH watched AS (
            SELECT media_id FROM user_media_state WHERE user_id = ${userId} AND is_watched = true
        ),
        disliked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating <= 4
        ),
        liked AS (
            SELECT media_id FROM user_ratings WHERE user_id = ${userId} AND rating >= 7
        ),
        user_profile AS (
            SELECT AVG(me.embedding) as avg_embedding
            FROM liked l
            JOIN media_embeddings me ON me.media_id = l.media_id
            WHERE me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        ),
        top_matches AS (
            SELECT
                mi.id as media_id,
                primary_ext.external_id as primary_ext_id,
                imdb_ext.external_id as imdb_id,
                mi.media_type,
                mi.title,
                pm.metadata as pm_metadata,
                ${isAvailableExpr(sql)} AS is_available,
                1 - (me.embedding <=> up.avg_embedding) as similarity_score
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                AND primary_ext.media_type = mi.media_type
            LEFT JOIN external_ids imdb_ext ON imdb_ext.media_id = mi.id
                AND imdb_ext.provider = 'imdb'
            ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
                JOIN media_embeddings me ON me.media_id = mi.id AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
            CROSS JOIN user_profile up
            WHERE mi.status = 'active'
                AND mi.media_type IN ('movie', 'tv')
                AND up.avg_embedding IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.media_id = mi.id)
                AND NOT EXISTS (SELECT 1 FROM disliked d WHERE d.media_id = mi.id)
                AND (pm.metadata->>'adult')::boolean IS NOT TRUE
            AND (pm.metadata->>'is_color') IS DISTINCT FROM 'false'
                AND COALESCE((pm.metadata->>'vote_count')::int, 0) >= ${minVoteCount}
                AND ${excludeFilter}
                ${buildLibraryAccessFilter(sql, access.library)}
                ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY (
                (
                    (1 - (me.embedding <=> up.avg_embedding))
                    - GREATEST(1 - (me.embedding <=> up.avg_embedding), 0) * ${DAMPER_LAMBDA}::numeric * ${buildDamperPenalty(sql, sql`me.embedding`, damper)}
                )
                -- Soft cluster (kids/anime) down-rank applied BEFORE the top-5
                -- LIMIT below, so a flagged item only survives into the pool
                -- when there aren't 5 stronger non-flagged matches. Similarity
                -- here is bounded to roughly [-1, 1], so subtracting 10
                -- reliably drops a flagged match below every non-flagged
                -- candidate.
                - CASE
                    WHEN (
                        (${suppressKidsContent} AND EXISTS (
                            SELECT 1 FROM media_genres mg
                            WHERE mg.media_id = mi.id
                              AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                        ))
                        OR (${suppressAnimeContent} AND (
                            EXISTS (
                                SELECT 1 FROM media_keywords mk
                                WHERE mk.media_id = mi.id
                                  AND mk.keyword_type = 'mdblist'
                                  AND mk.keyword = 'anime'
                            )
                            OR (
                                EXISTS (
                                    SELECT 1 FROM media_genres mg2
                                    WHERE mg2.media_id = mi.id
                                      AND mg2.genre_id = ${ANIME_GENRE_ID}
                                )
                                AND (pm.metadata->>'original_language') = 'ja'
                            )
                        ))
                    ) THEN 10
                    ELSE 0
                  END
            ) DESC
            LIMIT 5
        )
        SELECT
            media_id,
            primary_ext_id,
            imdb_id,
            media_type,
            title,
            (pm_metadata->>'overview')::text as overview,
            (pm_metadata->>'imdb_rating')::float as imdb_rating,
            (pm_metadata->>'popularity')::float as popularity,
            NULLIF(pm_metadata->>'release_date', '')::date as release_date,
            (pm_metadata->>'runtime')::integer as runtime_minutes,
            (SELECT array_agg(g) FROM jsonb_array_elements_text(pm_metadata->'genres') g) as genres,
            (pm_metadata->>'trailer_url')::text as trailer_url,
            is_available,
            similarity_score,
            (pm_metadata->>'rt_rating')::integer as rt_critic,
            (pm_metadata->>'rt_audience_score')::integer as rt_audience,
            (pm_metadata->>'mdblist_score')::float as mdblist_score
        FROM top_matches
        ORDER BY RANDOM()
        LIMIT ${limit}
    `;
}

export function baselineGetLastEndedSessionSql(
    sql: postgres.Sql,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT
            COALESCE(u.username, ps.user_id::text) AS username,
            CASE
                WHEN mi.media_type = 'episode' AND COALESCE(gp.title, p.title) IS NOT NULL
                    THEN COALESCE(gp.title, p.title) || ' – ' || mi.title
                ELSE mi.title
            END AS title,
            ps.stopped_at
        FROM play_sessions ps
        LEFT JOIN users u ON u.id = ps.user_id
        LEFT JOIN media_items mi ON mi.id = ps.media_id
        LEFT JOIN media_items p ON p.id = mi.parent_id
        LEFT JOIN media_items gp ON gp.id = p.parent_id
        WHERE ps.status IN ('COMPLETED', 'CRASHED', 'KILLED')
          AND ps.stopped_at IS NOT NULL
        ORDER BY ps.stopped_at DESC
        LIMIT 1
    `;
}

export function baselineGetRecentlyAddedForOpsSql(
    sql: postgres.Sql,
    limit = 10,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT mi.id,
               mi.title,
               mi.media_type AS "mediaType",
               mi.year,
               series.id AS "seriesId",
               series.title AS "seriesTitle",
               mi.season_number AS "seasonNumber",
               mi.episode_number AS "episodeNumber",
               to_char(COALESCE(mi.library_added_at, mi.created_at) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "addedAt"
          FROM media_items mi
          LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
          LEFT JOIN media_items series ON series.id = CASE
              WHEN mi.media_type = 'season' THEN mi.parent_id
              WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
          END
         WHERE mi.status = 'active'
           AND mi.has_files = true
           AND mi.media_type IN ('movie', 'episode')
         ORDER BY COALESCE(mi.library_added_at, mi.created_at) DESC
         LIMIT ${limit}
    `;
}

export function baselineGetTrickplayBacklogCountsSql(
    sql: postgres.Sql,
    processingVersion: number,
    mediaTypes?: string[],
): postgres.PendingQuery<postgres.Row[]> {
    const effectiveTypes = mediaTypes ?? ['movie', 'episode'];
    return sql`
        -- Invariant: analyzed keys on EXISTS trickplay_params, so a row
        -- becomes analyzed as soon as params are generated regardless of any
        -- residual processing_state failure marker. No explicit marker clear
        -- is required — Phase C Task 6 locks this in as a design choice.
        --
        -- MATERIALIZED: has_params (a correlated EXISTS against
        -- trickplay_params) is read by 4 separate COUNT(*) FILTER clauses
        -- below. Without the barrier the planner inlines this CTE (it has
        -- exactly one reference in the FROM clause, the usual inlining
        -- trigger) and re-derives the EXISTS once per FILTER — 4 correlated
        -- subplans, each 53,858 index probes on prod, instead of one (prod
        -- slow-query log, 2026-09-26: 10 calls/4.3h, p50 322ms; 597ms in a
        -- prod EXPLAIN with 4 subplans vs 341ms materialized — ~1.75x, same
        -- plan also let the optimizer swap the correlated index probe for a
        -- single flat scan of trickplay_params, output identical in a prod
        -- comparison run).
        WITH eligible AS MATERIALIZED (
            SELECT
                EXISTS (
                    SELECT 1 FROM trickplay_params tp
                    WHERE tp.media_item_id = mi.id
                      AND tp.file_id = mfi.file_id
                ) AS has_params,
                ${currentTrickplayFileMarker(sql, processingVersion)} AS terminal_marker,
                EXISTS (
                    SELECT 1 FROM media_item_stage_state s
                    WHERE s.media_item_id = mi.id
                      AND s.stage_id = 'trickplay-params-sync'
                      AND s.status = 'obsolete'
                ) AS uncertain_source,
                mi.processing_state
                    ->('trickplay-params:' || mfi.file_id::text)
                    ->>'status'
                    AS marker_status
            FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            WHERE mi.media_type = ANY(${effectiveTypes})
              AND mi.status = 'active'
        )
        SELECT
            COUNT(*) FILTER (WHERE has_params AND NOT uncertain_source)::int AS analyzed,
            COUNT(*) FILTER (
                WHERE uncertain_source OR (NOT has_params AND NOT terminal_marker)
            )::int AS remaining,
            COUNT(*) FILTER (
                WHERE NOT has_params
                  AND NOT uncertain_source
                  AND terminal_marker
                  AND marker_status = 'no-provider'
            )::int AS ineligible,
            COUNT(*) FILTER (
                WHERE NOT has_params
                  AND NOT uncertain_source
                  AND terminal_marker
                  AND marker_status = 'error'
            )::int AS failed
        FROM eligible
    `;
}

export function baselineGetMediaBrowserStatsSql(
    sql: postgres.Sql,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        WITH ext AS (
            SELECT
                media_id,
                bool_or(provider = 'tmdb') AS has_tmdb
            FROM external_ids
            GROUP BY media_id
        )
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE mi.media_type = 'movie' AND mi.has_files)::int AS movies,
            COUNT(*) FILTER (WHERE mi.media_type = 'tv' AND mi.has_files)::int AS series,
            COUNT(*) FILTER (WHERE mi.media_type = 'episode' AND mi.has_files)::int AS episodes,
            COUNT(*) FILTER (WHERE mi.media_type = 'season' AND mi.has_files)::int AS seasons,
            COUNT(*) FILTER (WHERE mi.media_type = 'artist' AND mi.has_files)::int AS artists,
            COUNT(*) FILTER (WHERE mi.media_type = 'album' AND mi.has_files)::int AS albums,
            COUNT(*) FILTER (WHERE mi.media_type = 'track' AND mi.has_files)::int AS tracks,
            -- Audiobooks carry has_files = true when the book is playable on the
            -- upstream AudiobookShelf server (ABS 'isMissing' maps to false), so the
            -- same availability filter as every other counter applies unchanged.
            COUNT(*) FILTER (WHERE mi.media_type = 'audiobook' AND mi.has_files)::int AS audiobooks,
            COUNT(*) FILTER (WHERE mi.has_files = true)::int AS with_files,
            COUNT(*) FILTER (WHERE mi.has_files = false)::int AS unavailable,
            COUNT(*) FILTER (WHERE NOT COALESCE(ext.has_tmdb, false))::int AS missing_tmdb,
            COUNT(*) FILTER (WHERE mi.created_at > NOW() - INTERVAL '7 days')::int AS added_this_week,
            COUNT(*) FILTER (WHERE mi.metadata_locked = true)::int AS locked,
            COUNT(*) FILTER (WHERE NOT mi.is_dismissed AND mi.media_type IN ('movie', 'tv') AND ext.media_id IS NULL)::int AS unidentified
        FROM media_items mi
        LEFT JOIN ext ON ext.media_id = mi.id
        WHERE mi.status = 'active'
    `;
}
