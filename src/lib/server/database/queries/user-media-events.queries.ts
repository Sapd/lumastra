// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Media Events Query Module
 *
 * Append-only event log that backs the new watch-state system. Every
 * state change (progress tick, manual mark, sync report) is inserted
 * as an immutable row here. The derived `user_media_state` table is
 * rebuilt from these events via the watch-state rebuilder service.
 *
 * Events are never physically deleted in normal operation. Admin
 * repudiation (e.g. "wipe a bad Jellyfin sync window") soft-deletes
 * by setting `repudiated_at`; readers and the rebuilder ignore
 * repudiated rows.
 *
 * Idempotency:
 *   INSERTs with a `source_event_id` are deduped via a unique
 *   constraint on `(user_id, media_id, source, source_event_id)`.
 *   Callers can therefore safely retry without producing duplicates.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { defineQuery, defineWriteQuery } from '../typed-query.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Event categories written to `user_media_events`. Every source writes
 * a subset of these:
 *   - 'progress'        → periodic playback position tick
 *   - 'completed'       → end-of-file auto-complete (crosses threshold)
 *   - 'mark_watched'    → explicit "I watched this" action
 *   - 'mark_unwatched'  → explicit "actually, I haven't" action
 *   - 'state_snapshot'  → compaction marker; carries `snapshot_state`
 *                         JSON of the computed state at the snapshot's
 *                         `occurred_at`. Internal — never written by
 *                         user/external sources, only by the rebuilder.
 */
export type EventType =
    'progress' | 'completed' | 'mark_watched' | 'mark_unwatched' | 'state_snapshot';

/**
 * Systems that can write events. `lumastra-user-mark` outranks every
 * sync source in arbitration because it represents a deliberate user
 * action inside Lumastra. `compaction` is reserved for snapshot events
 * written internally by the rebuilder; it never participates in
 * arbitration directly because snapshot events are filtered as the
 * rebuild base case.
 */
export type EventSource =
    | 'lumastra-player'
    | 'lumastra-offline'
    | 'lumastra-user-mark'
    | 'jellyfin-sync'
    | 'plex-sync'
    | 'mal-sync'
    | 'trakt-sync'
    | 'audiobookshelf-sync'
    | 'migration'
    | 'compaction';

/**
 * Sources whose events are pushed OUT to remote providers (Jellyfin, Plex,
 * Trakt, AudiobookShelf). Exported as a constant because this set is consumed
 * from raw SQL in four places inside getUnpushedLumastraItems; a literal list
 * repeated per site is how 'lumastra-offline' would silently reach only half of
 * them and never leave the server on one code path.
 */
export const PUSHABLE_SOURCES: readonly EventSource[] = [
    'lumastra-player',
    'lumastra-offline',
    'lumastra-user-mark',
];

/**
 * Sources that represent a real action by this user in Lumastra, as opposed to
 * an upstream import. Used by suspicious-item vetoes.
 */
export const USER_DRIVEN_SOURCES: readonly EventSource[] = [
    'lumastra-player',
    'lumastra-offline',
    'lumastra-user-mark',
];

/**
 * Sources for which a burst of completions in a short window is normal and must
 * NOT be reported as a suspicious bulk-mark cascade. An offline flush is a
 * burst by construction: a week of playback uploads in one request.
 */
export const BULK_BY_DESIGN_SOURCES: readonly EventSource[] = [
    'lumastra-user-mark',
    'lumastra-offline',
    'migration',
];

/**
 * Computed state captured by a `state_snapshot` event. Mirrors
 * `UserMediaStateRow` plus a verdict-source pointer used by the
 * rebuilder to arbitrate against future back-dated events.
 *
 * Stored as `jsonb` in `user_media_events.snapshot_state`.
 *
 * `is_watched_source` records the source whose latest decisive event
 * drove `is_watched` at compaction time. Without this, a back-dated
 * lower-priority event arriving after the snapshot would silently win
 * the per-source priority loop because the snapshot's own verdict
 * source isn't represented in the loop's `latestBySource` map. The
 * rebuilder injects a synthetic event from this source at the
 * snapshot's `occurred_at` so priority arbitration sees both candidates
 * and picks correctly. Optional for back-compat with snapshots written
 * before this field was introduced.
 */
export interface SnapshotState {
    jellyfin_unwatch_acknowledged_at?: string | null;
    is_watched: boolean;
    /**
     * Source whose latest decisive event drove `is_watched` at the
     * time the snapshot was written. Only populated for snapshots
     * written after the M2 review pass that introduced verdict-source
     * tracking — older snapshots leave this null and the rebuilder
     * falls back to `last_event_source` as a heuristic.
     */
    is_watched_source: string | null;
    resume_position_ms: number;
    runtime_ms: number | null;
    watch_count: number;
    first_watched_at: string | null;
    last_watched_at: string | null;
    last_event_at: string | null;
    last_event_source: string | null;
    /**
     * max(session_elapsed_ms) over lumastra-player progress events
     * arbitrating to this snapshot. Carried so a recompute after
     * compaction (whose visible event window is post-snapshot only)
     * still has access to pre-snapshot engagement data. NULL on
     * snapshots written before this field existed; the rebuilder
     * still has the materialised column on user_media_state to fall
     * back to via the upsertState GREATEST merge.
     */
    highest_session_elapsed_ms: number | null;
}

/**
 * Row shape for `user_media_events`.
 *
 * `position_ms` / `runtime_ms` are stored as bigint in Postgres and come
 * back from the driver as JavaScript numbers when within safe-integer
 * range, which matches the rest of this codebase's convention.
 */
export interface UserMediaEvent {
    id: string;
    user_id: UserId;
    media_id: string;
    event_type: EventType;
    source: EventSource;
    position_ms: number | null;
    runtime_ms: number | null;
    source_event_id: string | null;
    session_id: string | null;
    event_seq: number | null;
    repudiated_at: string | null;
    /**
     * Populated only on rows where `event_type = 'state_snapshot'`. Holds
     * the computed state at the snapshot's `occurred_at` so the rebuilder
     * can use it as a base case instead of walking the full history.
     */
    snapshot_state: SnapshotState | null;
    /**
     * Cumulative milliseconds the player was actually *playing* (not paused,
     * not buffering, not seeking) within this session_id at the moment the
     * event was recorded. Carried by lumastra-player progress events; NULL
     * for events from sources that don't track engagement (jellyfin-sync,
     * plex-sync, lumastra-user-mark, migration, compaction) and for legacy
     * rows. Used by the rebuilder to derive
     * `user_media_state.highest_session_elapsed_ms` for the engagement-
     * based CW filter — a scrub-and-leave session emits a single progress
     * event with `session_elapsed_ms < threshold`, so the row never
     * surfaces in Continue Watching even though `position_ms` may be 50%
     * of runtime.
     */
    session_elapsed_ms: number | null;
    /**
     * Offline reports only: when the reporting client last incorporated
     * server state for this item. Anything another source wrote after this
     * instant was invisible to it, which is what lets the rebuilder refuse a
     * regression the reporter could not have known it was causing.
     *
     * NULL carries two different meanings and both are load-bearing — see
     * `resolveResumePosition` and migration 16.226.0. On a non-offline source
     * it means there is no blind spot at all (that source *is* the current
     * knowledge). On a `lumastra-offline` event it means the blind spot is
     * unbounded, because the client is too old to report one.
     */
    knowledge_as_of: string | null;
    /**
     * Providers this event has already been pushed/synced out to (e.g.
     * `'jellyfin'`, `'plex'`). Server-managed: starts as `[]` and is
     * extended by `markEventsPushed`. Used to avoid re-pushing the same
     * event to a downstream provider twice.
     */
    pushed_to_providers: string[];
    /** Server-managed delivery metadata; omitted by older in-memory fixtures. */
    sync_delivery?: Record<
        string,
        {
            attempts?: number;
            last_reason?: string;
            next_attempt_at?: string;
            acknowledged_at?: string;
        }
    >;

