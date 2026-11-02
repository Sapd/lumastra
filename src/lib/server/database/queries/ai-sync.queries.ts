// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI Sync Query Module
 *
 * Centralized queries for AI sync operations including:
 * - Series/episode sync from Jellyfin
 * - User progress tracking
 * - Embedding storage
 * - Task history management
 * - Provider metadata updates
 *
 * @module queries/ai-sync
 */

import type postgres from 'postgres';
import { CatalogService } from '../../services/catalog.service.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { normalizeJellyfinId } from '../../utils/jellyfin-id.js';
import { EMBEDDING_SOURCE, type EmbeddingSource } from '../../utils/embedding-source.js';
import { upsertProviderMetadataUnlessLocked } from './media-upsert.js';
import { refreshSortTitles } from './sort-title.queries.js';

// =============================================================================
// Types
// =============================================================================

export interface SeriesProgressRow {
    username: string;
    series_media_id: string;
    watched_episodes: number;
    total_episodes: number;
    completion_status: 'not_started' | 'in_progress' | 'completed';
    current_episode_media_id: string | null;
    current_season: number | null;
    current_episode: number | null;
}

export interface JellyfinSeasonInsert {
    jellyfinId: string;
    seriesJellyfinId: string;
    seriesPrimaryId: string | null;
    seasonNumber: number;
    name: string | null;
    overview: string | null;
    premiereDate: string | null;
    episodeCount: number | null;
    imageTag: string | null;
}

export interface JellyfinEpisodeInsert {
    jellyfinId: string;
    seriesJellyfinId: string;
    seriesPrimaryId: string | null;
    seasonNumber: number;
    episodeNumber: number;
    title: string | null;
    overview: string | null;
    runtimeSeconds: number | null;
    premiereDate: string | null;
}

/**
 * Upsert a Jellyfin season.
 */
