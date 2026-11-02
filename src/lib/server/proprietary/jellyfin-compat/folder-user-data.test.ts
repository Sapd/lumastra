// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { MediaItemForSerialization } from './serializers/base-item';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import { toUserId } from '$lib/shared/user-id';

const getFolderEpisodeCounts = vi.fn();
vi.mock('$lib/server/database/queries/jellyfin-folder-counts.queries', () => ({
    getFolderEpisodeCounts: (...args: unknown[]) => getFolderEpisodeCounts(...args),
}));

const { applyFolderUserData } = await import('./folder-user-data');

const sql = {} as postgres.Sql;
const userId = toUserId('00000000-0000-4000-8000-000000000001');
const access = restrictedAccess({ deniedGroupIds: ['g'], maxAgeRating: 12, allowUnrated: false });

beforeEach(() => getFolderEpisodeCounts.mockReset());

describe('applyFolderUserData', () => {
    it('makes one aggregate call for every series and season on the page', async () => {
        getFolderEpisodeCounts.mockResolvedValue(
            new Map([
                ['s1', { childCount: 2, totalCount: 10, playedCount: 4 }],
                ['se1', { childCount: 5, totalCount: 5, playedCount: 5 }],
            ]),
        );
        const items: MediaItemForSerialization[] = [
            { id: 's1', title: 'Series', media_type: 'tv' },
            { id: 'm1', title: 'Movie', media_type: 'movie' },
            { id: 'se1', title: 'Season 1', media_type: 'season' },
            { id: 's2', title: 'Unknown series', media_type: 'tv' },
        ];
        await applyFolderUserData(sql, items, userId, access);

        expect(getFolderEpisodeCounts).toHaveBeenCalledTimes(1);
        expect(getFolderEpisodeCounts).toHaveBeenCalledWith(sql, {
            folderIds: ['s1', 'se1', 's2'],
            userId,
            access,
        });
        expect(items[0]).toMatchObject({
            child_count: 2,
            recursive_item_count: 10,
            played_item_count: 4,
            unplayed_count: 6,
        });
        expect(items[1].recursive_item_count).toBeUndefined();
        expect(items[2]).toMatchObject({ child_count: 5, unplayed_count: 0 });
        // A folder the query found nothing for (no visible episode) is zero, not stale.
        expect(items[3]).toMatchObject({ child_count: 0, recursive_item_count: 0 });
    });

    it('skips the query when the page has no series or season', async () => {
        await applyFolderUserData(
            sql,
            [{ id: 'm', title: 'M', media_type: 'movie' }],
            userId,
            access,
        );
        expect(getFolderEpisodeCounts).not.toHaveBeenCalled();
    });
});
