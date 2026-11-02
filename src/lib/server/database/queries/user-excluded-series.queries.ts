// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Excluded Series Query Module
 *
 * Excluded-series data lives in `user_media_flags` with
 * flag_type = 'series_excluded'. Rows are keyed by id, never by title; a
 * legacy 'series_name' row is neither read nor written:
 *
 *   target_type 'series'      target_id = media_items.id (lowercase uuid text).
 *                             Names a catalog item; despite the type name it is
 *                             also used for a catalog MOVIE muted from the
 *                             calendar.
 *   target_type 'tmdb_tv'     target_id = 'tv:<tmdb id>'  (no catalog row yet)
 *   target_type 'tmdb_movie'  target_id = 'movie:<tmdb id>'
 *
 * The TMDB target ids carry the media type because the flag table is unique on
 * (user_id, target_id, flag_type) and a TMDB id is only unique per media type.
 *
 * The ExcludedSeriesRow shape is synthesised from user_media_flags columns:
 *
 *   id          - user_media_flags.id (uuid as string)
 *   series_name - display label (catalog title, else a title seen in the arr
 *                 projection, else 'TMDB <id>')
 *   media_id    - target_id when target_type='series', else null
 *   tmdb_id     - the TMDB id for tmdb_* rows, else null
 *   kind        - 'series' | 'tmdb_tv' | 'tmdb_movie'
 *   excluded_at - user_media_flags.created_at
 */

import { defineQuery, defineWriteQuery } from '../typed-query.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export type ExcludedSeriesKind = 'series' | 'tmdb_tv' | 'tmdb_movie';

export interface ExcludedSeriesRow {
    id: string;
    user_id: string;
    series_name: string;
    media_id: string | null;
    tmdb_id: string | null;
    kind: ExcludedSeriesKind;
    excluded_at: Date;
}

/** Raw key of one `series_excluded` flag, for the matcher's loader. */
export interface ExcludedSeriesKeyRow {
    target_type: string;
    target_id: string;
}

/** Prefix of a `tmdb_tv` / `tmdb_movie` target id. */
export const TMDB_TARGET_PREFIX = { tmdb_tv: 'tv:', tmdb_movie: 'movie:' } as const;

/** Flag target id for a TMDB key, e.g. `tv:1234`. */
export function tmdbTargetId(kind: 'tmdb_tv' | 'tmdb_movie', tmdbId: string): string {
    return `${TMDB_TARGET_PREFIX[kind]}${tmdbId}`;
}

// =============================================================================
// Read Queries
// =============================================================================

/**
 * Get all excluded series for a user, with a display label per row.
 *
 * The label comes from the catalog when the item exists, for tmdb rows from the
 * Sonarr/Radarr projection, and otherwise falls back to 'TMDB <id>'.
 */
