// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MediaSegment, MediaSegmentRow } from '$lib/schemas/playback-types.js';

export async function getSegmentsByMediaId(
    sql: postgres.Sql,
    mediaId: string,
    fileId?: string,
): Promise<MediaSegmentRow[]> {
    const rows = await sql<MediaSegmentRow[]>`
        SELECT * FROM (
            SELECT DISTINCT ON (type, source)
                id, media_id, file_id, type, start_time, end_time, source, fetched_at
            FROM media_segments
            WHERE media_id = ${mediaId}
              AND (file_id IS NULL OR file_id = COALESCE(${fileId ?? null}::uuid, (
                  SELECT file_id FROM media_file_items
                  WHERE media_item_id = ${mediaId} AND is_default = true
                  ORDER BY file_id LIMIT 1
              )))
            ORDER BY type, source, (file_id IS NULL), start_time
        ) effective
        ORDER BY start_time ASC
    `;
    return rows;
}

export async function upsertSegments(
    sql: postgres.Sql,
    mediaId: string,
    segments: MediaSegment[],
    source: string,
    fileId: string | null = null,
): Promise<void> {
    if (segments.length === 0) return;
    for (const segment of segments) {
        await sql`
            WITH superseded AS (
                DELETE FROM media_segments
                WHERE ${fileId}::uuid IS NULL
                  AND media_id = ${mediaId} AND type = ${segment.type} AND source = ${source}
                  AND file_id IS NOT NULL
            )
            INSERT INTO media_segments (media_id, file_id, type, start_time, end_time, source)
            VALUES (${mediaId}, ${fileId}, ${segment.type}, ${segment.startTime}, ${segment.endTime}, ${source})
            ON CONFLICT (media_id, type, source, file_id)
            DO UPDATE SET
                start_time = EXCLUDED.start_time,
                end_time = EXCLUDED.end_time,
                fetched_at = NOW()
        `;
    }
}

/**
 * Get the media_type for a single media item.
 */
