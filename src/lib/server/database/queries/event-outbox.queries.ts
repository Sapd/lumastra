// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pipeline event outbox — pure SQL helpers for the
 * `pipeline-event-dispatcher.service.ts` drain loop.
 *
 * The dispatcher owns transitions; this module only exposes
 * stateless queries.
 */
import type postgres from 'postgres';
import type { PipelineEventName, PipelineEventPayload } from '$lib/types/pipeline.js';

export interface EventOutboxRow {
    id: string;
    event_name: PipelineEventName;
    media_item_id: string;
    payload: PipelineEventPayload;
    attempts: number;
}

/**
 * Reserve up to `limit` drainable events for the calling worker. The
 * `FOR UPDATE SKIP LOCKED` clause ensures only one dispatcher replica
 * touches any given row even before the leader-lock kicks in — defense
 * in depth.
 *
 * Returns rows ordered by `next_retry_at NULLS FIRST, id` so retries
 * land after their backoff and fresh inserts go out FIFO.
 *
 * `shard` restricts the query to one deterministic slice of the outbox by
 * `hashtext(media_item_id)`. The parallel dispatcher runs `total` workers,
 * each passing its own `index`; because an item always hashes to the same
 * shard, ALL of a given item's events are drained by ONE worker in the SAME
 * `(next_retry_at NULLS FIRST, id)` order the serial drain uses — so per-item
 * ordering is byte-for-byte identical to serial, while different items proceed
 * in parallel. (The parallelism introduces no NEW reordering; it inherits
 * serial's exact per-item order. Note that order is not strictly by `id`: a
 * fresh event, `next_retry_at IS NULL`, still sorts ahead of an older
 * same-item event that is in retry-backoff — a pre-existing property, not a
 * consequence of sharding.) Omit (or `total <= 1`) for the unsharded serial
 * behaviour.
 * The `((h % t) + t) % t` form normalises Postgres's signed `%` (and avoids
 * the `abs(INT_MIN)` overflow trap) to a non-negative shard in `[0, total)`.
 *
 * NOTE: the shard is a post-filter on the `idx_event_outbox_drainable`
 * `(next_retry_at NULLS FIRST, id)` scan, not an index condition, so each
 * worker walks ~`total` index tuples to lock one shard-matching row. At the
 * auto-sized default (`total` 1..4) that amplification is negligible; if this
 * is ever raised much higher, add a stored shard-bucket column + index.
 */
export async function lockDrainableEvents(
    sql: postgres.Sql,
    limit: number,
    shard?: { index: number; total: number },
): Promise<EventOutboxRow[]> {
    const shardPredicate =
        shard && shard.total > 1
            ? sql`AND ((hashtext(media_item_id::text) % ${shard.total}) + ${shard.total}) % ${shard.total} = ${shard.index}`
            : sql``;
    return sql<EventOutboxRow[]>`
        SELECT id::text AS id, event_name, media_item_id::text AS media_item_id,
               payload, attempts
          FROM event_outbox
         WHERE consumed_at IS NULL
           AND NOT dead_letter
           AND (next_retry_at IS NULL OR next_retry_at <= now())
           ${shardPredicate}
         ORDER BY next_retry_at NULLS FIRST, id
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
    `;
}

/**
 * Mark a successfully-drained event consumed. Called after every
 * registered handler for that row succeeded.
 */
export async function markEventConsumed(sql: postgres.Sql, id: string): Promise<void> {
    await sql`
        UPDATE event_outbox
           SET consumed_at = now()
         WHERE id = ${id}::bigint
    `;
}

/**
 * Record a handler failure for the event. Increments attempts, sets
 * `next_retry_at` to `NOW() + backoff`, stores the error message. When
 * `attempts` exceeds `maxAttempts`, transitions to dead-letter.
 *
 * Backoff schedule: `2^attempts` seconds, capped at 10 minutes.
 */
export async function recordEventFailure(
    sql: postgres.Sql,
    input: { id: string; errorMessage: string; maxAttempts: number },
): Promise<{ deadLettered: boolean; nextAttempts: number }> {
    const rows = await sql<{ attempts: number; dead_letter: boolean }[]>`
        WITH updated AS (
            UPDATE event_outbox
               SET attempts = attempts + 1,
                   last_error = ${input.errorMessage.slice(0, 500)},
                   next_retry_at = CASE
                       WHEN attempts + 1 >= ${input.maxAttempts}
                           THEN NULL
                       ELSE
                           now() + make_interval(
                               secs => LEAST(POWER(2, attempts + 1)::int, 600)
                           )
                   END,
                   dead_letter = (attempts + 1) >= ${input.maxAttempts}
             WHERE id = ${input.id}::bigint
         RETURNING attempts, dead_letter
        )
        SELECT * FROM updated
    `;
    const r = rows[0];
    return {
        deadLettered: r?.dead_letter ?? false,
        nextAttempts: r?.attempts ?? 0,
    };
}

