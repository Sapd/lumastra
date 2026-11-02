// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Ratings Query Module
 *
 * Centralized queries for user rating operations on user_ratings table.
 * Previously scattered across ~23 files.
 *
 * Key principle: Use UUID-based queries (media_id) for user data operations.
 * Only resolve to TMDB IDs at API boundaries when needed for client responses.
 *
 * ## Access boundary
 *
 * Every query in this module that joins `media_items` takes a REQUIRED
 * {@link MediaAccessBoundary}. There is no permissive default and no optional
 * access parameter: a call site that wants unfiltered rows must say so with
 * `unrestrictedAccess()`, which makes each such decision greppable instead of
 * invisible by omission.
 *
 * All of these queries alias `media_items` as `mi` — which is the alias
 * `buildLibraryAccessFilter` hardcodes and `buildAgeRatingFilter` defaults to —
 * so neither builder needs an alias override. Note the two big metadata queries
 * alias `user_ratings` differently (`ur` vs `urv`); that is irrelevant to the
 * access fragments, which only reference `mi`, but the two queries are NOT
 * otherwise alias-identical and must not be assumed so.
 */

import type postgres from 'postgres';
import { defaultActivitySharing } from '$lib/server/config/activity-sharing.js';
import type { UserId } from '$lib/shared/user-id.js';
import {
    defineQuery,
    defineWriteQuery,
    defineScalarQuery,
    defineExistsQuery,
} from '../typed-query.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { buildOverrideAwareMetadataLateralJoin } from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import {
    buildAgeRatingFilter,
    buildSeriesOwnedAgeRatingFilter,
} from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { pgTextTimestamp } from './builders/keyset-cursor.builder.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'movie' | 'tv';

export interface UserRatingRow {
    id: number;
    user_id: string;
    media_id: string;
    rating: number;
    suggestion_context: string | null;
    skipped: boolean;
    created_at: Date;
    /** How the rating was entered — 'quick' | 'stars' | null (legacy rows / not provided). */
    rating_style: string | null;
}

export interface UserRatingWithTmdb extends UserRatingRow {
    primary_ext_id: string | null;
    media_type: MediaType;
    title: string | null;
}

export interface UserRatingWithMetadata extends UserRatingWithTmdb {
    poster_path: string | null;
    overview: string | null;
    year: number | null;
}

export interface RatingStats {
    total_ratings: number;
    today_ratings: number;
    avg_rating: number | null;
    liked_count: number; // rating >= 7
    disliked_count: number; // rating <= 4
}

export interface RatingDistribution {
    rating: number;
    count: number;
}

// =============================================================================
// Read Queries - Single Item
// =============================================================================

/**
 * Get a user's rating for a specific media item by internal UUID.
 */
export const getUserRating = defineQuery<
    { userId: UserId; mediaId: string },
    { rating: number; created_at: Date }
>(
    'getUserRating',
    (sql, { userId, mediaId }) => sql`
    SELECT rating, created_at
    FROM user_ratings
    WHERE user_id = ${userId}
      AND media_id = ${mediaId}
    LIMIT 1
`,
);

/**
 * Get a user's rating for a media item by TMDB ID.
 * Use this when you only have the TMDB ID (e.g., from external API).
 */
export const getUserRatingByTmdb = defineQuery<
    { userId: UserId; tmdbId: number; mediaType: MediaType },
    { rating: number; created_at: Date; media_id: string }
>(
    'getUserRatingByTmdb',
    (sql, { userId, tmdbId, mediaType }) => sql`
    SELECT ur.rating, ur.created_at, ur.media_id
    FROM user_ratings ur
    JOIN external_ids ei ON ei.media_id = ur.media_id
    WHERE ur.user_id = ${userId}
      AND ei.provider = ${getPrimaryExternalIdProvider()}
      AND ei.external_id = ${String(tmdbId)}
      AND ei.media_type = ${mediaType}
    LIMIT 1
`,
);

/**
 * Check if a user has rated a specific media item.
 */
export const hasUserRated = defineExistsQuery<{
    userId: UserId;
    mediaId: string;
}>(
    'hasUserRated',
    (sql, { userId, mediaId }) => sql`
        SELECT 1
        FROM user_ratings
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
        LIMIT 1
    `,
);

