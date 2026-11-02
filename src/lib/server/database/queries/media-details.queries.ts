// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Details Query Module
 *
 * Handles media detail lookups by UUID or composite key.
 * Extracted from src/routes/api/media-details/+server.ts.
 *
 * @module queries/media-details
 */

import type postgres from 'postgres';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { AVAILABILITY_SELECT_FIELDS } from './availability.queries.js';
import type {
    BaseMediaRow,
    AvailabilityFields,
    MetadataContent,
    ExtendedRatings,
    MetadataArrays,
    TvMetadataFields,
} from './types/index.js';

// =========================================================================
// ROW TYPES
// =========================================================================

export type MediaDetailRow = BaseMediaRow &
    AvailabilityFields &
    MetadataContent &
    Omit<ExtendedRatings, 'mal_score'> &
    Pick<MetadataArrays, 'keywords' | 'networks' | 'actors' | 'directors'> &
    TvMetadataFields & {
        original_language?: string | null;
        tagline?: string | null;
        /** Genre names (strings) extracted from JSONB objects, not numeric IDs */
        genres: string[] | null;
        /**
         * Structured cast (name + character + person id) from
         * `provider_metadata.cast` — powers the detail API's
         * `actors[].character` and proxied `actors[].profileUrl`. Null when the
         * item predates cast ingest (fall back to the flat `actors` names).
         */
        cast_structured: Array<{
            name: string;
            character?: string;
            person_id?: string;
            profile_path?: string;
        }> | null;
        vote_count: number | null;
        /** A playable local trailer file (media_type='extra', extra_type='trailer') exists for this item */
        has_local_trailer: boolean;
        /** File-backed extras (trailers, behind-the-scenes, featurettes, …) belonging to this item */
        extras: MediaExtraRow[];
        /** `media_item_quality.resolution_tier` — '4K' | '1080p' | '720p' | 'SD' | null (best version) */
        resolution_tier: string | null;
        /** `media_item_quality.hdr_tier` — 'dolby_vision' | 'hdr' | 'sdr' | null (coarse, best version) */
        hdr_tier: string | null;
        /** `media_item_quality.hdr_type` — 'dolby_vision' | 'hdr10_plus' | 'hdr10' | 'hlg' | 'sdr' | null (fine, best version) */
        hdr_type: string | null;
        /** Best audio stream of the default version, or null (series / no probed files) */
        best_audio: {
            codec: string | null;
            channels: number | null;
            channel_layout: string | null;
            profile: string | null;
        } | null;
    };

/** A single file-backed extra row, as returned by the `extras` JSON aggregate. */
export interface MediaExtraRow {
    id: string;
    title: string;
    extra_type: string;
    runtime_seconds: number | null;
}

export interface CachedListItemRow {
    media_id: string;
    queried_external_id: string;
    title: string;
    media_type: 'movie' | 'tv';
    release_year: number | null;
    score: number | null;
    overview: string | null;
}

// =========================================================================
// SQL FRAGMENT CONSTANTS
// =========================================================================

/**
 * A numeric read off `provider_metadata`, guarded by a shape check.
 *
 * `provider_metadata.metadata` is free-form jsonb from several providers, and
 * only the INDEXED keys have any guarantee about their contents. A bare
 * `(metadata->>'x')::float` on a key that turns out to hold `''`, `'N/A'` or
 * `'8.1/10'` raises 22P02, and because these columns all live in one SELECT
 * list, that single bad row does not blank one rating — it fails the whole
 * media-detail query and the page renders with nothing.
 *
 * A guarded read yields NULL for the junk instead, which every consumer here
 * already handles: these fields are all optional downstream.
 *
 * `key` and `cast` are compile-time literals from this file, never caller
 * input — this string is interpolated into SQL, so it must stay that way.
 */
function numericMetadata(key: string, cast: 'float' | 'integer'): string {
    // Interpolated, not template-escaped: this is the literal text Postgres
    // sees, so the dot needs exactly one backslash.
    const shape = cast === 'integer' ? '^[0-9]+$' : '^[0-9]+(\\.[0-9]+)?$';
    return `CASE WHEN pm.metadata->>'${key}' ~ '${shape}' THEN (pm.metadata->>'${key}')::${cast} END`;
}

/**
 * Shared SELECT columns for media detail queries.
 * Used by both UUID and composite key paths.
 */
