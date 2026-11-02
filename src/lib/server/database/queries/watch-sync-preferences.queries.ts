// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * watch_sync_preferences — per-user, per-provider watch-sync direction
 * preference ('both'|'pull'|'push') plus a push watermark (the point after
 * which push-direction events become eligible to push to the provider).
 * Pure SQL; `sql` is always the first parameter. One row per (user_id,
 * provider); absence means the default ('both', no watermark).
 */
import type postgres from 'postgres';

export type SyncDirection = 'both' | 'pull' | 'push';

export interface WatchSyncPreference {
    direction: SyncDirection;
    pushWatermark: Date | null;
}

const DEFAULT_PREFERENCE: WatchSyncPreference = { direction: 'both', pushWatermark: null };

/** The direction + push-watermark preference for one (user, provider) pair.
 *  Defaults to `{direction:'both', pushWatermark:null}` when no row exists. */
export async function getPreference(
    sql: postgres.Sql,
    userId: string,
    provider: string,
): Promise<WatchSyncPreference> {
    const rows = await sql<{ direction: SyncDirection; push_watermark: Date | null }[]>`
        SELECT direction, push_watermark
        FROM watch_sync_preferences
        WHERE user_id = ${userId}::uuid AND provider = ${provider}
        LIMIT 1
    `;
    const row = rows[0];
    if (!row) return DEFAULT_PREFERENCE;
    return { direction: row.direction, pushWatermark: row.push_watermark };
}

/** Set the sync direction for (user, provider). UPSERT — preserves any
 *  existing push_watermark (only `direction` + `updated_at` change). */
export async function setDirection(
    sql: postgres.Sql,
    userId: string,
    provider: string,
    direction: SyncDirection,
): Promise<void> {
    await sql`
        INSERT INTO watch_sync_preferences (user_id, provider, direction, updated_at)
        VALUES (${userId}::uuid, ${provider}, ${direction}, now())
        ON CONFLICT (user_id, provider)
        DO UPDATE SET direction = EXCLUDED.direction, updated_at = now()
    `;
}

/** Set the push watermark for (user, provider). UPSERT — a fresh row defaults
 *  to direction 'both' if none existed yet. */
export async function setWatermark(
    sql: postgres.Sql,
    userId: string,
    provider: string,
    at: Date,
): Promise<void> {
    await sql`
        INSERT INTO watch_sync_preferences (user_id, provider, push_watermark, updated_at)
        VALUES (${userId}::uuid, ${provider}, ${at}, now())
        ON CONFLICT (user_id, provider)
        DO UPDATE SET push_watermark = EXCLUDED.push_watermark, updated_at = now()
    `;
}

/** Batch-fetch preferences for a provider across multiple users. Users with
 *  no row are simply absent from the returned Map (callers apply the default). */
export async function listPreferences(
    sql: postgres.Sql,
    provider: string,
    userIds: string[],
): Promise<Map<string, WatchSyncPreference>> {
    const result = new Map<string, WatchSyncPreference>();
    if (userIds.length === 0) return result;

    const rows = await sql<
        { user_id: string; direction: SyncDirection; push_watermark: Date | null }[]
    >`
        SELECT user_id, direction, push_watermark
        FROM watch_sync_preferences
        WHERE provider = ${provider} AND user_id = ANY(${userIds}::uuid[])
    `;
    for (const row of rows) {
        result.set(row.user_id, { direction: row.direction, pushWatermark: row.push_watermark });
    }
    return result;
}
