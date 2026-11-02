// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * StageDispositionRunner — Declarative Stage Contract (Phase 1 + Phase 3).
 *
 * Executes a stage's declared `terminalDisposition` AND its `eligibility`
 * dispose pass in a single pre-enqueue call so disposed rows leave the backlog
 * in the same tick with one framework function instead of two.
 *
 * Variants:
 *   - `predicate`     → canonical bulk UPDATE driven by the declared `excludes`
 *                       SQL fragment; `disposeAs` chooses the terminal status.
 *   - `global-guard`  → run `guard(ctx)`; on false → drain whole stage to
 *                       `skipped_transient`; on true → no-op.
 *   - `self-terminal` → no-op (handled at runtime by wedge-guard Invariant 2).
 *   - array           → run each in declaration order.
 *
 * After the author `terminalDisposition` variants have run, the eligibility
 * dispose pass runs (the negative half of the unified `eligibility` contract)
 * unless `skipAutoDispose` is set. Order is invariant: author disposition
 * always fires BEFORE the eligibility dispose. This matters for stages like
 * `music-embedding-generation` where the author disposes `skipped_transient`
 * and the eligibility negation must not re-stamp those rows.
 *
 * Column semantics mirror the established batch helpers in
 * `stage-state.queries.ts` (`markSkippedPermanentBatch` /
 * `markSkippedTransientBatch` / `markCompletedBatch`) — same sweepable status
 * guard, same column set — so the framework UPDATE is the generalisation of
 * the per-task SQL it replaces. The `predicate` path hand-builds the UPDATE
 * only because the batch helpers take an id array, not a `sql` fragment.
 *
 * PHASE 3 NOTE: `StageDispositionRunResult` (the single-field wrapper object)
 * has been deleted. `runStageDisposition` now returns `Promise<number>` (total
 * rows disposed across all author variants + eligibility dispose). Call sites
 * use the bare number directly.
 */

import type postgres from 'postgres';
import {
    markAllPendingSkippedTransientForStage,
    markSkippedPermanentBatch,
} from '$lib/server/database/queries/stage-state.queries.js';
import { reEnrollMisSkippedStage } from '$lib/server/database/queries/stage-sweep.queries.js';
import type {
    StageTerminalDisposition,
    StageGuardContext,
    StageDispositionFragment,
    StageEligibility,
    MediaItemSnapshot,
} from '$lib/types/pipeline.js';

/** Framework-reserved skip reason written by the eligibility dispose pass. */
export const ELIGIBILITY_SKIP_REASON = 'ineligible';

/**
 * The minimal stage shape this runner needs. Accepts the SDK or host-mirror
 * `CoversStagesDeclaration` structurally — we only read `id`,
 * `terminalDisposition`, and `eligibility`.
 */
interface DispositionStage {
    id: string;
    terminalDisposition?: StageTerminalDisposition | ReadonlyArray<StageTerminalDisposition>;
    eligibility?: StageEligibility;
}

/**
 * The stage's GATE predicates: author `predicate` dispositions whose skips the
 * sweep must reclaim once the predicate stops matching, even while the item is
 * still not eligible.
 *
 * A gate is a predicate that writes `skipped_permanent` under a reason the stage
 * also lists in `eligibility.recoverWhenAdditionalReasons` — "turned off",
 * "no API key", "no engine on this host". The eligibility heal reclaims those
 * rows only when eligibility is TRUE, i.e. when EVERY gate is open. A row whose
 * own gate opened while another stays closed would otherwise keep a reason that
 * is no longer true ("disabled" for a feature that is on), telling the operator
 * to fix the wrong thing. Flipping it back to `pending` lets the same tick's
 * dispose pass (which runs after the heal and before any enqueue) re-stamp it
 * with whichever reason holds now, or the generic eligibility skip.
 *
 * Excluded: readiness-gated predicates (`requiresQuietUpstream`,
 * `requiresUpstreamRun`), whose "not matching" can mean "not decided yet"; and
 * stages that opt out of the eligibility dispose, which would leave a reclaimed
 * ineligible row pending.
 */
