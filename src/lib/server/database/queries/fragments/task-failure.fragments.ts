// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task-failure SQL fragments — the SINGLE source of truth for "what counts as an
 * actionable task failure".
 *
 * @module fragments/task-failure
 */

import type postgres from 'postgres';

/**
 * THE one definition of "an actionable task failure": a `state='failed'`
 * task_history row in the last 24h that a human should actually look at.
 *
 * This predicate was previously copy-pasted in FOUR places — the
 * `task-recent-failures` health invariant, two `lane-data.ts` queries (the ⚠
 * failed-lane count and its last-error lookup), and `attention.queries.ts`
 * `loadFailedRunSpikes` — each carrying a "keep in sync" comment that DRIFTED.
 * The drift shipped a real prod incident: a NULL-error leadership-wedge reclaim
 * of ~27k stuck-active runs leaked into the per-task spike + the failed lane
 * because those copies still had the old `error IS NULL OR (...)` form while the
 * invariant had been fixed. One source now; callers add only their own SELECT /
 * GROUP BY / `task_id` scope.
 *
 * Excluded as NON-actionable (self-healing / infrastructure noise, NOT a bug a
 * human must fix — the task system retries these automatically):
 *  - **NULL error** → an INFRASTRUCTURE event: BullMQ failed a job that never ran
 *    its handler (orphan reclaim / queue drain / parent-fail / bulk force-fail).
 *    A genuine task error ALWAYS carries a thrown message — the runner records
 *    it — so a missing message means "terminated by infra", not "handler error".
 *  - the whole `%orphan%_at_recovery%` family — boot/runtime orphan reclaim
 *    (orphaned_at_recovery, pending_orphan_at_recovery,
 *    cancelling_orphan_at_recovery, …_manual). Matched by PATTERN, not an exact
 *    list, so a new reclaim code can't silently leak deploy churn into the count.
 *  - `claimRun failed … state mismatch` — lost a scheduling race to another worker.
 *  - `maxConcurrent reached …` — throttled by the concurrency cap, re-queued.
 *  - `job stalled more than allowable limit` — BullMQ's deploy/restart-mid-run
 *    watchdog (same root cause as orphan reclaim, detected by BullMQ instead).
 *  - optional-integration `not configured` / `Plugin secret not found` for the
 *    handful of opt-in tasks (Last.fm/Discogs/MDBList) — SCOPED to those ids so a
 *    CORE "TMDB API key not configured" stays surfaced.
 *  - the 10-minute window after the most recent node `online` event — deploy /
 *    restart boot churn. COALESCE → no grace when there are no boot events.
 *  - provider rate limiting on a run the runner already classified
 *    `kind='transient'` — the amber case /admin/help/tasks documents. Scoped by
 *    kind so a permanent error that merely mentions a rate limit stays counted.
 *
 * Also excluded: a failure that has SINCE RECOVERED — a later run of the same
 * (task_id, input) reached 'completed'. "Failed once, working now" is not a thing
 * a human must act on; only an UN-recovered failure (latest attempt still failed,
 * or still retrying) stays counted. This is the single biggest source of false
 * RED after a cold start, where scheduled tasks time out against a huge backlog
 * and then succeed every cycle once it drains.
 *
 * A genuinely too-long task that is STILL failing surfaces via `Handler runtime …
 * exceeded hard timeout` (not excluded by message) right up until a run of the
 * same input completes.
 *
 * Usage: interpolate into a WHERE clause —
 *   ``sql`SELECT … FROM task_history WHERE ${actionableTaskFailure(sql)}` ``
 * and append any extra scope with `AND` (e.g. `AND task_id = ANY(${ids})`).
 */