// =============================================================================
// Read Queries - Lists
// =============================================================================

/**
 * Get user's ratings with optional skipped filter.
 * Returns internal UUIDs + TMDB IDs for API responses.
 * Optimized: Uses LEFT JOIN instead of scalar subquery for TMDB resolution.
 */
export const getUserRatings = defineQuery<
    { userId: UserId; limit: number; includeSkipped: boolean },
    UserRatingWithTmdb
>('getUserRatings', (sql, { userId, limit, includeSkipped }) =>
    includeSkipped
        ? sql`
                SELECT
                    ur.id, ur.user_id, ur.media_id, ur.rating,
                    ur.suggestion_context, ur.skipped, ur.created_at, ur.rating_style,
                    primary_ext.external_id as primary_ext_id,
                    mi.media_type,
                    mi.title
                FROM user_ratings ur
                JOIN media_items mi ON mi.id = ur.media_id
                LEFT JOIN external_ids primary_ext ON primary_ext.media_id = ur.media_id
                    AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                WHERE ur.user_id = ${userId}
                ORDER BY ur.created_at DESC
                LIMIT ${limit}
            `
        : sql`
                SELECT
                    ur.id, ur.user_id, ur.media_id, ur.rating,
                    ur.suggestion_context, ur.skipped, ur.created_at, ur.rating_style,
                    primary_ext.external_id as primary_ext_id,
                    mi.media_type,
                    mi.title
                FROM user_ratings ur
                JOIN media_items mi ON mi.id = ur.media_id
                LEFT JOIN external_ids primary_ext ON primary_ext.media_id = ur.media_id
                    AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                WHERE ur.user_id = ${userId}
                  AND ur.skipped IS NOT TRUE
                ORDER BY ur.created_at DESC
                LIMIT ${limit}
            `,
);

/**
 * Get a user's ratings for a specific, known set of media items (by internal
 * UUID). Returns the same shape as `getUserRatings` (incl. `primary_ext_id` and
 * `media_type` resolved via the primary external-id provider) so callers can
 * key a ratings map identically — but scoped to only the UUIDs of interest
 * instead of fetching the caller's entire (capped) rating history.
 *
 * Includes skipped ratings (parity with `getUserRatings({ includeSkipped: true })`).
 * Pass an empty array only after guarding at the call site — `= ANY('{}')`
 * simply matches nothing.
 */