export function reopenableGatePredicates(
    stage: DispositionStage,
): Array<{ reason: string; excludes: (sql: postgres.Sql) => StageDispositionFragment }> {
    const elig = stage.eligibility;
    if (!elig?.sql || elig.skipAutoDispose === true) return [];
    const recoverable = new Set(elig.recoverWhenAdditionalReasons ?? []);
    const eligibilityReason = elig.skipReason ?? ELIGIBILITY_SKIP_REASON;
    const disposition = stage.terminalDisposition;
    const list =
        disposition === undefined ? [] : Array.isArray(disposition) ? disposition : [disposition];
    const gates: Array<{
        reason: string;
        excludes: (sql: postgres.Sql) => StageDispositionFragment;
    }> = [];
    for (const d of list as readonly StageTerminalDisposition[]) {
        if (d.kind !== 'predicate' || d.disposeAs !== 'skipped_permanent') continue;
        if (d.requiresQuietUpstream !== undefined || d.requiresUpstreamRun !== undefined) continue;
        if (d.reason === eligibilityReason || !recoverable.has(d.reason)) continue;
        gates.push({ reason: d.reason, excludes: d.excludes });
    }
    return gates;
}

/**
 * The gate re-label heal pass for one stage (see {@link reopenableGatePredicates}):
 * flip `skipped_permanent` rows back to `pending` where the gate that stamped
 * their reason no longer matches, then re-run the stage's dispose at once, so
 * each flipped row is re-stamped with the reason that holds now (or stays
 * `pending` because it is now genuinely eligible). Doing both here, rather than
 * leaving the re-stamp to the sweep's later dispose phase, means a tick cut
 * short by its deadline cannot leave an ineligible row `pending` for the
 * enqueue. Returns the rows flipped.
 *
 * - NULL-safe: a gate whose fragment yields NULL for a row counts as "does not
 *   match" (`IS NOT TRUE`), never as "unknown, leave stuck".
 * - Gates sharing a reason are ANDed: a row is only released once EVERY gate
 *   that could have stamped that reason is open, so two gates with one reason
 *   cannot flip a row back and forth.
 */
export async function reEnrollReopenedGates(
    sql: postgres.Sql,
    stage: DispositionStage,
    limit: number,
    ctx: StageGuardContext,
    opts: { hashJoin?: boolean; lateFilter?: boolean } = {},
): Promise<number> {
    const byReason = new Map<string, Array<(sql: postgres.Sql) => StageDispositionFragment>>();
    for (const gate of reopenableGatePredicates(stage)) {
        const list = byReason.get(gate.reason) ?? [];
        list.push(gate.excludes);
        byReason.set(gate.reason, list);
    }
    let reEnrolled = 0;
    for (const [reason, excludesList] of byReason) {
        const stillClosed = excludesList.reduce<StageDispositionFragment | null>(
            (acc, excludes) => (acc ? sql`${acc} OR (${excludes(sql)})` : sql`(${excludes(sql)})`),
            null,
        );
        reEnrolled += await reEnrollMisSkippedStage(sql, {
            stageId: stage.id,
            eligibleWhere: sql`(${stillClosed}) IS NOT TRUE`,
            reasons: [reason],
            limit,
            hashJoin: opts.hashJoin,
            lateFilter: opts.lateFilter,
        });
    }
    if (reEnrolled > 0) await runStageDisposition(sql, stage, ctx);
    return reEnrolled;
}

