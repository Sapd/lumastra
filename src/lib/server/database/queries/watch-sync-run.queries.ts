// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

// User-scoped lookups over `task_history` for the manual watch-sync trigger
// (`watch-sync-manual`). The task's `input` (`{ userId, provider, direction }`)
// and `scope` (`{ userId }`, written by `orchestrator.startRun(..., { userId })`)
// are both persisted as JSONB on the run row — there is no dedicated join
// table for "this user's manual sync runs", so callers resolve a run id via
// `getLatestManualRunId` and MUST re-verify ownership with `assertRunOwnedBy`
// before returning status or allowing cancellation of that run to anyone but
// its owner (`task_history.id` is a bare `text` id, not scoped by user, so a
// guessed/enumerated id must not leak another user's run).

/**
 * Find the most recent `watch-sync-manual` run started by `userId` for
 * `provider`, or `null` when the user has never triggered a manual sync for
 * that provider.
 *
 * "Latest" is `started_at DESC NULLS LAST, id DESC` — `started_at` has a
 * `NOT NULL DEFAULT now()` in the schema so the `NULLS LAST` is defensive
 * (legacy/backfilled rows only), and the `id` tiebreak keeps the result
 * deterministic when two runs share a timestamp.
 */
export async function getLatestManualRunId(
    sql: postgres.Sql,
    userId: string,
    provider: string,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM task_history
        WHERE task_id = 'watch-sync-manual'
          AND scope->>'userId' = ${userId}
          AND input->>'provider' = ${provider}
        ORDER BY started_at DESC NULLS LAST, id DESC
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Ownership guard for the manual sync status + cancel endpoints: true iff the
 * `task_history` row `runId` exists, is a `watch-sync-manual` run, AND its
 * `scope->>'userId'` equals `userId`.
 *
 * The `task_id = 'watch-sync-manual'` filter is load-bearing, not cosmetic: a
 * user owns many kinds of task runs (library scans, etc.), and without it a
 * user could pass the id of one of their OWN unrelated runs to the watch-sync
 * cancel/status endpoint and pass this gate — routing a cancel/status action
 * at the wrong task type. Narrowing to `watch-sync-manual` here means the gate
 * affirms ownership only for the runs these endpoints are allowed to act on.
 *
 * A missing run, a run owned by someone else, and a run owned by the user but
 * of a different task type all return `false` — callers should treat every
 * `false` as "not yours" (404), never distinguish them, to avoid leaking
 * whether a given run id exists.
 */
export async function assertRunOwnedBy(
    sql: postgres.Sql,
    runId: string,
    userId: string,
): Promise<boolean> {
    const rows = await sql<{ owned: boolean }[]>`
        SELECT (scope->>'userId' = ${userId}) AS owned
        FROM task_history
        WHERE id = ${runId}
          AND task_id = 'watch-sync-manual'
    `;
    return rows[0]?.owned === true;
}