export async function upsertJellyfinSeason(
    sql: postgres.Sql,
    season: JellyfinSeasonInsert,
): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const seriesRows = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = 'jellyfin' AND external_id = ${normalizeJellyfinId(season.seriesJellyfinId)} AND media_type = 'tv'
            LIMIT 1
        `;
        const seriesMediaId = seriesRows[0]?.media_id;
        if (!seriesMediaId) {
            return;
        }

        const existingRows = await tx<{ id: string }[]>`
            SELECT mi.id FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id
            WHERE ei.provider = 'jellyfin' AND ei.external_id = ${normalizeJellyfinId(season.jellyfinId)}
              AND mi.media_type = 'season'
            LIMIT 1
        `;

        let seasonMediaId: string;

        if (existingRows.length > 0) {
            seasonMediaId = existingRows[0].id;
            await tx`
                UPDATE media_items SET
                    title = ${season.name},
                    parent_id = ${seriesMediaId},
                    season_number = ${season.seasonNumber},
                    overview = COALESCE(${season.overview}, overview),
                    premiere_date = COALESCE(${season.premiereDate}, premiere_date),
                    updated_at = NOW()
                WHERE id = ${seasonMediaId}
            `;
            await refreshSortTitles(tx, [seasonMediaId]);
        } else {
            const insertResult = await tx<{ id: string }[]>`
                INSERT INTO media_items (
                    title, media_type, parent_id, season_number, overview, premiere_date
                ) VALUES (
                    ${season.name}, 'season', ${seriesMediaId}, ${season.seasonNumber},
                    ${season.overview}, ${season.premiereDate}
                )
                RETURNING id
            `;
            seasonMediaId = insertResult[0].id;
            await refreshSortTitles(tx, [seasonMediaId]);

            const catalogService = new CatalogService(tx, {
                skipLifecycleHooks: true,
            });
            await catalogService.upsertExternalId(seasonMediaId, {
                provider: 'jellyfin',
                id: season.jellyfinId,
                mediaType: 'season',
                source: 'sync',
            });
        }

        if (season.imageTag) {
            await upsertProviderMetadataUnlessLocked(tx, seasonMediaId, 'jellyfin', {
                image_tag: season.imageTag,
            });
        }
    });
}

/**
 * Upsert a Jellyfin episode.
 */
export async function upsertJellyfinEpisode(
    sql: postgres.Sql,
    episode: JellyfinEpisodeInsert,
): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const seriesRows = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = 'jellyfin' AND external_id = ${normalizeJellyfinId(episode.seriesJellyfinId)} AND media_type = 'tv'
            LIMIT 1
        `;
        const seriesMediaId = seriesRows[0]?.media_id;
        if (!seriesMediaId) {
            return;
        }

        const seasonRows = await tx<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${seriesMediaId} AND media_type = 'season' AND season_number = ${episode.seasonNumber}
            LIMIT 1
        `;
        const seasonMediaId = seasonRows[0]?.id;
        if (!seasonMediaId) {
            return;
        }

        const existingRows = await tx<{ id: string }[]>`
            SELECT mi.id FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id
            WHERE ei.provider = 'jellyfin' AND ei.external_id = ${normalizeJellyfinId(episode.jellyfinId)}
              AND mi.media_type = 'episode'
            LIMIT 1
        `;

        let episodeMediaId: string;

        if (existingRows.length > 0) {
            episodeMediaId = existingRows[0].id;
            await tx`
                UPDATE media_items SET
                    title = ${episode.title},
                    parent_id = ${seasonMediaId},
                    season_number = ${episode.seasonNumber},
                    episode_number = ${episode.episodeNumber},
                    runtime_seconds = COALESCE(${episode.runtimeSeconds}, runtime_seconds),
                    premiere_date = COALESCE(${episode.premiereDate}, premiere_date),
                    overview = COALESCE(${episode.overview}, overview),
                    updated_at = NOW()
                WHERE id = ${episodeMediaId}
            `;
            await refreshSortTitles(tx, [episodeMediaId]);
        } else {
            const insertResult = await tx<{ id: string }[]>`
                INSERT INTO media_items (
                    title, media_type, parent_id,
                    season_number, episode_number,
                    runtime_seconds, premiere_date, overview
                ) VALUES (
                    ${episode.title}, 'episode', ${seasonMediaId},
                    ${episode.seasonNumber}, ${episode.episodeNumber},
                    ${episode.runtimeSeconds}, ${episode.premiereDate}, ${episode.overview}
                )
                RETURNING id
            `;
            episodeMediaId = insertResult[0].id;
            await refreshSortTitles(tx, [episodeMediaId]);

            const catalogService = new CatalogService(tx, {
                skipLifecycleHooks: true,
            });
            await catalogService.upsertExternalId(episodeMediaId, {
                provider: 'jellyfin',
                id: episode.jellyfinId,
                mediaType: 'episode',
                source: 'sync',
            });
        }
    });
}

/**
 * Check if an episode exists by Jellyfin ID.
 */
export async function episodeExists(sql: postgres.Sql, jellyfinId: string): Promise<boolean> {
    const result = await sql`
        SELECT 1 FROM external_ids
        WHERE provider = 'jellyfin' AND external_id = ${normalizeJellyfinId(jellyfinId)} AND media_type = 'episode'
        LIMIT 1
    `;
    return result.length > 0;
}

// =============================================================================
// Embedding Queries
//
// NOTE: Task-history functions (insertTaskHistory, updateTaskProgress,
// markTaskAborted, markTaskCompleted, markTaskCompletedByType,
// getTaskHistoryRow, getTaskHistory, getLastTaskRun, trimTaskHistory) and the
// TaskHistoryRow type were removed here. Migration 15.0.0 rewrote task_history
// with an incompatible schema — columns type/status/progress/metadata/
// started_by/updated_at/triggered_by/parent_job_id no longer exist.
// Use the task orchestrator for all task-history writes.
// =============================================================================

/**
 * Upsert a media embedding.
 */
export async function upsertMediaEmbedding(
    sql: postgres.Sql,
    mediaId: string,
    source: EmbeddingSource | 'tmdb' | 'music',
    embedding: number[],
): Promise<void> {
    const embeddingStr = `[${embedding.join(',')}]`;
    await sql`
        INSERT INTO media_embeddings (media_id, source, embedding)
        VALUES (${mediaId}, ${source}, ${embeddingStr}::vector)
        ON CONFLICT (media_id, source) DO UPDATE SET
            embedding = EXCLUDED.embedding,
            updated_at = NOW()
    `;
}

/**
 * Atomically refresh one of the two mutually-exclusive recommendation
 * embeddings ({@link EMBEDDING_SOURCE.LIBRARY} / {@link EMBEDDING_SOURCE.DISCOVERY})
 * for a media item.
 *
 * The library- and discovery-embedding stages are mutually exclusive by
 * `has_files`: library-embeddings only covers items WITH a library file,
 * discovery-embeddings only items WITHOUT one. An item is therefore eligible
 * for exactly ONE source at any moment. When `has_files` flips (a file is
 * attached or removed), the item migrates from one source to the other.
 *
 * If only the now-correct source's task runs and the opposite-source task is
 * delayed, the item transiently holds BOTH embeddings — one fresh and one
 * stale from before the migration. Downstream weighted-fusion similarity
 * scoring would then blend a stale vector into the score (drift).
 *
 * This writes the target embedding AND deletes any opposite-source embedding
 * in a single transaction, so an item never simultaneously holds both
 * recommendation embeddings. Only LIBRARY/DISCOVERY participate in the pair;
 * MUSIC and provider-internal sources ('tmdb') are independent and use the
 * plain {@link upsertMediaEmbedding}.
 */
export async function upsertExclusiveRecommendationEmbedding(
    sql: postgres.Sql,
    mediaId: string,
    source: typeof EMBEDDING_SOURCE.LIBRARY | typeof EMBEDDING_SOURCE.DISCOVERY,
    embedding: number[],
): Promise<void> {
    const embeddingStr = `[${embedding.join(',')}]`;
    const oppositeSource =
        source === EMBEDDING_SOURCE.LIBRARY ? EMBEDDING_SOURCE.DISCOVERY : EMBEDDING_SOURCE.LIBRARY;

    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`
            INSERT INTO media_embeddings (media_id, source, embedding)
            VALUES (${mediaId}, ${source}, ${embeddingStr}::vector)
            ON CONFLICT (media_id, source) DO UPDATE SET
                embedding = EXCLUDED.embedding,
                updated_at = NOW()
        `;
        await tx`
            DELETE FROM media_embeddings
            WHERE media_id = ${mediaId} AND source = ${oppositeSource}
        `;
    });
}

/**
 * Check if embedding exists for a media item and source.
 */
export async function embeddingExists(
    sql: postgres.Sql,
    mediaId: string,
    source: string,
): Promise<boolean> {
    const result = await sql`
        SELECT 1 FROM media_embeddings
        WHERE media_id = ${mediaId} AND source = ${source}
        LIMIT 1
    `;
    return result.length > 0;
}

// =============================================================================
// Provider Metadata Queries
// =============================================================================

/**
 * Get series info for progress tracking (from media_items hierarchy).
 */
export async function getSeriesInfoForProgress(
    sql: postgres.Sql,
    seriesJellyfinId: string,
): Promise<{ total_episodes: number; primary_id: string | null } | null> {
    const rows = await sql<{ total_episodes: number; primary_id: string | null }[]>`
        SELECT
            COUNT(*)::int as total_episodes,
            (SELECT external_id FROM external_ids WHERE media_id = series.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_id
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        JOIN external_ids ei ON ei.media_id = series.id AND ei.provider = 'jellyfin'
        WHERE ei.external_id = ${normalizeJellyfinId(seriesJellyfinId)}
          AND ep.media_type = 'episode'
        GROUP BY series.id
    `;
    return rows[0] || null;
}

// =============================================================================
// Series Sync Status Queries
// =============================================================================

export interface SeriesSyncStatus {
    episodeCount: number;
    seasonCount: number;
    lastSynced: Date | null;
}

/**
 * Check staleness of episodes and seasons for a series.
 */
export async function getSeriesSyncStatus(
    sql: postgres.Sql,
    seriesJellyfinId: string,
): Promise<SeriesSyncStatus> {
    const seriesRows = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = 'jellyfin' AND external_id = ${normalizeJellyfinId(seriesJellyfinId)} AND media_type = 'tv'
        LIMIT 1
    `;
    const seriesMediaId = seriesRows[0]?.media_id;

    if (!seriesMediaId) {
        return {
            episodeCount: 0,
            seasonCount: 0,
            lastSynced: null,
        };
    }

    const [episodeCheck, seasonCheck] = await Promise.all([
        sql<{ count: number | string; last_synced: string | Date | null }[]>`
            SELECT COUNT(*) as count, MAX(ep.updated_at) as last_synced
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE season.parent_id = ${seriesMediaId}
              AND ep.media_type = 'episode'
        `,
        sql<{ count: number | string }[]>`
            SELECT COUNT(*) as count
            FROM media_items
            WHERE parent_id = ${seriesMediaId}
              AND media_type = 'season'
        `,
    ]);

    const toNumber = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

    return {
        episodeCount: toNumber(episodeCheck[0]?.count),
        seasonCount: toNumber(seasonCheck[0]?.count),
        lastSynced: episodeCheck[0]?.last_synced ? new Date(episodeCheck[0].last_synced) : null,
    };
}

