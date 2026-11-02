// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browse Queries Module
 *
 * Queries for browsing and discovering media through various filters:
 * - Alphabetical browsing (A-Z mode)
 * - Library filtering
 * - Media type filtering
 * - Availability filtering
 *
 * @module queries/browse
 */

import type postgres from 'postgres';
import * as m from '$lib/paraglide/messages';
import type { MediaEmbedding } from '../connection.js';
import {
    buildMetadataLateralJoinFragment,
    buildProviderPriorityCase,
} from './builders/provider-metadata.builder.js';
import { keywordNameToSlug } from './metadata-aggregation.queries.js';
import { isMovie } from '../../utils/media-types.js';
import type { BrowseItem, BrowseGenreRow } from '$lib/schemas/api-browse-responses.js';
import { Logger } from '../../utils/logger.js';
import {
    getPrimaryExternalIdProvider,
    getMetadataProviderChain,
} from '../../utils/provider-config.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildLibraryGroupFilter } from './builders/library-group.builder.js';
import { buildAgeRatingFilter, type AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { PG_TEXT_OID } from './builders/keyset-cursor.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildTrackLanguageFilter } from './builders/track-language.builder.js';
import { buildQualityFilter } from './builders/quality.builder.js';
import {
    KEYWORD_ALIAS_SQL_PAIRS,
    curatedKeywordsForPrefix,
    keywordGroupMembers,
} from '$lib/shared/keyword-vocabulary.js';
import { getLibraryGroupsWithCounts } from './library-groups.queries.js';
import { GenreService } from '../../services/genre.service.js';

const logger = Logger.for('BrowseQueries');

// =============================================================================
// Types
// =============================================================================

export interface RecentlyAddedMediaOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    limit?: number;
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
}

export interface RecentlyAddedMediaRow {
    id: string;
    title: string;
    media_type: string;
    overview: string | null;
}

/**
 * Newness mode for the filterable Recently Added surface.
 *
 * - 'everything': newest file anywhere in the title bumps it. Mirrors the
 *   existing carousel exactly (orders on the precomputed library_added_at /
 *   created_at, which already equals the propagated MAX file-added time).
 * - 'seasons': a whole NEW season debut bumps the title; extra episodes added
 *   to an existing season do not. Recency = MAX over each season's first-file
 *   time (and the title's own files).
 * - 'titles': only brand-new titles (first became playable recently). Recency =
 *   MIN file-added time across the whole hierarchy, so a long-standing show
 *   that merely gained an episode stays put.
 */
export type RecentlyAddedNewness = 'everything' | 'seasons' | 'titles';

export interface FilteredRecentlyAddedOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    limit?: number;
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
    /** Restrict to titles with at least one file in this library group. */
    groupId?: string;
    /** Case-insensitive title substring filter. */
    query?: string;
    /** Recency-computation mode. Defaults to 'everything'. */
    newness: RecentlyAddedNewness;
}

/** Sort order for the A-Z browse item query. Defaults to 'title_asc'. */
export type AlphabeticalBrowseSort =
    'title_asc' | 'title_desc' | 'added_desc' | 'year_desc' | 'year_asc' | 'rating_desc';

export interface AlphabeticalBrowseOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    limit?: number;
    offset?: number;
    letter?: string;
    availableOnly?: boolean;
    groupId?: string;
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
    audioLangs?: string[];
    subLangs?: string[];
    includeUnknown?: boolean;
    resolutions?: string[];
    hdr?: string[];
    codecs?: string[];
    qualityIncludeUnknown?: boolean;
    /** Item ordering. Defaults to 'title_asc' (the historical alphabetical order). */
    sort?: AlphabeticalBrowseSort;
    /**
     * Restrict to titles carrying this genre name (exact match, e.g. "Science
     * Fiction"). Uses the SAME best-source-per-title rule as `getMediaByGenre`,
     * so `/browse/az?genre=X` and `/browse/genre/X` agree on membership.
     */
    genreName?: string;
    /**
     * Restrict to titles carrying this keyword, matched against the existing
     * `media_keywords` projection. Values are the projection's own normalized
     * form — lowercased, spaces preserved (`whodunit`, `time travel`) — NOT
     * slugs. Input is lowercased at the boundary, so matching is effectively
     * case-insensitive (unlike `genreName`, which is case-sensitive).
     *
     * Deliberately NOT narrowed by `keyword_type`: keywords are additive across
     * providers, so a title tagged by mdblist and by tmdb carries both. This
     * matches the all-providers behaviour in `search-filter.builder.ts`.
     */
    keyword?: string;
    /**
     * Free-text narrowing over the title columns — "search within this slice".
     *
     * Composes with every other filter here, which is the whole point: a viewer
     * who narrowed to Documentaries / 4K and then types a title must search THAT
     * slice, not the whole library. `/api/v1/search` cannot serve this — it fans
     * out over six sources for which `res`/`hdr`/`codec`/`groupId` are
     * meaningless, and it is discovery-scoped rather than library-local.
     *
     * Substring ILIKE rather than the `search_vector` FTS column: this backs a
     * filter box where typing "dun" must match "Dune" mid-word, which word-based
     * FTS does not do. Matched unaccented so "amelie" finds "Amélie" — that form
     * has its own trigram index (idx_media_items_title_unaccent_trgm).
     *
     * OVERRIDES `letter` (see the effective-letter gate in getMediaAlphabetical):
     * "titles starting with D" and "titles matching 'dune'" are competing
     * intents, and the A-Z rail is hidden while a query is active.
     */
    query?: string;
}

export interface AlphabeticalBrowseResult {
    items: MediaEmbedding[];
    totalCount: number;
}

export interface LibraryInfo {
    id: string;
    name: string;
    itemCount: number;
    mediaType: 'movie' | 'tv' | 'mixed';
    icon?: string;
    description?: string;
}

/**
 * Decoded keyset cursor for `getMediaByGenre` — mirrors the
 * `(popularity DESC NULLS LAST, mi.id DESC)` ordering (Gate H2). `popularity` is
 * the raw `media_scalars.popularity::text` rendering (exact `numeric` — NOT a
 * float round-trip, F4) or `null` for the NULL-popularity group (Gate D2b carry:
 * local-only/unscored items are paged, never hidden). `id` is the unique tiebreak.
 */
export interface GenreCursor {
    popularity: string | null;
    id: string;
}

/**
 * Paging mode for `getMediaByGenre`. Discriminated union so offset and keyset
 * paging cannot both be supplied. Cursor mode is opt-in; offset stays default.
 */
export type GenrePage =
    { mode: 'offset'; offset: number } | { mode: 'cursor'; cursor: GenreCursor };

export interface GenreBrowseOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    limit?: number;
    /** Row offset for pagination (default 0). Ignored when `page` is a cursor. */
    offset?: number;
    /** Opt-in keyset paging. When absent, falls back to offset (`offset`). */
    page?: GenrePage;
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
}

export interface GenreBrowseRow {
    genre_name: string;
    item_count: number;
}

export interface GenreMediaRow {
    id: string;
    title: string;
    media_type: string;
    overview: string | null;
    community_rating: number | null;
    year: number | null;
    /**
     * `media_scalars.popularity::text` — the exact numeric rendering used to mint
     * the next keyset cursor (never the lossy `::float` `community_rating`). Null
     * for NULL-popularity rows. Only consumed by the cursor def; kept a bare string.
     */
    popularity_cursor?: string;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Get recently added top-level media items (movies and series).
 * Filters to active items with available files (including child items).
 *
 * @param sql - Postgres SQL instance
 * @param options - Media type filter and result limit
 * @returns Array of recently added media items
 */
export async function getRecentlyAddedMedia(
    sql: postgres.Sql,
    options: RecentlyAddedMediaOptions,
): Promise<RecentlyAddedMediaRow[]> {
    const { mediaType = 'all', limit = 50, access } = options;
    if (deniesEverything(access)) return [];

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;

        const results = await sql<RecentlyAddedMediaRow[]>`
            SELECT mi.id, mi.title, mi.media_type, mi.overview
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.parent_id IS NULL
              ${mediaTypeFilter}
              ${buildAgeRatingFilter(sql, access.age)}
              ${buildLibraryAccessFilter(sql, access.library)}
              AND mi.has_files = true
            ORDER BY COALESCE(mi.library_added_at, mi.created_at) DESC
            LIMIT ${limit}
        `;

        return results;
    } catch (error) {
        logger.error('Failed to get recently added media', error as Error, options);
        return [];
    }
}

/**
 * Get recently added top-level media items with a configurable "newness" mode,
 * plus optional library-group and title-search filters.
 *
 * Backs the filterable /browse "Recently Added" surface. Same row shape as
 * {@link getRecentlyAddedMedia} (id, title, media_type, overview) so the route
 * mapping is identical. WHERE always enforces: status='active',
 * parent_id IS NULL, has_files=true, age filter, library-access (denied)
 * filter; then layers the optional group + title filters.
 *
 * The three modes differ only in how the per-title recency timestamp is
 * computed from media_files.created_at across the series→season→episode
 * hierarchy (see {@link RecentlyAddedNewness}). 'everything' reuses the cheap
 * precomputed ordering (library_added_at) so it matches the current carousel
 * byte-for-byte; 'seasons' and 'titles' use LATERAL joins over the file rows.
 *
 * @param sql - Postgres SQL instance
 * @param options - Filters, limit, and newness mode
 * @returns Array of recently added media items, newest-recency first
 */
export async function getFilteredRecentlyAddedMedia(
    sql: postgres.Sql,
    options: FilteredRecentlyAddedOptions,
): Promise<RecentlyAddedMediaRow[]> {
    const { mediaType = 'all', limit = 40, access, groupId, query, newness } = options;
    if (deniesEverything(access)) return [];

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;

        // Positive library-group filter: keep titles with at least one file in
        // groupId anywhere in their hierarchy (self / season / episode). Reuses
        // the proven walk-up builder shared with A-Z browse.
        const groupFilter = buildLibraryGroupFilter(sql, groupId);

        // Title search: parameterized ILIKE with LIKE wildcards escaped so a
        // user-supplied '%' / '_' is treated literally.
        const trimmedQuery = query?.trim();
        const titleFilter =
            trimmedQuery && trimmedQuery.length > 0
                ? sql`AND mi.title ILIKE ${'%' + trimmedQuery.replace(/[%_\\]/g, '\\$&') + '%'} ESCAPE '\\'`
                : sql``;

        // GENRE-FILTER SLOT: a future `genreName` option would add an
        // `AND EXISTS (... jsonb_array_elements(pm.metadata->'genres') ...)`
        // fragment here (see getMediaByGenre). Omitted for now to keep the
        // signature param-free under the zero-warnings lint policy.

        // 'everything' reuses the precomputed ordering key so it matches the
        // existing carousel exactly — no LATERAL join needed.
        if (newness === 'everything') {
            const results = await sql<RecentlyAddedMediaRow[]>`
                SELECT mi.id, mi.title, mi.media_type, mi.overview
                FROM media_items mi
                WHERE mi.status = 'active'
                  AND mi.parent_id IS NULL
                  ${mediaTypeFilter}
                  ${buildAgeRatingFilter(sql, access.age)}
                  ${buildLibraryAccessFilter(sql, access.library)}
                  ${groupFilter}
                  ${titleFilter}
                  AND mi.has_files = true
                ORDER BY COALESCE(mi.library_added_at, mi.created_at) DESC, mi.id
                LIMIT ${limit}
            `;
            return results;
        }

        if (newness === 'titles') {
            // 'titles': first time the title became playable = MIN file-added
            // time across the whole hierarchy. A long-standing show that merely
            // gained a new episode keeps its old (small) recency and drops off.
            //
            // PERF: first_file_at is materialized (migration 16.119.0) and kept
            // fresh by refreshRecentlyAddedRecency, so this orders directly on
            // an indexed column instead of recomputing the whole file-hierarchy
            // aggregation per candidate row on every request (~938ms on prod).
            const results = await sql<RecentlyAddedMediaRow[]>`
                SELECT mi.id, mi.title, mi.media_type, mi.overview
                FROM media_items mi
                WHERE mi.status = 'active'
                  AND mi.parent_id IS NULL
                  ${mediaTypeFilter}
                  ${buildAgeRatingFilter(sql, access.age)}
                  ${buildLibraryAccessFilter(sql, access.library)}
                  ${groupFilter}
                  ${titleFilter}
                  AND mi.has_files = true
                ORDER BY mi.first_file_at DESC NULLS LAST,
                         COALESCE(mi.library_added_at, mi.created_at) DESC, mi.id
                LIMIT ${limit}
            `;
            return results;
        }

        // newness === 'seasons': latest season-debut = MAX over each season's
        // first-file time (and the title's own files' MIN). Adding episodes to
        // an existing season does not move that season's MIN, so it does not
        // bump the title.
        //
        // PERF: season_debut_at is materialized (migration 16.119.0) and kept
        // fresh by refreshRecentlyAddedRecency — same rationale as 'titles' above.
        const results = await sql<RecentlyAddedMediaRow[]>`
            SELECT mi.id, mi.title, mi.media_type, mi.overview
            FROM media_items mi
            WHERE mi.status = 'active'
              AND mi.parent_id IS NULL
              ${mediaTypeFilter}
              ${buildAgeRatingFilter(sql, access.age)}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${groupFilter}
              ${titleFilter}
              AND mi.has_files = true
            ORDER BY mi.season_debut_at DESC NULLS LAST,
                     COALESCE(mi.library_added_at, mi.created_at) DESC, mi.id
            LIMIT ${limit}
        `;
        return results;
    } catch (error) {
        logger.error('Failed to get filtered recently added media', error as Error, options);
        return [];
    }
}

