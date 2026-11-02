// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stage State Query Module
 *
 * Pure SQL primitives for the media_item_stage_state table (migration 16.2.0).
 * No side effects, no caching, no logging — that belongs in the service layer.
 */

import type postgres from 'postgres';
import { acceptReidentifyItem } from './ingest-map.queries.js';
import type { StageStateRow, StageErrorDetail, StageStatus } from '$lib/types/pipeline.js';
import {
    FREE_DECLINES,
    BACKOFF_EXP_CAP,
    BACKOFF_CEIL_MIN,
} from '$lib/server/tasks/decline-loop.js';

/** Lock an eligible running row until the caller's disposition transaction commits. */
export async function lockRunningStageForDisposition(
    sql: postgres.Sql | postgres.TransactionSql,
    input: { mediaItemId: string; stageId: string; runId: string },
): Promise<boolean> {
    const rows = await sql`
        SELECT 1 FROM media_item_stage_state
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
           AND status = 'running' AND last_run_id = ${input.runId}
           AND (invalidated_at IS NULL OR invalidated_at < started_at)
         FOR UPDATE
    `;
    return rows.length === 1;
}

/** Requires lockRunningStageForDisposition in the SAME transaction. Never inserts or claims a row. */
export async function markRunSkippedPermanent(
    sql: postgres.Sql | postgres.TransactionSql,
    input: { mediaItemId: string; stageId: string; runId: string; reason: string },
): Promise<number> {
    const rows = await sql`
        UPDATE media_item_stage_state
           SET status = 'skipped_permanent', skipped_reason = ${input.reason},
               completed_at = NULL, last_error = NULL, next_eligible_at = NULL,
               last_run_id = NULL, declines = 0, declines_since = NULL, updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid AND stage_id = ${input.stageId}
           AND status = 'running' AND last_run_id = ${input.runId}
           AND (invalidated_at IS NULL OR invalidated_at < started_at)
         RETURNING media_item_id
    `;
    return rows.length;
}

export interface InsertPendingRowInput {
    mediaItemId: string;
    stageId: string;
    processingVersion: number;
    initialStatus?: Extract<StageStatus, 'pending' | 'skipped_permanent' | 'skipped_transient'>;
    skippedReason?: string;
    nextEligibleAt?: Date;
}

/**
 * Returns whether a row was actually INSERTED. `ON CONFLICT DO NOTHING` makes
 * this call a silent no-op when a row already exists, so a caller that counts
 * calls rather than inserts will over-report — and, worse, announce a `seed`
 * event for a row it did not create. Callers that only need idempotency can
 * keep ignoring the result.
 */
export async function insertPendingRow(
    sql: postgres.Sql,
    input: InsertPendingRowInput,
): Promise<boolean> {
    const status: StageStatus = input.initialStatus ?? 'pending';
    const inserted = await sql<{ media_item_id: string }[]>`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status,
            skipped_reason, next_eligible_at
        ) VALUES (
            ${input.mediaItemId}::uuid, ${input.stageId}, ${input.processingVersion}, ${status},
            ${input.skippedReason ?? null}, ${input.nextEligibleAt ?? null}
        )
        ON CONFLICT (media_item_id, stage_id) DO NOTHING
        RETURNING media_item_id
    `;
    return inserted.length > 0;
}

export async function markRunning(
    sql: postgres.Sql,
    input: { mediaItemId: string; stageId: string; runId: string },
): Promise<void> {
    await sql`
        UPDATE media_item_stage_state
           SET status = 'running',
               last_run_id = ${input.runId},
               started_at = now(),
               last_error = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
    `;
}

/**
 * Atomically seed-or-transition a row to `'running'`.
 *
 * Replaces `markRunning` at runtime: `markRunning` silently no-ops when no
 * row exists for `(mediaItemId, stageId)` — which happens for pre-migration
 * items, items missed by inference, and items not yet processed by
 * `afterCreated`. This upsert handles both cases:
 *
 *   - No row exists      → INSERT a fresh row in `'running'`.
 *   - Row exists, idle   → UPDATE to `'running'`, claim with our `runId`.
 *   - Row already
 *     `'running'` under
 *     a different runId  → KEEP the existing run's ownership (concurrent
 *                          BullMQ delivery; the original owner stays the row's
 *                          recorded owner). The new run still executes, but
 *                          the coverage row reflects the original concurrent
 *                          run rather than getting clobbered.
 *   - Row `'running'`
 *     under our runId    → idempotent refresh.
 */
export async function upsertRunningRow(
    sql: postgres.Sql | postgres.TransactionSql,
    input: {
        mediaItemId: string;
        stageId: string;
        processingVersion: number;
        runId: string;
    },
): Promise<{ attempt: number }> {
    const rows = await sql<{ attempt: number }[]>`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status,
            last_run_id, started_at, updated_at
        ) VALUES (
            ${input.mediaItemId}::uuid, ${input.stageId}, ${input.processingVersion}, 'running',
            ${input.runId}, now(), now()
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           -- "Keep, don't claim" when the row is already owned by a DIFFERENT live
           -- run (concurrent BullMQ delivery), OR — M5 — when it is already
           -- skipped_permanent. A worker claim reaching a skipped_permanent row
           -- means the job is STALE: the sweep eligibility-dispose tombstoned the row
           -- AFTER this job was enqueued on an earlier tick. Resurrecting it to
           -- running would re-run a just-disposed (now-ineligible) item and let the
           -- racing terminal write resurrect a false status. Keeping it
           -- skipped_permanent makes the stale job a no-op (its runId-guarded
           -- markCompleted/markFailed match nothing); the heal re-enrolls it cleanly
           -- if it ever becomes eligible again. (completed/failed_permanent stay
           -- claimable — those are legitimate re-run/retry targets.)
           SET status = CASE
                   WHEN media_item_stage_state.status = 'skipped_permanent'
                   THEN media_item_stage_state.status
                   WHEN media_item_stage_state.status = 'running'
                    AND media_item_stage_state.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id
                   THEN media_item_stage_state.status
                   ELSE 'running'
               END,
               last_run_id = CASE
                   WHEN media_item_stage_state.status = 'skipped_permanent'
                   THEN media_item_stage_state.last_run_id
                   WHEN media_item_stage_state.status = 'running'
                    AND media_item_stage_state.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id
                   THEN media_item_stage_state.last_run_id
                   ELSE EXCLUDED.last_run_id
               END,
               started_at = CASE
                   WHEN media_item_stage_state.status = 'skipped_permanent'
                   THEN media_item_stage_state.started_at
                   WHEN media_item_stage_state.status = 'running'
                    AND media_item_stage_state.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id
                   THEN media_item_stage_state.started_at
                   ELSE now()
               END,
               -- A claim is not a successful repair; preserve the last failure
               -- until completion (or a newer failure) supplies actual evidence.
               last_error = media_item_stage_state.last_error,
               updated_at = now()
        RETURNING attempt
    `;
    // Every ON CONFLICT branch updates at least `updated_at`, so RETURNING
    // always yields the (post-claim) row. `attempt` is untouched by the claim —
    // it is the durable count of prior FAILED attempts for this stage row,
    // which run-wrapper needs because BullMQ's per-job `attemptsMade` resets to
    // 0 on every fresh sweep-enqueued job (see WrapExecuteOptions.currentAttempt).
    return { attempt: rows[0]?.attempt ?? 0 };
}

