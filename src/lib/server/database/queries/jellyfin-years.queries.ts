// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Production years present in the library, for the `/j` Years browse view.
 *
 * Same access rules as the other `/j` browse queries (see
 * jellyfin-browse.queries.ts): a REQUIRED {@link MediaAccessBoundary}, `mi`
 * as the media_items alias the library and age builders splice into, and only
 * file-backed items, so a year never appears for catalog-only rows the user
 * could not open.
 */

import type postgres from 'postgres';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import { buildSeriesOwnedAgeRatingFilter } from './builders/age-rating.builder';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildFileBackedVideoItemFilter } from './builders/file-backed-media.builder.js';

export interface YearWithCount {
    year: number;
    itemCount: number;
}

export interface DistinctYearsOptions {
    /** A library group, a parent item (series, album, …) or a Jellyfin library id. */
    parentId: string | null;
    /** Media types to count; empty = every type except episodes and seasons. */
    mediaTypes: string[];
    excludeMediaTypes: string[];
    /** Restrict to one year (the `/Years/{year}` lookup). */
    year?: number;
    access: MediaAccessBoundary;
}

export async function getDistinctYears(
    sql: postgres.Sql,
    options: DistinctYearsOptions,
): Promise<YearWithCount[]> {
    const { parentId, mediaTypes, excludeMediaTypes, year, access } = options;
    if (deniesEverything(access)) return [];

    const rows = await sql<{ year: number; item_count: number }[]>`
        SELECT mi.year::int AS year, COUNT(*)::int AS item_count
        FROM media_items mi
        ${
            parentId
                ? sql`LEFT JOIN LATERAL (
              SELECT metadata
              FROM provider_metadata
              WHERE media_id = mi.id AND provider = 'jellyfin'
              LIMIT 1
          ) jf_pm ON true`
                : sql``
        }
        WHERE mi.status = 'active'
          AND mi.year IS NOT NULL
          AND mi.year > 0
          ${year !== undefined ? sql`AND mi.year = ${year}` : sql``}
          ${
              mediaTypes.length > 0
                  ? sql`AND mi.media_type = ANY(${mediaTypes})`
                  : sql`AND mi.media_type NOT IN ('episode', 'season')`
          }
          ${excludeMediaTypes.length > 0 ? sql`AND mi.media_type != ALL(${excludeMediaTypes})` : sql``}
          ${
              parentId
                  ? sql`AND (
              mi.parent_id = ${parentId}::uuid
              OR (jf_pm.metadata->>'jellyfin_library_id')::text = ${parentId}
              OR EXISTS (
                  SELECT 1 FROM media_file_items _mfi
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _mfi.media_item_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  -- TV: the series itself has no files, only its episodes do.
                  SELECT 1 FROM media_items _ep
                  JOIN media_items _season ON _season.id = _ep.parent_id
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _ep.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _season.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
              OR EXISTS (
                  SELECT 1 FROM media_items _child
                  JOIN media_file_items _mfi ON _mfi.media_item_id = _child.id
                  JOIN media_files _mf ON _mf.id = _mfi.file_id
                  WHERE _child.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
              )
          )`
                  : sql``
          }
          ${buildFileBackedVideoItemFilter(sql, true, mediaTypes)}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
        GROUP BY mi.year
        ORDER BY mi.year
    `;
    return rows.map((r) => ({ year: r.year, itemCount: r.item_count }));
}
