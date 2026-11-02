// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stage Sweep Query Module
 *
 * Pure SQL primitives for the `stage-sweep` task — the leader-only periodic
 * task that drains `media_item_stage_state` by enqueuing per-item runs of the
 * owning task. See `src/lib/server/tasks/builtin/native/stage-sweep.ts`.
 *
 * The two predicates here are intentionally identical aside from `LIMIT` /
 * `COUNT(*)`:
 *
 *   status IN ('pending','failed_transient','skipped_transient','obsolete')
 *   AND (next_eligible_at IS NULL OR next_eligible_at <= now())
 *   AND media_items.is_dismissed = false
 *
 * Both queries are O(index range scan) — the partial index
 * `idx_stage_state_sweep` covers the four sweepable statuses. The EXISTS
 * subquery against `media_items` is a belt-and-braces guard so the sweeper
 * never enqueues for a soft-dismissed item even if `afterDismissed`'s row
 * deletion lags (the spec's `afterDismissed` deletes coverage rows, but a
 * defensive filter here costs nothing and prevents resurrection bugs).
 */

import type postgres from 'postgres';
import type { StageDispositionFragment } from '$lib/types/pipeline.js';

export interface SweepCandidate {
    media_item_id: string;
    status: string;
    attempt: number;
}

/**
 * Return up to `limit` rows from `media_item_stage_state` that are eligible
 * for the sweeper to enqueue, ordered FIFO with backoff respected
 * (`next_eligible_at ASC NULLS FIRST, updated_at ASC`).
 *
 * Rows with `next_eligible_at` in the future are excluded — that's how the
 * exponential backoff window applies to `failed_transient` /
 * `skipped_transient`. Rows belonging to soft-dismissed items are also
 * excluded as a defensive guard.
 */
