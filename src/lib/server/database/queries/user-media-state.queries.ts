// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Media State Query Module
 *
 * Materialized-state read model that replaces the mutable
 * `user_media_state` table. Rows here are derived from
 * `user_media_events` by the watch-state rebuilder; nothing else
 * should write to this table. Readers are unchanged in shape from
 * the old table so downstream code can be renamed mechanically.
 *
 * Columns
 *   - (user_id, media_id) is the PK
 *   - is_watched                 boolean derived state
 *   - resume_position_ms         0 when is_watched = true
 *   - runtime_ms                 last non-null runtime reported
 *   - watch_count                completions minus revocations, floor 0
 *   - first_watched_at           earliest completion ever
 *   - last_watched_at            most recent un-revoked completion
 *   - last_event_at              timestamp of most recent event
 *   - last_event_source          source of most recent event
 */

import type postgres from 'postgres';
import { defineQuery, defineWriteQuery } from '../typed-query.js';
import type { UserId } from '$lib/shared/user-id.js';

// =============================================================================
// Types
// =============================================================================

export interface UserMediaStateRow {
    user_id: string;
    media_id: string;
    is_watched: boolean;
    resume_position_ms: number;
    runtime_ms: number | null;
    watch_count: number;
    first_watched_at: string | null;
    last_watched_at: string | null;
    last_event_at: string | null;
    last_event_source: string | null;
    /**
     * max(session_elapsed_ms) across lumastra-player progress events that
     * arbitrate to this state. NULL when we have no engagement signal yet
     * (legacy data, or a media item only ever touched by jellyfin-sync /
     * mark events). The Continue Watching filter gates on this when
     * present and falls back to the position+percent heuristic when NULL,
     * so the migration to engagement-based gating is purely additive.
     */
    highest_session_elapsed_ms: number | null;
}

/**
 * Input shape for `upsertState`. Mirrors `UserMediaStateRow` exactly
 * because the rebuilder computes every column authoritatively — but the
 * write key `user_id` must be the branded `UserId` (FKs `users(id)` since
 * migration 16.46.0), so the caller can't hand us a username by mistake.
 */
export type UserMediaStateUpsert = Omit<UserMediaStateRow, 'user_id'> & { user_id: UserId };

// =============================================================================
// Read queries
// =============================================================================

/**
 * Single-row fetch. Returns null when the user has no events for the
 * media item (no derived state row has been materialized).
 */
export const getState = defineQuery<{ userId: UserId; mediaId: string }, UserMediaStateRow>(
    'getState',
    (sql, { userId, mediaId }) => sql`
        SELECT *
        FROM user_media_state
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
    `,
);

/**
 * Bulk fetch for a user-scoped set of media ids. Returns only rows
 * that exist; callers compare against the requested set themselves.
 */
export const batchGetStates = defineQuery<
    { userId: UserId; mediaIds: string[] },
    UserMediaStateRow
>(
    'batchGetStates',
    (sql, { userId, mediaIds }) => sql`
        SELECT *
        FROM user_media_state
        WHERE user_id = ${userId}
          AND media_id = ANY(${mediaIds}::uuid[])
    `,
);

/**
 * Rows that belong in a Continue Watching list: a non-zero resume
 * position and not explicitly watched. Ordered newest-first by event
 * timestamp so callers can take(limit) without an extra sort.
 */
export const getResumeStates = defineQuery<{ userId: UserId }, UserMediaStateRow>(
    'getResumeStates',
    (sql, { userId }) => sql`
        SELECT *
        FROM user_media_state
        WHERE user_id = ${userId}
          AND resume_position_ms > 0
          AND is_watched = false
        ORDER BY last_event_at DESC NULLS LAST
    `,
);

/**
 * Resume position for ONE (user, media) row, regardless of watched state.
 *
 * Deliberately not `getResumeStates`, which filters `is_watched = false` and so
 * cannot see the row an un-finish is about to act on — that row is watched by
 * definition. Used by `markUnwatched` to carry an audiobook's position onto the
 * `mark_unwatched` event so the rebuild preserves it.
 */
export const getResumePositionForMedia = defineQuery<
    { userId: UserId; mediaId: string },
    { resume_position_ms: number }
>(
    'getResumePositionForMedia',
    (sql, { userId, mediaId }) => sql`
        SELECT resume_position_ms
        FROM user_media_state
        WHERE user_id = ${userId}
          AND media_id = ${mediaId}
        LIMIT 1
    `,
);

// =============================================================================
// Write queries
// =============================================================================

/**
 * Full-row upsert. Only the rebuilder should call this — every column
 * value is the result of arbitration across the event log, so a
 * partial update would corrupt derived state.
 */
export const upsertState = defineWriteQuery<{ state: UserMediaStateUpsert }, UserMediaStateRow>(
    'upsertState',
    (sql, { state }) => sql`
        INSERT INTO user_media_state (
            user_id,
            media_id,
            is_watched,
            resume_position_ms,
            runtime_ms,
            watch_count,
            first_watched_at,
            last_watched_at,
            last_event_at,
            last_event_source,
            highest_session_elapsed_ms
        ) VALUES (
            ${state.user_id},
            ${state.media_id},
            ${state.is_watched},
            ${state.resume_position_ms},
            ${state.runtime_ms},
            ${state.watch_count},
            ${state.first_watched_at},
            ${state.last_watched_at},
            ${state.last_event_at},
            ${state.last_event_source},
            ${state.highest_session_elapsed_ms}
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            is_watched = EXCLUDED.is_watched,
            resume_position_ms = EXCLUDED.resume_position_ms,
            runtime_ms = EXCLUDED.runtime_ms,
            watch_count = EXCLUDED.watch_count,
            first_watched_at = EXCLUDED.first_watched_at,
            last_watched_at = EXCLUDED.last_watched_at,
            last_event_at = EXCLUDED.last_event_at,
            last_event_source = EXCLUDED.last_event_source,
            -- Ratchet up only. The rebuilder's compute is bounded to the
            -- post-snapshot event window; older engagement data lives only
            -- in this column. GREATEST + PG's NULL-ignoring semantics mean:
            --   both NULL  → stays NULL (no signal yet)
            --   one NULL   → the non-NULL wins
            --   both set   → max wins
            -- Phantom-shadow repudiation does not retroactively erase
            -- engagement: the signal is independent of whether the source
            -- events stayed live, which is what we want for CW filtering.
            highest_session_elapsed_ms = GREATEST(
                EXCLUDED.highest_session_elapsed_ms,
                user_media_state.highest_session_elapsed_ms
            )
        RETURNING *
    `,
);

/**
 * Delete the derived row. Called when every event for (user, media)
 * has been repudiated so no state remains to materialize.
 */
export async function deleteState(
    sql: postgres.Sql,
    params: { userId: UserId; mediaId: string },
): Promise<void> {
    await sql`
        DELETE FROM user_media_state
        WHERE user_id = ${params.userId}
          AND media_id = ${params.mediaId}
    `;
}
