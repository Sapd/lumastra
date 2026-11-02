// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ingest Map Query Module
 *
 * Returns items that were recently added OR have in-flight stage rows,
 * with all their stage state rows joined. Used by the Metro Map page.
 *
 * ## Access gating (audited 2026-07-30)
 *
 * Every query here is admin-only, so the per-row gates that
 * `callback-safety/no-unscoped-media-items` looks for are intentionally
 * absent. The consumers, and the gate each one applies:
 *
 *   - `defs/admin/ingest/{map,diagnostics,stage-activity}` — `auth: { kind: 'admin' }`
 *   - `services/attention/attention-service` — itself reached only from
 *     `defs/admin/attention/*` and, via `admin-status-payload.service`,
 *     from `defs/admin/ops/status`; all `auth: { kind: 'admin' }`
 *   - page loaders under `/src/routes/admin/`
 *
 * Admin scope grants library-wide visibility by policy, which is why these
 * reads are unscoped rather than merely un-gated.
 *
 * Treat that list as the consumers audited on the date above, NOT as a
 * closed set — re-check it before adding a caller. Until 2026-07-30 this
 * whole file passed the lint rule because the word `requireAdmin` appeared
 * in this comment; prose no longer counts as a gate, so each site now
 * carries its own line-scoped disable pointing back here.
 */

import type postgres from 'postgres';
import type { StageErrorDetail, StageStatus } from '$lib/types/pipeline.js';
import type { StuckItemReason } from '$lib/schemas/ingest-map.js';
import { SUMMARY_BUCKETS } from '$lib/components/admin/coverage/ingest-map.constants.js';
import { pgTextTimestamp } from './builders/keyset-cursor.builder.js';
import { buildLibraryGroupRootFilter } from './builders/library-group.builder.js';

export interface IngestMapStageRow {
    stage_id: string;
    status: StageStatus;
    processing_version: number;
    attempt: number;
    last_error: StageErrorDetail | null;
    updated_at: Date;
    /**
     * Why the stage row is in a skipped_* status (e.g.
     * 'predicate-false', 'ineligible-by-legacy-filter'). Always null
     * for non-skipped rows. Exposed so the train tooltip can explain
     * the difference between "parked deliberately" and "stuck".
     */
    skipped_reason: string | null;
    /**
     * When a failed_transient or skipped_transient row becomes eligible
     * for retry. Null otherwise. Renders as a "retry in Nm" countdown.
     */
    next_eligible_at: Date | null;
}

export interface IngestMapItem {
    media_item_id: string;
    media_type: string;
    title: string;
    created_at: Date;
    /**
     * `mi.created_at::text` — the same instant as `created_at`, rendered by
     * Postgres as a raw string rather than parsed into a JS `Date` by
     * postgres.js's timestamptz type parser. `Date#toISOString()` only carries
     * millisecond precision, while Postgres timestamps carry microseconds —
     * round-tripping a keyset cursor through a `Date` can silently skip a row
     * created in the same microsecond-collapsed millisecond as the page
     * boundary (a real risk here: bulk scanner inserts share one `now()` per
     * transaction). Keep this a bare string, never widen it to `string | Date`.
     */
    created_at_cursor?: string;
    /**
     * For episodes and seasons: the parent series' title. Episodes walk
     * parent_id twice (episode → season → series); seasons walk it once
     * (season → series). Null for movies, music, standalone series rows,
     * and anything else with no parent chain. Lets the UI render
     * "Haus des Geldes · S01E22 — Folge 22" instead of just "Folge 22",
     * and "Haus des Geldes · Season 1" instead of just "Season 1".
     */
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    stages: IngestMapStageRow[];
}

/** Decoded keyset cursor for `loadIngestMap` — mirrors the `(created_at, id) DESC` order. */
export interface IngestMapCursor {
    createdAt: string;
    id: string;
}