/**
 * App-side emit. Mirrors the SQL `emit_pipeline_event` function but
 * lets the lifecycle service emit events that don't have a DB-row-
 * transition source (item.created after seed, item.dismissed, item.deleted,
 * item.reclaimed). Caller is expected to be inside the same outer
 * transaction as the originating service call — pass the transaction
 * `sql` handle.
 *
 * No-ops silently when the feature flag is 'off' so call sites can be
 * added before Phase B without changing behavior.
 */
export async function emitPipelineEvent(
    sql: postgres.Sql,
    event: PipelineEventName,
    mediaItemId: string,
    payload: PipelineEventPayload,
): Promise<void> {
    await sql`
        SELECT emit_pipeline_event(
            ${event},
            ${mediaItemId}::uuid,
            ${sql.json(payload)}
        )
    `;
}

/**
 * App-side flag setter. Called from `hooks.server.ts` startup so the
 * DB feature_flags row matches the running container's env var.
 *
 * **Semantics: turn-on-only.** During a rolling deploy where replicas
 * boot with mismatched env vars (e.g. one was rebuilt with the flag
 * enabled, another still has the previous image), a last-writer-wins
 * `value = EXCLUDED.value` upsert would let a disabled replica flip
 * the flag back to 'off' AFTER an enabled replica turned it on —
 * silently disabling DB trigger writes and losing pipeline events
 * until the rollback finishes. To avoid that data-loss window we
 * preserve any pre-existing 'on' value: a single replica with the
 * flag on keeps the system on. To turn the flag OFF cluster-wide,
 * deploy every replica with the env var unset / false AND update
 * the row manually via SQL (it never auto-downgrades).
 *
 * On mismatch (local env=false but DB=on), the caller logs a
 * warning so the operator notices the inconsistency.
 */
export async function syncEventOutboxFlag(
    sql: postgres.Sql,
    enabled: boolean,
): Promise<{ effective: boolean; conflict: boolean }> {
    const target = enabled ? 'on' : 'off';
    const rows = await sql<{ value: string }[]>`
        INSERT INTO feature_flags (key, value)
        VALUES ('event_outbox_enabled', ${target})
        ON CONFLICT (key) DO UPDATE
           SET value = CASE
                   -- Only flip to 'on'; never auto-downgrade. See docstring.
                   WHEN EXCLUDED.value = 'on' THEN 'on'
                   ELSE feature_flags.value
               END,
               updated_at = now()
     RETURNING value
    `;
    const effective = (rows[0]?.value ?? 'off') === 'on';
    const conflict = effective !== enabled;
    return { effective, conflict };
}

/**
 * Per-item `event_outbox` history (Slice 2 — Per-Item Traceability).
 *
 * First reader of `event_outbox` keyed by media item: surfaces the per-item
 * event narrative (file.attached → metadata.changed → identity.assigned …) on
 * the pipeline timeline. Read-only; ordered newest-first.
 *
 * `limit` is clamped here as a defense-in-depth backstop (default 50, max 200)
 * even though the route also clamps — a query module must not trust its caller.
 */
export interface ItemEventOutboxRow {
    id: string;
    event_name: string;
    payload: unknown;
    attempts: number;
    created_at: Date;
    consumed_at: Date | null;
    next_retry_at: Date | null;
    dead_letter: boolean;
    last_error: string | null;
}

export async function findEventsByItem(
    sql: postgres.Sql,
    mediaItemId: string,
    limit = 50,
): Promise<ItemEventOutboxRow[]> {
    const truncated = Math.trunc(limit);
    // NaN → default 50; otherwise clamp into [1, 200] (explicit 0 → 1).
    const clamped = Number.isNaN(truncated) ? 50 : Math.max(1, Math.min(truncated, 200));
    return sql<ItemEventOutboxRow[]>`
        SELECT id::text AS id, event_name, payload, attempts,
               created_at, consumed_at, next_retry_at, dead_letter, last_error
          FROM event_outbox
         WHERE media_item_id = ${mediaItemId}::uuid
         ORDER BY id DESC
         LIMIT ${clamped}
    `;
}