export async function findSweepCandidates(
    sql: postgres.Sql,
    stageId: string,
    limit: number,
): Promise<SweepCandidate[]> {
    // System sweep query — operates on the whole catalog for background stage
    // processing; no per-user access scoping applies.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return await sql<SweepCandidate[]>`
        SELECT s.media_item_id::text AS media_item_id,
               s.status,
               s.attempt
          FROM media_item_stage_state s
         WHERE s.stage_id = ${stageId}
           AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
           AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
           AND EXISTS (
               SELECT 1
                 FROM media_items mi
                WHERE mi.id = s.media_item_id
                  AND COALESCE(mi.is_dismissed, false) = false
                  AND mi.status = 'active'
           )
         ORDER BY s.next_eligible_at ASC NULLS FIRST, s.updated_at ASC
         LIMIT ${limit}
    `;
}

/**
 * Does ANY of these stages have work waiting right now?
 *
 * Exists so the sweeper's first-impression reserve can be use-it-or-lose-it.
 * Reserving budget for stages that have nothing to do does not redistribute
 * that budget — it burns it, permanently capping the sweeper below its own
 * limit once artwork is backfilled and only previews/embeddings remain.
 *
 * Same predicate as {@link findSweepCandidates}, with `LIMIT 1` and no
 * ordering: the question is existence, not which row.
 */
export async function hasSweepCandidatesForStages(
    sql: postgres.Sql,
    stageIds: string[],
): Promise<boolean> {
    if (stageIds.length === 0) return false;
    // LATERAL over the stage ids, NOT `stage_id = ANY(...)`.
    //
    // `idx_stage_state_sweep` is (stage_id, status, next_eligible_at) and the
    // ANY form did not use it: the planner costed `LIMIT 1` as cheap, chose a
    // sequential scan, and then — because the answer is normally NO ROWS — had
    // to read the whole table to prove it. Measured on preprod: 181,312 rows
    // filtered, 3,022 buffers, 32.6 ms. On a 60-second loop, on a table that
    // only grows.
    //
    // One equality probe per stage makes the index usable: 8 buffers, 0.11 ms.
    // The EXISTS stays INSIDE the lateral so a stage whose only rows belong to
    // dismissed or deleted items is correctly reported as having no work.
    //
    // System sweep query — same scoping rationale as findSweepCandidates.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
          FROM unnest(${sql.array(stageIds)}::text[]) AS t(stage_id)
         CROSS JOIN LATERAL (
             SELECT 1
               FROM media_item_stage_state s
              WHERE s.stage_id = t.stage_id
                AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
                AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
                AND EXISTS (
                    SELECT 1
                      FROM media_items mi
                     WHERE mi.id = s.media_item_id
                       AND COALESCE(mi.is_dismissed, false) = false
                       AND mi.status = 'active'
                )
              LIMIT 1
         ) x
         LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * Find media_items that should have coverage rows but don't.
 *
 * Self-heal compensation for code paths that create `media_items` rows
 * without firing `MediaLifecycleService.afterCreated` — those rows have
 * ZERO `media_item_stage_state` entries and are invisible to the sweeper's
 * normal per-stage scan. Migration 16.7.0 reseeded historical rows; this
 * helper feeds the ongoing self-heal phase in the stage-sweep task.
 *
 * Returns up to `limit` IDs ordered by `created_at ASC` (oldest first) so
 * the sweeper catches up chronologically as it drains.
 *
 * Excludes:
 *  - dismissed items (no coverage needed)
 *  - media_types that don't appear in any registered stage's `appliesTo`
 *    (callers pass the union of stage `appliesTo` sets to keep the SQL
 *    side filtered and the index range scan tight)
 *
 * Query plan: at 158k items, filter by `media_type = ANY(...)` first
 * (small selectivity for music libraries), then NOT EXISTS probes
 * `idx_stage_state_item` per remaining row. The partial existence check
 * is bounded by O(N log N) total in the worst case.
 *
 * enable_nestloop is off (LOCAL to this transaction) so the anti join is a
 * hash join. The default nested loop probed the stage_state primary key once
 * per media item (~154k probes, 1.0-1.2 s on prod once the backlog drains);
 * the hash plan takes ~0.3-0.5 s with an identical result.
 */
export async function findItemsMissingCoverage(
    sql: postgres.Sql,
    coveredMediaTypes: ReadonlyArray<string>,
    limit: number,
): Promise<Array<{ id: string }>> {
    if (coveredMediaTypes.length === 0) return [];
    return await sql.begin(async (tx) => {
        await tx`SELECT set_config('enable_nestloop', 'off', true)`;
        // System sweep query — whole-catalog background processing; no per-user
        // access scoping applies.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        return await tx<{ id: string }[]>`
            SELECT mi.id::text AS id
              FROM media_items mi
             WHERE COALESCE(mi.is_dismissed, false) = false
               AND mi.status = 'active'
               AND mi.media_type = ANY(${coveredMediaTypes}::text[])
               AND NOT EXISTS (
                   SELECT 1 FROM media_item_stage_state s
                    WHERE s.media_item_id = mi.id
               )
             ORDER BY mi.created_at ASC
             LIMIT ${limit}
        `;
    });
}

/**
 * Find media_items that should have a row for ONE SPECIFIC stage but don't.
 *
 * 🔴 The gap {@link findItemsMissingCoverage} structurally cannot see. That
 * one asks "does this item have ANY stage row", which is the right question
 * only for an item the lifecycle hook missed entirely. It is the wrong
 * question for an item that has rows for fifteen stages and is missing the
 * sixteenth — and that is the far more common shape, because seeding writes
 * rows for whatever `registry.getAllTasks()` returns AT THAT MOMENT
 * (`StageStateService.applicableStages`). Any stage whose coverage was
 * declared after an item was seeded is absent for that item forever.
 *
 * Observed on prod 2026-08-21: ~10,900 items seeded in a four-day window in
 * June carry `media-probe-a/-b`, `trickplay-params-sync` and
 * `lumastra-intro-analyzer` rows but no `trickplay-generation`, `image-sync`
 * or `integrity-file-present` row. 11,186 items had no trickplay coverage and
 * the sweep reported a clean backlog throughout — an item with no row is not
 * "pending", it is invisible. Three stages, ~11k items each, silent.
 *
 * Scoped by `appliesTo` so the caller only pays for media types the stage
 * actually covers, and ordered oldest-first so the backfill is chronological
 * and its progress is legible.
 *
 * enable_nestloop is turned off (LOCAL to the transaction) only when the
 * stage covers episodes or tracks. Measured on prod 2026-09-29 for every
 * stage/type set the sweep issues, alternating runs:
 *  - sets with episode/track (60k-112k candidates): hash plan 110-140 ms vs
 *    the default nested loop 340-550 ms (one primary-key probe per item);
 *  - tv / season / artist / album alone (3k-7k candidates): the hash plan
 *    seq-scans all 1.5M stage rows (55-85 ms) while the default plan needs
 *    16-36 ms, so an unconditional hint made these ~2.5x slower;
 *  - movie / movie+tv: a tie.
 * Only the plan changes, never which items qualify. (Ties on created_at were
 * already broken arbitrarily before; the query has no tiebreaker.)
 */
export async function findItemsMissingStageRow(
    sql: postgres.Sql,
    stageId: string,
    appliesTo: ReadonlyArray<string>,
    limit: number,
): Promise<Array<{ id: string }>> {
    if (appliesTo.length === 0) return [];
    const hashJoin = appliesTo.includes('episode') || appliesTo.includes('track');
    return await sql.begin(async (tx) => {
        if (hashJoin) await tx`SELECT set_config('enable_nestloop', 'off', true)`;
        // System sweep query — whole-catalog background processing; no per-user
        // access scoping applies.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        return await tx<{ id: string }[]>`
            SELECT mi.id::text AS id
              FROM media_items mi
             WHERE COALESCE(mi.is_dismissed, false) = false
               AND mi.status = 'active'
               AND mi.media_type = ANY(${tx.array([...appliesTo])}::text[])
               AND NOT EXISTS (
                   SELECT 1 FROM media_item_stage_state s
                    WHERE s.media_item_id = mi.id
                      AND s.stage_id = ${stageId}
               )
             ORDER BY mi.created_at ASC
             LIMIT ${limit}
        `;
    });
}

/**
 * Upper bound on `countSweepBacklog` — the count scan stops here so a
 * multi-100k sweepable backlog can't make the per-tick observability count an
 * unbounded scan. A returned value equal to this means "at least this many".
 */
export const BACKLOG_COUNT_CEILING = 10001;

/**
 * Count the total backlog for a stage, applying the same predicate as
 * `findSweepCandidates`. Used for sweeper observability (run summary log,
 * /admin/tasks/[stage-sweep] panel). Bounded by {@link BACKLOG_COUNT_CEILING}.
 */
export async function countSweepBacklog(sql: postgres.Sql, stageId: string): Promise<number> {
    // Bounded count (D7): cap the scan at BACKLOG_COUNT_CEILING rows via a
    // LIMIT subquery so a multi-100k sweepable backlog on a fresh large install
    // can't turn this per-tick-per-stage count into an unbounded scan. Callers
    // only need "is the backlog small / large / huge"; a returned value of
    // BACKLOG_COUNT_CEILING means ">= that" (i.e. "10000+").
    //
    // System sweep count — whole-catalog background processing; no per-user
    // access scoping applies.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
          FROM (
              SELECT 1
                FROM media_item_stage_state s
               WHERE s.stage_id = ${stageId}
                 AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
                 AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
                 AND EXISTS (
                     SELECT 1
                       FROM media_items mi
                      WHERE mi.id = s.media_item_id
                        AND COALESCE(mi.is_dismissed, false) = false
                        AND mi.status = 'active'
                 )
               LIMIT ${BACKLOG_COUNT_CEILING}
          ) capped
    `;
    return parseInt(rows[0]?.n ?? '0', 10);
}

