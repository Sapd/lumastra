// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * livetv_simple_mode: one row per user (migration 16.307.0). The channels of
 * simple mode are the user's favorites (livetv_channel_favorites), so the
 * favorites replace lives here too.
 */

import type postgres from 'postgres';
import { lineupChannelOf } from '$lib/server/database/queries/livetv-channels.queries.js';
import type { SimpleModeLayout, SimpleModeTextSize } from '$lib/schemas/livetv-simple-mode.js';

export interface SimpleModeRow {
    user_id: string;
    enabled: boolean;
    layout: SimpleModeLayout;
    text_size: SimpleModeTextSize;
    start_channel_id: string | null;
    autostart: boolean;
    locked: boolean;
    pin_hash: string | null;
    updated_at: Date;
    updated_by: string | null;
    updated_by_display_name: string | null;
}

export async function getSimpleModeRow(
    sql: postgres.Sql,
    userId: string,
): Promise<SimpleModeRow | null> {
    const rows = await sql<SimpleModeRow[]>`
        SELECT s.user_id, s.enabled, s.layout, s.text_size, s.start_channel_id,
               s.autostart, s.locked, s.pin_hash, s.updated_at,
               s.updated_by, u.display_name AS updated_by_display_name
          FROM livetv_simple_mode s
          LEFT JOIN users u ON u.id = s.updated_by
         WHERE s.user_id = ${userId}
    `;
    return rows[0] ?? null;
}

/**
 * How many of `ids` are lineup channels: what the lineup itself lists, so a
 * visible feed that is not the shown member of its backup group does not count.
 */
export async function countLineupChannels(sql: postgres.Sql, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const [row] = await sql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
          FROM livetv_channels lc
         WHERE lc.id = ANY(${ids}::uuid[])
           AND lc.id = ${lineupChannelOf(sql)}
    `;
    return row?.n ?? 0;
}

/**
 * Saved channel ids → the lineup channels that stand in for them, in the saved
 * order, without repeats. A saved feed that is no longer the shown member of
 * its backup group becomes the shown one; a channel the lineup has nothing for
 * is dropped.
 */
export async function resolveLineupChannelIds(sql: postgres.Sql, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await sql<{ saved_id: string; lineup_id: string | null }[]>`
        SELECT lc.id AS saved_id, ${lineupChannelOf(sql)} AS lineup_id
          FROM livetv_channels lc
         WHERE lc.id = ANY(${ids}::uuid[])
    `;
    const resolved = new Map(rows.map((r) => [r.saved_id, r.lineup_id]));
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
        const lineupId = resolved.get(id);
        if (lineupId && !seen.has(lineupId)) {
            seen.add(lineupId);
            out.push(lineupId);
        }
    }
    return out;
}

/** Lock the row (or nothing, when the user has none yet) for a read-modify-write. */
export async function lockSimpleModeRow(sql: postgres.Sql, userId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('livetv_simple_mode'), hashtext(${userId}))`;
}

export interface SimpleModeWrite {
    enabled: boolean;
    layout: SimpleModeLayout;
    textSize: SimpleModeTextSize;
    startChannelId: string | null;
    autostart: boolean;
    locked: boolean;
    pinHash: string | null;
    updatedBy: string | null;
}

export async function upsertSimpleModeRow(
    sql: postgres.Sql,
    userId: string,
    w: SimpleModeWrite,
): Promise<void> {
    await sql`
        INSERT INTO livetv_simple_mode (
            user_id, enabled, layout, text_size, start_channel_id, autostart,
            locked, pin_hash, updated_by, updated_at
        ) VALUES (
            ${userId}, ${w.enabled}, ${w.layout}, ${w.textSize}, ${w.startChannelId},
            ${w.autostart}, ${w.locked}, ${w.pinHash}, ${w.updatedBy}, now()
        )
        ON CONFLICT (user_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            layout = EXCLUDED.layout,
            text_size = EXCLUDED.text_size,
            start_channel_id = EXCLUDED.start_channel_id,
            autostart = EXCLUDED.autostart,
            locked = EXCLUDED.locked,
            pin_hash = EXCLUDED.pin_hash,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
    `;
}

/**
 * Make the user's favorites exactly `channelIds`, in that order: removes the
 * others, adds the missing ones, ranks all 0..n-1. Run inside a transaction.
 * Throws a 23503 FK violation for an unknown channel id.
 */
export async function replaceFavoriteChannels(
    sql: postgres.Sql,
    userId: string,
    channelIds: string[],
): Promise<void> {
    if (channelIds.length === 0) {
        await sql`DELETE FROM livetv_channel_favorites WHERE user_id = ${userId}`;
        return;
    }
    await sql`
        DELETE FROM livetv_channel_favorites
         WHERE user_id = ${userId} AND NOT (channel_id = ANY(${channelIds}::uuid[]))
    `;
    const orders = channelIds.map((_, i) => i);
    await sql`
        INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order)
        SELECT ${userId}, data.id, data.sort_order
          FROM unnest(${channelIds}::uuid[], ${orders}::int[]) AS data(id, sort_order)
        ON CONFLICT (user_id, channel_id) DO UPDATE SET sort_order = EXCLUDED.sort_order
    `;
}

/** True when the home page should open Live TV for this user (simple mode on + autostart). */
export async function simpleModeAutostarts(sql: postgres.Sql, userId: string): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM livetv_simple_mode
         WHERE user_id = ${userId} AND enabled AND autostart
           -- Without lineup channels the TV would be an empty screen; keep the
           -- home page. A favorite counts only if the lineup lists it (or the
           -- shown feed of its station).
           AND EXISTS (
             SELECT 1
               FROM livetv_channel_favorites f
               JOIN livetv_channels lc ON lc.id = f.channel_id
              WHERE f.user_id = ${userId}
                AND ${lineupChannelOf(sql)} IS NOT NULL
           )
    `;
    return rows.length > 0;
}

/**
 * True while the user's simple mode is on AND locked. Its channels are the
 * favorites, so the favorite write paths refuse changes then: only the
 * simple-mode setup (with the PIN) or an admin may change them.
 */
export async function simpleModeLocksFavorites(
    sql: postgres.Sql,
    userId: string,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one FROM livetv_simple_mode
         WHERE user_id = ${userId} AND enabled AND locked
    `;
    return rows.length > 0;
}