export interface SeriesMediaInfo {
    primaryId: string | null;
    mediaId: string | null;
}

/**
 * Get primary external ID and media_id for a series from UUID-based tables.
 */
export async function getSeriesMediaInfo(
    sql: postgres.Sql,
    seriesJellyfinId: string,
): Promise<SeriesMediaInfo> {
    const rows = await sql<{ primary_id: string | null; media_id: string | null }[]>`
        SELECT
            primary_ext.external_id AS primary_id,
            mi.id AS media_id
        FROM media_items mi
        JOIN external_ids jf_ext ON jf_ext.media_id = mi.id
            AND jf_ext.provider = 'jellyfin'
        LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
        WHERE jf_ext.external_id = ${normalizeJellyfinId(seriesJellyfinId)}
            AND mi.status = 'active'
        LIMIT 1
    `;
    return {
        primaryId: rows[0]?.primary_id || null,
        mediaId: rows[0]?.media_id || null,
    };
}

/**
 * Get series Jellyfin ID for an episode.
 */
export async function getSeriesIdForEpisode(
    sql: postgres.Sql,
    episodeJellyfinId: string,
): Promise<string | null> {
    const result = await sql<{ series_jellyfin_id: string }[]>`
        SELECT ei_series.external_id as series_jellyfin_id
        FROM external_ids ei_ep
        JOIN media_items ep ON ep.id = ei_ep.media_id AND ep.media_type = 'episode'
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN external_ids ei_series ON ei_series.media_id = season.parent_id AND ei_series.provider = 'jellyfin'
        WHERE ei_ep.provider = 'jellyfin' AND ei_ep.external_id = ${normalizeJellyfinId(episodeJellyfinId)}
        LIMIT 1
    `;
    return result[0]?.series_jellyfin_id || null;
}

