// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** One row per Live TV feed (livetv_channels.id). */
export interface LiveTvChannelHealthRow {
    channel_id: string;
    consecutive_failures: number;
    last_reason: string | null;
    last_failure_at: Date | null;
    last_success_at: Date | null;
    updated_at: Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Event channel ids are text; only a UUID can be a feed row. */
export function isFeedUuid(value: string | null | undefined): value is string {
    return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * +1 consecutive failure for a feed. A feed that was deleted (no livetv_channels row)
 * is ignored instead of failing on the foreign key.
 */
export async function recordFailure(
    sql: postgres.Sql,
    channelId: string,
    reason: string,
    occurredAt: Date = new Date(),
): Promise<void> {
    if (!isFeedUuid(channelId)) return;
    await sql`
        INSERT INTO livetv_channel_health
            (channel_id, consecutive_failures, last_reason, last_failure_at, updated_at)
        SELECT lc.id, 1, ${reason}, ${occurredAt}, now()
        FROM livetv_channels lc WHERE lc.id = ${channelId}::uuid
        ON CONFLICT (channel_id) DO UPDATE SET
            consecutive_failures = livetv_channel_health.consecutive_failures + 1,
            last_reason = EXCLUDED.last_reason,
            last_failure_at = GREATEST(
                COALESCE(livetv_channel_health.last_failure_at, EXCLUDED.last_failure_at),
                EXCLUDED.last_failure_at),
            updated_at = now()
    `;
}

/** The feed played: the failure streak ends. */
export async function recordSuccess(sql: postgres.Sql, channelId: string): Promise<void> {
    if (!isFeedUuid(channelId)) return;
    await sql`
        INSERT INTO livetv_channel_health
            (channel_id, consecutive_failures, last_success_at, updated_at)
        SELECT lc.id, 0, now(), now()
        FROM livetv_channels lc WHERE lc.id = ${channelId}::uuid
        ON CONFLICT (channel_id) DO UPDATE SET
            consecutive_failures = 0,
            last_success_at = now(),
            updated_at = now()
    `;
}

/** Admin reset: back to "ok" without claiming a success. */
export async function reset(sql: postgres.Sql, channelId: string): Promise<boolean> {
    if (!isFeedUuid(channelId)) return false;
    const exists = await sql<
        Array<{ id: string }>
    >`SELECT id FROM livetv_channels WHERE id = ${channelId}::uuid`;
    if (exists.length === 0) return false;
    await sql`DELETE FROM livetv_channel_health WHERE channel_id = ${channelId}::uuid`;
    return true;
}

export async function listForChannels(
    sql: postgres.Sql,
    channelIds: string[],
): Promise<LiveTvChannelHealthRow[]> {
    const ids = channelIds.filter(isFeedUuid);
    if (ids.length === 0) return [];
    return sql<LiveTvChannelHealthRow[]>`
        SELECT channel_id, consecutive_failures, last_reason, last_failure_at, last_success_at, updated_at
        FROM livetv_channel_health
        WHERE channel_id = ANY(${ids}::uuid[])
    `;
}

/**
 * Every station (backup group id, else the feed id) whose usable feeds are all failing hard
 * enough to hide: consecutive_failures >= threshold and a failure within the window. A feed
 * without a health row is healthy, so one healthy feed keeps its station visible.
 *
 * Usable feeds are the members the lineup and getBackupGroupFeeds can actually play: in a
 * visible category (or none) and not absent from the last three imports. A hidden-from-lineup
 * feed still counts, since hiding the feeds the lineup does not show is what makes them
 * backups. A station without any usable feed is not reported.
 *
 * The candidate stations come from the health rows, so the cost follows the number of failing
 * feeds, not the size of the lineup.
 */
export async function listOfflineStationIds(
    sql: postgres.Sql,
    threshold: number,
    windowHours: number,
): Promise<string[]> {
    if (threshold <= 0) return [];
    const rows = await sql<Array<{ station_id: string }>>`
        WITH candidates AS (
            SELECT DISTINCT COALESCE(c.backup_group_id, c.id) AS station_id
            FROM livetv_channel_health h
            JOIN livetv_channels c ON c.id = h.channel_id
            WHERE h.consecutive_failures >= ${threshold}
              AND h.last_failure_at > now() - make_interval(hours => ${windowHours})
        )
        SELECT COALESCE(lc.backup_group_id, lc.id)::text AS station_id
        FROM livetv_channels lc
        LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
        LEFT JOIN livetv_channel_health h ON h.channel_id = lc.id
        WHERE COALESCE(lc.backup_group_id, lc.id) IN (SELECT station_id FROM candidates)
          AND (lc.category_id IS NULL OR lcat.is_visible = true)
          AND lc.consecutive_absences < 3
        GROUP BY COALESCE(lc.backup_group_id, lc.id)
        HAVING bool_and(
            COALESCE(
                h.consecutive_failures >= ${threshold}
                    AND h.last_failure_at > now() - make_interval(hours => ${windowHours}),
                false)
        )
    `;
    return rows.map((r) => r.station_id);
}