    occurred_at: string;
    recorded_at: string;
}

/**
 * Input shape for inserts — everything except server-managed columns.
 * `occurred_at` is provided by the caller because some sources (e.g.
 * Jellyfin backfill) report historical timestamps that are NOT "now".
 *
 * `snapshot_state` is optional because nearly every caller writes a
 * non-snapshot event and shouldn't be forced to set the field to NULL
 * explicitly. Only the rebuilder's compaction path sets it.
 */
export type NewUserMediaEvent = Omit<
    UserMediaEvent,
    | 'id'
    | 'repudiated_at'
    | 'recorded_at'
    | 'sync_delivery'
    | 'snapshot_state'
    | 'session_elapsed_ms'
    | 'knowledge_as_of'
    | 'pushed_to_providers'
    | 'user_id'
> & {
    /**
     * Stable users.id UUID — the user-data key (since migration 16.46.0).
     * Branded so a username can never be written here by mistake.
     */
    user_id: UserId;
    /**
     * ISO timestamp when the originating session was started.
     * Used by the stale-tab guard in appendEventAndRebuild to distinguish
     * a fresh session from an old tab's lagging event. Optional — callers
     * that don't have the session row (non-player paths) may omit it and
     * the guard will fall back to occurred_at.
     */
    session_started_at?: string | null;

    /**
     * State payload for `'state_snapshot'` events. Required when
     * `event_type === 'state_snapshot'`; ignored otherwise. Optional so
     * non-snapshot writers don't need to set it explicitly to null.
     */
    snapshot_state?: SnapshotState | null;

    /**
     * Cumulative playing time in this session at event time. Optional
     * because only the lumastra player can compute it — sync sources,
     * mark events, and snapshots all leave it unset. Stored as NULL on
     * the DB row when absent.
     */
    session_elapsed_ms?: number | null;

    /**
     * ISO timestamp at which the reporting client last incorporated server
     * state for this item. Only the offline-playback ingest can supply it;
     * every other writer omits it and keeps unchanged latest-wins
     * arbitration. See the field's doc on `UserMediaEvent`.
     */
    knowledge_as_of?: string | null;
};

// =============================================================================
// Write queries
// =============================================================================

/**
 * Insert a new event. When `source_event_id` is supplied the INSERT is
 * idempotent — repeated calls with the same
 * `(user_id, media_id, source, source_event_id)` collapse to a single row.
 *
 * When `source_event_id` is NULL the partial unique index does not fire
 * and the row is always inserted (intended for sources without a stable
 * event key, such as internal player heartbeats).
 */
export const insertEvent = defineWriteQuery<{ event: NewUserMediaEvent }, UserMediaEvent>(
    'insertEvent',
    (sql, { event }) => sql`
        INSERT INTO user_media_events (
            user_id,
            media_id,
            event_type,
            source,
            position_ms,
            runtime_ms,
            source_event_id,
            session_id,
            event_seq,
            snapshot_state,
            session_elapsed_ms,
            knowledge_as_of,
            occurred_at
        ) VALUES (
            ${event.user_id},
            ${event.media_id},
            ${event.event_type},
            ${event.source},
            ${event.position_ms},
            ${event.runtime_ms},
            ${event.source_event_id},
            ${event.session_id},
            ${event.event_seq},
            ${
                event.snapshot_state == null
                    ? null
                    : sql.json(event.snapshot_state as unknown as postgres.JSONValue)
            },
            ${event.session_elapsed_ms ?? null},
            ${event.knowledge_as_of ?? null},
            CASE WHEN ${event.source} IN ('lumastra-player', 'lumastra-offline')
                THEN LEAST(${event.occurred_at}::timestamptz, clock_timestamp() + INTERVAL '1 second')
                ELSE ${event.occurred_at}::timestamptz END
        )
        ON CONFLICT (user_id, media_id, source, source_event_id)
            WHERE source_event_id IS NOT NULL
            DO NOTHING
        RETURNING *
    `,
);

/**
 * Soft-delete events in a (source, time-window) by setting
 * `repudiated_at = NOW()`. Used by the admin repudiate tool to walk
 * back a bad sync pass or similar. Already-repudiated rows are left
 * alone so the timestamp reflects the original repudiation.
 *
 * Snapshot interaction: a `state_snapshot` event derives its payload
 * from the events that preceded it. Repudiating any of those base
 * events leaves the snapshot stale, which would silently feed bad data
 * into future rebuilds. To keep the rebuilder safe we ALSO repudiate
 * every live snapshot for any (user, media) pair touched by the
 * repudiation. The next rebuild for those pairs sees no live snapshot
 * and falls back to a full-history compute, which is correct.
 *
 * Returns the count of newly-repudiated rows AND the distinct media_ids
 * touched. Retrying an upstream cleanup after a failed attempt goes through
 * `getRepudiatedUnwatchedMediaIds`, since a repeat call repudiates nothing new.
 */
export async function repudiateEvents(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        source: EventSource;
        fromTs: string;
        toTs: string;
    },
): Promise<{ count: number; mediaIds: string[] }> {
    const rows = await sql<{ id: string; media_id: string }[]>`
        UPDATE user_media_events
        SET repudiated_at = NOW()
        WHERE user_id = ${params.userId}
          AND source = ${params.source}
          AND occurred_at >= ${params.fromTs}
          AND occurred_at <= ${params.toTs}
          AND repudiated_at IS NULL
        RETURNING id, media_id
    `;

    const distinctMediaIds = Array.from(new Set(rows.map((r) => r.media_id)));

    // Cascade snapshot invalidation: any (user, media) pair touched
    // above gets its live snapshots repudiated too. Without this,
    // future rebuilds could read a snapshot whose payload was computed
    // from now-repudiated events.
    if (distinctMediaIds.length > 0) {
        await sql`
            UPDATE user_media_events
            SET repudiated_at = NOW()
            WHERE user_id = ${params.userId}
              AND media_id = ANY(${distinctMediaIds}::uuid[])
              AND event_type = 'state_snapshot'
              AND repudiated_at IS NULL
        `;
    }

    return { count: rows.length, mediaIds: distinctMediaIds };
}

