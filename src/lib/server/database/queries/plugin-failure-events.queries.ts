// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Failure Events Query Module
 *
 * Append-only log backing Phase G's per-item failure timeline. Every call
 * to a plugin's failed-marker helper (markFailedSentinel, markArtistProcessed
 * with status='failed', markTrackExcluded with status='failed', etc.)
 * should be followed by `recordFailure` to surface the timeline in the
 * admin UI. Event writes are advisory — failures are swallowed to avoid
 * blocking the primary marker write.
 */

import type postgres from 'postgres';
import { reviewedDurationFailureSql } from './file-health-review.queries.js';
import {
    currentAnalyzerFailurePredicate,
    analyzerFailureVersionSql,
} from './media-segment-input.queries.js';
import { Logger } from '../../utils/logger.js';
import { condenseFailureReason, MAX_REASON_LEN } from '../../utils/failure-reason.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

const logger = Logger.for('PluginFailureEvents');

export interface FailureEventRow {
    id: string;
    plugin_id: string;
    item_id: string;
    reason: string | null;
    /**
     * task_history.id (run id) — column is `run_id` on the new schema
     * introduced by migration 15.0.0. The old schema used
     * `task_run_job_id` (task name), which migration 15.0.0 dropped.
     */
    run_id: string | null;
    /**
     * Same resolution semantic as before — kept non-null when the
     * run row still exists in `task_history` (or its archive). Null
     * means the original row has aged out of both tables.
     */
    task_run_id: string | null;
    /**
     * Column was renamed `created_at` → `occurred_at` in migration
     * 15.0.0. Field name kept stable for API compatibility — the
     * SELECT aliases the new column back to this name.
     */
    occurred_at: Date;
    file_id?: string | null;
    input_identity?: string | null;
    processing_version?: number | null;
    analysis_stage_id?: string | null;
    input_scope?: 'current' | 'earlier' | 'unverified';
}

export interface FailureAggregateRow {
    plugin_id: string;
    item_id: string;
    failure_count: number;
    first_seen: Date;
    last_seen: Date;
}

/** Cap reason strings before they hit the event log. Pathological errors
 *  (5 MB stack trace, HTML 500 body) would otherwise bloat the table and
 *  slow every aggregate read. 500 chars matches trickplay's existing
 *  MAX_REASON_LEN convention for in-marker reasons.
 *
 *  Re-exported from the condenser so the cap and the thing that enforces it
 *  cannot drift apart. */
export { MAX_REASON_LEN };

/**
 * Append a failure event. Non-throwing — any DB error is logged at ERROR
 * severity and the caller continues. The event log is a supplementary
 * forensic signal, never the source of truth for "is this item currently
 * failing" (that's the per-plugin marker). Therefore an INSERT failure here
 * must NOT unwind the marker write the caller just performed.
 *
 * **TRANSACTION COUPLING:** This function accepts either the outer `sql`
 * instance or a `tx` handle. Which to pass depends on the desired durability
 * guarantee:
 *
 * - Pass the outer `sql` when the event should survive a marker-write
 *   rollback. A rollback on the caller's transaction leaves the event intact,
 *   giving a forensic record even when the marker itself was not committed.
 *
 * - Pass `tx` (a transaction handle) when atomicity is required — e.g.
 *   media-probe writes the event INSIDE the probe transaction so a process
 *   crash between tx commit and a subsequent INSERT cannot leave an orphan
 *   marker without an event. In this case a tx rollback also discards the
 *   event, but the marker itself was also rolled back, so no orphan is created.
 *
 * Choose the option that matches the invariant at your call site.
 */
