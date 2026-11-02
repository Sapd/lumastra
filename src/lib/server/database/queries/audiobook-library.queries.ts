// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { deriveSortTitle } from '$lib/server/utils/sort-title.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from './builders/age-rating.builder.js';

/** Live sessions and cached watch rows must not revive a removed audiobook source. */
export async function availableAudiobookIds(
    sql: postgres.Sql,
    mediaIds: string[],
    boundary: MediaAccessBoundary,
): Promise<Set<string>> {
    if (mediaIds.length === 0) return new Set();
    const rows = await sql<{ id: string }[]>`SELECT mi.id::text FROM media_items mi
        WHERE mi.id = ANY(${mediaIds}::uuid[]) AND mi.media_type = 'audiobook'
          AND mi.status = 'active' AND mi.has_files = true AND mi.is_dismissed = false
          ${buildLibraryAccessFilter(sql, boundary.library, 'mi')}
          ${buildSeriesOwnedAgeRatingFilter(sql, boundary.age, 'mi')}`;
    return new Set(rows.map((row) => row.id));
}

/** Local library configuration changes do not bump the upstream ABS revision. */
export async function refreshAudiobookLibrarySettings(
    sql: postgres.Sql,
    pathId: string,
    language: string,
    movedToGroup?: string,
): Promise<void> {
    const rows = await sql<{ id: string; title: string }[]>`
        SELECT id, title FROM media_items
        WHERE media_type = 'audiobook'
          AND custom_metadata #>> '{audiobookshelf,libraryPathId}' = ${pathId}
        FOR UPDATE`;
    if (rows.length === 0) return;
    const titles = rows.map((row) =>
        deriveSortTitle(row.title, null, null, language, { declaredLanguageOnly: true }),
    );
    await sql`UPDATE media_items AS mi
        SET sort_title = settings.sort_title,
            library_group_id = COALESCE(${movedToGroup ?? null}::uuid, mi.library_group_id)
        FROM unnest(${rows.map((row) => row.id)}::uuid[], ${titles}::text[]) AS settings(id, sort_title)
        WHERE mi.id = settings.id`;
}

/** Removing a source retires availability, without deleting progress or ratings. */
export async function retireAudiobookLibraryPath(sql: postgres.Sql, pathId: string): Promise<void> {
    await sql`UPDATE media_items
        SET has_files = false, is_dismissed = true, dismissed_at = NULL
        WHERE media_type = 'audiobook'
          AND custom_metadata #>> '{audiobookshelf,libraryPathId}' = ${pathId}`;
}

/** The group FK becomes NULL on deletion; retained book records must keep its age floor. */
export async function preserveAudiobookLibraryAgeRating(
    sql: postgres.Sql,
    groupId: string,
): Promise<void> {
    await sql`SELECT id FROM library_groups WHERE id = ${groupId}::uuid FOR UPDATE`;
    await sql`UPDATE media_items mi
        SET age_rating = GREATEST(mi.age_rating, lg.max_age_rating)
        FROM library_groups lg
        WHERE mi.media_type = 'audiobook'
          AND mi.library_group_id = ${groupId}::uuid
          AND lg.id = mi.library_group_id AND lg.max_age_rating IS NOT NULL`;
}
