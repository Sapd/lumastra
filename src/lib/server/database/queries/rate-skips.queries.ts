// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rate-Skips Query Module
 *
 * Durable per-user skip records for the /rate swipe trainer
 * (user_rate_skips). `buildRateQueue` (defs/rate/queue.ts) excludes rows
 * skipped within the last SKIP_SUPPRESSION_DAYS; this module is the write
 * side, called from the skip beacon endpoint (defs/rate/skip.ts).
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';

/**
 * Upsert skip records for a user, refreshing `skipped_at` to now() on repeat
 * skips of the same item (so the suppression window resets from the latest
 * skip). No-op for an empty `mediaIds` array.
 */
export async function recordSkips(
    sql: postgres.Sql,
    userId: UserId,
    mediaIds: string[],
): Promise<void> {
    if (mediaIds.length === 0) return;

    // Defense-in-depth dedupe: the unnest + ON CONFLICT DO UPDATE below raises
    // Postgres 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
    // second time") if the same id appears twice in one batch. Callers
    // (defs/rate/skip.ts) already dedupe before calling in, but dedupe here
    // too so this function is safe on its own.
    const uniqueIds = [...new Set(mediaIds)];
    const userIds = uniqueIds.map(() => userId);
    await sql`
        INSERT INTO user_rate_skips (user_id, media_id)
        SELECT * FROM unnest(${userIds}::uuid[], ${uniqueIds}::uuid[])
        ON CONFLICT (user_id, media_id) DO UPDATE SET skipped_at = now()
    `;
}