export async function recordFailure(
    sql: postgres.Sql,
    pluginId: string,
    itemKey: string,
    reason: string | null,
    jobId: string | null,
    // Optional coverage stage. Plugins with a single stage pass nothing and
    // keep writing NULL; plugins that tombstone several stages independently
    // pass theirs so each one accumulates its own quarantine threshold.
    stageId: string | null = null,
    lineage?: {
        fileId: string;
        inputIdentity: string;
        analysisStageId?: string;
        processingVersion?: number;
    },
): Promise<void> {
    // condenseFailureReason, NOT a head slice. A reason that is a subprocess's
    // captured stderr puts its preamble first and its diagnosis last, so
    // slicing from the front stored 500 characters of ffmpeg build banner and
    // discarded the error — 705 prod rows across 300 items said nothing at all
    // (2026-09-11). See failure-reason.ts.
    const cappedReason = reason !== null ? condenseFailureReason(reason, MAX_REASON_LEN) : reason;
    try {
        // Migration 15.0.0 dropped + recreated the table with new
        // column names (`item_id`, `run_id`, `occurred_at`). Inserts
        // here previously used the old names and failed with
        // "column does not exist", losing every failure-timeline
        // event for every plugin until repaired.
        await sql`
            INSERT INTO plugin_failure_events (
                plugin_id, item_id, reason, run_id, stage_id, file_id, input_identity,analysis_stage_id,processing_version
            ) VALUES (
                ${pluginId},
                ${itemKey},
                ${cappedReason ?? 'unspecified'},
                ${jobId ?? null},
                ${stageId},
                ${lineage?.fileId ?? null},
                ${lineage?.inputIdentity ?? null},
                ${lineage?.analysisStageId ?? stageId},${lineage?.processingVersion ?? null}
            )
        `;
    } catch (err) {
        logger.error(
            'Failed to record plugin_failure_events row — failure timeline data lost',
            err instanceof Error ? err : new Error(String(err)),
            { pluginId, itemKey },
        );
    }
}

/**
 * Fetch the full timeline for a single (plugin_id, item_id) — newest
 * events first. Bounded by `limit` so a hot-loop item can't ship a 10k-
 * row response to the admin UI.
 *
 * The task_history → task_run_id resolution uses LEFT JOIN LATERAL with
 * LIMIT 1 (rather than a UNION-ALL subquery JOIN) to defend against the
 * edge case where the same `task_id` appears in BOTH the live and
 * archive tables. A plain UNION-JOIN would emit duplicate event rows in
 * that case — the lateral preserves one row per event regardless of
 * how many task_history-side rows match the job_id. Archive rows are
 * filtered to `original_id IS NOT NULL` because the archive's own
 * SERIAL `id` is a different id-space (Phase D's contract).
 */
export async function getFailureTimeline(
    sql: postgres.Sql,
    pluginId: string,
    itemKey: string,
    limit = 100,
): Promise<FailureEventRow[]> {
    // NaN-defensive — Math.min(500, Math.max(1, NaN)) collapses to NaN and
    // would crash the SQL LIMIT. Internal callers shouldn't pass NaN, but
    // a guard here means a single bad call doesn't take down the timeline.
    const clampedLimit = Number.isFinite(limit) ? Math.min(500, Math.max(1, limit)) : 100;
    return sql<FailureEventRow[]>`
        SELECT
            fe.id::text AS id,
            fe.plugin_id,
            fe.item_id,
            fe.reason,
            fe.run_id,
            th.id AS task_run_id,
            fe.occurred_at, fe.file_id, fe.input_identity,fe.analysis_stage_id,fe.processing_version,
            CASE WHEN fe.input_identity IS NULL OR (fe.plugin_id='lumastra-intro-analyzer' AND (fe.processing_version IS NULL OR COALESCE(fe.analysis_stage_id,fe.stage_id) IS NULL)) THEN 'unverified'
                 WHEN TRUE ${currentAnalyzerFailurePredicate(sql, 'fe')} THEN 'current'
                 ELSE 'earlier' END AS input_scope
        FROM plugin_failure_events fe
        LEFT JOIN LATERAL (
            SELECT id FROM (
                SELECT id FROM task_history
                UNION ALL
                SELECT id FROM task_history_archive
            ) u
            WHERE u.id = fe.run_id
            LIMIT 1
        ) th ON true
        WHERE fe.plugin_id = ${pluginId}
          AND fe.item_id = ${itemKey}
        ORDER BY fe.occurred_at DESC, fe.id DESC
        LIMIT ${clampedLimit}
    `;
}