/**
 * Recompute `media_items.first_file_at` and `.season_debut_at` for the given
 * top-level title ids (or every active top-level movie/tv title when
 * `mediaIds` is omitted/empty). Backs the materialized recency columns that
 * {@link getFilteredRecentlyAddedMedia}'s 'titles'/'seasons' newness modes now
 * ORDER BY directly (migration 16.119.0) instead of recomputing the file-
 * hierarchy aggregation per request.
 *
 * Set-based (one UPDATE ... FROM statement, no per-row loop). LEFT JOINs so a
 * title that lost every file gets its recency reset to NULL rather than left
 * stale. Rows whose value is already current are skipped (IS DISTINCT
 * FROM): a full refresh used to rewrite every title row twice per call. Callers should treat this as best-effort — failures must never fail
 * the ingest path that triggered them.
 *
 * Was two independent UPDATEs, each re-deriving the SAME episode->season->
 * title file union from scratch (prod slow-query log, 2026-09-26: 20 calls/
 * 4.3h each, p50 ~350ms, ~500ms in a prod EXPLAIN — ~1000ms total per call,
 * dominated by the media_items/media_file_items/media_files joins run TWICE).
 * Collapsed into one pass: `file_events` computes each file's `(title_id,
 * season_key)` once — `season_key` is the season id for an episode's file, or
 * the title's own id for a file attached directly to the title (a movie, or
 * a season-less special) — then a single window `MIN(created_at) OVER
 * (PARTITION BY title_id, season_key)` gives the per-season first-file time
 * in the same pass a plain `MIN(created_at) GROUP BY title_id` gives the
 * all-time first-file time. `MAX()` of the per-season minimums over each
 * title reproduces the old two-level "latest-debuting season's first file"
 * aggregation exactly (prod verified: 0 mismatches across all 20,352 eligible
 * titles against the old two-query result) at ~425ms in a prod EXPLAIN
 * (~2.3x). `file_events` joins `eligible` early (not just at the final
 * UPDATE) so a scoped call over a handful of `mediaIds` doesn't still walk
 * every episode's file — that scoping is what made the old per-statement cost
 * acceptable in the caller-scoped case; it must not regress here.
 *
 * @param sql       - Postgres SQL instance
 * @param mediaIds  - Top-level title ids to refresh; omit/empty = refresh all
 */
export async function refreshRecentlyAddedRecency(
    sql: postgres.Sql,
    mediaIds?: string[],
): Promise<string[]> {
    const scopeToIds =
        mediaIds && mediaIds.length > 0 ? sql`AND el.id = ANY(${mediaIds}::uuid[])` : sql``;

    // System-wide (or caller-scoped) maintenance recompute of a derived
    // recency column — not a user-facing content listing, so library/age
    // access scoping does not apply here.

    const changed = await sql<{ id: string }[]>`
        WITH eligible AS (
            SELECT id
            FROM media_items el
            WHERE el.parent_id IS NULL
              AND el.status = 'active'
              AND el.media_type IN ('movie', 'tv')
              ${scopeToIds}
        ),
        file_events AS (
            SELECT mfi.media_item_id AS title_id, mfi.media_item_id AS season_key, mf.created_at
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            JOIN eligible el ON el.id = mfi.media_item_id
            UNION ALL
            SELECT s.parent_id AS title_id, s.id AS season_key, mf.created_at
            FROM media_items s
            JOIN eligible el ON el.id = s.parent_id
            JOIN media_items e ON e.parent_id = s.id
            JOIN media_file_items mfi ON mfi.media_item_id = e.id
            JOIN media_files mf ON mf.id = mfi.file_id
        ),
        agg AS (
            SELECT title_id,
                   MIN(created_at) AS overall_recency,
                   MAX(season_min) AS season_recency
            FROM (
                SELECT title_id, created_at,
                       MIN(created_at) OVER (PARTITION BY title_id, season_key) AS season_min
                FROM file_events
            ) x
            GROUP BY title_id
        )
        UPDATE media_items mi
        SET first_file_at = agg.overall_recency,
            season_debut_at = agg.season_recency
        FROM eligible el
        LEFT JOIN agg ON agg.title_id = el.id
        WHERE mi.id = el.id
          AND (mi.first_file_at IS DISTINCT FROM agg.overall_recency
               OR mi.season_debut_at IS DISTINCT FROM agg.season_recency)
        RETURNING mi.id
    `;

    // A title whose recency moved (first file gained, a season debuted, files
    // removed) changes the browse "Recently added" row. The refresh has
    // committed by now, so the invalidation below cannot be followed by a
    // re-warm that caches the old order.
    const changedIds = changed.map((r) => r.id);
    await invalidateBrowseCachesForRecencyChange(changedIds);
    return changedIds;
}

/**
 * Schedule the coalesced browse-cache invalidation (this process and, over the
 * cache bus, every other process's L1) for titles whose recency just changed.
 * Never throws: the refresh itself already succeeded.
 */
