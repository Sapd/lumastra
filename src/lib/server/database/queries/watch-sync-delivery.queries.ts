// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';

/** Each event owns its retry state, so a genuinely new local act bypasses an old backoff. */
export async function deferSyncDelivery(
    sql: postgres.Sql,
    provider: string,
    userId: string,
    eventIds: string[],
    reason: string,
    reportFailure = true,
): Promise<{ firstReport: boolean; description: string }> {
    const baseSeconds = provider === 'audiobookshelf' ? 30 : 600;
    const capSeconds = provider === 'audiobookshelf' ? 300 : 86400;
    const [row] = await sql<{ attempts: number; next_at: Date; first_report: boolean }[]>`
        WITH updated AS (
            UPDATE user_media_events SET sync_delivery = jsonb_set(sync_delivery, ARRAY[${provider}],
                jsonb_build_object(
                    'error_reported', ${reportFailure} OR COALESCE((sync_delivery -> ${provider} ->> 'error_reported')::boolean, false),
                    'first_report', ${reportFailure} AND NOT COALESCE((sync_delivery -> ${provider} ->> 'error_reported')::boolean, false),
                    'attempts', COALESCE((sync_delivery -> ${provider} ->> 'attempts')::int, 0) + 1,
                    'last_reason', ${reason.slice(0, 500)}::text,
                    'next_attempt_at', now() + LEAST(${capSeconds}, ${baseSeconds} * power(2, LEAST(8, COALESCE((sync_delivery -> ${provider} ->> 'attempts')::int, 0)))) * INTERVAL '1 second'
                ))
            WHERE user_id = ${userId}::uuid AND id = ANY(${eventIds}::uuid[])
            RETURNING sync_delivery -> ${provider} AS delivery
        ) SELECT MIN((delivery ->> 'attempts')::int) AS attempts,
                 MIN((delivery ->> 'next_attempt_at')::timestamptz) AS next_at,
                 bool_or((delivery ->> 'first_report')::boolean) AS first_report FROM updated
    `;
    return {
        firstReport: row?.first_report ?? false,
        description: `${reason} (attempt ${row?.attempts ?? 1}; retry after ${row?.next_at?.toISOString() ?? 'backoff'})`,
    };
}

/** Latest explicit mark (including an unacknowledged replacement) is authoritative. */
export async function getAcknowledgedJellyfinUnwatches(
    sql: postgres.Sql,
    userId: string,
    mediaIds: string[],
): Promise<Map<string, string>> {
    const rows = await sql<{ media_id: string; acknowledged_at: string | null }[]>`
        SELECT DISTINCT ON (media_id) media_id,
            CASE WHEN event_type = 'mark_unwatched' THEN sync_delivery -> 'jellyfin' ->> 'acknowledged_at'
                 WHEN event_type = 'state_snapshot' AND snapshot_state ->> 'is_watched_source' = 'lumastra-user-mark'
                      AND (snapshot_state ->> 'is_watched')::boolean = false
                 THEN snapshot_state ->> 'jellyfin_unwatch_acknowledged_at' END AS acknowledged_at
        FROM user_media_events
        WHERE user_id = ${userId}::uuid AND media_id = ANY(${mediaIds}::uuid[]) AND repudiated_at IS NULL
          AND ((source = 'lumastra-user-mark' AND event_type IN ('mark_watched', 'mark_unwatched')) OR event_type = 'state_snapshot')
        ORDER BY media_id, occurred_at DESC, recorded_at DESC
    `;
    return new Map(
        rows.flatMap((r) => (r.acknowledged_at ? [[r.media_id, r.acknowledged_at]] : [])),
    );
}
