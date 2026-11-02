// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

const mockGetItemDetail = vi.fn();
vi.mock('$lib/server/database/queries/jellyfin-item-detail.queries', () => ({
    getItemDetail: (...a: unknown[]) => mockGetItemDetail(...a),
}));

const mockApplyFolderUserData = vi.fn();
vi.mock('./folder-user-data', () => ({
    applyFolderUserData: (...a: unknown[]) => mockApplyFolderUserData(...a),
}));
vi.mock('./access-context', () => ({
    buildJellyfinAccessContext: vi.fn(async () => ({
        boundary: { library: { kind: 'denyGroups', ids: ['g'] }, age: { kind: 'any' } },
        deniedGroupIds: ['g'],
        ageRating: null,
    })),
}));

const { readUserItemData, syntheticUserItemData, userItemDataAfterWrite } =
    await import('./user-item-data');

const ITEM_ID = '00000000-0000-4000-a000-000000000001';
const USER = 'uid-alice' as unknown as UserId;
const sql = {} as postgres.Sql;

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user-item-data', () => {
    it('serialises the item row exactly like /Items/{id} UserData', async () => {
        mockGetItemDetail.mockResolvedValue({
            id: ITEM_ID,
            title: 'M',
            media_type: 'movie',
            runtime_seconds: 100,
            resume_position_ms: 50_000,
            is_watched: false,
            is_favorite: true,
        });
        expect(await readUserItemData(sql, ITEM_ID, USER)).toEqual({
            PlaybackPositionTicks: 500_000_000,
            PlayedPercentage: 50,
            Played: false,
            IsFavorite: true,
            PlayCount: 0,
            Key: ITEM_ID,
            ItemId: ITEM_ID,
        });
        expect(mockGetItemDetail).toHaveBeenCalledWith(sql, ITEM_ID, USER);
    });

    it('after a write answers the re-read state, not the written flag alone', async () => {
        mockGetItemDetail.mockResolvedValue({
            id: ITEM_ID,
            title: 'M',
            media_type: 'movie',
            is_watched: true,
            is_favorite: true,
        });
        const dto = await userItemDataAfterWrite(sql, ITEM_ID, USER, { Played: true });
        expect(dto).toMatchObject({ Played: true, IsFavorite: true });
    });

    it('falls back to the written values when there is no row or the read fails', async () => {
        mockGetItemDetail.mockResolvedValueOnce(null);
        expect(await userItemDataAfterWrite(sql, ITEM_ID, USER, { IsFavorite: true })).toEqual(
            syntheticUserItemData(ITEM_ID, { IsFavorite: true }),
        );
        mockGetItemDetail.mockRejectedValueOnce(new Error('db down'));
        expect(await userItemDataAfterWrite(sql, ITEM_ID, USER, { Played: true })).toMatchObject({
            Played: true,
            PlayCount: 1,
            IsFavorite: false,
        });
        expect(await userItemDataAfterWrite(null, ITEM_ID, USER, { Played: false })).toMatchObject({
            Played: false,
        });
    });

    it('with the full user a series reads back its access-scoped episode counts', async () => {
        mockGetItemDetail.mockResolvedValue({ id: ITEM_ID, title: 'S', media_type: 'tv' });
        mockApplyFolderUserData.mockImplementation(
            async (_sql: unknown, items: Record<string, unknown>[]) => {
                items[0].recursive_item_count = 4;
                items[0].played_item_count = 1;
            },
        );
        const dto = await readUserItemData(sql, ITEM_ID, { userId: USER, userGroups: ['kids'] });
        expect(dto).toMatchObject({ UnplayedItemCount: 3, PlayedPercentage: 25, Played: false });
        expect(mockApplyFolderUserData).toHaveBeenCalledWith(
            sql,
            [expect.objectContaining({ id: ITEM_ID })],
            USER,
            { library: { kind: 'denyGroups', ids: ['g'] }, age: { kind: 'any' } },
        );
    });

    it('a bare user id reads the row alone', async () => {
        mockGetItemDetail.mockResolvedValue({ id: ITEM_ID, title: 'S', media_type: 'tv' });
        await readUserItemData(sql, ITEM_ID, USER);
        expect(mockApplyFolderUserData).not.toHaveBeenCalled();
    });
});
