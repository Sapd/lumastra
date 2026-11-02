// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Analysis Query Module
 *
 * Pure SQL queries for the music-analysis sync plugin. Like the
 * `artist-enrichment.queries` module, the fetchSlice predicate
 * (`getUnanalyzedTracks`) and the admin-card count predicate
 * (`countUnanalyzedTracks`) live together and MUST stay in lockstep —
 * otherwise the backlog card and the drain disagree about "remaining".
 *
 * @module queries/music-analysis
 */

import type postgres from 'postgres';

// =============================================================================
// Types
// =============================================================================

export interface UnanalyzedTrackRow {
    id: string;
    file_path: string;
}

export interface MusicAnalysisBacklogCounts {
    analyzed: number;
    remaining: number;
    ineligible: number;
    failed: number;
}

// =============================================================================
// Predicates
// =============================================================================

/**
 * Select the next slice of tracks the drain should analyze. MUST match the
 * `has_file` + marker logic in `getMusicAnalysisBacklog` — the fetchSlice
 * predicate and the `remaining` counter are kept in lockstep in this
 * module.
 *
 * Ordering is `mi.created_at DESC` so newly-imported tracks analyze first
 * — users notice missing BPMs on freshly-added tracks the most. `mi.id
 * ASC` is appended as the tiebreaker so tracks sharing a created_at (the
 * whole batch flushed on one scan) return in a deterministic order; the
 * drain's no-progress signature (count + first-id + last-id) misfires
 * otherwise.
 *
 * Filter parity with `countUnanalyzedTracks`:
 * - `DISTINCT ON (mi.id)` collapses tracks attached to multiple media_files
 *   into a single row (the file scanner can yield N rows per track for
 *   legitimate multi-file imports — versions, secondary formats, etc.).
 *   Without DISTINCT, a slice of LIMIT 100 can hand back a dozen unique
 *   tracks and the drain spends its budget re-analyzing duplicates.
 * - `mf.file_path IS NOT NULL` matches the count predicate so the
 *   admin-facing "remaining" total and the fetch predicate never drift.
 * - `MIN(mf.id)` picks a canonical file per track (stable, deterministic)
 *   so the same file_path is analyzed every drain — no risk of
 *   flip-flopping between variants.
 */
export async function getUnanalyzedTracks(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
    limit: number,
): Promise<UnanalyzedTrackRow[]> {
    // Subquery-with-DISTINCT pattern rather than DISTINCT ON: postgres.js
    // parameterizes the ORDER BY and DISTINCT ON requires the leading
    // columns to match ORDER BY verbatim, which made the hoist-and-rank
    // version awkward. The windowed MIN(mf.id) keeps a single canonical
    // file per track while preserving the created_at DESC ordering.
    return sql<UnanalyzedTrackRow[]>`
        SELECT id, file_path FROM (
            SELECT
                mi.id,
                mi.created_at,
                MIN(mf.id::text) AS file_id,
                (ARRAY_AGG(mf.file_path ORDER BY mf.id))[1] AS file_path
            FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE mi.media_type = 'track'
              AND mf.file_path IS NOT NULL
              AND (
                  mi.processing_state->'music-analysis' IS NULL
                  OR (mi.processing_state->'music-analysis'->>'version')::int < ${processingVersion}
              )
            GROUP BY mi.id, mi.created_at
        ) sub
        ORDER BY created_at DESC, id ASC
        LIMIT ${limit}
    `;
}

/**
 * Count tracks eligible for analysis — must have at least one attached
 * media_file row with a non-null file_path AND either no marker or a stale
 * version. Matches the fetchSlice WHERE clause so the heartbeat and the
 * remaining-hint totals stay consistent with the drain loop's actual work.
 */
