// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Orderings Queries
 *
 * Centralized database queries for episode ordering functionality.
 * Supports alternative episode orderings (absolute, DVD, regional).
 *
 * Tables:
 * - series_episode_ordering: Series-level ordering preference
 * - episode_orderings: Episode-level ordering mappings
 * - jellyfin_series: Jellyfin series lookup for ID resolution
 * - external_ids: TMDB ID lookups
 *
 * @module queries/episode-orderings
 */

import type postgres from 'postgres';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';

// =============================================================================
// Types
// =============================================================================

export type EpisodeOrderingType = 'standard' | 'dvd' | 'absolute' | 'regional' | 'other';

export type OrderingSource = 'manual' | 'auto';

export interface SeriesOrderingRow {
    id: number;
    media_id: string;
    ordering_type: EpisodeOrderingType;
    ordering_source: OrderingSource;
    ordering_provider: string | null;
    ordering_group_id: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface EpisodeOrderingRow {
    provider_episode_id: string;
    original_season_number: number;
    original_episode_number: number;
    order_season_number: number | null;
    order_episode_number: number;
    absolute_number: number | null;
}

export interface EpisodeOrderingInsert {
    series_media_id: string;
    provider: string;
    provider_episode_id: string;
    ordering_type: EpisodeOrderingType;
    ordering_group_id: string;
    original_season_number: number;
    original_episode_number: number;
    order_season_number: number | null;
    order_episode_number: number;
    absolute_number: number | null;
}

// =============================================================================
// Series Ordering Queries
// =============================================================================

/**
 * Get series ordering preference by media_id.
 */
export async function getSeriesOrdering(
    sql: postgres.Sql,
    mediaId: string,
): Promise<SeriesOrderingRow | null> {
    const rows = await sql<SeriesOrderingRow[]>`
        SELECT
            id,
            media_id,
            ordering_type,
            ordering_source,
            ordering_provider,
            ordering_group_id,
            created_at,
            updated_at
        FROM series_episode_ordering
        WHERE media_id = ${mediaId}
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Upsert series ordering preference.
 */
export async function upsertSeriesOrdering(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        orderingType: EpisodeOrderingType;
        orderingSource: OrderingSource;
        orderingProvider: string | null;
        orderingGroupId: string | null;
    },
): Promise<SeriesOrderingRow> {
    const rows = await sql<SeriesOrderingRow[]>`
        INSERT INTO series_episode_ordering (
            media_id,
            ordering_type,
            ordering_source,
            ordering_provider,
            ordering_group_id
        ) VALUES (
            ${params.mediaId},
            ${params.orderingType},
            ${params.orderingSource},
            ${params.orderingProvider},
            ${params.orderingGroupId}
        )
        ON CONFLICT (media_id)
        DO UPDATE SET
            ordering_type = EXCLUDED.ordering_type,
            ordering_source = EXCLUDED.ordering_source,
            ordering_provider = EXCLUDED.ordering_provider,
            ordering_group_id = EXCLUDED.ordering_group_id,
            updated_at = NOW()
        RETURNING
            id,
            media_id,
            ordering_type,
            ordering_source,
            ordering_provider,
            ordering_group_id,
            created_at,
            updated_at
    `;
    return rows[0];
}

/**
 * Delete series ordering preference.
 */
export async function deleteSeriesOrdering(sql: postgres.Sql, mediaId: string): Promise<void> {
    await sql`
        DELETE FROM series_episode_ordering
        WHERE media_id = ${mediaId}
    `;
}

// =============================================================================
// Episode Ordering Queries
// =============================================================================

/**
 * Get episode orderings for a series with optional filters.
 */
export async function getEpisodeOrderings(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        orderingType: EpisodeOrderingType;
        orderingProvider?: string | null;
        orderingGroupId?: string | null;
    },
): Promise<EpisodeOrderingRow[]> {
    const { mediaId, orderingType, orderingProvider, orderingGroupId } = params;

    return await sql<EpisodeOrderingRow[]>`
        SELECT
            provider_episode_id,
            original_season_number,
            original_episode_number,
            order_season_number,
            order_episode_number,
            absolute_number
        FROM episode_orderings
        WHERE series_media_id = ${mediaId}
          AND ordering_type = ${orderingType}
          ${orderingProvider ? sql`AND provider = ${orderingProvider}` : sql``}
          ${orderingGroupId ? sql`AND ordering_group_id = ${orderingGroupId}` : sql``}
    `;
}

/**
 * Find episode by absolute number.
 */
export async function findEpisodeByAbsoluteNumber(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        absoluteNumber: number;
        orderingProvider?: string | null;
        orderingGroupId?: string | null;
    },
): Promise<EpisodeOrderingRow | null> {
    const { mediaId, absoluteNumber, orderingProvider, orderingGroupId } = params;

    const rows = await sql<EpisodeOrderingRow[]>`
        SELECT
            provider_episode_id,
            original_season_number,
            original_episode_number,
            order_season_number,
            order_episode_number,
            absolute_number
        FROM episode_orderings
        WHERE series_media_id = ${mediaId}
          AND absolute_number = ${absoluteNumber}
          ${orderingProvider ? sql`AND provider = ${orderingProvider}` : sql``}
          ${orderingGroupId ? sql`AND ordering_group_id = ${orderingGroupId}` : sql``}
        LIMIT 1
    `;
    return rows[0] || null;
}

/**
 * Get absolute number for an episode.
 */
export async function getAbsoluteNumber(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        seasonNumber: number;
        episodeNumber: number;
        orderingProvider?: string | null;
        orderingGroupId?: string | null;
    },
): Promise<number | null> {
    const { mediaId, seasonNumber, episodeNumber, orderingProvider, orderingGroupId } = params;

    const rows = await sql<{ absolute_number: number }[]>`
        SELECT absolute_number
        FROM episode_orderings
        WHERE series_media_id = ${mediaId}
          AND original_season_number = ${seasonNumber}
          AND original_episode_number = ${episodeNumber}
          AND absolute_number IS NOT NULL
          ${orderingProvider ? sql`AND provider = ${orderingProvider}` : sql``}
          ${orderingGroupId ? sql`AND ordering_group_id = ${orderingGroupId}` : sql``}
        LIMIT 1
    `;
    return rows[0]?.absolute_number ?? null;
}

/**
 * Check if orderings exist for a series.
 */
export async function hasOrderingsCache(
    sql: postgres.Sql,
    mediaId: string,
    orderingType?: EpisodeOrderingType,
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
            SELECT 1
            FROM episode_orderings
            WHERE series_media_id = ${mediaId}
            ${orderingType ? sql`AND ordering_type = ${orderingType}` : sql``}
        ) as exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Delete episode orderings with optional filters.
 */
export async function deleteEpisodeOrderings(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        orderingType?: EpisodeOrderingType;
        provider?: string;
        groupId?: string;
    },
): Promise<void> {
    const { mediaId, orderingType, provider, groupId } = params;

    await sql`
        DELETE FROM episode_orderings
        WHERE series_media_id = ${mediaId}
          ${orderingType ? sql`AND ordering_type = ${orderingType}` : sql``}
          ${provider ? sql`AND provider = ${provider}` : sql``}
          ${groupId ? sql`AND ordering_group_id = ${groupId}` : sql``}
    `;
}

/**
 * Batch insert episode orderings in chunks.
 *
 * PostgreSQL's wire protocol uses a 16-bit integer for the parameter count
 * (max 65535). With ~10 columns per row a single insert would exceed that
 * for large anime (e.g. Sky Harbor absolute ordering ~1100 eps, any series
 * that might have 6500+ rows). Chunking at 500 rows keeps each statement
 * well under the limit (5000 bindings) regardless of column count changes.
 */
export async function batchInsertEpisodeOrderings(
    sql: postgres.Sql,
    orderings: EpisodeOrderingInsert[],
): Promise<void> {
    if (orderings.length === 0) return;
    const CHUNK_SIZE = 500;
    for (let i = 0; i < orderings.length; i += CHUNK_SIZE) {
        await sql`INSERT INTO episode_orderings ${sql(orderings.slice(i, i + CHUNK_SIZE))}`;
    }
}

// =============================================================================
// ID Resolution Queries
// =============================================================================

/**
 * Resolve TMDB ID to media_id (for TV series only).
 */
export async function resolveMediaIdFromTmdbId(
    sql: postgres.Sql,
    tmdbId: number,
): Promise<string | null> {
    const rows = await sql<{ media_id: string }[]>`
        SELECT ei.media_id
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id
        WHERE ei.provider = ${getPrimaryExternalIdProvider()}
          AND ei.external_id = ${String(tmdbId)}
          AND mi.media_type = 'tv'
        LIMIT 1
    `;
    return rows[0]?.media_id || null;
}

/**
 * Resolve media_id to TMDB ID (for TV series only).
 */
export async function resolveTmdbIdFromMediaId(
    sql: postgres.Sql,
    mediaId: string,
): Promise<number | null> {
    const rows = await sql<{ external_id: string }[]>`
        SELECT ei.external_id
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id
        WHERE ei.media_id = ${mediaId}
          AND ei.provider = ${getPrimaryExternalIdProvider()}
          AND mi.media_type = 'tv'
        LIMIT 1
    `;
    if (!rows[0]?.external_id) return null;
    return parseInt(rows[0].external_id, 10);
}

// =============================================================================
// Episode Media ID Linking (Display-Layer Ordering)
// =============================================================================

/**
 * Link episode_orderings rows to their local media_items via tiered matching:
 * 1. Provider episode ID match (external_ids)
 * 2. Original season/episode number match
 * 3. Order season/episode number match — covers libraries whose files are
 *    named by the alternate ordering itself (e.g. Sonarr/TVDB season splits),
 *    where the local row exists at the ORDER position rather than the
 *    provider's original position. Only local episodes not already claimed
 *    by another row of the same ordering are eligible.
 * 4. Unmatched rows keep episode_media_id = NULL
 *
 * Provider-agnostic: uses eo.provider to determine which external_ids to match against.
 */
export async function linkEpisodeMediaIds(
    sql: postgres.Sql,
    seriesMediaId: string,
    orderingType: string,
    provider: string,
    groupId: string,
): Promise<{ linked: number; unlinked: number; combined: number }> {
    // Tier 1: Match by provider episode ID via external_ids
    await sql`
        UPDATE episode_orderings eo
        SET episode_media_id = ei.media_id
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id AND mi.media_type = 'episode'
        WHERE eo.series_media_id = ${seriesMediaId}
          AND eo.ordering_type = ${orderingType}
          AND eo.provider = ${provider}
          AND eo.ordering_group_id = ${groupId}
          AND eo.episode_media_id IS NULL
          AND ei.provider = ${provider}
          AND ei.external_id = eo.provider_episode_id
    `;

    // Tier 2: Match by original season/episode number (for rows still unlinked)
    await sql`
        UPDATE episode_orderings eo
        SET episode_media_id = ep.id
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE eo.series_media_id = ${seriesMediaId}
          AND eo.ordering_type = ${orderingType}
          AND eo.provider = ${provider}
          AND eo.ordering_group_id = ${groupId}
          AND eo.episode_media_id IS NULL
          AND season.parent_id = ${seriesMediaId}
          AND ep.media_type = 'episode'
          AND ep.season_number = eo.original_season_number
          AND ep.episode_number = eo.original_episode_number
    `;

    // Tier 3: Match by ORDER season/episode number (for rows still unlinked).
    // Skip local episodes already linked by another row of this ordering so a
    // Tier 1/2 winner is never double-assigned.
    await sql`
        UPDATE episode_orderings eo
        SET episode_media_id = ep.id
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE eo.series_media_id = ${seriesMediaId}
          AND eo.ordering_type = ${orderingType}
          AND eo.provider = ${provider}
          AND eo.ordering_group_id = ${groupId}
          AND eo.episode_media_id IS NULL
          AND eo.order_season_number IS NOT NULL
          AND season.parent_id = ${seriesMediaId}
          AND ep.media_type = 'episode'
          AND ep.season_number = eo.order_season_number
          AND ep.episode_number = eo.order_episode_number
          AND NOT EXISTS (
              SELECT 1 FROM episode_orderings claimed
              WHERE claimed.series_media_id = ${seriesMediaId}
                AND claimed.ordering_type = ${orderingType}
                AND claimed.provider = ${provider}
                AND claimed.ordering_group_id = ${groupId}
                AND claimed.episode_media_id = ep.id
          )
    `;

    // Count results
    const counts = await sql<
        {
            linked: string;
            total: string;
            combined: string;
        }[]
    >`
        SELECT
            COUNT(*) FILTER (WHERE episode_media_id IS NOT NULL) AS linked,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE order_episode_number_end IS NOT NULL) AS combined
        FROM episode_orderings
        WHERE series_media_id = ${seriesMediaId}
          AND ordering_type = ${orderingType}
          AND provider = ${provider}
          AND ordering_group_id = ${groupId}
    `;

    const linked = parseInt(counts[0]?.linked ?? '0', 10);
    const total = parseInt(counts[0]?.total ?? '0', 10);
    const combined = parseInt(counts[0]?.combined ?? '0', 10);

    return { linked, unlinked: total - linked, combined };
}

/**
 * Clear all episode_media_id links for a series ordering.
 */
export async function unlinkEpisodeMediaIds(
    sql: postgres.Sql,
    seriesMediaId: string,
    orderingType?: string,
    provider?: string,
    groupId?: string,
): Promise<void> {
    await sql`
        UPDATE episode_orderings
        SET episode_media_id = NULL
        WHERE series_media_id = ${seriesMediaId}
          ${orderingType ? sql`AND ordering_type = ${orderingType}` : sql``}
          ${provider ? sql`AND provider = ${provider}` : sql``}
          ${groupId ? sql`AND ordering_group_id = ${groupId}` : sql``}
    `;
}