export const getUserRatingsForMedia = defineQuery<
    {
        userId: UserId;
        mediaIds: string[];
        /** REQUIRED. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
        access: MediaAccessBoundary;
    },
    UserRatingWithTmdb
>(
    'getUserRatingsForMedia',
    (sql, { userId, mediaIds, access }) => sql`
        SELECT
            ur.id, ur.user_id, ur.media_id, ur.rating,
            ur.suggestion_context, ur.skipped, ur.created_at, ur.rating_style,
            primary_ext.external_id as primary_ext_id,
            mi.media_type,
            mi.title
        FROM user_ratings ur
        JOIN media_items mi ON mi.id = ur.media_id
        LEFT JOIN external_ids primary_ext ON primary_ext.media_id = ur.media_id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
        WHERE ur.user_id = ${userId}
          AND ur.media_id = ANY(${mediaIds}::uuid[])
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
    `,
);

/**
 * Get user's liked media (rating >= 7).
 * Returns internal UUIDs for efficient internal operations.
 */
export const getUserLikedMedia = defineQuery<
    { userId: UserId; limit: number },
    { media_id: string; rating: number }
>(
    'getUserLikedMedia',
    (sql, { userId, limit }) => sql`
    SELECT media_id, rating
    FROM user_ratings
    WHERE user_id = ${userId}
      AND rating >= 7
      AND skipped IS NOT TRUE
    ORDER BY rating DESC, created_at DESC
    LIMIT ${limit}
`,
);

/**
 * Get user's disliked media (rating <= 4).
 * Returns internal UUIDs for efficient exclusion queries.
 */
export const getUserDislikedMedia = defineQuery<
    { userId: UserId; limit: number },
    { media_id: string; rating: number }
>(
    'getUserDislikedMedia',
    (sql, { userId, limit }) => sql`
    SELECT media_id, rating
    FROM user_ratings
    WHERE user_id = ${userId}
      AND rating <= 4
      AND skipped IS NOT TRUE
    ORDER BY created_at DESC
    LIMIT ${limit}
`,
);

/**
 * Get user's ratings with full metadata for display.
 * Optimized: Uses LEFT JOIN instead of scalar subquery for TMDB resolution.
 * Uses idx_user_ratings_active partial index.
 */
export const getUserRatingsWithMetadata = defineQuery<
    {
        userId: UserId;
        limit: number;
        offset?: number;
        /** REQUIRED. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
        access: MediaAccessBoundary;
    },
    UserRatingWithMetadata
>(
    'getUserRatingsWithMetadata',
    (sql, { userId, limit, offset = 0, access }) => sql`
    SELECT
        ur.id, ur.user_id, ur.media_id, ur.rating,
        ur.suggestion_context, ur.skipped, ur.created_at, ur.rating_style,
        primary_ext.external_id as primary_ext_id,
        mi.media_type,
        mi.title,
        mi.year,
        pm.metadata->>'poster_path' as poster_path,
        pm.metadata->>'overview' as overview
    FROM user_ratings ur
    JOIN media_items mi ON mi.id = ur.media_id
    LEFT JOIN external_ids primary_ext ON primary_ext.media_id = ur.media_id
        AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
    ${sql.unsafe(buildOverrideAwareMetadataLateralJoin())}
    WHERE ur.user_id = ${userId}
      AND ur.skipped IS NOT TRUE
      ${buildLibraryAccessFilter(sql, access.library)}
      ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
    ORDER BY ur.created_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
`,
);

/**
 * Get all user IDs who have rated a specific media item.
 */
export const getUsersWhoRated = defineQuery<
    { mediaId: string },
    { user_id: string; rating: number; rating_style: string | null }
>(
    'getUsersWhoRated',
    (sql, { mediaId }) => sql`
        SELECT user_id, rating, rating_style
        FROM user_ratings
        WHERE media_id = ${mediaId}
          AND skipped IS NOT TRUE
        LIMIT 1000
    `,
);

// =============================================================================
// Statistics Queries
// =============================================================================

/**
 * Get user's rating statistics.
 * Uses idx_user_ratings_active partial index.
 */
export const getUserRatingStats = defineScalarQuery<{ userId: UserId }, RatingStats>(
    'getUserRatingStats',
    (sql, { userId }) => sql`
        SELECT
            COUNT(*)::int as total_ratings,
            COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int as today_ratings,
            AVG(rating)::numeric(3,1)::float8 as avg_rating,
            COUNT(*) FILTER (WHERE rating >= 7)::int as liked_count,
            COUNT(*) FILTER (WHERE rating <= 4)::int as disliked_count
        FROM user_ratings
        WHERE user_id = ${userId}
          AND skipped IS NOT TRUE
    `,
    (row) => ({
        total_ratings: row.total_ratings as number,
        today_ratings: row.today_ratings as number,
        avg_rating: row.avg_rating as number | null,
        liked_count: row.liked_count as number,
        disliked_count: row.disliked_count as number,
    }),
);

/**
 * Get total rating count for a user (simple count for confidence calculations).
 */
export const getUserRatingCount = defineScalarQuery<{ userId: UserId }, number>(
    'getUserRatingCount',
    (sql, { userId }) => sql`
        SELECT COUNT(*)::int as count
        FROM user_ratings
        WHERE user_id = ${userId}
    `,
    (row) => row.count as number,
);

/**
 * Get today's rating count for a user.
 */
export const getUserTodayRatingCount = defineScalarQuery<{ userId: UserId }, number>(
    'getUserTodayRatingCount',
    (sql, { userId }) => sql`
        SELECT COUNT(*)::int as count
        FROM user_ratings
        WHERE user_id = ${userId}
          AND created_at >= CURRENT_DATE
    `,
    (row) => row.count as number,
);

/**
 * Get rating distribution for a user.
 * Uses idx_user_ratings_active partial index.
 */
export const getUserRatingDistribution = defineQuery<{ userId: UserId }, RatingDistribution>(
    'getUserRatingDistribution',
    (sql, { userId }) => sql`
        SELECT rating, COUNT(*)::int as count
        FROM user_ratings
        WHERE user_id = ${userId}
          AND skipped IS NOT TRUE
        GROUP BY rating
        ORDER BY rating
    `,
);

/**
 * Get average rating for a media item across all users.
 */
export const getMediaAverageRating = defineScalarQuery<
    { mediaId: string },
    { avg_rating: number; rating_count: number }
>(
    'getMediaAverageRating',
    (sql, { mediaId }) => sql`
        SELECT
            AVG(rating)::numeric(3,1)::float8 as avg_rating,
            COUNT(*)::int as rating_count
        FROM user_ratings
        WHERE media_id = ${mediaId}
          AND skipped IS NOT TRUE
    `,
    (row) => ({
        avg_rating: row.avg_rating as number,
        rating_count: row.rating_count as number,
    }),
);

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Upsert result row — `inserted` distinguishes a genuinely new rating from a
 * conflict-update (re-rating an already-rated item). Postgres surfaces this
 * via the row's `xmax` system column: 0 for a fresh insert, non-zero when
 * ON CONFLICT DO UPDATE touched an existing row.
 */
export interface UserRatingUpsertRow extends UserRatingRow {
    inserted: boolean;
}

/**
 * Upsert a user rating.
 */
export const upsertUserRating = defineWriteQuery<
    {
        userId: UserId;
        mediaId: string;
        rating: number;
        suggestionContext?: string | null;
        skipped?: boolean;
        /**
         * How the rating was entered — 'quick' | 'stars'. Stored as-is (null when
         * absent); legacy rows and callers that don't pass it stay null.
         */
        ratingStyle?: 'quick' | 'stars' | null;
    },
    UserRatingUpsertRow
>(
    'upsertUserRating',
    (sql, { userId, mediaId, rating, suggestionContext, skipped, ratingStyle }) => sql`
        INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, skipped, rating_style, is_explicit)
        VALUES (${userId}, ${mediaId}, ${rating}, ${suggestionContext ?? null}, ${skipped ?? false}, ${ratingStyle ?? null}, true)
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            rating = EXCLUDED.rating,
            is_explicit = true,
            suggestion_context = EXCLUDED.suggestion_context,
            skipped = EXCLUDED.skipped,
            rating_style = EXCLUDED.rating_style
        RETURNING id, user_id, media_id, rating, suggestion_context, skipped, created_at, rating_style,
            (xmax = 0) AS inserted
    `,
);

/**
 * Delete a user's rating for a media item.
 */
export const deleteUserRating = defineWriteQuery<
    { userId: UserId; mediaId: string },
    { id: number }
>(
    'deleteUserRating',
    (sql, { userId, mediaId }) => sql`
    DELETE FROM user_ratings
    WHERE user_id = ${userId}
      AND media_id = ${mediaId}
    RETURNING id
`,
);

/**
 * Delete all ratings for a user.
 */
export const deleteAllUserRatings = defineWriteQuery<{ userId: UserId }, { count: number }>(
    'deleteAllUserRatings',
    (sql, { userId }) => sql`
        WITH deleted AS (
            DELETE FROM user_ratings
            WHERE user_id = ${userId}
            RETURNING 1
        )
        SELECT COUNT(*)::int as count FROM deleted
    `,
);

export interface DemoEligibleMediaRow {
    media_id: string;
    primary_ext_id: string;
    title: string;
    media_type: MediaType;
}

/**
 * Fetch active media items that have a LIBRARY embedding, for seeding demo
 * ratings. Returns the internal UUID (`media_id`) directly so callers do not
 * need a second per-item resolve round-trip.
 */
export async function getDemoEligibleMedia(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
): Promise<DemoEligibleMediaRow[]> {
    if (deniesEverything(access)) return [];
    return sql<DemoEligibleMediaRow[]>`
        SELECT
            mi.id AS media_id,
            COALESCE(
                (
                    SELECT external_id
                    FROM external_ids
                    WHERE media_id = mi.id
                      AND provider = ${getPrimaryExternalIdProvider()}
                    LIMIT 1
                ),
                ''
            ) AS primary_ext_id,
            mi.title,
            mi.media_type
        FROM media_items mi
        JOIN media_embeddings me
            ON me.media_id = mi.id
            AND me.source = ${EMBEDDING_SOURCE.LIBRARY}
        WHERE mi.status = 'active'
          AND me.embedding IS NOT NULL
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        LIMIT ${limit}
    `;
}

/**
 * Bulk upsert demo ratings, refreshing `created_at` on conflict. Behaviour
 * matches the legacy per-row `INSERT ... ON CONFLICT DO UPDATE SET rating,
 * created_at` loop, but in a single round-trip.
 */
export async function bulkUpsertDemoRatings(
    sql: postgres.Sql,
    userId: UserId,
    items: Array<{ mediaId: string; rating: number }>,
): Promise<number> {
    if (items.length === 0) return 0;

    const userIds = items.map(() => userId);
    const mediaIds = items.map((r) => r.mediaId);
    const ratingValues = items.map((r) => r.rating);

    const result = await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, created_at, is_explicit)
        SELECT u, m, r, NOW(), true
        FROM unnest(
            ${userIds}::uuid[],
            ${mediaIds}::uuid[],
            ${ratingValues}::numeric[]
        ) AS t(u, m, r)
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            rating = EXCLUDED.rating,
            is_explicit = true,
            created_at = EXCLUDED.created_at
    `;

    return result.count;
}

/**
 * Bulk insert demo ratings (for onboarding).
 */
export async function bulkInsertRatings(
    sql: postgres.Sql,
    ratings: Array<{
        userId: UserId;
        mediaId: string;
        rating: number;
        suggestionContext?: string;
    }>,
): Promise<number> {
    if (ratings.length === 0) return 0;

    const userIds = ratings.map((r) => r.userId);
    const mediaIds = ratings.map((r) => r.mediaId);
    const ratingValues = ratings.map((r) => r.rating);
    const contexts = ratings.map((r) => r.suggestionContext ?? null);

    const result = await sql`
        INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, is_explicit)
        SELECT *, true FROM unnest(
            ${userIds}::uuid[],
            ${mediaIds}::uuid[],
            ${ratingValues}::integer[],
            ${contexts}::text[]
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            rating = EXCLUDED.rating,
            is_explicit = true,
            suggestion_context = EXCLUDED.suggestion_context
    `;

    return result.count;
}

// =============================================================================
// CTE Helpers for Complex Queries
// =============================================================================

/**
 * SQL fragment for getting a user's disliked media as a CTE.
 * Use in complex queries that need to exclude disliked content.
 *
 * @example
 * const query = sql`
 *   WITH disliked_media AS (${getDislikedMediaCTEFragment(sql, userId)})
 *   SELECT * FROM recommendations
 *   WHERE media_id NOT IN (SELECT media_id FROM disliked_media)
 * `;
 */
export function getDislikedMediaCTEFragment(sql: postgres.Sql, userId: UserId) {
    return sql`
        SELECT media_id
        FROM user_ratings
        WHERE user_id = ${userId} AND rating <= 4
    `;
}

/**
 * SQL fragment for getting a user's liked media as a CTE.
 */
export function getLikedMediaCTEFragment(sql: postgres.Sql, userId: UserId) {
    return sql`
        SELECT media_id, rating
        FROM user_ratings
        WHERE user_id = ${userId} AND rating >= 7
    `;
}

// =============================================================================
// Extended Queries with Full Metadata & Availability
// =============================================================================

export interface UserRatingFullRow {
    /**
     * `media_items.id` UUID. Internal-only: used as the multilingual-metadata
     * translation-overlay lookup key (spec §5) in the `ai/user-ratings.ts`
     * endpoint; NOT part of that endpoint's wire response shape.
     */
    media_id: string;
    primary_ext_id: string;
    media_type: MediaType;
    rating: number;
    created_at: Date;
    title: string;
    overview: string | null;
    imdb_rating: number | null;
    rt_rating: number | null;
    is_available: boolean;
    can_request: boolean;
    /** How the rating was entered — 'quick' | 'stars' | null (legacy rows / not provided). */
    rating_style: string | null;
    /**
     * `urv.created_at::text` — the exact micro-precision rendering, projected ONLY
     * so the cursor def can mint the next keyset cursor without a lossy `Date`
     * round-trip. Absent unless selected; not part of the wire response.
     */
    created_at_cursor?: string;
}

/**
 * Decoded keyset cursor for `getUserRatingsFullMetadata` — mirrors the
 * `(created_at DESC, media_id DESC)` ordering. `createdAt` is the raw
 * `urv.created_at::text` rendering (micro precision preserved end-to-end);
 * `id` is the `media_items.id` UUID tiebreak. `created_at` is NOT NULL, so
 * there is no NULL group to carry (Gate D2b is N/A here).
 */
export interface UserRatingsCursor {
    createdAt: string;
    id: string;
}

/**
 * Get user ratings with full metadata including availability.
 * Used for the user-ratings API endpoint.
 * Optimized: Uses LEFT JOINs instead of scalar subqueries for external IDs.
 * Uses idx_external_ids_tmdb_lookup and idx_external_ids_jellyfin_lookup partial indexes.
 */
export const getUserRatingsFullMetadata = defineQuery<
    {
        userId: UserId;
        ratingMin: number;
        limit: number;
        offset?: number;
        /**
         * Opt-in keyset cursor over `(created_at DESC, media_id DESC)`. When
         * supplied, `offset` is ignored: the query replaces OFFSET with a
         * `(created_at, mi.id) < (cursor)` predicate so a page is a stable window
         * that cannot drift when new ratings land between requests.
         */
        cursor?: UserRatingsCursor;
        /** REQUIRED. Use `unrestrictedAccess()` for a deliberately unfiltered read. */
        access: MediaAccessBoundary;
    },
    UserRatingFullRow
>(
    'getUserRatingsFullMetadata',
    (sql, { userId, ratingMin, limit, offset = 0, cursor, access }) => sql`
    SELECT
        mi.id AS media_id,
        COALESCE(primary_ext.external_id, '') as primary_ext_id,
        mi.media_type,
        urv.rating,
        urv.created_at,
        urv.created_at::text AS created_at_cursor,
        urv.rating_style,
        mi.title,
        (pm.metadata->>'overview')::text as overview,
        (pm.metadata->>'imdb_rating')::float as imdb_rating,
        (pm.metadata->>'rt_rating')::integer as rt_rating,
        ${isAvailableExpr(sql)} AS is_available,
        ${canRequestExpr(sql)} AS can_request
    FROM user_ratings urv
    JOIN media_items mi ON mi.id = urv.media_id
    LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
        AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
    ${sql.unsafe(buildOverrideAwareMetadataLateralJoin())}
    WHERE urv.user_id = ${userId}
      AND urv.rating >= ${ratingMin}
      AND mi.status = 'active'
      ${buildLibraryAccessFilter(sql, access.library)}
      ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
      ${
          cursor
              ? // pgTextTimestamp() pins the bind to OID 25 (TEXT) so postgres.js
                // ships the raw micro-precision string and Postgres parses it
                // server-side — a `::timestamptz` bind would truncate to ms via
                // `new Date(x).toISOString()`. See keyset-cursor.builder.ts.
                sql`AND (urv.created_at, mi.id) < (${pgTextTimestamp(sql, cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`
              : sql``
      }
    -- Gate H2: the id tiebreak is present in BOTH offset and cursor mode. It only
    -- reorders rows sharing an identical created_at (previously non-deterministic),
    -- and is required so the offset ordering matches the keyset for the J1 handoff.
    ORDER BY urv.created_at DESC, mi.id DESC
    ${cursor ? sql`LIMIT ${limit}` : sql`LIMIT ${limit} OFFSET ${offset}`}
`,
);

// =============================================================================
// Admin/Bulk Operations
// =============================================================================

/**
 * Delete all user ratings (simple version without returning count).
 * Used by reset-profile endpoint.
 */
export async function deleteUserRatingsSimple(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`DELETE FROM user_ratings WHERE user_id = ${userId}`;
}

/**
 * Delete user suggestions (companion to ratings deletion).
 */
export async function deleteUserSuggestions(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`DELETE FROM user_suggestions WHERE user_id = ${userId}`;
}

/**
 * Delete user profile.
 */
export async function deleteUserProfile(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
}

/**
 * Get count of user ratings.
 */
export async function countUserRatings(sql: postgres.Sql, userId: UserId): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM user_ratings WHERE user_id = ${userId}
    `;
    return parseInt(row?.count || '0', 10);
}

/**
 * Get count of user suggestions.
 */
export async function countUserSuggestions(sql: postgres.Sql, userId: UserId): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM user_suggestions WHERE user_id = ${userId}
    `;
    return parseInt(row?.count || '0', 10);
}

/**
 * Get count of user profiles.
 */
export async function countUserProfiles(sql: postgres.Sql, userId: UserId): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM user_profiles WHERE user_id = ${userId}
    `;
    return parseInt(row?.count || '0', 10);
}