export interface IngestMapOptions {
    windowSinceMs?: number;
    mediaTypes?: ReadonlyArray<string>;
    limit?: number;
    /**
     * Keyset cursor — when present, returns rows strictly after this
     * `(created_at, id)` position in `(created_at DESC, id DESC)` order.
     * `media_items.created_at` is `NOT NULL`, so no null-group handling is
     * needed. Additive/opt-in: omitted, behavior is unchanged.
     */
    cursor?: IngestMapCursor;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 500;

export async function loadIngestMap(
    sql: postgres.Sql,
    opts: IngestMapOptions = {},
): Promise<IngestMapItem[]> {
    const windowSecs = (opts.windowSinceMs ?? DEFAULT_WINDOW_MS) / 1000;
    const mediaTypes = opts.mediaTypes && opts.mediaTypes.length > 0 ? [...opts.mediaTypes] : null;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    // pgTextTimestamp() pins this parameter's wire OID to TEXT (25) — see
    // `keyset-cursor.builder.ts`. Left as a bare `${...}::timestamptz`,
    // postgres.js would infer timestamptz (1184) from the cast and serialize
    // the value via `new Date(x).toISOString()`, truncating the
    // microsecond-precision `created_at_cursor` string back to milliseconds.
    // Reused verbatim in both UNION branches below (same `mi` alias).
    const cursorPredicate = opts.cursor
        ? sql`AND (mi.created_at, mi.id) < (${pgTextTimestamp(sql, opts.cursor.createdAt)}::timestamptz, ${opts.cursor.id}::uuid)`
        : sql``;

    interface RawRow {
        media_item_id: string;
        media_type: string;
        title: string;
        created_at: Date;
        created_at_cursor?: string;
        series_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        stages: IngestMapStageRow[];
    }

    // For episodes, walk parent_id twice (episode → season → series) so the
    // UI can render "Haus des Geldes · S01E22 — Folge 22" instead of the
    // ambiguous "Folge 22". For seasons, walk it once (season → series) so
    // e.g. "Season 1" — a title shared by hundreds of shows — also renders
    // with its series prefix. Movies + tv + music rows have no useful
    // parent chain; series_title is NULL for those.
    //
    // Performance: the previous shape `WHERE (created_at > t OR EXISTS(...))`
    // forced a Seq Scan on media_items because the planner can't combine
    // an OR-of-an-EXISTS into an index strategy. On preprod that meant
    // 412 k Seq Scan rows + 442 k correlated EXISTS probes = 4.3 s. The
    // UNION below lets the planner pick a strategy per branch:
    //   1. Recent items use idx_media_items_created_at_desc directly.
    //   2. In-flight items use idx_stage_state_in_flight
    //      (16.17.0) for an Index-Only Scan of distinct media_item_ids,
    //      then a PK join to media_items.
    // Deduplication is handled by UNION (set-semantics) so an item that
    // appears in both branches collapses to one row.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: loadIngestMap (this function's own name — corrected 2026-09-22, the prior comment named a since-renamed `loadIngestMapItems`).
    const rows = await sql<RawRow[]>`
        WITH candidate_items AS (
          (
            SELECT mi.id, mi.media_type, mi.title, mi.created_at,
                   mi.parent_id, mi.season_number, mi.episode_number
              FROM media_items mi
             WHERE mi.created_at > now() - make_interval(secs => ${windowSecs})
               AND (${mediaTypes}::text[] IS NULL OR mi.media_type = ANY(${mediaTypes}::text[]))
               AND COALESCE(mi.is_dismissed, false) = false
               ${cursorPredicate}
             ORDER BY mi.created_at DESC, mi.id DESC
             LIMIT ${limit}
          )
          UNION
          (
            SELECT mi.id, mi.media_type, mi.title, mi.created_at,
                   mi.parent_id, mi.season_number, mi.episode_number
              FROM media_items mi
              JOIN (
                  SELECT DISTINCT media_item_id
                    FROM media_item_stage_state
                   WHERE status IN ('running', 'pending', 'failed_transient', 'failed_permanent', 'obsolete')
              ) active ON active.media_item_id = mi.id
             WHERE (${mediaTypes}::text[] IS NULL OR mi.media_type = ANY(${mediaTypes}::text[]))
               -- Dismissed items have no active pipeline (afterDismissed
               -- deletes their stage rows). Including them surfaces
               -- "stuck at scan" trains for items the user already
               -- removed — noise that hides real pipeline work.
               AND COALESCE(mi.is_dismissed, false) = false
               ${cursorPredicate}
             ORDER BY mi.created_at DESC, mi.id DESC
             LIMIT ${limit}
          )
        ),
        candidate_items_capped AS (
            SELECT * FROM candidate_items
             ORDER BY created_at DESC, id DESC
             LIMIT ${limit}
        )
        SELECT ci.id AS media_item_id,
               ci.media_type,
               ci.title,
               ci.created_at,
               ci.created_at::text AS created_at_cursor,
               series.title AS series_title,
               ci.season_number,
               ci.episode_number,
               COALESCE(
                   jsonb_agg(
                       jsonb_build_object(
                           'stage_id', s.stage_id,
                           'status', s.status,
                           'processing_version', s.processing_version,
                           'attempt', s.attempt,
                           'last_error', s.last_error,
                           'updated_at', s.updated_at,
                           'skipped_reason', s.skipped_reason,
                           'next_eligible_at', s.next_eligible_at
                       )
                   ) FILTER (WHERE s.stage_id IS NOT NULL),
                   '[]'::jsonb
               ) AS stages
          FROM candidate_items_capped ci
          LEFT JOIN media_item_stage_state s ON s.media_item_id = ci.id
          LEFT JOIN media_items season ON season.id = ci.parent_id AND ci.media_type = 'episode'
          LEFT JOIN media_items series ON series.id = COALESCE(
                   season.parent_id,
                   CASE WHEN ci.media_type = 'season' THEN ci.parent_id END
               )
         GROUP BY ci.id, ci.media_type, ci.title, ci.created_at,
                  series.title, ci.season_number, ci.episode_number
         ORDER BY ci.created_at DESC, ci.id DESC
    `;

    return rows;
}

export interface SummaryBucketCount {
    /** Matches SummaryBucketDef.id from ingest-map.constants. */
    bucket_id: string;
    /** Number of media_items in this bucket (no time-window filter applied). */
    total: number;
    /** Number created within the active window — drives the "fresh" badge. */
    recent: number;
}

export interface StageActivityRow {
    stage_id: string;
    /** Wall-clock of the most recent successful completion at this stage. */
    last_completed_at: Date | null;
    /** Completions in the last 5 minutes — the "is this stage alive?" signal. */
    completed_5m: number;
    /** Items currently in `running` status — workers actively processing here. */
    running: number;
    /** failed_transient OR failed_permanent events in the last 1 hour. */
    failed_1h: number;
}

/**
 * Per-stage activity snapshot for the Ingest Map.
 *
 * Answers "is this stage actually progressing or just parked?" — the
 * raw `(489)` count under a station tells you what's queued but nothing
 * about whether anything is moving. The fields here give the front-end:
 *
 *   - `last_completed_at`     → "12s ago" caption, or "—" when never
 *   - `completed_5m`          → throughput in the recent past
 *   - `running`               → live worker activity ("3 running")
 *   - `failed_1h`             → warning badge when recent attempts failed
 *
 * One row per stage_id present in `media_item_stage_state`. Stages with
 * no rows at all are simply absent from the result; the UI treats those
 * as "no data" (— captions).
 */
/**
 * The slow, anxiety-generating per-item stages a fresh admin watches for "is my
 * library done yet?". Each has rich per-item `media_item_stage_state` rows so the
 * progress hero can show "X of Y, ~ETA". Friendly labels + denomination units are
 * a UI concern (the component maps these ids to "Trickplay previews" etc.).
 */
export const HEADLINE_PROGRESS_STAGE_IDS = [
    'media-probe-a',
    'trickplay-generation',
    // 🔴 The SPLIT stage id. Migration 16.212.0 replaced the single
    // 'lumastra-intro-analyzer' stage with ':visual' + ':acoustic' and nothing
    // writes the legacy id any more — so this bar sat frozen at 19.6% for three
    // days (9,270 of 47,375) while the real stage was at 95.6% and completing
    // episodes that morning. A progress bar keyed to a retired stage does not
    // read as stale, it reads as stuck.
    'lumastra-intro-analyzer:visual',
    'music-analysis',
    'library-embeddings',
] as const;

export interface StageProgressRow {
    stage_id: string;
    /** Rows in a terminal `completed` status. */
    completed: number;
    /**
     * Rows still to do: pending / running / failed_transient / skipped_transient /
     * obsolete. `skipped_transient` is counted here (it retries) so the bar reaches
     * 100% only when there is genuinely nothing left.
     */
    remaining: number;
    /**
     * Rows that don't NEED this stage — `skipped_permanent` (no video track, not an
     * anime series, etc.). Disclosed as a past-tense footnote, NEVER counted in the
     * denominator. Under the unified eligibility contract these are exactly the
     * `'ineligible'` (+ observed-terminal) skips.
     */
    not_applicable: number;
    /** All rows for the stage (completed + remaining + not_applicable). */
    total: number;
    /** Rows in `failed_transient` status — will be retried. */
    failed_transient: number;
    /** Rows in `failed_permanent` status — pipeline gave up; excluded from denominator. */
    failed_permanent: number;
}

/**
 * Per-stage progress denominated in ELIGIBLE items (the load-bearing UX decision).
 *
 * The progress bar a fresh admin sees must read in things they recognise:
 * "11,033 of ~11,210 done" — NOT "23% complete" when 77% of the rows are
 * `skipped_permanent` because the items have no video track. So the denominator is
 * `completed + remaining` (= total − not_applicable); `not_applicable`
 * (`skipped_permanent`) is disclosed as a footnote, never counted as remaining work
 * or failure. One row per requested stage_id present in the table.
 */
export async function loadStageProgressByIds(
    sql: postgres.Sql,
    stageIds: readonly string[],
): Promise<StageProgressRow[]> {
    if (stageIds.length === 0) return [];
    return sql<StageProgressRow[]>`
        SELECT stage_id,
               COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
               COUNT(*) FILTER (
                   WHERE status IN ('pending', 'running', 'failed_transient', 'skipped_transient', 'obsolete')
               )::int AS remaining,
               COUNT(*) FILTER (WHERE status = 'skipped_permanent')::int AS not_applicable,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'failed_transient')::int AS failed_transient,
               COUNT(*) FILTER (WHERE status = 'failed_permanent')::int AS failed_permanent
          FROM media_item_stage_state
         WHERE stage_id = ANY(${stageIds as string[]})
         GROUP BY stage_id
    `;
}

export async function loadStageActivity(sql: postgres.Sql): Promise<StageActivityRow[]> {
    return sql<StageActivityRow[]>`
        SELECT stage_id,
               MAX(completed_at) FILTER (WHERE status = 'completed') AS last_completed_at,
               COUNT(*) FILTER (
                   WHERE status = 'completed'
                     AND completed_at > now() - interval '5 minutes'
               )::int AS completed_5m,
               COUNT(*) FILTER (WHERE status = 'running')::int AS running,
               COUNT(*) FILTER (
                   WHERE status IN ('failed_transient', 'failed_permanent')
                     AND updated_at > now() - interval '1 hour'
               )::int AS failed_1h
          FROM media_item_stage_state
         GROUP BY stage_id
    `;
}

/**
 * Counts items in the non-pipeline summary buckets (Live TV, Other media).
 *
 * Each bucket has zero applicable pipeline stages, so they can't be shown
 * as stations + trains on the metro lines. The map renders them as chips
 * with a total count + a "fresh" badge for items added inside the window.
 *
 * `total` is unbounded by time so the chip surfaces the steady-state pool
 * size (e.g. "1,368 Live TV channels"). `recent` is the window-scoped
 * delta so a freshly-added home video is visible to the admin.
 */
export async function loadIngestMapSummaryBuckets(
    sql: postgres.Sql,
    opts: { windowSinceMs: number },
): Promise<SummaryBucketCount[]> {
    const windowSecs = opts.windowSinceMs / 1000;
    const results: SummaryBucketCount[] = [];
    for (const bucket of SUMMARY_BUCKETS) {
        const types = [...bucket.mediaTypes];
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: summary bucket counts.
        const [row] = await sql<Array<{ total: string; recent: string }>>`
            SELECT count(*)::text AS total,
                   count(*) FILTER (
                       WHERE mi.created_at > now() - make_interval(secs => ${windowSecs})
                   )::text AS recent
              FROM media_items mi
             WHERE mi.media_type = ANY(${types}::text[])
        `;
        results.push({
            bucket_id: bucket.id,
            total: row ? Number(row.total) : 0,
            recent: row ? Number(row.recent) : 0,
        });
    }
    return results;
}

// ── Pipeline summary / health strip ───────────────────────────────────

export interface IngestPipelineSummary {
    /** Total items with any non-terminal stage row right now. */
    inFlight: number;
    /** failed_transient + failed_permanent rows updated in last 1 h. */
    failedLastHour: number;
    /** Items with at least one failed_permanent row (= dead letter). */
    deadLetterItems: number;
    /** stage rows currently in `running` status across all stages. */
    running: number;
    /**
     * Oldest pending stage row age, in seconds. Useful for "anything stuck
     * for hours?" at-a-glance — large values signal a wedged stage.
     */
    oldestPendingAgeSec: number | null;
    /** Items whose most-active stage row has attempt ≥ 3. */
    degradedItems: number;
    /**
     * Subset of `deadLetterItems` whose failure was explicitly non-retryable
     * (a data/identity problem a retry can't fix — e.g. a dead TMDB id),
     * on a non-dismissed item. Deliberately the SAME predicate as
     * `countReidentifyItems` (below) so this number can never disagree with
     * what Library → Fix matches (broken-match view) and the attention
     * system's `needs-reidentification` item show — admin IA redesign
     * spec §5 "one source of truth". The pipeline's own `deadLetterItems`
     * stays broader on purpose: it also covers technically-retryable
     * stages that simply exhausted their retry budget (not an identity
     * problem, e.g. a corrupt trickplay source file), which never belongs
     * on the Fix-matches workbench.
     */
    reidentifyItems: number;
}

/**
 * Single-row global health summary for the page header strip. Cheap
 * because each sub-count is a partial-indexed aggregation against
 * `media_item_stage_state` — the existing
 * `idx_stage_state_sweep` + `idx_stage_state_activity_failed` cover
 * most of the work.
 */
export async function loadIngestPipelineSummary(sql: postgres.Sql): Promise<IngestPipelineSummary> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: loadIngestPipelineSummary.
    const [row] = await sql<
        Array<{
            in_flight: string;
            failed_last_hour: string;
            dead_letter_items: string;
            running: string;
            oldest_pending_age_sec: string | null;
            degraded_items: string;
            reidentify_items: string;
        }>
    >`
        -- Dismissed items are left out everywhere, as the dead-letter list and
        -- the re-identify queue already do, so a header count never exceeds the
        -- list it summarises. Anti-join: dismissals are rare and media_items.id
        -- is the primary key; NOT MATERIALIZED lets each count keep its partial index.
        WITH visible AS NOT MATERIALIZED (
            SELECT s.media_item_id, s.status, s.attempt, s.updated_at
              FROM media_item_stage_state s
             WHERE NOT EXISTS (
                     SELECT 1 FROM media_items dm
                      WHERE dm.id = s.media_item_id AND dm.is_dismissed IS TRUE
                   )
        ),
        active AS (
            SELECT DISTINCT media_item_id
              FROM visible
             WHERE status IN ('running','pending','failed_transient','failed_permanent','obsolete')
        ),
        dead AS (
            SELECT DISTINCT media_item_id
              FROM visible
             WHERE status = 'failed_permanent'
        ),
        degraded AS (
            SELECT DISTINCT media_item_id
              FROM visible
             WHERE attempt >= 3
               AND status IN ('running','pending','failed_transient')
        ),
        oldest_pending AS (
            SELECT extract(epoch FROM now() - min(updated_at))::int AS age_sec
              FROM visible
             WHERE status = 'pending'
        ),
        reidentify AS (
            -- Same predicate as countReidentifyItems (one source of truth).
            SELECT DISTINCT s.media_item_id
              FROM media_item_stage_state s
              JOIN media_items mi ON mi.id = s.media_item_id
              ${seriesJoins(sql)}
             WHERE ${reidentifyPredicate(sql, {})}
        )
        SELECT
            (SELECT count(*) FROM active)::text AS in_flight,
            (SELECT count(*) FROM visible
              WHERE status IN ('failed_transient','failed_permanent')
                AND updated_at > now() - interval '1 hour')::text AS failed_last_hour,
            (SELECT count(*) FROM dead)::text AS dead_letter_items,
            (SELECT count(*) FROM visible WHERE status = 'running')::text AS running,
            (SELECT age_sec FROM oldest_pending)::text AS oldest_pending_age_sec,
            (SELECT count(*) FROM degraded)::text AS degraded_items,
            (SELECT count(*) FROM reidentify)::text AS reidentify_items
    `;
    return {
        inFlight: row ? Number(row.in_flight) : 0,
        failedLastHour: row ? Number(row.failed_last_hour) : 0,
        deadLetterItems: row ? Number(row.dead_letter_items) : 0,
        running: row ? Number(row.running) : 0,
        oldestPendingAgeSec:
            row?.oldest_pending_age_sec === null || row?.oldest_pending_age_sec === undefined
                ? null
                : Number(row.oldest_pending_age_sec),
        degradedItems: row ? Number(row.degraded_items) : 0,
        reidentifyItems: row ? Number(row.reidentify_items) : 0,
    };
}