async function invalidateBrowseCachesForRecencyChange(changedIds: string[]): Promise<void> {
    if (changedIds.length === 0) return;
    try {
        const { cacheInvalidation } = await import('$lib/server/cache/index.js');
        // The log keeps the ids it is given; a first scan can change thousands.
        await cacheInvalidation.onContentAdded(changedIds.slice(0, 100));
    } catch {
        // Non-fatal: the caches expire on their TTL.
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Refresh the recency columns for the top-level titles that own `mediaItemIds`
 * (a title, season, episode, or anything deeper). Walks each id up to its root
 * (`parent_id IS NULL`, bounded at depth 10 like the has_files chain walk), then
 * calls the scoped {@link refreshRecentlyAddedRecency}.
 *
 * For ingest/removal paths that touch a handful of items and have no scan-wide
 * refresh of their own (the file watcher, file-delta-ingest). Ids that are not
 * uuids are dropped (a cast error would fail the whole batch), and an empty or
 * unresolvable set is a no-op: passing an empty list straight to
 * {@link refreshRecentlyAddedRecency} would drop its scope predicate and
 * recompute the whole library.
 */
export async function refreshRecentlyAddedRecencyForItems(
    sql: postgres.Sql,
    mediaItemIds: string[],
): Promise<string[]> {
    const ids = [...new Set(mediaItemIds.filter((id) => UUID_RE.test(id)))];
    if (ids.length === 0) return [];

    // Ancestor resolution only, no user-facing listing, so library/age access
    // scoping does not apply (same as refreshRecentlyAddedRecency).
    const topLevel = await sql<{ top_id: string }[]>`
        WITH RECURSIVE up AS (
            SELECT id, parent_id, 1 AS depth
            FROM media_items
            WHERE id = ANY(${ids}::uuid[])
            UNION ALL
            SELECT p.id, p.parent_id, up.depth + 1
            FROM media_items p
            JOIN up ON p.id = up.parent_id
            WHERE up.depth < 10
        )
        SELECT DISTINCT id AS top_id FROM up WHERE parent_id IS NULL
    `;
    const topIds = topLevel.map((r) => r.top_id);
    if (topIds.length === 0) return [];

    return refreshRecentlyAddedRecency(sql, topIds);
}

export interface LocalAvailableIdsOptions {
    /** external_ids.provider to match (e.g. the primary ID provider). */
    provider: string;
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
}

export interface LocalAvailableIdRow {
    external_id: string;
    media_type: string;
}

/**
 * Get the (external_id, media_type) pairs for media that is locally available
 * to the caller — i.e. has files the caller may access. Used to mark
 * TMDB-discovery rows on /browse as playable; since /browse is always
 * library-local, anything NOT in this set is dropped from the keyword sections.
 *
 * Requires `mi.has_files = true`: the media_files join alone is insufficient,
 * because orphaned media_file_items/media_files rows can outlive a
 * has_files=false item and would otherwise leak it as available. The join is
 * kept solely for per-file `library_group_id` scoping (a media item may have
 * files spread across multiple library groups, some denied).
 */
export async function getLocalAvailableExternalIds(
    sql: postgres.Sql,
    options: LocalAvailableIdsOptions,
): Promise<LocalAvailableIdRow[]> {
    const { provider, access } = options;
    if (deniesEverything(access)) return [];

    // Derive the legacy predicate inputs from the boundary so the two query
    // shapes below stay byte-identical to the pre-migration SQL. `all` / `any`
    // collapse to null (no predicate), exactly as before.
    const deniedGroupIds: string[] | null =
        access.library.kind === 'denyGroups' ? access.library.ids : null;
    const ageRating: AgeRatingFilterParams | null =
        access.age.kind === 'limit'
            ? { maxAgeRating: access.age.maxAgeRating, allowUnrated: access.age.allowUnrated }
            : null;

    const hasGroupRestriction = !!(deniedGroupIds && deniedGroupIds.length > 0);
    const hasAgeRestriction = !!(ageRating && ageRating.maxAgeRating !== null);

    try {
        // Fast path for unrestricted callers: `mi.has_files = true` already
        // guarantees the item is locally playable, so the media_file_items /
        // media_files joins (needed only to scope per-file library_group_id) are
        // pure overhead — they also fan each item out to one row per file, which
        // the DISTINCT then has to collapse. Skipping them roughly halves the
        // query time on prod (~500ms → ~190ms). The join-based query is kept
        // verbatim for the restricted case where per-file group scoping matters.
        if (!hasGroupRestriction && !hasAgeRestriction) {
            const rows = await sql<LocalAvailableIdRow[]>`
                SELECT ei.external_id, mi.media_type
                FROM external_ids ei
                JOIN media_items mi ON mi.id = ei.media_id
                WHERE ei.provider = ${provider}
                  AND mi.status = 'active'
                  AND mi.has_files = true
                LIMIT 50000
            `;
            return rows;
        }

        const rows = await sql<LocalAvailableIdRow[]>`
            SELECT DISTINCT ei.external_id, mi.media_type
            FROM external_ids ei
            JOIN media_items mi ON mi.id = ei.media_id
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE ei.provider = ${provider}
              AND mi.status = 'active'
              AND mi.has_files = true
              ${
                  hasGroupRestriction
                      ? sql`AND (mf.library_group_id IS NULL
                               OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))`
                      : sql``
              }
              ${
                  hasAgeRestriction
                      ? sql`AND (
                          (mi.age_rating IS NULL AND ${ageRating.allowUnrated}::boolean)
                          OR mi.age_rating <= ${ageRating.maxAgeRating}
                      )`
                      : sql``
              }
            LIMIT 50000
        `;
        return rows;
    } catch (error) {
        logger.error('Failed to query local available external IDs', error as Error);
        return [];
    }
}

/**
 * Get media items alphabetically sorted for A-Z browse mode.
 * Supports filtering by media type, letter, availability, and library group.
 *
 * Features:
 * - Alphabetical pagination with letter filtering
 * - Library group filtering by group ID
 * - Availability filtering (media files presence)
 * - Media type filtering (movie/tv/all)
 * - Uses scalar subqueries for external IDs to prevent row duplication
 *
 * @param sql - Postgres SQL instance
 * @param options - Browse options (pagination, filters)
 * @returns Media items and total count
 */
/**
 * Free-text narrowing over the title columns — see
 * {@link AlphabeticalBrowseOptions.query}.
 *
 * Shared by the page read, its count, and all three facet-count reads. That
 * sharing is the point: a facet computed without the query would describe a
 * DIFFERENT set than the grid beside it, and a letter rail or genre count that
 * disagrees with the results is worse than no rail at all.
 *
 * `%` and `_` are escaped so a viewer typing them searches for the literal
 * character instead of silently matching everything, matching
 * audiobook-browse's own predicate. `original_title`/`english_title` are
 * included so a viewer can find a title by the name they know it under; all
 * three columns carry an unaccented trigram index.
 */
function buildTitleQueryFilter(
    sql: postgres.Sql,
    query: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const trimmed = query?.trim();
    if (!trimmed) return sql``;
    const pattern = `%${trimmed.replace(/([%_\\])/g, '\\$1')}%`;
    return sql`AND (
        immutable_unaccent(mi.title) ILIKE immutable_unaccent(${pattern})
        OR immutable_unaccent(COALESCE(mi.original_title, '')) ILIKE immutable_unaccent(${pattern})
        OR immutable_unaccent(COALESCE(mi.english_title, '')) ILIKE immutable_unaccent(${pattern})
    )`;
}

export async function getMediaAlphabetical(
    sql: postgres.Sql,
    options: AlphabeticalBrowseOptions,
): Promise<AlphabeticalBrowseResult> {
    const {
        mediaType = 'all',
        limit = 50,
        offset = 0,
        letter,
        availableOnly = true,
        groupId,
        access,
        audioLangs,
        subLangs,
        includeUnknown,
        resolutions,
        hdr,
        codecs,
        qualityIncludeUnknown,
        sort = 'title_asc',
        genreName,
        keyword,
        query,
    } = options;
    if (deniesEverything(access)) return { items: [], totalCount: 0 };

    try {
        const availabilityFragment = availableOnly ? sql`AND mi.has_files = true` : sql``;
        const titleQueryFragment = buildTitleQueryFilter(sql, query);
        const groupFragment = buildLibraryGroupFilter(sql, groupId);
        const genreFragment = buildGenreMembershipFilter(sql, genreName);
        const keywordFragment = buildKeywordMembershipFilter(sql, keyword);
        const languageFragment = buildTrackLanguageFilter(sql, {
            audioLangs,
            subLangs,
            includeUnknown,
        });
        const qualityFragment = buildQualityFilter(sql, {
            resolutions,
            hdr,
            codecs,
            includeUnknown: qualityIncludeUnknown,
        });
        // Effective sort key: the precomputed sort_title (Hangul romanized,
        // diacritics folded, articles stripped) with a defensive fallback to
        // LOWER(title) for any row an insert path left NULL. Compared under
        // COLLATE "C" so ordering is deterministic and locale-independent.
        const sortKey = sql`COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title))`;
        // Letter filter: '#' = anything that doesn't start with a Latin a-z
        // (digits, CJK, kana) — the reachable bucket for non-romanizable titles.
        const letterFragment = letter
            ? letter === '#'
                ? sql`AND ${sortKey} !~ '^[a-z]'`
                : sql`AND ${sortKey} LIKE ${letter.toLowerCase() + '%'}`
            : sql``;
        // A stale `letter` (e.g. left over in the URL/store from A-Z mode) must
        // not silently narrow non-alphabetical sorts — the jump-nav rail is
        // hidden client-side for those sorts, so a leftover letter is never an
        // intentional filter there. Only title_asc/title_desc honour it.
        //
        // An active `query` suppresses it for exactly the same reason, one axis
        // over: the rail is hidden while searching, so a letter left in the
        // filter bar is not an intentional narrowing — and "titles starting with
        // D" and "titles matching 'dune'" are competing intents. Query wins.
        const letterApplies = (sort === 'title_asc' || sort === 'title_desc') && !query?.trim();
        const effectiveLetterFragment = letterApplies ? letterFragment : sql``;
        // 'added_desc' narrows to top-level rows (parent_id IS NULL) so the
        // partial index idx_media_items_recently_added can be used — SAFE
        // because movie/tv rows returned by this query are always top-level
        // (parent_id NULL) already, so the result set is unchanged; only the
        // access path differs. Applied to BOTH count and item queries so the
        // totals stay consistent for this sort.
        const addedDescFragment = sort === 'added_desc' ? sql`AND mi.parent_id IS NULL` : sql``;

        // Get total count using UUID-based tables.
        // No provider-metadata join here: COUNT(*) never references pm, so the
        // per-row LATERAL lookup was pure overhead (it added a provider_metadata
        // probe for every candidate row — ~600ms on prod for the full library).
        const countResult = await sql<[{ count: string }]>`
            SELECT COUNT(*) as count
            FROM media_items mi
            WHERE mi.status = 'active'
              ${availabilityFragment}
              ${mediaType !== 'all' ? sql`AND mi.media_type = ${mediaType}` : sql`AND mi.media_type IN ('movie', 'tv')`}
              ${effectiveLetterFragment}
              ${titleQueryFragment}
              ${groupFragment}
              ${genreFragment}
              ${keywordFragment}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
              ${languageFragment}
              ${qualityFragment}
              ${addedDescFragment}
        `;
        const totalCount = Number.parseInt(countResult[0]?.count || '0');

        // Item ORDER BY, driven by `sort`. `mi.id` is always the final tiebreaker
        // so pagination stays stable within a sort. title_desc keeps rows using
        // the same sortKey as title_asc (COLLATE "C") but reversed.
        const orderByFragment: postgres.PendingQuery<postgres.Row[]> =
            sort === 'title_desc'
                ? sql`${sortKey} COLLATE "C" DESC, mi.id DESC`
                : sort === 'added_desc'
                  ? sql`COALESCE(mi.library_added_at, mi.created_at) DESC, mi.id DESC`
                  : sort === 'year_desc'
                    ? sql`mi.year DESC NULLS LAST, mi.id DESC`
                    : sort === 'year_asc'
                      ? sql`mi.year ASC NULLS LAST, mi.id ASC`
                      : sort === 'rating_desc'
                        ? sql`COALESCE(NULLIF(CASE WHEN pm.metadata->>'imdb_rating' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'imdb_rating')::float ELSE NULL END, 0), CASE WHEN pm.metadata->>'vote_average' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'vote_average')::float ELSE NULL END) DESC NULLS LAST, mi.id DESC`
                        : sql`${sortKey} COLLATE "C" ASC, mi.id ASC`;

        // Get items with pagination using UUID-based tables
        // Uses scalar subqueries for external_ids to avoid duplicate rows from multiple providers
        const results = await sql`
            SELECT
                mi.id as media_uuid,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as primary_ext_id,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                mi.media_type,
                mi.title,
                mi.original_title,
                mi.english_title,
                (pm.metadata->>'overview')::text as overview,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                    ELSE NULL
                END as genres,
                mi.year as release_year,
                (pm.metadata->>'vote_count')::integer as vote_count,
                (pm.metadata->>'popularity')::float as popularity,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                (pm.metadata->>'poster_path')::text as poster_path,
                (pm.metadata->>'backdrop_path')::text as backdrop_path,
                (pm.metadata->>'trailer_url')::text as trailer_url,
                CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                    ELSE NULL
                END as actors,
                CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                    ELSE NULL
                END as directors,
                CASE WHEN pm.metadata->>'imdb_rating' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'imdb_rating')::float ELSE NULL END as imdb_rating,
                CASE WHEN pm.metadata->>'vote_average' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'vote_average')::float ELSE NULL END as tmdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                mi.has_files as is_available,
                (NOT mi.has_files) as can_request,
                mi.created_at,
                mi.updated_at
            FROM media_items mi
            ${buildMetadataLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
              ${availabilityFragment}
              ${mediaType !== 'all' ? sql`AND mi.media_type = ${mediaType}` : sql`AND mi.media_type IN ('movie', 'tv')`}
              ${effectiveLetterFragment}
              ${titleQueryFragment}
              ${groupFragment}
              ${genreFragment}
              ${keywordFragment}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
              ${languageFragment}
              ${qualityFragment}
              ${addedDescFragment}
            ORDER BY ${orderByFragment}
            LIMIT ${limit}
            OFFSET ${offset}
        `;

        // Map results to MediaEmbedding format
        const items: MediaEmbedding[] = results.map((row) => ({
            id: 0, // Legacy field, not used with new schema
            internal_id: row.media_uuid as string | undefined,
            tmdb_id: /^\d+$/.test(String(row.primary_ext_id))
                ? Number(row.primary_ext_id as string)
                : null,
            primary_ext_id: /^\d+$/.test(String(row.primary_ext_id))
                ? Number(row.primary_ext_id as string)
                : null,
            imdb_id: row.imdb_id as string | undefined,
            // constrained: mediaType is 'movie' | 'tv' | 'all', and the WHERE
            // filters `= ${mediaType}` or `IN ('movie','tv')` on both branches.
            // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
            media_type: row.media_type as 'movie' | 'tv',
            title: row.title as string,
            original_title: row.original_title as string | undefined,
            english_title: row.english_title as string | undefined,
            overview: row.overview as string | undefined,
            genres: (row.genres as number[]) || [],
            release_year: row.release_year as number | undefined,
            vote_count: row.vote_count as number | undefined,
            popularity: row.popularity as number | undefined,
            runtime_minutes: row.runtime_minutes as number | undefined,
            poster_path: row.poster_path as string | undefined,
            backdrop_path: row.backdrop_path as string | undefined,
            trailer_url: row.trailer_url as string | undefined,
            actors: row.actors as string[] | undefined,
            directors: row.directors as string[] | undefined,
            imdb_rating: row.imdb_rating as number | undefined,
            tmdb_rating: row.tmdb_rating as number | undefined,
            rt_rating: row.rt_rating as number | undefined,
            rt_audience_score: row.rt_audience_score as number | undefined,
            is_available: row.is_available as boolean | undefined,
            can_request: row.can_request as boolean | undefined,
            created_at: row.created_at as Date,
            updated_at: row.updated_at as Date,
        }));

        return { items, totalCount };
    } catch (error) {
        logger.error('Failed to get media alphabetically', error as Error, options);
        // The API caches successful pages. An outage is not an empty library.
        throw error;
    }
}

export interface AlphabeticalBucketCount {
    /** A single letter A-Z, or '#' for titles not starting with a Latin letter. */
    bucket: string;
    count: number;
}

/**
 * Count A-Z browse items per first-letter bucket, using the same effective sort
 * key and access/availability filters as {@link getMediaAlphabetical}.
 *
 * Drives the A-Z jump-nav rail: lets the UI show which letters (and the '#'
 * bucket for non-Latin titles) have content, and disable empty ones. The '#'
 * bucket is what makes Hangul/CJK titles reachable in one tap.
 *
 * `genreName` IS honoured (unlike `letter`): with a genre selected the rail must
 * show which letters have content *within that genre*, or it would offer letters
 * that land on an empty grid.
 *
 * @param sql - Postgres SQL instance
 * @param options - Same browse options as getMediaAlphabetical (letter ignored;
 *   `sort` is accepted only so callers can pass it through uniformly — the
 *   bucket rail is only meaningful for title_asc/title_desc and callers
 *   should skip calling this for other sorts, but the query itself never
 *   applies a letter narrowing regardless of `sort`)
 * @returns Array of { bucket, count }, one row per non-empty bucket
 */
export async function getAlphabeticalBucketCounts(
    sql: postgres.Sql,
    options: AlphabeticalBrowseOptions,
): Promise<AlphabeticalBucketCount[]> {
    const {
        mediaType = 'all',
        availableOnly = true,
        groupId,
        access,
        audioLangs,
        subLangs,
        includeUnknown,
        resolutions,
        hdr,
        codecs,
        qualityIncludeUnknown,
        // Not otherwise referenced below: this query never applies a letter
        // narrowing, so there is nothing to gate on `sort` today. Accepted +
        // defaulted here purely so this function's options stay a safe subset
        // of AlphabeticalBrowseOptions if a future change adds letter support.
        sort = 'title_asc',
        genreName,
        keyword,
        query,
    } = options;
    void sort;
    if (deniesEverything(access)) return [];

    try {
        const availabilityFragment = availableOnly ? sql`AND mi.has_files = true` : sql``;
        const groupFragment = buildLibraryGroupFilter(sql, groupId);
        const genreFragment = buildGenreMembershipFilter(sql, genreName);
        const keywordFragment = buildKeywordMembershipFilter(sql, keyword);
        // The rail must offer only letters that have content under the ACTIVE
        // query, or it points at empty buckets.
        const titleQueryFragment = buildTitleQueryFilter(sql, query);
        const sortKey = sql`COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title))`;
        const languageFragment = buildTrackLanguageFilter(sql, {
            audioLangs,
            subLangs,
            includeUnknown,
        });
        const qualityFragment = buildQualityFilter(sql, {
            resolutions,
            hdr,
            codecs,
            includeUnknown: qualityIncludeUnknown,
        });

        const rows = await sql<{ bucket: string; count: string }[]>`
            SELECT
                CASE WHEN ${sortKey} ~ '^[a-z]' THEN UPPER(LEFT(${sortKey}, 1)) ELSE '#' END AS bucket,
                COUNT(*) AS count
            FROM media_items mi
            WHERE mi.status = 'active'
              ${availabilityFragment}
              ${mediaType !== 'all' ? sql`AND mi.media_type = ${mediaType}` : sql`AND mi.media_type IN ('movie', 'tv')`}
              ${titleQueryFragment}
              ${groupFragment}
              ${genreFragment}
              ${keywordFragment}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
              ${languageFragment}
              ${qualityFragment}
            GROUP BY bucket
        `;

        return rows.map((r) => ({
            bucket: r.bucket,
            count: Number.parseInt(r.count, 10),
        }));
    } catch (error) {
        logger.error('Failed to get alphabetical bucket counts', error as Error, options);
        return [];
    }
}

export interface GenreFacetCount {
    /** Genre name exactly as it must be passed back as `?genre=`. */
    genre: string;
    count: number;
}

/**
 * Count A-Z browse items per genre, under the same access/availability/type/
 * group/language/quality scoping as {@link getMediaAlphabetical}.
 *
 * This is the genre analogue of {@link getAlphabeticalBucketCounts}: it tells a
 * client which genres actually have content behind them for the *current* filter
 * set, so a genre rail can hide empties and show real counts instead of
 * hardcoding a genre list that drifts from the catalog.
 *
 * Facet semantics: every option is honoured EXCEPT `genreName` — the counts are
 * computed with the genre narrowing removed so the client can switch genres from
 * the same response (exactly how `letter` is ignored by the bucket counts). The
 * caller should pass `letter` only when it is actually in effect (A-Z sorts).
 * `keyword` (the `tag` axis) IS honoured — a genre count under an active tag
 * must count only titles that also carry that tag, matching what
 * `?genre=X&tag=Y` itself returns.
 *
 * Genre membership uses the same normalized `media_genres` projection and
 * best-source-per-title pick as {@link getGenreList} / {@link getMediaByGenre},
 * so a pill's count matches what `?genre=` then returns. Unlike `getGenreList`
 * there is NO minimum-count floor: a genre with a single title is still a real
 * destination, and hiding it would recreate the drift this fixes.
 *
 * RETHROWS on query failure (unlike its siblings here, which return `[]`) — same
 * reasoning as `getMediaByGenre`'s cursor mode: an empty facet is not a neutral
 * degradation, it reads as "this catalog has no genres", which is precisely the
 * false statement a caller would then cache and render as an empty rail. Callers
 * decide: `/browse/genres` surfaces it as 500 (its entire payload is this list),
 * while `/browse/az` degrades to an empty rail WITHOUT caching so the grid still
 * renders and a transient failure isn't pinned for the namespace TTL.
 *
 * @param sql - Postgres SQL instance
 * @param options - Same browse options as getMediaAlphabetical (`genreName`,
 *   `sort`, `offset` and `limit` are ignored)
 * @returns Array of { genre, count }, count-descending then name-ascending
 * @throws the underlying postgres error on query failure
 */
export async function getGenreFacetCounts(
    sql: postgres.Sql,
    options: AlphabeticalBrowseOptions,
): Promise<GenreFacetCount[]> {
    const {
        mediaType = 'all',
        availableOnly = true,
        letter,
        groupId,
        access,
        audioLangs,
        subLangs,
        includeUnknown,
        resolutions,
        hdr,
        codecs,
        qualityIncludeUnknown,
        keyword,
        query,
        // Accepted so callers can forward AlphabeticalBrowseOptions wholesale.
        // `genreName` MUST NOT narrow a facet over its own axis (see above), and
        // ordering is fixed (count DESC) — neither is referenced below.
        sort = 'title_asc',
        genreName,
    } = options;
    void sort;
    void genreName;
    if (deniesEverything(access)) return [];

    try {
        const availabilityFragment = availableOnly ? sql`AND mi.has_files = true` : sql``;
        const groupFragment = buildLibraryGroupFilter(sql, groupId);
        const keywordFragment = buildKeywordMembershipFilter(sql, keyword);
        const sortKey = sql`COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title))`;
        const letterFragment = letter
            ? letter === '#'
                ? sql`AND ${sortKey} !~ '^[a-z]'`
                : sql`AND ${sortKey} LIKE ${letter.toLowerCase() + '%'}`
            : sql``;
        const languageFragment = buildTrackLanguageFilter(sql, {
            audioLangs,
            subLangs,
            includeUnknown,
        });
        const qualityFragment = buildQualityFilter(sql, {
            resolutions,
            hdr,
            codecs,
            includeUnknown: qualityIncludeUnknown,
        });

        const chain = safeProviderChain();
        const srcRank = buildSourcePriorityCase(sql, chain);

        const rows = await sql<{ genre: string; count: number }[]>`
            WITH title_best AS (
                SELECT mg.media_id, MIN(${srcRank}) AS best_rank
                FROM media_genres mg
                WHERE ${buildGenreLabel(sql, 'mg')} IS NOT NULL
                  AND mg.source = ANY(${chain})
                GROUP BY mg.media_id
            )
            SELECT ${buildGenreLabel(sql, 'mg')} AS genre, COUNT(DISTINCT mg.media_id)::int AS count
            FROM media_genres mg
            JOIN title_best tb ON tb.media_id = mg.media_id AND ${srcRank} = tb.best_rank
            JOIN media_items mi ON mi.id = mg.media_id
            WHERE ${buildGenreLabel(sql, 'mg')} IS NOT NULL
              AND mg.source = ANY(${chain})
              AND mi.status = 'active'
              ${availabilityFragment}
              ${mediaType !== 'all' ? sql`AND mi.media_type = ${mediaType}` : sql`AND mi.media_type IN ('movie', 'tv')`}
              ${letterFragment}
              ${buildTitleQueryFilter(sql, query)}
              ${groupFragment}
              ${keywordFragment}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
              ${languageFragment}
              ${qualityFragment}
            GROUP BY 1
            ORDER BY count DESC, genre ASC
        `;

        return rows.map((r) => ({ genre: r.genre, count: r.count }));
    } catch (error) {
        logger.error('Failed to get genre facet counts', error as Error, options);
        throw error;
    }
}

export interface KeywordFacetCount {
    /** Keyword in the projection's normalized form — pass back verbatim as `?tag=`. */
    keyword: string;
    count: number;
}

/**
 * Keyword-axis facet counts — the keyword analogue of {@link getGenreFacetCounts},
 * over the existing `media_keywords` projection.
 *
 * Facet semantics: every option is honoured EXCEPT `keyword` — counts are
 * computed with the keyword narrowing removed so a client can switch tags from
 * the same response, exactly as the genre facet ignores `genreName`.
 *
 * NO minimum-count floor, matching the genre facet: a tag with a single title is
 * still a real destination. Cardinality is bounded two ways instead: the
 * curated-vocabulary gate in {@link queryKeywordFacets} (≤ ALLOWED_KEYWORDS)
 * and `options.max`, which every caller SHOULD set — omitting it emits no
 * LIMIT, and an un-capped facet on a large catalog is a multi-megabyte payload.
 *
 * COUNT(DISTINCT media_id) is required, not COUNT(*): the projection stores one
 * row per (source, keyword_type), so a title tagged by both mdblist and tmdb
 * would otherwise be counted twice and the facet would exceed the filter's total.
 *
 * RETHROWS on query failure, for the same reason getGenreFacetCounts does: an
 * empty facet is not a neutral degradation, it reads as "this catalog has no
 * tags" — a false statement a caller would cache for the namespace TTL.
 *
 * @param options - Browse scope; `max` caps the number of keywords returned.
 * @throws the underlying postgres error on query failure
 */
export async function getKeywordFacetCounts(
    sql: postgres.Sql,
    options: AlphabeticalBrowseOptions & { max?: number },
): Promise<KeywordFacetCount[]> {
    return queryKeywordFacets(sql, options, undefined, options.max);
}

/**
 * Prefix-matched keyword facets for the browse typeahead. Same facet semantics
 * and same rethrow policy as {@link getKeywordFacetCounts}.
 *
 * @param prefix - Raw user input; lowercased and matched against the curated
 *   vocabulary in memory (whole alias groups at a time), never interpolated
 *   into a SQL pattern.
 * @throws the underlying postgres error on query failure
 */
export async function searchKeywordFacets(
    sql: postgres.Sql,
    prefix: string,
    options: AlphabeticalBrowseOptions & { max?: number },
): Promise<KeywordFacetCount[]> {
    return queryKeywordFacets(sql, options, prefix, options.max ?? 20);
}

/**
 * Shared body for both keyword facet entry points, kept private so the two can
 * never drift on filters, ordering, or error policy.
 *
 * CURATED VOCABULARY GATE: both entry points OFFER keywords to a user, so both
 * are restricted to `ALLOWED_KEYWORDS`. The raw projection holds ~84k distinct
 * values on a large catalog, ~96% of them hyphenated mdblist slugs
 * (`whore-of-babylon`, `who-s-afraid-of-virginia-woolf`) plus near-duplicates of
 * the same concept (`whodunit` / `whodunnit` / `whodunnit-mystery` /
 * `whodunit-spoof`) — unusable as a public vocabulary, and the same reason
 * `fetchPopularKeywords` has always gated on this list.
 *
 * ALIAS GROUPS: curating the list did not by itself solve the near-duplicates —
 * it admitted `whodunit` AND `whodunnit-mystery`, which share a display label,
 * so the typeahead rendered two identical rows that filtered to different
 * subsets. Aliased slugs are therefore folded onto their canonical here (see
 * `KEYWORD_ALIASES`) and {@link buildKeywordMembershipFilter} widens `?tag=` to
 * the same group, so one row covers the concept and its count still holds.
 *
 * The whitelist is SLUG-keyed (`time-travel`), which matches the `mdblist`
 * slice of the projection. The `plain` slice holds provider keyword NAMES with
 * spaces (`time travel`), so those rows are simply not suggested — exactly the
 * same semantics `fetchPopularKeywords` has always had. This keeps the facet
 * self-consistent, which is what matters: whatever is offered, its count equals
 * what `?tag=<that value>` returns.
 *
 * The gate is deliberately NOT applied to {@link buildKeywordMembershipFilter}:
 * `?tag=<non-curated>` deep links still resolve, they are just not suggested.
 */
async function queryKeywordFacets(
    sql: postgres.Sql,
    options: AlphabeticalBrowseOptions,
    prefix: string | undefined,
    max: number | undefined,
): Promise<KeywordFacetCount[]> {
    const {
        mediaType = 'all',
        availableOnly = true,
        letter,
        groupId,
        access,
        audioLangs,
        subLangs,
        includeUnknown,
        resolutions,
        hdr,
        codecs,
        qualityIncludeUnknown,
        genreName,
        query,
        // A facet MUST NOT narrow over its own axis; ordering is fixed.
        sort = 'title_asc',
        keyword,
    } = options;
    void sort;
    void keyword;
    if (deniesEverything(access)) return [];

    const availabilityFragment = availableOnly ? sql`AND mi.has_files = true` : sql``;
    const groupFragment = buildLibraryGroupFilter(sql, groupId);
    const sortKey = sql`COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title))`;
    const letterFragment = letter
        ? letter === '#'
            ? sql`AND ${sortKey} !~ '^[a-z]'`
            : sql`AND ${sortKey} LIKE ${letter.toLowerCase() + '%'}`
        : sql``;
    const languageFragment = buildTrackLanguageFilter(sql, {
        audioLangs,
        subLangs,
        includeUnknown,
    });
    const qualityFragment = buildQualityFilter(sql, {
        resolutions,
        hdr,
        codecs,
        includeUnknown: qualityIncludeUnknown,
    });
    const genreFragment = buildGenreMembershipFilter(sql, genreName);
    const mediaTypeFragment =
        mediaType === 'all'
            ? sql`AND mi.media_type IN ('movie','tv')`
            : sql`AND mi.media_type = ${mediaType}`;

    // Prefix matching happens in JS over the 271-slug vocabulary rather than as
    // a SQL LIKE, because it has to select WHOLE alias groups (see
    // curatedKeywordsForPrefix): a group's count must never be computed over
    // just the member whose slug happened to match the prefix. It also collapses
    // the old `= ANY(curated) AND keyword LIKE 'p%'` pair into one predicate.
    const scannedKeywords = curatedKeywordsForPrefix(prefix ?? '');
    // `= ANY('{}')` would be correct but still pays for the whole scan+aggregate
    // to return nothing.
    if (scannedKeywords.length === 0) return [];

    const limitFragment = max !== undefined ? sql`LIMIT ${max}` : sql``;

    // Fold each alias onto its canonical BEFORE aggregating. Merging counts in
    // JS afterwards would double-count any title carrying two slugs of the same
    // group (COUNT(DISTINCT media_id) is per group, and the groups overlap), and
    // the facet would then exceed what `?tag=` actually returns.
    const rows = await sql<{ keyword: string; count: number }[]>`
        SELECT COALESCE(ka.canonical, mk.keyword) AS keyword,
               COUNT(DISTINCT mk.media_id)::int   AS count
        FROM media_keywords mk
        JOIN media_items mi ON mi.id = mk.media_id
        LEFT JOIN unnest(
                      ${KEYWORD_ALIAS_SQL_PAIRS.from as string[]}::text[],
                      ${KEYWORD_ALIAS_SQL_PAIRS.to as string[]}::text[]
                  ) AS ka(alias, canonical) ON ka.alias = mk.keyword
        WHERE mi.status = 'active'
          AND mi.parent_id IS NULL
          AND mk.keyword = ANY(${scannedKeywords as string[]})
          ${availabilityFragment}
          ${mediaTypeFragment}
          ${letterFragment}
          ${buildTitleQueryFilter(sql, query)}
          ${groupFragment}
          ${genreFragment}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
          ${languageFragment}
          ${qualityFragment}
        GROUP BY COALESCE(ka.canonical, mk.keyword)
        ORDER BY count DESC, keyword ASC
        ${limitFragment}
    `;

    return rows.map((r) => ({ keyword: r.keyword, count: r.count }));
}

/**
 * Get list of available library groups with media counts.
 *
 * Features:
 * - Queries library_groups table via the dedicated query module
 * - Aggregates media types to determine library type
 * - Only includes groups with available content
 * - Supports filtering out denied groups for per-user access
 * - Returns sorted by sort_order then name
 *
 * @param sql - Postgres SQL instance
 * @param access - REQUIRED access boundary. Use `unrestrictedAccess()` for a
 *   deliberately unfiltered read.
 * @returns Array of library information
 */
export async function getAvailableLibraries(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): Promise<LibraryInfo[]> {
    if (deniesEverything(access)) return [];
    // Delegate takes the legacy `(deniedGroupIds, maxAgeRating)` pair; derive it
    // from the boundary so the emitted SQL is unchanged.
    const deniedGroupIds: string[] | null =
        access.library.kind === 'denyGroups' ? access.library.ids : null;
    const maxAgeRating: number | null =
        access.age.kind === 'limit' ? access.age.maxAgeRating : null;
    try {
        const groups = await getLibraryGroupsWithCounts(sql, deniedGroupIds, maxAgeRating);

        return groups
            .filter((g) => g.browsable_item_count > 0)
            .map((g) => {
                const TV_TYPES = new Set(['tv', 'episode', 'season']);
                const MOVIE_TYPES = new Set(['movie']);
                const types = g.media_types.filter(Boolean);
                const hasMovie = types.some((t) => MOVIE_TYPES.has(t));
                const hasTv = types.some((t) => TV_TYPES.has(t));

                let mediaType: 'movie' | 'tv' | 'mixed';
                if (hasMovie && hasTv) {
                    mediaType = 'mixed';
                } else if (hasMovie) {
                    mediaType = 'movie';
                } else if (hasTv) {
                    mediaType = 'tv';
                } else {
                    mediaType = 'mixed';
                }

                return {
                    id: g.id,
                    name: g.name,
                    itemCount: g.browsable_item_count,
                    mediaType,
                    icon: g.icon ?? undefined,
                    description: g.description ?? undefined,
                };
            });
    } catch (error) {
        logger.error('Failed to get available libraries', error as Error);
        return [];
    }
}

/**
 * The configured metadata provider chain, filtered to safe identifiers. Genre
 * reads must be RESTRICTED to these sources (not merely ranked) so an out-of-chain
 * provider that happens to write object/scalar genres can never become a title's
 * "best" source — mirroring the old `buildGenreSourceLateralJoin`'s
 * `WHERE provider IN (chain)`.
 */
function safeProviderChain(): string[] {
    return getMetadataProviderChain().filter((p) => /^[a-z0-9_]+$/i.test(p));
}

/**
 * SQL fragment ranking `media_genres.source` by the provider `chain` (index 0 =
 * highest priority). Mirrors the per-title "highest provider that actually has
 * genres" pick that `buildGenreSourceLateralJoin` performed over the JSONB, but
 * against the normalized projection. Callers MUST also restrict rows to `chain`
 * (see `safeProviderChain`) — this only ranks.
 */
function buildSourcePriorityCase(
    sql: postgres.Sql,
    chain: string[],
    sourceCol = 'mg.source',
): postgres.PendingQuery<postgres.Row[]> {
    return sql.unsafe(buildProviderPriorityCase(chain, sourceCol));
}

const TMDB_GENRE_IDS = GenreService.getAllGenres().map((g) => g.id);
const TMDB_GENRE_NAMES = GenreService.getAllGenres().map((g) => g.name);

/**
 * SQL expression for a `media_genres` row's label — the name every genre
 * browse surface groups, counts and matches on. The TMDB `genre_id` is the
 * canonical key: most rows are id-only (`genre_name` NULL, because the TMDB
 * sync stores `genres` as bare ids) and the named rest are split across
 * metadata languages ("Comedy" vs "Komödie"). Matching the stored name found
 * 19 of 598 comedies in one prod library. A known TMDB id maps to its canonical
 * English name; any other id falls back to the stored name.
 */
function buildGenreLabel(
    sql: postgres.Sql,
    alias: 'mg' | '_mg' | '_mg2',
): postgres.PendingQuery<postgres.Row[]> {
    const t = sql.unsafe(alias);
    return sql`COALESCE((${TMDB_GENRE_NAMES}::text[])[array_position(${TMDB_GENRE_IDS}::int[], ${t}.genre_id)], ${t}.genre_name)`;
}

/**
 * WHERE-fragment (leading `AND`) restricting `mi` to titles that carry
 * `genreName`, under the SAME best-source-per-title rule `getMediaByGenre` uses:
 * only rows from the configured provider chain count, and only from the
 * highest-priority source that carries NAMED genres for that title. Written as a
 * correlated EXISTS (rather than the CTE form used by the standalone genre
 * queries) so it can be dropped into the existing A-Z item/count/bucket queries
 * without restructuring them.
 *
 * Membership therefore agrees with `/browse/genre/{name}` — the same title set,
 * just composed with A-Z's type/group/language/quality filters and sorts.
 *
 * @param sql - Postgres SQL instance
 * @param genreName - Exact browse name, case-insensitive search names, or undefined
 * @returns SQL fragment to append after existing WHERE conditions
 */
export function buildGenreMembershipFilter(
    sql: postgres.Sql,
    genreName: string | readonly string[] | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    if (!genreName || genreName.length === 0) return sql``;

    const chain = safeProviderChain();
    const srcRank = buildSourcePriorityCase(sql, chain, '_mg.source');
    const srcRankInner = buildSourcePriorityCase(sql, chain, '_mg2.source');

    // The stored-name arm keeps pre-canonical deep links (`?genre=Komödie`) working.
    return sql`AND EXISTS (
        SELECT 1
        FROM media_genres _mg
        WHERE _mg.media_id = mi.id
          AND ${
              typeof genreName === 'string'
                  ? sql`(${buildGenreLabel(sql, '_mg')} = ${genreName} OR _mg.genre_name = ${genreName})`
                  : sql`(lower(${buildGenreLabel(sql, '_mg')}) = ANY(${genreName.map((genre) => genre.toLowerCase())}) OR lower(_mg.genre_name) = ANY(${genreName.map((genre) => genre.toLowerCase())}))`
          }
          AND _mg.source = ANY(${chain})
          AND ${srcRank} = (
              SELECT MIN(${srcRankInner})
              FROM media_genres _mg2
              WHERE _mg2.media_id = mi.id
                AND ${buildGenreLabel(sql, '_mg2')} IS NOT NULL
                AND _mg2.source = ANY(${chain})
          )
    )`;
}

/**
 * Membership filter for a single keyword, over the existing `media_keywords`
 * projection (base schema 16.125.0).
 *
 * INDEX REALITY (measured with EXPLAIN, do not "correct" this back): the
 * correlated EXISTS is served by an `Index Only Scan using media_keywords_pkey`
 * — the PK leads on `media_id`, which is the column the correlation binds, so
 * that is the right plan for THIS shape. It is NOT served by
 * `idx_media_keywords_kw`, which is `(keyword_type, keyword)` and cannot be
 * probed by keyword alone. No `(keyword)`-leading index exists; a keyword-first
 * scan (the `/browse/tags` prefix query) therefore has no usable index.
 *
 * Deliberately NOT gated on `ALLOWED_KEYWORDS`: filtering accepts any keyword in
 * the projection so existing `?tag=` deep links resolve. Only the SUGGESTION
 * surfaces (see {@link getKeywordFacetCounts}) are restricted to the curated set.
 *
 * ALIAS GROUPS: the keyword is widened to its whole group (`whodunit` also
 * matches `whodunnit-mystery`) so a suggestion's count equals what selecting it
 * returns. Canonicalization runs first, so a legacy `?tag=whodunnit-mystery`
 * link resolves to the same set rather than to the alias alone. Everything
 * outside the alias map — including the entire non-curated long tail — is a
 * group of one and keeps its exact previous behaviour, equality against a single
 * literal, which is also the plan the comment above describes.
 *
 * @param sql     - Postgres SQL instance
 * @param keyword - Keyword in any case, or undefined for no narrowing
 * @returns SQL fragment to append after existing WHERE conditions
 */
function buildKeywordMembershipFilter(
    sql: postgres.Sql,
    keyword: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const normalized = keyword?.trim().toLowerCase();
    if (!normalized) return sql``;
    const members = keywordGroupMembers(normalized);
    const matchFragment =
        members.length === 1
            ? sql`_mk.keyword = ${members[0]}`
            : sql`_mk.keyword = ANY(${members as string[]})`;
    return sql`AND EXISTS (
        SELECT 1
        FROM media_keywords _mk
        WHERE _mk.media_id = mi.id
          AND ${matchFragment}
    )`;
}

/**
 * Get list of genres with item counts.
 *
 * Reads from the normalized `media_genres` projection (migration 16.122.0)
 * instead of detoasting provider_metadata.metadata per title. Per title we pick
 * the highest-priority `source` that carries NAMED genres and count distinct
 * titles per genre label (see `buildGenreLabel`) — reproducing the provider-resilient sourcing of the old
 * `buildGenreSourceLateralJoin` path (aggregated > tmdb; TV genres live on the
 * tmdb source). Id-only rows (genre_name IS NULL) count under their canonical
 * TMDB name.
 *
 * @param sql - Postgres SQL instance
 * @param options - Media type filter and result limit
 * @returns Array of genre names with counts, sorted by count descending
 */
export async function getGenreList(
    sql: postgres.Sql,
    options: GenreBrowseOptions,
): Promise<GenreBrowseRow[]> {
    const { mediaType = 'all', access } = options;
    if (deniesEverything(access)) return [];

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;
        const chain = safeProviderChain();
        const srcRank = buildSourcePriorityCase(sql, chain);

        const results = await sql<GenreBrowseRow[]>`
            WITH title_best AS (
                SELECT mg.media_id, MIN(${srcRank}) AS best_rank
                FROM media_genres mg
                WHERE ${buildGenreLabel(sql, 'mg')} IS NOT NULL
                  AND mg.source = ANY(${chain})
                GROUP BY mg.media_id
            )
            SELECT ${buildGenreLabel(sql, 'mg')} AS genre_name, COUNT(DISTINCT mg.media_id)::int AS item_count
            FROM media_genres mg
            JOIN title_best tb ON tb.media_id = mg.media_id AND ${srcRank} = tb.best_rank
            JOIN media_items mi ON mi.id = mg.media_id
            WHERE ${buildGenreLabel(sql, 'mg')} IS NOT NULL
              AND mg.source = ANY(${chain})
              AND mi.status = 'active'
              AND mi.parent_id IS NULL
              AND mi.has_files = true
              ${mediaTypeFilter}
              ${buildAgeRatingFilter(sql, access.age)}
              ${buildLibraryAccessFilter(sql, access.library)}
            GROUP BY 1
            HAVING COUNT(DISTINCT mg.media_id) >= 3
            ORDER BY item_count DESC
        `;

        return results;
    } catch (error) {
        logger.error('Failed to get genre list', error as Error, options);
        return [];
    }
}

