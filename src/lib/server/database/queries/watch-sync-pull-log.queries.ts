// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * watch_state_pull_log — per-(user, provider) pull cursor bookkeeping.
 * Pure SQL; `sql` is always the first parameter. See
 * `WatchSyncEngine.logPullRun` (watch-sync-engine.service.ts) for the writer
 * side of this table — `provider` there is the lowercased
 * `WatchSyncDefinition.providerName` (e.g. 'trakt', 'mal'), which is the same
 * short provider name this module's callers pass in.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';

/**
 * Clears the persisted `last_played_cursor` for a (user, provider) pair so
 * the next pull treats the user as having no watermark — a full historical
 * re-import instead of an incremental one from the old cursor.
 *
 * Used by the `watch-sync-manual` task (Task 7) ahead of a user-triggered
 * "Import" — the caller decides WHEN to reset; this only performs the
 * write. No-ops (0 rows affected) when the pair has no log row yet, which
 * is equivalent to "already primed for a full pull" since an absent row
 * behaves the same as a NULL cursor on read (see
 * `WatchSyncEngine.pullForProvider`'s cursor load).
 */
export async function resetPullCursor(
    sql: postgres.Sql,
    userId: UserId,
    provider: string,
): Promise<void> {
    await sql`
        UPDATE watch_state_pull_log
        SET last_played_cursor = NULL
        WHERE user_id = ${userId} AND provider = ${provider}
    `;
}