/**
 * Distinct media ids with an already-repudiated event of `source` in the
 * window, minus media the user currently has as watched. Lets the admin
 * repudiate tool retry a failed upstream unmark: a second call finds no newly
 * repudiated rows, but the media of the earlier repudiation are still here.
 * Watched media are left out so a genuine later rewatch is never wiped upstream.
 * Call after the watch state rebuild so `user_media_state` is current.
 */
export async function getRepudiatedUnwatchedMediaIds(
    sql: postgres.Sql,
    params: { userId: UserId; source: EventSource; fromTs: string; toTs: string },
): Promise<string[]> {
    const rows = await sql<{ media_id: string }[]>`
        SELECT DISTINCT e.media_id
        FROM user_media_events e
        WHERE e.user_id = ${params.userId}
          AND e.source = ${params.source}
          AND e.occurred_at >= ${params.fromTs}
          AND e.occurred_at <= ${params.toTs}
          AND e.repudiated_at IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM user_media_state s
              WHERE s.user_id = e.user_id
                AND s.media_id = e.media_id
                AND s.is_watched = true
          )
    `;
    return rows.map((r) => r.media_id);
}

/** Counts the repudiate endpoint returns (and audits) for its Jellyfin unmark. */
export interface JellyfinUnmarkStats {
    attempted: number;
    succeeded: number;
    failed: number;
    skippedNoExternalId: number;
}

/**
 * A repudiated jellyfin-sync window whose Jellyfin unmark may not have taken.
 * Bounds are ISO 8601 UTC with microseconds, ready for the repudiate endpoint.
 */
export interface PendingJellyfinUnmarkWindow {
    repudiated_at: string;
    from_ts: string;
    to_ts: string;
    event_count: number;
    /** Media the user has not watched since and that have a Jellyfin id. */
    pending_media_count: number;
    /** Latest audited repudiate call covering the window; null when none is recorded. */
    last_attempt_at: string | null;
    /** That call's unmark stats; null when it did not unmark (or none is recorded). */
    last_unmark: JellyfinUnmarkStats | null;
}

/**
 * Repudiated jellyfin-sync windows of one user whose Jellyfin unmark may not
 * have taken, newest first, for the provenance page's retry list.
 *
 * A window is the events one repudiate call marked: they share its
 * `repudiated_at` (`NOW()` of its transaction). It is listed when it still has
 * pending media (as `getRepudiatedUnwatchedMediaIds`, plus a Jellyfin id; an
 * item without one is never unmarked) and the latest `watch_events.repudiate`
 * audit row covering it reports failures, or reports no unmark, or is missing.
 * Lumastra keeps no other record of whether an unmark took, so a missing audit
 * row (best-effort write, pruned) counts as "may not have taken"; the lookback
 * should not exceed the admin audit retention for that reason.
 */
export async function getPendingJellyfinUnmarkWindows(
    sql: postgres.Sql,
    params: { userId: UserId; lookbackDays: number; limit: number },
): Promise<PendingJellyfinUnmarkWindow[]> {
    return sql<PendingJellyfinUnmarkWindow[]>`
        WITH windows AS (
            SELECT
                e.repudiated_at,
                MIN(e.occurred_at)  AS from_ts,
                MAX(e.occurred_at)  AS to_ts,
                COUNT(*)::int       AS event_count,
                COUNT(DISTINCT e.media_id) FILTER (
                    WHERE NOT EXISTS (
                        SELECT 1 FROM user_media_state s
                        WHERE s.user_id = e.user_id
                          AND s.media_id = e.media_id
                          AND s.is_watched = true
                    )
                    AND EXISTS (
                        SELECT 1 FROM external_ids x
                        WHERE x.media_id = e.media_id
                          AND x.provider = 'jellyfin'
                    )
                )::int AS pending_media_count
            FROM user_media_events e
            WHERE e.user_id = ${params.userId}
              AND e.source = 'jellyfin-sync'
              AND e.repudiated_at IS NOT NULL
              AND e.repudiated_at >= NOW() - make_interval(days => ${params.lookbackDays})
            GROUP BY e.repudiated_at
        ),
        assessed AS (
            SELECT w.*, a.ts AS last_attempt_at, a.detail -> 'jellyfinUnmark' AS last_unmark
            FROM windows w
            LEFT JOIN LATERAL (
                SELECT al.ts, al.detail
                FROM audit_log al
                WHERE al.source = 'admin'
                  AND al.ts >= w.repudiated_at
                  AND al.target = ${params.userId}::text
                  -- CASE: cast only this action's bounds, whatever order the
                  -- planner evaluates the other conditions in.
                  AND CASE WHEN al.action = 'watch_events.repudiate'
                            AND al.detail ->> 'source' = 'jellyfin-sync'
                       THEN (al.detail ->> 'fromTs')::timestamptz <= w.from_ts
                        AND (al.detail ->> 'toTs')::timestamptz >= w.to_ts
                       ELSE FALSE
                  END
                ORDER BY al.ts DESC
                LIMIT 1
            ) a ON TRUE
            WHERE w.pending_media_count > 0
        )
        SELECT
            to_char(repudiated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS repudiated_at,
            to_char(from_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')       AS from_ts,
            to_char(to_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')         AS to_ts,
            event_count,
            pending_media_count,
            to_char(last_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_attempt_at,
            CASE WHEN jsonb_typeof(last_unmark) = 'object' THEN last_unmark END AS last_unmark
        FROM assessed
        WHERE jsonb_typeof(last_unmark) IS DISTINCT FROM 'object'
           OR COALESCE((last_unmark ->> 'failed')::int, 0) > 0
        ORDER BY assessed.repudiated_at DESC
        LIMIT ${params.limit}
    `;
}

// =============================================================================
// Read queries
// =============================================================================

/**
 * All live (non-repudiated) events for one (user, media), newest first.
 *
 * Used by admin tooling and integration tests that genuinely need the
 * full log. The hot rebuild path goes through `getEventsSinceLastSnapshot`
 * instead so cost stays bounded as the log grows.
 */
export const getEventsForMedia = defineQuery<{ userId: UserId; mediaId: string }, UserMediaEvent>(
    'getEventsForMedia',
    (sql, { userId, mediaId }) => sql`
        SELECT *
        FROM user_media_events
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
          AND repudiated_at IS NULL
        ORDER BY occurred_at DESC, recorded_at DESC
    `,
);