export const getExcludedSeries = defineQuery<{ userId: UserId }, ExcludedSeriesRow>(
    'getExcludedSeries',
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status -- user_id-scoped read of the caller's OWN series_excluded flags; media_items is only a title lookup for the row label. Library/age gating must NOT apply (a user must see, and be able to clear, their own exclusion even for a now-denied title).
    (sql, { userId }) => sql`
        SELECT
            f.id::text AS id,
            f.user_id,
            COALESCE(
                CASE f.target_type
                    WHEN 'series' THEN (
                        SELECT mi.title FROM media_items mi
                        WHERE mi.id = CASE WHEN f.target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                           THEN f.target_id::uuid END
                    )
                    WHEN 'tmdb_tv' THEN COALESCE(
                        (
                            SELECT mi.title
                            FROM external_ids ei
                            JOIN media_items mi ON mi.id = ei.media_id AND mi.media_type = 'tv'
                            WHERE ei.provider = 'tmdb' AND ei.media_type = 'tv'
                              AND ei.external_id = split_part(f.target_id, ':', 2)
                            LIMIT 1
                        ),
                        (
                            SELECT ur.series_title FROM upcoming_releases ur
                            WHERE ur.media_type = 'episode' AND ur.series_title IS NOT NULL
                              AND ur.tmdb_id::text = split_part(f.target_id, ':', 2)
                            LIMIT 1
                        )
                    )
                    WHEN 'tmdb_movie' THEN COALESCE(
                        (
                            SELECT mi.title
                            FROM external_ids ei
                            JOIN media_items mi ON mi.id = ei.media_id AND mi.media_type = 'movie'
                            WHERE ei.provider = 'tmdb' AND ei.media_type = 'movie'
                              AND ei.external_id = split_part(f.target_id, ':', 2)
                            LIMIT 1
                        ),
                        (
                            SELECT ur.title FROM upcoming_releases ur
                            WHERE ur.media_type = 'movie'
                              AND ur.tmdb_id::text = split_part(f.target_id, ':', 2)
                            LIMIT 1
                        )
                    )
                END,
                CASE WHEN f.target_type IN ('tmdb_tv', 'tmdb_movie')
                     THEN 'TMDB ' || split_part(f.target_id, ':', 2) END,
                ''
            ) AS series_name,
            CASE WHEN f.target_type = 'series' THEN f.target_id END AS media_id,
            CASE WHEN f.target_type IN ('tmdb_tv', 'tmdb_movie')
                 THEN split_part(f.target_id, ':', 2) END AS tmdb_id,
            f.target_type AS kind,
            f.created_at AS excluded_at
        FROM user_media_flags f
        WHERE f.user_id = ${userId}
          AND f.flag_type = 'series_excluded'
          AND f.target_type IN ('series', 'tmdb_tv', 'tmdb_movie')
        ORDER BY f.created_at DESC
    `,
);

/** Raw keys of every `series_excluded` flag a user holds. */
export const getExcludedSeriesKeys = defineQuery<{ userId: UserId }, ExcludedSeriesKeyRow>(
    'getExcludedSeriesKeys',
    (sql, { userId }) => sql`
        SELECT target_type, target_id
        FROM user_media_flags
        WHERE user_id = ${userId}
          AND flag_type = 'series_excluded'
    `,
);

/**
 * Catalog items carrying one of the given TMDB ids. Composite key: a TV id is
 * matched only against TV items and a movie id only against movies.
 */
export const resolveTmdbToCatalogIds = defineQuery<
    { tvIds: string[]; movieIds: string[] },
    { id: string; external_id: string; media_type: string }
>(
    'resolveTmdbToCatalogIds',
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status -- id resolution for the caller's OWN exclusion keys; no media fields are returned. Library/age gating must NOT apply (a mute must keep matching a title the user can no longer see).
    (sql, { tvIds, movieIds }) => sql`
        SELECT mi.id::text AS id, ei.external_id, mi.media_type
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id
        WHERE ei.provider = 'tmdb'
          AND (
              (ei.media_type = 'tv' AND mi.media_type = 'tv'
                  AND ei.external_id = ANY(${sql.array(tvIds)}::text[]))
              OR (ei.media_type = 'movie' AND mi.media_type = 'movie'
                  AND ei.external_id = ANY(${sql.array(movieIds)}::text[]))
          )
    `,
);

/** TMDB (and, for series, TVDB) ids of catalog items, with the media type that scopes each id. */
export const resolveCatalogIdsToExternal = defineQuery<
    { ids: string[] },
    { provider: 'tmdb' | 'tvdb'; external_id: string; media_type: string }
>(
    'resolveCatalogIdsToExternal',
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status -- id resolution for the caller's OWN exclusion keys; no media fields beyond the provider ids are returned. Library/age gating must NOT apply.
    (sql, { ids }) => sql`
        SELECT ei.provider, ei.external_id, mi.media_type
        FROM media_items mi
        JOIN external_ids ei ON ei.media_id = mi.id
                            AND ei.media_type = mi.media_type
        WHERE mi.id = ANY(${sql.array(ids)}::uuid[])
          AND mi.media_type IN ('tv', 'movie')
          AND (ei.provider = 'tmdb' OR (ei.provider = 'tvdb' AND mi.media_type = 'tv'))
    `,
);