/**
 * The terminal-state writers (`markCompleted` / `markFailedTransient` /
 * `markFailedPermanent`) accept an optional `runId`. When provided, the UPDATE
 * scopes itself with `AND last_run_id = ${runId}` so that a run which **lost**
 * the `upsertRunningRow` race cannot later clobber the ownership of the run
 * that **won** it. Without this guard:
 *
 *   1. Run A and Run B both fan out for the same `(mediaItemId, stageId)`.
 *   2. `upsertRunningRow` runs first → Run A wins, B's ownership is rejected.
 *   3. B completes its `inner()` faster than A and calls `markCompleted` —
 *      the row's `last_run_id` is still A, yet the row now says `completed`
 *      and the audit trail no longer matches the actual owner.
 *
 * With the guard, B's `markCompleted` no-ops (zero rows affected); the row
 * keeps `running` until A finishes. Existing legacy call sites that omit
 * `runId` retain idempotent behavior — used by tests that assert single-run
 * state-machine flows.
 */
export async function markCompleted(
    sql: postgres.Sql | postgres.TransactionSql,
    input: { mediaItemId: string; stageId: string; runId?: string },
): Promise<void> {
    if (input.runId !== undefined) {
        await sql`
            UPDATE media_item_stage_state
               SET status = CASE
                       WHEN invalidated_at IS NOT NULL
                        AND started_at IS NOT NULL
                        AND invalidated_at >= started_at
                       THEN 'obsolete'
                       ELSE 'completed'
                   END,
                   completed_at = now(),
                   last_error = NULL,
                   skipped_reason = NULL,
                   next_eligible_at = NULL,
                   invalidated_at = NULL,
                   declines = 0,
                   declines_since = NULL,
                   updated_at = now()
             WHERE media_item_id = ${input.mediaItemId}::uuid
               AND stage_id = ${input.stageId}
               AND last_run_id = ${input.runId}
        `;
        return;
    }
    await sql`
        UPDATE media_item_stage_state
           SET status = CASE
                   WHEN invalidated_at IS NOT NULL
                    AND started_at IS NOT NULL
                    AND invalidated_at >= started_at
                   THEN 'obsolete'
                   ELSE 'completed'
               END,
               completed_at = now(),
               last_error = NULL,
               skipped_reason = NULL,
               next_eligible_at = NULL,
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
    `;
}

/**
 * Reset a stage row from `'running'` back to `'pending'` when the task
 * legitimately declined to do any work this run — `execute()` returned
 * `{ success: false, ... }` WITHOUT throwing (e.g. a routine GLOBAL block
 * like an hourly rate cap or a disk-headroom guard, or a run aborted
 * mid-flight). Used by `wrapExecute`'s `success:false` path in
 * `run-wrapper.ts`.
 *
 * Scoped by `runId` (same guard as `markCompleted`/`markFailedTransient`/
 * `markFailedPermanent`): a run that LOST the `upsertRunningRow` race must
 * not un-claim the WINNER's row.
 *
 * `attempt` is deliberately left UNCHANGED — declining to run is not a
 * failed attempt, so it must not consume retry budget or drift the
 * exhaustion count.
 *
 * ## Why this write also counts, and backs off
 *
 * Leaving `attempt` alone is right, but it means a task that returns
 * `success:false` on a genuinely PERMANENT condition loops here every ~60s
 * forever while incrementing no counter — invisible to the registration wedge
 * guard and to the attempt cap alike, because both key on `attempt`. Seven-plus
 * incidents in this project are that exact shape. `declines` is the counter
 * those guards lack; see `server/tasks/decline-loop.ts` for why the response is
 * backoff rather than a terminal disposition (short version: the blocked and
 * looping populations cannot be told apart, and both want the same treatment).
 *
 * The first `FREE_DECLINES` declines still clear `next_eligible_at`, preserving
 * the original behaviour — the row re-enters the ordinary sweepable backlog
 * immediately rather than sitting `'running'` until
 * `reclaimWedgedRunningStageRows` reclassifies it after 10 minutes. Past that a
 * backoff is stamped, which DOES demote the row: `findSweepCandidates` orders
 * `next_eligible_at ASC NULLS FIRST`, so any non-NULL value sorts behind the
 * whole NULL backlog even once it lapses. That is accepted (it puts declined
 * rows in the tier `markFailedTransient` rows already occupy) and it is exactly
 * why the alert built on these columns keys on streak AGE rather than count —
 * `declines` only advances when the row is picked, and a demoted row may never
 * be picked again.
 *
 * Returns the number of rows reset (0 if a concurrent run already owns the row,
 * or the row is no longer `'running'`) and the post-increment `declines` for
 * that row, which `run-wrapper` compares against `ALERT_FLOOR` to log the
 * crossing exactly once per streak.
 */
export async function resetRunningToPending(
    sql: postgres.Sql | postgres.TransactionSql,
    input: { mediaItemId: string; stageId: string; runId: string },
): Promise<{ count: number; declines: number | null }> {
    const rows = await sql<{ declines: number }[]>`
        UPDATE media_item_stage_state
           SET status = 'pending',
               declines = declines + 1,
               declines_since = COALESCE(declines_since, now()),
               next_eligible_at = CASE
                   WHEN declines + 1 <= ${FREE_DECLINES} THEN NULL
                   ELSE now() + make_interval(mins => LEAST(
                            2 ^ LEAST(declines + 1 - ${FREE_DECLINES}, ${BACKOFF_EXP_CAP}),
                            ${BACKOFF_CEIL_MIN})::int)
               END,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
           AND status = 'running'
           AND last_run_id = ${input.runId}
     RETURNING declines
    `;
    return { count: rows.count ?? 0, declines: rows[0]?.declines ?? null };
}

export async function markFailedTransient(
    sql: postgres.Sql | postgres.TransactionSql,
    input: {
        mediaItemId: string;
        stageId: string;
        error: StageErrorDetail;
        backoffMs: number;
        runId?: string;
    },
): Promise<void> {
    if (input.runId !== undefined) {
        await sql`
            UPDATE media_item_stage_state
               SET status = 'failed_transient',
                   attempt = attempt + 1,
                   last_error = ${sql.json(input.error as unknown as postgres.JSONValue)},
                   next_eligible_at = now() + make_interval(secs => ${input.backoffMs} / 1000.0),
                   invalidated_at = NULL,
                   declines = 0,
                   declines_since = NULL,
                   updated_at = now()
             WHERE media_item_id = ${input.mediaItemId}::uuid
               AND stage_id = ${input.stageId}
               AND last_run_id = ${input.runId}
        `;
        return;
    }
    await sql`
        UPDATE media_item_stage_state
           SET status = 'failed_transient',
               attempt = attempt + 1,
               last_error = ${sql.json(input.error as unknown as postgres.JSONValue)},
               next_eligible_at = now() + make_interval(secs => ${input.backoffMs} / 1000.0),
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
    `;
}

