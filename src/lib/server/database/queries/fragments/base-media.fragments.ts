// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Base Media Query Fragments
 *
 * SQL fragments for building media queries against the UUID-based media catalog.
 * These utilities help build consistent queries across the application.
 *
 * Table Reference:
 * - media_items: Core catalog with internal UUIDs (id, title, original_title, year, media_type, is_local_only)
 * - external_ids: Maps internal IDs to external provider IDs (media_id, provider, external_id, media_type)
 * - provider_metadata: Raw metadata from each provider (media_id, provider, metadata JSONB)
 * - media_embeddings: Vector embeddings per source (media_id, source, embedding)
 * - library_availability: Track availability across libraries (media_id, library, library_item_id, available)
 *
 * @module fragments/base-media
 */

import { getPrimaryExternalIdProvider } from '../../../utils/provider-config.js';
import { AVAILABILITY_SELECT_FIELDS, AVAILABILITY_FILTER } from '../availability.queries.js';
import { EMBEDDING_SOURCE } from '../../../utils/embedding-source.js';

/**
 * SQL fragments for building media queries.
 * Use these to construct consistent queries across the application.
 *
 * Note: These are raw SQL strings intended to be used with sql.unsafe() or
 * string interpolation in SQL templates. Always use parameterized queries
 * for user-provided values.
 */
export function buildEmbeddingTextFields(
    libraryAlias: string = 'lib_emb',
    discoveryAlias: string = 'disc_emb',
): string {
    return `
        ${libraryAlias}.embedding::text AS library_embedding,
        ${discoveryAlias}.embedding::text AS discovery_embedding
    `;
}

