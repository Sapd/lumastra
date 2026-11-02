// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Query module for `watch_state_pending_resolution` — the buffer of watch-state
 * pull items that could not yet be resolved to an internal media UUID (the media
 * had not been ingested when the pull saw it). The drain re-resolves these once
 * the matching media_item exists. See `watch-sync-pending.ts` for the pure
 * planning logic and `watch-sync-pending-drain.service.ts` for orchestration.
 */

import type postgres from 'postgres';
import type {
    PendingResolutionInsert,
    PendingResolutionRow,
} from '$lib/server/services/watch-sync-pending.js';

/**
 * Upsert unresolved pull items into the buffer. Dedupes on
 * `(provider, user_id, media_type, provider_id)` — re-buffering the same item
 * refreshes its watch fields (newest pull wins) and resets `attempts` so a still-
 * active item doesn't age toward the drop threshold. Returns the number of rows
 * written.
 */
const UPSERT_CHUNK_SIZE = 500;

const PENDING_INSERT_COLUMNS = [
    'user_id',
    'provider',
    'media_type',
    'provider_id',
    'tmdb_id',
    'imdb_id',
    'internal_media_id',
    'series_tmdb_id',
    'season_number',
    'episode_number',
    'is_watched',
    'resume_position_ms',
    'runtime_ms',
    'watch_count',
    'last_watched_at',
    'first_watched_at',
] as const;

export async function upsertPendingResolution(
    sql: postgres.Sql,
    rows: PendingResolutionInsert[],
): Promise<number> {
    if (rows.length === 0) return 0;

    // Multi-row INSERT (chunked) rather than one statement per row — a fresh
    // migration can buffer thousands of unresolved items in a single pull, and
    // N round-trips would dominate the cycle.
    let written = 0;
    for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + UPSERT_CHUNK_SIZE);
        await sql`
            INSERT INTO watch_state_pending_resolution ${sql(chunk, ...PENDING_INSERT_COLUMNS)}
            ON CONFLICT (provider, user_id, media_type, provider_id) DO UPDATE SET
                tmdb_id = EXCLUDED.tmdb_id,
                imdb_id = EXCLUDED.imdb_id,
                internal_media_id = EXCLUDED.internal_media_id,
                series_tmdb_id = EXCLUDED.series_tmdb_id,
                season_number = EXCLUDED.season_number,
                episode_number = EXCLUDED.episode_number,
                is_watched = EXCLUDED.is_watched,
                resume_position_ms = EXCLUDED.resume_position_ms,
                runtime_ms = EXCLUDED.runtime_ms,
                watch_count = EXCLUDED.watch_count,
                last_watched_at = EXCLUDED.last_watched_at,
                first_watched_at = EXCLUDED.first_watched_at,
                attempts = 0,
                updated_at = NOW()
        `;
        written += chunk.length;
    }
    return written;
}

/**
 * Load buffered rows for a provider, oldest-created first, capped at `limit`.
 * Oldest-first so a long backlog drains fairly rather than starving early rows.
 */
export async function loadPendingResolution(
    sql: postgres.Sql,
    provider: string,
    limit: number,
    onlyUserIds?: string[],
): Promise<PendingResolutionRow[]> {
    const rows = onlyUserIds
        ? await sql<PendingResolutionRow[]>`
              SELECT p.id, p.user_id, p.provider, p.media_type, p.provider_id,
                     p.tmdb_id, p.imdb_id, p.internal_media_id, p.series_tmdb_id,
                     p.season_number, p.episode_number, p.is_watched,
                     p.resume_position_ms, p.runtime_ms, p.watch_count,
                     p.last_watched_at, p.first_watched_at, p.attempts, p.created_at
                FROM watch_state_pending_resolution p
                JOIN users u ON u.id = p.user_id
               WHERE p.provider = ${provider}
                 AND p.user_id = ANY(${onlyUserIds}::uuid[])
                 AND u.disabled_at IS NULL
                 AND u.deleted_at IS NULL
               ORDER BY p.created_at ASC
               LIMIT ${limit}
          `
        : await sql<PendingResolutionRow[]>`
              SELECT p.id, p.user_id, p.provider, p.media_type, p.provider_id,
                     p.tmdb_id, p.imdb_id, p.internal_media_id, p.series_tmdb_id,
                     p.season_number, p.episode_number, p.is_watched,
                     p.resume_position_ms, p.runtime_ms, p.watch_count,
                     p.last_watched_at, p.first_watched_at, p.attempts, p.created_at
                FROM watch_state_pending_resolution p
                JOIN users u ON u.id = p.user_id
               WHERE p.provider = ${provider}
                 AND u.disabled_at IS NULL
                 AND u.deleted_at IS NULL
               ORDER BY p.created_at ASC
               LIMIT ${limit}
          `;
    return rows;
}

/** Delete buffered rows by id (resolved+imported, or aged-out). */
export async function deletePendingResolution(sql: postgres.Sql, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await sql`DELETE FROM watch_state_pending_resolution WHERE id = ANY(${ids})`;
}

/** Increment `attempts` (and stamp `updated_at`) for still-unresolved rows. */
export async function bumpPendingAttempts(sql: postgres.Sql, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await sql`
        UPDATE watch_state_pending_resolution
        SET attempts = attempts + 1, updated_at = NOW()
        WHERE id = ANY(${ids})
    `;
}

/** Count buffered rows for a provider (admin/metrics visibility). */
export async function countPendingResolution(sql: postgres.Sql, provider: string): Promise<number> {
    const rows = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count
        FROM watch_state_pending_resolution
        WHERE provider = ${provider}
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}