/**
 * Record a transient per-item failure for a self-managing multi-stage task
 * (media-probe) that bypasses `wrapExecute` and therefore never gets the
 * attempt-accounting `markFailedTransient` writes the run-wrapper would normally
 * do (bug M1). Unlike the bare `markFailedTransient`, this is STATUS-GUARDED: it
 * only transitions a row that is currently `pending`/`failed_transient`/`running`
 * — so a probe failure cannot resurrect a `skipped_permanent` row (that is the
 * heal rail's job, with its own reason tracking) nor clobber a `completed` one.
 * Increments `attempt`, records `last_error`, and sets a `next_eligible_at`
 * backoff so the stage-sweep stops re-enqueuing a perpetually-failing item every
 * tick. Returns the number of rows updated (0 when the row was terminal/absent).
 *
 * **Attempt cap (give-up).** When `maxAttempts` is supplied and this failure
 * reaches it (`attempt + 1 >= maxAttempts`), the row is promoted to
 * `failed_permanent` (with `next_eligible_at = NULL`) instead of looping as
 * `failed_transient` forever. Without this, a handler that always reports
 * `retryable: true` for an unfixable input (e.g. a 50 GB remux whose keyframe
 * scan always exceeds the ffprobe timeout) retries every backoff window
 * indefinitely — observed in prod at `attempt 637`. Omit `maxAttempts` to keep
 * the legacy uncapped behavior (always `failed_transient`).
 */
export async function recordStageAttemptFailure(
    sql: postgres.Sql,
    input: {
        mediaItemId: string;
        stageId: string;
        error: StageErrorDetail;
        backoffMs: number;
        /** Promote to `failed_permanent` once `attempt + 1 >= maxAttempts`. */
        maxAttempts?: number;
    },
): Promise<number> {
    // A null cap disables the promotion branch (CASE comparison against NULL is
    // never true), so the row stays `failed_transient` — the legacy behavior.
    // Coerce a malformed cap (NaN/float/<=0 from a bad config) to null rather
    // than letting it reach SQL: `attempt + 1 >= NaN` is silently never true, so
    // a garbage cap would re-introduce the exact infinite loop this guards.
    const cap =
        typeof input.maxAttempts === 'number' &&
        Number.isInteger(input.maxAttempts) &&
        input.maxAttempts > 0
            ? input.maxAttempts
            : null;
    const rows = await sql<{ media_item_id: string }[]>`
        UPDATE media_item_stage_state
           SET status = CASE
                   WHEN attempt + 1 >= ${cap} THEN 'failed_permanent'
                   ELSE 'failed_transient'
               END,
               attempt = attempt + 1,
               last_error = ${sql.json(input.error as unknown as postgres.JSONValue)},
               next_eligible_at = CASE
                   WHEN attempt + 1 >= ${cap} THEN NULL
                   ELSE now() + make_interval(secs => ${input.backoffMs} / 1000.0)
               END,
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
           AND status IN ('pending', 'failed_transient', 'running')
        RETURNING media_item_id
    `;
    return rows.length;
}

export async function markFailedPermanent(
    sql: postgres.Sql | postgres.TransactionSql,
    input: {
        mediaItemId: string;
        stageId: string;
        error: StageErrorDetail;
        runId?: string;
    },
): Promise<void> {
    if (input.runId !== undefined) {
        await sql`
            UPDATE media_item_stage_state
               SET status = 'failed_permanent',
                   last_error = ${sql.json(input.error as unknown as postgres.JSONValue)},
                   next_eligible_at = NULL,
                   invalidated_at = NULL,
                   declines = 0,
                   declines_since = NULL,
                   updated_at = now()
             WHERE media_item_id = ${input.mediaItemId}::uuid
               AND stage_id = ${input.stageId}
               AND last_run_id = ${input.runId}
        `;
        return;
    }
    await sql`
        UPDATE media_item_stage_state
           SET status = 'failed_permanent',
               last_error = ${sql.json(input.error as unknown as postgres.JSONValue)},
               next_eligible_at = NULL,
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
    `;
}

/**
 * Defensively coerce a raw `last_error` JSONB cell into a `StageErrorDetail`.
 *
 * postgres-js usually hands back parsed objects, but legacy or malformed rows
 * can surface as strings (single-encoded JSON) or shapes that don't match
 * `StageErrorDetail`. Returning a sanitized object keeps the admin pipeline
 * endpoint responsive: a single bad row should not 500 the whole tab.
 */
function coerceLastError(raw: unknown): StageErrorDetail | null {
    if (raw == null) return null;

    let candidate: unknown = raw;

    // Some drivers/connections deliver JSONB as a string. Try to decode once.
    if (typeof candidate === 'string') {
        const asString = candidate;
        try {
            candidate = JSON.parse(asString);
        } catch {
            // best-effort: non-JSON string is treated as a plain error message (keeps the tab responsive).
            return { message: asString };
        }
    }

    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        return { message: String(raw) };
    }

    const obj = candidate as Record<string, unknown>;
    const message = typeof obj.message === 'string' ? obj.message : 'Unknown stage error';
    const code = typeof obj.code === 'string' ? obj.code : undefined;
    const retryable = typeof obj.retryable === 'boolean' ? obj.retryable : undefined;
    const pluginId = typeof obj.plugin_id === 'string' ? obj.plugin_id : undefined;

    const out: StageErrorDetail = { message };
    if (obj.remediation === 'identity' || obj.remediation === 'operational')
        out.remediation = obj.remediation;
    if (code !== undefined) out.code = code;
    if (retryable !== undefined) out.retryable = retryable;
    if (pluginId !== undefined) out.plugin_id = pluginId;
    return out;
}