/**
 * Get media items for a specific genre from provider_metadata.
 *
 * @param sql - Postgres SQL instance
 * @param genreName - Genre name to filter by (e.g. "Action", "Comedy")
 * @param options - Media type filter and result limit
 * @returns Array of media items in this genre
 */
export async function getMediaByGenre(
    sql: postgres.Sql,
    genreName: string,
    options: GenreBrowseOptions,
): Promise<GenreMediaRow[]> {
    const { mediaType = 'all', limit = 20, offset = 0, access } = options;
    if (deniesEverything(access)) return [];

    const page: GenrePage = options.page ?? { mode: 'offset', offset };

    // Gate D2b keyset predicate over `(popularity DESC NULLS LAST, mi.id DESC)`
    // (Gate H2). Mirrors the series feed: a non-NULL cursor carries the entire
    // NULL-popularity group (NULLS LAST puts it after every scored row); a
    // NULL-group cursor pages the remaining NULL rows by id. popularity is
    // `numeric` — bind the cursor as exact text pinned to OID 25 (TEXT) and cast
    // `::numeric`, NEVER `::float8` (F4: a float round-trip disagrees with the
    // numeric ORDER BY and poisons any future index). See keyset-cursor.builder.ts.
    const cursorPredicate =
        page.mode === 'cursor'
            ? page.cursor.popularity === null
                ? sql`AND ms.popularity IS NULL AND mi.id < ${page.cursor.id}::uuid`
                : sql`AND (
                      (ms.popularity IS NOT NULL
                       AND (ms.popularity, mi.id) < (${sql.typed(page.cursor.popularity, PG_TEXT_OID)}::numeric, ${page.cursor.id}::uuid))
                      OR ms.popularity IS NULL
                  )`
            : sql``;

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;

        // Genre membership comes from the normalized `media_genres` projection
        // (migration 16.122.0); overview + popularity now come from the
        // `media_scalars` projection (16.124.0) instead of the pm metadata lateral,
        // eliminating the last per-row detoast in this query. Both laterals pick
        // the highest-priority `source` per title using the SAME chain/ordering as
        // the old buildMetadataLateralJoin, so the winning row — and thus overview,
        // popularity, and the popularity sort — are unchanged.
        // Rank providers only for titles this query can return. Ranking every
        // discovery-only title before the library predicate needlessly repeats
        // work during cold Browse rebuilds (once per genre). These title predicates
        // already apply below; filtering here preserves each eligible title's
        // complete provider set. Library/age gates remain on the final rows.
        const chain = safeProviderChain();
        const srcRank = buildSourcePriorityCase(sql, chain);
        const srcRankMs = buildSourcePriorityCase(sql, chain, 's.source');
        const results = await sql<GenreMediaRow[]>`
            WITH title_best AS (
                SELECT mg.media_id, MIN(${srcRank}) AS best_rank
                FROM media_genres mg
                JOIN media_items mi ON mi.id = mg.media_id
                  AND mi.status = 'active'
                  AND mi.parent_id IS NULL
                  AND mi.has_files = true
                  ${mediaTypeFilter}
                WHERE ${buildGenreLabel(sql, 'mg')} IS NOT NULL
                  AND mg.source = ANY(${chain})
                GROUP BY mg.media_id
            ),
            matched AS MATERIALIZED (
                SELECT mg.media_id
                FROM media_genres mg
                JOIN title_best tb ON tb.media_id = mg.media_id AND ${srcRank} = tb.best_rank
                WHERE (${buildGenreLabel(sql, 'mg')} = ${genreName} OR mg.genre_name = ${genreName})
                  AND mg.source = ANY(${chain})
            )
            SELECT
                mi.id,
                mi.title,
                mi.media_type,
                ms.overview as overview,
                COALESCE(NULLIF(ms.imdb_rating, 0), NULLIF(ms.vote_average, 0))::float as community_rating,
                ms.popularity::text as popularity_cursor,
                mi.year
            FROM matched m
            JOIN media_items mi ON mi.id = m.media_id
            LEFT JOIN LATERAL (
                SELECT s.overview, s.popularity, s.imdb_rating, s.vote_average
                FROM media_scalars s
                WHERE s.media_id = mi.id AND s.source = ANY(${chain})
                ORDER BY ${srcRankMs}
                LIMIT 1
            ) ms ON true
            WHERE mi.status = 'active'
              AND mi.parent_id IS NULL
              AND mi.has_files = true
              ${mediaTypeFilter}
              ${buildAgeRatingFilter(sql, access.age)}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${cursorPredicate}
            ORDER BY ms.popularity DESC NULLS LAST, mi.id DESC
            ${
                page.mode === 'cursor'
                    ? sql`LIMIT ${limit + 1}`
                    : sql`LIMIT ${limit} OFFSET ${page.offset}`
            }
        `;

        return results;
    } catch (error) {
        logger.error('Failed to get media by genre', error as Error, {
            genreName,
            ...options,
        });
        // F8: in cursor mode an empty array reads as hasMore:false, silently
        // ENDING the client's pagination on a transient error. Propagate instead
        // so the def surfaces a real error; offset mode keeps its lenient [].
        if (page.mode === 'cursor') throw error;
        return [];
    }
}

