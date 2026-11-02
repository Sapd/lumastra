// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Watch History Query Module
 *
 * Centralized queries for watched-item lookups.
 * Used for "Because you watched" recommendations, filtering watched content, etc.
 *
 * All queries read from user_media_state (is_watched = true) — the single source of truth.
 *
 * Key principle: Always include media_type alongside tmdb_id to avoid ID collisions.
 *
 * ## Access boundary
 *
 * Every query here takes a REQUIRED {@link MediaAccessBoundary}. There is no
 * permissive default and no optional access parameter: a call site that wants
 * unfiltered rows must write {@link unrestrictedAccess} so the decision is
 * greppable rather than invisible by omission.
 *
 * The module splits into two groups, and the split is load-bearing:
 *
 * **Enforcing queries** — `getRecentWatchedMoviesWithEmbeddings`,
 * `getRecentWatchedTvWithEmbeddings`, `getRecentWatchedWithTitles`. These join
 * `media_items` as `mi`, which is the alias `buildLibraryAccessFilter` hardcodes
 * and `buildAgeRatingFilter` defaults to, so both predicates splice in directly
 * and both axes are genuinely enforced in SQL.
 *
 * **Non-enforcing queries** — `getWatchedItems`, `getWatchedMovies`,
 * `getWatchedTvShows`, `getWatchedCount`, `getWatchedMovieCount`,
 * `getWatchedTvCount`. These join only `user_media_state` + `external_ids`;
 * there is no `media_items` row in scope, so the shared builders cannot be used
 * (`mi.id` would be a missing-FROM-clause error) and a real predicate would
 * require adding `JOIN media_items` — a structural change that would alter which
 * rows existing callers see, which this migration explicitly must not do.
 *
 * They still take the required boundary, and {@link assertNoMediaItemsScope}
 * makes that honest: `all`/`any` emits nothing (byte-identical SQL to before),
 * `denyAll` emits `AND false`, and anything narrower THROWS rather than silently
 * returning unfiltered rows. A caller that needs real filtering on these must
 * either filter downstream (see `for-you/watching-sources.ts`) or the query must
 * first be restructured in a dedicated, behaviour-changing PR.
 *
 * Known consequence, deliberately preserved: `/api/watched` and the assistant's
 * `get_watch_stats` therefore surface ids/counts for content the user's current
 * library-group membership would deny. Pre-existing; see the call sites.
 */

import { defineQuery } from '../typed-query.js';
import type postgres from 'postgres';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything, isUnrestricted } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type { UserId } from '$lib/shared/user-id';
import { buildSocialVisibilityFilter } from './builders/social-visibility.builder.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'movie' | 'tv';

/**
 * Access gate for the queries in this module that have no `media_items` row in
 * scope and therefore cannot express the library/age predicates.
 *
 * - `all` + `any` -> empty fragment. Identical SQL to the pre-boundary version.
 * - `denyAll` on either axis -> `AND false`. Enforceable without any join, and
 *   it is the state the legacy shape could not express at all.
 * - anything narrower -> throws.
 *
 * The throw is the point. A required parameter that is quietly ignored is worse
 * than no parameter: it reads at the call site as though filtering happened. No
 * current caller passes a narrower boundary, so this never fires today; if one
 * ever does, it fails loudly instead of failing open.
 */
function assertNoMediaItemsScope(
    sql: postgres.Sql,
    queryName: string,
    access: MediaAccessBoundary,
): postgres.PendingQuery<postgres.Row[]> {
    if (deniesEverything(access)) return sql`AND false`;
    if (isUnrestricted(access)) return sql``;
    throw new Error(
        `${queryName}: cannot enforce a restricted MediaAccessBoundary — this query does not ` +
            `join media_items, so the library/age predicates have no row to bind to. Pass ` +
            `unrestrictedAccess() and filter downstream, or restructure the query first.`,
    );
}

export interface WatchedItemRow {
    internal_id: string | null;
    tmdb_id: string;
    media_type: MediaType;
}

export interface WatchedItemWithTitleRow extends WatchedItemRow {
    title: string;
    watched_at: Date;
}

export interface WatchedSourceRow extends WatchedItemWithTitleRow {
    media_id: string;
}

// =============================================================================
// Basic Watch History Queries
// =============================================================================

/**
 * Get all watched items for a user (TMDB ID + media_type).
 * Returns distinct items for filtering recommendations.
 *
 * NON-ENFORCING: no `media_items` in scope — see the module docstring. Callers
 * pass `unrestrictedAccess()`; a narrower boundary throws.
 */
export const getWatchedItems = defineQuery<
    { userId: UserId; access: MediaAccessBoundary },
    WatchedItemRow
