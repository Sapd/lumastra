// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watchlist Media Queries Module
 *
 * Queries for fetching media items from a user's watchlist with full metadata.
 * Parameterized query with the shared library and effective-age boundaries.
 *
 * @module queries/watchlist-media
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { getProviderArray } from './builders/provider-metadata.builder.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildAgeRatingFilter, type AgeRatingFilterParams } from './builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import type {
    BaseMediaWithExtIdRow,
    AvailabilityFields,
    MetadataContent,
    ExtendedRatings,
    MetadataArrays,
} from './types/index.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Decoded keyset cursor for `getUserWatchlistMedia`.
 *
 * The watchlist output is ordered by the DISTINCT ON key
 * `(COALESCE(external_id, media_id), media_type)` ASC — NOT by `added_at`
 * (that column is only the DISTINCT ON tiebreak that picks which duplicate
 * survives per key). That pair is therefore UNIQUE per output row and is the
 * natural, stable keyset for this feed.
 *
 * `externalId` here is NOT always a real primary-provider id: `primary_ext`
 * is a LEFT JOIN (a row whose media type has no external_ids row under the
 * configured primary provider — e.g. an audiobook, which is keyed by
 * `provider='audiobookshelf'`, never `tmdb` — would otherwise all collapse
 * onto the SAME `NULL` DISTINCT ON key and silently drop every audiobook
 * past the first). The query falls back to the media UUID
 * (`mi.id::text`) in that case, which is always present and unique, so this
 * field can be either shape — it's an opaque cursor value round-tripped
 * verbatim into the same COALESCE comparison, never parsed as a real
 * provider id.
 */
export interface WatchlistMediaCursor {
    /** Primary-provider `external_id`, or the media UUID when the row has none. */
    externalId: string;
    /** `media_type` of the last row on the previous page. */
    mediaType: string;
}

export type WatchlistMediaRow = Omit<BaseMediaWithExtIdRow, 'media_id' | 'primary_ext_id'> &
    AvailabilityFields &
    Pick<MetadataContent, 'overview' | 'release_date' | 'runtime_minutes' | 'certification'> &
    Pick<
        ExtendedRatings,
        | 'imdb_rating'
        | 'rt_rating'
        | 'rt_audience_score'
        | 'letterboxd_rating'
        | 'letterboxd_votes'
        | 'mdblist_score'
        | 'trakt_score'
        | 'mal_score'
        | 'popularity'
    > &
    Pick<MetadataArrays, 'genres' | 'actors' | 'directors'> & {
        media_id: string;
        saved_at: string | Date;
        /** `media_items.year` — feeds the canonical `media.year` on the API shape. */
        year: number | null;
        tmdb_rating: number | null;
        jellyseerr_id: number | null;
        imdb_id: string | null;
        /**
         * `primary_ext.external_id` is a LEFT JOIN — null for a media type with
         * no external_ids row under the configured primary provider (e.g. an
         * audiobook, keyed by `provider='audiobookshelf'`, never the movie/series
         * primary provider). Unlike the shared `BaseMediaWithExtIdRow` type this
         * overrides, this field is genuinely nullable here.
         */
        primary_ext_id: string | null;
    };

// =============================================================================
// Queries
// =============================================================================

/**
 * Fetch all watchlist media items for a user with full metadata.
 *
 * Uses DISTINCT ON to prevent duplicate rows from multiple external_ids entries.
 * Scalar subqueries fetch jellyseerr_id, and imdb_id without duplication.
 *
 * @param sql - Postgres SQL client instance
 * @param userId - The user ID to fetch watchlist items for
 * @returns Array of watchlist media rows
 */
