// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Status Query Module
 *
 * Centralized queries for episode and movie watch status operations.
 * Uses unified media_items table with hierarchy (series → season → episode).
 *
 * Key tables:
 * - user_media_state: Unified watch tracking (UUID-based)
 * - user_movie_watch_status: Per-movie watch tracking (legacy)
 * - media_items: Unified media catalog with hierarchy
 * - external_ids: Provider ID mappings
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { defineQuery } from '../typed-query.js';
import { Logger } from '../../utils/logger.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';
import { EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';

const logger = Logger.for('WatchStatusQueries');

// =============================================================================
// Types
// =============================================================================

export interface EpisodeWatchStatusRow {
    episode_id: string;
    season_number: number | null;
    episode_number: number | null;
    is_watched: boolean;
    resume_position_ms: number;
    runtime_ms: number | null;
    last_watched_at: string | null;
    last_event_at: string | null;
}

export interface EpisodeRow {
    id: string;
    runtime_seconds: number | null;
    season_number: number | null;
    episode_number: number | null;
}

// =============================================================================
// Episode Watch Status - Read Queries
// =============================================================================

/**
 * Get episodes with watch status for a series.
 * LEFT JOIN ensures we get all episodes even without watch status.
 */
export const getSeriesEpisodesWithWatchStatus = defineQuery<
    { seriesId: string; userId: UserId },
    EpisodeWatchStatusRow
>(
    'getSeriesEpisodesWithWatchStatus',
    (sql, { seriesId, userId }) => sql`
    SELECT
        ep.id as episode_id,
        COALESCE(eo.order_season_number, ep.season_number) as season_number,
        COALESCE(eo.order_episode_number, ep.episode_number) as episode_number,
        COALESCE(ws.is_watched, false) as is_watched,
        COALESCE(ws.resume_position_ms, 0) as resume_position_ms,
        COALESCE(ws.runtime_ms, ep.runtime_seconds::bigint * 1000) as runtime_ms,
        ws.last_watched_at,
        ws.last_event_at
    FROM media_items ep
    JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
    ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
    LEFT JOIN user_media_state ws ON ws.media_id = ep.id AND ws.user_id = ${userId}
    WHERE season.parent_id = ${seriesId}::uuid
      AND ep.media_type = 'episode'
      -- Exclude ordering segments (unmapped episodes when ordering is active)
      AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
    ORDER BY COALESCE(eo.order_season_number, ep.season_number),
             COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number)
`,
);

/**
 * Get episodes with watch status for a specific season.
 */
export const getSeasonEpisodesWithWatchStatus = defineQuery<
    { seriesId: string; seasonNumber: number; userId: UserId },
    EpisodeWatchStatusRow
>(
    'getSeasonEpisodesWithWatchStatus',
    (sql, { seriesId, seasonNumber, userId }) => sql`
    SELECT
        ep.id as episode_id,
        COALESCE(eo.order_season_number, ep.season_number) as season_number,
        COALESCE(eo.order_episode_number, ep.episode_number) as episode_number,
        COALESCE(ws.is_watched, false) as is_watched,
        COALESCE(ws.resume_position_ms, 0) as resume_position_ms,
        COALESCE(ws.runtime_ms, ep.runtime_seconds::bigint * 1000) as runtime_ms,
        ws.last_watched_at,
        ws.last_event_at
    FROM media_items ep
    JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
    ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
    LEFT JOIN user_media_state ws ON ws.media_id = ep.id AND ws.user_id = ${userId}
    WHERE season.parent_id = ${seriesId}::uuid
      AND COALESCE(eo.order_season_number, ep.season_number) = ${seasonNumber}
      AND ep.media_type = 'episode'
      -- Exclude ordering segments (unmapped episodes when ordering is active)
      AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
    ORDER BY COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number)
`,
);

// =============================================================================
// Episode Queries - Lookup Queries
// =============================================================================

/**
 * Get all episodes for a series.
 */
export const getSeriesEpisodes = defineQuery<{ seriesId: string }, EpisodeRow>(
    'getSeriesEpisodes',
    (sql, { seriesId }) => sql`
        SELECT ep.id, ep.runtime_seconds,
               COALESCE(eo.order_season_number, ep.season_number) as season_number,
               COALESCE(eo.order_episode_number, ep.episode_number) as episode_number
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
        WHERE season.parent_id = ${seriesId}::uuid
          AND ep.media_type = 'episode'
          -- Exclude ordering segments (unmapped episodes when ordering is active)
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
        ORDER BY COALESCE(eo.order_season_number, ep.season_number),
                 COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number)
    `,
);

/**
 * Get episodes for a specific season.
 */
export const getSeasonEpisodes = defineQuery<
    { seriesId: string; seasonNumber: number },
    EpisodeRow
>(
    'getSeasonEpisodes',
    (sql, { seriesId, seasonNumber }) => sql`
    SELECT ep.id, ep.runtime_seconds,
           COALESCE(eo.order_season_number, ep.season_number) as season_number,
           COALESCE(eo.order_episode_number, ep.episode_number) as episode_number
    FROM media_items ep
    JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
    ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
    WHERE season.parent_id = ${seriesId}::uuid
      AND COALESCE(eo.order_season_number, ep.season_number) = ${seasonNumber}
      AND ep.media_type = 'episode'
      -- Exclude ordering segments (unmapped episodes when ordering is active)
      AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
    ORDER BY COALESCE(eo.order_episode_number, ep.sort_order, ep.episode_number)
`,
);

/**
 * Get episode IDs for a series (lightweight, just IDs).
 * Respects custom episode orderings — excludes unmapped segments.
 */
export async function getSeriesEpisodeIds(sql: postgres.Sql, seriesId: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT ep.id
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
        WHERE season.parent_id = ${seriesId}::uuid
          AND ep.media_type = 'episode'
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
    `;
    return rows.map((r) => r.id);
}

/**
 * Get every episode of a series with its effective order key
 * (`COALESCE(eo.order_*, mi.*) season * MULTIPLIER + episode`) plus the
 * user's current `is_watched` state. Used by the "Set my progress" flow
 * so the service can compute a delta against current state and only emit
 * events for episodes that actually changed — re-emitting `mark_watched`
 * for an already-watched row would bump its `last_watched_at` to "now"
 * and scramble the NextUp anchor (which picks the most-recently-watched).
 *
 * Excludes ordering segments (unmapped episodes when an ordering is
 * active) for the same reason `getSeriesEpisodeIds` does — they're not
 * part of the user-visible main-line progression.
 */
export async function getSeriesEpisodesWithOrderAndState(
    sql: postgres.Sql,
    seriesId: string,
    userId: UserId,
): Promise<Array<{ id: string; effective_order: number; is_watched: boolean }>> {
    return await sql<{ id: string; effective_order: number; is_watched: boolean }[]>`
        SELECT
            ep.id,
            (COALESCE(eo.order_season_number, ep.season_number) * ${EPISODE_ORDER_MULTIPLIER}
             + COALESCE(eo.order_episode_number, ep.episode_number)) AS effective_order,
            COALESCE(uws.is_watched, false) AS is_watched
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
        LEFT JOIN user_media_state uws
            ON uws.media_id = ep.id AND uws.user_id = ${userId}
        WHERE season.parent_id = ${seriesId}::uuid
          AND ep.media_type = 'episode'
          AND ep.season_number IS NOT NULL
          AND ep.episode_number IS NOT NULL
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
        ORDER BY effective_order ASC
    `;
}

/**
 * Get episode IDs for a specific season (lightweight, just IDs).
 * Respects custom episode orderings — uses remapped season numbers and excludes unmapped segments.
 */
export async function getSeasonEpisodeIds(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT ep.id
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep')}
        WHERE season.parent_id = ${seriesId}::uuid
          AND COALESCE(eo.order_season_number, ep.season_number) = ${seasonNumber}
          AND ep.media_type = 'episode'
          AND (seo.media_id IS NULL OR eo.episode_media_id IS NOT NULL)
    `;
    return rows.map((r) => r.id);
}

// =============================================================================
// User Watch History (UUID-based queries)
// =============================================================================

/**
 * Check if a user has watched a specific media item.
 * Reads from user_media_state.is_watched — the single source of truth.
 *
 * @param sql - Postgres SQL instance
 * @param userId - User identifier
 * @param mediaId - Internal UUID of the media item
 * @returns True if the user has watched the item, false otherwise
 */
export async function hasUserWatched(
    sql: postgres.Sql,
    userId: UserId,
    mediaId: string,
): Promise<boolean> {
    if (!userId || !mediaId) return false;

    try {
        const rows = await sql<{ is_watched: boolean }[]>`
            SELECT 1 FROM user_media_state
            WHERE user_id = ${userId} AND media_id = ${mediaId}::uuid AND is_watched = true
            LIMIT 1
        `;
        return rows.length > 0;
    } catch (error: unknown) {
        logger.error(
            'Failed to check user watch status',
            error instanceof Error ? error : undefined,
            { userId, mediaId },
        );
        return false;
    }
}

/**
 * Batch check watch status for multiple items.
 * Reads from user_media_state.is_watched — the single source of truth.
 *
 * @param sql - Postgres SQL instance
 * @param userId - User identifier
 * @param mediaIds - Array of internal UUIDs to check
 * @returns Map of mediaId -> boolean (true if watched)
 */
export async function batchGetWatchStatus(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
): Promise<Map<string, boolean>> {
    if (!userId || mediaIds.length === 0) {
        return new Map();
    }

    try {
        const watchedItems = await sql<{ media_id: string }[]>`
            SELECT media_id
            FROM user_media_state
            WHERE user_id = ${userId}
              AND media_id = ANY(${mediaIds}::uuid[])
              AND is_watched = true
        `;

        const watchedMap = new Map<string, boolean>();
        for (const id of mediaIds) {
            watchedMap.set(id, false);
        }
        for (const item of watchedItems) {
            watchedMap.set(item.media_id, true);
        }

        return watchedMap;
    } catch (error: unknown) {
        logger.error(
            'Failed to batch get watch status',
            error instanceof Error ? error : undefined,
            { userId, mediaIdCount: mediaIds.length },
        );
        return new Map();
    }
}

/**
 * Batch check watch status for multiple items using TMDB composite keys.
 * Resolves TMDB IDs to UUIDs internally.
 *
 * @param sql - Postgres SQL instance
 * @param userId - User identifier
 * @param items - Array of {tmdb_id, media_type} objects
 * @returns Map of "tmdb_id:media_type" -> boolean (true if watched)
 */
export async function getWatchedStatusBatch(
    sql: postgres.Sql,
    userId: UserId,
    items: Array<{ ext_id: string; media_type: string }>,
): Promise<Map<string, boolean>> {
    if (items.length === 0) {
        return new Map();
    }

    try {
        const { batchResolveMediaIds } = await import('./media-queries.js');

        const resolved = await batchResolveMediaIds(
            sql,
            items.map((i) => ({
                tmdbId: i.ext_id,
                mediaType: i.media_type,
            })),
        );

        const mediaIds = Array.from(resolved.values());
        if (mediaIds.length === 0) {
            return new Map();
        }

        const watchedItems = await sql<{ media_id: string; tmdb_id: string; media_type: string }[]>`
            SELECT uws.media_id, e.external_id as tmdb_id, e.media_type
            FROM user_media_state uws
            JOIN external_ids e ON e.media_id = uws.media_id AND e.provider = ${getPrimaryExternalIdProvider()}
            WHERE uws.user_id = ${userId}
              AND uws.media_id = ANY(${mediaIds}::uuid[])
              AND uws.is_watched = true
        `;

        const watchedMap = new Map<string, boolean>();
        for (const item of watchedItems) {
            watchedMap.set(`${item.tmdb_id}:${item.media_type}`, true);
        }

        return watchedMap;
    } catch (error: unknown) {
        logger.error(
            'Failed to get watched status batch',
            error instanceof Error ? error : undefined,
            { userId, itemCount: items.length },
        );
        return new Map();
    }
}
