// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { TrickplayInfo } from '$lib/schemas/playback-types.js';
import { ELIGIBILITY_SKIP_REASON } from '../../tasks/stage-disposition-runner.js';
import { withTx } from '../with-tx.js';

export interface TrickplayParamsRow {
    media_item_id: string;
    file_id: string;
    width: number;
    height: number;
    interval_ms: number;
    tile_width: number;
    tile_height: number;
    thumbnail_count: number;
    bandwidth: number;
    source: string;
    updated_at: Date;
}

export async function getTrickplayParams(
    sql: postgres.Sql,
    mediaItemId: string,
    fileId?: string | null,
): Promise<TrickplayParamsRow[]> {
    const fileFilter = fileId ? sql`AND file_id = ${fileId}` : sql``;
    return sql<TrickplayParamsRow[]>`
        SELECT media_item_id, file_id, width, height, interval_ms, tile_width,
               tile_height, thumbnail_count, bandwidth, source, updated_at
        FROM trickplay_params
        WHERE media_item_id = ${mediaItemId}
          ${fileFilter}
        ORDER BY width ASC
    `;
}

export async function getTrickplayParamsByWidth(
    sql: postgres.Sql,
    mediaItemId: string,
    width: number,
    fileId?: string | null,
): Promise<TrickplayParamsRow | null> {
    const fileFilter = fileId ? sql`AND file_id = ${fileId}` : sql``;
    const rows = await sql<TrickplayParamsRow[]>`
        SELECT media_item_id, file_id, width, height, interval_ms, tile_width,
               tile_height, thumbnail_count, bandwidth, source, updated_at
        FROM trickplay_params
        WHERE media_item_id = ${mediaItemId}
          AND width = ${width}
          ${fileFilter}
    `;
    return rows[0] ?? null;
}

export interface UpsertTrickplayParam {
    width: number;
    height: number;
    /** True when `height` was read from the sprite sheets, not guessed as 16:9. */
    heightMeasured?: boolean;
    intervalMs: number;
    tileWidth: number;
    tileHeight: number;
    thumbnailCount: number;
    bandwidth: number;
    source: string;
}

export async function upsertTrickplayParams(
    sql: postgres.Sql,
    mediaItemId: string,
    fileId: string,
    params: UpsertTrickplayParam[],
): Promise<void> {
    if (params.length === 0) return;

    // Typically 1-3 resolutions, so sequential upserts are fine.
    // Each upsert is idempotent (ON CONFLICT DO UPDATE), so partial
    // failure is recoverable on next sync run.
    for (const p of params) {
        await sql`
            INSERT INTO trickplay_params
                (media_item_id, file_id, width, height, height_measured, interval_ms,
                 tile_width, tile_height, thumbnail_count, bandwidth, source, updated_at)
            VALUES (${mediaItemId}, ${fileId}, ${p.width}, ${p.height},
                    ${p.heightMeasured ?? false}, ${p.intervalMs}, ${p.tileWidth},
                    ${p.tileHeight}, ${p.thumbnailCount}, ${p.bandwidth}, ${p.source}, NOW())
            ON CONFLICT (media_item_id, file_id, width) DO UPDATE SET
                height = EXCLUDED.height,
                height_measured = EXCLUDED.height_measured,
                interval_ms = EXCLUDED.interval_ms,
                tile_width = EXCLUDED.tile_width,
                tile_height = EXCLUDED.tile_height,
                thumbnail_count = EXCLUDED.thumbnail_count,
                bandwidth = EXCLUDED.bandwidth,
                source = EXCLUDED.source,
                updated_at = NOW()
        `;
    }
}

export interface UnmeasuredTrickplayRow {
    media_item_id: string;
    file_id: string;
    width: number;
    height: number;
    source: string;
    file_path: string | null;
}

/**
 * Rows whose thumbnail height is still the old 16:9 guess, in key order after
 * `after` (keyset, so a row that cannot be measured is not re-read in the same
 * pass).
 */