/**
 * Count episodes in a season for a series.
 */
export async function countEpisodesInSeason(
    sql: postgres.Sql,
    seriesJellyfinId: string,
    seasonNumber: number,
): Promise<number> {
    const rows = await sql<{ count: number | string }[]>`
        SELECT COUNT(*) as count
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id
        JOIN external_ids ei ON ei.media_id = series.id AND ei.provider = 'jellyfin'
        WHERE ei.external_id = ${normalizeJellyfinId(seriesJellyfinId)}
          AND season.season_number = ${seasonNumber}
          AND ep.media_type = 'episode'
    `;
    const toNumber = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;
    return toNumber(rows[0]?.count);
}

export interface SeriesInfoFromMedia {
    totalEpisodes: number;
    primaryId: string | null;
}

/**
 * Get series info (total_episodes and primary_id) from UUID-based media_items table.
 * Used for progress tracking queries that need authoritative data.
 *
 * @param sql - The postgres client
 * @param seriesJellyfinId - The Jellyfin ID of the series
 * @param lateralJoinSql - The lateral join SQL string for provider_metadata
 */
export async function getSeriesInfoFromMedia(
    sql: postgres.Sql,
    seriesJellyfinId: string,
    lateralJoinSql: string,
): Promise<SeriesInfoFromMedia> {
    const toNumber = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0;

    const rows = await sql<{ total_episodes: number | null; primary_id: string | null }[]>`
        SELECT
            CAST(pm.metadata->>'total_episodes' AS INTEGER) AS total_episodes,
            primary_ext.external_id AS primary_id
        FROM media_items mi
        JOIN external_ids jf_ext ON jf_ext.media_id = mi.id
            AND jf_ext.provider = 'jellyfin'
        LEFT JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
        ${sql.unsafe(lateralJoinSql)}
        WHERE jf_ext.external_id = ${normalizeJellyfinId(seriesJellyfinId)}
            AND mi.status = 'active'
        LIMIT 1
    `;

    return {
        totalEpisodes: toNumber(rows[0]?.total_episodes),
        primaryId: rows[0]?.primary_id || null,
    };
}

/**
 * Upsert MDBList provider metadata via external_ids lookup.
 * Uses composite key (tmdb_id + media_type) for safety.
 *
 * Skips the write when the matched item is `metadata_locked` (C3, 2026-09-24
 * security review) — mdblist-sync is background-only with no admin-force
 * caller, so a locked item's `mdblist` provider row must not be replaced.
 * The lock check is atomic with the write (single statement, no
 * SELECT-then-write race): a `target` CTE resolves the media_id + lock state
 * once, the `upsert` CTE writes only `WHERE NOT metadata_locked`, and the
 * final SELECT falls back to `target`'s id when the write was skipped — same
 * "resolve, then conditionally write, then recover the id either way" shape
 * as `findOrCreateChild` in metadata-sync-single.service.ts. This means a
 * locked item's media_id is still returned (not null) so the caller can't
 * mistake "matched but locked" for "no media item carries this id" — that
 * distinction matters: mdblist-sync.ts treats a null return as "discard,
 * tombstone the coverage row" (no media item exists), which would be the
 * WRONG diagnosis for a locked item that genuinely exists.
 *
 * `wrote` tells the caller whether the write actually landed, so a locked
 * item (media_id resolved, `wrote: false`) can be counted as SKIPPED rather
 * than updated — mdblist-sync.ts's `processBatch` used to treat any
 * non-null `media_id` as a successful write and mark the coverage row
 * `completed` even when this function silently no-opped (C3 fix-round-2,
 * 2026-09-25 security review).
 *
 * @returns `mediaId`: the media_id that was resolved (whether or not the
 * write happened), or null if no matching item exists at all. `wrote`:
 * true iff the INSERT/UPDATE actually landed.
 */
export async function upsertMdblistMetadata(
    sql: postgres.Sql,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    metadata: Record<string, unknown>,
): Promise<{ mediaId: string | null; wrote: boolean }> {
    const result = await sql<{ media_id: string; wrote: boolean }[]>`
        WITH target AS (
            SELECT ei.media_id, mi.metadata_locked
            FROM external_ids ei
            JOIN media_items mi ON mi.id = ei.media_id
            WHERE ei.provider = ${getPrimaryExternalIdProvider()}
                AND ei.external_id = ${String(tmdbId)}
                AND ei.media_type = ${mediaType}
            LIMIT 1
        ),
        upsert AS (
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
            SELECT target.media_id, 'mdblist', ${sql.json(metadata as Record<string, never>)}, NOW(), NOW()
            FROM target
            WHERE NOT target.metadata_locked
            ON CONFLICT (media_id, provider) DO UPDATE SET
                metadata = EXCLUDED.metadata,
                fetched_at = NOW(),
                updated_at = NOW()
            WHERE NOT EXISTS (
                SELECT 1 FROM media_items locked_check
                WHERE locked_check.id = provider_metadata.media_id
                    AND locked_check.metadata_locked
            )
            RETURNING media_id
        )
        SELECT target.media_id::text AS media_id, EXISTS(SELECT 1 FROM upsert) AS wrote
        FROM target
    `;
    const row = result[0];
    if (!row) return { mediaId: null, wrote: false };
    return { mediaId: row.media_id, wrote: row.wrote };
}

