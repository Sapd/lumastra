// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The library-wide ingest funnel: how far files get, and where they stop.
 *
 * `where-is-it` answers "where did THIS one stop?". These are the same joins
 * aggregated, answering "how many stopped at each step?" — which turns a tool
 * that answers reported problems into one that finds unreported ones.
 *
 * ## Segmented by media type, and that is not cosmetic
 *
 * Measured on production before this was written: 28,997 files were linked to an
 * entry carrying no provider id. Segmenting showed 28,258 of them were music
 * tracks — 100% of the tracks in the library — because tracks are not identified
 * through `external_ids` in this system at all. An unsegmented funnel would have
 * headlined "28,997 unidentified" on a completely healthy library.
 *
 * The real signal underneath was 726 episodes and 7 movies. That is the number
 * worth an operator's attention, and it is invisible next to a fabricated 29k.
 *
 * So identification is only evaluated for the types that are expected to carry a
 * provider id, and every other step is reported per type so a problem in one
 * library cannot be averaged away by the health of another.
 */

import type postgres from 'postgres';

/**
 * Media types where a missing provider id is a genuine finding.
 *
 * Music (`track`, `album`, `artist`) and `extra` legitimately carry none —
 * verified on production, where 100% of both are "unidentified" on a library
 * with no identification problem. Listing the types explicitly rather than
 * inferring from the data is deliberate: a genuinely broken movie library would
 * also be 100% unidentified, and an inference would excuse it.
 */
export const TYPES_EXPECTING_PROVIDER_ID: readonly string[] = ['movie', 'episode', 'tv', 'season'];

/** One media type's journey from disk to library. Counts are of FILES. */
export interface FunnelSegment {
    mediaType: string;
    /** Files of this type that are not flagged missing. */
    present: number;
    /** Of those, how many ffprobe has read. */
    probed: number;
    /** Of those, how many reached a library entry. */
    linked: number;
    /**
     * Of the linked, how many carry a provider id. Null when identification is
     * not expected for this type — null means "not applicable", never zero.
     */
    identified: number | null;
    /** Of the linked, how many are flagged visible on library surfaces. */
    visible: number;
}

export interface IngestFunnel {
    /** Files the scanner has flagged as gone from disk. Not a funnel step. */
    missingFiles: number;
    /** Files never linked to any library entry, across every type. */
    orphanFiles: number;
    /** Files linked only to entries that are no longer active. */
    removedEntryFiles: number;
    segments: FunnelSegment[];
}

interface FunnelRow {
    media_type: string | null;
    present: number;
    probed: number;
    linked: number;
    identified: number;
    visible: number;
    missing: number;
}

/**
 * One pass over `media_files`, aggregated per file first.
 *
 * The per-file `GROUP BY` is load-bearing: `media_file_items` is many-to-many
 * and `external_ids` fans out further, so counting the joined rows directly
 * would report a file twice for every extra provider id it happens to carry.
 * Measured at ~210ms over 79k files on production.
 */