// ── Stuck-items panel ────────────────────────────────────────────────

export interface StuckItemRow {
    media_item_id: string;
    title: string;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    media_type: string;
    stage_id: string;
    status: StageStatus;
    /** The highest-priority SQL criterion that selected this row. */
    reason: StuckItemReason;
    attempt: number;
    last_error: StageErrorDetail | null;
    /** Last stage-state update for this row; this is not an execution timestamp. */
    stuck_since: Date;
    /** Seconds since the last stage-state update. */
    stuck_age_sec: number;
}

/**
 * Items selected by the prioritized diagnostics criteria: recorded running
 * state without an update for >15 minutes, recorded attempts >=3 for
 * running/pending/failed_transient rows, or pending >30 minutes when the
 * stage has neither a recent completion nor a future unpaused schedule.
 *
 * Sorted by stuck-age desc so the worst-offenders surface first.
 */
export async function loadStuckItems(sql: postgres.Sql, limit = 20): Promise<StuckItemRow[]> {
    // Perf: the previous shape materialized the full stuck set (up to ~1.2 M
    // pending rows older than 2h) and applied
    // `ROW_NUMBER() OVER (PARTITION BY media_item_id)` across all of them
    // just to drop down to LIMIT 20. Under load this ballooned from a
    // 1.3 s isolated cost to 26 s when the page-server's other 7 queries
    // were contending for the same Postgres parallel-worker pool.
    //
    // The rewrite bounds each WHERE-branch separately with its own ORDER
    // BY + LIMIT so each branch can use a partial index
    // (idx_stage_state_stuck_running, idx_stage_state_stuck_pending,
    // idx_stage_state_degraded) for a small targeted scan. We then merge
    // the three at most 100-row sets and run the dedup ROW_NUMBER over
    // ≤ 300 rows — cheap. The bound is 5× the user-facing LIMIT so an
    // item that's stuck in multiple stages still gets its priority-1
    // row chosen.
    const branchCap = Math.max(limit * 5, 100);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: loadStuckItems.
    return sql<StuckItemRow[]>`
        WITH stuck_raw AS (
            -- Branch 1: recorded running state with no update for > 15 min (highest urgency)
            (
                SELECT s.media_item_id, s.stage_id, s.status, s.attempt,
                       s.last_error, s.updated_at, 'running_stale'::text AS reason,
                       1::smallint AS prio
                  FROM media_item_stage_state s
                 WHERE s.status = 'running'
                   AND s.updated_at < now() - interval '15 minutes'
                 ORDER BY s.updated_at ASC
                 LIMIT ${branchCap}
            )
            UNION ALL
            -- Branch 2: attempt >= 3 stuck-retry
            (
                SELECT s.media_item_id, s.stage_id, s.status, s.attempt,
                       s.last_error, s.updated_at, 'attempt_threshold'::text AS reason,
                       2::smallint AS prio
                  FROM media_item_stage_state s
                 WHERE s.attempt >= 3
                   AND s.status IN ('running','pending','failed_transient')
                 ORDER BY s.updated_at ASC
                 LIMIT ${branchCap}
            )
            UNION ALL
            -- Branch 3: pending in a stage whose drain has stalled AND
            -- isn't waiting on an upcoming scheduled run.
            --
            -- Two filters compose here:
            --
            --   a) dormant stages (not in recent_completed): stages with no completion in the
            --      last 30 min. Captures "the handler isn't moving".
            --
            --   b) scheduled_waiting: stages whose handler is registered
            --      in scheduler_state with next_fire_at in the future.
            --      These tasks are scheduled (often daily / weekly —
            --      fribb-anime-sync fires every 7d, integrity-scanner
            --      daily, etc.) so a 30 min dormancy window is the wrong
            --      signal — they're idle by design. Excluding them
            --      stops the dashboard from flagging items pending in
            --      perfectly-healthy queued-on-schedule stages.
            --
            -- The pending row is "stuck" iff its stage is in
            -- (dormant stages MINUS scheduled_waiting).
            --
            -- Per-item-enqueueable stages (lumastra-intro-analyzer,
            -- mdblist-sync, music-popularity, etc.) don't sit in
            -- scheduler_state with future fire times the same way —
            -- their work is driven by stage-sweep, not a recurring
            -- schedule — so they still fall into the dormancy bucket
            -- when their workers genuinely aren't progressing.
            (
                WITH
                -- Perf: this used to be (all distinct stage_ids EXCEPT
                -- recently-completed ones), which seq-scanned the whole
                -- table (about 1.5 M rows, about 110 ms) just to list the
                -- stage_ids. The outer query only ever tests stage_ids of
                -- existing rows, so it is equivalent to exclude the
                -- recently-completed stages directly; that side is a cheap
                -- skip-scan over idx_stage_state_activity_completed.
                recent_completed AS (
                    SELECT DISTINCT stage_id FROM media_item_stage_state
                     WHERE status = 'completed'
                       AND completed_at > now() - interval '30 minutes'
                ),
                scheduled_waiting AS (
                    -- Tasks the scheduler will fire in the future. The
                    -- scheduler_state row's task_id matches the task that
                    -- drives the stage_id of the same name in most builtin
                    -- cases (chapter-sync, fribb-anime-sync,
                    -- mal-anime-id-enrichment, mdblist-sync). Tasks that
                    -- drive a different stage_id (e.g. integrity-scanner
                    -- → integrity-file-present) are covered below.
                    SELECT task_id AS stage_id FROM scheduler_state
                     WHERE next_fire_at > now()
                       AND COALESCE(paused, false) = false
                    UNION
                    -- integrity-scanner is the handler that drives the
                    -- integrity-file-present stage; the scheduler key is
                    -- 'integrity-scanner' but the stage_id is different.
                    SELECT 'integrity-file-present' FROM scheduler_state
                     WHERE task_id = 'integrity-scanner'
                       AND next_fire_at > now()
                       AND COALESCE(paused, false) = false
                    UNION
                    -- lumastra-intro-analyzer's scheduled task drives its
                    -- registered split stage ids (visual and acoustic).
                    -- Those aliases are declared by the native task, while
                    -- scheduler_state stores only its task id.
                    SELECT stage.stage_id
                      FROM scheduler_state sched
                      CROSS JOIN (VALUES
                          ('lumastra-intro-analyzer:visual'),
                          ('lumastra-intro-analyzer:acoustic')
                      ) AS stage(stage_id)
                     WHERE sched.task_id = 'lumastra-intro-analyzer'
                       AND sched.next_fire_at > now()
                       AND COALESCE(sched.paused, false) = false
                )
                SELECT s.media_item_id, s.stage_id, s.status, s.attempt,
                       s.last_error, s.updated_at, 'pending_dormant'::text AS reason,
                       3::smallint AS prio
                  FROM media_item_stage_state s
                 WHERE s.status = 'pending'
                   AND s.updated_at < now() - interval '30 minutes'
                   AND s.stage_id NOT IN (SELECT stage_id FROM recent_completed)
                   AND s.stage_id NOT IN (SELECT stage_id FROM scheduled_waiting)
                 ORDER BY s.updated_at ASC
                 LIMIT ${branchCap}
            )
        ),
        stuck AS (
            SELECT media_item_id,
                   stage_id,
                   status,
                   attempt,
                   last_error,
                   reason,
                   updated_at AS stuck_since,
                   extract(epoch FROM now() - updated_at)::int AS stuck_age_sec,
                   ROW_NUMBER() OVER (
                       PARTITION BY media_item_id
                       ORDER BY prio ASC, updated_at ASC
                   ) AS rn
              FROM stuck_raw
        )
        SELECT s.media_item_id,
               mi.title,
               series.title AS series_title,
               mi.season_number,
               mi.episode_number,
               mi.media_type,
               s.stage_id,
               s.status,
               s.attempt,
               s.reason,
               s.last_error,
               s.stuck_since,
               s.stuck_age_sec
          FROM stuck s
          JOIN media_items mi ON mi.id = s.media_item_id
          LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
          LEFT JOIN media_items series ON series.id = CASE
              WHEN mi.media_type = 'season' THEN mi.parent_id
              WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
          END
         WHERE s.rn = 1
           AND COALESCE(mi.is_dismissed, false) = false
         ORDER BY s.stuck_age_sec DESC
         LIMIT ${limit}
    `;
}