/**
 * Generic event-INDEPENDENT re-enroll heal — the declarative replacement for
 * the former bespoke `reEnrollMisSkipped*` functions.
 *
 * A stage that gates on upstream-populated data (probe streams, file linkage,
 * provider ids) can have its rows wrongly disposed `skipped_permanent` at seed
 * time, BEFORE the upstream stage runs — and `skipped_permanent` is never
 * re-swept (`findSweepCandidates`). The intended recovery (an invalidation
 * event re-evaluating eligibility) is loss-prone (dispatcher lag / leaderless
 * window / dropped outbox row, or — for media-probe — no event emitted at all).
 *
 * This rail is event-INDEPENDENT: it re-queries CURRENT DB state each tick and
 * flips `skipped_permanent` rows back to `pending` wherever the stage's declared
 * positive `eligibility.sql` fragment is now TRUE. `eligibleWhere` is the
 * already-built fragment and must reference alias `mi` (media_items). Only
 * matches recoverable rows, so it makes forward progress and is a no-op once
 * drained. Bounded by `limit`; idempotent; re-asserts `skipped_permanent` under
 * READ COMMITTED so a concurrent change isn't clobbered. Returns the count flipped.
 *
 * `hashJoin` turns enable_nestloop off (LOCAL to one transaction) so the
 * stage_state to media_items join is hashed instead of one primary-key probe
 * per skipped row. That only pays off when eligibleWhere is cheap per row
 * (media-probe, trickplay, poster/backdrop artwork: 30-50% faster on prod).
 * For fragments with correlated EXISTS walks it is far worse: MAL enrichment
 * went from ~25 ms to ~1.5 s, because Postgres then hashes whole tables. So
 * it is opt-in per stage (HEAL_HASH_JOIN_STAGES in stage-sweep.ts). Either way
 * the query and the updated row set are the same; only the plan differs.
 *
 * `lateFilter` keeps the eligibility fragment from being pushed down to the
 * `media_items` scan. By default Postgres applies it to `mi` before the join,
 * and (for EXISTS) turns it into a semi-join that can drive from the whole
 * catalog: for acoustid-fingerprint that means walking every track and
 * detoasting its `custom_metadata` (147k rows) to find the ~10k skipped rows
 * that matter, 1.1 to 1.5 s per call on prod. Wrapping the fragment in
 * `(<fragment>) OR s2.stage_id IS DISTINCT FROM s2.stage_id` makes it a join
 * filter: it is evaluated only for rows that already passed the cheap
 * stage_state predicates (one primary-key probe per skipped row). The second
 * disjunct is never TRUE and never NULL, so `x OR FALSE` is `x` for TRUE, FALSE
 * and NULL alike; the row set is identical. Opt-in per stage, because it only
 * pays off when the skipped set is much smaller than the catalog (it was
 * measured worse for music-analysis, sonic-embedding and the season poster).
 */