/**
 * Admin-only counter for the Ingest Map dead-letter card.
 */
export async function countDeadLetterEvents(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c FROM event_outbox WHERE dead_letter
    `;
    return row?.c ?? 0;
}

/**
 * One row per distinct dead-lettered `event_name`, with its count and a sample
 * error, ordered by count descending and bounded by `limit`. Feeds the
 * operator "attention" warning (`adaptOutboxDeadLetter`): a dead-lettered
 * pipeline event is a recovery signal that gave up after MAX_ATTEMPTS, so the
 * stage invalidation it carried never propagated — silent staleness that today
 * only ever surfaces in the logs.
 */
export interface DeadLetterEventSummaryRow {
    event_name: string;
    cnt: number;
    last_error: string | null;
}

export async function summarizeDeadLetterEvents(
    sql: postgres.Sql,
    limit = 20,
): Promise<DeadLetterEventSummaryRow[]> {
    const truncated = Math.trunc(limit);
    const clamped = Number.isNaN(truncated) ? 20 : Math.max(1, Math.min(truncated, 100));
    return sql<DeadLetterEventSummaryRow[]>`
        SELECT event_name,
               COUNT(*)::int AS cnt,
               (array_agg(last_error) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
          FROM event_outbox
         WHERE dead_letter
         GROUP BY event_name
         ORDER BY cnt DESC, event_name
         LIMIT ${clamped}
    `;
}

/**
 * A dead-lettered row that is still within its auto-requeue budget. The
 * dispatcher selects these, filters to transient `last_error`s (via the shared
 * `isTransientPgError` classifier — single source of truth, so the SQL layer
 * carries no duplicate regex), and requeues the matching ids.
 */
export interface DeadLetterRequeueCandidate {
    id: string;
    last_error: string | null;
    auto_requeue_count: number;
}

/**
 * Dead-lettered rows still under the per-row auto-requeue budget
 * (`auto_requeue_count < maxAutoRequeue`), for transient-error auto-recovery.
 * Ordered oldest-first so a backlog drains FIFO; `limit` bounds one pass.
 */
export async function findAutoRequeuableDeadLetters(
    sql: postgres.Sql,
    maxAutoRequeue: number,
    limit = 200,
): Promise<DeadLetterRequeueCandidate[]> {
    const truncated = Math.trunc(limit);
    const clamped = Number.isNaN(truncated) ? 200 : Math.max(1, Math.min(truncated, 1000));
    return sql<DeadLetterRequeueCandidate[]>`
        SELECT id::text AS id, last_error, auto_requeue_count
          FROM event_outbox
         WHERE dead_letter
           AND auto_requeue_count < ${maxAutoRequeue}
         ORDER BY id
         LIMIT ${clamped}
    `;
}

/**
 * Requeue specific dead-lettered rows by id: clear `dead_letter`, reset
 * `attempts`/`next_retry_at`/`last_error`, and INCREMENT `auto_requeue_count`
 * so the bound shrinks. This is the dispatcher's automatic path — a row that
 * keeps re-dead-lettering eventually exhausts its budget and is left for an
 * operator. Returns the number of rows actually requeued (rows that changed
 * state between select and update are skipped via the `dead_letter` guard).
 */
export async function requeueDeadLetterEventsAuto(
    sql: postgres.Sql,
    ids: string[],
): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await sql<{ id: string }[]>`
        UPDATE event_outbox
           SET dead_letter = false,
               attempts = 0,
               next_retry_at = NULL,
               last_error = NULL,
               auto_requeue_count = auto_requeue_count + 1
         WHERE id = ANY(${ids}::bigint[])
           AND dead_letter
        RETURNING id::text AS id
    `;
    return rows.length;
}

/**
 * Manual operator requeue of ALL dead-lettered events (the "Requeue" action on
 * the admin Operations spine). Resets `auto_requeue_count` to 0 so the operator
 * grants a fresh auto-recovery budget — the explicit intent is "I addressed the
 * underlying cause, give every parked event another full run." Returns rows
 * requeued.
 */
export async function requeueAllDeadLetterEvents(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        UPDATE event_outbox
           SET dead_letter = false,
               attempts = 0,
               next_retry_at = NULL,
               last_error = NULL,
               auto_requeue_count = 0
         WHERE dead_letter
        RETURNING id::text AS id
    `;
    return rows.length;
}