// ── Dead-letter panel ────────────────────────────────────────────────

export interface DeadLetterRow {
    media_item_id: string;
    title: string;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    media_type: string;
    stage_id: string;
    attempt: number;
    last_error: StageErrorDetail | null;
    /** Retryability controls retry policy; it does not imply a broken identity. */
    retryable: boolean | null;
    needs_identity_repair?: boolean;
    /** When the row gave up retrying. */
    dead_since: Date;
    dead_age_sec: number;
}

/**
 * Items with at least one `failed_permanent` stage row — pipeline gave
 * up retrying. These vanish from the failed_1h sliding window over
 * time but stay in the database; if nobody acknowledges them the DLQ
 * grows silently. Sort by recency so the latest perma-fails are most
 * visible.
 */
export async function loadDeadLetterItems(sql: postgres.Sql, limit = 20): Promise<DeadLetterRow[]> {
    // Dedupe to one row per media_item — when an item has multiple
    // failed_permanent stages, surface the most-recently-failed one.
    // Without this the panel showed N stage-rows while the HealthStrip
    // chip showed N distinct items, confusing the operator about which
    // number was authoritative.
    // Filter dismissed items INSIDE the CTE — otherwise rows belonging
    // to dismissed items would still consume top ranks in the
    // PARTITION BY, and a post-rank `WHERE not dismissed` would shrink
    // the result below the requested `limit` for no good reason.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: loadDeadLetterItems.
    return sql<DeadLetterRow[]>`
        WITH ranked AS (
            SELECT s.media_item_id,
                   s.stage_id,
                   s.status,
                   s.attempt,
                   s.last_error,
                   s.updated_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY s.media_item_id
                       ORDER BY s.updated_at DESC
                   ) AS rn
              FROM media_item_stage_state s
              JOIN media_items mi2 ON mi2.id = s.media_item_id
             WHERE s.status = 'failed_permanent'
               AND COALESCE(mi2.is_dismissed, false) = false
        )
        SELECT s.media_item_id,
               mi.title,
               series.title AS series_title,
               mi.season_number,
               mi.episode_number,
               mi.media_type,
               s.stage_id,
               s.attempt,
               s.last_error,
               (s.last_error->>'retryable')::boolean AS retryable,
               COALESCE((${reidentifyPredicate(sql, {})}), false) AS needs_identity_repair,
               s.updated_at AS dead_since,
               extract(epoch FROM now() - s.updated_at)::int AS dead_age_sec
          FROM ranked s
          JOIN media_items mi ON mi.id = s.media_item_id
          LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
          LEFT JOIN media_items series ON series.id = CASE
              WHEN mi.media_type = 'season' THEN mi.parent_id
              WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
          END
         WHERE s.rn = 1
         ORDER BY s.updated_at DESC
         LIMIT ${limit}
    `;
}