const MEDIA_DETAIL_COLUMNS = `
    mi.id::text as media_id,
    mi.title,
    (SELECT original_pm.metadata->>'original_language'
        FROM provider_metadata original_pm
        WHERE original_pm.media_id IN (mi.id, (SELECT parent.parent_id FROM media_items parent WHERE parent.id = mi.parent_id))
          AND NULLIF(original_pm.metadata->>'original_language', '') IS NOT NULL
        ORDER BY (original_pm.media_id = mi.id),
          CASE original_pm.provider WHEN 'aggregated' THEN 0 WHEN 'tmdb' THEN 1 ELSE 2 END
        LIMIT 1) AS original_language,
    NULLIF(BTRIM(pm.metadata->>'tagline'), '') as tagline,
    mi.media_type,
    mi.year::text as release_date,
    -- Provider text first, local scan text second, with '' collapsed to NULL on
    -- both sides — see getMediaDetailsById for why. This join picks ONE provider
    -- row (not the per-field merge), so an empty provider overview reaches here
    -- even when another provider carries real text.
    COALESCE(NULLIF(pm.metadata->>'overview', ''), NULLIF(mi.overview, ''))::text as overview,
    ${numericMetadata('imdb_rating', 'float')} as imdb_rating,
    ${numericMetadata('rt_rating', 'float')} as rt_rating,
    -- TMDB's score lands as 'vote_average', NOT as 'tmdb_rating' — nothing in
    -- this pipeline ever writes that key (0 of 1951 active movies with files on
    -- prod). Reading it here left 'tmdb_rating' permanently null, so
    -- transformToMediaDetail's pickDisplayRating call could never take its TMDB
    -- branch and every IMDb-less title fell through to the mdblist/rt fallback
    -- chain — or showed nothing. Alias kept: the 'tmdb' label is still correct
    -- for the value, only the source key was wrong.
    ${numericMetadata('vote_average', 'float')} as tmdb_rating,
    ${numericMetadata('popularity', 'float')} as popularity,
    ${numericMetadata('vote_count', 'integer')} as vote_count,
    COALESCE(
        NULLIF(${numericMetadata('runtime_minutes', 'integer')}, 0),
        NULLIF(ROUND(mi.runtime_seconds / 60.0)::integer, 0)
    ) as runtime_minutes,
    CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
        THEN NULLIF(ARRAY(SELECT elem->>'name' FROM jsonb_array_elements(pm.metadata->'genres') AS elem
                          WHERE jsonb_typeof(elem) = 'object' AND elem->>'name' IS NOT NULL), ARRAY[]::text[])
        ELSE NULL
    END as genres,
    CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'keywords') AS elem)
        ELSE NULL
    END as keywords,
    CASE WHEN pm.metadata->'networks' IS NOT NULL AND jsonb_typeof(pm.metadata->'networks') = 'array'
        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'networks') AS elem)
        ELSE NULL
    END as networks,
    CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
        ELSE NULL
    END as actors,
    CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
        THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
        ELSE NULL
    END as directors,
    CASE WHEN pm.metadata->'cast' IS NOT NULL AND jsonb_typeof(pm.metadata->'cast') = 'array'
        THEN pm.metadata->'cast'
        ELSE NULL
    END as cast_structured,
    (pm.metadata->>'certification')::text as certification,
    ${AVAILABILITY_SELECT_FIELDS},
    ${numericMetadata('rt_audience_score', 'float')} as rt_audience_score,
    ${numericMetadata('letterboxd_rating', 'float')} as letterboxd_rating,
    ${numericMetadata('letterboxd_votes', 'integer')} as letterboxd_votes,
    ${numericMetadata('metacritic_score', 'float')} as metacritic_score,
    ${numericMetadata('trakt_score', 'float')} as trakt_score,
    ${numericMetadata('mdblist_score', 'float')} as mdblist_score,
    (pm.metadata->>'first_air_date')::text as first_air_date,
    (pm.metadata->>'last_air_date')::text as last_air_date,
    (pm.metadata->>'status')::text as status,
    ${numericMetadata('season_count', 'integer')} as season_count,
    ${numericMetadata('number_of_episodes', 'integer')} as episode_count,
    EXISTS (
        SELECT 1
        FROM media_items tr
        JOIN media_file_items tmfi ON tmfi.media_item_id = tr.id
        JOIN media_files tmf ON tmf.id = tmfi.file_id
        WHERE tr.parent_id = mi.id
          AND tr.media_type = 'extra'
          AND tr.extra_type = 'trailer'
          AND tmf.is_missing = false
    ) AS has_local_trailer,
    COALESCE(
        (
            SELECT json_agg(
                json_build_object(
                    'id', ex.id,
                    'title', ex.title,
                    'extra_type', ex.extra_type,
                    'runtime_seconds', ex.runtime_seconds
                ) ORDER BY ex.extra_type, ex.title
            )
            FROM media_items ex
            WHERE ex.parent_id = mi.id
              AND ex.media_type = 'extra'
              AND EXISTS (
                  SELECT 1
                  FROM media_file_items exmfi
                  JOIN media_files exmf ON exmf.id = exmfi.file_id
                  WHERE exmfi.media_item_id = ex.id
                    AND exmf.is_missing = false
              )
        ),
        '[]'::json
    ) AS extras,
    -- Best-available version quality (drives 4K / HDR / Dolby Vision badges).
    -- Sourced from the media_item_quality projection (single source of truth
    -- for best-version ranking; correct for movies AND series via the episode
    -- rollup). PK subqueries — one indexed row lookup each on a single item.
    (SELECT q.resolution_tier FROM media_item_quality q WHERE q.media_item_id = mi.id) AS resolution_tier,
    (SELECT q.hdr_tier FROM media_item_quality q WHERE q.media_item_id = mi.id) AS hdr_tier,
    (SELECT q.hdr_type FROM media_item_quality q WHERE q.media_item_id = mi.id) AS hdr_type,
    -- Best audio stream across ALL of the item's versions (audio isn't
    -- projected). Independent "best available" — consistent with resolution and
    -- HDR, which the projection also computes independently across versions
    -- (best_res / best_hdr are separate), NOT tied to one physical file. Ranked
    -- by channels then bitrate. Uses the covering index
    -- media_file_items(media_item_id) INCLUDE (file_id) → media_streams(file_id).
    -- NULL for series rows (no directly-linked files).
    (
        SELECT json_build_object(
            'codec', ms.codec,
            'channels', ms.channels,
            'channel_layout', ms.channel_layout,
            'profile', ms.profile
        )
        FROM media_streams ms
        JOIN media_file_items mfi ON mfi.file_id = ms.file_id
        WHERE mfi.media_item_id = mi.id
          AND ms.stream_type = 'audio'
        ORDER BY ms.channels DESC NULLS LAST, ms.bitrate DESC NULLS LAST
        LIMIT 1
    ) AS best_audio
`;