export async function countUnanalyzedTracks(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
): Promise<number> {
    const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c
        FROM media_items mi
        WHERE mi.media_type = 'track'
          AND EXISTS (
              SELECT 1 FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
              WHERE mfi.media_item_id = mi.id
                AND mf.file_path IS NOT NULL
          )
          AND (
              mi.processing_state->'music-analysis' IS NULL
              OR (mi.processing_state->'music-analysis'->>'version')::int < ${processingVersion}
          )
    `;
    return row?.c ?? 0;
}

/**
 * Full bucket breakdown for the admin backlog card.
 *
 *   analyzed   → current-version marker, status NOT IN (failed, skipped).
 *                Absent/unknown status is treated as success so future
 *                status values can be added without silently dropping rows.
 *   failed     → current-version marker, status='failed' (Essentia threw —
 *                retry on version bump).
 *   ineligible → current-version marker with status='skipped' (file missing
 *                when drain ran) PLUS unmarked tracks that have no attached
 *                media_file (or null path). Lumping "skipped" with the
 *                no-media-file cohort keeps the progress bar honest
 *                (analyzed / (analyzed+remaining)) without inflating "done".
 *   remaining  → unmarked (or older-version marker) tracks WITH a non-null
 *                file_path — i.e. the drain's work set.
 *
 * `has_file` mirrors the fetchSlice JOIN (media_file_items + media_files
 * with a non-null path) so the backlog card never shows a phantom
 * "remaining" that the drain will never actually fetch.
 */
export async function getMusicAnalysisBacklog(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
): Promise<MusicAnalysisBacklogCounts> {
    const [row] = await sql<
        Array<{
            analyzed: number;
            remaining: number;
            ineligible: number;
            failed: number;
        }>
    >`
        WITH marker AS (
            SELECT
                mi.id,
                (processing_state->'music-analysis'->>'version')::int AS version,
                processing_state->'music-analysis'->>'status'           AS status,
                EXISTS (
                    SELECT 1 FROM media_file_items mfi
                    JOIN media_files mf ON mf.id = mfi.file_id
                    WHERE mfi.media_item_id = mi.id
                      AND mf.file_path IS NOT NULL
                ) AS has_file
            FROM media_items mi
            WHERE media_type = 'track'
        )
        SELECT
            COUNT(*) FILTER (
                WHERE version >= ${processingVersion}
                  AND (status IS NULL OR status NOT IN ('failed', 'skipped'))
            )::int AS analyzed,
            COUNT(*) FILTER (
                WHERE version >= ${processingVersion}
                  AND status = 'failed'
            )::int AS failed,
            COUNT(*) FILTER (
                WHERE (version IS NULL OR version < ${processingVersion})
                  AND has_file
            )::int AS remaining,
            COUNT(*) FILTER (
                WHERE (version IS NULL OR version < ${processingVersion})
                  AND NOT has_file
            )::int
            + COUNT(*) FILTER (
                WHERE version >= ${processingVersion}
                  AND status = 'skipped'
            )::int AS ineligible
        FROM marker
    `;
    return {
        analyzed: row?.analyzed ?? 0,
        remaining: row?.remaining ?? 0,
        ineligible: row?.ineligible ?? 0,
        failed: row?.failed ?? 0,
    };
}

// =============================================================================
// Coverage-table backlog (feature-flag path)
// =============================================================================

/**
 * Return up to `limit` track IDs from `media_item_stage_state` where the row
 * is in a retriable state for `stageId`. Used when
 * `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES` includes `'music-analysis'` and
 * the coverage table is the authoritative eligibility source instead of the
 * legacy `processing_state` predicate.
 *
 * Retriable statuses:
 *   pending          — not yet processed
 *   failed_transient — transient failure, backoff window expired
 *   obsolete         — content changed, needs re-analysis
 *   skipped_transient — transient skip (e.g. mount outage), retry allowed
 *
 * Version-aware re-run: a `completed` row whose `processing_version` is below
 * `processingVersion` is also selected so that bumping PROCESSING_VERSION
 * re-queues already-completed tracks. `upsertCompletedRow` stamps
 * `GREATEST(EXCLUDED, existing)` on completion, so re-completed rows carry
 * the new version and will not loop back into the backlog.
 *
 * The JOIN back to `media_files` keeps the result shape identical to
 * `getUnanalyzedTracks` so callers can swap the fetch without touching the
 * process-slice logic.
 */
export async function findCoverageTableBacklog(
    sql: postgres.Sql<Record<string, never>>,
    stageId: string,
    processingVersion: number,
    limit: number,
): Promise<UnanalyzedTrackRow[]> {
    return sql<UnanalyzedTrackRow[]>`
        SELECT mi.id, (ARRAY_AGG(mf.file_path ORDER BY mf.id))[1] AS file_path
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE miss.stage_id = ${stageId}
          AND (
              miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
              OR (miss.status = 'completed' AND miss.processing_version < ${processingVersion})
          )
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
          AND mi.media_type = 'track'
          AND mf.file_path IS NOT NULL
        GROUP BY mi.id
        ORDER BY mi.created_at DESC, mi.id ASC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Duration cap
// =============================================================================

/** Reason stamped on tracks skipped for exceeding the duration cap. */
export const TRACK_TOO_LONG_REASON = 'track-too-long';

/**
 * TRUE when the track (alias `mi`) has a live file longer than `maxSeconds`.
 * `maxSeconds <= 0` means "no cap" and yields a constant FALSE, so the
 * fragment is safe to embed unconditionally (stage eligibility, reconcile).
 */
export function overDurationLimitSql(
    sql: postgres.Sql<Record<string, never>>,
    maxSeconds: number,
): postgres.PendingQuery<postgres.Row[]> {
    if (!(maxSeconds > 0)) return sql`false`;
    return sql`EXISTS (
        SELECT 1 FROM media_file_items mfi
          JOIN media_files mf ON mf.id = mfi.file_id
         WHERE mfi.media_item_id = mi.id
           AND NOT mf.is_missing
           AND mf.duration_seconds > ${maxSeconds}
    )`;
}

/** Per-track form of {@link overDurationLimitSql}, for the single-item paths. */
export async function isTrackOverDurationLimit(
    sql: postgres.Sql<Record<string, never>>,
    trackId: string,
    maxSeconds: number,
): Promise<boolean> {
    if (!(maxSeconds > 0)) return false;
    const [row] = await sql<{ over: boolean }[]>`
        SELECT ${overDurationLimitSql(sql, maxSeconds)} AS over
          FROM media_items mi
         WHERE mi.id = ${trackId}::uuid
    `;
    return row?.over === true;
}

/**
 * Bring existing markers in line with the current cap, in both directions:
 *
 * - `skippedIds`: over-cap tracks still marked `failed` at the current version
 *   (the 60m+ DJ mixes that returned `essentia-empty-result` before the cap
 *   existed) are re-stamped `skipped` / {@link TRACK_TOO_LONG_REASON}. They are
 *   never refetched on their own, so without this the failures would persist.
 * - `restoredIds`: tracks skipped for length that are now within the cap (the
 *   operator raised or removed it) lose their marker so the drain picks them up.
 *
 * Unmarked over-cap tracks are left to the per-track guard in the drain.
 */
export async function reconcileDurationLimit(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
    maxSeconds: number,
): Promise<{ skippedIds: string[]; restoredIds: string[] }> {
    const skipped =
        maxSeconds > 0
            ? await sql<{ id: string }[]>`
                UPDATE media_items mi
                   SET processing_state = processing_state || ${sql.json({
                       'music-analysis': {
                           version: processingVersion,
                           processedAt: new Date().toISOString(),
                           status: 'skipped',
                           reason: TRACK_TOO_LONG_REASON,
                       },
                   })}
                 WHERE mi.media_type = 'track'
                   AND mi.processing_state -> 'music-analysis' ->> 'status' = 'failed'
                   AND (mi.processing_state -> 'music-analysis' ->> 'version')::int >= ${processingVersion}
                   AND ${overDurationLimitSql(sql, maxSeconds)}
             RETURNING mi.id
            `
            : [];
    const restored = await sql<{ id: string }[]>`
        UPDATE media_items mi
           SET processing_state = processing_state - 'music-analysis'
         WHERE mi.media_type = 'track'
           AND mi.processing_state -> 'music-analysis' ->> 'status' = 'skipped'
           AND mi.processing_state -> 'music-analysis' ->> 'reason' = ${TRACK_TOO_LONG_REASON}
           AND NOT ${overDurationLimitSql(sql, maxSeconds)}
     RETURNING mi.id
    `;
    return {
        skippedIds: skipped.map((r) => r.id),
        restoredIds: restored.map((r) => r.id),
    };
}

// =============================================================================
// Mutations
// =============================================================================

export type MusicAnalysisStatus = 'skipped' | 'failed';

/**
 * Mark a track's processing_state so the fetchSlice query excludes it on
 * subsequent drains. Without this, tracks whose file is missing or whose
 * Essentia analysis fails occupy the newest-100 cursor forever — the
 * scheduler fetches the same 100 bad tracks every hour, analyzes none,
 * and the drain never makes progress on newer material.
 *
 * `status` is recorded for observability (admins can see which tracks were
 * skipped vs. failed) but the fetchSlice query treats any row with
 * `version >= PROCESSING_VERSION` as off-limits. Under the legacy
 * non-authoritative path (`countUnanalyzedTracks` / `getUnanalyzedTracks`) a
 * PROCESSING_VERSION bump re-admits skipped/failed tracks for retry. Under the
 * authoritative coverage-table path, re-admission is driven by
 * `findCoverageTableBacklog` selecting rows whose `processing_version` is below
 * the current version — a version bump alone does not re-admit tracks whose
 * coverage-table row carries a non-retriable status.
 *
 * Returns `true` when the marker write landed. Callers credit `advanced`
 * only on a true result — a DB blip must leave the row eligible so
 * drainBacklog's no-progress detector can fire on a genuinely stuck writer
 * instead of silently burning the soft budget.
 */
export async function markTrackExcluded(
    sql: postgres.Sql<Record<string, never>>,
    trackId: string,
    processingVersion: number,
    status: MusicAnalysisStatus,
    reason: string,
    jobId?: string,
): Promise<boolean> {
    const marker: Record<string, unknown> = {
        version: processingVersion,
        processedAt: new Date().toISOString(),
        status,
        reason,
    };
    if (status === 'failed' && jobId !== undefined) {
        marker.audit_run_job_id = jobId;
    }
    try {
        await sql`
            UPDATE media_items
            SET processing_state = COALESCE(processing_state, '{}'::jsonb) || ${sql.json({
                'music-analysis': marker,
            } as unknown as postgres.JSONValue)}
            WHERE id = ${trackId}
        `;
        return true;
    } catch {
        return false;
    }
}

/**
 * Mark a track as successfully analyzed at the current processing version.
 * Returns `true` if the UPDATE landed, `false` on any DB failure — mirroring
 * `markTrackExcluded` and `markArtistProcessed` so every processing-state
 * writer shares the same contract.
 *
 * Callers pair this with `storeAnalysis` inside a single transaction so a
 * mid-flight crash never desyncs processing_state from custom_metadata. To
 * get tx-rollback-on-failure semantics the caller must treat `false` as an
 * error and `throw` explicitly; otherwise the surrounding `sql.begin` will
 * commit the stored analysis with no marker attached.
 */
export async function markTrackAnalyzed(
    sql: postgres.Sql<Record<string, never>>,
    trackId: string,
    processingVersion: number,
): Promise<boolean> {
    try {
        await sql`
            UPDATE media_items
            SET processing_state = COALESCE(processing_state, '{}'::jsonb) || ${sql.json({
                'music-analysis': {
                    version: processingVersion,
                    processedAt: new Date().toISOString(),
                },
            })}
            WHERE id = ${trackId}
        `;
        return true;
    } catch {
        return false;
    }
}

// =============================================================================
// Wipe
// =============================================================================

/**
 * Pick up to `limit` track IDs that still carry Essentia-derived data — the
 * ones we need to roll back in an atomic wipe batch. A track qualifies if
 * it has the Essentia namespace in custom_metadata OR a music-analysis
 * marker in processing_state.
 */
export async function getMusicAnalysisWipeBatch(
    sql: postgres.Sql<Record<string, never>>,
    essentiaNamespaceKey: string,
    limit: number,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM media_items
        WHERE media_type = 'track'
          AND (
              custom_metadata ? ${essentiaNamespaceKey}
              OR (jsonb_typeof(processing_state) = 'object' AND processing_state ? 'music-analysis')
          )
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/**
 * Atomically clear Essentia data from the given track IDs in a single
 * UPDATE statement. Because we're writing two JSONB keys on the same row,
 * the UPDATE is inherently atomic — no risk of leaving custom_metadata
 * cleared while processing_state still carries the old marker (or vice
 * versa).
 *
 * Returns the number of rows touched.
 */
export async function atomicallyWipeMusicAnalysis(
    sql: postgres.Sql<Record<string, never>>,
    ids: string[],
    essentiaNamespaceKey: string,
): Promise<number> {
    const result = await sql`
        UPDATE media_items mi
        SET
            custom_metadata = mi.custom_metadata - ${essentiaNamespaceKey},
            processing_state = mi.processing_state - 'music-analysis',
            updated_at = NOW()
        WHERE mi.id = ANY(${ids})
    `;
    return result.count ?? 0;
}