/**
 * Compaction-aware variant of `getEventsForMedia`. Returns the most
 * recent live `'state_snapshot'` event (if any) plus every live event
 * with `recorded_at >= snapshot.recorded_at`. When no snapshot exists
 * the WHERE clause matches every live event via the
 * `'-infinity'::timestamptz` fallback, so the result is identical to
 * `getEventsForMedia` on un-compacted media.
 *
 * Boundary semantics: we filter on `recorded_at`, not `occurred_at`.
 * `occurred_at` is "when the event happened in the user's timeline"
 * and a Jellyfin sync can insert a back-dated event whose
 * `occurred_at` predates an already-written snapshot (the snapshot's
 * `occurred_at` is always NOW() at compaction time, while a sync
 * event's `occurred_at` reflects the historical play). Filtering on
 * `occurred_at` would silently drop those events from every future
 * rebuild and freeze state forever. `recorded_at` is "when Lumastra
 * saw the row" — anything written after the snapshot's `recorded_at`
 * is new knowledge that the rebuilder must arbitrate, regardless of
 * the historical timestamp it carries.
 *
 * The rebuilder uses this as its primary input — the snapshot acts as
 * the base case for `computeStateFromEvents` so we don't have to
 * arbitrate over the entire history every tick. Arbitration inside
 * `computeStateFromEvents` still uses `occurred_at` for ordering
 * (so a back-dated sync event correctly slots before newer events),
 * but the event must reach the compute function first — that's what
 * the `recorded_at` boundary guarantees.
 *
 * Ordering matches `getEventsForMedia` (occurred_at DESC, recorded_at
 * DESC) so the snapshot — if present — is at the END of the result
 * (oldest occurred_at among the kept rows) rather than at the start.
 */
export const getEventsSinceLastSnapshot = defineQuery<
    { userId: UserId; mediaId: string },
    UserMediaEvent
>(
    'getEventsSinceLastSnapshot',
    (sql, { userId, mediaId }) => sql`
        SELECT *
        FROM user_media_events
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
          AND repudiated_at IS NULL
          AND recorded_at >= COALESCE(
              (
                  SELECT MAX(recorded_at)
                  FROM user_media_events
                  WHERE user_id = ${userId}
                    AND media_id = ${mediaId}
                    AND event_type = 'state_snapshot'
                    AND repudiated_at IS NULL
              ),
              '-infinity'::timestamptz
          )
        ORDER BY occurred_at DESC, recorded_at DESC
    `,
);

/**
 * Batch variant of `getEventsSinceLastSnapshot` for a whole user (H18). Returns
 * the live events for every listed media, each newer than THAT media's own most
 * recent live snapshot — identical per-media boundary and ordering to the
 * single-media query, just in ONE round-trip instead of one per media. Rows come
 * back ordered by media_id so the caller can slice consecutive runs per media.
 */
export async function getEventsSinceLastSnapshotForUser(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
): Promise<UserMediaEvent[]> {
    if (mediaIds.length === 0) return [];
    return sql<UserMediaEvent[]>`
        WITH snap AS (
            SELECT media_id, MAX(recorded_at) AS snap_at
            FROM user_media_events
            WHERE user_id = ${userId}
              AND event_type = 'state_snapshot'
              AND repudiated_at IS NULL
              AND media_id = ANY(${mediaIds}::uuid[])
            GROUP BY media_id
        )
        SELECT e.*
        FROM user_media_events e
        LEFT JOIN snap ON snap.media_id = e.media_id
        WHERE e.user_id = ${userId}
          AND e.media_id = ANY(${mediaIds}::uuid[])
          AND e.repudiated_at IS NULL
          AND e.recorded_at >= COALESCE(snap.snap_at, '-infinity'::timestamptz)
        ORDER BY e.media_id, e.occurred_at DESC, e.recorded_at DESC
    `;
}

/**
 * Count of live, non-snapshot events newer than the most recent live
 * snapshot for (user, media). Used by `appendEventAndRebuild` after a
 * successful rebuild to decide whether to write a fresh snapshot.
 *
 * Boundary uses `recorded_at` (matching `getEventsSinceLastSnapshot`)
 * rather than `occurred_at` so back-dated sync events written after
 * the snapshot still count toward the compaction threshold.
 *
 * `'-infinity'::timestamptz` fallback: when no snapshot exists, every
 * non-snapshot live event qualifies. This matches the boot case where
 * the log has grown organically without ever being compacted.
 */
export const countEventsSinceLastSnapshot = defineQuery<
    { userId: UserId; mediaId: string },
    { count: number }
>(
    'countEventsSinceLastSnapshot',
    (sql, { userId, mediaId }) => sql`
        SELECT COUNT(*)::int AS count
        FROM user_media_events
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
          AND repudiated_at IS NULL
          AND event_type <> 'state_snapshot'
          AND recorded_at > COALESCE(
              (
                  SELECT MAX(recorded_at)
                  FROM user_media_events
                  WHERE user_id = ${userId}
                    AND media_id = ${mediaId}
                    AND event_type = 'state_snapshot'
                    AND repudiated_at IS NULL
              ),
              '-infinity'::timestamptz
          )
    `,
);

/**
 * Batched variant of `getEventsForMedia`. Returns events across the
 * whole `mediaIds` set; callers group by `media_id` locally.
 *
 * Ordering is stable (media_id, occurred_at DESC) so callers can lean
 * on the order without extra sorts.
 */
export const getEventsForMediaBatch = defineQuery<
    { userId: UserId; mediaIds: string[] },
    UserMediaEvent
>(
    'getEventsForMediaBatch',
    (sql, { userId, mediaIds }) => sql`
        SELECT *
        FROM user_media_events
        WHERE user_id = ${userId}
          AND media_id = ANY(${mediaIds}::uuid[])
          AND repudiated_at IS NULL
        ORDER BY media_id, occurred_at DESC, recorded_at DESC
    `,
);

/**
 * Minimal session fingerprint returned by `getLatestLumastraSessionInfo`.
 * The three fields together are sufficient to decide whether an
 * incoming 'lumastra-player' progress event is from a newer, same, or
 * stale session (see `shouldAcceptLumastraProgressEvent`).
 */
export interface LumastraSessionInfo {
    session_id: string | null;
    event_seq: number | null;
    session_started_at: string | Date | null;
}

/**
 * Look up the session fingerprint of the most recent non-repudiated
 * 'lumastra-player' 'progress' event for a (user, media). Used for
 * stale-tab rejection before inserting new progress ticks — without
 * this check a background tab could silently overwrite the real
 * active session's position.
 *
 * `session_started_at` is materialized from the earliest event in the
 * session so the caller doesn't need a side table just for session
 * start times. It's cheap because sessions are short-lived.
 */
// =============================================================================
// Admin / diagnostic queries
// =============================================================================

/**
 * A "bulk-mark window" is a cluster of mark_watched/completed events from
 * the same source that arrived within a short time window. The canonical
 * trigger is Jellyfin's "Mark series as played" cascade, which can write
 * thousands of events in a single millisecond burst.
 *
 * `window_start` / `window_end` are ISO timestamps of the earliest and
 * latest event in the bucket so callers can feed them directly into
 * `repudiateEvents`.
 *
 * `span_ms` is `window_end - window_start` in milliseconds — the
 * fingerprint that distinguishes a true cascade (single batch insert,
 * span ≈ 0) from a fast binge (events spaced over seconds). The audit
 * page surfaces this so operators can spot the obvious cascades first.
 *
 * `confidence_tier` collapses span + count into a tri-state label so the
 * UI can render visual severity without re-deriving:
 *   - 'high':   span <= 100 ms — almost certainly a single batch insert
 *               (Jellyfin cascade button, library import script).
 *   - 'medium': span <= 5 s   — bulk action (slower API loop, queued
 *               batch) but still likely automated.
 *   - 'low':    span > 5 s    — could be a fast bingewatcher; still
 *               worth surfacing because event_count is above threshold.
 */