export interface JellyfinEpisodeInsertExtended extends JellyfinEpisodeInsert {
    episodeTmdbId: number | null;
    imdbId: string | null;
}

/**
 * Upsert a Jellyfin episode with extended fields and tracking.
 * Returns whether the row was inserted (true) or updated (false).
 */
export async function upsertJellyfinEpisodeWithTracking(
    sql: postgres.Sql,
    episode: JellyfinEpisodeInsertExtended,
): Promise<boolean> {
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const seriesRows = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = 'jellyfin' AND external_id = ${normalizeJellyfinId(episode.seriesJellyfinId)} AND media_type = 'tv'
            LIMIT 1
        `;
        const seriesMediaId = seriesRows[0]?.media_id;
        if (!seriesMediaId) {
            return false;
        }

        const seasonRows = await tx<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${seriesMediaId} AND media_type = 'season' AND season_number = ${episode.seasonNumber}
            LIMIT 1
        `;
        const seasonMediaId = seasonRows[0]?.id;
        if (!seasonMediaId) {
            return false;
        }

        const existingRows = await tx<{ id: string }[]>`
            SELECT mi.id FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id
            WHERE ei.provider = 'jellyfin' AND ei.external_id = ${normalizeJellyfinId(episode.jellyfinId)}
              AND mi.media_type = 'episode'
            LIMIT 1
        `;

        let episodeMediaId: string;
        let inserted = false;

        if (existingRows.length > 0) {
            episodeMediaId = existingRows[0].id;
            await tx`
                UPDATE media_items SET
                    title = CASE WHEN media_items.title_binding = 'identity' THEN media_items.title ELSE ${episode.title} END,
                    parent_id = ${seasonMediaId},
                    season_number = ${episode.seasonNumber},
                    episode_number = ${episode.episodeNumber},
                    runtime_seconds = COALESCE(${episode.runtimeSeconds}, runtime_seconds),
                    premiere_date = COALESCE(${episode.premiereDate}, premiere_date),
                    overview = CASE WHEN media_items.title_binding = 'identity' THEN media_items.overview ELSE COALESCE(${episode.overview}, overview) END,
                    updated_at = NOW()
                WHERE id = ${episodeMediaId}
            `;
            await refreshSortTitles(tx, [episodeMediaId]);
        } else {
            const insertResult = await tx<{ id: string }[]>`
                INSERT INTO media_items (
                    title, media_type, parent_id,
                    season_number, episode_number,
                    runtime_seconds, premiere_date, overview
                ) VALUES (
                    ${episode.title}, 'episode', ${seasonMediaId},
                    ${episode.seasonNumber}, ${episode.episodeNumber},
                    ${episode.runtimeSeconds}, ${episode.premiereDate}, ${episode.overview}
                )
                RETURNING id
            `;
            episodeMediaId = insertResult[0].id;
            await refreshSortTitles(tx, [episodeMediaId]);
            inserted = true;

            const catalogService = new CatalogService(tx, {
                skipLifecycleHooks: true,
            });
            await catalogService.upsertExternalId(episodeMediaId, {
                provider: 'jellyfin',
                id: episode.jellyfinId,
                mediaType: 'episode',
                source: 'sync',
            });
        }

        if (episode.episodeTmdbId) {
            const [bindingRow] = await tx<{ title_binding: string }[]>`
                SELECT title_binding FROM media_items WHERE id = ${episodeMediaId}
            `;
            const skipTmdbExternalId = bindingRow?.title_binding === 'identity';

            if (!skipTmdbExternalId) {
                const catalogService = new CatalogService(tx, {
                    skipLifecycleHooks: true,
                });
                // provider: 'tmdb' is intentional here — Jellyfin surfaces episode TMDB IDs
                // specifically, so this external ID is legitimately TMDB-specific.
                await catalogService.upsertExternalId(episodeMediaId, {
                    provider: 'tmdb',
                    id: String(episode.episodeTmdbId),
                    mediaType: 'episode',
                    source: 'sync',
                });
            }
        }

        if (episode.imdbId) {
            const catalogService = new CatalogService(tx, {
                skipLifecycleHooks: true,
            });
            await catalogService.upsertExternalId(episodeMediaId, {
                provider: 'imdb',
                id: episode.imdbId,
                mediaType: 'episode',
                source: 'sync',
            });
        }

        return inserted;
    });
}

/**
 * Upsert a Jellyfin episode into media_items + external_ids.
 */