/**
 * Get count of user watchlist items.
 */
export async function countUserWatchlist(sql: postgres.Sql, userId: UserId): Promise<number> {
    const [row] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM playlist_items wpi
        JOIN playlists wp ON wp.id = wpi.playlist_id
        WHERE wp.user_id = ${userId}::uuid
          AND wp.playlist_type = 'watchlist'
    `;
    return parseInt(row?.count || '0', 10);
}

/**
 * Ensure a user record exists (idempotent).
 */
export async function ensureUserExists(
    sql: postgres.Sql,
    username: string,
    options: { maxAgeRating?: number | null } = {},
): Promise<void> {
    const sharing = defaultActivitySharing();
    await sql`
        INSERT INTO users (username, allow_live_tv, hide_streams, share_listening_activity, share_audiobook_activity)
        VALUES (${username}, ${options.maxAgeRating == null ? null : false}, ${!sharing}, ${sharing}, ${sharing})
        ON CONFLICT (username) DO NOTHING
    `;
}

/**
 * Ensure a user profile exists for AI rating (idempotent).
 *
 * `userId` is the stable users.id UUID — `user_profiles.user_id` FKs `users(id)`
 * since migration 16.46.0, so a username would FK-fail here.
 */
export async function ensureUserProfileExists(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`
        INSERT INTO user_profiles (user_id, total_ratings, updated_at)
        VALUES (${userId}, 0, NOW())
        ON CONFLICT (user_id) DO NOTHING
    `;
}

/**
 * Delete a specific suggestion for a user by media UUID.
 */
export async function deleteUserSuggestionByMediaId(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
): Promise<void> {
    await sql`
        DELETE FROM user_suggestions
        WHERE user_id = ${userId} AND media_id = ${mediaId}::uuid
    `;
}

/**
 * Get the media_type for a media item by UUID.
 */
export async function getMediaTypeById(sql: postgres.Sql, mediaId: string): Promise<string | null> {
    const [row] = await sql<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${mediaId} LIMIT 1
    `;
    return row?.media_type ?? null;
}