export interface BulkMarkWindow {
    user_id: string;
    source: string;
    window_start: string;
    window_end: string;
    event_count: number;
    distinct_media_count: number;
    span_ms: number;
    confidence_tier: 'high' | 'medium' | 'low';
}

/**
 * Detect suspicious bulk-mark windows for a single user.
 *
 * Events are bucketed by source + the integer quotient
 * `floor(epoch_ms / windowMs)`. Any bucket that meets or exceeds
 * `minEventCount` is returned as a suspicious window.
 */
export const detectBulkMarkWindows = defineQuery<
    { userId: UserId; windowMs: number; minEventCount: number },
    BulkMarkWindow
>(
    'detectBulkMarkWindows',
    (sql, { userId, windowMs, minEventCount }) => sql`
        SELECT
            user_id,
            source,
            -- ISO 8601 in UTC with full microseconds: the repudiate endpoint
            -- validates these bounds as ISO datetimes and matches them with
            -- <=, so the Postgres ::text form (space, '+00') was rejected and
            -- a millisecond round-trip would drop the window's last events.
            to_char(MIN(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
            to_char(MAX(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
            COUNT(*)::int            AS event_count,
            COUNT(DISTINCT media_id)::int AS distinct_media_count,
            (EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000)::int AS span_ms,
            CASE
                WHEN EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000 <= 100  THEN 'high'
                WHEN EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000 <= 5000 THEN 'medium'
                ELSE 'low'
            END AS confidence_tier
        FROM user_media_events
        WHERE user_id = ${userId}
          AND event_type IN ('mark_watched', 'completed')
          -- Exclude sources that are bulk by design and known-legitimate:
          -- - 'lumastra-user-mark': operator/user clicked "mark all watched"
          -- - 'lumastra-offline': a reconnect flush of a week of playback
          --   uploads all at once, by construction
          -- - 'migration': one-shot M0 backfill from legacy user_watch_state
          --   wrote every pre-existing watched flag with occurred_at = NOW()
          --   at migration time, producing a 178k-event "cascade" that is
          --   not a contamination signal. Without this filter, 42 of the
          --   49 surfaced windows on the audit page are migration noise
          --   and the 7 real Jellyfin bulk-mark events get buried.
          AND source <> ALL(${sql.array(BULK_BY_DESIGN_SOURCES as string[])})
          AND repudiated_at IS NULL
        GROUP BY
            user_id,
            source,
            (extract(epoch from occurred_at) * 1000)::bigint / ${windowMs}
        HAVING COUNT(*) >= ${minEventCount}
        ORDER BY window_start DESC
    `,
);

/**
 * Same detection logic as `detectBulkMarkWindows` but across all users.
 * Used by the audit page to surface cluster-wide suspicious activity.
 * Results are ordered by event_count DESC so the worst offenders appear
 * first.
 */
export const detectBulkMarkWindowsAllUsers = defineQuery<
    { windowMs: number; minEventCount: number },
    BulkMarkWindow
>(
    'detectBulkMarkWindowsAllUsers',
    (sql, { windowMs, minEventCount }) => sql`
        SELECT
            user_id,
            source,
            -- ISO 8601 in UTC with full microseconds: the repudiate endpoint
            -- validates these bounds as ISO datetimes and matches them with
            -- <=, so the Postgres ::text form (space, '+00') was rejected and
            -- a millisecond round-trip would drop the window's last events.
            to_char(MIN(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_start,
            to_char(MAX(occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS window_end,
            COUNT(*)::int            AS event_count,
            COUNT(DISTINCT media_id)::int AS distinct_media_count,
            (EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000)::int AS span_ms,
            CASE
                WHEN EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000 <= 100  THEN 'high'
                WHEN EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000 <= 5000 THEN 'medium'
                ELSE 'low'
            END AS confidence_tier
        FROM user_media_events
        WHERE event_type IN ('mark_watched', 'completed')
          -- Exclude sources that are bulk by design and known-legitimate:
          -- - 'lumastra-user-mark': operator/user clicked "mark all watched"
          -- - 'lumastra-offline': a reconnect flush of a week of playback
          --   uploads all at once, by construction
          -- - 'migration': one-shot M0 backfill from legacy user_watch_state
          --   wrote every pre-existing watched flag with occurred_at = NOW()
          --   at migration time, producing a 178k-event "cascade" that is
          --   not a contamination signal. Without this filter, 42 of the
          --   49 surfaced windows on the audit page are migration noise
          --   and the 7 real Jellyfin bulk-mark events get buried.
          AND source <> ALL(${sql.array(BULK_BY_DESIGN_SOURCES as string[])})
          AND repudiated_at IS NULL
        GROUP BY
            user_id,
            source,
            (extract(epoch from occurred_at) * 1000)::bigint / ${windowMs}
        HAVING COUNT(*) >= ${minEventCount}
        -- Sort high-confidence cascades to the top so operators see the
        -- obvious cleanup candidates first; within tier, larger event
        -- counts (more impactful) come before smaller ones. The CASE
        -- expression is repeated rather than referencing the
        -- confidence_tier alias because Postgres does not resolve
        -- SELECT-list aliases inside expressions in ORDER BY.
        ORDER BY
            CASE
                WHEN EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000 <= 100  THEN 0
                WHEN EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at))) * 1000 <= 5000 THEN 1
                ELSE 2
            END,
            COUNT(*) DESC
    `,
);

/**
 * Provenance group: events for a user bucketed by source + time window
 * of `bucketMinutes` minutes. The outer aggregation collapses the window
 * function so each (source, bucket) pair returns one row.
 *
 * `type_counts` is a JSONB object whose keys are event_type strings and
 * whose values are per-(source, bucket, event_type) counts. The driver
 * returns it as a plain JS object; callers can treat it as
 * `Record<string, number>`.
 */
export interface ProvenanceGroup {
    source: string;
    bucket_start: string;
    event_count: number;
    distinct_media_count: number;
    type_counts: Record<string, number>;
}

/**
 * Returns events grouped by source + hour bucket for a single user.
 * Used by the admin provenance explorer to spot anomalous ingestion
 * patterns (e.g. "8 188 events in a 4-second window").
 */
export const getProvenanceGroups = defineQuery<
    { userId: UserId; bucketMinutes: number; limit: number },
    ProvenanceGroup
>(
    'getProvenanceGroups',
    (sql, { userId, bucketMinutes, limit }) => sql`
        SELECT
            source,
            to_timestamp(
                floor(extract(epoch from occurred_at) / (${bucketMinutes} * 60))
                * (${bucketMinutes} * 60)
            )::text AS bucket_start,
            COUNT(*)::int                      AS event_count,
            COUNT(DISTINCT media_id)::int       AS distinct_media_count,
            jsonb_object_agg(event_type, type_count) AS type_counts
        FROM (
            SELECT
                source,
                occurred_at,
                media_id,
                event_type,
                COUNT(*) OVER (
                    PARTITION BY source, event_type,
                        floor(extract(epoch from occurred_at) / (${bucketMinutes} * 60))
                ) AS type_count
            FROM user_media_events
            WHERE user_id = ${userId}
              AND repudiated_at IS NULL
        ) windowed
        GROUP BY source, bucket_start
        ORDER BY bucket_start DESC
        LIMIT ${limit}
    `,
);

