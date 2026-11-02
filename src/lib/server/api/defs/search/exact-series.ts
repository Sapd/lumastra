// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MediaEmbedding } from '$lib/server/database/connection.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { isAvailableExpr } from '$lib/server/database/queries/availability.queries.js';

/** Exact title equality before paging; no fuzzy, hint parsing or auxiliary sources. */
export async function exactSeriesRows(
    sql: postgres.Sql,
    title: string,
    year: number | undefined,
    limit: number,
    offset: number,
    access: MediaAccessBoundary,
    availableOnly: boolean,
): Promise<Array<MediaEmbedding & { rank: number }>> {
    return sql<Array<MediaEmbedding & { rank: number }>>`
        SELECT row_number() OVER (ORDER BY mi.has_files DESC, mi.year DESC NULLS LAST, mi.id)::int AS id,
            mi.id AS internal_id, mi.title, mi.media_type, mi.overview, ARRAY[]::int[] AS genres,
            (SELECT external_id::bigint FROM external_ids WHERE media_id = mi.id AND provider = 'tmdb' AND external_id ~ '^[0-9]+$' LIMIT 1) AS tmdb_id,
            (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) AS imdb_id,
            CASE WHEN mi.year BETWEEN 1 AND 9999 THEN make_date(mi.year, 1, 1)::text END AS release_date,
            ${isAvailableExpr(sql)} AS is_available,
            CASE WHEN mi.has_files THEN 2.0 ELSE 1.0 END AS rank
        FROM media_items mi
        WHERE mi.media_type = 'tv' AND mi.status = 'active'
          AND lower(trim(mi.title)) = lower(trim(${title}))
          ${year === undefined ? sql`` : sql`AND mi.year = ${year}`}
          ${availableOnly ? sql`AND ${isAvailableExpr(sql)}` : sql``}
          ${buildLibraryAccessFilter(sql, access.library, 'mi')}
          ${buildAgeRatingFilter(sql, access.age, 'mi')}
        ORDER BY mi.has_files DESC, mi.year DESC NULLS LAST, mi.id
        LIMIT ${limit} OFFSET ${offset}
    `;
}