export async function listUnmeasuredTrickplayParams(
    sql: postgres.Sql,
    after: { mediaItemId: string; fileId: string; width: number } | null,
    limit: number,
): Promise<UnmeasuredTrickplayRow[]> {
    const cursor = after
        ? sql`AND (tp.media_item_id, tp.file_id, tp.width) >
                  (${after.mediaItemId}::uuid, ${after.fileId}::uuid, ${after.width})`
        : sql``;
    return sql<UnmeasuredTrickplayRow[]>`
        SELECT tp.media_item_id, tp.file_id, tp.width, tp.height, tp.source,
               mf.file_path
          FROM trickplay_params tp
          LEFT JOIN media_files mf ON mf.id = tp.file_id
         WHERE NOT tp.height_measured
           ${cursor}
         ORDER BY tp.media_item_id, tp.file_id, tp.width
         LIMIT ${limit}
    `;
}

/**
 * Store a measured thumbnail height. `updated_at` moves only when the height
 * changes: it is the sheet revision clients cache by.
 */
export async function setTrickplayMeasuredHeight(
    sql: postgres.Sql,
    row: { mediaItemId: string; fileId: string; width: number },
    height: number,
): Promise<void> {
    await sql`
        UPDATE trickplay_params
           SET height_measured = true,
               updated_at = CASE WHEN height = ${height} THEN updated_at ELSE NOW() END,
               height = ${height}
         WHERE media_item_id = ${row.mediaItemId}
           AND file_id = ${row.fileId}
           AND width = ${row.width}
           AND NOT height_measured
    `;
}

export async function deleteTrickplayParams(
    sql: postgres.Sql,
    mediaItemId: string,
    fileId?: string | null,
): Promise<void> {
    const fileFilter = fileId ? sql`AND file_id = ${fileId}` : sql``;
    await sql`
        DELETE FROM trickplay_params
        WHERE media_item_id = ${mediaItemId}
          ${fileFilter}
    `;
}

export interface ItemWithoutTrickplay {
    id: string;
    fileId: string;
    jellyfinId: string | null;
}

const DEFAULT_ELIGIBLE_MEDIA_TYPES = ['movie', 'episode'] as const;
export const TRICKPLAY_PARAMS_PROCESSING_VERSION = 3;

/**
 * A marker only closes work for its own currently linked file. Treat unknown
 * status/version shapes as runnable; malformed historical JSON must never
 * throw during a library scan or certify another file's work.
 * Callers use `mi` and `mfi` aliases for the current item/file pair.
 */