// ── Re-identification queue (permanent / non-retryable dead-letters) ──

/** One item needing re-identification — a permanent (non-retryable) dead-letter. */
export interface ReidentifyItem {
    media_item_id: string;
    title: string;
    /** The series a season/episode belongs to — the row Fix match must target. */
    series_id: string | null;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    media_type: string;
    stage_id: string;
    /** The permanent error (e.g. a TMDB 404) explaining why it can't be matched. */
    error_message: string | null;
    /** Machine error code recorded with the failure, when the stage set one. */
    error_code: string | null;
    dead_since: Date;
    /** Release year, when known — disambiguation context for the Identify modal. */
    year: number | null;
    /** Default (or first) file's path — disambiguation context for the Identify modal. */
    file_path: string | null;
    season_count: number | null;
    episode_count: number | null;
}

/** Optional narrowing of the re-identification queue (Fix matches toolbar). */
export interface ReidentifyFilters {
    /** Case-insensitive substring of the item's own title or its series title. */
    search?: string;
    /** 'movie' = movies only; 'series' = series, seasons and episodes. */
    mediaType?: 'movie' | 'series';
    /**
     * Only items whose ROOT (series, artist, movie, …) belongs to this library
     * group, by the shared membership rule (`buildLibraryGroupRootFilter`).
     */
    libraryGroupId?: string;
}