/**
 * Total count of library items in a genre, under the same scoping as
 * getMediaByGenre (active, top-level, has_files, media-type + age + library
 * filters). Powers totalCount/hasMore for the paginated genre browse route.
 */
export async function getMediaByGenreCount(
    sql: postgres.Sql,
    genreName: string,
    options: Omit<GenreBrowseOptions, 'limit' | 'offset'>,
): Promise<number> {
    const { mediaType = 'all', access } = options;
    if (deniesEverything(access)) return 0;

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;

        const chain = safeProviderChain();
        const srcRank = buildSourcePriorityCase(sql, chain);
        const [row] = await sql<{ count: number }[]>`
            WITH title_best AS (
                SELECT mg.media_id, MIN(${srcRank}) AS best_rank
                FROM media_genres mg
                WHERE ${buildGenreLabel(sql, 'mg')} IS NOT NULL
                  AND mg.source = ANY(${chain})
                GROUP BY mg.media_id
            ),
            matched AS MATERIALIZED (
                SELECT mg.media_id
                FROM media_genres mg
                JOIN title_best tb ON tb.media_id = mg.media_id AND ${srcRank} = tb.best_rank
                WHERE (${buildGenreLabel(sql, 'mg')} = ${genreName} OR mg.genre_name = ${genreName})
                  AND mg.source = ANY(${chain})
            )
            SELECT COUNT(*)::int AS count
            FROM matched m
            JOIN media_items mi ON mi.id = m.media_id
            WHERE mi.status = 'active'
              AND mi.parent_id IS NULL
              AND mi.has_files = true
              ${mediaTypeFilter}
              ${buildAgeRatingFilter(sql, access.age)}
              ${buildLibraryAccessFilter(sql, access.library)}
        `;
        return row?.count ?? 0;
    } catch (error) {
        logger.error('Failed to count media by genre', error as Error, {
            genreName,
            ...options,
        });
        return 0;
    }
}