export async function reEnrollMisSkippedStage(
    sql: postgres.Sql,
    opts: {
        stageId: string;
        eligibleWhere: StageDispositionFragment;
        reasons: readonly string[];
        limit: number;
        hashJoin?: boolean;
        lateFilter?: boolean;
    },
): Promise<number> {
    const { stageId, eligibleWhere, reasons, limit, hashJoin = false, lateFilter = false } = opts;
    // `s2.stage_id IS DISTINCT FROM s2.stage_id` is constant FALSE (see above); it
    // only exists so the planner treats the fragment as a join clause.
    const eligibleClause = lateFilter
        ? sql`((${eligibleWhere}) OR s2.stage_id IS DISTINCT FROM s2.stage_id)`
        : sql`(${eligibleWhere})`;
    const heal = async (q: postgres.Sql): Promise<number> => {
        // System sweep heal — whole-catalog background processing; no per-user
        // access scoping applies.
        const rows = await q<{ media_item_id: string }[]>`
            UPDATE media_item_stage_state s
               SET status = 'pending',
                   attempt = 0,
                   declines = 0,
                   declines_since = NULL,
                   skipped_reason = NULL,
                   last_error = NULL,
                   started_at = NULL,
                   completed_at = NULL,
                   next_eligible_at = now(),
                   updated_at = now()
              FROM (
                  SELECT s2.media_item_id
                    FROM media_item_stage_state s2
                    JOIN media_items mi ON mi.id = s2.media_item_id
                   WHERE s2.stage_id = ${stageId}
                     AND s2.status = 'skipped_permanent'
                     AND s2.skipped_reason = ANY(${reasons as string[]})
                     AND mi.status = 'active'
                     -- Must mirror findSweepCandidates' dismissal gate. Without it this
                     -- heal flips a DISMISSED item's row to 'pending', and the sweep can
                     -- then never pick it up again (findSweepCandidates excludes
                     -- dismissed) — a one-way leak into a permanently stranded state.
                     -- The population at risk is real: prod carried 2466 seasons wrongly
                     -- dismissed by migration 13.0.0, every one of which satisfies the
                     -- season-poster eligibility fragment.
                     AND COALESCE(mi.is_dismissed, false) = false
                     AND ${eligibleClause}
                   -- media_item_id tiebreaker keeps the LIMIT slice deterministic
                   -- when many rows share updated_at (e.g. a bulk seed/migration);
                   -- progress is guaranteed regardless since flipped rows leave the
                   -- skipped_permanent set, but determinism aids tests + fairness.
                   ORDER BY s2.updated_at ASC, s2.media_item_id ASC
                   LIMIT ${limit}
              ) t
             WHERE s.media_item_id = t.media_item_id
               AND s.stage_id = ${stageId}
               -- Re-assert status so a row that concurrently changed (e.g. the
               -- owning task just completed it) under READ COMMITTED isn't flipped.
               AND s.status = 'skipped_permanent'
            RETURNING s.media_item_id
        `;
        return rows.length;
    };
    if (!hashJoin) return await heal(sql);
    return await sql.begin(async (tx) => {
        await tx`SELECT set_config('enable_nestloop', 'off', true)`;
        return await heal(tx);
    });
}

