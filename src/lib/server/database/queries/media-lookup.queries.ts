// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Lookup Queries
 *
 * Centralized queries for media ID resolution and lookups.
 * Consolidates duplicate UUID resolution patterns from:
 * - /api/media/[id]/+server.ts
 * - /api/for-you/watching/+server.ts
 *
 * @module queries/media-lookup
 */

import type postgres from 'postgres';
import {
    buildMetadataLateralJoinFragment,
    buildMergedMetadataLateralJoinFragment,
} from './builders/provider-metadata.builder.js';
import { Logger } from '../../utils/logger.js';
import {
    getPrimaryExternalIdProvider,
    type ExternalIdProvider,
} from '../../utils/provider-config.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import type { EmbeddingSource } from '../../utils/embedding-source.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import {
    runWithTrigramThreshold,
    clampTrigramThreshold,
} from './builders/trigram-threshold.builder.js';
import { config } from '../../config.js';
import {
    KEYFRAME_END_PADDING_SECONDS,
    reconcileRuntimeSeconds,
} from '../../utils/media-duration.js';

const logger = Logger.for('MediaLookupQueries');

// =============================================================================
// Types
// =============================================================================

export interface MediaItemRow {
    id: string;
    title: string;
    original_title: string | null;
    year: number | null;
    media_type: 'movie' | 'tv' | 'episode' | 'season';
    is_local_only: boolean;
}

export interface MediaDetailsRow {
    original_language?: string | null;
    tagline?: string | null;
    media_id: string;
    title: string;
    original_title: string | null;
    english_title: string | null;
    year: number | null;
    media_type: 'movie' | 'tv' | 'episode' | 'season';
    is_local_only: boolean;
    poster_path: string | null;
    backdrop_path: string | null;
    overview: string | null;
    runtime_minutes: number | null;
    imdb_rating: number | null;
    vote_average: number | null;
    popularity: number | null;
    rt_rating: number | null;
    rt_audience_score: number | null;
    mdblist_score: number | null;
    letterboxd_rating: number | null;
    letterboxd_votes: number | null;
    metacritic_score: number | null;
    trakt_score: number | null;
    certification: string | null;
    trailer_url: string | null;
    genres: string[] | null;
    actors: unknown;
    directors: unknown;
    is_available: boolean;
    can_request: boolean;
    parent_id: string | null;
    /** `media_items.premiere_date` — release date; null for most library-scanned rows. */
    premiere_date: string | null;
    season_number: number | null;
    episode_number: number | null;
    audio_languages: string[];
    subtitle_languages: string[];
}

export interface ExternalIdRecord {
    provider: string;
    external_id: string;
}

// =============================================================================
// UUID / Internal ID Lookups
// =============================================================================

/**
 * Check if a media item exists by internal UUID.
 */