// =============================================================================
// Write Queries
// =============================================================================

/**
 * Add or update an excluded series.
 *
 * The key is chosen in this order: a catalog `mediaId` (target_type='series'),
 * else a `tmdbId` with its `tmdbType` (target_type='tmdb_tv' / 'tmdb_movie').
 * A row without either key inserts nothing: a mute is never keyed by title.
 *
 * Upsert semantics: ON CONFLICT (user_id, target_id, flag_type) DO UPDATE
 * refreshes created_at.
 *
 * A catalog-keyed row is written only while that media row exists and is a
 * series or movie (an episode or season id would never match a mute), under a KEY
 * SHARE lock (as in `setFlag`), so it cannot orphan against a concurrent
 * unavailable-media retention delete; a missing target inserts nothing.
 */
export const upsertExcludedSeries = defineWriteQuery<
    {
        userId: UserId;
        seriesName: string;
        tmdbType?: 'tv' | 'movie' | null;
    } & ({ mediaId: string; tmdbId?: string | null } | { mediaId?: null; tmdbId: string }),
    ExcludedSeriesRow
>('upsertExcludedSeries', (sql, { userId, seriesName, mediaId, tmdbId, tmdbType }) => {
    const normalizedMediaId = mediaId != null && isUuid(mediaId) ? normalizeUuid(mediaId) : null;
    const tmdbKind = tmdbType === 'movie' ? 'tmdb_movie' : 'tmdb_tv';
    const hasKey = mediaId != null || tmdbId != null;
    let targetType: string = tmdbKind;
    let targetId = '';
    if (mediaId != null) {
        targetType = 'series';
        targetId = normalizedMediaId ?? mediaId;
    } else if (tmdbId != null) {
        targetId = tmdbTargetId(tmdbKind, tmdbId);
    }
    // Existence check only (the caller gates access); no media fields are returned,
    // and a mute may name a title without files (a muted upcoming series).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    return sql`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type, created_at, expires_at)
            SELECT
                ${userId},
                ${targetId},
                ${targetType},
                'series_excluded',
                NOW(),
                NULL::timestamptz
            WHERE ${hasKey}::boolean AND (${mediaId == null}::boolean OR EXISTS (
                SELECT 1 FROM media_items
                WHERE id = ${normalizedMediaId}::uuid
                  AND media_type IN ('tv', 'movie')
                FOR KEY SHARE
            ))
            ON CONFLICT (user_id, target_id, flag_type)
            DO UPDATE SET created_at = NOW()
            RETURNING
                id::text              AS id,
                user_id,
                ${seriesName}::text   AS series_name,
                CASE
                    WHEN target_type = 'series' THEN target_id
                    ELSE NULL
                END                   AS media_id,
                CASE
                    WHEN target_type IN ('tmdb_tv', 'tmdb_movie') THEN split_part(target_id, ':', 2)
                    ELSE NULL
                END                   AS tmdb_id,
                target_type           AS kind,
                created_at            AS excluded_at
        `;
});

/** Remove one exclusion by its flag row id (as listed by `getExcludedSeries`). */
export const removeExcludedSeriesById = defineWriteQuery<
    { userId: UserId; id: string },
    { id: string }
>(
    'removeExcludedSeriesById',
    (sql, { userId, id }) => sql`
        DELETE FROM user_media_flags
        WHERE id = ${id}::uuid
          AND user_id = ${userId}
          AND flag_type = 'series_excluded'
        RETURNING id::text AS id
    `,
);

/**
 * Remove all excluded series for a user.
 */
export const clearExcludedSeries = defineWriteQuery<{ userId: UserId }, { count: number }>(
    'clearExcludedSeries',
    (sql, { userId }) => sql`
        WITH deleted AS (
            DELETE FROM user_media_flags
            WHERE user_id = ${userId}
              AND flag_type = 'series_excluded'
            RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted
    `,
);