const SERIES_FAMILY_TYPES = ['tv', 'series', 'season', 'episode'];

/**
 * WHERE-clause tail shared by the queue + count. Expects `s` (stage row),
 * `mi` (the failed item) and `series` (its series, LEFT JOINed — null for a
 * movie or a top-level series) in scope.
 *
 * Excludes items whose top-level row never had an external id: those are the
 * "Never matched" population (listPersonalMediaItems) and the fix there is the
 * same Identify flow. Listing them here too put the same title in both Fix
 * matches views, with no way to tell which one to act in.
 */
export function reidentifyPredicate(sql: postgres.Sql, filters: ReidentifyFilters) {
    const search = filters.search?.trim();
    return sql`
        s.status = 'failed_permanent'
        AND (
            s.last_error->>'remediation' = 'identity'
            OR (
                s.last_error->>'remediation' IS NULL
                AND (s.last_error->>'retryable')::boolean IS FALSE
                AND COALESCE(s.last_error->>'message', '') ~* '((tmdb|imdb|tvdb).*(404|not found|no longer exists|id.{0,25}(stale|wrong|invalid)|no (seasons|episodes|children))|provider.{0,40}(id|identity|match).*(404|not found|no longer exists|stale|wrong|invalid))'
                AND COALESCE(s.last_error->>'message', '') !~* '(codec|encrypt|drm|ffmpeg|truncat|unreadable|corrupt|decrypt)'
                AND (
                    COALESCE(s.last_error->>'message', '') !~* '(image|poster|artwork|thumbnail|backdrop|url)'
                    OR COALESCE(s.last_error->>'message', '') ~* '(series|movie|show|season|episode).{0,80}(404|not found|no longer exists|stale|wrong|invalid|no (seasons|episodes|children))'
                )
            )
        )
        AND COALESCE(mi.is_dismissed, false) = false
        AND EXISTS (
            SELECT 1 FROM external_ids ei
             WHERE ei.media_id = COALESCE(series.id, mi.id) AND ei.source IS DISTINCT FROM 'watch-sync-file'
        )
        ${search ? sql`AND (mi.title ILIKE ${'%' + search + '%'} OR series.title ILIKE ${'%' + search + '%'})` : sql``}
        ${
            filters.mediaType === 'movie'
                ? sql`AND mi.media_type = 'movie'`
                : filters.mediaType === 'series'
                  ? sql`AND mi.media_type IN ${sql(SERIES_FAMILY_TYPES)}`
                  : sql``
        }
        ${buildLibraryGroupRootFilter(
            sql,
            filters.libraryGroupId,
            // Root of the failed row at any depth: grandparent -> parent -> self
            // (episode -> season -> series, track -> album -> artist, movie).
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: reidentifyPredicate root.
            sql`COALESCE(
                (SELECT _root_p.parent_id FROM media_items _root_p WHERE _root_p.id = mi.parent_id),
                mi.parent_id,
                mi.id
            )`,
        )}
    `;
}