export async function loadIngestFunnel(sql: postgres.Sql): Promise<IngestFunnel> {
    // Deliberately ungated against library access. This returns COUNTS ONLY —
    // no ids, titles or paths — and its sole caller is an admin-scoped fix
    // endpoint. A per-viewer filter would be actively wrong here: an operator
    // asking "is my library losing files" must be told about the whole library,
    // not the slice their own account can see.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<FunnelRow[]>`
        WITH per_file AS (
            SELECT mf.id                                  AS file_id,
                   max(mi.media_type)                     AS media_type,
                   bool_or(mf.is_missing)                 AS is_missing,
                   bool_or(mf.probed_at IS NOT NULL)      AS probed,
                   bool_or(mfi.media_item_id IS NOT NULL) AS linked,
                   bool_or(ei.id IS NOT NULL)             AS identified,
                   bool_or(mi.has_files IS TRUE)          AS visible
              FROM media_files mf
              LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
              LEFT JOIN media_items mi
                     ON mi.id = mfi.media_item_id
                    AND mi.status = 'active'
              LEFT JOIN external_ids ei ON ei.media_id = mi.id
             GROUP BY mf.id
        )
        SELECT media_type,
               COUNT(*) FILTER (WHERE NOT is_missing)::int                      AS present,
               COUNT(*) FILTER (WHERE NOT is_missing AND probed)::int           AS probed,
               COUNT(*) FILTER (WHERE NOT is_missing AND linked)::int           AS linked,
               COUNT(*) FILTER (WHERE NOT is_missing AND linked AND identified)::int
                                                                                AS identified,
               COUNT(*) FILTER (WHERE NOT is_missing AND linked AND visible)::int
                                                                                AS visible,
               COUNT(*) FILTER (WHERE is_missing)::int                          AS missing
          FROM per_file
         GROUP BY media_type
    `;

    let missingFiles = 0;
    let orphanFiles = 0;
    let removedEntryFiles = 0;
    const segments: FunnelSegment[] = [];

    for (const r of rows) {
        missingFiles += r.missing;
        // A NULL media_type means the file reached no active library entry at
        // all. That is the orphan count, not a media type, and folding it into
        // the segments would invent a type called "null".
        // Within that group `linked` is the raw link flag (it ignores item
        // status), so it separates files linked only to a removed entry from
        // files that were never linked at all.
        if (r.media_type === null) {
            removedEntryFiles += r.linked;
            orphanFiles += r.present - r.linked;
            continue;
        }
        segments.push({
            mediaType: r.media_type,
            present: r.present,
            probed: r.probed,
            linked: r.linked,
            identified: TYPES_EXPECTING_PROVIDER_ID.includes(r.media_type) ? r.identified : null,
            visible: r.visible,
        });
    }

    segments.sort((a, b) => b.present - a.present);
    return { missingFiles, orphanFiles, removedEntryFiles, segments };
}

/**
 * Which files a funnel count is made of.
 *
 * `orphans` and `missing` are the two library-wide counts; the rest are the
 * per-type steps, and select exactly the files `findingsFor` counted as dropped
 * at that step — the same predicates, over the same per-file aggregation, so a
 * sample can never contain a file the headline number did not.
 */
export type FunnelSampleKind =
    'orphans' | 'removed-entry' | 'missing' | 'probed' | 'identified' | 'visible';

export interface FunnelSample {
    fileId: string;
    filePath: string;
    /** The active library entry the file reached, if any. */
    mediaItemId: string | null;
    title: string | null;
    mediaType: string | null;
    /** Series title for an episode or season, so "Episode 4" is identifiable. */
    showTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    /**
     * The most recent scan issue recorded on the file — for an orphan this is
     * usually the reason it never linked (e.g. `filename_not_utf8`).
     */
    issueType: string | null;
    issueDetail: string | null;
}

interface SampleRow {
    file_id: string;
    file_path: string;
    media_item_id: string | null;
    title: string | null;
    media_type: string | null;
    show_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    issue_type: string | null;
    issue_detail: string | null;
}

/**
 * Up to `limit` files behind one funnel count, ordered by path so a whole
 * season folder reads as one block.
 *
 * Unlike `loadIngestFunnel` this returns paths and titles. Same reasoning for
 * leaving it ungated: its sole caller is the admin-scoped fix endpoint, and an
 * operator chasing lost files needs the whole library, not their own slice.
 */
export async function loadIngestFunnelSamples(
    sql: postgres.Sql,
    kind: FunnelSampleKind,
    mediaType: string | null,
    limit: number,
): Promise<FunnelSample[]> {
    const predicate = (() => {
        switch (kind) {
            case 'orphans':
                return sql`NOT pf.is_missing AND pf.media_type IS NULL AND NOT pf.linked`;
            case 'removed-entry':
                return sql`NOT pf.is_missing AND pf.media_type IS NULL AND pf.linked`;
            case 'missing':
                return sql`pf.is_missing`;
            case 'probed':
                return sql`NOT pf.is_missing AND NOT pf.probed`;
            case 'identified':
                return sql`NOT pf.is_missing AND pf.linked AND NOT pf.identified`;
            case 'visible':
                return sql`NOT pf.is_missing AND pf.linked AND NOT pf.visible`;
        }
    })();
    // `identified` is only a finding for types expected to carry a provider id;
    // the headline reports null ("not applicable") for the rest, so a sample of
    // music tracks here would list files the count never included.
    if (
        kind === 'identified' &&
        mediaType !== null &&
        !TYPES_EXPECTING_PROVIDER_ID.includes(mediaType)
    ) {
        return [];
    }
    const typeFilter =
        kind === 'orphans' || kind === 'removed-entry'
            ? sql``
            : mediaType !== null
              ? sql`AND pf.media_type = ${mediaType}`
              : kind === 'identified'
                ? sql`AND pf.media_type = ANY(${sql.array([...TYPES_EXPECTING_PROVIDER_ID])})`
                : sql``;

    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<SampleRow[]>`
        WITH per_file AS (
            SELECT mf.id                                  AS file_id,
                   mf.file_path,
                   max(mi.media_type)                     AS media_type,
                   (array_agg(mi.id ORDER BY mi.id) FILTER (WHERE mi.id IS NOT NULL))[1]
                                                          AS media_item_id,
                   bool_or(mf.is_missing)                 AS is_missing,
                   bool_or(mf.probed_at IS NOT NULL)      AS probed,
                   bool_or(mfi.media_item_id IS NOT NULL) AS linked,
                   bool_or(ei.id IS NOT NULL)             AS identified,
                   bool_or(mi.has_files IS TRUE)          AS visible
              FROM media_files mf
              LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
              LEFT JOIN media_items mi
                     ON mi.id = mfi.media_item_id
                    AND mi.status = 'active'
              LEFT JOIN external_ids ei ON ei.media_id = mi.id
             GROUP BY mf.id, mf.file_path
        )
        SELECT pf.file_id::text,
               pf.file_path,
               mi.id::text        AS media_item_id,
               mi.title,
               mi.media_type,
               COALESCE(CASE WHEN mi.media_type = 'episode' THEN gp.title END,
                        CASE WHEN mi.media_type IN ('episode', 'season') THEN p.title END)
                                  AS show_title,
               mi.season_number,
               mi.episode_number,
               mf.health_issues -> -1 ->> 'type'   AS issue_type,
               mf.health_issues -> -1 ->> 'detail' AS issue_detail
          FROM per_file pf
          JOIN media_files mf ON mf.id = pf.file_id
          LEFT JOIN media_items mi ON mi.id = pf.media_item_id
          LEFT JOIN media_items p  ON p.id = mi.parent_id
          LEFT JOIN media_items gp ON gp.id = p.parent_id
         WHERE ${predicate} ${typeFilter}
         ORDER BY pf.file_path
         LIMIT ${limit}
    `;

    return rows.map((r) => ({
        fileId: r.file_id,
        filePath: r.file_path,
        mediaItemId: r.media_item_id,
        title: r.title,
        mediaType: r.media_type,
        showTitle: r.show_title,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        issueType: r.issue_type,
        issueDetail: r.issue_detail,
    }));
}