>(
    'getWatchedItems',
    (sql, { userId, access }) => sql`
        SELECT DISTINCT ON (ei.external_id, ei.media_type)
            uws.media_id::text as internal_id,
            ei.external_id as tmdb_id,
            ei.media_type
        FROM user_media_state uws
        JOIN external_ids ei ON ei.media_id = uws.media_id AND ei.provider = ${getPrimaryExternalIdProvider()}
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          AND ei.media_type IN ('movie', 'tv')
          ${assertNoMediaItemsScope(sql, 'getWatchedItems', access)}
    `,
);

/**
 * Get watched movies only.
 *
 * NON-ENFORCING: see {@link getWatchedItems}.
 */
export const getWatchedMovies = defineQuery<
    { userId: UserId; limit: number; access: MediaAccessBoundary },
    WatchedItemRow
>(
    'getWatchedMovies',
    (sql, { userId, limit, access }) => sql`
        SELECT DISTINCT ei.external_id as tmdb_id, ei.media_type
        FROM user_media_state uws
        JOIN external_ids ei ON ei.media_id = uws.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.media_type = 'movie'
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          ${assertNoMediaItemsScope(sql, 'getWatchedMovies', access)}
        ORDER BY ei.external_id
        LIMIT ${limit}
    `,
);

/**
 * Get watched TV shows only.
 *
 * NON-ENFORCING: see {@link getWatchedItems}.
 */
export const getWatchedTvShows = defineQuery<
    { userId: UserId; limit: number; access: MediaAccessBoundary },
    WatchedItemRow
>(
    'getWatchedTvShows',
    (sql, { userId, limit, access }) => sql`
        SELECT DISTINCT ei.external_id as tmdb_id, ei.media_type
        FROM user_media_state uws
        JOIN external_ids ei ON ei.media_id = uws.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.media_type = 'tv'
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          ${assertNoMediaItemsScope(sql, 'getWatchedTvShows', access)}
        ORDER BY ei.external_id
        LIMIT ${limit}
    `,
);

// =============================================================================
// "Because You Watched" Source Queries
// =============================================================================

/**
 * Get recently watched movies with embeddings for "Because you watched" sources.
 * Requires media to have embeddings for similarity search.
 *
 * ENFORCING: joins `media_items` as `mi`, so both boundary axes are applied here.
 */
export const getRecentWatchedMoviesWithEmbeddings = defineQuery<
    { userId: UserId; limit: number; access: MediaAccessBoundary },
    WatchedSourceRow
>(
    'getRecentWatchedMoviesWithEmbeddings',
    (sql, { userId, limit, access }) => sql`
    SELECT
        ei.external_id as tmdb_id,
        ei.media_type,
        mi.title,
        uws.last_watched_at as watched_at,
        uws.media_id
    FROM user_media_state uws
    JOIN media_items mi ON mi.id = uws.media_id
    JOIN external_ids ei ON ei.media_id = uws.media_id
        AND ei.provider = ${getPrimaryExternalIdProvider()}
        AND ei.media_type = 'movie'
    INNER JOIN media_embeddings me ON me.media_id = uws.media_id
        AND me.source = ${EMBEDDING_SOURCE.LIBRARY}
    WHERE uws.user_id = ${userId}
      AND uws.is_watched = true
      AND mi.media_type = 'movie'
      AND mi.status = 'active'
      ${buildLibraryAccessFilter(sql, access.library)}
      ${buildAgeRatingFilter(sql, access.age)}
    ORDER BY uws.last_watched_at DESC
    LIMIT ${limit}
`,
);

/**
 * Get recently watched TV shows with embeddings for "Because you watched" sources.
 *
 * ENFORCING: joins `media_items` as `mi`, so both boundary axes are applied here.
 */
export const getRecentWatchedTvWithEmbeddings = defineQuery<
    { userId: UserId; limit: number; access: MediaAccessBoundary },
    WatchedSourceRow
>(
    'getRecentWatchedTvWithEmbeddings',
    (sql, { userId, limit, access }) => sql`
    SELECT
        ei.external_id as tmdb_id,
        ei.media_type,
        mi.title,
        uws.last_watched_at as watched_at,
        uws.media_id
    FROM user_media_state uws
    JOIN media_items mi ON mi.id = uws.media_id
    JOIN external_ids ei ON ei.media_id = uws.media_id
        AND ei.provider = ${getPrimaryExternalIdProvider()}
        AND ei.media_type = 'tv'
    INNER JOIN media_embeddings me ON me.media_id = uws.media_id
        AND me.source = ${EMBEDDING_SOURCE.LIBRARY}
    WHERE uws.user_id = ${userId}
      AND uws.is_watched = true
      AND mi.media_type = 'tv'
      AND mi.status = 'active'
      ${buildLibraryAccessFilter(sql, access.library)}
      ${buildAgeRatingFilter(sql, access.age)}
    ORDER BY uws.last_watched_at DESC
    LIMIT ${limit}
`,
);

