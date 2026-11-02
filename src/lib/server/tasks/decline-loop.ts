// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Decline-loop backoff — constants and the shared streak-reset fragment.
 *
 * ## The loop this exists to stop
 *
 * A per-item stage task that returns `{ success: false }` WITHOUT a permanent
 * marker is routed through `resetRunningToPending`, which deliberately leaves
 * `attempt` unchanged — declining to run is not a failed attempt, so it must not
 * consume retry budget. The sweep then re-picks the row roughly every 60s.
 *
 * That is correct for the population it was written for (a rate cap, a
 * disk-headroom guard, a run aborted mid-flight). It is catastrophic for a task
 * that returns `success:false` on a genuinely permanent condition: the item
 * loops forever, and because it increments NO counter, neither the registration
 * wedge guard nor the attempt cap can see it. It is invisible by construction.
 *
 * This is the most frequently recurring root cause in the project's incident
 * history — at least seven occurrences across trickplay, series-sync, MAL
 * enrichment, provider-artwork and the OSS task-system audit. Every one was
 * found by a human eventually noticing.
 *
 * ## Why backoff and not a terminal disposition
 *
 * `resetRunningToPending` serves two populations that CANNOT be told apart from
 * row state, because real blocks are frequently PARTIAL — an hourly rate cap
 * admits a trickle, a full mount affects one library while others proceed. Any
 * "did a sibling complete?" test is satisfied by the blocked population itself,
 * so a design that kills on that evidence silently suppresses quota-blocked
 * items. That is strictly worse than the loop: a loop wastes a worker slot
 * loudly, suppression hides an operator's media with no error anywhere.
 *
 * They do not need to be told apart. Both populations want the same treatment —
 * stop hammering — and both tolerate it. Choosing a reversible action dissolves
 * the classification problem instead of solving it. Nothing here is ever
 * terminal; the alert built on these counters is the entire output.
 *
 * @module server/tasks/decline-loop
 */

/** Declines that pass before any backoff is applied. */
export const FREE_DECLINES = 3;

/**
 * First decline that writes a backoff (a non-NULL `next_eligible_at`).
 *
 * This is the moment the row leaves the NULL-pending tier. `findSweepCandidates`
 * orders `next_eligible_at ASC NULLS FIRST`, so ANY non-NULL value sorts the row
 * behind the entire NULL backlog even after its timestamp lapses — the codebase
 * has a scar from exactly this (88 trickplay wedges starved untouched for a week
 * once the reclaimer stamped `now()`).
 */
export const DEMOTION_ONSET = FREE_DECLINES + 1;

/**
 * Alert floor. DEFINED as `DEMOTION_ONSET`, never chosen near it.
 *
 * A demoted row may never be picked again on a busy stage, and `declines` only
 * increments when a row IS picked — so a floor even one above the demotion onset
 * is unreachable, and the alert can never fire on precisely the stages the
 * incident history comes from. An earlier revision of this design shipped that
 * bug in review.
 */
export const ALERT_FLOOR = DEMOTION_ONSET;

/** Streak age at which a demoted row is reported. Age, not count — see below. */
export const ALERT_AGE_HOURS = 6;

/** Ceiling on the backoff interval. */
export const BACKOFF_CEIL_MIN = 60;

/**
 * Exponent clamp, derived so the curve actually reaches the ceiling.
 *
 * The cap must be applied to the EXPONENT, not only to the result. Capping the
 * result alone (`LEAST(2^n * interval '1 minute', interval '1 hour')`) evaluates
 * the multiplication first, and interval microseconds are int64 — that raises
 * `22003` at around 51 declines, roughly two days of looping. The decline write
 * would then throw, the row would wedge, and the breaker would delete itself on
 * exactly the rows it had been right about.
 */
export const BACKOFF_EXP_CAP = Math.ceil(Math.log2(BACKOFF_CEIL_MIN));

/**
 * Columns that end a decline streak, as a fragment for splicing into any
 * `UPDATE media_item_stage_state`.
 *
 * ## Use it at every run-outcome write, with two exceptions
 *
 * The invariant is "every run-outcome write ends the streak". A stale
 * `declines_since` riding along on a completed row is not inert: three writers
 * move `completed → obsolete` carrying every column forward, and
 * `stage-version-detector` does it STAGE-WIDE on every processing-version bump —
 * i.e. at deploys. Without the reset, a row that declined during last month's
 * quota block and later completed would go alert-visible at the next deploy
 * carrying an ancient streak, producing mass false "not progressing since three
 * weeks" alerts.
 *
 * `markFailedTransient` and `recordStageAttemptFailure` DO reset, even though a
 * transient failure looks like continued non-progress. An actual run is a
 * categorically different outcome from a decline — the item engaged the task —
 * and escalation transfers to `attempt`, which both writers increment and which
 * carries its own cap to `failed_permanent`. Declines never touch `attempt`, so
 * an interleaved decline/fail pattern still accumulates it monotonically and
 * nothing escapes both counters.
 *
 * EXCEPTION 1 — `reclaimWedgedRunningStageRows` must NOT use this. It is the one
 * place the escalation transfer above fails: it writes `failed_transient` with
 * `attempt` deliberately unchanged, so no cap is running. Resetting there would
 * erase the streak on the decline/wedge loop and make `failed_transient` in the
 * alert derive dead code.
 *
 * EXCEPTION 2 — `unskipItemStage` DOES use this despite not touching `attempt`.
 * An operator un-skipping a row is asserting it should run now, and a stale
 * streak would back it off immediately.
 *
 * A two-predicate static test enforces both rules; the exceptions are allowlisted
 * there by name.
 *
 * ## Written inline, not spliced as a fragment
 *
 * The design called for a shared SQL fragment so every site would use one
 * definition. Splicing is how this codebase produced a malformed `$3AND` —
 * postgres.js concatenates adjacent template fragments with NO separator — and
 * a fragment buys nothing here, because the guarantee never came from sharing
 * the SQL. It comes from `decline-reset-invariant.test.ts`, which asserts the
 * two columns are PRESENT in every qualifying UPDATE.
 *
 * Testing the effect rather than the mechanism is both stricter (a site that
 * hand-wrote the columns correctly still passes; a site that imported the
 * fragment and spliced it into the wrong clause would not have been caught) and
 * free of the concatenation hazard. So the columns are written inline:
 *
 *     declines = 0,
 *     declines_since = NULL,
 */
export const DECLINE_RESET_COLUMNS = ['declines', 'declines_since'] as const;