export async function getMediaTypeById(sql: postgres.Sql, mediaId: string): Promise<string | null> {
    const rows = await sql<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${mediaId} LIMIT 1
    `;
    return rows[0]?.media_type ?? null;
}

/**
 * Get the media_type and episode_number for a single media item.
 * Returns null when the item does not exist.
 */
export async function getEpisodeInfo(
    sql: postgres.Sql,
    mediaId: string,
): Promise<{ media_type: string; episode_number: number | null } | null> {
    const rows = await sql<{ media_type: string; episode_number: number | null }[]>`
        SELECT media_type, episode_number FROM media_items WHERE id = ${mediaId} LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Get segments for all episodes under a series (via seasons) or a season.
 * Used by the GET endpoint so the series/season page shows children's segments.
 */
export async function getSegmentsForChildren(
    sql: postgres.Sql,
    parentId: string,
    parentType: 'tv' | 'season',
): Promise<
    (MediaSegmentRow & {
        episode_title: string | null;
        episode_number: number | null;
        season_number: number | null;
    })[]
> {
    if (parentType === 'season') {
        return sql<
            (MediaSegmentRow & {
                episode_title: string | null;
                episode_number: number | null;
                season_number: number | null;
            })[]
        >`
            SELECT * FROM (
            SELECT DISTINCT ON (ms.media_id, ms.type, ms.source) ms.id, ms.media_id, ms.file_id, ms.type, ms.start_time, ms.end_time, ms.source, ms.fetched_at,
                   ep.title AS episode_title, ep.episode_number, season.season_number
            FROM media_segments ms
            LEFT JOIN LATERAL (
                SELECT file_id FROM media_file_items
                WHERE media_item_id = ms.media_id AND is_default = true
                ORDER BY file_id LIMIT 1
            ) selected ON true
            JOIN media_items ep ON ep.id = ms.media_id
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE ep.parent_id = ${parentId}
              AND ep.media_type = 'episode'
              AND (ms.file_id IS NULL OR ms.file_id = selected.file_id)
            ORDER BY ms.media_id, ms.type, ms.source, (ms.file_id IS NULL), ms.start_time
            ) effective ORDER BY episode_number NULLS LAST, start_time
        `;
    }
    // Series: episodes via season → series hierarchy
    return sql<
        (MediaSegmentRow & {
            episode_title: string | null;
            episode_number: number | null;
            season_number: number | null;
        })[]
    >`
        SELECT * FROM (
        SELECT DISTINCT ON (ms.media_id, ms.type, ms.source) ms.id, ms.media_id, ms.file_id, ms.type, ms.start_time, ms.end_time, ms.source, ms.fetched_at,
               ep.title AS episode_title, ep.episode_number, season.season_number
        FROM media_segments ms
            LEFT JOIN LATERAL (
                SELECT file_id FROM media_file_items
                WHERE media_item_id = ms.media_id AND is_default = true
                ORDER BY file_id LIMIT 1
            ) selected ON true
        JOIN media_items ep ON ep.id = ms.media_id AND ep.media_type = 'episode'
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${parentId}
        AND (ms.file_id IS NULL OR ms.file_id = selected.file_id)
        ORDER BY ms.media_id, ms.type, ms.source, (ms.file_id IS NULL), ms.start_time
        ) effective ORDER BY season_number NULLS LAST, episode_number NULLS LAST, start_time
    `;
}

/**
 * Delete all segments for a single media item scoped to a specific source.
 * Used before upsertSegments to ensure re-analysis fully replaces prior results.
 */
export async function deleteSegmentsForSource(
    sql: postgres.Sql,
    mediaId: string,
    source: string,
): Promise<void> {
    await sql`
        DELETE FROM media_segments
        WHERE media_id = ${mediaId}
          AND source = ${source}
    `;
}

/**
 * Delete segments scoped to a single media item, source, AND a specific set
 * of types. Used by per-item re-analysis to replace only the types this run
 * actually regenerates (e.g. chapter/blackframe) without clobbering types
 * owned by another pass (e.g. chromaprint Intro/Outro produced by a prior
 * season-cohort run that the per-item path cannot reproduce).
 */
export async function deleteSegmentsForSourceByTypes(
    sql: postgres.Sql,
    mediaId: string,
    source: string,
    types: string[],
    fileId: string | null = null,
): Promise<void> {
    if (types.length === 0) return;
    await sql`
        DELETE FROM media_segments
        WHERE media_id = ${mediaId}
          AND source = ${source}
          AND type = ANY(${types}::text[])
          AND (${fileId}::uuid IS NULL OR file_id = ${fileId}::uuid)
    `;
}

/**
 * Aggregated inputs for anime preview synthesis. Returns one row per episode
 * with the latest Outro end time (from the given source) and whether a
 * Preview segment already exists (from the same source).
 */
export interface AnimePreviewInput {
    episodeId: string;
    outroEndSec: number | null;
    hasExistingPreview: boolean;
}

export async function getAnimePreviewInputs(
    sql: postgres.Sql,
    episodeIds: string[],
    pluginId: string,
    fileId?: string,
): Promise<AnimePreviewInput[]> {
    if (episodeIds.length === 0) return [];
    return sql<AnimePreviewInput[]>`
        WITH effective AS (
            SELECT DISTINCT ON (ms.media_id, ms.type, ms.source) ms.*
            FROM media_segments ms
            WHERE ms.media_id = ANY(${episodeIds}::uuid[]) AND ms.source = ${pluginId}
              AND (ms.file_id IS NULL OR ms.file_id = COALESCE(${fileId ?? null}::uuid, (
                  SELECT file_id FROM media_file_items
                  WHERE media_item_id = ms.media_id AND is_default = true
                  ORDER BY file_id LIMIT 1
              )))
            ORDER BY ms.media_id, ms.type, ms.source, (ms.file_id IS NULL), ms.start_time
        )
        SELECT
            ep.id AS "episodeId",
            outro.max_end_time AS "outroEndSec",
            (preview.cnt > 0) AS "hasExistingPreview"
        FROM media_items ep
        LEFT JOIN LATERAL (
            SELECT MAX(end_time) AS max_end_time
            FROM effective
            WHERE media_id = ep.id
              AND type = 'Outro'
              AND source = ${pluginId}
        ) outro ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS cnt
            FROM effective
            WHERE media_id = ep.id
              AND type = 'Preview'
              AND source = ${pluginId}
        ) preview ON true
        WHERE ep.id = ANY(${episodeIds}::uuid[])
    `;
}

/**
 * Delete all segments for a single media item.
 */
export async function deleteSegmentsByMediaId(sql: postgres.Sql, mediaId: string): Promise<number> {
    const result = await sql`
        DELETE FROM media_segments WHERE media_id = ${mediaId}
    `;
    return result.count;
}

/** Delete segments for an exact, already-authorized set of media items. */
export async function deleteSegmentsByMediaIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<number> {
    if (mediaIds.length === 0) return 0;
    const result = await sql`
        DELETE FROM media_segments
        WHERE media_id = ANY(${[...mediaIds]}::uuid[])
    `;
    return result.count;
}

/**
 * Delete all segments for every episode under a series (via seasons) or a season.
 */
export async function deleteSegmentsForChildren(
    sql: postgres.Sql,
    parentId: string,
    parentType: 'tv' | 'season',
): Promise<number> {
    if (parentType === 'season') {
        const result = await sql`
            DELETE FROM media_segments
            WHERE media_id IN (
                SELECT id FROM media_items
                WHERE parent_id = ${parentId} AND media_type = 'episode'
            )
        `;
        return result.count;
    }
    const result = await sql`
        DELETE FROM media_segments
        WHERE media_id IN (
            SELECT ep.id FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE season.parent_id = ${parentId} AND ep.media_type = 'episode'
        )
    `;
    return result.count;
}

/**
 * A single `media_item_stage_state` requirement: the stage must have a row
 * that is `completed` or `skipped_permanent`, at `processing_version >=
 * minVersion`, and not `invalidated_at`.
 */
export interface SegmentAnalysisStageRequirement {
    stageId: string;
    minVersion: number;
}

/**
 * Whether every listed stage has reached a current, resolved terminal state
 * for `mediaId` — i.e. whether `lumastra-intro-analyzer`'s analysis is
 * complete and up to date for this item.
 *
 * Mirrors the "resolved" predicate the analyzer's own eligibility queries use
 * (`getUnanalyzedSeasons` / `countBacklog` in lumastra-intro-analyzer.ts):
 * `status IN ('completed', 'skipped_permanent') AND processing_version >=
 * <required>`. `skipped_permanent` counts as resolved because it is the
 * poison-episode tombstone — a deterministically-failing episode is a
 * terminal, current answer ("we tried, it will never produce a result"), not
 * an outstanding one.
 *
 * `invalidated_at IS NULL` is checked in addition, even though the write
 * paths (`markCompleted` / `upsertCompletedRow` / `invalidateByEvent` in
 * stage-state.service.ts) already flip a row's `status` away from
 * `'completed'` the moment it is invalidated (to `'pending'` immediately, or
 * to `'obsolete'` when the invalidation lands while the stage is
 * `'running'`) — so a `'completed'` row should never carry a non-null
 * `invalidated_at` in steady state. The extra check is a defensive mirror of
 * that invariant rather than a new rule: this endpoint is on the playback
 * read path and must never let a caching client latch onto a stale "no
 * intro" if that invariant is ever violated by a future code path.
 *
 * Every listed requirement must be satisfied — this function does not know
 * which stages are enabled by the caller's task config, so the caller is
 * responsible for only listing stages it expects to actually run.
 */
export async function getSegmentAnalysisStatus(
    sql: postgres.Sql,
    mediaId: string,
    requirements: readonly SegmentAnalysisStageRequirement[],
): Promise<'analyzed' | 'pending'> {
    if (requirements.length === 0) return 'pending';
    const stageIds = requirements.map((r) => r.stageId);
    const rows = await sql<
        Array<{
            stage_id: string;
            status: string;
            processing_version: number;
            invalidated_at: Date | null;
        }>
    >`
        SELECT stage_id, status, processing_version, invalidated_at
        FROM media_item_stage_state
        WHERE media_item_id = ${mediaId}
          AND stage_id = ANY(${stageIds})
    `;
    const satisfied = requirements.every((req) => {
        const row = rows.find((r) => r.stage_id === req.stageId);
        if (!row) return false;
        if (row.invalidated_at !== null) return false;
        if (row.processing_version < req.minVersion) return false;
        return row.status === 'completed' || row.status === 'skipped_permanent';
    });
    return satisfied ? 'analyzed' : 'pending';
}

/** Convert DB rows to API MediaSegment shape */
export function toMediaSegments(rows: MediaSegmentRow[]): MediaSegment[] {
    return rows.map((r) => ({
        type: r.type,
        startTime: r.start_time,
        endTime: r.end_time,
    }));
}
