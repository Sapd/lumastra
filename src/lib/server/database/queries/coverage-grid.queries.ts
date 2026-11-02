// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coverage Grid Query Module
 *
 * Paginated per-item × per-stage coverage data for the Library Completeness
 * page. Returns both a paged item list and aggregate summary counts.
 */

import type postgres from 'postgres';
import type { StageStatus } from '$lib/types/pipeline.js';
import { pgTextTimestamp } from './builders/keyset-cursor.builder.js';

export interface CoverageGridItem {
    id: string;
    title: string;
    media_type: string;
    library_group_id: string | null;
    stage_completion: Record<string, StageStatus>;
    added_at: Date;
    /**
     * `mi.created_at::text` — the same instant as `added_at`, rendered by
     * Postgres as a raw string rather than parsed into a JS `Date` by
     * postgres.js's timestamptz type parser. `Date#toISOString()` only
     * carries millisecond precision, while Postgres timestamps carry
     * microseconds — round-tripping a keyset cursor through a `Date` can
     * silently skip a row added in the same microsecond-collapsed
     * millisecond as the page boundary. Keep this a bare string, never
     * widen it to `string | Date`.
     */
    added_at_cursor?: string;
    /**
     * Episodes only — parent series title resolved via the parent_id chain
     * (episode → season → series). Lets the Completion grid show "Series ·
     * SxxEyy" instead of a bare episode title (admin IA redesign, spec
     * §3.3: "Completion grid shows series context for episodes").
     */
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
}

/** Decoded keyset cursor for `loadCoverageGridItems` — mirrors the `(added_at, id) DESC` order. */
export interface CoverageGridCursor {
    addedAt: string;
    id: string;
}

export interface CoverageGridOptions {
    mediaTypes?: ReadonlyArray<string>;
    incompleteOnly?: boolean;
    missingStage?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /**
     * Keyset cursor — when present, ignores `offset` and returns rows
     * strictly after this `(added_at, id)` position in
     * `(added_at DESC, id DESC)` order. `media_items.created_at` is
     * `NOT NULL`, so no null-group handling is needed. Additive/opt-in:
     * omitted, behavior (incl. `offset`) is unchanged.
     */
    cursor?: CoverageGridCursor;
}

export interface CoverageGridSummary {
    total: number;
    completed: number;
    in_progress: number;
    failed: number;
    pending: number;
    skipped: number;
    obsolete: number;
}

const DEFAULT_LIMIT = 50;

/**
 * Stages that record the verdict of a SCHEDULED CHECK, not processing work.
 *
 * `integrity-file-present` is classified only when the integrity scanner runs
 * (every 6h, first run up to 6h after a fresh boot, never if
 * `DISABLE_INTEGRITY_SCANNER`), so its rows sit `pending` between scans while
 * nothing is waiting on them. Counted as remaining work they kept the admin
 * drawer saying "Library processing · 61 of 75" on a fresh install that had
 * finished everything else (2026-10-06).
 *
 * So a check stage's UNCHECKED rows (`pending` / `running`) are not work:
 *   - the summary leaves them out of every count, `total` included, so the bar
 *     can reach 100%;
 *   - `incompleteOnly` does not treat them as incomplete, in the grid and in
 *     the summary alike, so the two agree on which items they cover.
 * Its verdicts still count: `completed`, and `failed_permanent` for a default
 * file the scan found missing. The grid cells still show the unchecked status.
 *
 * Exception: `missingStage` naming a check stage is an explicit request for its
 * unchecked rows, so for that query they count as work everywhere (see
 * {@link uncheckedScheduledCheckRow}).
 */
export const SCHEDULED_CHECK_STAGE_IDS = ['integrity-file-present'] as const;

/**
 * `(<alias>.stage_id IS an unchecked scheduled-check row)` — callers negate it.
 * The stage `missingStage` names is dropped from the list, so asking for the
 * items a check has not reached yet counts those rows rather than hiding them.
 * An empty list makes the fragment FALSE.
 */
function uncheckedScheduledCheckRow(
    sql: postgres.Sql,
    alias: 's' | 's2',
    missingStage: string | null,
): postgres.PendingQuery<postgres.Row[]> {
    const ids = SCHEDULED_CHECK_STAGE_IDS.filter((id) => id !== missingStage);
    return sql`(
        ${sql(alias)}.stage_id = ANY(${ids}::text[])
        AND ${sql(alias)}.status IN ('pending','running')
    )`;
}

