// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Episode Search Queries
 *
 * Centralized queries for episode search and lookup.
 * Uses media_items table with UUID-based hierarchy (series → season → episode).
 *
 * Provider-agnostic: series external ID is picked via LATERAL JOIN with priority
 * (tmdb → tvdb → imdb → trakt), returned as seriesMetaId + seriesMetaProvider.
 *
 * @module queries/episode-search
 *
 * Integration tests: episode-search.queries.integration.test.ts
 */

import type postgres from 'postgres';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import {
    buildSeriesOwnedAgeRatingFilter,
    type AgeRatingFilterParams,
} from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { isAvailableExpr } from './availability.queries.js';
import type {
    AgeScope,
    LibraryScope,
    MediaAccessBoundary,
} from './builders/media-access-boundary.js';

// =============================================================================
// SQL Builder Helpers
// =============================================================================

/** Allowed static SQL column references for episode table aliases (prevents sql.unsafe injection). */
type EpisodeAlias = 'ep' | 'mi' | 'm';

/** Allowed static SQL column expressions for series ID resolution (prevents sql.unsafe injection). */
type SeriesIdColumn =
    | 'season.parent_id'
    | 'parent_mi.parent_id'
    | 'parent.parent_id'
    | 'parent_season.parent_id'
    | 'season_mi.parent_id';

/**
 * Ordered provider list for series external ID resolution.
 * Primary provider (from config) is tried first, then common fallbacks.
 */
function getSeriesExternalIdProviders(): string[] {
    const primary = getPrimaryExternalIdProvider();
    const fallbacks = ['tmdb', 'tvdb', 'imdb', 'trakt'].filter((p) => p !== primary);
    return [primary, ...fallbacks];
}

/**
 * Build a parameterized postgres.js SQL fragment for the series external ID LATERAL JOIN.
 *
 * Picks the best available external ID for a series using provider priority order.
 * Uses array_position() for ordering — fully parameterized, no sql.unsafe() needed.
 *
 * @param sql - Postgres SQL client instance
 * @param mediaIdColumn - SQL column expression for the series media_id.
 *   MUST be a static SQL column reference (e.g., 'season.parent_id'), never user input.
 * @returns postgres.js SQL fragment for use in template literals
 */
export function buildSeriesExternalIdLateralJoinFragment(
    sql: postgres.Sql,
    mediaIdColumn: SeriesIdColumn = 'season.parent_id',
): postgres.PendingQuery<postgres.Row[]> {
    const providers = getSeriesExternalIdProviders();
    // array_position returns the 1-based index of provider in the priority array,
    // providing natural ascending priority ordering.
    return sql`
        LEFT JOIN LATERAL (
            SELECT external_id, provider
            FROM external_ids
            WHERE media_id = ${sql.unsafe(mediaIdColumn)}
              AND provider = ANY(${providers})
            ORDER BY array_position(${providers}::text[], provider)
            LIMIT 1
        ) series_meta ON true
    `;
}

/**
 * Build a self-resolving episode ordering JOIN for cross-series queries.
 *
 * Joins series_episode_ordering to discover the active ordering per series,
 * then joins episode_orderings for display numbers. When no ordering is active
 * for a series, the LEFT JOINs return NULL and COALESCE falls through.
 */
export function buildAutoEpisodeOrderingJoinFragment(
    sql: postgres.Sql,
    episodeAlias: EpisodeAlias = 'ep',
    seriesIdColumn: SeriesIdColumn = 'season.parent_id',
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        LEFT JOIN series_episode_ordering seo
            ON seo.media_id = ${sql.unsafe(seriesIdColumn)}
            AND seo.ordering_type != 'standard'
        LEFT JOIN episode_orderings eo
            ON eo.episode_media_id = ${sql.unsafe(episodeAlias)}.id
            AND eo.series_media_id = seo.media_id
            AND eo.ordering_type = seo.ordering_type
            AND eo.ordering_group_id = seo.ordering_group_id
    `;
}

/**
 * Build a WHERE-clause filter that excludes unmapped episodes when an ordering is active,
 * but preserves episodes from entirely unmapped physical seasons (e.g., Specials).
 *
 * Logic:
 * - No ordering active (seo.media_id IS NULL) → include all episodes
 * - Ordering active + episode is mapped (eo.episode_media_id IS NOT NULL) → include
 * - Ordering active + episode unmapped, but NO sibling from same physical season is mapped → include
 *   (entire season is outside the ordering, e.g., Specials)
 * - Ordering active + episode unmapped, but other siblings ARE mapped → exclude
 *   (leftover episode that would pollute the ordered view)
 */
export function buildUnmappedEpisodeFilterFragment(
    sql: postgres.Sql,
    episodeAlias: EpisodeAlias = 'ep',
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        AND (
            seo.media_id IS NULL
            OR eo.episode_media_id IS NOT NULL
            OR NOT EXISTS (
                SELECT 1 FROM episode_orderings eo_sib
                JOIN media_items ep_sib ON ep_sib.id = eo_sib.episode_media_id
                WHERE eo_sib.series_media_id = seo.media_id
                  AND eo_sib.ordering_type = seo.ordering_type
                  AND eo_sib.ordering_group_id = seo.ordering_group_id
                  AND ep_sib.parent_id = ${sql.unsafe(episodeAlias)}.parent_id
            )
        )
    `;
}