/**
 * Get recently watched items with titles (both movies and TV).
 * Useful for display purposes.
 *
 * ENFORCING: joins `media_items` as `mi`, so both boundary axes are applied here.
 */
export const getRecentWatchedWithTitles = defineQuery<
    { userId: UserId; limit: number; access: MediaAccessBoundary },
    WatchedItemWithTitleRow
>(
    'getRecentWatchedWithTitles',
    // Re-gated on CURRENT access: a title the user watched may since have moved
    // into a library group now denied to them (parity with get_my_ratings /
    // get_watchlist). Both axes are bound here; which of them the assistant
    // actually narrows is now the call site's explicit, greppable decision — see
    // assistant-service.ts and get-watch-history.tool.ts.
    (sql, { userId, limit, access }) => sql`
    SELECT
        ei.external_id as tmdb_id,
        ei.media_type,
        mi.title,
        uws.last_watched_at as watched_at
    FROM user_media_state uws
    JOIN media_items mi ON mi.id = uws.media_id
    JOIN external_ids ei ON ei.media_id = uws.media_id AND ei.provider = ${getPrimaryExternalIdProvider()}
    WHERE uws.user_id = ${userId}
      AND uws.is_watched = true
      AND ei.media_type IN ('movie', 'tv')
      AND mi.status = 'active'
      ${buildLibraryAccessFilter(sql, access.library)}
      ${buildAgeRatingFilter(sql, access.age)}
    ORDER BY uws.last_watched_at DESC
    LIMIT ${limit}
`,
);

/**
 * Consent-gated watch history for a named social peer. This is intentionally
 * not a general user lookup: the subject is resolved inside the query and the
 * shared social predicate is applied before any title leaves the database.
 */
export const getSharedRecentWatchedWithTitles = defineQuery<
    { viewerId: UserId; username: string; limit: number; access: MediaAccessBoundary },
    WatchedItemWithTitleRow
>(
    'getSharedRecentWatchedWithTitles',
    (sql, { viewerId, username, limit, access }) => sql`
    SELECT
        ei.external_id as tmdb_id,
        ei.media_type,
        mi.title,
        uws.last_watched_at as watched_at
    FROM users subject
    JOIN user_media_state uws ON uws.user_id = subject.id
    JOIN media_items mi ON mi.id = uws.media_id
    JOIN external_ids ei ON ei.media_id = uws.media_id
        AND ei.provider = ${getPrimaryExternalIdProvider()}
    WHERE lower(subject.username) = lower(${username})
      AND uws.is_watched = true
      AND ei.media_type IN ('movie', 'tv')
      AND mi.status = 'active'
      ${buildLibraryAccessFilter(sql, access.library)}
      ${buildAgeRatingFilter(sql, access.age)}
      ${buildSocialVisibilityFilter(sql, {
          viewerId,
          subjectAlias: 'subject',
          media: { alias: 'uws', column: 'media_id' },
      })}
    ORDER BY uws.last_watched_at DESC
    LIMIT ${limit}
`,
);

// =============================================================================
// Watch History Count Queries
// =============================================================================

/**
 * Get total watched item count for a user.
 *
 * NON-ENFORCING: see {@link getWatchedItems}.
 */
export const getWatchedCount = defineQuery<
    { userId: UserId; access: MediaAccessBoundary },
    { count: number }
>(
    'getWatchedCount',
    (sql, { userId, access }) => sql`
        SELECT COUNT(DISTINCT uws.media_id)::int as count
        FROM user_media_state uws
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          ${assertNoMediaItemsScope(sql, 'getWatchedCount', access)}
    `,
);

/**
 * Get watched movie count for a user.
 *
 * NON-ENFORCING: see {@link getWatchedItems}.
 */
export const getWatchedMovieCount = defineQuery<
    { userId: UserId; access: MediaAccessBoundary },
    { count: number }
>(
    'getWatchedMovieCount',
    (sql, { userId, access }) => sql`
        SELECT COUNT(DISTINCT uws.media_id)::int as count
        FROM user_media_state uws
        JOIN external_ids ei ON ei.media_id = uws.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.media_type = 'movie'
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          ${assertNoMediaItemsScope(sql, 'getWatchedMovieCount', access)}
    `,
);

/**
 * Get watched TV show count for a user.
 *
 * NON-ENFORCING: see {@link getWatchedItems}.
 */
export const getWatchedTvCount = defineQuery<
    { userId: UserId; access: MediaAccessBoundary },
    { count: number }
>(
    'getWatchedTvCount',
    (sql, { userId, access }) => sql`
        SELECT COUNT(DISTINCT uws.media_id)::int as count
        FROM user_media_state uws
        JOIN external_ids ei ON ei.media_id = uws.media_id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.media_type = 'tv'
        WHERE uws.user_id = ${userId}
          AND uws.is_watched = true
          ${assertNoMediaItemsScope(sql, 'getWatchedTvCount', access)}
    `,
);
