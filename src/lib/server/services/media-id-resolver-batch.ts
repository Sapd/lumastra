// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { parseMediaId } from '$lib/server/utils/media-key-parser.js';
import type { UserContext } from '$lib/server/types.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';

export interface BatchRow {
    raw: string;
    id: string;
    media_type: string;
    title: string;
    year: number | null;
    has_files: boolean;
    season_number: number | null;
    episode_number: number | null;
    series_id: string | null;
    series_title: string | null;
    ids: Record<string, string>;
}

/** Lookup only, one query for all handles, including canonical redirects and access filtering. */
export async function resolveCatalogMediaBatch(
    ctx: { sql: postgres.Sql; access: MediaAccessBoundary; user?: UserContext },
    ids: string[],
): Promise<BatchRow[]> {
    const { sql, access } = ctx;
    const requested = ids.flatMap((raw) => {
        const parsed = parseMediaId(raw);
        // Untyped TMDB handles prefer a movie, then a series (the single-item contract).
        const tmdb = /^tmdb:([1-9]\d*)$/.exec(raw.trim());
        if (!parsed.uuid && !parsed.provider && !tmdb) return [];
        return [
            {
                raw,
                uuid: parsed.uuid ?? null,
                provider: parsed.provider ?? (tmdb ? 'tmdb' : null),
                external_id: parsed.externalId ?? tmdb?.[1] ?? null,
                media_type: parsed.mediaType ?? null,
            },
        ];
    });
    if (!requested.length || access.library.kind === 'denyAll' || access.age.kind === 'denyAll')
        return [];
    return sql<BatchRow[]>`
        WITH RECURSIVE requested AS (
            SELECT * FROM jsonb_to_recordset(${sql.json(requested)}::jsonb)
                AS r(raw text, uuid uuid, provider text, external_id text, media_type text)
        ), matches AS (
            SELECT r.raw, mi.id, 0 AS priority FROM requested r JOIN media_items mi ON mi.id = r.uuid
            UNION
            SELECT r.raw, e.media_id,
                CASE WHEN r.provider = 'tmdb' AND r.media_type IS NULL AND e.media_type IN ('tv', 'series')
                    THEN 1 ELSE 0 END AS priority
            FROM requested r JOIN external_ids e
                ON e.provider = r.provider AND e.external_id = r.external_id
                AND (e.media_type = r.media_type
                    OR (r.media_type IN ('tv', 'series') AND e.media_type IN ('tv', 'series'))
                    OR (r.media_type IS NULL
                    AND (r.provider <> 'tmdb' OR e.media_type IN ('movie', 'tv', 'series'))))
        ), canonical AS (
            SELECT raw, id, priority, ARRAY[id] AS path FROM matches
            UNION ALL
            SELECT c.raw, mi.canonical_id, c.priority, c.path || mi.canonical_id
            FROM canonical c JOIN media_items mi ON mi.id = c.id
            WHERE mi.canonical_id IS NOT NULL AND NOT mi.canonical_id = ANY(c.path)
                AND cardinality(c.path) < 10
        ), targets AS (
            SELECT c.raw, mi.id, min(c.priority) AS priority FROM canonical c JOIN media_items mi ON mi.id = c.id
            WHERE mi.canonical_id IS NULL AND mi.status = 'active'
                ${toLibraryAccessUser(ctx.user)?.isAdmin ? sql`` : sql`AND (mi.media_type <> 'audiobook' OR (mi.has_files AND NOT mi.is_dismissed))`}
                ${buildLibraryAccessFilter(sql, access.library)} ${buildAgeRatingFilter(sql, access.age)}
            GROUP BY c.raw, mi.id
        ), preferred AS (
            SELECT raw, min(priority) AS priority FROM targets GROUP BY raw
        ), resolved AS (
            SELECT t.raw, min(t.id::text)::uuid AS id FROM targets t
            JOIN preferred p ON p.raw = t.raw AND p.priority = t.priority
            GROUP BY t.raw HAVING count(*) = 1
        )
        SELECT r.raw, mi.id, mi.media_type, mi.title, mi.year, mi.has_files,
            mi.season_number, mi.episode_number,
            ser_ok.id AS series_id,
            ser_ok.title AS series_title,
            COALESCE((SELECT jsonb_object_agg(e.provider, e.external_id ORDER BY e.provider, e.external_id)
                FROM external_ids e WHERE e.media_id = mi.id AND e.provider NOT IN ('internal', 'jellyfin')), '{}'::jsonb) AS ids
        FROM resolved r JOIN media_items mi ON mi.id = r.id
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        LEFT JOIN media_items series ON series.id = parent.parent_id AND series.media_type IN ('tv', 'series')
        -- The parent series is only reported when the caller may open it too.
        LEFT JOIN media_items ser_ok
            ON ser_ok.id = CASE WHEN parent.media_type IN ('tv', 'series') THEN parent.id ELSE series.id END
            ${buildLibraryAccessFilter(sql, access.library, 'ser_ok')}
            ${buildAgeRatingFilter(sql, access.age, 'ser_ok')}
        WHERE true ${buildLibraryAccessFilter(sql, access.library)} ${buildAgeRatingFilter(sql, access.age)}`;
}