/** The `season` + `series` LEFT JOINs both queue queries resolve a row's series through. */
export function seriesJoins(sql: postgres.Sql) {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: seriesJoins.
    return sql`
        LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
        LEFT JOIN media_items series ON series.id = CASE
            WHEN mi.media_type = 'season' THEN mi.parent_id
            WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
        END
    `;
}

/**
 * Count for the re-identification queue: a `failed_permanent` stage row whose
 * failure was explicitly NON-retryable (`retryable: false` — e.g. a TMDB 404), on
 * a non-dismissed item that was matched once (see {@link reidentifyPredicate}).
 * These are DATA problems a retry can't fix; the operator re-identifies the media
 * or accepts it as expected. {@link acceptReidentifyForStage} flips exactly this
 * set (per stage), so the count an operator sees is what the action changes.
 */
export async function countReidentifyItems(
    sql: postgres.Sql,
    filters: ReidentifyFilters = {},
): Promise<number> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: countReidentifyItems.
    const [row] = await sql<{ count: string }[]>`
        SELECT count(DISTINCT s.media_item_id)::text AS count
          FROM media_item_stage_state s
          JOIN media_items mi ON mi.id = s.media_item_id
          ${seriesJoins(sql)}
         WHERE ${reidentifyPredicate(sql, filters)}
    `;
    const n = Number(row?.count ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Stage-wide "accept as expected": flip this stage's re-identification rows —
 * exactly the {@link reidentifyPredicate} set the queue and its count show —
 * to `skipped_permanent`. It used to match on status + retryable alone, so it
 * also flipped dismissed and never-matched items the chip never counted: a
 * destructive action must match its preview. Returns rows accepted.
 */
export async function acceptReidentifyForStage(
    sql: postgres.Sql,
    stageId: string,
    skippedReason: string,
): Promise<number> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: acceptReidentifyForStage.
    const result = await sql`
        UPDATE media_item_stage_state t
           SET status = 'skipped_permanent',
               skipped_reason = ${skippedReason},
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
          FROM (
                SELECT s.media_item_id, s.stage_id
                  FROM media_item_stage_state s
                  JOIN media_items mi ON mi.id = s.media_item_id
                  ${seriesJoins(sql)}
                 WHERE s.stage_id = ${stageId}
                   AND ${reidentifyPredicate(sql, {})}
               ) q
         WHERE t.media_item_id = q.media_item_id
           AND t.stage_id = q.stage_id
           AND t.status = 'failed_permanent'
    `;
    return result.count ?? 0;
}

/**
 * Page through the re-identification queue, one row per media item (the most
 * recently-failed non-retryable stage), newest first.
 */
export async function loadReidentifyQueue(
    sql: postgres.Sql,
    { limit, offset, ...filters }: { limit: number; offset: number } & ReidentifyFilters,
): Promise<ReidentifyItem[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only module; every consumer is admin-gated (see the access-gating note in the file header, audited 2026-07-30). Site: loadReidentifyQueue.
    return sql<ReidentifyItem[]>`
        WITH ranked AS (
            SELECT s.media_item_id,
                   s.stage_id,
                   s.last_error,
                   s.updated_at,
                   series.id AS series_id,
                   series.title AS series_title,
                   ROW_NUMBER() OVER (
                       PARTITION BY s.media_item_id
                       ORDER BY s.updated_at DESC
                   ) AS rn
              FROM media_item_stage_state s
              JOIN media_items mi ON mi.id = s.media_item_id
              ${seriesJoins(sql)}
             WHERE ${reidentifyPredicate(sql, filters)}
        )
        SELECT r.media_item_id,
               mi.title,
               r.series_id,
               r.series_title,
               mi.season_number,
               mi.episode_number,
               mi.media_type,
               mi.year,
               r.stage_id,
               r.last_error->>'message' AS error_message,
               r.last_error->>'code' AS error_code,
               r.updated_at AS dead_since,
               file_info.file_path,
               child_counts.season_count,
               child_counts.episode_count
          FROM ranked r
          JOIN media_items mi ON mi.id = r.media_item_id
          -- Default (or first) file for this item — a movie/episode has its own
          -- file directly; a series falls back to its first episode's file.
          -- Disambiguation context for the Identify modal (spec: "two same-year
          -- candidates without leaving the modal").
          LEFT JOIN LATERAL (
              SELECT mf.file_path
                FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
               WHERE mfi.media_item_id = mi.id
                  OR mfi.media_item_id IN (
                       SELECT ep.id
                         FROM media_items s2
                         JOIN media_items ep ON ep.parent_id = s2.id AND ep.media_type = 'episode'
                        WHERE s2.parent_id = mi.id AND s2.media_type = 'season'
                     )
               ORDER BY mf.file_path
               LIMIT 1
          ) file_info ON true
          LEFT JOIN LATERAL (
              SELECT COUNT(DISTINCT s3.id)::int AS season_count,
                     COUNT(DISTINCT ep2.id)::int AS episode_count
                FROM media_items s3
                LEFT JOIN media_items ep2 ON ep2.parent_id = s3.id AND ep2.media_type = 'episode'
               WHERE s3.parent_id = mi.id AND s3.media_type = 'season'
          ) child_counts ON mi.media_type IN ('series', 'tv')
         WHERE r.rn = 1
         ORDER BY r.updated_at DESC
         LIMIT ${limit} OFFSET ${offset}
    `;
}

