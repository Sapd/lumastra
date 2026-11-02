// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { reidentifyPredicate, seriesJoins } from './ingest-map.queries.js';
import type { AlertRow, UpsertAlert } from '../../services/attention/types.js';
import { actionableTaskFailure } from './fragments/task-failure.fragments.js';
import { domainForType } from '$lib/shared/attention-domain.js';
import { ALERT_FLOOR, ALERT_AGE_HOURS } from '$lib/server/tasks/decline-loop.js';

/**
 * True per-stage count of dead-letter items, split by the identity repair queue predicate.
 * `loadDeadLetterItems` fetches only a 20-row sample for detail display; using the
 * sample size in the alert title / `countBucket` fingerprint caps the ack watermark
 * at 20 regardless of the real backlog. This query provides the true total so the
 * displayed count and fingerprint bucket reflect the actual population.
 *
 * Legacy bucket names are retained: `transient:` means operational, `permanent:` means identity repair.
 * Uses the same `failed_permanent` filter and dismissed-item exclusion as
 * `loadDeadLetterItems`. Cheap: one indexed aggregate over media_item_stage_state.
 */
export async function countDeadLetterItemsByStage(sql: postgres.Sql): Promise<Map<string, number>> {
    const rows = await sql<{ stage_id: string; identity: boolean; cnt: number }[]>`
        SELECT s.stage_id,
               COALESCE((${reidentifyPredicate(sql, {})}), false) AS identity,
               COUNT(*)::int AS cnt
          FROM media_item_stage_state s
          JOIN media_items mi ON mi.id = s.media_item_id
          ${seriesJoins(sql)}
         WHERE s.status = 'failed_permanent'
           AND COALESCE(mi.is_dismissed, false) = false
         GROUP BY s.stage_id, identity
        -- NOTE: a (stage_id, status) partial index WHERE status='failed_permanent'
        -- would help at scale, but migration is owned by another agent.
    `;
    const map = new Map<string, number>();
    for (const r of rows) {
        // This is the exact partition used by queue/count/accept and the adapter.
        const bucket = r.identity ? `permanent:${r.stage_id}` : `transient:${r.stage_id}`;
        map.set(bucket, (map.get(bucket) ?? 0) + r.cnt);
    }
    return map;
}