// =============================================================================
// Types
// =============================================================================

export interface EpisodeSearchResult {
    id: string; // media_items UUID
    seriesId: string; // series media_items UUID (walked up from season)
    /** Best available series external ID (tmdb → tvdb → imdb → trakt priority) */
    seriesMetaId: string | null;
    /** Provider name corresponding to seriesMetaId */
    seriesMetaProvider: string | null;
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    overview: string | null;
    runtimeSeconds: number | null;
    premiereDate: string | null;
    relevanceScore: number;
}

export interface EpisodeLookupResult {
    id: string; // media_items UUID
}

export interface EpisodeByNameLookupResult {
    id: string; // episode media_items UUID
    seriesId: string; // series media_items UUID
    seriesTitle: string;
    similarityScore: number;
}

// =============================================================================
// Search Term Preparation
// =============================================================================

/**
 * Prepare search query for PostgreSQL tsquery.
 * Escapes special characters and adds prefix matching.
 */
export function prepareSearchTerms(query: string): string {
    return query
        .trim()
        .split(/\s+/)
        .filter((term) => term.length > 0)
        .map((term) => term.replace(/[&|!():*'"]/g, ''))
        .filter((term) => term.length > 0)
        .map((term) => `${term}:*`)
        .join(' & ');
}

// =============================================================================
// Full-Text Search Queries
// =============================================================================

export interface EpisodeSearchQueryOptions {
    deniedGroupIds: string[] | null;
    ageRating: AgeRatingFilterParams | null;
}

/**
 * Library access filter fragment for episode search queries.
 *
 * Every query in this module SELECTs episode rows aliased `ep`, so the row
 * whose library membership decides visibility is the EPISODE — the leaf that
 * actually carries a `media_files.library_group_id`. This delegates to the
 * shared `buildLibraryAccessFilter` with that alias; `ep.media_type` is
 * `'episode'`, so it takes the leaf branch. Search additionally applies
 * canonical availability through buildSearchableEpisodeFilter; metadata walks
 * retain their explicit playableOnly option.
 *
 * It used to be a second copy of the OLD predicate correlated to
 * `season.parent_id` — the `tv` row — because the shared builder hardcoded the
 * `mi` alias. That copy was vacuous in production: no `tv` row owns
 * `media_file_items` (0 of 6,570, verified 2026-09-15, against 80,777 leaf
 * rows that do), so its `NOT EXISTS (own files)` arm was always TRUE and the
 * whole library axis of every episode-search query did nothing. The shared
 * builder now takes an alias, so there is no copy left to drift.
 *
 * Accepts a {@link LibraryScope} (preferred) or the legacy denied-group list;
 * scope dispatch (`all` / `denyGroups` / `denyAll`) is the builder's.
 */
function buildEpisodeLibraryFilter(
    sql: postgres.Sql,
    scope: LibraryScope | string[] | null | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    return buildLibraryAccessFilter(sql, scope, 'ep');
}

/** Availability applies to user-facing search, independently of library access. */
function buildSearchableEpisodeFilter(
    sql: postgres.Sql,
    scope: LibraryScope | string[] | null | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`AND ${isAvailableExpr(sql, sql`ep.id`)}
        AND ep.status = 'active' AND ep.is_dismissed = false
        ${buildEpisodeLibraryFilter(sql, scope)}`;
}

/**
 * Age-rating filter applied at the series level for episode search.
 * Subquery against media_items because the surrounding query joins
 * episode and season but not the series row directly.
 *
 * Accepts an {@link AgeScope} (preferred) or the legacy params:
 * - `any`     -> empty fragment
 * - `limit`   -> the existing predicate
 * - `denyAll` -> `AND false`
 */
function buildEpisodeAgeFilter(
    sql: postgres.Sql,
    scope: AgeScope | AgeRatingFilterParams | null,
): postgres.PendingQuery<postgres.Row[]> {
    if (scope !== null && 'kind' in scope) {
        if (scope.kind === 'denyAll') return sql`AND false`;
        return buildEpisodeAgeFilter(
            sql,
            scope.kind === 'limit'
                ? { maxAgeRating: scope.maxAgeRating, allowUnrated: scope.allowUnrated }
                : null,
        );
    }
    const ageRating = scope;
    if (!ageRating || ageRating.maxAgeRating === null) return sql``;
    return sql`
        AND EXISTS (
            SELECT 1 FROM media_items series
            WHERE series.id = season.parent_id
              AND (
                  (series.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                  OR series.age_rating <= ${ageRating.maxAgeRating}
              )
        )
    `;
}

/**
 * Search episodes by title/overview using full-text search on media_items.search_vector.
 * Filters by series UUID if provided.
 * Display numbers are ordering-aware via auto-resolving LEFT JOIN.
 */
export async function searchEpisodesFullText(
    sql: postgres.Sql,
    searchTerms: string,
    limit: number,
    seriesId: string | undefined,
    options: EpisodeSearchQueryOptions,
): Promise<EpisodeSearchResult[]> {
    if (seriesId) {
        return (await sql`
            SELECT
                ep.id,
                season.parent_id as "seriesId",
                series_meta.external_id as "seriesMetaId",
                series_meta.provider as "seriesMetaProvider",
                COALESCE(eo.order_season_number, ep.season_number) as "seasonNumber",
                COALESCE(eo.order_episode_number, ep.episode_number) as "episodeNumber",
                ep.title,
                ep.overview,
                ep.runtime_seconds as "runtimeSeconds",
                ep.premiere_date as "premiereDate",
                ts_rank(ep.search_vector, to_tsquery('simple', immutable_unaccent(${searchTerms}))) as "relevanceScore"
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            ${buildSeriesExternalIdLateralJoinFragment(sql)}
            ${buildAutoEpisodeOrderingJoinFragment(sql)}
            WHERE season.parent_id = ${seriesId}
              AND ep.media_type = 'episode'
              AND ep.search_vector @@ to_tsquery('simple', immutable_unaccent(${searchTerms}))
              ${buildSearchableEpisodeFilter(sql, options.deniedGroupIds)}
              ${buildEpisodeAgeFilter(sql, options.ageRating)}
            ORDER BY "relevanceScore" DESC,
                     COALESCE(eo.order_season_number, ep.season_number) ASC,
                     COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number) ASC
            LIMIT ${limit}
        `) as unknown as EpisodeSearchResult[];
    }

    return (await sql`
        SELECT
            ep.id,
            season.parent_id as "seriesId",
            series_meta.external_id as "seriesMetaId",
            series_meta.provider as "seriesMetaProvider",
            COALESCE(eo.order_season_number, ep.season_number) as "seasonNumber",
            COALESCE(eo.order_episode_number, ep.episode_number) as "episodeNumber",
            ep.title,
            ep.overview,
            ep.runtime_seconds as "runtimeSeconds",
            ep.premiere_date as "premiereDate",
            ts_rank(ep.search_vector, to_tsquery('simple', immutable_unaccent(${searchTerms}))) as "relevanceScore"
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildSeriesExternalIdLateralJoinFragment(sql)}
        ${buildAutoEpisodeOrderingJoinFragment(sql)}
        WHERE ep.media_type = 'episode'
          AND ep.search_vector @@ to_tsquery('simple', immutable_unaccent(${searchTerms}))
          ${buildSearchableEpisodeFilter(sql, options.deniedGroupIds)}
          ${buildEpisodeAgeFilter(sql, options.ageRating)}
        ORDER BY "relevanceScore" DESC
        LIMIT ${limit}
    `) as unknown as EpisodeSearchResult[];
}

/**
 * Search episodes by title using trigram similarity.
 * Fallback for when full-text search returns no results.
 * Display numbers are ordering-aware via auto-resolving LEFT JOIN.
 */
export async function searchEpisodesTrigram(
    sql: postgres.Sql,
    query: string,
    limit: number,
    seriesId: string | undefined,
    options: EpisodeSearchQueryOptions,
): Promise<EpisodeSearchResult[]> {
    if (seriesId) {
        return (await sql`
            SELECT
                ep.id,
                season.parent_id as "seriesId",
                series_meta.external_id as "seriesMetaId",
                series_meta.provider as "seriesMetaProvider",
                COALESCE(eo.order_season_number, ep.season_number) as "seasonNumber",
                COALESCE(eo.order_episode_number, ep.episode_number) as "episodeNumber",
                ep.title,
                ep.overview,
                ep.runtime_seconds as "runtimeSeconds",
                ep.premiere_date as "premiereDate",
                GREATEST(similarity(immutable_unaccent(ep.title), immutable_unaccent(${query})), similarity(german_digraph_fold(ep.title), german_digraph_fold(${query}))) as "relevanceScore"
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            ${buildSeriesExternalIdLateralJoinFragment(sql)}
            ${buildAutoEpisodeOrderingJoinFragment(sql)}
            WHERE season.parent_id = ${seriesId}
              AND ep.media_type = 'episode'
              AND (immutable_unaccent(ep.title) % immutable_unaccent(${query})
                   OR german_digraph_fold(ep.title) % german_digraph_fold(${query}))
              ${buildSearchableEpisodeFilter(sql, options.deniedGroupIds)}
              ${buildEpisodeAgeFilter(sql, options.ageRating)}
            ORDER BY "relevanceScore" DESC,
                     COALESCE(eo.order_season_number, ep.season_number) ASC,
                     COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number) ASC
            LIMIT ${limit}
        `) as unknown as EpisodeSearchResult[];
    }

    return (await sql`
        SELECT
            ep.id,
            season.parent_id as "seriesId",
            series_meta.external_id as "seriesMetaId",
            series_meta.provider as "seriesMetaProvider",
            COALESCE(eo.order_season_number, ep.season_number) as "seasonNumber",
            COALESCE(eo.order_episode_number, ep.episode_number) as "episodeNumber",
            ep.title,
            ep.overview,
            ep.runtime_seconds as "runtimeSeconds",
            ep.premiere_date as "premiereDate",
            GREATEST(similarity(immutable_unaccent(ep.title), immutable_unaccent(${query})), similarity(german_digraph_fold(ep.title), german_digraph_fold(${query}))) as "relevanceScore"
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildSeriesExternalIdLateralJoinFragment(sql)}
        ${buildAutoEpisodeOrderingJoinFragment(sql)}
        WHERE ep.media_type = 'episode'
          AND (immutable_unaccent(ep.title) % immutable_unaccent(${query})
               OR german_digraph_fold(ep.title) % german_digraph_fold(${query}))
          ${buildSearchableEpisodeFilter(sql, options.deniedGroupIds)}
          ${buildEpisodeAgeFilter(sql, options.ageRating)}
        ORDER BY "relevanceScore" DESC
        LIMIT ${limit}
    `) as unknown as EpisodeSearchResult[];
}

/**
 * Search episodes with full-text first, falling back to trigram.
 * Convenience function that combines both search methods.
 */
export async function searchEpisodes(
    sql: postgres.Sql,
    query: string,
    limit: number,
    seriesId: string | undefined,
    options: EpisodeSearchQueryOptions,
): Promise<EpisodeSearchResult[]> {
    const searchTerms = prepareSearchTerms(query);

    if (!searchTerms) {
        return [];
    }

    // Try full-text search first
    let results = await searchEpisodesFullText(sql, searchTerms, limit, seriesId, options);

    // Fall back to trigram search if no full-text results
    if (results.length === 0) {
        results = await searchEpisodesTrigram(sql, query, limit, seriesId, options);
    }

    return results;
}

// =============================================================================
// Episode Lookup Queries
// =============================================================================

/**
 * Find episode by series UUID, season number, and episode number.
 */
export async function findEpisodeByNumber(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
    episodeNumber: number,
): Promise<EpisodeLookupResult | null> {
    const rows = await sql<EpisodeLookupResult[]>`
        SELECT ep.id
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
          AND ep.season_number = ${seasonNumber}
          AND ep.episode_number = ${episodeNumber}
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Find episode by series external ID (tmdb/tvdb/imdb), season, and episode
 * number. Preferred over name-based lookup when the caller has authoritative
 * IDs (e.g. from Sonarr's calendar response with includeSeries=true).
 *
 * Returns the episode UUID plus the resolved series UUID.
 */
export async function findEpisodeBySeriesExternalId(
    sql: postgres.Sql,
    provider: 'tmdb' | 'tvdb' | 'imdb',
    externalId: string,
    seasonNumber: number,
    episodeNumber: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<EpisodeByNameLookupResult | null> {
    if (!externalId || externalId === '0') return null;
    const denied = access.deniedGroupIds;
    const age = access.ageRating;
    const rows = await sql<EpisodeByNameLookupResult[]>`
        SELECT
            ep.id,
            series.id as "seriesId",
            series.title as "seriesTitle",
            1.0::float as "similarityScore"
        FROM external_ids ei
        JOIN media_items series
            ON series.id = ei.media_id AND series.media_type = 'tv'
        JOIN media_items season
            ON season.parent_id = series.id AND season.media_type = 'season'
        JOIN media_items ep
            ON ep.parent_id = season.id AND ep.media_type = 'episode'
        WHERE ei.provider = ${provider}
          AND ei.external_id = ${externalId}
          AND ei.media_type = 'tv'
          AND ep.season_number = ${seasonNumber}
          AND ep.episode_number = ${episodeNumber}
          AND series.status = 'active'
          ${
              denied && denied.length > 0
                  ? sql`AND EXISTS (
              SELECT 1 FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE mfi.media_item_id = ep.id
                AND (mf.library_group_id IS NULL
                     OR mf.library_group_id != ALL(${denied}::uuid[]))
          )`
                  : sql``
          }
          ${
              age && age.maxAgeRating !== null
                  ? sql`AND (
              (series.age_rating IS NULL AND ${age.allowUnrated}::boolean)
              OR series.age_rating <= ${age.maxAgeRating}
          )`
                  : sql``
          }
        ORDER BY series.id ASC
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Find the series UUID for an external series ID, under the same access rules
 * as `findEpisodeBySeriesExternalId`. The library check passes when ANY of the
 * series' episodes has a file outside the denied groups, so a series the user
 * cannot see does not leak through a miss.
 *
 * Used when the S/E lookup by ID misses: the series is still known, so the
 * caller must not fall back to a title match that can land on a different
 * series of the same name.
 */
export async function findSeriesIdByExternalId(
    sql: postgres.Sql,
    provider: 'tmdb' | 'tvdb' | 'imdb',
    externalId: string,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<string | null> {
    if (!externalId || externalId === '0') return null;
    const denied = access.deniedGroupIds;
    const age = access.ageRating;
    const rows = await sql<{ id: string }[]>`
        SELECT series.id
        FROM external_ids ei
        JOIN media_items series
            ON series.id = ei.media_id AND series.media_type = 'tv'
        WHERE ei.provider = ${provider}
          AND ei.external_id = ${externalId}
          AND ei.media_type = 'tv'
          AND series.status = 'active'
          ${
              denied && denied.length > 0
                  ? sql`AND EXISTS (
              SELECT 1 FROM media_items season
              JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
              JOIN media_file_items mfi ON mfi.media_item_id = ep.id
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE season.parent_id = series.id
                AND season.media_type = 'season'
                AND (mf.library_group_id IS NULL
                     OR mf.library_group_id != ALL(${denied}::uuid[]))
          )`
                  : sql``
          }
          ${
              age && age.maxAgeRating !== null
                  ? sql`AND (
              (series.age_rating IS NULL AND ${age.allowUnrated}::boolean)
              OR series.age_rating <= ${age.maxAgeRating}
          )`
                  : sql``
          }
        ORDER BY series.id ASC
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Find episode by series name, season, and episode number — disambiguating
 * across multiple series that share the same title (e.g. UK and US "Glimmers",
 * UK and US "The Outpost") by preferring a series that *actually contains*
 * the requested S/E.
 *
 * Strategy: join series → season → episode in a single query, filter by
 * series name similarity AND matching season/episode numbers, then order
 * by similarity. Series that don't contain the episode are filtered out
 * by the JOIN, so a tie-on-title is automatically broken by "this one has
 * the episode".
 *
 * Returns the episode's UUID, plus the resolved series UUID
 * so callers can correct any earlier name-only series guess.
 */
export async function findEpisodeBySeriesName(
    sql: postgres.Sql,
    seriesName: string,
    seasonNumber: number,
    episodeNumber: number,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<EpisodeByNameLookupResult | null> {
    if (!seriesName?.trim()) return null;
    const denied = access.deniedGroupIds;
    const age = access.ageRating;
    const rows = await sql<EpisodeByNameLookupResult[]>`
        SELECT
            ep.id,
            series.id as "seriesId",
            series.title as "seriesTitle",
            GREATEST(
                similarity(immutable_unaccent(COALESCE(series.title, '')), immutable_unaccent(${seriesName})),
                similarity(immutable_unaccent(COALESCE(series.original_title, '')), immutable_unaccent(${seriesName}))
            ) as "similarityScore"
        FROM media_items ep
        JOIN media_items season
            ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN media_items series
            ON series.id = season.parent_id AND series.media_type = 'tv'
        WHERE ep.media_type = 'episode'
          AND ep.season_number = ${seasonNumber}
          AND ep.episode_number = ${episodeNumber}
          AND series.status = 'active'
          AND (
              similarity(immutable_unaccent(COALESCE(series.title, '')), immutable_unaccent(${seriesName})) >= 0.5
              OR similarity(immutable_unaccent(COALESCE(series.original_title, '')), immutable_unaccent(${seriesName})) >= 0.5
              OR similarity(german_digraph_fold(COALESCE(series.title, '')), german_digraph_fold(${seriesName})) >= 0.5
              OR similarity(german_digraph_fold(COALESCE(series.original_title, '')), german_digraph_fold(${seriesName})) >= 0.5
              OR immutable_unaccent(LOWER(series.title)) = immutable_unaccent(LOWER(${seriesName}))
              OR immutable_unaccent(LOWER(series.original_title)) = immutable_unaccent(LOWER(${seriesName}))
              OR german_digraph_fold(series.title) = german_digraph_fold(${seriesName})
              OR german_digraph_fold(series.original_title) = german_digraph_fold(${seriesName})
          )
          ${
              denied && denied.length > 0
                  ? sql`AND EXISTS (
              SELECT 1 FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE mfi.media_item_id = ep.id
                AND (mf.library_group_id IS NULL
                     OR mf.library_group_id != ALL(${denied}::uuid[]))
          )`
                  : sql``
          }
          ${
              age && age.maxAgeRating !== null
                  ? sql`AND (
              (series.age_rating IS NULL AND ${age.allowUnrated}::boolean)
              OR series.age_rating <= ${age.maxAgeRating}
          )`
                  : sql``
          }
        ORDER BY "similarityScore" DESC, series.id ASC
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Get all episodes for a series (via season hierarchy).
 * When an ordering context is provided, returns display numbers via COALESCE.
 *
 * `access` is REQUIRED. It used to be absent entirely, which made the function
 * safe only transitively: its one caller (the new-episodes route) resolved the
 * series UUID from rows that had already passed an access filter, so nothing
 * restricted could reach it. That invariant was undocumented and invisible at
 * the call site. The boundary is now applied here, at the series level
 * (`season.parent_id`), the same row the caller's upstream filter tests.
 */
export async function getSeriesEpisodesList(
    sql: postgres.Sql,
    seriesId: string,
    access: MediaAccessBoundary,
    options: {
        /**
         * Restrict to episodes that actually exist as files (`has_files` +
         * `status = 'active'`) — i.e. episodes a user can press play on.
         *
         * OFF by default: a series' episode list legitimately includes rows for
         * unaired episodes (that is what renders the "not yet aired" entries in
         * the series modal). Callers that ADVERTISE an episode must opt in, or
         * they promise content that does not exist — see the new-episodes feed,
         * which offered five unaired episodes of a show whose only released
         * episode the user had already watched.
         */
        playableOnly?: boolean;
    } = {},
): Promise<
    Array<{
        id: string;
        season_number: number;
        episode_number: number;
        title: string;
        /** ISO timestamp from premiere_date; null when the row has no air date. */
        air_date: string | null;
    }>
> {
    if (deniesEverything(access)) return [];
    return await sql`
        SELECT
            ep.id,
            COALESCE(eo.order_season_number, ep.season_number) AS season_number,
            COALESCE(eo.order_episode_number, ep.episode_number) AS episode_number,
            ep.title,
            to_char(ep.premiere_date::timestamp AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS air_date
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql)}
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
          ${options.playableOnly ? sql`AND ep.has_files = true AND ep.status = 'active'` : sql``}
          ${buildEpisodeLibraryFilter(sql, access.library)}
          ${buildEpisodeAgeFilter(sql, access.age)}
          ${buildUnmappedEpisodeFilterFragment(sql)}
        ORDER BY COALESCE(eo.order_season_number, ep.season_number) ASC,
                 COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number) ASC
    `;
}

/**
 * Get episodes for a specific season.
 * When an ordering context is provided, filters and sorts by display numbers.
 */
export async function getSeasonEpisodesList(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
): Promise<
    Array<{
        id: string;
        episode_number: number;
        title: string;
    }>
> {
    return await sql`
        SELECT
            ep.id,
            COALESCE(eo.order_episode_number, ep.episode_number) AS episode_number,
            ep.title
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql)}
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
          ${buildUnmappedEpisodeFilterFragment(sql)}
          AND COALESCE(eo.order_season_number, season.season_number) = ${seasonNumber}
        ORDER BY COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number) ASC
    `;
}

export interface NextSequentialEpisodeRow {
    id: string;
    title: string;
    season_number: number;
    episode_number: number;
    is_new_season: boolean;
    has_primary_image: boolean;
    overview: string | null;
    /** Episode runtime in seconds (null when unknown, undefined when not fetched).
     *  Carried so synthetic next-up items can populate duration instead of dropping it. */
    runtime_seconds?: number | null;
    has_files: boolean;
}

/**
 * Find the episode that plays sequentially after the given episode within the same series.
 *
 * Ordering-aware: uses the active series ordering when one is set (COALESCE falls through
 * to physical numbers otherwise), so the result matches the order the user sees in the UI.
 * `is_new_season` compares the next episode's *display* season to the current episode's
 * *display* season (not the physical column), so it stays correct under remapped orderings.
 *
 * Playback callers opt into `afterCurrentFile`: whole-file playback consumes all
 * default-file siblings, including entries with segment offsets. The cursor stays
 * at the requested episode and those siblings are skipped, so a hand-linked file
 * holding E37 + E41, or episodes of two seasons, does not jump over the episodes
 * between them. The default remains a logical single-episode step for
 * history/progress consumers.
 * `playableOnly` checks the default file that automatic playback will select,
 * rather than admitting an episode solely because an alternate file exists.
 *
 * Returns null when the current episode (or consumed file) is last in its series.
 */
export async function findNextSequentialEpisode(
    sql: postgres.Sql,
    seriesId: string,
    currentEpisodeId: string,
    options: {
        afterCurrentFile?: boolean;
        playableOnly?: boolean;
        access?: MediaAccessBoundary;
        /**
         * Playback chaining: after a special (season 0) only another special
         * follows, never S01E01. Next-up and continue-watching leave it off.
         */
        specialsStayInSeason?: boolean;
    } = {},
): Promise<NextSequentialEpisodeRow | null> {
    if (options.access && deniesEverything(options.access)) return null;
    const accessFilter = options.access
        ? sql`${buildLibraryAccessFilter(sql, options.access.library, 'mi')}
              ${buildSeriesOwnedAgeRatingFilter(sql, options.access.age, 'mi')}`
        : sql``;
    const rows = await sql<NextSequentialEpisodeRow[]>`
        WITH anchor_episode AS (
            SELECT ep.id,
                COALESCE(eo.order_season_number, ep.season_number) AS s,
                COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number) AS e
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            ${buildAutoEpisodeOrderingJoinFragment(sql)}
            WHERE ep.id = ${currentEpisodeId}
              AND ep.media_type = 'episode'
              AND season.parent_id = ${seriesId}
        ), current_ep AS (
            -- The cursor is the requested episode itself. After playback of a
            -- shared file its other episodes are excluded below instead of
            -- moving the cursor to the highest one: a file linked by hand can
            -- hold E37 + E41 (E38-E40 are files of their own) or episodes of
            -- two seasons, and the highest sibling would skip what lies between.
            SELECT id, s, e FROM anchor_episode
        )
        SELECT
            mi.id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number)::int AS season_number,
            COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)::int AS episode_number,
            (COALESCE(eo.order_season_number, mi.season_number) <> (SELECT s FROM anchor_episode)) AS is_new_season,
            (
                EXISTS (
                    SELECT 1
                    FROM provider_metadata pm
                    WHERE pm.media_id = mi.id
                      AND (pm.metadata ? 'still_path' OR pm.metadata ? 'poster_path')
                )
                -- Episodes commonly have no provider still; their thumbnail is a
                -- locally-extracted ffmpeg frame stored as image_candidates
                -- (source 'local', type 'thumb' or 'backdrop'). The image endpoint
                -- serves that frame, so the prompt must know it exists.
                OR EXISTS (
                    SELECT 1
                    FROM image_candidates ma
                    WHERE ma.media_item_id = mi.id
                      AND ma.source = 'local' AND NOT ma.suppressed
                      AND ma.artwork_type IN ('thumb', 'backdrop')
                      AND ma.file_path IS NOT NULL
                )
            ) AS has_primary_image,
            mi.overview,
            mi.runtime_seconds,
            mi.has_files
        FROM media_items mi
        JOIN media_items season
            ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        CROSS JOIN current_ep ce
        WHERE season.parent_id = ${seriesId}
          AND mi.media_type = 'episode'
          AND mi.id <> ${currentEpisodeId}
          ${
              options.afterCurrentFile
                  ? sql`AND NOT EXISTS (
              SELECT 1
              FROM media_file_items anchor
              JOIN media_file_items sibling
                ON sibling.file_id = anchor.file_id AND sibling.is_default = true
              WHERE anchor.media_item_id = ${currentEpisodeId}
                AND anchor.is_default = true
                AND sibling.media_item_id = mi.id
          )`
                  : sql``
          }
          ${
              options.playableOnly
                  ? sql`AND mi.status = 'active' AND EXISTS (
              SELECT 1 FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id AND mf.is_missing = false
              WHERE mfi.media_item_id = mi.id
                AND mfi.is_default = true
          )`
                  : sql``
          }
          AND (
              COALESCE(eo.order_season_number, mi.season_number),
              COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number),
              mi.id
          ) > (ce.s, ce.e, ce.id)
          ${
              options.specialsStayInSeason
                  ? sql`-- Season 0 (specials) never auto-advances into regular seasons.
                    AND (ce.s <> 0 OR COALESCE(eo.order_season_number, mi.season_number) = 0)`
                  : sql``
          }
          ${accessFilter}
          ${buildUnmappedEpisodeFilterFragment(sql, 'mi')}
        ORDER BY
            COALESCE(eo.order_season_number, mi.season_number) ASC,
            COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number) ASC,
            mi.id ASC
        LIMIT 1
    `;
    return rows[0] ?? null;
}

export interface EpisodeForNextUpRow {
    id: string;
    title: string;
    season_number: number;
    episode_number: number;
    overview: string | null;
    runtime_seconds: number | null;
    premiere_date: Date | string | null;
}

export interface FileSiblingEpisodeRow {
    id: string;
    episode_number: number | null;
    /** Physical season: a file an admin linked by hand may span two. */
    season_number: number | null;
    title: string | null;
    /**
     * Playback window of this episode inside the shared file, in ms. NULL on
     * both bounds means whole-file playback (single-episode file, or a combined
     * file whose split could not be derived — see utils/file-segments.ts).
     */
    start_offset_ms: string | null;
    end_offset_ms: string | null;
}

/**
 * Return all episode media_items that share the same default file as the
 * given episode, including the episode itself, in FILE order: by window start,
 * then link sort_order, then episode_number. For derived segments that is
 * episode order; a file an admin linked by hand can hold 9x20 before 9x19.
 *
 * A "combined" multi-episode file has two episode rows both linked to the
 * same media_files row via media_file_items (is_default = true). For a
 * normal single-episode file this returns exactly one row (the episode itself).
 */
export async function getFileSiblingEpisodes(
    sql: postgres.Sql,
    episodeId: string,
): Promise<FileSiblingEpisodeRow[]> {
    return await sql<FileSiblingEpisodeRow[]>`
        SELECT mi.id, mi.episode_number, mi.season_number, mi.title,
               mfi_sibling.start_offset_ms, mfi_sibling.end_offset_ms
        FROM media_file_items mfi_anchor
        JOIN media_file_items mfi_sibling
            ON mfi_sibling.file_id = mfi_anchor.file_id
            AND mfi_sibling.is_default = true
        JOIN media_items mi
            ON mi.id = mfi_sibling.media_item_id
            AND mi.media_type = 'episode'
        WHERE mfi_anchor.media_item_id = ${episodeId}
          AND mfi_anchor.is_default = true
        ORDER BY mfi_sibling.start_offset_ms ASC NULLS LAST,
                 mfi_sibling.sort_order ASC,
                 mi.episode_number ASC NULLS LAST, mi.id ASC
    `;
}

/**
 * Fetch the metadata fields needed to build an EffectiveNextUpRow for a
 * specific episode UUID. Used as a last-resort fallback when the durable
 * next-up query returns null during a rewatch (all episodes already watched,
 * so there is no "after the anchor" candidate yet).
 */
export async function findEpisodeForNextUp(
    sql: postgres.Sql,
    episodeId: string,
): Promise<EpisodeForNextUpRow | null> {
    const rows = await sql<EpisodeForNextUpRow[]>`
        SELECT
            mi.id,
            mi.title,
            COALESCE(eo.order_season_number, mi.season_number)::int AS season_number,
            COALESCE(eo.order_episode_number, mi.episode_number)::int AS episode_number,
            mi.overview,
            mi.runtime_seconds,
            mi.premiere_date
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
        WHERE mi.id = ${episodeId}
          AND mi.media_type = 'episode'
        LIMIT 1
    `;
    return rows[0] ?? null;
}
