// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Series and seasons in any `/j` list or detail carry Jellyfin's derived user
 * data — `UserData.UnplayedItemCount`, `PlayedPercentage`, `Played` — and
 * `ChildCount` / `RecursiveItemCount`, from ONE aggregate query for the whole
 * page (`getFolderEpisodeCounts`), scoped to the episodes the user may see.
 *
 * Call after mapping rows, before `serializeBaseItem(s)`; it fills
 * `child_count`, `recursive_item_count` and `played_item_count` on the
 * series/season items in place and leaves every other item untouched.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { MediaItemForSerialization } from './serializers/base-item';
import {
    getFolderEpisodeCounts,
    type FolderEpisodeCounts,
} from '$lib/server/database/queries/jellyfin-folder-counts.queries';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary';
import { isSeason, isSeries } from '$lib/server/utils/media-types.js';

export async function applyFolderUserData(
    sql: postgres.Sql,
    items: MediaItemForSerialization[],
    userId: UserId | undefined,
    access: MediaAccessBoundary,
    /** Counts the caller already fetched (same user + boundary); skips the query when complete. */
    known?: ReadonlyMap<string, FolderEpisodeCounts>,
): Promise<void> {
    const folders = items.filter((i) => isSeries(i.media_type) || isSeason(i.media_type));
    if (folders.length === 0) return;
    const counts =
        known && folders.every((f) => known.has(f.id))
            ? known
            : await getFolderEpisodeCounts(sql, {
                  folderIds: folders.map((f) => f.id),
                  userId,
                  access,
              });
    for (const item of folders) {
        const c = counts.get(item.id) ?? { childCount: 0, totalCount: 0, playedCount: 0 };
        item.child_count = c.childCount;
        item.recursive_item_count = c.totalCount;
        item.played_item_count = c.playedCount;
        item.unplayed_count = Math.max(0, c.totalCount - c.playedCount);
    }
}