export async function mediaItemExistsByUuid(
    sql: postgres.Sql,
    uuid: string,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE id = ${uuid}::uuid AND status = 'active'
        LIMIT 1
    `;
    return rows[0]?.id || null;
}

// =============================================================================
// Media Details
// =============================================================================

/**
 * Get full media details by internal ID.
 * Includes metadata from provider_metadata and availability from library_availability.
 */
export async function getMediaDetailsById(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaDetailsRow | null> {
    const rows = await sql<MediaDetailsRow[]>`
        SELECT
            mi.id AS media_id,
            mi.title,
            mi.original_title,
            (SELECT original_pm.metadata->>'original_language'
        FROM provider_metadata original_pm
        WHERE original_pm.media_id IN (mi.id, (SELECT parent.parent_id FROM media_items parent WHERE parent.id = mi.parent_id))
          AND NULLIF(original_pm.metadata->>'original_language', '') IS NOT NULL
        ORDER BY (original_pm.media_id = mi.id),
          CASE original_pm.provider WHEN 'aggregated' THEN 0 WHEN 'tmdb' THEN 1 ELSE 2 END
        LIMIT 1) AS original_language,
            NULLIF(BTRIM(pm.metadata->>'tagline'), '') AS tagline,
            mi.english_title,
            mi.year,
            mi.media_type,
            mi.is_local_only,
            pm.metadata->>'poster_path' AS poster_path,
            pm.metadata->>'backdrop_path' AS backdrop_path,
            -- Provider text first, local scan text (NFO / embedded tags) second.
            -- Both sides collapse '' to NULL: TMDB stores a present-but-empty
            -- overview for titles it has no synopsis for, and an empty string is
            -- not a description — it just shadows the fallback and reaches the
            -- client as an empty overview string.
            COALESCE(NULLIF(pm.metadata->>'overview', ''), NULLIF(mi.overview, '')) AS overview,
            -- Same shape for runtime, where the provider's "missing" value is 0
            -- rather than absent. mi.runtime_seconds comes from ffprobe, so it is
            -- the more trustworthy of the two whenever the provider has nothing.
            COALESCE(
                NULLIF(CAST(pm.metadata->>'runtime_minutes' AS INTEGER), 0),
                NULLIF(ROUND(mi.runtime_seconds / 60.0)::INTEGER, 0)
            ) AS runtime_minutes,
            CAST(pm.metadata->>'imdb_rating' AS FLOAT8) AS imdb_rating,
            CAST(pm.metadata->>'vote_average' AS FLOAT8) AS vote_average,
            CAST(pm.metadata->>'popularity' AS FLOAT8) AS popularity,
            CAST(pm.metadata->>'rt_rating' AS INTEGER) AS rt_rating,
            CAST(pm.metadata->>'rt_audience_score' AS INTEGER) AS rt_audience_score,
            CAST(pm.metadata->>'mdblist_score' AS SMALLINT) AS mdblist_score,
            CAST(pm.metadata->>'letterboxd_rating' AS FLOAT8) AS letterboxd_rating,
            CAST(pm.metadata->>'letterboxd_votes' AS INTEGER) AS letterboxd_votes,
            CAST(pm.metadata->>'metacritic_score' AS INTEGER) AS metacritic_score,
            CAST(pm.metadata->>'trakt_score' AS FLOAT8) AS trakt_score,
            pm.metadata->>'certification' AS certification,
            pm.metadata->>'trailer_url' AS trailer_url,
            CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                THEN NULLIF(ARRAY(SELECT elem->>'name' FROM jsonb_array_elements(pm.metadata->'genres') AS elem WHERE jsonb_typeof(elem) = 'object' AND elem->>'name' IS NOT NULL), ARRAY[]::text[])
                ELSE NULL
            END AS genres,
            pm.metadata->'actors' AS actors,
            pm.metadata->'directors' AS directors,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            mi.parent_id,
            mi.premiere_date,
            mi.season_number,
            mi.episode_number,
ARRAY(
    SELECT DISTINCT ms.language
    FROM media_file_items mfi
    JOIN media_streams ms ON ms.file_id = mfi.file_id
    WHERE mfi.media_item_id = mi.id
      AND mfi.is_default = true
      AND ms.stream_type = 'audio'
      AND ms.language IS NOT NULL
      AND ms.language NOT IN ('', 'und')
    ORDER BY ms.language
) AS audio_languages,
ARRAY(
    SELECT DISTINCT lang FROM (
        SELECT ms.language AS lang
        FROM media_file_items mfi
        JOIN media_streams ms ON ms.file_id = mfi.file_id
        WHERE mfi.media_item_id = mi.id
          AND mfi.is_default = true
          AND ms.stream_type = 'subtitle'
          AND ms.language IS NOT NULL
          AND ms.language NOT IN ('', 'und')
        UNION
        SELECT esf.language AS lang
        FROM media_file_items mfi
        JOIN external_subtitle_files esf ON esf.file_id = mfi.file_id
        WHERE mfi.media_item_id = mi.id
          AND mfi.is_default = true
          AND esf.language IS NOT NULL
          AND esf.language NOT IN ('', 'und')
    ) sub
    ORDER BY lang
) AS subtitle_languages
        FROM media_items mi
        -- Merged (per-field) provider metadata, not a single LIMIT 1 row: a stale
        -- or partial 'aggregated' row must not blank overview/poster/genres in the
        -- detail modal when the richer values still sit in the 'tmdb' row. Safe
        -- here because this is a single-item by-id lookup. See
        -- buildMergedMetadataLateralJoin for the why.
        ${buildMergedMetadataLateralJoinFragment(sql)}
        WHERE mi.id = ${mediaId}
            AND mi.status = 'active'
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Get basic media item by ID (without metadata).
 */
export async function getMediaItemById(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaItemRow | null> {
    const rows = await sql<MediaItemRow[]>`
        SELECT id, title, original_title, year, media_type, is_local_only
        FROM media_items
        WHERE id = ${mediaId} AND status = 'active'
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Narrow read-only row shape backing the SDK's `MediaItemSummary` DTO.
 * Lives here (not in the schemas module) because the column list is hand-picked
 * to expose only fields the SDK contract promises plugin authors — adding
 * columns to this row must be matched by additions to `MediaItemSummary`
 * in `packages/@sapd/lumastra-plugin-sdk/src/types.ts`.
 */
export interface MediaItemSummaryRow {
    id: string;
    title: string;
    year: number | null;
    media_type: string;
    overview: string | null;
    library_added_at: Date | null;
    created_at: Date;
}

/**
 * Fetch the narrow plugin-SDK summary for one media item, or null.
 * `library_added_at` falls back to `created_at` so plugins always see a
 * monotonic "added to library" timestamp.
 */
export async function getMediaItemSummaryById(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaItemSummaryRow | null> {
    const rows = await sql<MediaItemSummaryRow[]>`
        SELECT id, title, year, media_type, overview, library_added_at, created_at
        FROM media_items
        WHERE id = ${mediaId} AND status = 'active'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Deep-link navigation context for an episode/season media item.
 *
 * The `?modal=` deep link for an episode/season must open the PARENT SERIES
 * modal with the season/episode preselected (see `modal-url-sync.ts`) — opening
 * `?modal=<episode-uuid>` directly would surface a bare episode at the wrong
 * place. This resolves the owning series UUID plus the season/episode numbers
 * needed to build `?modal=<series>&season=N&episode=N`.
 *
 * Returns `null` when the item does not exist.
 */
export interface MediaNavContextRow {
    /** The item's own media_type (lowercase). */
    media_type: string;
    /** Resolved series UUID (grandparent for an episode, parent for a season, self otherwise). */
    series_id: string | null;
    season_number: number | null;
    episode_number: number | null;
}

export async function getMediaNavContext(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaNavContextRow | null> {
    const rows = await sql<MediaNavContextRow[]>`
        SELECT
            mi.media_type,
            CASE
                WHEN mi.media_type = 'episode' THEN COALESCE(grandparent.id, parent.id)
                WHEN mi.media_type = 'season' THEN parent.id
                ELSE mi.id
            END AS series_id,
            mi.season_number,
            mi.episode_number
        FROM media_items mi
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        LEFT JOIN media_items grandparent ON grandparent.id = parent.parent_id
        WHERE mi.id = ${mediaId} AND mi.status = 'active'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Fuzzy title search returning the SDK summary shape. Uses a trigram
 * similarity query and expands the projection to match
 * `MediaItemSummaryRow`, and accepts an optional `mediaType` filter so SDK
 * callers can scope to one type.
 */
export async function searchMediaItemSummaries(
    sql: postgres.Sql,
    query: string,
    opts?: { limit?: number; mediaType?: string },
): Promise<MediaItemSummaryRow[]> {
    if (!query.trim()) return [];
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 20));
    const mediaType = opts?.mediaType;
    // Trigram threshold from config (single source of truth), same value the
    // `%`-gated search paths apply via runWithTrigramThreshold. Bound directly
    // as a parameter here (not via SET LOCAL) because these are similarity()
    // function-call gates, not the `%` operator — the GUC has no effect on them.
    const threshold = clampTrigramThreshold(config.SEARCH_TRIGRAM_THRESHOLD);
    // Inline branch keeps the WHERE shape statically analysable by postgres.js;
    // avoid sql`` fragment concat to keep the parameter list flat.
    if (mediaType) {
        return sql<MediaItemSummaryRow[]>`
            SELECT id, title, year, media_type, overview, library_added_at, created_at
            FROM media_items
            WHERE (similarity(immutable_unaccent(title), immutable_unaccent(${query})) > ${threshold}
            OR similarity(german_digraph_fold(title), german_digraph_fold(${query})) > ${threshold})
              AND status = 'active'
              AND media_type = ${mediaType}
            ORDER BY GREATEST(similarity(immutable_unaccent(title), immutable_unaccent(${query})), similarity(german_digraph_fold(title), german_digraph_fold(${query}))) DESC
            LIMIT ${limit}
        `;
    }
    return sql<MediaItemSummaryRow[]>`
        SELECT id, title, year, media_type, overview, library_added_at, created_at
        FROM media_items
        WHERE (similarity(immutable_unaccent(title), immutable_unaccent(${query})) > ${threshold}
            OR similarity(german_digraph_fold(title), german_digraph_fold(${query})) > ${threshold})
          AND status = 'active'
        ORDER BY GREATEST(similarity(immutable_unaccent(title), immutable_unaccent(${query})), similarity(german_digraph_fold(title), german_digraph_fold(${query}))) DESC
        LIMIT ${limit}
    `;
}

// =============================================================================
// External IDs
// =============================================================================

/**
 * Get all external IDs for a media item.
 */
export async function getExternalIdsByMediaId(
    sql: postgres.Sql,
    mediaId: string,
): Promise<ExternalIdRecord[]> {
    return await sql<ExternalIdRecord[]>`
        SELECT provider, external_id
        FROM external_ids
        WHERE media_id = ${mediaId}
    `;
}

/**
 * Get all external IDs for multiple media items in a single query.
 *
 * Returns a Map of mediaId → ExternalIdRecord[]. Media IDs with no external
 * ID rows are absent from the map. Callers that need an empty-array default
 * should use `map.get(id) ?? []`.
 *
 * Replaces per-item `getExternalIdsByMediaId` loops; use this for any
 * collection to avoid N+1 queries.
 */
export async function getExternalIdsByMediaIds(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<Map<string, ExternalIdRecord[]>> {
    const result = new Map<string, ExternalIdRecord[]>();
    if (mediaIds.length === 0) return result;

    const rows = await sql<(ExternalIdRecord & { media_id: string })[]>`
        SELECT media_id::text, provider, external_id
        FROM external_ids
        WHERE media_id = ANY(${mediaIds}::uuid[])
    `;
    for (const row of rows) {
        const existing = result.get(row.media_id);
        if (existing) {
            existing.push({ provider: row.provider, external_id: row.external_id });
        } else {
            result.set(row.media_id, [{ provider: row.provider, external_id: row.external_id }]);
        }
    }
    return result;
}

/**
 * Build the API `ids` object from records.
 *
 * Jellyfin item ids are left out: they belong to the optional Jellyfin sync
 * (which reads `external_ids` itself) and are never part of an API response.
 */
export function buildExternalIdsObject(records: ExternalIdRecord[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const record of records) {
        if (record.provider === 'jellyfin') continue;
        result[record.provider] = record.external_id;
    }
    return result;
}

// =============================================================================
// External ID Resolution
// =============================================================================

/**
 * Resolve an external provider ID to an internal UUID.
 * Returns null if not found.
 *
 * @param sql - Postgres SQL instance
 * @param extId - External ID string (e.g., "12345" for TMDB, "tt0137523" for IMDB)
 * @param mediaType - Media type for composite key lookup
 * @param provider - Which provider the ID belongs to (uses primary provider if omitted)
 */
export async function resolveExternalIdToUuid(
    sql: postgres.Sql,
    extId: string,
    /**
     * Matched verbatim against `external_ids.media_type`. Widened beyond
     * `'movie' | 'tv'` because that column also holds `'episode'` and
     * `'season'` rows — same reasoning as resolveMediaIdByProvider.
     */
    mediaType: string,
    provider?: ExternalIdProvider,
): Promise<string | null> {
    const resolvedProvider = provider ?? getPrimaryExternalIdProvider();
    const rows = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = ${resolvedProvider}
          AND external_id = ${extId}
          AND media_type = ${mediaType}
        LIMIT 1
    `;
    return rows[0]?.media_id ?? null;
}

/** @deprecated Use resolveExternalIdToUuid instead */
export async function resolveTmdbToUuid(
    sql: postgres.Sql,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<string | null> {
    return resolveExternalIdToUuid(sql, String(tmdbId), mediaType);
}

// resolveUuidToPrimaryExt / resolveUuidToTmdb were removed here: both were
// unreferenced outside the queries barrel. They selected media_type from
// external_ids with no type filter while declaring the result 'movie' | 'tv',
// so any episode UUID would have handed callers a mistyped value. Reach for
// mediaIdResolver (src/lib/server/services/media-id-resolver.ts) instead — it
// carries the parser's real token union.

/**
 * Get existing TMDB IDs with their media types to avoid TMDB ID collisions.
 * Returns composite keys "tmdb_id:media_type" to properly distinguish movies from TV shows.
 *
 * @param sql - Postgres SQL instance
 * @param tmdbIds - Array of TMDB IDs to check
 * @param sourceType - Optional filter by embedding source (jellyfin/jellyseerr)
 * @returns Set of composite keys in format "tmdb_id:media_type"
 */
export async function getTmdbCompositeKeys(
    sql: postgres.Sql,
    tmdbIds: number[],
    sourceType?: EmbeddingSource,
): Promise<Set<string>> {
    if (tmdbIds.length === 0) return new Set();

    type TmdbKeyRow = { tmdb_id: string; media_type: string };
    let results: TmdbKeyRow[];

    if (sourceType === EMBEDDING_SOURCE.LIBRARY) {
        results = await sql<TmdbKeyRow[]>`
            SELECT e.external_id as tmdb_id, e.media_type
            FROM external_ids e
            JOIN media_embeddings me ON me.media_id = e.media_id
            WHERE e.provider = ${getPrimaryExternalIdProvider()}
              AND e.external_id = ANY(${tmdbIds.map(String)}::text[])
              AND me.source = ${EMBEDDING_SOURCE.LIBRARY}
        `;
    } else if (sourceType === EMBEDDING_SOURCE.DISCOVERY) {
        results = await sql<TmdbKeyRow[]>`
            SELECT e.external_id as tmdb_id, e.media_type
            FROM external_ids e
            JOIN media_embeddings me ON me.media_id = e.media_id
            WHERE e.provider = ${getPrimaryExternalIdProvider()}
              AND e.external_id = ANY(${tmdbIds.map(String)}::text[])
              AND me.source = ${EMBEDDING_SOURCE.DISCOVERY}
        `;
    } else {
        results = await sql<TmdbKeyRow[]>`
            SELECT DISTINCT e.external_id as tmdb_id, e.media_type
            FROM external_ids e
            JOIN media_embeddings me ON me.media_id = e.media_id
            WHERE e.provider = ${getPrimaryExternalIdProvider()}
              AND e.external_id = ANY(${tmdbIds.map(String)}::text[])
              AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
        `;
    }

    // Return composite keys to handle TMDB ID collisions between movies and TV shows
    return new Set(results.map((row) => `${row.tmdb_id}:${row.media_type}`));
}

// =============================================================================
// Series Search
// =============================================================================

export interface SeriesSearchResult {
    /** Series internal UUID (media_items.id) — the primary identifier. */
    internal_id: string;
    primary_ext_id: string;
    title: string;
    overview: string | null;
    genres: string[] | null;
    vote_count: number | null;
    tmdb_rating: number | null;
    release_date: string | null;
    similarity_score: number;
}

/**
 * Search for a TV series by name using trigram similarity (pg_trgm).
 * Handles leetspeak like "Plur1bus" matching "Pluribus".
 *
 * ACCESS: `access` is REQUIRED. There is no permissive default — a caller that
 * genuinely wants an unfiltered search must say so with `unrestrictedAccess()`
 * so the decision is greppable. Both axes bind inside the inner SELECT, where
 * `media_items` is aliased `mi`.
 *
 * @param sql - Postgres SQL instance
 * @param seriesName - The series name to search for
 * @param access - Media access boundary; both axes required
 * @returns Series data if found, null otherwise
 */
export async function findSeriesByName(
    sql: postgres.Sql,
    seriesName: string,
    access: MediaAccessBoundary,
): Promise<SeriesSearchResult | null> {
    // Short-circuit before opening the trigram transaction. The builders would
    // emit `AND false` and return nothing anyway, but a deny-all caller should
    // not pay for a round trip (nor for the SET LOCAL that wraps it).
    if (deniesEverything(access)) return null;

    try {
        // Use trigram similarity for fuzzy matching
        // This handles cases like "Plur1bus" → "Pluribus"
        // `mi.has_files` is the availability gate (no Jellyfin join); LEFT JOIN on
        // the primary provider replaces a scalar subquery.
        const results = await runWithTrigramThreshold(sql, true, (db) => {
            // Both filters are built against `db`, NOT `sql`: runWithTrigramThreshold
            // hands back a transaction-scoped handle so the `%` operator sees the
            // session GUC it sets. This used to be a hand-inlined copy of
            // buildLibraryAccessFilter's predicate (kept because the builder takes
            // `sql`) — but `db` IS a postgres.Sql, so the copy was never necessary
            // and only created a third place for the predicate to drift.
            const libraryFilter = buildLibraryAccessFilter(db, access.library);
            // Default alias 'mi' is correct here: the inner subquery below aliases
            // media_items as `mi`, matching what buildLibraryAccessFilter hardcodes.
            const ageFilter = buildAgeRatingFilter(db, access.age);

            return db<SeriesSearchResult[]>`
            SELECT * FROM (
              SELECT DISTINCT ON (mi.id)
                mi.id::text as internal_id,
                COALESCE(ei_primary.external_id, '') as primary_ext_id,
                mi.title,
                (pm.metadata->>'overview')::text as overview,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                  THEN ARRAY(SELECT elem->>'id' FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                  ELSE NULL
                END as genres,
                (pm.metadata->>'vote_count')::integer as vote_count,
                (pm.metadata->>'popularity')::float as tmdb_rating,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                  THEN make_date(mi.year, 1, 1)::text
                  ELSE NULL
                END as release_date,
                GREATEST(
                  similarity(immutable_unaccent(COALESCE(mi.title, '')), immutable_unaccent(${seriesName})),
                  similarity(immutable_unaccent(COALESCE(mi.original_title, '')), immutable_unaccent(${seriesName})),
                  similarity(german_digraph_fold(COALESCE(mi.title, '')), german_digraph_fold(${seriesName})),
                  similarity(german_digraph_fold(COALESCE(mi.original_title, '')), german_digraph_fold(${seriesName}))
                ) as similarity_score
              FROM media_items mi
              LEFT JOIN external_ids ei_primary ON ei_primary.media_id = mi.id AND ei_primary.provider = ${getPrimaryExternalIdProvider()}
              ${buildMetadataLateralJoinFragment(db)}
              WHERE mi.media_type = 'tv'
                AND mi.status = 'active'
                AND mi.has_files
                -- UUID-first: a local series is identified by its UUID, not by
                -- whether it happens to be Jellyfin-synced. has_files is the
                -- availability gate (replaces the old INNER JOIN on jellyfin).
                -- Trigram percent operator; threshold is config.SEARCH_TRIGRAM_THRESHOLD
                -- via runWithTrigramThreshold (not the bare pg_trgm session default) so
                -- the expression GIN trigram indexes are usable (incl. the
                -- TV-scoped partial indexes from 16.80.0). Expressions match the
                -- index definitions verbatim (no COALESCE/LOWER wrapping). The
                -- percent operator subsumes the old similarity() >= threshold AND
                -- the exact-match branches (identical strings score 1.0); pg_trgm
                -- is case-insensitive so the LOWER() exact branches are redundant.
                AND (
                  immutable_unaccent(mi.title) % immutable_unaccent(${seriesName})
                  OR immutable_unaccent(mi.original_title) % immutable_unaccent(${seriesName})
                  OR german_digraph_fold(mi.title) % german_digraph_fold(${seriesName})
                  OR german_digraph_fold(mi.original_title) % german_digraph_fold(${seriesName})
                )
                ${libraryFilter}
                ${ageFilter}
              ORDER BY mi.id, similarity_score DESC
            ) deduped
            ORDER BY similarity_score DESC
            LIMIT 1
        `;
        });

        if (results.length > 0) {
            // Require a minimum similarity of 0.5 to avoid false matches
            // (e.g., "Star Harbor: Starfleet Academy" should not match "Raumschiff Enterprise" at 0.41)
            const MIN_SIMILARITY = 0.5;
            if (results[0].similarity_score < MIN_SIMILARITY) {
                logger.debug('Series match rejected due to low similarity', {
                    searchName: seriesName,
                    foundTitle: results[0].title,
                    similarity: results[0].similarity_score,
                    threshold: MIN_SIMILARITY,
                });
                return null;
            }

            logger.debug('Found series in database', {
                searchName: seriesName,
                foundTitle: results[0].title,
                similarity: results[0].similarity_score,
            });
            return results[0];
        }

        logger.debug('Series not found in database', {
            searchName: seriesName,
        });
        return null;
    } catch (error) {
        logger.error('Failed to search series by name', error as Error, {
            seriesName,
        });
        return null;
    }
}

// =============================================================================
// Episode Series Context
// =============================================================================

/**
 * Get the runtime_seconds for a media item. Returns null if not set.
 * Used by the HLS Lumastra session builder to populate totalDurationSeconds
 * without inlining SQL in the route handler.
 */
export async function getMediaItemRuntime(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<number | null> {
    const rows = await sql<[{ runtime_seconds: number | null }]>`
        SELECT runtime_seconds FROM media_items
        WHERE id = ${mediaItemId}
        LIMIT 1
    `;
    return rows[0]?.runtime_seconds ?? null;
}

/**
 * Get the probed duration_seconds for a specific physical file. Returns null
 * if not set (not yet probed) or the file doesn't exist.
 *
 * A media item's own `runtime_seconds` (see `getMediaItemRuntime`) is
 * metadata for the ITEM as a whole and can diverge from an individual file's
 * real duration — most notably for a multi-file combined episode, where each
 * file is one physical segment shorter than the combined item's runtime.
 * Callers that already know which file they're transcoding (`fileId`
 * present) should prefer this over the item runtime.
 */
export async function getMediaFileDuration(
    sql: postgres.Sql,
    fileId: string,
): Promise<number | null> {
    const rows = await sql<
        [{ duration_seconds: number | null; last_keyframe: number | null; keyframe_count: number }]
    >`
        SELECT duration_seconds,
               CASE WHEN jsonb_typeof(keyframes) = 'array'
                     AND jsonb_typeof(keyframes->-1) = 'number'
                    THEN (keyframes->>-1)::float8 END AS last_keyframe,
               CASE WHEN jsonb_typeof(keyframes) = 'array'
                    THEN jsonb_array_length(keyframes) ELSE 0 END AS keyframe_count
        FROM media_files
        WHERE id = ${fileId}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    // Rows probed before the probe reconciled the container duration can
    // still carry a bogus one (a subtitle's "infinite" end time); the keyframe
    // scan says where the video really ends — see reconcileRuntimeSeconds.
    // The real end sits up to one GOP past the last keyframe: pad by twice
    // the average GOP (never under 10 s) so a long-GOP file isn't cut short.
    // Fewer than two keyframes (intra-refresh streams) says nothing.
    const lastKeyframe = row.last_keyframe;
    const videoEnd =
        lastKeyframe !== null && lastKeyframe > 0 && row.keyframe_count >= 2
            ? lastKeyframe +
              Math.max(KEYFRAME_END_PADDING_SECONDS, (2 * lastKeyframe) / (row.keyframe_count - 1))
            : null;
    return reconcileRuntimeSeconds(row.duration_seconds, videoEnd);
}

/**
 * The file's overall bitrate as the scanner persisted it (`format.bit_rate`,
 * falling back to the video stream's — see `capComparableBitrate`). Null when
 * the file was never probed or ffprobe reported none.
 */
export async function getMediaFileTotalBitrate(
    sql: postgres.Sql,
    fileId: string,
): Promise<number | null> {
    const rows = await sql<[{ total_bitrate: number | string | null }]>`
        SELECT total_bitrate FROM media_files
        WHERE id = ${fileId}
        LIMIT 1
    `;
    const value = rows[0]?.total_bitrate;
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}
