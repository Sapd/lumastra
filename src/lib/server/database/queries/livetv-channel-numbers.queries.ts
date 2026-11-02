// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * livetv_channel_numbers (migration 16.308.0): stable channel numbers per
 * station card. Planning lives in services/livetv/channel-number-plan.ts,
 * orchestration (lock, transaction) in channel-numbers.service.ts.
 */

import type postgres from 'postgres';
import type {
    NumberCategory,
    NumberInsert,
    NumberRow,
} from '$lib/server/services/livetv/channel-number-plan.js';

/** Serialises every write to the numbers (assignment, admin edits, renumber). */
export async function lockChannelNumbers(sql: postgres.Sql): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext('livetv_channel_numbers'))`;
}

export async function getChannelNumberRows(sql: postgres.Sql): Promise<NumberRow[]> {
    const rows = await sql<
        {
            number: number;
            backup_group_id: string | null;
            channel_id: string | null;
            channel_group_id: string | null;
            pinned: boolean;
            owner_alive: boolean;
        }[]
    >`
        SELECT n.number, n.backup_group_id, n.channel_id, n.pinned,
               c.backup_group_id AS channel_group_id,
               -- A number of a group lives while the group has channels (a group
               -- left empty, its feeds moved elsewhere, would otherwise hold a
               -- ghost number forever); an ungrouped one while its channel exists.
               CASE WHEN n.backup_group_id IS NOT NULL
                    THEN EXISTS (
                        SELECT 1 FROM livetv_channels g WHERE g.backup_group_id = n.backup_group_id
                    )
                    ELSE c.id IS NOT NULL
               END AS owner_alive
          FROM livetv_channel_numbers n
          LEFT JOIN livetv_channels c ON c.id = n.channel_id
    `;
    return rows.map((r) => ({
        number: r.number,
        backupGroupId: r.backup_group_id,
        channelId: r.channel_id,
        channelGroupId: r.channel_group_id,
        pinned: r.pinned,
        ownerAlive: r.owner_alive,
    }));
}

export async function getNumberCategories(sql: postgres.Sql): Promise<NumberCategory[]> {
    const rows = await sql<
        { id: string; name: string; sort_order: number; number_start: number | null }[]
    >`SELECT id, name, sort_order, number_start FROM livetv_categories`;
    return rows.map((r) => ({
        id: r.id,
        name: r.name,
        sortOrder: r.sort_order,
        numberStart: r.number_start,
    }));
}

export async function deleteChannelNumbers(sql: postgres.Sql, numbers: number[]): Promise<void> {
    if (numbers.length === 0) return;
    await sql`
        DELETE FROM livetv_channel_numbers WHERE number = ANY(${numbers.map(String)}::text[]::int[])
    `;
}

export async function claimChannelNumbers(
    sql: postgres.Sql,
    claims: { number: number; backupGroupId: string }[],
): Promise<void> {
    if (claims.length === 0) return;
    await sql`
        UPDATE livetv_channel_numbers AS n
           SET backup_group_id = v.backup_group_id::uuid, updated_at = now()
          FROM unnest(
              ${claims.map((c) => String(c.number))}::text[],
              ${claims.map((c) => c.backupGroupId)}::text[]
          ) AS v(number, backup_group_id)
         WHERE n.number = v.number::int
    `;
}

export async function insertChannelNumbers(
    sql: postgres.Sql,
    inserts: (NumberInsert & { pinned?: boolean })[],
): Promise<void> {
    if (inserts.length === 0) return;
    // Every array goes over as text: postgres.js cannot bind a JS boolean[]
    // ("cannot cast type boolean to boolean[]").
    await sql`
        INSERT INTO livetv_channel_numbers (number, backup_group_id, channel_id, pinned)
        SELECT v.number::int, v.backup_group_id::uuid, v.channel_id::uuid, v.pinned::boolean
          FROM unnest(
              ${inserts.map((i) => String(i.number))}::text[],
              ${inserts.map((i) => i.backupGroupId)}::text[],
              ${inserts.map((i) => i.channelId)}::text[],
              ${inserts.map((i) => String(i.pinned ?? false))}::text[]
          ) AS v(number, backup_group_id, channel_id, pinned)
    `;
}

/**
 * The provider's own channel names of a source (not an admin rename): what a
 * re-import's playlist carries, so the matcher compares like with like.
 */
export async function getProviderChannelTitles(
    sql: postgres.Sql,
    sourceId: string,
): Promise<Map<string, string>> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin import path (livetv:admin); reads Live TV channel titles of one source
    const rows = await sql<{ id: string; title: string }[]>`
        SELECT lc.id, mi.title
          FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
         WHERE lc.source_id = ${sourceId}::uuid
    `;
    return new Map(rows.map((r) => [r.id, r.title]));
}

/** The card (group id, else channel id) of a channel, or null when it does not exist. */
export async function getChannelCard(
    sql: postgres.Sql,
    channelId: string,
): Promise<{ channelId: string; backupGroupId: string | null } | null> {
    const [row] = await sql<{ id: string; backup_group_id: string | null }[]>`
        SELECT id, backup_group_id FROM livetv_channels WHERE id = ${channelId}::uuid
    `;
    return row ? { channelId: row.id, backupGroupId: row.backup_group_id } : null;
}

/** The name an admin knows a number's channel by (a channel of it, else its group). */
export async function getChannelNumberHolderName(
    sql: postgres.Sql,
    number: number,
): Promise<string | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only (livetv:admin scope on the calling route); reads one Live TV channel's title
    const [row] = await sql<{ name: string | null }[]>`
        SELECT COALESCE(
                   (SELECT COALESCE(lc.admin_display_name, mi.title)
                      FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
                     WHERE lc.id = n.channel_id),
                   (SELECT COALESCE(lc.admin_display_name, mi.title)
                      FROM livetv_channels lc JOIN media_items mi ON mi.id = lc.id
                     WHERE lc.backup_group_id = n.backup_group_id
                     ORDER BY lc.sort_order, lc.id LIMIT 1),
                   bg.name
               ) AS name
          FROM livetv_channel_numbers n
          LEFT JOIN livetv_backup_groups bg ON bg.id = n.backup_group_id
         WHERE n.number = ${number}
    `;
    return row?.name ?? null;
}

export async function setChannelNumberRow(
    sql: postgres.Sql,
    from: number,
    to: number,
    pinned: boolean,
): Promise<void> {
    await sql`
        UPDATE livetv_channel_numbers
           SET number = ${to}, pinned = ${pinned}, updated_at = now()
         WHERE number = ${from}
    `;
}

export async function setChannelNumberPinned(
    sql: postgres.Sql,
    number: number,
    pinned: boolean,
): Promise<void> {
    await sql`
        UPDATE livetv_channel_numbers SET pinned = ${pinned}, updated_at = now()
         WHERE number = ${number}
    `;
}

export async function setCategoryNumberStart(
    sql: postgres.Sql,
    categoryId: string,
    numberStart: number | null,
): Promise<boolean> {
    const result = await sql`
        UPDATE livetv_categories SET number_start = ${numberStart}
         WHERE id = ${categoryId}::uuid
    `;
    return result.count > 0;
}