/**
 * Genres surfaced before the long tail, in display order. A genre missing from
 * the library is simply skipped; anything not listed sorts after these by count.
 */
const PRIORITY_GENRES = [
    'Action',
    'Comedy',
    'Drama',
    'Science Fiction',
    'Sci-Fi',
    'Thriller',
    'Horror',
    'Romance',
    'Animation',
    'Documentary',
    'Fantasy',
    'Adventure',
    'Crime',
    'Family',
    'Mystery',
];

export interface BrowseGenreSectionsOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
    /** How many genre rows to return (default 12). */
    genreLimit?: number;
    /** How many items per genre row (default 20). */
    itemLimit?: number;
}

export interface BrowseGenreSectionsResult {
    genres: BrowseGenreRow[];
    totalGenres: number;
    hasMoreGenres: boolean;
}

/**
 * Build the genre carousels for the browse page: pick the top genres (priority
 * list first, then by item count), fetch items for each, and map to BrowseItem.
 *
 * Shared by the cache-warming service and the /api/browse endpoint so the two
 * can never drift. Rows with fewer than 3 items (after cross-rail dedup, see
 * below) are dropped so the page never renders a lonely single-card carousel.
 *
 * Cross-rail dedup: a title matching multiple genres (e.g. "The Rookie" in
 * Comedy + Drama + Crime) previously repeated in every matching rail. Each
 * genre is over-fetched at 2x `itemLimit` so there's headroom left after
 * removing titles already claimed by an earlier rail, then trimmed back down
 * to `itemLimit`. A `usedIds` set is threaded through the genres IN BUILD
 * ORDER (the same priority-then-count order rendered on the page), so a
 * title's FIRST rail keeps it and every later rail drops it. Ids are only
 * committed to `usedIds` for rows that end up surviving the sparse-row drop
 * rule below — a genre that gets dropped entirely (because dedup left it with
 * <3 items) releases its candidate ids back to later genres instead of
 * silently disappearing a title from the whole page.
 */