/**
 * Execute the declared `terminalDisposition` variants for one stage, then run
 * the eligibility dispose pass. Returns the total number of rows disposed
 * across both passes. No-op for each pass that has nothing to do.
 *
 * Author disposition runs BEFORE the eligibility dispose (a stable convention).
 * For `music-embedding-generation` the rows the author skips
 * (`skipped_transient`, "embedding up-to-date") and the rows the eligibility
 * negation skips (`skipped_permanent`, "no file/audio") are normally DISJOINT:
 * a fresh music embedding implies the track had an audio stream, so the
 * eligibility negation `NOT (has_file AND has_audio)` is false for exactly those
 * rows. That ORTHOGONALITY — not the ordering — is what keeps the author's
 * transient skip from being re-stamped permanent.
 *
 * Residual edge (PRE-EXISTING, not introduced by this merge): if the audio
 * stream is detached AFTER the embedding is written, the negation matches a row
 * the author just set `skipped_transient`. The `skipped_permanent` UPDATE path
 * DOES carry the same `next_eligible_at <= now()` guard as the
 * `skipped_transient` path (both are L4-guarded — see `runPredicate`), so while
 * that row is still inside its transient backoff window the eligibility
 * dispose correctly leaves it alone; only once the backoff elapses (or
 * `next_eligible_at` is NULL) does the negation re-stamp it permanent. Rare and
 * re-checkable on invalidation; flagged for a future targeted fix rather than
 * addressed here (this is a behaviour-preserving refactor).
 *
 * Each pass is isolated internally (independent try/catch), so a failure in one
 * pass never suppresses the other and this function does not throw on a per-pass
 * disposition error; it returns the sum of rows successfully disposed. The
 * stage-sweep caller keeps an outer try/catch as defense-in-depth.
 */