export async function upsertJellyfinEpisodeWithMediaItem(
    sql: postgres.Sql,
    episode: JellyfinEpisodeInsertExtended,
): Promise<boolean> {
    return await upsertJellyfinEpisodeWithTracking(sql, episode);
}

/**
 * Upsert a Jellyfin season with tracking.
 * Returns whether the row was inserted (true) or updated (false).
 */
export async function upsertJellyfinSeasonWithTracking(
    sql: postgres.Sql,
    season: JellyfinSeasonInsert,
): Promise<boolean> {
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const seriesRows = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = 'jellyfin' AND external_id = ${normalizeJellyfinId(season.seriesJellyfinId)} AND media_type = 'tv'
            LIMIT 1
        `;
        const seriesMediaId = seriesRows[0]?.media_id;
        if (!seriesMediaId) {
            return false;
        }

        const existingRows = await tx<{ id: string }[]>`
            SELECT mi.id FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id
            WHERE ei.provider = 'jellyfin' AND ei.external_id = ${normalizeJellyfinId(season.jellyfinId)}
              AND mi.media_type = 'season'
            LIMIT 1
        `;

        let seasonMediaId: string;
        let inserted = false;

        if (existingRows.length > 0) {
            seasonMediaId = existingRows[0].id;
            await tx`
                UPDATE media_items SET
                    title = ${season.name},
                    parent_id = ${seriesMediaId},
                    season_number = ${season.seasonNumber},
                    overview = COALESCE(${season.overview}, overview),
                    premiere_date = COALESCE(${season.premiereDate}, premiere_date),
                    updated_at = NOW()
                WHERE id = ${seasonMediaId}
            `;
            await refreshSortTitles(tx, [seasonMediaId]);
        } else {
            const insertResult = await tx<{ id: string }[]>`
                INSERT INTO media_items (
                    title, media_type, parent_id, season_number, overview, premiere_date
                ) VALUES (
                    ${season.name}, 'season', ${seriesMediaId}, ${season.seasonNumber},
                    ${season.overview}, ${season.premiereDate}
                )
                RETURNING id
            `;
            seasonMediaId = insertResult[0].id;
            await refreshSortTitles(tx, [seasonMediaId]);
            inserted = true;

            const catalogService = new CatalogService(tx, {
                skipLifecycleHooks: true,
            });
            await catalogService.upsertExternalId(seasonMediaId, {
                provider: 'jellyfin',
                id: season.jellyfinId,
                mediaType: 'season',
                source: 'sync',
            });
        }

        if (season.imageTag) {
            await upsertProviderMetadataUnlessLocked(tx, seasonMediaId, 'jellyfin', {
                image_tag: season.imageTag,
            });
        }

        return inserted;
    });
}

/**
 * `provider_metadata` key the discovery sweep stamps (ISO timestamp) whenever
 * it wrote a row from a successful per-item detail fetch. A dedicated key —
 * not `provider_metadata.updated_at` — because other writers touch the same
 * primary-provider row and would otherwise keep deferring the refresh.
 */
export const DISCOVERY_DETAIL_SYNCED_AT_KEY = 'discovery_detail_synced_at';

/**
 * Which of the discovery sweep's (tmdbId, mediaType) keys had their details
 * fetched at or after `freshSince` — or are `metadata_locked`, which the sweep
 * cannot write to anyway. The sweep skips those instead of paying one
 * detail request per catalog item on every run — before this, each 12h sweep
 * re-fetched all ~9k items. Returns `"<tmdbId>:<mediaType>"` strings.
 */
export async function listFreshDiscoveryDetailKeys(
    sql: postgres.Sql,
    keys: ReadonlyArray<{ tmdbId: string; mediaType: string }>,
    freshSince: Date,
): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const provider = getPrimaryExternalIdProvider();
    const rows = await sql<{ tmdb_id: string; media_type: string }[]>`
        SELECT primary_ext.external_id AS tmdb_id, mi.media_type
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${provider}
        LEFT JOIN provider_metadata pm ON pm.media_id = mi.id
            AND pm.provider = ${provider}
        WHERE mi.status = 'active'
            AND (primary_ext.external_id, mi.media_type) IN (
                SELECT * FROM unnest(
                    ${keys.map((k) => k.tmdbId)}::text[],
                    ${keys.map((k) => k.mediaType)}::text[]
                )
            )
            AND (
                -- Locked rows reject the sweep's write, so they never get
                -- stamped; without this they would be re-fetched every sweep
                -- for a write that cannot land.
                mi.metadata_locked
                -- The regex guard keeps one malformed value from aborting the
                -- whole query (it guards a column, so the CASE does short-circuit).
                OR CASE
                    WHEN pm.metadata->>${DISCOVERY_DETAIL_SYNCED_AT_KEY}
                        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$'
                    THEN (pm.metadata->>${DISCOVERY_DETAIL_SYNCED_AT_KEY})::timestamptz >= ${freshSince}
                    ELSE false
                END
            )
    `;
    return new Set(rows.map((r) => `${r.tmdb_id}:${r.media_type}`));
}

/**
 * Whether tmdb-metadata-sync completed a DEEP discovery listing (every list
 * paged to its cap) at or after `since`. The daily sweep pages only the fronts
 * of the lists and goes deep when this is false, so a deep run that failed or
 * was cut short is retried the next day instead of being skipped for a week.
 * Reads the run's own recorded `listDepth`, so no extra state is kept.
 */
export async function hasRecentDeepDiscoveryListing(
    sql: postgres.Sql,
    since: Date,
): Promise<boolean> {
    const [row] = await sql<{ found: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM task_history
            WHERE task_id = 'tmdb-metadata-sync'
              AND state = 'completed'
              AND completed_at >= ${since}
              AND result->'result'->>'listDepth' = 'deep'
        ) AS found
    `;
    return row?.found ?? false;
}