export async function buildBrowseGenreSections(
    sql: postgres.Sql,
    options: BrowseGenreSectionsOptions,
): Promise<BrowseGenreSectionsResult> {
    const { mediaType = 'all', access, genreLimit = 12, itemLimit = 20 } = options;
    if (deniesEverything(access)) {
        return { genres: [], totalGenres: 0, hasMoreGenres: false };
    }

    const genreRows = await getGenreList(sql, { mediaType, access });

    const sortedGenres = [...genreRows].sort((a, b) => {
        const aIndex = PRIORITY_GENRES.indexOf(a.genre_name);
        const bIndex = PRIORITY_GENRES.indexOf(b.genre_name);
        if (aIndex === -1 && bIndex === -1) return b.item_count - a.item_count;
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
    });

    const totalGenres = sortedGenres.length;
    const paginatedGenres = sortedGenres.slice(0, genreLimit);
    const hasMoreGenres = genreLimit < totalGenres;

    // Fetch is still fully concurrent — only the dedup pass below depends on
    // build order, not the fetch order.
    const genreCandidateRows = await Promise.all(
        paginatedGenres.map(async (genreRow): Promise<{ genre: string; rows: GenreMediaRow[] }> => {
            const mediaRows = await getMediaByGenre(sql, genreRow.genre_name, {
                mediaType,
                limit: itemLimit * 2,
                access,
            });
            return { genre: genreRow.genre_name, rows: mediaRows };
        }),
    );

    const usedIds = new Set<string>();
    const genres: BrowseGenreRow[] = [];
    for (const { genre, rows } of genreCandidateRows) {
        const candidateRows: GenreMediaRow[] = [];
        for (const row of rows) {
            if (usedIds.has(row.id)) continue;
            candidateRows.push(row);
            if (candidateRows.length >= itemLimit) break;
        }

        // Sparse-row drop rule, applied AFTER dedup so a rail that only looked
        // full before removing duplicates doesn't render a lonely carousel.
        if (candidateRows.length < 3) continue;

        // Commit these ids to the used set only now that the row is known to
        // survive — a dropped row must not lock its titles out of later rails.
        for (const row of candidateRows) usedIds.add(row.id);

        const items: BrowseItem[] = candidateRows.map((row) => ({
            id: row.id,
            name: row.title,
            type: isMovie(row.media_type) ? 'movie' : 'series',
            overview: row.overview ?? undefined,
            communityRating: row.community_rating ?? undefined,
            year: row.year ?? undefined,
            imageId: row.id,
        }));
        genres.push({ genre, items });
    }

    return { genres, totalGenres, hasMoreGenres };
}

// =============================================================================
// Keyword Browse (TMDB keyword ID — stored metadata)
// =============================================================================

export interface KeywordBrowseOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    limit?: number;
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
}

export interface KeywordMediaRow {
    /** media_items.id (uuid) — internal-only, used for the translation overlay lookup. */
    internal_id: string;
    /** Numeric TMDB ID (from external_ids scalar subquery). */
    tmdb_id: number | null;
    /** String form of the TMDB ID for externalIds.tmdb. */
    tmdb_id_str: string | null;
    title: string;
    media_type: string;
    overview: string | null;
    rating: number | null;
    year: number | null;
    poster_path: string | null;
    backdrop_path: string | null;
    trailer_url: string | null;
    /** TMDB popularity from the aggregated metadata (the ORDER BY key); null when absent. */
    popularity: number | null;
}

/**
 * Get media items whose aggregated provider_metadata contains a given TMDB
 * keyword ID in `metadata->'tmdb_keyword_ids'` (a JSONB array of integers).
 *
 * Uses the override-aware aggregated-first LATERAL join so per-media provider
 * overrides are honoured. Access-filtered by library group and age rating.
 * Ordered by popularity descending so the best-known items surface first.
 *
 * @param sql        - Postgres SQL instance
 * @param keywordId  - Numeric TMDB keyword ID to match
 * @param options    - Media type, limit, and access filters
 */
export async function getMediaByTmdbKeyword(
    sql: postgres.Sql,
    keywordId: number,
    options: KeywordBrowseOptions,
): Promise<KeywordMediaRow[]> {
    const { mediaType = 'all', access } = options;
    if (deniesEverything(access)) return [];

    // Defensive guards for non-endpoint callers: a non-integer keywordId would
    // serialize to `[null]` (matches nothing), and a non-positive limit errors.
    if (!Number.isInteger(keywordId)) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;

        // Start from provider_metadata so the GIN index on
        // idx_pm_tmdb_keyword_ids_gin can drive the scan. Applying the JSONB
        // containment on the LATERAL-joined pm row (as the old query did) forced
        // Postgres to evaluate the lateral for every media_items row first, making
        // the index unreachable. Joining media_items from the base-table predicate
        // restores index eligibility.
        //
        // One row per media item without DISTINCT ON: (media_id, provider) is
        // unique on provider_metadata and the external-id LATERAL is LIMIT 1.
        // DISTINCT ON (mi.id) would force ORDER BY to lead with mi.id, so LIMIT
        // kept the lowest UUIDs instead of the most popular items. mi.id breaks
        // popularity ties so the result is stable.
        const results = await sql<KeywordMediaRow[]>`
            SELECT
                mi.id                                           AS internal_id,
                CASE WHEN pe.ext_str ~ '^[0-9]+$' THEN pe.ext_str::integer END AS tmdb_id,
                pe.ext_str                                     AS tmdb_id_str,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text                AS overview,
                COALESCE(NULLIF(CASE WHEN pm.metadata->>'imdb_rating' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'imdb_rating')::float END, 0), NULLIF(CASE WHEN pm.metadata->>'vote_average' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'vote_average')::float END, 0)) AS rating,
                mi.year,
                (pm.metadata->>'poster_path')::text             AS poster_path,
                (pm.metadata->>'backdrop_path')::text           AS backdrop_path,
                (pm.metadata->>'trailer_url')::text             AS trailer_url,
                CASE WHEN pm.metadata->>'popularity' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'popularity')::float END AS popularity
            FROM provider_metadata pm
            JOIN media_items mi ON mi.id = pm.media_id
            LEFT JOIN LATERAL (
                SELECT external_id AS ext_str
                  FROM external_ids
                 WHERE media_id = mi.id
                   AND provider = ${getPrimaryExternalIdProvider()}
                 LIMIT 1
            ) pe ON true
            WHERE pm.provider = 'aggregated'
              AND pm.metadata->'tmdb_keyword_ids' @> ${sql.json([keywordId])}::jsonb
              AND mi.status = 'active'
              AND mi.has_files = true
              AND mi.parent_id IS NULL
              ${mediaTypeFilter}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY (pm.metadata->>'popularity')::float DESC NULLS LAST, mi.id
            LIMIT ${limit}
        `;

        return results;
    } catch (error) {
        logger.error('Failed to get media by TMDB keyword', error as Error, {
            keywordId,
            ...options,
        });
        return [];
    }
}

export interface AccessibleTmdbMatchRow {
    tmdb_id: string;
    media_type: 'movie' | 'tv';
    /** media_items.id (uuid). */
    media_id: string;
}

/**
 * Resolve TMDB (id, media type) pairs to the library items the caller may
 * actually play: active, top-level, with files, and inside the caller's
 * library-group and age boundary. Pairs with no such item are simply absent.
 *
 * Used to mark TMDB-discovered rows as available. Bounded by the caller's
 * candidate list — never a whole-library read.
 */
export async function getAccessibleMediaByTmdbIds(
    sql: postgres.Sql,
    pairs: ReadonlyArray<{ tmdbId: number; mediaType: 'movie' | 'tv' }>,
    access: MediaAccessBoundary,
): Promise<AccessibleTmdbMatchRow[]> {
    if (pairs.length === 0 || deniesEverything(access)) return [];
    const ids = pairs.map((p) => String(p.tmdbId));
    const types = pairs.map((p) => p.mediaType);

    return sql<AccessibleTmdbMatchRow[]>`
        SELECT DISTINCT ON (ei.external_id, mi.media_type)
            ei.external_id AS tmdb_id,
            mi.media_type,
            mi.id          AS media_id
        FROM unnest(${ids}::text[], ${types}::text[]) AS req(tmdb_id, media_type)
        JOIN external_ids ei
            ON ei.provider = 'tmdb'
           AND ei.external_id = req.tmdb_id
        JOIN media_items mi
            ON mi.id = ei.media_id
           AND mi.media_type = req.media_type
        WHERE mi.status = 'active'
          AND mi.has_files = true
          AND mi.parent_id IS NULL
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY ei.external_id, mi.media_type, mi.id
    `;
}

/**
 * Get media items whose aggregated provider_metadata contains a given
 * provider-neutral keyword slug in `metadata->'keyword_slugs'` (a JSONB array
 * of slug strings).
 *
 * This is the preferred query for keyword browse when the keyword is identified
 * by name rather than by a TMDB numeric ID. It resolves the name to a slug at
 * call time so the comparison is locale-independent and works regardless of
 * which metadata provider populated the row.
 *
 * Falls back gracefully: if a row was enriched before `keyword_slugs` existed
 * it will simply not appear in results (no false positives). Use
 * {@link getMediaByTmdbKeyword} as a complementary fallback for TMDB-ID-based
 * callers until the backfill completes.
 *
 * Uses the override-aware aggregated-first LATERAL join so per-media provider
 * overrides are honoured. Ordered by popularity descending.
 *
 * @param sql          - Postgres SQL instance
 * @param keywordName  - Raw keyword name (e.g. "time travel"). Normalised to slug internally.
 * @param options      - Media type, limit, and access filters
 */