export async function runStageDisposition(
    sql: postgres.Sql,
    stage: DispositionStage,
    ctx: StageGuardContext,
    opts?: { loadCandidates?: LoadEligibilityCandidates; limit?: number },
): Promise<number> {
    let rowsDisposed = 0;

    // --- Author terminalDisposition variants (fired in declaration order) ---
    // Each variant is ISOLATED in its own try/catch: a failing author variant
    // must never suppress the remaining variants OR the eligibility pass below.
    // This preserves the pre-merge behaviour where stage-sweep wrapped the
    // author pass and the eligibility pass in INDEPENDENT try/catch blocks — so
    // a transient error in one pass only costs that pass's work for one tick,
    // not both. We still return the sum of rows successfully disposed.
    const disposition = stage.terminalDisposition;
    if (disposition !== undefined) {
        const list = Array.isArray(disposition) ? disposition : [disposition];
        for (const d of list) {
            try {
                rowsDisposed += await runOne(sql, stage.id, d, ctx);
            } catch (err) {
                ctx.logger.warn('stage disposition: terminalDisposition variant failed', {
                    stageId: stage.id,
                    kind: d.kind,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    // --- Eligibility dispose pass (negative half of the unified `eligibility`
    //     contract) — runs AFTER the author disposition. Demotes sweepable rows
    //     the stage should NOT run on to `skipped_permanent/'ineligible'`
    //     (re-checkable). Skipped when `skipAutoDispose` is set (e.g.
    //     mal-anime-id-enrichment, where the upstream-gated author disposition
    //     handles the skip and the eligibility negation must not fire
    //     prematurely). Isolated from the author pass above (see note). ---
    if (stage.eligibility !== undefined && stage.eligibility.skipAutoDispose !== true) {
        try {
            rowsDisposed += await runEligibilityDispose(sql, stage, opts);
        } catch (err) {
            ctx.logger.warn('stage disposition: eligibility dispose failed', {
                stageId: stage.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return rowsDisposed;
}

async function runOne(
    sql: postgres.Sql,
    stageId: string,
    d: StageTerminalDisposition,
    ctx: StageGuardContext,
): Promise<number> {
    switch (d.kind) {
        case 'predicate':
            return await runPredicate(sql, stageId, d);
        case 'global-guard':
            return await runGlobalGuard(sql, stageId, d, ctx);
        case 'self-terminal':
            // No bulk step — wedge-guard Invariant 2 provides runtime detection.
            return 0;
        default:
            return 0;
    }
}

/**
 * Run the canonical bulk-drain UPDATE for a `predicate` disposition. The
 * `excludes` fragment (host `sql\`…\``) is embedded via `${...}`; it names the
 * ineligibility condition over aliases `mi` (media_items) and `s`
 * (media_item_stage_state).
 */
/**
 * Build the "source files are QUIET" fragment for a `requiresQuietUpstream`
 * gate. TRUE when the relevant file set's freshest timestamp
 * (`created_at` / `file_mtime` / `updated_at`) is older than `windowMs` — OR
 * when there are no files at all (COALESCE to `epoch`, which is always older →
 * disposed immediately, since a genuinely file-less item is correctly
 * terminal). FALSE while files are still arriving, so the row is left
 * sweepable and re-evaluated next tick.
 *
 * `scope: 'self'` gates on files linked to the item itself (`mi.id`);
 * `scope: 'parent'` gates on files of every item sharing `mi.parent_id`
 * (season-aggregate predicates).
 */
/**
 * Exported so health-invariants' stage-wedge-guard Check 1a can compose the
 * SAME gate the real disposer applies (see `buildUpstreamRunFragment` below)
 * — the invariant asks "would the real disposer have cleared this row by
 * now?", so its candidate query must mirror every AND-composed gate here or
 * it false-fires on rows correctly waiting on a `requiresQuietUpstream` feeder.
 */
export function buildQuietUpstreamFragment(
    sql: postgres.Sql,
    gate: { windowMs: number; scope: 'self' | 'parent' },
): StageDispositionFragment {
    const windowSecs = gate.windowMs / 1000;
    const freshest =
        gate.scope === 'parent'
            ? sql`
                SELECT MAX(GREATEST(mf.created_at,
                                    COALESCE(mf.file_mtime, mf.created_at),
                                    mf.updated_at))
                  FROM media_items sib
                  JOIN media_file_items mfi ON mfi.media_item_id = sib.id
                  JOIN media_files mf ON mf.id = mfi.file_id
                 -- mi.parent_id IS NOT NULL guard: SQL NULL = NULL never matches,
                 -- so without it a parent-less item would treat ALL other
                 -- parent-less items as its siblings. Explicit so the intent is
                 -- clear and the gate stays correct for any future scope:'parent'
                 -- caller whose items can have a null parent.
                 WHERE mi.parent_id IS NOT NULL
                   AND sib.parent_id = mi.parent_id`
            : sql`
                SELECT MAX(GREATEST(mf.created_at,
                                    COALESCE(mf.file_mtime, mf.created_at),
                                    mf.updated_at))
                  FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                 WHERE mfi.media_item_id = mi.id`;
    return sql`COALESCE((${freshest}), 'epoch'::timestamptz) < now() - make_interval(secs => ${windowSecs})`;
}

/**
 * Gate for `requiresUpstreamRun`: TRUE only when the named upstream stage has a
 * TERMINAL row for the same item, so a disposition can't fire before its feeder
 * has run. References alias `s` (the target media_item_stage_state row, in scope
 * in the disposition UPDATE). No upstream row / a still-pending upstream →
 * EXISTS is false → the skip is suppressed (gate closed), which is the desired
 * "wait for the feeder" behaviour.
 */
/**
 * Exported so health-invariants' stage-wedge-guard Check 1a can compose the
 * SAME gate the real disposer applies — see `buildQuietUpstreamFragment`
 * above for why the invariant needs both.
 */
export function buildUpstreamRunFragment(
    sql: postgres.Sql,
    upstreamStageId: string,
): StageDispositionFragment {
    return sql`EXISTS (
        SELECT 1 FROM media_item_stage_state u
         WHERE u.media_item_id = s.media_item_id
           AND u.stage_id = ${upstreamStageId}
           AND u.status IN ('completed', 'skipped_permanent', 'failed_permanent')
    )`;
}

/**
 * Sweepable status guard shared with the batch helpers in
 * `stage-state.queries.ts`. A disposition only touches rows that the sweeper
 * would otherwise re-enqueue; `running` / `completed` / `skipped_permanent` /
 * `failed_permanent` rows are deliberately untouched.
 *
 * Keep these statuses as SQL literals in runPredicate: a bound ANY array
 * prevents generic prepared plans from proving the predicate of the existing
 * idx_stage_state_sweep / idx_stage_state_queue_position partial indexes.
 *
 * Includes `'obsolete'` so this set matches `findSweepCandidates`' enqueueable
 * set EXACTLY — otherwise an ineligible row demoted to `obsolete` (WI-10: a
 * completed result invalidated mid-run) would be enqueued by the sweep without
 * the eligibility/terminal dispose first removing it (a no-op-run gap).
 */
async function runPredicate(
    sql: postgres.Sql,
    stageId: string,
    d: Extract<StageTerminalDisposition, { kind: 'predicate' }>,
): Promise<number> {
    // Build the host fragment with OUR sql (the disposition's own connection),
    // then embed it. `excludes` is typed `StageDispositionFragment`
    // (= postgres.PendingQuery<Row[]>), so this is a real driver fragment, not a
    // string — it embeds natively into the UPDATE below via `${excludes}`.
    // When the rule declares `requiresQuietUpstream`, AND-compose the
    // "files have stopped arriving" gate so a terminal skip cannot fire against
    // a still-populating linkage view on a fresh large install.
    let excludes = d.excludes(sql);
    if (d.requiresQuietUpstream) {
        // CASE, not AND: the quiet gate is a per-row sibling-file aggregate on `mi`
        // alone, so the planner applies it to every sweepable row before the join,
        // ahead of the predicate that usually rejects the row. CASE fixes the order
        // (predicate first); in a WHERE clause `CASE WHEN a THEN b ELSE false END`
        // keeps exactly the rows `a AND b` keeps (NULL and false both reject).
        excludes = sql`CASE WHEN (${excludes}) THEN (${buildQuietUpstreamFragment(sql, d.requiresQuietUpstream)}) ELSE false END`;
    }
    // requiresUpstreamRun: don't terminal-skip until the named feeder stage has
    // a terminal row for this item (e.g. fribb-anime-sync before mal 'not-anime').
    if (d.requiresUpstreamRun) {
        excludes = sql`(${excludes}) AND (${buildUpstreamRunFragment(sql, d.requiresUpstreamRun)})`;
    }

    if (d.disposeAs === 'completed') {
        // Mirrors markCompletedBatch column semantics (sets completed_at,
        // clears last_error). Guard skips rows already completed.
        const result = await sql`
			UPDATE media_item_stage_state s
			   SET status = 'completed',
			       last_error = NULL,
			       skipped_reason = ${d.reason},
			       next_eligible_at = NULL,
			       completed_at = now(),
			       declines = 0,
			       declines_since = NULL,
			       updated_at = now()
			  FROM media_items mi
			 WHERE mi.id = s.media_item_id
			   AND s.stage_id = ${stageId}
			   AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
			   AND ${excludes}
		`;
        return result.count ?? 0;
    }

    if (d.disposeAs === 'skipped_transient') {
        // Mirrors markSkippedTransientBatch column semantics (retry backoff).
        const retryAfterMs = d.retryAfterMs ?? 0;
        const result = await sql`
			UPDATE media_item_stage_state s
			   SET status = 'skipped_transient',
			       skipped_reason = ${d.reason},
			       next_eligible_at = now() + make_interval(secs => ${retryAfterMs / 1000}),
			       completed_at = now(),
			       declines = 0,
			       declines_since = NULL,
			       updated_at = now()
			  FROM media_items mi
			 WHERE mi.id = s.media_item_id
			   AND s.stage_id = ${stageId}
			   AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
			   -- L4: only (re)stamp rows eligible NOW, so a row already in
			   -- skipped_transient mid-backoff doesn't have its retry window rolled
			   -- forward every tick (e.g. music-embedding's 6h 'embedding-up-to-date'
			   -- backoff would otherwise never elapse). Re-evaluated when it does.
			   AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
			   AND ${excludes}
		`;
        return result.count ?? 0;
    }

    // disposeAs === 'skipped_permanent' — mirrors markSkippedPermanentBatch
    // (next_eligible_at cleared to NULL; permanent-until-invalidation).
    const result = await sql`
		UPDATE media_item_stage_state s
		   SET status = 'skipped_permanent',
		       skipped_reason = ${d.reason},
		       next_eligible_at = NULL,
		       completed_at = now(),
		       declines = 0,
		       declines_since = NULL,
		       updated_at = now()
		  FROM media_items mi
		 WHERE mi.id = s.media_item_id
		   AND s.stage_id = ${stageId}
		   AND s.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
		   -- L4: never re-stamp a row currently inside a transient backoff window
		   -- (next_eligible_at in the future) to permanent — e.g. a row the author
		   -- disposition just set skipped_transient with a 6h music-embedding backoff.
		   AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
		   AND ${excludes}
	`;
    return result.count ?? 0;
}

/**
 * Run a `global-guard` disposition. On `guard() === false`, drain the whole
 * stage to `skipped_transient` via the established helper; on `true`, no-op.
 */
async function runGlobalGuard(
    sql: postgres.Sql,
    stageId: string,
    d: Extract<StageTerminalDisposition, { kind: 'global-guard' }>,
    ctx: StageGuardContext,
): Promise<number> {
    const ok = await d.guard(ctx);
    if (ok) return 0;
    return await markAllPendingSkippedTransientForStage(sql, {
        stageId,
        skippedReason: d.reason,
        retryAfterMs: d.retryAfterMs,
    });
}

/** Minimal stage shape the eligibility dispose pass needs. */
interface EligibilityStage {
    id: string;
    eligibility?: StageEligibility;
}

/**
 * Loads a bounded page of sweepable rows + their snapshots for a stage. Injected by `stage-sweep` for
 * the EXTERNAL (`appliesTo`-only) eligibility path, which has no host `sql` fragment and must evaluate
 * the plugin's TS predicate per row. Native (`eligibility.sql`) stages never need this — they dispose via
 * one bulk UPDATE.
 */
export type LoadEligibilityCandidates = (
    stageId: string,
    limit: number,
) => Promise<ReadonlyArray<{ mediaItemId: string; snapshot: MediaItemSnapshot }>>;

/**
 * Eligibility dispose pass (the negative half of the unified `eligibility` contract). Demotes sweepable
 * rows the stage should NOT run on to `skipped_permanent/'ineligible'` (re-checkable). Returns the
 * number of rows disposed.
 *
 *  - NATIVE (`eligibility.sql`): one bulk UPDATE over `NOT (<sql>)` via the existing `runPredicate`
 *    machinery. Zero per-row JS at 100k+ scale.
 *  - EXTERNAL (`appliesTo` only): evaluate the TS predicate per row over a bounded candidate page (loaded
 *    via the injected `loadCandidates`) and batch-skip the ones it rejects. Bounded by `limit`.
 *
 * No-op (returns 0) for a stage with no `eligibility` block.
 *
 * Not exported — callers go through `runStageDisposition` which provides the
 * correct author-before-eligibility ordering guarantee.
 */
async function runEligibilityDispose(
    sql: postgres.Sql,
    stage: EligibilityStage,
    opts?: { loadCandidates?: LoadEligibilityCandidates; limit?: number },
): Promise<number> {
    const elig = stage.eligibility;
    if (!elig) return 0;
    const reason = elig.skipReason ?? ELIGIBILITY_SKIP_REASON;

    // NATIVE bulk path — synthesize a `predicate` disposition whose `excludes` is the NEGATION of the
    // positive eligibility fragment, and run it through the canonical bulk-drain UPDATE.
    if (elig.sql) {
        const sqlBuilder = elig.sql;
        return await runPredicate(sql, stage.id, {
            kind: 'predicate',
            ruleId: `${stage.id}-eligibility`,
            disposeAs: 'skipped_permanent',
            reason,
            excludes: (s) => s`NOT (${sqlBuilder(s)})`,
        });
    }

    // EXTERNAL per-row path — only reached by a plugin that declares `appliesTo` with no `sql`.
    if (elig.appliesTo) {
        const appliesTo = elig.appliesTo;
        const load = opts?.loadCandidates;
        if (!load) return 0; // no loader wired (e.g. unit context) — the heal rail still backstops
        const limit = opts?.limit ?? 100;
        const rows = await load(stage.id, limit);
        const ineligible: string[] = [];
        for (const r of rows) {
            try {
                if (!appliesTo(r.snapshot)) ineligible.push(r.mediaItemId);
            } catch {
                // A throwing external predicate must not dispose the row (could be a transient author bug);
                // leave it sweepable and let the next tick re-evaluate.
            }
        }
        if (ineligible.length === 0) return 0;
        return await markSkippedPermanentBatch(sql, {
            stageId: stage.id,
            mediaItemIds: ineligible,
            skippedReason: reason,
        });
    }

    return 0;
}
