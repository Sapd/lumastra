// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSONB Array Extraction Utilities
 *
 * SQL fragments and helpers for safely extracting JSONB array fields as PostgreSQL arrays.
 * These handle NULL checks and type validation to avoid runtime errors.
 *
 * @module fragments/jsonb-extractors
 */

/**
 * Build a JSON array extraction expression for any JSONB field.
 *
 * @param jsonPath - Full path to the JSONB field (e.g., 'pm.metadata', 'meta.data')
 * @param fieldName - Name of the array field within the JSON (e.g., 'mdblist_keywords', 'genres')
 * @param castTo - Optional cast for array elements ('integer', 'text', etc.)
 *
 * @example
 * // Extract text array
 * const keywords = buildJsonArrayExtract('pm.metadata', 'mdblist_keywords');
 *
 * // Extract integer array
 * const genres = buildJsonArrayExtract('pm.metadata', 'genres', 'integer');
 *
 * // Use with custom alias
 * const actors = buildJsonArrayExtract('meta.data', 'actors');
 */
export function buildJsonArrayExtract(
    jsonPath: string,
    fieldName: string,
    castTo?: 'integer' | 'text' | 'numeric',
): string {
    const fullPath = `${jsonPath}->'${fieldName}'`;

    if (castTo === 'integer') {
        return `CASE WHEN ${fullPath} IS NOT NULL AND jsonb_typeof(${fullPath}) = 'array'
        THEN ARRAY(SELECT (elem::text)::integer FROM jsonb_array_elements(${fullPath}) AS elem)
        ELSE NULL
    END`;
    }

    // Default: extract as text array
    return `CASE WHEN ${fullPath} IS NOT NULL AND jsonb_typeof(${fullPath}) = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(${fullPath}))
        ELSE NULL
    END`;
}

/**
 * SQL fragments for safely extracting JSONB array fields as PostgreSQL arrays.
 * These handle NULL checks and type validation to avoid runtime errors.
 *
 * Usage: Include these in your SELECT clause when you need typed arrays from JSONB.
 * Assumes pm.metadata is available (requires provider_metadata JOIN).
 */
export const JsonbArrayExtractors = {
    /**
     * Extract genres as integer array.
     * Returns: genres (integer[] or NULL)
     */
    genres: `
        CASE
            WHEN pm.metadata->'genres' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'genres') = 'array'
            THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
            ELSE NULL
        END AS genres
    `,

    /**
     * Extract actors as text array.
     * Returns: actors (text[] or NULL)
     */
    actors: `
        CASE
            WHEN pm.metadata->'actors' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'actors') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
            ELSE NULL
        END AS actors
    `,

    /**
     * Extract directors as text array.
     * Returns: directors (text[] or NULL)
     */
    directors: `
        CASE
            WHEN pm.metadata->'directors' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'directors') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
            ELSE NULL
        END AS directors
    `,

    /**
     * Extract MDBList keywords as text array.
     * Returns: mdblist_keywords (text[] or NULL)
     */
    mdblistKeywords: `
        CASE
            WHEN pm.metadata->'mdblist_keywords' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'mdblist_keywords') AS elem)
            ELSE NULL
        END AS mdblist_keywords
    `,

    /**
     * Extract streaming services as text array.
     * Returns: streaming_services (text[] or NULL)
     */
    streamingServices: `
        CASE
            WHEN pm.metadata->'streaming_services' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'streaming_services') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'streaming_services') AS elem)
            ELSE NULL
        END AS streaming_services
    `,

    /**
     * Extract anime genres as text array.
     * Returns: anime_genres (text[] or NULL)
     */
    animeGenres: `
        CASE
            WHEN pm.metadata->'anime_genres' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'anime_genres') AS elem)
            ELSE NULL
        END AS anime_genres
    `,
} as const;

/**
 * Combined JSONB extraction fragments for common use cases.
 * These reduce boilerplate when building queries that need typed arrays.
 */
export const TypedJsonbExtractors = {
    /**
     * All typed array extractions in one fragment.
     * Includes: genres, actors, directors, mdblist_keywords, streaming_services
     */
    allTypedArrays: `
        ${JsonbArrayExtractors.genres},
        ${JsonbArrayExtractors.actors},
        ${JsonbArrayExtractors.directors},
        ${JsonbArrayExtractors.mdblistKeywords},
        ${JsonbArrayExtractors.streamingServices}
    `,

    /**
     * All ratings in one fragment.
     * Includes: imdb_rating, rt_rating, tmdb_rating, mdblist_score, letterboxd_rating, trakt_score, mal_score
     */
    allRatings: `
        CAST(pm.metadata->>'imdb_rating' AS FLOAT8) AS imdb_rating,
        CAST(pm.metadata->>'rt_rating' AS INTEGER) AS rt_rating,
        CAST(pm.metadata->>'tmdb_rating' AS FLOAT8) AS tmdb_rating,
        CAST(pm.metadata->>'mdblist_score' AS SMALLINT) AS mdblist_score,
        CAST(pm.metadata->>'letterboxd_rating' AS FLOAT8) AS letterboxd_rating,
        CAST(pm.metadata->>'trakt_score' AS SMALLINT) AS trakt_score,
        CAST(pm.metadata->>'mal_score' AS FLOAT8) AS mal_score
    `,

    /**
     * Core content fields commonly needed.
     * Includes: title, overview, poster_path, backdrop_path, year
     */
    coreContent: `
        pm.metadata->>'poster_path' AS poster_path,
        pm.metadata->>'backdrop_path' AS backdrop_path,
        pm.metadata->>'overview' AS overview,
        CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
        pm.metadata->>'certification' AS certification
    `,

    /**
     * People fields (cast, crew).
     * Includes: actors, directors, producers, writers
     */
    people: `
        ${JsonbArrayExtractors.actors},
        ${JsonbArrayExtractors.directors},
        CASE
            WHEN pm.metadata->'producers' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'producers') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'producers') AS elem)
            ELSE NULL
        END AS producers,
        CASE
            WHEN pm.metadata->'writers' IS NOT NULL
                AND jsonb_typeof(pm.metadata->'writers') = 'array'
            THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'writers') AS elem)
            ELSE NULL
        END AS writers
    `,
} as const;

export default JsonbArrayExtractors;