// =============================================================================
// Push-cycle queries
// =============================================================================

/**
 * One (user, media) pair that has lumastra-* events not yet pushed to the
 * given provider. `event_ids` is the set of lumastra-* event IDs that the
 * push cycle marks as pushed once `pushWatchState` reports success for
 * the pair.
 *
 * `latest_decisive_event_type` is the most recent un-pushed lumastra
 * event_type that asserts a definite watched/unwatched intent — i.e.
 * `mark_watched`, `completed`, or `mark_unwatched`. `null` means the
 * queue contains only `progress` heartbeats; the engine sends those through
 * the position-only API so they cannot clobber a Jellyfin-side watched flag.
 *
 * Grouping by (user_id, media_id) collapses many tail events (e.g. a
 * session's progress ticks) into a single push call — Jellyfin only has
 * an "is_watched / resume" setter per item, so we push current state
 * once and acknowledge every backing event.
 */
export interface UnpushedItem {
    user_id: UserId;
    media_id: string;
    event_ids: string[];
    latest_decisive_event_at?: string | Date | null;
    latest_decisive_event_type: 'mark_watched' | 'completed' | 'mark_unwatched' | null;
}

/**
 * Find (user, media) pairs with un-pushed lumastra-* events for the given
 * provider, oldest pending first so a stale backlog item never starves
 * behind newer ones.
 *
 * `provider` must be a lowercase provider name (e.g. 'jellyfin'). The
 * push engine normalises it from `manifest.watchSyncConfig.providerName`
 * before calling.
 *
 * Bounded by `limit` so a huge backlog doesn't load megabytes of UUIDs
 * into a single page; the engine pages through repeatedly until empty.
 *
 * `latest_decisive_event_type` is computed via a correlated subquery so
 * the engine can split position-only queues from decisive watched-state queues.
 * The subquery picks the most recent un-pushed lumastra mark_watched/completed/mark_unwatched event
 * for the same (user, media); when no such event exists the column is
 * NULL and the engine calls only pushResumePosition, retaining unacknowledged events.
 */
/**
 * Per-user scoping for {@link getUnpushedLumastraItems}. When supplied, only
 * events belonging to a listed `userId` are considered, and each user's
 * events are additionally floored at their own `since` watermark
 * (`occurred_at >= since`; `since = null` means "no lower bound for this
 * user"). This is how the push engine excludes users who have never linked
 * the provider (simply omitted from the list) and skips pre-link history
 * (via each user's own watermark) without a second round-trip or an N-query
 * fan-out — the whole scope travels in as two parallel arrays and is
 * `unnest()`-ed into a join, the same idiom `markEventsPushedBatch` uses
 * below for its (event_id, user_id) pairs.
 */
export const getUnpushedLumastraItems = defineQuery<
    {
        provider: string;
        limit: number;
        /** playbackOnly scopes admit playback progress while watch-state export is disabled. */
        userScopes?: Array<{ userId: string; since: Date | null; playbackOnly?: boolean }>;
        /** Already examined user:media pairs in this run; never persisted. */
        excludeKeys?: string[];
        respectBackoff?: boolean;
    },
    UnpushedItem
>(
    'getUnpushedLumastraItems',
    (sql, { provider, limit, userScopes, excludeKeys, respectBackoff }) => {
        // `undefined` (param omitted entirely) is the back-compat contract:
        // preserve the scheduled push audience, with no scope join at all. An explicit
        // empty array is a real caller choice ("no users in scope") and is
        // handled correctly by the join itself — unnest() of two empty
        // arrays yields zero rows, so nothing matches.
        if (userScopes === undefined) {
            return sql`
                SELECT
                    outer_e.user_id,
                    outer_e.media_id,
                    array_agg(outer_e.id::text) AS event_ids,
                    MAX(outer_e.occurred_at) FILTER (WHERE outer_e.event_type IN ('mark_watched', 'completed', 'mark_unwatched')) AS latest_decisive_event_at,
                    (
                        SELECT inner_e.event_type
                        FROM user_media_events inner_e
                        WHERE inner_e.user_id = outer_e.user_id
                          AND inner_e.media_id = outer_e.media_id
                          AND inner_e.source = ANY(${sql.array(PUSHABLE_SOURCES as string[])})
                          AND inner_e.event_type IN ('mark_watched', 'completed', 'mark_unwatched')
                          AND inner_e.repudiated_at IS NULL
                          AND NOT (${provider} = ANY(inner_e.pushed_to_providers))
                        ORDER BY inner_e.occurred_at DESC, inner_e.recorded_at DESC
                        LIMIT 1
                    ) AS latest_decisive_event_type
                FROM user_media_events outer_e
                WHERE outer_e.source = ANY(${sql.array(PUSHABLE_SOURCES as string[])})
                  AND outer_e.repudiated_at IS NULL
                  AND NOT (${provider} = ANY(outer_e.pushed_to_providers))
                  AND NOT ((outer_e.user_id::text || ':' || outer_e.media_id::text) = ANY(${sql.array(excludeKeys ?? [])}::text[]))
                GROUP BY outer_e.user_id, outer_e.media_id
                HAVING NOT ${respectBackoff ?? false} OR bool_or(
                    COALESCE((outer_e.sync_delivery -> ${provider} ->> 'next_attempt_at')::timestamptz, '-infinity') <= now()
                )
                ORDER BY MAX(outer_e.occurred_at) ASC
                LIMIT ${limit}
            `;
        }

        const scopeUserIds = userScopes.map((s) => s.userId);
        const scopeSinces = userScopes.map((s) => s.since);
        const scopePlaybackOnly = userScopes.map((s) => s.playbackOnly ?? false);

        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- outbound sync of each user's own recorded events; no listing for a viewer
        return sql`
            SELECT
                outer_e.user_id,
                outer_e.media_id,
                array_agg(outer_e.id::text) AS event_ids,
                MAX(outer_e.occurred_at) FILTER (WHERE outer_e.event_type IN ('mark_watched', 'completed', 'mark_unwatched')) AS latest_decisive_event_at,
                (
                    SELECT inner_e.event_type
                    FROM user_media_events inner_e
                    JOIN unnest(
                        ${sql.array(scopeUserIds)}::uuid[],
                        ${sql.array(scopeSinces)}::timestamptz[],
                        ${sql.array(scopePlaybackOnly)}::boolean[]
                    ) AS scope(user_id, since, playback_only)
                      ON scope.user_id = inner_e.user_id
                     AND (scope.since IS NULL OR inner_e.occurred_at >= scope.since)
                     AND (NOT scope.playback_only OR (
                         (
                             (inner_e.source IN ('lumastra-player', 'lumastra-offline') AND inner_e.event_type = 'progress')
                             OR (inner_e.source = 'lumastra-user-mark' AND inner_e.event_type = 'mark_unwatched' AND inner_e.session_id IS NOT NULL)
                         )
                         AND EXISTS (SELECT 1 FROM media_items mi WHERE mi.id = inner_e.media_id AND mi.media_type = 'audiobook')
                     ))
                    WHERE inner_e.user_id = outer_e.user_id
                      AND inner_e.media_id = outer_e.media_id
                      AND inner_e.source = ANY(${sql.array(PUSHABLE_SOURCES as string[])})
                      AND inner_e.event_type IN ('mark_watched', 'completed', 'mark_unwatched')
                      AND inner_e.repudiated_at IS NULL
                      AND NOT (${provider} = ANY(inner_e.pushed_to_providers))
                    ORDER BY inner_e.occurred_at DESC, inner_e.recorded_at DESC
                    LIMIT 1
                ) AS latest_decisive_event_type
            FROM user_media_events outer_e
            JOIN unnest(
                ${sql.array(scopeUserIds)}::uuid[],
                ${sql.array(scopeSinces)}::timestamptz[],
                ${sql.array(scopePlaybackOnly)}::boolean[]
            ) AS scope(user_id, since, playback_only)
              ON scope.user_id = outer_e.user_id
             AND (scope.since IS NULL OR outer_e.occurred_at >= scope.since)
             AND (NOT scope.playback_only OR (
                         (
                             (outer_e.source IN ('lumastra-player', 'lumastra-offline') AND outer_e.event_type = 'progress')
                             OR (outer_e.source = 'lumastra-user-mark' AND outer_e.event_type = 'mark_unwatched' AND outer_e.session_id IS NOT NULL)
                         )
                         AND EXISTS (SELECT 1 FROM media_items mi WHERE mi.id = outer_e.media_id AND mi.media_type = 'audiobook')
                     ))
            WHERE outer_e.source = ANY(${sql.array(PUSHABLE_SOURCES as string[])})
              AND outer_e.repudiated_at IS NULL
              AND NOT (${provider} = ANY(outer_e.pushed_to_providers))
              AND NOT ((outer_e.user_id::text || ':' || outer_e.media_id::text) = ANY(${sql.array(excludeKeys ?? [])}::text[]))
            GROUP BY outer_e.user_id, outer_e.media_id
                HAVING NOT ${respectBackoff ?? false} OR bool_or(
                    COALESCE((outer_e.sync_delivery -> ${provider} ->> 'next_attempt_at')::timestamptz, '-infinity') <= now()
                )
            ORDER BY MAX(outer_e.occurred_at) ASC
            LIMIT ${limit}
        `;
    },
);