export const MediaQueryFragments: {
    baseMediaSelect: string;
    metadataFields: string;
    extendedMetadataFields: string;
    embeddings: string;
    availabilityFields: string;
    embeddingJoins: string;
    availabilityJoin: string;
    imdbJoin: string;
    jellyfinExtJoin: string;
    jellyseerrExtJoin: string;
    activeFilter: string;
    hasFilesFilter: string;
    libraryMovieFilter: string;
    tvFilter: string;
    orderByUpdated: string;
    orderByPopularity: string;
    tmdbProviderFilter: string;
    imdbProviderFilter: string;
    jellyfinProviderFilter: string;
    jellyseerrProviderFilter: string;
    primaryExtFilter: string;
    /** @deprecated Use primaryExtFilter */
    primaryTmdbExtFilter: string;
    libraryEmbeddingSourceFilter: string;
    discoveryEmbeddingSourceFilter: string;
    bothEmbeddingSourcesFilter: string;
    libraryEmbeddingFilter: string;
    discoveryEmbeddingFilter: string;
    isAvailableFilter: string;
    isNotAvailableFilter: string;
    activeLibraryMovieFilter: string;
    activeTvFilter: string;
    activeAndAvailableFilter: string;
    cteDislikedMoviesSimple: string;
    cteLikedMoviesSimple: string;
    cteRecentWatches: string;
    excludeDislikedPattern: string;
    excludeWatchedPattern: string;
    scalarPrimaryExtId: string;
    /** @deprecated Use scalarPrimaryExtId — returns text, no integer cast */
    scalarTmdbId: string;
    /** @deprecated Use scalarPrimaryExtId */
    scalarTmdbIdString: string;
    scalarImdbId: string;
    scalarJellyseerrId: string;
    scalarTvdbId: string;
    primaryExtWithMediaTypeJoin: string;
    /** @deprecated Use primaryExtWithMediaTypeJoin */
    tmdbExtWithMediaTypeJoin: string;
    primaryExtIsPrimaryWithMediaTypeJoin: string;
    /** @deprecated Use primaryExtIsPrimaryWithMediaTypeJoin */
    primaryTmdbExtWithMediaTypeJoin: string;
    libraryEmbeddingJoin: string;
    discoveryEmbeddingJoin: string;
    extractKeywordsArray: string;
    extractGenresArray: string;
    extractActorsArray: string;
    extractDirectorsArray: string;
} = {
    // =========================================================================
    // SELECT FIELD GROUPS
    // =========================================================================

    /**
     * Base SELECT for media items with primary external ID mapping.
     * Returns: media_id (UUID), primary_ext_id, title, original_title, year, media_type, is_local_only
     */
    baseMediaSelect: `
        mi.id AS media_id,
        primary_ext.external_id AS primary_ext_id,
        mi.title,
        mi.original_title,
        mi.year,
        mi.media_type,
        mi.is_local_only
    `,

    /**
     * Provider metadata fields from the aggregated or TMDB metadata.
     * Returns: poster_path, backdrop_path, overview, genres, runtime_minutes, vote_average, popularity
     */
    metadataFields: `
        pm.metadata->>'poster_path' AS poster_path,
        pm.metadata->>'backdrop_path' AS backdrop_path,
        pm.metadata->>'overview' AS overview,
        pm.metadata->'genres' AS genres,
        CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
        CAST(pm.metadata->>'vote_average' AS FLOAT8) AS vote_average,
        CAST(pm.metadata->>'popularity' AS FLOAT8) AS popularity,
        CAST(pm.metadata->>'vote_count' AS INTEGER) AS vote_count,
        pm.metadata->>'certification' AS certification,
        pm.metadata->'keywords' AS keywords,
        pm.metadata->'networks' AS networks,
        pm.metadata->'production_companies' AS production_companies,
        pm.metadata->'actors' AS actors,
        pm.metadata->'directors' AS directors,
        CAST(pm.metadata->>'imdb_rating' AS FLOAT8) AS imdb_rating,
        CAST(pm.metadata->>'rt_rating' AS INTEGER) AS rt_rating,
        CAST(pm.metadata->>'tmdb_rating' AS FLOAT8) AS tmdb_rating,
        pm.metadata->>'trailer_url' AS trailer_url
    `,

    /**
     * Extended metadata fields including MDBList enrichment.
     * Returns all standard metadata plus: mdblist_score, letterboxd_rating, metacritic_score, etc.
     */
    extendedMetadataFields: `
        pm.metadata->>'poster_path' AS poster_path,
        pm.metadata->>'backdrop_path' AS backdrop_path,
        pm.metadata->>'overview' AS overview,
        pm.metadata->'genres' AS genres,
        CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
        CAST(pm.metadata->>'vote_average' AS FLOAT8) AS vote_average,
        CAST(pm.metadata->>'popularity' AS FLOAT8) AS popularity,
        CAST(pm.metadata->>'vote_count' AS INTEGER) AS vote_count,
        pm.metadata->>'certification' AS certification,
        pm.metadata->'keywords' AS keywords,
        pm.metadata->'networks' AS networks,
        pm.metadata->'production_companies' AS production_companies,
        pm.metadata->'actors' AS actors,
        pm.metadata->'directors' AS directors,
        pm.metadata->'producers' AS producers,
        pm.metadata->'writers' AS writers,
        CAST(pm.metadata->>'imdb_rating' AS FLOAT8) AS imdb_rating,
        CAST(pm.metadata->>'rt_rating' AS INTEGER) AS rt_rating,
        CAST(pm.metadata->>'tmdb_rating' AS FLOAT8) AS tmdb_rating,
        pm.metadata->>'trailer_url' AS trailer_url,
        CAST(pm.metadata->>'mdblist_score' AS SMALLINT) AS mdblist_score,
        pm.metadata->'mdblist_keywords' AS mdblist_keywords,
        CAST(pm.metadata->>'letterboxd_rating' AS FLOAT8) AS letterboxd_rating,
        CAST(pm.metadata->>'letterboxd_votes' AS INTEGER) AS letterboxd_votes,
        CAST(pm.metadata->>'metacritic_score' AS SMALLINT) AS metacritic_score,
        CAST(pm.metadata->>'rt_audience_score' AS SMALLINT) AS rt_audience_score,
        CAST(pm.metadata->>'trakt_score' AS SMALLINT) AS trakt_score,
        CAST(pm.metadata->>'mal_score' AS FLOAT8) AS mal_score,
        CAST(pm.metadata->>'mal_votes' AS INTEGER) AS mal_votes,
        pm.metadata->'streaming_services' AS streaming_services,
        pm.metadata->'anime_genres' AS anime_genres
    `,

    /**
     * Embedding fields from media_embeddings table.
     * Requires JOIN on media_embeddings (use embeddingJoins).
     * Returns: library_embedding, discovery_embedding
     */
    embeddings: buildEmbeddingTextFields(),

    /**
     * Availability fields using correlated subqueries against media_file_items.
     * An item is available if it has at least one file on disk.
     * No JOIN required — fields use correlated subqueries (use availabilityJoin which is empty).
     */
    availabilityFields: AVAILABILITY_SELECT_FIELDS,

    // =========================================================================
    // JOIN CLAUSES
    // =========================================================================

    /**
     * JOINs for media_embeddings table.
     * Aliases: lib_emb (library embedding), disc_emb (discovery embedding)
     */
    embeddingJoins: `
        LEFT JOIN media_embeddings lib_emb ON mi.id = lib_emb.media_id
            AND lib_emb.source = '${EMBEDDING_SOURCE.LIBRARY}'
        LEFT JOIN media_embeddings disc_emb ON mi.id = disc_emb.media_id
            AND disc_emb.source = '${EMBEDDING_SOURCE.DISCOVERY}'
    `,

    /**
     * No JOIN needed — availabilityFields uses correlated subqueries against media_file_items.
     */
    availabilityJoin: ``,

    /**
     * JOIN for IMDB external ID.
     * Alias: imdb_ext (external_ids)
     */
    imdbJoin: `
        LEFT JOIN external_ids imdb_ext ON mi.id = imdb_ext.media_id
            AND imdb_ext.provider = 'imdb'
    `,

    /**
     * JOIN for Jellyfin external ID.
     * Alias: jf_ext (external_ids)
     */
    jellyfinExtJoin: `
        LEFT JOIN external_ids jf_ext ON mi.id = jf_ext.media_id
            AND jf_ext.provider = 'jellyfin'
    `,

    /**
     * JOIN for Jellyseerr external ID.
     * Alias: js_ext (external_ids)
     */
    jellyseerrExtJoin: `
        LEFT JOIN external_ids js_ext ON mi.id = js_ext.media_id
            AND js_ext.provider = 'jellyseerr'
    `,

    // =========================================================================
    // FILTER EXPRESSIONS
    // =========================================================================

    /**
     * Filter for active media items only.
     */
    activeFilter: `mi.status = 'active'`,

    /**
     * Filter for library-backed items (files present on disk).
     *
     * Use on library-scoped reads to keep catalog ghosts (metadata with no
     * files) from leaking as playable cards.
     */
    hasFilesFilter: `mi.has_files = true`,

    /**
     * Filter for library-backed movies only.
     *
     * Includes `has_files = true` so catalog ghosts (movie metadata with no
     * files on disk — e.g. discovery rows) never leak into library-scoped
     * reads as playable cards. Named `libraryMovieFilter` (not a bare
     * `movieFilter`) precisely because the has_files clause makes it unsafe for
     * discovery/aggregation reads — use a plain `mi.media_type = 'movie'` there.
     */
    libraryMovieFilter: `mi.media_type = 'movie' AND mi.has_files = true`,

    /**
     * Filter for TV shows only.
     */
    tvFilter: `mi.media_type = 'tv'`,

    // =========================================================================
    // ORDER BY CLAUSES
    // =========================================================================

    /**
     * ORDER BY clause for most recently updated items.
     */
    orderByUpdated: `mi.updated_at DESC`,

    /**
     * ORDER BY clause for popularity.
     * Requires provider_metadata JOIN.
     */
    orderByPopularity: `CAST(pm.metadata->>'popularity' AS FLOAT8) DESC NULLS LAST`,

    // =========================================================================
    // PROVIDER FILTERS - Use these instead of hardcoding provider strings
    // =========================================================================

    /**
     * Filter for TMDB provider in external_ids table.
     * Use with external_ids JOIN: `WHERE ${tmdbProviderFilter}`
     */
    get tmdbProviderFilter() {
        // Safe: getPrimaryExternalIdProvider() returns a value from server config, not user input
        return `provider = '${getPrimaryExternalIdProvider()}'`;
    },

    /**
     * Filter for IMDB provider in external_ids table.
     */
    imdbProviderFilter: `provider = 'imdb'`,

    /**
     * Filter for Jellyfin provider in external_ids table.
     */
    jellyfinProviderFilter: `provider = 'jellyfin'`,

    /**
     * Filter for Jellyseerr provider in external_ids table.
     */
    jellyseerrProviderFilter: `provider = 'jellyseerr'`,

    /**
     * Filter for primary external ID (use in JOINs).
     * Example: `JOIN external_ids primary_ext ON ... AND ${primaryExtFilter}`
     */
    get primaryExtFilter() {
        return `primary_ext.provider = '${getPrimaryExternalIdProvider()}' AND primary_ext.is_primary = TRUE`;
    },
    /** @deprecated Use primaryExtFilter */
    get primaryTmdbExtFilter() {
        return this.primaryExtFilter;
    },

    // =========================================================================
    // EMBEDDING SOURCE FILTERS - For media_embeddings table queries
    // =========================================================================

    /**
     * Filter for library embedding source.
     * Use with media_embeddings JOIN: `WHERE ${libraryEmbeddingSourceFilter}`
     */
    libraryEmbeddingSourceFilter: `source = '${EMBEDDING_SOURCE.LIBRARY}'`,

    /**
     * Filter for discovery embedding source.
     */
    discoveryEmbeddingSourceFilter: `source = '${EMBEDDING_SOURCE.DISCOVERY}'`,

    /**
     * Filter for both embedding sources (library OR discovery).
     * Use in queries that accept either source.
     */
    bothEmbeddingSourcesFilter: `source IN ('${EMBEDDING_SOURCE.LIBRARY}', '${EMBEDDING_SOURCE.DISCOVERY}')`,

    /**
     * Filter for library embedding with table alias.
     * Use when table is aliased as lib_emb: `AND ${libraryEmbeddingFilter}`
     */
    libraryEmbeddingFilter: `lib_emb.source = '${EMBEDDING_SOURCE.LIBRARY}'`,

    /**
     * Filter for discovery embedding with table alias.
     * Use when table is aliased as disc_emb: `AND ${discoveryEmbeddingFilter}`
     */
    discoveryEmbeddingFilter: `disc_emb.source = '${EMBEDDING_SOURCE.DISCOVERY}'`,

    // =========================================================================
    // AVAILABILITY FILTERS - Check media_file_items existence
    // =========================================================================

    /**
     * Check if item is available (has files on disk).
     */
    isAvailableFilter: AVAILABILITY_FILTER,

    /**
     * Check if item is NOT available (requestable).
     */
    isNotAvailableFilter: `NOT ${AVAILABILITY_FILTER}`,

    // =========================================================================
    // COMBINED FILTERS - Common filter combinations
    // =========================================================================

    /**
     * Active, library-backed movies only.
     *
     * Includes `has_files = true` so catalog ghosts (active movie metadata with
     * no files on disk) never leak into library-scoped reads as playable cards.
     * Named `activeLibraryMovieFilter` (not a bare `activeMovieFilter`) because
     * the has_files clause makes it unsafe for discovery/aggregation reads.
     */
    activeLibraryMovieFilter: `mi.status = 'active' AND mi.media_type = 'movie' AND mi.has_files = true`,

    /**
     * Active TV shows only.
     */
    activeTvFilter: `mi.status = 'active' AND mi.media_type = 'tv'`,

    /**
     * Active and available in Jellyfin.
     * Requires library_availability JOIN.
     */
    activeAndAvailableFilter: `mi.status = 'active' AND ${AVAILABILITY_FILTER}`,

    // =========================================================================
    // CTE PATTERNS - Common Table Expression templates
    // Note: These are templates - replace $USER_ID and $LIMIT with actual parameters
    // =========================================================================

    /**
     * CTE for getting user's disliked media (rating <= 4).
     * Returns: media_id (UUID)
     * Usage: Replace $USER_ID with parameterized user ID.
     *
     * @example
     * WITH disliked_movies AS (
     *     SELECT ur.media_id
     *     FROM user_ratings ur
     *     WHERE ur.user_id = ${userId} AND ur.rating <= 4
     * )
     */
    cteDislikedMoviesSimple: `
        SELECT ur.media_id
        FROM user_ratings ur
        WHERE ur.user_id = $USER_ID AND ur.rating <= 4
    `,

    /**
     * CTE for getting user's liked media (rating >= 7).
     * Returns: media_id (UUID)
     *
     * @example
     * WITH liked_movies AS (
     *     SELECT ur.media_id
     *     FROM user_ratings ur
     *     WHERE ur.user_id = ${userId} AND ur.rating >= 7
     * )
     */
    cteLikedMoviesSimple: `
        SELECT ur.media_id
        FROM user_ratings ur
        WHERE ur.user_id = $USER_ID AND ur.rating >= 7
    `,

    /**
     * CTE for getting user's recent watch history.
     * Returns: media_id (UUID), watched_at
     *
     * @example
     * WITH recent_watches AS (
     *     SELECT uwh.media_id, uwh.watched_at
     *     FROM user_watch_history uwh
     *     WHERE uwh.user_id = ${userId}
     *     ORDER BY uwh.watched_at DESC
     *     LIMIT ${limit}
     * )
     */
    cteRecentWatches: `
        SELECT uwh.media_id, uwh.last_watched_at
        FROM user_media_state uwh
        WHERE uwh.user_id = $USER_ID
          AND uwh.is_watched = true
        ORDER BY uwh.last_watched_at DESC
        LIMIT $LIMIT
    `,

    /**
     * Exclusion pattern using NOT EXISTS with disliked_movies CTE.
     * Add to WHERE clause after defining disliked_movies CTE.
     */
    excludeDislikedPattern: `NOT EXISTS (SELECT 1 FROM disliked_movies dm WHERE dm.media_id = mi.id)`,

    /**
     * Exclusion pattern using NOT EXISTS with watched_media CTE.
     * Add to WHERE clause after defining watched_media CTE.
     */
    excludeWatchedPattern: `NOT EXISTS (SELECT 1 FROM watched_media wm WHERE wm.media_id = mi.id)`,

    // =========================================================================
    // SCALAR SUBQUERIES - Use these for fetching external IDs in SELECT clauses
    // Avoids row multiplication from JOINs, always returns single value
    // =========================================================================

    /**
     * Scalar subquery to fetch the primary external ID for a media item as text.
     * Use in SELECT: `${MediaQueryFragments.scalarPrimaryExtId} as primary_ext_id`
     * Assumes mi.id is the media_id column.
     */
    get scalarPrimaryExtId() {
        return `(SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = '${getPrimaryExternalIdProvider()}' LIMIT 1)`;
    },

    /** @deprecated Use scalarPrimaryExtId — returns text, no integer cast */
    get scalarTmdbId() {
        return this.scalarPrimaryExtId;
    },

    /** @deprecated Use scalarPrimaryExtId */
    get scalarTmdbIdString() {
        return this.scalarPrimaryExtId;
    },

    /**
     * Scalar subquery to fetch IMDB ID for a media item.
     */
    scalarImdbId: `(SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1)`,

    /**
     * Scalar subquery to fetch Jellyseerr ID for a media item.
     */
    scalarJellyseerrId: `(SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'jellyseerr' LIMIT 1)`,

    /**
     * Scalar subquery to fetch TVDB ID for a media item.
     */
    scalarTvdbId: `(SELECT external_id::integer FROM external_ids WHERE media_id = mi.id AND provider = 'tvdb' LIMIT 1)`,

    // =========================================================================
    // COMPOSITE KEY JOINS - Safe JOINs that include media_type to prevent collisions
    // =========================================================================

    /**
     * JOIN for primary external ID with media_type safety.
     * Prevents ID collisions between movies and TV shows.
     * Alias: primary_ext
     */
    get primaryExtWithMediaTypeJoin() {
        return `LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = '${getPrimaryExternalIdProvider()}' AND primary_ext.media_type = mi.media_type`;
    },
    /** @deprecated Use primaryExtWithMediaTypeJoin */
    get tmdbExtWithMediaTypeJoin() {
        return this.primaryExtWithMediaTypeJoin;
    },

    /**
     * JOIN for primary external ID with is_primary and media_type safety.
     * Use when multiple provider entries might exist (e.g., after type corrections).
     * Alias: primary_ext
     */
    get primaryExtIsPrimaryWithMediaTypeJoin() {
        return `LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = '${getPrimaryExternalIdProvider()}' AND primary_ext.is_primary = TRUE AND primary_ext.media_type = mi.media_type`;
    },
    /** @deprecated Use primaryExtIsPrimaryWithMediaTypeJoin */
    get primaryTmdbExtWithMediaTypeJoin() {
        return this.primaryExtIsPrimaryWithMediaTypeJoin;
    },

    // =========================================================================
    // EMBEDDING JOINS - Specific variants for common embedding patterns
    // =========================================================================

    /**
     * JOIN for library embedding only.
     * Alias: lib_emb
     */
    libraryEmbeddingJoin: `LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = '${EMBEDDING_SOURCE.LIBRARY}'`,

    /**
     * JOIN for discovery embedding only.
     * Alias: disc_emb
     */
    discoveryEmbeddingJoin: `LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = '${EMBEDDING_SOURCE.DISCOVERY}'`,

    // =========================================================================
    // JSON ARRAY EXTRACTION - Extract JSONB arrays to PostgreSQL arrays
    // =========================================================================

    /**
     * Extract mdblist_keywords from metadata as text array.
     * Assumes pm.metadata is available (requires provider_metadata JOIN).
     *
     * @example
     * SELECT ${MediaQueryFragments.extractKeywordsArray} as mdblist_keywords
     */
    extractKeywordsArray: `CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'mdblist_keywords'))
        ELSE NULL
    END`,

    /**
     * Extract genres from metadata as integer array.
     * Assumes pm.metadata is available (requires provider_metadata JOIN).
     *
     * @example
     * SELECT ${MediaQueryFragments.extractGenresArray} as genres
     */
    extractGenresArray: `CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
        THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
        ELSE NULL
    END`,

    /**
     * Extract actors from metadata as text array.
     * Assumes pm.metadata is available (requires provider_metadata JOIN).
     */
    extractActorsArray: `CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'actors'))
        ELSE NULL
    END`,

    /**
     * Extract directors from metadata as text array.
     * Assumes pm.metadata is available (requires provider_metadata JOIN).
     */
    extractDirectorsArray: `CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'directors'))
        ELSE NULL
    END`,
};

export default MediaQueryFragments;
