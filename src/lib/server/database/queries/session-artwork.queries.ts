// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Batch lookup of public artwork paths for active sessions.
 *
 * Sessions are enriched in one query rather than per row: the active-sessions
 * view is rebuilt every 2 seconds behind a single-flight, so an N+1 here would
 * be a per-session round trip on a hot path.
 *
 * @module database/queries/session-artwork
 */

import type postgres from 'postgres';

/**
 * Fetch `poster_path` for the given media UUIDs.
 *
 * Provider preference is `tmdb` first, then `aggregated`: the aggregated row is
 * a merge that may have taken its poster from a non-public provider, whereas a
 * `tmdb` row's path is by definition resolvable on TMDB's public CDN.
 *
 * @returns Map of media UUID → poster path. Missing entries mean no path.
 */
export async function getPosterPathsByMediaIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<Map<string, string>> {
    if (mediaIds.length === 0) return new Map();

    const rows = await sql<{ media_id: string; poster_path: string }[]>`
        SELECT DISTINCT ON (pm.media_id)
               pm.media_id::text        AS media_id,
               pm.metadata->>'poster_path' AS poster_path
        FROM provider_metadata pm
        WHERE pm.media_id = ANY(${sql.array(mediaIds as string[])}::uuid[])
          AND pm.provider IN ('tmdb', 'aggregated')
          AND pm.metadata->>'poster_path' IS NOT NULL
        ORDER BY pm.media_id,
                 CASE pm.provider WHEN 'tmdb' THEN 0 ELSE 1 END
    `;

    return new Map(rows.map((row) => [row.media_id, row.poster_path]));
}