// =========================================================================
// QUERY FUNCTIONS
// =========================================================================

/**
 * Fetch media detail by internal UUID (direct PK lookup — no external_ids JOIN).
 */
export async function getMediaDetailByUuid(
    sql: postgres.Sql,
    uuid: string,
): Promise<MediaDetailRow | null> {
    const results = await sql<MediaDetailRow[]>`
        SELECT ${sql.unsafe(MEDIA_DETAIL_COLUMNS)}
        FROM media_items mi
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.id = ${uuid}
            AND mi.status = 'active'
        LIMIT 1
    `;
    return results[0] ?? null;
}

export interface CompositeKeyParams {
    provider: string;
    externalId: string;
    mediaType: string;
}

/**
 * Fetch media detail by composite key (provider + external_id + media_type JOIN).
 */
export async function getMediaDetailByCompositeKey(
    sql: postgres.Sql,
    params: CompositeKeyParams,
): Promise<MediaDetailRow | null> {
    const results = await sql<MediaDetailRow[]>`
        SELECT
            ${sql.unsafe(MEDIA_DETAIL_COLUMNS)}
        FROM media_items mi
        JOIN external_ids ei ON ei.media_id = mi.id
            AND ei.provider = ${params.provider}
            AND ei.external_id = ${params.externalId}
            AND ei.media_type = ${params.mediaType}
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
        LIMIT 1
    `;
    return results[0] ?? null;
}

/**
 * Fetch a cached list item by composite key (fallback when media_items has no match).
 */
export async function getCachedListItemByCompositeKey(
    sql: postgres.Sql,
    params: CompositeKeyParams,
): Promise<CachedListItemRow | null> {
    const results = await sql<CachedListItemRow[]>`
        SELECT
            mi.id::text as media_id,
            ei.external_id as queried_external_id,
            mi.title,
            mi.media_type,
            mi.year as release_year,
            (pm.metadata->>'mdblist_score')::smallint as score,
            pm.metadata->>'overview' as overview
        FROM cached_list_items cli
        JOIN media_items mi ON mi.id = cli.media_id
        JOIN external_ids ei ON ei.media_id = mi.id
            AND ei.provider = ${params.provider}
            AND ei.external_id = ${params.externalId}
            AND ei.media_type = ${params.mediaType}
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        LIMIT 1
    `;
    return results[0] ?? null;
}