/**
 * Candidates for the original_title backfill (metadata-sync phase 2).
 *
 * Only a missing `original_title` qualifies — TMDB always returns one, so every
 * candidate converges after one fetch. A missing `english_title` used to
 * qualify too, but TMDB has no English title for most items (English originals
 * carry an empty `en` translation), so ~13k rows were re-fetched every night
 * forever; the discovery sweep and the file scanner already write
 * `english_title` whenever TMDB has one. Episodes are excluded: the backfill
 * resolves movie/tv details only, and they were 87k of the re-selected rows.
 *
 * Must mirror `updateOriginalTitleByTmdbId`'s `metadata_locked` guard: a locked
 * row would be selected every run while its UPDATE no-ops.
 */
export interface OriginalTitleBackfillCandidate {
    external_id: string;
    media_type: 'movie' | 'tv' | 'series';
    title: string | null;
}

export async function listOriginalTitleBackfillCandidates(
    sql: postgres.Sql,
): Promise<OriginalTitleBackfillCandidate[]> {
    return sql<OriginalTitleBackfillCandidate[]>`
        SELECT
            primary_ext.external_id AS external_id,
            mi.media_type,
            mi.title
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
        WHERE mi.original_title IS NULL
            AND mi.media_type IN ('movie', 'tv', 'series')
            AND mi.status = 'active'
            AND mi.metadata_locked = false
        ORDER BY primary_ext.external_id
    `;
}

/**
 * Update original_title for media item by TMDB ID.
 *
 * Respects metadata_locked — users who hand-edit titles via the admin UI
 * auto-lock the row, and scheduled AI syncs must not clobber those edits.
 */
/**
 * Write original/english title for a (tmdbId, mediaType) pair.
 *
 * Returns the number of rows actually updated. It is 0 whenever the item is
 * `metadata_locked` or no row carries this composite key — both legitimate,
 * neither an error. Callers MUST branch on this instead of assuming the absence
 * of a thrown error means a write landed: this used to return `void`, so
 * `updated++` fired on every locked item on every run, forever.
 */
export async function updateOriginalTitleByTmdbId(
    sql: postgres.Sql,
    tmdbId: string,
    mediaType: string,
    originalTitle: string,
    englishTitle?: string | null,
): Promise<number> {
    const result = await sql`
        UPDATE media_items
        SET original_title = ${originalTitle},
            english_title = COALESCE(${englishTitle ?? null}, english_title),
            updated_at = NOW()
        WHERE id IN (
            SELECT mi.id FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            WHERE primary_ext.external_id = ${tmdbId}
                AND mi.media_type = ${mediaType}
                AND mi.status = 'active'
                AND mi.metadata_locked = false
        )
        RETURNING id
    `;
    await refreshSortTitles(
        sql,
        result.map((r) => r.id as string),
    );
    return result.count;
}

/**
 * Update media_type for mismatched items (type correction).
 *
 * Intentionally ignores metadata_locked: media_type is a schema-level
 * invariant (a TMDB tv id mis-stored as 'movie' breaks composite-key
 * resolution everywhere), not a user-curated display field. Users have
 * no UI surface for "locking" the media_type, so there is no user intent
 * to preserve here.
 */