export interface StarredItemRow {
    id: string;
    media_type: string;
}

/**
 * Return IDs and media_types of items the user has starred (rating = 10),
 * limited to artist / album / track, newest-starred first. Capped at 500.
 */
export async function getStarredItemIds(
    sql: postgres.Sql,
    userId: UserId,
    access: MediaAccessBoundary,
): Promise<StarredItemRow[]> {
    if (deniesEverything(access)) return [];
    return sql<StarredItemRow[]>`
        SELECT mi.id, mi.media_type
        FROM user_ratings ur
        JOIN media_items mi ON mi.id = ur.media_id
        WHERE ur.user_id = ${userId}
          AND ur.rating = 10
          AND mi.media_type IN ('artist', 'album', 'track')
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY ur.created_at DESC
        LIMIT 500
    `;
}

/**
 * Return album IDs the user has starred (rating = 10), newest-starred first.
 */
export async function getStarredAlbumIds(
    sql: postgres.Sql,
    userId: UserId,
    limit: number,
    access: MediaAccessBoundary,
): Promise<Array<{ id: string }>> {
    if (deniesEverything(access)) return [];
    return sql<Array<{ id: string }>>`
        SELECT mi.id
        FROM user_ratings ur
        JOIN media_items mi ON mi.id = ur.media_id
        WHERE ur.user_id = ${userId}
          AND ur.rating = 10
          AND mi.media_type = 'album'
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY ur.created_at DESC
        LIMIT ${limit}
    `;
}