export async function getMediaByKeywordSlug(
    sql: postgres.Sql,
    keywordName: string,
    options: KeywordBrowseOptions,
): Promise<KeywordMediaRow[]> {
    const { mediaType = 'all', access } = options;
    if (deniesEverything(access)) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200));

    const slug = keywordNameToSlug(keywordName);
    if (slug.length === 0) return [];

    try {
        const mediaTypeFilter =
            mediaType === 'all'
                ? sql`AND mi.media_type IN ('movie', 'tv')`
                : sql`AND mi.media_type = ${mediaType}`;

        // Start from provider_metadata so the GIN index on
        // idx_pm_keyword_slugs_gin can drive the scan. Applying the JSONB
        // containment on the LATERAL-joined pm row (as the old query did) forced
        // Postgres to evaluate the lateral for every media_items row first, making
        // the index unreachable. Joining media_items from the base-table predicate
        // restores index eligibility.
        //
        // One row per media item without DISTINCT ON: (media_id, provider) is
        // unique on provider_metadata and the external-id LATERAL is LIMIT 1.
        // DISTINCT ON (mi.id) would force ORDER BY to lead with mi.id, so LIMIT
        // kept the lowest UUIDs instead of the most popular items. mi.id breaks
        // popularity ties so the result is stable.
        const results = await sql<KeywordMediaRow[]>`
            SELECT
                mi.id                                           AS internal_id,
                CASE WHEN pe.ext_str ~ '^[0-9]+$' THEN pe.ext_str::integer END AS tmdb_id,
                pe.ext_str                                      AS tmdb_id_str,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text                AS overview,
                COALESCE(NULLIF(CASE WHEN pm.metadata->>'imdb_rating' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'imdb_rating')::float END, 0), NULLIF(CASE WHEN pm.metadata->>'vote_average' ~ '^-?[0-9]+([.][0-9]+)?$' THEN (pm.metadata->>'vote_average')::float END, 0)) AS rating,
                mi.year,
                (pm.metadata->>'poster_path')::text             AS poster_path,
                (pm.metadata->>'backdrop_path')::text           AS backdrop_path,
                (pm.metadata->>'trailer_url')::text             AS trailer_url
            FROM provider_metadata pm
            JOIN media_items mi ON mi.id = pm.media_id
            LEFT JOIN LATERAL (
                SELECT external_id AS ext_str
                  FROM external_ids
                 WHERE media_id = mi.id
                   AND provider = ${getPrimaryExternalIdProvider()}
                 LIMIT 1
            ) pe ON true
            WHERE pm.provider = 'aggregated'
              AND pm.metadata->'keyword_slugs' @> ${sql.json([slug])}::jsonb
              AND mi.status = 'active'
              AND mi.has_files = true
              AND mi.parent_id IS NULL
              ${mediaTypeFilter}
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY (pm.metadata->>'popularity')::float DESC NULLS LAST, mi.id
            LIMIT ${limit}
        `;

        return results;
    } catch (error) {
        logger.error('Failed to get media by keyword slug', error as Error, {
            keywordName,
            slug,
            ...options,
        });
        return [];
    }
}

// =============================================================================
// Keyword Browse Sections (shared by /api/browse/keywords + cache warming)
// =============================================================================

/**
 * Static keyword sections surfaced on the browse page. The list is fixed at
 * build time; only which entries have enough matching library items changes,
 * and only on ingest. Shared by the /api/browse/keywords endpoint and the
 * cache-warming service via {@link buildBrowseKeywordSections} so the two can
 * never drift.
 */
export const KEYWORD_SECTIONS = [
    { id: 779, name: 'Martial Arts' },
    { id: 345851, name: 'Dark Comedy' },
    { id: 10683, name: 'Coming of Age' },
    { id: 6513, name: 'Detektive' },
    { id: 10349, name: 'Survival' },
    { id: 9715, name: 'Superhelden' },
    { id: 10950, name: 'Psycho-Thriller' },
    { id: 9951, name: 'Aliens' },
    { id: 11322, name: 'Serienkiller' },
    { id: 5983, name: 'One Man Army' },
    { id: 4565, name: 'Weltraum' },
    { id: 4379, name: 'Zeitreisen' },
    { id: 470, name: 'Spionage' },
    { id: 4458, name: 'Dystopie' },
    { id: 1432, name: 'Raumschiffe' },
    { id: 10714, name: 'Krimi' },
    { id: 12570, name: 'Whodunit' },
    { id: 12377, name: 'Zombies' },
    { id: 10291, name: 'Heist' },
    { id: 161176, name: 'Space Opera' },
    { id: 154802, name: 'Silent Cinema' },
    { id: 9807, name: 'Film Noir' },
    { id: 156764, name: 'Pre-Code Hollywood' },
    { id: 164218, name: 'Cult Classics' },
    { id: 155457, name: 'Screwball Comedy' },
    { id: 244516, name: 'German Expressionism' },
    { id: 11034, name: 'B-Movies' },
    { id: 10125, name: 'Mad Scientist' },
    { id: 9253, name: 'Slapstick' },
    { id: 4344, name: 'Musicals' },
] as const;

/**
 * TMDB keyword id -> paraglide message function, for localizing
 * {@link KEYWORD_SECTIONS} display names at request time. `name` above stays
 * the query-time value passed to {@link getMediaByKeywordSlug} (unchanged
 * behavior) and doubles as the English/German fallback literal for any id
 * with no message-key match below.
 *
 * Reuses the same `keyword_*` message keys as `KEYWORD_I18N_MAP` in
 * `$lib/shared/keyword-vocabulary` — not imported directly because that map is
 * keyed by SLUG while this one is keyed by TMDB id. Every id
 * present here was cross-checked against messages/en.json so the mapped
 * English string is the same keyword concept as the (often German) literal
 * `name` it replaces, e.g. `10950 'Psycho-Thriller'` -> `keyword_psychological_thriller`
 * whose en.json value is literally "Psycho-Thriller".
 *
 * Every KEYWORD_SECTIONS id is mapped; the literal `name` fallback in
 * resolveKeywordDisplayName only guards future additions that ship without
 * a message key.
 */
const KEYWORD_ID_I18N: Record<number, () => string> = {
    10714: m.keyword_crime_fiction,
    154802: m.keyword_silent_cinema,
    156764: m.keyword_pre_code_hollywood,
    155457: m.keyword_screwball_comedy,
    244516: m.keyword_german_expressionism,
    779: m.keyword_martial_arts,
    345851: m.keyword_dark_comedy,
    10683: m.keyword_coming_of_age,
    6513: m.keyword_detective,
    10349: m.keyword_survival,
    9715: m.keyword_superhero,
    10950: m.keyword_psychological_thriller,
    9951: m.keyword_alien,
    11322: m.keyword_serial_killer,
    5983: m.keyword_one_man_army,
    4565: m.keyword_outer_space,
    4379: m.keyword_time_travel,
    470: m.keyword_espionage,
    4458: m.keyword_dystopia,
    1432: m.keyword_spaceship,
    12570: m.keyword_whodunit,
    12377: m.keyword_zombie,
    10291: m.keyword_heist,
    161176: m.keyword_space_opera,
    9807: m.keyword_film_noir,
    164218: m.keyword_cult_film,
    11034: m.keyword_b_movie,
    10125: m.keyword_mad_scientist,
    9253: m.keyword_slapstick_comedy,
    4344: m.keyword_musical,
};

/**
 * Resolve a {@link KEYWORD_SECTIONS} entry's user-facing display name through
 * the localized message map, falling back to the static literal `name` for
 * the handful of ids with no existing message key (see the list above).
 */
function resolveKeywordDisplayName(keyword: { id: number; name: string }): string {
    const i18nFn = KEYWORD_ID_I18N[keyword.id];
    return i18nFn ? i18nFn() : keyword.name;
}

export interface BrowseKeywordItem {
    id: number;
    /** media_items.id (uuid) — internal-only, used for the translation overlay lookup; never sent to clients (stripped at the endpoint boundary). */
    internalId: string;
    externalIds: { tmdb: string };
    name: string;
    type: 'movie' | 'series';
    year?: string;
    overview?: string;
    rating?: number;
    trailerUrl?: string;
    posterPath?: string | null;
    backdropPath?: string | null;
    isAvailable: boolean;
}

export interface BrowseKeywordSection {
    keyword: string;
    keywordId: number;
    items: BrowseKeywordItem[];
}

export interface BrowseKeywordSectionsResult {
    sections: BrowseKeywordSection[];
    availableKeywords: Array<{ id: number; name: string }>;
    totalKeywords: number;
    hasMore: boolean;
    nextOffset: number;
}

export interface BrowseKeywordSectionsOptions {
    mediaType?: 'movie' | 'tv' | 'all';
    /** REQUIRED access boundary. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
    access: MediaAccessBoundary;
    /** Number of non-empty sections to accumulate (default 5). */
    limit?: number;
    /** Offset into the static keyword list (default 0). */
    offset?: number;
    /** Items per section (default 20). */
    itemLimit?: number;
}

/**
 * Build the keyword carousels for the browse page: scan the static
 * {@link KEYWORD_SECTIONS} list forward from `offset`, union the slug-based and
 * TMDB-numeric keyword queries per entry (deduped by external-id), and keep
 * sections that have at least two library items until `limit` of them are
 * collected.
 *
 * Shared by the cache-warming service and the /api/browse/keywords endpoint so
 * the two can never drift. Access-filtered by library group + age rating.
 */
export async function buildBrowseKeywordSections(
    sql: postgres.Sql,
    options: BrowseKeywordSectionsOptions,
): Promise<BrowseKeywordSectionsResult> {
    const { mediaType = 'all', access, limit = 5, offset = 0, itemLimit = 20 } = options;
    if (deniesEverything(access)) {
        return {
            sections: [],
            availableKeywords: [...KEYWORD_SECTIONS].map((k) => ({
                id: k.id,
                name: resolveKeywordDisplayName(k),
            })),
            totalKeywords: KEYWORD_SECTIONS.length,
            hasMore: false,
            nextOffset: offset,
        };
    }

    const totalKeywords = KEYWORD_SECTIONS.length;

    const queryOpts = {
        mediaType,
        limit: itemLimit,
        access,
    };

    const buildSection = async (keyword: {
        id: number;
        name: string;
    }): Promise<BrowseKeywordSection | null> => {
        try {
            // Run both paths unconditionally and union the results.
            // Slug path covers post-enrichment rows (keyword_slugs populated).
            // TMDB-numeric path covers pre-enrichment rows that have
            // tmdb_keyword_ids but no keyword_slugs yet. A fallback-only
            // strategy silently drops the pre-enrichment items whenever the
            // slug query returns at least one result.
            const [slugRows, tmdbRows] = await Promise.all([
                getMediaByKeywordSlug(sql, keyword.name, queryOpts),
                getMediaByTmdbKeyword(sql, keyword.id, queryOpts),
            ]);

            // Dedupe by external-id string (the natural per-item identity in
            // these rows). Slug rows are inserted first so the richer/newer
            // row wins when both queries return the same item. Items that lack
            // a non-empty external-id string are dropped — emitting an empty
            // tmdb key or id 0 causes collisions and broken image/link lookups.
            const seen = new Set<string>();
            const mergedRows = [...slugRows, ...tmdbRows].filter((row) => {
                const key = row.tmdb_id_str;
                if (!key) return false;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            const limitedRows = mergedRows.slice(0, itemLimit);

            const items: BrowseKeywordItem[] = limitedRows.map((row) => ({
                id: row.tmdb_id ?? 0,
                internalId: row.internal_id,
                externalIds: { tmdb: row.tmdb_id_str! },
                name: row.title,
                // Canonical: 'series' replaces 'tv'
                type: isMovie(row.media_type) ? 'movie' : 'series',
                year: row.year != null ? String(row.year) : undefined,
                overview: row.overview ?? undefined,
                rating: row.rating ?? undefined,
                trailerUrl: row.trailer_url ?? undefined,
                posterPath: row.poster_path ?? null,
                backdropPath: row.backdrop_path ?? null,
                isAvailable: true,
            }));

            return { keyword: resolveKeywordDisplayName(keyword), keywordId: keyword.id, items };
        } catch (e) {
            logger.error(`Failed to fetch keyword ${keyword.name}`, e as Error);
            return null;
        }
    };

    // Scan forward accumulating non-empty sections until we have `limit` of them.
    const validSections: BrowseKeywordSection[] = [];
    let cursor = offset;
    while (cursor < totalKeywords && validSections.length < limit) {
        const window = [...KEYWORD_SECTIONS].slice(cursor, cursor + limit);
        const built = (await Promise.all(window.map(buildSection))).filter(
            Boolean,
        ) as BrowseKeywordSection[];
        for (const section of built) {
            if (section.items.length >= 2) validSections.push(section);
        }
        cursor += window.length;
    }

    return {
        sections: validSections,
        availableKeywords: [...KEYWORD_SECTIONS].map((k) => ({
            id: k.id,
            name: resolveKeywordDisplayName(k),
        })),
        totalKeywords,
        hasMore: cursor < totalKeywords,
        nextOffset: cursor,
    };
}