/**
 * Mark a set of lumastra-* events as pushed to the given provider.
 *
 * The `NOT (... = ANY(...))` guard handles the rare case where two
 * concurrent push cycles race on the same event — without it the second
 * UPDATE would append a duplicate provider entry into the array.
 *
 * `userId` scopes the UPDATE as defense-in-depth: if a caller ever
 * supplies an event ID belonging to a different user (programming bug
 * upstream — the engine groups by user before paginating), the row
 * stays untouched instead of getting silently flipped to "pushed."
 *
 * No-ops on an empty `eventIds` to save a round-trip.
 */
export async function markEventsPushed(
    sql: postgres.Sql,
    params: { userId: UserId; provider: string; eventIds: string[]; acknowledged?: boolean },
): Promise<void> {
    if (params.eventIds.length === 0) return;
    await sql`
        WITH acknowledged AS (
            UPDATE user_media_events
            SET pushed_to_providers = array_append(pushed_to_providers, ${params.provider}),
                sync_delivery = CASE WHEN ${params.acknowledged ?? false} THEN jsonb_set(sync_delivery, ARRAY[${params.provider}], jsonb_build_object('acknowledged_at', now())) ELSE sync_delivery END
            WHERE id = ANY(${params.eventIds}::uuid[])
              AND user_id = ${params.userId}
              AND NOT (${params.provider} = ANY(pushed_to_providers))
            RETURNING id, user_id, media_id, event_type, occurred_at
        )
        -- A reset may have been compacted while the HTTP write was in flight.
        -- Update its snapshot watermark atomically with the acknowledgement.
        -- A newer local act outside this batch must remain unacknowledged.
        UPDATE user_media_events snapshot SET snapshot_state = jsonb_set(
            snapshot.snapshot_state, '{jellyfin_unwatch_acknowledged_at}', to_jsonb(now()))
        WHERE ${params.acknowledged ?? false} AND ${params.provider} = 'jellyfin'
          AND snapshot.user_id = ${params.userId} AND snapshot.event_type = 'state_snapshot'
          AND snapshot.repudiated_at IS NULL
          AND snapshot.snapshot_state ->> 'is_watched_source' = 'lumastra-user-mark'
          AND (snapshot.snapshot_state ->> 'is_watched')::boolean = false
          AND EXISTS (
              SELECT 1 FROM acknowledged a WHERE a.media_id = snapshot.media_id AND a.event_type = 'mark_unwatched'
                AND a.occurred_at <= snapshot.occurred_at
                AND a.id = (
                    SELECT latest.id FROM user_media_events latest
                    WHERE latest.user_id = a.user_id AND latest.media_id = a.media_id
                      AND latest.source = 'lumastra-user-mark' AND latest.event_type IN ('mark_watched', 'mark_unwatched')
                      AND latest.repudiated_at IS NULL
                    ORDER BY latest.occurred_at DESC, latest.recorded_at DESC LIMIT 1
                )
          )
    `;
}

/**
 * Re-queues a user's decisive watch-state events for the given provider by
 * clearing their `pushed_to_providers` membership — so the next push cycle
 * treats them as un-pushed again and re-sends them.
 *
 * Used by the `watch-sync-manual` task (Task 7) ahead of a user-triggered
 * "Export" — a manual export intentionally re-syncs the user's entire
 * current state to that provider regardless of what a scheduled push cycle
 * already sent.
 *
 * Scoped to "decisive" event types (`mark_watched`/`completed`/
 * `mark_unwatched`) — `progress` ticks are drained separately by the push
 * loop (see {@link markEventsPushedBatch}'s progress-only path) and
 * re-queuing them here would resurrect stale resume-position pushes.
 */
export async function requeueUserEventsForProvider(
    sql: postgres.Sql,
    userId: UserId,
    provider: string,
): Promise<void> {
    await sql`
        UPDATE user_media_events
        SET pushed_to_providers = array_remove(pushed_to_providers, ${provider}),
            sync_delivery = sync_delivery - ${provider}
        WHERE user_id = ${userId}
          AND event_type IN ('mark_watched', 'completed', 'mark_unwatched')
    `;
}

/**
 * Batched variant of {@link markEventsPushed}. Marks events pushed for many
 * (user, eventIds) groups in a single UPDATE instead of one round-trip per
 * group — used by the watch-sync push path when draining a page of
 * progress-only items.
 *
 * Each event is matched against its OWN user_id (flattened into the join
 * relation), preserving the same per-user defense-in-depth scoping as the
 * single-group function: an event ID supplied under the wrong user is left
 * untouched rather than silently flipped to "pushed."
 *
 * No-ops when there are no events to mark.
 */
