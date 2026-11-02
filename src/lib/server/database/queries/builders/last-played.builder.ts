// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * When the user last played an item, from their `user_media_state` row
 * (`alias`): the newer of the last completion and the last playback event,
 * and only when the row records a play at all (watched, a saved position or a
 * play count) — a row left by "mark unwatched" alone has no play date.
 * Jellyfin's `UserItemDataDto.LastPlayedDate`.
 */
export function lastPlayedAtExpression(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`lastPlayedAtExpression: invalid alias "${alias}"`);
    }
    const ws = sql(alias);
    return sql`(CASE
        WHEN ${ws}.is_watched OR ${ws}.resume_position_ms > 0 OR ${ws}.watch_count > 0
        THEN GREATEST(${ws}.last_watched_at, ${ws}.last_event_at)
    END)`;
}
