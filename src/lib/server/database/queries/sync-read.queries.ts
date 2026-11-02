// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { Sql } from 'postgres';
import type { SyncKind, SyncUserKind, SyncStateFields } from '$lib/schemas/api-sync';
import { SYNC_KIND_BY_MEDIA_TYPE } from '$lib/server/sync/capture-registry';
import { SYNC_STATE_FIELD, SYNC_STATE_SCHEMA } from '$lib/schemas/api-sync';
import { buildPlaybackProgress } from '$lib/schemas/api-playback-progress';
import type { SearchAccessContext } from '$lib/server/utils/search-access-context';
import { searchAccessBoundary } from '$lib/server/utils/search-access-context';
import type { SyncPosition } from '$lib/server/sync/cursor';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import {
    buildSeriesOwnedAgeRatingFilter,
    seriesOwnedAgeRatingExpression,
} from './builders/age-rating.builder';
import { buildSyncSetFilter } from './builders/sync-set.builder';

export interface SyncLogRow extends SyncPosition {
    kind: SyncKind;
    entity_id: string;
    user_id: string | null;
    prev_library_ids: string[];
    prev_libs_known: boolean;
    prev_age_rating: number | null;
    prev_age_known: boolean;
}
export interface SyncReadState {
    instance_id: string;
    epoch: number;
    pruned_xid: string | null;
    pruned_seq: string;
    horizon: string;
    xmax: string;
}
export async function readSyncState(sql: Sql): Promise<SyncReadState> {
    const [row] = await sql<SyncReadState[]>`
        SELECT instance_id::text, epoch, pruned_xid::text, pruned_seq::text,
            pg_snapshot_xmin(pg_current_snapshot())::text AS horizon,
            pg_snapshot_xmax(pg_current_snapshot())::text AS xmax
        FROM sync_state WHERE id = 1
    `;
    if (!row) throw new Error('Library sync state is missing');
    return row;
}

export async function scanSyncLog(
    sql: Sql,
    userId: string | null,
    cursor: SyncPosition,
    horizon: string,
    cap: number,
): Promise<SyncLogRow[]> {
    return await sql<SyncLogRow[]>`
        SELECT xid::text, seq::text, kind, entity_id, user_id::text,
            prev_library_ids, prev_libs_known, prev_age_rating, prev_age_known
        FROM sync_changes
        WHERE ${userId === null ? sql`user_id IS NULL` : sql`user_id = ${userId}::uuid`}
            AND (xid, seq) > (${cursor.xid}::xid8, ${cursor.seq}::bigint)
            AND xid < ${horizon}::xid8
        ORDER BY sync_changes.xid, sync_changes.seq LIMIT ${cap + 1}
    `;
}

export interface SyncItemFacts {
    id: string;
    media_type: string;
    in_sync_set: boolean;
    passes_boundary: boolean;
    effective_age: number | null;
    library_ids: string[];
    has_any_files: boolean;
}

/** Existence and both predicates are evaluated even for unrestricted callers. */
export async function readSyncItemFacts(
    sql: Sql,
    ids: string[],
    ctx: SearchAccessContext,
): Promise<SyncItemFacts[]> {
    if (!ids.length) return [];
    const boundary = searchAccessBoundary(ctx);
    return await sql<SyncItemFacts[]>`
        SELECT mi.id::text, mi.media_type,
            (true ${buildSyncSetFilter(sql)}) AS in_sync_set,
            (true ${buildLibraryAccessFilter(sql, boundary.library)}
                ${buildSeriesOwnedAgeRatingFilter(sql, boundary.age)}) AS passes_boundary,
            ${seriesOwnedAgeRatingExpression(sql)} AS effective_age,
            libs.library_ids, libs.has_any_files
        FROM media_items mi
        CROSS JOIN LATERAL (
            SELECT COALESCE(array_agg(DISTINCT COALESCE(mf.library_group_id,
                '00000000-0000-0000-0000-000000000000'::uuid)), '{}'::uuid[]) AS library_ids,
                count(*) > 0 AS has_any_files
            FROM (
                SELECT mi.id
                UNION ALL SELECT child.id FROM media_items child WHERE child.parent_id = mi.id
                UNION ALL SELECT grandchild.id FROM media_items child
                    JOIN media_items grandchild ON grandchild.parent_id = child.id
                    WHERE child.parent_id = mi.id
            ) tree
            JOIN media_file_items mfi ON mfi.media_item_id = tree.id
            JOIN media_files mf ON mf.id = mfi.file_id
        ) libs
        WHERE mi.id = ANY(${ids}::uuid[])
    `;
}