export async function loadCoverageGridItems(
    sql: postgres.Sql,
    opts: CoverageGridOptions,
): Promise<CoverageGridItem[]> {
    const mediaTypes = opts.mediaTypes && opts.mediaTypes.length > 0 ? [...opts.mediaTypes] : null;
    const incompleteOnly = opts.incompleteOnly ?? false;
    const missingStage = opts.missingStage ?? null;
    const searchPattern = opts.search ? `%${opts.search}%` : null;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const offset = opts.offset ?? 0;
    // pgTextTimestamp() pins this parameter's wire OID to TEXT (25) — see
    // `keyset-cursor.builder.ts`. Left as a bare `${...}::timestamptz`,
    // postgres.js would infer timestamptz (1184) from the cast and serialize
    // the value via `new Date(x).toISOString()`, truncating the
    // microsecond-precision `added_at_cursor` string back to milliseconds.
    const cursorPredicate = opts.cursor
        ? sql`AND (mi.created_at, mi.id) < (${pgTextTimestamp(sql, opts.cursor.addedAt)}::timestamptz, ${opts.cursor.id}::uuid)`
        : sql``;

    interface RawRow {
        id: string;
        title: string;
        media_type: string;
        library_group_id: string | null;
        added_at: Date;
        added_at_cursor?: string;
        series_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        stage_completion: Record<string, StageStatus>;
    }

    const rows = await sql<RawRow[]>`
        WITH item_rows AS (
          SELECT mi.id,
                 mi.title,
                 mi.media_type,
                 mi.library_group_id,
                 mi.created_at AS added_at,
                 mi.created_at::text AS added_at_cursor,
                 mi.season_number,
                 mi.episode_number,
                 series.title AS series_title
            FROM media_items mi
            LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
            LEFT JOIN media_items series ON series.id = CASE
                WHEN mi.media_type = 'season' THEN mi.parent_id
                WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
            END
           WHERE (${mediaTypes}::text[] IS NULL OR mi.media_type = ANY(${mediaTypes}::text[]))
             AND (NOT ${incompleteOnly}::bool OR EXISTS (
                    SELECT 1 FROM media_item_stage_state s
                     WHERE s.media_item_id = mi.id
                       AND s.status NOT IN ('completed','skipped_permanent')
                       AND NOT ${uncheckedScheduledCheckRow(sql, 's', missingStage)}
             ))
             AND (${missingStage}::text IS NULL OR EXISTS (
                    SELECT 1 FROM media_item_stage_state s
                     WHERE s.media_item_id = mi.id
                       AND s.stage_id = ${missingStage}::text
                       AND s.status NOT IN ('completed','skipped_permanent')
             ))
             AND (${searchPattern}::text IS NULL
                  OR mi.title ILIKE ${searchPattern}
                  OR EXISTS (
                        SELECT 1 FROM media_items parent
                         WHERE parent.id = mi.parent_id
                           AND parent.title ILIKE ${searchPattern}
                  ))
               ${cursorPredicate}
           ORDER BY mi.created_at DESC, mi.id DESC
           LIMIT ${limit}
           ${opts.cursor ? sql`` : sql`OFFSET ${offset}`}
        )
        SELECT ir.id,
               ir.title,
               ir.media_type,
               ir.library_group_id,
               ir.added_at,
               ir.added_at_cursor,
               ir.season_number,
               ir.episode_number,
               ir.series_title,
               COALESCE(
                   jsonb_object_agg(s.stage_id, s.status)
                   FILTER (WHERE s.stage_id IS NOT NULL),
                   '{}'::jsonb
               ) AS stage_completion
          FROM item_rows ir
          LEFT JOIN media_item_stage_state s ON s.media_item_id = ir.id
         GROUP BY ir.id, ir.title, ir.media_type, ir.library_group_id, ir.added_at,
                  ir.added_at_cursor, ir.season_number, ir.episode_number, ir.series_title
         ORDER BY ir.added_at DESC, ir.id DESC
    `;

    return rows;
}

