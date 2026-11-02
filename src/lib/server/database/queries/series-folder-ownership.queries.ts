// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface SeriesFolderWitness {
    file_id: string;
    file_path: string;
    file_library: string | null;
    is_missing: boolean;
    episode_id: string;
    offset_source: string | null;
    start_offset_ms: string | null;
    end_offset_ms: string | null;
    season_id: string | null;
    series_id: string | null;
    series_year: number | null;
    series_library: string | null;
    valid_hierarchy: boolean;
}

/** All linked owners in the exact directory boundary, including invalid and
 * cross-library evidence. Filtering those out would manufacture uniqueness. */
export async function listSeriesFolderWitnesses(
    sql: postgres.Sql,
    folder: string,
    incomingPath?: string,
): Promise<SeriesFolderWitness[]> {
    const prefix = folder + '/';
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal scanner: inspect all owners within the exact directory, including cross-library contradictions
    return sql<SeriesFolderWitness[]>`
        SELECT mf.id AS file_id, mf.file_path, mf.library_group_id AS file_library,
            mf.is_missing, ep.id AS episode_id, link.offset_source,
            link.start_offset_ms::text, link.end_offset_ms::text, season.id AS season_id,
            series.id AS series_id, series.year AS series_year,
            series.library_group_id AS series_library,
            COALESCE(ep.media_type = 'episode' AND season.media_type = 'season'
                AND series.media_type = 'tv' AND series.parent_id IS NULL
                AND ep.status = 'active' AND season.status = 'active' AND series.status = 'active'
                AND NOT ep.is_dismissed AND NOT season.is_dismissed AND NOT series.is_dismissed
                AND ep.canonical_id IS NULL AND season.canonical_id IS NULL AND series.canonical_id IS NULL
                AND (ep.library_group_id IS NULL OR ep.library_group_id = mf.library_group_id)
                AND (season.library_group_id IS NULL OR season.library_group_id = mf.library_group_id), false) AS valid_hierarchy
        FROM media_files mf
        JOIN media_file_items link ON link.file_id = mf.id
        JOIN media_items ep ON ep.id = link.media_item_id
        LEFT JOIN media_items season ON season.id = ep.parent_id
        LEFT JOIN media_items series ON series.id = season.parent_id
        WHERE mf.file_path ~>=~ ${prefix} AND mf.file_path ~<~ ${folder + '0'}
            AND starts_with(mf.file_path, ${prefix})
            AND (${incomingPath ?? null}::text IS NULL OR mf.file_path <> ${incomingPath ?? null})
        ORDER BY mf.id, ep.id
        LIMIT 1001
    `;
}

/** A read-only prefilter for reclaiming into the candidate's existing series.
 * Return only a unique, valid owner. NULL/invalid/mixed witnesses stay unknown;
 * do not filter them away to manufacture uniqueness. No witness cap, locks or
 * per-file work: preserving the same series does not need a cross-series fence. */
export async function findSeriesFolderOwnerId(
    sql: postgres.Sql,
    folder: string,
    incomingPath: string,
    libraryGroupId: string,
    year?: number,
): Promise<string | null> {
    const prefix = folder + '/';
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal scanner includes invalid/cross-library witnesses as NULL owners, never filters contradictions away
    const rows = await sql<{ series_id: string | null }[]>`
        SELECT DISTINCT CASE WHEN
            ep.media_type = 'episode' AND season.media_type = 'season'
            AND series.media_type = 'tv' AND series.parent_id IS NULL
            AND ep.status = 'active' AND season.status = 'active' AND series.status = 'active'
            AND NOT ep.is_dismissed AND NOT season.is_dismissed AND NOT series.is_dismissed
            AND ep.canonical_id IS NULL AND season.canonical_id IS NULL AND series.canonical_id IS NULL
            AND NOT mf.is_missing
            AND mf.library_group_id = ${libraryGroupId}::uuid
            AND series.library_group_id = ${libraryGroupId}::uuid
            AND (ep.library_group_id IS NULL OR ep.library_group_id = mf.library_group_id)
            AND (season.library_group_id IS NULL OR season.library_group_id = mf.library_group_id)
            AND (${year ?? null}::int IS NULL OR series.year = ${year ?? null})
            THEN series.id END AS series_id
        FROM media_files mf
        JOIN media_file_items link ON link.file_id = mf.id
        JOIN media_items ep ON ep.id = link.media_item_id
        LEFT JOIN media_items season ON season.id = ep.parent_id
        LEFT JOIN media_items series ON series.id = season.parent_id
        WHERE mf.file_path ~>=~ ${prefix} AND mf.file_path ~<~ ${folder + '0'}
            AND starts_with(mf.file_path, ${prefix}) AND mf.file_path <> ${incomingPath}
        LIMIT 2
    `;
    return rows.length === 1 ? rows[0].series_id : null;
}

/** Match the editor's sorted item → ancestor → file order. All acquisitions
 * are nonblocking: a contended witness is uncertainty, never a reason to
 * wait while holding locks another scanner/editor needs. Use inside withTx. */
export async function tryLockSeriesFolderWitnesses(
    tx: postgres.Sql,
    rows: SeriesFolderWitness[],
): Promise<boolean> {
    const episodes = [...new Set(rows.map((r) => r.episode_id))].sort();
    for (const id of episodes) {
        const [lock] = await tx<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${id})) AS acquired
        `;
        if (!lock.acquired) return false;
    }
    const items = [
        ...new Set(
            rows
                .flatMap((r) => [r.episode_id, r.season_id, r.series_id])
                .filter((id): id is string => !!id),
        ),
    ].sort();
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal scanner locks only explicit witness IDs; library ownership is revalidated after locks
    await tx`SELECT id FROM media_items WHERE id = ANY(${items}::uuid[])
        ORDER BY id FOR NO KEY UPDATE NOWAIT`;
    const files = [...new Set(rows.map((r) => r.file_id))].sort();
    await tx`SELECT id FROM media_files WHERE id = ANY(${files}::uuid[])
        ORDER BY id FOR UPDATE NOWAIT`;
    return true;
}

export async function listSeriesFolderOwnerIds(
    sql: postgres.Sql,
    seriesId: string,
): Promise<{ provider: string; external_id: string }[]> {
    return sql<{ provider: string; external_id: string }[]>`
        SELECT provider, external_id FROM external_ids
        WHERE media_id = ${seriesId}::uuid AND media_type = 'tv'
        ORDER BY provider, external_id FOR SHARE NOWAIT
    `;
}