export async function markEventsPushedBatch(
    sql: postgres.Sql,
    params: {
        provider: string;
        groups: Array<{ userId: UserId; eventIds: string[] }>;
    },
): Promise<void> {
    const userIds: string[] = [];
    const eventIds: string[] = [];
    for (const group of params.groups) {
        for (const eventId of group.eventIds) {
            userIds.push(group.userId);
            eventIds.push(eventId);
        }
    }
    if (eventIds.length === 0) return;
    await sql`
        UPDATE user_media_events e
        SET pushed_to_providers = array_append(pushed_to_providers, ${params.provider})
        FROM unnest(
            ${sql.array(eventIds)}::uuid[],
            ${sql.array(userIds)}::uuid[]
        ) AS t(event_id, user_id)
        WHERE e.id = t.event_id
          AND e.user_id = t.user_id
          AND NOT (${params.provider} = ANY(e.pushed_to_providers))
    `;
}

/**
 * Per-media "own-source" snapshot used by the watch-sync pull loop's
 * change-detection (see `watch-sync-source-gate.ts`). Comparing a sync
 * source's freshly-reported value against what THAT SAME SOURCE last
 * reported — instead of against Lumastra's derived `user_media_state`,
 * which is arbitrated across every source and can permanently diverge
 * from any one of them — is what makes the comparison converge instead
 * of re-firing every pull cycle forever.
 *
 * `last_progress_position_ms` is the `position_ms` of the most recent
 * live `'progress'` event from `source` for that media (NULL when the
 * source has never reported a position — callers default to 0).
 *
 * `last_decisive_event_type` is the most recent live
 * `mark_watched` / `completed` / `mark_unwatched` event type from
 * `source` for that media (NULL when the source has never reported a
 * definite watched/unwatched intent).
 */
export interface SourceSnapshot {
    media_id: string;
    last_progress_position_ms: number | null;
    last_decisive_event_type: DecisiveEventType | null;
}

/** Mirrors `UnpushedItem.latest_decisive_event_type`'s value set. */
export type DecisiveEventType = 'mark_watched' | 'completed' | 'mark_unwatched';

/**
 * Batch variant: one row per requested `mediaId`, via a correlated
 * subquery per column (same idiom as `getUnpushedLumastraItems`) so the
 * whole chunk resolves in a single round-trip instead of one query per
 * media item. `unnest()` over an empty array yields zero rows, so an
 * empty `mediaIds` is handled correctly without a special case — but we
 * still short-circuit to avoid the round-trip entirely.
 *
 * Ordering is by `recorded_at DESC` (APPEND order), NOT `occurred_at`. This
 * is the "what did this source last report to us" snapshot, and external
 * sources stamp `occurred_at` with the provider's own play DATE (e.g.
 * Jellyfin `LastPlayedDate`), which can be older than a *later* re-appended
 * event and can differ across mark_watched/mark_unwatched for the same item.
 * Ordering by `occurred_at` here let a stale mark_watched (newer play-date)
 * outrank the most-recently-appended mark_unwatched → `shouldEmitSourceUnwatch`
 * kept firing every pull cycle (the resync loop). `recorded_at` reflects the
 * actual append order and converges.
 */
export async function getSourceSnapshotsForMedia(
    sql: postgres.Sql,
    params: { userId: UserId; mediaIds: string[]; source: EventSource },
): Promise<SourceSnapshot[]> {
    if (params.mediaIds.length === 0) return [];
    return sql<SourceSnapshot[]>`
        SELECT
            m.media_id,
            (
                SELECT e.position_ms
                FROM user_media_events e
                WHERE e.user_id = ${params.userId}
                  AND e.media_id = m.media_id
                  AND e.source = ${params.source}
                  AND e.event_type = 'progress'
                  AND e.repudiated_at IS NULL
                ORDER BY e.recorded_at DESC, e.occurred_at DESC
                LIMIT 1
            ) AS last_progress_position_ms,
            (
                SELECT e.event_type
                FROM user_media_events e
                WHERE e.user_id = ${params.userId}
                  AND e.media_id = m.media_id
                  AND e.source = ${params.source}
                  AND e.event_type IN ('mark_watched', 'completed', 'mark_unwatched')
                  AND e.repudiated_at IS NULL
                ORDER BY e.recorded_at DESC, e.occurred_at DESC
                LIMIT 1
            ) AS last_decisive_event_type
        FROM unnest(${sql.array(params.mediaIds)}::uuid[]) AS m(media_id)
    `;
}

export const getLatestLumastraSessionInfo = defineQuery<
    { userId: UserId; mediaId: string },
    LumastraSessionInfo
>(
    'getLatestLumastraSessionInfo',
    (sql, { userId, mediaId }) => sql`
        WITH latest AS (
            SELECT session_id, event_seq, occurred_at
            FROM user_media_events
            WHERE user_id = ${userId}
              AND media_id = ${mediaId}
              AND source = 'lumastra-player'
              AND event_type = 'progress'
              AND repudiated_at IS NULL
              -- A row without a session_id cannot describe a live session, and
              -- letting one win this ORDER BY disables the guard entirely: the
              -- caller returns "accept" as soon as the tracked session_id is
              -- null, so a single session-less row masquerading as the current
              -- session makes every subsequent heartbeat accepted, including a
              -- stale tab's. Every live writer sets session_id (watch-manager
              -- reportProgress, the only lumastra-player writer, requires it),
              -- so this excludes nothing that exists today — it stops a future
              -- back-dated/batch ingestion path from silently switching the
              -- stale-tab protection off.
              AND session_id IS NOT NULL
            ORDER BY occurred_at DESC, recorded_at DESC
            LIMIT 1
        )
        SELECT
            latest.session_id,
            latest.event_seq,
            (
                SELECT MIN(occurred_at)
                FROM user_media_events e
                WHERE e.user_id = ${userId}
                  AND e.media_id = ${mediaId}
                  AND e.source = 'lumastra-player'
                  AND e.event_type = 'progress'
                  AND e.session_id = latest.session_id
                  AND e.repudiated_at IS NULL
            ) AS session_started_at
        FROM latest
    `,
);

/**
 * Whether this playback session has already recorded a live `completed` for
 * this media. The player keeps sending heartbeats past the completion
 * threshold (credits, a paused end screen, a tab left open), and each one used
 * to append another `completed` — every one a +1 on `watch_count`. On prod
 * 2026-09-30, 17,683 of 19,126 player completions were such repeats; one
 * session wrote 1,657.
 */
export async function hasSessionCompletion(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string; sessionId: string },
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM user_media_events
        WHERE user_id = ${params.userId}
          AND media_id = ${params.mediaId}
          AND session_id = ${params.sessionId}
          AND event_type = 'completed'
          AND repudiated_at IS NULL
        LIMIT 1
    `;
    return rows.length > 0;
}