export function actionableTaskFailure(sql: postgres.Sql) {
    return sql`
        state = 'failed'
        AND completed_at > NOW() - INTERVAL '24 hours'
        -- Restart grace window: ignore failures in the first 10 min after the
        -- most recent node 'online' event (deploy/restart boot churn).
        AND NOT (
            completed_at >= COALESCE((SELECT MAX(created_at) FROM cluster_node_events WHERE event_type = 'online'), 'epoch'::timestamptz)
            AND completed_at <= COALESCE((SELECT MAX(created_at) FROM cluster_node_events WHERE event_type = 'online'), 'epoch'::timestamptz) + INTERVAL '10 minutes'
        )
        -- NULL error = infrastructure event, not a genuine task error.
        AND error IS NOT NULL
        -- The WHOLE orphan-reclaim family is infrastructure (a run reclaimed
        -- because its worker died / was redeployed / SIGKILLed, or a manual
        -- reclaim) — NOT a task error. Match by pattern, not an exact list: the
        -- reclaimer emits orphaned_at_recovery / pending_orphan_at_recovery /
        -- cancelling_orphan_at_recovery (state-dependent), and a manual reclaim
        -- appends a suffix (..._manual). A hardcoded NOT IN of just the first two
        -- silently missed the latter two and leaked deploy churn into the RED count.
        AND error->>'message' NOT LIKE '%orphan%_at_recovery%'
        AND error->>'message' NOT LIKE 'claimRun failed%state mismatch%'
        AND error->>'message' NOT LIKE 'maxConcurrent reached%'
        AND error->>'message' <> 'job stalled more than allowable limit'
        -- media-item deletion race: a media-item-scoped run whose subject was
        -- deleted before it executed (run-wrapper records this exact sentinel).
        -- The work is moot and can NEVER recover (item gone), so the later-success
        -- rule below can't clear it — exclude by message. Keep in sync with
        -- MEDIA_ITEM_DELETED_BEFORE_RUN in tasks/run-wrapper.ts.
        AND error->>'message' <> 'media_item_deleted_before_run'
        -- Provider rate limiting is the documented AMBER case, not red:
        -- /admin/help/tasks promises "Amber failures are usually self-healing --
        -- things like rate limits or quota limits that resolve on their own."
        -- A big first scan against TMDB/MDBList/MAL is EXPECTED to hit 429s; the
        -- runner backs off and the quota window rolls. Counting them here made
        -- them red in every headline the operator reads (failedRuns24h, the
        -- task-recent-failures 10/20 amber-red thresholds, the failed lane via
        -- lane-data recentFailCount, and the failed-run-spike alert) while the
        -- operator had nothing to do and it cleared by itself -- which is how
        -- you train someone to stop reading red.
        --
        -- Gated on kind = transient on purpose. The message match alone is not
        -- enough: only a failure the runner ALREADY classified as retryable may
        -- be excused. A permanent/fatal error that merely mentions a rate limit
        -- stays counted. error->>kind is written by writeTerminalToPostgres;
        -- rows without it (older rows, infra-written terminals) simply do not
        -- match and stay counted -- the safe direction.
        --
        -- ILIKE rather than a regex, for two reasons. Postgres ARE reads the
        -- backslash-b escape as BACKSPACE (backslash-y is its word boundary),
        -- so a pattern ported straight from the JS RATE_LIMIT_ERROR_PATTERN
        -- would silently match nothing; and this whole query lives inside a JS
        -- template literal, where a backslash is an escape sequence before
        -- Postgres ever sees it. Keep this block free of backticks and
        -- backslashes for the same reason. These three substrings cover every
        -- rate-limit message the runner can record once
        -- isTransientInfrastructureError has classified it transient.
        AND NOT (
            error->>'kind' = 'transient'
            AND (
                error->>'message' ILIKE '%rate limit%'
                OR error->>'message' ILIKE '%rate-limit%'
                OR error->>'message' ILIKE '%too many requests%'
            )
        )
        AND NOT (
            task_id IN ('music-popularity', 'mdblist-sync', 'artist-enrichment', 'album-enrichment')
            AND (
                error->>'message' LIKE '%not configured%'
                OR error->>'message' LIKE '%Plugin secret not found%'
            )
        )
        -- RECOVERED failures are NOT actionable: if a LATER run of the SAME
        -- logical work (same task_id + same input ⇒ same identity) has since
        -- reached 'completed', the task self-healed and no human need look.
        -- For a scheduled singleton (input is constant) ANY later success clears
        -- the whole backlog of cold-start timeouts; for a per-item task only that
        -- item's own later success clears it (another item succeeding does not
        -- mask a genuinely-broken item). A run still retrying (no terminal
        -- success yet) keeps its failure visible until it actually recovers.
        -- This is why a watch-sync-pull that timed out 3× while a huge backlog
        -- drained, then succeeded every cycle since, no longer shows red.
        --
        -- recovered.duration_ms IS NOT NULL is semantically redundant
        -- (duration_ms is GENERATED from completed_at - started_at, started_at
        -- is NOT NULL, and the completed_at comparison below already excludes
        -- NULL) but it is what lets the planner use the partial index
        -- idx_task_history_task_completed (task_id, completed_at DESC)
        -- WHERE duration_ms IS NOT NULL. Without it the anti-join seq-scans
        -- every completed row: 2 s per call on a 3.7M-row prod table, fired
        -- ~140x/hour from health + attention; 2.4 ms with it.
        AND NOT EXISTS (
            SELECT 1
              FROM task_history recovered
             WHERE recovered.task_id = task_history.task_id
               AND recovered.input = task_history.input
               AND recovered.state = 'completed'
               AND recovered.duration_ms IS NOT NULL
               AND recovered.completed_at > task_history.completed_at
        )
    `;
}