/**
 * Batch-aggregate failure stats for a set of (plugin_id, item_id) pairs.
 * Used by listFailedItems JOIN to populate the new firstSeen / failureCount
 * / lastSeen fields without N+1 queries. Returns a Map keyed by item_id
 * for O(1) lookups during the row transformation.
 *
 * Scoped to a single pluginId because listFailedItems is always called
 * per-plugin; a bulk-across-plugins query would need a composite key Map
 * which the callers never need.
 *
 * **Throws on DB errors.** listFailedItems callers in plugin code wrap
 * the call in a try/catch and fall back to an empty Map — the list main
 * SELECT has already succeeded by this point, so serving rows without
 * the new aggregate columns is strictly better than serving a 500
 * because the supplementary aggregate query hit a transient blip.
 */
export async function getFailureAggregates(
    sql: postgres.Sql,
    pluginId: string,
    itemKeys: string[],
    // When given, count only failures recorded for that coverage stage, so a
    // plugin whose stages are tombstoned independently does not arm one
    // stage's quarantine threshold with another stage's failures.
    stageId: string | null = null,
    freshRetryBudget = false,
): Promise<Map<string, FailureAggregateRow>> {
    if (itemKeys.length === 0) return new Map();
    const rows = await sql<FailureAggregateRow[]>`
        SELECT
            plugin_id,
            item_id,
            COUNT(*)::int AS failure_count,
            MIN(occurred_at) AS first_seen,
            MAX(occurred_at) AS last_seen
        FROM plugin_failure_events fe
        WHERE plugin_id = ${pluginId}
          AND item_id = ANY(${itemKeys})
          ${currentAnalyzerFailurePredicate(sql, 'fe')}
          AND (${stageId}::text IS NULL OR stage_id = ${stageId})
          AND (${freshRetryBudget} = false OR (
              fe.resolved_at IS NULL AND NOT EXISTS (
                  SELECT 1 FROM media_item_stage_state ss
                  WHERE ss.media_item_id = CASE WHEN fe.item_id ~* ${UUID_SQL_PATTERN} THEN fe.item_id::uuid END
                    AND ss.stage_id = ${stageId}
                    AND fe.occurred_at < ss.retry_budget_started_at
              )
          ))
        GROUP BY plugin_id, item_id
    `;
    const map = new Map<string, FailureAggregateRow>();
    for (const row of rows) {
        map.set(row.item_id, row);
    }
    return map;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResolvedTitleRow {
    lookup_id: string;
    title: string | null;
    media_type: string;
    season_number: number | null;
    episode_number: number | null;
    series_title: string | null;
    artist_title: string | null;
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/**
 * Builds the same "Series · S01E04" / "Artist · Track" convention already
 * used for media headlines elsewhere in the admin UI (e.g.
 * `formatTrainHeadline` in `ingest-map.constants.ts`), from a row carrying
 * ancestry titles resolved by `media_type` rather than fixed depth — the
 * same robustness `admin-media.queries.ts` relies on, since an episode can
 * be parented directly to its series instead of via a season.
 */
function formatResolvedTitle(row: ResolvedTitleRow): string {
    const title = row.title ?? 'Untitled';
    if (row.media_type === 'episode') {
        const s = row.season_number;
        const e = row.episode_number;
        if (row.series_title && s != null && e != null) {
            return `${row.series_title} · S${pad2(s)}E${pad2(e)}`;
        }
        if (row.series_title) return `${row.series_title} · ${title}`;
        if (s != null && e != null) return `S${pad2(s)}E${pad2(e)} — ${title}`;
        return title;
    }
    if (row.media_type === 'track') {
        return row.artist_title ? `${row.artist_title} · ${title}` : title;
    }
    return title;
}

/**
 * Batch-resolve `plugin_failure_events.item_id` values to human-readable
 * titles for the admin failures list (Phase G). `item_id` is a plugin-chosen
 * key, not always a bare `media_items.id`:
 *
 * - Most plugins (artist-enrichment, album-enrichment, music-analysis,
 *   lumastra-intro-analyzer) key it directly on a `media_items.id`.
 * - `media-probe` keys it on `media_files.id` (the file, not the catalog
 *   item) — resolved via `media_file_items`.
 * - `trickplay-params` keys it on a composite `mediaItemId|fileId` string —
 *   the part before `|` is used as the lookup candidate.
 *
 * Non-UUID-shaped ids (any future plugin using its own key scheme) are left
 * unresolved rather than sent to Postgres, so one odd id can't 500 the whole
 * page. Returns a Map from the ORIGINAL `item_id` (not the lookup candidate)
 * to its resolved title; ids that could not be resolved (item deleted,
 * unrecognized shape) are simply absent — callers fall back to the raw id.
 *
 * `access` is REQUIRED (C2, 2026-09-18 fix-plan-4 Task 2). Both queries below
 * used to select `title`/`media_type`/`season_number`/`episode_number` (and
 * parent series/artist titles) with no library-group or age predicate at
 * all — a title is exactly the age-bearing, library-bearing metadata the
 * access boundary exists to withhold, so an item id from a task the caller
 * triggered but whose title lives in a library group (or above the age
 * ceiling) they are denied was resolved anyway. The caller must pass the
 * REAL boundary for the current request (see
 * `utils/scope-gated-access-boundary.ts`) — there is no permissive default.
 */
export async function getFailureItemTitles(
    sql: postgres.Sql,
    itemIds: string[],
    access: MediaAccessBoundary,
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (itemIds.length === 0) return result;
    if (deniesEverything(access)) return result;

    const candidates = new Map<string, string>(); // lookup uuid -> original item_id
    for (const itemId of itemIds) {
        const lookupId = itemId.includes('|') ? itemId.split('|', 1)[0] : itemId;
        if (UUID_RE.test(lookupId)) candidates.set(lookupId, itemId);
    }
    if (candidates.size === 0) return result;

    const lookupIds = [...candidates.keys()];

    // Access-scoped via buildLibraryAccessFilter/buildAgeRatingFilter below
    // (C2 fix, 2026-09-18 fix-plan-4 Task 2) — NOT "admin-only" (the prior
    // comment here claimed the caller was scope-gated on `tasks:read` and
    // therefore needed no predicate of its own; `tasks:read` was auto-granted
    // to every non-admin session at the time, so that claim was false at
    // HEAD). Same defence-in-depth reasoning as `buildRateQueue`: the route
    // ALSO now requires `tasks:admin` (belt-and-braces, same task), but the
    // query does not rely on that alone.
    const direct = await sql<ResolvedTitleRow[]>`
        SELECT
            mi.id::text AS lookup_id,
            mi.title,
            mi.media_type,
            mi.season_number,
            mi.episode_number,
            CASE
                WHEN gp.media_type = 'tv' THEN gp.title
                WHEN p.media_type  = 'tv' THEN p.title
            END AS series_title,
            CASE
                WHEN gp.media_type = 'artist' THEN gp.title
                WHEN p.media_type  = 'artist' THEN p.title
            END AS artist_title
        FROM media_items mi
        -- p/gp (series_title/artist_title above) are UNPREDICATED --
        -- buildLibraryAccessFilter/buildAgeRatingFilter below apply to mi
        -- only, not to the parent/grandparent this joins in. Safe ONLY
        -- because the sole caller (defs/tasks/[taskId]/failures.ts) is gated
        -- tasks:admin, whose boundary is always 'all' -- an admin sees
        -- every title regardless. A future non-admin caller of this
        -- function MUST NOT inherit this silently: either predicate p/gp
        -- too, or keep the caller admin-only (final fix wave, item 5,
        -- 2026-09-22).
        LEFT JOIN media_items p  ON p.id  = mi.parent_id
        LEFT JOIN media_items gp ON gp.id = p.parent_id
        WHERE mi.id = ANY(${lookupIds}::uuid[])
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
    `;
    const resolvedLookupIds = new Set<string>();
    for (const row of direct) {
        const itemId = candidates.get(row.lookup_id);
        if (!itemId) continue;
        result.set(itemId, formatResolvedTitle(row));
        resolvedLookupIds.add(row.lookup_id);
    }

    const remaining = lookupIds.filter((id) => !resolvedLookupIds.has(id));
    if (remaining.length > 0) {
        // Fallback: media-probe records failures against media_files.id, not
        // a catalog item. Resolve via the file's linked media item(s) — a
        // file can link to more than one item (e.g. a multi-episode file),
        // DISTINCT ON picks one deterministically rather than fanning out.
        // Access-scoped via buildLibraryAccessFilter/buildAgeRatingFilter
        // below — see the `direct` query above for why the previous
        // "admin-only, enforced at the route" comment here was false at HEAD.
        const viaFile = await sql<ResolvedTitleRow[]>`
            SELECT DISTINCT ON (mf.id)
                mf.id::text AS lookup_id,
                mi.title,
                mi.media_type,
                mi.season_number,
                mi.episode_number,
                CASE
                    WHEN gp.media_type = 'tv' THEN gp.title
                    WHEN p.media_type  = 'tv' THEN p.title
                END AS series_title,
                CASE
                    WHEN gp.media_type = 'artist' THEN gp.title
                    WHEN p.media_type  = 'artist' THEN p.title
                END AS artist_title
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            -- Same unpredicated p/gp as the direct query above -- see that
            -- comment. Safe only because the sole caller is tasks:admin-
            -- gated (final fix wave, item 5, 2026-09-22).
            LEFT JOIN media_items p  ON p.id  = mi.parent_id
            LEFT JOIN media_items gp ON gp.id = p.parent_id
            WHERE mf.id = ANY(${remaining}::uuid[])
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY mf.id, mi.id
        `;
        for (const row of viaFile) {
            const itemId = candidates.get(row.lookup_id);
            if (itemId) result.set(itemId, formatResolvedTitle(row));
        }

        // A file with no linked media item has no title to find — which is
        // exactly the population this panel is full of, since media-probe fails
        // on files that never made it into the catalogue. Falling through would
        // print a bare UUID, and "never show the operator a raw id" is the whole
        // point of this function. The filename is what they'd recognise and what
        // they'd need to go look at the file, so use it.
        const stillUnresolved = remaining.filter((id) => {
            const itemId = candidates.get(id);
            return itemId !== undefined && !result.has(itemId);
        });
        if (stillUnresolved.length > 0) {
            // No access-gate directive needed here: this query touches only
            // `media_files`, never `media_items`, so the rule does not fire.
            const byPath = await sql<{ lookup_id: string; file_path: string }[]>`
                SELECT mf.id::text AS lookup_id, mf.file_path
                  FROM media_files mf
                 WHERE mf.id = ANY(${stillUnresolved}::uuid[])
            `;
            for (const row of byPath) {
                const itemId = candidates.get(row.lookup_id);
                if (!itemId || !row.file_path) continue;
                const base = row.file_path.split('/').pop() || row.file_path;
                result.set(itemId, base);
            }
        }
    }

    return result;
}

/** One plugin failure, trimmed to what a diagnostics bundle needs. */
export interface RecentPluginFailureRow {
    plugin_id: string;
    reason: string | null;
    occurred_at: Date;
}

/** Unresolved plugin-reported failures for one plugin. */
export interface PluginFailureCountRow {
    pluginId: string;
    count: number;
}

const UUID_SQL_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * `AND ...` fragment, for a `plugin_failure_events` row aliased `alias`, that
 * is TRUE only while the failure still matters. Rows stay "unresolved" forever
 * unless someone retries them, and on prod most of the attention-board count
 * was stale (2026-10-21): album-enrichment 26 (19 fileless + 7 completed after
 * the failure), media-probe 32 (9 whose file row is gone), music-analysis 1 and
 * sonic-embedding-backfill 1 (fileless). The following cases drop out:
 *
 * - the subject is gone: a uuid-shaped item_id that matches neither a
 *   media_items nor a media_files row (a deleted file). Non-uuid keys (other
 *   plugins key by their own ids) are never treated as gone. item_id is cast to
 *   uuid inside a CASE, which is the one construct Postgres evaluates in order,
 *   so a non-uuid key yields NULL instead of a cast error, and the lookups use
 *   the primary keys (a `mi.id::text = item_id` compare would scan media_items
 *   once per failure row).
 * - the subject is a fileless media item (has_files = false): it cannot be
 *   processed and the stage marks it ineligible, so the failure is noise.
 * - the item completed the stage after the failure: a later success supersedes
 *   the failure. Stage defaults to the plugin id, as the stage rows are keyed.
 *
 * - a media-probe duration finding has a current accepted review. A changed
 *   source, finding, stream or assessment (or a revoked review) reopens it.
 *
 * Use in every place that counts or lists unresolved failures, so the tile
 * count and the Failures list stay in agreement.
 */
export function liveFailureSubjectPredicate(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const f = sql(alias);
    const subjectId = sql`(CASE WHEN ${f}.item_id ~* ${UUID_SQL_PATTERN} THEN ${f}.item_id::uuid END)`;
    return sql`
        ${currentAnalyzerFailurePredicate(sql, alias)}
        AND NOT (${f}.plugin_id = 'media-probe' AND ${reviewedDurationFailureSql(sql, sql`${f}.item_id`, sql`${f}.reason`)})
        AND NOT (
            ${f}.item_id ~* ${UUID_SQL_PATTERN}
            AND NOT EXISTS (SELECT 1 FROM media_items mi WHERE mi.id = ${subjectId})
            AND NOT EXISTS (SELECT 1 FROM media_files mf WHERE mf.id = ${subjectId})
        )
        AND NOT EXISTS (
            SELECT 1 FROM media_items mi
             WHERE mi.id = ${subjectId}
               AND mi.has_files = false
        )
        AND NOT EXISTS (
            SELECT 1 FROM media_item_stage_state s
             WHERE s.media_item_id = ${subjectId}
               AND s.stage_id = COALESCE(${f}.stage_id, ${f}.plugin_id)
               AND s.status = 'completed'
               AND s.completed_at > ${f}.occurred_at
               AND (${f}.plugin_id <> 'lumastra-intro-analyzer' OR EXISTS (
                   SELECT 1 FROM media_segment_analysis_passes pass
                   WHERE pass.media_id = s.media_item_id AND pass.stage_id = s.stage_id
                     AND pass.input_identity = ${f}.input_identity
                     AND pass.completed_at > ${f}.occurred_at
               ))
        )
    `;
}

/**
 * Unresolved plugin-reported failures, grouped by plugin.
 *
 * These are a DIFFERENT population from the dead-letter adapter's, which
 * counts `media_item_stage_state.status = 'failed_permanent'`. A plugin
 * reports through `ctx.reportFailure` when it cannot process one item, and
 * that need not fail the whole stage — measured on preprod: 11 unresolved
 * plugin failures against 0 failed_permanent stage rows, with no overlap at
 * all. So without this they are reachable only by opening each task's Failures
 * tab one at a time, and invisible on the board.
 *
 * Unresolved only, matching every other read in this module: a failure the
 * operator has already dealt with must not keep asking for attention.
 *
 * COUNT(DISTINCT item_id), NOT COUNT(*). The table is append-only and one
 * periodic task writes one row per item per attempt, so rows and items diverge
 * without bound — prod 2026-09-11 read 1,179 unresolved rows for
 * `sonic-embedding-backfill` against exactly FOUR distinct items, two corrupt
 * mp3s re-attempted on every two-hourly sweep since August. The alert this
 * feeds says "could not process {count} items", so counting rows made the
 * board state a number that was wrong by nearly three orders of magnitude, and
 * wrong in the alarming direction: it read as a library-wide outage when two
 * files were broken.
 */
export async function countUnresolvedFailuresByPlugin(
    sql: postgres.Sql,
): Promise<PluginFailureCountRow[]> {
    const rows = await sql<{ plugin_id: string; cnt: number }[]>`
        SELECT f.plugin_id, COUNT(DISTINCT f.item_id)::int AS cnt
          FROM plugin_failure_events f
         WHERE f.resolved_at IS NULL
           ${liveFailureSubjectPredicate(sql, 'f')}
           -- Terminal stage failures already have one operational/identity alert.
           AND NOT EXISTS (
               SELECT 1 FROM media_item_stage_state ss
               WHERE ss.media_item_id = CASE WHEN f.item_id ~* ${UUID_SQL_PATTERN} THEN f.item_id::uuid END
                 AND ss.stage_id = COALESCE(f.stage_id, f.plugin_id)
                 AND ss.status = 'failed_permanent'
           )
         GROUP BY f.plugin_id
         ORDER BY cnt DESC, plugin_id
    `;
    return rows.map((r) => ({ pluginId: r.plugin_id, count: r.cnt }));
}

/**
 * The most recent failures ACROSS ALL plugins, newest first — the plugin leg of
 * the instance diagnostics bundle.
 *
 * Every other read in this module is scoped to one `(plugin_id, item_id)` pair;
 * the bundle needs an instance-wide view, so this is its own query rather than a
 * loop over plugins. `item_id` is deliberately NOT selected: it is a library
 * item key, which is identity a public issue does not need.
 *
 * Unresolved rows only (`resolved_at IS NULL`) — matching `listItemFailureRows`
 * in `failure-patterns.queries.ts` — so an already-fixed failure does not pad
 * out a bug report with noise.
 */
export async function listRecentPluginFailures(
    sql: postgres.Sql,
    limit: number,
): Promise<RecentPluginFailureRow[]> {
    return sql<RecentPluginFailureRow[]>`
        SELECT plugin_id, reason, occurred_at
        FROM plugin_failure_events f
        WHERE resolved_at IS NULL
          ${currentAnalyzerFailurePredicate(sql, 'f')}
        ORDER BY occurred_at DESC
        LIMIT ${limit}
    `;
}

/**
 * The newest event id for a `(plugin_id, item_id)` pair, or `null` when the
 * pair has never failed. Backs the existence check in
 * POST /tasks/{id}/failures/{id}/retry, which 404s rather than handing an
 * arbitrary item key to a plugin's `failures.retry` hook.
 *
 * Deliberately NOT filtered on `resolved_at IS NULL`: retrying an item that
 * was already resolved is a no-op at worst, and the alternative — a 404 on a
 * row the operator can still see in a stale panel — reads as data loss.
 *
 * `id` is BIGINT and this app's global type parser (connection.ts) returns
 * bigint columns as JS `number`, so it is cast to text here rather than
 * silently narrowing through 2^53 at the call site.
 */
export async function findLatestFailureEventId(
    sql: postgres.Sql,
    pluginId: string,
    itemId: string,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id::text AS id
        FROM plugin_failure_events
        WHERE plugin_id = ${pluginId}
          AND item_id = ${itemId}
        ORDER BY occurred_at DESC
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Stamp `resolved_at` on every still-unresolved event for a
 * `(plugin_id, item_id)` pair; returns how many rows were stamped.
 *
 * This is the ONLY thing in the codebase that ever resolves a row. The table
 * is append-only, so an item that fails on every periodic run accumulates one
 * unresolved row per attempt, and `listItemFailureRows` filters on exactly
 * this column — which is why a successful retry has to clear the whole backlog
 * for the item, not just its newest event.
 *
 * Pass `stageId` when the task tracks several stages independently: only that
 * stage's rows are stamped, plus legacy rows with no stage (written before
 * stage attribution existed, so they can only be matched by task — the same
 * rule migration 16.246.0 applied). Without it, a visual success on an intro
 * analyzer episode would silence a still-real chromaprint failure.
 */
export async function markFailureEventsResolved(
    sql: postgres.Sql | postgres.TransactionSql,
    pluginId: string,
    itemId: string,
    stageId: string | null = null,
    inputIdentity?: string,
): Promise<number> {
    const result = await sql`
        UPDATE plugin_failure_events AS fe
        SET resolved_at = now()
        WHERE plugin_id = ${pluginId}
          AND item_id = ${itemId}
          AND resolved_at IS NULL
          AND (${pluginId} <> 'lumastra-intro-analyzer' OR (input_identity = ${inputIdentity ?? null} AND ${analyzerFailureVersionSql(sql, 'fe')} AND COALESCE(analysis_stage_id,stage_id)=${stageId}))
          ${stageId !== null ? sql`AND (stage_id = ${stageId} OR stage_id IS NULL)` : sql``}
    `;
    return result.count;
}