// ── Error groupings ──────────────────────────────────────────────────

export interface ErrorGroupRow {
    stage_id: string;
    /** Normalized message — UUIDs / numbers replaced with placeholders. */
    fingerprint: string;
    sample_message: string;
    error_code: string | null;
    count: number;
    first_seen: Date;
    last_seen: Date;
}

/**
 * Group items by a normalized error fingerprint so 200 items failing
 * with the same `ECONNRESET` show up as ONE actionable row instead of
 * 200 individual tooltips. Fingerprint strips UUIDs and large numbers
 * so per-call ids don't shatter groups.
 *
 * Window: last 24 h. Limit: top 20 groups by count.
 */
export async function loadErrorGroups(sql: postgres.Sql, limit = 20): Promise<ErrorGroupRow[]> {
    return sql<ErrorGroupRow[]>`
        WITH normalized AS (
            SELECT s.stage_id,
                   s.last_error->>'code' AS error_code,
                   s.last_error->>'message' AS raw_message,
                   regexp_replace(
                       regexp_replace(
                           COALESCE(s.last_error->>'message', ''),
                           '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                           '<uuid>',
                           'g'
                       ),
                       '[0-9]{4,}',
                       '<n>',
                       'g'
                   ) AS fingerprint,
                   s.updated_at
              FROM media_item_stage_state s
             WHERE s.status IN ('failed_transient','failed_permanent')
               AND s.updated_at > now() - interval '24 hours'
               AND s.last_error IS NOT NULL
        )
        SELECT stage_id,
               fingerprint,
               (array_agg(raw_message ORDER BY updated_at DESC))[1] AS sample_message,
               (array_agg(error_code ORDER BY updated_at DESC))[1] AS error_code,
               count(*)::int AS count,
               min(updated_at) AS first_seen,
               max(updated_at) AS last_seen
          FROM normalized
         WHERE fingerprint IS NOT NULL AND fingerprint <> ''
         GROUP BY stage_id, fingerprint
         ORDER BY count DESC, last_seen DESC
         LIMIT ${limit}
    `;
}

/** Pending (not yet eligible-checked) rows per stage — the backlog's shape. */
export interface StagePendingRow {
    stage_id: string;
    pending: number;
    oldest_pending_age_sec: number | null;
}

/**
 * Items with a stage row that will still run: claimed now, or one the sweep
 * re-enqueues. Mirrors the sweepable set in `stage-disposition-runner.ts`
 * (`pending`, `failed_transient`, `skipped_transient`, `obsolete`) plus
 * `running`.
 *
 * Unlike `loadIngestPipelineSummary.inFlight` this leaves out
 * `failed_permanent`: a dead letter is terminal, and counting it kept the
 * `/admin/fix/stuck` verdict from ever reading `idle` on an instance with a
 * single dead letter.
 */
export async function countRunnableStageItems(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<Array<{ n: number }>>`
        SELECT COUNT(DISTINCT media_item_id)::int AS n
          FROM media_item_stage_state
         WHERE status IN ('running', 'pending', 'failed_transient', 'skipped_transient', 'obsolete')
    `;
    return row?.n ?? 0;
}

/**
 * Where the waiting work actually sits, per stage.
 *
 * `loadStageActivity` reports movement — completions, running rows, recent
 * failures. On a genuinely wedged instance every one of those is zero, so a
 * page built only on it shows an EMPTY evidence list at exactly the moment the
 * operator most needs to know which stage is holding the backlog. This supplies
 * the other half: what is waiting, and how long it has waited.
 *
 * Counts `pending` and `failed_transient` — both are rows the sweep still
 * intends to run. Terminal statuses are excluded because a stage full of
 * `skipped_permanent` rows is finished, not stuck, and listing it would send
 * the operator after work that is deliberately over.
 */
export async function loadStagePendingCounts(sql: postgres.Sql): Promise<StagePendingRow[]> {
    return sql<StagePendingRow[]>`
        SELECT stage_id,
               COUNT(*)::int AS pending,
               EXTRACT(EPOCH FROM (now() - MIN(updated_at)))::int AS oldest_pending_age_sec
          FROM media_item_stage_state
         WHERE status IN ('pending', 'failed_transient')
         GROUP BY stage_id
    `;
}

export async function acceptReidentifyItem(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
    skippedReason: string,
): Promise<number> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only remediation, same queue predicate as bulk acceptance
    const result = await sql`
        UPDATE media_item_stage_state t SET status = 'skipped_permanent',
            skipped_reason = ${skippedReason}, next_eligible_at = NULL,
            declines = 0, declines_since = NULL, updated_at = now()
        FROM (SELECT s.media_item_id, s.stage_id FROM media_item_stage_state s
            JOIN media_items mi ON mi.id = s.media_item_id ${seriesJoins(sql)}
            WHERE s.media_item_id = ${mediaItemId}::uuid AND s.stage_id = ${stageId}
              AND ${reidentifyPredicate(sql, {})}) q
        WHERE t.media_item_id = q.media_item_id AND t.stage_id = q.stage_id
          AND t.status = 'failed_permanent'
    `;
    return result.count ?? 0;
}
