// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin `UserItemDataDto` for one item, read back from the database.
 *
 * Every /j route that answers with user data after a write (mark played,
 * favourite, `UserItems/{id}/UserData`) uses this, so the answer is the item's
 * real state — the same `UserData` `/Items/{id}` would show. The handlers
 * used to build it by hand with the OTHER flag hard-coded (marking played
 * answered `IsFavorite: false`, favouriting answered `Played: false`), and
 * clients that store the returned dto showed a favourite as un-favourited.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { JellyfinUserItemData } from './types';
import { getItemDetail } from '$lib/server/database/queries/jellyfin-item-detail.queries';
import { mapRowToMediaItem, serializeBaseItem } from './serializers/base-item';
import { buildJellyfinAccessContext, type JellyfinAccessUser } from './access-context';
import { applyFolderUserData } from './folder-user-data';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:UserItemData');

/**
 * Who the user data is read for. The full user (its access fields) lets a
 * series / season answer with its episode-derived state (UnplayedItemCount,
 * Played, PlayedPercentage) exactly as lists show it; a bare id cannot scope
 * those counts and reads the row alone.
 */
export type UserItemDataReader = UserId | (JellyfinAccessUser & { userId: UserId });

/** The item's user data, or null when it is no (active) media item. */
export async function readUserItemData(
    sql: postgres.Sql,
    itemId: string,
    reader: UserItemDataReader,
): Promise<JellyfinUserItemData | null> {
    const userId = typeof reader === 'string' ? reader : reader.userId;
    const row = await getItemDetail(sql, itemId, userId);
    if (!row) return null;
    const item = mapRowToMediaItem(row as unknown as Record<string, unknown>);
    if (typeof reader !== 'string') {
        const access = await buildJellyfinAccessContext(sql, reader);
        await applyFolderUserData(sql, [item], userId, access.boundary);
    }
    return serializeBaseItem(item).UserData ?? null;
}

/**
 * A user-data dto for an id that has no media item row to read (a Live TV
 * channel or EPG program, a non-UUID id): defaults plus what the caller just set.
 */
export function syntheticUserItemData(
    itemId: string,
    set: Partial<JellyfinUserItemData> = {},
): JellyfinUserItemData {
    const played = set.Played ?? false;
    return {
        PlaybackPositionTicks: 0,
        PlayedPercentage: played ? 100 : 0,
        Played: played,
        IsFavorite: false,
        PlayCount: played ? 1 : 0,
        Key: itemId,
        ItemId: itemId,
        ...set,
    };
}

/**
 * The response dto after a write: the re-read state, else (no media row, or the
 * read failed — the write already succeeded, so never turn it into an error)
 * the synthetic dto carrying what was set.
 */
export async function userItemDataAfterWrite(
    sql: postgres.Sql | null | undefined,
    itemId: string,
    reader: UserItemDataReader,
    set: Partial<JellyfinUserItemData>,
): Promise<JellyfinUserItemData> {
    if (sql) {
        try {
            const data = await readUserItemData(sql, itemId, reader);
            if (data) return data;
        } catch (err) {
            logger.warn('User data read-back failed; answering with the written values', {
                itemId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return syntheticUserItemData(itemId, set);
}