/**
 * EXTERNAL-PLUGIN eligibility path support: load a bounded page of
 * `skipped_permanent` rows for a stage whose `skipped_reason` is one the heal
 * pass reclaims. Used only by stages that declare `eligibility.appliesTo` with
 * NO `eligibility.sql` (external plugins — no host `sql` fragment to bulk-heal
 * with), so the sweep can re-evaluate the TS predicate per row. Native stages
 * use the bulk `reEnrollMisSkippedStage` instead. Bounded by `limit`.
 */
export async function findSkippedPermanentByReasons(
    sql: postgres.Sql,
    stageId: string,
    reasons: readonly string[],
    limit: number,
): Promise<{ media_item_id: string }[]> {
    if (reasons.length === 0 || limit <= 0) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return await sql<{ media_item_id: string }[]>`
        SELECT s.media_item_id
          FROM media_item_stage_state s
          JOIN media_items mi ON mi.id = s.media_item_id
         WHERE s.stage_id = ${stageId}
           AND s.status = 'skipped_permanent'
           AND s.skipped_reason = ANY(${reasons as string[]})
           AND mi.status = 'active'
           -- Same dismissal gate as findSweepCandidates / reEnrollMisSkippedStage:
           -- this feeds markPendingByIds, so omitting it strands the row exactly as
           -- described there.
           AND COALESCE(mi.is_dismissed, false) = false
         ORDER BY s.updated_at ASC, s.media_item_id ASC
         LIMIT ${limit}
    `;
}

/**
 * Flip a batch of `skipped_permanent` rows back to `pending` for a stage (the
 * external eligibility heal's write step — the per-row analogue of
 * `reEnrollMisSkippedStage`'s bulk UPDATE). Re-asserts `skipped_permanent` so a
 * row a concurrent run already advanced isn't clobbered. Returns the count flipped.
 */
export async function markPendingByIds(
    sql: postgres.Sql,
    stageId: string,
    mediaItemIds: string[],
): Promise<number> {
    if (mediaItemIds.length === 0) return 0;
    const rows = await sql<{ media_item_id: string }[]>`
        UPDATE media_item_stage_state
           SET status = 'pending',
               attempt = 0,
               declines = 0,
               declines_since = NULL,
               skipped_reason = NULL,
               last_error = NULL,
               started_at = NULL,
               completed_at = NULL,
               next_eligible_at = now(),
               updated_at = now()
         WHERE stage_id = ${stageId}
           AND media_item_id = ANY(${mediaItemIds}::uuid[])
           AND status = 'skipped_permanent'
        RETURNING media_item_id
    `;
    return rows.length;
}