/** `state` holds exactly the field named after the kind (watchState, rating, ...). */
export interface SyncStateItem {
    id: string;
    state: SyncStateFields;
}
function stateFields(kind: SyncUserKind, data: unknown): SyncStateFields {
    return { [SYNC_STATE_FIELD[kind]]: SYNC_STATE_SCHEMA[kind].parse(data) };
}
interface WatchRow {
    id: string;
    resume_position_ms: number | string | null;
    runtime_ms: number | string | null;
    is_watched: boolean;
    last_event_at: Date | string | null;
    last_watched_at: Date | string | null;
    watch_count: number;
    is_favorite: boolean | null;
}
function iso(value: Date | string | null): string | null {
    return value instanceof Date ? value.toISOString() : value;
}

/** Shared by delta and full load. Filtering happens before keyset LIMIT. */
export async function readSyncUserData(
    sql: Sql,
    userId: string,
    ctx: SearchAccessContext,
    kind: SyncUserKind,
    options: { ids?: string[]; after?: string; limit: number },
): Promise<SyncStateItem[]> {
    const { ids, after, limit } = options;
    if (ids?.length === 0) return [];
    const boundary = searchAccessBoundary(ctx);
    const mediaFilter = sql`
        ${buildLibraryAccessFilter(sql, boundary.library)}
        ${buildSeriesOwnedAgeRatingFilter(sql, boundary.age)}
        ${ids ? sql`AND mi.id = ANY(${ids}::uuid[])` : sql``}
        ${after ? sql`AND mi.id > ${after}::uuid` : sql``}
    `;
    if (kind === 'watch_state') {
        const rows = await sql<WatchRow[]>`
            SELECT mi.id::text, s.resume_position_ms, s.runtime_ms, s.is_watched,
                s.last_event_at, s.last_watched_at, s.watch_count, s.is_favorite
            FROM user_media_state s JOIN media_items mi ON mi.id = s.media_id
            WHERE s.user_id = ${userId}::uuid ${mediaFilter}
            ORDER BY mi.id LIMIT ${limit}
        `;
        return rows.map((s) => ({
            id: s.id,
            state: stateFields('watch_state', {
                progress: buildPlaybackProgress({
                    positionMs: s.resume_position_ms === null ? null : Number(s.resume_position_ms),
                    durationMs: s.runtime_ms === null ? null : Number(s.runtime_ms),
                    finished: s.is_watched,
                    updatedAt: s.last_event_at ?? s.last_watched_at,
                }),
                playCount: Number(s.watch_count),
                favorite: s.is_favorite ?? false,
                lastWatchedAt: iso(s.last_watched_at),
            }),
        }));
    }
    let rows: { id: string; data: unknown }[];
    if (kind === 'listen_state') {
        rows = await sql<{ id: string; data: unknown }[]>`
            SELECT mi.id::text, jsonb_build_object('playCount', s.play_count,
                'skipCount', s.skip_count, 'completeCount', s.complete_count,
                'lastPlayedAt', s.last_played_at) AS data
            FROM user_music_state s JOIN media_items mi ON mi.id = s.track_id
            WHERE s.user_id = ${userId}::uuid ${mediaFilter}
            ORDER BY mi.id LIMIT ${limit}
        `;
    } else if (kind === 'rating') {
        // Only the user's own explicit ratings; skip/complete inferences are not ratings (package 5).
        rows = await sql<{ id: string; data: unknown }[]>`
            SELECT mi.id::text, jsonb_build_object('rating', s.rating, 'style', s.rating_style) AS data
            FROM user_ratings s JOIN media_items mi ON mi.id = s.media_id
            WHERE s.user_id = ${userId}::uuid AND s.is_explicit AND s.skipped IS NOT TRUE ${mediaFilter}
            ORDER BY mi.id LIMIT ${limit}
        `;
    } else if (kind === 'watchlist') {
        rows = await sql<{ id: string; data: unknown }[]>`
            SELECT mi.id::text, jsonb_build_object('addedAt', min(s.added_at),
                'entries', jsonb_agg(jsonb_build_object('seasonNumber', s.season_number,
                    'episodeNumber', s.episode_number, 'addedAt', s.added_at)
                    ORDER BY s.added_at, s.id)) AS data
            FROM playlist_items s JOIN playlists p ON p.id = s.playlist_id
            JOIN media_items mi ON mi.id = s.media_id
            WHERE p.user_id = ${userId}::uuid AND p.playlist_type = 'watchlist' ${mediaFilter}
            GROUP BY mi.id ORDER BY mi.id LIMIT ${limit}
        `;
    } else {
        rows = await sql<{ id: string; data: unknown }[]>`
            SELECT p.id::text, jsonb_build_object('revision', p.revision) AS data
            FROM playlists p
            WHERE (p.user_id = ${userId}::uuid OR EXISTS (
                SELECT 1 FROM playlist_members pm WHERE pm.playlist_id = p.id
                    AND pm.user_id = ${userId}::uuid AND pm.status = 'accepted'
            ))
            ${ids ? sql`AND p.id = ANY(${ids}::int[])` : sql``}
            ${after ? sql`AND p.id > ${after}::int` : sql``}
            ORDER BY p.id LIMIT ${limit}
        `;
    }
    return rows.map((row) => ({ id: row.id, state: stateFields(kind, row.data) }));
}