export async function findRowsByItem(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<StageStateRow[]> {
    // Read into a permissive raw shape first so we can sanitize each row
    // independently — a single decoder failure (malformed JSONB, unexpected
    // type) becomes a degraded row instead of a 500 on the whole endpoint.
    const raw = await sql<
        Array<{
            media_item_id: string;
            stage_id: string;
            processing_version: number;
            status: StageStatus;
            attempt: number;
            last_run_id: string | null;
            last_error: unknown;
            skipped_reason: string | null;
            started_at: Date | null;
            completed_at: Date | null;
            next_eligible_at: Date | null;
            updated_at: Date;
        }>
    >`
        SELECT media_item_id, stage_id, processing_version, status, attempt,
               last_run_id, last_error, skipped_reason,
               started_at, completed_at, next_eligible_at, updated_at
          FROM media_item_stage_state
         WHERE media_item_id = ${mediaItemId}::uuid
         ORDER BY stage_id
    `;

    const rows: StageStateRow[] = [];
    for (const r of raw) {
        try {
            rows.push({
                media_item_id: r.media_item_id,
                stage_id: r.stage_id,
                processing_version: r.processing_version,
                status: r.status,
                attempt: r.attempt,
                last_run_id: r.last_run_id,
                last_error: coerceLastError(r.last_error),
                skipped_reason: r.skipped_reason,
                started_at: r.started_at,
                completed_at: r.completed_at,
                next_eligible_at: r.next_eligible_at,
                updated_at: r.updated_at,
            });
        } catch {
            // Last-ditch: emit a minimal sanitized row so the response stays well-formed.
            rows.push({
                media_item_id: r.media_item_id ?? mediaItemId,
                stage_id: r.stage_id ?? 'unknown',
                processing_version:
                    typeof r.processing_version === 'number' ? r.processing_version : 0,
                status: r.status ?? 'pending',
                attempt: typeof r.attempt === 'number' ? r.attempt : 0,
                last_run_id: null,
                last_error: { message: 'row decode failed' },
                skipped_reason: null,
                started_at: null,
                completed_at: null,
                next_eligible_at: null,
                updated_at: r.updated_at ?? new Date(),
            });
        }
    }
    return rows;
}

export async function deleteRowsForItem(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ${mediaItemId}::uuid`;
}

/**
 * Batch-mark a set of items as `failed_permanent` for a given stage.
 *
 * Used by sweep-style tasks (e.g. integrity-scanner) that classify many items
 * in a single pass rather than per-item runs.
 *
 * `AND status != 'completed'` guard: mirrors {@link markCompletedBatch}'s own
 * guard in the other direction. Without it, a caller feeding a raw/un-debounced
 * read (e.g. integrity-scanner's `scanMissingDefaultFiles`, which has no
 * staleness window on `is_missing`) can stamp `failed_permanent` over a row
 * that just legitimately transitioned to `completed` moments earlier — a
 * transient blip (NFS hiccup) on the read side would silently overwrite a
 * true positive. Checked every call site (integrity-scanner's stage-state
 * sweep, both integration test suites): none intentionally resurrect a
 * `completed` row via this function — the only production caller always
 * writes disjoint id sets to markFailedPermanentBatch vs markCompletedBatch
 * within the same pass (missingIds vs presentIds), so this guard cannot drop
 * a legitimate transition, only block an accidental clobber.
 *
 * Returns the number of rows updated.
 */
export async function markFailedPermanentBatch(
    sql: postgres.Sql,
    input: {
        stageId: string;
        mediaItemIds: string[];
        error: StageErrorDetail;
    },
): Promise<number> {
    if (input.mediaItemIds.length === 0) return 0;
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'failed_permanent',
               last_error = ${sql.json(input.error as unknown as postgres.JSONValue)},
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           AND media_item_id = ANY(${input.mediaItemIds}::uuid[])
           AND status != 'completed'
        RETURNING media_item_id
    `;
    return result.count ?? 0;
}

/**
 * Whether this item's stage row is `completed` with a completion inside the
 * last `withinMs`. Lets a caller skip re-enqueuing a per-item task that has
 * just run for the same item.
 */
export async function wasStageCompletedWithin(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
    withinMs: number,
): Promise<boolean> {
    const rows = await sql<{ found: boolean }[]>`
        SELECT EXISTS (
            SELECT 1 FROM media_item_stage_state
            WHERE media_item_id = ${mediaItemId}::uuid
              AND stage_id = ${stageId}
              AND status = 'completed'
              AND completed_at >= now() - make_interval(secs => ${withinMs} / 1000.0)
        ) AS found
    `;
    return rows[0]?.found === true;
}

/** Record fresh file work for current links without stealing an active owner or a newer invalidation. */
export async function completeFreshFileProbeStage(
    sql: postgres.Sql,
    input: { fileId: string; stageId: string; processingVersion: number; observedAt: Date },
): Promise<string[]> {
    const rows = await sql<{ media_item_id: string }[]>`
        INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, completed_at)
        SELECT mfi.media_item_id, ${input.stageId}, ${input.processingVersion}, 'completed', now()
        FROM media_file_items mfi WHERE mfi.file_id = ${input.fileId}::uuid
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
        SET status = 'completed', completed_at = now(), last_error = NULL, next_eligible_at = NULL,
            invalidated_at = NULL, declines = 0, declines_since = NULL,
            processing_version = GREATEST(EXCLUDED.processing_version, media_item_stage_state.processing_version), updated_at = now()
        WHERE (media_item_stage_state.invalidated_at IS NULL OR media_item_stage_state.invalidated_at <= ${input.observedAt})
          AND media_item_stage_state.status NOT IN ('running', 'queued')
          AND NOT EXISTS (SELECT 1 FROM task_history th WHERE th.id = media_item_stage_state.last_run_id AND th.state IN ('pending', 'active', 'cancelling'))
        RETURNING media_item_id
    `;
    return rows.map((row) => row.media_item_id);
}

/**
 * Idempotent UPSERT to a terminal `completed` state for `(mediaItemId, stageId)`.
 *
 * Use this from tasks whose runner does NOT auto-seed a coverage row at
 * dispatch time (per-item scope tasks bypass that path: their input lacks a
 * `mediaItemId`, so the global runner wrapper skips the coverage write). Such
 * tasks must write completion themselves after each item succeeds — otherwise
 * the row stays `pending` (seeded by `afterCreated`) and the task re-processes
 * the item every drain tick.
 *
 * Behavior:
 *   - No row exists  → INSERT a `completed` row.
 *   - Row exists     → UPDATE to `completed`; bump `processing_version` to
 *                      `GREATEST(EXCLUDED, existing)` so a concurrent earlier
 *                      version can't downgrade.
 *
 * Safe to call repeatedly; the UPSERT is idempotent on `(media_item_id, stage_id)`.
 */
export async function upsertCompletedRow(
    sql: postgres.Sql,
    input: { mediaItemId: string; stageId: string; processingVersion: number; runId?: string },
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, completed_at, last_run_id
        ) VALUES (
            ${input.mediaItemId}::uuid, ${input.stageId}, ${input.processingVersion}, 'completed', now(), ${input.runId ?? null}
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           -- WI-10 (C1): if a content/identity change was marked
           -- (invalidated_at) AFTER this run claimed the row (started_at), the
           -- 'completed' the worker just produced is built from now-stale input.
           -- Demote to 'obsolete' (a sweepable status) so the stage re-runs
           -- against the fresh input instead of committing a stale result.
           SET status = CASE
                   WHEN media_item_stage_state.invalidated_at IS NOT NULL
                    AND media_item_stage_state.started_at IS NOT NULL
                    AND media_item_stage_state.invalidated_at >= media_item_stage_state.started_at
                   THEN 'obsolete'
                   ELSE 'completed'
               END,
               last_run_id = COALESCE(EXCLUDED.last_run_id, media_item_stage_state.last_run_id),
               completed_at = now(),
               last_error = NULL,
               skipped_reason = NULL,
               next_eligible_at = NULL,
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               processing_version = GREATEST(EXCLUDED.processing_version, media_item_stage_state.processing_version),
               updated_at = now()
    `;
}

/**
 * Per-item analogue of `upsertCompletedRow` for the "this item will never
 * be processable by this stage" case. Used by tasks that walk their entire
 * eligible set on each run and want to tombstone items that don't match the
 * stage's purpose so the row stops appearing in `pending` and stops
 * triggering the dormant-stage health invariant.
 *
 * Example: `fribb-anime-sync` covers every series, but only series whose
 * TMDB id appears in the Fribb anime-mappings dataset are actually anime.
 * The rest are silently skipped on every run, leaving stage rows in
 * `pending` forever. Calling this with `skippedReason: 'not-anime'`
 * tombstones them so they never re-appear in the candidate list.
 *
 * Self-healing: `invalidateByEvent` flips skipped_permanent rows back to
 * pending when an event re-evaluates the predicate to true (e.g. a TMDB
 * identity change might link an item to an anime entry on the next
 * Fribb dataset refresh). The dispatcher's existing two-way invalidation
 * handles this without changes here.
 */
export async function upsertSkippedPermanentRow(
    sql: postgres.Sql,
    input: {
        mediaItemId: string;
        stageId: string;
        processingVersion: number;
        skippedReason: string;
        runId?: string;
        /**
         * Also replace a `completed` row. Off by default: a `completed` row is
         * normally a finished result that a tombstone must not clobber. A caller
         * that has just proven the completion no longer covers the current input
         * (an analyzer quarantining an item that keeps failing on its replaced
         * file) opts in, otherwise the tombstone silently never lands and the
         * item is retried forever.
         */
        replaceCompleted?: boolean;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, skipped_reason, completed_at, last_run_id
        ) VALUES (
            ${input.mediaItemId}::uuid, ${input.stageId}, ${input.processingVersion},
            'skipped_permanent', ${input.skippedReason}, now(), ${input.runId ?? null}
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           SET status = 'skipped_permanent',
               last_run_id = COALESCE(EXCLUDED.last_run_id, media_item_stage_state.last_run_id),
               skipped_reason = ${input.skippedReason},
               completed_at = now(),
               last_error = NULL,
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               processing_version = GREATEST(EXCLUDED.processing_version, media_item_stage_state.processing_version),
               updated_at = now()
         WHERE media_item_stage_state.status IN
                ('pending', 'failed_transient', 'skipped_transient', 'skipped_permanent', 'obsolete')
            OR (${input.replaceCompleted === true}::boolean AND media_item_stage_state.status = 'completed')
    `;
}

/**
 * Bulk-flip every retriable row for a stage to `skipped_transient` with a
 * fixed retry delay. Used by tasks whose precondition is GLOBAL (rather than
 * per-item) and isn't currently satisfied — e.g. `mal-anime-id-enrichment`
 * with no MAL borrower auth linked. Marking rows transient (not permanent)
 * lets them retry once the precondition becomes available without an
 * explicit operator re-eligibilize step; the long backoff prevents
 * stage-sweep from spamming a still-broken task at its full enqueue rate.
 *
 * Status guard mirrors `markSkippedTransientBatch` — `running` / `completed`
 * / `skipped_permanent` rows are deliberately untouched.
 *
 * Returns the number of rows updated.
 */
export async function markAllPendingSkippedTransientForStage(
    sql: postgres.Sql,
    input: { stageId: string; skippedReason: string; retryAfterMs: number },
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'skipped_transient',
               skipped_reason = ${input.skippedReason},
               next_eligible_at = now() + make_interval(secs => ${input.retryAfterMs / 1000}),
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           -- Must cover the SAME set the sweep ENQUEUES (stage-disposition-runner
           -- SWEEPABLE_STATUSES = pending/failed_transient/skipped_transient/
           -- obsolete). S2: 'obsolete' was omitted here, so when a global-guard
           -- precondition is unmet the sweep kept enqueueing obsolete rows that
           -- this drain never quieted → a steady churn of no-op runs.
           AND status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
           -- L2: only (re)stamp rows that are eligible NOW. Without this, a row
           -- already in skipped_transient mid-backoff would have its retry window
           -- rolled forward ~60s every sweep tick, so a long backoff (e.g. a 24h
           -- global-guard) never actually elapses. A mid-backoff row is already
           -- skipped_transient and re-becomes eligible on schedule; when the guard
           -- is still false it is re-drained then.
           AND (next_eligible_at IS NULL OR next_eligible_at <= now())
    `;
    return result.count ?? 0;
}

/**
 * Make every row a global guard parked for `skippedReason` eligible NOW, for
 * when the guard's precondition was just met (an operator saved the missing
 * API key). Without this the rows wait out the guard's full `retryAfterMs`
 * (6h/12h) although nothing blocks them any more. Only the backoff is
 * cleared: the row stays `skipped_transient` (a sweepable status), so the next
 * sweep or run re-evaluates it like any other eligible row, and if the guard
 * still fails it is parked again. Rows parked for any other reason keep their
 * window.
 *
 * Returns the number of rows released.
 */
export async function releaseSkippedTransientForReason(
    sql: postgres.Sql,
    input: { stageId: string; skippedReason: string },
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state
           SET next_eligible_at = now(),
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           AND status = 'skipped_transient'
           AND skipped_reason = ${input.skippedReason}
           AND next_eligible_at > now()
    `;
    return result.count ?? 0;
}

/**
 * Batch-mark a set of items as `skipped_transient` for a given stage with a
 * retry delay.
 *
 * Used by coverage-table-driven generators when `candidateSource` returns
 * items that the downstream legacy predicate then drops (e.g.
 * `library-embeddings` requires `has_files=true`, `mdblist-sync` requires a
 * primary `external_ids` row). Without this reconciliation step those items
 * stay `pending` forever — they're returned by every subsequent
 * `candidateSource` call but never reach `upsertCompletedRow`.
 *
 * The status guard (`AND status IN ('pending', 'failed_transient',
 * 'skipped_transient')`) prevents accidentally clobbering `running` or
 * `completed` rows when this runs concurrently with a per-item handler.
 *
 * Self-healing: when the item becomes eligible again (e.g. files arrive →
 * `afterContentChanged` fires → `invalidateByKind` flips the row back to
 * `pending`), the row exits the skip state automatically.
 *
 * Returns the number of rows updated.
 */
export async function markSkippedTransientBatch(
    sql: postgres.Sql,
    input: {
        stageId: string;
        mediaItemIds: string[];
        skippedReason: string;
        retryAfterMs: number;
    },
): Promise<number> {
    if (input.mediaItemIds.length === 0) return 0;
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'skipped_transient',
               skipped_reason = ${input.skippedReason},
               next_eligible_at = now() + make_interval(secs => ${input.retryAfterMs / 1000}),
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           AND media_item_id = ANY(${input.mediaItemIds}::uuid[])
           AND status IN ('pending', 'failed_transient', 'skipped_transient')
        RETURNING media_item_id
    `;
    return result.count ?? 0;
}

/**
 * Defer re-selection of a set of coverage rows by pushing their
 * `next_eligible_at` out by `retryAfterMs`, WITHOUT changing status. For
 * TRANSIENT unavailability (e.g. a mount outage) where the row must stay in its
 * current state but should not be re-picked on every drain tick.
 *
 * Unlike {@link markSkippedTransientBatch} this also defers `completed` rows, so
 * a version-behind `completed` row that a version-aware backlog re-selected for
 * re-run does not hot-loop while its file is transiently absent. Only touches
 * backlog-selectable statuses — never `running` or the permanent terminals.
 *
 * Returns the number of rows deferred.
 */
export async function deferTransientRetryBatch(
    sql: postgres.Sql,
    input: {
        stageId: string;
        mediaItemIds: string[];
        retryAfterMs: number;
    },
): Promise<number> {
    if (input.mediaItemIds.length === 0) return 0;
    const result = await sql`
        UPDATE media_item_stage_state
           SET next_eligible_at = now() + make_interval(secs => ${input.retryAfterMs / 1000}),
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           AND media_item_id = ANY(${input.mediaItemIds}::uuid[])
           AND status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete', 'completed')
        RETURNING media_item_id
    `;
    return result.count ?? 0;
}

/**
 * Admin-only recovery: flip `failed_permanent` rows back to `pending` so the
 * sweeper retries them. Transient infra failures that exhausted the retry
 * budget land in `failed_permanent`, which both invalidation paths intentionally
 * exclude from the auto-requeue filter ("admin only"). This is the explicit
 * operator opt-in. Resets attempt=0, clears last_error + next_eligible_at.
 *
 * `stageId` omitted → reset every failed_permanent row for the item.
 * Returns the number of rows reset.
 */
export async function resetFailedPermanent(
    sql: postgres.Sql,
    input: { mediaItemId: string; stageId?: string },
): Promise<number> {
    const result = input.stageId
        ? await sql`
            UPDATE media_item_stage_state
               SET status = 'pending', attempt = 0,
                   skipped_reason = NULL, retry_budget_started_at = clock_timestamp(),
                   declines = 0,
                   declines_since = NULL,
                   next_eligible_at = NULL, updated_at = now()
             WHERE media_item_id = ${input.mediaItemId}::uuid
               AND stage_id = ${input.stageId}
               AND (status = 'failed_permanent' OR
                    (status = 'skipped_permanent' AND skipped_reason LIKE 'poison-episode:%'))
        `
        : await sql`
            UPDATE media_item_stage_state
               SET status = 'pending', attempt = 0,
                   skipped_reason = NULL, retry_budget_started_at = clock_timestamp(),
                   declines = 0,
                   declines_since = NULL,
                   next_eligible_at = NULL, updated_at = now()
             WHERE media_item_id = ${input.mediaItemId}::uuid
               AND (status = 'failed_permanent' OR
                    (status = 'skipped_permanent' AND skipped_reason LIKE 'poison-episode:%'))
        `;
    return result.count ?? 0;
}

/**
 * Admin-only bulk recovery: flip ALL `failed_permanent` rows for a stage back
 * to `pending`. Counterpart of {@link resetFailedPermanent} for operator batch
 * resets after an infra outage. Returns the number of rows reset.
 */
export async function resetFailedPermanentForStage(
    sql: postgres.Sql,
    stageId: string,
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'pending', attempt = 0,
                   skipped_reason = NULL, retry_budget_started_at = clock_timestamp(),
               declines = 0,
               declines_since = NULL,
               next_eligible_at = NULL, updated_at = now()
         WHERE stage_id = ${stageId}
           AND (status = 'failed_permanent' OR
                    (status = 'skipped_permanent' AND skipped_reason LIKE 'poison-episode:%'))
    `;
    return result.count ?? 0;
}

/**
 * Derived-artifact reset recovery: flip a stage's `completed` rows back to
 * `pending` so a `missingOnly` generator re-runs them. Backs the "reset
 * embeddings" admin path, which deletes the derived artifact (rows in
 * `media_embeddings`) but would otherwise leave the stage `completed`.
 *
 * Why this is needed: the embedding backlog is driven by stage-state STATUS,
 * not by artifact presence — `findEmbeddingCoverageTableBacklog` only returns
 * rows whose status is in `('pending','failed_transient','obsolete',
 * 'skipped_transient')`. Delete the artifact while the stage stays `completed`
 * and the backlog returns 0 candidates ⇒ the artifact is never regenerated
 * (silent, permanent loss with no auto-recovery).
 *
 * Ordering contract: MUST run in the SAME transaction as the artifact delete,
 * AFTER it. A `missingOnly` generator skips a row whose artifact still exists,
 * so any window where the row is `pending` but the artifact is present lets the
 * stage-sweep dispose it to `skipped_permanent`. Doing the delete + re-enroll
 * atomically closes that gap — the generator only ever observes the committed
 * end state (artifact gone + row pending).
 *
 * Only `completed` rows are touched: `skipped_permanent`/`failed_*` rows never
 * produced an artifact, so re-enrolling them would just churn straight back to
 * the same terminal state. Returns the number of rows re-enrolled.
 */
export async function reEnrollCompletedStageForReset(
    sql: postgres.Sql,
    stageId: string,
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'pending',
               attempt = 0,
               declines = 0,
               declines_since = NULL,
               last_error = NULL,
               next_eligible_at = now(),
               started_at = NULL,
               completed_at = NULL,
               updated_at = now()
         WHERE stage_id = ${stageId}
           AND status = 'completed'
    `;
    return result.count ?? 0;
}

/**
 * Per-item counterpart of `acceptReidentifyForStage` (ingest-map.queries.ts): accept ONE
 * non-retryable `failed_permanent` row → `skipped_permanent`. Backs the per-item
 * "Accept as expected" verb on the re-identification queue. The `retryable IS FALSE`
 * guard keeps it from silencing a transient failure the operator didn't intend to.
 *
 * `last_error` is deliberately PRESERVED (not nulled): {@link unskipItemStage} is
 * the only way back to `pending`, and an operator un-ignoring this row later needs
 * to see what was failing before they decide to retry it.
 *
 * Returns rows accepted (0 or 1).
 */
export async function acceptFailedPermanentItem(
    sql: postgres.Sql,
    input: { mediaItemId: string; stageId: string; skippedReason: string },
): Promise<number> {
    return acceptReidentifyItem(sql, input.mediaItemId, input.stageId, input.skippedReason);
}

/**
 * Self-heal recovery: flip `failed_permanent` rows for a stage to
 * `skipped_permanent` when the item's current `media_type` is outside the
 * stage's eligible set. Targets rows a NOW-fixed `appliesTo`/eligibility bug
 * seeded before the fix landed (e.g. tmdb-metadata-sync's per-item path
 * permanently rejecting series/episode ids it was never supposed to receive)
 * — those rows are stuck in `failed_permanent` forever, since the sweeper's
 * disposition passes deliberately never touch that status (see
 * `stage-disposition-runner.ts` — `running`/`completed`/`skipped_permanent`/
 * `failed_permanent` rows are left untouched by the standard predicate/
 * eligibility drain). Automatic and idempotent: once healed, a row no longer
 * matches and a repeat call is a no-op for it. Only `retryable IS FALSE` rows
 * are considered — the same guard the stage-wide accept (`acceptReidentifyForStage`) uses
 * — so a genuinely transient dead-letter that merely exhausted its retry
 * budget is left alone. Returns the number of rows healed.
 */
export async function healMisappliedFailedPermanentRows(
    sql: postgres.Sql,
    input: { stageId: string; eligibleMediaTypes: readonly string[]; skippedReason: string },
): Promise<number> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system-level stage-state maintenance invoked by the task runner (whole-catalog, no user in scope): it must heal EVERY misapplied row regardless of library/age visibility, same as the sweep-candidate queries and the re-enroll repair above.
    const result = await sql`
        UPDATE media_item_stage_state s
           SET status = 'skipped_permanent',
               skipped_reason = ${input.skippedReason},
               last_error = NULL,
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
          FROM media_items mi
         WHERE mi.id = s.media_item_id
           AND s.stage_id = ${input.stageId}
           AND s.status = 'failed_permanent'
           AND (s.last_error->>'retryable')::boolean IS FALSE
           AND NOT (mi.media_type = ANY(${input.eligibleMediaTypes as string[]}))
    `;
    return result.count ?? 0;
}

/**
 * Operator "Give up" on ONE stuck/failing (item, stage): force it to
 * `skipped_permanent` regardless of the `retryable` flag. Unlike
 * {@link acceptFailedPermanentItem} (which only accepts NON-retryable
 * `failed_permanent` rows), this is the explicit manual escape hatch for a
 * stage wedged as `failed_transient`/`failed_permanent`/`pending` — e.g. a probe
 * that keeps timing out. It does NOT touch `running` (don't yank an active
 * worker's row) or already-terminal rows. Reversible via the normal file-content
 * invalidation path, and via the explicit {@link unskipItemStage} un-ignore verb.
 *
 * `last_error` is deliberately PRESERVED (not nulled): an operator who later
 * un-ignores this row still needs to see what was failing before they retry it.
 *
 * Returns rows skipped (0 or 1 — 0 if the row changed state between render and
 * click).
 */
export async function skipItemStage(
    sql: postgres.Sql,
    input: { mediaItemId: string; stageId: string; skippedReason: string },
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'skipped_permanent',
               skipped_reason = ${input.skippedReason},
               next_eligible_at = NULL,
               invalidated_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
           AND status IN ('pending', 'failed_transient', 'failed_permanent')
    `;
    return result.count ?? 0;
}

/**
 * Un-ignore: the reverse of {@link skipItemStage} / {@link acceptFailedPermanentItem}.
 * Restores ONE `skipped_permanent` row to `pending` so it re-enters normal
 * stage-sweep processing. Before this verb existed, the only escape from
 * `skipped_permanent` was `invalidateByEvent` firing on a content or identity
 * change — an operator who ignored the wrong item had no way back from the UI.
 *
 * Clears `skipped_reason` and `next_eligible_at`. `last_error` and `attempt` are
 * left untouched: the row's prior failure history (now preserved by
 * `skipItemStage`/`acceptFailedPermanentItem`) stays visible after the restore,
 * and un-ignoring is not itself a new attempt.
 *
 * Only `skipped_permanent` rows are eligible — this cannot resurrect a
 * `failed_permanent`/`failed_transient` row (that's {@link resetFailedPermanent}'s
 * job) or touch `running`/`completed`. Returns rows restored (0 or 1 — 0 if the
 * row already changed state, e.g. self-healed via invalidation, between render
 * and click).
 */
export async function unskipItemStage(
    sql: postgres.Sql,
    input: { mediaItemId: string; stageId: string },
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'pending',
               skipped_reason = NULL,
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${input.mediaItemId}::uuid
           AND stage_id = ${input.stageId}
           AND status = 'skipped_permanent'
           -- Only an OPERATOR's skip is reversible. The disposition runner also
           -- writes skipped_permanent ('ineligible', rule ids) for stages that
           -- genuinely do not apply to an item; un-skipping one of those sets it
           -- pending, stage-sweep re-evaluates eligibility and re-skips it, and
           -- the operator watches their own action undo itself with no
           -- explanation. operatorReason() in pipeline-remediation.service.ts
           -- guarantees the prefix, including on free-text reasons.
           -- NB: no backticks in this block -- it lives inside a JS template
           -- literal, where one would terminate the string mid-query.
           AND skipped_reason LIKE 'operator-%'
    `;
    return result.count ?? 0;
}

/**
 * Batch-mark a set of items as `skipped_permanent` for a given stage.
 *
 * Used by handlers whose internal eligibility check filters items that the
 * stage's declared `eligibilityPredicate` doesn't catch — typically deeper
 * properties that require a JOIN to compute (e.g. "this episode belongs to
 * a season with fewer than 2 episodes", "this album has no MBID associated
 * via external_ids", "this series is not in the anime catalog").
 *
 * Without this, every subsequent `stage-sweep` tick keeps re-enqueueing
 * the same items because their stage_state row stays at `pending`; the
 * handler runs, finds 0 candidates, exits, repeat — costing CPU and
 * inflating "stuck" counts on the Ingest Map for items that will never
 * become eligible without an explicit invalidation (file-content change,
 * external-id reseed, etc.).
 *
 * Self-healing: when the item becomes eligible again, the relevant
 * `invalidateByKind` call flips the row back to `pending`. Permanent
 * here means "permanent until invalidation fires" — not literally
 * forever. That matches the existing semantics used by predicate-based
 * skipped_permanent rows seeded at `classifyStagesForCreate`.
 *
 * The status guard (`AND status IN ('pending', 'failed_transient',
 * 'skipped_transient')`) prevents clobbering `running`/`completed`/
 * `skipped_permanent` rows if the handler runs concurrently with a
 * per-item upsert or with itself.
 *
 * Returns the number of rows updated.
 */
export async function markSkippedPermanentBatch(
    sql: postgres.Sql,
    input: {
        stageId: string;
        mediaItemIds: string[];
        skippedReason: string;
    },
): Promise<number> {
    if (input.mediaItemIds.length === 0) return 0;
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'skipped_permanent',
               skipped_reason = ${input.skippedReason},
               next_eligible_at = NULL,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           AND media_item_id = ANY(${input.mediaItemIds}::uuid[])
           AND status IN ('pending', 'failed_transient', 'skipped_transient')
        RETURNING media_item_id
    `;
    return result.count ?? 0;
}

/**
 * Batch-mark a set of items as `completed` for a given stage.
 *
 * Skips rows that are already `completed` so the UPDATE is a no-op for them.
 * Returns the number of rows updated.
 */
export async function markCompletedBatch(
    sql: postgres.Sql,
    input: { stageId: string; mediaItemIds: string[] },
): Promise<number> {
    if (input.mediaItemIds.length === 0) return 0;
    const result = await sql`
        UPDATE media_item_stage_state
           SET status = 'completed',
               last_error = NULL,
               next_eligible_at = NULL,
               completed_at = now(),
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE stage_id = ${input.stageId}
           AND media_item_id = ANY(${input.mediaItemIds}::uuid[])
           AND status != 'completed'
        RETURNING media_item_id
    `;
    return result.count ?? 0;
}

/**
 * Reclaim `media_item_stage_state` rows stuck in `'running'` because
 * the worker died between `markRunning` and the terminal transition
 * to `'completed'` / `'failed_*'`.
 *
 * Background: when a worker container is SIGKILL'd or OOMs mid-stage,
 * boot-recovery + reconciler correctly reclaim the matching
 * `task_history` rows — but neither touches `media_item_stage_state`.
 * The stage row stays at `status='running'` forever, and stage-sweep
 * filters running rows out of its enqueue list, so nothing ever
 * re-picks them up. Surfaced via the Ingest Map's "stuck items"
 * panel as `wedged_running`.
 *
 * Reset criteria (all must hold):
 *   1. `status = 'running'`
 *   2. `updated_at < now() - <olderThanMs>` — far enough in the past
 *      that we won't race a live worker still mid-stage. Default
 *      threshold is 10 minutes which matches the project's other
 *      stale-active heuristics.
 *   3. The row's `last_run_id` is not in an active / pending /
 *      cancelling state in `task_history`. If a live run still owns
 *      this stage_id+media_item_id, we leave the row alone.
 *
 * Recovery action: status → `'failed_transient'`, attempt unchanged
 * (the worker death wasn't a logical failure of the attempt), and a
 * structured `last_error` documenting the recovery. Stage-sweep
 * re-enqueues failed_transient rows on its next tick.
 *
 * Returns the number of rows reset.
 */
export async function reclaimWedgedRunningStageRows(
    sql: postgres.Sql,
    olderThanMs = 10 * 60 * 1000,
): Promise<number> {
    const ageSecs = olderThanMs / 1000;
    // Clear next_eligible_at so the row sits in the same FIFO "ready" bucket
    // as plain pending rows. Previously the reaper stamped next_eligible_at =
    // now(), which — combined with stage-sweep's `ORDER BY next_eligible_at
    // ASC NULLS FIRST` — sorted every wedge row AFTER the entire pending
    // backlog. On a stage with 14k pending rows and 100/tick enqueue cap,
    // wedge rows were starved indefinitely (observed: 88 trickplay-generation
    // wedges accumulating untouched from May 21 to May 28).
    //
    // Preserve the original "ready since" timestamp via started_at fallback
    // so the wedge row competes for sweep priority based on when the work
    // first became eligible, not when the wedge happened to be detected.
    const result = await sql`
        UPDATE media_item_stage_state s
           SET status = 'failed_transient',
               last_error = ${sql.json({
                   message:
                       'Stage row was running but the owning task_history run is no longer active. Most likely the worker died (SIGKILL / OOM / container restart) between markRunning and the terminal transition. Recovered to failed_transient so stage-sweep will retry on the next tick.',
                   code: 'WEDGED_RUNNING_RECOVERY',
               })},
               next_eligible_at = NULL,
               updated_at = COALESCE(s.started_at, s.updated_at)
         WHERE s.status = 'running'
           AND s.updated_at < now() - make_interval(secs => ${ageSecs})
           AND NOT EXISTS (
               SELECT 1 FROM task_history th
                WHERE th.id = s.last_run_id
                  AND th.state IN ('pending', 'active', 'cancelling')
           )
    `;
    return result.count ?? 0;
}

/**
 * Operator-forced, stage-scoped sibling of {@link reclaimWedgedRunningStageRows}: release
 * the wedged `running` rows for ONE stage immediately (no age gate), so the admin can
 * unstick a stage from the attention drawer on demand. Keeps the same critical safety
 * guard — only flips rows whose owning task_history run is NO LONGER active — so it can
 * never race a live worker. Stage-sweep re-enqueues the resulting failed_transient rows.
 * Returns the number of rows released.
 */
export async function releaseWedgedRunningForStage(
    sql: postgres.Sql,
    stageId: string,
): Promise<number> {
    const result = await sql`
        UPDATE media_item_stage_state s
           SET status = 'failed_transient',
               last_error = ${sql.json({
                   message:
                       'Operator forced a release of a wedged running stage row from the attention drawer. The owning task_history run was no longer active, so the row was recovered to failed_transient for stage-sweep to retry.',
                   code: 'WEDGED_RUNNING_OPERATOR_RELEASE',
               })},
               next_eligible_at = NULL,
               updated_at = COALESCE(s.started_at, s.updated_at)
         WHERE s.stage_id = ${stageId}
           AND s.status = 'running'
           AND NOT EXISTS (
               SELECT 1 FROM task_history th
                WHERE th.id = s.last_run_id
                  AND th.state IN ('pending', 'active', 'cancelling')
           )
    `;
    return result.count ?? 0;
}

/** Coverage of one stage across the items that should have it. */
export interface StageCoverage {
    /** Items that ought to carry a row for this stage. */
    eligibleItems: number;
    /** Items carrying a row in any status. */
    withRow: number;
    completed: number;
    pending: number;
    running: number;
    failedTransient: number;
    failedPermanent: number;
    skipped: number;
    obsolete: number;
}

/**
 * How much of the eligible library one stage actually covers.
 *
 * ## `withoutRow` is the number that matters, and it is derived here
 *
 * Counting rows BY STATUS answers "how is the work going". It cannot answer
 * "was the work ever queued", because an item with no row at all contributes to
 * no bucket — it is invisible to every status count and to the progress bar
 * built from them. That is not hypothetical: stage rows are seeded from the task
 * registry snapshot at item-creation time, so a stage registered LATER gets no
 * row for pre-existing items, and a prod incident left 11,186 items with no
 * trickplay coverage while every dashboard read clean.
 *
 * So eligibility is counted independently of the rows and the difference is
 * reported. `eligibleItems - withRow` is the silent-gap number.
 *
 * ## Eligibility is deliberately coarse
 *
 * "Items with files, of these media types, active and not dismissed" — the same
 * population `findSweepCandidates` filters to. A stage's own `eligibility` block
 * may narrow further, so this OVER-counts rather than under-counts: reporting a
 * gap that turns out to be a deliberate skip is a recoverable annoyance, while
 * hiding a real gap is the failure mode this exists to catch.
 */
export async function getStageCoverage(
    sql: postgres.Sql,
    stageId: string,
    mediaTypes: readonly string[],
): Promise<StageCoverage> {
    // Deliberately ungated against library access. This returns COUNTS ONLY —
    // no ids, titles or any per-item field — and its sole caller is an
    // admin-scoped fix endpoint. A per-viewer access filter here would be
    // actively wrong: an operator asking "how much of my library has no seek
    // previews" must be told about the whole library, not their slice of it.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<
        {
            eligible_items: number;
            with_row: number;
            completed: number;
            pending: number;
            running: number;
            failed_transient: number;
            failed_permanent: number;
            skipped: number;
            obsolete: number;
        }[]
    >`
        WITH eligible AS (
            SELECT mi.id
              FROM media_items mi
             WHERE mi.media_type = ANY(${sql.array(mediaTypes as string[])}::text[])
               AND mi.has_files = true
               AND mi.status = 'active'
               AND COALESCE(mi.is_dismissed, false) = false
        )
        SELECT (SELECT COUNT(*)::int FROM eligible) AS eligible_items,
               COUNT(s.*)::int                                                        AS with_row,
               COUNT(*) FILTER (WHERE s.status = 'completed')::int                    AS completed,
               COUNT(*) FILTER (WHERE s.status = 'pending')::int                      AS pending,
               COUNT(*) FILTER (WHERE s.status = 'running')::int                      AS running,
               COUNT(*) FILTER (WHERE s.status = 'failed_transient')::int             AS failed_transient,
               COUNT(*) FILTER (WHERE s.status = 'failed_permanent')::int             AS failed_permanent,
               COUNT(*) FILTER (WHERE s.status IN ('skipped_permanent','skipped_transient'))::int AS skipped,
               COUNT(*) FILTER (WHERE s.status = 'obsolete')::int                     AS obsolete
          FROM eligible e
          LEFT JOIN media_item_stage_state s
                 ON s.media_item_id = e.id
                AND s.stage_id = ${stageId}
    `;
    return {
        eligibleItems: row?.eligible_items ?? 0,
        withRow: row?.with_row ?? 0,
        completed: row?.completed ?? 0,
        pending: row?.pending ?? 0,
        running: row?.running ?? 0,
        failedTransient: row?.failed_transient ?? 0,
        failedPermanent: row?.failed_permanent ?? 0,
        skipped: row?.skipped ?? 0,
        obsolete: row?.obsolete ?? 0,
    };
}