export async function loadCoverageGridSummary(
    sql: postgres.Sql,
    opts: CoverageGridOptions,
): Promise<CoverageGridSummary> {
    const mediaTypes = opts.mediaTypes && opts.mediaTypes.length > 0 ? [...opts.mediaTypes] : null;
    const incompleteOnly = opts.incompleteOnly ?? false;
    const missingStage = opts.missingStage ?? null;
    const searchPattern = opts.search ? `%${opts.search}%` : null;

    interface RawSummary {
        total: string;
        completed: string;
        in_progress: string;
        failed: string;
        pending: string;
        skipped: string;
        obsolete: string;
    }

    // Unfiltered (the default load): the media_items join only serves the
    // filters, and every stage_state row has exactly one media_items parent
    // (NOT NULL foreign key), so skip it. Filtered calls keep the full query.
    const noFilter =
        mediaTypes === null && !incompleteOnly && missingStage === null && searchPattern === null;

    // See SCHEDULED_CHECK_STAGE_IDS: a check stage's unchecked rows are not work.
    const notUncheckedScheduledCheck = sql`NOT ${uncheckedScheduledCheckRow(sql, 's', missingStage)}`;

    const [row] = noFilter
        ? await sql<RawSummary[]>`
        SELECT
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE s.status = 'completed')::text AS completed,
            COUNT(*) FILTER (WHERE s.status = 'running')::text AS in_progress,
            COUNT(*) FILTER (WHERE s.status IN ('failed_transient','failed_permanent'))::text AS failed,
            COUNT(*) FILTER (WHERE s.status = 'pending')::text AS pending,
            COUNT(*) FILTER (WHERE s.status IN ('skipped_permanent','skipped_transient'))::text AS skipped,
            COUNT(*) FILTER (WHERE s.status = 'obsolete')::text AS obsolete
          FROM media_item_stage_state s
         WHERE ${notUncheckedScheduledCheck}
        `
        : await sql<RawSummary[]>`
        SELECT
            COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE s.status = 'completed')::text AS completed,
            COUNT(*) FILTER (WHERE s.status = 'running')::text AS in_progress,
            COUNT(*) FILTER (WHERE s.status IN ('failed_transient','failed_permanent'))::text AS failed,
            COUNT(*) FILTER (WHERE s.status = 'pending')::text AS pending,
            COUNT(*) FILTER (WHERE s.status IN ('skipped_permanent','skipped_transient'))::text AS skipped,
            COUNT(*) FILTER (WHERE s.status = 'obsolete')::text AS obsolete
          FROM media_item_stage_state s
          JOIN media_items mi ON mi.id = s.media_item_id
         WHERE ${notUncheckedScheduledCheck}
           AND (${mediaTypes}::text[] IS NULL OR mi.media_type = ANY(${mediaTypes}::text[]))
           AND (NOT ${incompleteOnly}::bool OR EXISTS (
                  SELECT 1 FROM media_item_stage_state s2
                   WHERE s2.media_item_id = mi.id
                     AND s2.status NOT IN ('completed','skipped_permanent')
                     AND NOT ${uncheckedScheduledCheckRow(sql, 's2', missingStage)}
           ))
           AND (${missingStage}::text IS NULL OR EXISTS (
                  SELECT 1 FROM media_item_stage_state s3
                   WHERE s3.media_item_id = mi.id
                     AND s3.stage_id = ${missingStage}::text
                     AND s3.status NOT IN ('completed','skipped_permanent')
           ))
           AND (${searchPattern}::text IS NULL
                OR mi.title ILIKE ${searchPattern}
                OR EXISTS (
                      SELECT 1 FROM media_items parent
                       WHERE parent.id = mi.parent_id
                         AND parent.title ILIKE ${searchPattern}
                ))
    `;

    return {
        total: parseInt(row?.total ?? '0', 10),
        completed: parseInt(row?.completed ?? '0', 10),
        in_progress: parseInt(row?.in_progress ?? '0', 10),
        failed: parseInt(row?.failed ?? '0', 10),
        pending: parseInt(row?.pending ?? '0', 10),
        skipped: parseInt(row?.skipped ?? '0', 10),
        obsolete: parseInt(row?.obsolete ?? '0', 10),
    };
}