export function currentTrickplayFileMarker(
    sql: postgres.Sql,
    processingVersion: number,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        COALESCE(
            CASE WHEN (
                mi.processing_state -> ('trickplay-params:' || mfi.file_id::text) ->> 'version'
            ) ~ '^[0-9]{1,15}$' THEN (
                mi.processing_state -> ('trickplay-params:' || mfi.file_id::text) ->> 'version'
            )::numeric END >= ${processingVersion}
            AND mi.processing_state -> ('trickplay-params:' || mfi.file_id::text) ->> 'status'
                IN ('no-provider', 'error'),
            false
        )
    `;
}

/**
 * Fetch a slice of eligible items that still need trickplay params. Excludes
 * items the plugin has already attempted at `processingVersion` — whether
 * they succeeded (they already have a `trickplay_params` row and drop out
 * via the NOT EXISTS clause) or explicitly failed (status=`error`) or had
 * no provider coverage (status=`no-provider`). Without the marker filter a
 * cohort of permanently-uncacheable items in the newest band would stall
 * the drain's no-progress detector before healthier older items could be
 * reached.
 *
 * A PROCESSING_VERSION bump (e.g. when a new trickplay provider ships)
 * clears all markers and re-admits the excluded items for retry.
 */
export async function getItemsWithoutTrickplayParams(
    sql: postgres.Sql,
    limit: number,
    processingVersion: number,
    mediaTypes?: string[],
): Promise<ItemWithoutTrickplay[]> {
    const effectiveTypes = mediaTypes ?? [...DEFAULT_ELIGIBLE_MEDIA_TYPES];
    const rows = await sql<{ id: string; file_id: string; jellyfin_id: string | null }[]>`
        SELECT mi.id, mfi.file_id, ei.external_id AS jellyfin_id
        FROM media_items mi
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
        WHERE mi.media_type = ANY(${effectiveTypes})
          AND mi.status = 'active'
          AND NOT EXISTS (
              SELECT 1 FROM trickplay_params tp
              WHERE tp.media_item_id = mi.id
                AND tp.file_id = mfi.file_id
          )
          AND NOT (${currentTrickplayFileMarker(sql, processingVersion)})
        -- mi.id ASC tiebreaker: items imported in the same bulk scan share a
        -- created_at, and drainBacklog's no-progress signature (count + first-id
        -- + last-id) misfires when the engine shuffles ties across fetches.
        ORDER BY mi.created_at DESC, mi.id ASC, mfi.sort_order NULLS LAST, mfi.file_id
        LIMIT ${limit}
    `;
    return rows.map((r) => ({
        id: r.id,
        fileId: r.file_id,
        jellyfinId: r.jellyfin_id,
    }));
}

export interface TrickplayBacklogCounts {
    /** Current linked-file pairs with params and no obsolete source warning. */
    analyzed: number;
    /** Linked-file pairs without terminal evidence, including obsolete source work. */
    remaining: number;
    /**
     * Linked-file pairs marked `no-provider` at the current version. Split out so the
     * progress bar denominator (`analyzed + remaining`) stays honest while
     * admins can still see "N items can't be cached" at a glance.
     */
    ineligible: number;
    /** Linked-file pairs marked `error` at the current version (provider threw). */
    failed: number;
}

/**
 * Backlog counts for the trickplay sync plugin. Mirrors the eligibility +
 * marker logic used by `getItemsWithoutTrickplayParams` (active
 * movies/episodes). Obsolete stage rows reserve every linked file as
 * uncertain until the task clears their legacy evidence for a fresh pass.
 */
export async function getTrickplayBacklogCounts(
    sql: postgres.Sql,
    processingVersion: number,
    mediaTypes?: string[],
): Promise<TrickplayBacklogCounts> {
    const effectiveTypes = mediaTypes ?? [...DEFAULT_ELIGIBLE_MEDIA_TYPES];
    const [row] = await sql<
        {
            analyzed: number;
            remaining: number;
            ineligible: number;
            failed: number;
        }[]
    >`
        -- Joining distinct keys avoids per-file probes and duplicate counts
        -- across trickplay widths. Terminal JSON is irrelevant once params or
        -- obsolete evidence decide the bucket, so avoid detoasting it then.
        WITH params AS MATERIALIZED (
            SELECT DISTINCT media_item_id, file_id FROM trickplay_params
        ), eligible AS MATERIALIZED (
            SELECT
                tp.media_item_id IS NOT NULL AS has_params,
                s.media_item_id IS NOT NULL AS uncertain_source,
                CASE WHEN tp.media_item_id IS NULL AND s.media_item_id IS NULL
                    THEN ${currentTrickplayFileMarker(sql, processingVersion)}
                    ELSE false END AS terminal_marker,
                CASE WHEN tp.media_item_id IS NULL AND s.media_item_id IS NULL
                    THEN mi.processing_state->('trickplay-params:' || mfi.file_id::text)->>'status'
                    END AS marker_status
            FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            LEFT JOIN params tp ON tp.media_item_id=mi.id AND tp.file_id=mfi.file_id
            LEFT JOIN media_item_stage_state s ON s.media_item_id=mi.id
                AND s.stage_id='trickplay-params-sync' AND s.status='obsolete'
            WHERE mi.media_type = ANY(${effectiveTypes}) AND mi.status = 'active'
        )
        SELECT
            COUNT(*) FILTER (WHERE has_params AND NOT uncertain_source)::int AS analyzed,
            COUNT(*) FILTER (
                WHERE uncertain_source OR (NOT has_params AND NOT terminal_marker)
            )::int AS remaining,
            COUNT(*) FILTER (
                WHERE NOT has_params
                  AND NOT uncertain_source
                  AND terminal_marker
                  AND marker_status = 'no-provider'
            )::int AS ineligible,
            COUNT(*) FILTER (
                WHERE NOT has_params
                  AND NOT uncertain_source
                  AND terminal_marker
                  AND marker_status = 'error'
            )::int AS failed
        FROM eligible
    `;
    return {
        analyzed: row?.analyzed ?? 0,
        remaining: row?.remaining ?? 0,
        ineligible: row?.ineligible ?? 0,
        failed: row?.failed ?? 0,
    };
}

/**
 * Stamp a processing_state marker on a media_items row so the drain's
 * `getItemsWithoutTrickplayParams` predicate excludes it on the next pass.
 * Without markers, items whose provider returns null ("no-provider") occupy
 * the newest slice every drain and the no-progress detector halts the loop
 * before older healthier items get a look. A `processingVersion` bump
 * clears every marker (fetchSlice filters on `version < processingVersion`)
 * so a new provider ships and immediately retries the tail.
 *
 * `reason` is truncated to `maxReasonLength` chars before write so provider
 * HTML error pages or multi-KB stack traces don't bloat the per-row marker
 * and slow every subsequent scan of processing_state. Callers pass the
 * plugin's own cap so this module stays provider-agnostic.
 *
 * Returns `true` when the marker write landed so the caller can credit
 * `advanced` — the drain's no-progress detector relies on advance==false
 * under DB-outage conditions to stop after two identical slices, so the
 * boolean signal is the mechanism that keeps a broken writer from burning
 * the full soft budget.
 */
export async function markTrickplayItemTried(
    sql: postgres.Sql,
    itemId: string,
    fileId: string,
    processingVersion: number,
    status: 'no-provider' | 'error',
    reason: string,
    maxReasonLength: number,
    jobId?: string,
): Promise<boolean> {
    const truncatedReason =
        reason.length > maxReasonLength ? `${reason.slice(0, maxReasonLength)}…` : reason;
    const marker: Record<string, unknown> = {
        version: processingVersion,
        processedAt: new Date().toISOString(),
        status,
        reason: truncatedReason,
    };
    if (status === 'error' && jobId !== undefined) marker.audit_run_job_id = jobId;
    try {
        const result = await sql`
            UPDATE media_items
            SET processing_state = COALESCE(processing_state, '{}'::jsonb) || ${sql.json({
                [`trickplay-params:${fileId}`]: marker,
            } as unknown as postgres.JSONValue)}
            WHERE id = ${itemId}
        `;
        return (result.count ?? 0) > 0;
    } catch {
        return false;
    }
}

/**
 * Close an item-level coverage row only when every currently linked file has
 * either params or a terminal marker for this processing version. The
 * decision and update share one PostgreSQL statement, so a sibling's success
 * cannot certify an unprocessed alternate. Rows owned by an active run are
 * left to that run; fileless rows belong to eligibility disposition.
 */
export async function reconcileTrickplayCoverageRows(
    sql: postgres.Sql,
    processingVersion: number,
    limit: number,
    mediaItemId?: string,
): Promise<number> {
    const itemFilter = mediaItemId ? sql`AND s.media_item_id = ${mediaItemId}::uuid` : sql``;
    const rows = await sql<{ count: number }[]>`
        WITH candidates AS (
            SELECT s.media_item_id
              FROM media_item_stage_state s
              JOIN media_items mi ON mi.id = s.media_item_id
             WHERE s.stage_id = 'trickplay-params-sync'
               AND s.status IN ('pending', 'failed_transient', 'skipped_transient')
               AND s.processing_version <= ${processingVersion}
               AND mi.status = 'active'
               ${itemFilter}
               AND EXISTS (
                   SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id
               )
               AND NOT EXISTS (
                   SELECT 1 FROM media_file_items mfi
                    WHERE mfi.media_item_id = mi.id
                      AND NOT EXISTS (
                          SELECT 1 FROM trickplay_params tp
                           WHERE tp.media_item_id = mi.id AND tp.file_id = mfi.file_id
                      )
                      AND NOT (${currentTrickplayFileMarker(sql, processingVersion)})
               )
               AND NOT EXISTS (
                   SELECT 1 FROM task_history th
                    WHERE th.id = s.last_run_id
                      AND th.state IN ('pending', 'active', 'cancelling')
               )
             ORDER BY s.updated_at, s.media_item_id
             LIMIT ${limit}
             FOR UPDATE OF s SKIP LOCKED
        ), reconciled AS (
            UPDATE media_item_stage_state s
               SET status = CASE WHEN EXISTS (
                       SELECT 1 FROM trickplay_params tp
                       JOIN media_file_items mfi ON mfi.file_id = tp.file_id
                        WHERE mfi.media_item_id = s.media_item_id
                          AND tp.media_item_id = s.media_item_id
                   ) THEN 'completed' ELSE 'skipped_permanent' END,
                   skipped_reason = CASE WHEN EXISTS (
                       SELECT 1 FROM trickplay_params tp
                       JOIN media_file_items mfi ON mfi.file_id = tp.file_id
                        WHERE mfi.media_item_id = s.media_item_id
                          AND tp.media_item_id = s.media_item_id
                   ) THEN NULL ELSE 'all-linked-files-terminal' END,
                   processing_version = GREATEST(s.processing_version, ${processingVersion}),
                   completed_at = now(),
                   declines = 0,
                   declines_since = NULL,
                   next_eligible_at = NULL,
                   invalidated_at = NULL,
                   updated_at = now()
              FROM candidates c
             WHERE s.media_item_id = c.media_item_id
               AND s.stage_id = 'trickplay-params-sync'
             RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM reconciled
    `;
    return rows[0]?.count ?? 0;
}

/**
 * An obsolete item row has no reliable source witness in legacy params or
 * markers. Clear only its currently linked trickplay evidence before retrying;
 * the stage row, params and markers change together under the stage row lock.
 */
export async function resetObsoleteTrickplayCoverage(
    sql: postgres.Sql,
    limit: number,
    processingVersion: number,
): Promise<number> {
    return withTx(sql, async (tx) => {
        const rows = await tx<{ media_item_id: string }[]>`
            SELECT s.media_item_id
              FROM media_item_stage_state s
              JOIN media_items mi ON mi.id = s.media_item_id
             WHERE s.stage_id = 'trickplay-params-sync'
               AND s.status = 'obsolete'
               AND s.processing_version <= ${processingVersion}
               AND mi.status = 'active'
               AND mi.media_type = ANY(${[...DEFAULT_ELIGIBLE_MEDIA_TYPES]})
               AND NOT EXISTS (
                   SELECT 1 FROM task_history th
                    WHERE th.id = s.last_run_id
                      AND th.state IN ('pending', 'active', 'cancelling')
               )
             ORDER BY s.updated_at, s.media_item_id
             LIMIT ${limit}
             FOR UPDATE OF s SKIP LOCKED
        `;
        if (rows.length === 0) return 0;
        const ids = rows.map((row) => row.media_item_id);
        await tx`
            DELETE FROM trickplay_params tp
             WHERE tp.media_item_id = ANY(${ids}::uuid[])
               AND EXISTS (
                   SELECT 1 FROM media_file_items mfi
                    WHERE mfi.media_item_id = tp.media_item_id
                      AND mfi.file_id = tp.file_id
               )
        `;
        await tx`
            UPDATE media_items mi
               SET processing_state = mi.processing_state - ARRAY(
                   SELECT 'trickplay-params:' || mfi.file_id::text
                     FROM media_file_items mfi
                    WHERE mfi.media_item_id = mi.id
               )
             WHERE mi.id = ANY(${ids}::uuid[])
               AND jsonb_typeof(mi.processing_state) = 'object'
        `;
        await tx`
            UPDATE media_item_stage_state s
               SET status = 'pending', skipped_reason = NULL,
                   next_eligible_at = NULL, invalidated_at = NULL, updated_at = now()
             WHERE s.stage_id = 'trickplay-params-sync'
               AND s.media_item_id = ANY(${ids}::uuid[])
               AND s.status = 'obsolete'
        `;
        return ids.length;
    });
}

/**
 * Coverage-table backlog for trickplay-params-sync.
 *
 * Returns (media_item, file) pairs with current runnable work. A historical
 * `completed` item-level row cannot hide a newly linked alternate file.
 * Result shape is identical to
 * `getItemsWithoutTrickplayParams` so callers can swap the fetch without
 * changing the process-slice logic.
 */
export async function findCoverageTableBacklog(
    sql: postgres.Sql,
    stageId: string,
    limit: number,
    processingVersion: number,
): Promise<ItemWithoutTrickplay[]> {
    const rows = await sql<{ id: string; file_id: string; jellyfin_id: string | null }[]>`
        SELECT mi.id, mfi.file_id, ei.external_id AS jellyfin_id
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
        WHERE miss.stage_id = ${stageId}
          AND miss.processing_version <= ${processingVersion}
          AND (
              miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
              OR (
                  miss.status = 'completed'
                  AND EXISTS (
                      SELECT 1 FROM media_file_items linked
                      JOIN trickplay_params tp
                        ON tp.media_item_id = mi.id AND tp.file_id = linked.file_id
                      WHERE linked.media_item_id = mi.id
                  )
              )
              OR (
                  miss.status = 'skipped_permanent'
                  AND (
                      miss.skipped_reason = 'all-linked-files-terminal'
                      OR (
                          miss.skipped_reason = 'no-provider'
                          AND EXISTS (
                              SELECT 1 FROM media_file_items mfi
                               WHERE mfi.media_item_id = mi.id
                                 AND ${currentTrickplayFileMarker(sql, processingVersion)}
                          )
                      )
                  )
              )
          )
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
          AND mi.media_type = ANY(${[...DEFAULT_ELIGIBLE_MEDIA_TYPES]})
          AND mi.status = 'active'
          AND NOT (${currentTrickplayFileMarker(sql, processingVersion)})
          AND NOT EXISTS (
              SELECT 1 FROM trickplay_params tp
              WHERE tp.media_item_id = mi.id
                AND tp.file_id = mfi.file_id
          )
        ORDER BY miss.next_eligible_at ASC NULLS FIRST, miss.updated_at ASC,
                 mi.id ASC, mfi.sort_order NULLS LAST, mfi.file_id ASC
        LIMIT ${limit}
    `;
    return rows.map((r) => ({
        id: r.id,
        fileId: r.file_id,
        jellyfinId: r.jellyfin_id,
    }));
}

/**
 * Availability of trickplay (scrub thumbnail) sprite sheets for a media
 * item, derived from `media_item_stage_state` for the `trickplay-generation`
 * stage and cross-checked against `trickplay_params`.
 *
 * `widths` is only ever non-empty when `state === 'ready'` — see the
 * sanity rule on {@link getTrickplayAvailability}.
 */
export interface TrickplayAvailability {
    state: 'ready' | 'pending' | 'unsupported';
    widths: number[];
    /** Only a current completed stage with no selected-file params may probe disk. */
    needsRepair?: true;
}

/**
 * `skipped_reason` values on a `skipped_permanent` `trickplay-generation` row
 * that are re-checkable, not a genuine dead end.
 *
 * `trickplayGenerationTask` (media-item-tasks.ts) has TWO writers of
 * `skipped_permanent`:
 *   - the sweep's eligibility-dispose pass (stage-disposition-runner.ts), which
 *     stamps {@link ELIGIBILITY_SKIP_REASON} (`'ineligible'`) — the task's
 *     `eligibility` block sets no custom `skipReason`; and
 *   - its author `kind:'predicate'` disposition `trickplay-generation-disabled`,
 *     which stamps `'trickplay-disabled'` for the whole stage whenever
 *     `TRICKPLAY_ENABLED` is off (the default).
 * `'no-file-linked'` is the pre-consolidation legacy equivalent the stage also
 * declares via `recoverWhenAdditionalReasons`.
 *
 * All three are the exact set stage-sweep.ts's event-independent heal
 * re-enrolls back to `pending` the instant eligibility becomes true again — a
 * probed video stream lands, a file gets (re-)linked, or the operator turns
 * trickplay on — so none is a promise that trickplay will never exist.
 *
 * 🔴 `'trickplay-disabled'` in particular MUST stay listed. `'unsupported'` is
 * a strong client promise ("never retry"), and on a stock install
 * `TRICKPLAY_ENABLED` defaults to false — so omitting it would hand every
 * client a permanent "no scrub thumbnails for this title" verdict for a
 * setting the operator can flip in the admin UI.
 */
const RECOVERABLE_SKIPPED_REASONS = new Set<string>([
    ELIGIBILITY_SKIP_REASON,
    'no-file-linked',
    'trickplay-disabled',
]);

/**
 * Whether trickplay sprite sheets can be fetched right now for `mediaId`,
 * and at which widths.
 *
 * Mirrors `getSegmentAnalysisStatus` (media-segments.queries.ts)'s
 * `processing_version` / `invalidated_at` freshness handling: a stage row is
 * only trusted when it is current — `invalidated_at IS NULL` and
 * `processing_version >= minVersion` — otherwise the item is treated as if
 * no row existed at all (`'pending'`), even if it was previously terminal.
 * Both the "ready" and the "unsupported" verdicts are strong client
 * promises (fetch now / never retry), so neither may be handed out from a
 * stale row.
 *
 * Terminal states of the (current) stage row map as follows:
 *   - `'completed'`                                   → tentatively `'ready'`
 *   - `'skipped_permanent'` with a recoverable reason  → `'pending'` (see
 *     {@link RECOVERABLE_SKIPPED_REASONS} — this is the common case: an item
 *     seeded before media-probe writes streams, healed the instant it does)
 *   - `'skipped_permanent'` with any other reason      → `'unsupported'`
 *   - anything else (no row, `'pending'`, `'running'`, `'failed_transient'`,
 *     `'obsolete'`, `'skipped_transient'`, or stale)    → `'pending'`
 *
 * Sanity check: a tentative `'ready'` is downgraded to `'pending'` when
 * `trickplay_params` has no rows for this item — advertising tiles that
 * cannot actually be served is worse than under-promising. This can happen
 * transiently between the stage-completion write and the params write, or
 * if the params were deleted out from under a completed stage row.
 */
export async function getTrickplayAvailability(
    sql: postgres.Sql,
    mediaId: string,
    stageId: string,
    minVersion: number,
    fileId?: string | null,
): Promise<TrickplayAvailability> {
    const [stageRows, widthRows] = await Promise.all([
        sql<
            {
                status: string;
                processing_version: number;
                invalidated_at: Date | null;
                skipped_reason: string | null;
            }[]
        >`
            SELECT status, processing_version, invalidated_at, skipped_reason
            FROM media_item_stage_state
            WHERE media_item_id = ${mediaId}
              AND stage_id = ${stageId}
        `,
        sql<{ width: number }[]>`
            SELECT DISTINCT width
            FROM trickplay_params
            WHERE media_item_id = ${mediaId}
              AND (${fileId ?? null}::uuid IS NULL OR file_id = ${fileId ?? null}::uuid)
            ORDER BY width ASC
        `,
    ]);

    const stage = stageRows[0] ?? null;
    const isCurrent =
        stage !== null && stage.invalidated_at === null && stage.processing_version >= minVersion;

    if (isCurrent && stage.status === 'skipped_permanent') {
        if (!RECOVERABLE_SKIPPED_REASONS.has(stage.skipped_reason ?? '')) {
            return { state: 'unsupported', widths: [] };
        }
        // Recoverable tombstone — fall through to the 'pending' default below,
        // same as a row that hasn't reached a terminal state yet.
    }

    if (isCurrent && stage.status === 'completed') {
        const widths = widthRows.map((r) => r.width);
        if (widths.length > 0) return { state: 'ready', widths };
        return { state: 'pending', widths: [], needsRepair: true };
    }

    return { state: 'pending', widths: [] };
}

/** Convert DB row to TrickplayInfo shape */
export function toTrickplayInfo(row: TrickplayParamsRow): TrickplayInfo {
    return {
        width: row.width,
        height: row.height,
        tileWidth: row.tile_width,
        tileHeight: row.tile_height,
        thumbnailCount: row.thumbnail_count,
        interval: row.interval_ms,
        bandwidth: row.bandwidth,
    };
}

/** A local publication replaces imported provider discovery for this file. */
export async function deleteNonLocalTrickplayParams(
    sql: postgres.Sql,
    mediaId: string,
    fileId: string,
): Promise<void> {
    await sql`DELETE FROM trickplay_params
        WHERE media_item_id = ${mediaId} AND file_id = ${fileId} AND source <> 'local'`;
}