/** Count of manual task runs currently in flight (drives the bell activity pulse). */
export async function countActiveManualRuns(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM task_history
        WHERE state IN ('pending', 'active', 'cancelling')
          AND trigger ->> 'kind' = 'manual'
    `;
    return rows[0]?.count ?? 0;
}

export interface FailedRunSpikeRow {
    task_id: string;
    fail_count: number;
}

/**
 * Of the given `taskIds`, which are recently active — either:
 *  (a) completed a run within the last `withinMinutes`, OR
 *  (b) currently have an in-flight `state='active'` run started within 8 hours.
 *
 * Used to suppress "overdue schedule" alerts for tasks demonstrably running via
 * events / stage-sweep even though their time-schedule's next_fire_at is stale —
 * see `adaptOverdueSchedules`.
 *
 * Fix 17 (OSS): the original query only covered completed runs. A task still
 * in a long-running active run (e.g. a large music analysis job) was not
 * counted as recently-active, so it could fire an overdue-schedule warning
 * even while genuinely in flight. The OR branch adds active-run coverage
 * bounded to `started_at > NOW() - INTERVAL '8 hours'` to keep the scan
 * cheap and scoped to the passed ids.
 *
 * -- NOTE: a (task_id, started_at) WHERE state='active' index would help at
 * -- scale, but adding a migration is owned by another agent.
 *
 * The completed-run branch rides the
 * `idx_task_history_task_completed (task_id, completed_at) WHERE duration_ms IS NOT NULL`
 * index. Callers MUST pass only the overdue ids (and skip the call when none are
 * overdue) to keep this scoped and cheap on large task_history tables.
 */
export async function listRecentlyActiveTaskIds(
    sql: postgres.Sql,
    taskIds: string[],
    withinMinutes: number,
): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const rows = await sql<{ task_id: string }[]>`
        SELECT DISTINCT task_id
        FROM task_history
        WHERE task_id = ANY(${sql.array(taskIds)})
          AND (
              -- (a) completed a run recently
              (duration_ms IS NOT NULL
               AND completed_at > NOW() - make_interval(mins => ${withinMinutes}::int))
              OR
              -- (b) Fix 17: currently in-flight — suppress false overdue for long-running tasks
              -- NOTE: a (task_id, started_at) WHERE state='active' index would help at scale.
              (state = 'active'
               AND started_at > NOW() - INTERVAL '8 hours')
          )
    `;
    return rows.map((r) => r.task_id);
}

/**
 * Per-task count of genuinely-failed runs in the last 24h, ≥ minCount.
 *
 * The boot-recovery exclusion predicate is load-bearing and copied verbatim from
 * lane-data.ts (recentFailCount): a raw `state='failed'` count over-reports ~15×
 * because every task that ran during a deploy gets orphan/claim-race/concurrency
 * rows that are noise, not actionable failures. A single indexed aggregate over a
 * 24h slice — same cost profile as the dead-letter / stuck sources.
 */
export async function loadFailedRunSpikes(
    sql: postgres.Sql,
    minCount: number,
): Promise<FailedRunSpikeRow[]> {
    return sql<FailedRunSpikeRow[]>`
        SELECT task_id, COUNT(*)::int AS fail_count
        FROM task_history
        WHERE ${actionableTaskFailure(sql)}
        GROUP BY task_id
        HAVING COUNT(*) >= ${minCount}
    `;
}

export interface RepeatedSubsystemEventRow {
    category: string;
    action: string;
    cnt: number;
    /** Summary of the most recent occurrence (for the alert detail). */
    last_summary: string | null;
}

/**
 * Repeated autonomous recovery events (spec §5 auto-promotion): the SAME
 * subsystem recovery action firing over and over inside a 24 h window means a
 * fault keeps recurring — each individual recovery "succeeds", so nothing else
 * ever tells the operator. Groups the `audit_log` subsystem feed by
 * (category, action) and returns groups at or above `minCount`. Callers pass
 * the recovery-action allowlist so routine chatter (leader renewals etc.)
 * can't promote.
 *
 * 🔴 RESTART GRACE. Every action in the allowlist is ALSO the correct,
 * expected response to a node stopping: `boot-recovery-complete` fires on
 * literally every boot, and `orphans-reclaimed` fires whenever a deploy
 * SIGTERMs a worker mid-run (a 30-minute task cannot drain inside a 30-second
 * stop grace, so its runs are reclaimed ~5 minutes later by the reconciler).
 *
 * Counting those made the alert a deploy-frequency meter: on a day with 16
 * deploys it fired "×19 in 24 h, something keeps re-wedging" while nothing
 * whatsoever was wedged. An alert that cries wolf on ordinary deploys teaches
 * operators to ignore it, which costs more than the alert ever earns.
 *
 * So: ignore recoveries that land within {@link RESTART_GRACE_MINUTES} of a
 * node transition. What survives is recovery that happened while the cluster
 * was stable — which is the actual signal. Mirrors the identical grace window
 * in `actionableTaskFailure` (task-failure.fragments.ts).
 *
 * 🔴 THE GRACE MUST BE DEPLOY-SPECIFIC, NOT TRANSITION-SPECIFIC. An unplanned
 * restart plants the exact same `cluster_node_events` row a deploy does: the
 * crashed instance's Valkey heartbeat key expires, the leader's detector
 * writes an 'offline' row for it, and the restarted process's 'online' row
 * follows a few seconds later — indistinguishable, on shape alone, from a
 * SIGTERM-and-recreate. A plain "any transition nearby" check therefore grants
 * the SAME excuse to a crash loop, and the operator-facing copy this alert
 * feeds (adapters.ts) explicitly promises it has already excluded that case.
 *
 * `INSTANCE_ID` is normally unpinned, so a restart —
 * crash or deploy alike — usually mints a brand-new instance id with no prior
 * history; there is no stable per-instance row to diff a version against. What
 * IS reliable is the {@link HeartbeatPayload.version} carried on every 'online'
 * row (git-describe — changes only on an actual release, never on a bare
 * restart of the same image). So: only excuse a recovery when a nearby
 * 'online' transition carries a version that itself only started appearing
 * recently, i.e. within {@link DEPLOY_WAVE_WINDOW_MINUTES} — a genuinely NEW
 * build having just gone out, not the SAME build coming back up. A crash-loop
 * restarting a long-deployed version fails this (that version's first-ever
 * appearance is far in the past) and is counted, closing the gap the operator
 * copy already claims is closed. A multi-replica ROLLING deploy still clears
 * it for every replica: they all share one first-ever-seen timestamp for the
 * new version (whichever replica came up with it first), so a later replica's
 * own recovery is excused by that same recent timestamp even though it did
 * not personally introduce the version.
 */
export const RESTART_GRACE_MINUTES = 15;

/**
 * How recently a version's first-ever 'online' appearance must be for a
 * transition carrying it to count as "a deploy just happened" rather than
 * "the same build restarting". Wider than {@link RESTART_GRACE_MINUTES} so a
 * multi-replica rolling deploy (each replica recreated in turn, several
 * minutes apart) still reads as one wave rather than N separate excuses.
 */
const DEPLOY_WAVE_WINDOW_MINUTES = 60;

export async function loadRepeatedSubsystemEvents(
    sql: postgres.Sql,
    actions: readonly string[],
    minCount: number,
): Promise<RepeatedSubsystemEventRow[]> {
    if (actions.length === 0) return [];
    return sql<RepeatedSubsystemEventRow[]>`
        SELECT category,
               action,
               COUNT(*)::int AS cnt,
               (ARRAY_AGG(summary ORDER BY ts DESC))[1] AS last_summary
          FROM audit_log a
         WHERE a.source = 'subsystem'
           AND a.ts > NOW() - INTERVAL '24 hours'
           AND a.action = ANY(${sql.array([...actions])})
           AND NOT EXISTS (
               SELECT 1
                 FROM cluster_node_events e
                WHERE e.created_at <= a.ts
                  AND e.created_at > a.ts - make_interval(mins => ${RESTART_GRACE_MINUTES})
                  AND e.event_type = 'online'
                  AND e.version IS NOT NULL
                  -- This version's first-ever 'online' appearance (any
                  -- instance, any time in retained history) must itself be
                  -- recent — otherwise it is the SAME build restarting, which
                  -- is precisely the crash-loop case this alert must catch.
                  AND (
                      SELECT MIN(seen.created_at)
                        FROM cluster_node_events seen
                       WHERE seen.event_type = 'online'
                         AND seen.version = e.version
                  ) > a.ts - make_interval(mins => ${DEPLOY_WAVE_WINDOW_MINUTES})
           )
         GROUP BY category, action
        HAVING COUNT(*) >= ${minCount}
    `;
}

export interface UncleanExitRow {
    instanceId: string;
    cnt: number;
    role: string | null;
    hostname: string | null;
}

/**
 * Instances that came back from an unclean exit (`restart_unclean`: OOM kill,
 * crash, lost node) at least `minCount` times in the last 24 h.
 *
 * Deploy churn is excluded the same way loadRepeatedSubsystemEvents does it, and
 * for the same reason: a deploy whose old process outlives its stop grace is
 * SIGKILLed and its successor is recorded as `restart_unclean`. A restart row
 * whose version's current run first came online less than
 * {@link DEPLOY_WAVE_WINDOW_MINUTES} before it belongs to a deploy wave (including
 * a rollback); the SAME build dying again later does not, which is the crash loop
 * this must catch. A row without a version is never
 * excused. Instances whose latest event is not 'online' (replaced, scaled
 * down) are left out.
 */
export async function loadUncleanExits(
    sql: postgres.Sql,
    minCount: number,
): Promise<UncleanExitRow[]> {
    return sql<UncleanExitRow[]>`
        SELECT e.instance_id AS "instanceId",
               COUNT(*)::int AS cnt,
               (ARRAY_AGG(e.role ORDER BY e.created_at DESC))[1] AS role,
               (ARRAY_AGG(e.hostname ORDER BY e.created_at DESC))[1] AS hostname
          FROM cluster_node_events e
         WHERE e.event_type = 'online'
           AND e.reason = 'restart_unclean'
           AND e.created_at > NOW() - INTERVAL '24 hours'
           -- Only instances that are running now: a replaced or decommissioned
           -- one cannot be fixed, so its item would sit there for a day.
           AND (
               SELECT latest.event_type
                 FROM cluster_node_events latest
                WHERE latest.instance_id = e.instance_id
                ORDER BY latest.created_at DESC
                LIMIT 1
           ) = 'online'
           AND NOT (
               e.version IS NOT NULL
               AND (
                   SELECT MIN(seen.created_at)
                     FROM cluster_node_events seen
                    WHERE seen.event_type = 'online'
                      AND seen.version = e.version
                      AND seen.created_at <= e.created_at
                      -- A rollback starts a new run of an older version. Only
                      -- sightings after the previous different version belong
                      -- to this deploy wave, not that version's entire history.
                      AND seen.created_at > COALESCE((
                          SELECT MAX(previous.created_at)
                            FROM cluster_node_events previous
                           WHERE previous.event_type = 'online'
                             AND previous.version IS DISTINCT FROM e.version
                             AND previous.created_at < e.created_at
                      ), '-infinity'::timestamptz)
               ) > e.created_at - make_interval(mins => ${DEPLOY_WAVE_WINDOW_MINUTES})
           )
         GROUP BY e.instance_id
        HAVING COUNT(*) >= ${minCount}
    `;
}

export interface RecentlyAddedRow {
    id: string;
    title: string;
    mediaType: string;
    year: number | null;
    seriesId: string | null;
    seriesTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    addedAt: string;
}

/**
 * Last N file-backed leaf items (movies + episodes) by real arrival time.
 * Admin-scoped (no library/age filter — the operations center shows everything).
 *
 * For episodes the series context is resolved by walking parent_id twice
 * (episode → season → series), mirroring the exact join used in
 * loadStuckItems / loadDeadLetterItems in ingest-map.queries.ts.
 */
export async function getRecentlyAddedForOps(
    sql: postgres.Sql,
    limit = 10,
): Promise<RecentlyAddedRow[]> {
    return sql<RecentlyAddedRow[]>`
        WITH recent AS MATERIALIZED (
            SELECT id, title, media_type, year, parent_id, season_number, episode_number,
                   library_added_at, created_at
            FROM media_items
            WHERE status = 'active' AND has_files = true AND media_type IN ('movie', 'episode')
            ORDER BY COALESCE(library_added_at, created_at) DESC
            LIMIT ${limit}
        )
        SELECT mi.id,
               mi.title,
               mi.media_type AS "mediaType",
               mi.year,
               series.id AS "seriesId",
               series.title AS "seriesTitle",
               mi.season_number AS "seasonNumber",
               mi.episode_number AS "episodeNumber",
               to_char(COALESCE(mi.library_added_at, mi.created_at) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "addedAt"
          FROM recent mi
          LEFT JOIN media_items season ON season.id = mi.parent_id AND mi.media_type = 'episode'
          LEFT JOIN media_items series ON series.id = CASE
              WHEN mi.media_type = 'season' THEN mi.parent_id
              WHEN mi.media_type = 'episode' THEN COALESCE(season.parent_id, mi.parent_id)
          END
         ORDER BY COALESCE(mi.library_added_at, mi.created_at) DESC
    `;
}

/** All non-deleted rows (caller filters by status as needed). */
export async function readAllAlerts(sql: postgres.Sql): Promise<AlertRow[]> {
    const rows = await sql<AlertRow[]>`
        SELECT id, fingerprint, type, domain, severity, title, detail, source_ref,
               status,
               to_char(first_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen,
               to_char(last_seen  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen,
               to_char(acked_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS acked_at,
               acked_by, acked_fingerprint, count, acked_count, count_first, count_prev,
               to_char(snoozed_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS snoozed_until,
               to_char(resolved_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at
        FROM admin_attention_alerts
    `;
    return rows;
}

/**
 * Recently auto-resolved alerts ("what happened while away"), newest first.
 * Only resolved rows carry resolved_at, so the partial index serves this directly.
 */
export async function readResolvedHistory(sql: postgres.Sql, limit = 10): Promise<AlertRow[]> {
    return sql<AlertRow[]>`
        SELECT id, fingerprint, type, domain, severity, title, detail, source_ref,
               status,
               to_char(first_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_seen,
               to_char(last_seen  AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen,
               to_char(acked_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS acked_at,
               acked_by, acked_fingerprint, count, acked_count, count_first, count_prev,
               to_char(snoozed_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS snoozed_until,
               to_char(resolved_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at
        FROM admin_attention_alerts
        WHERE status = 'resolved' AND resolved_at IS NOT NULL
        ORDER BY resolved_at DESC
        LIMIT ${limit}
    `;
}

/**
 * Write-through the current derivation; PK conflict overwrites mutable fields.
 *
 * Fix 16 (OSS): replaced the N-row serial await loop with a single bulk
 * `INSERT … ON CONFLICT … DO UPDATE` using postgres.js unnest so the entire
 * derivation cycle costs exactly ONE pool round-trip, regardless of alert count.
 * Each statement is its own brief pool checkout, returned immediately (no
 * long-held connection).  The write-through remains naturally eventually-
 * consistent — any partial failure is corrected by the next reconcile.
 *
 * Fix 14 (OSS): added `resolved_at = NULL` to the ON CONFLICT clause so a
 * re-fired alert atomically clears the stale resolved timestamp from its prior
 * resolved incarnation.  Without this, a re-active alert row carried a non-null
 * `resolved_at` while `status='active'`, which is a latent correctness hazard.
 */
export async function upsertAlerts(sql: postgres.Sql, items: UpsertAlert[]): Promise<void> {
    if (items.length === 0) return;

    // Build parallel arrays for unnest — postgres.js maps sql.array(arr) to a
    // Postgres array literal that unnest() expands into rows.
    const ids = items.map((a) => a.id);
    const fingerprints = items.map((a) => a.fingerprint);
    const types = items.map((a) => a.type);
    // A producer that states its own domain wins; everything else keeps landing
    // where the deprecated `type` map puts it. Writing the column (rather than
    // leaving it on its 'system' default) is the follow-up migration 16.231.0
    // named — and because the ON CONFLICT below rewrites it every derive tick,
    // rows created between that migration and this change self-correct within
    // one tick instead of needing a backfill.
    const domains = items.map((a) => a.domain?.trim() || domainForType(a.type));
    const severities = items.map((a) => a.severity);
    const titles = items.map((a) => a.title);
    const details = items.map((a) => a.detail);
    const sourceRefs = items.map((a) => a.source_ref);
    const statuses = items.map((a) => a.status);
    const firstSeens = items.map((a) => a.first_seen);
    const lastSeens = items.map((a) => a.last_seen);
    const ackedAts = items.map((a) => a.acked_at);
    const ackedBys = items.map((a) => a.acked_by);
    const ackedFingerprints = items.map((a) => a.acked_fingerprint);
    const counts = items.map((a) => a.count);
    const ackedCounts = items.map((a) => a.acked_count);
    const snoozedUntils = items.map((a) => a.snoozed_until);

    await sql`
        INSERT INTO admin_attention_alerts
            (id, fingerprint, type, domain, severity, title, detail, source_ref,
             status, first_seen, last_seen, acked_at, acked_by, acked_fingerprint,
             count, acked_count, snoozed_until, count_first, count_prev)
        SELECT * FROM unnest(
            ${sql.array(ids)}::text[],
            ${sql.array(fingerprints)}::text[],
            ${sql.array(types)}::text[],
            ${sql.array(domains)}::text[],
            ${sql.array(severities)}::text[],
            ${sql.array(titles)}::text[],
            ${sql.array(details)}::text[],
            ${sql.array(sourceRefs)}::text[],
            ${sql.array(statuses)}::text[],
            ${sql.array(firstSeens)}::timestamptz[],
            ${sql.array(lastSeens)}::timestamptz[],
            ${sql.array(ackedAts)}::timestamptz[],
            ${sql.array(ackedBys)}::text[],
            ${sql.array(ackedFingerprints)}::text[],
            ${sql.array(counts)}::int[],
            ${sql.array(ackedCounts)}::int[],
            ${sql.array(snoozedUntils)}::timestamptz[],
            ${sql.array(counts)}::int[],
            ${sql.array(counts)}::int[]
        ) AS v(id, fingerprint, type, domain, severity, title, detail, source_ref,
               status, first_seen, last_seen, acked_at, acked_by, acked_fingerprint,
               count, acked_count, snoozed_until, count_first, count_prev)
        ON CONFLICT (id) DO UPDATE SET
            fingerprint       = EXCLUDED.fingerprint,
            type              = EXCLUDED.type,
            domain            = EXCLUDED.domain,
            severity          = EXCLUDED.severity,
            title             = EXCLUDED.title,
            detail            = EXCLUDED.detail,
            source_ref        = EXCLUDED.source_ref,
            status            = EXCLUDED.status,
            last_seen         = EXCLUDED.last_seen,
            acked_at          = EXCLUDED.acked_at,
            acked_by          = EXCLUDED.acked_by,
            acked_fingerprint = EXCLUDED.acked_fingerprint,
            count             = EXCLUDED.count,
            acked_count       = EXCLUDED.acked_count,
            snoozed_until     = EXCLUDED.snoozed_until,
            -- Trend memory. count_first is what this alert was worth when it
            -- became active and must survive every tick -- COALESCE rather than
            -- assignment, so a row created before 16.241.0 adopts its current
            -- value once instead of staying NULL forever. count_prev rolls the
            -- OLD row's count forward, which is the whole point: EXCLUDED.count
            -- is the NEW value, so reading direction needs the pre-update one.
            -- A resolved alert that re-fires is a NEW incident, so resolveAlerts
            -- clears both.
            count_first       = COALESCE(admin_attention_alerts.count_first, EXCLUDED.count),
            count_prev        = admin_attention_alerts.count,
            -- Fix 14 (OSS): clear stale resolved_at when an alert re-fires so a
            -- re-active row can't carry a non-null resolved_at (latent hazard).
            resolved_at       = NULL
    `;
}

/**
 * Mark a set of ids resolved (moves them to history). Stamps resolved_at for the
 * history ordering + retention sweep; the status guard keeps it idempotent.
 *
 * Fix 15 (OSS): also clears `snoozed_until` on resolution so that if the same
 * alert id re-fires in a future cycle it cannot be silently suppressed by a snooze
 * the operator placed on the prior incarnation. (reconcile.ts also skips snooze
 * carry-forward for resolved rows as defense-in-depth — do both for safety.)
 */
export async function resolveAlerts(sql: postgres.Sql, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await sql`
        UPDATE admin_attention_alerts
           SET status       = 'resolved',
               resolved_at  = now(),
               snoozed_until = NULL,
               -- A re-fire after resolution is a NEW incident. Carrying the old
               -- incident's first/prev counts forward would report a trend across
               -- a gap where the problem was actually gone.
               count_first  = NULL,
               count_prev   = NULL
         WHERE id = ANY(${sql.array(ids)}) AND status <> 'resolved'
    `;
}

/**
 * Snooze one alert until `until` (ISO), but only if the supplied fingerprint still
 * matches the live row (same guard as ack — don't snooze an incident that changed
 * between render and click). Unlike ack this does not change status. Returns true if
 * a row was snoozed.
 */
export async function snoozeAlert(
    sql: postgres.Sql,
    id: string,
    fingerprint: string,
    until: string,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE admin_attention_alerts
           SET snoozed_until = ${until}::timestamptz
         WHERE id = ${id} AND fingerprint = ${fingerprint} AND status <> 'resolved'
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Ack one alert, but only if the supplied fingerprint still matches the live row
 * (guards against acking an incident that changed between render and click).
 * Returns true if a row was acked.
 *
 * `acked_count` is snapshotted server-side from the live `count` column (written
 * by the most recent derive cycle) rather than trusted from the client, so the
 * watermark the ack is held against can't be spoofed or go stale. For scalar
 * alerts `count` is null → `acked_count` stays null and reconcile falls back to
 * fingerprint-equality ack.
 */
export async function ackAlert(
    sql: postgres.Sql,
    id: string,
    fingerprint: string,
    ackedBy: string,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE admin_attention_alerts
           SET status = 'acked',
               acked_at = now(),
               acked_by = ${ackedBy},
               acked_fingerprint = ${fingerprint},
               acked_count = admin_attention_alerts.count
         WHERE id = ${id} AND fingerprint = ${fingerprint} AND status <> 'resolved'
        RETURNING id
    `;
    return rows.length > 0;
}

/**
 * Resolved-row retention (Problems-as-Architecture design, §5.5 / Slice 0).
 *
 * `admin_attention_alerts` had no cleanup — resolved rows accumulated forever.
 * Only `status = 'resolved'` rows are ever eligible here. `active` and `acked`
 * rows are NEVER time-evicted: a problem that has been true for a long time is
 * still true, and an `acked` row is the operator's live "I've seen this, don't
 * page me again" anchor for a condition that has not gone away — deleting it
 * would be deleting state, not history. A row only becomes eligible once its
 * underlying condition has actually cleared and `resolveAlerts` has stamped a
 * `resolved_at` on it (which happens regardless of whether it was ever acked).
 *
 * Two independent passes, both riding the existing partial index
 * `idx_admin_attention_alerts_resolved_at ON (resolved_at) WHERE status = 'resolved'`:
 *
 *  1. Age — resolved rows older than {@link RESOLVED_ALERT_RETENTION_DAYS} days.
 *  2. Cap — beyond the newest {@link RESOLVED_ALERT_HISTORY_CAP} resolved rows,
 *     oldest first. Bounds a producer that resolves/re-fires often enough to
 *     fill the table well inside the age window.
 *
 * Both DELETEs are batched (LIMIT in a do-while loop, same shape as
 * `deleteInBatches` in `playback-telemetry.service.ts`) so a large backlog on a
 * neglected instance can't turn one run into an unbounded lock hold; the
 * caller's abort signal is honoured between batches.
 */
export const RESOLVED_ALERT_RETENTION_DAYS = 30;
export const RESOLVED_ALERT_HISTORY_CAP = 500;
const CLEANUP_BATCH_SIZE = 500;

async function deleteAlertsInBatches(
    runner: () => Promise<{ count: number }>,
    abortSignal?: AbortSignal,
): Promise<number> {
    let total = 0;
    let batchCount: number;
    do {
        if (abortSignal?.aborted) break;
        const result = await runner();
        batchCount = result.count;
        total += batchCount;
    } while (batchCount >= CLEANUP_BATCH_SIZE);
    return total;
}

export interface CleanupResolvedAlertsResult {
    deletedByAge: number;
    deletedByCap: number;
}

export async function cleanupResolvedAlerts(
    sql: postgres.Sql,
    abortSignal?: AbortSignal,
): Promise<CleanupResolvedAlertsResult> {
    const deletedByAge = await deleteAlertsInBatches(
        async () => sql`
            DELETE FROM admin_attention_alerts
             WHERE id IN (
                SELECT id FROM admin_attention_alerts
                 WHERE status = 'resolved'
                   AND resolved_at < NOW() - make_interval(days => ${RESOLVED_ALERT_RETENTION_DAYS}::int)
                 LIMIT ${CLEANUP_BATCH_SIZE}
             )
        `,
        abortSignal,
    );

    let deletedByCap = 0;
    if (!abortSignal?.aborted) {
        deletedByCap = await deleteAlertsInBatches(
            async () => sql`
                DELETE FROM admin_attention_alerts
                 WHERE id IN (
                    SELECT id FROM admin_attention_alerts
                     WHERE status = 'resolved'
                     ORDER BY resolved_at DESC
                    OFFSET ${RESOLVED_ALERT_HISTORY_CAP}
                     LIMIT ${CLEANUP_BATCH_SIZE}
                 )
            `,
            abortSignal,
        );
    }

    return { deletedByAge, deletedByCap };
}

/** One stage row whose decline streak has aged past the alert window. */
export interface DeclineLoopRow {
    stage_id: string;
    media_item_id: string;
    declines: number;
    declines_since: Date;
    last_error: unknown;
}

/**
 * Stage rows that have been declining without progressing for longer than
 * `ALERT_AGE_HOURS`.
 *
 * ## Why AGE and not count
 *
 * `declines` only advances when the sweep actually PICKS the row — and past
 * `DEMOTION_ONSET` the row carries a `next_eligible_at`, which
 * `findSweepCandidates` sorts behind the entire NULL-pending backlog. On a stage
 * with sustained inflow a demoted row may never be picked again, freezing its
 * counter. A count threshold would therefore be unreachable on exactly the busy
 * stages the incident history comes from. Streak age advances regardless, so it
 * is the only predicate that survives the demotion this design causes.
 *
 * `declines >= ALERT_FLOOR` is not the detector; it only asks "was this row ever
 * demoted", which is reachable by construction because `ALERT_FLOOR` IS
 * `DEMOTION_ONSET`. Keep those two equal — an earlier revision set the floor one
 * higher and the alert became unreachable.
 *
 * ## Status scope
 *
 * Exactly `pending` and `failed_transient`. Every writer into `completed`,
 * `obsolete`, `skipped_*` and `failed_permanent` resets the streak, so those can
 * never carry a live one; listing them would read as a disagreement with that
 * invariant. `failed_transient` MUST stay: `reclaimWedgedRunningStageRows` and
 * `releaseWedgedRunningForStage` write it WITHOUT resetting (they leave `attempt`
 * unchanged, so no cap is escalating), and that decline/wedge alternation is
 * precisely the loop worth catching.
 *
 * The liveness EXISTS mirrors `findSweepCandidates`. Without it a dismissed item
 * is permanently unsweepable — nothing can ever complete or re-decline it — while
 * staying visible here with an ever-aging streak, producing an alert that could
 * never auto-resolve.
 *
 * Rides `idx_stage_state_decline_streak` (partial on `declines >= 4`, keyed on
 * `declines_since`); the migration's literal must equal `ALERT_FLOOR` or this
 * degrades to a sequential scan on a 60s reconcile loop.
 */
export async function loadDeclineLoopRows(
    sql: postgres.Sql,
    limit = 20,
): Promise<DeclineLoopRow[]> {
    const rows = await sql<DeclineLoopRow[]>`
        SELECT s.stage_id,
               s.media_item_id::text AS media_item_id,
               s.declines,
               s.declines_since,
               s.last_error
          FROM media_item_stage_state s
         WHERE s.declines >= ${ALERT_FLOOR}
           AND s.declines_since < now() - make_interval(hours => ${ALERT_AGE_HOURS}::int)
           AND s.status IN ('pending', 'failed_transient')
           AND EXISTS (
               SELECT 1
                 FROM media_items mi
                WHERE mi.id = s.media_item_id
                  AND mi.status = 'active'
                  AND COALESCE(mi.is_dismissed, false) = false
           )
         ORDER BY s.declines_since ASC
         LIMIT ${limit}
    `;
    return Array.from(rows);
}

/**
 * True per-stage totals for the decline-loop alert. `loadDeclineLoopRows` returns
 * only a display sample, and using the sample size for the count would cap the ack
 * watermark at the sample limit regardless of the real population — the same trap
 * `countDeadLetterItemsByStage` exists to avoid.
 */
export async function countDeclineLoopRowsByStage(sql: postgres.Sql): Promise<Map<string, number>> {
    const rows = await sql<{ stage_id: string; total: string }[]>`
        SELECT s.stage_id, COUNT(*)::text AS total
          FROM media_item_stage_state s
         WHERE s.declines >= ${ALERT_FLOOR}
           AND s.declines_since < now() - make_interval(hours => ${ALERT_AGE_HOURS}::int)
           AND s.status IN ('pending', 'failed_transient')
           AND EXISTS (
               SELECT 1
                 FROM media_items mi
                WHERE mi.id = s.media_item_id
                  AND mi.status = 'active'
                  AND COALESCE(mi.is_dismissed, false) = false
           )
         GROUP BY s.stage_id
    `;
    return new Map(rows.map((r) => [r.stage_id, Number(r.total)]));
}

/**
 * Jellyfin accounts the newest completed watch-sync pull that actually pulled
 * Jellyfin skipped for having no Lumastra user. Reads the Jellyfin entry of the
 * per-provider meta of that run's task result (`jellyfin-watch-sync`). A run
 * that did not pull Jellyfin (unavailable, other mode) has no such entry, so it
 * is passed over instead of clearing the notice. Only a run from the last hour
 * counts, so the notice clears once the pulls stop or the accounts are linked.
 * Bounded by LIMIT 1 and the 1-hour window. The duration_ms predicate makes
 * idx_task_history_task_completed (task_id, completed_at) eligible: it is a
 * partial index (WHERE duration_ms IS NOT NULL). The planner still chooses
 * between it and idx_task_history_terminal_completed by statistics.
 */
export async function loadJellyfinUnlinkedUsers(
    sql: postgres.Sql,
): Promise<{ count: number; names: string[] }> {
    const rows = await sql<{ count: number | null; names: unknown }[]>`
        SELECT (result -> 'result' -> 'meta' -> 'skippedNoLumastraAccountCountByProvider' ->> 'jellyfin-watch-sync')::int AS count,
               result -> 'result' -> 'meta' -> 'skippedNoLumastraAccountByProvider' -> 'jellyfin-watch-sync' AS names
          FROM task_history
         WHERE task_id = 'watch-sync-pull'
           AND state = 'completed'
           AND duration_ms IS NOT NULL
           AND completed_at > NOW() - INTERVAL '1 hour'
           AND result -> 'result' -> 'meta' -> 'skippedNoLumastraAccountByProvider' -> 'jellyfin-watch-sync' IS NOT NULL
         ORDER BY completed_at DESC
         LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { count: 0, names: [] };
    const names = Array.isArray(row.names)
        ? row.names.filter((n): n is string => typeof n === 'string')
        : [];
    return { count: row.count ?? names.length, names };
}