export async function oldestSyncWriterAge(sql: Sql): Promise<number | null> {
    const [row] = await sql<{ seconds: number | null }[]>`
        SELECT extract(epoch FROM (now() - min(started)))::float8 AS seconds FROM (
            SELECT xact_start AS started FROM pg_stat_activity WHERE backend_xid IS NOT NULL
            UNION ALL SELECT prepared FROM pg_prepared_xacts
        ) writers
    `;
    return row?.seconds ?? null;
}

/**
 * Ids of one catalog kind that are in the sync set and visible to the caller. The initial
 * load of a local library: it shares the predicates of readSyncItemFacts, so the full load
 * and the delta feed cannot disagree about what belongs in the cache.
 */
export async function readSyncLibraryIds(
    sql: Sql,
    ctx: SearchAccessContext,
    kind: keyof typeof SYNC_KIND_BY_MEDIA_TYPE | string,
    options: { after?: string; limit: number },
): Promise<string[]> {
    const mediaTypes = Object.entries(SYNC_KIND_BY_MEDIA_TYPE)
        .filter(([, k]) => k === kind)
        .map(([type]) => type);
    if (!mediaTypes.length) return [];
    const boundary = searchAccessBoundary(ctx);
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id::text
        FROM media_items mi
        WHERE mi.media_type = ANY(${mediaTypes}::text[])
            ${buildSyncSetFilter(sql)}
            ${buildLibraryAccessFilter(sql, boundary.library)}
            ${buildSeriesOwnedAgeRatingFilter(sql, boundary.age)}
            ${options.after ? sql`AND mi.id > ${options.after}::uuid` : sql``}
        ORDER BY mi.id LIMIT ${options.limit}
    `;
    return rows.map((r) => r.id);
}