export async function updateMediaTypeByTmdbId(
    sql: postgres.Sql,
    tmdbId: string,
    oldMediaType: string,
    newMediaType: string,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET media_type = ${newMediaType},
            updated_at = NOW()
        WHERE id IN (
            SELECT mi.id FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            WHERE primary_ext.external_id = ${tmdbId}
                AND mi.media_type = ${oldMediaType}
        )
    `;
}

/** Candidate row for the `metadata-cast-backfill` task. */
export interface CastBackfillCandidate {
    media_id: string;
    external_id: string;
    media_type: 'movie' | 'tv';
}

/**
 * Find top-level library items (movie/tv) that still lack a structured
 * `cast` array (name + character + TMDB person id) on any of their
 * `provider_metadata` rows, so the detail API's `actors[].character` /
 * proxied `actors[].profileUrl` stay empty even though the primary provider
 * has this data.
 *
 * A candidate must:
 *   - be a top-level item (`parent_id IS NULL`) of type movie/tv with local
 *     files (`has_files = true` — prioritise library items over catalog-only
 *     rows);
 *   - have a primary-provider external id (composite-keyed by media_type);
 *   - have NO provider_metadata row with a non-empty `cast` array;
 *   - have NO `cast_synced_at` marker on the primary provider's row. The
 *     marker records that a fetch attempt already ran (even one that found
 *     no cast at the provider), so a title TMDB genuinely has no cast for
 *     is not re-fetched forever.
 *
 * Ordered newest-first so a capped run enriches recently-touched items
 * first, mirroring the deleted one-off `backfill-cast-structured.ts` script
 * this task replaces.
 *
 * Excludes `metadata_locked` items (C3): the task that consumes this list
 * writes structured cast via `upsertProviderMetadataUnlessLocked`, which
 * already no-ops on a locked row — filtering here is the cheaper fix, since
 * it stops a locked id from ever entering `touchedIds`/`syncedMediaIds` (and
 * so from ever being handed to the 'aggregated' rebuild) in the first place.
 */
export async function findCastBackfillCandidates(
    sql: postgres.Sql,
    limit: number,
): Promise<CastBackfillCandidate[]> {
    const primaryProvider = getPrimaryExternalIdProvider();
    return await sql<CastBackfillCandidate[]>`
        SELECT mi.id::text AS media_id,
               pe.external_id AS external_id,
               mi.media_type
        FROM media_items mi
        JOIN external_ids pe
            ON pe.media_id = mi.id
            AND pe.provider = ${primaryProvider}
            AND pe.media_type = mi.media_type
        WHERE mi.parent_id IS NULL
            AND mi.media_type IN ('movie', 'tv')
            AND mi.has_files = true
            AND mi.metadata_locked = false
            AND NOT EXISTS (
                SELECT 1 FROM provider_metadata pm
                WHERE pm.media_id = mi.id
                    AND jsonb_typeof(pm.metadata->'cast') = 'array'
                    AND jsonb_array_length(pm.metadata->'cast') > 0
            )
            AND NOT EXISTS (
                SELECT 1 FROM provider_metadata pm2
                WHERE pm2.media_id = mi.id
                    AND pm2.provider = ${primaryProvider}
                    AND pm2.metadata->'cast_synced_at' IS NOT NULL
            )
        ORDER BY mi.updated_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Items whose structured `cast` sits on a source provider row but is missing
 * from their 'aggregated' row — the row the detail API reads. Until
 * 2026-09-24 the aggregator dropped `cast` whenever plugin manifests supplied
 * the field priorities (11,494 such items on prod); re-aggregating them is
 * in-DB only.
 *
 * Excludes `metadata_locked` items (C3, 2026-09-24 security review): its sole
 * caller feeds the result straight into `batchAggregateMetadata`, which
 * already skips locked ids itself — filtering here is the cheaper fix, same
 * rationale as `findCastBackfillCandidates`'s `metadata_locked = false`.
 */
export async function findCastAggregationGaps(sql: postgres.Sql, limit: number): Promise<string[]> {
    const rows = await sql<{ media_id: string }[]>`
        SELECT src.media_id::text AS media_id
        FROM provider_metadata src
        JOIN media_items mi ON mi.id = src.media_id AND mi.metadata_locked = false
        LEFT JOIN provider_metadata agg
            ON agg.media_id = src.media_id AND agg.provider = 'aggregated'
        WHERE src.provider <> 'aggregated'
            AND jsonb_typeof(src.metadata->'cast') = 'array'
            AND jsonb_array_length(src.metadata->'cast') > 0
            AND (agg.media_id IS NULL OR jsonb_typeof(agg.metadata->'cast') IS DISTINCT FROM 'array')
        GROUP BY src.media_id
        LIMIT ${limit}
    `;
    return rows.map((r) => r.media_id);
}

export interface TvSeriesRow {
    jellyfin_id: string;
    primary_ext_id: string | null;
    title: string;
}

/**
 * Get all TV series from database for sync operations.
 */
export async function getAllTvSeries(sql: postgres.Sql): Promise<TvSeriesRow[]> {
    return await sql<TvSeriesRow[]>`
        SELECT jf_ext.external_id as jellyfin_id,
               (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
               mi.title
        FROM media_items mi
        JOIN external_ids jf_ext ON jf_ext.media_id = mi.id AND jf_ext.provider = 'jellyfin'
        WHERE mi.media_type = 'tv'
        ORDER BY mi.title
    `;
}

/**
 * Get specific TV series by Jellyfin IDs for sync operations.
 */
export async function getTvSeriesByJellyfinIds(
    sql: postgres.Sql,
    jellyfinIds: string[],
): Promise<TvSeriesRow[]> {
    return await sql<TvSeriesRow[]>`
        SELECT jf_ext.external_id as jellyfin_id,
               (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
               mi.title
        FROM media_items mi
        JOIN external_ids jf_ext ON jf_ext.media_id = mi.id AND jf_ext.provider = 'jellyfin'
        WHERE mi.media_type = 'tv'
          AND jf_ext.external_id = ANY(${jellyfinIds})
    `;
}