export async function getUserWatchlistMedia(
    sql: postgres.Sql,
    userId: UserId,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
        availableOnly?: boolean;
    },
    /**
     * Optional paging. Omit to return the full list (legacy behaviour). Two
     * mutually-exclusive modes, both over the SAME unchanged ORDER BY so a page
     * is a stable window of the existing ordering — no result-shape change:
     *   - offset: `{ limit, offset }` — legacy LIMIT/OFFSET (byte-identical).
     *   - cursor: `{ limit, cursor }` — opt-in keyset over `(external_id,
     *     media_type)` (the DISTINCT ON output order). Replaces OFFSET with a
     *     `(external_id, media_type) > (cursor)` predicate that cannot drift
     *     across the page boundary under concurrent watchlist inserts.
     */
    pagination?:
        { limit: number; offset: number } | { limit: number; cursor: WatchlistMediaCursor },
): Promise<WatchlistMediaRow[]> {
    // Metadata pick uses the override-aware LATERAL, NOT `LEFT JOIN
    // v_media_metadata`. Both select the same provider row (per-media override →
    // 'aggregated' → chain order), but the view cannot be parameterized on the
    // nullable side of the LEFT JOIN: the planner materialises the ENTIRE view
    // (seq scan of every active media_item, one provider_metadata lookup each)
    // and then discards it with a `Join Filter: vm.media_id = mi.id`. The cost is
    // independent of how many rows the caller actually has — on prod (140k media
    // items) a THREE-item watchlist took 2962 ms, 418,734 lateral executions and
    // 645 ms of JIT to return 3 rows. The LATERAL below runs one indexed lookup
    // per result row: same query, same output, 0.5 ms.
    //
    // Equivalence verified on prod by EXCEPT in both directions over all 139,578
    // active media items: 0 rows differ. Keep them in sync — the view reads the
    // provider order from `provider_capabilities`, the builder from the config
    // chain that `provider-config-loader` populates from that same table.
    //
    // This is also what the homepage rails already do (see
    // media-rail-metadata.queries.ts) — the view join is a trap for any query
    // that returns fewer rows than the catalogue holds.
    const providers = getProviderArray();
    const cursor = pagination && 'cursor' in pagination ? pagination.cursor : null;
    // The indexed metadata pick keeps the existing precedence: per-item override,
    // aggregated metadata, then configured provider order. Provider names, cursors,
    // paging and access values are all bound parameters, never SQL text.
    return sql<WatchlistMediaRow[]>`
            SELECT DISTINCT ON (COALESCE(primary_ext.external_id, mi.id::text), mi.media_type)
                primary_ext.external_id as primary_ext_id,
                mi.id as media_id,
                mi.media_type,
                mi.title,
                (pm.metadata->>'overview')::text as overview,
                uw.added_at as saved_at,
                (pm.metadata->>'popularity')::float as tmdb_rating,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                (SELECT CASE WHEN external_id ~ '^[0-9]+$' THEN external_id::integer ELSE NULL END FROM external_ids WHERE media_id = mi.id AND provider = 'jellyseerr' LIMIT 1) as jellyseerr_id,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(
                        SELECT CASE
                            WHEN jsonb_typeof(elem) = 'object' THEN (elem->>'id')::integer
                            WHEN elem::text ~ '^[0-9]+$' THEN (elem::text)::integer
                            ELSE NULL
                        END
                        FROM jsonb_array_elements(pm.metadata->'genres') AS elem
                    )
                    ELSE NULL
                END as genres,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                mi.year as year,
                (pm.metadata->>'popularity')::float as popularity,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                    ELSE NULL
                END as actors,
                CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                    ELSE NULL
                END as directors,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                (pm.metadata->>'certification')::text as certification,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'letterboxd_votes')::integer as letterboxd_votes,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                (pm.metadata->>'trakt_score')::float as trakt_score,
                (pm.metadata->>'mal_score')::float as mal_score
            FROM playlist_items uw
            JOIN playlists wp
              ON wp.id = uw.playlist_id
             AND wp.user_id = ${userId}
             AND wp.playlist_type = 'watchlist'
            JOIN media_items mi ON mi.id = uw.media_id
            LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            LEFT JOIN LATERAL (
                SELECT metadata FROM provider_metadata
                WHERE media_id = mi.id AND provider = ANY(${providers}::text[])
                ORDER BY CASE WHEN mi.preferred_provider IS NOT NULL AND provider = mi.preferred_provider THEN 0 ELSE 1 END,
                    array_position(${providers}::text[], provider)
                LIMIT 1
            ) pm ON true
            WHERE mi.status = 'active'
              AND (mi.media_type <> 'audiobook' OR (mi.has_files AND NOT mi.is_dismissed))
              ${access.availableOnly ? sql`AND ${isAvailableExpr(sql)} AND mi.is_dismissed = false` : sql``}
              ${buildLibraryAccessFilter(sql, access.deniedGroupIds, 'mi')}
              ${buildAgeRatingFilter(sql, access.ageRating, 'mi')}
              ${cursor ? sql`AND (COALESCE(primary_ext.external_id, mi.id::text), mi.media_type) > (${cursor.externalId}, ${cursor.mediaType})` : sql``}
            ORDER BY COALESCE(primary_ext.external_id, mi.id::text), mi.media_type, uw.added_at DESC
            ${pagination ? ('cursor' in pagination ? sql`LIMIT ${pagination.limit}` : sql`LIMIT ${pagination.limit} OFFSET ${pagination.offset}`) : sql``}
        `;
}
